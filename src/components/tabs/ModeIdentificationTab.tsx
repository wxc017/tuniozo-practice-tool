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

interface ModeInfo {
  name: string;         // code name (matches getModeDegreeMap key)
  family: string;       // "Major Family" | "Harmonic Minor Family" | "Melodic Minor Family"
  displayName: string;  // pretty name shown in UI
  scaleDegrees: string[];  // 7 ordered degree labels
  character: string[];     // characteristic tones (subset of scaleDegrees)
  stable: string[];        // stable tones
  chordOptions: string[][];// each option = list of chromatic degree labels
}

// Chromatic degree labels → chord arrays
const CD: Record<string, string[]> = {
  "maj7":      ["1","3","5","7"],
  "maj9":      ["1","3","5","7","9"],
  "maj13":     ["1","3","5","7","9","6"],
  "maj7#11":   ["1","3","5","7","#4"],
  "maj9#11":   ["1","3","5","7","9","#4"],
  "maj13#11":  ["1","3","5","7","9","#4","6"],
  "m7":        ["1","b3","5","b7"],
  "m9":        ["1","b3","5","b7","9"],
  "m11":       ["1","b3","5","b7","9","4"],
  "m13":       ["1","b3","5","b7","9","4","6"],
  "m7b9":      ["1","b3","5","b7","b9"],
  "m11b9":     ["1","b3","5","b7","b9","4"],
  "sus_b9":    ["1","4","5","b9"],
  "m7b5":      ["1","b3","b5","b7"],
  "m9b5":      ["1","b3","b5","b7","9"],
  "m11b5":     ["1","b3","b5","b7","9","4"],
  "m7b13":     ["1","b3","5","b7","b13"],
  "7":         ["1","3","5","b7"],
  "9":         ["1","3","5","b7","9"],
  "13":        ["1","3","5","b7","9","6"],
  "7sus4":     ["1","4","5","b7"],
  "13sus4":    ["1","4","5","b7","9","6"],
  "mMaj7":     ["1","b3","5","7"],
  "mMaj9":     ["1","b3","5","7","9"],
  "mMaj11":    ["1","b3","5","7","9","4"],
  "maj7s5":    ["1","3","#5","7"],
  "maj9s5":    ["1","3","#5","7","9"],
  "maj7s5s11": ["1","3","#5","7","#4"],
  "m7s11":     ["1","b3","5","b7","#4"],
  "m9s11":     ["1","b3","5","b7","9","#4"],
  "m11s11":    ["1","b3","5","b7","9","4","#4"],
  "7b9":       ["1","3","5","b7","b9"],
  "7b13":      ["1","3","5","b7","b13"],
  "7b9b13":    ["1","3","5","b7","b9","b13"],
  "7s11":      ["1","3","5","b7","#4"],
  "9s11":      ["1","3","5","b7","9","#4"],
  "13s11":     ["1","3","5","b7","9","#4","6"],
  "9b13":      ["1","3","5","b7","9","b13"],
  "dim7":      ["1","b3","b5","6"],
  "dim9":      ["1","b3","b5","6","9"],
  "dim11":     ["1","b3","b5","6","9","4"],
  "7alt":      ["1","3","b5","b7","b9","#9"],
  "7b5":       ["1","3","b5","b7"],
  "7s5":       ["1","3","#5","b7"],
  "7s9":       ["1","3","5","b7","#9"],
  // Lydian / maj#11 variants
  "maj7s11":   ["1","3","5","7","#4"],
  "maj9s11":   ["1","3","5","7","9","#4"],
  "maj13s11":  ["1","3","5","7","9","#4","6"],
};

const c = (...names: string[]): string[][] =>
  names.map(n => CD[n] ?? ["1","3","5","b7"]);

