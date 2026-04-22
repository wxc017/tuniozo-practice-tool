import { useEffect, useRef } from "react";
import {
  Renderer, Stave, StaveNote, StaveNoteStruct, Voice, Formatter, Beam, Barline,
  Articulation, Annotation, GraceNote, GraceNoteGroup, Parenthesis, Tremolo, ModifierPosition,
  Tuplet, StaveTie, Dot,
} from "vexflow";
import { GridType, GRID_SUBDIVS } from "@/lib/drumData";

// ── DrumAccent ────────────────────────────────────────────────────────────────
// Draws accent mark (>) a fixed distance above the beam/stem tip.
class DrumAccent extends Annotation {
  constructor() { super(">"); this.setFont("Arial", 14, "bold"); }
  override draw(): void {
    try {
      const note = (this as any).checkAttachedNote() as StaveNote;
      const ctx = this.checkContext();
      const x = note.getAbsoluteX();
      // Use stave top line as consistent reference so all accents align horizontally
      const stave = note.getStave();
      // Use the higher of stave-top-text or stem-top so accents clear 32nd-note beams
      const staveY = stave ? stave.getYForTopText(1) - 4 : Infinity;
      const stemY  = note.getStemExtents().topY - 8;
      const y = Math.min(staveY, stemY);
      const prevFont = ctx.getFont();
      ctx.setFont("Arial", 14, "bold");
      ctx.fillText(">", x - 2, y);
      ctx.setFont(prevFont);
    } catch { /* ignore render errors */ }
  }
}

// ── DrumTremolo ────────────────────────────────────────────────────────────────
// VexFlow's stock Tremolo.draw() starts at getStemExtents().topY (the beam end)
// and moves marks downward — they sit right inside the beam and are invisible.
// This subclass mirrors the same logic but adds BEAM_CLEAR px of downward offset
// so the marks land on the stem below the beam, where they're always readable.
class DrumTremolo extends Tremolo {
  private scale: number;
  constructor(num: number, scale = 0.25) { super(num); this.scale = scale; }
  override draw(): void {
    // Position tremolo marks just above the notehead (baseY) on the stem,
    // not relative to beam/stem tip — so they stay near the doubled note
    // even when the stem is long due to chord voicing (e.g. HH + ghost).
    const note = (this as any).checkAttachedNote() as StaveNote;
    const orig = note.getStemExtents.bind(note);
    note.getStemExtents = () => {
      const e = orig();
      // Place marks above the notehead (baseY), independent of stem length.
      // This keeps the tremolo visually attached to the note being doubled.
      // Offset enough to clear the notehead entirely (notehead is ~8px tall).
      return { ...e, topY: e.baseY - 24 };
    };
    // Wrap in a scaled SVG group so the tremolo marks render smaller
    const ctx = this.checkContext();
    const svgCtx = ctx as any;
    const parentSvg = svgCtx.svg as SVGElement | undefined;
    let wrapper: SVGGElement | undefined;
    if (parentSvg && this.scale !== 1) {
      const x = note.getAbsoluteX();
      const e = note.getStemExtents();
      const cy = e.topY;
      wrapper = document.createElementNS("http://www.w3.org/2000/svg", "g");
      wrapper.setAttribute("transform",
        `translate(${x}, ${cy}) scale(${this.scale}) translate(${-x}, ${-cy})`);
      parentSvg.appendChild(wrapper);
      svgCtx.svg = wrapper;
    }
    try { super.draw(); } finally {
      note.getStemExtents = orig;
      if (wrapper && parentSvg) svgCtx.svg = parentSvg;
    }
  }
}

// Draws a small "z" on the stem for buzz roll notation.
class DrumBuzzZ extends Annotation {
  constructor() { super("z"); this.setFont("Arial", 12, "bold"); }
  override draw(): void {
    const note = (this as any).checkAttachedNote() as StaveNote;
    const ctx = this.checkContext();
    const stemX = (note as any).getStemX?.() ?? note.getAbsoluteX();
    const ext = note.getStemExtents();
    const y = ext.topY + (ext.baseY - ext.topY) * 0.70 + 3;
    const prevFont = ctx.getFont();
    ctx.setFont("Arial", 12, "bold");
    // Center the "z" on the stem (half glyph width ~4px)
    ctx.fillText("z", stemX - 4, y);
    ctx.setFont(prevFont);
  }
}

// ── Staff positions ────────────────────────────────────────────────────────────
const HH_KEY      = "a/5";   // x-head stem-up  (HH cymbal / ostinato, top line)
const CRASH_KEY   = "c/6";   // x-head stem-up  (crash cymbal, ledger line above staff)
const SN_KEY      = "c/5";   // normal stem-up   (snare & ghost)
const TOM_KEY     = "e/5";   // normal stem-up   (high tom / orchestration)
const BD_KEY      = "f/4";   // normal stem-down (bass drum)
const HH_FOOT_KEY = "c/4";   // x-head stem-down (HH pedal, ledger below)
const REST_KEY    = "b/4";


// SMuFL notehead unicode glyphs (Bravura font, U+E0xx)
const GLYPH_X        = "\uE0A9"; // noteheadXBlack      — closed hi-hat / ostinato
const GLYPH_CIRCLE_X = "\uE0B3"; // noteheadCircleX     — open hi-hat
type HackNH = { noteType: string; text: string };

// ── Duration helpers ──────────────────────────────────────────────────────────
// Returns [vfDuration, leftoverSlots].
// beatSize: 4 = 16th grid, 2 = 8th grid, 3 = triplet grid
// tripletGroup3: when true, 16th-grid 3-slot notes split as 8th + remaining 16th
// (instead of dotted-8th) so a held triplet-ostinato beat renders as two tied
// notes spanning the 3-sixteenth group, making the grouping visible.
function slotsToVfDur(slots: number, beatSize: number, tripletGroup3 = false): [string, number] {
  if (beatSize === 3) {
    // Triplet: 1 slot ≈ triplet-8th → use "8" (1 beam)
    if (slots >= 3) return ["4",  slots - 3];
    return ["8", slots - 1];
  }
  if (beatSize === 5) {
    // Quintuplet: matches konnakol partToNoteEntries mapping
    // 5 = quarter+16th(tied), 4 = quarter, 3 = dotted 8th, 2 = 8th, 1 = 16th
    if (slots >= 4) return ["4",  slots - 4];
    if (slots >= 3) return ["8d", slots - 3];
    if (slots >= 2) return ["8",  slots - 2];
    return ["16", slots - 1];
  }
  if (beatSize === 6) {
    // Sextuplet: matches konnakol partToNoteEntries mapping
    // 6 = dotted quarter, 5 = quarter+16th(tied), 4 = quarter, 3 = dotted 8th, 2 = 8th, 1 = 16th
    if (slots >= 6) return ["4d", slots - 6];
    if (slots >= 4) return ["4",  slots - 4];
    if (slots >= 3) return ["8d", slots - 3];
    if (slots >= 2) return ["8",  slots - 2];
    return ["16", slots - 1];
  }
  if (beatSize === 7) {
    // Septuplet: matches konnakol partToNoteEntries mapping
    // 7 = dotted quarter+8th(tied), 6 = dotted quarter, 4 = quarter, 3 = dotted 8th, 2 = 8th, 1 = 16th
    if (slots >= 6) return ["4d", slots - 6];
    if (slots >= 4) return ["4",  slots - 4];
    if (slots >= 3) return ["8d", slots - 3];
    if (slots >= 2) return ["8",  slots - 2];
    return ["16", slots - 1];
  }
  if (beatSize === 8) {
    // 32nd grid: 8 slots = 1 quarter; 1 slot = 32nd note
    if (slots >= 8) return ["4",  slots - 8];
    if (slots >= 4) return ["8",  slots - 4];
    if (slots >= 2) return ["16", slots - 2];
    return              ["32", slots - 1];
  }
  if (beatSize === 2) {
    // 8th grid: 1 slot = 8th
    if (slots >= 8) return ["1",  slots - 8];
    if (slots >= 4) return ["2",  slots - 4];
    if (slots >= 2) return ["4",  slots - 2];
    return ["8", slots - 1];
  }
  // 16th grid (beatSize = 4)
  if (tripletGroup3) {
    // Break at triplet-group (3-slot) boundaries so a held beat renders as
    // two tied notes (8th + 16th) instead of a dotted 8th — makes the
    // group-of-three visible in the notation.
    if (slots >= 6)  return ["4d",  slots - 6];
    if (slots >= 4)  return ["4",   slots - 4];
    if (slots >= 3)  return ["8",   slots - 2]; // 8th now, 16th next
    if (slots >= 2)  return ["8",   slots - 2];
    return              ["16",  slots - 1];
  }
  if (slots >= 16) return ["1",   slots - 16];
  if (slots >= 12) return ["2d",  slots - 12];
  if (slots >= 8)  return ["2",   slots - 8];
  if (slots >= 6)  return ["4d",  slots - 6];
  if (slots >= 4)  return ["4",   slots - 4];
  if (slots >= 3)  return ["8d",  slots - 3];
  if (slots >= 2)  return ["8",   slots - 2];
  return              ["16",  slots - 1];
}

