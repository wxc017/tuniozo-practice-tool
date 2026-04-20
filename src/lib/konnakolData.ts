// ── Konnakol Data Layer ───────────────────────────────────────────────────────
// Syllable tables, grouping definitions, pattern generators, and cycle data.

import { selectGrouping, generateAndSelectGrouping, type GroupingMode } from "./groupingSelector";

export type NoteType = "normal" | "tie" | "rest";

export const MIXED_NOTE_TYPES: NoteType[] = ["normal", "tie", "rest"];

export const MIXED_CYCLE_TYPES: NoteType[] = ["normal", "tie", "rest"];

// ── Subdivision Permutation Types ─────────────────────────────────────────────

export interface PermNoteEntry {
  dur: string;
  dots?: number;
  syl: string;
  tie?: boolean;  // this note is tied from (continues) the previous note
}

export interface PermGroup {
  notes: PermNoteEntry[];
}

export type Permutation = PermGroup[];

export interface KonnakolNote {
  syllable: string;
  noteType: NoteType;
  accent: boolean;
  duration?: string;
  isTieStart?: boolean;
  hidden?: boolean;
  /** Optional per-note fill color for the syllable annotation (hex string). */
  syllableColor?: string;
  /** Optional per-note fill+stroke color for the notehead/stem/flag itself.
   *  Used by features (e.g. Vocal Percussion) that want to colour-code voices
   *  on the staff instead of (or in addition to) labelling them with text. */
  noteColor?: string;
}

export interface KonnakolGroup {
  notes: KonnakolNote[];
  subdivision: number;
  noTuplet?: boolean;
}

export type SubGrouping = number[];

// ── Syllable Tables ───────────────────────────────────────────────────────────

export type SubdivisionN = 3 | 4 | 5 | 6 | 7 | 8;

export interface GroupingDef {
  label: string;
  syllables: string[];
  size: number;
}

const G1: GroupingDef[] = [
  { label: "ta", syllables: ["ta"], size: 1 },
];

const G2: GroupingDef[] = [
  { label: "ta ke", syllables: ["ta", "ke"], size: 2 },
  { label: "ta dim", syllables: ["ta", "dim"], size: 2 },
];

const G3: GroupingDef[] = [
  { label: "ta ki te", syllables: ["ta", "ki", "te"], size: 3 },
  { label: "ta ke dim", syllables: ["ta", "ke", "dim"], size: 3 },
  { label: "ta dim ke", syllables: ["ta", "dim", "ke"], size: 3 },
];

const G4: GroupingDef[] = [
  { label: "ta ke di mi", syllables: ["ta", "ke", "di", "mi"], size: 4 },
  { label: "ta ki te dim", syllables: ["ta", "ki", "te", "dim"], size: 4 },
  { label: "ta ke dim ke", syllables: ["ta", "ke", "dim", "ke"], size: 4 },
  { label: "ta ke ja nu", syllables: ["ta", "ke", "ja", "nu"], size: 4 },
];

const G5: GroupingDef[] = [
  { label: "ta di ghi na ton", syllables: ["ta", "di", "ghi", "na", "ton"], size: 5 },
];

const G6: GroupingDef[] = [
  { label: "ta ke di mi ta ke", syllables: ["ta", "ke", "di", "mi", "ta", "ke"], size: 6 },
];

const G7: GroupingDef[] = [
  { label: "ta ke ta di ghi na ton", syllables: ["ta", "ke", "ta", "di", "ghi", "na", "ton"], size: 7 },
];

const G8: GroupingDef[] = [
  { label: "ta ke di mi ta ke ja nu", syllables: ["ta", "ke", "di", "mi", "ta", "ke", "ja", "nu"], size: 8 },
];

export const SUBDIVISION_GROUPINGS: Record<SubdivisionN, GroupingDef[]> = {
  3: [...G3, ...G2, ...G1],
  4: [...G4, ...G3, ...G2, ...G1],
  5: [...G5, ...G4, ...G3, ...G2, ...G1],
  6: [...G6, ...G5, ...G4, ...G3, ...G2, ...G1],
  7: [...G7, ...G6, ...G5, ...G4, ...G3, ...G2, ...G1],
  8: [...G8, ...G7, ...G6, ...G5, ...G4, ...G3, ...G2, ...G1],
};