const ALL_MODES: ModeInfo[] = [
  // ── Major Family ──────────────────────────────────────────────────
  {
    name: "Ionian", family: "Major Family", displayName: "Ionian",
    scaleDegrees: ["1","2","3","4","5","6","7"],
    character: ["4","7"], stable: ["1","3","5"],
    chordOptions: c("maj7","maj9","maj13"),
  },
  {
    name: "Dorian", family: "Major Family", displayName: "Dorian",
    scaleDegrees: ["1","2","b3","4","5","6","b7"],
    character: ["b3","6"], stable: ["1","5"],
    chordOptions: c("m7","m9","m11","m13"),
  },
  {
    name: "Phrygian", family: "Major Family", displayName: "Phrygian",
    scaleDegrees: ["1","b2","b3","4","5","b6","b7"],
    character: ["b2"], stable: ["1","5"],
    chordOptions: c("m7b9","m11b9","sus_b9"),
  },
  {
    name: "Lydian", family: "Major Family", displayName: "Lydian",
    scaleDegrees: ["1","2","3","#4","5","6","7"],
    character: ["#4"], stable: ["1","5"],
    chordOptions: c("maj7s11","maj9s11","maj13s11"),
  },
  {
    name: "Mixolydian", family: "Major Family", displayName: "Mixolydian",
    scaleDegrees: ["1","2","3","4","5","6","b7"],
    character: ["b7"], stable: ["1","3","5"],
    chordOptions: c("7","9","13","7sus4","13sus4"),
  },
  {
    name: "Aeolian", family: "Major Family", displayName: "Aeolian",
    scaleDegrees: ["1","2","b3","4","5","b6","b7"],
    character: ["b3","b6"], stable: ["1","5"],
    chordOptions: c("m7","m9","m11","m7b13"),
  },
  {
    name: "Locrian", family: "Major Family", displayName: "Locrian",
    scaleDegrees: ["1","b2","b3","4","b5","b6","b7"],
    character: ["b2","b5"], stable: ["1"],
    chordOptions: c("m7b5","m9b5","m11b5"),
  },
  // ── Harmonic Minor Family ─────────────────────────────────────────
  {
    name: "Harmonic Minor", family: "Harmonic Minor Family", displayName: "Harmonic Minor",
    scaleDegrees: ["1","2","b3","4","5","b6","7"],
    character: ["b6","7"], stable: ["1","5"],
    chordOptions: c("mMaj7","mMaj9","mMaj11"),
  },
  {
    name: "Locrian #6", family: "Harmonic Minor Family", displayName: "Locrian ♮6",
    scaleDegrees: ["1","b2","b3","4","b5","6","b7"],
    character: ["b2","6"], stable: ["1"],
    chordOptions: c("m7b5","m9b5","m11b5"),
  },
  {
    name: "Ionian #5", family: "Harmonic Minor Family", displayName: "Ionian ♯5",
    scaleDegrees: ["1","2","3","4","#5","6","7"],
    character: ["#5"], stable: ["1"],
    chordOptions: c("maj7s5","maj9s5","maj7s5s11"),
  },
  {
    name: "Dorian #4", family: "Harmonic Minor Family", displayName: "Dorian ♯4",
    scaleDegrees: ["1","2","b3","#4","5","6","b7"],
    character: ["#4"], stable: ["1","5"],
    chordOptions: c("m7s11","m9s11","m11s11"),
  },
  {
    name: "Phrygian Dominant", family: "Harmonic Minor Family", displayName: "Phrygian Dominant",
    scaleDegrees: ["1","b2","3","4","5","b6","b7"],
    character: ["b2","3","b6"], stable: ["1","5"],
    chordOptions: c("7b9","7b13","7b9b13"),
  },
  {
    name: "Lydian #2", family: "Harmonic Minor Family", displayName: "Lydian ♯2",
    scaleDegrees: ["1","#2","3","#4","5","6","7"],
    character: ["#2","#4"], stable: ["1","5"],
    chordOptions: c("maj7s11","maj9s11"),
  },
  {
    name: "Ultralocrian", family: "Harmonic Minor Family", displayName: "Superlocrian ♭♭7",
    scaleDegrees: ["1","b2","b3","3","b5","b6","6"],
    character: ["b2","b3","3","b5","b6"], stable: ["1"],
    chordOptions: c("dim7","dim9","dim11"),
  },
  // ── Melodic Minor Family ──────────────────────────────────────────
  {
    name: "Melodic Minor", family: "Melodic Minor Family", displayName: "Melodic Minor",
    scaleDegrees: ["1","2","b3","4","5","6","7"],
    character: ["6","7"], stable: ["1","5"],
    chordOptions: c("mMaj7","mMaj9","mMaj11"),
  },
  {
    name: "Dorian b2", family: "Melodic Minor Family", displayName: "Dorian ♭2",
    scaleDegrees: ["1","b2","b3","4","5","6","b7"],
    character: ["b2","6"], stable: ["1","5"],
    chordOptions: c("m7b9","m11b9"),
  },
  {
    name: "Lydian Augmented", family: "Melodic Minor Family", displayName: "Lydian Augmented",
    scaleDegrees: ["1","2","3","#4","#5","6","7"],
    character: ["#4","#5"], stable: ["1"],
    chordOptions: c("maj7s5","maj9s5","maj7s5s11"),
  },
  {
    name: "Lydian Dominant", family: "Melodic Minor Family", displayName: "Lydian Dominant",
    scaleDegrees: ["1","2","3","#4","5","6","b7"],
    character: ["#4","b7"], stable: ["1","3","5"],
    chordOptions: c("7s11","9s11","13s11"),
  },
  {
    name: "Mixolydian b6", family: "Melodic Minor Family", displayName: "Mixolydian ♭6",
    scaleDegrees: ["1","2","3","4","5","b6","b7"],
    character: ["b6","b7"], stable: ["1","3","5"],
    chordOptions: c("7b13","9b13"),
  },
  {
    name: "Locrian #2", family: "Melodic Minor Family", displayName: "Locrian ♮2",
    scaleDegrees: ["1","2","b3","4","b5","b6","b7"],
    character: ["2","b5"], stable: ["1"],
    chordOptions: c("m7b5","m9b5","m11b5"),
  },
  {
    name: "Altered", family: "Melodic Minor Family", displayName: "Altered",
    scaleDegrees: ["1","b2","#2","3","b5","#5","b7"],
    character: ["b2","#2","b5","#5"], stable: ["1","3"],
    chordOptions: c("7alt","7b9","7s9","7b5","7s5"),
  },
];

