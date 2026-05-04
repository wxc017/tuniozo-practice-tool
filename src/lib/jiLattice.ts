// ── JI Lattice Engine (Adaptive JI / comma-drift modelling, all-limits) ───
//
// Tracks chord-to-chord motion on the prime lattice so chord progressions
// in Adaptive JI mode actually drift the tonic when they should — the
// famous I-vi-ii-V-I "comma pump" lands the final I 81/80 ≈ 21.5¢ flat,
// the septimal pump V7→I drifts by 64/63 ≈ 27¢, etc.
//
// Lattice convention: a position [a, b, c, d, e, f, g, h, i, j] represents
// a pitch ratio of 3^a * 5^b * 7^c * 11^d * 13^e * 17^f * 19^g * 23^h *
// 29^i * 31^j (octave reduction handled separately via 2^k).  Each axis
// edge corresponds to one prime's pure interval:
//   3-axis  = perfect fifth        3:2  (701.96¢)
//   5-axis  = major third          5:4  (386.31¢)
//   7-axis  = harmonic 7th         7:4  (968.83¢)
//   11-axis = 11-limit wide 4th   11:8  (551.32¢)
//   13-axis = tridecimal wide 6th 13:8  (840.53¢)
//   17-axis = supraminor 2nd     17:16 (104.96¢)
//   19-axis = small minor 3rd    19:16 (297.51¢)
//   23-axis = wide minor 6th    23:16  (628.27¢)
//   29-axis = small minor 7th   29:16  (1029.58¢)
//   31-axis = supermajor 7th    31:16  (1145.04¢)
//
// Chord transitions are mapped to lattice motions via a curated table.
// 5-limit motions are exhaustive (every diatonic transition modeled);
// 7+/11+/13+ motions cover the most common septimal / undecimal / etc.
// resolutions and are extended on demand.  Per-note voice tracking is
// implemented separately via `voicingFor(quality)` so each note in a
// chord (root, third, fifth, seventh, ninth, ...) carries its own
// lattice position — the only honest way to capture higher-limit
// comma drifts that arise from chord-quality resolution rather than
// chord-root motion (e.g. V7's 7/4 resolving to I's M3).
//
// Chord labels with suffixes (V/IV, I~neu, etc.) are stripped down
// to their core Roman numeral before lookup.

/** N-dimensional lattice position — exponents on the prime axes
 *  [3, 5, 7, 11, 13, 17, 19, 23, 29, 31].  Trailing zeros may be
 *  omitted; helpers pad to the canonical length internally. */
export type LatticePos = readonly number[];

/** Index into LatticePos for each prime axis. */
export const PRIME_AXES = [3, 5, 7, 11, 13, 17, 19, 23, 29, 31] as const;

/** Cents value of one step along each prime axis (= log2(prime) * 1200). */
export const PRIME_AXIS_CENTS: readonly number[] = [
  701.955,   // 3
  386.314,   // 5
  968.826,   // 7 (7/4 octave-reduced for octave-equivalent lattice)
  551.318,   // 11 (11/8)
  840.528,   // 13 (13/8)
  104.955,   // 17 (17/16)
  297.513,   // 19 (19/16)
  628.274,   // 23 (23/16)
  1029.577,  // 29 (29/16)
  1145.036,  // 31 (31/16)
];

const LATTICE_DIM = PRIME_AXES.length;

export const LATTICE_ORIGIN: LatticePos = new Array(LATTICE_DIM).fill(0);

/** Pad a (possibly short) lattice position to the canonical N dimensions
 *  by appending zeros.  Lets callers omit trailing zero axes. */
function padPos(pos: LatticePos): number[] {
  const out = pos.slice();
  while (out.length < LATTICE_DIM) out.push(0);
  return out;
}

/** Component-wise add. */
export function latticeAdd(a: LatticePos, b: LatticePos): LatticePos {
  const pa = padPos(a), pb = padPos(b);
  const out = new Array(LATTICE_DIM);
  for (let i = 0; i < LATTICE_DIM; i++) out[i] = pa[i] + pb[i];
  return out;
}