// ── Mixed Groups Presets ──────────────────────────────────────────────────────

export interface MixedGroupPreset {
  label: string;
  groups: number[];
  description: string;
}

export function generateDefaultPresets(): MixedGroupPreset[] {
  return [];
}

export function randomPartition(
  n: number,
  minGroup: number = 2,
  maxGroup: number = 7,
  mode?: "musical" | "awkward" | "both",
  previousGroupings: number[][] = [],
): number[] {
  if (n <= 0) return [];

  // If a mode is specified, use the structural grouping selector
  if (mode) {
    const mp = Math.min(maxGroup, 8);
    // For manageable N, exhaustive enumeration
    if (n <= 18) {
      const result = generateAndSelectGrouping(n, mode, mp, previousGroupings);
      if (result) return result;
    }
    // Larger N: random pool
    const candidates: number[][] = [];
    for (let i = 0; i < 200; i++) {
      const r: number[] = [];
      let rem = n;
      let safety = 0;
      while (rem > 0 && safety++ < 200) {
        const lo = Math.min(minGroup, rem);
        const hi = Math.min(maxGroup, rem);
        if (lo > hi) { r.push(rem); break; }
        const p = lo + Math.floor(Math.random() * (hi - lo + 1));
        if (p >= rem) { r.push(rem); break; }
        const left = rem - p;
        if (left > 0 && left < minGroup) {
          if (p + left <= maxGroup) { r.push(p + left); break; }
          continue;
        }
        r.push(p);
        rem -= p;
      }
      if (r.length > 0) candidates.push(r);
    }
    const selected = selectGrouping(candidates, mode, previousGroupings);
    if (selected) return selected;
  }

  // Fallback: original random partition
  const result: number[] = [];
  let remaining = n;
  let attempts = 0;
  while (remaining > 0 && attempts < 2000) {
    attempts++;
    const lo = Math.min(minGroup, remaining);
    const hi = Math.min(maxGroup, remaining);
    if (lo > hi) { result.push(remaining); break; }
    const pick = lo + Math.floor(Math.random() * (hi - lo + 1));
    if (pick >= remaining) { result.push(remaining); break; }
    const leftover = remaining - pick;
    if (leftover > 0 && leftover < minGroup) {
      if (pick + leftover <= maxGroup) { result.push(pick + leftover); break; }
      continue;
    }
    result.push(pick);
    remaining -= pick;
  }
  return result;
}

export const MIXED_GROUP_PRESETS: MixedGroupPreset[] = generateDefaultPresets();

// ── Cycle Ratios ──────────────────────────────────────────────────────────────

export interface CycleRatio {
  label: string;
  a: number;
  b: number;
  description: string;
}

export const CYCLE_RATIOS: CycleRatio[] = [
  { label: "2:3", a: 2, b: 3, description: "Hemiola" },
  { label: "3:2", a: 3, b: 2, description: "Hemiola inverse" },
  { label: "3:4", a: 3, b: 4, description: "Three against four" },
  { label: "4:3", a: 4, b: 3, description: "Four against three" },
  { label: "4:5", a: 4, b: 5, description: "Four against five" },
  { label: "5:4", a: 5, b: 4, description: "Five against four" },
  { label: "5:3", a: 5, b: 3, description: "Five against three" },
  { label: "3:5", a: 3, b: 5, description: "Three against five" },
  { label: "5:6", a: 5, b: 6, description: "Five against six" },
  { label: "6:5", a: 6, b: 5, description: "Six against five" },
  { label: "5:7", a: 5, b: 7, description: "Five against seven" },
  { label: "7:5", a: 7, b: 5, description: "Seven against five" },
  { label: "6:7", a: 6, b: 7, description: "Six against seven" },
  { label: "7:6", a: 7, b: 6, description: "Seven against six" },
  { label: "7:8", a: 7, b: 8, description: "Seven against eight" },
  { label: "8:7", a: 8, b: 7, description: "Eight against seven" },
  { label: "7:9", a: 7, b: 9, description: "Seven against nine" },
  { label: "9:7", a: 9, b: 7, description: "Nine against seven" },
  { label: "9:13", a: 9, b: 13, description: "Nine against thirteen" },
  { label: "13:9", a: 13, b: 9, description: "Thirteen against nine" },
];

// ── Syllable Selection Per Group Size ─────────────────────────────────────────

