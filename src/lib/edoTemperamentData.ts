/**
 * Structured EDO temperament data parsed from Xenharmonic Wiki
 * (edo_regular_temperament_properties.md, EDOs 5–99)
 *
 * Contains: harmonic errors, ring structure, commas tempered,
 * named temperaments, and cross-EDO relationships.
 */

import { getIntervalNames } from "./edoData";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface HarmonicError {
  /** Absolute error in cents */
  abs: number;
  /** Relative error as percentage of step size */
  rel: number;
  /** Steps (unreduced) */
  steps: number;
  /** Steps reduced to within EDO */
  reduced: number;
}

export interface EDOData {
  edo: number;
  /** Ring structure info */
  ring: {
    type: "single" | "multi";
    /** Number of independent rings */
    count: number;
    /** Notes per ring */
    notesPerRing: number;
    /** Fifth in steps */
    fifthSteps: number;
    /** Fifth in cents */
    fifthCents: number;
  };
  /** Harmonic approximation errors, keyed by harmonic number */
  harmonics: Record<number, HarmonicError>;
  /** Commas tempered out (extracted from prose) */
  commasTempered: { n: number; d: number; name: string }[];
  /** Named temperaments supported */
  temperaments: string[];
  /** Subset EDOs */
  subsets: number[];
  /** Is a prime EDO? */
  isPrime: boolean;
  /** Zeta properties */
  zetaProps: string[];
  /** Consistency info (odd-limit) */
  consistencyLimit: number | null;
  /** Step size in cents */
  stepCents: number;
  /** Best subgroup approximation (primes with <25% relative error) */
  goodSubgroup: number[];
  /** Dual fifths: if the EDO has a usable sharp AND flat fifth candidate */
  dualFifths: { sharp: { steps: number; cents: number }; flat: { steps: number; cents: number } } | null;
  /** MOS patterns (moment of symmetry scales) from stacking the best fifth */
  mosPatterns: { L: number; s: number; steps: string }[];
  /** Circle of fifths: ordered pitch classes from stacking fifths */
  circleOfFifths: number[];
  /** Common chords available in this EDO */
  chords: EdoChord[];
  /** Notable scales */
  scales: EdoScale[];
}

export interface EdoChord {
  name: string;
  steps: number[];
  /** Approximate JI ratios */
  jiApprox: string;
}

export interface EdoScale {
  name: string;
  steps: number[];
  /** Step pattern like "2 2 1 2 2 2 1" */
  pattern: string;
}

// ═══════════════════════════════════════════════════════════════
// Well-known commas database
// ═══════════════════════════════════════════════════════════════

export interface CommaInfo {
  n: number;
  d: number;
  name: string;
  /** Cents size */
  cents: number;
  /** Primes involved */
  primes: number[];
  /** Monzo (prime exponents for 2,3,5,7,11,13) */
  monzo: number[];
  /** Category */
  category: string;
}

