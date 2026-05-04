import { useState, useRef, useCallback } from "react";
import { audioEngine } from "@/lib/audioEngine";
import {
  fitLineIntoWindow, strictWindowBounds, randomChoice,
  getModeDegreeMap, getDegreeMap, PATTERN_SCALE_FAMILIES,
} from "@/lib/musicTheory";
import { useLS } from "@/lib/storage";
import { recordAnswer } from "@/lib/stats";
import { JI_FAMILY, JI_SCALE_NAMES, getJiScaleDegrees, getJiScaleCents } from "@/lib/jiScaleData";
import { jiLimitGroupsForEdo, limitForJiTonality } from "@/lib/jiTonalityFamilies";
import JiScaleLattice from "@/components/JiScaleLattice";
import { analyzeJiScale } from "@/lib/jiChordAnalysis";

interface Props {
  tonicPc: number;
  lowestPitch: number;
  highestPitch: number;
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
  "Ultralocrian":      { name: "dim7(♭9,11,♭13)",  degrees: ["1","b3","b5","bb7","b9","11","b13"] },
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
//
// In meantone EDOs (19, 31, 41) some modes (notably Altered) have scale
// degrees whose family-map step doesn't match the global getDegreeMap —
// e.g. Altered's "3" is enharmonically a "b4" and sits at a different step
// in 31-EDO than getDegreeMap's "3".  When a modeMap is supplied we prefer
// it so the characteristic chord lands on the same notes the scale plays.
function resolveStep(d: string, edo: number, modeMap?: Record<string, number>): number {
  if (modeMap && modeMap[d] !== undefined) return modeMap[d];
  const map = getDegreeMap(edo);
  if (map[d] !== undefined) return map[d];
  const fallback: Record<string, string> = {
    "11":  "4",  "#11": "#4", "b11": "b4",
    "13":  "6",  "b13": "b6", "#13": "#6",
  };
  const alt = fallback[d];
  if (alt) {
    if (modeMap && modeMap[alt] !== undefined) return modeMap[alt];
    if (map[alt] !== undefined) return map[alt];
  }
  return 0;
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
    // Proper 31-EDO Ultralocrian: pos 4 = step 11 (b4), pos 7 = step 24
    // (bb7).  Existing data labelled these as "3" / "6" (12-EDO
    // enharmonic shorthand for m3 / m7), which in 31-EDO sit at
    // different pitches.
    name: "Ultralocrian", family: "Harmonic Minor Family", displayName: "Superlocrian ♭♭7",
    scaleDegrees: ["1","b2","b3","b4","b5","b6","bb7"],
    character: ["b2","b3","b4","b5","b6","bb7"], stable: ["1"],
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
  // ── Septimal / neutral diatonic families (31-EDO) ───────────────────
  // Each family has 7 modes — mode 1 is the canonical parent and modes
  // 2-7 are mechanical rotations.  Names are numerical because the
  // rotations don't correspond to standard Greek-mode shapes (the
  // sub/neu/sup alterations don't survive rotation).  All scale-degree
  // labels come from the rotation maps in PATTERN_SCALE_MAPS_31.
  ...buildXenRotationInfos(),
  // ── JI scales (Pythagorean / Schismatic — 41-EDO + 53-EDO) ──────────
  // 19 scales registered as "JI Family" by jiScaleData.ts.  Character
  // tones are inferred from accidentals in the degree spelling; chord
  // option uses the first four scale degrees as a 7th-chord stand-in.
  // Same scales work for both EDOs since getModeDegreeMap routes through
  // the EDO-specific pattern maps.
  ...buildJiInfos(),
];

function buildJiInfos(): ModeInfo[] {
  return JI_SCALE_NAMES.map(name => {
    const degs = getJiScaleDegrees(name) ?? ["1"];
    const isStandard = (d: string) => /^[1-7]$/.test(d);
    const character = degs.filter(d => !isStandard(d) && d !== "1");
    const has5 = degs.includes("5");
    return {
      name,
      family: JI_FAMILY,
      displayName: name,
      scaleDegrees: degs,
      character: character.length ? character : [degs[2] ?? "b3"],
      stable: has5 ? ["1", "5"] : ["1"],
      chordOptions: [{ name, degrees: degs.slice(0, 4) }],
    };
  });
}

function buildXenRotationInfos(): ModeInfo[] {
  const families = [
    "Subminor Diatonic Family",
    "Neutral Diatonic Family",
    "Supermajor Diatonic Family",
    "Subharmonic Diatonic Family",
  ];
  const out: ModeInfo[] = [];
  for (const family of families) {
    const modeNames = PATTERN_SCALE_FAMILIES[family] ?? [];
    for (const modeName of modeNames) {
      const map = getModeDegreeMap(31, family, modeName);
      const sorted = Object.entries(map).sort((a, b) => a[1] - b[1]);
      const scaleDegrees = sorted.map(([k]) => k);
      // Character = any non-standard degree (sub/neu/sup, or #/bb prefix)
      const isStandard = (d: string) => /^[1-7]$|^b[1-7]$/.test(d);
      const character = scaleDegrees.filter(d => !isStandard(d) && d !== "1");
      const has5 = scaleDegrees.includes("5");
      out.push({
        name: modeName,
        family,
        displayName: modeName,
        scaleDegrees,
        character: character.length ? character : [scaleDegrees[2] ?? "1"],
        stable: has5 ? ["1","5"] : ["1"],
        chordOptions: [{ name: modeName, degrees: scaleDegrees.slice(0, 4) }],
      });
    }
  }
  return out;
}

const FAMILY_MAP: Record<string, ModeInfo[]> = {
  major:    ALL_MODES.filter(m => m.family === "Major Family"),
  harmonic: ALL_MODES.filter(m => m.family === "Harmonic Minor Family"),
  melodic:  ALL_MODES.filter(m => m.family === "Melodic Minor Family"),
  subminor: ALL_MODES.filter(m => m.family === "Subminor Diatonic Family"),
  neutral:  ALL_MODES.filter(m => m.family === "Neutral Diatonic Family"),
  supermajor: ALL_MODES.filter(m => m.family === "Supermajor Diatonic Family"),
  subharmonic: ALL_MODES.filter(m => m.family === "Subharmonic Diatonic Family"),
  ji:       ALL_MODES.filter(m => m.family === JI_FAMILY),
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

// Diagnostic priority order for a mode, highest → lowest:
//   1. character tones (colors) — the alterations that *define* the mode
//   2. 3rd — major / minor quality
//   3. 5th — present in most diatonic modes; secondary stability
//   4. 4th (or whatever the mode's 4th-degree label is) — last
// If a mode happens to put a 4th or 5th *into* its character set
// (e.g. Lydian's #4, Locrian's b5), that note enters the priority
// list at level 1 instead of level 3/4 — handled automatically by
// the dedup in `getDiagnosticPriority`.
function getDiagnosticPriority(mode: ModeInfo): string[] {
  const third = getThird(mode);
  const out: string[] = [];
  // Level 1 — colors (shuffled so different runs feature different ones first).
  for (const c of [...mode.character].sort(() => Math.random() - 0.5)) {
    if (!out.includes(c)) out.push(c);
  }
  // Level 2 — 3rd.
  if (!out.includes(third)) out.push(third);
  // Level 3 — 5th, only if the mode actually has one.
  if (mode.scaleDegrees.includes("5") && !out.includes("5")) out.push("5");
  // Level 4 — 4th-position degree (could be "4", "#4", "b5" depending on mode).
  const fourth = mode.scaleDegrees[3];
  if (fourth && fourth !== "1" && !out.includes(fourth)) out.push(fourth);
  return out;
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
  const innerSlots = Math.max(0, target - 2);
  // mustHit follows the priority order (colors first, then 3rd, then
  // 5th, then 4th).  When phraseLen is short (innerSlots < |colors|+1),
  // the 3rd may not fit; in that case we force it as the start so the
  // listener always hears the mode's quality.
  const mustHit = getDiagnosticPriority(mode).slice(0, innerSlots);
  const has3rd = mustHit.includes(third);
  // If the 3rd didn't fit in mustHit, force it as the start.  Either
  // way the 3rd is placed exactly once (via mustHit or via start);
  // fill and end never reintroduce it.
  const start = has3rd ? randomChoice(anchors.filter(a => a !== third)) || randomChoice(anchors) : third;
  // End picks from anchors excluding the 3rd so it can't double up
  // there either.
  const endAnchors = anchors.filter(a => a !== third);
  const end = endAnchors.length ? randomChoice(endAnchors) : randomChoice(anchors);
  const seq: string[] = [start, ...mustHit];
  const fillCount = Math.max(0, target - 1 - seq.length);
  const colorPool = colors.length <= 2 ? [...colors, ...extras] : colors;
  // Fill anchor pool excludes the 3rd — it's already placed exactly
  // once.  No repeats of the 3rd anywhere in the phrase.
  const fillAnchors = anchors.filter(a => a !== third);
  for (let i = 0; i < fillCount; i++) {
    const prev = seq[seq.length - 1];
    const r = Math.random();
    // 75% colors, 25% other anchors.  The 3rd is intentionally absent
    // from the fill pool — it sits exactly once in the phrase.
    if (r < 0.75 || fillAnchors.length === 0)  seq.push(pickAvoiding(colorPool, prev));
    else                                        seq.push(pickAvoiding(fillAnchors, prev));
  }
  seq.push(end);
  return voiceLeadSeq(seq, mode, tonicAbs, edo, low, high);
};

// Archetype C — chord-tone spine with colors woven in.
// Root excluded; line alternates between the mode's basic 4-note chord tones
// (3rd / 5th / 7th — slice avoids the upper extensions, which would just be
// the rest of the scale and turn the spine into the whole mode) and color tones.
const archetypeSpine: ArchetypeFn = (mode, tonicAbs, edo, low, high, phraseLen) => {
  const third = getThird(mode);
  const chord = mode.chordOptions[0]?.degrees ?? ["1","3","5","b7"];
  const spine = chord.slice(1, 4);
  if (!spine.length) return null;
  const colors = getColorsMinusThird(mode);
  const extras = getMelodicExtras(mode);

  // Spine excluding the 3rd — used in fill so the 3rd never repeats.
  const spineNoThird = [...spine.filter(d => d !== third)].sort(() => Math.random() - 0.5);
  const colorPool = (colors.length <= 2 ? [...colors, ...extras] : [...colors])
    .sort(() => Math.random() - 0.5);
  // Honour phraseLen strictly — never exceed the user's Max-notes budget.
  const target = Math.max(1, phraseLen);
  const seq: string[] = [];
  // Lead with the 3rd so the listener hears the diagnostic tone
  // immediately, regardless of phrase length.  3rd is placed exactly
  // once here; fill never re-emits it.
  if (target >= 1) seq.push(third);
  let si = 0, ci = 0;
  while (seq.length < target) {
    const prev: string | undefined = seq.length > 0 ? seq[seq.length - 1] : undefined;
    // 70% colors, 30% other spine notes (5th / 7th).  Colors are the
    // top priority per the diagnostic order; spine fills weak slots.
    if (Math.random() < 0.3 && spineNoThird.length > 0) {
      let pick = spineNoThird[si++ % spineNoThird.length];
      if (pick === prev && spineNoThird.length > 1) pick = spineNoThird[si++ % spineNoThird.length];
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
  const innerSlots = Math.max(0, target - 2);
  // mustHit follows priority order (colors > 3rd > 5th > 4th); the
  // final-landing color is reserved separately so we filter it out
  // here to avoid duplicating it in the inner.
  const priorityFiltered = getDiagnosticPriority(mode).filter(d => d !== finalColor);
  const mustHit = priorityFiltered.slice(0, innerSlots);
  const has3rd = mustHit.includes(third);
  // Force-start with 3rd when it didn't fit into mustHit; otherwise
  // pick a random non-3rd stable so the 3rd doesn't double-up.
  const stableNoThird = stable.filter(d => d !== third);
  const start = has3rd
    ? (stableNoThird.length ? randomChoice(stableNoThird) : randomChoice(stable))
    : third;
  const seq: string[] = [start, ...mustHit];
  const fillCount = Math.max(0, target - 1 - seq.length);
  const colorPool = colors.length <= 2 ? [...colors, ...extras] : colors;
  for (let i = 0; i < fillCount; i++) {
    const prev = seq[seq.length - 1];
    const r = Math.random();
    // 75% colors, 25% other stable.  3rd intentionally absent — it's
    // already placed exactly once via mustHit or start.
    if (r < 0.75 || stableNoThird.length === 0)  seq.push(pickAvoiding(colorPool, prev));
    else                                          seq.push(pickAvoiding(stableNoThird, prev));
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
// Mode-phrase patterns merge the old "Color Set" exercise with five
// degree-cycle traversals.  Every pattern hits all 7 scale degrees
// (except color-set, which is melodic and biased to character tones),
// using free voice-leading that inverts each note to stay inside the
// register window — so even a 1-octave window plays cleanly.
type ScalePattern =
  | "color-set"
  | "thirds"
  | "fourths"
  | "fifths"
  | "sixths"
  | "shuffle";
const SCALE_PATTERNS: ScalePattern[] = ["color-set", "thirds", "fourths", "fifths", "sixths", "shuffle"];

export const SCALE_PATTERN_LABEL: Record<ScalePattern, string> = {
  "color-set":   "Color Set",
  "thirds":      "Scale 3rds",
  "fourths":     "Scale 4ths",
  "fifths":      "Scale 5ths",
  "sixths":      "Scale 6ths",
  "shuffle":     "Scale Shuffled",
};

function generateScale(
  mode: ModeInfo, tonicAbs: number, edo: number, low: number, high: number,
  allowedPatterns: ScalePattern[] = SCALE_PATTERNS,
  maxNotes: number = Infinity,
): { notes: number[]; degrees: string[]; pattern: ScalePattern } | null {
  const modeMap = getModeDegreeMap(edo, mode.family, mode.name);
  const n = mode.scaleDegrees.length;
  const asc = Array.from({ length: n }, (_, i) => i);
  // color-set is dispatched separately by the caller — strip it here
  // so generateScale only handles degree-cycle patterns.
  const scalePool = (allowedPatterns.length ? allowedPatterns : SCALE_PATTERNS)
    .filter(p => p !== "color-set");
  const pool = scalePool.length > 0 ? scalePool : SCALE_PATTERNS.filter(p => p !== "color-set");

  // Try the user's chosen pattern first; fall back through the rest of
  // the enabled patterns so a narrow register doesn't drop the round.
  // Shuffle is appended last as a guaranteed fallback — its voice-leading
  // bounds the spread to ~1 octave so it always fits.
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
  // Degree-index traversal for each pattern.  Walks the diatonic degree
  // wheel by a fixed step size:
  //   thirds  → +2 mod n
  //   fourths → +3 mod n
  //   fifths  → +4 mod n
  //   sixths  → +5 mod n
  //   shuffle → random permutation
  // Non-shuffle patterns pick a random start degree (so the line doesn't
  // always begin on the tonic) and coin-flip the direction (forward vs
  // reverse).  Voice-leading inverts each note so the line stays in
  // the register window.
  let idxSeq: number[];
  if (pattern === "shuffle") {
    idxSeq = [...asc].sort(() => Math.random() - 0.5);
  } else {
    const stepSize =
      pattern === "thirds"  ? 2 :
      pattern === "fourths" ? 3 :
      pattern === "fifths"  ? 4 :
      pattern === "sixths"  ? 5 : 1;
    const startIdx = Math.floor(Math.random() * n);
    idxSeq = [];
    const seen = new Set<number>();
    for (let k = 0; k < n; k++) {
      const idx = ((startIdx + k * stepSize) % n + n) % n;
      if (seen.has(idx)) break;
      seen.add(idx);
      idxSeq.push(idx);
    }
    if (Math.random() < 0.5) idxSeq = idxSeq.slice().reverse();
  }
  const octPos: "start" | "end" | null = null;

  // Honour the Max-notes setting: truncate the traversal so the phrase
  // stays at most maxNotes long.
  if (Number.isFinite(maxNotes) && maxNotes > 0) {
    const slots = Math.max(1, Math.floor(maxNotes));
    if (slots < idxSeq.length) idxSeq = idxSeq.slice(0, slots);
  }

  const degrees = idxSeq.map(i => mode.scaleDegrees[i]);

  // All non-color-set patterns use free voice-leading with in-window
  // preference: each note picks the octave that stays inside [low, high]
  // AND closest to the previous note.  This is what gives "Scale 4ths"
  // its inverted-within-an-octave shape (C → F → B → E → A → D → G).
  const direction = "free";

  const notes: number[] = [];
  void direction; // patterns are uniformly free-voice-leading now
  for (let i = 0; i < degrees.length; i++) {
    const isOct = (octPos === "end"   && i === degrees.length - 1)
               || (octPos === "start" && i === 0);
    const step = isOct ? edo : (modeMap[degrees[i]] ?? 0);
    const base = tonicAbs + step;
    if (i === 0) { notes.push(base); continue; }
    const prev = notes[i - 1];
    // Free voice-leading: prefer the octave that keeps the note inside
    // [low, high] AND stays close to the previous note.  This is what
    // gives "Scale 4ths" its inverted-within-an-octave shape (C → F →
    // B → E → A → D → G).  Falls back to nearest-overall when no
    // in-window candidate exists.
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

// Characteristic-chord builder: plays the mode's full tonic 13th chord —
// lower structure 1-3-5-7 + upper structure 9-11-13, with each degree's
// alteration baked in by the mode (e.g. Aeolian = 1, b3, 5, b7, 9, 11, b13).
// All seven degrees stack ascending from tonicAbs so the listener actually
// hears every tension named in the chord symbol.  Earlier this was a 1-3-7
// shell + character-tones-only upper, which made chords like "m7(9,11,♭13)"
// drop the 9 and 11 entirely — the symbol claimed extensions the voicing
// never played.  The stack is allowed to run past the top of the register.
function generateChord(
  mode: ModeInfo, tonicAbs: number, edo: number, _low: number, _high: number,
): { notes: number[]; chordName: string; degrees: string[] } | null {
  void _low; void _high;
  if (!mode.chordOptions.length) return null;
  const pick = mode.chordOptions[0];

  const modeMap = getModeDegreeMap(edo, mode.family, mode.name);
  // Drop the natural P5 — it's redundant in dense voicings (the ear
  // hears it from the harmonic series of the root) and dropping it
  // makes room for the upper tensions to speak.  Altered fifths
  // (b5 in Locrian/Altered, #5 in Lydian Aug / Ionian #5) ARE chord-
  // defining and stay in the voicing.
  const playedDegrees = pick.degrees.filter(d => d !== "5");
  const notes: number[] = [tonicAbs];
  for (let i = 1; i < playedDegrees.length; i++) {
    let n = tonicAbs + resolveStep(playedDegrees[i], edo, modeMap);
    while (n <= notes[notes.length - 1]) n += edo;
    notes.push(n);
  }

  return {
    notes,
    chordName: pick.name,
    degrees: playedDegrees,
  };
}

// ── Scale highlight helper ────────────────────────────────────────────

function getScalePitches(
  mode: ModeInfo, tonicPc: number, edo: number,
  lowestPitch: number, highestPitch: number,
): number[] {
  const modeMap = getModeDegreeMap(edo, mode.family, mode.name);
  const pitches: number[] = [];
  for (const deg of mode.scaleDegrees) {
    const offset = modeMap[deg] ?? 0;
    // Walk every (tonicPc + offset + k*edo) across octaves k and keep
    // the ones in [lowestPitch, highestPitch].
    let abs = tonicPc + offset;
    while (abs < lowestPitch) abs += edo;
    while (abs - edo >= lowestPitch) abs -= edo;
    for (; abs <= highestPitch; abs += edo) pitches.push(abs);
  }
  return pitches;
}

// ── Component ─────────────────────────────────────────────────────────

export default function ModeIdentificationTab({
  tonicPc, lowestPitch, highestPitch, edo, onHighlight,
  onResult, onPlay, lastPlayed, ensureAudio, onAnswer, answerButtons,
}: Props) {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const [enabledModes, setEnabledModes] = useLS<Set<string>>("lt_modeid_enabled_v2",
    new Set(ALL_MODES.map(m => m.name))
  );
  const [maxNotes, setMaxNotes] = useLS<number>("lt_modeid_maxNotes", 8);
  const [noteSec, setNoteSec] = useLS<number>("lt_modeid_noteSec", DEFAULT_GAP / 1000);
  // Mode Phrase patterns — Color Set + 5 degree-cycle traversals are
  // independent toggles, plus Characteristic Chord (different exercise
  // type, kept separate).  Each round picks one enabled item at random.
  const [enabledPatterns, setEnabledPatterns] = useLS<Set<ScalePattern>>(
    "lt_modeid_phrase_patterns_v3", new Set<ScalePattern>(SCALE_PATTERNS),
  );
  const [chordEnabled, setChordEnabled] = useLS<boolean>("lt_modeid_chord_enabled_v3", true);

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

    // Pick randomly among the enabled patterns.  Chord is appended as a
    // pseudo-pattern so the merge-into-one-row UI works.
    type Picked = ScalePattern | "chord";
    const choices: Picked[] = [...enabledPatterns];
    if (chordEnabled) choices.push("chord");
    if (!choices.length) { onResult("Enable at least one pattern."); return; }
    const picked: Picked = randomChoice(choices);
    const kind: "colors" | "chord" | "scale" =
      picked === "chord" ? "chord" :
      picked === "color-set" ? "colors" : "scale";

    const mode = randomChoice(pool);
    const [low, high] = strictWindowBounds(lowestPitch, highestPitch);
    // Tonic-aligned anchor closest to the mid-pitch of the user's range.
    const midPitchRaw = Math.floor((lowestPitch + highestPitch) / 2);
    const midAbs = midPitchRaw - (((midPitchRaw - tonicPc) % edo + edo) % edo);

    let frames: number[][];
    let gapMs: number;
    let degrees: string[];
    let chordInfo: { name: string; degrees: string[] } | null = null;
    let pattern: ScalePattern | null = null;

    // Strict window for any horizontal phrase (Color Set + Scale): the
    // phrase is bounded by tonic-aligned pitches inside the user's range.
    // Characteristic Chord uses the wider raw bounds since it's a vertical
    // sonority.
    const firstTonic = lowestPitch + (((tonicPc - lowestPitch) % edo) + edo) % edo;
    const tightLow = firstTonic <= highestPitch ? firstTonic : lowestPitch;
    const tightHigh = firstTonic <= highestPitch
      ? firstTonic + edo * Math.floor((highestPitch - firstTonic) / edo)
      : highestPitch;

    if (picked === "color-set") {
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
      pattern = "color-set";
    } else if (picked === "chord") {
      const built = generateChord(mode, midAbs, edo, low, high);
      if (!built) { onResult("Mode has no chord options."); return; }
      frames = [built.notes];
      gapMs = 2000; // single chord ringing; sustain ≈ 2.25s
      degrees = built.degrees;
      chordInfo = { name: built.chordName, degrees: built.degrees };
    } else {
      // picked is one of the scale patterns.  Pass a single-pattern pool
      // so the user gets exactly what they enabled.
      const built = generateScale(mode, midAbs, edo, tightLow, tightHigh, [picked], maxNotes);
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

  // Family groups switch per EDO: 41/53 (Pythagorean / Schismatic) show
  // the JI scales grouped by limit (3 / 5 / 7 / 11); other EDOs show the
  // standard meantone-flavoured trio of Major / Harmonic Minor / Melodic.
  const FAMILY_GROUPS: { key: string; label: string; color: string; modes: ModeInfo[] }[] =
    (edo === 41 || edo === 53)
      ? jiLimitGroupsForEdo(edo).map(g => ({
          key: `limit-${g.limit}`,
          label: g.label,
          color: g.color,
          modes: g.families
            .flatMap(f => f.tonalities)
            .map(t => ALL_MODES.find(m => m.name === t))
            .filter((m): m is ModeInfo => !!m),
        }))
      : [
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
        {/* Pattern toggles — single merged row.  Each round picks one
            enabled pattern at random.  Color Set runs the archetype
            phrase generator; the four "Scale Nths" patterns walk the
            diatonic degree wheel by N (3rds = +2, 4ths = +3 mod 7,
            etc.) with free voice-leading so the phrase stays inside
            the register.  Scale Shuffled is a random permutation.
            Characteristic Chord is a vertical sonority. */}
        <div>
          <label className="text-xs text-[#888] block mb-1">Patterns</label>
          <div className="flex gap-1 flex-wrap">
            {SCALE_PATTERNS.map(p => {
              const on = enabledPatterns.has(p);
              const color = p === "color-set" ? "#7173e6" : "#5cca8a";
              return (
                <button key={p}
                  onClick={() => setEnabledPatterns(prev => {
                    const next = new Set(prev);
                    if (next.has(p)) {
                      // At least one phrase pattern OR chord must stay on.
                      if (next.size > 1 || chordEnabled) next.delete(p);
                    } else next.add(p);
                    return next;
                  })}
                  className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                    on ? "" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                  }`}
                  style={on ? { backgroundColor: color + "30", borderColor: color, color } : undefined}>
                  {SCALE_PATTERN_LABEL[p]}
                </button>
              );
            })}
            <button
              onClick={() => {
                if (chordEnabled && enabledPatterns.size === 0) return;
                setChordEnabled(!chordEnabled);
              }}
              className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                chordEnabled ? "" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
              }`}
              style={chordEnabled ? { backgroundColor: "#a06cc830", borderColor: "#a06cc8", color: "#a06cc8" } : undefined}>
              Characteristic Chord
            </button>
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
          </div>

          {/* JI Show Answer extras — chord-analysis box above, lattice
              viewer below.  Both render only for JI-family scales, both
              sized at the same fixed max-width (480 px) so they stack
              cleanly as a matched pair. */}
          {curMode.current.family === JI_FAMILY && (() => {
            const cents = getJiScaleCents(curMode.current.name);
            const degs = getJiScaleDegrees(curMode.current.name);
            const analysis = analyzeJiScale(curMode.current.name);
            if (!cents || !degs) return null;
            const tones = degs.map((degree, i) => ({ degree, cents: cents[i] }));
            const limit = limitForJiTonality(curMode.current.name);
            const ROMAN = ["I","II","III","IV","V","VI","VII"];
            const tagColor = (k: string) => {
              if (k === "wolf") return "#cc6a8a";
              if (k === "off-grid") return "#c8aa50";
              if (k === "pure-3") return "#9999cc";
              if (k === "pure-5") return "#6acca0";
              if (k === "pure-7") return "#cc8855";
              if (k === "pure-11") return "#9a66c0";
              return "#888";
            };
            return (
              <div className="space-y-2">
                {/* Chord analysis — same shape as the floating panel in
                    ChordsTab so the user sees identical info in both
                    places.  Tonic-relative triads with each chord's
                    third / fifth classified as pure / wolf. */}
                {analysis && (
                  <div className="bg-[#0a0a0a] border border-[#5b5be6] rounded p-3" style={{ maxWidth: 480 }}>
                    <p className="text-[10px] text-[#5b5be6] font-bold tracking-wider mb-2">
                      CHORD ANALYSIS · {curMode.current.displayName}
                    </p>
                    <div className="grid grid-cols-[28px_1fr_1fr_60px] gap-x-2 gap-y-1 text-[10px]">
                      <span className="text-[#555] font-medium">Ch</span>
                      <span className="text-[#555] font-medium">Third</span>
                      <span className="text-[#555] font-medium">Fifth</span>
                      <span className="text-[#555] font-medium">Status</span>
                      {analysis.map((row, i) => (
                        <span key={i} style={{ display: "contents" }}>
                          <span className="text-[#aaa] font-mono">{ROMAN[i]}</span>
                          <span style={{ color: tagColor(row.third.kind) }}>
                            {row.third.ratio}
                          </span>
                          <span style={{ color: tagColor(row.fifth.kind) }}>
                            {row.fifth.ratio}
                          </span>
                          <span style={{ color: row.pure ? "#5cca5c" : "#cc6a8a", fontWeight: 600 }}>
                            {row.pure ? "✓" : "✗ Wolf"}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {/* Lattice projection — same fixed width (480 px) so the
                    two boxes stack as a matched pair. */}
                <div className="bg-[#0a0a0a] border border-[#5cca8a] rounded p-3" style={{ maxWidth: 480 }}>
                  <p className="text-[10px] text-[#5cca8a] font-bold tracking-wider mb-2">
                    5-LIMIT LATTICE PROJECTION{limit ? ` · ${limit}-limit scale` : ""}
                  </p>
                  <JiScaleLattice tones={tones} accent="#5cca8a" compact />
                </div>
              </div>
            );
          })()}
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
        <button onClick={replay} disabled={isPlaying || !hasPlayed}
          className="bg-[#1e1e1e] hover:bg-[#2a2a2a] disabled:opacity-50 border border-[#333] text-[#aaa] px-4 py-2 rounded text-sm transition-colors">
          Replay
        </button>
        <button onClick={() => {
          setShowAnswer(true);
          const lp = lastPlayed.current;
          const mode = curMode.current;
          if (lp && !isPlaying) {
            setIsPlaying(true);
            doPlay(lp.frames, curGapMs.current, true);
            if (mode) {
              const tailId = setTimeout(
                () => onHighlight(getScalePitches(mode, tonicPc, edo, lowestPitch, highestPitch)),
                lp.frames.length * curGapMs.current + 200,
              );
              timers.current.push(tailId);
            }
          } else if (mode) {
            onHighlight(getScalePitches(mode, tonicPc, edo, lowestPitch, highestPitch));
          }
        }}
          disabled={isPlaying || !hasPlayed}
          className="bg-[#1e1e1e] hover:bg-[#2a2a2a] disabled:opacity-50 border border-[#444] text-[#9999ee] px-4 py-2 rounded text-sm transition-colors">
          Show Answer
        </button>
        {answerButtons}
      </div>
    </div>
  );
}