// Slot-indexed syllables for each gati (per-beat subdivision count).
// `size` is the number of equal slots in one beat — e.g. 4 = chaturasra
// (four 16ths), 3 = tisra (triplet), 5 = khanda (quintuplet), etc.
// Each array entry is the syllable for a note whose START slot equals its
// index. A composition like [2,1,1] (1 eighth + 2 sixteenths) picks slots
// 0, 2, 3 and reads ["ta","ta","ke"] — which is the correct konnakol
// spoken form. Picking by slot position (instead of by sequential note
// index) is what makes compound rhythms come out right.
export function getSyllablesForSize(size: number): string[] {
  switch (size) {
    case 1: return ["ta"];
    case 2: return ["ta", "ka"];
    case 3: return ["ta", "ki", "ta"];                        // tisra
    case 4: return ["ta", "dim", "ta", "ke"];                 // chaturasra
    case 5: return ["ta", "ka", "ta", "ki", "ta"];            // khanda
    case 6: return ["ta", "ki", "ta", "ta", "ki", "ta"];      // two tisras
    case 7: return ["ta", "ki", "ta", "ta", "ka", "di", "mi"]; // misra
    case 8: return ["ta", "dim", "ta", "ke", "ta", "dim", "ta", "ke"]; // two chaturasras
    default: {
      // For uncommon sizes, tile the chaturasra pattern with a "ta" anchor.
      const base = ["ta", "dim", "ta", "ke"];
      return Array.from({ length: size }, (_, i) => base[i % base.length]);
    }
  }
}

// ── Accent Permutations (sub-groupings) per group size ───────────────────────
// Each entry is a list of sub-group sizes that sum to the key (the parent size).
// Ordered: complete fill first, then most common musical partitions.

export const ACCENT_PERMUTATIONS: Record<number, SubGrouping[]> = {
  1: [[1]],
  2: [[2], [1, 1]],
  3: [[3], [2, 1], [1, 2], [1, 1, 1]],
  4: [
    [4], [2, 2], [3, 1], [1, 3],
    [2, 1, 1], [1, 2, 1], [1, 1, 2], [1, 1, 1, 1],
  ],
  5: [
    [5], [3, 2], [2, 3], [4, 1], [1, 4],
    [2, 2, 1], [2, 1, 2], [1, 2, 2],
    [3, 1, 1], [1, 3, 1], [1, 1, 3],
    [2, 1, 1, 1], [1, 2, 1, 1], [1, 1, 2, 1], [1, 1, 1, 2],
  ],
  6: [
    [6], [3, 3], [4, 2], [2, 4],
    [2, 2, 2], [3, 2, 1], [3, 1, 2], [2, 3, 1], [1, 3, 2], [2, 1, 3], [1, 2, 3],
    [1, 1, 4], [4, 1, 1], [2, 2, 1, 1], [1, 1, 2, 2],
  ],
  7: [
    [7], [4, 3], [3, 4], [5, 2], [2, 5],
    [3, 2, 2], [2, 3, 2], [2, 2, 3],
    [3, 3, 1], [3, 1, 3], [1, 3, 3],
    [4, 2, 1], [2, 4, 1], [1, 2, 4], [4, 1, 2], [2, 1, 4], [1, 4, 2],
  ],
  8: [
    [8], [4, 4], [5, 3], [3, 5], [6, 2], [2, 6],
    [3, 3, 2], [3, 2, 3], [2, 3, 3],
    [4, 2, 2], [2, 4, 2], [2, 2, 4],
    [3, 3, 1, 1], [2, 2, 2, 2], [4, 1, 2, 1],
  ],
};

export function randomSubGrouping(size: number): SubGrouping {
  const opts = ACCENT_PERMUTATIONS[size] ?? [[size]];
  return opts[Math.floor(Math.random() * opts.length)];
}

// ── Beat Count Options ────────────────────────────────────────────────────────

export type BeatCountOption = 1 | 2 | 4 | 8 | "custom" | "random";

// ── Pattern Generation ────────────────────────────────────────────────────────

export type FillMode = "complete" | "mixed";