/** Master comma database — all commas referenced in the scraped data */
export const COMMA_DB: CommaInfo[] = [
  // 3-limit
  { n: 531441, d: 524288, name: "Pythagorean comma", cents: 23.46, primes: [2, 3], monzo: [-19, 12, 0, 0, 0, 0], category: "3-limit" },
  { n: 256, d: 243, name: "Pythagorean limma", cents: 90.22, primes: [2, 3], monzo: [8, -5, 0, 0, 0, 0], category: "3-limit" },

  // 5-limit
  { n: 81, d: 80, name: "Syntonic comma", cents: 21.51, primes: [2, 3, 5], monzo: [-4, 4, -1, 0, 0, 0], category: "5-limit" },
  { n: 128, d: 125, name: "Diesis", cents: 41.06, primes: [2, 5], monzo: [7, 0, -3, 0, 0, 0], category: "5-limit" },
  { n: 2048, d: 2025, name: "Diaschisma", cents: 19.55, primes: [2, 3, 5], monzo: [11, -4, -2, 0, 0, 0], category: "5-limit" },
  { n: 32805, d: 32768, name: "Schisma", cents: 1.95, primes: [2, 3, 5], monzo: [-15, 8, 1, 0, 0, 0], category: "5-limit" },
  { n: 250, d: 243, name: "Maximal diesis (Porcupine)", cents: 49.17, primes: [2, 3, 5], monzo: [1, -5, 3, 0, 0, 0], category: "5-limit" },
  { n: 3125, d: 3072, name: "Small diesis (Magic)", cents: 29.61, primes: [2, 3, 5], monzo: [-10, -1, 5, 0, 0, 0], category: "5-limit" },
  { n: 15625, d: 15552, name: "Kleisma", cents: 8.11, primes: [2, 3, 5], monzo: [-6, -5, 6, 0, 0, 0], category: "5-limit" },
  { n: 16875, d: 16384, name: "Negri comma", cents: 51.12, primes: [2, 3, 5], monzo: [-14, 3, 4, 0, 0, 0], category: "5-limit" },
  { n: 25, d: 24, name: "Chromatic diesis", cents: 70.67, primes: [2, 3, 5], monzo: [-3, -1, 2, 0, 0, 0], category: "5-limit" },
  { n: 27, d: 25, name: "Large limma", cents: 133.24, primes: [3, 5], monzo: [0, 3, -2, 0, 0, 0], category: "5-limit" },
  { n: 16, d: 15, name: "Father comma", cents: 111.73, primes: [2, 3, 5], monzo: [4, -1, -1, 0, 0, 0], category: "5-limit" },
  { n: 648, d: 625, name: "Major diesis", cents: 62.57, primes: [2, 3, 5], monzo: [3, 4, -4, 0, 0, 0], category: "5-limit" },
  { n: 20000, d: 19683, name: "Tetracot comma", cents: 27.66, primes: [2, 3, 5], monzo: [5, -9, 4, 0, 0, 0], category: "5-limit" },
  { n: 393216, d: 390625, name: "Würschmidt comma", cents: 11.45, primes: [2, 3, 5], monzo: [17, 1, -8, 0, 0, 0], category: "5-limit" },
  { n: 78732, d: 78125, name: "Sensipent comma", cents: 13.40, primes: [2, 3, 5], monzo: [2, 9, -7, 0, 0, 0], category: "5-limit" },
  { n: 3125, d: 2916, name: "Sixix comma", cents: 122.09, primes: [2, 3, 5], monzo: [-2, -6, 5, 0, 0, 0], category: "5-limit" },
  { n: 1600000, d: 1594323, name: "Amity comma", cents: 6.16, primes: [2, 3, 5], monzo: [9, -13, 5, 0, 0, 0], category: "5-limit" },

  // 7-limit
  { n: 64, d: 63, name: "Septimal comma", cents: 27.26, primes: [2, 3, 7], monzo: [6, -2, 0, -1, 0, 0], category: "7-limit" },
  { n: 225, d: 224, name: "Septimal kleisma (Marvel)", cents: 7.71, primes: [2, 3, 5, 7], monzo: [-5, 2, 2, -1, 0, 0], category: "7-limit" },
  { n: 126, d: 125, name: "Starling comma", cents: 13.79, primes: [2, 3, 5, 7], monzo: [1, 2, -3, 1, 0, 0], category: "7-limit" },
  { n: 50, d: 49, name: "Jubilisma", cents: 34.98, primes: [2, 5, 7], monzo: [1, 0, 2, -2, 0, 0], category: "7-limit" },
  { n: 49, d: 48, name: "Slendro diesis", cents: 35.70, primes: [2, 3, 7], monzo: [-4, -1, 0, 2, 0, 0], category: "7-limit" },
  { n: 36, d: 35, name: "Septimal quarter tone", cents: 48.77, primes: [2, 3, 5, 7], monzo: [2, 2, -1, -1, 0, 0], category: "7-limit" },
  { n: 28, d: 27, name: "Septimal third-tone", cents: 62.96, primes: [2, 3, 7], monzo: [2, -3, 0, 1, 0, 0], category: "7-limit" },
  { n: 245, d: 243, name: "Sensamagic comma", cents: 14.19, primes: [3, 5, 7], monzo: [0, -5, 1, 2, 0, 0], category: "7-limit" },
  { n: 875, d: 864, name: "Keema", cents: 21.90, primes: [2, 3, 5, 7], monzo: [-5, -3, 3, 1, 0, 0], category: "7-limit" },
  { n: 1029, d: 1024, name: "Gamelisma", cents: 8.43, primes: [2, 3, 7], monzo: [-10, 1, 0, 3, 0, 0], category: "7-limit" },
  { n: 2401, d: 2400, name: "Breedsma", cents: 0.72, primes: [2, 3, 5, 7], monzo: [-5, -1, -2, 4, 0, 0], category: "7-limit" },
  { n: 4375, d: 4374, name: "Ragisma", cents: 0.40, primes: [2, 3, 5, 7], monzo: [-1, -7, 4, 1, 0, 0], category: "7-limit" },
  { n: 525, d: 512, name: "Avicennmic comma", cents: 43.41, primes: [2, 3, 5, 7], monzo: [-9, 1, 2, 1, 0, 0], category: "7-limit" },
  { n: 3136, d: 3125, name: "Hemimean comma", cents: 6.08, primes: [2, 5, 7], monzo: [6, 0, -5, 2, 0, 0], category: "7-limit" },
  { n: 1728, d: 1715, name: "Orwellisma", cents: 13.07, primes: [2, 3, 5, 7], monzo: [6, 3, -1, -3, 0, 0], category: "7-limit" },
  { n: 245, d: 242, name: "Frostburn comma", cents: 21.33, primes: [2, 5, 7, 11], monzo: [0, 0, 1, 2, -2, 0], category: "7-limit" },

  // 11-limit
  { n: 100, d: 99, name: "Ptolemisma", cents: 17.40, primes: [2, 3, 5, 11], monzo: [2, -2, 2, 0, -1, 0], category: "11-limit" },
  { n: 121, d: 120, name: "Biyatisma", cents: 14.37, primes: [2, 3, 5, 11], monzo: [-3, -1, -1, 0, 2, 0], category: "11-limit" },
  { n: 176, d: 175, name: "Valinorsma", cents: 9.86, primes: [2, 5, 7, 11], monzo: [4, 0, -2, -1, 1, 0], category: "11-limit" },
  { n: 99, d: 98, name: "Mothwellsma", cents: 17.58, primes: [2, 3, 7, 11], monzo: [-1, 2, 0, -2, 1, 0], category: "11-limit" },
  { n: 243, d: 242, name: "Rastma", cents: 7.14, primes: [2, 3, 11], monzo: [-1, 5, 0, 0, -2, 0], category: "11-limit" },
  { n: 385, d: 384, name: "Keenanisma", cents: 4.50, primes: [2, 3, 5, 7, 11], monzo: [-7, -1, 1, 1, 1, 0], category: "11-limit" },
  { n: 441, d: 440, name: "Werckisma", cents: 3.93, primes: [2, 3, 5, 7, 11], monzo: [-3, 2, -1, 2, -1, 0], category: "11-limit" },
  { n: 540, d: 539, name: "Swetisma", cents: 3.21, primes: [2, 3, 5, 7, 11], monzo: [2, 3, 1, -2, -1, 0], category: "11-limit" },
  { n: 896, d: 891, name: "Pentacircle comma", cents: 9.69, primes: [2, 3, 7, 11], monzo: [7, -4, 0, 1, -1, 0], category: "11-limit" },
  { n: 33, d: 32, name: "Undecimal comma", cents: 53.27, primes: [2, 3, 11], monzo: [-5, 1, 0, 0, 1, 0], category: "11-limit" },
  { n: 45, d: 44, name: "Undecimal 1/5-tone", cents: 38.91, primes: [2, 3, 5, 11], monzo: [-2, 2, 1, 0, -1, 0], category: "11-limit" },
  { n: 56, d: 55, name: "Undecimal diaschisma", cents: 31.19, primes: [2, 5, 7, 11], monzo: [3, 0, -1, 1, -1, 0], category: "11-limit" },
  { n: 144, d: 143, name: "Grossma", cents: 12.06, primes: [2, 3, 11, 13], monzo: [4, 2, 0, 0, -1, -1], category: "13-limit" },

  // 13-limit
  { n: 169, d: 168, name: "Dhanvantarisma", cents: 10.27, primes: [2, 3, 7, 13], monzo: [-3, -1, 0, -1, 0, 2], category: "13-limit" },
  { n: 196, d: 195, name: "Mynucuma", cents: 8.86, primes: [2, 3, 5, 7, 13], monzo: [2, -1, -1, 2, 0, -1], category: "13-limit" },
  { n: 325, d: 324, name: "Marveltwin comma", cents: 5.34, primes: [2, 3, 5, 13], monzo: [-2, -4, 2, 0, 0, 1], category: "13-limit" },
  { n: 352, d: 351, name: "Minthma", cents: 4.93, primes: [2, 3, 11, 13], monzo: [5, -3, 0, 0, 1, -1], category: "13-limit" },
  { n: 364, d: 363, name: "Gentle comma", cents: 4.76, primes: [2, 3, 7, 11, 13], monzo: [2, -1, 0, 1, -2, 1], category: "13-limit" },
  { n: 640, d: 637, name: "Huntma", cents: 8.15, primes: [2, 5, 7, 13], monzo: [7, 0, 1, -2, 0, -1], category: "13-limit" },
  { n: 676, d: 675, name: "Island comma", cents: 2.56, primes: [2, 3, 5, 13], monzo: [2, -3, -2, 0, 0, 2], category: "13-limit" },
  { n: 729, d: 728, name: "Squbema", cents: 2.38, primes: [2, 3, 7, 13], monzo: [-3, 6, 0, -1, 0, -1], category: "13-limit" },
  { n: 1001, d: 1000, name: "Sinbadma", cents: 1.73, primes: [2, 3, 5, 7, 11, 13], monzo: [-3, 0, -3, 1, 1, 1], category: "13-limit" },
  { n: 2080, d: 2079, name: "Ibnsinma", cents: 0.83, primes: [2, 3, 5, 7, 11, 13], monzo: [5, -3, 1, -1, 1, -1], category: "13-limit" },
  { n: 40, d: 39, name: "Tridecimal 1/5-tone", cents: 43.83, primes: [2, 3, 5, 13], monzo: [3, -1, 1, 0, 0, -1], category: "13-limit" },
  { n: 65, d: 64, name: "Wilsorma", cents: 26.84, primes: [2, 5, 13], monzo: [-6, 0, 1, 0, 0, 1], category: "13-limit" },
  { n: 91, d: 90, name: "Superleap", cents: 19.13, primes: [2, 3, 5, 7, 13], monzo: [-1, -2, -1, 1, 0, 1], category: "13-limit" },
  { n: 105, d: 104, name: "Animist comma", cents: 16.57, primes: [2, 3, 5, 7, 13], monzo: [-3, 1, 1, 1, 0, -1], category: "13-limit" },
];

/** Lookup comma by ratio */
export function findComma(n: number, d: number): CommaInfo | undefined {
  return COMMA_DB.find(c => c.n === n && c.d === d);
}

// ═══════════════════════════════════════════════════════════════
// Per-EDO harmonic data (parsed from tables in the markdown)
// ═══════════════════════════════════════════════════════════════

/** Helper to build harmonic records */
function h(abs: number, rel: number, steps: number, reduced: number): HarmonicError {
  return { abs, rel, steps, reduced };
}

function isPrimeNum(n: number): boolean {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}

function getFactors(n: number): number[] {
  const f: number[] = [];
  for (let i = 2; i < n; i++) if (n % i === 0) f.push(i);
  return f;
}

function fifthSteps(edo: number): number {
  // Best approximation of 3/2 = 701.955 cents
  return Math.round(edo * Math.log2(3 / 2));
}

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

function buildRing(edo: number): EDOData["ring"] {
  const fs = fifthSteps(edo);
  const g = gcd(edo, fs);
  return {
    type: g === 1 ? "single" : "multi",
    count: g,
    notesPerRing: edo / g,
    fifthSteps: fs,
    fifthCents: +(fs * 1200 / edo).toFixed(2),
  };
}

