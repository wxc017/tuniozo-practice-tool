import { useEffect, useRef } from "react";
import {
  Renderer, Stave, StaveNote, StaveNoteStruct, Voice, Formatter, Beam, Barline,
  Annotation, Articulation, Tuplet, StaveTie, Dot,
} from "vexflow";
import { KonnakolGroup, getSyllablesForSize } from "@/lib/konnakolData";

const DUR_TO_SLOTS: Record<string, number> = {
  "32": 0.5, "16": 1, "16.": 1.5, "8": 2, "8.": 3, "q": 4, "q.": 6, "h": 8, "h.": 12, "w": 16,
};
const SLOTS_TO_DUR: [number, string, number?][] = [
  [16, "w"],
  [12, "h", 1],
  [8, "h"],
  [6, "q", 1],
  [4, "q"],
  [3, "8", 1],
  [2, "8"],
  [1.5, "16", 1],
  [1, "16"],
  [0.5, "32"],
];

function slotsToVex(slots: number): { dur: string; dots?: number } {
  for (const [s, d, dots] of SLOTS_TO_DUR) {
    if (Math.abs(slots - s) < 0.001) return { dur: d, dots };
  }
  for (const [s, d, dots] of SLOTS_TO_DUR) {
    if (slots >= s) return { dur: d, dots };
  }
  return { dur: "16" };
}

interface FlatNote {
  keys: string[];
  slots: number;
  syllable: string;
  accent: boolean;
  isRest: boolean;
}

function flattenGroups(groups: KonnakolGroup[]): {
  flat: FlatNote[];
  groupBoundaries: number[];
} {
  const flat: FlatNote[] = [];
  const groupBoundaries: number[] = [];
  for (const group of groups) {
    for (let i = 0; i < group.notes.length; i++) {
      const note = group.notes[i];
      const noteDur = note.duration ?? "16";
      const slots = DUR_TO_SLOTS[noteDur] ?? 1;
      const isFirst = i === 0;
      flat.push({
        keys: note.noteType === "rest" ? ["b/4"] : ["c/5"],
        slots,
        // Keep the syllable on tie continuations too — every notated note
        // should have a solkattu label, not just the first of a tied pair.
        syllable: note.noteType === "rest" ? "" : (note.syllable ?? ""),
        accent: isFirst && note.accent,
        isRest: note.noteType === "rest",
      });
    }
    groupBoundaries.push(flat.length);
  }
  return { flat, groupBoundaries };
}

function applyWhite(el: HTMLElement) {
  const svg = el.querySelector("svg");
  if (svg) (svg as SVGSVGElement).style.filter = "invert(1)";
}

const SNARE_KEY = "c/5";
const REST_KEY  = "b/4";

interface KonnakolNotationProps {
  groups: KonnakolGroup[];
  width: number;
  height?: number;
  baseDuration?: "q" | "8" | "16";
  noTuplets?: boolean;
  onNoteClick?: (groupIdx: number, noteIdx: number) => void;
  useTiedSixteenths?: boolean;
  groupedSixteenths?: number[];
  singleLine?: boolean;
  /** Override the note pitch (e.g. "b/4" to center notes on a single-line stave) */
  noteKey?: string;
  noteOverrides?: Record<number, "rest" | "32nd">;
  tieAfter?: number[];
  groupYValues?: number[];
  onNotePositions?: (positions: number[]) => void;
  /** When provided, renders a second (pulse) stave below the main stave, with both voices
   * formatted by a shared Formatter so tick positions align perfectly across staves. */
  pulseGroups?: KonnakolGroup[];
  /** Vertical space reserved for the pulse stave (only used when pulseGroups is set). */
  pulseHeight?: number;
  /** Hide all stems, flags, and beams on the main staff — just noteheads +
   *  accent marks.  Used by feature views (e.g. Vocal Percussion) that want a
   *  clean colour-coded rhythm grid without conventional stem/beam clutter. */
  stemless?: boolean;
}