const FAMILY_MAP: Record<string, ModeInfo[]> = {
  major:    ALL_MODES.filter(m => m.family === "Major Family"),
  harmonic: ALL_MODES.filter(m => m.family === "Harmonic Minor Family"),
  melodic:  ALL_MODES.filter(m => m.family === "Melodic Minor Family"),
  all:      ALL_MODES,
};

// ── Phrase generation ─────────────────────────────────────────────────

const GAP = 560;        // ms between notes
const CHORD_LEAD = 1300; // ms chord rings before phrase starts

const PATTERN_LIST = [
  { key: "stepwise",           label: "Stepwise"   },
  { key: "arpeggio",           label: "Arpeggio"   },
  { key: "jump",               label: "Jump"        },
  { key: "character_emphasis", label: "Character"  },
  { key: "mixed",              label: "Mixed"       },
] as const;

const NOTE_COUNTS = [4, 5, 6, 7, 8, 10, 12];

function weightedIdx(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}

/**
 * Generate a pedagogically-structured mode identification phrase.
 *
 * Structure (for a phrase of length N):
 *   [1] Tonic anchor (degree 1)
 *   [2] Stable approach tone — stepwise neighbor of a characteristic tone
 *   [3..N-2] Body — pattern-dependent movement that highlights characteristic
 *            tones via stepwise approach from stable context
 *   [N-1] Characteristic tone (exposed, approached by step)
 *   [N] Tonic resolution (degree 1)
 *
 * This ensures:
 *  - The tonic is always established first and confirmed last
 *  - Characteristic tones are heard in relation to stable context
 *  - The ear has a clear tonal framework before encountering "color" tones
 */