/** Compute harmonic errors for any EDO */
function computeHarmonics(edo: number, primeList: number[]): Record<number, HarmonicError> {
  const result: Record<number, HarmonicError> = {};
  const stepCents = 1200 / edo;
  for (const p of primeList) {
    const exactCents = 1200 * Math.log2(p);
    const steps = Math.round(exactCents / stepCents);
    const approxCents = steps * stepCents;
    const absErr = +(approxCents - exactCents).toFixed(2);
    const relErr = +((absErr / stepCents) * 100).toFixed(1);
    result[p] = { abs: absErr, rel: relErr, steps, reduced: steps % edo };
  }
  return result;
}

const STANDARD_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31];

// ═══════════════════════════════════════════════════════════════
// Comma-to-EDO mapping: which EDOs temper out which commas
// (Data extracted from prose in the markdown)
// ═══════════════════════════════════════════════════════════════

/**
 * For each comma, which EDOs temper it out?
 * An EDO tempers out a comma n/d when: round(edo * log2(n)) == round(edo * log2(d)),
 * i.e., the comma maps to 0 steps.
 */
export function edoTempersComma(edo: number, n: number, d: number): boolean {
  const commaCents = 1200 * Math.log2(n / d);
  const stepCents = 1200 / edo;
  // The comma is tempered out if it maps to 0 steps.  Direct === 0 test
  // (the prior Math.abs(...) wrapper was redundant — Math.round returns
  // a signed integer, but for a tiny comma the rounded value is in
  // {-0, 0}, both === 0).
  return Math.round(commaCents / stepCents) === 0;
}

/** Build full comma tempering matrix for EDOs 5-99 */
export function buildCommaMatrix(): { edos: number[]; commas: CommaInfo[]; matrix: boolean[][] } {
  const edos = Array.from({ length: 95 }, (_, i) => i + 5);
  const commas = COMMA_DB;
  const matrix = edos.map(edo =>
    commas.map(c => edoTempersComma(edo, c.n, c.d))
  );
  return { edos, commas, matrix };
}

// ═══════════════════════════════════════════════════════════════
// Named temperament families with defining commas
// ═══════════════════════════════════════════════════════════════

export interface TemperamentFamily {
  name: string;
  /** Defining commas */
  commas: { n: number; d: number }[];
  /** Brief description */
  description: string;
  /** Primes involved (limit) */
  limit: number;
}

// ═══════════════════════════════════════════════════════════════
// Fifth-tuning families — organize EDOs by their fifth size,
// matching the Xenharmonic Wiki / Inthar's "diatonic spectrum of
// fifth tunings" classification.  Bands run narrow → wide, and
// each EDO falls into exactly one band based on its best fifth.
// ═══════════════════════════════════════════════════════════════

export interface FifthTuningFamily {
  /** Display name */
  name: string;
  /** One-line summary */
  blurb: string;
  /** Multi-paragraph description */
  description: string;
  /** Inclusive cents range for the fifth */
  fifthRange: [number, number];
  /** EDOs canonically classified in this family, in order of fifth size */
  edos: number[];
  /** Just-intonation / non-EDO anchors that share this family's flavour */
  jiAnchors?: { name: string; cents: number }[];
}

/**
 * Map a fifth size (in cents) to its fifth-tuning family.  The
 * canonical band cutoffs follow the spectrum in
 * FIFTH_TUNING_FAMILIES (narrow → wide).  Returns null if the
 * fifth falls outside any band (which only happens for fifths
 * narrower than ~685 ¢ or wider than 720 ¢).
 */
export function classifyFifthTuningFamily(fifthCents: number): FifthTuningFamily | null {
  for (const fam of FIFTH_TUNING_FAMILIES) {
    if (fifthCents >= fam.fifthRange[0] && fifthCents <= fam.fifthRange[1]) {
      return fam;
    }
  }
  return null;
}

/**
 * Group every EDO in `edos` by its fifth-tuning family using each
 * EDO's actual best-fifth cents.  EDOs whose fifth lands outside
 * the canonical band get bucketed under "Other".  Returns the
 * groups in family-spectrum order (narrow fifths → wide fifths),
 * with EDOs inside each group sorted by fifth cents.
 */
export function groupEdosByFifthFamily(
  edos: number[],
  edoData: Map<number, EDOData>,
): { family: FifthTuningFamily | null; edos: { edo: number; fifthCents: number }[] }[] {
  const buckets = new Map<string | null, { edo: number; fifthCents: number }[]>();
  for (const edo of edos) {
    const data = edoData.get(edo);
    if (!data) continue;
    const fifth = data.ring.fifthCents;
    const fam = classifyFifthTuningFamily(fifth);
    const key = fam?.name ?? null;
    const arr = buckets.get(key) ?? [];
    arr.push({ edo, fifthCents: fifth });
    buckets.set(key, arr);
  }
  const out: { family: FifthTuningFamily | null; edos: { edo: number; fifthCents: number }[] }[] = [];
  for (const fam of FIFTH_TUNING_FAMILIES) {
    const list = buckets.get(fam.name);
    if (list) {
      list.sort((a, b) => a.fifthCents - b.fifthCents);
      out.push({ family: fam, edos: list });
    }
  }
  const others = buckets.get(null);
  if (others) {
    others.sort((a, b) => a.fifthCents - b.fifthCents);
    out.push({ family: null, edos: others });
  }
  return out;
}

export const FIFTH_TUNING_FAMILIES: FifthTuningFamily[] = [
  {
    name: "Equal heptatonic / Neutral diatonic",
    blurb: "Seven equal steps — fifths sit at 4/7 of an octave (~685.7 ¢).",
    description:
      "7-TET is the boundary case where every step is the same size, so the diatonic and chromatic intervals collapse into one neutral spectrum. Used as the reference floor of the fifth-tuning spectrum.",
    fifthRange: [685, 690],
    edos: [7],
  },
  {
    name: "Flattone",
    blurb: "Narrower-than-meantone fifths; 4:7 is a diminished 7th (-9 fifths).",
    description:
      "Flattone is technically inside the meantone spectrum but with fifths flat enough that 4:7 is best mapped to the diminished seventh rather than the augmented sixth. M2 maps closer to 9:10 than 8:9. 19-TET is the upper boundary; 26-TET is the canonical example.",
    fifthRange: [690, 696.5],
    edos: [47, 40, 33, 26, 45],
  },
  {
    name: "Meantone",
    blurb: "Most popular tuning family — tempers 80:81, four fifths ≈ 5/4.",
    description:
      "Meantone tempers the syntonic comma (80:81), so four fifths land near a 5:4 major third. Tunings sit between 1/3-comma (~694.8 ¢) and 1/4-comma (~696.6 ¢), with 19-TET, 31-TET, 50-TET as standout examples.",
    fifthRange: [696.5, 700],
    edos: [19, 50, 81, 31, 43, 55],
  },
  {
    name: "Dominant",
    blurb: "12-TET — fifths essentially Pythagorean, 1/11-comma meantone.",
    description:
      "12 equal divisions per octave, fifth at 700 ¢. Effectively meantone but with the Pythagorean comma circulated, which is why 12-TET sits at the meantone/Pythagorean boundary.",
    fifthRange: [700, 700],
    edos: [12],
  },
  {
    name: "Schismatic",
    blurb: "Tempers 32805:32768 (schisma); 4:5 is the diminished fourth.",
    description:
      "Schismatic tunings sit at or just below Pythagorean, where the schisma (32805:32768) is tempered out and 4:5 is approximated by the diminished fourth (-8 fifths). 53-TET is the canonical example, very close to pure Pythagorean.",
    fifthRange: [700, 703.6],
    edos: [53, 94, 41],
    jiAnchors: [{ name: "Pythagorean (3-limit JI)", cents: 701.955 }],
  },
  {
    name: "Gentle (Zalzalian Schismatic)",
    blurb: "Slightly heightened Pythagorean — augmented intervals sound supraminor.",
    description:
      "Margo Schulter's 'gentle' region: fifths a bit wider than pure 2:3, so augmented intervals push toward neutral territory and diminished intervals push toward submajor. Suits Turkish makam and other neutral-interval musics. 17-TET sits at the upper boundary.",
    fifthRange: [703.6, 705.9],
    edos: [29, 46, 63, 80],
  },
  {
    name: "Supra (boundary)",
    blurb: "17-TET — the gentle/inverse-gentle boundary.",
    description:
      "17-TET represents the boundary between gentle and inverse gentle; neutral intervals sit exactly between minor and major.",
    fifthRange: [705.9, 705.9],
    edos: [17],
  },
  {
    name: "Inverse gentle (Inverse Zalzalian Schismatic)",
    blurb: "Wider fifths still — A2 reads supramajor third, d4 reads supraminor.",
    description:
      "Inverse gentle has fifths between ~706 ¢ and ~709 ¢. Compared to gentle, the dd3/A1 ordering flips: d3 < A1, d4 < A2. Around 22-TET A2 starts to read like a classic 5:4 and d4 like a classic 5:6.",
    fifthRange: [705.9, 709],
    edos: [56, 39],
  },
  {
    name: "Archy / Superpyth",
    blurb: "Superpythagorean — major thirds approximate 7:9, minor thirds 6:7.",
    description:
      "Wide-fifth tunings where M3 ≈ 7:9 and m3 ≈ 6:7, so major triads approximate 14:18:21 and minor triads 6:7:9. The septimal (Archytan) comma 63:64 is tempered out. 22-TET and 27-TET are the most prominent examples.",
    fifthRange: [709, 720],
    edos: [22, 49, 27, 32, 37, 47],
  },
  {
    name: "Equal pentatonic",
    blurb: "5-TET — five equal steps; fifth at 3/5 octave (~720 ¢).",
    description:
      "5-TET is the boundary at the wide end of the spectrum. The fifth lands at 720 ¢, much wider than even the most extreme superpyth.",
    fifthRange: [720, 720],
    edos: [5],
  },
];

