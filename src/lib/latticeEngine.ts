/**
 * Monzo-style JI Lattice Engine
 *
 * Supports:
 * - Arbitrary primes (2, 3, 5, 7, 11, 13, 17, 19, 23, …)
 * - Programmable per-axis bounds (asymmetric, independent)
 * - Octave equivalence (mod-2 reduction)
 * - N-dimensional internal space with configurable 3D projection
 * - Comma tempering with geometry bending
 * - Dynamic node generation from bounds config
 */

import { xenIntervalName, xenIntervalNames, XEN_INTERVAL_MAP } from "./xenIntervals";
export { ratioToHEJILabel, hejiToText, hejiToCompactText, hejiToSMuFL, hejiAccidentalSMuFL, ratioToShorthand } from "./hejiNotation";
export type { HEJILabel, HEJINotation, HEJICommaModifier } from "./hejiNotation";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** A monzo: vector of prime exponents. exps[i] is the exponent of primes[i]. */
export interface Monzo {
  /** Numerator of the ratio (for display) */
  n: number;
  /** Denominator of the ratio (for display) */
  d: number;
  /** Exponent vector — exps[i] corresponds to primes[i] in the config */
  exps: number[];
  /** If true, this is a comma node */
  isComma?: boolean;
}

/** Per-axis bound config */
export interface AxisBound {
  prime: number;
  /** Max positive exponent (e.g. +6) */
  max: number;
  /** Max negative exponent (e.g. -6, stored as negative) */
  min: number;
}

/** A comma to temper out */
export interface CommaSpec {
  n: number;
  d: number;
  name: string;
}

/** 3D projection vector for a prime axis */
export interface PrimeProjection {
  prime: number;
  vec: [number, number, number];
}

/** Full lattice configuration */
/** Grid geometry: "square" uses orthogonal axes, "triangle" uses 60° angles */
export type GridType = "square" | "triangle" | "helical" | "toroidal";

/**
 * Tuning optimization method for higher-rank temperaments.
 * For EDOs (rank-1), all methods produce the same result.
 *
 * - "TE"   — Tenney-Euclidean: minimizes RMS cents error weighted by log₂(p).
 *            Octave may stretch. Standard default in RT community.
 * - "POTE" — Pure-Octave TE: same as TE but octave pinned to 1200¢.
 *            Practical for keyboards/DAWs.
 * - "TOP"  — Tenney Optimal (minimax): minimizes worst-case relative error
 *            weighted by Tenney height. Octave may stretch.
 * - "CTE"  — Constrained TE: preserves eigenmonzos as pure, optimizes the rest.
 *            Octave is always pure.
 * - "Euclidean" — Unweighted projection: all primes treated equally.
 *            Minimizes exponent-space error, not perceptual error.
 */
export type TuningMethod = "TE" | "POTE" | "TOP" | "CTE" | "Euclidean";

export interface LatticeConfig {
  /** Which primes to include as axes */
  primes: number[];
  /** Per-axis bounds: [min, max] exponent for each prime */
  bounds: Record<number, [number, number]>;
  /** Whether to use octave equivalence (collapse prime-2) */
  octaveEquivalence: boolean;
  /** Include prime 2 as a lattice axis (only relevant if octaveEquivalence is false) */
  showPrime2: boolean;
  /** 3D projection vectors for each prime */
  projections: Record<number, [number, number, number]>;
  /** Commas to temper out */
  temperedCommas: CommaSpec[];
  /** Grid geometry — square (orthogonal) or triangle (60° skew) */
  gridType?: GridType;
  /** EDO number — when set, equivalence classes use val-based classification
   *  which always produces exactly `edo` classes (instead of SNF which may
   *  give more classes when commas don't fully span the lattice dimensions). */
  edo?: number;
  /** Tuning optimization method for tempered pitch computation */
  tuningMethod?: TuningMethod;
}

export interface LatticeNode {
  monzo: Monzo;
  key: string;           // "n/d" display key
  pos3d: [number, number, number];
  /** If tempered, which equivalence class this belongs to */
  temperedClass?: number;
}

export interface LatticeEdge {
  from: string;
  to: string;
  prime: number;
  type: "generator" | "comma" | "tempered";
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

export const ALL_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 127] as const;

export const PRIME_COLORS: Record<number, string> = {
  2:   "#ff4488",
  3:   "#e87010",
  5:   "#22cc44",
  7:   "#5599ff",
  11:  "#ddbb00",
  13:  "#cc44cc",
  17:  "#ff6688",
  19:  "#44dddd",
  23:  "#88ff44",
  29:  "#ff8844",
  31:  "#aa66ff",
  37:  "#ff5566",
  41:  "#55ddaa",
  43:  "#dd7744",
  47:  "#6688ee",
  53:  "#aacc33",
  59:  "#ee55aa",
  61:  "#44bbcc",
  67:  "#ccaa55",
  71:  "#7755dd",
  73:  "#55cc77",
  79:  "#dd5577",
  83:  "#77aaee",
  89:  "#bbdd55",
  97:  "#aa55cc",
  127: "#55aadd",
};

/** Default 3D projection vectors — first 3 primes get orthogonal axes,
 *  higher primes are projected into the space at distinct angles */
export const DEFAULT_PROJECTIONS: Record<number, [number, number, number]> = {
  2:   [1.5, 1.5, -1.0],
  3:   [3.0, 0, 0],
  5:   [0, 3.0, 0],
  7:   [0, 0, 3.0],
  11:  [1.2, 1.2, 1.5],
  13:  [-1.4, 0.8, 0.5],
  17:  [1.0, -1.2, 0.8],
  19:  [-0.8, -1.0, 1.2],
  23:  [0.6, 0.8, -1.4],
  29:  [-1.0, 1.4, -0.6],
  31:  [1.4, -0.6, -1.0],
  37:  [-0.6, 1.6, 0.8],
  41:  [1.6, 0.4, -0.8],
  43:  [-1.2, -0.6, 1.4],
  47:  [0.4, -1.4, -1.0],
  53:  [1.0, 1.0, -1.2],
  59:  [-1.6, -0.4, -0.6],
  61:  [0.8, -0.8, 1.6],
  67:  [-0.4, 1.2, -1.4],
  71:  [1.4, -1.0, 0.4],
  73:  [-1.0, -1.4, 0.8],
  79:  [0.6, 1.4, 1.0],
  83:  [-0.8, 0.4, -1.6],
  89:  [1.2, -0.6, -1.4],
  97:  [-1.4, 1.0, 1.2],
  127: [0.8, -1.6, 0.6],
};

/**
 * Triangle-grid projection vectors: axes separated by 60° instead of 90°.
 *
 * For 2D (primes 3, 5): prime 3 → east, prime 5 → 60° NE.
 * For 3D+: the first two active primes get the 60° relationship,
 * remaining primes use distinct out-of-plane directions.
 *
 * The cos/sin(60°) = (0.5, √3/2) skew creates the classic triangular
 * Tonnetz / hexagonal-lattice look.
 */
export const TRIANGLE_PROJECTIONS: Record<number, [number, number, number]> = {
  2:   [1.5, 1.5, -1.0],           // same as square (rarely an axis)
  3:   [3.0, 0, 0],                // → east
  5:   [1.5, 2.598, 0],            // → 60° NE  (3·cos60°, 3·sin60°, 0)
  7:   [0, 0, 3.0],                // → up (out of plane)
  11:  [0.75, 1.299, 2.0],         // 60° blend into z
  13:  [-1.5, 0.866, 1.0],         // distinct angle
  17:  [1.0, -1.2, 0.8],
  19:  [-0.8, -1.0, 1.2],
  23:  [0.6, 0.8, -1.4],
  29:  [-1.0, 1.4, -0.6],
  31:  [1.4, -0.6, -1.0],
  37:  [-0.6, 1.6, 0.8],
  41:  [1.6, 0.4, -0.8],
  43:  [-1.2, -0.6, 1.4],
  47:  [0.4, -1.4, -1.0],
  53:  [1.0, 1.0, -1.2],
  59:  [-1.6, -0.4, -0.6],
  61:  [0.8, -0.8, 1.6],
  67:  [-0.4, 1.2, -1.4],
  71:  [1.4, -1.0, 0.4],
  73:  [-1.0, -1.4, 0.8],
  79:  [0.6, 1.4, 1.0],
  83:  [-0.8, 0.4, -1.6],
  89:  [1.2, -0.6, -1.4],
  97:  [-1.4, 1.0, 1.2],
  127: [0.8, -1.6, 0.6],
};

/** Get effective projections for a grid type */
export function getProjections(gridType: GridType | undefined): Record<number, [number, number, number]> {
  return gridType === "triangle" ? TRIANGLE_PROJECTIONS : DEFAULT_PROJECTIONS;
}

/** Well-known commas */
export const KNOWN_COMMAS: CommaSpec[] = [
  { n: 81,  d: 80,  name: "Syntonic comma" },
  { n: 64,  d: 63,  name: "Septimal comma" },
  { n: 33,  d: 32,  name: "Undecimal comma" },
  { n: 128, d: 125, name: "Diesis" },
  { n: 225, d: 224, name: "Septimal kleisma" },
  { n: 385, d: 384, name: "Keenanisma" },
  { n: 513, d: 512, name: "Schisma (19-limit)" },
  { n: 736, d: 729, name: "23-limit comma" },
];

// ═══════════════════════════════════════════════════════════════
// Preset configs
// ═══════════════════════════════════════════════════════════════

