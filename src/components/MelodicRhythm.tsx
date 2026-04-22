import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  Renderer, Stave, StaveNote, StaveNoteStruct, Voice, Formatter, Beam, Barline, Tuplet, Dot, StaveTie,
} from "vexflow";
import {
  type RhythmStyle,
  type RhythmResult,
  STYLE_INFO,
  generateRhythm,
  melodyPositionStrengths,
  isTripletStyle,
} from "@/lib/rhythmGen";

// ── Duration helpers ──────────────────────────────────────────────────────
// beatSize = slots per beat.

/** Map a within-beat slot count to a VexFlow duration string. */
function withinBeatDur(slots: number, beatSize: number, bottom: number = 4): string {
  const grid = bottom === 8 ? beatSize * 2 : beatSize;
  if (grid <= 1) return "4";
  if (grid === 2) {
    if (slots >= 2) return "4";
    return "8";
  }
  if (grid === 3) {
    if (slots >= 3) return "4";
    if (slots >= 2) return "8d";
    return "8";
  }
  // grid === 4
  if (slots >= 4) return "4";
  if (slots >= 3) return "8d";
  if (slots >= 2) return "8";
  return "16";
}

/** Duration string for exact full-beat multiples (on-beat start). */
function fullBeatDur(beatCount: number, bottom: number): string | null {
  if (bottom === 8) {
    // Each beat = eighth note
    return ({ 8: "1", 6: "2d", 4: "2", 3: "4d", 2: "4", 1: "8" } as Record<number, string>)[beatCount] ?? null;
  }
  // /4 time: each beat = quarter note
  return ({ 4: "1", 3: "2d", 2: "2", 1: "4" } as Record<number, string>)[beatCount] ?? null;
}

/**
 * Split a slot span into VexFlow duration strings, respecting beat boundaries.
 * startSlot: absolute position in the bar.
 * slotCount: how many slots this note/rest spans.
 * totalSlots: bar length (used to decide half-bar alignment rules).
 * Returns an array of VexFlow duration strings whose values sum correctly.
 */
function splitAtBeats(
  startSlot: number,
  slotCount: number,
  beatSize: number,
  bottom: number = 4,
  totalSlots: number = 0,
): string[] {
  if (slotCount <= 0) return [];

  // Triplet grid: slots don't map 1:1 to standard durations.
  // Use flat mapping — tuplet brackets handle the visual interpretation.
  // VexFlow mode 2 (SOFT) doesn't enforce tick counts.
  if (beatSize === 3) {
    const result: string[] = [];
    let rem = slotCount;
    while (rem >= 6) { result.push("2"); rem -= 6; }
    while (rem >= 3) { result.push("4"); rem -= 3; }
    while (rem > 0) { result.push("8"); rem -= 1; }
    return result;
  }

  // Standard 16th grid in /4 (beatSize=4). For bottom=8 with beatSize=4 the
  // existing beat-split is retained since duration mapping there expects the
  // coarser per-beat fallback.
  if (beatSize === 4 && bottom === 4) {
    return greedySplit(startSlot, slotCount, totalSlots);
  }

  const endSlot = startSlot + slotCount;

  // If the span starts on a beat and covers exact whole beats, try a single duration
  const onBeat = startSlot % beatSize === 0;
  if (onBeat && slotCount % beatSize === 0) {
    const nBeats = slotCount / beatSize;
    const single = fullBeatDur(nBeats, bottom);
    if (single) return [single];
  }

  // If the span starts on a beat and is 1.5 beats (dotted beat), allow it
  if (onBeat && slotCount === Math.floor(beatSize * 1.5) && beatSize >= 2) {
    const dotted = bottom === 8 ? "8d" : "4d";
    return [dotted];
  }

  // Split at each beat boundary
  const segments: number[] = [];
  let pos = startSlot;
  while (pos < endSlot) {
    const nextBeat = (Math.floor(pos / beatSize) + 1) * beatSize;
    const segEnd = Math.min(nextBeat, endSlot);
    segments.push(segEnd - pos);
    pos = segEnd;
  }

  // Convert each segment to a VexFlow duration
  return segments.map(s => withinBeatDur(s, beatSize, bottom));
}