export default function KonnakolNotation({
  groups,
  width,
  height = 140,
  baseDuration = "q",
  noTuplets = false,
  onNoteClick,
  useTiedSixteenths = false,
  groupedSixteenths,
  singleLine = false,
  noteKey: noteKeyProp,
  noteOverrides = {},
  tieAfter = [],
  groupYValues,
  onNotePositions,
  pulseGroups,
  pulseHeight = 100,
  stemless = false,
}: KonnakolNotationProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = "";
    if (groups.length === 0) return;

    try {
      const hasPulse = !!pulseGroups && pulseGroups.length > 0;
      const GAP_PX = 2;
      const totalHeight = hasPulse ? height + GAP_PX + pulseHeight : height;

      const renderer = new Renderer(el, Renderer.Backends.SVG);
      renderer.resize(width, totalHeight);
      const ctx = renderer.getContext();
      ctx.setFont("Arial", 10);

      // Push stave down to leave room above for tuplet brackets + their digit labels
      const staveY = 50;
      const CLEF_W = 30;
      const staveW = width - CLEF_W - 10;

      const snareKey = noteKeyProp ?? (singleLine ? "f/5" : SNARE_KEY);
      const staveX = singleLine ? 4 : CLEF_W;
      const actualStaveW = singleLine ? width - 8 : staveW;
      const stave = new Stave(staveX, staveY, actualStaveW);
      if (singleLine) {
        stave.setNumLines(1);
        stave.setBegBarType(Barline.type.NONE);
      } else {
        stave.addClef("percussion");
      }
      stave.setEndBarType(Barline.type.END);
      stave.setContext(ctx).draw();

      const totalNotes = groups.reduce((s, g) => s + g.notes.length, 0);
      if (totalNotes === 0) return;

      let notePositions: number[] = [];
      if (hasPulse) {
        const pulseStaveY = height + GAP_PX + 50;
        const pulseStave = new Stave(staveX, pulseStaveY, actualStaveW);
        pulseStave.setNumLines(1);
        pulseStave.setBegBarType(Barline.type.NONE);
        pulseStave.setEndBarType(Barline.type.END);
        pulseStave.setContext(ctx).draw();
        notePositions = renderLegacyWithPulse(
          ctx, stave, pulseStave, staveW, groups, pulseGroups!, noTuplets, snareKey, stemless,
        );
      } else if (groupedSixteenths) {
        notePositions = renderGroupedSixteenths(ctx, stave, actualStaveW, groups, groupedSixteenths, groupYValues, snareKey);
      } else if (useTiedSixteenths) {
        notePositions = renderTiedSixteenths(ctx, stave, staveW, groups, snareKey);
      } else {
        notePositions = renderLegacy(ctx, stave, staveW, groups, noTuplets, snareKey, stemless);
      }

      if (onNotePositions && notePositions.length > 0) {
        onNotePositions(notePositions);
      }

      applyWhite(el);
    } catch (err) {
      console.warn("KonnakolNotation render error:", err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, width, height, useTiedSixteenths, groupedSixteenths, baseDuration, noTuplets, singleLine, noteKeyProp, noteOverrides, tieAfter, groupYValues, pulseGroups, pulseHeight, stemless]);

  const handleClick = (e: React.MouseEvent) => {
    if (!onNoteClick) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;

    let noteGlobalIdx = 0;
    const totalN = groups.reduce((s, g) => s + g.notes.length, 0);
    for (let gi = 0; gi < groups.length; gi++) {
      for (let ni = 0; ni < groups[gi].notes.length; ni++) {
        const approxX = 40 + (noteGlobalIdx / Math.max(1, totalN - 1)) * (width - 80);
        if (Math.abs(x - approxX) < 20) {
          onNoteClick(gi, ni);
          return;
        }
        noteGlobalIdx++;
      }
    }
  };

  const hasPulse = !!pulseGroups && pulseGroups.length > 0;
  const outerHeight = hasPulse ? height + 2 + pulseHeight : height;

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      style={{ width, height: outerHeight, overflow: "visible", display: "block", flexShrink: 0, cursor: onNoteClick ? "pointer" : "default" }}
    />
  );
}

