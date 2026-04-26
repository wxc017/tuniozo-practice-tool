import { useState, useRef, useCallback } from "react";
import { audioEngine } from "@/lib/audioEngine";
import {
  fitLineIntoWindow, strictWindowBounds, randomChoice,
  getModeDegreeMap, getDegreeMap,
} from "@/lib/musicTheory";
import { useLS } from "@/lib/storage";
import { recordAnswer } from "@/lib/stats";

interface Props {
  tonicPc: number;
  lowestOct: number;
  highestOct: number;
  edo: number;
  onHighlight: (pcs: number[]) => void;
  responseMode: string;
  onResult: (text: string) => void;
  onPlay: (optionKey: string, label: string) => void;
  lastPlayed: React.MutableRefObject<{ frames: number[][]; info: string } | null>;
  ensureAudio: () => Promise<void>;
  playVol?: number;
  onAnswer?: (optionKey: string, label: string, correct: boolean) => void;
  answerButtons?: React.ReactNode;
}

// ── Mode data ─────────────────────────────────────────────────────────

interface ChordOption {
  name: string;        // chord symbol key into CD (e.g. "maj7", "m9", "7alt")
  degrees: string[];   // chromatic degree labels making up the chord
}

interface ModeInfo {
  name: string;         // code name (matches getModeDegreeMap key)
  family: string;       // "Major Family" | "Harmonic Minor Family" | "Melodic Minor Family"
  displayName: string;  // pretty name shown in UI
  scaleDegrees: string[];  // 7 ordered degree labels
  character: string[];     // characteristic tones (subset of scaleDegrees)
  stable: string[];        // stable tones
  chordOptions: ChordOption[]; // characteristic chords for this mode
}

// Each mode has exactly ONE characteristic tonic chord — the full mode stacked
// as a 13th chord (1, 3rd, 5th, 7th, 9, 11, 13). Degree labels here are kept in
// "chord-symbol" form (e.g. "9", "11", "b13") for both display and voicing;
// the chord builder shifts each tone into ascending order at play time.
const TONIC_CHORD: Record<string, ChordOption> = {
  // Major Family
  "Ionian":     { name: "maj7(9,11,13)",     degrees: ["1","3","5","7","9","11","13"] },
  "Dorian":     { name: "m7(9,11,13)",       degrees: ["1","b3","5","b7","9","11","13"] },
  "Phrygian":   { name: "m7(♭9,11,♭13)",     degrees: ["1","b3","5","b7","b9","11","b13"] },
  "Lydian":     { name: "maj7(9,♯11,13)",    degrees: ["1","3","5","7","9","#11","13"] },
  "Mixolydian": { name: "7(9,11,13)",        degrees: ["1","3","5","b7","9","11","13"] },
  "Aeolian":    { name: "m7(9,11,♭13)",      degrees: ["1","b3","5","b7","9","11","b13"] },
  "Locrian":    { name: "m7♭5(♭9,11,♭13)",   degrees: ["1","b3","b5","b7","b9","11","b13"] },
  // Harmonic Minor Family
  "Harmonic Minor":    { name: "mMaj7(9,11,♭13)",  degrees: ["1","b3","5","7","9","11","b13"] },
  "Locrian #6":        { name: "m7♭5(♭9,11,13)",   degrees: ["1","b3","b5","b7","b9","11","13"] },
  "Ionian #5":         { name: "maj7♯5(9,11,13)",  degrees: ["1","3","#5","7","9","11","13"] },
  "Dorian #4":         { name: "m7(9,♯11,13)",     degrees: ["1","b3","5","b7","9","#11","13"] },
  "Phrygian Dominant": { name: "7(♭9,11,♭13)",     degrees: ["1","3","5","b7","b9","11","b13"] },
  "Lydian #2":         { name: "maj7(♯9,♯11,13)",  degrees: ["1","3","5","7","#9","#11","13"] },
  "Ultralocrian":      { name: "dim7(♭9,11,♭13)",  degrees: ["1","b3","b5","6","b9","11","b13"] },
  // Melodic Minor Family
  "Melodic Minor":     { name: "mMaj7(9,11,13)",   degrees: ["1","b3","5","7","9","11","13"] },
  "Dorian b2":         { name: "m7(♭9,11,13)",     degrees: ["1","b3","5","b7","b9","11","13"] },
  "Lydian Augmented":  { name: "maj7♯5(9,♯11,13)", degrees: ["1","3","#5","7","9","#11","13"] },
  "Lydian Dominant":   { name: "7(9,♯11,13)",      degrees: ["1","3","5","b7","9","#11","13"] },
  "Mixolydian b6":     { name: "7(9,11,♭13)",      degrees: ["1","3","5","b7","9","11","b13"] },
  "Locrian #2":        { name: "m7♭5(9,11,♭13)",   degrees: ["1","b3","b5","b7","9","11","b13"] },
  "Altered":           { name: "7alt",             degrees: ["1","3","b5","b7","b9","#9","#11","b13"] },
};

// Resolve a chord-symbol degree label (including "11", "13", etc.) to a step count.
// Falls back to the lower-octave equivalent when a label isn't directly in the EDO map.
function resolveStep(d: string, edo: number): number {
  const map = getDegreeMap(edo);
  if (map[d] !== undefined) return map[d];
  const fallback: Record<string, string> = {
    "11":  "4",  "#11": "#4", "b11": "b4",
    "13":  "6",  "b13": "b6", "#13": "#6",
  };
  const alt = fallback[d];
  return (alt && map[alt] !== undefined) ? map[alt] : 0;
}

const c = (modeName: string): ChordOption[] => {
  const tc = TONIC_CHORD[modeName];
  return tc ? [tc] : [{ name: "?", degrees: ["1","3","5","b7"] }];
};