export const PRESET_CONFIGS: Record<string, LatticeConfig> = {
  "5-limit": {
    primes: [2, 3, 5],
    bounds: { 2: [-1, 1], 3: [-4, 4], 5: [-2, 2] },
    octaveEquivalence: true,
    showPrime2: false,
    projections: DEFAULT_PROJECTIONS,
    temperedCommas: [],
  },
  "7-limit": {
    primes: [2, 3, 5, 7],
    bounds: { 2: [-1, 1], 3: [-4, 4], 5: [-2, 2], 7: [-1, 1] },
    octaveEquivalence: true,
    showPrime2: false,
    projections: DEFAULT_PROJECTIONS,
    temperedCommas: [],
  },
  "13-limit": {
    primes: [2, 3, 5, 7, 11, 13],
    bounds: { 2: [-1, 1], 3: [-3, 3], 5: [-2, 2], 7: [-1, 1], 11: [-1, 1], 13: [-1, 1] },
    octaveEquivalence: true,
    showPrime2: false,
    projections: DEFAULT_PROJECTIONS,
    temperedCommas: [],
  },
  "Monzo high-limit": {
    primes: [2, 3, 5, 7, 17, 19, 23],
    bounds: { 2: [-1, 1], 3: [-6, 6], 5: [-2, 3], 7: [-1, 2], 17: [-1, 1], 19: [-1, 1], 23: [-1, 1] },
    octaveEquivalence: true,
    showPrime2: false,
    projections: DEFAULT_PROJECTIONS,
    temperedCommas: [],
  },
  "Meantone (81/80)": {
    primes: [2, 3, 5],
    bounds: { 2: [-1, 1], 3: [-6, 6], 5: [-2, 2] },
    octaveEquivalence: true,
    showPrime2: false,
    projections: DEFAULT_PROJECTIONS,
    temperedCommas: [{ n: 81, d: 80, name: "Syntonic comma" }],
  },
  "Septimal meantone": {
    primes: [2, 3, 5, 7],
    bounds: { 2: [-1, 1], 3: [-4, 4], 5: [-2, 2], 7: [-1, 1] },
    octaveEquivalence: true,
    showPrime2: false,
    projections: DEFAULT_PROJECTIONS,
    temperedCommas: [
      { n: 81, d: 80, name: "Syntonic comma" },
      { n: 225, d: 224, name: "Septimal kleisma" },
    ],
  },
};

// ═══════════════════════════════════════════════════════════════
// Math utilities
// ═══════════════════════════════════════════════════════════════

export function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

export function ratioToCents(n: number, d: number): number {
  return 1200 * Math.log2(n / d);
}

/** Factorize n/d into monzo exponents for the given primes.
 *  Returns exponent vector. Ignores prime 2 if octaveEquivalence is true. */
export function factorize(n: number, d: number, primes: number[], octaveEq: boolean): number[] {
  const exps = new Array(primes.length).fill(0);
  // Remove factors of 2 if octave-equivalent
  if (octaveEq) {
    while (n % 2 === 0) n /= 2;
    while (d % 2 === 0) d /= 2;
  }
  for (let i = 0; i < primes.length; i++) {
    const p = primes[i];
    if (p === 2 && octaveEq) continue;
    while (n % p === 0) { n /= p; exps[i]++; }
    while (d % p === 0) { d /= p; exps[i]--; }
  }
  return exps;
}

/** Build n/d ratio from a monzo exponent vector */
export function monzoToRatio(exps: number[], primes: number[], octaveEq: boolean): [number, number] {
  let n = 1, d = 1;
  for (let i = 0; i < primes.length; i++) {
    const p = primes[i];
    if (p === 2 && octaveEq) continue;
    if (exps[i] > 0) {
      n *= Math.pow(p, exps[i]);
    } else if (exps[i] < 0) {
      d *= Math.pow(p, -exps[i]);
    }
  }
  // Guard against overflow producing non-finite values
  if (!isFinite(n) || !isFinite(d) || n === 0 || d === 0) {
    return [1, 1];
  }
  // Octave-reduce to [1, 2) if octave-equivalent
  if (octaveEq) {
    let ratio = n / d;
    let safety = 0;
    while (ratio >= 2 && safety < 60) { d *= 2; ratio = n / d; safety++; }
    safety = 0;
    while (ratio < 1 && safety < 60) { n *= 2; ratio = n / d; safety++; }
  }
  if (!isFinite(n) || !isFinite(d)) return [1, 1];
  const g = gcd(n, d);
  return [n / g, d / g];
}

/** Project a monzo into 3D space using projection vectors */
export function monzoTo3D(
  exps: number[],
  primes: number[],
  projections: Record<number, [number, number, number]>,
): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < primes.length; i++) {
    const p = primes[i];
    const proj = projections[p] ?? [0, 0, 0];
    x += exps[i] * proj[0];
    y += exps[i] * proj[1];
    z += exps[i] * proj[2];
  }
  return [x, y, z];
}

/** Helical / Tonescape-style projection.
 *
 *  This is the canonical Tonalsoft Tonescape layout: every pitch
 *  sits on a cylinder where one full turn equals one octave, and
 *  the vertical axis is log-frequency.  Specifically:
 *
 *    cents = Σ exp_i · log2(prime_i) · 1200    (total log frequency)
 *    angle = 2π · (cents mod 1200) / 1200      (pitch class on the wheel)
 *    y     = cents · YCENTS_PER_UNIT           (octave-by-octave rise)
 *
 *  Two cells separated by an octave land directly above each other.
 *  Two cells separated by a fifth land 7/12 of a turn apart and a
 *  bit higher.  The chain of fifths in 12-EDO (12 cells) makes 7
 *  full rotations and rises 7 octaves — the classic Tonescape
 *  helix.  In 41 / 53-EDO the spiral has more turns per octave
 *  because each fifth is closer to pure 3/2.
 *
 *  Higher-prime axes (5, 7) are baked into `cents`, so cells off
 *  the 3-axis still land at their honest pitch height.  No
 *  artificial "radius modulation" — the cylinder stays a clean
 *  cylinder, and the only thing that distinguishes cells visually
 *  is their position on it.  `edo` is unused by the projection
 *  itself (the cylinder is the same regardless), but it's accepted
 *  so callers can flag context for debug / labeling. */
export function monzoTo3DHelical(
  exps: number[],
  primes: number[],
  _edo: number | null,
): [number, number, number] {
  let cents = 0;
  for (let i = 0; i < primes.length; i++) {
    const p = primes[i];
    const exp = exps[i] ?? 0;
    if (exp !== 0) cents += exp * 1200 * Math.log2(p);
  }

  // Spacing tuned to match the linear-lattice scale (DEFAULT_PROJECTIONS
  // puts cells ~3 units apart per prime axis).  RADIUS sets cylinder
  // diameter; Y_PER_OCTAVE keeps the helix from over-stretching
  // vertically so chord-tone clusters stay close together on screen
  // and the user can follow chord motion at a glance.
  const RADIUS = 3.0;
  const Y_PER_OCTAVE = 1.5;
  const angle = 2 * Math.PI * (((cents % 1200) + 1200) % 1200) / 1200;
  const y = (cents / 1200) * Y_PER_OCTAVE;
  const x = RADIUS * Math.cos(angle);
  const z = RADIUS * Math.sin(angle);
  return [x, y, z];
}

/** Toroidal / Tonescape "3,5-primespace" projection.
 *
 *  Every EDO renders as a smooth helix on a cylinder, with each
 *  fifth advancing the major angle by 2π/edo and lifting z by one
 *  slice.  After `edo` fifths the helix closes.  The cell's
 *  position along the spiral is its chain-of-fifths index
 *  k = step · P5⁻¹ (mod edo); this is the inverse of the
 *  forward map step = k · P5_step (mod edo) that walks fifths
 *  through every EDO class exactly once.
 *
 *  Why a cylinder instead of a torus, even when the EDO is
 *  composite: the (step mod a, step mod b) torus parameterisation
 *  groups augmented triads into clean columns but jumps `u` by
 *  a large angle per fifth (e.g. 270° in 12-EDO), so the P5 chain
 *  draws as straight chord-lines slicing the surface rather than
 *  a smooth curve.  Using k as the spine keeps each P5 step at
 *  Δu = 2π/edo — a small, continuous advance — so the chain reads
 *  visually as a single helical curve wrapping the cylinder.
 *
 *  Falls back to the linear sum projection when `edo` is null. */
export function monzoTo3DToroidal(
  exps: number[],
  primes: number[],
  edo: number | null,
): [number, number, number] {
  if (edo === null || edo <= 0) {
    return monzoTo3D(exps, primes, DEFAULT_PROJECTIONS);
  }
  const val = primes.map(p => Math.round(edo * Math.log2(p)));
  let step = 0;
  for (let i = 0; i < primes.length; i++) step += val[i] * (exps[i] ?? 0);
  step = ((step % edo) + edo) % edo;

  // Modular inverse of the P5 step — small loop is fine for edo ≤ ~100.
  const p5Step = Math.round(edo * Math.log2(3 / 2));
  let invP5 = 0;
  for (let i = 1; i < edo; i++) {
    if (((p5Step * i) % edo + edo) % edo === 1) {
      invP5 = i;
      break;
    }
  }
  const k = ((step * invP5) % edo + edo) % edo;

  const cylR = 5.0;
  const verticalSpan = 10.0;
  const u = 2 * Math.PI * k / edo;
  const z = (k / edo) * verticalSpan - verticalSpan / 2;
  return [cylR * Math.cos(u), z, cylR * Math.sin(u)];
}

// ═══════════════════════════════════════════════════════════════
// Linear algebra for tempering projection
// ═══════════════════════════════════════════════════════════════

/** Invert a square matrix using Gauss-Jordan elimination. Returns null if singular. */
function invertMatrix(M: number[][]): number[][] | null {
  const n = M.length;
  if (n === 0) return [];
  const aug = M.map((row, i) => {
    const r = [...row];
    for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
    return r;
  });
  for (let col = 0; col < n; col++) {
    let maxVal = Math.abs(aug[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) return null;
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = aug[row][col];
      for (let j = 0; j < 2 * n; j++) aug[row][j] -= f * aug[col][j];
    }
  }
  return aug.map(row => row.slice(n));
}

/**
 * Compute the projection matrix onto the complement of the comma space.
 *
 * Unweighted (weights omitted):
 *   P = I − Cᵀ(CCᵀ)⁻¹C
 *   Standard Euclidean projection — used for lattice visualization.
 *
 * Tenney-weighted (weights = log₂(p) for each prime):
 *   P = I − M⁻¹Cᵀ(CM⁻¹Cᵀ)⁻¹C   where M = diag(w²)
 *   Minimizes RMS error in cents (log-frequency) across tempered primes.
 *   This is the TE (Tenney-Euclidean) optimal tuning from regular
 *   temperament theory (Gene Ward Smith, Graham Breed).
 *
 * Tempering IS this projection: every monzo is mapped to Rⁿ/V where
 * V = span(comma vectors). Monzos differing by a comma project to the
 * same point — which is exactly what "declaring a comma = 0" means
 * geometrically.
 */