export function generateBasicPattern(
  selectedGroupings: GroupingDef[],
  beatCount: number,
  subdivision: SubdivisionN,
  fillMode: FillMode = "complete",
  subGroupingChoices: Record<string, SubGrouping | "random"> = {},
): KonnakolGroup[] {
  if (selectedGroupings.length === 0) {
    const defaults = SUBDIVISION_GROUPINGS[subdivision];
    selectedGroupings = [defaults[0]];
  }

  const pulseCount = beatCount * subdivision;
  const groups: KonnakolGroup[] = [];
  let filled = 0;

  let attempts = 0;
  while (filled < pulseCount && attempts < 1000) {
    attempts++;
    const available = selectedGroupings.filter(g => g.size <= pulseCount - filled);
    if (available.length === 0) break;
    const pick = available[Math.floor(Math.random() * available.length)];

    if (fillMode === "mixed") {
      const choice = subGroupingChoices[pick.label] ?? "random";
      const subGrp: SubGrouping =
        choice === "random" ? randomSubGrouping(pick.size) : choice;
      const isSubGrouped = subGrp.length > 1;
      let sylIdx = 0;
      for (const sz of subGrp) {
        const subSyls = pick.syllables.slice(sylIdx, sylIdx + sz);
        groups.push({
          notes: subSyls.map((s, i) => ({
            syllable: s,
            noteType: "normal" as NoteType,
            accent: i === 0,
          })),
          subdivision,
          noTuplet: isSubGrouped,
        });
        sylIdx += sz;
      }
    } else {
      groups.push({
        notes: pick.syllables.map((s, i) => ({
          syllable: s,
          noteType: "normal" as NoteType,
          accent: i === 0,
        })),
        subdivision,
      });
    }

    filled += pick.size;
  }

  return groups;
}

const SLOT_TO_DUR: Record<number, string> = {
  1: "16",
  2: "8",
  3: "8.",
  4: "q",
  6: "q.",
  8: "h",
};

export function generateDurationPattern(slotDurations: number[]): KonnakolGroup[] {
  const syllables = getSyllablesForSize(slotDurations.length);
  return slotDurations.map((slots, i) => ({
    notes: [{
      syllable: syllables[i] ?? "ta",
      noteType: "normal" as NoteType,
      accent: i === 0,
      duration: SLOT_TO_DUR[slots] ?? "16",
    }],
    subdivision: 1,
  }));
}

export function generateMixedPattern(groupSizes: number[]): KonnakolGroup[] {
  return groupSizes.map(size => {
    const syllables = getSyllablesForSize(size);
    return {
      notes: syllables.map((s, i) => ({
        syllable: s,
        noteType: "normal" as NoteType,
        accent: i === 0,
      })),
      subdivision: size,
    };
  });
}

export function generateCyclePattern(ratio: CycleRatio): KonnakolGroup[] {
  const { a, b } = ratio;
  const accentSyllables = getSyllablesForSize(b);
  const groups: KonnakolGroup[] = [];

  for (let i = 0; i < b; i++) {
    const notes = [];
    for (let j = 0; j < a; j++) {
      notes.push({
        syllable: accentSyllables[(i * a + j) % b],
        noteType: "normal" as NoteType,
        accent: (i * a + j) % b === 0,
      });
    }
    groups.push({
      notes,
      subdivision: a,
    });
  }

  return groups;
}

export function applyRandomNoteModifications(groups: KonnakolGroup[]): KonnakolGroup[] {
  const types: NoteType[] = ["normal", "tie", "rest"];
  return groups.map((group, gi) => ({
    ...group,
    notes: group.notes.map((note, ni) => {
      const isGlobalFirst = gi === 0 && ni === 0;
      const noteType: NoteType = isGlobalFirst
        ? "normal"
        : types[Math.floor(Math.random() * types.length)];
      return { ...note, noteType };
    }),
  }));
}

export function cycleNoteType(current: NoteType): NoteType {
  const order: NoteType[] = ["normal", "tie", "rest"];
  const idx = order.indexOf(current);
  return order[(idx + 1) % order.length];
}

export function cycleMixedNoteType(current: NoteType): NoteType {
  return cycleNoteType(current);
}

const DURATION_HALVES: Record<string, string> = {
  "h": "q",
  "q.": "8.",
  "q": "8",
  "8": "16",
  "16": "32",
};