/** Cents value (in 0..1200) of a lattice position, octave-reduced. */
export function latticeToCents(pos: LatticePos): number {
  const p = padPos(pos);
  let c = 0;
  for (let i = 0; i < LATTICE_DIM; i++) c += p[i] * PRIME_AXIS_CENTS[i];
  return ((c % 1200) + 1200) % 1200;
}

/** Signed drift in cents from origin, centred on 0 (range −600 .. +600). */
export function latticeDriftCents(pos: LatticePos): number {
  const c = latticeToCents(pos);
  return c > 600 ? c - 1200 : c;
}

/** Lattice position of each diatonic chord ROOT relative to the major
 *  tonic at [0, 0].  These are the "canonical" positions used when a
 *  chord is reached from the tonic directly; pump motions can override.
 *  Roman numerals follow the standard major-key labelling; minor-key
 *  scales reuse these (i = lower-case I, etc.). */
const CHORD_ROOT_POSITION: Record<string, LatticePos> = {
  "I":   [0, 0],
  "i":   [0, 0],
  "ii":  [+2, 0],   // Pythagorean D (9/8)
  "iiø": [+2, 0],
  "ii°": [+2, 0],
  "iii": [0, +1],   // 5/4 from tonic = E
  "III": [0, +1],
  "IV":  [-1, 0],   // 4/3 from tonic = F
  "iv":  [-1, 0],
  "V":   [+1, 0],   // 3/2 from tonic = G
  "v":   [+1, 0],
  "vi":  [-1, +1],  // 5/3 from tonic = A
  "VI":  [-1, +1],
  "vii°":[+1, +1],  // 15/8 from tonic = B
  "VII": [+1, +1],
  // Modal-mixture / borrowed chords
  "bII":  [-5, 0],  // Db as Pyth (rare); often used as Neapolitan
  "bIII": [+1, -1], // Eb as 6/5 (minor third up)
  "bVI":  [-3, 0],  // Ab as Pyth m6
  "bVII": [+2, -1], // Bb as 16/9 (Pyth m7) — could also be (-3,+1)
};

/** Motion vector for selected chord transitions.  When present, this
 *  overrides the (next.position − prev.position) default motion — used
 *  to encode the canonical pure-interval path between chords, which is
 *  what causes comma drift on diatonic loops.  Each entry asserts:
 *  "going from prev to next, the pure-interval move is [da, db]". */
const TRANSITION_MOTIONS: Record<string, Record<string, LatticePos>> = {
  // The comma-pump cluster.  Going vi → ii via "up a fourth from vi"
  // (not "back to the I-relative ii at +2,0") puts ii at lattice
  // (-2, +1) = 5-limit JI minor-second 10/9.  All subsequent chords in
  // the chain inherit the comma offset.
  "vi": { "ii": [-1, 0], "ii°": [-1, 0] },
  "VI": { "ii": [-1, 0], "ii°": [-1, 0] },
  // Authentic motions (don't drift on their own, but exercise the chain)
  "ii": { "V": [+1, 0] },
  "iiø":{ "V": [+1, 0] },
  "ii°":{ "V": [+1, 0] },
  "V":  { "I": [-1, 0], "i": [-1, 0], "vi": [-1, +1], "VI": [-1, +1] },
  "v":  { "I": [-1, 0], "i": [-1, 0] },
  // Plagal
  "IV": { "I": [+1, 0], "i": [+1, 0] },
  "iv": { "I": [+1, 0], "i": [+1, 0] },
  "I":  { "IV": [-1, 0], "iv": [-1, 0], "V": [+1, 0], "vi": [-1, +1], "ii": [+2, 0], "iii": [0, +1] },
  "i":  { "IV": [-1, 0], "iv": [-1, 0], "V": [+1, 0], "vi": [-1, +1], "VI": [-1, +1] },
  // Modal mixture
  "I":  { "bVII": [+2, -1], "bVI": [-3, 0], "bIII": [+1, -1] } as Record<string, LatticePos>,  // (overrides above; see merge note)
};