function commaProjectionMatrix(
  commaVectors: number[][],
  dim: number,
  weights?: number[],
): number[][] {
  const k = commaVectors.length;
  if (k === 0) {
    return Array.from({ length: dim }, (_, i) => {
      const row = new Array(dim).fill(0); row[i] = 1; return row;
    });
  }

  const C = commaVectors;

  if (!weights) {
    // ── Unweighted: P = I − Cᵀ(CCᵀ)⁻¹C ──

    const CCT: number[][] = Array.from({ length: k }, (_, i) =>
      Array.from({ length: k }, (_, j) => {
        let s = 0;
        for (let l = 0; l < dim; l++) s += C[i][l] * C[j][l];
        return s;
      })
    );

    const inv = invertMatrix(CCT);
    if (!inv) return gramSchmidtProjection(commaVectors, dim);

    const CTinv: number[][] = Array.from({ length: dim }, (_, i) =>
      Array.from({ length: k }, (_, j) => {
        let s = 0;
        for (let l = 0; l < k; l++) s += C[l][i] * inv[l][j];
        return s;
      })
    );

    return Array.from({ length: dim }, (_, i) =>
      Array.from({ length: dim }, (_, j) => {
        let s = 0;
        for (let l = 0; l < k; l++) s += CTinv[i][l] * C[l][j];
        return (i === j ? 1 : 0) - s;
      })
    );
  }

  // ── Tenney-weighted: P = I − Cᵀ(CMCᵀ)⁻¹CM ──
  // M = diag(w²) — the Tenney metric on monzo space.
  // Projects onto the M-orthogonal complement of the comma subspace.
  const w2 = weights.map(w => w * w);

  // CMCᵀ (k×k): [i][j] = Σ_l C[i][l] · C[j][l] · w[l]²
  const CMCT: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => {
      let s = 0;
      for (let l = 0; l < dim; l++) s += C[i][l] * C[j][l] * w2[l];
      return s;
    })
  );

  const inv = invertMatrix(CMCT);
  if (!inv) return gramSchmidtProjection(commaVectors, dim, weights);

  // Cᵀ · inv (dim×k): [i][j] = Σ_l C[l][i] · inv[l][j]
  const CTinv: number[][] = Array.from({ length: dim }, (_, i) =>
    Array.from({ length: k }, (_, j) => {
      let s = 0;
      for (let l = 0; l < k; l++) s += C[l][i] * inv[l][j];
      return s;
    })
  );

  // P[i][j] = δ_ij − Σ_l CTinv[i][l] · C[l][j] · w²[j]
  return Array.from({ length: dim }, (_, i) =>
    Array.from({ length: dim }, (_, j) => {
      let s = 0;
      for (let l = 0; l < k; l++) s += CTinv[i][l] * C[l][j];
      return (i === j ? 1 : 0) - s * w2[j];
    })
  );
}

/**
 * Fallback for dependent commas: Gram-Schmidt orthogonalization of comma
 * directions, then project onto the orthogonal complement.
 *
 * When weights are provided, orthogonalization uses the M-inner product
 * ⟨x,y⟩_M = Σ x[i]·y[i]·w[i]² and the complement projector is
 * P = I − Σ bᵢ bᵢᵀ M  (where bᵢ are M-orthonormal).
 */
function gramSchmidtProjection(
  commaVectors: number[][],
  dim: number,
  weights?: number[],
): number[][] {
  const w2 = weights ? weights.map(w => w * w) : undefined;
  const basis: number[][] = [];

  for (const v of commaVectors) {
    const u = [...v];
    for (const b of basis) {
      // ⟨u, b⟩_M  (b is M-orthonormal so no denominator needed)
      const dot = w2
        ? u.reduce((s, x, i) => s + x * b[i] * w2[i], 0)
        : u.reduce((s, x, i) => s + x * b[i], 0);
      for (let i = 0; i < dim; i++) u[i] -= dot * b[i];
    }
    const normSq = w2
      ? u.reduce((s, x, i) => s + x * x * w2[i], 0)
      : u.reduce((s, x) => s + x * x, 0);
    const norm = Math.sqrt(normSq);
    if (norm > 1e-10) {
      for (let i = 0; i < dim; i++) u[i] /= norm;
      basis.push(u);
    }
  }

  // Unweighted: P = I − Σ bᵢbᵢᵀ
  // Weighted:   P = I − Σ bᵢ bᵢᵀ M   →  P[i][j] = δᵢⱼ − Σ_k b_k[i]·b_k[j]·w²[j]
  const P: number[][] = Array.from({ length: dim }, (_, i) =>
    Array.from({ length: dim }, (_, j) => {
      let s = i === j ? 1 : 0;
      for (const b of basis) s -= w2 ? b[i] * b[j] * w2[j] : b[i] * b[j];
      return s;
    })
  );
  return P;
}

/**
 * PCA redistribution for tempered 3D positions.
 *
 * After comma tempering, all positions may lie on a plane or line in 3D
 * (because tempering removes dimensions). This makes orbit controls feel
 * stuck — most rotation angles show the structure edge-on.
 *
 * We compute the 3×3 covariance matrix, find its eigenvalues/eigenvectors,
 * then rotate positions so the largest-variance direction maps to X, second
 * to Y, third to Z. If a dimension has near-zero variance we inflate it
 * slightly so the structure has some depth and orbiting feels smooth.
 */
function redistributeAxesPCA(positions: Map<string, [number, number, number]>): void {
  if (positions.size < 2) return;

  // Compute centroid
  let cx = 0, cy = 0, cz = 0;
  for (const [, p] of positions) { cx += p[0]; cy += p[1]; cz += p[2]; }
  const n = positions.size;
  cx /= n; cy /= n; cz /= n;

  // Compute 3×3 covariance matrix (symmetric)
  let cov00 = 0, cov01 = 0, cov02 = 0;
  let cov11 = 0, cov12 = 0, cov22 = 0;
  for (const [, p] of positions) {
    const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
    cov00 += dx * dx; cov01 += dx * dy; cov02 += dx * dz;
    cov11 += dy * dy; cov12 += dy * dz; cov22 += dz * dz;
  }
  cov00 /= n; cov01 /= n; cov02 /= n;
  cov11 /= n; cov12 /= n; cov22 /= n;

  // Find eigenvalues/eigenvectors of the 3×3 symmetric covariance matrix
  // using Jacobi iteration (simple and robust for 3×3)
  const mat = [
    [cov00, cov01, cov02],
    [cov01, cov11, cov12],
    [cov02, cov12, cov22],
  ];
  const evecs = [[1,0,0],[0,1,0],[0,0,1]]; // starts as identity

  for (let iter = 0; iter < 50; iter++) {
    // Find largest off-diagonal element
    let maxVal = 0, p = 0, q = 1;
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        if (Math.abs(mat[i][j]) > maxVal) { maxVal = Math.abs(mat[i][j]); p = i; q = j; }
      }
    }
    if (maxVal < 1e-12) break;

    // Jacobi rotation
    const theta = 0.5 * Math.atan2(2 * mat[p][q], mat[p][p] - mat[q][q]);
    const c = Math.cos(theta), s = Math.sin(theta);

    // Rotate mat: G^T * mat * G
    const newMat: number[][] = mat.map(row => [...row]);
    for (let i = 0; i < 3; i++) {
      newMat[i][p] = c * mat[i][p] + s * mat[i][q];
      newMat[i][q] = -s * mat[i][p] + c * mat[i][q];
    }
    for (let j = 0; j < 3; j++) {
      mat[p][j] = c * newMat[p][j] + s * newMat[q][j];
      mat[q][j] = -s * newMat[p][j] + c * newMat[q][j];
    }
    // Copy back symmetric part
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        mat[j][i] = mat[i][j];
      }
    }

    // Rotate eigenvector matrix
    for (let i = 0; i < 3; i++) {
      const ep = evecs[i][p], eq = evecs[i][q];
      evecs[i][p] = c * ep + s * eq;
      evecs[i][q] = -s * ep + c * eq;
    }
  }

  // Eigenvalues are on the diagonal; sort descending
  const evals = [
    { val: mat[0][0], idx: 0 },
    { val: mat[1][1], idx: 1 },
    { val: mat[2][2], idx: 2 },
  ].sort((a, b) => b.val - a.val);

  // Build rotation matrix: rows = eigenvectors sorted by descending eigenvalue
  // evecs[row][col] — column `idx` is the eigenvector for that eigenvalue
  const R: number[][] = evals.map(e => [evecs[0][e.idx], evecs[1][e.idx], evecs[2][e.idx]]);

  // Determine scaling: if a principal axis has near-zero variance compared to
  // the largest, inflate it so the structure has visible depth.
  const maxEval = Math.max(evals[0].val, 1e-15);
  const FLAT_THRESHOLD = 0.01; // axis counts as "flat" if <1% of max variance
  const INFLATE_FRACTION = 0.15; // inflate flat axes to 15% of max spread
  const targetStddev = Math.sqrt(maxEval) * INFLATE_FRACTION;
  const MAX_SCALE = 1000; // prevent extreme scale factors that produce Infinity positions
  const scales = evals.map(e => {
    if (e.val < maxEval * FLAT_THRESHOLD) {
      const currentStd = Math.sqrt(Math.max(e.val, 1e-30));
      return Math.min(targetStddev / currentStd, MAX_SCALE);
    }
    return 1;
  });

  // Apply: center, rotate, scale, re-center
  for (const [key, pos] of positions) {
    const dx = pos[0] - cx, dy = pos[1] - cy, dz = pos[2] - cz;
    const rx = R[0][0] * dx + R[0][1] * dy + R[0][2] * dz;
    const ry = R[1][0] * dx + R[1][1] * dy + R[1][2] * dz;
    const rz = R[2][0] * dx + R[2][1] * dy + R[2][2] * dz;
    positions.set(key, [
      rx * scales[0] + cx,
      ry * scales[1] + cy,
      rz * scales[2] + cz,
    ]);
  }
}

/** Apply projection matrix to a monzo exponent vector. */
function projectMonzo(exps: number[], P: number[][]): number[] {
  const dim = exps.length;
  const result = new Array(dim).fill(0);
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      result[i] += P[i][j] * exps[j];
    }
  }
  return result;
}