function renderGroupedSixteenths(
  ctx: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  stave: Stave,
  staveW: number,
  groups: KonnakolGroup[],
  formula: number[],
  groupYValues?: number[],
  noteKey: string = SNARE_KEY,
): number[] {
  const allNotes: StaveNote[] = [];
  const allLabels: string[] = [];
  const groupBoundaries: number[] = [];
  let totalSlots = 0; // counted in 32nd-note units for accurate timing

  for (let gi = 0; gi < formula.length; gi++) {
    const n = formula[gi];
    const syllables = getSyllablesForSize(n);
    for (let si = 0; si < n; si++) {
      const groupNote = groups[gi];
      const srcNote = groupNote?.notes[si] ?? groupNote?.notes[0];
      const isRest = srcNote?.noteType === "rest";
      const formulaSyl = syllables[si] ?? "ta";
      // Label every non-rest slot (including tie continuations) so every
      // notated note gets a solkattu syllable underneath.
      const syllable = !isRest ? formulaSyl : "";
      allLabels.push(syllable);
      const isFirst = si === 0;

      // Respect per-note duration: "32" → 32nd note, otherwise 16th
      const is32 = srcNote?.duration === "32";
      const baseDur = is32 ? "32" : "16";
      const vexDur = isRest ? baseDur + "r" : baseDur;
      const sn = new StaveNote({
        keys: [isRest ? REST_KEY : noteKey],
        duration: vexDur,
        stemDirection: 1,
      } as StaveNoteStruct);

      if (srcNote?.accent || (isFirst && srcNote?.accent !== false)) {
        try { sn.addModifier(new Articulation("a>").setPosition(3)); } catch { /* ignore */ }
      }

      if (!isRest && syllable) {
        try {
          const ann = new Annotation(syllable);
          ann.setFont("Arial", 10, "normal");
          ann.setVerticalJustification(Annotation.VerticalJustify.BOTTOM);
          try { ann.setStyle({ fillStyle: "#000000", strokeStyle: "#000000" }); } catch { /* ignore */ }
          sn.addModifier(ann);
        } catch { /* ignore */ }
      }

      allNotes.push(sn);
      totalSlots += is32 ? 1 : 2; // 32nd = 1 unit, 16th = 2 units
    }

    groupBoundaries.push(allNotes.length);
  }

  if (allNotes.length === 0) return [];

  // Use 32nd-note beat value so both 16th and 32nd notes have integer durations
  const voice = new Voice({ numBeats: totalSlots, beatValue: 32 });
  (voice as unknown as { setMode(m: number): void }).setMode(2);
  voice.addTickables(allNotes);

  const fmtW = Math.max(60, staveW - 40);
  new Formatter().joinVoices([voice]).format([voice], fmtW);

  const beamsToRender: Beam[] = [];
  let prevBoundary = 0;
  for (const boundary of groupBoundaries) {
    const notesForBeam = allNotes.slice(prevBoundary, boundary).filter(n => !n.isRest());
    if (notesForBeam.length >= 2) {
      try { beamsToRender.push(new Beam(notesForBeam)); } catch { /* ignore */ }
    }
    prevBoundary = boundary;
  }

  voice.draw(ctx, stave);
  beamsToRender.forEach(b => b.setContext(ctx).draw());

  // Draw x:y tuplet brackets per group when groupYValues is set
  if (groupYValues) {
    let prevB = 0;
    for (let gi = 0; gi < formula.length; gi++) {
      const boundary = groupBoundaries[gi];
      const y = groupYValues[gi];
      if (y != null && y > 0) {
        const groupNotes = allNotes.slice(prevB, boundary);
        if (groupNotes.length >= 1) {
          try {
            new Tuplet(groupNotes, {
              numNotes: formula[gi],
              notesOccupied: y,
              ratioed: false,
              bracketed: true,
              location: 1,
            }).setContext(ctx).draw();
          } catch { /* ignore */ }
        }
      }
      prevB = boundary;
    }
  }

  // Draw tie arcs for isTieStart (forward) and noteType="tie" (backward)
  let tieNoteIdx = 0;
  for (let gi = 0; gi < formula.length; gi++) {
    const n = formula[gi];
    for (let si = 0; si < n; si++) {
      const srcNote = groups[gi]?.notes[si] ?? groups[gi]?.notes[0];
      const noteVf = allNotes[tieNoteIdx + si];
      const nextVf = allNotes[tieNoteIdx + si + 1];
      const prevVf = (tieNoteIdx + si) > 0 ? allNotes[tieNoteIdx + si - 1] : null;
      if (srcNote?.isTieStart && noteVf && nextVf) {
        try {
          new StaveTie({ firstNote: noteVf, lastNote: nextVf, firstIndexes: [0], lastIndexes: [0] })
            .setContext(ctx).draw();
        } catch { /* ignore */ }
      }
      if (srcNote?.noteType === "tie" && prevVf && noteVf) {
        try {
          new StaveTie({ firstNote: prevVf, lastNote: noteVf, firstIndexes: [0], lastIndexes: [0] })
            .setContext(ctx).draw();
        } catch { /* ignore */ }
      }
    }
    tieNoteIdx += n;
  }

  // Solkattu labels drawn as raw SVG text (labels parallel to allNotes).
  drawSyllableLabels(ctx, stave, allNotes, allLabels);

  // Return note X positions for button alignment
  try {
    return allNotes.map(n => n.getAbsoluteX());
  } catch {
    return [];
  }
}

