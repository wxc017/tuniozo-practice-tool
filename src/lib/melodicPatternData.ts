// ── Melodic Pattern Data ──────────────────────────────────────────────
// Multi-segment phrase builder: lay out a chord progression, generate
// melodic patterns over each chord, hear how the line moves through
// the harmony.
//
// Pitch pool options: diatonic (7), pentatonic (5), chromatic (all EDO steps).
// Chord fit levels: fits / kinda / clashes.
// All chord types from getEdoChordTypes are candidates.

// Side-channels: metadata about what Bergonzi cell was used.
// Reset each call to randomMelodyWithAngularity.
let _lastDigitalShape: string | null = null;
let _lastTriadPairInfo: string | null = null;
let _lastHexatonicInfo: string | null = null;
let _lastPentatonicInfo: string | null = null;
let _lastIntervallicInfo: string | null = null;
let _lastCellType: string | null = null;
export function getLastDigitalShape(): string | null { return _lastDigitalShape; }
export function getLastTriadPairInfo(): string | null { return _lastTriadPairInfo; }
export function getLastHexatonicInfo(): string | null { return _lastHexatonicInfo; }
export function getLastPentatonicInfo(): string | null { return _lastPentatonicInfo; }
export function getLastIntervallicInfo(): string | null { return _lastIntervallicInfo; }
export function getLastCellType(): string | null { return _lastCellType; }

import {
  getEdoChordTypes,
  getBaseChords,
  getDegreeMap,
  getFullDegreeNames,
  getEDOIntervals,
  type EdoChordType,
} from "./edoData";

// ── Types ────────────────────────────────────────────────────────────

export type FitLevel = "fits" | "kinda" | "clashes";
export type PitchPool = "diatonic" | "modal" | "extended" | "full";

/** One segment of a phrase: a chord + melodic pattern over it. */
export interface PhraseSegment {
  /** Roman numeral label e.g. "I", "V", "iv" */
  romanNumeral: string;
  /** Chord steps from root (absolute pitch classes) */
  chordPcs: number[];
  /** Melodic pattern: pitch classes relative to tonic */
  melody: number[];
}

export interface ChordOption {
  roman: string;
  steps: number[];  // absolute pitch classes from tonic
}

// ── Pitch pools ──────────────────────────────────────────────────────