const ALL_MODES: ModeInfo[] = [
  // ── Major Family ──────────────────────────────────────────────────
  {
    name: "Ionian", family: "Major Family", displayName: "Ionian",
    scaleDegrees: ["1","2","3","4","5","6","7"],
    character: ["4","7"], stable: ["1","3","5"],
    chordOptions: c("Ionian"),
  },
  {
    name: "Dorian", family: "Major Family", displayName: "Dorian",
    scaleDegrees: ["1","2","b3","4","5","6","b7"],
    character: ["b3","6"], stable: ["1","5"],
    chordOptions: c("Dorian"),
  },
  {
    name: "Phrygian", family: "Major Family", displayName: "Phrygian",
    scaleDegrees: ["1","b2","b3","4","5","b6","b7"],
    character: ["b2"], stable: ["1","5"],
    chordOptions: c("Phrygian"),
  },
  {
    name: "Lydian", family: "Major Family", displayName: "Lydian",
    scaleDegrees: ["1","2","3","#4","5","6","7"],
    character: ["#4"], stable: ["1","5"],
    chordOptions: c("Lydian"),
  },
  {
    name: "Mixolydian", family: "Major Family", displayName: "Mixolydian",
    scaleDegrees: ["1","2","3","4","5","6","b7"],
    character: ["b7"], stable: ["1","3","5"],
    chordOptions: c("Mixolydian"),
  },
  {
    name: "Aeolian", family: "Major Family", displayName: "Aeolian",
    scaleDegrees: ["1","2","b3","4","5","b6","b7"],
    character: ["b3","b6"], stable: ["1","5"],
    chordOptions: c("Aeolian"),
  },
  {
    name: "Locrian", family: "Major Family", displayName: "Locrian",
    scaleDegrees: ["1","b2","b3","4","b5","b6","b7"],
    character: ["b2","b5"], stable: ["1"],
    chordOptions: c("Locrian"),
  },
  // ── Harmonic Minor Family ─────────────────────────────────────────
  {
    name: "Harmonic Minor", family: "Harmonic Minor Family", displayName: "Harmonic Minor",
    scaleDegrees: ["1","2","b3","4","5","b6","7"],
    character: ["b6","7"], stable: ["1","5"],
    chordOptions: c("Harmonic Minor"),
  },
  {
    name: "Locrian #6", family: "Harmonic Minor Family", displayName: "Locrian ♮6",
    scaleDegrees: ["1","b2","b3","4","b5","6","b7"],
    character: ["b2","6"], stable: ["1"],
    chordOptions: c("Locrian #6"),
  },
  {
    name: "Ionian #5", family: "Harmonic Minor Family", displayName: "Ionian ♯5",
    scaleDegrees: ["1","2","3","4","#5","6","7"],
    character: ["#5"], stable: ["1"],
    chordOptions: c("Ionian #5"),
  },
  {
    name: "Dorian #4", family: "Harmonic Minor Family", displayName: "Dorian ♯4",
    scaleDegrees: ["1","2","b3","#4","5","6","b7"],
    character: ["#4"], stable: ["1","5"],
    chordOptions: c("Dorian #4"),
  },
  {
    name: "Phrygian Dominant", family: "Harmonic Minor Family", displayName: "Phrygian Dominant",
    scaleDegrees: ["1","b2","3","4","5","b6","b7"],
    character: ["b2","3","b6"], stable: ["1","5"],
    chordOptions: c("Phrygian Dominant"),
  },
  {
    name: "Lydian #2", family: "Harmonic Minor Family", displayName: "Lydian ♯2",
    scaleDegrees: ["1","#2","3","#4","5","6","7"],
    character: ["#2","#4"], stable: ["1","5"],
    chordOptions: c("Lydian #2"),
  },
  {
    name: "Ultralocrian", family: "Harmonic Minor Family", displayName: "Superlocrian ♭♭7",
    scaleDegrees: ["1","b2","b3","3","b5","b6","6"],
    character: ["b2","b3","3","b5","b6"], stable: ["1"],
    chordOptions: c("Ultralocrian"),
  },
  // ── Melodic Minor Family ──────────────────────────────────────────
  {
    name: "Melodic Minor", family: "Melodic Minor Family", displayName: "Melodic Minor",
    scaleDegrees: ["1","2","b3","4","5","6","7"],
    character: ["6","7"], stable: ["1","5"],
    chordOptions: c("Melodic Minor"),
  },
  {
    name: "Dorian b2", family: "Melodic Minor Family", displayName: "Dorian ♭2",
    scaleDegrees: ["1","b2","b3","4","5","6","b7"],
    character: ["b2","6"], stable: ["1","5"],
    chordOptions: c("Dorian b2"),
  },
  {
    name: "Lydian Augmented", family: "Melodic Minor Family", displayName: "Lydian Augmented",
    scaleDegrees: ["1","2","3","#4","#5","6","7"],
    character: ["#4","#5"], stable: ["1"],
    chordOptions: c("Lydian Augmented"),
  },
  {
    name: "Lydian Dominant", family: "Melodic Minor Family", displayName: "Lydian Dominant",
    scaleDegrees: ["1","2","3","#4","5","6","b7"],
    character: ["#4","b7"], stable: ["1","3","5"],
    chordOptions: c("Lydian Dominant"),
  },
  {
    name: "Mixolydian b6", family: "Melodic Minor Family", displayName: "Mixolydian ♭6",
    scaleDegrees: ["1","2","3","4","5","b6","b7"],
    character: ["b6","b7"], stable: ["1","3","5"],
    chordOptions: c("Mixolydian b6"),
  },
  {
    name: "Locrian #2", family: "Melodic Minor Family", displayName: "Locrian ♮2",
    scaleDegrees: ["1","2","b3","4","b5","b6","b7"],
    character: ["2","b5"], stable: ["1"],
    chordOptions: c("Locrian #2"),
  },
  {
    name: "Altered", family: "Melodic Minor Family", displayName: "Altered",
    scaleDegrees: ["1","b2","#2","3","b5","#5","b7"],
    character: ["b2","#2","b5","#5"], stable: ["1","3"],
    chordOptions: c("Altered"),
  },
];