function renderTiedSixteenths(
  ctx: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  stave: Stave,
  staveW: number,
  groups: KonnakolGroup[],
  noteKey: string = SNARE_KEY,
): number[] {
  const { flat, groupBoundaries } = flattenGroups(groups);
  if (flat.length === 0) return [];

  const allNotes: StaveNote[] = [];

  for (const fn of flat) {
    const { dur, dots } = slotsToVex(fn.slots);
    const vexDur = fn.isRest ? dur + "r" : dur;
    const sn = new StaveNote({
      keys: fn.isRest ? fn.keys : [noteKey],
      duration: vexDur,
      dots: dots ?? 0,
      stemDirection: 1,
    } as StaveNoteStruct);

    if (dots) {
      try { Dot.buildAndAttach([sn], { all: true }); } catch { /* ignore */ }
    }

    try { sn.setFlagStyle({ strokeStyle: "transparent", fillStyle: "transparent" }); } catch { /* ignore */ }

    if (fn.accent) {
      try { sn.addModifier(new Articulation("a>").setPosition(3)); } catch { /* ignore */ }
    }

    if (!fn.isRest && fn.syllable) {
      try {
        const ann = new Annotation(fn.syllable);
        ann.setFont("Arial", 10, "normal");
        ann.setVerticalJustification(Annotation.VerticalJustify.BOTTOM);
        try { ann.setStyle({ fillStyle: "#000000", strokeStyle: "#000000" }); } catch { /* ignore */ }
        sn.addModifier(ann);
      } catch { /* ignore */ }
    }

    allNotes.push(sn);
  }

  const totalSlots = flat.reduce((s, n) => s + n.slots, 0);
  const voice = new Voice({ numBeats: totalSlots, beatValue: 16 });
  (voice as unknown as { setMode(m: number): void }).setMode(2);
  voice.addTickables(allNotes);

  const fmtW = Math.max(60, staveW - 40);
  new Formatter().joinVoices([voice]).format([voice], fmtW);

  const beamsToRender: Beam[] = [];
  let prevBoundary = 0;
  for (const boundary of groupBoundaries) {
    const notesForBeam = allNotes.slice(prevBoundary, boundary).filter(n => !n.isRest());
    if (notesForBeam.length >= 2) {
      try { beamsToRender.push(new Beam(notesForBeam, true)); } catch { /* ignore */ }
    }
    prevBoundary = boundary;
  }

  voice.draw(ctx, stave);
  beamsToRender.forEach(b => b.setContext(ctx).draw());

  // Solkattu labels (parallel to `flat`, which is parallel to `allNotes`).
  drawSyllableLabels(ctx, stave, allNotes, flat.map(f => f.isRest ? "" : f.syllable));

  try {
    return allNotes.map(n => n.getAbsoluteX());
  } catch {
    return [];
  }
}