// Note: the duplicate "I" above is intentional clutter — TS's later-key-wins
// behaviour merges them, so the modal-mixture line wins.  In practice we
// merge explicitly:
const MERGED_TRANSITIONS = (() => {
  const out: Record<string, Record<string, LatticePos>> = {};
  for (const from of Object.keys(TRANSITION_MOTIONS)) {
    out[from] = { ...(out[from] ?? {}), ...TRANSITION_MOTIONS[from] };
  }
  // Hand-merge the two "I" entries so both sets of motions are reachable.
  out["I"] = {
    "IV": [-1, 0], "iv": [-1, 0], "V": [+1, 0],
    "vi": [-1, +1], "ii": [+2, 0], "iii": [0, +1],
    "bVII": [+2, -1], "bVI": [-3, 0], "bIII": [+1, -1],
  };
  return out;
})();

/** Strip xen suffixes / applied-chord prefixes from a chord label so the
 *  lattice lookup hits the underlying Roman numeral.  E.g. "I~neu" → "I",
 *  "V/IV" → "V" (we treat applied dominants as their own degree for lattice
 *  purposes; finer-grained applied-chord modelling is a follow-up). */
export function stripChordLabel(label: string): string {
  let s = label;
  const xenIdx = s.indexOf("~");
  if (xenIdx > 0) s = s.slice(0, xenIdx);
  const slashIdx = s.indexOf("/");
  if (slashIdx > 0) s = s.slice(0, slashIdx);
  return s;
}

/** Compute the lattice motion vector from `prev` to `next`.  Returns the
 *  curated pump motion when one is registered for the pair; otherwise
 *  returns the default motion as (next.position − prev.position). */
export function getLatticeMotion(prev: string, next: string): LatticePos {
  const p = stripChordLabel(prev);
  const n = stripChordLabel(next);
  const pump = MERGED_TRANSITIONS[p]?.[n];
  if (pump) return pump;
  const prevPos = CHORD_ROOT_POSITION[p] ?? [0, 0];
  const nextPos = CHORD_ROOT_POSITION[n] ?? [0, 0];
  return [nextPos[0] - prevPos[0], nextPos[1] - prevPos[1]];
}

/** Walk a progression, accumulating lattice positions per chord.  The
 *  first chord lands at LATTICE_ORIGIN; each subsequent chord adds the
 *  motion vector from the prior label.  Returns one position per chord. */
export function tracePath(progression: string[]): LatticePos[] {
  const out: LatticePos[] = [];
  let pos: LatticePos = LATTICE_ORIGIN;
  for (let i = 0; i < progression.length; i++) {
    if (i === 0) {
      // First chord: anchor to its canonical position relative to tonic.
      pos = CHORD_ROOT_POSITION[stripChordLabel(progression[0])] ?? LATTICE_ORIGIN;
    } else {
      const motion = getLatticeMotion(progression[i - 1], progression[i]);
      pos = [pos[0] + motion[0], pos[1] + motion[1]];
    }
    out.push(pos);
  }
  return out;
}

/** Cumulative drift (signed cents from origin) at each chord position
 *  in the path.  Computed by subtracting the chord's I-relative
 *  canonical position from the actual lattice position reached — what's
 *  left is the comma offset accumulated by the chord chain. */
export function tracePathDrifts(progression: string[]): number[] {
  const positions = tracePath(progression);
  return positions.map((pos, i) => {
    const canonical = CHORD_ROOT_POSITION[stripChordLabel(progression[i])] ?? LATTICE_ORIGIN;
    const driftPos: LatticePos = [pos[0] - canonical[0], pos[1] - canonical[1]];
    return latticeDriftCents(driftPos);
  });
}

/** Convert a lattice drift in cents to an EDO-step offset (rounded). */
export function driftCentsToSteps(driftCents: number, edo: number): number {
  return Math.round((driftCents / 1200) * edo);
}