/**
 * Greedy longest-first split for standard 16th-grid /4 time.
 * At each step, picks the longest standard duration whose starting alignment
 * is legal at the current position. Alignment rules: a duration of N slots
 * may only start where `pos % alignment === 0`. Dotted values inherit the
 * alignment of their next-larger power-of-2 base so they don't cross a
 * higher-level metric boundary.
 *
 * For bars whose length divides into 8-slot halves (2/4, 4/4, 8/4, ...), the
 * half-bar is treated as a higher-level boundary: half notes and dotted
 * quarters must not cross it. For other bar sizes (3/4, 5/4, ...), no
 * half-bar rule is applied so half notes at interior beats remain legal.
 */
function greedySplit(startSlot: number, slotCount: number, totalSlots: number): string[] {
  const hasHalfBar = totalSlots > 0 && totalSlots % 8 === 0;
  const halfAlign = hasHalfBar ? 8 : 4;

  // Durations ordered longest-first. `align` = required divisor for start pos.
  const D: Array<{ slots: number; str: string; align: number }> = [
    { slots: 16, str: "1",  align: 16 },
    { slots: 12, str: "2d", align: 16 },
    { slots: 8,  str: "2",  align: halfAlign },
    { slots: 6,  str: "4d", align: halfAlign },
    { slots: 4,  str: "4",  align: 4 },
    { slots: 3,  str: "8d", align: 4 },
    { slots: 2,  str: "8",  align: 2 },
    { slots: 1,  str: "16", align: 1 },
  ];

  const result: string[] = [];
  let pos = startSlot;
  let rem = slotCount;
  while (rem > 0) {
    let chosen: { slots: number; str: string } | null = null;
    for (const d of D) {
      if (d.slots > rem) continue;
      if (pos % d.align !== 0) continue;
      chosen = d;
      break;
    }
    if (!chosen) chosen = { slots: 1, str: "16" };
    result.push(chosen.str);
    pos += chosen.slots;
    rem -= chosen.slots;
  }
  return result;
}

// ── Build proper note/rest sequence from hit positions ────────────────────

// Chord notes sit in the space just above the visible center line (stems up);
// melody notes sit in the space just below (stems down). Separating pitch
// placement keeps coincident chord+melody noteheads from stacking.
const CHORD_KEY  = "g/5";
const MELODY_KEY = "a/4";
const REST_KEY = "b/4";

interface BuildVoiceResult {
  notes: StaveNote[];
  ties: [number, number][]; // pairs of note indices to tie
}