export const TEMPERAMENT_FAMILIES: TemperamentFamily[] = [
  { name: "Meantone", commas: [{ n: 81, d: 80 }], description: "Four 3/2 fifths ≈ 5/4 major third", limit: 5 },
  { name: "Schismatic", commas: [{ n: 32805, d: 32768 }], description: "Eight 3/2 fifths down ≈ 5/4", limit: 5 },
  { name: "Porcupine", commas: [{ n: 250, d: 243 }], description: "Three ~10/9 steps = 4/3", limit: 5 },
  { name: "Magic", commas: [{ n: 3125, d: 3072 }], description: "Five 5/4 thirds ≈ 3/2", limit: 5 },
  { name: "Negri", commas: [{ n: 16875, d: 16384 }], description: "Four ~4/3 = three ~5/4 + octave", limit: 5 },
  { name: "Kleismic", commas: [{ n: 15625, d: 15552 }], description: "Six 6/5 minor thirds ≈ 3/2", limit: 5 },
  { name: "Diaschismic", commas: [{ n: 2048, d: 2025 }], description: "Two 5-limit tritones ≈ octave", limit: 5 },
  { name: "Augmented", commas: [{ n: 128, d: 125 }], description: "Three 5/4 thirds = octave", limit: 5 },
  { name: "Dimipent", commas: [{ n: 648, d: 625 }], description: "Four 6/5 thirds = octave", limit: 5 },
  { name: "Würschmidt", commas: [{ n: 393216, d: 390625 }], description: "Eight 5/4 thirds ≈ octave + fifth", limit: 5 },
  { name: "Tetracot", commas: [{ n: 20000, d: 19683 }], description: "Four 10/9 steps ≈ 4/3 + 25/24", limit: 5 },
  { name: "Amity", commas: [{ n: 1600000, d: 1594323 }], description: "Five 3/2 + one 5/4 ≈ five octaves", limit: 5 },
  { name: "Sensipent", commas: [{ n: 78732, d: 78125 }], description: "Seven 5/4 thirds ≈ two 3/2 + octave", limit: 5 },
  { name: "Superpyth", commas: [{ n: 64, d: 63 }], description: "Septimal comma: 3^2 ≈ 2·7", limit: 7 },
  { name: "Pajara", commas: [{ n: 2048, d: 2025 }, { n: 50, d: 49 }], description: "Period = half octave, two fifths", limit: 7 },
  { name: "Septimal meantone", commas: [{ n: 81, d: 80 }, { n: 126, d: 125 }], description: "Meantone + starling", limit: 7 },
  { name: "Marvel", commas: [{ n: 225, d: 224 }], description: "Septimal kleisma: 15/14 ≈ 16/15", limit: 7 },
  { name: "Orwell", commas: [{ n: 1728, d: 1715 }], description: "Seven ~7/6 steps ≈ twelfth", limit: 7 },
  { name: "Miracle", commas: [{ n: 225, d: 224 }, { n: 1029, d: 1024 }], description: "Generator = secor (~116.7¢)", limit: 7 },
  { name: "Ennealimmal", commas: [{ n: 2401, d: 2400 }], description: "Period = 1/9 octave, breedsma", limit: 7 },
  { name: "Valentine", commas: [{ n: 126, d: 125 }, { n: 1029, d: 1024 }], description: "Nine generators ≈ fifth", limit: 7 },
  { name: "Hemifamity", commas: [{ n: 5120, d: 5103 }], description: "Hemifamity comma", limit: 7 },
  { name: "Rodan", commas: [{ n: 245, d: 243 }], description: "Sensamagic comma", limit: 7 },
  { name: "Myna", commas: [{ n: 126, d: 125 }, { n: 2401, d: 2400 }], description: "Five categories of thirds", limit: 7 },
  { name: "Mohajira", commas: [{ n: 81, d: 80 }, { n: 121, d: 120 }], description: "Neutral third as generator", limit: 11 },
  { name: "Mothra", commas: [{ n: 81, d: 80 }, { n: 99, d: 98 }], description: "Three generators ≈ fifth", limit: 11 },
  { name: "Sensi", commas: [{ n: 126, d: 125 }, { n: 176, d: 175 }], description: "Sensipent extended to 11-limit", limit: 11 },
  { name: "Leapday", commas: [{ n: 100, d: 99 }, { n: 225, d: 224 }], description: "29 generators/octave", limit: 11 },
];

// ═══════════════════════════════════════════════════════════════
// Computed EDO data for all EDOs 5–99
// ═══════════════════════════════════════════════════════════════

/** Build computed data for a single EDO */
function buildEDO(edo: number): EDOData {
  const ring = buildRing(edo);
  const harmonics = computeHarmonics(edo, STANDARD_PRIMES);
  const subsets = getFactors(edo);

  // Determine which commas this EDO tempers out
  const commasTempered = COMMA_DB
    .filter(c => edoTempersComma(edo, c.n, c.d))
    .map(c => ({ n: c.n, d: c.d, name: c.name }));

  // Determine which named temperaments this EDO supports
  const temperaments = TEMPERAMENT_FAMILIES
    .filter(t => t.commas.every(c => edoTempersComma(edo, c.n, c.d)))
    .map(t => t.name);

  // Zeta properties
  const zetaProps = computeZetaProps(edo);

  // Consistency
  let consistencyLimit: number | null = null;
  const oddLimits = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31];
  for (const limit of oddLimits) {
    if (isConsistentAtLimit(edo, limit)) consistencyLimit = limit;
    else break;
  }

  // Good subgroup: primes with < 25% relative error
  const stepCents = 1200 / edo;
  const goodSubgroup = [2, ...STANDARD_PRIMES].filter(p => {
    if (p === 2) return true;
    const h = harmonics[p];
    return h && Math.abs(h.rel) < 25;
  });

  // Dual fifths
  const dualFifths = computeDualFifths(edo);

  // MOS patterns from stacking fifths
  const mosPatterns = computeMOS(edo, ring.fifthSteps);

  // Circle of fifths
  const circleOfFifths = computeCircleOfFifths(edo, ring.fifthSteps);

  // Chords
  const chords = computeChords(edo);

  // Scales
  const scales = computeScales(edo, ring.fifthSteps);

  return {
    edo, ring, harmonics, commasTempered, temperaments, subsets,
    isPrime: isPrimeNum(edo), zetaProps, consistencyLimit,
    stepCents: +(1200 / edo).toFixed(4),
    goodSubgroup, dualFifths, mosPatterns, circleOfFifths, chords, scales,
  };
}