function generatePhrase(
  mode: ModeInfo, tonicAbs: number, edo: number,
  low: number, high: number,
  phraseLen: number, pattern: string,
): { notes: number[]; degrees: string[] } | null {
  const modeMap = getModeDegreeMap(edo, mode.family, mode.name);
  const degs = mode.scaleDegrees;
  const n = degs.length;
  const charSet = new Set(mode.character);
  const stableSet = new Set(mode.stable);

  const charIndices = degs.map((d, i) => charSet.has(d) ? i : -1).filter(i => i >= 0);
  const stableIndices = degs.map((d, i) => (d === "1" || d === "5" || stableSet.has(d)) ? i : -1).filter(i => i >= 0);

  // Helper: stepwise neighbor of a target index
  const neighborOf = (target: number): number => {
    const above = (target + 1) % n;
    const below = ((target - 1) % n + n) % n;
    // Prefer the neighbor that is a stable tone
    if (stableSet.has(degs[above]) || degs[above] === "1" || degs[above] === "5") return above;
    if (stableSet.has(degs[below]) || degs[below] === "1" || degs[below] === "5") return below;
    return Math.random() < 0.5 ? above : below;
  };

  const seq: number[] = [];

  // ── [1] Always start on tonic ──
  seq.push(0); // degree "1"

  if (phraseLen <= 2) {
    // Ultra-short: tonic → characteristic tone
    if (charIndices.length) seq.push(randomChoice(charIndices));
    else seq.push(0);
    const raw = seq.map(s => tonicAbs + (modeMap[degs[s]] ?? 0));
    const fitted = fitLineIntoWindow(raw, edo, low, high);
    return fitted.length ? { notes: fitted, degrees: seq.map(s => degs[s]) } : null;
  }

  // ── [2] Move to a stable tone (5th or 3rd) to establish the mode's color ──
  const openingStable = stableIndices.filter(i => i !== 0);
  seq.push(openingStable.length ? randomChoice(openingStable) : 1);

  // ── [3..N-2] Body — pattern-dependent, biased toward characteristic tones ──
  const bodyLen = phraseLen - 4; // reserve: tonic + stable + char + tonic
  let pos = seq[seq.length - 1];

  for (let i = 0; i < Math.max(0, bodyLen); i++) {
    const prev = pos;

    if (pattern === "character_emphasis") {
      // 80% chance to hit a characteristic tone or its stepwise neighbor
      if (charIndices.length && Math.random() < 0.8) {
        const target = randomChoice(charIndices);
        pos = Math.random() < 0.6 ? target : neighborOf(target);
      } else {
        pos = ((prev + (Math.random() < 0.5 ? 1 : -1)) % n + n) % n;
      }
    } else if (pattern === "stepwise") {
      const dir = Math.random() < 0.55 ? 1 : -1;
      const step = Math.random() < 0.8 ? 1 : 2;
      pos = ((prev + dir * step) % n + n) % n;
    } else if (pattern === "arpeggio") {
      // Arpeggiate through chord tones and characteristic tones
      const targets = [...new Set([0, 2, 4, ...charIndices])];
      pos = randomChoice(targets);
    } else if (pattern === "jump") {
      const dir = Math.random() < 0.5 ? 1 : -1;
      pos = ((prev + dir * (3 + Math.floor(Math.random() * 3))) % n + n) % n;
    } else {
      // mixed: alternate between stepwise and characteristic emphasis
      if (Math.random() < 0.4 && charIndices.length) {
        const target = randomChoice(charIndices);
        pos = Math.random() < 0.5 ? target : neighborOf(target);
      } else {
        const dir = Math.random() < 0.5 ? 1 : -1;
        pos = ((prev + dir * (Math.random() < 0.7 ? 1 : 2)) % n + n) % n;
      }
    }
    seq.push(pos);
  }

  // ── [N-1] Expose a characteristic tone, approached by step ──
  if (charIndices.length) {
    const charTarget = randomChoice(charIndices);
    // If the previous note isn't already a step away, insert the approach
    const prevPos = seq[seq.length - 1];
    const dist = Math.min(
      Math.abs(prevPos - charTarget),
      Math.abs(prevPos - charTarget + n),
      Math.abs(prevPos - charTarget - n),
    );
    if (dist > 2) {
      // Insert a stepwise approach to the characteristic tone
      seq.push(neighborOf(charTarget));
    }
    seq.push(charTarget);
  } else {
    // No characteristic tones defined — just approach tonic
    seq.push(((0 - 1 + n) % n)); // degree below tonic
  }

  // ── [N] Always resolve to tonic ──
  seq.push(0);

  // Trim if we overshot the target length
  while (seq.length > phraseLen) {
    // Remove from the body, not the structural bookends
    const removeIdx = 2 + Math.floor(Math.random() * Math.max(1, seq.length - 4));
    if (removeIdx > 1 && removeIdx < seq.length - 2) seq.splice(removeIdx, 1);
    else break;
  }

  // ── Voice-leading: resolve each degree to closest octave of previous note ──
  const raw: number[] = [tonicAbs + (modeMap[degs[seq[0]]] ?? 0)];
  for (let i = 1; i < seq.length; i++) {
    const base = tonicAbs + (modeMap[degs[seq[i]]] ?? 0);
    let best = base, bestD = Math.abs(base - raw[i - 1]);
    for (let k = -4; k <= 4; k++) {
      const c = base + k * edo, d = Math.abs(c - raw[i - 1]);
      if (d < bestD) { bestD = d; best = c; }
    }
    raw.push(best);
  }

  const fitted = fitLineIntoWindow(raw, edo, low, high);
  return fitted.length ? { notes: fitted, degrees: seq.map(s => degs[s]) } : null;
}