function buildVoice(
  hits: number[],
  totalSlots: number,
  beatSize: number,
  bottom: number = 4,
  stemDir: 1 | -1 = 1,
): BuildVoiceResult {
  const NOTE_KEY = stemDir === 1 ? CHORD_KEY : MELODY_KEY;
  const sorted = [...hits].sort((a, b) => a - b);
  const notes: StaveNote[] = [];
  const ties: [number, number][] = [];
  let cursor = 0;

  for (let hi = 0; hi < sorted.length; hi++) {
    const pos = sorted[hi];
    const nextPos = hi + 1 < sorted.length ? sorted[hi + 1] : totalSlots;

    // Fill gap before this hit with rests
    if (cursor < pos) {
      const restDurs = splitAtBeats(cursor, pos - cursor, beatSize, bottom, totalSlots);
      for (const dur of restDurs) {
        const rn = new StaveNote({
          keys: [REST_KEY], duration: dur + "r", stemDirection: stemDir,
        } as StaveNoteStruct);
        if (dur.includes("d")) Dot.buildAndAttach([rn], { all: true });
        notes.push(rn);
      }
    }

    // The hit note: spans from pos to nextPos
    const durParts = splitAtBeats(pos, nextPos - pos, beatSize, bottom, totalSlots);
    // First part is the actual note
    const sn = new StaveNote({
      keys: [NOTE_KEY], duration: durParts[0], stemDirection: stemDir,
    } as StaveNoteStruct);
    if (durParts[0].includes("d")) Dot.buildAndAttach([sn], { all: true });
    notes.push(sn);
    // Remaining parts: visible tied notes
    for (let d = 1; d < durParts.length; d++) {
      const prevIdx = notes.length - 1;
      const tiedNote = new StaveNote({
        keys: [NOTE_KEY], duration: durParts[d], stemDirection: stemDir,
      } as StaveNoteStruct);
      if (durParts[d].includes("d")) Dot.buildAndAttach([tiedNote], { all: true });
      notes.push(tiedNote);
      ties.push([prevIdx, notes.length - 1]);
    }

    cursor = nextPos;
  }

  // Fill remaining slots with rests
  if (cursor < totalSlots) {
    const restDurs = splitAtBeats(cursor, totalSlots - cursor, beatSize, bottom, totalSlots);
    for (const dur of restDurs) {
      const rn = new StaveNote({
        keys: [REST_KEY], duration: dur + "r", stemDirection: stemDir,
      } as StaveNoteStruct);
      if (dur.includes("d")) Dot.buildAndAttach([rn], { all: true });
      notes.push(rn);
    }
  }

  return { notes, ties };
}

function buildBeams(notes: StaveNote[], beatSize: number): Beam[] {
  // Pass the full note list (rests included): VexFlow's generateBeams
  // uses cumulative ticks to align groups to beat boundaries, so removing
  // rests desyncs the tick math and beams end up spanning beat lines.
  // With beamRests:false (default), rests also break beams at their
  // actual positions, which is the musically correct behavior.
  if (beatSize === 2 || beatSize === 4) {
    return Beam.generateBeams(notes, { maintainStemDirections: true, flatBeams: true });
  }
  // Triplet grid: walk notes in order, grouping consecutive beamable
  // non-rest notes up to `beatSize` (3) per group. Rests and non-beamable
  // durations close the current group so they break beams at the right spot.
  const BEAMABLE = new Set(["8", "16", "32"]);
  const beams: Beam[] = [];
  let group: StaveNote[] = [];
  const flush = () => {
    if (group.length >= 2) {
      try {
        const beam = new Beam(group, false);
        (beam as unknown as { renderOptions: { flatBeams: boolean } }).renderOptions.flatBeams = true;
        beams.push(beam);
      } catch { /* skip */ }
    }
    group = [];
  };
  for (const n of notes) {
    if (n.isRest() || !BEAMABLE.has(n.getDuration())) {
      flush();
      continue;
    }
    group.push(n);
    if (group.length >= beatSize) flush();
  }
  flush();
  return beams;
}

function applyWhite(el: HTMLElement) {
  const svg = el.querySelector("svg");
  if (svg) (svg as SVGSVGElement).style.filter = "invert(1)";
}

// Voice time signature for VexFlow
function voiceTimeSig(beatSize: number, totalSlots: number, bottom: number = 4): { numBeats: number; beatValue: number } {
  if (bottom === 8) return { numBeats: totalSlots / beatSize, beatValue: 8 };
  if (beatSize === 3) return { numBeats: totalSlots, beatValue: 8 };
  if (beatSize === 1) return { numBeats: totalSlots, beatValue: 4 };
  const numBeats = totalSlots / beatSize;
  return { numBeats: Math.max(1, numBeats), beatValue: 4 };
}

// ── VexFlow dual-rhythm renderer ──────────────────────────────────────────
// Chord and melody share ONE stave with two voices (chord stems up, melody
// stems down) so their tick positions can never drift apart visually.