/** Zeta properties: simplified check based on harmonic error sums */
function computeZetaProps(edo: number): string[] {
  const props: string[] = [];
  const stepCents = 1200 / edo;
  // Zeta peak: weighted sum of cos(2π·edo·log2(p)) for small primes is high
  let zetaSum = 0;
  for (const p of [2, 3, 5, 7, 11, 13]) {
    const exact = edo * Math.log2(p);
    const frac = exact - Math.round(exact);
    zetaSum += Math.cos(2 * Math.PI * frac);
  }
  if (zetaSum > 4.5) props.push("zeta peak");
  if (zetaSum > 3.5) props.push("zeta integral");
  // Known zeta EDOs from the literature
  const knownZetaPeak = [5, 7, 10, 12, 19, 22, 27, 31, 41, 46, 53, 72];
  if (knownZetaPeak.includes(edo) && !props.includes("zeta peak")) props.push("zeta peak");
  return props;
}

/** Dual fifths: check if there's both a flat and sharp fifth candidate */
function computeDualFifths(edo: number): EDOData["dualFifths"] {
  const just = 701.955;
  const step = 1200 / edo;
  const bestSteps = Math.round(just / step);
  const sharpSteps = bestSteps;
  const flatSteps = bestSteps - 1;
  const sharpCents = sharpSteps * step;
  const flatCents = flatSteps * step;
  // Both must be within ~20 cents of just to be "usable"
  if (Math.abs(sharpCents - just) < 20 && Math.abs(flatCents - just) < 20 && sharpSteps !== flatSteps) {
    return {
      sharp: { steps: sharpSteps, cents: +sharpCents.toFixed(2) },
      flat: { steps: flatSteps, cents: +flatCents.toFixed(2) },
    };
  }
  return null;
}

/** MOS patterns from stacking a generator */
function computeMOS(edo: number, genSteps: number): EDOData["mosPatterns"] {
  const patterns: EDOData["mosPatterns"] = [];
  const g = gcd(edo, genSteps);
  if (g > 1) return []; // multi-ring, no single MOS chain

  // Compute convergents of genSteps/edo continued fraction
  // Each convergent denominator gives a MOS scale size
  const sizes: number[] = [];
  let a = edo, b = genSteps;
  let p0 = 0, p1 = 1, q0 = 1, q1 = 0;
  for (let i = 0; i < 20 && b > 0; i++) {
    const quotient = Math.floor(a / b);
    const pNew = quotient * p1 + p0;
    const qNew = quotient * q1 + q0;
    if (qNew > 1 && qNew < edo) sizes.push(qNew);
    p0 = p1; p1 = pNew; q0 = q1; q1 = qNew;
    const tmp = b; b = a - quotient * b; a = tmp;
  }

  for (const size of sizes.slice(0, 5)) {
    // Build scale by stacking generator
    const scale: number[] = [];
    for (let i = 0; i < size; i++) scale.push((i * genSteps) % edo);
    scale.sort((a, b) => a - b);
    // Compute step sizes
    const stepSizes: number[] = [];
    for (let i = 0; i < scale.length; i++) {
      const next = i + 1 < scale.length ? scale[i + 1] : scale[0] + edo;
      stepSizes.push(next - scale[i]);
    }
    const unique = [...new Set(stepSizes)].sort((a, b) => b - a);
    if (unique.length === 2 || unique.length === 1) {
      const L = unique[0], s = unique[unique.length - 1];
      const Lcount = stepSizes.filter(x => x === L).length;
      const scount = stepSizes.filter(x => x === s).length;
      patterns.push({
        L: Lcount, s: scount,
        steps: stepSizes.join(" "),
      });
    }
  }
  return patterns;
}

/** Circle of fifths */
function computeCircleOfFifths(edo: number, fifthSteps: number): number[] {
  const g = gcd(edo, fifthSteps);
  const ringSize = edo / g;
  const circle: number[] = [];
  for (let i = 0; i < Math.min(ringSize, edo); i++) {
    circle.push((i * fifthSteps) % edo);
  }
  return circle;
}