export function randomizePhrases(groups: KonnakolGroup[]): KonnakolGroup[] {
  return groups.map((group, gi) => ({
    ...group,
    notes: group.notes.map((note, ni) => {
      const isFirst = gi === 0 && ni === 0;
      const r = Math.random();
      if (isFirst) {
        return { ...note, noteType: "normal" as NoteType, isTieStart: r > 0.72 };
      }
      let noteType: NoteType = "normal";
      let isTieStart = false;
      if (r < 0.18) noteType = "rest";
      else if (r < 0.32) noteType = "tie";
      else { noteType = "normal"; isTieStart = r > 0.74; }
      return { ...note, noteType, isTieStart };
    }),
  }));
}

export function splitNote(
  groupIndex: number,
  noteIndex: number,
  groups: KonnakolGroup[],
): KonnakolGroup[] {
  const result: KonnakolGroup[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (gi !== groupIndex) {
      result.push(g);
      continue;
    }
    const n = g.notes[noteIndex];
    if (!n) {
      result.push(g);
      continue;
    }
    const currentDur = n.duration ?? "16";
    const halfDur = DURATION_HALVES[currentDur];
    if (!halfDur) {
      result.push(g);
      continue;
    }
    const baseType: NoteType = n.noteType === "rest" ? "rest" : "normal";
    result.push({ notes: [{ ...n, noteType: baseType, duration: halfDur }], subdivision: 1 });
    result.push({ notes: [{ syllable: n.syllable, noteType: baseType, accent: false, duration: halfDur }], subdivision: 1 });
  }
  return result;
}

export function canSplitNote(note: KonnakolNote): boolean {
  const dur = note.duration ?? "16";
  return dur in DURATION_HALVES;
}

export interface PlaybackNote {
  syllable: string;
  accent: boolean;
  durationSlots: number;
}

const DUR_TO_SLOTS_PB: Record<string, number> = {
  "32": 0.5, "16": 1, "16.": 1.5, "8": 2, "8.": 3, "q": 4, "q.": 6, "h": 8, "h.": 12, "w": 16,
};

export function flattenGroupsForPlayback(groups: KonnakolGroup[]): PlaybackNote[] {
  const events: PlaybackNote[] = [];
  for (const group of groups) {
    for (const note of group.notes) {
      const slots = DUR_TO_SLOTS_PB[note.duration ?? "16"] ?? 1;
      if (note.noteType === "tie" && events.length > 0) {
        events[events.length - 1].durationSlots += slots;
      } else {
        events.push({
          syllable: note.noteType === "rest" ? "" : (note.syllable ?? ""),
          accent: note.accent,
          durationSlots: slots,
        });
      }
    }
  }
  return events;
}

// ── Subdivision Permutation Data ───────────────────────────────────────────────
// Auto-generated from all ordered integer compositions of x (the subdivision).
// For each composition [p1, p2, ...] summing to x, every part pi maps to a
// single note duration (with a tie for parts that require two VexFlow notes):
//   1 → 16th note
//   2 → 8th note
//   3 → dotted 8th
//   4 → quarter
//   5 → quarter tied to 16th  (tie: true on the continuation note)
//   6 → dotted quarter
//   7 → dotted quarter tied to 8th
//   8 → half note
// Syllables come from getSyllablesForSize(x), assigned left-to-right by slots.
// All notes in a composition share ONE PermGroup (beamed/tied together).

// Maps a slot-count part to the PermNoteEntry array representing it.
// Parts 5 and 7 require a tie continuation note (tie: true).
function partToNoteEntries(slots: number, syl: string): PermNoteEntry[] {
  switch (slots) {
    case 1: return [{ syl, dur: "16" }];
    case 2: return [{ syl, dur: "8" }];
    case 3: return [{ syl, dur: "8", dots: 1 }];
    case 4: return [{ syl, dur: "q" }];
    case 5: return [{ syl, dur: "q" }, { syl: "", dur: "16", tie: true }];
    case 6: return [{ syl, dur: "q", dots: 1 }];
    case 7: return [{ syl, dur: "q", dots: 1 }, { syl: "", dur: "8", tie: true }];
    case 8: return [{ syl, dur: "h" }];
    default: return [{ syl, dur: "h" }];
  }
}