/**
 * Analyze the quotient group Z^n / <commas> via Smith Normal Form.
 *
 * Returns invariant factors describing the group structure:
 * - factor = 1  →  direction fully collapsed (trivial)
 * - factor > 1  →  finite cyclic group of that order (loop)
 * - remaining n−k dimensions  →  free Z factors (infinite lines)
 */
export function analyzeQuotientGroup(
  commaVectors: number[][],
  dim: number,
): { invariantFactors: number[]; cyclicOrders: number[]; freeDims: number; collapsedDims: number } {
  if (commaVectors.length === 0) {
    return { invariantFactors: [], cyclicOrders: [], freeDims: dim, collapsedDims: 0 };
  }

  const { S } = smithNormalForm(commaVectors);

  const invariantFactors: number[] = [];
  for (let i = 0; i < Math.min(S.length, dim); i++) {
    const d = i < S[i].length ? Math.abs(S[i][i]) : 0;
    invariantFactors.push(d);
  }

  const collapsedDims = invariantFactors.filter(d => d === 1).length;
  const cyclicOrders = invariantFactors.filter(d => d > 1);
  const commaRank = invariantFactors.filter(d => d >= 1).length;
  const freeDims = dim - commaRank;

  return { invariantFactors, cyclicOrders, freeDims, collapsedDims };
}

// ═══════════════════════════════════════════════════════════════
// Superscript formatting
// ═══════════════════════════════════════════════════════════════

const SUP: Record<string, string> = {
  "-": "\u207B", "0": "\u2070", "1": "\u00B9", "2": "\u00B2", "3": "\u00B3",
  "4": "\u2074", "5": "\u2075", "6": "\u2076", "7": "\u2077", "8": "\u2078", "9": "\u2079",
};

function toSup(n: number): string {
  return String(n).split("").map(c => SUP[c] ?? c).join("");
}

export function monzoLabel(exps: number[], primes: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < primes.length; i++) {
    if (exps[i] !== 0) parts.push(`${primes[i]}${toSup(exps[i])}`);
  }
  return parts.join("\u00B7") || "1\u2070";
}

// ═══════════════════════════════════════════════════════════════
// Interval naming
// ═══════════════════════════════════════════════════════════════

const INTERVAL_NAMES: Record<string, string> = {
  "1/1": "Unison", "2/1": "Octave",
  "256/243": "Pyth. m2", "16/15": "JI m2", "15/14": "Sept. m2",
  "9/8": "Pyth. M2", "10/9": "JI m2", "8/7": "Sept. M2",
  "7/6": "Sept. m3", "32/27": "Pyth. m3", "6/5": "JI m3",
  "5/4": "JI M3", "81/64": "Pyth. M3", "9/7": "Sept. M3",
  "4/3": "P4", "11/8": "Undec. tritone", "7/5": "Sept. tritone",
  "10/7": "Sept. tritone", "729/512": "Pyth. tritone",
  "3/2": "P5", "128/81": "Pyth. m6", "8/5": "JI m6",
  "5/3": "JI M6", "27/16": "Pyth. M6", "12/7": "Sept. M6",
  "7/4": "Harmonic 7th", "16/9": "Pyth. m7", "9/5": "JI m7",
  "15/8": "JI M7", "243/128": "Pyth. M7",
  // 11-limit
  "12/11": "Undec. m2", "11/10": "Undec. n2", "11/9": "Undec. n3",
  "14/11": "Undec. 3rd", "11/7": "Undec. 6th", "18/11": "Undec. 6th",
  "20/11": "Undec. 7th", "11/6": "Undec. 7th",
  // 13-limit
  "14/13": "Tridec. 2nd", "13/12": "Tridec. 2nd",
  // Commas
  "81/80": "Syntonic comma", "64/63": "Septimal comma",
  "33/32": "Undecimal comma", "128/125": "Diesis",
  "225/224": "Septimal kleisma",
};

export function intervalName(n: number, d: number): string {
  const key = `${n}/${d}`;
  return INTERVAL_NAMES[key] ?? XEN_INTERVAL_MAP.get(key)?.name ?? key;
}

/** Get all known names for a ratio (local short names + xen database). */
export function intervalAllNames(n: number, d: number): string[] {
  const key = `${n}/${d}`;
  const local = INTERVAL_NAMES[key];
  const xenNames = xenIntervalNames(n, d);
  // If xen only returned the ratio fallback, there are no known names
  if (xenNames.length === 1 && xenNames[0] === key) {
    return local ? [local] : [key];
  }
  // Prepend local short name if different from first xen name
  if (local && local !== xenNames[0]) {
    return [local, ...xenNames];
  }
  return xenNames;
}

// ═══════════════════════════════════════════════════════════════
// Note name from ratio + root
// ═══════════════════════════════════════════════════════════════

const NOTE_NAMES_SHARP = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"] as const;
const NOTE_NAMES_FLAT  = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"] as const;

export const ROOT_NOTE_OPTIONS = [
  "C", "C♯/D♭", "D", "D♯/E♭", "E", "F", "F♯/G♭", "G", "G♯/A♭", "A", "A♯/B♭", "B",
] as const;

/** Circle-of-fifths position for a ratio n/d, summing across all prime factors.
 *  Each prime's exponent is weighted by its 12-equal fifths mapping.
 *  Positive → sharp side, negative → flat side. */
function fifthsPosition(n: number, d: number): number {
  const PRIMES = [3, 5, 7, 11, 13, 17, 19, 23, 29, 31];
  let pos = 0;
  for (const p of PRIMES) {
    let exp = 0;
    while (n % p === 0) { n /= p; exp++; }
    while (d % p === 0) { d /= p; exp--; }
    if (exp !== 0) {
      const semi = Math.round(1200 * Math.log2(p) / 100) % 12;
      const f = (semi * 7) % 12;
      pos += exp * (f > 6 ? f - 12 : f);
    }
  }
  return pos;
}

/** Given a ratio n/d and a root note (0–11, C=0), return the closest note name.
 *  Sharp/flat determined by circle-of-fifths position across all prime factors. */
export function ratioToNoteName(n: number, d: number, rootPc: number = 0): string {
  const cents = 1200 * Math.log2(n / d);
  const semitones = Math.round(cents / 100);
  const pc = ((rootPc + semitones) % 12 + 12) % 12;
  const deviation = cents - semitones * 100;
  const useFlat = fifthsPosition(n, d) < 0;
  const name = useFlat ? NOTE_NAMES_FLAT[pc] : NOTE_NAMES_SHARP[pc];
  if (Math.abs(deviation) > 5) {
    const sign = deviation > 0 ? "+" : "";
    return `${name} ${sign}${deviation.toFixed(3)}¢`;
  }
  return name;
}

/** Frequency for a root note pitch class (C4=261.63) */
export function rootPcToFreq(rootPc: number): number {
  return 261.63 * Math.pow(2, rootPc / 12);
}

// ═══════════════════════════════════════════════════════════════
// Tempered pitch computation
// ═══════════════════════════════════════════════════════════════

/**
 * Compute tempered pitch in cents above 1/1 for a monzo.
 *
 * ϕ(P·exps) = Σ (P·exps)[i] · log₂(primes[i]) · 1200
 *
 * Comma-equivalent nodes produce the same tempered cents value,
 * which is the core audible consequence of tempering.
 */
export function temperedCents(
  exps: number[],
  primes: number[],
  commas: CommaSpec[],
  octaveEq: boolean,
  method: TuningMethod = "TE",
): number {
  // When octave-equivalent, stored monzos have prime-2 exponent = 0.
  // Reconstruct the full monzo (including prime-2) so the Tenney-weighted
  // projection works correctly — e.g. 5/4 = 2^-2·5^1, not just 5^1.
  const fullExps = [...exps];
  const p2idx = primes.indexOf(2);
  if (octaveEq && p2idx >= 0) {
    let log2ratio = 0;
    for (let i = 0; i < primes.length; i++) {
      if (i === p2idx) continue;
      log2ratio += fullExps[i] * Math.log2(primes[i]);
    }
    fullExps[p2idx] = -Math.floor(log2ratio + 1e-9);
  }

  if (commas.length === 0) {
    // Pure JI cents
    let cents = 0;
    for (let i = 0; i < primes.length; i++) {
      cents += fullExps[i] * Math.log2(primes[i]) * 1200;
    }
    return octaveEq ? ((cents % 1200) + 1200) % 1200 : cents;
  }

  // Always use full comma monzos (including prime-2 exponent) so the
  // Tenney projection correctly handles octave contributions.
  const commaMonzos = commas.map(c => factorize(c.n, c.d, primes, false));

  function computeCents(tempered: number[]): number {
    let c = 0;
    for (let i = 0; i < primes.length; i++) c += tempered[i] * Math.log2(primes[i]) * 1200;
    return c;
  }

  let rawCents: number;

  switch (method) {
    case "Euclidean": {
      const P = commaProjectionMatrix(commaMonzos, primes.length);
      rawCents = computeCents(projectMonzo(fullExps, P));
      break;
    }

    case "POTE": {
      const tenneyWeights = primes.map(p => Math.log2(p));
      const P = commaProjectionMatrix(commaMonzos, primes.length, tenneyWeights);
      const tempered = projectMonzo(fullExps, P);
      const octaveMonzo = primes.map((p) => p === 2 ? 1 : 0);
      const octaveCents = computeCents(projectMonzo(octaveMonzo, P));
      const scale = octaveCents > 0 ? 1200 / octaveCents : 1;
      rawCents = computeCents(tempered) * scale;
      break;
    }

    case "TOP": {
      const n = primes.length;
      let weights = primes.map(p => Math.log2(p));
      let P = commaProjectionMatrix(commaMonzos, n, weights);
      let tempered = projectMonzo(fullExps, P);

      for (let iter = 0; iter < 20; iter++) {
        const residuals = primes.map((p, i) => {
          const jiVal = fullExps[i] * Math.log2(p) * 1200;
          const teVal = tempered[i] * Math.log2(p) * 1200;
          return Math.abs(jiVal - teVal) / (Math.log2(p) * 1200);
        });
        const maxR = Math.max(...residuals, 1e-15);
        weights = primes.map((p, i) => {
          const r = Math.max(residuals[i] / maxR, 0.01);
          return Math.log2(p) / Math.sqrt(r);
        });
        P = commaProjectionMatrix(commaMonzos, n, weights);
        tempered = projectMonzo(fullExps, P);
      }

      rawCents = computeCents(tempered);
      break;
    }

    case "CTE": {
      const n = primes.length;
      const tenneyWeights = primes.map(p => Math.log2(p));
      const P = commaProjectionMatrix(commaMonzos, n, tenneyWeights);
      const tempered = projectMonzo(fullExps, P);

      const p2 = primes.indexOf(2);
      if (p2 >= 0) {
        const octaveMonzo = primes.map((_p, idx) => idx === 0 ? 1 : 0);
        const octaveCents = computeCents(projectMonzo(octaveMonzo, P));
        if (octaveCents > 0) {
          const octaveError = (1200 - octaveCents) / (Math.log2(primes[p2]) * 1200);
          tempered[p2] += octaveError * (fullExps[p2] || 1);
        }
      }

      rawCents = computeCents(tempered);
      break;
    }

    case "TE":
    default: {
      const tenneyWeights = primes.map(p => Math.log2(p));
      const P = commaProjectionMatrix(commaMonzos, primes.length, tenneyWeights);
      rawCents = computeCents(projectMonzo(fullExps, P));
      break;
    }
  }

  // Octave-normalize to [0, 1200) when octave-equivalent
  return octaveEq ? ((rawCents % 1200) + 1200) % 1200 : rawCents;
}