// Build beams for a voice's note array.
// For non-standard beat sizes (anything other than 2 or 4) notes are grouped
// sequentially by beatSize so every group shares one beam.
// The standard 8th/16th grids (beatSize 2 or 4) fall through to VexFlow's auto-beamer.
function buildBeams(notes: StaveNote[], beatSize: number): Beam[] {
  // Pass the full note list (rests included): VexFlow's generateBeams uses
  // cumulative ticks to align beam groups to beat boundaries, and with
  // beamRests:false (the default) rests also break beams at their actual
  // positions. Stripping rests desyncs the tick math so non-adjacent hits
  // (e.g. bass on slots 0 and 3 of a 4-slot bar) end up beamed across the
  // gap instead of each showing their own flag.
  if (beatSize === 2 || beatSize === 4) {
    return Beam.generateBeams(notes, { maintainStemDirections: true, flatBeams: true });
  }
  const BEAMABLE = new Set(["8", "16", "32"]);
  const beams: Beam[] = [];
  let group: StaveNote[] = [];
  const flush = () => {
    if (group.length >= 2) {
      try {
        const beam = new Beam(group, false);
        (beam as unknown as { renderOptions: { flatBeams: boolean } }).renderOptions.flatBeams = true;
        beams.push(beam);
      } catch { /* ignore */ }
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

// Inverse of slotsToVfDur: maps a rendered VexFlow duration string back to
// the number of slots it occupies under the given beat size.  Used when we
// need to walk voice notes (including rests) in slot order — e.g. to split
// them into per-beat tuplet groups for bracket rendering.
function vfDurToSlots(dur: string, beatSize: number): number {
  const clean = dur.replace(/r$/, "");
  if (beatSize === 3) {
    if (clean === "8")  return 1;
    if (clean === "4")  return 3;
    if (clean === "2")  return 6;
    if (clean === "1")  return 12;
    return 0;
  }
  if (beatSize === 4) {
    if (clean === "16") return 1;
    if (clean === "8")  return 2;
    if (clean === "8d") return 3;
    if (clean === "4")  return 4;
    if (clean === "4d") return 6;
    if (clean === "2")  return 8;
    if (clean === "2d") return 12;
    if (clean === "1")  return 16;
    return 0;
  }
  if (beatSize === 2) {
    if (clean === "8")  return 1;
    if (clean === "4")  return 2;
    if (clean === "2")  return 4;
    if (clean === "1")  return 8;
    return 0;
  }
  return 0;
}

// Build beams with an explicit slot-based grouping.  Walks `notes` (including
// rests) tracking cumulative slot position, and groups consecutive non-rest
// beamable notes whose positions fall in the same `groupSize`-slot window.
// `startOffset` shifts where the first group boundary lands — a bar whose
// preceding phrase summed to 4 slots under groupSize:3 passes startOffset:1
// so its first beam closes the still-open group from across the barline.
// Rests and non-beamable durations break the beam (standard notation: a beam
// can't span a rest).
function buildBeamsByGrouping(
  notes: StaveNote[],
  beatSize: number,
  groupSize: number,
  startOffset: number,
  // When true, rests inside a group don't break the beam — they're skipped
  // silently. Used by ostinato previews where hits are shown as 1-slot
  // attacks with (hidden) rests filling the gaps: the visual beam spans
  // all attacks in the beat, which is what the user expects for a
  // quintuplet/septuplet etc.
  beamAcrossRests: boolean = false,
): Beam[] {
  const BEAMABLE = new Set(["8", "16", "32"]);
  const beams: Beam[] = [];
  let group: StaveNote[] = [];
  let currentGroupId = Math.floor(startOffset / groupSize);
  let slotCursor = startOffset;
  const flushGroup = () => {
    if (group.length >= 2) {
      try {
        const beam = new Beam(group, false);
        (beam as unknown as { renderOptions: { flatBeams: boolean } }).renderOptions.flatBeams = true;
        beams.push(beam);
      } catch { /* ignore */ }
    }
    group = [];
  };
  for (const n of notes) {
    const noteSlots = vfDurToSlots(n.getDuration(), beatSize);
    const startSlot = slotCursor;
    if (noteSlots > 0) slotCursor += noteSlots;
    const noteGroupId = Math.floor(startSlot / groupSize);
    if (noteGroupId !== currentGroupId) {
      flushGroup();
      currentGroupId = noteGroupId;
    }
    if (!n.isRest() && BEAMABLE.has(n.getDuration())) {
      group.push(n);
    } else if (n.isRest() && beamAcrossRests) {
      // Skip the rest silently — keep the group open so the beam spans
      // across the rest's slots.
      continue;
    } else {
      flushGroup();
    }
  }
  flushGroup();
  return beams;
}

// Walk `notes` and split them into per-tuplet groups, where each group covers
// exactly `tupletSlots` slots (e.g. 3 for a triplet beat in triplet grid).
// Notes are measured by their slot duration via vfDurToSlots; rests count
// the same as hits, so a whole-beat rest becomes its own one-element group.
// A trailing partial group (fewer than tupletSlots slots) is dropped — a 3:2
// bracket over a single leftover note renders as garbage, so we'd rather
// have no bracket than a broken one.
function splitNotesIntoTupletGroups(notes: StaveNote[], beatSize: number, tupletSlots: number): StaveNote[][] {
  const groups: StaveNote[][] = [];
  let current: StaveNote[] = [];
  let acc = 0;
  for (const n of notes) {
    const slots = vfDurToSlots(n.getDuration(), beatSize);
    if (slots <= 0) { current.push(n); continue; }
    current.push(n);
    acc += slots;
    if (acc >= tupletSlots) {
      if (acc === tupletSlots) {
        groups.push(current);
        current = [];
        acc = 0;
      } else {
        // Note's duration straddles a tuplet boundary (shouldn't normally
        // happen under slotsToVfDur's emissions, but guard against it) —
        // keep the note in the current group and carry leftover into the
        // next group.
        groups.push(current);
        current = [];
        acc -= tupletSlots;
      }
    }
  }
  // Drop trailing partial group — a single-note bracket is worse than none.
  return groups;
}

function splitSlots(slots: number, beatSize: number, tripletGroup3 = false): string[] {
  const result: string[] = [];
  let rem = slots;
  while (rem > 0) {
    const [dur, left] = slotsToVfDur(rem, beatSize, tripletGroup3);
    result.push(dur);
    rem = left;
  }
  return result;
}

function makeRest(dur: string, stemDir: number, visible = false): StaveNote {
  const n = new StaveNote({ keys: [REST_KEY], duration: dur + "r", stemDirection: stemDir });
  if (dur.includes("d")) { try { Dot.buildAndAttach([n], { all: true }); } catch { /* ignore */ } }
  if (!visible) n.setStyle({ fillStyle: "transparent", strokeStyle: "transparent" });
  return n;
}

// Apply x or circle-x notehead glyph to an already-constructed NoteHead.
// VexFlow 5: `_text` is the rendered SMuFL glyph char, set at construction
// from glyphProps.codeHead.  Changing noteType alone won't update the
// rendered glyph — we must set both .noteType AND .text.
function applyXHead(noteHead: unknown, isOpen: boolean) {
  const nh = noteHead as HackNH;
  nh.noteType = isOpen ? "h" : "x";
  nh.text     = isOpen ? GLYPH_CIRCLE_X : GLYPH_X;
}

// ── Patch descriptor for deferred X-head application ─────────────────────────
interface XPatch { note: StaveNote; headIndex: number; isOpen: boolean; }

// ── Merged voice builder ──────────────────────────────────────────────────────
function buildMergedVoice(
  keys:             string[],
  stemDir:          number,
  xFlags:           boolean[],
  hitArrays:        number[][],
  openArrays:       number[][],
  slotCount:        number,
  beatSize:         number,
  ghostIndices:     number[] = [],
  showRests:        boolean  = false,
  hideGhostParens:  boolean  = false,
  doubleIndices:    number[] = [],
  tripletGroup3:    boolean  = false,
  // When true, every hit is 1 slot long and the gap to the next hit is
  // filled with rests instead of extending the current note. Drum attacks
  // (kick/snare/bass) are short events, not sustained pitches — without
  // this cap, sparse hits render as dotted 8ths/8ths and the formatter
  // allocates uneven widths that make adjacent notes overlap visually.
  shortHits:        boolean  = false,
): { notes: StaveNote[]; xPatches: XPatch[]; tieChains: number[][] } {
  const allHits = new Set<number>();
  hitArrays.forEach(arr => arr.filter(s => s < slotCount).forEach(s => allHits.add(s)));
  const sortedHits = [...allHits].sort((a, b) => a - b);

  const notes: StaveNote[] = [];
  const xPatches: XPatch[] = [];
  const tieChains: number[][] = [];
  let cursor = 0;

  const fillRests = (gap: number) => {
    for (const rd of splitSlots(gap, beatSize, tripletGroup3)) notes.push(makeRest(rd, stemDir, showRests));
  };

  for (let hi = 0; hi < sortedHits.length; hi++) {
    const pos     = sortedHits[hi];
    const nextPos = hi + 1 < sortedHits.length ? sortedHits[hi + 1] : slotCount;

    if (cursor < pos) {
      fillRests(pos - cursor);
    }

    const activeVIs = hitArrays
      .map((arr, vi) => (arr.filter(s => s < slotCount).includes(pos) ? vi : -1))
      .filter(vi => vi >= 0);

    // Hits hold to the next hit by default — that's the traditional drum
    // notation where, say, a bass on slot 0 and another on slot 3 renders
    // as a dotted 8th + 16th beamed together. shortHits forces every hit
    // short (single 16th + trailing rest), which K/S tile galleries and
    // ostinato patterns flagged for visible rests request explicitly.
    const noteDur = shortHits ? 1 : nextPos - pos;

    // Check if any ghost voice at this position has double-stroke
    const doubleGhostVI = activeVIs
      .filter(vi => ghostIndices.includes(vi))
      .find(vi => openArrays[vi].filter(s => s < slotCount).includes(pos));

    // Check if any non-ghost voice at this position has double-stroke
    const doubleNonGhostVI = activeVIs
      .filter(vi => doubleIndices.includes(vi))
      .find(vi => openArrays[vi].filter(s => s < slotCount).includes(pos));

    // ── Normal note / chord (handles ghost doubles via Tremolo too) ─────────
    {
      const noteKeys = activeVIs.map(vi => keys[vi]);
      // Only apply triplet-group3 splitting when every active voice in this
      // chord is a cymbal x-head (ostinato, crash).  Snare/ghost/tom/bass
      // chords keep the original dotted-8th rendering so they aren't forced
      // into spurious ties.
      const cymbalOnly = activeVIs.length > 0 && activeVIs.every(vi => xFlags[vi]);
      const effectiveTriplet = tripletGroup3 && cymbalOnly;
      const [vfDur, extra] = slotsToVfDur(noteDur, beatSize, effectiveTriplet);
      const note = new StaveNote({
        keys: noteKeys, duration: vfDur, stemDirection: stemDir,
      } as StaveNoteStruct);
      if (vfDur.includes("d")) { try { Dot.buildAndAttach([note], { all: true }); } catch { /* ignore */ } }

      const hasGhost    = activeVIs.some(vi =>  ghostIndices.includes(vi));
      const hasNonGhost = activeVIs.some(vi => !ghostIndices.includes(vi));
      activeVIs.forEach((vi, ki) => {
        const isOpen = openArrays[vi].filter(s => s < slotCount).includes(pos);
        if (xFlags[vi]) xPatches.push({ note, headIndex: ki, isOpen });
      });

      if (hasGhost && !hideGhostParens) {
        // Add parentheses to ghost noteheads
        try {
          if (!hasNonGhost) {
            // Ghost-only note → whole note gets parentheses
            note.addModifier(new Parenthesis(ModifierPosition.LEFT));
            note.addModifier(new Parenthesis(ModifierPosition.RIGHT));
          } else {
            // Mixed chord (ghost + other voices) → parentheses on ghost noteheads only
            activeVIs.forEach((vi, ki) => {
              if (ghostIndices.includes(vi)) {
                note.addModifier(new Parenthesis(ModifierPosition.LEFT), ki);
                note.addModifier(new Parenthesis(ModifierPosition.RIGHT), ki);
              }
            });
          }
        } catch { /* ignore */ }
      }

      // Double-stroke ghost → add DrumTremolo(2) below the notehead
      if (doubleGhostVI !== undefined || doubleNonGhostVI !== undefined) {
        try { note.addModifier(new DrumTremolo(2)); } catch { /* ignore */ }
      }

      // Only split/tie when the chord is cymbal-only (every active voice is
      // an x-head — ostinato or crash).  If any snare/ghost/tom/bass is in
      // the chord, keep the single-note rendering so those voices aren't
      // forced into spurious ties.
      const firstIdx = notes.length;
      notes.push(note);
      if (extra > 0) {
        if (tripletGroup3 && cymbalOnly) {
          // Emit extras as tied continuation notes (same pitches) so the held
          // beat renders as two (or more) tied notes spanning the 3-sixteenth
          // group, not as rests.
          const chain = [firstIdx];
          for (const rd of splitSlots(extra, beatSize, tripletGroup3)) {
            const cont = new StaveNote({
              keys: noteKeys, duration: rd, stemDirection: stemDir,
            } as StaveNoteStruct);
            if (rd.includes("d")) { try { Dot.buildAndAttach([cont], { all: true }); } catch { /* ignore */ } }
            // Preserve x-head glyphs on continuation noteheads
            activeVIs.forEach((vi, ki) => {
              if (xFlags[vi]) {
                const isOpen = openArrays[vi].filter(s => s < slotCount).includes(pos);
                xPatches.push({ note: cont, headIndex: ki, isOpen });
              }
            });
            chain.push(notes.length);
            notes.push(cont);
          }
          if (chain.length >= 2) tieChains.push(chain);
        } else {
          // Non-cymbal chord OR tripletGroup3 off — keep the original
          // behaviour: the held slots become (hidden) rests rather than ties.
          // Under tripletGroup3 this means slotsToVfDur still emitted a short
          // head note (e.g. "8") and we need to fill the remainder; use
          // non-triplet splitting so the rests use their natural durations.
          for (const rd of splitSlots(extra, beatSize, false)) notes.push(makeRest(rd, stemDir, showRests));
        }
      }
    }
    cursor = pos + noteDur;
  }

  if (cursor < slotCount) {
    fillRests(slotCount - cursor);
  }
  return { notes, xPatches, tieChains };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function applyWhite(el: HTMLElement) {
  const svg = el.querySelector("svg");
  if (svg) (svg as SVGSVGElement).style.filter = "invert(1)";
}

// Centre the full 5-voice content (top = staveY-5, bottom = staveY+125) in h px.
// Extra headroom for accent marks above ostinato stems.
function computeStaveY(h: number): number {
  return Math.max(30, Math.round(h * 0.22));
}

// numBeats / beatValue for a Voice given grid and slotCount
function voiceTimeSig(beatSize: number, slotCount: number): { numBeats: number; beatValue: number } {
  if (beatSize === 3) {
    // Each triplet slot → "8" note.  Set budget = slotCount × 8th notes.
    return { numBeats: slotCount, beatValue: 8 };
  }
  // If slotCount isn't evenly divisible by beatSize, express in 16th notes
  // to avoid fractional numBeats (e.g. 7 slots / 4 = 1.75 quarters → 7/16 instead)
  if (slotCount % beatSize !== 0) {
    return { numBeats: slotCount, beatValue: 16 };
  }
  // 16th and 8th grids: budget in quarter notes
  const numBeats = slotCount / beatSize;   // 16th: 4slots/4=1; 8th: 2slots/2=1; full: 4
  return { numBeats: Math.max(1, numBeats), beatValue: 4 };
}

// ── Accent & sticking annotation helper ──────────────────────────────────────
function addAccentsAndStickings(
  upNotes: StaveNote[],
  ostinatoHits: number[],
  snareHits: number[],
  ghostHits: number[],
  slotCount: number,
  beatSize: number,
  accentSet: Set<number>,
  stickingMap: Map<number, string>,
  accentInterp?: string,
  tapInterp?: string,
  tripletGroup3: boolean = false,
  // Must mirror buildMergedVoice's shortHits flag: when true the voice
  // uses a 1-slot hit + rest-filled gap instead of a held note, so the
  // note-index walk has to advance over those rest notes when hopping
  // between hits. Without this the accent lands on the wrong StaveNote.
  shortHits: boolean = false,
) {
  const hasWork = accentSet.size > 0 || stickingMap.size > 0 || !!accentInterp || !!tapInterp;
  if (!hasWork) return;

  const ghostSet = new Set(ghostHits.filter(s => s < slotCount));

  const allUp = new Set<number>();
  [ostinatoHits, snareHits, ghostHits].forEach(arr =>
    arr.filter(s => s < slotCount).forEach(s => allUp.add(s))
  );
  const sortedUp = [...allUp].sort((a, b) => a - b);

  let noteIdx = 0;
  let cursor = 0;
  for (let hi = 0; hi < sortedUp.length; hi++) {
    const pos = sortedUp[hi];
    if (cursor < pos) {
      noteIdx += splitSlots(pos - cursor, beatSize, tripletGroup3).length;
    }
    if (noteIdx < upNotes.length && !upNotes[noteIdx].isRest()) {
      const note = upNotes[noteIdx];
      const isAccent = accentSet.has(pos);
      const isGhostOnly = ghostSet.has(pos) && !snareHits.filter(s => s < slotCount).includes(pos) && !ostinatoHits.filter(s => s < slotCount).includes(pos);

      // Accent marking — fixed distance above beam/stem tip
      if (isAccent) {
        try {
          note.addModifier(new DrumAccent());
        } catch { /* ignore */ }
      }

      // Sticking annotation
      if (stickingMap.has(pos)) {
        try {
          const ann = new Annotation(stickingMap.get(pos)!);
          ann.setFont("Arial", 8, "bold");
          ann.setVerticalJustification(Annotation.VerticalJustify.BOTTOM);
          note.addModifier(ann);
        } catch { /* ignore */ }
      }

      // Accent interpretation: affects accented snare notes
      if (isAccent && accentInterp) {
        try {
          if (accentInterp === "accent-flam") {
            const g = new GraceNote({ keys: [SN_KEY], duration: "8", slash: true, stemDirection: 1 } as StaveNoteStruct);
            const grp = new GraceNoteGroup([g], true);
            note.addModifier(grp, 0);
          } else if (accentInterp === "accent-double") {
            // Double stroke: one slash through the stem
            note.addModifier(new DrumTremolo(1));
          } else if (accentInterp === "accent-buzz") {
            // Buzz roll: "z" above the notehead (standard notation)
            note.addModifier(new DrumBuzzZ());
          }
        } catch { /* ignore */ }
      }

      // Tap interpretation: affects ghost-only tap notes
      if (isGhostOnly && tapInterp) {
        try {
          if (tapInterp === "tap-buzz") {
            // Buzz roll: "z" above the notehead (standard notation)
            note.addModifier(new DrumBuzzZ());
          } else if (tapInterp === "tap-flam") {
            const g = new GraceNote({ keys: [SN_KEY], duration: "8", slash: true, stemDirection: 1 } as StaveNoteStruct);
            const grp = new GraceNoteGroup([g], true);
            note.addModifier(grp, 0);
          } else if (tapInterp === "tap-double") {
            // Double stroke: one slash through the stem
            note.addModifier(new DrumTremolo(1));
          }
        } catch { /* ignore */ }
      }
    }
    const nextPos = hi + 1 < sortedUp.length ? sortedUp[hi + 1] : slotCount;
    const noteDur = nextPos - pos;
    noteIdx += 1;
    if (shortHits) {
      // Hit is a fixed 1-slot attack; remaining slots are rest notes.
      const gap = noteDur - 1;
      if (gap > 0) noteIdx += splitSlots(gap, beatSize, tripletGroup3).length;
    } else {
      const [, extra] = slotsToVfDur(noteDur, beatSize, tripletGroup3);
      if (extra > 0) noteIdx += splitSlots(extra, beatSize, tripletGroup3).length;
    }
    cursor = nextPos;
  }
}

function addBassStickings(
  downNotes: StaveNote[],
  bassHits: number[],
  slotCount: number,
  beatSize: number,
  stickingMap: Map<number, string>,
) {
  if (stickingMap.size === 0 || bassHits.length === 0) return;
  const bassSet = new Set(bassHits.filter(s => s < slotCount));
  const sortedDown = [...bassSet].sort((a, b) => a - b);
  let noteIdx = 0;
  let cursor = 0;
  for (const pos of sortedDown) {
    if (cursor < pos) {
      noteIdx += splitSlots(pos - cursor, beatSize).length;
    }
    if (noteIdx < downNotes.length && !downNotes[noteIdx].isRest() && stickingMap.has(pos)) {
      try {
        const ann = new Annotation(stickingMap.get(pos)!);
        ann.setFont("Arial", 8, "bold");
        ann.setVerticalJustification(Annotation.VerticalJustify.BOTTOM);
        downNotes[noteIdx].addModifier(ann);
      } catch { /* ignore */ }
    }
    const nextIdx = sortedDown.indexOf(pos) + 1;
    const nextPos = nextIdx < sortedDown.length ? sortedDown[nextIdx] : slotCount;
    const noteDur = nextPos - pos;
    noteIdx += 1;
    const [, extra] = slotsToVfDur(noteDur, beatSize);
    if (extra > 0) noteIdx += splitSlots(extra, beatSize).length;
    cursor = nextPos;
  }
}

// ── Single-measure component ──────────────────────────────────────────────────
export interface VexDrumNotationProps {
  grid: GridType;
  ostinatoHits?: number[];
  ostinatoOpen?: number[];
  snareHits?: number[];
  bassHits?: number[];
  hhFootHits?: number[];
  hhFootOpen?: number[];
  ghostHits?: number[];
  ghostDoubleHits?: number[];
  snareDoubleHits?: number[];
  bassDoubleHits?: number[];
  accentFlags?: boolean[];
  stickings?: string[];
  accentInterpretation?: string;
  tapInterpretation?: string;
  showRests?: boolean;
  hideGhostParens?: boolean;
  bassStemUp?: boolean;
  width: number;
  height: number;
  beatOnly?: boolean;
  showClef?: boolean;
}

export default function VexDrumNotation({
  grid,
  ostinatoHits    = [],
  ostinatoOpen    = [],
  snareHits       = [],
  bassHits        = [],
  hhFootHits      = [],
  hhFootOpen      = [],
  ghostHits       = [],
  ghostDoubleHits = [],
  snareDoubleHits = [],
  bassDoubleHits  = [],
  accentFlags     = [],
  stickings       = [],
  accentInterpretation,
  tapInterpretation,
  showRests        = false,
  hideGhostParens  = false,
  bassStemUp       = false,
  width,
  height,
  beatOnly = false,
  showClef = true,
}: VexDrumNotationProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = "";

    const subdivs   = GRID_SUBDIVS[grid];
    const beatSize  = subdivs / 4;
    const slotCount = beatOnly ? beatSize : subdivs;
    const staveY    = computeStaveY(height);
    const { numBeats, beatValue } = voiceTimeSig(beatSize, slotCount);

    try {
      const renderer = new Renderer(el, Renderer.Backends.SVG);
      renderer.resize(width, height);
      const ctx = renderer.getContext();
      ctx.setFont("Arial", 10);

      const leftPad = showClef ? 24 : 6;
      const staveW  = width - leftPad - 6;
      const stave   = new Stave(leftPad, staveY, staveW);
      if (showClef) stave.addClef("percussion");
      stave.setEndBarType(Barline.type.END);
      stave.setContext(ctx).draw();

      const upKeys   = [HH_KEY, SN_KEY, SN_KEY, ...(bassStemUp ? [BD_KEY] : [])];
      const upXFlags = [true,   false,  false,  ...(bassStemUp ? [false]  : [])];
      const upHits   = [ostinatoHits, snareHits, ghostHits, ...(bassStemUp ? [bassHits] : [])];
      const upOpens  = [ostinatoOpen, snareDoubleHits, ghostDoubleHits, ...(bassStemUp ? [bassDoubleHits] : [])];
      const upGhostI = [2];
      const upDoubleI = [1, ...(bassStemUp ? [3] : [])];
      const { notes: upNotes,   xPatches: upPatches   } = buildMergedVoice(
        upKeys, 1, upXFlags, upHits, upOpens,
        slotCount, beatSize, upGhostI, showRests, hideGhostParens, upDoubleI,
      );
      const downBassHits = bassStemUp ? [] : bassHits;
      const downBassDoubles = bassStemUp ? [] : bassDoubleHits;
      const { notes: downNotes, xPatches: downPatches } = buildMergedVoice(
        [BD_KEY, HH_FOOT_KEY], -1,
        [false, true],
        [downBassHits, hhFootHits],
        [downBassDoubles, hhFootOpen],
        slotCount, beatSize, [], showRests, false, [0],
      );

      const accentSet = new Set<number>();
      (accentFlags ?? []).forEach((f, i) => { if (f && i < slotCount) accentSet.add(i); });
      const stickingMap = new Map<number, string>();
      (stickings ?? []).forEach((s, i) => { if (s && i < slotCount) stickingMap.set(i, s); });
      addAccentsAndStickings(upNotes, ostinatoHits, snareHits, ghostHits, slotCount, beatSize, accentSet, stickingMap, accentInterpretation, tapInterpretation);

      const hasUp   = upNotes.some(n => !n.isRest());
      const hasDown = downNotes.some(n => !n.isRest());
      if (!hasUp && !hasDown) { applyWhite(el); return; }

      const makeVoice = (notes: StaveNote[]): Voice => {
        const v = new Voice({ numBeats, beatValue });
        (v as unknown as { setMode(m: number): void }).setMode(2);
        v.addTickables(notes);
        return v;
      };

      const voices: Voice[] = [];
      const beamSrcs: StaveNote[][] = [];
      if (hasUp)   { voices.push(makeVoice(upNotes));   beamSrcs.push(upNotes); }
      if (hasDown) { voices.push(makeVoice(downNotes)); beamSrcs.push(downNotes); }

      const allBeams = beamSrcs.flatMap(arr => buildBeams(arr, beatSize));
      const fmtW = staveW - (showClef ? 40 : 16);

      new Formatter().joinVoices(voices).format(voices, fmtW);
      [...upPatches, ...downPatches].forEach(p => applyXHead(p.note.noteHeads[p.headIndex], p.isOpen));
      voices.forEach(v => v.draw(ctx, stave));
      allBeams.forEach(b => b.setContext(ctx).draw());

      applyWhite(el);
    } catch (err) {
      console.warn("VexFlow render error:", err);
    }
  }, [
    grid, ostinatoHits, ostinatoOpen, snareHits, bassHits,
    hhFootHits, hhFootOpen, ghostHits, ghostDoubleHits,
    accentFlags, stickings, accentInterpretation, tapInterpretation,
    width, height, beatOnly, showClef, bassStemUp,
  ]);

  return (
    <div ref={containerRef}
      style={{ width, height, overflow: "hidden", display: "block", flexShrink: 0 }}
    />
  );
}

// ── Multi-measure strip ───────────────────────────────────────────────────────
export interface StripMeasureData {
  grid: GridType;
  ostinatoHits: number[];
  ostinatoOpen: number[];
  snareHits: number[];
  bassHits: number[];
  hhFootHits: number[];
  hhFootOpen: number[];
  ghostHits: number[];
  ghostDoubleHits: number[];
  snareDoubleHits?: number[];
  bassDoubleHits?: number[];
  ostinatoDoubleHits?: number[];
  hhFootDoubleHits?: number[];
  tomHits?: number[];
  crashHits?: number[];
  accentFlags?: boolean[];
  stickings?: string[];
  slotOverride?: number;
  accentInterpretation?: string;
  tapInterpretation?: string;
  showRests?: boolean;
  hideGhostParens?: boolean;
  bassStemUp?: boolean;
  /** If set, draw a tuplet bracket with this number above the beat (e.g. 3, 5, 6, 7) */
  tupletNum?: number;
  /** Override the beam group size (slots per beam) for this measure.  When
   *  undefined we beam by the grid's natural beat (4 for 16th grid, 3 for
   *  triplet, etc).  Set to 3 to render a 16th-grid measure as groups of
   *  three 16ths — the notation used for a triplet ostinato that's been
   *  imported as straight 16ths. */
  beamGrouping?: number;
  /** Starting slot offset for the beam grouping within this measure.  Lets
   *  a phrase carry its 3-grouping phase across bar lines — if the previous
   *  bars summed to 4 slots under beamGrouping:3, the next bar passes
   *  beamGroupingOffset: 1 so its first beam closes the still-open group
   *  from before the barline. */
  beamGroupingOffset?: number;
  /** Cap every drum hit at 1 slot (single attack, gap filled with rests)
   *  instead of holding through to the next hit. Useful for bare K/S pattern
   *  tiles where the sustained-note rendering makes sparse hits overlap. */
  shortHits?: boolean;
  /** When true, beam groups span across rests instead of breaking at each
   *  rest. Combined with shortHits + showRests:false this yields the
   *  "4/5/6/7 attacks all beamed as one group, with empty slots still
   *  occupying width" look used by the ostinato previews. */
  beamAcrossRests?: boolean;
}

interface VexDrumStripProps {
  measures:       StripMeasureData[];
  measureWidth:   number;
  measureWidths?: number[];  // per-measure widths (overrides measureWidth when provided)
  height:         number;
  fullBar?:       boolean;
  staveY?:        number;
  oneBeatPerBar?: boolean;
  showClef?:      boolean;
  /** When true, each measure renders its own time signature (from voiceTimeSig
   *  applied to slotOverride or the default beat/bar count).  Useful for
   *  variable-length phrases where bar N and bar N+1 have different meters. */
  showTimeSig?:   boolean;
  /** When true, each stave is drawn as a single horizontal line (no 5-line
   *  clef).  Useful for hi-hat-only ostinato previews where only the cymbal
   *  line is relevant. */
  singleLine?:    boolean;
  /** Called after render with the absolute x-position of each non-rest note across all measures */
  onNotePositions?: (positions: number[]) => void;
  /** Called after render with the absolute x-position of each up-voice hit,
   *  keyed by measureIdx + slot. Use this for overlay widgets (e.g. accent
   *  buttons) that need to pin to actual rendered note positions rather than
   *  estimate them from slot-index arithmetic. */
  onNoteSlotPositions?: (positions: Array<{ measureIdx: number; slot: number; x: number }>) => void;
}

export function VexDrumStrip({ measures, measureWidth, measureWidths, height, fullBar = false, staveY: staveYProp, oneBeatPerBar = false, showClef = true, showTimeSig = false, singleLine = false, onNotePositions, onNoteSlotPositions }: VexDrumStripProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || measures.length === 0) { if (el) el.innerHTML = ""; return; }
    el.innerHTML = "";

    const CLEF_EXTRA = showClef ? 40 : 0;
    const mw = (i: number) => measureWidths?.[i] ?? measureWidth;
    const totalW     = CLEF_EXTRA + measures.reduce((sum, _, i) => sum + mw(i), 0);
    const staveY     = staveYProp ?? computeStaveY(height);

    try {
      const renderer = new Renderer(el, Renderer.Backends.SVG);
      renderer.resize(totalW, height);
      const ctx = renderer.getContext();
      ctx.setFont("Arial", 10);

      const collectedPositions: number[] = [];
      const collectedSlotPositions: Array<{ measureIdx: number; slot: number; x: number }> = [];
      let xCursor = 0;
      measures.forEach((m, idx) => {
        const isFirst = idx === 0;
        const isLast  = idx === measures.length - 1;
        const thisMW = mw(idx);
        const x = xCursor;
        const w = isFirst ? thisMW + CLEF_EXTRA : thisMW;

        const stave = new Stave(x, staveY, w);
        if (singleLine) {
          stave.setNumLines(1);
          if (!isFirst) stave.setBegBarType(Barline.type.NONE);
        } else {
          if (isFirst && showClef) stave.addClef("percussion");
          if (!isFirst) stave.setBegBarType(Barline.type.NONE);
        }
        if (isLast)  stave.setEndBarType(Barline.type.END);
        else if (oneBeatPerBar) stave.setEndBarType(Barline.type.SINGLE);
        else stave.setEndBarType(Barline.type.NONE);
        if (showTimeSig) {
          // Display time signature is always raw-slots over the note-value of
          // one grid slot (16 for 16th grid, 8 for triplet).  This matches
          // how the Garstka PDFs notate — "5/16" for 5 sixteenths, not the
          // reduced "1/4" that voiceTimeSig computes for voice-budget math.
          const subdivsForTS = GRID_SUBDIVS[m.grid];
          const beatSizeForTS = subdivsForTS / 4;
          const slotCountForTS = m.slotOverride ?? (fullBar ? subdivsForTS : beatSizeForTS);
          const displayDen = m.grid === "triplet" ? 8 : 16;
          stave.addTimeSignature(`${slotCountForTS}/${displayDen}`);
        }
        stave.setContext(ctx).draw();

        const { grid, ostinatoHits, ostinatoOpen, snareHits, bassHits,
                hhFootHits, hhFootOpen, ghostHits, ghostDoubleHits,
                snareDoubleHits: mSnareDoubleHits, bassDoubleHits: mBassDoubleHits,
                tomHits: mTomHits, crashHits: mCrashHits,
                accentFlags: mAccentFlags, stickings: mStickings,
                accentInterpretation: mAccentInterp, tapInterpretation: mTapInterp,
                showRests: mShowRests, hideGhostParens: mHideGhostParens,
                bassStemUp: mBassStemUp } = m;
        const snareDoubles = mSnareDoubleHits ?? [];
        const bassDoubles  = mBassDoubleHits ?? [];
        const tomHits = mTomHits ?? [];
        const crashHits = mCrashHits ?? [];

        const subdivs   = GRID_SUBDIVS[grid];
        const beatSize  = subdivs / 4;
        const slotCount = m.slotOverride ?? (fullBar ? subdivs : beatSize);
        // When slotOverride creates a non-standard beat size (e.g. 9 sixteenths),
        // use slotCount as beam group so all notes beam together
        const beamSize  = (m.slotOverride && m.slotOverride % beatSize !== 0)
          ? slotCount : beatSize;
        const { numBeats, beatValue } = voiceTimeSig(beatSize, slotCount);

        const accentSet = new Set<number>();
        (mAccentFlags ?? []).forEach((f, i) => { if (f && i < slotCount) accentSet.add(i); });
        const stickingMap = new Map<number, string>();
        (mStickings ?? []).forEach((s, i) => { if (s && i < slotCount) stickingMap.set(i, s); });

        // When singleLine is on, remap every up-voice pitch to the middle line
        // ("f/5" — the pitch KonnakolNotation uses for its single-line renders)
        // so hi-hat x-marks and any other up-voice notes land ON the drawn line
        // instead of floating above it.
        const ostinatoKey = singleLine ? "f/5" : HH_KEY;
        const singleLineSnareKey = singleLine ? "f/5" : SN_KEY;
        const singleLineTomKey = singleLine ? "f/5" : TOM_KEY;
        const singleLineCrashKey = singleLine ? "f/5" : CRASH_KEY;
        const mUpKeys   = [ostinatoKey, singleLineCrashKey, singleLineSnareKey, singleLineSnareKey, singleLineTomKey, ...(mBassStemUp ? [BD_KEY] : [])];
        const mUpXFlags = [true,   true,      false,  false,  false,   ...(mBassStemUp ? [false]  : [])];
        const mUpHits   = [ostinatoHits, crashHits, snareHits, ghostHits, tomHits, ...(mBassStemUp ? [bassHits] : [])];
        const mUpOpens  = [ostinatoOpen, [],        snareDoubles, ghostDoubleHits, [], ...(mBassStemUp ? [bassDoubles] : [])];
        const mUpDoubleI = [2, ...(mBassStemUp ? [5] : [])];
        // When a triplet ostinato is rendered as straight 16ths with
        // beamGrouping:3, split any held 3-slot note into an 8th + tied 16th
        // so the group-of-three structure stays visible (instead of collapsing
        // into a dotted 8th).
        const tripletGroup3 = m.beamGrouping === 3 && grid === "16th";
        const mShortHits = m.shortHits ?? false;
        const { notes: upNotes,   xPatches: upPatches, tieChains: upTieChains } = buildMergedVoice(
          mUpKeys, 1, mUpXFlags, mUpHits, mUpOpens,
          slotCount, beatSize, [3], mShowRests ?? false, mHideGhostParens ?? false, mUpDoubleI,
          tripletGroup3, mShortHits,
        );
        const mDownBassHits = mBassStemUp ? [] : bassHits;
        const mDownBassDoubles = mBassStemUp ? [] : bassDoubles;
        const { notes: downNotes, xPatches: downPatches } = buildMergedVoice(
          [BD_KEY, HH_FOOT_KEY], -1,
          [false, true],
          [mDownBassHits, hhFootHits],
          [mDownBassDoubles, hhFootOpen],
          slotCount, beatSize, [], mShowRests ?? false, false, [0],
          false, mShortHits,
        );

        const upSnareGroup = [...snareHits, ...tomHits, ...crashHits, ...(mBassStemUp ? bassHits : [])];
        addAccentsAndStickings(upNotes, ostinatoHits, upSnareGroup, ghostHits, slotCount, beatSize, accentSet, stickingMap, mAccentInterp, mTapInterp, tripletGroup3, mShortHits);
        addBassStickings(downNotes, mDownBassHits, slotCount, beatSize, stickingMap);

        const hasUp   = upNotes.some(n => !n.isRest());
        const hasDown = downNotes.some(n => !n.isRest());
        if (!hasUp && !hasDown) return;

        const makeVoice = (notes: StaveNote[]): Voice => {
          const v = new Voice({ numBeats, beatValue });
          (v as unknown as { setMode(m: number): void }).setMode(2);
          v.addTickables(notes);
          return v;
        };

        const voices: Voice[] = [];
        const beamSrcs: StaveNote[][] = [];
        if (hasUp)   { voices.push(makeVoice(upNotes));   beamSrcs.push(upNotes); }
        if (hasDown) { voices.push(makeVoice(downNotes)); beamSrcs.push(downNotes); }

        // When a custom beam grouping is requested (e.g. 3 for a triplet-ostinato
        // phrase rendered as straight 16ths), beam by slot position and respect
        // the per-measure start offset so groupings carry across bar lines.
        const allBeams = m.beamGrouping && m.beamGrouping > 0
          ? beamSrcs.flatMap(arr => buildBeamsByGrouping(arr, beatSize, m.beamGrouping!, m.beamGroupingOffset ?? 0, m.beamAcrossRests ?? false))
          : beamSrcs.flatMap(arr => buildBeams(arr, beamSize));
        // Use the stave's own note area (already compensates for clef,
        // time signature, and end barline) so notes never overflow the
        // measure regardless of what's drawn at the head of the bar.
        // Leave a small tail margin so the last notehead + any tie/flag
        // fits cleanly inside the end barline.
        const noteAreaW = stave.getNoteEndX() - stave.getNoteStartX();
        const fmtW = Math.max(40, noteAreaW - 10);

        try {
          // Low softmax → near-uniform per-slot spacing, so every bar with the
          // same meter lays notes out at the same fractional positions
          // regardless of hit density or beam grouping.
          const formatter = new Formatter({ softmaxFactor: 1 } as unknown as never);
          formatter.joinVoices(voices).format(voices, fmtW);
          [...upPatches, ...downPatches].forEach(p => applyXHead(p.note.noteHeads[p.headIndex], p.isOpen));
          voices.forEach(v => v.draw(ctx, stave));
          allBeams.forEach(b => b.setContext(ctx).draw());

          // Draw ties connecting split triplet-group notes (8th + tied 16th)
          // so a held beat reads as one sustained note rather than two hits.
          if (upTieChains.length > 0) {
            for (const chain of upTieChains) {
              for (let ci = 0; ci + 1 < chain.length; ci++) {
                const a = upNotes[chain[ci]];
                const b = upNotes[chain[ci + 1]];
                if (!a || !b) continue;
                try {
                  new StaveTie({
                    firstNote: a, lastNote: b,
                    firstIndexes: [0], lastIndexes: [0],
                  }).setContext(ctx).draw();
                } catch { /* ignore */ }
              }
            }
          }

          // Draw tuplet brackets if requested.  For multi-beat measures we
          // split the up voice into per-beat groups each covering `tupletNum`
          // slots, so a 6-slot triplet bar gets TWO "3" brackets, not one
          // 6-bracket spanning the whole measure.  Rest-only groups (rare —
          // would mean a whole beat of silence in the up voice) are skipped.
          if (m.tupletNum && m.tupletNum > 1 && hasUp) {
            const notesOccupied =
              m.tupletNum === 3 ? 2 :
              m.tupletNum === 5 ? 4 :
              m.tupletNum === 6 ? 4 :
              m.tupletNum === 7 ? 4 :
              m.tupletNum === 9 ? 8 :
              m.tupletNum - 1;
            const groups = splitNotesIntoTupletGroups(upNotes, beatSize, m.tupletNum);
            for (const group of groups) {
              if (group.length < 1) continue;
              if (!group.some(n => !n.isRest())) continue;
              // If the group consolidated to a single note that fills the
              // whole beat (e.g. triplet "+ - -" → one quarter note), skip the
              // tuplet bracket — a quarter note is the same length as a triplet
              // beat, so the "3" mark is redundant and visually misleading.
              const nonRestCount = group.filter(n => !n.isRest()).length;
              if (nonRestCount === 1) {
                const lone = group.find(n => !n.isRest())!;
                if (vfDurToSlots(lone.getDuration(), beatSize) >= m.tupletNum) {
                  continue;
                }
              }
              try {
                const tup = new Tuplet(group, {
                  numNotes: m.tupletNum,
                  notesOccupied,
                  bracketed: true,
                  ratioed: false,
                });
                tup.setContext(ctx).draw();
              } catch { /* ignore tuplet errors */ }
            }
          }
          // Collect note center x-positions for external alignment
          if (onNotePositions) {
            for (const n of upNotes) {
              try {
                const bb = n.getBoundingBox();
                collectedPositions.push(bb.x + bb.w / 2);
              } catch {
                try { collectedPositions.push(n.getAbsoluteX()); } catch { /* ignore */ }
              }
            }
          }
          // Collect per-slot positions for overlays (e.g. accent buttons).
          // buildMergedVoice emits non-rest notes in the order of the sorted
          // union of all up-voice hit slots, so we recompute the same union
          // here and pair each non-rest upNote with its originating slot.
          if (onNoteSlotPositions) {
            const upSlotSet = new Set<number>();
            const pushHits = (arr: number[]) => {
              for (const s of arr) if (s < slotCount) upSlotSet.add(s);
            };
            pushHits(ostinatoHits);
            pushHits(crashHits);
            pushHits(snareHits);
            pushHits(ghostHits);
            pushHits(tomHits);
            if (mBassStemUp) pushHits(bassHits);
            const upSortedHits = [...upSlotSet].sort((a, b) => a - b);
            // Tied-continuation notes share the original hit's slot — skip
            // them so each hit only maps to the first (head) notehead.
            const continuationIdx = new Set<number>();
            for (const chain of upTieChains) {
              for (let ci = 1; ci < chain.length; ci++) continuationIdx.add(chain[ci]);
            }
            let hitI = 0;
            for (let ni = 0; ni < upNotes.length; ni++) {
              const n = upNotes[ni];
              if (n.isRest()) continue;
              if (continuationIdx.has(ni)) continue;
              if (hitI >= upSortedHits.length) break;
              // Use the first notehead's own bbox rather than the whole note's
              // bbox: for a beamed note, the note-level bbox extends to include
              // the beam segment reaching the next note, which pulls the
              // reported center off the notehead. In a chord all noteheads
              // share the stem x, so the first notehead is a safe representative.
              let cx: number | null = null;
              try {
                const heads = (n as unknown as { noteHeads?: Array<{ getBoundingBox(): { x: number; w: number } }> }).noteHeads;
                if (heads && heads.length > 0) {
                  const hbb = heads[0].getBoundingBox();
                  cx = hbb.x + hbb.w / 2;
                }
              } catch { /* fall through */ }
              if (cx === null) {
                try {
                  const bb = n.getBoundingBox();
                  cx = bb.x + bb.w / 2;
                } catch {
                  try { cx = n.getAbsoluteX(); } catch { /* ignore */ }
                }
              }
              if (cx !== null) {
                collectedSlotPositions.push({ measureIdx: idx, slot: upSortedHits[hitI], x: cx });
              }
              hitI++;
            }
          }
        } catch (innerErr) {
          console.warn(`VexFlow strip measure ${idx} error:`, innerErr);
        }
        xCursor += w;
      });

      applyWhite(el);
      if (onNotePositions && collectedPositions.length > 0) {
        onNotePositions(collectedPositions);
      }
      if (onNoteSlotPositions && collectedSlotPositions.length > 0) {
        onNoteSlotPositions(collectedSlotPositions);
      }
    } catch (err) {
      console.warn("VexFlow strip render error:", err);
    }
  }, [measures, measureWidth, measureWidths, height, fullBar, staveYProp, oneBeatPerBar, showClef, showTimeSig, singleLine]);

  return (
    <div ref={containerRef}
      style={{ height, display: "inline-block", flexShrink: 0 }}
    />
  );
}