export function getPitchPool(edo: number, pool: PitchPool): number[] {
  const dm = getDegreeMap(edo);
  const names = getFullDegreeNames(edo);

  switch (pool) {
    case "diatonic":
      // 7 naturals
      return ["1", "2", "3", "4", "5", "6", "7"]
        .map(d => dm[d]).filter(s => s !== undefined);

    case "modal": {
      // Meantone-12: diatonic + standard modal interchange (b2 b3 #4 b6 b7)
      // These are the 12 pitches needed for all common modes/scales.
      const keys = ["1", "b2", "2", "b3", "3", "4", "#4", "5", "b6", "6", "b7", "7"];
      return keys.map(d => dm[d]).filter(s => s !== undefined).sort((a, b) => a - b);
    }

    case "extended": {
      // All single-accidental pitches (21 in 31-EDO)
      // Every step reachable by one # or b from a natural degree.
      const set = new Set<number>();
      for (let step = 0; step < edo; step++) {
        const name = names[step];
        // Count accidentals: naturals (0), single (1), double (2), etc.
        const accCount = (name.match(/[#b]/g) ?? []).length;
        if (accCount <= 1) set.add(step);
      }
      return [...set].sort((a, b) => a - b);
    }

    case "full":
      // All EDO steps
      return Array.from({ length: edo }, (_, i) => i);
  }
}

// ── Roman numeral chords ─────────────────────────────────────────────

/** Get available roman numeral chords for an EDO. */
export function getRomanChords(edo: number): ChordOption[] {
  return getBaseChords(edo).map(([roman, steps]) => ({
    roman,
    steps: steps.map(s => ((s % edo) + edo) % edo),
  }));
}

// ── Degree name → roman numeral mapping ──
const DEGREE_TO_ROMAN: Record<string, string> = {
  "1": "I", "2": "II", "3": "III", "4": "IV", "5": "V", "6": "VI", "7": "VII",
};

/**
 * Build a roman numeral from a root step + chord quality.
 * Returns { roman, chordType } separately so UI can display them
 * on two lines.
 *
 * Examples for 31-EDO:
 *   root=0,  maj  → { roman: "I",    chordType: "Major" }
 *   root=8,  min  → { roman: "iii",  chordType: "Minor" }
 *   root=3,  dom7 → { roman: "bII",  chordType: "Dom7"  }
 *   root=7,  submin → { roman: "bb3", chordType: "Subminor" }
 */
/** Extract 7th quality suffix from xen chord ids like "submin_m7", "neu_M7", "sup_h7" */
function xen7suffix(id: string): string {
  if (id.includes("_M7") || id.includes("_maj7")) return "M7";
  if (id.includes("_m7") || id.includes("_min7")) return "m7";
  if (id.includes("_h7") || id.includes("_harm7")) return "h7";
  if (id.includes("_n7") || id.includes("_neu7")) return "n7";
  if (id.includes("_sm7") || id.includes("_submin7")) return "sm7";
  if (id.includes("_maj6") || id.includes("_M6")) return "M6";
  if (id.includes("_clm7")) return "cl.m7";
  return "7";
}

/** Does this EDO have xenharmonic third types (subminor, neutral, etc.)? */
function hasXenThirds(edo: number): boolean {
  return getEDOIntervals(edo).A1 >= 2;
}

export function toRomanNumeralParts(
  edo: number,
  root: number,
  chord: EdoChordType,
): { roman: string; chordType: string } {
  const names = getFullDegreeNames(edo);
  const rootIdx = ((root % edo) + edo) % edo;
  const degreeName_ = names[rootIdx] ?? `${rootIdx}`;

  // Extract the base digit and accidentals
  const match = degreeName_.match(/^([#b]*)(\d)$/);
  if (!match) {
    return { roman: degreeName_, chordType: chord.name };
  }

  const accidentals = match[1]; // e.g. "b", "##", "bbb"
  const degreeNum = match[2];   // e.g. "1", "3", "5"
  const baseRoman = DEGREE_TO_ROMAN[degreeNum] ?? degreeNum;

  // Determine case: minor-ish qualities → lowercase roman
  const id = chord.id;
  const isMinorish = ["min", "halfdim", "dim", "clmin", "submin"].some(p => id.startsWith(p));
  const romanBase = isMinorish ? baseRoman.toLowerCase() : baseRoman;

  // Jazz suffix based on chord type
  let suffix = "";
  // Triads
  if (id === "dim" || id === "dim_lo" || id === "dim_hi") suffix = "°";
  else if (id === "aug" || id === "aug_lo" || id === "aug_hi") suffix = "+";
  else if (id === "sus4") suffix = "sus4";
  else if (id === "sus2") suffix = "sus2";
  // Standard 7ths
  else if (id === "dom7") suffix = "7";
  else if (id === "maj7") suffix = "maj7";
  else if (id === "min7") suffix = "m7";
  else if (id === "minmaj7") suffix = "mM7";
  else if (id === "halfdim7" || id.startsWith("halfdim")) suffix = "ø7";
  else if (id === "dim7" || id.startsWith("dim7")) suffix = "°7";
  // Xenharmonic triads
  else if (id === "submin") suffix = "sub";
  else if (id === "supermaj") suffix = "sup";
  else if (id === "neutral") suffix = "neu";
  else if (id === "clmin") suffix = "cl.m";
  else if (id === "clmaj") suffix = "cl.M";
  // In xenharmonic EDOs, label maj/min triads explicitly to distinguish from
  // classic major/minor, subminor, supermajor, neutral
  else if (id === "maj" && hasXenThirds(edo)) suffix = "maj";
  else if (id === "min" && hasXenThirds(edo)) suffix = "min";
  // Xenharmonic 7ths — extract quality from id pattern: type_seventh
  else if (id.startsWith("submin_")) suffix = "sub" + xen7suffix(id);
  else if (id.startsWith("supermaj_") || id.startsWith("sup_")) suffix = "sup" + xen7suffix(id);
  else if (id.startsWith("neutral_") || id.startsWith("neu_")) suffix = "neu" + xen7suffix(id);
  else if (id.startsWith("clmin_")) suffix = "cl.m" + xen7suffix(id);
  else if (id.startsWith("clmaj_")) suffix = "cl.M" + xen7suffix(id);
  // Maj/min 7ths in xenharmonic EDOs
  else if (id.startsWith("maj_") && hasXenThirds(edo)) suffix = "maj" + xen7suffix(id);
  else if (id.startsWith("min_") && hasXenThirds(edo)) suffix = "min" + xen7suffix(id);
  // Standard triads (maj, min) — no suffix needed in 12-EDO, case encodes it

  const roman = `${accidentals}${romanBase}${suffix}`;
  return { roman, chordType: chord.name };
}

/**
 * If this dom7 chord is a secondary dominant or tritone sub, return the
 * function label (V/vi, TT/I, etc.). Returns null otherwise.
 */
export function getSecDomLabel(
  edo: number, root: number, chordTypeId: string,
  enabledCats?: Set<HarmonyCategory>,
): string | null {
  if (chordTypeId !== "dom7") return null;
  const dm = getDegreeMap(edo);
  const { M2, M3, P4, P5, M6 } = getEDOIntervals(edo);
  const d5 = dm["b5"] ?? P4 + 1;
  const b2 = dm["b2"] ?? 1;
  const m6 = dm["b6"] ?? (dm["6"] ?? P5 + M2) - 1;
  const normRoot = ((root % edo) + edo) % edo;

  // Only show TT/ labels when tritone category is enabled (or no filter provided)
  if (!enabledCats || enabledCats.has("tritone")) {
    const ttTargets: { root: number; label: string }[] = [
      { root: b2, label: "TT/I" },
      { root: (P5 + b2) % edo, label: "TT/V" },
      { root: (M2 + b2) % edo, label: "TT/ii" },
    ];
    for (const { root: ttRoot, label } of ttTargets) {
      if (((ttRoot % edo) + edo) % edo === normRoot) return label;
    }
  }

  // Only show V/ labels when secondary dominants category is enabled (or no filter)
  if (!enabledCats || enabledCats.has("secdom")) {
    const secTargets: { target: number; label: string }[] = [
      { target: M2, label: "V/ii" },  { target: M3, label: "V/iii" },
      { target: P4, label: "V/IV" },  { target: P5, label: "V/V" },
      { target: M6, label: "V/vi" },
    ];
    for (const { target, label } of secTargets) {
      if (((target + P5) % edo + edo) % edo === normRoot) return label;
    }
  }

  return null;
}

/** Legacy: returns just the combined string. */
export function toRomanNumeral(
  edo: number,
  root: number,
  chordAbbr: string,
  chordPcs: number[],
): string {
  // Try to find the chord type
  const chordTypes = getEdoChordTypes(edo);
  const intervals = chordPcs.map(pc => ((pc - chordPcs[0] + edo) % edo));
  const ct = chordTypes.find(c =>
    c.steps.length === intervals.length && c.steps.every((s, j) => s === intervals[j])
  );
  if (ct) {
    const parts = toRomanNumeralParts(edo, chordPcs[0], ct);
    return parts.roman;
  }
  // Fallback
  const names = getFullDegreeNames(edo);
  return `${names[((chordPcs[0] % edo) + edo) % edo] ?? chordPcs[0]}`;
}

// ── Pattern enumeration ──────────────────────────────────────────────

export function enumeratePatterns(
  pitches: number[],
  length: number,
  allowRepeats: boolean,
  maxResults = 5000,
): number[][] {
  if (pitches.length < length && !allowRepeats) return [];
  const total = allowRepeats
    ? Math.pow(pitches.length, length)
    : perm(pitches.length, length);
  if (total <= maxResults) return exhaustive(pitches, length, allowRepeats);
  return sample(pitches, length, allowRepeats, maxResults);
}

function perm(n: number, r: number): number {
  let p = 1;
  for (let i = 0; i < r; i++) p *= n - i;
  return p;
}

function exhaustive(pitches: number[], length: number, allowRepeats: boolean): number[][] {
  const results: number[][] = [];
  function go(cur: number[], used: Set<number>) {
    if (cur.length === length) { results.push([...cur]); return; }
    for (let i = 0; i < pitches.length; i++) {
      if (!allowRepeats && used.has(i)) continue;
      cur.push(pitches[i]);
      used.add(i);
      go(cur, used);
      cur.pop();
      used.delete(i);
    }
  }
  go([], new Set());
  return results;
}

function sample(
  pitches: number[],
  length: number,
  allowRepeats: boolean,
  count: number,
): number[][] {
  const seen = new Set<string>();
  const results: number[][] = [];
  const maxAttempts = count * 10;
  for (let a = 0; a < maxAttempts && results.length < count; a++) {
    const pat: number[] = [];
    const used = new Set<number>();
    let ok = true;
    for (let i = 0; i < length; i++) {
      // Build available indices, then pick from those to avoid indexOf ambiguity with duplicates
      const availIdx = allowRepeats
        ? pitches.map((_, idx) => idx)
        : pitches.map((_, idx) => idx).filter(idx => !used.has(idx));
      if (availIdx.length === 0) { ok = false; break; }
      const pick = availIdx[Math.floor(Math.random() * availIdx.length)];
      pat.push(pitches[pick]);
      if (!allowRepeats) used.add(pick);
    }
    if (!ok) continue;
    const key = pat.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(pat);
  }
  return results;
}

/** Pick a random pattern from a pool. */
export function randomPattern(
  pitches: number[],
  length: number,
  allowRepeats: boolean,
): number[] {
  const pat: number[] = [];
  const used = new Set<number>();
  for (let i = 0; i < length; i++) {
    const availIdx = allowRepeats
      ? pitches.map((_, idx) => idx)
      : pitches.map((_, idx) => idx).filter(idx => !used.has(idx));
    if (availIdx.length === 0) break;
    const pick = availIdx[Math.floor(Math.random() * availIdx.length)];
    pat.push(pitches[pick]);
    if (!allowRepeats) used.add(pick);
  }
  return pat;
}

// ── Note category system ─────────────────────────────────────────────
// Each note relative to a chord root falls into one of these categories:
//   ct          — chord tone (part of the chord)
//   diatonic    — diatonic tension: natural degree not in chord (9, 11, 13)
//   chromatic   — chromatic tension: single-accidental degree not in chord
//   micro       — microtonal: double+ accidental degree
//
// The melody generator filters the pitch pool to only include enabled categories.

export type NoteCategory = "ct" | "diatonic" | "chromatic" | "micro" | "microTense";

export type TensionLevel = "stable" | "mixed" | "tense";

/**
 * Melodic vocabulary types controlling which cell/pattern techniques
 * the melody generator uses in connector filling.
 *
 * BEBOP CELLS (jazz):
 *   approach    — diatonic/chromatic step into a chord tone
 *   enclosure   — upper + lower neighbor surrounding a chord tone
 *   chromPass   — chromatic passing tone between chord tones
 *
 * BERGONZI TRIADIC:
 *   triadPerm   — permutations of chord-tone triads (1-3-5, 3-5-1, 5-1-3, etc.)
 *
 * BARRY HARRIS:
 *   dimScale    — diminished scale cells: alternating chord tone + dim passing tone
 *
 * COUNTERPOINT (classical figures):
 *   passing     — stepwise motion connecting two chord tones (Fux species 2)
 *   neighbor    — step away from CT and back (Fux species 3)
 *   cambiata    — step away, skip, step back (Fux nota cambiata)
 */
export type MelodicVocab =
  | "approach" | "enclosure" | "chromPass"   // bebop
  | "passing" | "neighbor" | "cambiata"       // classical figures
  | "pentatonic" | "digital" | "triadPair" | "hexatonic" | "intervallic" // bergonzi
  | "pedal" | "arpStep"; // universal cells

export const VOCAB_GROUPS: { group: string; items: { id: MelodicVocab; label: string; desc: string }[] }[] = [
  { group: "Bebop Cells", items: [
    { id: "approach",   label: "Approach",     desc: "Diatonic/chromatic step into a chord tone" },
    { id: "enclosure",  label: "Enclosure",    desc: "Upper + lower neighbor surrounding a chord tone" },
    { id: "chromPass",  label: "Chrom. Pass",  desc: "Chromatic passing tone between chord tones" },
  ]},
  { group: "Classical Figures", items: [
    { id: "passing",    label: "Passing Tone",  desc: "Stepwise motion connecting two chord tones (species 2)" },
    { id: "neighbor",   label: "Neighbor",      desc: "Step away from chord tone and return (species 3)" },
    { id: "cambiata",   label: "Cambiata",      desc: "Step away, skip opposite, step back (nota cambiata)" },
  ]},
  { group: "Bergonzi Cells", items: [
    { id: "pentatonic",  label: "Pentatonic",   desc: "Pentatonic cell fragment (major/minor/dom) — Bergonzi Vol 1 & 2" },
    { id: "digital",     label: "Digital",      desc: "4-note shape (1235, 1345, 1256, 1357 permutations) sequenced through the pool — Bergonzi Vol 3" },
    { id: "triadPair",   label: "Triad Pair",   desc: "Adjacent triad pair permutation — Bergonzi Vol 6" },
    { id: "hexatonic",   label: "Hexatonic",    desc: "Six-note scale cell from two combined triads — Bergonzi Vol 7" },
    { id: "intervallic", label: "Intervallic",  desc: "Constant-interval melodic pattern (3rds, 4ths, 5ths) — Bergonzi Vol 5" },
  ]},
  { group: "Universal Cells", items: [
    { id: "pedal",    label: "Pedal / Axis",    desc: "Fixed anchor note with orbiting notes — ostinato, pedal point, pivot patterns" },
    { id: "arpStep",  label: "Arp → Step",      desc: "Arpeggiate through chord tones then scalar fill back — Bach inventions, smooth jazz runs" },
  ]},
];

/**
 * Cell resolution for Classical Figures: controls step size for passing tones,
 * neighbor tones, and cambiata.
 *   diatonic    — 12-tone scale steps (natural degrees, the main 12)
 *   microtonal  — single EDO steps (finest resolution, quarter tones in 31-EDO)
 *
 * Bebop cells always use chromatic (half-step) resolution regardless.
 */
export type CellResolution = "diatonic" | "microtonal";

/**
 * Minimum note categories required in the pool for each vocab type to work.
 * The vocab strategy bypasses category filters for connector notes, but the
 * cell still needs non-chord-tone notes in the EDO to walk through.
 *
 * If the user's enabledCats doesn't include at least one of the listed
 * categories, the vocab button is disabled in the UI.
 *
 * "ct" is always implicitly available — these list what's needed BEYOND ct.
 */
// Every vocab cell needs at least one non-chord-tone category enabled —
// any of diatonic/chromatic/micro/microTense will do.
const ANY_NON_CT: NoteCategory[] = ["diatonic", "chromatic", "micro", "microTense"];

/**
 * Minimum melody notes (patternLength) required for each vocab type.
 * Buttons are disabled and auto-deselected when patternLength is below this.
 */
export const VOCAB_MIN_NOTES: Partial<Record<MelodicVocab, number>> = {
  cambiata:   5,
  digital:    4,
  triadPair:  6,
  hexatonic:  6,
  arpStep:    4,
};

export const VOCAB_REQUIRED_CATS: Record<MelodicVocab, NoteCategory[]> = {
  approach:    ANY_NON_CT,
  enclosure:   ANY_NON_CT,
  chromPass:   ["chromatic", "micro", "microTense"],
  passing:     ANY_NON_CT,
  neighbor:    ANY_NON_CT,
  cambiata:    ANY_NON_CT,
  pentatonic:  ANY_NON_CT,
  digital:     ANY_NON_CT,
  triadPair:   ANY_NON_CT,
  hexatonic:   ANY_NON_CT,
  intervallic: ANY_NON_CT,
  pedal:       ANY_NON_CT,
  arpStep:     ANY_NON_CT,
};

/**
 * Stable microtonal intervals = the N-odd-limit tonality diamond (Partch).
 * An interval is stable when it's within half an EDO step of a ratio a/b
 * where max(oddPart(a), oddPart(b)) ≤ MAX_ODD_LIMIT.
 *
 * Why odd-limit, not prime-limit: Partch's framework tracks dyad roughness,
 * which scales with odd numbers. 81/64 is 3-prime-limit but 81-odd-limit —
 * correctly tense. 21/16 is 7-prime-limit but 21-odd-limit — also tense at
 * N=11. Bump MAX_ODD_LIMIT to 13/15 to admit tridecimals; drop to 7 to
 * exclude the undecimal neutrals (11/9, 11/8, …).
 */
const MAX_ODD_LIMIT = 11;

function buildTonalityDiamond(N: number): number[] {
  const seen = new Set<string>();
  const cents: number[] = [];
  for (let a = 1; a <= N; a += 2) {
    for (let b = 1; b <= N; b += 2) {
      if (a === b) continue;
      let r = a / b;
      while (r >= 2) r /= 2;
      while (r < 1)  r *= 2;
      const c = 1200 * Math.log2(r);
      const key = c.toFixed(3);
      if (seen.has(key)) continue;
      seen.add(key);
      cents.push(c);
    }
  }
  return cents.sort((a, b) => a - b);
}

const STABLE_MICRO_CENTS: number[] = buildTonalityDiamond(MAX_ODD_LIMIT);

export function isStableMicro(relStep: number, edo: number): boolean {
  const cents = (relStep / edo) * 1200;
  const tolerance = (1200 / edo) / 2; // half an EDO step
  return STABLE_MICRO_CENTS.some(target => Math.abs(cents - target) <= tolerance);
}

/**
 * Check whether an EDO step lies close to a 12-EDO semitone.
 * "Chromatic" (Tense Diatonic) = the 5 notes that complete the 12-tone
 * chromatic scale beyond the 7 naturals. In 12-EDO all single-accidental
 * notes qualify. In 31/41-EDO only those near a 12-EDO step qualify;
 * others (subminor, neutral, supermajor) are microtonal.
 */
/**
 * In 12-EDO all single-accidental notes are "chromatic" (Tense Diatonic).
 * In 31/41-EDO, only the 5 notes that complete the standard 12-tone
 * chromatic scale qualify. The others (#1, #2, #3, #5, #6, #7 in 31-EDO)
 * are subminor/neutral/supermajor intervals — they go to micro categories.
 *
 * We identify the 5 chromatic notes by their degree names: the standard
 * flat/sharp pairs that exist in 12-EDO (b2, b3, #4, b5, b6, b7).
 */
const CHROMATIC_DEGREE_NAMES = new Set([
  "b2", "b3", "#4", "b5", "b6", "b7",
]);

function is12EdoChromatic(relStep: number, edo: number): boolean {
  if (edo === 12) return true;
  const names = getFullDegreeNames(edo);
  const name = names[relStep] ?? "";
  return CHROMATIC_DEGREE_NAMES.has(name);
}

/**
 * Build the diatonic pitch-class set (relative to tonic = 0) for a tonality.
 * Major → {1,2,3,4,5,6,7}, Minor → {1,2,b3,4,5,b6,b7}.
 * "both" falls back to major (the naming reference).
 */
const _diatonicPcCache: Record<string, Set<number>> = {};
function getDiatonicPcSet(edo: number, tonality: Tonality): Set<number> {
  const key = `${edo}:${tonality}`;
  if (_diatonicPcCache[key]) return _diatonicPcCache[key];
  const dm = getDegreeMap(edo);
  let pcs: Set<number>;
  if (tonality === "minor") {
    pcs = new Set([dm["1"], dm["2"], dm["b3"], dm["4"], dm["5"], dm["b6"], dm["b7"]]);
  } else {
    // major or "both" — use the standard major diatonic set
    pcs = new Set([dm["1"], dm["2"], dm["3"], dm["4"], dm["5"], dm["6"], dm["7"]]);
  }
  _diatonicPcCache[key] = pcs;
  return pcs;
}

/** Classify a pitch-class relative to a chord. */
export function classifyNoteCategory(
  pc: number, chordPcs: number[], edo: number, tonicRoot: number = 0,
  tonality: Tonality = "major",
): NoteCategory {
  const norm = ((pc % edo) + edo) % edo;
  const ctSet = new Set(chordPcs.map(p => ((p % edo) + edo) % edo));
  if (ctSet.has(norm)) return "ct";

  // Classify relative to the KEY (tonic root), not the chord root.
  // "diatonic" means the note is a natural degree of the key's scale,
  // which depends on the tonality (major vs minor).
  // However, diatonic notes a half step above a chord tone are "avoid notes"
  // — they clash against the chord despite being in the key. Downgrade these
  // to "chromatic" so the melody engine treats them as tense, not stable.
  const rel = ((norm - tonicRoot) % edo + edo) % edo;
  const diaSet = getDiatonicPcSet(edo, tonality);
  if (diaSet.has(rel)) {
    const dm = getDegreeMap(edo);
    const halfStep = dm["b2"] ?? 1; // minor 2nd in this EDO
    for (const ct of ctSet) {
      const above = ((norm - ct) % edo + edo) % edo;
      if (above > 0 && above <= halfStep) return "chromatic"; // avoid note
    }
    return "diatonic";
  }

  // Non-diatonic: classify as chromatic (tense diatonic) vs microtonal.
  // Use the major-reference degree name for structural distance.
  const names = getFullDegreeNames(edo);
  const name = names[rel] ?? "";
  const accCount = (name.match(/[#b]/g) ?? []).length;

  // Notes with 0 accidentals that aren't in the diatonic set (e.g. "3" in minor)
  // are standard chromatic alterations — classify as "chromatic" (tense diatonic).
  if (accCount === 0) return "chromatic";
  if (accCount === 1) {
    if (is12EdoChromatic(rel, edo)) return "chromatic";
    return isStableMicro(rel, edo) ? "micro" : "microTense";
  }
  return isStableMicro(rel, edo) ? "micro" : "microTense";
}

/** Filter a pitch pool to only include enabled note categories relative to a chord. */
export function filterPoolByCategories(
  pitchPool: number[],
  chordPcs: number[],
  enabledCategories: Set<NoteCategory>,
  edo: number,
  tonicRoot: number = 0,
  tonality: Tonality = "major",
): number[] {
  return pitchPool.filter(pc =>
    enabledCategories.has(classifyNoteCategory(pc, chordPcs, edo, tonicRoot, tonality))
  );
}

/**
 * Classify a pitch-class by its absolute degree name (relative to tonic, no chord context).
 * Used in melody-first mode where no chord exists yet.
 *   ct       → tonic triad (1, 3/b3, 5)
 *   diatonic → other scale naturals — "stable colors"
 *   chromatic → nearby chromatic alterations
 *   micro    → microtonal intervals
 */
export function classifyNoteAbsolute(pc: number, edo: number, tonality: Tonality = "major"): NoteCategory {
  const norm = ((pc % edo) + edo) % edo;
  const dm = getDegreeMap(edo);

  // Tonic triad depends on tonality
  const tonicTriad = tonality === "minor"
    ? new Set([dm["1"], dm["b3"], dm["5"]])
    : new Set([dm["1"], dm["3"], dm["5"]]);
  if (tonicTriad.has(norm)) return "ct";

  // Diatonic = in the scale for this tonality
  const diaSet = getDiatonicPcSet(edo, tonality);
  if (diaSet.has(norm)) return "diatonic";

  // Non-diatonic: classify as chromatic vs micro
  const names = getFullDegreeNames(edo);
  const name = names[norm] ?? "";
  const accCount = (name.match(/[#b]/g) ?? []).length;
  if (accCount === 0) return "chromatic";
  if (accCount === 1) {
    if (is12EdoChromatic(norm, edo)) return "chromatic";
    return isStableMicro(norm, edo) ? "micro" : "microTense";
  }
  return isStableMicro(norm, edo) ? "micro" : "microTense";
}

/** Filter a pitch pool by enabled categories using absolute degree classification (no chord context). */
export function filterPoolAbsolute(
  pitchPool: number[],
  enabledCategories: Set<NoteCategory>,
  edo: number,
  tonality: Tonality = "major",
): number[] {
  // "diatonic" category maps to same notes as "ct" in absolute mode
  const effectiveCats = new Set(enabledCategories);
  if (effectiveCats.has("diatonic")) effectiveCats.add("ct");
  return pitchPool.filter(pc =>
    effectiveCats.has(classifyNoteAbsolute(pc, edo, tonality))
  );
}

/**
 * Generate a melody using only notes from the enabled categories.
 * Falls back to chord tones if the filtered pool is too small.
 */
export function randomMelodyForChord(
  pitchPool: number[],
  chordPcs: number[],
  length: number,
  categories: Set<NoteCategory>,
  allowRepeats: boolean,
  edo: number,
): number[] {
  let filtered = filterPoolByCategories(pitchPool, chordPcs, categories, edo);
  // Fallback: if filtered pool is too small, include chord tones
  if (filtered.length < (allowRepeats ? 1 : length)) {
    const ctSet = new Set(chordPcs.map(p => ((p % edo) + edo) % edo));
    const cts = pitchPool.filter(p => ctSet.has(((p % edo) + edo) % edo));
    filtered = [...new Set([...filtered, ...cts])];
  }
  // Final fallback
  if (filtered.length === 0) filtered = pitchPool;

  const pat: number[] = [];
  const used = new Set<number>();
  for (let i = 0; i < length; i++) {
    const avail = allowRepeats
      ? filtered
      : filtered.filter((_, idx) => !used.has(idx));
    if (avail.length === 0) {
      // Pool exhausted without repeats — fill remaining slots with repeats
      if (!allowRepeats && pat.length > 0) {
        while (pat.length < length) {
          pat.push(filtered[Math.floor(Math.random() * filtered.length)]);
        }
      }
      break;
    }
    const pick = avail[Math.floor(Math.random() * avail.length)];
    pat.push(pick);
    if (!allowRepeats) used.add(filtered.indexOf(pick));
  }
  return pat;
}

// ── Pattern analysis ─────────────────────────────────────────────────

/** Raw intervals between absolute pitches (no octave wrapping). */
export function getIntervals(pattern: number[]): number[] {
  const ivs: number[] = [];
  for (let i = 1; i < pattern.length; i++) {
    ivs.push(pattern[i] - pattern[i - 1]);
  }
  return ivs;
}

export function getContour(intervals: number[]): string {
  return intervals.map(i => (i > 0 ? "↑" : i < 0 ? "↓" : "—")).join("");
}

/** Extract pitch class (0..edo-1) from an absolute pitch. */
export function toPc(abs: number, edo: number): number {
  return ((abs % edo) + edo) % edo;
}

/** Octave offset from base octave (0). e.g. 35 in 31-EDO → +1, -5 → -1. */
export function octaveOffset(abs: number, edo: number): number {
  return Math.floor(abs / edo);
}

export function degreeName(pc: number, edo: number): string {
  const names = getFullDegreeNames(edo);
  const idx = ((pc % edo) + edo) % edo;
  return names[idx] ?? `${pc}`;
}

/**
 * Name an interval relative to a chord root using extension/tension names.
 * 2→9, 4→11, 6→13 (with accidentals), chord-tone degrees (1,3,5,7) stay as-is.
 * Microtonal 3rds/7ths spelled on an even base ("bb4", "#2", "b4", "#6", "##6")
 * are labeled sub3/neu3/sup3/sub7/neu7 instead of dragged into tension names.
 */
export function chordExtensionName(relPc: number, edo: number): string {
  const raw = degreeName(relPc, edo);
  const m = raw.match(/^([#b]*)(\d+)$/);
  if (!m) return raw;
  const acc = m[1];
  const deg = parseInt(m[2]);
  // Microtonal chord tones spell onto an even base (2/4/6) but the effective
  // pitch hovers around an odd chord-tone position (3/7). Label by flavor
  // (sub/neu/sup) rather than dragging into tension territory ("#9", "bb11",
  // "##6"). 5ths skipped — "sub5"/"sup5" aren't common terminology.
  if (acc.length > 0 && (deg === 2 || deg === 4 || deg === 6)) {
    const sharps = (acc.match(/#/g) || []).length;
    const flats  = (acc.match(/b/g) || []).length;
    const effDeg = deg + 0.5 * sharps - 0.5 * flats;
    const odd = (deg === 6) ? 7 : 3;
    if (Math.abs(effDeg - odd) <= 0.5) {
      const delta = effDeg - odd;
      if (delta < -0.25) return `sub${odd}`;
      if (delta > 0.25)  return `sup${odd}`;
      return `neu${odd}`;
    }
  }
  switch (deg) {
    case 1: return acc ? acc + "R" : "R";
    case 2: return acc + "9";
    case 4: return acc + "11";
    case 6: return acc + "13";
    default: return raw; // 3, 5, 7 stay as chord-tone names
  }
}

// ── Chord-melody fit scoring ─────────────────────────────────────────

/** What fraction of melody notes are chord tones? */
export function chordMelodyOverlap(
  melodyPcs: number[],
  chordPcs: number[],
  edo: number,
): number {
  const cset = new Set(chordPcs.map(s => ((s % edo) + edo) % edo));
  let hits = 0;
  for (const pc of melodyPcs) {
    if (cset.has(((pc % edo) + edo) % edo)) hits++;
  }
  return hits / Math.max(1, melodyPcs.length);
}

/** Classify a chord's fit against a melody. */
export function classifyFit(overlap: number): FitLevel {
  if (overlap >= 0.5) return "fits";
  if (overlap >= 0.25) return "kinda";
  return "clashes";
}

/**
 * Pick a random chord (from all types × all roots) at a given fit level.
 * Returns the chord type, transposed steps, and root.
 */
export function pickChordForMelody(
  melodyPcs: number[],
  edo: number,
  fitLevel: FitLevel,
  excludeKey?: string,
): { chord: EdoChordType; root: number; chordPcs: number[]; overlap: number } | null {
  const chordTypes = getEdoChordTypes(edo);
  const candidates: { chord: EdoChordType; root: number; chordPcs: number[]; overlap: number }[] = [];

  for (const ct of chordTypes) {
    for (let root = 0; root < edo; root++) {
      const pcs = ct.steps.map(s => (s + root) % edo);
      const overlap = chordMelodyOverlap(melodyPcs, pcs, edo);
      if (classifyFit(overlap) === fitLevel) {
        const key = `${ct.id}@${root}`;
        if (excludeKey && key === excludeKey) continue;
        candidates.push({ chord: ct, root, chordPcs: pcs, overlap });
      }
    }
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Pick a random chord whose overlap with the melody falls within [fitLo, fitHi].
 * Overlap is the fraction of melody notes that are chord tones (0 = no overlap, 1 = all chord tones).
 * Note: overlap is inverted from "fit distance" — high overlap = best fit.
 * fitLo/fitHi are in "distance" space (0 = best fit, 1 = worst), so we convert:
 *   accept chord when (1 - overlap) is in [fitLo, fitHi].
 */
export function pickChordForMelodyInRange(
  melodyPcs: number[],
  edo: number,
  fitLo: number,
  fitHi: number,
  categories: Set<HarmonyCategory> | ChordComplexity | Set<ChordComplexity>,
  minChordNotes: number,
  tonality: Tonality,
  tonicRoot: number = 0,
  prevChordPcs?: number[],
  seventhFilter?: Set<string>,
  thirdFilter?: Set<string>,
  includeAltered?: boolean,
): { chordTypeId: string; root: number; chordPcs: number[]; overlap: number } | null {
  const pool = generateProgression(edo, 0, categories, "pool", minChordNotes, tonality, tonicRoot, seventhFilter, thirdFilter, includeAltered);
  if (pool.length === 0) return null;

  const dm = getDegreeMap(edo);
  const M3 = dm["3"] ?? Math.round(edo * 4 / 12);
  const P5 = dm["5"] ?? Math.round(edo * 7 / 12);

  // Multi-factor scoring for chord selection.
  const melSet = new Set(melodyPcs.map(p => ((p % edo) + edo) % edo));
  const diaRoots = new Set([0, dm["2"], M3, dm["4"], P5, dm["6"], dm["7"]].filter(x => x != null));

  const scored = pool.map(ch => {
    const overlap = chordMelodyOverlap(melodyPcs, ch.chordPcs, edo);
    const dist = 1 - overlap;

    // 1. Coverage: how well does the fit range match?
    let coverageScore: number;
    if (dist >= fitLo && dist <= fitHi) {
      coverageScore = 1.0;
    } else {
      const mid = (fitLo + fitHi) / 2;
      coverageScore = Math.max(0, 1 - Math.abs(dist - mid) * 2);
    }

    // 2. Guide-tone match: chord's 3rd or 7th in the melody
    const third = ch.chordPcs.length >= 2 ? ((ch.chordPcs[1] % edo) + edo) % edo : null;
    const seventh = ch.chordPcs.length >= 4 ? ((ch.chordPcs[3] % edo) + edo) % edo : null;
    let guideScore = 0;
    if (third !== null && melSet.has(third)) guideScore += 0.5;
    if (seventh !== null && melSet.has(seventh)) guideScore += 0.5;

    // 3. Chord identity: triads and 7ths are stronger than clusters
    const identityScore = ch.chordPcs.length >= 3 && ch.chordPcs.length <= 5 ? 1.0 : 0.6;

    // 4. Voice-leading from previous chord
    let vlScore = 0.5;
    if (prevChordPcs && prevChordPcs.length > 0) {
      const prevSet = new Set(prevChordPcs.map(p => ((p % edo) + edo) % edo));
      const chSet = new Set(ch.chordPcs.map(p => ((p % edo) + edo) % edo));
      let commonTones = 0;
      let halfSteps = 0;
      for (const pc of chSet) {
        if (prevSet.has(pc)) commonTones++;
        for (const pp of prevSet) {
          const d = ((pc - pp) % edo + edo) % edo;
          if (d >= 1 && d <= 2 || d >= edo - 2) { halfSteps++; break; }
        }
      }
      vlScore = Math.min(1.0, commonTones * 0.3 + halfSteps * 0.2);
    }

    // 5. Functional probability: diatonic roots preferred
    const rootPc = ((ch.root - tonicRoot) % edo + edo) % edo;
    const funcScore = diaRoots.has(rootPc) ? 0.8 : 0.4;

    // 6. Same-root penalty: heavily penalize picking the same root as previous chord
    let repeatPenalty = 0;
    if (prevChordPcs && prevChordPcs.length > 0) {
      const prevRoot = ((prevChordPcs[0] % edo) + edo) % edo;
      const chRoot = ((ch.chordPcs[0] % edo) + edo) % edo;
      if (chRoot === prevRoot) repeatPenalty = -4.0; // strong penalty
    }

    const total = coverageScore * 3.0
                + guideScore * 2.0
                + identityScore * 0.5
                + vlScore * 1.5
                + funcScore * 1.0
                + repeatPenalty;

    return { chordTypeId: ch.chordTypeId, root: ch.root, chordPcs: ch.chordPcs, overlap, score: total };
  });

  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0].score;
  const topTier = scored.filter(s => s.score >= topScore * 0.85);
  const pick = topTier[Math.floor(Math.random() * topTier.length)];
  return { chordTypeId: pick.chordTypeId, root: pick.root, chordPcs: pick.chordPcs, overlap: pick.overlap };
}

/**
 * Category weight for melody generation.
 *
 * Each category has an "inside" weight and an "outside" weight.
 * The bias parameter (0–1) interpolates between them:
 *   bias 0   → inside-heavy (chord tones dominate)
 *   bias 0.5 → equal weight across enabled categories
 *   bias 1   → outside-heavy (outermost enabled category dominates)
 *
 * Disabled categories always get 0.
 */
const INSIDE_WEIGHT: Record<NoteCategory, number> = {
  ct: 1.0, diatonic: 0.30, chromatic: 0.12, micro: 0.06, microTense: 0.02,
};
const OUTSIDE_WEIGHT: Record<NoteCategory, number> = {
  ct: 0.05, diatonic: 0.12, chromatic: 0.30, micro: 0.70, microTense: 1.0,
};

function categoryWeight(cat: NoteCategory, enabled: Set<NoteCategory>, bias: number): number {
  if (!enabled.has(cat)) return 0;
  const inside = INSIDE_WEIGHT[cat];
  const outside = OUTSIDE_WEIGHT[cat];
  // Power curve: chord tones dominate at neutral bias, outside notes need high bias
  const insideT = (1 - bias) ** 1.5;
  const outsideT = bias ** 1.5;
  return inside * insideT + outside * outsideT;
}

// ── Default phrase-position metric weights ──────────────────────────
export function defaultMetricWeights(length: number): number[] {
  if (length <= 1) return [1.0];
  if (length === 2) return [1.0, 0.9];
  const w: number[] = new Array(length).fill(0.3);
  w[0] = 1.0;
  w[length - 1] = 0.9;
  if (length >= 4) w[Math.floor(length / 2)] = 0.7;
  if (length >= 6) {
    w[Math.floor(length / 4)] = Math.max(w[Math.floor(length / 4)], 0.5);
    w[Math.floor(3 * length / 4)] = Math.max(w[Math.floor(3 * length / 4)], 0.5);
  }
  return w;
}

// ── Contour shapes ──────────────────────────────────────────────────
// Each returns a directional bias per position: positive = prefer ascending,
// negative = prefer descending, 0 = neutral. Range roughly [-1, 1].
type ContourShape = "arch" | "descending" | "ascending" | "valley" | "plateau";
function contourBias(shape: ContourShape, pos: number, length: number): number {
  if (length <= 2) return 0;
  const t = pos / (length - 1); // 0..1
  switch (shape) {
    case "arch":       return t < 0.5 ? 0.7 : -0.7;           // rise then fall
    case "valley":     return t < 0.5 ? -0.6 : 0.6;           // fall then rise
    case "ascending":  return 0.5 * (1 - t * 0.4);             // steady rise, easing off
    case "descending": return -0.5 * (1 - t * 0.4);            // steady fall, easing off
    case "plateau":    return t < 0.3 ? 0.5 : t > 0.7 ? -0.5 : 0; // rise, hold, descend
  }
}
const CONTOUR_SHAPES: ContourShape[] = ["arch", "descending", "ascending", "valley", "plateau"];

// ── Context-sensitive category weighting ──────────────────────────────

interface MelodyContext {
  recentCategories: NoteCategory[];
  resolutionDebt: number;
  recentDirections: number[];
}

function createMelodyContext(): MelodyContext {
  return { recentCategories: [], resolutionDebt: 0, recentDirections: [] };
}

const TENSION_DEBT: Record<NoteCategory, number> = {
  ct: 0, diatonic: 0, chromatic: 0.3, micro: 0.5, microTense: 0.8,
};
const DEBT_DECAY: Record<NoteCategory, number> = {
  ct: 0.3, diatonic: 0.7, chromatic: 1.0, micro: 1.0, microTense: 1.0,
};

function updateMelodyContext(ctx: MelodyContext, cat: NoteCategory, dir: number) {
  ctx.recentCategories.push(cat);
  if (ctx.recentCategories.length > 4) ctx.recentCategories.shift();
  ctx.resolutionDebt = ctx.resolutionDebt * DEBT_DECAY[cat] + TENSION_DEBT[cat];
  if (dir !== 0) {
    ctx.recentDirections.push(dir);
    if (ctx.recentDirections.length > 3) ctx.recentDirections.shift();
  }
}

function contextWeightModifier(
  ctx: MelodyContext,
  candidateCat: NoteCategory,
  candidateDir: number,
  predictability: number,
): number {
  if (predictability <= 0) return 1;
  let mod = 1;

  // Saturation: penalize repeating the same category
  if (ctx.recentCategories.length >= 2) {
    const sameCount = ctx.recentCategories.filter(c => c === candidateCat).length;
    const saturation = (sameCount / ctx.recentCategories.length) ** 2;
    mod *= 1 - saturation * 0.6 * predictability;
  }

  // Resolution debt: high tension → pull toward CT; just resolved → allow color
  if (ctx.resolutionDebt > 0.3) {
    const debtFactor = Math.min(ctx.resolutionDebt, 2) / 2;
    if (candidateCat === "ct") {
      mod *= 1 + debtFactor * 1.5 * predictability;
    } else if (candidateCat === "chromatic" || candidateCat === "micro" || candidateCat === "microTense") {
      mod *= 1 - debtFactor * 0.5 * predictability;
    }
  } else if (ctx.resolutionDebt < 0.1 && ctx.recentCategories.length >= 2) {
    if (candidateCat !== "ct" && candidateCat !== "diatonic") {
      mod *= 1 + 0.3 * predictability;
    }
  }

  // Direction momentum: favor contrary motion after sustained direction
  if (ctx.recentDirections.length >= 2 && candidateDir !== 0) {
    const avgDir = ctx.recentDirections.reduce((a, b) => a + b, 0) / ctx.recentDirections.length;
    if (Math.abs(avgDir) > 1) {
      if (Math.sign(avgDir) !== Math.sign(candidateDir)) {
        mod *= 1 + 0.8 * predictability;
      } else {
        mod *= 1 - 0.3 * predictability;
      }
    }
  }

  return Math.max(0.05, mod);
}

// ── Melodic pool override presets ─────────────────────────────────────

export type PoolPreset = "all" | "pentatonic-maj" | "pentatonic-min" | "whole-tone" | "triad-pair" | "quartal" | "custom";

export const POOL_PRESETS: { id: PoolPreset; label: string; color: string; desc: string }[] = [
  { id: "all",            label: "All",        color: "#888",    desc: "Full EDO — all pitch classes available" },
  { id: "pentatonic-maj", label: "Pent Maj",   color: "#6ab06a", desc: "Major pentatonic (1 2 3 5 6)" },
  { id: "pentatonic-min", label: "Pent Min",   color: "#5a9a8a", desc: "Minor pentatonic (1 b3 4 5 b7)" },
  { id: "whole-tone",     label: "Whole Tone",  color: "#c8aa50", desc: "Whole-tone scale (6 equidistant notes)" },
  { id: "quartal",        label: "Quartal",    color: "#8888cc", desc: "Stacked perfect fourths from tonic" },
  { id: "triad-pair",     label: "Triad Pair", color: "#c06090", desc: "Two adjacent triads (I + II)" },
  { id: "custom",         label: "Custom",     color: "#aa66aa", desc: "User-defined pitch class set" },
];

export function getPoolPresetPcs(
  preset: PoolPreset, edo: number, tonicRoot: number = 0,
): number[] | null {
  if (preset === "all" || preset === "custom") return null;
  const dm = getDegreeMap(edo);
  const wrap = (step: number) => ((step + tonicRoot) % edo + edo) % edo;
  switch (preset) {
    case "pentatonic-maj":
      return ["1", "2", "3", "5", "6"].map(d => dm[d]).filter(s => s !== undefined).map(wrap);
    case "pentatonic-min":
      return ["1", "b3", "4", "5", "b7"].map(d => dm[d]).filter(s => s !== undefined).map(wrap);
    case "whole-tone": {
      const T = dm["2"] ?? Math.round(edo / 6);
      const pcs: number[] = [];
      for (let i = 0; i < 6; i++) {
        const pc = (tonicRoot + i * T) % edo;
        if (!pcs.includes(pc)) pcs.push(pc);
      }
      return pcs;
    }
    case "quartal": {
      const P4 = dm["4"] ?? Math.round(edo * 5 / 12);
      const pcs: number[] = [];
      let cur = tonicRoot;
      for (let i = 0; i < 6; i++) {
        const pc = (cur % edo + edo) % edo;
        if (!pcs.includes(pc)) pcs.push(pc);
        cur += P4;
      }
      return pcs;
    }
    case "triad-pair": {
      const M3 = dm["3"] ?? Math.round(edo / 3);
      const P5 = dm["5"] ?? Math.round(edo * 7 / 12);
      const M2 = dm["2"] ?? Math.round(edo / 6);
      const t1 = [tonicRoot, (tonicRoot + M3) % edo, (tonicRoot + P5) % edo];
      const r2 = (tonicRoot + M2) % edo;
      const t2 = [r2, (r2 + M3) % edo, (r2 + P5) % edo];
      return [...new Set([...t1, ...t2])];
    }
  }
  return null;
}

/**
 * Multi-pass melody generator.
 *
 * Pass 1 — Role assignment from metric weights.
 * Pass 2 — Target generation with contour planning, bias-aware pool, guide-tone preference.
 * Pass 3 — Connector filling: scalar passing, motivic repetition (with inversion),
 *           approach notes, enclosures (flexible placement), tension-release free fill.
 * Pass 4 — Octave placement with contour-aware direction, leap recovery, registral pull.
 */
export function randomMelodyWithAngularity(
  pitchPool: number[],
  chordPcs: number[],
  length: number,
  categories: Set<NoteCategory>,
  bias: number,
  allowRepeats: boolean,
  edo: number,
  angularity: number,
  hasChordContext: boolean,
  useApproach: boolean = false,
  useEnclosure: boolean = false,
  metricWeights?: number[],
  prevMelodyEnd?: number,
  tonicRoot: number = 0,
  /** Position in a multi-segment phrase (0-based). Used for cross-segment arc. */
  segmentIndex: number = 0,
  /** Total segments in the phrase. 0 = no arc shaping. */
  totalSegments: number = 0,
  /** PCs of the NEXT chord in the progression. Enables voice-leading on last note. */
  nextChordPcs?: number[],
  /** Melodic vocabulary techniques to use. Overrides useApproach/useEnclosure when provided. */
  vocab?: Set<MelodicVocab>,
  /** Resolution for classical figure cells: diatonic (12-tone steps) or microtonal (EDO steps). */
  cellResolution: CellResolution = "diatonic",
  /** Tonality for diatonic classification (major vs minor scale). */
  tonality: Tonality = "major",
  /** Context sensitivity: 0 = positional only, 1 = fully context-reactive. */
  predictability: number = 0,
): number[] {
  if (length <= 0) return [];
  _lastDigitalShape = null; // reset each call
  _lastTriadPairInfo = null;
  _lastHexatonicInfo = null;
  _lastPentatonicInfo = null;
  _lastIntervallicInfo = null;
  _lastCellType = null;

  // Derive approach/enclosure from vocab if provided (backward compat)
  if (vocab) {
    useApproach = vocab.has("approach") || vocab.has("chromPass");
    useEnclosure = vocab.has("enclosure");
  }

  // When a vocab strategy is active, connector notes bypass the category
  // filter and use an expanded step pool (pool ∪ diatonic naturals).
  const vocabActive = vocab != null && vocab.size > 0;

  // ── Setup ──
  const classifyPc = (pc: number): NoteCategory =>
    hasChordContext ? classifyNoteCategory(pc, chordPcs, edo, tonicRoot, tonality) : classifyNoteAbsolute(pc, edo, tonality);

  const pcWeighted = pitchPool.map(pc => {
    const cat = classifyPc(pc);
    return { pc, cat, cWeight: categoryWeight(cat, categories, bias) };
  }).filter(n => n.cWeight > 0);

  let pool = pcWeighted;
  if (pool.length < 1) {
    pool = pitchPool.map(pc => ({ pc, cat: "ct" as NoteCategory, cWeight: 1 }));
  }

  const ctSet = new Set(chordPcs.map(p => ((p % edo) + edo) % edo));
  const leapThreshold = Math.max(2, Math.round(edo / 7));
  const melCtx = createMelodyContext();

  // If the unique PC pool is smaller than the melody length, repeats are
  // inevitable — allow them from the start instead of depleting then falling back.
  // But prefer non-repeats: avoid immediate consecutive repetitions.
  const uniquePcCount = new Set(pool.map(n => n.pc)).size;
  // Shadow the parameter so all downstream code uses the adjusted value
  allowRepeats = allowRepeats || uniquePcCount < length; // eslint-disable-line no-param-reassign

  // Bias-aware target pool: at low bias prefer CTs, at high bias allow all enabled categories
  const targetPool = bias < 0.5
    ? pool.filter(n => n.cat === "ct" || n.cat === "diatonic")
    : pool; // at high bias, any enabled category can be a target
  const effectiveTargetPool = targetPool.length > 0 ? targetPool : pool;

  // Guide-tone PCs (3rds and 7ths of the chord) for cross-segment voice-leading
  const guideTonePcs = new Set<number>();
  if (hasChordContext && chordPcs.length >= 3) {
    guideTonePcs.add(((chordPcs[1] % edo) + edo) % edo); // 3rd
    if (chordPcs.length >= 4) guideTonePcs.add(((chordPcs[3] % edo) + edo) % edo); // 7th
  }

  // Choose a contour shape — arc-aware when in a multi-segment phrase.
  // Early segments: ascending/arch (building). Middle: plateau/arch. Final: descending/valley (resolving).
  let contour: ContourShape;
  if (totalSegments >= 3) {
    const phase = segmentIndex / (totalSegments - 1); // 0→1
    const arcShapes: ContourShape[][] = [
      ["ascending", "arch"],                          // opening: build
      ["arch", "plateau", "ascending"],               // middle: sustain
      ["descending", "valley", "arch"],               // closing: resolve
    ];
    const bucket = phase < 0.33 ? 0 : phase < 0.67 ? 1 : 2;
    const shapes = arcShapes[bucket];
    contour = shapes[Math.floor(Math.random() * shapes.length)];
  } else {
    contour = CONTOUR_SHAPES[Math.floor(Math.random() * CONTOUR_SHAPES.length)];
  }

  const weightedPick = <T,>(candidates: T[], weights: number[]): T => {
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return candidates[Math.floor(Math.random() * candidates.length)];
    let r = Math.random() * total;
    for (let j = 0; j < candidates.length; j++) {
      r -= weights[j];
      if (r <= 0) return candidates[j];
    }
    return candidates[candidates.length - 1];
  };

  // Shortest signed interval between two PCs (wrapping around the EDO)
  const pcDist = (a: number, b: number): number => {
    let d = ((b - a) % edo + edo) % edo;
    if (d > edo / 2) d -= edo;
    return d;
  };

  // Build a sorted list of all enabled PCs for scalar runs
  const scaleSteps = pool.map(n => n.pc).sort((a, b) => a - b);
  // Find the next scale step above/below a given PC
  const nextScaleStep = (from: number, dir: 1 | -1): number | null => {
    if (scaleSteps.length === 0) return null;
    if (dir === 1) {
      for (const s of scaleSteps) { if (s > from) return s; }
      return scaleSteps[0]; // wrap
    } else {
      for (let i = scaleSteps.length - 1; i >= 0; i--) { if (scaleSteps[i] < from) return scaleSteps[i]; }
      return scaleSteps[scaleSteps.length - 1]; // wrap
    }
  };

  // Neighbor PCs around a target for approach/enclosure/neighbor vocabulary.
  // Resolution controls what "one step" means:
  //   chromatic:  half steps (A1 in the EDO — e.g., 1 step in 12-EDO, 2 in 31-EDO)
  //   diatonic:   scale steps (jump to next natural degree, skipping accidentals)
  //   microtonal: single EDO steps (finest grain — quarter tones in 31-EDO)
  const diatonicSteps = (() => {
    const names = getFullDegreeNames(edo);
    return names.map((n, i) => ({ pc: i, acc: (n.match(/[#b]/g) ?? []).length }))
      .filter(x => x.acc === 0).map(x => x.pc).sort((a, b) => a - b);
  })();
  const _dm = getDegreeMap(edo);
  const chromaticStep = _dm["b2"] ?? 1; // A1 = the EDO's half step

  // When vocab is active, connectors need access to diatonic steps even if
  // the user's pool only has chord tones. vocabSteps = pool ∪ diatonic naturals.
  const vocabSteps = vocabActive
    ? [...new Set([...scaleSteps, ...diatonicSteps])].sort((a, b) => a - b)
    : scaleSteps;
  // nextVocabStep: like nextScaleStep but walks vocabSteps
  const nextVocabStep = (from: number, dir: 1 | -1): number | null => {
    if (vocabSteps.length === 0) return null;
    if (dir === 1) {
      for (const s of vocabSteps) { if (s > from) return s; }
      return vocabSteps[0];
    } else {
      for (let i = vocabSteps.length - 1; i >= 0; i--) { if (vocabSteps[i] < from) return vocabSteps[i]; }
      return vocabSteps[vocabSteps.length - 1];
    }
  };

  // Neighbor steps: find the nearest notes above/below a target PC.
  // When vocab is active, uses vocabSteps (pool + diatonic) so passing tones,
  // neighbors, and cambiata figures can access scale steps beyond chord tones.
  // When no vocab, uses scaleSteps (the user's pool only).
  // "bebop" mode always uses chromatic half steps for enclosures.
  const getNeighborSteps = (targetPc: number, mode: "bebop" | "classical" = "classical"): { above: number[]; below: number[] } => {
    const above: number[] = [];
    const below: number[] = [];

    if (mode === "bebop") {
      // Bebop: always chromatic half steps (A1 multiples)
      for (let m = 1; m <= 3; m++) {
        const d = m * chromaticStep;
        if (d > leapThreshold) break;
        above.push((targetPc + d) % edo);
        below.push(((targetPc - d) % edo + edo) % edo);
      }
    } else {
      // Walk through vocabSteps to find nearest notes above and below.
      // vocabSteps = pool + diatonic when vocab is active, pool only otherwise.
      for (const spc of vocabSteps) {
        if (spc === targetPc) continue;
        const distUp = ((spc - targetPc) % edo + edo) % edo;
        const distDown = ((targetPc - spc) % edo + edo) % edo;
        if (distUp > 0 && distUp <= Math.ceil(edo / 4)) above.push(spc);
        if (distDown > 0 && distDown <= Math.ceil(edo / 4)) below.push(spc);
      }
      // Sort by proximity to target
      above.sort((a, b) => ((a - targetPc) % edo + edo) % edo - ((b - targetPc) % edo + edo) % edo);
      below.sort((a, b) => ((targetPc - a) % edo + edo) % edo - ((targetPc - b) % edo + edo) % edo);
    }
    return { above, below };
  };

  // ══════════════════════════════════════════════════════════════════════
  // CELL FAST PATH — every vocab cell IS the melody, built from the pool
  // ══════════════════════════════════════════════════════════════════════
  // All vocab cells (bebop, classical, bergonzi) generate the entire melody
  // using the notes available in the pool, grouped by category so cells can
  // place stable notes (ct, diatonic) at structural positions and tense notes
  // (chromatic, micro, microTense) at decorative positions.

  const allCellTypes: MelodicVocab[] = [
    "approach", "enclosure", "chromPass",              // bebop
    "passing", "neighbor", "cambiata",                 // classical
    "pentatonic", "digital", "triadPair", "hexatonic", "intervallic", // bergonzi
    "pedal", "arpStep",                                // universal
  ];
  const activeCells = allCellTypes.filter(c => vocab?.has(c));

  if (activeCells.length > 0 && scaleSteps.length >= 2) {
    const cellType = activeCells[Math.floor(Math.random() * activeCells.length)];
    _lastCellType = cellType;

    // ── Category-aware pool helpers ──
    const stablePcs = pool.filter(n => n.cat === "ct" || n.cat === "diatonic").map(n => n.pc);
    const tensePcs  = pool.filter(n => n.cat !== "ct" && n.cat !== "diatonic").map(n => n.pc);
    const ctPcs     = pool.filter(n => n.cat === "ct").map(n => n.pc);
    // Full sorted pool for indexed access
    const ssLen = scaleSteps.length;
    const poolAt = (idx: number): number =>
      scaleSteps[((idx % ssLen) + ssLen) % ssLen];

    const nearestIdx = (pc: number): number => {
      let best = 0, bestD = edo;
      for (let i = 0; i < ssLen; i++) {
        const d = Math.abs(pcDist(scaleSteps[i], pc));
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    };

    // Pick a random note from a category group, or fallback to full pool
    const pickFrom = (group: number[]): number => {
      if (group.length === 0) return scaleSteps[Math.floor(Math.random() * ssLen)];
      return group[Math.floor(Math.random() * group.length)];
    };
    // Nearest note in a group to a reference PC
    const nearestIn = (group: number[], ref: number): number => {
      if (group.length === 0) return scaleSteps[nearestIdx(ref)];
      let best = group[0], bestD = edo;
      for (const pc of group) {
        const d = Math.abs(pcDist(ref, pc));
        if (d < bestD) { bestD = d; best = pc; }
      }
      return best;
    };
    // Neighbors above/below a target from a specific group (or full pool)
    const neighborsOf = (target: number, group: number[]): { above: number[]; below: number[] } => {
      const src = group.length > 0 ? group : scaleSteps;
      const above: number[] = [];
      const below: number[] = [];
      for (const pc of src) {
        if (pc === target) continue;
        const distUp = ((pc - target) % edo + edo) % edo;
        const distDown = ((target - pc) % edo + edo) % edo;
        if (distUp > 0 && distUp <= edo / 2) above.push(pc);
        if (distDown > 0 && distDown <= edo / 2) below.push(pc);
      }
      above.sort((a, b) => ((a - target) % edo + edo) % edo - ((b - target) % edo + edo) % edo);
      below.sort((a, b) => ((target - a) % edo + edo) % edo - ((target - b) % edo + edo) % edo);
      return { above, below };
    };
    // Walk to next note in a group in a direction
    const nextIn = (from: number, dir: 1 | -1, group: number[]): number => {
      const src = group.length > 0 ? [...group].sort((a, b) => a - b) : scaleSteps;
      if (dir === 1) {
        for (const s of src) { if (((s - from) % edo + edo) % edo > 0 && ((s - from) % edo + edo) % edo <= edo / 2) return s; }
        return src[0];
      } else {
        for (let i = src.length - 1; i >= 0; i--) { if (((from - src[i]) % edo + edo) % edo > 0 && ((from - src[i]) % edo + edo) % edo <= edo / 2) return src[i]; }
        return src[src.length - 1];
      }
    };

    // Starting point
    let startIdx = Math.floor(Math.random() * ssLen);
    if (prevMelodyEnd !== undefined) {
      startIdx = nearestIdx(((prevMelodyEnd % edo) + edo) % edo);
    }
    const chordRootPc = chordPcs.length > 0 ? ((chordPcs[0] % edo) + edo) % edo : -1;
    const anchorIdx = chordRootPc >= 0 ? nearestIdx(chordRootPc) : startIdx;
    const dir = Math.random() < 0.5 ? 1 : -1;

    // The tense pool to use for decorative notes — prefers tense categories,
    // falls back to non-CT diatonic if no tense notes enabled
    const decorPool = tensePcs.length > 0 ? tensePcs
      : pool.filter(n => n.cat !== "ct").map(n => n.pc);
    // The stable pool for anchor/target notes — prefers CT, falls back to diatonic
    const anchorPool = ctPcs.length > 0 ? ctPcs : stablePcs;

    const pcs: number[] = [];

    // ── Bebop cells ──

    if (cellType === "approach") {
      // Pattern: [tense approach note] → [stable target], sequenced through targets
      // Each pair = 1 approach + 1 resolution. Targets walk through anchorPool.
      let cur = anchorPool.length > 0 ? nearestIn(anchorPool, poolAt(anchorIdx)) : poolAt(anchorIdx);
      while (pcs.length < length) {
        // Approach note: nearest tense note to the target
        const { above, below } = neighborsOf(cur, decorPool.length > 0 ? decorPool : scaleSteps);
        const neighbors = [...above.slice(0, 2), ...below.slice(0, 2)];
        if (neighbors.length > 0 && pcs.length < length) {
          pcs.push(neighbors[Math.floor(Math.random() * neighbors.length)]);
        }
        // Target resolution
        if (pcs.length < length) pcs.push(cur);
        // Advance to next stable target
        cur = nextIn(cur, dir, anchorPool.length > 0 ? anchorPool : scaleSteps);
      }

    } else if (cellType === "enclosure") {
      // Pattern: [upper neighbor] → [lower neighbor] → [target], sequenced
      // Neighbors are drawn from the available pool — respects user's note
      // category selection. When chromatic notes are enabled the enclosures
      // will naturally be tight (half-step); when only diatonic is enabled
      // they'll use diatonic neighbors (whole-step or larger).
      const encPool = decorPool.length > 0 ? decorPool : scaleSteps;
      let cur = anchorPool.length > 0 ? nearestIn(anchorPool, poolAt(anchorIdx)) : poolAt(anchorIdx);
      while (pcs.length < length) {
        const { above, below } = neighborsOf(cur, encPool);
        const upper = above.length > 0 ? above[0] : (cur + chromaticStep) % edo;
        const lower = below.length > 0 ? below[0] : ((cur - chromaticStep) % edo + edo) % edo;
        const startHigh = Math.random() < 0.5;
        if (pcs.length < length) pcs.push(startHigh ? upper : lower);
        if (pcs.length < length) pcs.push(startHigh ? lower : upper);
        if (pcs.length < length) pcs.push(cur);
        cur = nextIn(cur, dir, anchorPool.length > 0 ? anchorPool : scaleSteps);
      }

    } else if (cellType === "chromPass") {
      // Chromatic passing tones BETWEEN diatonic anchors.
      // Pattern: anchor → chromatic steps → next anchor → chromatic steps → …
      const anchors = anchorPool.length > 0 ? anchorPool : scaleSteps;
      let cur = nearestIn(anchors, poolAt(anchorIdx));
      let walkDir: 1 | -1 = dir;
      const stepSize = cellResolution === "microtonal" ? 1 : chromaticStep;
      // Emit the starting anchor
      pcs.push(cur);
      while (pcs.length < length) {
        const tgt = nextIn(cur, walkDir, anchors);
        // Walk chromatically from cur toward tgt
        let walkPc = cur;
        let safety = 0;
        while (walkPc !== tgt && pcs.length < length && safety++ < edo) {
          walkPc = ((walkPc + walkDir * stepSize) % edo + edo) % edo;
          pcs.push(walkPc);
        }
        // Arrived at anchor — advance
        cur = tgt;
        if (Math.random() < 0.4) walkDir = walkDir === 1 ? -1 : 1;
      }

    // ── Classical figure cells ──

    } else if (cellType === "passing") {
      // Stepwise motion BETWEEN chord tones. Pick two adjacent CTs as
      // endpoints, fill in between with pool steps, then advance to the
      // next CT pair. The passing notes come from the full pool (which
      // includes whatever categories the user has enabled).
      const sortedCt = [...anchorPool].sort((a, b) => a - b);
      if (sortedCt.length < 2) {
        // Not enough CTs — fall back to scalar walk
        let cur = poolAt(anchorIdx);
        while (pcs.length < length) {
          cur = nextIn(cur, dir, scaleSteps);
          pcs.push(cur);
        }
      } else {
        // Find starting CT nearest the anchor
        let ctIdx = 0;
        let bestD = edo;
        for (let i = 0; i < sortedCt.length; i++) {
          const d = Math.abs(pcDist(sortedCt[i], poolAt(anchorIdx)));
          if (d < bestD) { bestD = d; ctIdx = i; }
        }
        while (pcs.length < length) {
          const fromCt = sortedCt[((ctIdx % sortedCt.length) + sortedCt.length) % sortedCt.length];
          ctIdx += dir;
          const toCt = sortedCt[((ctIdx % sortedCt.length) + sortedCt.length) % sortedCt.length];
          // Walk stepwise from fromCt toward toCt through the pool
          let cur = fromCt;
          // If same CT (single chord tone), walk in current direction to add passing tones
          const walkDir: 1 | -1 = fromCt === toCt ? dir as 1 | -1 : (pcDist(fromCt, toCt) >= 0 ? 1 : -1);
          // Don't push fromCt if it was already the last note pushed
          if (pcs.length === 0 || pcs[pcs.length - 1] !== fromCt) {
            if (pcs.length < length) pcs.push(fromCt);
          }
          let safety = 0;
          while (cur !== toCt && pcs.length < length && safety++ < edo) {
            cur = nextIn(cur, walkDir, scaleSteps);
            pcs.push(cur);
          }
        }
      }

    } else if (cellType === "neighbor") {
      // Pattern: [anchor] → [neighbor away] → [anchor], advancing each cycle
      let anchor = anchorPool.length > 0 ? nearestIn(anchorPool, poolAt(anchorIdx)) : poolAt(anchorIdx);
      while (pcs.length < length) {
        // Anchor
        if (pcs.length < length) pcs.push(anchor);
        // Step away to the immediate upper or lower scale neighbor
        const { above, below } = neighborsOf(anchor, scaleSteps);
        const neighbors: number[] = [];
        if (above.length > 0) neighbors.push(above[0]);
        if (below.length > 0) neighbors.push(below[0]);
        if (neighbors.length > 0 && pcs.length < length) {
          pcs.push(neighbors[Math.floor(Math.random() * neighbors.length)]);
        }
        // Return to anchor
        if (pcs.length < length) pcs.push(anchor);
        // Advance anchor
        anchor = nextIn(anchor, dir, anchorPool.length > 0 ? anchorPool : scaleSteps);
      }

    } else if (cellType === "cambiata") {
      // Nota cambiata (Fux): step away → leap SAME direction (3rd) → step back (fill)
      // The dissonance is left by leap, then the gap is filled stepwise.
      let anchor = anchorPool.length > 0 ? nearestIn(anchorPool, poolAt(anchorIdx)) : poolAt(anchorIdx);
      const pool = decorPool.length > 0 ? decorPool : scaleSteps;
      while (pcs.length < length) {
        const { above, below } = neighborsOf(anchor, pool);
        if (above.length < 2 && below.length < 2) {
          if (pcs.length < length) pcs.push(anchor);
          anchor = nextIn(anchor, dir, scaleSteps);
          continue;
        }
        const goUp = above.length >= 2 && (below.length < 2 || Math.random() < 0.5);
        // Step away: nearest neighbor in chosen direction
        const stepNote = goUp ? above[0] : below[0];
        // Leap same direction: 2nd neighbor (≈ a 3rd from anchor)
        const leapNote = goUp ? above[1] : below[1];
        // Fill: step back from leapNote toward anchor
        const leapNbrs = neighborsOf(leapNote, pool);
        const fillNote = goUp
          ? (leapNbrs.below.length > 0 ? leapNbrs.below[0] : null)
          : (leapNbrs.above.length > 0 ? leapNbrs.above[0] : null);
        // step away
        if (pcs.length < length) pcs.push(stepNote);
        // leap same direction
        if (pcs.length < length) pcs.push(leapNote);
        // step back (fill)
        if (fillNote !== null && pcs.length < length) pcs.push(fillNote);
        // advance
        anchor = nextIn(anchor, dir, anchorPool.length > 0 ? anchorPool : scaleSteps);
      }

    // ── Bergonzi cells ──
    // All Bergonzi patterns need the full diatonic pool so that scale-degree
    // indices (0-6) map to real degrees instead of wrapping a tiny chord-tone pool.

    } else if (cellType === "digital" && vocabSteps.length >= 4) {
      const dPool = vocabSteps;
      const dLen = dPool.length;
      const dPoolAt = (idx: number): number =>
        dPool[((idx % dLen) + dLen) % dLen];
      // Base cells: 1235 (skip 4th), 1345 (skip 2nd), 1256 (skip 3-4), 1357 (thirds)
      const DIGITAL_BASES: number[][] = [[0,1,2,4], [0,2,3,4], [0,1,4,5], [0,2,4,6]];
      const base = DIGITAL_BASES[Math.floor(Math.random() * DIGITAL_BASES.length)];
      // Generate all 24 permutations of the chosen base cell
      const perms: number[][] = [];
      for (let a = 0; a < 4; a++)
        for (let b = 0; b < 4; b++)
          for (let c = 0; c < 4; c++)
            for (let d = 0; d < 4; d++)
              if (a !== b && a !== c && a !== d && b !== c && b !== d && c !== d)
                perms.push([base[a], base[b], base[c], base[d]]);
      const shape = perms[Math.floor(Math.random() * perms.length)];
      _lastDigitalShape = shape.map(s => s + 1).join("-");
      // Find anchor position in the diatonic pool
      const anchorPc = poolAt(anchorIdx);
      let dAnchor = 0;
      {
        let bestD = edo;
        for (let i = 0; i < dLen; i++) {
          const d = Math.abs(pcDist(dPool[i], anchorPc));
          if (d < bestD) { bestD = d; dAnchor = i; }
        }
      }
      let baseIdx = dAnchor;
      while (pcs.length < length) {
        for (let s = 0; s < shape.length && pcs.length < length; s++) {
          pcs.push(dPoolAt(baseIdx + dir * shape[s]));
        }
        baseIdx += dir;
      }

    } else if (cellType === "pentatonic" && vocabSteps.length >= 5) {
      const dPool = vocabSteps;
      const dLen = dPool.length;
      const dPoolAt = (idx: number): number =>
        dPool[((idx % dLen) + dLen) % dLen];
      const anchorPc = poolAt(anchorIdx);
      let dAnchor = 0;
      {
        let bestD = edo;
        for (let i = 0; i < dLen; i++) {
          const d = Math.abs(pcDist(dPool[i], anchorPc));
          if (d < bestD) { bestD = d; dAnchor = i; }
        }
      }
      const pentSize = Math.min(5, dLen);
      const spacing = dLen / pentSize;
      const pentNotes: number[] = [];
      for (let i = 0; i < pentSize; i++) {
        pentNotes.push(dPoolAt(dAnchor + Math.round(i * spacing)));
      }
      // Label pentatonic relative to chord root, not key root
      const chordRoot = chordPcs.length > 0 ? chordPcs[0] : 0;
      _lastPentatonicInfo = pentNotes.map(p => degreeName(((p - chordRoot) % edo + edo) % edo, edo)).join("-");
      let pi = 0;
      while (pcs.length < length) {
        pcs.push(pentNotes[((pi * dir) % pentSize + pentSize) % pentSize]);
        pi += dir;
      }

    } else if (cellType === "triadPair" && vocabSteps.length >= 6) {
      const dPool = vocabSteps;
      const dLen = dPool.length;
      const dPoolAt = (idx: number): number =>
        dPool[((idx % dLen) + dLen) % dLen];
      const anchorPc = poolAt(anchorIdx);
      let dAnchor = 0;
      {
        let bestD = edo;
        for (let i = 0; i < dLen; i++) {
          const d = Math.abs(pcDist(dPool[i], anchorPc));
          if (d < bestD) { bestD = d; dAnchor = i; }
        }
      }
      const t1 = [dPoolAt(dAnchor), dPoolAt(dAnchor + 2), dPoolAt(dAnchor + 4)];
      const t2 = [dPoolAt(dAnchor + 1), dPoolAt(dAnchor + 3), dPoolAt(dAnchor + 5)];
      _lastTriadPairInfo = `${t1.map(p => degreeName(p, edo)).join("-")} | ${t2.map(p => degreeName(p, edo)).join("-")}`;
      const ascending = Math.random() > 0.4;
      const a1 = ascending ? t1 : [...t1].reverse();
      const a2 = ascending ? t2 : [...t2].reverse();
      let useFirst = true;
      let ti = 0;
      while (pcs.length < length) {
        const triad = useFirst ? a1 : a2;
        pcs.push(triad[ti % triad.length]);
        ti++;
        if (ti >= 3) { ti = 0; useFirst = !useFirst; }
      }

    } else if (cellType === "hexatonic" && vocabSteps.length >= 6) {
      const dPool = vocabSteps;
      const dLen = dPool.length;
      const dPoolAt = (idx: number): number =>
        dPool[((idx % dLen) + dLen) % dLen];
      const anchorPc = poolAt(anchorIdx);
      let dAnchor = 0;
      {
        let bestD = edo;
        for (let i = 0; i < dLen; i++) {
          const d = Math.abs(pcDist(dPool[i], anchorPc));
          if (d < bestD) { bestD = d; dAnchor = i; }
        }
      }
      const hexSize = Math.min(6, dLen);
      const spacing = dLen / hexSize;
      const hexNotes: number[] = [];
      for (let i = 0; i < hexSize; i++) {
        hexNotes.push(dPoolAt(dAnchor + Math.round(i * spacing)));
      }
      _lastHexatonicInfo = hexNotes.map(p => degreeName(p, edo)).join("-");
      let hi = 0;
      while (pcs.length < length) {
        pcs.push(hexNotes[((hi * dir) % hexSize + hexSize) % hexSize]);
        hi += dir;
      }

    } else if (cellType === "intervallic" && vocabSteps.length >= 2) {
      // Target real EDO-step intervals for 3rds, 4ths, 5ths rather than
      // pool-index skips, so intervallic patterns produce wide leaps even
      // when the pool is small (e.g. chord-tones-only triads).
      const dPool = vocabSteps;
      const dLen = dPool.length;
      const iv = getEDOIntervals(edo);
      // Target intervals in EDO steps: minor 3rd, major 3rd, perfect 4th, perfect 5th
      const intervalTargets = [
        { steps: iv.m3, name: "m3" },
        { steps: iv.M3, name: "M3" },
        { steps: iv.P4, name: "P4" },
        { steps: iv.P5, name: "P5" },
      ];
      const chosen = intervalTargets[Math.floor(Math.random() * intervalTargets.length)];
      const zigzag = Math.random() > 0.5;
      _lastIntervallicInfo = `${chosen.name}${zigzag ? " zigzag" : ""}`;

      // Find the pool note nearest to (current + interval) in the desired direction
      const nearestPoolByEdo = (fromPc: number, edoInterval: number): number => {
        const targetPc = ((fromPc + edoInterval) % edo + edo) % edo;
        let bestIdx = 0, bestD = edo;
        for (let i = 0; i < dLen; i++) {
          const d = Math.abs(pcDist(dPool[i], targetPc));
          if (d < bestD) { bestD = d; bestIdx = i; }
        }
        return dPool[bestIdx];
      };

      let curPc = poolAt(anchorIdx);
      while (pcs.length < length) {
        const d = zigzag ? (pcs.length % 2 === 0 ? dir : -dir) : dir;
        const interval = d * chosen.steps;
        curPc = nearestPoolByEdo(curPc, interval);
        pcs.push(curPc);
      }

    } else if (cellType === "pedal") {
      // Pedal / Axis: a fixed anchor note alternates with orbiting notes.
      // Pattern: [anchor, orbit1, anchor, orbit2, anchor, orbit3, ...]
      // The anchor is a chord tone that stays fixed; orbit notes walk
      // through the pool (stable or tense depending on enabled categories),
      // producing ostinato / pedal-point / pivot shapes.
      const anchor = anchorPool.length > 0
        ? nearestIn(anchorPool, poolAt(anchorIdx))
        : poolAt(anchorIdx);
      // Orbit pool: all available notes except the anchor itself
      const orbitSrc = scaleSteps.filter(pc => pc !== anchor);
      if (orbitSrc.length === 0) {
        // Degenerate: only one note available — just repeat
        while (pcs.length < length) pcs.push(anchor);
      } else {
        let orbitIdx = Math.floor(Math.random() * orbitSrc.length);
        const orbitDir = dir;
        while (pcs.length < length) {
          // Anchor
          pcs.push(anchor);
          if (pcs.length >= length) break;
          // Orbit note — walk through orbit pool
          pcs.push(orbitSrc[((orbitIdx % orbitSrc.length) + orbitSrc.length) % orbitSrc.length]);
          orbitIdx += orbitDir;
        }
      }

    } else if (cellType === "arpStep" && scaleSteps.length >= 3) {
      // Arp → Step: arpeggiate up through chord tones, then scalar fill
      // back down (or vice versa). Produces the classic "leap through
      // triad then stepwise descent" shape found in Bach inventions,
      // Chopin etudes, smooth jazz runs, and pop melodies.
      const arpPool = anchorPool.length >= 2 ? anchorPool : stablePcs.length >= 2 ? stablePcs : scaleSteps;
      // Sort arp pool ascending for clean arpeggiation
      const sortedArp = [...arpPool].sort((a, b) =>
        ((a - poolAt(anchorIdx)) % edo + edo) % edo - ((b - poolAt(anchorIdx)) % edo + edo) % edo
      );
      const goUp = Math.random() < 0.5;
      const arpNotes = goUp ? sortedArp : [...sortedArp].reverse();
      while (pcs.length < length) {
        // Phase 1: arpeggiate (2-4 notes from chord tones)
        const arpLen = Math.min(arpNotes.length, Math.max(2, Math.ceil(length * 0.4)));
        for (let a = 0; a < arpLen && pcs.length < length; a++) {
          pcs.push(arpNotes[a % arpNotes.length]);
        }
        // Phase 2: scalar fill in the opposite direction back toward start
        const fillDir: 1 | -1 = goUp ? -1 : 1;
        let cur = pcs[pcs.length - 1];
        const target = pcs[pcs.length - arpLen]; // where we started the arp
        let safety = 0;
        while (pcs.length < length && safety++ < edo * 2) {
          cur = nextIn(cur, fillDir, scaleSteps);
          pcs.push(cur);
          // Stop fill early if we've returned near the arp start
          if (cur === target) break;
        }
      }

    } else {
      // Fallback: sequential walk through pool
      let idx = startIdx;
      while (pcs.length < length) {
        idx += dir;
        pcs.push(poolAt(idx));
      }
    }

    // Octave placement (Pass 4 inline)
    const result: number[] = [];
    let prevAbs = prevMelodyEnd ?? pcs[0];
    let centerPitch = prevAbs;
    for (let i = 0; i < length; i++) {
      const pc = pcs[i];
      if (i === 0 && prevMelodyEnd !== undefined) {
        const oct = pickOctave(prevAbs, pc, edo, Math.min(angularity, 0.3));
        const abs = pc + oct * edo;
        result.push(abs);
        prevAbs = abs;
        centerPitch = abs;
        continue;
      }
      if (i === 0) {
        result.push(pc);
        prevAbs = pc;
        centerPitch = pc;
        continue;
      }
      const oct = pickOctave(prevAbs, pc, edo, angularity < 0.5 ? 0 : angularity);
      let abs = pc + oct * edo;
      const cBias = contourBias(contour, i, length);
      if (Math.abs(cBias) > 0.3) {
        const wantsUp = cBias > 0;
        if ((wantsUp && abs <= prevAbs) || (!wantsUp && abs >= prevAbs)) {
          const altAbs = pc + (wantsUp ? oct + 1 : oct - 1) * edo;
          if (Math.abs(altAbs - centerPitch) <= edo * 1.5) abs = altAbs;
        }
      }
      if (i >= 3 && Math.abs(abs - centerPitch) > edo * 1.2) {
        const closerAbs = pc + (abs > centerPitch ? oct - 1 : oct + 1) * edo;
        if (Math.abs(closerAbs - centerPitch) < Math.abs(abs - centerPitch)) abs = closerAbs;
      }
      result.push(abs);
      prevAbs = abs;
      centerPitch = centerPitch * 0.8 + abs * 0.2;
    }
    return result;
  }

  // ══════════════════════════════════════════════════════════════════════
  // PASS 1: Role assignment
  // ══════════════════════════════════════════════════════════════════════

  const mw = metricWeights ?? defaultMetricWeights(length);
  const sortedMw = [...mw].sort((a, b) => b - a);
  // When approach/enclosure is enabled, use fewer targets to leave gaps for
  // connector notes. Without them, be generous with targets.
  const wantsGaps = useApproach || useEnclosure || (vocab && vocab.size > 0);
  const targetFraction = wantsGaps ? 0.25 : 0.4;
  // Minimum targets: always at least 2 (first + last), but for approach with
  // short patterns we want exactly those 2 so every other position is a gap.
  // Figures like cambiata (3 notes) and neighbor (2 notes) need room inside
  // each gap.  When one of these is the active vocab and the pattern is short,
  // we only pin the FIRST position as a target so the figure can fill all the
  // way to the end and resolve itself onto a chord tone.
  const needsWideGap = vocab && (vocab.has("cambiata") || vocab.has("neighbor"));
  const minTargets = needsWideGap && length <= 5 ? 1 : 2;
  const cutoff = Math.max(minTargets, Math.floor(sortedMw.length * targetFraction));
  const targetThreshold = sortedMw[Math.min(cutoff - 1, sortedMw.length - 1)];

  const isTarget: boolean[] = mw.map((w, i) =>
    i === 0 || i === length - 1 || w >= targetThreshold
  );
  if (length >= 2) { isTarget[0] = true; }
  // Only pin the last position as a target when we don't need wide gaps
  if (length >= 2 && !needsWideGap) { isTarget[length - 1] = true; }

  // If approach/enclosure is on and we have too many targets, demote the
  // weakest interior ones to leave room for connectors.
  if (wantsGaps) {
    let targetCount = isTarget.filter(Boolean).length;
    const maxTargets = Math.max(minTargets, Math.ceil(length * targetFraction));
    if (targetCount > maxTargets) {
      // Score interior targets by metric weight; demote weakest first
      const interior = isTarget
        .map((t, i) => ({ i, w: mw[i], t }))
        .filter(x => x.t && x.i !== 0 && x.i !== length - 1)
        .sort((a, b) => a.w - b.w);
      for (const x of interior) {
        if (targetCount <= maxTargets) break;
        isTarget[x.i] = false;
        targetCount--;
      }
    }
  }

  const targetPositions = isTarget.map((t, i) => t ? i : -1).filter(i => i >= 0);

  // ══════════════════════════════════════════════════════════════════════
  // PASS 2: Target generation with contour + guide-tone awareness
  // ══════════════════════════════════════════════════════════════════════

  const pcs: (number | null)[] = new Array(length).fill(null);
  const usedPcs = new Set<number>();

  let prevTargetPc: number | null = prevMelodyEnd !== undefined
    ? ((prevMelodyEnd % edo) + edo) % edo
    : null;

  for (let ti = 0; ti < targetPositions.length; ti++) {
    const pos = targetPositions[ti];
    let avail = allowRepeats
      ? effectiveTargetPool
      : effectiveTargetPool.filter(n => !usedPcs.has(n.pc));
    if (avail.length === 0) {
      // Pool depleted: allow repeats as graceful fallback
      avail = effectiveTargetPool;
    }
    if (avail.length === 0) {
      const fallback = pool.length > 0 ? pool : effectiveTargetPool;
      if (fallback.length > 0) {
        const pick = weightedPick(fallback, fallback.map(n => n.cWeight));
        pcs[pos] = pick.pc;
        if (!allowRepeats) usedPcs.add(pick.pc);
        prevTargetPc = pick.pc;
      }
      continue;
    }

    const cBias = contourBias(contour, pos, length);

    // ── Unified tension model ──
    // Three forces contribute to a single stability target (0 = maximum tension, 1 = maximum stability):
    //   1. Bias (user control): 0 = inside/stable, 1 = outside/tense
    //   2. Metric weight (rhythm): high = stable position, low = passing
    //   3. Phrase arc (cross-segment): opening/closing = stable, middle = tense
    const posWeight = mw[pos] ?? 0.5;
    const arcStability = totalSegments >= 3
      ? (segmentIndex === totalSegments - 1 ? 0.85  // final: very stable
        : segmentIndex === 0 ? 0.7                   // opening: stable
        : 0.4)                                        // middle: allow color
      : 0.6;
    // Combine: metric weight and arc pull toward stability, bias pulls toward tension
    const stability = (posWeight * 0.4 + arcStability * 0.3 + (1 - bias) * 0.3);
    // stability range ~0.1 (very tense) to ~0.9 (very stable)

    const weights = avail.map(n => {
      // Base weight from category
      let w = n.cWeight;
      // Stability-aware boosting: CTs boosted proportional to stability,
      // outer categories boosted inversely
      if (n.cat === "ct") w *= 1 + stability * 3.0;          // range 1.3–3.7
      else if (n.cat === "diatonic") w *= 1 + stability * 1.0; // mild stable boost
      else w *= 1 + (1 - stability) * 1.5;                    // tension categories boosted when unstable
      // Last position: strong CT pull for resolution
      if (pos === length - 1 && n.cat === "ct") w *= 2.5;
      // Last position + next chord known: strongly prefer notes a half-step
      // from a chord tone of the next chord (voice-leading preparation).
      if (pos === length - 1 && nextChordPcs && nextChordPcs.length > 0) {
        const nextCtSet = new Set(nextChordPcs.map(p => ((p % edo) + edo) % edo));
        // Check if this PC is a half-step (1-2 EDO steps) from any next CT
        for (const nct of nextCtSet) {
          const d = Math.abs(pcDist(n.pc, nct));
          if (d >= 1 && d <= 2) { w *= 3.0; break; } // strong voice-leading bonus
          if (d === 0) { w *= 2.0; break; }           // common tone bonus
        }
      }
      // Guide-tone bonus: first target prefers 3rds/7ths when voice-leading
      if (ti === 0 && prevMelodyEnd !== undefined && guideTonePcs.has(n.pc)) w *= 1.8;

      if (prevTargetPc !== null) {
        const dir = pcDist(prevTargetPc, n.pc); // signed
        const dist = Math.abs(dir);
        const normDist = dist / (edo / 2);

        // Block immediate repetition of the same PC
        if (dist === 0) w = 0;

        if (angularity < 0.5) {
          // Stepwise: exponential decay by interval size.
          // All notes penalised by distance; CTs get a softer curve
          // so nearby CTs are still preferred but distant ones are
          // discouraged, preventing arpeggiated/pentatonic leaps.
          if (dist <= leapThreshold) {
            const stepW = 1 / (1 + dist);
            w *= n.cat === "ct" ? Math.sqrt(stepW) : stepW;
          } else {
            const leapW = Math.exp(-(dist - leapThreshold) * 2.5);
            w *= n.cat === "ct" ? Math.pow(leapW, 0.4) : leapW;
          }
        }

        // Contour: bias toward the direction the shape wants
        if (cBias !== 0 && dist > 0) {
          const goingUp = dir > 0;
          const wantsUp = cBias > 0;
          if (goingUp === wantsUp) w *= 1 + Math.abs(cBias) * 1.5;
          else w *= Math.max(0.15, 1 - Math.abs(cBias) * 0.8);
        }

        // Context-sensitive modifier: saturation, debt, momentum
        if (predictability > 0) {
          w *= contextWeightModifier(melCtx, n.cat, dir, predictability);
        }
      }
      return w;
    });

    // If all weights zero (only option is a repeat), pick farthest non-prev note
    let picked: typeof avail[0];
    if (weights.every(w => w === 0)) {
      const nonPrev = avail.filter(n => n.pc !== prevTargetPc);
      if (nonPrev.length > 0) {
        const byDist = nonPrev.sort((a, b) => Math.abs(pcDist(prevTargetPc!, b.pc)) - Math.abs(pcDist(prevTargetPc!, a.pc)));
        picked = byDist[0];
      } else {
        picked = avail[Math.floor(Math.random() * avail.length)]; // truly no choice
      }
    } else {
      picked = weightedPick(avail, weights);
    }
    pcs[pos] = picked.pc;
    if (!allowRepeats) usedPcs.add(picked.pc);
    // Update melody context with the picked note
    updateMelodyContext(melCtx, picked.cat, prevTargetPc !== null ? pcDist(prevTargetPc, picked.pc) : 0);
    prevTargetPc = picked.pc;
  }

  // ══════════════════════════════════════════════════════════════════════
  // PASS 3: Connector filling
  // ══════════════════════════════════════════════════════════════════════

  type Gap = {
    start: number; end: number;
    prevTargetPc: number | null; nextTargetPc: number | null;
  };
  const gaps: Gap[] = [];
  let lastFilledIdx = -1;
  for (let i = 0; i < length; i++) {
    if (pcs[i] !== null) {
      if (lastFilledIdx >= 0 && i - lastFilledIdx > 1) {
        gaps.push({
          start: lastFilledIdx + 1, end: i - 1,
          prevTargetPc: pcs[lastFilledIdx], nextTargetPc: pcs[i],
        });
      }
      lastFilledIdx = i;
    }
  }
  // Trailing gap: positions after the last target that still need filling.
  // nextTargetPc is null — the figure should resolve onto a chord tone.
  if (lastFilledIdx >= 0 && lastFilledIdx < length - 1) {
    gaps.push({
      start: lastFilledIdx + 1, end: length - 1,
      prevTargetPc: pcs[lastFilledIdx], nextTargetPc: null,
    });
  }

  // Motivic cell: interval pattern captured from the first filled segment
  // (includes target boundaries for 3-4 interval cells)
  let motivicCell: number[] | null = null;
  let gapIndex = 0;

  // Tension-release modifier
  const tensionWeight = (pc: number, prevPc: number): number => {
    if (!hasChordContext || chordPcs.length === 0) return 1;
    const dist = Math.abs(pcDist(pc, prevPc));
    if (dist > 2) return 1;
    const prevIsCt = ctSet.has(((prevPc % edo) + edo) % edo);
    const thisIsCt = ctSet.has(((pc % edo) + edo) % edo);
    if (!prevIsCt && thisIsCt) return 1 + 2.0 * (1 - bias);
    if (prevIsCt && !thisIsCt) return 1 + 0.8 * bias;
    return 1;
  };

  const fillFree = (prevPc: number) => {
    let avail = allowRepeats ? pool : pool.filter(n => !usedPcs.has(n.pc));
    if (avail.length === 0) avail = pool;
    // Filter out immediate repetition — hard exclude, not just penalty
    const nonRepeat = avail.filter(n => n.pc !== prevPc);
    if (nonRepeat.length > 0) avail = nonRepeat;
    const weights = avail.map(n => {
      let w = n.cWeight * tensionWeight(n.pc, prevPc);
      const dist = Math.abs(pcDist(prevPc, n.pc));
      if (angularity < 0.5) {
        if (dist <= leapThreshold) {
          const stepW = 1 / (1 + dist);
          w *= n.cat === "ct" ? Math.sqrt(stepW) : stepW;
        } else {
          const leapW = Math.exp(-(dist - leapThreshold) * 2.5);
          w *= n.cat === "ct" ? Math.pow(leapW, 0.4) : leapW;
        }
      }
      // Context-sensitive modifier in connectors too
      if (predictability > 0) {
        w *= contextWeightModifier(melCtx, n.cat, pcDist(prevPc, n.pc), predictability);
      }
      return w;
    });
    // If all weights are zero, fall back to farthest-from-prev (maximize movement)
    if (weights.every(w => w === 0)) {
      if (avail.length === 0) return prevPc; // no notes available at all
      const byDist = avail.map(n => ({ n, d: Math.abs(pcDist(prevPc, n.pc)) })).sort((a, b) => b.d - a.d);
      const picked = byDist[0].n;
      if (!allowRepeats) usedPcs.add(picked.pc);
      updateMelodyContext(melCtx, picked.cat, pcDist(prevPc, picked.pc));
      return picked.pc;
    }
    const picked = weightedPick(avail, weights);
    if (!allowRepeats) usedPcs.add(picked.pc);
    updateMelodyContext(melCtx, picked.cat, pcDist(prevPc, picked.pc));
    return picked.pc;
  };

  // Try to fill a gap with a scalar run from gPrev toward gNext
  const tryScalarFill = (gap: Gap, bypassCat = false): boolean => {
    const { prevTargetPc: gPrev, nextTargetPc: gNext } = gap;
    if (gPrev === null || gNext === null) return false;
    const gapLen = gap.end - gap.start + 1;
    const dir = pcDist(gPrev, gNext);
    if (dir === 0 || Math.abs(dir) > gapLen + 2) return false; // too far for scalar

    const stepDir: 1 | -1 = dir > 0 ? 1 : -1;
    const runPcs: number[] = [];
    let cur = gPrev;
    const stepFn = bypassCat ? nextVocabStep : nextScaleStep;
    for (let j = 0; j < gapLen; j++) {
      const next = stepFn(cur, stepDir);
      if (next === null) return false;
      // Wrap-aware: check we're moving toward gNext, not away
      const remaining = Math.abs(pcDist(next, gNext));
      if (j < gapLen - 1 && remaining === 0) break; // arrived early
      if (!bypassCat && !categories.has(classifyPc(next))) return false;
      if (!allowRepeats && usedPcs.has(next)) return false;
      runPcs.push(next);
      cur = next;
    }
    if (runPcs.length === 0) return false;
    for (let j = 0; j < runPcs.length && gap.start + j <= gap.end; j++) {
      pcs[gap.start + j] = runPcs[j];
      if (!allowRepeats) usedPcs.add(runPcs[j]);
    }
    // Fill any remainder
    let prev = runPcs[runPcs.length - 1];
    for (let pos = gap.start + runPcs.length; pos <= gap.end; pos++) {
      pcs[pos] = fillFree(prev);
      prev = pcs[pos]!;
    }
    return true;
  };

  // Smooth fill: walk from prevPc toward targetPc using scale steps, falling
  // back to fillFree only when the scale walk can't make progress.
  // On the last position, ensures the interval to the next placed note (afterPc)
  // stays within a step to prevent boundary leaps.
  const fillSmooth = (startPos: number, endPos: number, prevPc: number, targetPc: number | null, afterPc?: number | null, bypassCat = false) => {
    const catOk = (pc: number) => bypassCat || categories.has(classifyPc(pc));
    const stepFn = bypassCat ? nextVocabStep : nextScaleStep;
    let cur = prevPc;
    for (let pos = startPos; pos <= endPos; pos++) {
      if (pcs[pos] !== null) { cur = pcs[pos]!; continue; }

      // Last position: ensure we arrive within a step of afterPc (the next target)
      if (pos === endPos && afterPc != null) {
        const distToAfter = Math.abs(pcDist(cur, afterPc));
        if (distToAfter > leapThreshold) {
          // We're too far — pick the scale step closest to afterPc
          const dir = pcDist(cur, afterPc);
          const step = stepFn(cur, dir > 0 ? 1 : -1);
          if (step !== null && catOk(step) && (allowRepeats || !usedPcs.has(step))) {
            pcs[pos] = step;
            if (!allowRepeats) usedPcs.add(step);
            cur = step;
            continue;
          }
        }
      }

      if (targetPc !== null) {
        const dir = pcDist(cur, targetPc);
        if (dir !== 0) {
          const step = stepFn(cur, dir > 0 ? 1 : -1);
          if (step !== null && catOk(step) && (allowRepeats || !usedPcs.has(step))) {
            pcs[pos] = step;
            if (!allowRepeats) usedPcs.add(step);
            cur = step;
            continue;
          }
        }
      }
      pcs[pos] = fillFree(cur);
      cur = pcs[pos]!;
    }
  };

  for (const gap of gaps) {
    const gapLen = gap.end - gap.start + 1;
    const { prevTargetPc: gPrev, nextTargetPc: _gNextRaw } = gap;
    gapIndex++;

    if (gPrev === null) {
      let prev = 0;
      for (let pos = gap.start; pos <= gap.end; pos++) {
        pcs[pos] = fillFree(prev);
        prev = pcs[pos]!;
      }
      continue;
    }
    // When _gNextRaw is null (trailing gap — no final target pinned), pick
    // a nearby chord tone as the resolution target so figures have forward
    // motion toward a musically sensible destination.
    const gNext: number = _gNextRaw ?? (() => {
      if (hasChordContext && chordPcs.length > 0) {
        const sorted = chordPcs
          .map(cp => ({ pc: ((cp % edo) + edo) % edo, d: Math.abs(pcDist(gPrev, ((cp % edo) + edo) % edo)) }))
          .filter(x => x.d > 0)
          .sort((a, b) => a.d - b.d);
        return sorted.length > 0 ? sorted[0].pc : gPrev;
      }
      return gPrev;
    })();

    // ── Strategy selection (no vocab — all vocab handled in cell fast path) ──
    const cellHasLeap = motivicCell && angularity < 0.5
      && motivicCell.some(iv => Math.abs(iv) > leapThreshold);
    const targetDist = Math.abs(pcDist(gPrev, gNext));
    const canMotivic = motivicCell && !cellHasLeap && motivicCell.length <= gapLen + 1;
    const canScalar = targetDist > 0 && targetDist <= gapLen + 2;

    let stratIdx: number;
    if (canMotivic && Math.random() < 0.4) {
      stratIdx = 0;
    } else if (canScalar && Math.random() < 0.6) {
      stratIdx = 1;
    } else {
      stratIdx = 4;
    }

    // ── Strategy 0: Motivic repetition ──
    if (stratIdx === 0 && canMotivic && motivicCell) {
      const mc = motivicCell;
      const variants = [mc, mc.map(iv => -iv)];
      let used = false;
      for (const cell of variants) {
        let cur = gPrev;
        let valid = true;
        const motifPcs: number[] = [];
        for (let j = 0; j < Math.min(cell.length, gapLen); j++) {
          const next = ((cur + cell[j]) % edo + edo) % edo;
          if (!categories.has(classifyPc(next))) { valid = false; break; }
          if (!allowRepeats && usedPcs.has(next)) { valid = false; break; }
          if (angularity < 0.5 && Math.abs(cell[j]) > leapThreshold) { valid = false; break; }
          motifPcs.push(next);
          cur = next;
        }
        if (valid && motifPcs.length >= 2) {
          for (let j = 0; j < motifPcs.length; j++) {
            pcs[gap.start + j] = motifPcs[j];
            if (!allowRepeats) usedPcs.add(motifPcs[j]);
          }
          fillSmooth(gap.start + motifPcs.length, gap.end, motifPcs[motifPcs.length - 1], gNext, gNext);
          used = true;
          break;
        }
      }
      if (used) continue;
    }

    // ── Strategy 1: Scalar passing fill ──
    if (stratIdx === 1 && canScalar) {
      if (tryScalarFill(gap)) {
        if (!motivicCell && gapLen >= 2) {
          const cellPcs = [gPrev];
          for (let p = gap.start; p <= gap.end; p++) if (pcs[p] !== null) cellPcs.push(pcs[p]!);
          cellPcs.push(gNext);
          if (cellPcs.length >= 4) {
            motivicCell = [];
            for (let j = 1; j < cellPcs.length; j++) motivicCell.push(pcDist(cellPcs[j - 1], cellPcs[j]));
          }
        }
        continue;
      }
    }

    // ── Strategy 4: Free fill with tension-release (fallback) ──
    let prev = gPrev;
    for (let pos = gap.start; pos <= gap.end; pos++) {
      pcs[pos] = fillFree(prev);
      prev = pcs[pos]!;
    }

    // Capture motivic cell from first gap that has enough notes
    if (!motivicCell && gapLen >= 2) {
      const cellPcs = [gPrev];
      for (let pos = gap.start; pos <= gap.end; pos++) {
        if (pcs[pos] !== null) cellPcs.push(pcs[pos]!);
      }
      cellPcs.push(gNext);
      if (cellPcs.length >= 4) {
        motivicCell = [];
        for (let j = 1; j < cellPcs.length; j++) motivicCell.push(pcDist(cellPcs[j - 1], cellPcs[j]));
      }
    }
  }

  // Safety: fill any remaining nulls
  for (let i = 0; i < length; i++) {
    if (pcs[i] === null) {
      const prev = i > 0 && pcs[i - 1] !== null ? pcs[i - 1]! : 0;
      pcs[i] = fillFree(prev);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // PASS 4: Octave placement with contour-aware direction
  // ══════════════════════════════════════════════════════════════════════

  const result: number[] = [];
  let prevAbs = prevMelodyEnd ?? pcs[0]!;
  let centerPitch = prevAbs;

  for (let i = 0; i < length; i++) {
    const pc = pcs[i]!;

    if (i === 0 && prevMelodyEnd !== undefined) {
      const oct = pickOctave(prevAbs, pc, edo, Math.min(angularity, 0.3));
      const abs = pc + oct * edo;
      result.push(abs);
      prevAbs = abs;
      centerPitch = abs;
      continue;
    }
    if (i === 0) {
      result.push(pc);
      prevAbs = pc;
      centerPitch = pc;
      continue;
    }

    let oct = pickOctave(prevAbs, pc, edo, angularity < 0.5 ? 0 : angularity);
    let abs = pc + oct * edo;

    // Contour-aware octave bias: nudge octave choice to match phrase direction.
    // In stepwise mode: only nudge when the alternative is still within a step
    // (prevents leaps but allows the melody to actually ascend/descend in register).
    // In leap mode: freely override octave for contour.
    const cBias = contourBias(contour, i, length);
    if (Math.abs(cBias) > 0.3) {
      const wantsUp = cBias > 0;
      const isUp = abs > prevAbs;
      if (wantsUp !== isUp) {
        const altOct = wantsUp ? oct + 1 : oct - 1;
        const altAbs = pc + altOct * edo;
        const altInterval = Math.abs(altAbs - prevAbs);
        if (angularity < 0.5) {
          // Stepwise: only allow contour nudge if the alt stays within a step
          if (altInterval <= leapThreshold && Math.abs(altAbs - centerPitch) <= edo * 1.5) {
            abs = altAbs;
          }
        } else {
          // Leap mode: allow if within reasonable range
          if (Math.abs(altAbs - centerPitch) <= edo * 1.5) {
            abs = altAbs;
          }
        }
      }
    }

    // Registral pull: after 3 notes, discourage drifting
    if (i >= 3 && Math.abs(abs - centerPitch) > edo * 1.2) {
      const closerOct = abs > centerPitch ? oct - 1 : oct + 1;
      const closerAbs = pc + closerOct * edo;
      if (Math.abs(closerAbs - centerPitch) < Math.abs(abs - centerPitch)) {
        abs = closerAbs;
      }
    }

    // Leap recovery
    if (result.length >= 2) {
      const prevInterval = result[result.length - 1] - result[result.length - 2];
      if (Math.abs(prevInterval) >= leapThreshold) {
        const thisInterval = abs - prevAbs;
        const isOpposite = (prevInterval > 0 && thisInterval < 0)
                        || (prevInterval < 0 && thisInterval > 0);
        if (!isOpposite) {
          const flipOct = thisInterval > 0 ? oct - 1 : oct + 1;
          const flipAbs = pc + flipOct * edo;
          const flipInterval = flipAbs - prevAbs;
          const flipIsOpp = (prevInterval > 0 && flipInterval < 0)
                         || (prevInterval < 0 && flipInterval > 0);
          if (flipIsOpp && Math.abs(flipInterval) <= leapThreshold * 2) {
            abs = flipAbs;
          }
        }
      }
    }

    result.push(abs);
    prevAbs = abs;
    if (i < 4) {
      centerPitch = result.reduce((a, b) => a + b, 0) / result.length;
    }
  }

  return result;
}

/**
 * Generate a counterpoint voice against an existing melody (cantus firmus)
 * using species counterpoint techniques.
 *
 * Two-pass approach:
 *   Pass 1 — Build a diatonic scale-step skeleton that moves in contrary
 *            motion to the soprano, creating real melodic shape.
 *   Pass 2 — Refine each note for consonance with the cantus firmus,
 *            parallel-interval avoidance, and voice-crossing checks,
 *            only substituting when the skeleton note violates a rule.
 */
export function generateCounterpoint(
  soprano: number[],
  chordPcs: number[],
  edo: number,
  categories: Set<NoteCategory>,
  _bias: number,
  tonicRoot: number = 0,
  tonality: Tonality = "major",
  /** Voice index: 1 = first voice below melody, 2 = second, 3 = third */
  voiceIndex: number = 1,
  existingVoices: number[][] = [],
): number[] {
  if (soprano.length === 0) return [];

  const dm = getDegreeMap(edo);
  const P5 = dm["5"] ?? Math.round(edo * 7 / 12);
  const P4 = dm["4"] ?? Math.round(edo * 5 / 12);
  const M3 = dm["3"] ?? Math.round(edo * 4 / 12);
  const m3 = dm["b3"] ?? Math.round(edo * 3 / 12);
  const M6 = dm["6"] ?? Math.round(edo * 9 / 12);
  const m6 = dm["b6"] ?? Math.round(edo * 8 / 12);
  const M2 = dm["2"] ?? Math.round(edo * 2 / 12);

  const isPerfect = (interval: number): boolean => {
    const norm = ((interval % edo) + edo) % edo;
    return norm === 0 || norm === P5 || norm === edo - P5;
  };
  const isImperfect = (interval: number): boolean => {
    const norm = ((interval % edo) + edo) % edo;
    return norm === M3 || norm === m3 || norm === M6 || norm === m6
        || norm === edo - M3 || norm === edo - m3;
  };
  const isConsonant = (interval: number): boolean => isPerfect(interval) || isImperfect(interval);

  // Build sorted diatonic scale for stepwise walking
  const classifyPc = (pc: number): NoteCategory =>
    classifyNoteCategory(pc, chordPcs, edo, tonicRoot, tonality);
  const availPcs = Array.from({ length: edo }, (_, i) => i)
    .filter(pc => categories.has(classifyPc(pc)));
  const diatonicPcs = Array.from({ length: edo }, (_, i) => i)
    .filter(pc => {
      const cat = classifyPc(pc);
      return cat === "ct" || cat === "diatonic";
    }).sort((a, b) => a - b);
  if (diatonicPcs.length === 0) return soprano.map(() => soprano[0] - voiceIndex * edo);
  const ctSet = new Set(chordPcs.map(p => ((p % edo) + edo) % edo));
  const allVoices = [soprano, ...existingVoices];

  // ── Helpers for walking the diatonic scale by absolute pitch ──
  const dLen = diatonicPcs.length;
  /** Find the diatonic scale index + octave closest to an absolute pitch. */
  const toDiatonic = (abs: number): { idx: number; oct: number } => {
    const oct = Math.floor(abs / edo);
    const pc = ((abs % edo) + edo) % edo;
    let bestIdx = 0, bestD = edo;
    for (let j = 0; j < dLen; j++) {
      const d = Math.min(Math.abs(diatonicPcs[j] - pc), edo - Math.abs(diatonicPcs[j] - pc));
      if (d < bestD) { bestD = d; bestIdx = j; }
    }
    return { idx: bestIdx, oct };
  };
  /** Convert diatonic index + octave back to absolute pitch. */
  const fromDiatonic = (idx: number, oct: number): number => {
    const wrappedIdx = ((idx % dLen) + dLen) % dLen;
    const octAdj = Math.floor(idx / dLen) - (idx < 0 ? 1 : 0);
    return diatonicPcs[wrappedIdx] + (oct + (idx >= 0 ? octAdj : octAdj + 1)) * edo;
  };

  // ── Register target ──
  const sopranoMedian = soprano.reduce((a, b) => a + b, 0) / soprano.length;
  const targetCenter = sopranoMedian - voiceIndex * edo;

  // ── Pass 1: Build melodic skeleton via contrary motion ──
  // Start on a consonant interval, then walk by step mostly contrary to soprano.
  const skeleton: number[] = [];

  // Pick starting note: best imperfect consonance near target register
  {
    let best = targetCenter, bestS = -Infinity;
    for (const pc of diatonicPcs) {
      const base = pc + Math.floor(targetCenter / edo) * edo;
      for (const oc of [-1, 0, 1]) {
        const abs = base + oc * edo;
        if (abs >= soprano[0]) continue; // must be below soprano
        const intv = Math.abs(soprano[0] - abs);
        let s = 0;
        if (isImperfect(intv)) s += 8;
        else if (isPerfect(intv) && intv > 0) s += 3;
        s -= Math.abs(abs - targetCenter) / edo * 2;
        if (ctSet.has(pc)) s += 2;
        if (s > bestS) { bestS = s; best = abs; }
      }
    }
    skeleton.push(best);
  }

  // Walk by step using all four species motion types:
  //   contrary — voices move in opposite directions
  //   similar  — same direction, different interval (not parallel perfects)
  //   oblique  — one voice holds, the other moves
  //   parallel — same direction by the same generic interval (3rds, 6ths OK)
  for (let i = 1; i < soprano.length; i++) {
    const sopDir = soprano[i] - soprano[i - 1];
    const prev = skeleton[i - 1];
    const prevD = toDiatonic(prev);

    const roll = Math.random();
    let stepSize: number;

    if (sopDir === 0) {
      // Soprano static → oblique motion: we move freely
      if (roll < 0.3) stepSize = 0;                                         // oblique: hold
      else if (roll < 0.7) stepSize = Math.random() > 0.5 ? 1 : -1;        // step
      else stepSize = (Math.random() > 0.5 ? 2 : -2);                      // small leap
    } else {
      const contraryDir = sopDir > 0 ? -1 : 1;
      const similarDir = sopDir > 0 ? 1 : -1;

      if (roll < 0.35) {
        // Contrary motion — opposite direction step
        stepSize = contraryDir;
      } else if (roll < 0.50) {
        // Contrary leap — opposite direction, 3rd or 4th
        stepSize = contraryDir * (Math.random() > 0.5 ? 2 : 3);
      } else if (roll < 0.65) {
        // Similar motion — same direction step (different interval size)
        stepSize = similarDir;
      } else if (roll < 0.75) {
        // Parallel motion — same direction, parallel 3rds/6ths
        // Move by the same diatonic distance as soprano
        const sopD0 = toDiatonic(soprano[i - 1]);
        const sopD1 = toDiatonic(soprano[i]);
        stepSize = (sopD1.idx + sopD1.oct * dLen) - (sopD0.idx + sopD0.oct * dLen);
      } else if (roll < 0.90) {
        // Oblique — hold while soprano moves
        stepSize = 0;
      } else {
        // Similar leap — same direction, larger interval
        stepSize = similarDir * (Math.random() > 0.5 ? 2 : 3);
      }
    }

    const nextAbs = fromDiatonic(prevD.idx + stepSize, prevD.oct);
    skeleton.push(nextAbs);
  }

  // ── Pass 2: Refine skeleton for species correctness ──
  const result: number[] = [];

  for (let i = 0; i < soprano.length; i++) {
    const sopNote = soprano[i];
    const skelNote = skeleton[i];
    const isStrongBeat = i % 2 === 0;
    const prevNote = i > 0 ? result[i - 1] : undefined;
    const prevSop = i > 0 ? soprano[i - 1] : undefined;

    // Score the skeleton note and nearby alternatives, pick the best
    let bestNote = skelNote;
    let bestScore = -Infinity;

    // Candidates: skeleton note ± a few diatonic steps
    const skelD = toDiatonic(skelNote);
    for (let offset = -3; offset <= 3; offset++) {
      const abs = fromDiatonic(skelD.idx + offset, skelD.oct);
      const pc = ((abs % edo) + edo) % edo;

      // Hard: no voice crossing
      let crosses = false;
      for (const v of allVoices) {
        if (i < v.length && abs >= v[i]) { crosses = true; break; }
      }
      if (crosses) continue;

      let score = 0;

      // ── Consonance with cantus firmus ──
      const intv = Math.abs(sopNote - abs);
      if (isImperfect(intv)) score += 6;
      else if (isPerfect(intv) && intv > 0) score += 2;
      else if (intv === 0) score -= 1;
      else if (!isConsonant(intv)) {
        if (isStrongBeat) score -= 12;
        else score -= 1;  // weak-beat dissonance OK as passing tone
      }

      // ── Consonance with existing voices ──
      for (const v of existingVoices) {
        if (i >= v.length) continue;
        const vIntv = Math.abs(v[i] - abs);
        if (isImperfect(vIntv)) score += 2;
        else if (!isConsonant(vIntv)) score -= 2;
      }

      // ── No parallel perfect intervals ──
      if (prevNote !== undefined && prevSop !== undefined) {
        const prevInt = ((Math.abs(prevSop - prevNote)) % edo + edo) % edo;
        const curInt = ((Math.abs(sopNote - abs)) % edo + edo) % edo;
        if (isPerfect(prevInt) && isPerfect(curInt)) {
          const sD = sopNote - prevSop;
          const mD = abs - prevNote;
          if ((sD > 0 && mD > 0) || (sD < 0 && mD < 0)) score -= 25;
        }
        for (const v of existingVoices) {
          if (i >= v.length || i < 1) continue;
          const pI = ((Math.abs(v[i - 1] - prevNote)) % edo + edo) % edo;
          const cI = ((Math.abs(v[i] - abs)) % edo + edo) % edo;
          if (isPerfect(pI) && isPerfect(cI)) {
            const vD = v[i] - v[i - 1];
            const mD = abs - prevNote;
            if ((vD > 0 && mD > 0) || (vD < 0 && mD < 0)) score -= 25;
          }
        }
      }

      // ── No repeated notes (species counterpoint principle) ──
      if (prevNote !== undefined && abs === prevNote) score -= 8;

      // ── Motion type scoring (all four types valid) ──
      // Contrary and oblique are slightly preferred; similar and parallel
      // are fine but parallel perfects are already forbidden above.
      if (prevNote !== undefined && prevSop !== undefined) {
        const sD = sopNote - prevSop;
        const mD = abs - prevNote;
        if (sD === 0 && mD !== 0) score += 2;       // oblique (soprano holds)
        else if (sD !== 0 && mD === 0) score += 1;  // oblique (we hold)
        else if (sD !== 0 && mD !== 0) {
          if ((sD > 0 && mD < 0) || (sD < 0 && mD > 0)) score += 2; // contrary
          else score += 1;                                             // similar/parallel
        }
      }

      // ── Stepwise preferred, but must actually move ──
      if (prevNote !== undefined) {
        const step = Math.abs(abs - prevNote);
        if (step > 0 && step <= M2) score += 5;       // stepwise: best
        else if (step > M2 && step <= P4) score += 2;  // 3rd: fine
        else if (step > P4 && step <= P5) score += 0;  // 4th-5th: OK
        else if (step > P5) score -= 3;                 // larger: penalised
      }

      // ── Leap recovery ──
      if (i >= 2 && prevNote !== undefined) {
        const prevStep = Math.abs(prevNote - result[i - 2]);
        if (prevStep > P4) {
          const pDir = prevNote - result[i - 2];
          const cDir = abs - prevNote;
          if ((pDir > 0 && cDir < 0) || (pDir < 0 && cDir > 0)) score += 3;
        }
      }

      // ── Chord tones on strong beats ──
      if (ctSet.has(pc)) score += (isStrongBeat ? 3 : 1);

      // ── Prefer staying close to skeleton (preserves melodic shape) ──
      score -= Math.abs(offset) * 0.8;

      // ── Soft register preference ──
      score -= Math.abs(abs - targetCenter) / edo * 0.3;

      if (score > bestScore) { bestScore = score; bestNote = abs; }
    }

    result.push(bestNote);
  }

  return result;
}

/**
 * Choose an octave offset for the next note based on angularity.
 *
 * Computes the interval from `prev` to `pc` in each candidate octave
 * (-1, 0, +1), then weights by angularity:
 *   angularity 0 → pick the octave that minimizes interval (closest voicing)
 *   angularity 1 → pick the octave that maximizes interval (widest leap)
 *   0.5 → uniform across octaves
 */
function pickOctave(
  prev: number, pc: number, edo: number, angularity: number,
): number {
  const octaves = [-1, 0, 1];

  // At very low angularity, deterministically pick the closest octave
  if (angularity < 0.1) {
    let bestOct = 0, bestDist = Infinity;
    for (const oct of octaves) {
      const d = Math.abs(pc + oct * edo - prev);
      if (d < bestDist) { bestDist = d; bestOct = oct; }
    }
    return bestOct;
  }

  const weights = octaves.map(oct => {
    const absPitch = pc + oct * edo;
    const interval = Math.abs(absPitch - prev);
    const normInterval = interval / edo; // 0=unison, 1=octave, 2=two octaves
    const smooth = 1 / (1 + normInterval * 4); // sharply prefers close
    const angular = normInterval + 0.1;        // prefers far
    return smooth * (1 - angularity) + angular * angularity;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let j = 0; j < octaves.length; j++) {
    r -= weights[j];
    if (r <= 0) return octaves[j];
  }
  return 0;
}

// ── Progression generation ────────────────────────────────────────────

export type ChordComplexity = "simple" | "modal" | "chromatic" | "advanced";
export type Tonality = "major" | "minor" | "both";

// ── Granular harmony categories ──────────────────────────────────────
export type HarmonyCategory =
  | "functional"       // Diatonic triads & 7ths (I ii iii IV V vi vii°)
  | "quartal"          // Quartal/modal jazz (sus4, 7sus4, min7, maj7 — stepwise & quartal root motion)
  | "secdom"           // Secondary dominants (V/ii, V/iii, V/IV, V/V, V/vi)
  | "secdim"           // Secondary diminished (vii°/ii, vii°/iii, etc.)
  | "neapolitan"       // Neapolitan (bII, bIImaj7)
  | "tritone"          // Tritone substitutions (TT/I, TT/V, TT/ii)
  | "mediants"         // Chromatic mediants (III, biii, bvi, VI#)
  | "modal"            // Modal interchange (bVII, bVI, bIII, iv, bII, #IV)
  | "chromDia"         // All chord types on all ~12 chromatic roots
  | "chrom31"          // All chord types on all EDO roots
  | "xen_submin"       // Subminor triads & 7ths
  | "xen_min"          // Minor triads & 7ths (32/27 third — distinct in 41-EDO)
  | "xen_neutral"      // Neutral triads & 7ths
  | "xen_supermaj"     // Supermajor triads & 7ths
  | "xen_maj"          // Major triads & 7ths (81/64 third — distinct in 41-EDO)
  | "xen_clmin"        // Classic minor triads & 7ths
  | "xen_clmaj";       // Classic major triads & 7ths

export const XEN_CATEGORIES: HarmonyCategory[] = ["xen_submin", "xen_min", "xen_neutral", "xen_supermaj", "xen_maj", "xen_clmin", "xen_clmaj"];

/** Map a chord type id to its xen family category, or null if not xenharmonic.
 *  In 41-EDO, min (32/27) and maj (81/64) are distinct from classic minor/major,
 *  so they get their own xen family when the EDO has enough distinct thirds. */
export function xenFamily(id: string, edo?: number): HarmonyCategory | null {
  // Seventh-quality override: a neutral 7th (_n7 suffix) is the exotic
  // distinguishing feature, so classify under xen_neutral regardless of third.
  // This prevents e.g. "Major Neutral7" from appearing when only "Major" is enabled.
  if (id.endsWith("_n7")) return "xen_neutral";
  if (id === "submin" || id.startsWith("submin_")) return "xen_submin";
  if (id === "neutral" || id.startsWith("neu_") || id.startsWith("neutral_")) return "xen_neutral";
  if (id === "supermaj" || id.startsWith("sup_") || id.startsWith("supermaj_")) return "xen_supermaj";
  if (id === "clmin" || id.startsWith("clmin_")) return "xen_clmin";
  if (id === "clmaj" || id.startsWith("clmaj_")) return "xen_clmaj";
  // In EDOs beyond 12, min/maj are distinct xen families
  if (edo !== undefined && edo !== 12) {
    if (id === "min" || id.startsWith("min_")) return "xen_min";
    if (id === "maj" || id.startsWith("maj_")) return "xen_maj";
  }
  return null;
}

export const HARMONY_CATEGORIES: { id: HarmonyCategory; label: string; desc: string; group: string }[] = [
  { id: "functional", label: "Functional Harmony",    desc: "I ii iii IV V vi vii° + minor equivalents",   group: "Diatonic" },
  { id: "quartal",    label: "Quartal Jazz",          desc: "Sus4, 7sus4, min7, maj7 — stepwise & quartal root motion", group: "Diatonic" },
  { id: "modal",      label: "Modal Interchange",     desc: "bVII, bVI, bIII, iv, bII, #IV, Dorian VI",    group: "Diatonic" },
  { id: "secdom",     label: "Secondary Dominants",   desc: "V/ii, V/iii, V/IV, V/V, V/vi",                group: "Chromatic" },
  { id: "secdim",     label: "Secondary Diminished",  desc: "vii°/ii, vii°/iii, vii°/IV, vii°/V, vii°/vi", group: "Chromatic" },
  { id: "neapolitan", label: "Neapolitan",            desc: "bII, bIImaj7 → resolves to V",                group: "Chromatic" },
  { id: "tritone",    label: "Tritone Substitutions",  desc: "TT/I, TT/V, TT/ii",                          group: "Chromatic" },
  { id: "mediants",   label: "Chromatic Mediants",     desc: "III, biii, bvi, VI — third-related chords",   group: "Chromatic" },
  { id: "chromDia",   label: "Chromatic Diatonic",     desc: "All chord types on 12 chromatic roots",       group: "Extended" },
  { id: "chrom31",    label: "Chromatic {edo}",         desc: "All chord types on every EDO root",           group: "Extended" },
  { id: "xen_submin",  label: "Subminor",       desc: "Subminor triads & 7ths (7/6 third)",          group: "Xenharmonic" },
  { id: "xen_min",     label: "Minor",          desc: "Minor triads & 7ths (32/27 third)",           group: "Xenharmonic" },
  { id: "xen_clmin",   label: "Classic Minor",  desc: "Classic minor triads & 7ths (6/5 third)",     group: "Xenharmonic" },
  { id: "xen_neutral", label: "Neutral",        desc: "Neutral triads & 7ths (11/9 third)",          group: "Xenharmonic" },
  { id: "xen_clmaj",   label: "Classic Major",  desc: "Classic major triads & 7ths (5/4 third)",     group: "Xenharmonic" },
  { id: "xen_maj",     label: "Major",          desc: "Major triads & 7ths (81/64 third)",           group: "Xenharmonic" },
  { id: "xen_supermaj",label: "Supermajor",     desc: "Supermajor triads & 7ths (9/7 third)",        group: "Xenharmonic" },
];
/** Returns the set of harmony categories that have actual chord types in this EDO. */
export function availableHarmonyCategories(edo: number): Set<HarmonyCategory> {
  const shapes = getEdoChordTypes(edo);
  const available = new Set<HarmonyCategory>(["functional", "quartal", "modal", "secdom", "secdim", "neapolitan", "tritone", "mediants", "chromDia", "chrom31"] as HarmonyCategory[]);
  // Only include xen families that have at least one chord type in this EDO
  for (const xc of XEN_CATEGORIES) {
    if (shapes.some(s => xenFamily(s.id, edo) === xc)) available.add(xc);
  }
  return available;
}

export type ProgressionMode = "random" | "functional" | "pool";

/**
 * Generate a chord progression from the selected harmony categories.
 * Categories are granular: functional, secdom, secdim, neapolitan, tritone,
 * mediants, modal, aug6, chromDia, chrom31, xen.
 */
export interface ProgChord {
  roman: string;
  chordPcs: number[];
  root: number;
  chordTypeId: string;
}

export function generateProgression(
  edo: number,
  count: number,
  categories: Set<HarmonyCategory> | ChordComplexity | Set<ChordComplexity>,
  mode: ProgressionMode = "random",
  minChordNotes: number = 2,
  tonality: Tonality = "both",
  tonicRoot: number = 0,
  seventhFilter?: Set<string>,
  thirdFilter?: Set<string>,
  includeAltered?: boolean,
): ProgChord[] {
  // Convert legacy ChordComplexity to HarmonyCategory set
  let cats: Set<HarmonyCategory>;
  if (categories instanceof Set && categories.size > 0) {
    const first = [...categories][0];
    if (["simple","modal","chromatic","advanced"].includes(first as string)) {
      // Legacy Set<ChordComplexity>
      cats = new Set<HarmonyCategory>();
      if ((categories as Set<string>).has("simple")) cats.add("functional");
      if ((categories as Set<string>).has("modal")) cats.add("modal");
      if ((categories as Set<string>).has("chromatic")) { cats.add("secdom"); cats.add("secdim"); cats.add("neapolitan"); cats.add("tritone"); cats.add("mediants"); }
      if ((categories as Set<string>).has("advanced")) XEN_CATEGORIES.forEach(x => cats.add(x));
    } else {
      cats = categories as Set<HarmonyCategory>;
    }
  } else if (typeof categories === "string") {
    cats = new Set<HarmonyCategory>();
    if (categories === "simple") cats.add("functional");
    else if (categories === "modal") { cats.add("functional"); cats.add("modal"); }
    else if (categories === "chromatic") { cats.add("functional"); cats.add("modal"); cats.add("secdom"); cats.add("secdim"); cats.add("neapolitan"); cats.add("tritone"); cats.add("mediants"); }
    else { cats.add("functional"); cats.add("modal"); cats.add("secdom"); XEN_CATEGORIES.forEach(x => cats.add(x)); }
  } else {
    cats = new Set<HarmonyCategory>(["functional"]);
  }
  const shapes = getEdoChordTypes(edo);
  const dm = getDegreeMap(edo);
  const intervals = getEDOIntervals(edo);
  const { M3, m3, P4, P5, m7, M7, M2 } = intervals;

  // Helper to build a chord from root step + chord type id, transposed by tonicRoot
  const romanOverrides = new Map<string, string>(); // entryKey → override
  const mkChord = (rootStep: number, typeId: string) => {
    const ct = shapes.find(c => c.id === typeId);
    if (!ct) return null;
    const absRoot = ((rootStep + tonicRoot) % edo + edo) % edo;
    const pcs = ct.steps.map(s => (s + absRoot) % edo);
    // Roman numeral is relative to scale degree (not transposed)
    const relRoot = ((rootStep % edo) + edo) % edo;
    const key = `${relRoot}:${typeId}`;
    const roman = romanOverrides.get(key) ?? toRomanNumeral(edo, relRoot, ct.abbr, ct.steps.map(s => (s + relRoot) % edo));
    return { roman, chordPcs: pcs, root: absRoot, typeId };
  };

  // Key for identifying a chord entry
  const entryKey = (e: { root: number; type: string }) =>
    `${((e.root % edo) + edo) % edo}:${e.type}`;

  // ── Pool definitions ──
  const m6 = dm["b6"] ?? m3 + P5;
  const M6 = dm["6"] ?? P5 + M2;
  const d5 = dm["b5"] ?? P4 + 1;
  const b2 = dm["b2"] ?? 1;

  // Tag each entry with its layer for weighting
  type PoolEntry = { root: number; type: string; layer: HarmonyCategory; romanOverride?: string };

  // ── DIATONIC ──
  const majorDia: PoolEntry[] = [
    { root: 0,  type: "maj" },   { root: M2, type: "min" },
    { root: M3, type: "min" },   { root: P4, type: "maj" },
    { root: P5, type: "maj" },   { root: P5, type: "dom7" },
    { root: 0,  type: "maj7" },  { root: M2, type: "min7" },
    { root: P4, type: "maj7" },  { root: M3, type: "min7" },
    { root: M6, type: "min" },   { root: M6, type: "min7" },
  ].map(e => ({ ...e, layer: "functional" as const }));
  const minorDia: PoolEntry[] = [
    { root: 0,  type: "min" },   { root: 0,  type: "min7" },
    { root: M2, type: "dim" },   { root: m3, type: "maj" },
    { root: P4, type: "min" },   { root: P5, type: "min" },
    { root: m6, type: "maj" },   { root: m7, type: "maj" },
    { root: m6, type: "maj7" },  { root: m7, type: "dom7" },
    { root: P5, type: "dom7" },  { root: m3, type: "maj7" },
    { root: P4, type: "min7" },
  ].map(e => ({ ...e, layer: "functional" as const }));
  const diaPool = tonality === "major" ? majorDia
    : tonality === "minor" ? minorDia
    : [...majorDia, ...minorDia];

  // ── MODAL ── borrowed chords (may overlap minor diatonic; deduplication handles it)
  const modalPool: PoolEntry[] = [
    // Minor plagal in major context
    { root: P4, type: "min" },   { root: P4, type: "min7" },
    // Mixolydian bVII
    { root: m7, type: "maj" },   { root: m7, type: "dom7" },
    // Aeolian bVI
    { root: m6, type: "maj" },   { root: m6, type: "maj7" },
    // bIII (Mixolydian / borrowed)
    { root: m3, type: "maj" },   { root: m3, type: "maj7" },
    // Phrygian bII
    { root: b2, type: "maj" },   { root: b2, type: "dom7" },
    // Lydian #IV
    ...(dm["#4"] != null ? [{ root: dm["#4"], type: "maj" }, { root: dm["#4"], type: "dom7" }] : []),
    // Dorian — major VI in minor context
    { root: M6, type: "maj" },   { root: M6, type: "dom7" },
    // IV7 (Mixolydian of IV)
    { root: P4, type: "dom7" },
  ].map(e => ({ ...e, layer: "modal" as const }));

  // ── QUARTAL JAZZ ── sus4, 7sus4, min7, maj7 on all diatonic + chromatic roots
  // Modal jazz voicings: quartal stacks and extended chords approximated by
  // available types.  Root motion favors stepwise (M2) and quartal (P4).
  const quartalTypes = ["sus4", "sus2", "dom7sus4", "min7", "maj7"];
  const quartalAvail = quartalTypes.filter(t => shapes.some(s => s.id === t));
  const quartalRoots = [...new Set([0, M2, M3, P4, P5, M6, m7, b2, m3, m6])];
  const quartalPool: PoolEntry[] = [];
  if (cats.has("quartal")) {
    for (const r of quartalRoots) {
      for (const t of quartalAvail) {
        quartalPool.push({ root: r, type: t, layer: "quartal" });
      }
    }
  }

  // ── CHROMATIC ── secondary dominants with V/ notation, tritone subs, mediants
  const chromaticPool: PoolEntry[] = [];
  // Secondary dominants V/x — dom7 a P5 above each diatonic target
  const secTargets: { target: number; label: string }[] = [
    { target: M2, label: "V/ii" },  { target: M3, label: "V/iii" },
    { target: P4, label: "V/IV" },  { target: P5, label: "V/V" },
    { target: M6, label: "V/vi" },
  ];
  // Secondary dominants V/x — only the applied chords themselves
  if (cats.has("secdom")) {
    for (const { target, label } of secTargets) {
      chromaticPool.push({ root: (target + P5) % edo, type: "dom7", layer: "secdom", romanOverride: label });
    }
  }
  // Secondary diminished vii°/x
  const dimType = shapes.find(c => c.id === "dim7") ? "dim7" : shapes.find(c => c.id === "dim") ? "dim" : null;
  if (cats.has("secdim") && dimType) {
    for (const { target, label } of secTargets) {
      chromaticPool.push({ root: (target + M7) % edo, type: dimType, layer: "secdim", romanOverride: label.replace("V/", "vii°/") });
    }
  }
  // Tritone substitutions — only the TT chords
  if (cats.has("tritone")) {
    chromaticPool.push({ root: b2, type: "dom7", layer: "tritone", romanOverride: "TT/I" });
    chromaticPool.push({ root: (P5 + b2) % edo, type: "dom7", layer: "tritone", romanOverride: "TT/V" });
    chromaticPool.push({ root: (M2 + b2) % edo, type: "dom7", layer: "tritone", romanOverride: "TT/ii" });
  }
  // Neapolitan — only bII chords
  if (cats.has("neapolitan")) {
    chromaticPool.push({ root: b2, type: "maj", layer: "neapolitan" });
    chromaticPool.push({ root: b2, type: "maj7", layer: "neapolitan" });
  }
  // Chromatic mediants — only the mediant chords
  if (cats.has("mediants")) {
    chromaticPool.push({ root: M3, type: "maj", layer: "mediants" });
    chromaticPool.push({ root: m3, type: "min", layer: "mediants" });
    chromaticPool.push({ root: m6, type: "min", layer: "mediants" });
    chromaticPool.push({ root: M6, type: "maj", layer: "mediants" });
  }

  // ── XENHARMONIC ── microtonal chord types at diatonic + chromatic roots
  // Each xen family is its own category; only include enabled families
  const xenPool: PoolEntry[] = [];
  const enabledXen = XEN_CATEGORIES.filter(x => cats.has(x));
  const xenTriadIds = ["submin", "neutral", "supermaj", "clmin", "clmaj", ...(edo !== 12 ? ["min", "maj"] : [])];
  const xenTriads = shapes.filter(c => xenTriadIds.includes(c.id) && cats.has(xenFamily(c.id, edo)!));
  if (enabledXen.length > 0) {
    const xenShapes = shapes.filter(c => {
      const fam = xenFamily(c.id, edo);
      return fam !== null && cats.has(fam);
    });
    const xenRoots = [...new Set([0, M2, M3, P4, P5, M6, m7, b2, m3, d5, m6])];
    for (const r of xenRoots) {
      for (const ct of xenShapes) {
        xenPool.push({ root: r, type: ct.id, layer: xenFamily(ct.id, edo)! });
      }
    }
  }

  // ── CHROMATIC DIATONIC — ALL chord types on ~12 chromatic roots ──
  // Xen types only included if their family is individually enabled
  const chromDiaPool: PoolEntry[] = [];
  if (cats.has("chromDia")) {
    const chromRoots12 = [...new Set([0, b2, M2, m3, M3, P4, d5, P5, m6, M6, m7, M7])];
    for (const r of chromRoots12) {
      for (const ct of shapes) {
        const fam = xenFamily(ct.id, edo);
        if (fam !== null && !cats.has(fam)) continue; // skip disabled xen families
        chromDiaPool.push({ root: r, type: ct.id, layer: "chromDia" });
      }
    }
  }

  // ── CHROMATIC 31 — ALL chord types on all EDO roots ──
  const chrom31Pool: PoolEntry[] = [];
  if (cats.has("chrom31")) {
    for (let r = 0; r < edo; r++) {
      for (const ct of shapes) {
        const fam = xenFamily(ct.id, edo);
        if (fam !== null && !cats.has(fam)) continue;
        chrom31Pool.push({ root: r, type: ct.id, layer: "chrom31" });
      }
    }
  }

  // ── ALTERED ── every chord type on every diatonic scale degree
  // Allows any chord quality on any scale root: I7, IIIaug, vii°, Isus4,
  // iminmaj7, etc. — non-diatonic types treated as functional alterations.
  // Xen types are only included if their family is individually enabled.
  const alteredPool: PoolEntry[] = [];
  if (includeAltered) {
    const diaRoots = [...new Set([0, M2, M3, P4, P5, M6, M7])];
    for (const r of diaRoots) {
      for (const ct of shapes) {
        const fam = xenFamily(ct.id, edo);
        if (fam !== null && !cats.has(fam)) continue; // skip disabled xen families
        alteredPool.push({ root: r, type: ct.id, layer: "functional" });
      }
    }
  }

  // ── Build final pool ──
  let pool: PoolEntry[] = [];
  if (cats.has("functional")) pool = [...pool, ...diaPool];
  if (cats.has("quartal"))    pool = [...pool, ...quartalPool];
  if (cats.has("modal"))      pool = [...pool, ...modalPool];
  if (chromaticPool.length > 0) pool = [...pool, ...chromaticPool];
  if (includeAltered)         pool = [...pool, ...alteredPool];
  if (enabledXen.length > 0)  pool = [...pool, ...xenPool];
  if (cats.has("chromDia"))   pool = [...pool, ...chromDiaPool];
  if (cats.has("chrom31"))    pool = [...pool, ...chrom31Pool];

  // ── Chord-type filter ──
  // When xen chord-type families exist for this EDO, they act as a global
  // filter: any chord whose type maps to a xen family must have that family
  // enabled, regardless of which harmony layer produced it.
  // Exception: xen_min / xen_maj are just the standard min/maj triads in
  // non-12 EDOs — they must always pass for non-xen layers (functional,
  // modal, chromatic, etc.) so diatonic harmony isn't gated behind the
  // xen toggle buttons.
  const NON_XEN_LAYERS = new Set<string>(["functional", "quartal", "modal", "secdom", "secdim", "neapolitan", "tritone", "mediants", "chromDia", "chrom31"]);
  const availXen = XEN_CATEGORIES.filter(xc =>
    shapes.some(s => xenFamily(s.id, edo) === xc));
  if (availXen.length > 0) {
    pool = pool.filter(entry => {
      const fam = xenFamily(entry.type, edo);
      // Chord type has no xen family (e.g. dim, aug, sus) → always keep
      if (fam === null) return true;
      // Standard min/maj from non-xen layers bypass this filter
      if ((fam === "xen_min" || fam === "xen_maj") && NON_XEN_LAYERS.has(entry.layer)) return true;
      // Chord type's family exists for this EDO → must be enabled
      return cats.has(fam);
    });
  }

  // ── Auto-enable xen categories for selected non-standard qualities ──
  // When the user selects a quality like "neutral" or "supermajor" in the
  // 3rds/7ths filter, automatically include the corresponding xen chord
  // family in the pool (via the existing xen pool + Markov system) so
  // those chord types appear with proper transitions.
  const QUALITY_TO_XEN: Record<string, HarmonyCategory> = {
    sub3: "xen_submin", neu3: "xen_neutral", sup3: "xen_supermaj",
    clmin3: "xen_clmin", clmaj3: "xen_clmaj",
  };
  if (thirdFilter !== undefined) {
    for (const q of thirdFilter) {
      const xc = QUALITY_TO_XEN[q];
      if (xc && !cats.has(xc) && availXen.includes(xc)) {
        cats.add(xc);
        // Add xen entries for this newly-enabled family — only P5 types,
        // and for sevenths prefer fifth-paired voicings (3rd + P5 = 7th)
        const allFam = shapes.filter(c =>
          xenFamily(c.id, edo) === xc && c.steps.includes(P5));
        const famShapes = allFam.filter(c => {
          if (c.category === "triad") return true;
          // For seventh chords: only include fifth-paired (3rd + P5 = 7th)
          if (c.steps.length >= 4) {
            return (c.steps[1] + P5) % edo === c.steps[3] % edo;
          }
          return true;
        });
        const xenRoots = [...new Set([0, M2, M3, P4, P5, M6, m7, b2, m3, d5, m6])];
        for (const r of xenRoots) {
          for (const ct of famShapes) {
            pool.push({ root: r, type: ct.id, layer: xc });
          }
        }
      }
    }
  }

  // ── Quality filters (3rds + 7ths) ──
  // Pure filter: remove pool entries whose quality doesn't match.
  if (thirdFilter !== undefined) {
    if (thirdFilter.size > 0) {
      pool = pool.filter(entry => {
        const ct = shapes.find(c => c.id === entry.type);
        if (!ct) return true;
        return ct.thirdQuality == null || thirdFilter.has(ct.thirdQuality);
      });
    } else {
      pool = [];
    }
  }
  if (seventhFilter !== undefined) {
    if (seventhFilter.size > 0) {
      pool = pool.filter(entry => {
        const ct = shapes.find(c => c.id === entry.type);
        if (!ct || ct.category !== "seventh") return true;
        return ct.seventhQuality != null && seventhFilter.has(ct.seventhQuality);
      });
    } else {
      pool = pool.filter(entry => {
        const ct = shapes.find(c => c.id === entry.type);
        return !ct || ct.category !== "seventh";
      });
    }
  }

  if (pool.length === 0) return []; // no enabled categories → no chords

  // Apply V/ notation only when secondary dominants are enabled
  if (cats.has("secdom")) {
    for (const { target, label } of secTargets) {
      const secRoot = ((target + P5) % edo + edo) % edo;
      romanOverrides.set(`${secRoot}:dom7`, label);
    }
  }

  // Apply TT/ notation only when tritone substitutions are enabled
  // Don't overwrite existing secdom labels — secdom has priority (more specific)
  if (cats.has("tritone")) {
    const ttTargets: { target: number; label: string }[] = [
      { target: 0,  label: "TT/I" },
      { target: P5, label: "TT/V" },
      { target: M2, label: "TT/ii" },
    ];
    for (const { target, label } of ttTargets) {
      const ttRoot = ((target + P5 + d5) % edo + edo) % edo;
      const key = `${ttRoot}:dom7`;
      if (!romanOverrides.has(key)) romanOverrides.set(key, label);
    }
  }

  // Store additional roman overrides from pool entries (tritone subs, secdim, etc.)
  // Don't overwrite existing overrides (earlier, more specific labels win)
  for (const p of pool) {
    if (p.romanOverride) {
      const key = `${((p.root % edo) + edo) % edo}:${p.type}`;
      if (!romanOverrides.has(key)) romanOverrides.set(key, p.romanOverride);
    }
  }

  // Deduplicate and filter by minimum chord note count
  const seen = new Set<string>();
  const unique = pool.filter(p => {
    const key = entryKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    const ct = shapes.find(c => c.id === p.type);
    if (ct && ct.steps.length < minChordNotes) return false;
    return true;
  });

  // ── Pool mode: return all unique chords (no sampling) ──
  if (mode === "pool") {
    const result: ProgChord[] = [];
    for (const entry of unique) {
      const chord = mkChord(entry.root, entry.type);
      if (chord) {
        result.push({ roman: chord.roman, chordPcs: chord.chordPcs, root: chord.root, chordTypeId: chord.typeId });
      }
    }
    return result;
  }

  // ── Random mode: soft common-tone preference for smoother transitions ──
  if (mode === "random") {
    const result: ProgChord[] = [];
    let prevPcs: Set<number> | null = null;
    for (let i = 0; i < count; i++) {
      let entry: { root: number; type: string };
      if (prevPcs !== null && Math.random() < 0.7) {
        // Prefer chords sharing at least one common tone with the previous chord
        const withCommon = unique.filter(u => {
          const ct = shapes.find(c => c.id === u.type);
          if (!ct) return false;
          const absRoot = ((u.root + tonicRoot) % edo + edo) % edo;
          return ct.steps.some(s => prevPcs!.has((s + absRoot) % edo));
        });
        const pool = withCommon.length > 0 ? withCommon : unique;
        entry = pool[Math.floor(Math.random() * pool.length)];
      } else {
        entry = unique[Math.floor(Math.random() * unique.length)];
      }
      const chord = mkChord(entry.root, entry.type);
      if (chord) {
        result.push({ roman: chord.roman, chordPcs: chord.chordPcs, root: chord.root, chordTypeId: chord.typeId });
        prevPcs = new Set(chord.chordPcs.map(p => ((p % edo) + edo) % edo));
      } else {
        result.push({ roman: "I", chordPcs: [0, M3, P5].map(s => s % edo), root: 0, chordTypeId: "maj" });
        prevPcs = new Set([0, M3, P5].map(s => s % edo));
      }
    }
    return result;
  }

  // ── Functional mode: Markov chain by harmonic function ──
  // Transition tables encode common-practice tendencies.
  // Keys are entryKeys, values are arrays of { target: entryKey, weight }.
  // Any chord not in the table can go anywhere in the pool (uniform).

  type Transition = { target: string; weight: number }[];
  const transitions = new Map<string, Transition>();

  const addTrans = (from: { root: number; type: string }, tos: { to: { root: number; type: string }; w: number }[]) => {
    const fk = entryKey(from);
    const existing = transitions.get(fk) ?? [];
    for (const { to, w } of tos) {
      const tk = entryKey(to);
      // Only add if target exists in pool
      if (unique.some(u => entryKey(u) === tk)) {
        existing.push({ target: tk, weight: w });
      }
    }
    if (existing.length > 0) transitions.set(fk, existing);
  };

  // ── Chord aliases ──
  const I      = { root: 0,  type: "maj" };
  const Imaj7  = { root: 0,  type: "maj7" };
  const ii     = { root: M2, type: "min" };
  const ii7    = { root: M2, type: "min7" };
  const iii    = { root: M3, type: "min" };
  const IV     = { root: P4, type: "maj" };
  const IVmaj7 = { root: P4, type: "maj7" };
  const V      = { root: P5, type: "maj" };
  const V7     = { root: P5, type: "dom7" };
  const vi     = { root: M6, type: "min" };
  const i      = { root: 0,  type: "min" };
  const i7     = { root: 0,  type: "min7" };
  const iidim  = { root: M2, type: "dim" };
  const III    = { root: m3, type: "maj" };
  const iv     = { root: P4, type: "min" };
  const v      = { root: P5, type: "min" };
  const VI     = { root: m6, type: "maj" };
  const VImaj7 = { root: m6, type: "maj7" };
  const VII    = { root: m7, type: "maj" };
  const VII7   = { root: m7, type: "dom7" };
  const vi7     = { root: M6, type: "min7" };
  const iii7    = { root: M3, type: "min7" };
  const iv7     = { root: P4, type: "min7" };
  const halfdim = { root: M2, type: "halfdim7" };

  // Bias multiplier: selected non-functional categories get a strong boost
  // so they actually appear when the user enables them.  Functional gets a
  // moderate boost; everything else gets a high multiplier to compensate for
  // having fewer targets than the diatonic pool.
  const nonFunctionalSelected = [...cats].filter(c => c !== "functional").length;
  const W = (base: number, layer: HarmonyCategory) => {
    if (!cats.has(layer)) return base;
    if (layer === "functional") return base * (nonFunctionalSelected > 0 ? 2 : 3);
    return base * 8; // strong bias toward selected chromatic/modal categories
  };

  // Track which pool entries are "applied" (must resolve to target, not wander)
  const appliedEntries = new Set<string>();

  // ── DIATONIC transitions ──
  // Not just T→PD→D→T: includes retrogression, plagal motion, descending
  // fifth chains, stepwise root motion, and mediant relationships.
  addTrans(I,    [{ to: IV, w: W(3,"functional") }, { to: V, w: W(2,"functional") }, { to: V7, w: W(2,"functional") }, { to: ii, w: W(3,"functional") }, { to: vi, w: W(2,"functional") }, { to: iii, w: W(2,"functional") }, { to: ii7, w: W(2,"functional") }]);
  addTrans(Imaj7,[{ to: IV, w: W(3,"functional") }, { to: V7, w: W(2,"functional") }, { to: ii, w: W(3,"functional") }, { to: vi, w: W(2,"functional") }, { to: iii, w: W(1,"functional") }]);
  addTrans(ii,   [{ to: V, w: W(4,"functional") }, { to: V7, w: W(4,"functional") }, { to: I, w: W(1,"functional") }, { to: iii, w: W(1,"functional") }, { to: IV, w: W(1,"functional") }]);
  addTrans(ii7,  [{ to: V, w: W(4,"functional") }, { to: V7, w: W(4,"functional") }, { to: iii, w: W(1,"functional") }]);
  addTrans(iii,  [{ to: vi, w: W(3,"functional") }, { to: IV, w: W(3,"functional") }, { to: ii, w: W(2,"functional") }, { to: I, w: W(1,"functional") }]);
  addTrans(IV,   [{ to: V, w: W(3,"functional") }, { to: V7, w: W(3,"functional") }, { to: I, w: W(2,"functional") }, { to: ii, w: W(1,"functional") }, { to: vi, w: W(1,"functional") }]);
  addTrans(IVmaj7,[{ to: V, w: W(3,"functional") }, { to: V7, w: W(3,"functional") }, { to: I, w: W(1,"functional") }]);
  addTrans(V,    [{ to: I, w: W(5,"functional") }, { to: Imaj7, w: W(2,"functional") }, { to: vi, w: W(2,"functional") }, { to: IV, w: W(1,"functional") }, { to: iii, w: W(1,"functional") }]);
  addTrans(V7,   [{ to: I, w: W(5,"functional") }, { to: vi, w: W(2,"functional") }, { to: IV, w: W(1,"functional") }]);
  addTrans(vi,   [{ to: ii, w: W(3,"functional") }, { to: IV, w: W(3,"functional") }, { to: V, w: W(1,"functional") }, { to: iii, w: W(2,"functional") }, { to: I, w: W(1,"functional") }]);
  // Minor — includes plagal, descending fifths, mediant chains
  addTrans(i,    [{ to: iv, w: W(3,"functional") }, { to: iidim, w: W(2,"functional") }, { to: V7, w: W(2,"functional") }, { to: III, w: W(2,"functional") }, { to: VI, w: W(2,"functional") }, { to: VII, w: W(1,"functional") }, { to: v, w: W(1,"functional") }]);
  addTrans(i7,   [{ to: iv, w: W(3,"functional") }, { to: V7, w: W(2,"functional") }, { to: III, w: W(2,"functional") }, { to: VI, w: W(1,"functional") }]);
  addTrans(iidim,[{ to: V, w: W(4,"functional") }, { to: V7, w: W(4,"functional") }, { to: i, w: W(1,"functional") }]);
  addTrans(III,  [{ to: VI, w: W(3,"functional") }, { to: iv, w: W(3,"functional") }, { to: VII, w: W(2,"functional") }, { to: i, w: W(1,"functional") }, { to: v, w: W(1,"functional") }]);
  addTrans(iv,   [{ to: V, w: W(3,"functional") }, { to: V7, w: W(3,"functional") }, { to: i, w: W(2,"functional") }, { to: iidim, w: W(1,"functional") }]);
  addTrans(v,    [{ to: III, w: W(3,"functional") }, { to: VI, w: W(3,"functional") }, { to: i, w: W(1,"functional") }]);
  addTrans(V,    [{ to: i, w: W(4,"functional") }, { to: i7, w: W(2,"functional") }, { to: VI, w: W(1,"functional") }]);
  addTrans(V7,   [{ to: i, w: W(5,"functional") }, { to: VI, w: W(1,"functional") }]);
  addTrans(VI,   [{ to: iidim, w: W(3,"functional") }, { to: iv, w: W(3,"functional") }, { to: VII, w: W(2,"functional") }, { to: III, w: W(1,"functional") }, { to: V, w: W(1,"functional") }]);
  addTrans(VImaj7,[{ to: iidim, w: W(3,"functional") }, { to: iv, w: W(3,"functional") }, { to: VII, w: W(1,"functional") }]);
  addTrans(VII,  [{ to: III, w: W(3,"functional") }, { to: i, w: W(3,"functional") }, { to: VI, w: W(2,"functional") }, { to: iv, w: W(1,"functional") }]);
  addTrans(VII7, [{ to: III, w: W(3,"functional") }, { to: i, w: W(3,"functional") }, { to: VI, w: W(1,"functional") }]);
  // Cross-tonality bridges
  addTrans(vi,   [{ to: iidim, w: 1 }, { to: iv, w: 1 }]);
  addTrans(i,    [{ to: IV, w: 1 }, { to: V, w: 1 }]);

  // ── MODAL transitions ──
  // Only natural voice-leading paths. The W() bias makes the chain prefer
  // these when modal is enabled, but every transition here should sound
  // correct even without the bias — no artificial paths.
  const bIII = III, bVI = VI, bVImaj7_ = VImaj7, bVII = VII, bVII7 = VII7;
  const bIIImaj7 = { root: m3, type: "maj7" };
  const bII_ = { root: b2, type: "maj" };
  const bII7 = { root: b2, type: "dom7" };

  // ── Resolutions (where borrowed chords naturally go) ──
  addTrans(bVII,  [{ to: I, w: W(4,"modal") }, { to: Imaj7, w: W(3,"modal") }, { to: IV, w: W(2,"modal") }, { to: IVmaj7, w: W(1,"modal") }]);
  addTrans(bVII7, [{ to: I, w: W(4,"modal") }, { to: Imaj7, w: W(3,"modal") }]);
  addTrans(bVI,      [{ to: bVII, w: W(3,"modal") }, { to: bVII7, w: W(2,"modal") }, { to: V, w: W(2,"modal") }, { to: V7, w: W(2,"modal") }, { to: iv, w: W(2,"modal") }]);
  addTrans(bVImaj7_, [{ to: bVII, w: W(3,"modal") }, { to: bVII7, w: W(2,"modal") }, { to: V, w: W(2,"modal") }, { to: V7, w: W(2,"modal") }]);
  addTrans(bIII,     [{ to: IV, w: W(3,"modal") }, { to: IVmaj7, w: W(2,"modal") }, { to: bVII, w: W(2,"modal") }]);
  addTrans(bIIImaj7, [{ to: IV, w: W(3,"modal") }, { to: IVmaj7, w: W(2,"modal") }, { to: bVII, w: W(2,"modal") }]);
  addTrans(iv,    [{ to: I, w: W(3,"modal") }, { to: Imaj7, w: W(2,"modal") }, { to: V, w: W(2,"modal") }, { to: V7, w: W(2,"modal") }]); // minor plagal + approach V
  addTrans(iv7,   [{ to: I, w: W(3,"modal") }, { to: Imaj7, w: W(2,"modal") }, { to: V, w: W(2,"modal") }, { to: V7, w: W(2,"modal") }]);
  addTrans(bII_,  [{ to: V, w: W(3,"modal") }, { to: V7, w: W(2,"modal") }]);   // Neapolitan approach
  addTrans(bII7,  [{ to: V, w: W(3,"modal") }, { to: V7, w: W(2,"modal") }]);

  // ── Approaches (natural diatonic → modal pivots) ──
  // I can go to borrowed subdominants and bVII (very common in rock/pop/jazz)
  const modalFromI = [{ to: bVII, w: W(3,"modal") }, { to: bVI, w: W(2,"modal") }, { to: iv, w: W(2,"modal") }, { to: bIII, w: W(1,"modal") }];
  addTrans(I,     modalFromI);
  addTrans(Imaj7, modalFromI); // 7th variant must also reach modal chords
  // IV → bVII is chromatic neighbour (F→Bb in C), IV → iv is chromatic voice leading
  const modalFromIV = [{ to: iv, w: W(2,"modal") }, { to: bVII, w: W(2,"modal") }];
  addTrans(IV,     modalFromIV);
  addTrans(IVmaj7, modalFromIV); // 7th variant
  // V → bVI is the deceptive cadence to borrowed chord
  addTrans(V,  [{ to: bVI, w: W(2,"modal") }]);
  addTrans(V7, [{ to: bVI, w: W(2,"modal") }]);
  // vi → iv shares function (both pre-dominant), chromatic voice leading (A→Ab in C)
  addTrans(vi,  [{ to: iv, w: W(2,"modal") }]);
  addTrans(vi7, [{ to: iv, w: W(2,"modal") }]); // 7th variant
  // ii → bVII and bVI (common in jazz & pop — ii as pivot to modal area)
  addTrans(ii7, [{ to: bVII, w: W(2,"modal") }, { to: bVI, w: W(1,"modal") }]);
  // iii → bVI (mediant to borrowed submediant)
  addTrans(iii,  [{ to: bVI, w: W(1,"modal") }]);
  addTrans(iii7, [{ to: bVI, w: W(1,"modal") }]);
  // Minor context: i naturally approaches all borrowed chords
  const modalFromI_min = [{ to: bVII, w: W(3,"modal") }, { to: bVI, w: W(2,"modal") }, { to: bIII, w: W(2,"modal") }];
  addTrans(i,  modalFromI_min);
  addTrans(i7, modalFromI_min); // 7th variant

  // ── QUARTAL JAZZ transitions — stepwise (M2) and quartal (P4) root motion ──
  // Modal jazz progressions favor smooth, non-functional root motion:
  //   M2 up (E→F#, B→C#), P4 up (F#→B, E→A), m3 up (C#→E).
  // No "applied" chords — every chord is a destination, not a passing function.
  if (cats.has("quartal")) {
    // Build quartal chord aliases at each available root
    const qChord = (root: number, type: string) => ({ root, type });
    // For each quartal root, create stepwise and quartal transitions to
    // neighboring roots using the same voicing types
    for (const r of quartalRoots) {
      const stepUp   = ((r + M2) % edo + edo) % edo;   // M2 up
      const stepDown = ((r - M2) % edo + edo) % edo;   // M2 down
      const q4Up     = ((r + P4) % edo + edo) % edo;   // P4 up
      const q4Down   = ((r - P4) % edo + edo) % edo;   // P4 down (= P5 up)
      const m3Up     = ((r + m3) % edo + edo) % edo;   // m3 up

      for (const fromType of quartalAvail) {
        const from = qChord(r, fromType);
        const targets: { to: { root: number; type: string }; w: number }[] = [];

        for (const toType of quartalAvail) {
          // Stepwise M2 up — strongest quartal jazz motion
          targets.push({ to: qChord(stepUp, toType), w: W(4, "quartal") });
          // P4 up — quartal cycle (V→I motion recontextualized)
          targets.push({ to: qChord(q4Up, toType), w: W(3, "quartal") });
          // M2 down — retrograde stepwise
          targets.push({ to: qChord(stepDown, toType), w: W(2, "quartal") });
          // m3 up — color shift (C#→E, linking quartal plateaus)
          targets.push({ to: qChord(m3Up, toType), w: W(2, "quartal") });
          // P4 down (P5 up) — reverse quartal
          targets.push({ to: qChord(q4Down, toType), w: W(1, "quartal") });
        }
        addTrans(from, targets);
      }
    }
    // Bridge: diatonic chords can enter quartal territory and vice versa
    for (const t of quartalAvail) {
      // I / Imaj7 can enter quartal on same root or stepwise
      addTrans(I,     [{ to: qChord(0, t), w: W(2, "quartal") }, { to: qChord(M2, t), w: W(2, "quartal") }]);
      addTrans(Imaj7, [{ to: qChord(0, t), w: W(2, "quartal") }, { to: qChord(M2, t), w: W(2, "quartal") }]);
      // Quartal chords on tonic can resolve back to I
      addTrans(qChord(0, t), [{ to: I, w: W(2, "quartal") }, { to: Imaj7, w: W(2, "quartal") }]);
      // ii7 is already a quartal-adjacent voicing — bridge to quartal on ii root
      addTrans(ii7, [{ to: qChord(M2, t), w: W(3, "quartal") }]);
      // V7 can enter quartal (reharmonization)
      addTrans(V7, [{ to: qChord(P5, t), w: W(1, "quartal") }]);
    }
  }

  // ── CHROMATIC transitions — secondary dominants resolve to their targets ──
  // Collect all secondary dominants so resolution targets can approach them
  const allSecDoms: { root: number; type: string }[] = [];
  // First pass: register all secondary dominants as applied
  for (const { target } of secTargets) {
    const secDom = { root: (target + P5) % edo, type: "dom7" };
    allSecDoms.push(secDom);
    appliedEntries.add(entryKey(secDom)); // must resolve
  }
  // Second pass: add resolution transitions (excluding other applied chords at same root)
  for (let si = 0; si < secTargets.length; si++) {
    const { target } = secTargets[si];
    const secDom = allSecDoms[si];
    const targetChords = unique.filter(u =>
      ((u.root % edo + edo) % edo) === ((target % edo + edo) % edo) &&
      !appliedEntries.has(entryKey(u))); // exclude other secdoms at same root
    // Secondary dominant resolves to its target
    for (const tc of targetChords) {
      addTrans(secDom, [{ to: tc, w: W(5, "secdom") }]);
    }
  }
  // Resolution targets strongly approach the next secondary dominant (chain: V/vi→vi→V/ii→ii→V/V→V→I)
  // IMPORTANT: exclude applied chords (secondary dominants themselves share roots
  // with diatonic chords — e.g. V/ii is at root 23 = same as vi in 31-EDO)
  for (const { target } of secTargets) {
    const targetRoot = ((target % edo) + edo) % edo;
    const targetAsChord = unique.filter(u =>
      ((u.root % edo + edo) % edo) === targetRoot && !appliedEntries.has(entryKey(u)));
    for (const tc of targetAsChord) {
      // From each resolution target, go to ALL secondary dominants with high weight
      for (const sd of allSecDoms) {
        addTrans(tc, [{ to: sd, w: W(4, "secdom") }]);
      }
    }
  }
  // Approach weights per secondary dominant — V/V is most common, V/iii least
  const secApproachWeight: Record<string, number> = {
    "V/V": 4, "V/IV": 3, "V/ii": 3, "V/vi": 2, "V/iii": 1,
  };
  const secDomWithWeights = secTargets.map(({ target, label }) => ({
    sd: { root: (target + P5) % edo, type: "dom7" },
    approachW: secApproachWeight[label] ?? 2,
  }));
  addTrans(I,      secDomWithWeights.map(({ sd, approachW }) => ({ to: sd, w: W(approachW, "secdom") })));
  addTrans(Imaj7,  secDomWithWeights.map(({ sd, approachW }) => ({ to: sd, w: W(approachW, "secdom") })));
  addTrans(i,      secDomWithWeights.map(({ sd, approachW }) => ({ to: sd, w: W(Math.max(1, approachW - 1), "secdom") })));
  addTrans(i7,     secDomWithWeights.map(({ sd, approachW }) => ({ to: sd, w: W(Math.max(1, approachW - 1), "secdom") })));
  addTrans(IV,     secDomWithWeights.map(({ sd, approachW }) => ({ to: sd, w: W(Math.max(1, approachW - 1), "secdom") })));
  addTrans(IVmaj7, secDomWithWeights.map(({ sd, approachW }) => ({ to: sd, w: W(Math.max(1, approachW - 1), "secdom") })));
  addTrans(V,      secDomWithWeights.map(({ sd, approachW }) => ({ to: sd, w: W(Math.max(1, approachW - 1), "secdom") })));
  addTrans(V7,     secDomWithWeights.map(({ sd, approachW }) => ({ to: sd, w: W(Math.max(1, approachW - 1), "secdom") })));
  addTrans(vi,     secDomWithWeights.map(({ sd, approachW }) => ({ to: sd, w: W(Math.max(1, approachW - 1), "secdom") })));
  addTrans(vi7,    secDomWithWeights.map(({ sd, approachW }) => ({ to: sd, w: W(Math.max(1, approachW - 1), "secdom") })));

  // Tritone subs resolve down a half step (root = target + b2)
  const subV  = { root: b2, type: "dom7" };                       // TT/I: resolves to I
  const subVV = { root: (P5 + b2) % edo, type: "dom7" };          // TT/V: resolves to V
  appliedEntries.add(entryKey(subV));   // must resolve
  appliedEntries.add(entryKey(subVV));  // must resolve
  addTrans(subV,  [{ to: I, w: W(5,"tritone") }, { to: Imaj7, w: W(3,"tritone") }]);
  addTrans(subVV, [{ to: V, w: W(5,"tritone") }, { to: V7, w: W(3,"tritone") }]);
  // Neapolitan resolves to V
  appliedEntries.add(entryKey(bII_));   // must resolve
  addTrans(bII_,  [{ to: V, w: W(4,"neapolitan") }, { to: V7, w: W(3,"neapolitan") }]);
  // Approach tritone subs / Neapolitan from any resolution target
  const ttAndNea = [subV, subVV, bII_];
  for (const { target } of secTargets) {
    const targetRoot = ((target % edo) + edo) % edo;
    const targetAsChord = unique.filter(u =>
      ((u.root % edo + edo) % edo) === targetRoot && !appliedEntries.has(entryKey(u)));
    for (const tc of targetAsChord) {
      addTrans(tc, ttAndNea.map(t => ({ to: t, w: W(2, "secdom") })));
    }
  }
  addTrans(I,      ttAndNea.map(t => ({ to: t, w: W(2, "secdom") })));
  addTrans(Imaj7,  ttAndNea.map(t => ({ to: t, w: W(2, "secdom") })));
  addTrans(V,      ttAndNea.map(t => ({ to: t, w: W(2, "secdom") })));
  addTrans(V7,     ttAndNea.map(t => ({ to: t, w: W(2, "secdom") })));

  // ── SECONDARY DIMINISHED transitions — vii° resolves up a half step to its target ──
  if (cats.has("secdim")) {
    const dimType = shapes.find(c => c.id === "dim7") ? "dim7" : shapes.find(c => c.id === "dim") ? "dim" : null;
    if (dimType) {
      for (const { target } of secTargets) {
        const dimRoot = (target + M7) % edo;
        const secDim = { root: dimRoot, type: dimType };
        appliedEntries.add(entryKey(secDim)); // must resolve
        // Resolve to target (exclude other applied chords at same root)
        const targetChords = unique.filter(u =>
          ((u.root % edo + edo) % edo) === ((target % edo + edo) % edo) &&
          !appliedEntries.has(entryKey(u)));
        for (const tc of targetChords) {
          addTrans(secDim, [{ to: tc, w: W(4, "secdim") }]);
        }
        // Approach: any diatonic chord (including 7th variants) can go to a secondary diminished
        addTrans(I,      [{ to: secDim, w: W(2, "secdim") }]);
        addTrans(Imaj7,  [{ to: secDim, w: W(2, "secdim") }]);
        addTrans(IV,     [{ to: secDim, w: W(2, "secdim") }]);
        addTrans(IVmaj7, [{ to: secDim, w: W(2, "secdim") }]);
        addTrans(vi,     [{ to: secDim, w: W(2, "secdim") }]);
        addTrans(vi7,    [{ to: secDim, w: W(2, "secdim") }]);
      }
    }
  }

  // ── CHROMATIC MEDIANT transitions — third-related chords ──
  if (cats.has("mediants")) {
    const IIImaj  = { root: M3, type: "maj" };
    const biiimin = { root: m3, type: "min" };
    const bvimin  = { root: m6, type: "min" };
    const VImaj_m = { root: M6, type: "maj" };
    // Chromatic mediants resolve back to tonic or to each other
    addTrans(IIImaj,   [{ to: I, w: W(3,"mediants") }, { to: vi, w: W(2,"mediants") }, { to: IV, w: W(2,"mediants") }]);
    addTrans(biiimin,  [{ to: I, w: W(3,"mediants") }, { to: IV, w: W(2,"mediants") }, { to: bVI, w: W(1,"mediants") }]);
    addTrans(bvimin,   [{ to: I, w: W(2,"mediants") }, { to: V, w: W(3,"mediants") }, { to: iv, w: W(2,"mediants") }]);
    addTrans(VImaj_m,  [{ to: I, w: W(2,"mediants") }, { to: ii, w: W(3,"mediants") }, { to: IV, w: W(2,"mediants") }]);
    // Approach: I, V, vi (+ 7th variants) can reach mediants
    const mediantsFromI = [{ to: IIImaj, w: W(2,"mediants") }, { to: biiimin, w: W(1,"mediants") }, { to: VImaj_m, w: W(2,"mediants") }];
    addTrans(I,     mediantsFromI);
    addTrans(Imaj7, mediantsFromI);
    const mediantsFromV = [{ to: bvimin, w: W(2,"mediants") }, { to: VImaj_m, w: W(1,"mediants") }];
    addTrans(V,  mediantsFromV);
    addTrans(V7, mediantsFromV);
    addTrans(vi,  [{ to: IIImaj, w: W(2,"mediants") }]);
    addTrans(vi7, [{ to: IIImaj, w: W(2,"mediants") }]);
  }

  // ── NEAPOLITAN approach — more chords can reach bII ──
  if (cats.has("neapolitan")) {
    addTrans(vi,      [{ to: bII_, w: W(2,"neapolitan") }]);
    addTrans(vi7,     [{ to: bII_, w: W(2,"neapolitan") }]);
    addTrans(iv,      [{ to: bII_, w: W(3,"neapolitan") }]);
    addTrans(iv7,     [{ to: bII_, w: W(3,"neapolitan") }]);
    addTrans(iidim,   [{ to: bII_, w: W(2,"neapolitan") }]);
    addTrans(halfdim, [{ to: bII_, w: W(2,"neapolitan") }]);
    addTrans(i,       [{ to: bII_, w: W(2,"neapolitan") }]);
    addTrans(i7,      [{ to: bII_, w: W(2,"neapolitan") }]);
  }

  // ── TT/ii resolution (was missing) ──
  if (cats.has("tritone")) {
    const subVii = { root: (M2 + b2) % edo, type: "dom7" };
    appliedEntries.add(entryKey(subVii)); // must resolve
    addTrans(subVii, [{ to: ii, w: W(5,"tritone") }, { to: ii7, w: W(3,"tritone") }]);
    // ii can approach TT/ii
    addTrans(I,      [{ to: subVii, w: W(2,"tritone") }]);
    addTrans(Imaj7,  [{ to: subVii, w: W(2,"tritone") }]);
    addTrans(IV,     [{ to: subVii, w: W(2,"tritone") }]);
    addTrans(IVmaj7, [{ to: subVii, w: W(2,"tritone") }]);
  }

  // ── 7TH CHORD FUNCTIONAL TRANSITIONS ──

  addTrans(vi7,  [{ to: ii, w: W(3,"functional") }, { to: ii7, w: W(3,"functional") }, { to: IV, w: W(2,"functional") }]);
  addTrans(iii7, [{ to: vi, w: W(3,"functional") }, { to: vi7, w: W(2,"functional") }, { to: IV, w: W(2,"functional") }]);
  addTrans(iv7,  [{ to: V, w: W(3,"functional") }, { to: V7, w: W(3,"functional") }, { to: i, w: W(2,"functional") }]);
  // Half-diminished 7th (iiø7 in minor) — key pre-dominant
  addTrans(halfdim, [{ to: V, w: W(4,"functional") }, { to: V7, w: W(4,"functional") }, { to: i, w: W(1,"functional") }]);
  // Approach halfdim from minor tonic family
  addTrans(i,  [{ to: halfdim, w: W(2,"functional") }]);
  addTrans(VI, [{ to: halfdim, w: W(2,"functional") }]);

  // ── XENHARMONIC transitions — xen chords substitute and resolve ──
  const xenSubs: { diatonic: { root: number; type: string }; xen: { root: number; type: string } }[] = [];
  // Build substitution pairs: each xen chord at a root substitutes for the nearest diatonic.
  // Include chromatic roots (m3, b2, m6, m7) so xen chords on borrowed roots also have transitions.
  for (const r of [0, M2, M3, P4, P5, M6, m3, m6, m7, b2, d5]) {
    for (const xt of xenTriads) {
      const xenChord = { root: r, type: xt.id };
      // submin/clmin → minor, supermaj/clmaj → major, neutral → either
      const diaType = xt.id.includes("min") || xt.id === "submin" ? "min"
        : xt.id.includes("maj") || xt.id === "supermaj" ? "maj" : "maj";
      xenSubs.push({ diatonic: { root: r, type: diaType }, xen: xenChord });
    }
  }
  for (const { diatonic: dia, xen } of xenSubs) {
    // Diatonic can move to its xen substitute — weight must compete
    // with standard functional transitions (9–15) to actually appear
    const xenFam = xenFamily(xen.type, edo);
    addTrans(dia, [{ to: xen, w: xenFam && cats.has(xenFam) ? 5 * 3 : 2 }]);
    // Xen chord inherits the resolution of its diatonic relative
    const diaKey = entryKey(dia);
    const diaTrans = transitions.get(diaKey);
    if (diaTrans) {
      addTrans(xen, diaTrans.map(t => ({ to: keyToEntry_tmp(t.target), w: Math.ceil(t.weight * 0.7) })).filter(t => t.to !== null) as { to: { root: number; type: string }; w: number }[]);
    }
  }

  // Temp helper for xen transition copying (before keyToEntry is built)
  function keyToEntry_tmp(key: string): { root: number; type: string } | null {
    const match = key.match(/^(\d+):(.+)$/);
    if (!match) return null;
    return { root: Number(match[1]), type: match[2] };
  }

  // ── VOICE-LEADING TRANSITIONS for chromatic pools ──
  // When chromDia or chrom31 is enabled, build transitions based on
  // voice-leading distance: common tones + half-step connections.
  // This replaces the blunt chromEscape random jump with real Markov logic.
  if (cats.has("chromDia") || cats.has("chrom31")) {
    // Precompute PC sets for all unique entries
    const pcSets = new Map<string, Set<number>>();
    for (const u of unique) {
      const ct = shapes.find(c => c.id === u.type);
      if (!ct) continue;
      const absRoot = ((u.root + tonicRoot) % edo + edo) % edo;
      pcSets.set(entryKey(u), new Set(ct.steps.map(s => (s + absRoot) % edo)));
    }

    // For each chord, find the N best voice-leading neighbors
    const MAX_NEIGHBORS = 8;
    for (const u of unique) {
      const uKey = entryKey(u);
      const uPcs = pcSets.get(uKey);
      if (!uPcs) continue;
      // Already has strong transitions from functional/modal/chromatic rules — skip
      const existing = transitions.get(uKey);
      if (existing && existing.length >= 4) continue;

      // Score all other chords by voice-leading quality + root motion cycles.
      // Root motion cycles (Cohn, Tymoczko, Lerdahl):
      //   P4 up / P5 down: strongest functional motion (weight 5)
      //   m3/M3:           mediant relationships (weight 3)
      //   P5 up / P4 down: retrograde functional (weight 2)
      //   m6/M6:           inverted thirds (weight 3)
      //   M2/m2:           stepwise root motion (weight 2)
      const uRoot = ((u.root + tonicRoot) % edo + edo) % edo;
      const scored: { entry: typeof u; vlScore: number }[] = [];
      for (const v of unique) {
        const vKey = entryKey(v);
        if (vKey === uKey) continue;
        const vPcs = pcSets.get(vKey);
        if (!vPcs) continue;

        // Voice-leading score: common tones + half-step connections
        let commonTones = 0;
        let halfSteps = 0;
        for (const pc of vPcs) {
          if (uPcs.has(pc)) commonTones++;
          else {
            for (const upc of uPcs) {
              const d = ((pc - upc) % edo + edo) % edo;
              if (d >= 1 && d <= 2 || d >= edo - 2) { halfSteps++; break; }
            }
          }
        }
        const vlScore = commonTones * 2 + halfSteps;

        // Root motion score: how strong is the root relationship?
        const vRoot = ((v.root + tonicRoot) % edo + edo) % edo;
        const rootInterval = ((vRoot - uRoot) % edo + edo) % edo;
        let rootScore = 0;
        // Cycle of 4ths (up P4): strongest — ii→V→I→IV
        if (rootInterval === P4) rootScore = 5;
        // Cycle of 5ths (up P5 = down P4): retrograde functional
        else if (rootInterval === P5) rootScore = 2;
        // Cycle of minor 3rds: chromatic mediant (dim chord cycle)
        else if (rootInterval === m3 || rootInterval === edo - m3) rootScore = 3;
        // Cycle of major 3rds: chromatic mediant (aug chord cycle)
        else if (rootInterval === M3 || rootInterval === edo - M3) rootScore = 3;
        // Cycle of minor 6ths / major 6ths: inverted thirds
        else if (rootInterval === m6 || rootInterval === M6) rootScore = 3;
        // Stepwise root motion (up/down M2 or m2)
        else if (rootInterval === M2 || rootInterval === edo - M2) rootScore = 2;
        else if (rootInterval <= 2 || rootInterval >= edo - 2) rootScore = 2;

        const totalScore = vlScore + rootScore;
        if (totalScore > 0) scored.push({ entry: v, vlScore: totalScore });
      }

      // Take top N neighbors
      scored.sort((a, b) => b.vlScore - a.vlScore);
      const neighbors = scored.slice(0, MAX_NEIGHBORS);
      if (neighbors.length > 0) {
        addTrans(u, neighbors.map(n => ({ to: n.entry, w: n.vlScore })));
      }
    }
  }

  // ── INHERIT TRANSITIONS — chords without transitions inherit from same-root diatonic ──
  // When quality filters or altered mode inject non-standard chord types at
  // diatonic roots (e.g. halfdim7 on iii, dom7 on vi), they need Markov
  // transitions. Find the nearest diatonic relative at the same root and
  // copy its transitions, so injected chords behave functionally.
  for (const u of unique) {
    const uKey = entryKey(u);
    if (transitions.has(uKey)) continue; // already has transitions
    // Find a chord at the same root that DOES have transitions
    const sameRoot = unique.filter(v =>
      v.root === u.root && v.type !== u.type && transitions.has(entryKey(v)));
    if (sameRoot.length > 0) {
      // Pick the one with the most transitions (most connected)
      sameRoot.sort((a, b) => (transitions.get(entryKey(b))?.length ?? 0) - (transitions.get(entryKey(a))?.length ?? 0));
      const donor = sameRoot[0];
      const donorTrans = transitions.get(entryKey(donor));
      if (donorTrans) {
        // Inherit outgoing transitions (slightly lower weight)
        addTrans(u, donorTrans.map(t => ({ to: keyToEntry_tmp(t.target), w: Math.ceil(t.weight * 0.6) })).filter(t => t.to !== null) as { to: { root: number; type: string }; w: number }[]);
      }
      // Also let the donor's incoming sources reach this chord
      for (const [fromKey, fromTrans] of transitions) {
        if (fromTrans.some(t => t.target === entryKey(donor)) && !fromTrans.some(t => t.target === uKey)) {
          const from = keyToEntry_tmp(fromKey);
          if (from) addTrans(from, [{ to: u, w: 1 }]);
        }
      }
    }
  }

  // ── UNIVERSAL FALLBACK — ensure every chord in the pool has at least one transition ──
  for (const u of unique) {
    const key = entryKey(u);
    if (!transitions.has(key)) {
      const tonicTargets = tonality === "minor" ? [i, i7] : tonality === "major" ? [I, Imaj7] : [I, Imaj7, i, i7];
      addTrans(u, tonicTargets.map(t => ({ to: t, w: 2 })));
    }
    const tonicSources = tonality === "minor" ? [i] : tonality === "major" ? [I] : [I, i];
    for (const src of tonicSources) {
      const srcKey = entryKey(src);
      const srcTrans = transitions.get(srcKey) ?? [];
      if (!srcTrans.some(t => t.target === key)) {
        addTrans(src, [{ to: u, w: 1 }]);
      }
    }
  }

  // Weighted random pick from transition list
  const pickFromTransitions = (trans: Transition): string => {
    const total = trans.reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * total;
    for (const t of trans) {
      r -= t.weight;
      if (r <= 0) return t.target;
    }
    return trans[trans.length - 1].target;
  };

  // Build an index from entryKey → pool entry for fast lookup
  const keyToEntry = new Map<string, { root: number; type: string }>();
  for (const u of unique) keyToEntry.set(entryKey(u), u);

  // ── Root-based Markov: merge transitions by root ──
  // The Markov chain should select the next HARMONIC FUNCTION (root),
  // then pick a chord type at that root.  This prevents fragmented
  // transitions when the same root has multiple types (I vs Imaj7).
  // Preserve the full PoolEntry (including `layer`) so pickTypeAtRoot can
  // weight chord types by their harmonic category.
  const rootToEntries = new Map<number, PoolEntry[]>();
  for (const u of unique) {
    const r = ((u.root % edo) + edo) % edo;
    if (!rootToEntries.has(r)) rootToEntries.set(r, []);
    rootToEntries.get(r)!.push(u as PoolEntry);
  }

  // Merge all transitions from entries at the same root into a root→root map.
  // Target weights are summed by target ROOT (not individual entry).
  type RootTransition = { targetRoot: number; weight: number }[];
  const rootTransitions = new Map<number, RootTransition>();
  for (const [root, entries] of rootToEntries) {
    const targetWeights = new Map<number, number>();
    for (const entry of entries) {
      const trans = transitions.get(entryKey(entry));
      if (!trans) continue;
      for (const t of trans) {
        const targetEntry = keyToEntry.get(t.target);
        if (!targetEntry) continue;
        const tRoot = ((targetEntry.root % edo) + edo) % edo;
        targetWeights.set(tRoot, (targetWeights.get(tRoot) ?? 0) + t.weight);
      }
    }
    const rootTrans: RootTransition = [];
    for (const [tRoot, w] of targetWeights) rootTrans.push({ targetRoot: tRoot, weight: w });
    if (rootTrans.length > 0) rootTransitions.set(root, rootTrans);
  }

  // Track which roots are applied (must resolve — don't filter)
  const appliedRoots = new Set<number>();
  for (const key of appliedEntries) {
    const entry = keyToEntry.get(key);
    if (entry) appliedRoots.add(((entry.root % edo) + edo) % edo);
  }

  // Pick a chord type at a given root, weighted by layer so selected
  // non-functional categories actually surface when their root is shared with
  // a diatonic chord. Without this, "root=0" would pick "maj" vs "sus4" 50/50
  // even with only Quartal selected — the Markov's W bias only steers the
  // root choice, not the chord-type choice at that root. Layer weights:
  //   - selected non-functional layer: ×8 (mirrors W() bias strength)
  //   - selected functional layer:     ×2 (or ×3 if no non-functional picks)
  //   - unselected layer:              ×1 (still possible when the selected
  //                                        category has no chord at this root)
  const nonFunctionalCatCount = [...cats].filter(c => c !== "functional").length;
  const pickTypeAtRoot = (root: number): { root: number; type: string } => {
    const entries = rootToEntries.get(root);
    if (!entries || entries.length === 0) return unique[Math.floor(Math.random() * unique.length)];
    const weights = entries.map(e => {
      const layer = (e as PoolEntry).layer;
      if (!cats.has(layer)) return 1;
      if (layer === "functional") return nonFunctionalCatCount > 0 ? 2 : 3;
      return 8;
    });
    const total = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    for (let i = 0; i < entries.length; i++) {
      r -= weights[i];
      if (r <= 0) return entries[i];
    }
    return entries[entries.length - 1];
  };

  // Weighted random pick from root transitions
  const pickRoot = (trans: RootTransition): number => {
    const total = trans.reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * total;
    for (const t of trans) {
      r -= t.weight;
      if (r <= 0) return t.targetRoot;
    }
    return trans[trans.length - 1].targetRoot;
  };

  // Start on tonic
  let currentRoot: number;
  if (cats.has("chrom31") || cats.has("chromDia")) {
    currentRoot = ((unique[Math.floor(Math.random() * unique.length)].root % edo) + edo) % edo;
  } else {
    const tonicRoot_ = tonality === "minor" ? ((i.root % edo) + edo) % edo : 0;
    currentRoot = rootToEntries.has(tonicRoot_) ? tonicRoot_ : 0;
  }

  // Fallback: pick any root that has outgoing transitions
  const rootsWithTrans = [...rootTransitions.keys()];
  const pickFallbackRoot = () => rootsWithTrans.length > 0
    ? rootsWithTrans[Math.floor(Math.random() * rootsWithTrans.length)]
    : ((unique[Math.floor(Math.random() * unique.length)].root % edo) + edo) % edo;

  // Determine which non-functional categories the user selected
  // so we can guarantee at least one chord from each appears.
  const selectedNonFunc = [...cats].filter(c =>
    c !== "functional" && !c.startsWith("xen_") && c !== "chromDia" && c !== "chrom31");
  // Map each non-functional category to the pool entries that belong to it.
  // Use transitions as the source of truth: chords reachable via category-specific
  // transitions belong to that category (even if deduplicated to a different layer).
  const catEntries = new Map<string, string[]>();
  for (const cat of selectedNonFunc) {
    const entries: string[] = [];
    // For modal: chords at modal roots (m3, m6, m7, b2, P4) with modal transitions
    // For secdom: chords with V/ roman override
    // For others: chords from that category's pool (before dedup)
    for (const p of pool) {
      if (p.layer === cat || (p.romanOverride && (
        (cat === "secdom" && p.romanOverride.startsWith("V/")) ||
        (cat === "secdim" && p.romanOverride.startsWith("vii°/")) ||
        (cat === "tritone" && p.romanOverride.startsWith("TT/"))
      ))) {
        const key = entryKey(p);
        if (keyToEntry.has(key) && !entries.includes(key)) entries.push(key);
      }
    }
    // For modal: also include chords that have modal transitions defined
    if (cat === "modal") {
      const modalRoots = new Set([m3, m6, m7, b2, P4].map(r => ((r % edo) + edo) % edo));
      for (const u of unique) {
        const uRoot = ((u.root % edo) + edo) % edo;
        if (modalRoots.has(uRoot) && !entries.includes(entryKey(u))) {
          entries.push(entryKey(u));
        }
      }
    }
    if (entries.length > 0) catEntries.set(cat, entries);
  }

  const result: ProgChord[] = [];
  const recentRoots: number[] = [];
  const HISTORY = 3; // avoid repeating roots from the last N
  const appearedCats = new Set<string>();
  // Track the specific entry for applied chord detection
  let currentEntry: { root: number; type: string } | null = null;

  for (let idx = 0; idx < count; idx++) {
    const isLast = idx === count - 1;
    // Pick a chord type at the current root
    // If we arrived here via applied chord resolution, use the specific entry
    let current = currentEntry ?? pickTypeAtRoot(currentRoot);
    currentEntry = null; // reset
    // Never end on an applied chord (V/x, TT/x, vii°/x) — it can't resolve
    if (isLast && appliedEntries.has(entryKey(current))) {
      const nonApplied = (rootToEntries.get(currentRoot) ?? [])
        .filter(e => !appliedEntries.has(entryKey(e)));
      if (nonApplied.length > 0) {
        current = nonApplied[Math.floor(Math.random() * nonApplied.length)];
      } else {
        // No non-applied chord at this root — fall back to tonic
        const tonicRoot = tonality === "minor" ? ((i.root % edo) + edo) % edo : 0;
        current = pickTypeAtRoot(tonicRoot);
      }
    }
    const chord = mkChord(current.root, current.type);
    if (chord) {
      result.push({ roman: chord.roman, chordPcs: chord.chordPcs, root: chord.root, chordTypeId: chord.typeId });
    } else {
      result.push({ roman: "I", chordPcs: [0, M3, P5].map(s => s % edo), root: 0, chordTypeId: "maj" });
    }
    // Track categories
    const curKey = entryKey(current);
    for (const [cat, entries] of catEntries) {
      if (entries.includes(curKey)) appearedCats.add(cat);
    }
    recentRoots.push(currentRoot);
    if (recentRoots.length > HISTORY) recentRoots.shift();

    // Applied chords use entry-level transitions (forced resolution),
    // non-applied chords use root-merged transitions (harmonic function)
    const isApplied = appliedEntries.has(curKey);

    if (isApplied) {
      // V/x, TT/x, vii°/x MUST resolve via their specific transitions
      const entryTrans = transitions.get(curKey);
      if (entryTrans && entryTrans.length > 0) {
        const nextKey = pickFromTransitions(entryTrans);
        const nextEntry = keyToEntry.get(nextKey);
        if (nextEntry) {
          currentRoot = ((nextEntry.root % edo) + edo) % edo;
          currentEntry = nextEntry; // preserve the specific resolution target
        } else {
          currentRoot = pickFallbackRoot();
        }
      } else {
        currentRoot = pickFallbackRoot();
      }
    } else {
      // Non-applied: use root-merged Markov for harmonic function
      const trans = rootTransitions.get(currentRoot);
      if (trans && trans.length > 0) {
        const recentSet = new Set(recentRoots);
        // On penultimate chord, avoid targeting applied-only roots
        // (roots where every chord type is applied — would force applied as last)
        const isNextLast = idx === count - 2;
        const filtered = trans.filter(t => {
          if (recentSet.has(t.targetRoot)) return false;
          if (isNextLast) {
            const entries = rootToEntries.get(t.targetRoot);
            if (entries && entries.every(e => appliedEntries.has(entryKey(e)))) return false;
          }
          return true;
        });
        const noPrev = trans.filter(t => t.targetRoot !== currentRoot);
        const pool = filtered.length > 0 ? filtered
          : noPrev.length > 0 ? noPrev
          : trans;
        currentRoot = pickRoot(pool);
      } else {
        currentRoot = pickFallbackRoot();
      }
    }
  }

  // ── Guarantee: inject missing categories ──
  // If a selected non-functional category has zero representation,
  // replace one interior diatonic chord with [approach → chromatic chord].
  // Only do this if there's room (count >= 3).
  if (count >= 3) {
    for (const [cat, entries] of catEntries) {
      if (appearedCats.has(cat)) continue;
      // Find a diatonic chord in the interior (not first/last) to replace
      for (let replaceIdx = 1; replaceIdx < result.length - 1; replaceIdx++) {
        const replKey = `${((result[replaceIdx].root - tonicRoot) % edo + edo) % edo}:${result[replaceIdx].chordTypeId}`;
        // Don't replace already-injected chromatic chords
        if (appliedEntries.has(replKey)) continue;
        // Pick a random entry from this category
        const catEntry = entries[Math.floor(Math.random() * entries.length)];
        const entry = keyToEntry.get(catEntry);
        if (!entry) continue;
        const chord = mkChord(entry.root, entry.type);
        if (!chord) continue;
        result[replaceIdx] = { roman: chord.roman, chordPcs: chord.chordPcs, root: chord.root, chordTypeId: chord.typeId };
        // If this is an applied chord, also inject its resolution after it
        if (appliedEntries.has(catEntry)) {
          const resTrans = transitions.get(catEntry);
          if (resTrans && resTrans.length > 0 && replaceIdx + 1 < result.length) {
            const resKey = pickFromTransitions(resTrans);
            const resEntry = keyToEntry.get(resKey);
            if (resEntry) {
              const resChord = mkChord(resEntry.root, resEntry.type);
              if (resChord) {
                result[replaceIdx + 1] = { roman: resChord.roman, chordPcs: resChord.chordPcs, root: resChord.root, chordTypeId: resChord.typeId };
              }
            }
          }
        }
        break;
      }
    }
  }

  // Mark quartal-pool chords with a "^Qua" suffix so the display can render
  // "Qua" as a superscript next to the roman numeral. Recognising quartal
  // entries by membership in the quartal pool avoids mis-labelling a diatonic
  // chord that happens to share (root, type) with a quartal voicing.
  if (cats.has("quartal") && quartalPool.length > 0) {
    const quartalKeys = new Set(quartalPool.map(entryKey));
    for (let i = 0; i < result.length; i++) {
      const c = result[i];
      if (!c) continue;
      const relRoot = ((c.root - tonicRoot) % edo + edo) % edo;
      const key = `${relRoot}:${c.chordTypeId}`;
      if (quartalKeys.has(key) && !c.roman.includes("^Qua")) {
        result[i] = { ...c, roman: c.roman + "^Qua" };
      }
    }
  }

  return result;
}

// ── Multi-Tonic System Generator ─────────────────────────────────────
// Generates progressions that modulate through multiple key centers.
// Uses the existing Markov chain within each key, but shifts tonicRoot
// according to the selected cycle pattern.

export type MultiTonicCycle = "major3rd" | "minor3rd" | "chromatic" | "tritone" | "wholeTone";

/** Return key center roots (as EDO steps) for a given cycle starting at 0. */
export function getMultiTonicCenters(edo: number, cycle: MultiTonicCycle): number[] {
  const dm = getDegreeMap(edo);
  const M3 = dm["3"] ?? Math.round(edo * 4 / 12);
  const m3 = dm["b3"] ?? Math.round(edo * 3 / 12);
  const M2 = dm["2"] ?? Math.round(edo * 2 / 12);
  const TT = dm["b5"] ?? Math.round(edo / 2);

  switch (cycle) {
    case "major3rd":   // Coltrane changes: C → E → Ab → C
      return [0, M3, M3 * 2].map(r => ((r % edo) + edo) % edo);
    case "minor3rd":   // Diminished axis: C → Eb → Gb → A → C
      return [0, m3, m3 * 2, m3 * 3].map(r => ((r % edo) + edo) % edo);
    case "tritone":    // Tritone axis: C → F# → C
      return [0, TT].map(r => ((r % edo) + edo) % edo);
    case "wholeTone":  // Whole-tone cycle: C → D → E → F# → G# → A# → C
      return Array.from({ length: Math.floor(edo / M2) }, (_, i) => ((i * M2) % edo + edo) % edo);
    case "chromatic":  // All chromatic keys
      return Array.from({ length: edo }, (_, i) => i);
  }
}

/**
 * Generate a multi-tonic progression: cycles through key centers,
 * generating `chordsPerCenter` chords in each key using the existing
 * Markov chain. Roman numerals are annotated with key center info.
 */
export function generateMultiTonicProgression(
  edo: number,
  cycle: MultiTonicCycle,
  chordsPerCenter: number,
  categories: Set<HarmonyCategory> | ChordComplexity | Set<ChordComplexity>,
  mode: ProgressionMode = "functional",
  minChordNotes: number = 2,
  tonality: Tonality = "both",
  baseTonicRoot: number = 0,
  seventhFilter?: Set<string>,
  thirdFilter?: Set<string>,
  includeAltered?: boolean,
): ProgChord[] {
  const centers = getMultiTonicCenters(edo, cycle);
  const result: ProgChord[] = [];
  const degNames = getFullDegreeNames(edo);

  for (const centerOffset of centers) {
    const absRoot = ((baseTonicRoot + centerOffset) % edo + edo) % edo;
    const keyLabel = degNames[centerOffset] ?? `${centerOffset}`;
    const segment = generateProgression(
      edo, chordsPerCenter, categories, mode,
      minChordNotes, tonality, absRoot,
      seventhFilter, thirdFilter, includeAltered,
    );
    // Annotate roman numerals with key center
    for (const ch of segment) {
      result.push({
        ...ch,
        roman: centers.length > 1 ? `${ch.roman} [${keyLabel}]` : ch.roman,
      });
    }
  }
  return result;
}

/**
 * Pick a chord for a melody from the complexity-appropriate pool.
 * Ranks candidates by overlap with the melody and picks randomly
 * from the top tier.
 */
export function pickChordForMelodyAtComplexity(
  melodyPcs: number[],
  edo: number,
  complexity: ChordComplexity,
  excludeKey?: string,
  minChordNotes: number = 2,
  fitRange: [number, number] = [0, 0.30],
  tonality: Tonality = "both",
): { roman: string; chordPcs: number[]; overlap: number; root: number; chordTypeId: string } | null {
  const unique = generateProgression(edo, 0, complexity, "pool", minChordNotes, tonality);

  // Score each by overlap
  const scored = unique.map(ch => ({
    ...ch,
    overlap: chordMelodyOverlap(melodyPcs, ch.chordPcs, edo),
    key: [...ch.chordPcs].sort((a, b) => a - b).join(","),
  })).filter(ch => !excludeKey || ch.key !== excludeKey);

  if (scored.length === 0) return null;

  // fitRange [lo, hi] as actual overlap thresholds (0 = no chord tones, 1 = all chord tones)
  // Invert: lo fitRange = best fit (high overlap), hi fitRange = worst fit (low overlap)
  const minOverlap = 1 - fitRange[1];  // hi slider → low overlap threshold
  const maxOverlap = 1 - fitRange[0];  // lo slider → high overlap threshold
  let slice = scored.filter(ch => ch.overlap >= minOverlap && ch.overlap <= maxOverlap);

  // Fallback: if nothing matches the range, pick closest to the range midpoint
  if (slice.length === 0) {
    const targetOverlap = 1 - (fitRange[0] + fitRange[1]) / 2;
    scored.sort((a, b) => Math.abs(a.overlap - targetOverlap) - Math.abs(b.overlap - targetOverlap));
    slice = scored.slice(0, Math.max(3, Math.floor(scored.length * 0.2)));
  }

  const pick = slice[Math.floor(Math.random() * slice.length)];
  return { roman: pick.roman, chordPcs: pick.chordPcs, overlap: pick.overlap, root: pick.root, chordTypeId: pick.chordTypeId };
}

// ── Sorting ──────────────────────────────────────────────────────────

interface EdoParams { T: number; s: number; A1: number; }
const DIATONIC: Record<number, EdoParams> = {
  12: { T: 2, s: 1, A1: 1 },
  31: { T: 5, s: 3, A1: 2 },
  41: { T: 7, s: 3, A1: 4 },
};

export type SortMode = "default" | "stepwise" | "angular" | "ascending" | "descending";

export function sortPatterns(patterns: number[][], edo: number, mode: SortMode): number[][] {
  if (mode === "default") return patterns;
  const scored = patterns.map(p => {
    const ivs = getIntervals(p);
    const P = DIATONIC[edo] ?? DIATONIC[31];
    const step = ivs.filter(i => Math.abs(i) <= P.T + 1).length / Math.max(1, ivs.length);
    const up = ivs.filter(i => i > 0).length;
    const down = ivs.filter(i => i < 0).length;
    return { p, step, up, down };
  });
  switch (mode) {
    case "stepwise": scored.sort((a, b) => b.step - a.step); break;
    case "angular": scored.sort((a, b) => a.step - b.step); break;
    case "ascending": scored.sort((a, b) => b.up - a.up); break;
    case "descending": scored.sort((a, b) => b.down - a.down); break;
  }
  return scored.map(s => s.p);
}

// ── Helpers ──────────────────────────────────────────────────────────

export function totalPatternCount(pitchCount: number, length: number, allowRepeats: boolean): number {
  if (!allowRepeats && pitchCount < length) return 0;
  return allowRepeats ? Math.pow(pitchCount, length) : perm(pitchCount, length);
}

// ── Drill chord palette ──────────────────────────────────────────────

export interface DrillChord {
  roman: string;
  steps: number[];       // intervals from root (e.g. [0, M3, P5, m7])
  root: number;          // root as interval from tonic (before tonicRoot transposition)
  chordTypeId: string;
  group: string;         // "diatonic" | "modal" | "secondary" | "tritone" | "neapolitan" | "xen"
}

/**
 * Full chord palette for the pattern drill, reusing the same chord types
 * and root pairings as generateProgression.
 */
export function getDrillChordPalette(edo: number): DrillChord[] {
  const shapes = getEdoChordTypes(edo);
  const dm = getDegreeMap(edo);
  const { M3, m3, P4, P5, m7, M7, M2 } = getEDOIntervals(edo);
  const m6 = dm["b6"] ?? m3 + P5;
  const M6 = dm["6"] ?? P5 + M2;
  const d5 = dm["b5"] ?? P4 + 1;
  const b2 = dm["b2"] ?? 1;

  const mk = (rootStep: number, typeId: string, group: string, romanOverride?: string): DrillChord | null => {
    const ct = shapes.find(c => c.id === typeId);
    if (!ct) return null;
    const relRoot = ((rootStep % edo) + edo) % edo;
    const roman = romanOverride ?? toRomanNumeral(edo, relRoot, ct.abbr, ct.steps.map(s => (s + relRoot) % edo));
    return { roman, steps: ct.steps, root: relRoot, chordTypeId: typeId, group };
  };

  const results: DrillChord[] = [];
  const seen = new Set<string>();
  const add = (c: DrillChord | null) => {
    if (!c) return;
    const key = `${c.roman}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(c);
  };

  // Diatonic major (Ionian)
  add(mk(0,  "maj", "diatonic-major"));   add(mk(0,  "maj7", "diatonic-major"));   add(mk(0, "dom7", "diatonic-major"));
  add(mk(M2, "min", "diatonic-major"));   add(mk(M2, "min7", "diatonic-major"));
  add(mk(M3, "min", "diatonic-major"));   add(mk(M3, "min7", "diatonic-major"));
  add(mk(P4, "maj", "diatonic-major"));   add(mk(P4, "maj7", "diatonic-major"));
  add(mk(P5, "maj", "diatonic-major"));   add(mk(P5, "dom7", "diatonic-major"));
  add(mk(M6, "min", "diatonic-major"));   add(mk(M6, "min7", "diatonic-major"));
  add(mk(M7, "dim", "diatonic-major"));   add(mk(M7, "halfdim7", "diatonic-major"));
  // Sus chords (common in major/mixolydian context)
  add(mk(0,  "sus2", "diatonic-major"));   add(mk(0,  "sus4", "diatonic-major"));
  add(mk(0,  "dom7sus4", "diatonic-major"));
  add(mk(P5, "sus4", "diatonic-major"));   add(mk(P5, "dom7sus4", "diatonic-major"));

  // Natural minor (Aeolian)
  add(mk(0,  "min", "diatonic-minor"));   add(mk(0,  "min7", "diatonic-minor"));
  add(mk(M2, "dim", "diatonic-minor"));   add(mk(M2, "halfdim7", "diatonic-minor"));
  add(mk(m3, "maj", "diatonic-minor"));   add(mk(m3, "maj7", "diatonic-minor"));
  add(mk(P4, "min", "diatonic-minor"));   add(mk(P4, "min7", "diatonic-minor"));
  add(mk(P5, "min", "diatonic-minor"));   add(mk(P5, "min7", "diatonic-minor"));
  add(mk(m6, "maj", "diatonic-minor"));   add(mk(m6, "maj7", "diatonic-minor"));
  add(mk(m7, "maj", "diatonic-minor"));   add(mk(m7, "dom7", "diatonic-minor"));

  // Harmonic minor — raised 7th gives V7→i, vii°, III+
  add(mk(0,  "minmaj7", "harmonic-minor"));
  add(mk(m3, "aug", "harmonic-minor"));   add(mk(m3, "augmaj7", "harmonic-minor"));
  // V and V7 already in major; vii° and viiø7 already in major (same pitch)
  // i°7 = full diminished 7th on leading tone (enharmonic)
  add(mk(M7, "dim7", "harmonic-minor"));

  // Melodic minor — raised 6th+7th gives ii, IV, vi°
  add(mk(M2, "min", "melodic-minor"));    add(mk(M2, "min7", "melodic-minor"));
  add(mk(P4, "maj", "melodic-minor"));    add(mk(P4, "dom7", "melodic-minor"));
  add(mk(M6, "dim", "melodic-minor"));    add(mk(M6, "halfdim7", "melodic-minor"));

  // Modal
  add(mk(P4, "dom7", "modal"));
  add(mk(b2, "maj", "modal"));      add(mk(b2, "dom7", "modal"));
  if (dm["#4"] != null) {
    add(mk(dm["#4"], "maj", "modal"));
    add(mk(dm["#4"], "dom7", "modal"));
  }
  add(mk(M6, "dom7", "modal"));

  // Secondary dominants
  const secTargets = [
    { target: M2, label: "V/ii" },  { target: M3, label: "V/iii" },
    { target: P4, label: "V/IV" },  { target: P5, label: "V/V" },
    { target: M6, label: "V/vi" },
  ];
  for (const { target, label } of secTargets) {
    add(mk((target + P5) % edo, "dom7", "secondary", label));
  }

  // Secondary diminished
  const dimType = shapes.find(c => c.id === "dim7") ? "dim7" : shapes.find(c => c.id === "dim") ? "dim" : null;
  if (dimType) {
    for (const { target, label } of secTargets) {
      add(mk((target + M7) % edo, dimType, "secondary", label.replace("V/", "vii°/")));
    }
  }

  // Tritone subs
  add(mk(b2, "dom7", "tritone", "TT/I"));
  add(mk((P5 + b2) % edo, "dom7", "tritone", "TT/V"));
  add(mk((M2 + b2) % edo, "dom7", "tritone", "TT/ii"));

  // Neapolitan
  add(mk(b2, "maj7", "neapolitan"));


  // Xenharmonic (31-EDO / 41-EDO specific)
  const xenIds = ["submin", "neutral", "supermaj", "clmin", "clmaj",
    "submin_h7", "submin_m7", "submin_M7", "harm7",
    "neu_h7", "neu_m7", "neu_M7",
    "sup_h7", "sup_m7", "sup_M7", "min_h7", "maj_n7"];
  for (const id of xenIds) {
    if (shapes.find(c => c.id === id)) {
      add(mk(0, id, "xen"));
      add(mk(P5, id, "xen"));
    }
  }

  return results;
}