function buildLegacyNotes(
  groups: KonnakolGroup[],
  noTuplets: boolean,
  noteKey: string,
  stemless: boolean = false,
): {
  notes: StaveNote[];
  tupletGroups: { notes: StaveNote[]; size: number }[];
  totalSlots: number;
} {
  const notes: StaveNote[] = [];
  const tupletGroups: { notes: StaveNote[]; size: number }[] = [];
  let totalSlots = 0;

  for (const group of groups) {
    const groupNotes: StaveNote[] = [];
    for (const note of group.notes) {
      const rawDur = note.duration ?? "16";
      const isDotted = rawDur.endsWith(".");
      const baseDur = isDotted ? rawDur.slice(0, -1) : rawDur;
      totalSlots += DUR_TO_SLOTS[rawDur] ?? 1;

      const keys: string[] = note.noteType === "rest" ? [REST_KEY] : [noteKey];

      const sn = new StaveNote({
        keys,
        duration: note.noteType === "rest" ? baseDur + "r" : baseDur,
        dots: isDotted ? 1 : 0,
        stemDirection: 1,
      } as StaveNoteStruct);

      if (isDotted) {
        try { Dot.buildAndAttach([sn], { all: true }); } catch { /* ignore */ }
      }

      try { sn.setFlagStyle({ strokeStyle: "transparent", fillStyle: "transparent" }); } catch { /* ignore */ }

      if (note.hidden) {
        try {
          sn.setStyle({ strokeStyle: "transparent", fillStyle: "transparent" });
          sn.setStemStyle({ strokeStyle: "transparent" });
          sn.setLedgerLineStyle({ strokeStyle: "transparent", fillStyle: "transparent", lineWidth: 0 });
        } catch { /* ignore */ }
      } else if (note.noteColor && note.noteType !== "rest") {
        // Colour-code notehead per voice (Vocal Percussion identifies voices
        // by notehead colour instead of syllable text).  Stems stay white —
        // pre-inverted as black because the containing SVG has invert(1), so
        // black ink → white on screen.  Keeping stems neutral prevents the
        // staff from reading as a stripe of coloured vertical lines; the
        // noteheads carry the voice identity, stems just carry the rhythm.
        try {
          sn.setStyle({ fillStyle: note.noteColor, strokeStyle: note.noteColor });
          sn.setStemStyle({ strokeStyle: "#000000" });
        } catch { /* ignore */ }
      }

      if (note.accent && !note.hidden) {
        try {
          const art = new Articulation("a>").setPosition(3);
          // Match the stems — white accent mark (black pre-invert).  Prevents
          // the accent from adopting the notehead colour via default style
          // inheritance, which made accents read as part of the voice rather
          // than as a separate dynamic marker.
          try { art.setStyle({ fillStyle: "#000000", strokeStyle: "#000000" }); } catch { /* ignore */ }
          sn.addModifier(art);
        } catch { /* ignore */ }
      }

      // Show syllable under every notated note (including tie continuations)
      // so solkattu practice has a label for every sound position. Rests are
      // still skipped. Empty-string syllables naturally fall through.
      // Explicit black fill ensures the outer SVG invert(1) filter flips it
      // to white — without setStyle, VexFlow's default state flows through
      // the invert unchanged and the text reads as black on black.
      if (!note.hidden && note.noteType !== "rest" && note.syllable) {
        try {
          const ann = new Annotation(note.syllable);
          ann.setFont("Arial", 10, "normal");
          ann.setVerticalJustification(Annotation.VerticalJustify.BOTTOM);
          const color = note.syllableColor ?? "#000000";
          try { ann.setStyle({ fillStyle: color, strokeStyle: color }); } catch { /* ignore */ }
          sn.addModifier(ann);
        } catch { /* ignore */ }
      }

      groupNotes.push(sn);
      notes.push(sn);
    }

    if (!noTuplets && !group.noTuplet) {
      const subdiv = group.subdivision;
      // Show tuplet bracket when the beat subdivision is a true tuplet (3,5,6,7)
      // regardless of how many notes the permutation has
      if (subdiv && subdiv !== 4 && subdiv !== 8 && groupNotes.length >= 1) {
        tupletGroups.push({ notes: groupNotes, size: subdiv });
      }
    }
  }

  return { notes, tupletGroups, totalSlots };
}

