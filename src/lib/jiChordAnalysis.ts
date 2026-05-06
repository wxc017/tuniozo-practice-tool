// ── JI chord analysis (scale-degree triad purity) ────────────────────────
//
// For each JI scale registered in jiScaleData.ts, walk the seven
// scale-degree triads (built by stacking the scale's own thirds) and
// classify the third and fifth of each triad against a catalog of pure
// JI ratios.  Surfaces which chord positions land on pure consonances vs
// wolf intervals — the famous compromise of fixed JI tunings (one
// position always wolfs in 5-limit, etc.).
//
// All math is done in cents on the underlying JI ratios (not the EDO
// step rounding) so 41-EDO and 53-EDO produce the same analysis — the
// chord-purity story is intrinsic to the JI tuning, not the EDO grid.

import { JI_SCALE_NAMES, getJiScaleDegrees } from "./jiScaleData";

// ── Catalog of named intervals ──────────────────────────────────────────
//
// Each entry pairs a familiar JI ratio with its cent value and a short
// label.  The `kind` flag distinguishes pure consonances ("pure") from
// the syntonic-comma-displaced wolves ("wolf") and from intervals that
// are characteristic of a higher prime limit ("pure-5", "pure-7",
// "pure-11").  Order matters when two ratios sit close together — the
// classifier picks the FIRST match within tolerance, so list canonical
// pure intervals before their wolf neighbours.
interface KnownInterval {
  ratio: string;      // e.g. "5/4"
  cents: number;      // exact cent value
  name: string;       // e.g. "Just M3"
  kind: "pure-3" | "pure-5" | "pure-7" | "pure-11" | "wolf";
}

export const KNOWN_INTERVALS: KnownInterval[] = [
  { ratio: "1/1",      cents: 0,       name: "Unison",      kind: "pure-3" },
  // 2nds
  { ratio: "16/15",    cents: 111.7,   name: "Just m2",     kind: "pure-5" },
  { ratio: "12/11",    cents: 150.6,   name: "Neutral 2",   kind: "pure-11" },
  { ratio: "10/9",     cents: 182.4,   name: "Minor M2",    kind: "pure-5" },
  { ratio: "9/8",      cents: 203.9,   name: "Pyth M2",     kind: "pure-3" },
  // 3rds
  { ratio: "7/6",      cents: 266.9,   name: "Sub3",        kind: "pure-7" },
  { ratio: "32/27",    cents: 294.1,   name: "Pyth m3",     kind: "pure-3" },
  { ratio: "6/5",      cents: 315.6,   name: "Just m3",     kind: "pure-5" },
  { ratio: "11/9",     cents: 347.4,   name: "Neutral 3",   kind: "pure-11" },
  { ratio: "5/4",      cents: 386.3,   name: "Just M3",     kind: "pure-5" },
  { ratio: "81/64",    cents: 407.8,   name: "Pyth M3",     kind: "pure-3" },
  { ratio: "9/7",      cents: 435.1,   name: "Sup3",        kind: "pure-7" },
  // 4ths / tritones
  { ratio: "4/3",      cents: 498.0,   name: "Just P4",     kind: "pure-3" },
  { ratio: "11/8",     cents: 551.3,   name: "11-limit 4",  kind: "pure-11" },
  { ratio: "7/5",      cents: 582.5,   name: "Sept TT",     kind: "pure-7" },
  { ratio: "45/32",    cents: 590.2,   name: "5-limit #4",  kind: "pure-5" },
  { ratio: "64/45",    cents: 609.8,   name: "5-limit b5",  kind: "pure-5" },
  { ratio: "10/7",     cents: 617.5,   name: "Sept b5",     kind: "pure-7" },
  // 5ths (the wolf lives here)
  { ratio: "40/27",    cents: 680.4,   name: "Wolf 5",      kind: "wolf" },
  { ratio: "3/2",      cents: 702.0,   name: "Just P5",     kind: "pure-3" },
  // 6ths
  { ratio: "14/9",     cents: 764.9,   name: "Sub6",        kind: "pure-7" },
  { ratio: "128/81",   cents: 792.2,   name: "Pyth m6",     kind: "pure-3" },
  { ratio: "8/5",      cents: 813.7,   name: "Just m6",     kind: "pure-5" },
  { ratio: "18/11",    cents: 852.6,   name: "Neutral 6",   kind: "pure-11" },
  { ratio: "5/3",      cents: 884.4,   name: "Just M6",     kind: "pure-5" },
  { ratio: "27/16",    cents: 905.9,   name: "Pyth M6",     kind: "pure-3" },
  { ratio: "12/7",     cents: 933.1,   name: "Sup6",        kind: "pure-7" },
  // 7ths
  { ratio: "7/4",      cents: 968.8,   name: "Harm 7",      kind: "pure-7" },
  { ratio: "16/9",     cents: 996.1,   name: "Pyth m7",     kind: "pure-3" },
  { ratio: "9/5",      cents: 1017.6,  name: "Just m7",     kind: "pure-5" },
  { ratio: "11/6",     cents: 1049.4,  name: "Neutral 7",   kind: "pure-11" },
  { ratio: "15/8",     cents: 1088.3,  name: "Just M7",     kind: "pure-5" },
  { ratio: "243/128",  cents: 1109.8,  name: "Pyth M7",     kind: "pure-3" },
  // Octave
  { ratio: "2/1",      cents: 1200,    name: "Octave",      kind: "pure-3" },
];