// Converts one ordered composition to a single-group Permutation. The first
// note of each part gets the syllable at its start slot; any tie-continuation
// emitted by partToNoteEntries (5-slot → q+16th, 7-slot → q.+8th) gets the
// syllable at the slot where the continuation begins — so every notated
// note ends up with a label instead of the tied 16th/8th rendering blank.
function compositionToSingleGroupPerm(comp: number[], x: number): Permutation {
  const baseSyls = getSyllablesForSize(x);
  const allNotes: PermNoteEntry[] = [];
  let cursor = 0;
  for (const part of comp) {
    const syl = baseSyls[cursor] ?? "";
    const entries = partToNoteEntries(part, syl);
    // partToNoteEntries emits a tie continuation at slot offset 4 (for part 5)
    // or 6 (for part 7). Give that continuation the syllable at its own slot.
    if (part === 5 && entries[1]) entries[1].syl = baseSyls[cursor + 4] ?? "";
    else if (part === 7 && entries[1]) entries[1].syl = baseSyls[cursor + 6] ?? "";
    allNotes.push(...entries);
    cursor += part;
  }
  return [{ notes: allNotes }];
}

function buildSubdivisionPermutations(): Record<SubdivisionN, Permutation[]> {
  const result = {} as Record<SubdivisionN, Permutation[]>;
  for (const x of [3, 4, 5, 6, 7, 8] as SubdivisionN[]) {
    // maxPart = x so a single note can span the full subdivision (e.g. half note for 8)
    const comps = generateCompositions(x, x);
    result[x] = comps.map(comp => compositionToSingleGroupPerm(comp, x));
  }
  return result;
}

export const SUBDIVISION_PERMUTATIONS: Record<SubdivisionN, Permutation[]> = buildSubdivisionPermutations();

// ── Ordered Integer Compositions ──────────────────────────────────────────────
// Returns all ordered integer compositions of n where each part is 1..maxPart.
// Order: musically natural — fewest groups (parts) first.
// Within each group count, compositions are ordered with larger parts first (left-to-right descending).
// Part-to-duration mapping: 1→"16", 2→"8", 3→"8d" (dotted 8th), 4→"q".

export function generateCompositions(n: number, maxPart = 4): number[][] {
  // Generate all compositions grouped by number of parts
  const byPartCount = new Map<number, number[][]>();

  function recurse(remaining: number, current: number[]): void {
    if (remaining === 0) {
      const k = current.length;
      if (!byPartCount.has(k)) byPartCount.set(k, []);
      byPartCount.get(k)!.push([...current]);
      return;
    }
    for (let part = Math.min(remaining, maxPart); part >= 1; part--) {
      current.push(part);
      recurse(remaining - part, current);
      current.pop();
    }
  }

  recurse(n, []);

  // Collect in order of ascending part count (fewest groups first)
  const results: number[][] = [];
  const keys = Array.from(byPartCount.keys()).sort((a, b) => a - b);
  for (const k of keys) {
    results.push(...byPartCount.get(k)!);
  }
  return results;
}

// ── Konnakol Syllable Mapping for Compositions ─────────────────────────────────
// Maps a composition (array of part sizes) to arrays of konnakol syllables.
// Reads through the subdivision's full syllable list left to right,
// assigning the next P syllables to each part of size P.

export function syllablesForComposition(
  composition: number[],
  subdivisionSyllables: string[],
): string[][] {
  const result: string[][] = [];
  let cursor = 0;
  for (const partSize of composition) {
    const syls: string[] = [];
    for (let i = 0; i < partSize; i++) {
      syls.push(subdivisionSyllables[cursor % subdivisionSyllables.length]);
      cursor++;
    }
    result.push(syls);
  }
  return result;
}

// Part size → VexFlow duration string
export function partSizeToDuration(partSize: number): { dur: string; dots?: number } {
  switch (partSize) {
    case 1: return { dur: "16" };
    case 2: return { dur: "8" };
    case 3: return { dur: "8", dots: 1 };
    case 4: return { dur: "q" };
    default: return { dur: "16" };
  }
}

// ── Random Partition With Max ──────────────────────────────────────────────────
// Generates a random ordered partition of `size` where no part exceeds `max`.

export function partitionWithMax(size: number, max: number): number[] {
  const parts: number[] = [];
  let remaining = size;
  while (remaining > 0) {
    const maxAllowed = Math.min(remaining, max);
    const part = Math.floor(Math.random() * maxAllowed) + 1;
    parts.push(part);
    remaining -= part;
  }
  return parts;
}