function drawLegacyBeamsAndTies(
  ctx: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  groups: KonnakolGroup[],
  notes: StaveNote[],
  tupletGroups: { notes: StaveNote[]; size: number }[],
) {
  let offset = 0;
  const beamsToRender: Beam[] = [];
  for (const group of groups) {
    const beamable = notes.slice(offset, offset + group.notes.length).filter(n => !n.isRest());
    offset += group.notes.length;
    if (beamable.length >= 2) {
      try {
        beamsToRender.push(new Beam(beamable));
      } catch { /* ignore */ }
    }
  }
  beamsToRender.forEach(b => b.setContext(ctx).draw());

  for (const tg of tupletGroups) {
    if (tg.notes.length >= 1) {
      try {
        const tuplet = new Tuplet(tg.notes, {
          numNotes: tg.size,
          notesOccupied: tg.notes.length,
          ratioed: false,
          bracketed: true,
          location: 1,
        });
        tuplet.setContext(ctx).draw();
      } catch { /* ignore */ }
    }
  }

  let tieIdx = 0;
  for (const group of groups) {
    for (let ni = 0; ni < group.notes.length; ni++) {
      const srcNote = group.notes[ni];
      const staveNote = notes[tieIdx];
      const prevStaveNote = tieIdx > 0 ? notes[tieIdx - 1] : null;
      const nextStaveNote = tieIdx < notes.length - 1 ? notes[tieIdx + 1] : null;
      if (srcNote?.isTieStart && staveNote && nextStaveNote) {
        try {
          new StaveTie({ firstNote: staveNote, lastNote: nextStaveNote, firstIndexes: [0], lastIndexes: [0] })
            .setContext(ctx).draw();
        } catch { /* ignore */ }
      }
      if (srcNote?.noteType === "tie" && prevStaveNote && staveNote) {
        try {
          new StaveTie({ firstNote: prevStaveNote, lastNote: staveNote, firstIndexes: [0], lastIndexes: [0] })
            .setContext(ctx).draw();
        } catch { /* ignore */ }
      }
      tieIdx++;
    }
  }
}

function renderLegacyWithPulse(
  ctx: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  mainStave: Stave,
  pulseStave: Stave,
  staveW: number,
  mainGroups: KonnakolGroup[],
  pulseGroups: KonnakolGroup[],
  noTuplets: boolean,
  noteKey: string = SNARE_KEY,
  stemless: boolean = false,
): number[] {
  const mainBuilt = buildLegacyNotes(mainGroups, noTuplets, noteKey, stemless);
  const pulseBuilt = buildLegacyNotes(pulseGroups, true, noteKey);

  if (mainBuilt.notes.length === 0) return [];

  const mainVoice = new Voice({ numBeats: mainBuilt.totalSlots, beatValue: 16 });
  (mainVoice as unknown as { setMode(m: number): void }).setMode(2);
  mainVoice.addTickables(mainBuilt.notes);

  const voices: Voice[] = [mainVoice];
  let pulseVoice: Voice | null = null;
  if (pulseBuilt.notes.length > 0) {
    pulseVoice = new Voice({ numBeats: pulseBuilt.totalSlots, beatValue: 16 });
    (pulseVoice as unknown as { setMode(m: number): void }).setMode(2);
    pulseVoice.addTickables(pulseBuilt.notes);
    voices.push(pulseVoice);
  }

  const fmtW = Math.max(60, staveW - 40);
  // Joining voices forces the Formatter to assign identical x-coordinates to
  // notes that fall on the same tick — this is what actually keeps the pulse
  // quarter-notes sitting directly under each beat-start in the main staff.
  new Formatter().joinVoices(voices).format(voices, fmtW);

  mainVoice.draw(ctx, mainStave);
  drawLegacyBeamsAndTies(ctx, mainGroups, mainBuilt.notes, mainBuilt.tupletGroups);

  if (pulseVoice) {
    pulseVoice.draw(ctx, pulseStave);
    drawLegacyBeamsAndTies(ctx, pulseGroups, pulseBuilt.notes, pulseBuilt.tupletGroups);
  }

  try {
    return mainBuilt.notes.map(n => n.getAbsoluteX());
  } catch {
    return [];
  }
}