const TOLERANCE_CENTS = 4;  // "close enough" window for ratio matching

export interface ClassifiedInterval {
  cents: number;
  ratio: string;
  name: string;
  kind: "pure-3" | "pure-5" | "pure-7" | "pure-11" | "wolf" | "off-grid";
}

function classifyInterval(cents: number): ClassifiedInterval {
  // Wrap to single-octave range for matching
  let c = cents % 1200;
  if (c < 0) c += 1200;
  for (const iv of KNOWN_INTERVALS) {
    if (Math.abs(iv.cents - c) <= TOLERANCE_CENTS) {
      return { cents, ratio: iv.ratio, name: iv.name, kind: iv.kind };
    }
  }
  return { cents, ratio: `${Math.round(c)}¢`, name: "off-grid", kind: "off-grid" };
}

// ── Per-scale triad analysis ────────────────────────────────────────────

export interface TriadAnalysis {
  /** Scale degree label of the chord root (e.g. "1", "b3", "5") */
  rootDegree: string;
  /** The third of the triad (scale-degree position root + 2) */
  third: ClassifiedInterval;
  /** The fifth of the triad (scale-degree position root + 4) */
  fifth: ClassifiedInterval;
  /** True when both third and fifth are pure within the scale's limit. */
  pure: boolean;
  /** Triad quality inferred from third (M / m / N / sub / sup) and fifth
   *  (P / d / a). */
  quality: string;
}

// Pull the cent values for a JI scale by combining its registered degree
// labels with the catalog cents from KNOWN_INTERVALS.  The JI scale
// definitions in jiScaleData.ts use the same cent values, so the lookup
// is consistent.
function getScaleCents(scaleName: string): number[] | null {
  const degs = getJiScaleDegrees(scaleName);
  if (!degs) return null;
  // Re-derive cents by reading the scale spec from jiScaleData.  Avoid
  // a circular-import shape by using a registered-getter pattern below.
  const spec = JI_SCALE_CENTS_REGISTRY.get(scaleName);
  return spec ?? null;
}

// Filled by registerScaleCents() at module load (called from jiScaleData.ts).
const JI_SCALE_CENTS_REGISTRY = new Map<string, number[]>();
export function registerScaleCents(name: string, cents: number[]): void {
  JI_SCALE_CENTS_REGISTRY.set(name, cents);
}

/**
 * Walk the seven scale-degree triads of a JI scale, classifying each
 * one's third and fifth.  Returns null if the scale isn't registered.
 */