/**
 * Compute tempered frequency ratio for a monzo.
 * Returns the ratio as a number (e.g. 1.5 for a tempered fifth).
 */
export function temperedRatio(
  exps: number[],
  primes: number[],
  commas: CommaSpec[],
  octaveEq: boolean,
  method: TuningMethod = "TE",
): number {
  const cents = temperedCents(exps, primes, commas, octaveEq, method);
  return Math.pow(2, cents / 1200);
}

// ═══════════════════════════════════════════════════════════════
// Comma tempering — Union-Find for equivalence classes
// ═══════════════════════════════════════════════════════════════

/** Given nodes and commas, compute equivalence classes.
 *  Two nodes are equivalent if their exponent difference lies in the
 *  sublattice generated by all comma vectors (any integer linear combination). */
/**
 * Compute the Smith Normal Form of an integer matrix.
 * Returns { S, U, V } where U * A * V = S (diagonal).
 * We only need S for quotient-group class assignment.
 */
function smithNormalForm(matrix: number[][]): { S: number[][]; U: number[][]; V: number[][] } {
  const m = matrix.length;
  if (m === 0) return { S: [], U: [], V: [] };
  const n = matrix[0].length;
  // Deep copy
  const S = matrix.map(r => [...r]);
  // Identity matrices
  const U = Array.from({ length: m }, (_, i) => {
    const row = new Array(m).fill(0); row[i] = 1; return row;
  });
  const V = Array.from({ length: n }, (_, i) => {
    const row = new Array(n).fill(0); row[i] = 1; return row;
  });

  const pivots = Math.min(m, n);
  for (let k = 0; k < pivots; k++) {
    // Find smallest nonzero entry in submatrix S[k:][k:]
    let found = true;
    for (let iter = 0; iter < 200; iter++) {
      // Find pivot: smallest abs nonzero in submatrix
      let minVal = Infinity, pi = -1, pj = -1;
      for (let i = k; i < m; i++) {
        for (let j = k; j < n; j++) {
          const v = Math.abs(S[i][j]);
          if (v > 0 && v < minVal) { minVal = v; pi = i; pj = j; }
        }
      }
      if (pi === -1) { found = false; break; } // all zeros

      // Swap pivot to (k,k)
      if (pi !== k) {
        [S[k], S[pi]] = [S[pi], S[k]];
        [U[k], U[pi]] = [U[pi], U[k]];
      }
      if (pj !== k) {
        for (let i = 0; i < m; i++) [S[i][k], S[i][pj]] = [S[i][pj], S[i][k]];
        for (let i = 0; i < n; i++) [V[i][k], V[i][pj]] = [V[i][pj], V[i][k]];
      }

      // Eliminate column k below pivot
      let changed = false;
      for (let i = k + 1; i < m; i++) {
        if (S[i][k] !== 0) {
          const q = Math.floor(S[i][k] / S[k][k]);
          for (let j = 0; j < n; j++) S[i][j] -= q * S[k][j];
          for (let j = 0; j < m; j++) U[i][j] -= q * U[k][j];
          if (S[i][k] !== 0) changed = true;
        }
      }
      // Eliminate row k right of pivot
      for (let j = k + 1; j < n; j++) {
        if (S[k][j] !== 0) {
          const q = Math.floor(S[k][j] / S[k][k]);
          for (let i = 0; i < m; i++) S[i][j] -= q * S[i][k];
          for (let i = 0; i < n; i++) V[i][j] -= q * V[i][k];
          if (S[k][j] !== 0) changed = true;
        }
      }
      if (!changed) break;
    }
    if (!found) break;
    // Make pivot positive
    if (S[k][k] < 0) {
      for (let j = 0; j < n; j++) S[k][j] = -S[k][j];
      for (let j = 0; j < m; j++) U[k][j] = -U[k][j];
    }
  }
  return { S, U, V };
}

/**
 * Compute EDO equivalence classes using the patent val (prime→step mapping).
 * For each prime p, val(p) = round(edo × log₂(p)).
 * Class of monzo [a,b,c,...] = (Σ val[i]·exps[i]) mod edo.
 * Always gives exactly `edo` classes regardless of how many commas are active.
 */
function computeEdoClasses(
  nodes: Map<string, Monzo>,
  edo: number,
  primes: number[],
  octaveEq: boolean,
): Map<string, number> {
  const val = primes.map(p => {
    if (p === 2 && octaveEq) return 0;
    return Math.round(edo * Math.log2(p));
  });

  const classMap = new Map<string, number>();
  for (const [key, monzo] of nodes) {
    let step = 0;
    for (let i = 0; i < primes.length; i++) {
      step += val[i] * monzo.exps[i];
    }
    step = ((step % edo) + edo) % edo;
    classMap.set(key, step);
  }
  return classMap;
}

/**
 * Compute tempering equivalence classes using quotient group structure.
 * Two nodes are equivalent if their exponent difference lies in the
 * sublattice generated by the comma vectors (any integer linear combination).
 * This correctly handles multiple commas producing e.g. 12-equal from
 * syntonic comma + diesis in 5-limit.
 */
function computeTemperingClasses(
  nodes: Map<string, Monzo>,
  commas: CommaSpec[],
  primes: number[],
  octaveEq: boolean,
): Map<string, number> {
  const commaMonzos = commas.map(c => factorize(c.n, c.d, primes, octaveEq));
  const dim = primes.length;

  if (commaMonzos.length === 0) return new Map();

  // Build comma matrix (each row = one comma's exponent vector)
  // Use Smith Normal Form to find the quotient group Z^n / comma_lattice
  const { S, V } = smithNormalForm(commaMonzos);

  // The invariant factors are the diagonal entries of S.
  // S is k×n (commas × dimensions). Invariant factor i applies to column i.
  const invariants: number[] = [];
  for (let i = 0; i < Math.min(S.length, dim); i++) {
    invariants.push(i < S.length && i < S[i].length ? Math.abs(S[i][i]) : 0);
  }

  // To classify a node, project into the V-basis: compute exps * V (row-vector
  // times V, equivalently V^T * exps as column). Then reduce each coordinate j
  // modulo invariant factor d_j:
  //   d_j > 1 → coord mod d_j  (partially collapsed)
  //   d_j = 1 → coord = 0      (fully collapsed)
  //   d_j = 0 or j ≥ commaCount → keep as-is (free direction)
  const classMap = new Map<string, number>();
  const classIds = new Map<string, number>();
  let nextId = 0;

  for (const [key, monzo] of nodes) {
    const projected: number[] = [];
    for (let j = 0; j < dim; j++) {
      let coord = 0;
      for (let i = 0; i < dim; i++) {
        coord += monzo.exps[i] * V[i][j];
      }
      const inv = j < invariants.length ? invariants[j] : 0;
      if (inv > 1) {
        coord = ((coord % inv) + inv) % inv;
      } else if (inv === 1) {
        coord = 0; // fully collapsed
      }
      projected.push(coord);
    }
    const classKey = projected.join(",");
    if (!classIds.has(classKey)) classIds.set(classKey, nextId++);
    classMap.set(key, classIds.get(classKey)!);
  }

  return classMap;
}

// ═══════════════════════════════════════════════════════════════
// Main lattice builder
// ═══════════════════════════════════════════════════════════════

export interface BuiltLattice {
  nodes: LatticeNode[];
  edges: LatticeEdge[];
  /** Map from node key to 3D position (tempered if commas active) */
  positions: Map<string, [number, number, number]>;
  /** Map from node key to untempered JI position (same as positions when no tempering) */
  jiPositions: Map<string, [number, number, number]>;
  /** Map from node key to coset-clustered position: equivalent nodes are offset
   *  around their shared tempered center so they form visible groups instead of
   *  collapsing to a single point. This is the correct geometric picture of the
   *  quotient Z^n / <commas>: each cluster = one equivalence class = one pitch. */
  cosetPositions: Map<string, [number, number, number]>;
  /** Number of distinct tempering equivalence classes (0 if no tempering) */
  temperingClasses: number;
  /** Map from node key to equivalence class ID */
  classMap: Map<string, number>;
  /** Active primes in this lattice */
  primes: number[];
  /** The config used to build this */
  config: LatticeConfig;
  /** Comma vectors in 3D space (for kernel direction visualization) */
  commaDirections: Array<{ name: string; dir: [number, number, number] }>;
  /** Fundamental domain vertices (parallelogram in 3D enclosing one rep per class) */
  fundamentalDomain: [number, number, number][] | null;
}