function renderLegacy(
  ctx: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  stave: Stave,
  staveW: number,
  groups: KonnakolGroup[],
  noTuplets: boolean,
  noteKey: string = SNARE_KEY,
  stemless: boolean = false,
): number[] {
  const { notes, tupletGroups, totalSlots } = buildLegacyNotes(groups, noTuplets, noteKey, stemless);
  if (notes.length === 0) return [];

  const voice = new Voice({ numBeats: totalSlots, beatValue: 16 });
  (voice as unknown as { setMode(m: number): void }).setMode(2);
  voice.addTickables(notes);

  const fmtW = Math.max(60, staveW - 40);
  new Formatter().joinVoices([voice]).format([voice], fmtW);

  voice.draw(ctx, stave);
  drawLegacyBeamsAndTies(ctx, groups, notes, tupletGroups);

  // Solkattu labels, drawn directly as SVG text for reliability.
  const labels = groups.flatMap(g => g.notes).map(n =>
    (n && n.noteType !== "rest" && !n.hidden && n.syllable) ? n.syllable : "",
  );
  drawSyllableLabels(ctx, stave, notes, labels);

  try {
    return notes.map(n => n.getAbsoluteX());
  } catch {
    return [];
  }
}

// Append raw <text> elements directly to the VexFlow SVG element. Going
// through the DOM is more reliable than ctx.fillText / VexFlow Annotation,
// both of which mispositioned text on setNumLines(1) staves.
//
// Color is explicit black; the container applies filter: invert(1), so it
// renders as white on the dark background. Caller supplies `labels`
// parallel to `notes` so each render path can compute syllables in its
// own mapping scheme.
function drawSyllableLabels(
  ctx: ReturnType<InstanceType<typeof Renderer>["getContext"]>,
  stave: Stave,
  notes: StaveNote[],
  labels: string[],
) {
  const svg = (ctx as unknown as { svg?: SVGSVGElement }).svg;
  if (!svg) return;
  // Place text just below the stave bottom line. On a single-line stave
  // getYForLine(0) ≈ stave-line Y; +18 drops it a safe gap under any
  // noteheads/beams. On a 5-line stave getYForLine(4) + 18 works the same
  // way — use bottom line for a consistent look.
  const numLines = (stave as unknown as { getNumLines?: () => number }).getNumLines?.() ?? 5;
  const bottomLineIdx = numLines <= 1 ? 0 : 4;
  const y = stave.getYForLine(bottomLineIdx) + 22;
  const NS = "http://www.w3.org/2000/svg";
  for (let i = 0; i < notes.length && i < labels.length; i++) {
    const label = labels[i];
    if (!label) continue;
    let x: number;
    try { x = notes[i].getAbsoluteX(); } catch { continue; }
    const text = document.createElementNS(NS, "text");
    text.setAttribute("x", String(x));
    text.setAttribute("y", String(y));
    text.setAttribute("font-family", "Arial, sans-serif");
    text.setAttribute("font-size", "11");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "#000000");
    text.textContent = label;
    svg.appendChild(text);
  }
}