// ── Convert Permutation → KonnakolGroup[] ─────────────────────────────────────
// Converts a Permutation (array of PermGroup) into KonnakolGroup[] for display
// in KonnakolNotation. Uses subdivision=4 (16th-note-based rendering).

/**
 * Apply a subdivision permutation to a KonnakolGroup — replaces the group's
 * uniform 16th notes with the permutation's rhythm (varied durations/ties).
 * Preserves the group's subdivision value. Modifications (ties/rests) are reset.
 */
export function applyPermutationToGroup(group: KonnakolGroup, perm: Permutation): KonnakolGroup {
  const permNotes = perm[0]?.notes ?? [];
  const notes: KonnakolNote[] = permNotes.map((entry, ni) => ({
    syllable: entry.syl || group.notes[0]?.syllable || "ta",
    noteType: entry.tie ? "tie" as NoteType : "normal" as NoteType,
    accent: ni === 0,
    duration: entry.dur === "q" ? "q" : entry.dur === "8" ? "8" : entry.dur === "h" ? "h" : entry.dur === "16" ? "16" : entry.dur === "32" ? "32" : "16",
    isTieStart: false,
  }));
  // Handle dotted durations — store as base duration (the dot is implicit via slot count)
  // Re-map syllables from the original group's subdivision
  const baseSyls = getSyllablesForSize(group.subdivision);
  let cursor = 0;
  for (let i = 0; i < permNotes.length; i++) {
    const entry = permNotes[i];
    if (!entry.tie && cursor < baseSyls.length) {
      notes[i].syllable = baseSyls[cursor];
    }
    // Advance cursor by slot count of this note
    const slots = entry.dur === "h" ? 8 : entry.dur === "q" ? 4 : entry.dur === "8" ? 2 : entry.dur === "16" ? 1 : entry.dur === "32" ? 0.5 : 1;
    const dotMult = entry.dots ? 1.5 : 1;
    cursor += Math.round(slots * dotMult);
  }
  return { ...group, notes };
}

/** Extract the integer composition from a permutation (e.g., 16th+dotted-8th → [1, 3]) */
export function extractComposition(perm: Permutation): number[] {
  const comp: number[] = [];
  let cur = 0;
  const base: Record<string, number> = { "32": 0.5, "16": 1, "8": 2, "q": 4, "h": 8 };
  for (const g of perm) {
    for (const n of g.notes) {
      const s = (base[n.dur] ?? 1) * (n.dots ? 1.5 : 1);
      if (n.tie) { cur += s; } else { if (cur > 0) comp.push(cur); cur = s; }
    }
  }
  if (cur > 0) comp.push(cur);
  return comp.map(Math.round);
}

/**
 * Apply a permutation to a cycle group by keeping atom count and using ties.
 * Unlike applyPermutationToGroup (which changes note durations/count),
 * this keeps the original atoms intact and marks continuation atoms as ties.
 */
export function applyCompositionAsTies(group: KonnakolGroup, perm: Permutation): KonnakolGroup {
  const comp = extractComposition(perm);
  const baseSyls = getSyllablesForSize(group.subdivision);
  const newNotes = group.notes.map(n => ({ ...n }));

  let cursor = 0;
  for (let ci = 0; ci < comp.length; ci++) {
    const partSize = comp[ci];
    if (cursor < newNotes.length) {
      newNotes[cursor] = {
        ...newNotes[cursor],
        syllable: baseSyls[cursor] ?? "ta",
        noteType: "normal" as NoteType,
        accent: cursor === 0,
        isTieStart: partSize > 1,
      };
    }
    for (let j = 1; j < partSize && cursor + j < newNotes.length; j++) {
      newNotes[cursor + j] = {
        ...newNotes[cursor + j],
        syllable: "",
        noteType: "tie" as NoteType,
        accent: false,
        isTieStart: false,
      };
    }
    cursor += partSize;
  }

  return { ...group, notes: newNotes };
}

export function permutationToKonnakolGroups(perm: Permutation): KonnakolGroup[] {
  return perm.map((grp, gi) => ({
    notes: grp.notes.map((entry, ni) => ({
      syllable: entry.syl,
      noteType: "normal" as NoteType,
      accent: ni === 0,
    })),
    subdivision: 4,
    noTuplet: gi > 0,
  }));
}