const FAMILY_MAP: Record<string, ModeInfo[]> = {
  major:    ALL_MODES.filter(m => m.family === "Major Family"),
  harmonic: ALL_MODES.filter(m => m.family === "Harmonic Minor Family"),
  melodic:  ALL_MODES.filter(m => m.family === "Melodic Minor Family"),
  all:      ALL_MODES,
};

// ── Phrase generation ─────────────────────────────────────────────────

const DEFAULT_GAP = 560;  // ms between note starts (legato is added on top)

const NOTE_COUNTS = [4, 5, 6, 7, 8, 10, 12];

// The 3rd of a mode is always the second degree of its first chord option
// (e.g. maj7 → "3", m7 → "b3", dim7 → "b3").
function getThird(mode: ModeInfo): string {
  return mode.chordOptions[0]?.degrees[1] ?? "3";
}

// Voice-lead a sequence of degree labels to nearest-octave pitches and fit into window.
// Color-set safety: phrases must NEVER play the tonic (the drone already supplies
// it). Any "1" in the input sequence is rerouted to the perfect 5th, falling back
// to the 4th, then the 3rd, depending on what the mode contains.
function voiceLeadSeq(
  seq: string[], mode: ModeInfo,
  tonicAbs: number, edo: number, low: number, high: number,
): { notes: number[]; degrees: string[] } | null {
  const rootSub = mode.scaleDegrees.includes("5") ? "5"
                : mode.scaleDegrees.includes("4") ? "4"
                : getThird(mode);
  const safe = seq.map(d => d === "1" ? rootSub : d);

  const modeMap = getModeDegreeMap(edo, mode.family, mode.name);
  const raw: number[] = [tonicAbs + (modeMap[safe[0]] ?? 0)];
  for (let i = 1; i < safe.length; i++) {
    const base = tonicAbs + (modeMap[safe[i]] ?? 0);
    let best = base, bestD = Math.abs(base - raw[i - 1]);
    for (let k = -4; k <= 4; k++) {
      const c = base + k * edo, d = Math.abs(c - raw[i - 1]);
      if (d < bestD) { bestD = d; best = c; }
    }
    raw.push(best);
  }
  const fitted = fitLineIntoWindow(raw, edo, low, high);
  return fitted.length ? { notes: fitted, degrees: safe } : null;
}

type PhraseResult = { notes: number[]; degrees: string[] } | null;
type ArchetypeFn = (
  mode: ModeInfo, tonicAbs: number, edo: number,
  low: number, high: number, phraseLen: number,
) => PhraseResult;

// Helper: colors = character tones excluding the 3rd (3rd has its own slot).
function getColorsMinusThird(mode: ModeInfo): string[] {
  const third = getThird(mode);
  const colors = mode.character.filter(d => d !== third);
  return colors.length ? colors : [third];
}

// Diatonic non-character tones (the mode's 4th, 5th, 7th positions when
// they aren't already classed as stable or character).  Used to break
// monotony in archetypes when the color set is small (e.g. Aeolian only
// has b6 as a color — fillers like 4 and b7 keep the phrase melodic
// without revealing the mode through repeats).
function getMelodicExtras(mode: ModeInfo): string[] {
  const stable = new Set(mode.stable);
  const colors = new Set(mode.character);
  const out: string[] = [];
  for (const p of [3, 4, 6]) {
    const deg = mode.scaleDegrees[p];
    if (!deg || deg === "1") continue;
    if (stable.has(deg) || colors.has(deg)) continue;
    out.push(deg);
  }
  return out;
}

// Pick a degree from `pool`, avoiding `avoid` when possible.  Falls back
// to picking from the full pool when filtering would empty it.
function pickAvoiding(pool: string[], avoid: string | undefined): string {
  if (pool.length === 0) return "1";
  if (pool.length === 1 || avoid === undefined) return pool[Math.floor(Math.random() * pool.length)];
  const filtered = pool.filter(x => x !== avoid);
  const src = filtered.length > 0 ? filtered : pool;
  return src[Math.floor(Math.random() * src.length)];
}

// Archetype B — framed by stable non-root tones (3rd, 5th, etc.).
// Root never appears; drone supplies the tonic reference.
const archetypeStableFramed: ArchetypeFn = (mode, tonicAbs, edo, low, high, phraseLen) => {
  const third = getThird(mode);
  const colors = getColorsMinusThird(mode);
  const extras = getMelodicExtras(mode);
  const anchorSet = new Set<string>();
  for (const s of mode.stable) if (s !== "1") anchorSet.add(s);
  anchorSet.add(third);
  if (mode.scaleDegrees.includes("5")) anchorSet.add("5");
  const anchors = [...anchorSet];
  if (!anchors.length) anchors.push(third);

  // Honour phraseLen strictly: reserve 2 slots for start + end, cap the
  // mustHit color list to whatever's left.  A short maxNotes (e.g. 3)
  // shouldn't blow past its budget just because the mode has many colors.
  const target = Math.max(2, phraseLen);
  const start = randomChoice(anchors);
  const end = randomChoice(anchors);
  const innerSlots = Math.max(0, target - 2);
  const mustHit = [...colors].sort(() => Math.random() - 0.5).slice(0, innerSlots);
  const seq: string[] = [start, ...mustHit];
  const fillCount = Math.max(0, target - 1 - seq.length);
  const colorPool = colors.length <= 2 ? [...colors, ...extras] : colors;
  for (let i = 0; i < fillCount; i++) {
    const prev = seq[seq.length - 1];
    const r = Math.random();
    if (r < 0.35) seq.push(pickAvoiding(anchors, prev));
    else          seq.push(pickAvoiding(colorPool, prev));
  }
  seq.push(end);
  return voiceLeadSeq(seq, mode, tonicAbs, edo, low, high);
};