export function analyzeJiScale(scaleName: string): TriadAnalysis[] | null {
  const cents = getScaleCents(scaleName);
  const degs = getJiScaleDegrees(scaleName);
  if (!cents || !degs || cents.length !== degs.length) return null;
  const N = cents.length;
  const out: TriadAnalysis[] = [];
  for (let i = 0; i < N; i++) {
    const root = cents[i];
    const thirdRaw = cents[(i + 2) % N] + ((i + 2) >= N ? 1200 : 0) - root;
    const fifthRaw = cents[(i + 4) % N] + ((i + 4) >= N ? 1200 : 0) - root;
    const third = classifyInterval(thirdRaw);
    const fifth = classifyInterval(fifthRaw);
    const pure = third.kind !== "wolf" && third.kind !== "off-grid"
              && fifth.kind !== "wolf" && fifth.kind !== "off-grid";
    out.push({
      rootDegree: degs[i],
      third, fifth, pure,
      quality: triadQualityName(third, fifth),
    });
  }
  return out;
}

function triadQualityName(third: ClassifiedInterval, fifth: ClassifiedInterval): string {
  // Identify the chord quality from the labelled intervals, falling back
  // to a coarse cents-based bucket when the interval is off-grid.
  const thirdBucket = bucketThird(third.cents);
  const fifthBucket = bucketFifth(fifth.cents);
  if (thirdBucket === "M3" && fifthBucket === "P5") return "Major";
  if (thirdBucket === "m3" && fifthBucket === "P5") return "Minor";
  if (thirdBucket === "m3" && fifthBucket === "d5") return "Diminished";
  if (thirdBucket === "M3" && fifthBucket === "A5") return "Augmented";
  if (thirdBucket === "n3") return fifthBucket === "P5" ? "Neutral" : `Neutral (${fifth.name})`;
  if (thirdBucket === "sub3") return fifthBucket === "P5" ? "Subminor" : `Subminor (${fifth.name})`;
  if (thirdBucket === "sup3") return fifthBucket === "P5" ? "Supermajor" : `Supermajor (${fifth.name})`;
  return `${third.name} / ${fifth.name}`;
}
function bucketThird(c: number): "sub3" | "m3" | "n3" | "M3" | "sup3" | "?" {
  if (c < 280) return "sub3";
  if (c < 332) return "m3";
  if (c < 372) return "n3";
  if (c < 422) return "M3";
  if (c < 460) return "sup3";
  return "?";
}
function bucketFifth(c: number): "d5" | "P5" | "A5" | "?" {
  if (c < 670) return "d5";
  if (c < 715) return "P5";
  if (c < 750) return "A5";
  return "?";
}

// ── Adaptive-JI retuning ────────────────────────────────────────────────
//
// In Adaptive JI mode, each chord's third and fifth are retuned to pure
// ratios from the chord's root, regardless of where the scale would
// place them.  This eliminates the wolf at the cost of breaking
// scale-tone identity (the "5" of the scale and the "5" of the V chord
// may now differ slightly — the comma drift).
//
// Returns a step-offset triad relative to the chord root, suitable for
// substituting into the chord-pool's step arrays.

export interface AdaptiveTriad {
  /** Steps from chord root for [root, third, fifth] */
  steps: [number, number, number];
  /** Cents for [root, third, fifth] */
  cents: [number, number, number];
}

// ── Comma-drift reference catalog ───────────────────────────────────────
//
// Expected tonic drift (in cents) for common cadences when *true*
// Adaptive JI is used — each chord's root inferred from the previous
// chord's pure-interval motion, accumulating commas as the chain
// progresses.  These figures are well-known JI results: the classic
// I-vi-ii-V-I "comma pump" drifts the tonic 81/80 ≈ 21.5¢ flat in
// 5-limit; analogous pumps exist in 7-limit / 11-limit at their own
// commas.  3-limit (Pythagorean) doesn't pump on diatonic cadences
// since every chord motion is a pure fifth.
//
// The current Adaptive-JI implementation in ChordsTab is the milder
// "Pure Triads" variant — chord roots stay anchored to the scale, only
// the third + fifth are retuned — so these drifts represent what would
// happen under *true* Adaptive (chord roots derived from pure-interval
// chains), shown here as a reference.