/** Common chords for an EDO */
function computeChords(edo: number): EdoChord[] {
  const step = 1200 / edo;
  const map = (cents: number) => Math.round(cents / step);
  const chords: EdoChord[] = [];

  // Major triad (4:5:6)
  const M3 = map(386.31); const P5 = map(701.96);
  if (M3 > 0 && P5 > M3) chords.push({ name: "Major triad", steps: [0, M3, P5], jiApprox: "4:5:6" });

  // Minor triad (10:12:15)
  const m3 = map(315.64);
  if (m3 > 0 && P5 > m3) chords.push({ name: "Minor triad", steps: [0, m3, P5], jiApprox: "10:12:15" });

  // Sus4 (6:8:9)
  const P4 = map(498.04);
  if (P4 > 0 && P5 > P4) chords.push({ name: "Sus4", steps: [0, P4, P5], jiApprox: "6:8:9" });

  // Sus2 (8:9:12)
  const M2 = map(203.91);
  if (M2 > 0 && P5 > M2) chords.push({ name: "Sus2", steps: [0, M2, P5], jiApprox: "8:9:12" });

  // Dominant 7th (4:5:6:7)
  const m7 = map(968.83);
  if (M3 > 0 && P5 > M3 && m7 > P5) chords.push({ name: "Dom 7th", steps: [0, M3, P5, m7], jiApprox: "4:5:6:7" });

  // Minor 7th
  const Mm7 = map(1017.6);
  if (m3 > 0 && P5 > m3 && Mm7 > P5) chords.push({ name: "Minor 7th", steps: [0, m3, P5, Mm7], jiApprox: "10:12:15:18" });

  // Subminor triad (6:7:9)
  const subm3 = map(266.87);
  if (subm3 > 0 && subm3 !== m3 && P5 > subm3) chords.push({ name: "Subminor triad", steps: [0, subm3, P5], jiApprox: "6:7:9" });

  // Supermajor triad (14:18:21 ≈ 7:9:10.5)
  const supM3 = map(435.08);
  if (supM3 > 0 && supM3 !== M3 && P5 > supM3) chords.push({ name: "Supermajor triad", steps: [0, supM3, P5], jiApprox: "14:18:21" });

  // Neutral triad (18:22:27)
  const n3 = map(347.41);
  if (n3 > 0 && n3 !== M3 && n3 !== m3 && P5 > n3) chords.push({ name: "Neutral triad", steps: [0, n3, P5], jiApprox: "18:22:27" });

  // Augmented (1: 5/4 : 25/16)
  const aug5 = map(772.63);
  if (M3 > 0 && aug5 > M3 && aug5 !== P5) chords.push({ name: "Augmented", steps: [0, M3, aug5], jiApprox: "16:20:25" });

  // Diminished (1: 6/5 : 36/25)
  const dim5 = map(631.28);
  if (m3 > 0 && dim5 > m3 && dim5 !== P5) chords.push({ name: "Diminished", steps: [0, m3, dim5], jiApprox: "25:30:36" });

  // Deduplicate: remove chords where steps are identical to another
  const seen = new Set<string>();
  return chords.filter(c => {
    const key = c.steps.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Common scales for an EDO */
function computeScales(edo: number, fifthSteps: number): EdoScale[] {
  const scales: EdoScale[] = [];
  const step = 1200 / edo;
  const map = (cents: number) => Math.round(cents / step);

  // Diatonic (5L 2s) from stacking 5 fifths up + 1 fifth down
  if (edo >= 7) {
    const diatonic: number[] = [];
    for (let i = -1; i < 6; i++) diatonic.push(((i * fifthSteps) % edo + edo) % edo);
    diatonic.sort((a, b) => a - b);
    if (diatonic.length === 7) {
      const pattern: number[] = [];
      for (let i = 0; i < 7; i++) pattern.push((diatonic[(i + 1) % 7] - diatonic[i] + edo) % edo);
      scales.push({ name: "Diatonic", steps: diatonic, pattern: pattern.join(" ") });
    }
  }

  // Pentatonic (stacking 4 fifths)
  if (edo >= 5) {
    const penta: number[] = [];
    for (let i = 0; i < 5; i++) penta.push((i * fifthSteps) % edo);
    penta.sort((a, b) => a - b);
    const pattern: number[] = [];
    for (let i = 0; i < 5; i++) pattern.push((penta[(i + 1) % 5] - penta[i] + edo) % edo);
    scales.push({ name: "Pentatonic", steps: penta, pattern: pattern.join(" ") });
  }

  // Chromatic (all steps)
  scales.push({ name: "Chromatic", steps: Array.from({ length: edo }, (_, i) => i), pattern: Array(edo).fill(1).join(" ") });

  // Equal-tempered whole tone (if edo divisible)
  if (edo % 6 === 0) {
    const wt = Array.from({ length: 6 }, (_, i) => i * (edo / 6));
    scales.push({ name: "Whole-tone", steps: wt, pattern: Array(6).fill(edo / 6).join(" ") });
  }

  // Diminished / octatonic (if edo % 4 === 0)
  if (edo % 4 === 0) {
    const step1 = map(200), step2 = map(100);
    if (step1 > 0 && step2 > 0 && step1 !== step2) {
      const dim: number[] = [0];
      let pos = 0;
      for (let i = 0; i < 4; i++) {
        pos += step2; dim.push(pos % edo);
        pos += step1; if (pos < edo) dim.push(pos % edo);
      }
      const unique = [...new Set(dim)].sort((a, b) => a - b);
      if (unique.length === 8) {
        const pat: number[] = [];
        for (let i = 0; i < 8; i++) pat.push((unique[(i + 1) % 8] - unique[i] + edo) % edo);
        scales.push({ name: "Diminished", steps: unique, pattern: pat.join(" ") });
      }
    }
  }

  return scales;
}

/** Check if an EDO is consistent at a given odd limit */
function isConsistentAtLimit(edo: number, oddLimit: number): boolean {
  const stepCents = 1200 / edo;
  // Get all ratios in the odd-limit
  const odds: number[] = [];
  for (let i = 1; i <= oddLimit; i += 2) odds.push(i);

  // For consistency: for all i,j in odds, the best mapping of i/j
  // must equal the difference of best mappings of i and j
  const bestMap = (ratio: number) => Math.round(1200 * Math.log2(ratio) / stepCents);

  for (let i = 0; i < odds.length; i++) {
    for (let j = i; j < odds.length; j++) {
      const a = odds[i], b = odds[j];
      // Check a/b and b/a
      const mapA = bestMap(a);
      const mapB = bestMap(b);
      const mapRatio = bestMap(a / b);
      if (mapRatio !== (mapA - mapB)) return false;
    }
  }
  return true;
}

/** All EDO data, keyed by EDO number */
export const EDO_DATA: Map<number, EDOData> = new Map();
for (let n = 5; n <= 99; n++) {
  EDO_DATA.set(n, buildEDO(n));
}

/** Get EDO data array for convenience */
export function getAllEDOs(): EDOData[] {
  return Array.from(EDO_DATA.values());
}

/** Get comma matrix as a flat structure for visualization */
export interface CommaMatrixEntry {
  edo: number;
  comma: string;
  commaRatio: string;
  tempered: boolean;
  commaCents: number;
}

export function getCommaMatrixFlat(): CommaMatrixEntry[] {
  const entries: CommaMatrixEntry[] = [];
  for (let edo = 5; edo <= 99; edo++) {
    for (const c of COMMA_DB) {
      entries.push({
        edo,
        comma: c.name,
        commaRatio: `${c.n}/${c.d}`,
        tempered: edoTempersComma(edo, c.n, c.d),
        commaCents: c.cents,
      });
    }
  }
  return entries;
}

// ═══════════════════════════════════════════════════════════════
// Linear algebra for comma independence
// ═══════════════════════════════════════════════════════════════

/** Gaussian elimination to find the rank of a matrix of row vectors */
function matrixRank(rows: number[][]): number {
  if (rows.length === 0) return 0;
  const m = rows.map(r => [...r]);
  const nRows = m.length;
  const nCols = m[0].length;
  let rank = 0;
  for (let c = 0; c < nCols && rank < nRows; c++) {
    let pivot = -1;
    let bestAbs = 1e-10;
    for (let i = rank; i < nRows; i++) {
      if (Math.abs(m[i][c]) > bestAbs) { bestAbs = Math.abs(m[i][c]); pivot = i; }
    }
    if (pivot === -1) continue;
    [m[rank], m[pivot]] = [m[pivot], m[rank]];
    const scale = m[rank][c];
    for (let j = c; j < nCols; j++) m[rank][j] /= scale;
    for (let i = 0; i < nRows; i++) {
      if (i === rank) continue;
      const f = m[i][c];
      if (Math.abs(f) < 1e-10) continue;
      for (let j = c; j < nCols; j++) m[i][j] -= f * m[rank][j];
    }
    rank++;
  }
  return rank;
}

/**
 * Given a list of commas and a set of primes, find a maximal linearly
 * independent subset (basis) of the comma monzos restricted to those primes.
 * The number of basis commas = rank of the kernel, which for an EDO
 * (rank-1 temperament) should be (num_primes - 1).
 *
 * Also filters commas to only those whose primes are all within the given set.
 */
export function findCommaBasis(
  commas: CommaInfo[],
  primes: number[],
  useOctaveEq = true,
): { basis: CommaInfo[]; dependent: CommaInfo[] } {
  const primeSet = new Set(primes);
  // Filter to commas using only our primes
  const eligible = commas.filter(c =>
    c.primes.every(p => p === 2 || primeSet.has(p))
  );

  // Map primes to monzo indices (skip 2 if octave-equivalent)
  const PRIME_LIST = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31];
  const colIndices = primes
    .filter(p => !useOctaveEq || p !== 2)
    .map(p => PRIME_LIST.indexOf(p))
    .filter(i => i >= 0);

  const basis: CommaInfo[] = [];
  const dependent: CommaInfo[] = [];
  const basisMonzos: number[][] = [];

  // Sort eligible: prefer smaller commas (fewer nonzero entries, smaller cents)
  const sorted = [...eligible].sort((a, b) => {
    const aNz = a.monzo.filter(x => x !== 0).length;
    const bNz = b.monzo.filter(x => x !== 0).length;
    if (aNz !== bNz) return aNz - bNz;
    return a.cents - b.cents;
  });

  for (const c of sorted) {
    const row = colIndices.map(i => c.monzo[i] ?? 0);
    const testRows = [...basisMonzos, row];
    if (matrixRank(testRows) > basisMonzos.length) {
      basis.push(c);
      basisMonzos.push(row);
    } else {
      dependent.push(c);
    }
  }

  return { basis, dependent };
}

/**
 * For an EDO, compute how many independent commas are needed at a given prime limit.
 * An EDO is rank-1, so commas_needed = num_primes_in_subgroup - 1.
 */
export function commasNeededForEdo(primes: number[]): number {
  return Math.max(0, primes.length - 1);
}

/**
 * Compute minimum bounds needed to fit a set of commas in a lattice.
 * Returns merged per-prime bounds.
 */
export function computeMinBoundsForCommas(
  commas: CommaInfo[],
  useOctaveEq = true,
): Record<number, [number, number]> {
  const result: Record<number, [number, number]> = {};
  const PRIME_LIST = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31];
  // Cap bounds to avoid generating too many lattice nodes
  const MAX_BOUND = 10;
  for (const c of commas) {
    for (let i = 0; i < c.monzo.length && i < PRIME_LIST.length; i++) {
      const p = PRIME_LIST[i];
      if (p === 2 && useOctaveEq) continue;
      const e = c.monzo[i];
      if (e === 0) continue;
      const clamped = Math.max(-MAX_BOUND, Math.min(MAX_BOUND, e));
      const [curLo, curHi] = result[p] ?? [0, 0];
      result[p] = [Math.min(curLo, clamped), Math.max(curHi, clamped)];
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// Minimum bounds computation for commas
// ═══════════════════════════════════════════════════════════════

/**
 * Compute the minimum bounds each prime axis needs for a comma's
 * monzo to fit within the lattice.
 * Returns a record like { 2: [-4, 0], 3: [0, 4], 5: [-1, 0] } for 81/80.
 */
export function commaMinBounds(c: CommaInfo): Record<number, [number, number]> {
  const result: Record<number, [number, number]> = {};
  const primeList = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31];
  for (let i = 0; i < c.monzo.length && i < primeList.length; i++) {
    const e = c.monzo[i];
    if (e !== 0) {
      result[primeList[i]] = [Math.min(e, 0), Math.max(e, 0)];
    }
  }
  return result;
}

/**
 * Given a set of lattice primes and bounds, determine which commas from the DB
 * can be represented within those bounds. Returns commas split into
 * "active" (fit within bounds) and "needs expansion" (with what bounds they'd need).
 */
export interface CommaWithBounds {
  comma: CommaInfo;
  minBounds: Record<number, [number, number]>;
  /** Whether all non-2 primes of this comma are in the lattice primes */
  primesAvailable: boolean;
  /** Whether the comma's monzo fits within the current bounds */
  fitsInBounds: boolean;
}

export function classifyCommasForEdo(
  edo: number,
  latticePrimes: number[],
  bounds: Record<number, [number, number]>,
  useOctaveEq: boolean,
): CommaWithBounds[] {
  const edoData = EDO_DATA.get(edo);
  if (!edoData) return [];
  const primeSet = new Set(latticePrimes);

  return edoData.commasTempered.map(ct => {
    const info = COMMA_DB.find(db => db.n === ct.n && db.d === ct.d);
    if (!info) return null;
    const minB = commaMinBounds(info);

    // Check if all relevant primes are available
    const relevantPrimes = useOctaveEq
      ? info.primes.filter(p => p !== 2)
      : info.primes;
    const primesAvailable = relevantPrimes.every(p => primeSet.has(p));

    // Check if monzo fits in current bounds
    let fitsInBounds = primesAvailable;
    if (fitsInBounds) {
      for (const [p, [lo, hi]] of Object.entries(minB)) {
        const prime = +p;
        if (prime === 2 && useOctaveEq) continue;
        if (!primeSet.has(prime)) { fitsInBounds = false; break; }
        const [bLo, bHi] = bounds[prime] ?? [0, 0];
        if (lo < bLo || hi > bHi) { fitsInBounds = false; break; }
      }
    }

    return { comma: info, minBounds: minB, primesAvailable, fitsInBounds };
  }).filter(Boolean) as CommaWithBounds[];
}

// ═══════════════════════════════════════════════════════════════
// EDO interval utilities
// ═══════════════════════════════════════════════════════════════

export interface JIMatch {
  ratio: string;
  ratioNums: [number, number];
  jiCents: number;
  errorCents: number;
  name: string;
  limit: number;
}

export interface EdoInterval {
  step: number;
  cents: number;
  /** Smallest prime limit within ±10¢ */
  ji10: JIMatch | null;
  /** Smallest prime limit within ±5¢ */
  ji5: JIMatch | null;
  /** Closest by raw cents within ±2¢ */
  ji2: JIMatch | null;

  // Legacy fields (populated from ji10 for backward compat)
  approxRatio: string;
  approxRatioNums: [number, number] | null;
  jiCents: number | null;
  errorCents: number | null;
  name: string;
  limit: number | null;
}

/** Compute the prime limit of a ratio n/d (largest prime factor across both) */
function primeLimit(n: number, d: number): number {
  let maxP = 2;
  for (const v of [n, d]) {
    let x = v;
    for (let p = 2; p * p <= x; p++) {
      if (x % p === 0) {
        maxP = Math.max(maxP, p);
        while (x % p === 0) x /= p;
      }
    }
    if (x > 1) maxP = Math.max(maxP, x);
  }
  return maxP;
}

/** Well-known interval names for common ratios */
const RATIO_NAMES: Record<string, string> = {
  "1/1":"Unison","2/1":"P8","3/2":"P5","4/3":"P4","5/4":"M3","6/5":"m3",
  "5/3":"M6","8/5":"m6","9/8":"M2","16/15":"m2","15/8":"M7","7/4":"m7",
  "7/5":"tritone","7/6":"sept m3","8/7":"sept M2","9/7":"sept M3",
  "10/9":"min tone","12/7":"sept M6","9/5":"JI m7","16/9":"Pyth m7",
  "11/8":"undec 4th","11/9":"neutral 3rd","13/8":"tridec 6th",
  "27/16":"Pyth M6","32/27":"Pyth m3","81/64":"Pyth M3",
};

/**
 * Generate JI ratios up to a given prime limit within one octave.
 * Sorted by Tenney height (log2(n*d)) so simplest ratios come first.
 * Cached after first build per maxLimit.
 */
interface JIRatio { n: number; d: number; cents: number; limit: number; height: number; name: string }
const _ratioCache = new Map<number, JIRatio[]>();

function buildRatioTable(maxLimit: number): JIRatio[] {
  const cached = _ratioCache.get(maxLimit);
  if (cached) return cached;

  const seen = new Set<string>();
  const ratios: JIRatio[] = [];

  // Cap denominator search to keep table manageable — simple ratios have small n,d
  const maxD = 200;

  for (let d = 1; d <= maxD; d++) {
    for (let n = d; n <= 2 * d; n++) {
      const g = gcd(n, d);
      const rn = n / g;
      const rd = d / g;
      const key = `${rn}/${rd}`;
      if (seen.has(key)) continue;

      const pl = primeLimit(rn, rd);
      if (pl > maxLimit) continue;

      seen.add(key);
      const cents = 1200 * Math.log2(rn / rd);
      const height = Math.log2(rn * rd); // Tenney height — lower = simpler
      ratios.push({ n: rn, d: rd, cents, limit: pl, height, name: RATIO_NAMES[key] ?? "" });
    }
  }

  // Sort by cents for binary-search
  ratios.sort((a, b) => a.cents - b.cents);
  _ratioCache.set(maxLimit, ratios);
  return ratios;
}

/** Collect all ratios within ±tolerance cents of a target, using binary search. */
function findCandidates(ratios: JIRatio[], cents: number, tolerance: number): { r: JIRatio; err: number }[] {
  // Binary search for insertion point
  let lo = 0, hi = ratios.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ratios[mid].cents < cents) lo = mid + 1;
    else hi = mid - 1;
  }
  const results: { r: JIRatio; err: number }[] = [];
  // Scan left
  for (let j = lo - 1; j >= 0; j--) {
    const err = cents - ratios[j].cents;
    if (err > tolerance) break;
    results.push({ r: ratios[j], err });
  }
  // Scan right
  for (let j = lo; j < ratios.length; j++) {
    const err = ratios[j].cents - cents;
    if (err > tolerance) break;
    results.push({ r: ratios[j], err: -(ratios[j].cents - cents) });
  }
  return results;
}

function toJIMatch(r: JIRatio, cents: number): JIMatch {
  return {
    ratio: `${r.n}/${r.d}`,
    ratioNums: [r.n, r.d],
    jiCents: +r.cents.toFixed(2),
    errorCents: +(cents - r.cents).toFixed(2),
    name: r.name,
    limit: r.limit,
  };
}

export function getEdoIntervals(edo: number, maxLimit = 127): EdoInterval[] {
  const stepCents = 1200 / edo;
  const ratios = buildRatioTable(maxLimit);
  const intervals: EdoInterval[] = [];

  // Use curated interval names from spatial audiation when available
  const curatedNames = getIntervalNames(edo);
  const hasCurated = curatedNames.length === edo + 1;

  for (let s = 0; s <= edo; s++) {
    const cents = s * stepCents;

    // ── ji10: smallest prime limit within ±10¢ ──
    const cands10 = findCandidates(ratios, cents, 10);
    let ji10: JIMatch | null = null;
    if (cands10.length > 0) {
      // Pick lowest limit; break ties by smallest Tenney height; then by smallest error
      cands10.sort((a, b) => a.r.limit - b.r.limit || a.r.height - b.r.height || Math.abs(a.err) - Math.abs(b.err));
      ji10 = toJIMatch(cands10[0].r, cents);
    }

    // ── ji5: smallest prime limit within ±5¢ ──
    const cands5 = cands10.filter(c => Math.abs(c.err) <= 5);
    let ji5: JIMatch | null = null;
    if (cands5.length > 0) {
      cands5.sort((a, b) => a.r.limit - b.r.limit || a.r.height - b.r.height || Math.abs(a.err) - Math.abs(b.err));
      ji5 = toJIMatch(cands5[0].r, cents);
    }

    // ── ji2: closest ratio by raw cents within ±2¢ ──
    const cands2 = cands10.filter(c => Math.abs(c.err) <= 2);
    let ji2: JIMatch | null = null;
    if (cands2.length > 0) {
      cands2.sort((a, b) => Math.abs(a.err) - Math.abs(b.err) || a.r.height - b.r.height);
      ji2 = toJIMatch(cands2[0].r, cents);
    }

    // Legacy fields from the best available match (ji5 > ji10 > ji2)
    const best = ji5 ?? ji10 ?? ji2;

    // Prefer curated EDO-specific name, fall back to JI ratio name
    const name = (hasCurated && curatedNames[s]) ? curatedNames[s] : (best?.name ?? "");

    intervals.push({
      step: s, cents: +cents.toFixed(2),
      ji10, ji5, ji2,
      approxRatio: best?.ratio ?? "\u2014",
      approxRatioNums: best?.ratioNums ?? null,
      jiCents: best?.jiCents ?? null,
      errorCents: best?.errorCents ?? null,
      name,
      limit: best?.limit ?? null,
    });
  }
  return intervals;
}

// ═══════════════════════════════════════════════════════════════
// Temperament scenario presets for the animated lattice
// ═══════════════════════════════════════════════════════════════

export interface TemperScenario {
  name: string;
  description: string;
  /** Primes for the lattice */
  primes: number[];
  /** Bounds for each prime axis */
  bounds: Record<number, [number, number]>;
  /** Commas to temper, in order (user clicks through them) */
  commaSequence: { n: number; d: number; name: string }[];
  /** EDOs that result from tempering all commas */
  resultEdos: number[];
}

export const TEMPER_SCENARIOS: TemperScenario[] = [
  {
    name: "Meantone (5-limit → 12/19/31-EDO)",
    description: "Start with the pure 5-limit JI lattice. Temper out the syntonic comma (81/80) to collapse Pythagorean and just intervals. The 3-axis and 5-axis fold together — four fifths now equal a major third.",
    primes: [3, 5],
    bounds: { 3: [-5, 5], 5: [-2, 2] },
    commaSequence: [
      { n: 81, d: 80, name: "Syntonic comma (81/80)" },
    ],
    resultEdos: [12, 19, 31, 43, 50, 55],
  },
  {
    name: "Septimal meantone (7-limit)",
    description: "Extend meantone to the 7-limit by also tempering out the starling comma (126/125). This equates the augmented sixth with the harmonic seventh.",
    primes: [3, 5, 7],
    bounds: { 3: [-4, 4], 5: [-2, 2], 7: [-1, 1] },
    commaSequence: [
      { n: 81, d: 80, name: "Syntonic comma (81/80)" },
      { n: 126, d: 125, name: "Starling comma (126/125)" },
    ],
    resultEdos: [12, 19, 31],
  },
  {
    name: "Marvel (225/224) → Miracle",
    description: "The marvel comma equates 15/14 with 16/15. Adding the gamelisma collapses further into miracle temperament with its elegant secor generator.",
    primes: [3, 5, 7],
    bounds: { 3: [-3, 3], 5: [-2, 2], 7: [-2, 2] },
    commaSequence: [
      { n: 225, d: 224, name: "Septimal kleisma (225/224)" },
      { n: 1029, d: 1024, name: "Gamelisma (1029/1024)" },
    ],
    resultEdos: [31, 41, 72],
  },
  {
    name: "Pajara (50/49 + 64/63)",
    description: "Pajara splits the octave in half. The jubilisma equates 7/5 with 10/7, and the septimal comma folds the 3-7 relationship.",
    primes: [3, 5, 7],
    bounds: { 3: [-3, 3], 5: [-2, 2], 7: [-1, 1] },
    commaSequence: [
      { n: 50, d: 49, name: "Jubilisma (50/49)" },
      { n: 64, d: 63, name: "Septimal comma (64/63)" },
    ],
    resultEdos: [22, 34],
  },
  {
    name: "Porcupine (250/243)",
    description: "Three ~10/9 steps make a perfect fourth. The generator is a small neutral second around 162–164 cents.",
    primes: [3, 5],
    bounds: { 3: [-6, 6], 5: [-3, 3] },
    commaSequence: [
      { n: 250, d: 243, name: "Maximal diesis (250/243)" },
    ],
    resultEdos: [15, 22, 37],
  },
  {
    name: "Schismatic → Helmholtz/Groven",
    description: "The schisma is tiny (1.95¢) — tempering it makes eight fifths down nearly equal a major third. This is how 53-EDO works.",
    primes: [3, 5],
    bounds: { 3: [-8, 8], 5: [-1, 1] },
    commaSequence: [
      { n: 32805, d: 32768, name: "Schisma (32805/32768)" },
    ],
    resultEdos: [12, 29, 41, 53],
  },
  {
    name: "Full 7-limit collapse → 12-EDO",
    description: "Watch the JI lattice progressively collapse as we temper out 81/80 (meantone), then 128/125 (augmented), then 225/224 (marvel). The result maps perfectly to 12-EDO.",
    primes: [3, 5, 7],
    bounds: { 3: [-4, 4], 5: [-2, 2], 7: [-1, 1] },
    commaSequence: [
      { n: 81, d: 80, name: "Syntonic comma (81/80)" },
      { n: 128, d: 125, name: "Diesis (128/125)" },
      { n: 225, d: 224, name: "Septimal kleisma (225/224)" },
    ],
    resultEdos: [12],
  },
  {
    name: "Orwell (1728/1715)",
    description: "Seven steps of ~7/6 reach a perfect twelfth (3/1). The orwellisma creates a beautiful 7-limit system with a generator around 271 cents.",
    primes: [3, 5, 7],
    bounds: { 3: [-3, 3], 5: [-2, 2], 7: [-2, 2] },
    commaSequence: [
      { n: 1728, d: 1715, name: "Orwellisma (1728/1715)" },
    ],
    resultEdos: [22, 31, 53],
  },
  {
    name: "11-limit: Keenanisma path",
    description: "The keenanisma (385/384) links primes 5, 7, and 11. Watch how tempering it creates connections across all three higher-prime axes.",
    primes: [3, 5, 7, 11],
    bounds: { 3: [-3, 3], 5: [-1, 1], 7: [-1, 1], 11: [-1, 1] },
    commaSequence: [
      { n: 385, d: 384, name: "Keenanisma (385/384)" },
      { n: 441, d: 440, name: "Werckisma (441/440)" },
    ],
    resultEdos: [31, 41, 72],
  },
  {
    name: "13-limit exploration",
    description: "Temper the island comma (676/675) and the minthma (352/351) to bring prime 13 into alignment with 5 and 11.",
    primes: [3, 5, 7, 11, 13],
    bounds: { 3: [-2, 2], 5: [-1, 1], 7: [-1, 1], 11: [-1, 1], 13: [-1, 1] },
    commaSequence: [
      { n: 676, d: 675, name: "Island comma (676/675)" },
      { n: 352, d: 351, name: "Minthma (352/351)" },
      { n: 364, d: 363, name: "Gentle comma (364/363)" },
    ],
    resultEdos: [41, 46, 72],
  },
];