// Archetype C — chord-tone spine with colors woven in.
// Root excluded; line alternates between the mode's basic 4-note chord tones
// (3rd / 5th / 7th — slice avoids the upper extensions, which would just be
// the rest of the scale and turn the spine into the whole mode) and color tones.
const archetypeSpine: ArchetypeFn = (mode, tonicAbs, edo, low, high, phraseLen) => {
  const chord = mode.chordOptions[0]?.degrees ?? ["1","3","5","b7"];
  const spine = chord.slice(1, 4);
  if (!spine.length) return null;
  const colors = getColorsMinusThird(mode);
  const extras = getMelodicExtras(mode);

  const shuffledSpine = [...spine].sort(() => Math.random() - 0.5);
  const colorPool = (colors.length <= 2 ? [...colors, ...extras] : [...colors])
    .sort(() => Math.random() - 0.5);
  // Honour phraseLen strictly — never exceed the user's Max-notes budget.
  const target = Math.max(1, phraseLen);
  const seq: string[] = [];
  let si = 0, ci = 0;
  while (seq.length < target) {
    const prev: string | undefined = seq.length > 0 ? seq[seq.length - 1] : undefined;
    if (Math.random() < 0.5) {
      let pick = shuffledSpine[si++ % shuffledSpine.length];
      if (pick === prev && shuffledSpine.length > 1) pick = shuffledSpine[si++ % shuffledSpine.length];
      seq.push(pick);
    } else {
      let pick = colorPool[ci++ % colorPool.length];
      if (pick === prev && colorPool.length > 1) pick = colorPool[ci++ % colorPool.length];
      seq.push(pick);
    }
  }
  return voiceLeadSeq(seq, mode, tonicAbs, edo, low, high);
};

// Archetype D — land on a characteristic tone.
// Phrase starts on a stable tone, weaves through all colors, ends on a random color.
const archetypeLandOnColor: ArchetypeFn = (mode, tonicAbs, edo, low, high, phraseLen) => {
  const third = getThird(mode);
  const colors = getColorsMinusThird(mode);
  const extras = getMelodicExtras(mode);
  const stableNonRoot = mode.stable.filter(d => d !== "1");
  const stable = stableNonRoot.length ? stableNonRoot.concat([third]) : [third];

  // Honour phraseLen strictly: 1 slot for the final color, the rest is
  // start + must-hits + fillers, all capped to fit.
  const target = Math.max(2, phraseLen);
  const finalColor = randomChoice(colors);
  const start = randomChoice(stable);
  const innerSlots = Math.max(0, target - 2);
  const mustHit = colors
    .filter(c => c !== finalColor)
    .sort(() => Math.random() - 0.5)
    .slice(0, innerSlots);
  const seq: string[] = [start, ...mustHit];
  const fillCount = Math.max(0, target - 1 - seq.length);
  const colorPool = colors.length <= 2 ? [...colors, ...extras] : colors;
  for (let i = 0; i < fillCount; i++) {
    const prev = seq[seq.length - 1];
    const r = Math.random();
    if (r < 0.3)       seq.push(pickAvoiding(stable, prev));
    else if (r < 0.55) seq.push(prev === third ? pickAvoiding(stable, prev) : third);
    else               seq.push(pickAvoiding(colorPool, prev));
  }
  seq.push(finalColor);
  return voiceLeadSeq(seq, mode, tonicAbs, edo, low, high);
};

const ARCHETYPES: ArchetypeFn[] = [
  archetypeStableFramed,
  archetypeSpine,
  archetypeLandOnColor,
];

// Scale traversal patterns. All cover every degree of the mode exactly once;
// monotonic patterns bookend with the tonic octave, non-monotonic ones don't.
// Non-monotonic patterns remove the "ascending-scale gestalt" so the user
// actually has to identify the intervals, not the overall contour.
type ScalePattern = "up" | "down" | "thirds-up" | "thirds-down" | "shuffle";
const SCALE_PATTERNS: ScalePattern[] = ["up", "down", "thirds-up", "thirds-down", "shuffle"];

export const SCALE_PATTERN_LABEL: Record<ScalePattern, string> = {
  "up":          "ascending ↑",
  "down":        "descending ↓",
  "thirds-up":   "thirds ↑",
  "thirds-down": "thirds ↓",
  "shuffle":     "shuffled",
};

function generateScale(
  mode: ModeInfo, tonicAbs: number, edo: number, low: number, high: number,
  allowedPatterns: ScalePattern[] = SCALE_PATTERNS,
  maxNotes: number = Infinity,
): { notes: number[]; degrees: string[]; pattern: ScalePattern } | null {
  const modeMap = getModeDegreeMap(edo, mode.family, mode.name);
  const n = mode.scaleDegrees.length;
  const asc = Array.from({ length: n }, (_, i) => i);
  const pool = allowedPatterns.length ? allowedPatterns : SCALE_PATTERNS;

  // Try the user's chosen pattern first; fall back through the rest of
  // the enabled patterns so a narrow register doesn't drop the round.
  // We also try shuffle as a last resort even if disabled — its
  // voice-leading bounds the spread to ~1 octave so it always fits.
  const tried = new Set<ScalePattern>();
  const primary = randomChoice(pool);
  const orderedAttempts: ScalePattern[] = [primary, ...pool.filter(p => p !== primary)];
  if (!orderedAttempts.includes("shuffle")) orderedAttempts.push("shuffle");

  for (const pattern of orderedAttempts) {
    if (tried.has(pattern)) continue;
    tried.add(pattern);
    const built = tryBuildScale(mode, modeMap, asc, n, pattern, tonicAbs, edo, low, high, maxNotes);
    if (built) return built;
  }
  return null;
}