export interface CadenceDrift {
  cadence: string;        // e.g. "I - vi - ii - V - I"
  driftCents: number;     // signed cents (negative = flat, positive = sharp)
  comma: string;          // name of the comma involved
  applies: ("3-limit" | "5-limit" | "7-limit" | "11-limit")[];
  blurb: string;          // one-line explanation
}

export const COMMA_DRIFT_CATALOG: CadenceDrift[] = [
  {
    cadence: "I - V - I",
    driftCents: 0,
    comma: "—",
    applies: ["3-limit", "5-limit", "7-limit", "11-limit"],
    blurb: "Pure plagal motion; both fifths cancel.",
  },
  {
    cadence: "I - IV - V - I",
    driftCents: 0,
    comma: "—",
    applies: ["3-limit", "5-limit", "7-limit", "11-limit"],
    blurb: "Plain authentic cadence; no chord chain enters the comma zone.",
  },
  {
    cadence: "I - vi - ii - V - I",
    driftCents: -21.5,
    comma: "Syntonic (81/80)",
    applies: ["5-limit"],
    blurb: "The classic comma pump.  vi→ii forces a 10/9 motion where 9/8 was expected.",
  },
  {
    cadence: "I - IV - ii - V - I",
    driftCents: -21.5,
    comma: "Syntonic (81/80)",
    applies: ["5-limit"],
    blurb: "ii substituted for IV creates the same comma-pump motion vi→ii does.",
  },
  {
    cadence: "I - iii - vi - ii - V - I",
    driftCents: -21.5,
    comma: "Syntonic (81/80)",
    applies: ["5-limit"],
    blurb: "Extended turnaround through every diatonic chord; one syntonic comma flat.",
  },
  {
    cadence: "I - bVII - IV - I",
    driftCents: -21.5,
    comma: "Syntonic (81/80)",
    applies: ["5-limit"],
    blurb: "Modal-mixture pump; bVII as a JI 16/9 from a JI tonic doesn't quite return.",
  },
  {
    cadence: "i - bVII - bVI - V - i  (Andalusian)",
    driftCents: 0,
    comma: "—",
    applies: ["5-limit"],
    blurb: "Pure stepwise descending bass — no comma motion.",
  },
  {
    cadence: "I - V/IV - IV - I  (V/IV with 7/4)",
    driftCents: -27.3,
    comma: "Septimal (64/63)",
    applies: ["7-limit"],
    blurb: "Septimal V/IV uses the harmonic 7th (7/4); its resolution to IV pumps the septimal comma.",
  },
];

/**
 * Retune a triad to pure JI based on the chord quality inferred from the
 * frozen-JI third and fifth.  Returns null for unrecognised qualities so
 * the caller can fall back to the frozen version.
 */
export function adaptiveTriadFor(
  third: ClassifiedInterval,
  fifth: ClassifiedInterval,
  edo: number,
): AdaptiveTriad | null {
  const tb = bucketThird(third.cents);
  const fb = bucketFifth(fifth.cents);
  const c2s = (c: number) => Math.round((c / 1200) * edo);
  const wrap = (centsList: [number, number, number]): AdaptiveTriad => ({
    cents: centsList,
    steps: [c2s(centsList[0]), c2s(centsList[1]), c2s(centsList[2])],
  });
  if (tb === "M3" && fb === "P5") return wrap([0, 386.3, 702.0]);   // 4:5:6 major
  if (tb === "m3" && fb === "P5") return wrap([0, 315.6, 702.0]);   // 10:12:15 minor
  if (tb === "m3" && fb === "d5") return wrap([0, 315.6, 609.8]);   // diminished (5-limit)
  if (tb === "M3" && fb === "A5") return wrap([0, 386.3, 772.6]);   // augmented (5/4 + 5/4)
  if (tb === "n3" && fb === "P5") return wrap([0, 347.4, 702.0]);   // 11-limit neutral triad
  if (tb === "sub3" && fb === "P5") return wrap([0, 266.9, 702.0]); // 6:7:9 subminor
  if (tb === "sup3" && fb === "P5") return wrap([0, 435.1, 702.0]); // 14:18:21 supermajor (9/7 + ~)
  return null;
}