function drawTupletsForBuild(
  ctx: ReturnType<Renderer["getContext"]>,
  build: BuildVoiceResult,
  totalSlots: number,
) {
  const numBeatsLocal = Math.floor(totalSlots / 3);
  let noteIdx = 0;
  for (let b = 0; b < numBeatsLocal; b++) {
    const beatNotes: StaveNote[] = [];
    let slotsConsumed = 0;
    while (noteIdx < build.notes.length && slotsConsumed < 3) {
      beatNotes.push(build.notes[noteIdx]);
      const dur = build.notes[noteIdx].getDuration().replace("r", "").replace("d", "");
      const isDotted = build.notes[noteIdx].getDuration().includes("d");
      let durSlots = dur === "4" ? 3 : dur === "8" ? 1 : dur === "2" ? 6 : dur === "16" ? 1 : 1;
      if (isDotted) durSlots = Math.floor(durSlots * 1.5);
      slotsConsumed += durSlots;
      noteIdx++;
    }
    if (beatNotes.length >= 2 && beatNotes.some(n => !n.isRest())) {
      try {
        new Tuplet(beatNotes, {
          numNotes: 3, notesOccupied: 2,
          bracketed: true, ratioed: false, location: 1,
        }).setContext(ctx).draw();
      } catch { /* skip */ }
    }
  }
}

function VexDualRhythm({
  chordHits,
  melodyHits,
  totalSlots,
  beatSize,
  bottom,
  width,
  timeSigDisplay,
}: {
  chordHits: number[];
  melodyHits: number[];
  totalSlots: number;
  beatSize: number;
  bottom: number;
  width: number;
  timeSigDisplay: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const STAVE_Y = 10;
  const height = 110;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = "";

    try {
      const renderer = new Renderer(el, Renderer.Backends.SVG);
      renderer.resize(width, height);
      const ctx = renderer.getContext();
      ctx.setFont("Arial", 10);

      const staveW = width - 16;

      const stave = new Stave(8, STAVE_Y, staveW);
      stave.setConfigForLines([
        { visible: false },
        { visible: false },
        { visible: true },
        { visible: false },
        { visible: false },
      ]);
      stave.setBegBarType(Barline.type.NONE);
      stave.addTimeSignature(timeSigDisplay);
      stave.setEndBarType(Barline.type.END);
      stave.setContext(ctx).draw();

      // Chord voice: stems up (above the line). Melody voice: stems down
      // (below the line). Co-located on the same stave so ticks can't drift.
      const chordBuild = buildVoice(chordHits, totalSlots, beatSize, bottom, 1);
      const melodyBuild = buildVoice(melodyHits, totalSlots, beatSize, bottom, -1);

      if (chordBuild.notes.length === 0 && melodyBuild.notes.length === 0) {
        applyWhite(el);
        return;
      }

      const { numBeats, beatValue } = voiceTimeSig(beatSize, totalSlots, bottom);

      const makeVoice = (notes: StaveNote[]) => {
        const v = new Voice({ numBeats, beatValue });
        (v as unknown as { setMode(m: number): void }).setMode(2);
        v.addTickables(notes);
        return v;
      };

      const chordVoice = makeVoice(chordBuild.notes);
      const melodyVoice = makeVoice(melodyBuild.notes);

      // Build beams BEFORE drawing voices: the Beam constructor calls
      // setBeam() on each note, which suppresses the note's flag at draw time.
      const chordBeams = buildBeams(chordBuild.notes, beatSize);
      const melodyBeams = buildBeams(melodyBuild.notes, beatSize);

      const fmtW = staveW - 44;
      new Formatter({ softmaxFactor: 1, globalSoftmax: true })
        .joinVoices([chordVoice, melodyVoice])
        .format([chordVoice, melodyVoice], fmtW);

      chordVoice.draw(ctx, stave);
      melodyVoice.draw(ctx, stave);

      chordBeams.forEach(b => b.setContext(ctx).draw());
      melodyBeams.forEach(b => b.setContext(ctx).draw());

      const drawTies = (build: BuildVoiceResult) => {
        for (const [fromIdx, toIdx] of build.ties) {
          try {
            new StaveTie({
              firstNote: build.notes[fromIdx],
              lastNote: build.notes[toIdx],
              firstIndices: [0],
              lastIndices: [0],
            } as ConstructorParameters<typeof StaveTie>[0]).setContext(ctx).draw();
          } catch { /* skip */ }
        }
      };
      drawTies(chordBuild);
      drawTies(melodyBuild);

      if (beatSize === 3) {
        drawTupletsForBuild(ctx, chordBuild, totalSlots);
        drawTupletsForBuild(ctx, melodyBuild, totalSlots);
      }

      applyWhite(el);
    } catch (err) {
      console.warn("VexDualRhythm render error:", err);
    }
  }, [chordHits, melodyHits, totalSlots, beatSize, bottom, width, height, timeSigDisplay, STAVE_Y]);

  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-col flex-shrink-0 w-14 text-[9px] uppercase tracking-wider font-bold text-right leading-tight">
        <span style={{ color: "#c8aa50" }}>Chord ↑</span>
        <span style={{ color: "#9999ee" }}>Melody ↓</span>
      </div>
      <div ref={containerRef}
        style={{ width, height, overflow: "visible", display: "block", flexShrink: 0 }} />
    </div>
  );
}