function tryBuildScale(
  mode: ModeInfo,
  modeMap: Record<string, number>,
  asc: number[],
  n: number,
  pattern: ScalePattern,
  tonicAbs: number, edo: number, low: number, high: number,
  maxNotes: number,
): { notes: number[]; degrees: string[]; pattern: ScalePattern } | null {
  void mode;
  // Build the degree-index traversal and decide where (if anywhere) the
  // octave tonic sits — monotonic patterns bookend so the phrase resolves.
  let idxSeq: number[];
  let octPos: "start" | "end" | null;
  if (pattern === "up")               { idxSeq = asc;                             octPos = "end";   }
  else if (pattern === "down")        { idxSeq = [...asc].reverse();              octPos = "start"; }
  else if (pattern === "thirds-up")   { idxSeq = [0,2,4,6,1,3,5].filter(i => i<n); octPos = "end";   }
  else if (pattern === "thirds-down") { idxSeq = [6,4,2,0,5,3,1].filter(i => i<n); octPos = "start"; }
  else                                { idxSeq = [...asc].sort(() => Math.random() - 0.5); octPos = null; }

  // Honour the Max-notes setting: truncate the traversal so the phrase
  // stays at most maxNotes long.  Drop the octave bookend when it would
  // push past the cap so the user gets exactly maxNotes notes.
  if (Number.isFinite(maxNotes) && maxNotes > 0) {
    const reserve = octPos === null ? 0 : 1; // octave occupies one slot
    const slots = Math.max(1, Math.floor(maxNotes) - reserve);
    if (slots < idxSeq.length) idxSeq = idxSeq.slice(0, slots);
    if (Math.floor(maxNotes) < 1 + reserve) octPos = null; // no room for octave
  }

  const degrees = idxSeq.map(i => mode.scaleDegrees[i]);
  if (octPos === "end")   degrees.push("1");
  else if (octPos === "start") degrees.unshift("1");

  // Pitch placement. Monotonic patterns force each step in its direction
  // (so thirds-up stays ascending even across the 7→2 wrap); shuffle
  // voice-leads each degree to the nearest octave of the previous note.
  const direction = (pattern === "down" || pattern === "thirds-down") ? "down"
                  : (pattern === "up"   || pattern === "thirds-up")   ? "up"
                  : "free";

  const notes: number[] = [];
  for (let i = 0; i < degrees.length; i++) {
    const isOct = (octPos === "end"   && i === degrees.length - 1)
               || (octPos === "start" && i === 0);
    const step = isOct ? edo : (modeMap[degrees[i]] ?? 0);
    const base = tonicAbs + step;
    if (i === 0) { notes.push(base); continue; }
    const prev = notes[i - 1];
    if (direction === "up") {
      let m = base; while (m < prev) m += edo; notes.push(m);
    } else if (direction === "down") {
      let m = base; while (m > prev) m -= edo; notes.push(m);
    } else {
      // Free voice-leading: prefer the octave that keeps the note inside
      // the register window AND stays close to the previous note.  Falls
      // back to nearest-overall when no in-window candidate exists.
      let best: number | null = null;
      let bestD = Infinity;
      for (let k = -4; k <= 4; k++) {
        const cand = base + k * edo;
        if (cand < low || cand > high) continue;
        const d = Math.abs(cand - prev);
        if (d < bestD) { bestD = d; best = cand; }
      }
      if (best === null) {
        best = base;
        bestD = Math.abs(base - prev);
        for (let k = -4; k <= 4; k++) {
          const cand = base + k * edo, d = Math.abs(cand - prev);
          if (d < bestD) { bestD = d; best = cand; }
        }
      }
      notes.push(best);
    }
  }

  // Shift the whole line as a unit to fit the register.  If the natural
  // spread exceeds (high − low), no shift will fit and we bail; the
  // caller falls through to the next pattern.  STRICT enforcement: any
  // note outside [low, high] disqualifies the phrase.
  let fitted = notes.slice();
  while (Math.max(...fitted) > high) fitted = fitted.map(v => v - edo);
  while (Math.min(...fitted) < low)  fitted = fitted.map(v => v + edo);
  if (Math.max(...fitted) > high || Math.min(...fitted) < low) return null;

  return { notes: fitted, degrees, pattern };
}

// Characteristic-chord builder: a 1-3-7 shell (lower structure) topped by the
// mode's character tones (upper structure), so the listener hears the basic
// quality (major / minor / dom / dim) underneath the modal colors. Root is
// anchored at tonicAbs; each successive tone is octave-shifted up to sit above
// the previous one, and the stack is allowed to run past the top of the
// register. Character tones already covered by the shell (e.g. Mixolydian's
// b7) drop out — leaving the shell to carry that color on its own.
function generateChord(
  mode: ModeInfo, tonicAbs: number, edo: number, _low: number, _high: number,
): { notes: number[]; chordName: string; degrees: string[] } | null {
  void _low; void _high;
  if (!mode.chordOptions.length) return null;
  const pick = mode.chordOptions[0];

  // Shell: 1, 3, 7 — read by chord position so altered 3rds/7ths
  // (b3, b7, dim7=6, …) come along with the chord's quality.
  const shell: string[] = [pick.degrees[0]];
  if (pick.degrees.length >= 2) shell.push(pick.degrees[1]);
  if (pick.degrees.length >= 4) shell.push(pick.degrees[3]);

  // Upper structure: character tones not already represented in the shell,
  // sorted by raw step so the voicing reads in ascending pitch order.
  const shellSet = new Set(shell);
  const upper = mode.character
    .filter(d => !shellSet.has(d))
    .map(d => ({ d, step: resolveStep(d, edo) }))
    .sort((a, b) => a.step - b.step);

  const notes: number[] = [tonicAbs];
  for (let i = 1; i < shell.length; i++) {
    let n = tonicAbs + resolveStep(shell[i], edo);
    while (n <= notes[notes.length - 1]) n += edo;
    notes.push(n);
  }
  for (const { d } of upper) {
    let n = tonicAbs + resolveStep(d, edo);
    while (n <= notes[notes.length - 1]) n += edo;
    notes.push(n);
  }

  return {
    notes,
    chordName: pick.name,
    degrees: [...shell, ...upper.map(u => u.d)],
  };
}