// ── Single-line ostinato preview ──────────────────────────────────────────────
// Renders ostinato (hi-hat) hits as x-noteheads on a single visible percussion
// line, suitable for Level-1 LogModal thumbnails.  Uses a full 5-line stave
// with only the middle line visible so the percussion clef aligns correctly.
// b/4 sits exactly ON line 3 (the middle line).
const OSTINATO_KEY = "b/4";

export interface VexOstinatoLineProps {
  grid:       GridType;
  hitSlots:   number[];   // 0-indexed within one beat
  openSlots?: number[];   // which slots use circle-x (open hi-hat)
  width:      number;
  height?:    number;     // default 90
}

export function VexOstinatoLine({
  grid,
  hitSlots,
  openSlots = [],
  width,
  height = 90,
}: VexOstinatoLineProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = "";

    const beatSize = GRID_SUBDIVS[grid] / 4;
    const staveY   = -5;
    const CLEF_W   = 26;
    const staveW   = width - CLEF_W - 4;

    try {
      const renderer = new Renderer(el, Renderer.Backends.SVG);
      renderer.resize(width, height);
      const ctx = renderer.getContext();
      ctx.setFont("Arial", 10);

      const stave = new Stave(CLEF_W, staveY, staveW);
      stave.setConfigForLines([
        { visible: false }, { visible: false }, { visible: true },
        { visible: false }, { visible: false },
      ]);
      stave.addClef("percussion");
      stave.setEndBarType(Barline.type.END);
      stave.setContext(ctx).draw();

      const sortedHits = [...new Set(hitSlots)].sort((a, b) => a - b);

      // Nothing to draw — leave the stave blank
      if (sortedHits.length === 0) { applyWhite(el); return; }

      const notes: StaveNote[] = [];
      let cursor = 0;

      for (let hi = 0; hi < sortedHits.length; hi++) {
        const pos     = sortedHits[hi];
        const nextPos = hi + 1 < sortedHits.length ? sortedHits[hi + 1] : beatSize;
        const dur     = nextPos - pos;

        if (cursor < pos) {
          for (const rd of splitSlots(pos - cursor, beatSize))
            notes.push(makeRest(rd, 1));
        }

        const isOpen = openSlots.includes(pos);
        const [vfDur, extra] = slotsToVfDur(dur, beatSize);
        const note = new StaveNote({ keys: [OSTINATO_KEY], duration: vfDur, stemDirection: 1 } as StaveNoteStruct);
        if (vfDur.includes("d")) { try { Dot.buildAndAttach([note], { all: true }); } catch { /* ignore */ } }
        applyXHead(note.noteHeads[0], isOpen);
        notes.push(note);

        if (extra > 0)
          for (const rd of splitSlots(extra, beatSize)) notes.push(makeRest(rd, 1));

        cursor = nextPos;
      }

      if (cursor < beatSize)
        for (const rd of splitSlots(beatSize - cursor, beatSize)) notes.push(makeRest(rd, 1));

      if (notes.length === 0) { applyWhite(el); return; }

      const { numBeats, beatValue } = voiceTimeSig(beatSize, beatSize);
      const voice = new Voice({ numBeats, beatValue });
      (voice as unknown as { setMode(m: number): void }).setMode(2);
      voice.addTickables(notes);

      const fmtW = Math.max(20, staveW - 40);
      new Formatter().joinVoices([voice]).format([voice], fmtW);
      voice.draw(ctx, stave);

      const beams = Beam.generateBeams(notes.filter(n => !n.isRest()), { maintainStemDirections: true });
      beams.forEach(b => b.setContext(ctx).draw());

      applyWhite(el);
    } catch (err) {
      console.warn("VexOstinatoLine render error:", err);
    }
  }, [grid, hitSlots, openSlots, width, height]);

  return (
    <div ref={containerRef}
      style={{ width, height, overflow: "hidden", display: "block", flexShrink: 0 }}
    />
  );
}