// ── Preset time signatures ────────────────────────────────────────────────

const PRESETS = [
  { label: "4/4", beats: 4, bottom: 4 },
  { label: "3/4", beats: 3, bottom: 4 },
  { label: "2/4", beats: 2, bottom: 4 },
  { label: "6/8", beats: 6, bottom: 8 },
  { label: "5/8", beats: 5, bottom: 8 },
  { label: "7/8", beats: 7, bottom: 8 },
  { label: "9/8", beats: 9, bottom: 8 },
  { label: "5/4", beats: 5, bottom: 4 },
  { label: "11/8", beats: 11, bottom: 8 },
];

// ── Main Component ────────────────────────────────────────────────────────

export interface RhythmTimingData {
  /** Duration of each melody note as a fraction of the total bar (0-1). */
  durations: number[];
  /** Beats per bar for BPM calculation. */
  beatsPerBar: number;
  /** Time signature denominator. */
  bottom: number;
}

interface MelodicRhythmProps {
  melodyNoteCount: number;
  onMetricWeights?: (weights: number[]) => void;
  /** Callback with rhythm timing data for playback. */
  onRhythmTiming?: (data: RhythmTimingData) => void;
}

export default function MelodicRhythm({ melodyNoteCount, onMetricWeights, onRhythmTiming }: MelodicRhythmProps) {
  const [beats, setBeats] = useState(4);
  const [bottom, setBottom] = useState(4);
  const [customSig, setCustomSig] = useState("");
  const [style, setStyle] = useState<RhythmStyle>("straight");
  const [seed, setSeed] = useState(() => Date.now());

  // Triplet-based styles use 3 slots per beat (triplet grid); others use 4 (16th-note grid)
  const beatSize = isTripletStyle(style) ? 3 : 4;
  const totalSlots = beats * beatSize;
  const timeSigDisplay = `${beats}/${bottom}`;

  const rhythm: RhythmResult = useMemo(
    () => generateRhythm(beats, beatSize, style, melodyNoteCount, seed, bottom),
    [beats, beatSize, style, melodyNoteCount, seed, bottom],
  );

  // Report metric weights to parent for melody-rhythm coupling
  useEffect(() => {
    if (!onMetricWeights) return;
    const weights = melodyPositionStrengths(
      beats, beatSize, style, rhythm.melodyHits, bottom,
    );
    onMetricWeights(weights);
  }, [rhythm, onMetricWeights, beats, beatSize, style, bottom]);

  // Report rhythm timing data for playback
  useEffect(() => {
    if (!onRhythmTiming) return;
    const hits = rhythm.melodyHits;
    const total = rhythm.totalSlots;
    // Compute duration of each note as fraction of bar (gap to next hit, or to bar end)
    const durations = hits.map((slot, i) => {
      const nextSlot = i + 1 < hits.length ? hits[i + 1] : total;
      return (nextSlot - slot) / total;
    });
    onRhythmTiming({ durations, beatsPerBar: beats, bottom });
  }, [rhythm, onRhythmTiming, beats, bottom]);

  const regenerate = useCallback(() => {
    setSeed(Date.now() ^ Math.floor(Math.random() * 999999));
  }, []);

  const selectPreset = (p: typeof PRESETS[number]) => {
    setBeats(p.beats);
    setBottom(p.bottom);
    setCustomSig("");
    regenerate();
  };

  const applyCustomSig = () => {
    const m = customSig.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (m) {
      const t = parseInt(m[1]);
      const b = parseInt(m[2]);
      if (t >= 1 && t <= 32 && (b === 4 || b === 8 || b === 16)) {
        setBeats(t);
        setBottom(b);
        regenerate();
      }
    }
  };

  // Scale width by beats (not raw slots) so /8 and /4 look proportional
  const staveWidth = Math.max(350, Math.min(900, beats * 80 + 100));

  return (
    <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-3 space-y-3">
      <div className="flex items-center">
        <span className="text-[10px] text-[#666] uppercase tracking-widest font-semibold">Rhythm</span>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-end">
        {/* Time signature presets */}
        <div>
          <label className="block text-[9px] text-[#555] uppercase tracking-wider mb-1">Time Signature</label>
          <div className="flex gap-0.5 flex-wrap items-center">
            {PRESETS.map(p => (
              <button key={p.label}
                onClick={() => selectPreset(p)}
                className={`px-2 h-7 text-[11px] rounded border transition-colors ${
                  timeSigDisplay === p.label
                    ? "bg-[#1a1a2a] border-[#5a5a8a] text-[#9999ee]"
                    : "bg-[#111] border-[#1e1e1e] text-[#555] hover:text-[#aaa]"
                }`}>{p.label}</button>
            ))}
            {/* Custom input */}
            <input
              type="text"
              value={customSig}
              onChange={e => setCustomSig(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") applyCustomSig(); }}
              onBlur={applyCustomSig}
              placeholder="e.g. 13/8"
              className="w-16 h-7 px-1.5 text-[11px] rounded border bg-[#111] border-[#2a2a2a] text-white placeholder-[#333] focus:outline-none focus:border-[#5a5a8a]"
            />
          </div>
        </div>

        {/* Style */}
        <div>
          <label className="block text-[9px] text-[#555] uppercase tracking-wider mb-1">Style</label>
          <div className="flex gap-0.5 flex-wrap">
            {STYLE_INFO.map(s => (
              <button key={s.value}
                onClick={() => { setStyle(s.value); regenerate(); }}
                title={s.desc}
                className={`px-2 h-7 text-[11px] rounded border transition-colors ${
                  style === s.value ? "text-white" : "bg-[#111] border-[#1e1e1e] text-[#555] hover:text-[#aaa]"
                }`}
                style={style === s.value ? { backgroundColor: s.color + "20", borderColor: s.color + "80", color: s.color } : {}}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Shared-formatter dual-lane rhythm — aligned per tick */}
      <div className="overflow-x-auto">
        <VexDualRhythm
          chordHits={rhythm.chordHits}
          melodyHits={rhythm.melodyHits}
          totalSlots={rhythm.totalSlots}
          beatSize={rhythm.beatSize}
          bottom={rhythm.bottom}
          width={staveWidth}
          timeSigDisplay={timeSigDisplay}
        />
      </div>

      <div className="flex items-center justify-between">
        <button onClick={regenerate}
          className="px-4 py-2 text-sm font-semibold rounded-md bg-[#1a2a1a] border border-[#3a6a3a] text-[#6abf6a] hover:bg-[#2a3a2a] hover:text-[#8ade8a] transition-colors">
          Randomize
        </button>
        <span className="text-[9px] text-[#444]">
          {timeSigDisplay} — {style} — {rhythm.chordHits.length} chord hits, {rhythm.melodyHits.length} melody hits
        </span>
      </div>
    </div>
  );
}