// ── Scale highlight helper ────────────────────────────────────────────

function getScalePitches(
  mode: ModeInfo, tonicPc: number, edo: number,
  lowestOct: number, highestOct: number,
): number[] {
  const modeMap = getModeDegreeMap(edo, mode.family, mode.name);
  const [low, high] = strictWindowBounds(tonicPc, edo, lowestOct, highestOct);
  const pitches: number[] = [];
  for (const deg of mode.scaleDegrees) {
    const offset = modeMap[deg] ?? 0;
    for (let oct = lowestOct; oct <= highestOct; oct++) {
      const abs = tonicPc + (oct - 4) * edo + offset;
      if (abs >= low && abs <= high) pitches.push(abs);
    }
  }
  return pitches;
}

// ── Component ─────────────────────────────────────────────────────────

export default function ModeIdentificationTab({
  tonicPc, lowestOct, highestOct, edo, onHighlight,
  onResult, onPlay, lastPlayed, ensureAudio, onAnswer, answerButtons,
}: Props) {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const [enabledModes, setEnabledModes] = useLS<Set<string>>("lt_modeid_enabled_v2",
    new Set(ALL_MODES.map(m => m.name))
  );
  const [maxNotes, setMaxNotes] = useLS<number>("lt_modeid_maxNotes", 8);
  const [noteSec, setNoteSec] = useLS<number>("lt_modeid_noteSec", DEFAULT_GAP / 1000);
  const [enabledTypes, setEnabledTypes] = useLS<{ colors: boolean; chord: boolean; scale: boolean }>(
    "lt_modeid_types_v2", { colors: true, chord: true, scale: true }
  );
  const [enabledScalePatterns, setEnabledScalePatterns] = useLS<Set<ScalePattern>>(
    "lt_modeid_scale_patterns", new Set<ScalePattern>(SCALE_PATTERNS)
  );

  const [isPlaying, setIsPlaying] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [userAnswer, setUserAnswer] = useState<string | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);

  const curMode = useRef<ModeInfo | null>(null);
  const curDegrees = useRef<string[]>([]);
  const curGapMs = useRef(DEFAULT_GAP);
  const curKind = useRef<"colors" | "chord" | "scale">("colors");
  const curChord = useRef<{ name: string; degrees: string[] } | null>(null);
  const curPattern = useRef<ScalePattern | null>(null);

  const stopTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; audioEngine.stopDrone(); };

  const highlightFramesWithGap = useCallback((frames: number[][], gapMs: number) => {
    frames.forEach((frame, i) => {
      const id = setTimeout(() => onHighlight(frame), i * gapMs);
      timers.current.push(id);
    });
  }, [onHighlight]);

  // Audio playback. `showVisual` highlights each frame on the visualizer in order
  // (true only when the user clicks Show Answer — Play / Replay stay audio-only).
  const doPlay = useCallback((frames: number[][], gapMs: number, showVisual = false) => {
    stopTimers();
    const phraseMs = frames.length * gapMs;
    const sustainSec = Math.max(0.2, gapMs / 1000 + 0.25);
    audioEngine.playSequence(frames, edo, gapMs, sustainSec);
    if (showVisual) highlightFramesWithGap(frames, gapMs);
    const doneId = setTimeout(() => setIsPlaying(false), phraseMs + 500);
    timers.current.push(doneId);
  }, [edo, highlightFramesWithGap]);

  const play = async () => {
    if (isPlaying) return;
    await ensureAudio();

    const pool = ALL_MODES.filter(m => enabledModes.has(m.name));
    if (!pool.length) { onResult("Enable at least one mode in the pool."); return; }

    // Pick randomly among the enabled play types.
    const kinds: Array<"colors" | "chord" | "scale"> = [];
    if (enabledTypes.colors) kinds.push("colors");
    if (enabledTypes.chord)  kinds.push("chord");
    if (enabledTypes.scale)  kinds.push("scale");
    if (!kinds.length) { onResult("Enable Color Set, Characteristic Chord, or Scale."); return; }
    const kind = randomChoice(kinds);

    const mode = randomChoice(pool);
    const [low, high] = strictWindowBounds(tonicPc, edo, lowestOct, highestOct);
    const midAbs = tonicPc + (Math.floor((lowestOct + highestOct) / 2) - 4) * edo;

    let frames: number[][];
    let gapMs: number;
    let degrees: string[];
    let chordInfo: { name: string; degrees: string[] } | null = null;
    let pattern: ScalePattern | null = null;

    if (kind === "colors") {
      // Use the same strict window as scales: phrase ends at the tonic
      // of `highestOct` (no bleed into the next octave above).
      const tightHigh = tonicPc + (highestOct - 4) * edo;
      const tightLow  = tonicPc + (lowestOct  - 4) * edo;
      const shuffled = [...ARCHETYPES].sort(() => Math.random() - 0.5);
      let result: PhraseResult = null;
      for (const arche of shuffled) {
        result = arche(mode, midAbs, edo, tightLow, tightHigh, maxNotes);
        if (result) break;
      }
      if (!result) { onResult("Could not fit phrase in register."); return; }
      frames = result.notes.map(n => [n]);
      gapMs = Math.round(noteSec * 1000);
      degrees = result.degrees;
    } else if (kind === "chord") {
      const built = generateChord(mode, midAbs, edo, low, high);
      if (!built) { onResult("Mode has no chord options."); return; }
      frames = [built.notes];
      gapMs = 2000; // single chord ringing; sustain ≈ 2.25s
      degrees = built.degrees;
      chordInfo = { name: built.chordName, degrees: built.degrees };
    } else {
      // Scale exercises strictly stop at the tonic of `highestOct` —
      // notes never go above that.  strictWindowBounds returns the top
      // of the next octave (tonic+edo) as the upper bound; scales pull
      // that back to (tonic+0) so the phrase doesn't bleed into the
      // octave above the user's register.
      const scaleHigh = tonicPc + (highestOct - 4) * edo;
      const scaleLow  = tonicPc + (lowestOct  - 4) * edo;
      const built = generateScale(mode, midAbs, edo, scaleLow, scaleHigh, Array.from(enabledScalePatterns), maxNotes);
      if (!built) { onResult("Could not fit scale in register."); return; }
      frames = built.notes.map(n => [n]);
      gapMs = Math.round(noteSec * 1000);
      degrees = built.degrees;
      pattern = built.pattern;
    }

    curMode.current = mode;
    curDegrees.current = degrees;
    curGapMs.current = gapMs;
    curKind.current = kind;
    curChord.current = chordInfo;
    curPattern.current = pattern;
    lastPlayed.current = {
      frames,
      info: chordInfo
        ? `${mode.displayName} — ${chordInfo.name}`
        : pattern
          ? `${mode.displayName} — scale ${SCALE_PATTERN_LABEL[pattern]}`
          : mode.displayName,
    };
    setHasPlayed(true);

    setUserAnswer(null);
    setShowAnswer(false);
    setIsPlaying(true);

    const playKey = chordInfo
      ? `modeId:${mode.family}:${mode.name}:${chordInfo.name}`
      : pattern
        ? `modeId:${mode.family}:${mode.name}:scale-${pattern}`
        : `modeId:${mode.family}:${mode.name}`;
    const playLabel = chordInfo
      ? `Mode ID: ${mode.displayName} (${chordInfo.name})`
      : pattern
        ? `Mode ID: ${mode.displayName} (scale ${SCALE_PATTERN_LABEL[pattern]})`
        : `Mode ID: ${mode.displayName}`;
    onPlay(playKey, playLabel);
    onResult(
      kind === "chord" ? "Mode Identification — Characteristic Chord…"
      : kind === "scale" ? `Mode Identification — Scale ${pattern ? SCALE_PATTERN_LABEL[pattern] : ""}…`
      : "Mode Identification — Color Set…"
    );

    doPlay(frames, gapMs);
  };

  const replay = () => {
    const lp = lastPlayed.current;
    if (!lp || isPlaying) return;
    setIsPlaying(true);
    doPlay(lp.frames, curGapMs.current);
  };

  const toggleMode = (name: string) => {
    setEnabledModes(prev => {
      const next = new Set(prev);
      if (next.has(name)) { if (next.size > 1) next.delete(name); }
      else next.add(name);
      return next;
    });
  };

  const FAMILY_GROUPS: { key: string; label: string; color: string; modes: ModeInfo[] }[] = [
    { key: "major",    label: "MAJOR",          color: "#6a9aca", modes: FAMILY_MAP.major    },
    { key: "harmonic", label: "HARMONIC MINOR", color: "#c09050", modes: FAMILY_MAP.harmonic },
    { key: "melodic",  label: "MELODIC MINOR",  color: "#c06090", modes: FAMILY_MAP.melodic  },
  ];

  return (
    <div className="space-y-4">
      {/* Options row */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-xs text-[#888] block mb-1">Max notes</label>
          <select value={maxNotes} onChange={e => setMaxNotes(Number(e.target.value))}
            className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            {NOTE_COUNTS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-[#888]">Note length</label>
          <input type="range" min={0.2} max={2.0} step={0.05} value={noteSec}
            onChange={e => setNoteSec(Number(e.target.value))}
            className="w-28 accent-[#7173e6]" />
          <span className="text-xs text-[#555] w-10 font-mono">{noteSec.toFixed(2)}s</span>
        </div>
        {/* Play-type toggles — Play button picks randomly from those enabled */}
        <div>
          <label className="text-xs text-[#888] block mb-1">Play types</label>
          <div className="flex gap-1">
            {([
              { key: "colors", label: "Color Set",            color: "#7173e6" },
              { key: "chord",  label: "Characteristic Chord", color: "#a06cc8" },
              { key: "scale",  label: "Scale",                color: "#5cca8a" },
            ] as const).map(t => {
              const on = enabledTypes[t.key];
              return (
                <button key={t.key}
                  onClick={() => setEnabledTypes(prev => {
                    const next = { ...prev, [t.key]: !prev[t.key] };
                    // At least one must stay enabled
                    if (!next.colors && !next.chord && !next.scale) return prev;
                    return next;
                  })}
                  className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                    on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                  }`}
                  style={on ? { backgroundColor: t.color + "30", borderColor: t.color, color: t.color } : {}}>
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
        {/* Scale patterns — only selectable when the Scale play type is on */}
        <div className={enabledTypes.scale ? "" : "opacity-50"}>
          <label className="text-xs text-[#888] block mb-1">
            Scale patterns
            {!enabledTypes.scale && <span className="ml-1 text-[#555]">(enable Scale to edit)</span>}
          </label>
          <div className="flex gap-1 flex-wrap">
            {SCALE_PATTERNS.map(p => {
              const on = enabledScalePatterns.has(p);
              const color = "#5cca8a";
              const disabled = !enabledTypes.scale;
              return (
                <button key={p}
                  disabled={disabled}
                  onClick={() => setEnabledScalePatterns(prev => {
                    const next = new Set(prev);
                    if (next.has(p)) {
                      if (next.size > 1) next.delete(p);
                    } else next.add(p);
                    return next;
                  })}
                  className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                    disabled ? "cursor-not-allowed bg-[#0e0e0e] border-[#222] text-[#444]"
                    : on ? "" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                  }`}
                  style={!disabled && on ? { backgroundColor: color + "30", borderColor: color, color } : undefined}>
                  {SCALE_PATTERN_LABEL[p]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Mode pool — all 21 modes grouped by family, styled like Chords tab toggles */}
      <div className="bg-[#0e0e0e] border border-[#1a1a1a] rounded p-2 space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-xs text-[#888] font-medium">MODE POOL</p>
          <button onClick={() => setEnabledModes(new Set(ALL_MODES.map(m => m.name)))}
            className="text-[9px] text-[#555] hover:text-[#9999ee] border border-[#222] rounded px-2 py-0.5">All</button>
          {FAMILY_GROUPS.map(g => (
            <button key={g.key} onClick={() => setEnabledModes(prev => {
              const next = new Set(prev);
              for (const m of g.modes) next.add(m.name);
              return next;
            })}
              className="text-[9px] text-[#555] hover:text-[#aaa] border border-[#222] rounded px-2 py-0.5">
              +{g.label}
            </button>
          ))}
        </div>
        {FAMILY_GROUPS.map(group => (
          <div key={group.key}>
            <p className="text-[9px] mb-1 font-medium tracking-wider"
               style={{ color: group.color }}>{group.label}</p>
            <div className="flex flex-wrap gap-1">
              {group.modes.map(mode => {
                const on = enabledModes.has(mode.name);
                const isAnswer = showAnswer && curMode.current?.name === mode.name;
                const color = isAnswer ? "#5cca5c" : group.color;
                return (
                  <button key={mode.name} onClick={() => toggleMode(mode.name)}
                    className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                      on || isAnswer ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                    }`}
                    style={(on || isAnswer) ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
                    {mode.displayName}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Answer reveal — shown after clicking Show Answer */}
      {showAnswer && curMode.current && (
        <div className="space-y-2">
          <div className="rounded p-3 text-sm border font-medium bg-[#1a1a2a] border-[#444] text-[#9999ee]">
            {curMode.current.displayName}
            <span className="ml-2 text-xs opacity-60 font-normal">
              ({curMode.current.family.replace(" Family","")})
            </span>
            {curKind.current === "chord" && curChord.current && (
              <span className="ml-2 text-xs font-normal text-[#c9a3e8]">
                · chord played: <span className="font-mono font-medium">{curChord.current.name}</span>
              </span>
            )}
            {curKind.current === "scale" && curPattern.current && (
              <span className="ml-2 text-xs font-normal text-[#7ad6a3]">
                · scale {SCALE_PATTERN_LABEL[curPattern.current]}
              </span>
            )}
          </div>
          {/* Degrees played / chord tones / scale, with characteristic tones highlighted */}
          {curDegrees.current.length > 0 && (
            <div className="flex gap-1 items-center flex-wrap">
              <span className="text-[#666] text-xs mr-1">
                {curKind.current === "chord" ? "Chord tones:"
                 : curKind.current === "scale" ? "Scale:"
                 : "Degrees played:"}
              </span>
              {curDegrees.current.map((deg, i) => {
                const isChar = curMode.current!.character.includes(deg);
                return (
                  <span key={i} className={`px-1.5 py-0.5 rounded text-xs font-mono border ${
                    isChar
                      ? "bg-[#2a1a3a] text-[#bb88ee] border-[#6644aa] font-bold"
                      : "bg-[#1a1a2a] text-[#9999ee] border-[#333]"
                  }`}>
                    {deg}
                  </span>
                );
              })}
            </div>
          )}
          {/* Scale degrees with characteristic tones highlighted */}
          <div className="rounded p-3 text-sm border border-[#333] bg-[#161616]">
            <div className="flex gap-1 items-center flex-wrap">
              <span className="text-[#666] text-xs mr-1">Scale:</span>
              {curMode.current.scaleDegrees.map(deg => (
                <span key={deg} className={`px-1.5 py-0.5 rounded text-xs font-mono ${
                  curMode.current!.character.includes(deg)
                    ? "bg-[#2a1a3a] text-[#bb88ee] border border-[#6644aa] font-bold"
                    : "bg-[#1a1a1a] text-[#888] border border-[#2a2a2a]"
                }`}>
                  {deg}
                </span>
              ))}
              <span className="text-[10px] text-[#555] ml-2">
                (highlighted = characteristic)
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={play} disabled={isPlaying}
          className="bg-[#7173e6] hover:bg-[#5a5cc8] disabled:opacity-50 text-white px-5 py-2 rounded text-sm font-medium transition-colors">
          {isPlaying ? "♪ Playing…" : "▶ Play"}
        </button>
        {hasPlayed && (
          <button onClick={replay} disabled={isPlaying}
            className="bg-[#1e1e1e] hover:bg-[#2a2a2a] disabled:opacity-50 border border-[#333] text-[#aaa] px-4 py-2 rounded text-sm transition-colors">
            Replay
          </button>
        )}
        {hasPlayed && (
          <button onClick={() => {
            setShowAnswer(true);
            const lp = lastPlayed.current;
            const mode = curMode.current;
            if (lp && !isPlaying) {
              setIsPlaying(true);
              doPlay(lp.frames, curGapMs.current, true);
              if (mode) {
                const tailId = setTimeout(
                  () => onHighlight(getScalePitches(mode, tonicPc, edo, lowestOct, highestOct)),
                  lp.frames.length * curGapMs.current + 200,
                );
                timers.current.push(tailId);
              }
            } else if (mode) {
              onHighlight(getScalePitches(mode, tonicPc, edo, lowestOct, highestOct));
            }
          }}
            disabled={isPlaying}
            className="bg-[#1e1e1e] hover:bg-[#2a2a2a] disabled:opacity-50 border border-[#444] text-[#9999ee] px-4 py-2 rounded text-sm transition-colors">
            Show Answer
          </button>
        )}
        {answerButtons}
      </div>
    </div>
  );
}