export function buildLattice(config: LatticeConfig): BuiltLattice {
  const { primes, bounds, octaveEquivalence, temperedCommas, gridType } = config;
  // When gridType is set, it determines the projection vectors;
  // otherwise fall back to config.projections (legacy / custom).
  const projections = gridType ? getProjections(gridType) : config.projections;

  // 1) Generate all monzo points within bounds
  const monzoMap = new Map<string, Monzo>();
  const axisCount = primes.length;

  // Safety: cap total node count to prevent browser crashes with large bounds
  const MAX_NODES = 500;

  // Recursive enumeration of all exponent combinations within bounds
  function enumerate(depth: number, currentExps: number[]): void {
    if (monzoMap.size >= MAX_NODES) return;
    if (depth === axisCount) {
      const exps = [...currentExps];
      const [n, d] = monzoToRatio(exps, primes, octaveEquivalence);
      const key = `${n}/${d}`;
      // Deduplicate (octave equivalence can cause collisions)
      if (!monzoMap.has(key)) {
        monzoMap.set(key, { n, d, exps, isComma: undefined });
      }
      return;
    }
    const p = primes[depth];
    if (p === 2 && octaveEquivalence) {
      // Skip prime 2 axis if octave-equivalent
      currentExps[depth] = 0;
      enumerate(depth + 1, currentExps);
      return;
    }
    const [lo, hi] = bounds[p] ?? [-1, 1];
    for (let e = lo; e <= hi; e++) {
      currentExps[depth] = e;
      enumerate(depth + 1, currentExps);
    }
  }

  enumerate(0, new Array(axisCount).fill(0));

  // 2) Mark comma nodes
  for (const comma of temperedCommas) {
    const key = `${comma.n}/${comma.d}`;
    if (monzoMap.has(key)) {
      monzoMap.get(key)!.isComma = true;
    }
  }

  // 3) Compute tempering equivalence classes.
  //    Two independent sources can drive class assignment:
  //      - `config.edo` alone: each lattice cell gets its EDO step
  //        as its class, but the geometry stays at full JI rank.
  //        Tonescape-style: the spatial structure (chains of fifths,
  //        third-stacks, etc.) stays visible; only the colouring
  //        reflects the EDO collapse, so the user can see which
  //        cells the temperament identifies without losing the
  //        spatial information that makes the temperament legible.
  //      - `temperedCommas`: the lattice geometry is also projected
  //        onto the comma kernel's orthogonal complement, so cells
  //        that differ by a tempered comma physically coincide in
  //        3D.  Use this when you want to see the literal collapsed
  //        manifold (e.g. a 1D meantone chain).
  let classMap = new Map<string, number>();
  let temperingClasses = 0;
  if (temperedCommas.length > 0) {
    if (config.edo) {
      classMap = computeEdoClasses(monzoMap, config.edo, primes, octaveEquivalence);
    } else {
      classMap = computeTemperingClasses(monzoMap, temperedCommas, primes, octaveEquivalence);
    }
    temperingClasses = new Set(classMap.values()).size;
  } else if (config.edo) {
    classMap = computeEdoClasses(monzoMap, config.edo, primes, octaveEquivalence);
    temperingClasses = new Set(classMap.values()).size;
  }

  // 4) Compute 3D positions via orthogonal projection
  //
  // Tempering = projection onto V⊥ where V = span(comma vectors).
  // We compute P = I − Cᵀ(CCᵀ)⁻¹C in prime-exponent space, project
  // each monzo, THEN map the tempered exponents to 3D. This guarantees
  // that monzos differing by a comma land on the exact same 3D point.
  const positions = new Map<string, [number, number, number]>();
  const jiPositions = new Map<string, [number, number, number]>();

  // Always compute untempered JI positions.  Per-grid-type projection:
  //   "helical"  — Tonescape pitch-helix (one full turn per octave)
  //   "toroidal" — Tonescape 3,5-primespace torus, where the chain
  //                of fifths and the chain of thirds both wrap
  //                according to the EDO's val
  //   default    — linear sum of per-prime direction vectors
  const useHelical = config.gridType === "helical";
  const useToroidal = config.gridType === "toroidal";
  for (const [key, monzo] of monzoMap) {
    jiPositions.set(
      key,
      useToroidal
        ? monzoTo3DToroidal(monzo.exps, primes, config.edo ?? null)
        : useHelical
          ? monzoTo3DHelical(monzo.exps, primes, config.edo ?? null)
          : monzoTo3D(monzo.exps, primes, projections),
    );
  }

  // Comma directions in 3D (for kernel visualization)
  const commaDirections: Array<{ name: string; dir: [number, number, number] }> = [];
  // Fundamental domain vertices
  let fundamentalDomain: [number, number, number][] | null = null;

  if (temperedCommas.length > 0) {
    const commaMonzos = temperedCommas.map(c => factorize(c.n, c.d, primes, octaveEquivalence));
    const P = commaProjectionMatrix(commaMonzos, axisCount);

    for (const [key, monzo] of monzoMap) {
      const tempered = projectMonzo(monzo.exps, P);
      positions.set(key, monzoTo3D(tempered, primes, projections));
    }

    // 4a) PCA redistribution: tempering collapses comma dimensions, so the
    //     3D positions often lie on a plane or line. This makes orbit controls
    //     feel stuck because most rotation angles show the structure edge-on.
    //     We apply PCA to align the principal variance axes with x/y/z so the
    //     lattice fills 3D space and orbiting works naturally.
    redistributeAxesPCA(positions);

    // 4a-ii) Compute comma directions in 3D for kernel visualization.
    //        Each comma vector maps to a 3D direction showing which lattice
    //        direction gets collapsed to zero by tempering.
    for (let ci = 0; ci < temperedCommas.length; ci++) {
      const dir = monzoTo3D(commaMonzos[ci], primes, projections);
      const len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
      if (len > 0.01) {
        commaDirections.push({
          name: temperedCommas[ci].name,
          dir: [dir[0] / len, dir[1] / len, dir[2] / len],
        });
      }
    }

    // 4a-iii) Compute fundamental domain — the parallelogram/parallelepiped
    //         spanned by the generator vectors (complement of comma space).
    //         For a 2D lattice with 1 comma: it's a line segment (the generator).
    //         For a 2D lattice with 2 commas (full EDO): it's a single point (origin).
    //         For a 3D lattice with 1 comma: it's a parallelogram.
    //         We find the generator directions by taking basis vectors NOT in comma space.
    const activePrimes = primes.filter(p => !(p === 2 && octaveEquivalence));
    const freeDim = activePrimes.length - commaMonzos.filter(v => v.some(x => x !== 0)).length;
    if (freeDim >= 1 && freeDim <= 2) {
      // Find generator basis: standard basis vectors projected onto V⊥
      const generators: [number, number, number][] = [];
      for (let i = 0; i < axisCount; i++) {
        const e = new Array(axisCount).fill(0); e[i] = 1;
        const proj = projectMonzo(e, P);
        const pos3 = monzoTo3D(proj, primes, projections);
        const len = Math.sqrt(pos3[0] ** 2 + pos3[1] ** 2 + pos3[2] ** 2);
        if (len > 0.05) generators.push(pos3);
      }
      if (generators.length >= freeDim) {
        // Take the freeDim most linearly independent generators
        const picked = [generators[0]];
        if (freeDim >= 2 && generators.length >= 2) {
          // Pick the one most perpendicular to the first
          let bestCross = 0, bestIdx = 1;
          for (let i = 1; i < generators.length; i++) {
            const cx = picked[0][1] * generators[i][2] - picked[0][2] * generators[i][1];
            const cy = picked[0][2] * generators[i][0] - picked[0][0] * generators[i][2];
            const cz = picked[0][0] * generators[i][1] - picked[0][1] * generators[i][0];
            const cross = Math.sqrt(cx * cx + cy * cy + cz * cz);
            if (cross > bestCross) { bestCross = cross; bestIdx = i; }
          }
          picked.push(generators[bestIdx]);
        }
        // Build parallelogram/parallelepiped vertices from origin
        if (picked.length === 1) {
          fundamentalDomain = [[0, 0, 0], picked[0]];
        } else if (picked.length === 2) {
          const [a, b] = picked;
          fundamentalDomain = [
            [0, 0, 0],
            a,
            [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
            b,
          ];
        }
      }
    }
  } else {
    for (const [key, pos] of jiPositions) {
      positions.set(key, [...pos]);
    }
  }

  // 4b) Scale positions so nodes spread apart as the lattice grows.
  //     Base spacing is tuned for ~50 nodes. For larger lattices, scale up
  //     proportionally to the cube root of the node count so 3D density
  //     stays roughly constant.
  const nodeCount = monzoMap.size;
  const BASE_COUNT = 50;
  if (nodeCount > BASE_COUNT) {
    const scale = Math.cbrt(nodeCount / BASE_COUNT);
    for (const [key, pos] of positions) {
      positions.set(key, [pos[0] * scale, pos[1] * scale, pos[2] * scale]);
    }
    for (const [key, pos] of jiPositions) {
      jiPositions.set(key, [pos[0] * scale, pos[1] * scale, pos[2] * scale]);
    }
    // Scale fundamental domain too
    if (fundamentalDomain) {
      fundamentalDomain = fundamentalDomain.map(v => [v[0] * scale, v[1] * scale, v[2] * scale] as [number, number, number]);
    }
  }

  // 4c) Compute coset-clustered positions: equivalent nodes are offset around
  //     their shared tempered center point. This visualizes the quotient group
  //     correctly — each visible cluster IS one equivalence class (one pitch in
  //     the tempered system). Without this, all equivalent nodes pile on the
  //     same 3D point and look like "collapse to one node."
  const cosetPositions = new Map<string, [number, number, number]>();
  if (temperedCommas.length > 0 && classMap.size > 0) {
    // Group nodes by equivalence class
    const classMembers = new Map<number, string[]>();
    for (const [key, classId] of classMap) {
      if (!classMembers.has(classId)) classMembers.set(classId, []);
      classMembers.get(classId)!.push(key);
    }
    // Sort within each class by simplicity (smallest n+d first = representative)
    for (const [, members] of classMembers) {
      members.sort((a, b) => {
        const [an, ad] = a.split("/").map(Number);
        const [bn, bd] = b.split("/").map(Number);
        return (an + ad) - (bn + bd);
      });
    }

    // Compute average edge length in JI lattice for scaling the cluster radius
    let edgeLenSum = 0, edgeCount = 0;
    for (const [key, monzo] of monzoMap) {
      for (let k = 0; k < axisCount; k++) {
        const p = primes[k];
        if (p === 2 && octaveEquivalence) continue;
        const neighborExps = [...monzo.exps]; neighborExps[k] += 1;
        const [nn, nd] = monzoToRatio(neighborExps, primes, octaveEquivalence);
        const neighborKey = `${nn}/${nd}`;
        if (monzoMap.has(neighborKey)) {
          const pa = positions.get(key)!, pb = positions.get(neighborKey)!;
          if (pa && pb) {
            edgeLenSum += Math.sqrt((pa[0]-pb[0])**2 + (pa[1]-pb[1])**2 + (pa[2]-pb[2])**2);
            edgeCount++;
          }
        }
      }
    }
    const avgEdgeLen = edgeCount > 0 ? edgeLenSum / edgeCount : 1.5;
    // Cluster radius = fraction of average edge length
    const CLUSTER_RADIUS = avgEdgeLen * 0.35;

    for (const [classId, members] of classMembers) {
      if (members.length === 1) {
        // Single member — use tempered position as-is
        const p = positions.get(members[0]);
        cosetPositions.set(members[0], p ? [...p] : [0, 0, 0]);
        continue;
      }

      // Find center (tempered position — all should be nearly identical)
      const center: [number, number, number] = [0, 0, 0];
      for (const key of members) {
        const p = positions.get(key) ?? [0, 0, 0];
        center[0] += p[0]; center[1] += p[1]; center[2] += p[2];
      }
      center[0] /= members.length; center[1] /= members.length; center[2] /= members.length;

      // Place representative at center, others in a ring around it
      const n = members.length;
      for (let i = 0; i < n; i++) {
        if (i === 0) {
          // Representative: center
          cosetPositions.set(members[i], [...center]);
        } else {
          // Arrange others on a circle perpendicular to camera-ish direction
          // Use golden angle for even spacing in 3D
          const angle = ((i - 1) / (n - 1)) * Math.PI * 2;
          const phi = Math.acos(1 - 2 * (i / (n + 1)));  // spherical spread
          const r = CLUSTER_RADIUS * Math.min(1, 0.4 + 0.6 * (n > 4 ? 1 : n / 4));
          const dx = r * Math.sin(phi) * Math.cos(angle);
          const dy = r * Math.sin(phi) * Math.sin(angle);
          const dz = r * Math.cos(phi);
          cosetPositions.set(members[i], [center[0] + dx, center[1] + dy, center[2] + dz]);
        }
      }
    }

    // Handle any nodes not in a class
    for (const [key] of monzoMap) {
      if (!cosetPositions.has(key)) {
        cosetPositions.set(key, positions.get(key) ?? [0, 0, 0]);
      }
    }
  } else {
    // No tempering — coset positions = JI positions
    for (const [key, pos] of positions) {
      cosetPositions.set(key, [...pos]);
    }
  }

  // 5) Build nodes array
  const nodes: LatticeNode[] = [];
  for (const [key, monzo] of monzoMap) {
    nodes.push({
      monzo,
      key,
      pos3d: positions.get(key)!,
      temperedClass: classMap.get(key),
    });
  }

  // 6) Build edges — generator edges (differ by ±1 in exactly one prime exponent)
  //    O(n × primes) neighbor lookup instead of O(n²) pair comparison
  const edges: LatticeEdge[] = [];
  const edgeSeen = new Set<string>();

  for (const [key, monzo] of monzoMap) {
    for (let k = 0; k < axisCount; k++) {
      const p = primes[k];
      if (p === 2 && octaveEquivalence) continue;
      // Only check +1 direction; the reverse is found from the neighbor
      const neighborExps = [...monzo.exps];
      neighborExps[k] += 1;
      const [nn, nd] = monzoToRatio(neighborExps, primes, octaveEquivalence);
      const neighborKey = `${nn}/${nd}`;
      if (neighborKey !== key && monzoMap.has(neighborKey)) {
        const edgeId = key < neighborKey ? `${key}|${neighborKey}|${p}` : `${neighborKey}|${key}|${p}`;
        if (!edgeSeen.has(edgeId)) {
          edgeSeen.add(edgeId);
          edges.push({ from: key, to: neighborKey, prime: p, type: "generator" });
        }
      }
    }
  }

  // 7) Add tempered edges (connecting nodes in same equivalence class)
  if (temperedCommas.length > 0) {
    const classMembers = new Map<number, string[]>();
    for (const [key, classId] of classMap) {
      if (!classMembers.has(classId)) classMembers.set(classId, []);
      classMembers.get(classId)!.push(key);
    }
    for (const [, members] of classMembers) {
      if (members.length < 2) continue;
      // For large classes, connect to representative only (star topology)
      // to avoid O(n²) edge explosion
      if (members.length > 8) {
        for (let i = 1; i < members.length; i++) {
          edges.push({ from: members[0], to: members[i], prime: 0, type: "tempered" });
        }
      } else {
        for (let i = 0; i < members.length; i++) {
          for (let j = i + 1; j < members.length; j++) {
            edges.push({ from: members[i], to: members[j], prime: 0, type: "tempered" });
          }
        }
      }
    }
  }

  return { nodes, edges, positions, jiPositions, cosetPositions, temperingClasses, classMap, primes, config, commaDirections, fundamentalDomain };
}

/**
 * Compute ring layout positions for EDO visualization.
 * Each equivalence class sits at a unique position on a circle.
 * Within a class, nodes are offset vertically so they remain distinguishable.
 * Returns a new positions map suitable for animation targets.
 */
export function computeEdoRingPositions(
  lattice: BuiltLattice,
  edo: number,
): Map<string, [number, number, number]> {
  const ring = new Map<string, [number, number, number]>();
  const R = Math.max(3, edo * 0.35); // ring radius scales with EDO size

  // Group nodes by class
  const classMembers = new Map<number, string[]>();
  for (const [key, classId] of lattice.classMap) {
    if (!classMembers.has(classId)) classMembers.set(classId, []);
    classMembers.get(classId)!.push(key);
  }

  // Sort members within each class by simplicity (n+d)
  for (const [, members] of classMembers) {
    members.sort((a, b) => {
      const [an, ad] = a.split("/").map(Number);
      const [bn, bd] = b.split("/").map(Number);
      return (an + ad) - (bn + bd);
    });
  }

  for (const [classId, members] of classMembers) {
    // Place class at angle step/edo around the circle (like a clock)
    const angle = (2 * Math.PI * classId) / edo - Math.PI / 2;
    const cx = R * Math.cos(angle);
    const cz = R * Math.sin(angle);

    // Representative (first/simplest) at y=0, others stacked vertically
    const spacing = 0.5;
    members.forEach((key, i) => {
      const y = i === 0 ? 0 : (i * spacing);
      ring.set(key, [cx, y, cz]);
    });
  }

  // Also handle nodes with no class (shouldn't happen if commas are active)
  for (const node of lattice.nodes) {
    if (!ring.has(node.key)) {
      ring.set(node.key, lattice.positions.get(node.key) ?? [0, 0, 0]);
    }
  }

  return ring;
}

// ═══════════════════════════════════════════════════════════════
// Lattice statistics / info
// ═══════════════════════════════════════════════════════════════

export function latticeInfo(lattice: BuiltLattice): {
  nodeCount: number;
  edgeCount: number;
  dimension: number;
  primeLimit: number;
  isTempered: boolean;
  temperedCommaNames: string[];
} {
  return {
    nodeCount: lattice.nodes.length,
    edgeCount: lattice.edges.length,
    dimension: lattice.primes.filter(p => !(p === 2 && lattice.config.octaveEquivalence)).length,
    primeLimit: Math.max(...lattice.primes),
    isTempered: lattice.config.temperedCommas.length > 0,
    temperedCommaNames: lattice.config.temperedCommas.map(c => c.name),
  };
}

// ═══════════════════════════════════════════════════════════════
// Topology detection and surface mesh for tempered lattices
// ═══════════════════════════════════════════════════════════════

/**
 * Topology type after tempering, derived from the quotient group
 * Z^n / <comma lattice> via Smith Normal Form:
 *
 * - "plane"    — no tempering, infinite flat lattice (all free dims)
 * - "cylinder" — 1 cyclic + ≥1 free dimension
 * - "torus"    — ≥2 cyclic + 0 free dimensions
 * - "spiral"   — 0 cyclic, ≥1 free (commas fully collapse their dirs)
 * - "closed"   — 0 free, 0–1 cyclic (finite group — EDO or point)
 */
export type TopologyType = "plane" | "cylinder" | "torus" | "spiral" | "closed";

export interface TopologyInfo {
  type: TopologyType;
  /** Description for display */
  description: string;
  /** Number of independent commas tempered */
  commasTempered: number;
  /** Rank of the resulting temperament (free dimensions) */
  rank: number;
  /** Lattice dimension (number of active prime axes) */
  dimension: number;
  /** Invariant factors from SNF (quotient group structure) */
  invariantFactors: number[];
  /** Cyclic orders > 1 (loop sizes in the quotient) */
  cyclicOrders: number[];
  /** Best geometry for visualization */
  bestGeometry: "point" | "line" | "plane" | "circle" | "cylinder" | "torus" | "3d-lattice";
}

export function detectTopology(config: LatticeConfig): TopologyInfo {
  const activePrimes = config.primes.filter(p => !(p === 2 && config.octaveEquivalence));
  const dim = activePrimes.length;

  if (config.temperedCommas.length === 0) {
    return {
      type: "plane",
      description: `${dim}D lattice (untempered)`,
      commasTempered: 0, rank: dim, dimension: dim,
      invariantFactors: [], cyclicOrders: [],
      bestGeometry: dim <= 2 ? "plane" : "3d-lattice",
    };
  }

  // Factorize commas using only the active primes
  const commaMonzos = config.temperedCommas.map(c =>
    factorize(c.n, c.d, activePrimes, config.octaveEquivalence)
  );

  const { invariantFactors, cyclicOrders, freeDims, collapsedDims } =
    analyzeQuotientGroup(commaMonzos, dim);

  const nCyclic = cyclicOrders.length;
  const commaRank = collapsedDims + nCyclic;

  // Determine topology from quotient structure
  let type: TopologyType;
  let description: string;
  let bestGeometry: TopologyInfo["bestGeometry"];

  if (freeDims === 0 && nCyclic === 0) {
    // Everything collapsed to a point
    type = "closed";
    description = "Point — all dimensions fully collapsed";
    bestGeometry = "point";
  } else if (freeDims === 0 && nCyclic === 1) {
    // Single finite loop (e.g. EDO)
    type = "closed";
    description = `Closed loop of order ${cyclicOrders[0]} (EDO-like)`;
    bestGeometry = "circle";
  } else if (freeDims === 0 && nCyclic >= 2) {
    // Multiple loops → torus
    type = "torus";
    description = `Torus — cyclic orders ${cyclicOrders.join("×")}`;
    bestGeometry = "torus";
  } else if (freeDims >= 1 && nCyclic === 0) {
    // All commas fully collapse their direction, remaining are free
    type = freeDims === 1 ? "spiral" : "plane";
    description = freeDims === 1
      ? "Spiral — generator chain (rank-1 temperament)"
      : `${freeDims}D plane (rank-${freeDims} temperament)`;
    bestGeometry = freeDims === 1 ? "line" : freeDims === 2 ? "plane" : "3d-lattice";
  } else if (freeDims >= 1 && nCyclic >= 1) {
    // Mix of free and cyclic → cylinder-like
    type = "cylinder";
    description = `Cylinder — ${freeDims} free × cyclic(${cyclicOrders.join(",")})`;
    bestGeometry = "cylinder";
  } else {
    type = "spiral";
    description = `${commaRank} comma(s) tempered in ${dim}D`;
    bestGeometry = "3d-lattice";
  }

  return {
    type, description,
    commasTempered: commaRank,
    rank: freeDims,
    dimension: dim,
    invariantFactors, cyclicOrders,
    bestGeometry,
  };
}

/**
 * Generate a torus or cylinder wireframe mesh in 3D for visualization.
 * Used when tempering closes the lattice into a topological surface.
 *
 * Returns arrays of line segments (pairs of [x,y,z] points) for rendering.
 */
export interface TopoMeshData {
  /** Ring lines (circles around the torus/cylinder) */
  rings: Array<[number, number, number][]>;
  /** Longitudinal lines (along the tube) */
  tubes: Array<[number, number, number][]>;
  /** Center of the torus for camera positioning */
  center: [number, number, number];
  /** Approximate radius for camera framing */
  radius: number;
}

export function generateTorusMesh(
  majorRadius: number,
  minorRadius: number,
  ringSegments: number = 32,
  tubeSegments: number = 16,
  center: [number, number, number] = [0, 0, 0],
): TopoMeshData {
  const rings: Array<[number, number, number][]> = [];
  const tubes: Array<[number, number, number][]> = [];

  // Generate ring lines (circles around tube cross-section)
  for (let i = 0; i <= ringSegments; i++) {
    const theta = (i / ringSegments) * Math.PI * 2;
    const ring: [number, number, number][] = [];
    for (let j = 0; j <= tubeSegments; j++) {
      const phi = (j / tubeSegments) * Math.PI * 2;
      const x = (majorRadius + minorRadius * Math.cos(phi)) * Math.cos(theta) + center[0];
      const y = (majorRadius + minorRadius * Math.cos(phi)) * Math.sin(theta) + center[1];
      const z = minorRadius * Math.sin(phi) + center[2];
      ring.push([x, y, z]);
    }
    rings.push(ring);
  }

  // Generate tube lines (longitudinal)
  for (let j = 0; j <= tubeSegments; j++) {
    const phi = (j / tubeSegments) * Math.PI * 2;
    const tube: [number, number, number][] = [];
    for (let i = 0; i <= ringSegments; i++) {
      const theta = (i / ringSegments) * Math.PI * 2;
      const x = (majorRadius + minorRadius * Math.cos(phi)) * Math.cos(theta) + center[0];
      const y = (majorRadius + minorRadius * Math.cos(phi)) * Math.sin(theta) + center[1];
      const z = minorRadius * Math.sin(phi) + center[2];
      tube.push([x, y, z]);
    }
    tubes.push(tube);
  }

  return { rings, tubes, center, radius: majorRadius + minorRadius };
}

export function generateCylinderMesh(
  radius: number,
  height: number,
  segments: number = 32,
  rings: number = 8,
  center: [number, number, number] = [0, 0, 0],
): TopoMeshData {
  const ringLines: Array<[number, number, number][]> = [];
  const tubeLines: Array<[number, number, number][]> = [];

  // Ring lines (circles at different heights)
  for (let r = 0; r <= rings; r++) {
    const y = center[1] - height / 2 + (r / rings) * height;
    const ring: [number, number, number][] = [];
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      ring.push([
        center[0] + radius * Math.cos(theta),
        y,
        center[2] + radius * Math.sin(theta),
      ]);
    }
    ringLines.push(ring);
  }

  // Tube lines (vertical lines)
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const tube: [number, number, number][] = [];
    for (let r = 0; r <= rings; r++) {
      const y = center[1] - height / 2 + (r / rings) * height;
      tube.push([
        center[0] + radius * Math.cos(theta),
        y,
        center[2] + radius * Math.sin(theta),
      ]);
    }
    tubeLines.push(tube);
  }

  return { rings: ringLines, tubes: tubeLines, center, radius: Math.max(radius, height / 2) };
}