function buildChordNotes(rootAbs: number, degLabels: string[], edo: number): number[] {
  const dm = getDegreeMap(edo);
  const notes: number[] = [];
  for (const d of degLabels) {
    const off = dm[d];
    if (off === undefined) continue;
    let note = rootAbs + off;
    while (note < rootAbs) note += edo;
    while (note > rootAbs + Math.round(2.5 * edo)) note -= edo;
    notes.push(note);
  }
  return [...new Set(notes)].sort((a, b) => a - b);
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

// ── Mode descriptions for post-answer feedback ───────────────────────

const MODE_DESCRIPTIONS: Record<string, string> = {
  "Ionian":             "The standard major scale. Bright and resolved, with a natural leading tone.",
  "Dorian":             "Minor with a raised 6th. Warm and jazzy, less dark than Aeolian.",
  "Phrygian":           "Minor with a lowered 2nd. Dark, Spanish/flamenco flavor.",
  "Lydian":             "Major with a raised 4th. Dreamy, floating, ethereal quality.",
  "Mixolydian":         "Major with a lowered 7th. Bluesy, rock, dominant sound.",
  "Aeolian":            "The natural minor scale. Sad, dark, the default minor sound.",
  "Locrian":            "Diminished tonic. Unstable, tense, rarely used as a standalone mode.",
  "Harmonic Minor":     "Natural minor with raised 7th. Exotic, classical minor with leading tone.",
  "Locrian #6":         "Locrian with a natural 6th. Slightly less dark than standard Locrian.",
  "Ionian #5":          "Major with an augmented 5th. Mysterious, shimmering quality.",
  "Dorian #4":          "Dorian with a raised 4th. Combines minor warmth with Lydian brightness.",
  "Phrygian Dominant":  "Phrygian with a major 3rd. Middle Eastern, flamenco, dramatic tension.",
  "Lydian #2":          "Lydian with an augmented 2nd. Exotic, wide intervals, bright and strange.",
  "Ultralocrian":       "The most diminished mode. Extremely unstable and dissonant.",
  "Melodic Minor":      "Minor with raised 6th and 7th. Smooth ascending minor, jazz minor.",
  "Dorian b2":          "Dorian with a lowered 2nd. Dark minor with Phrygian-like opening.",
  "Lydian Augmented":   "Lydian with augmented 5th. Bright, expansive, unresolved.",
  "Lydian Dominant":    "Lydian with a dominant 7th. Bright but bluesy, Bartok scale.",
  "Mixolydian b6":      "Mixolydian with a lowered 6th. Hindu scale, bittersweet dominant.",
  "Locrian #2":         "Locrian with a natural 2nd. Half-diminished, less harsh than Locrian.",
  "Altered":            "All non-essential tones altered. Maximum tension, jazz dominant resolution.",
};

// ── Component ─────────────────────────────────────────────────────────

export default function ModeIdentificationTab({
  tonicPc, lowestOct, highestOct, edo, onHighlight,
  onResult, onPlay, lastPlayed, ensureAudio, onAnswer, answerButtons,
}: Props) {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const [modePool, setModePool] = useLS<string>("lt_modeid_pool", "major");
  const [enabledModes, setEnabledModes] = useLS<Set<string>>("lt_modeid_enabled",
    new Set((FAMILY_MAP["major"] ?? ALL_MODES).map(m => m.name))
  );
  const [useCharChord, setUseCharChord] = useLS<boolean>("lt_modeid_charChord", true);
  const [chordGain, setChordGain] = useLS<number>("lt_modeid_chordGain", 0.45);
  const [chordDroneMode, setChordDroneMode] = useLS<string>("lt_modeid_droneMode", "through");
  const [maxNotes, setMaxNotes] = useLS<number>("lt_modeid_maxNotes", 8);
  const [checkedPatterns, setCheckedPatterns] = useLS<Set<string>>(
    "lt_modeid_patterns",
    new Set(["stepwise","arpeggio","jump","character_emphasis","mixed"]),
  );

  const [isPlaying, setIsPlaying] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [userAnswer, setUserAnswer] = useState<string | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);

  const curMode = useRef<ModeInfo | null>(null);
  const curDegrees = useRef<string[]>([]);
  const curChordNotes = useRef<number[] | null>(null);
  const curChordGain = useRef(0.45);
  const curUseChord = useRef(false);

  const stopTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; audioEngine.stopDrone(); };

  const highlightFrames = useCallback((frames: number[][]) => {
    frames.forEach((frame, i) => {
      const id = setTimeout(() => onHighlight(frame), i * GAP);
      timers.current.push(id);
    });
  }, [onHighlight]);

  const doPlay = useCallback((
    frames: number[][], withChord: boolean,
    chordNotes: number[] | null, gain: number,
    droneMode: string, showVisual: boolean,
  ) => {
    stopTimers();
    const phraseMs = frames.length * GAP;

    if (withChord && chordNotes?.length) {
      // Start characteristic chord as a sustained drone (scale gain by note count)
      audioEngine.startDrone(chordNotes, edo, gain / Math.sqrt(chordNotes.length));
      // Show chord notes on keyboard during lead-in
      if (showVisual) onHighlight(chordNotes);
      if (droneMode === "through") {
        // Drone sustains through the entire phrase
        const pid = setTimeout(() => {
          audioEngine.playSequence(frames, edo, GAP, 0.9);
          if (showVisual) highlightFrames(frames);
        }, CHORD_LEAD);
        timers.current.push(pid);
        const stopId = setTimeout(() => audioEngine.stopDrone(), CHORD_LEAD + phraseMs + 500);
        timers.current.push(stopId);
        const doneId = setTimeout(() => setIsPlaying(false), CHORD_LEAD + phraseMs + 500);
        timers.current.push(doneId);
      } else {
        // Intro only: drone plays, fades out, then phrase starts after a gap
        const FADE_MS = 800;
        const INTRO_DUR = CHORD_LEAD + 400;
        const fadeId = setTimeout(() => audioEngine.fadeDrone(FADE_MS), INTRO_DUR);
        timers.current.push(fadeId);
        const phraseStart = INTRO_DUR + 300;
        const pid = setTimeout(() => {
          audioEngine.playSequence(frames, edo, GAP, 0.9);
          if (showVisual) highlightFrames(frames);
        }, phraseStart);
        timers.current.push(pid);
        const doneId = setTimeout(() => setIsPlaying(false), phraseStart + phraseMs + 500);
        timers.current.push(doneId);
      }
    } else {
      audioEngine.playSequence(frames, edo, GAP, 0.9);
      if (showVisual) highlightFrames(frames);
      const doneId = setTimeout(() => setIsPlaying(false), phraseMs + 500);
      timers.current.push(doneId);
    }
  }, [edo, highlightFrames, onHighlight]);

  const play = async () => {
    if (isPlaying) return;
    await ensureAudio();

    const patternPool = PATTERN_LIST.map(p => p.key).filter(k => checkedPatterns.has(k));
    if (!patternPool.length) { onResult("Select at least one pattern type."); return; }

    const familyPool = FAMILY_MAP[modePool] ?? ALL_MODES;
    const pool = familyPool.filter(m => enabledModes.has(m.name));
    if (!pool.length) { onResult("Enable at least one mode in the pool."); return; }
    const mode = randomChoice(pool);
    const [low, high] = strictWindowBounds(tonicPc, edo, lowestOct, highestOct);
    const midAbs = tonicPc + (Math.floor((lowestOct + highestOct) / 2) - 4) * edo;
    const pattern = randomChoice(patternPool);

    const result = generatePhrase(mode, midAbs, edo, low, high, maxNotes, pattern);
    if (!result) { onResult("Could not fit phrase in register."); return; }

    const frames = result.notes.map(n => [n]);
    let chordNotes: number[] | null = null;
    if (useCharChord) {
      const opt = randomChoice(mode.chordOptions);
      const rootAbs = tonicPc + (Math.max(lowestOct, 3) - 4) * edo;
      chordNotes = buildChordNotes(rootAbs, opt, edo);
    }

    curMode.current = mode;
    curDegrees.current = result.degrees;
    curChordNotes.current = chordNotes;
    curChordGain.current = chordGain;
    curUseChord.current = useCharChord;
    lastPlayed.current = { frames, info: mode.displayName };
    setHasPlayed(true);

    setUserAnswer(null);
    setShowAnswer(false);
    setIsPlaying(true);

    onPlay(`modeId:${mode.family}:${mode.name}`, `Mode ID: ${mode.displayName}`);
    onResult("Mode Identification — listening…");

    doPlay(frames, useCharChord, chordNotes, chordGain, chordDroneMode, false);
  };

  const replay = () => {
    const lp = lastPlayed.current;
    if (!lp || isPlaying) return;
    setIsPlaying(true);
    doPlay(
      lp.frames,
      curUseChord.current,
      curChordNotes.current,
      curChordGain.current,
      chordDroneMode,
      false,
    );
  };

  const togglePattern = (key: string) => setCheckedPatterns(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const displayPool = FAMILY_MAP[modePool] ?? ALL_MODES;

  const toggleMode = (name: string) => {
    setEnabledModes(prev => {
      const next = new Set(prev);
      if (next.has(name)) { if (next.size > 1) next.delete(name); }
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {/* Options row */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-xs text-[#888] block mb-1">Mode family</label>
          <select value={modePool} onChange={e => {
            const val = e.target.value;
            setModePool(val);
            // Auto-enable all modes in the new family
            const family = FAMILY_MAP[val] ?? ALL_MODES;
            setEnabledModes(new Set(family.map(m => m.name)));
          }}
            className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            <option value="major">Major modes (7)</option>
            <option value="harmonic">Harmonic minor (7)</option>
            <option value="melodic">Melodic minor (7)</option>
            <option value="all">All modes (21)</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-[#888] block mb-1">Max notes</label>
          <select value={maxNotes} onChange={e => setMaxNotes(Number(e.target.value))}
            className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            {NOTE_COUNTS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <label className={`flex items-center gap-2 px-3 py-2 rounded text-sm cursor-pointer transition-colors border ${
          useCharChord
            ? "bg-[#1a1a2a] text-[#9999ee] border-[#555]"
            : "bg-[#141414] text-[#666] border-[#2a2a2a] hover:border-[#444]"
        }`}>
          <input type="checkbox" checked={useCharChord} onChange={e => setUseCharChord(e.target.checked)}
            className="accent-[#7173e6]" />
          Use characteristic chord
        </label>
        {useCharChord && (
          <>
            <div className="flex items-center gap-2">
              <label className="text-xs text-[#666]">Chord vol</label>
              <input type="range" min={0.1} max={0.8} step={0.05} value={chordGain}
                onChange={e => setChordGain(Number(e.target.value))}
                className="w-20 accent-[#7173e6]" />
              <span className="text-xs text-[#555] w-7">{Math.round(chordGain / 0.8 * 100)}%</span>
            </div>
            <div>
              <label className="text-xs text-[#888] block mb-1">Drone</label>
              <select value={chordDroneMode} onChange={e => setChordDroneMode(e.target.value)}
                className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
                <option value="intro">Intro only</option>
                <option value="through">Sustain through</option>
              </select>
            </div>
          </>
        )}
      </div>

      {/* Pool display — click to toggle which modes are enabled */}
      <div>
        <div className="flex items-center gap-3 mb-1.5">
          <p className="text-xs text-[#555]">Mode pool:</p>
          <button onClick={() => setEnabledModes(new Set(displayPool.map(m => m.name)))}
            className="text-[10px] text-[#555] hover:text-[#aaa]">All</button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {displayPool.map(mode => {
            const isEnabled = enabledModes.has(mode.name);
            const isAnswer = showAnswer && curMode.current?.name === mode.name;
            return (
              <button
                key={mode.name}
                onClick={() => toggleMode(mode.name)}
                className={`px-3 py-1.5 rounded text-sm font-medium border transition-colors cursor-pointer ${
                  isAnswer
                    ? "bg-[#1a3a1a] border-[#3a6a3a] text-[#5cca5c]"
                    : isEnabled
                      ? "bg-[#1a1a2a] border-[#555] text-[#9999ee]"
                      : "bg-[#141414] border-[#2a2a2a] text-[#444]"
                }`}
              >
                {mode.displayName}
              </button>
            );
          })}
        </div>
      </div>

      {/* Answer reveal — shown after clicking Show Answer */}
      {showAnswer && curMode.current && (
        <div className="space-y-2">
          <div className="rounded p-3 text-sm border font-medium bg-[#1a1a2a] border-[#444] text-[#9999ee]">
            {curMode.current.displayName}
            <span className="ml-2 text-xs opacity-60 font-normal">
              ({curMode.current.family.replace(" Family","")})
            </span>
          </div>
          {/* Degrees played in order */}
          {curDegrees.current.length > 0 && (
            <div className="flex gap-1 items-center flex-wrap">
              <span className="text-[#666] text-xs mr-1">Degrees played:</span>
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
          {/* Scale degrees, characteristic tones, description */}
          <div className="rounded p-3 text-sm border border-[#333] bg-[#161616] space-y-2">
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
            <div className="text-xs text-[#666]">
              Family: <span className="text-[#999]">{curMode.current.family}</span>
              {curMode.current.stable.length > 0 && (
                <span className="ml-3">Stable: <span className="text-[#999]">{curMode.current.stable.join(", ")}</span></span>
              )}
            </div>
            <div className="text-xs text-[#888] italic">
              {MODE_DESCRIPTIONS[curMode.current.name] ?? ""}
            </div>
          </div>
        </div>
      )}

      {/* Pattern type checkboxes */}
      <div>
        <p className="text-xs text-[#555] mb-2">Pattern types:</p>
        <div className="flex flex-wrap gap-1.5">
          {PATTERN_LIST.map(({ key, label }) => (
            <label key={key} className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm cursor-pointer transition-colors border ${
              checkedPatterns.has(key)
                ? "bg-[#1a1a2a] text-[#9999ee] border-[#444]"
                : "bg-[#141414] text-[#666] border-[#2a2a2a] hover:border-[#444]"
            }`}>
              <input type="checkbox" checked={checkedPatterns.has(key)} onChange={() => togglePattern(key)}
                className="accent-[#7173e6]" />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={play} disabled={isPlaying}
          className="bg-[#7173e6] hover:bg-[#5a5cc8] disabled:opacity-50 text-white px-5 py-2 rounded text-sm font-medium transition-colors">
          {isPlaying ? "♪ Playing…" : "▶ Play Phrase"}
        </button>
        {hasPlayed && (
          <button onClick={replay} disabled={isPlaying}
            className="bg-[#1e1e1e] hover:bg-[#2a2a2a] disabled:opacity-50 border border-[#333] text-[#aaa] px-4 py-2 rounded text-sm transition-colors">
            Replay
          </button>
        )}
        {hasPlayed && !showAnswer && (
          <button onClick={() => {
            setShowAnswer(true);
            // Replay with visualization — chord notes shown first, then phrase
            const lp = lastPlayed.current;
            if (lp && !isPlaying) {
              setIsPlaying(true);
              doPlay(
                lp.frames,
                curUseChord.current,
                curChordNotes.current,
                curChordGain.current,
                chordDroneMode,
                true,
              );
            } else if (curMode.current) {
              // No replay possible, just show scale
              onHighlight(getScalePitches(curMode.current, tonicPc, edo, lowestOct, highestOct));
            }
          }}
            className="bg-[#1e1e1e] hover:bg-[#2a2a2a] border border-[#444] text-[#9999ee] px-4 py-2 rounded text-sm transition-colors">
            Show Answer
          </button>
        )}
        {answerButtons}
      </div>
    </div>
  );
}