/**
 * Map lattice node positions onto a topological surface.
 * When tempering creates a torus/cylinder, nodes should sit ON the surface.
 *
 * Uses the Smith Normal Form quotient coordinates — NOT raw monzo exponents —
 * so that comma-equivalent nodes land at the same surface position.
 *
 * The SNF gives Z^n / <commas> ≅ Z/d₁Z × Z/d₂Z × ... × Z^free.
 * - Cyclic coords (dⱼ > 1) → mapped to angles: θ = 2π · (coord mod dⱼ) / dⱼ
 * - Free coords (dⱼ = 0)  → mapped to linear positions
 * - Collapsed coords (dⱼ = 1) → zeroed out
 */
export function projectNodesToTopoSurface(
  lattice: BuiltLattice,
  topology: TopologyInfo,
  majorRadius: number = 8,
  minorRadius: number = 3,
): Map<string, [number, number, number]> {
  const positions = new Map<string, [number, number, number]>();
  const config = lattice.config;
  const primes = config.primes;
  const octaveEq = config.octaveEquivalence;

  if (config.temperedCommas.length === 0 || (topology.type !== "torus" && topology.type !== "cylinder" && topology.type !== "closed")) {
    // No tempering or flat topology — use the projected positions
    for (const node of lattice.nodes) {
      positions.set(node.key, node.pos3d);
    }
    return positions;
  }

  // Compute quotient coordinates via SNF
  const commaMonzos = config.temperedCommas.map(c => factorize(c.n, c.d, primes, octaveEq));
  const { S, V } = smithNormalForm(commaMonzos);
  const dim = primes.length;

  // Extract invariant factors from diagonal of S
  const invariants: number[] = [];
  for (let i = 0; i < Math.min(S.length, dim); i++) {
    invariants.push(i < S[i].length ? Math.abs(S[i][i]) : 0);
  }

  // Classify each dimension: cyclic (d>1), collapsed (d=1), free (d=0 or beyond commas)
  const cyclicDims: { idx: number; order: number }[] = [];
  const freeDims: number[] = [];
  for (let j = 0; j < dim; j++) {
    const d = j < invariants.length ? invariants[j] : 0;
    if (d > 1) cyclicDims.push({ idx: j, order: d });
    else if (d === 0 || j >= S.length) freeDims.push(j);
    // d === 1 → collapsed, ignore
  }

  // Compute quotient coordinates for each node: q = exps · V
  // Then reduce cyclic coords mod order
  const nodeQuotients = new Map<string, number[]>();
  for (const node of lattice.nodes) {
    const q: number[] = [];
    for (let j = 0; j < dim; j++) {
      let coord = 0;
      for (let i = 0; i < dim; i++) {
        coord += node.monzo.exps[i] * V[i][j];
      }
      const d = j < invariants.length ? invariants[j] : 0;
      if (d === 1) coord = 0;
      else if (d > 1) coord = ((coord % d) + d) % d;
      q.push(coord);
    }
    nodeQuotients.set(node.key, q);
  }

  if (topology.type === "torus" && cyclicDims.length >= 2) {
    // Two cyclic directions → torus angles
    const c1 = cyclicDims[0];
    const c2 = cyclicDims[1];

    for (const node of lattice.nodes) {
      const q = nodeQuotients.get(node.key)!;
      const theta = (q[c1.idx] / c1.order) * Math.PI * 2;
      const phi = (q[c2.idx] / c2.order) * Math.PI * 2;

      // Extra free dimensions → vertical offset
      let yOffset = 0;
      for (const fi of freeDims) {
        yOffset += q[fi] * 1.5;
      }

      const x = (majorRadius + minorRadius * Math.cos(phi)) * Math.cos(theta);
      const y = (majorRadius + minorRadius * Math.cos(phi)) * Math.sin(theta) + yOffset;
      const z = minorRadius * Math.sin(phi);
      positions.set(node.key, [x, y, z]);
    }
  } else if (topology.type === "cylinder" && cyclicDims.length >= 1) {
    // One cyclic direction → circle, free directions → height
    const c1 = cyclicDims[0];
    const radius = majorRadius;

    for (const node of lattice.nodes) {
      const q = nodeQuotients.get(node.key)!;
      const theta = (q[c1.idx] / c1.order) * Math.PI * 2;

      // Free dimensions → vertical spread
      let yPos = 0;
      for (let fi = 0; fi < freeDims.length; fi++) {
        yPos += q[freeDims[fi]] * 2.0;
      }

      positions.set(node.key, [
        radius * Math.cos(theta),
        yPos,
        radius * Math.sin(theta),
      ]);
    }
  } else if (topology.type === "closed" && cyclicDims.length === 1) {
    // Single loop (EDO-like) → circle
    const c1 = cyclicDims[0];
    const radius = majorRadius;

    for (const node of lattice.nodes) {
      const q = nodeQuotients.get(node.key)!;
      const theta = (q[c1.idx] / c1.order) * Math.PI * 2;
      positions.set(node.key, [
        radius * Math.cos(theta),
        0,
        radius * Math.sin(theta),
      ]);
    }
  } else {
    // Fallback: use flat projected positions
    for (const node of lattice.nodes) {
      positions.set(node.key, node.pos3d);
    }
  }

  return positions;
}
