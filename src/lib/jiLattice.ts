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

/** Canonical (non-drifted) lattice position for a chord — its tonal-
 *  center-relative position before any progression motion.  Returns
 *  the origin for any chord whose Roman numeral isn't in the chord-
 *  root table (rare; usually a sign of an exotic borrowed chord). */
export function canonicalChordRoot(label: string): LatticePos {
  return CHORD_ROOT_POSITION[stripChordLabel(label)] ?? LATTICE_ORIGIN;
}

/** Map any JI lattice position to the ratio key of the chain-of-fifths
 *  cell that occupies the same EDO pitch class.  Used by the harmonic-
 *  lattice overlay to highlight chord tones on a Tonescape spiral —
 *  the rendered lattice is purely the chain of fifths, so non-3-axis
 *  cells (e.g. a just 5/4 third) don't have nodes; we look up the
 *  fifth-chain cell that the EDO tempers them onto and highlight
 *  THAT instead.
 *
 *  Mathematically: exp3 × P5_step ≡ step (mod edo).  Brute-forces a
 *  modular inverse since edo is small.  Returns the position wrapped
 *  into the symmetric range used by the lattice bounds, so the key
 *  matches a cell that actually exists in the rendered scene. */
export function chordToneToFifthChainKey(pos: LatticePos, edo: number): string {
  const cents = latticeToCents(pos);
  const step = ((Math.round(cents / 1200 * edo) % edo) + edo) % edo;
  const p5Step = Math.round(edo * Math.log2(3 / 2));
  const halfLo = Math.floor(edo / 2);
  const halfHi = edo - halfLo - 1;
  for (let i = 0; i < edo; i++) {
    if ((((i * p5Step) % edo) + edo) % edo === step) {
      const exp3 = i > halfHi ? i - edo : i;
      return latticePosToRatio([exp3]);
    }
  }
  return "1/1";
}

/** Convert a lattice position to its octave-reduced "n/d" ratio string —
 *  the same key format LatticeView's MonzoScene uses internally for
 *  `highlightedRatios`.  Powers the chord-progression highlight overlay
 *  in Show Answer: each chord's lattice position is converted into a
 *  ratio key so the existing Harmonic-Lattice viewer can light it up
 *  without us reinventing its node-resolution logic.  Higher-prime axes
 *  are honoured (so e.g. a 7-axis position yields a ratio with 7 in
 *  numerator/denominator), but in practice the chord-trace mode walks
 *  only on the 3+5 axes. */
export function latticePosToRatio(pos: LatticePos): string {
  let num = 1, den = 1;
  for (let i = 0; i < pos.length; i++) {
    const exp = pos[i] ?? 0;
    if (exp === 0) continue;
    const prime = PRIME_AXES[i];
    if (exp > 0) num *= prime ** exp;
    else den *= prime ** -exp;
  }
  // Octave-reduce into [1, 2).
  while (num >= den * 2) den *= 2;
  while (num < den) num *= 2;
  // Reduce any leftover shared factors of 2.
  while (num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
  return `${num}/${den}`;
}

// ── Per-note voicings (for limit-aware Adaptive JI retuning) ────────────
//
// Each chord quality maps to a list of per-voice lattice positions
// relative to the chord ROOT.  This lets the chord-pool retuning do two
// things the old triad-only adaptiveTriadFor() couldn't:
//   1. Handle 4-note (and longer) voicings — dom7's 7/4 gets a real
//      lattice position, not silently dropped.
//   2. Reach into higher prime axes — septimal dom7 (4:5:6:7) places
//      the 7th on the 7-axis, undecimal neutral chord (4:9/2:11/2)
//      uses the 11-axis for its third, etc.
//
// When the lattice walker (tracePath) accumulates motions, voices that
// traverse higher-prime axes carry the comma activity — the audible
// septimal pump on V7→IV in 7-limit, the undecimal pump on neutral
// chord resolutions in 11-limit, and so on.

export interface ChordVoicing {
  /** Quality identifier (e.g. "major", "septimal-dom7", "neutral-triad"). */
  quality: string;
  /** Per-voice lattice positions, relative to chord root.  voices[0]
   *  is always the chord root at [0, ...] (origin). */
  voices: LatticePos[];
}

/** Catalog of pure-ratio voicings indexed by quality.  The 5-limit
 *  voicing is the default; higher-prime variants are listed alongside
 *  with explicit "septimal-" / "neutral-" / "tridecimal-" prefixes.
 *
 *  Lattice convention (all positions are root-relative):
 *    [3-axis, 5-axis, 7-axis, 11-axis, 13-axis, ...]
 *  Trailing zeros may be omitted; padPos() pads to canonical length. */
export const VOICING_CATALOG: Record<string, ChordVoicing> = {
  // ── 5-limit triads (the universal defaults) ───────────────────────────
  // 4:5:6 major
  major: { quality: "major", voices: [[0, 0], [0, +1], [+1, 0]] },
  // 10:12:15 minor (m3 = 6/5, P5 = 3/2)
  minor: { quality: "minor", voices: [[0, 0], [+1, -1], [+1, 0]] },
  // Diminished: m3 + diminished-5th (36/25 = stacked m3s)
  dim: { quality: "dim", voices: [[0, 0], [+1, -1], [+2, -2]] },
  // Augmented: M3 + aug-5th (25/16 = stacked M3s)
  aug: { quality: "aug", voices: [[0, 0], [0, +1], [0, +2]] },

  // ── 5-limit 7th chords ────────────────────────────────────────────────
  // 8:10:12:15 maj7 (M7 = 15/8)
  maj7: { quality: "maj7", voices: [[0, 0], [0, +1], [+1, 0], [+1, +1]] },
  // Just minor 7 chord: 1, 6/5, 3/2, 9/5 — has m3 + P5 + Just m7
  min7: { quality: "min7", voices: [[0, 0], [+1, -1], [+1, 0], [+2, -1]] },
  // 5-limit (Pythagorean) dom7: 1, 5/4, 3/2, 16/9 — m7 = 16/9 = 3^-2
  dom7: { quality: "dom7", voices: [[0, 0], [0, +1], [+1, 0], [-2, 0]] },
  // Half-diminished: m3, dim5, m7
  m7b5: { quality: "m7b5", voices: [[0, 0], [+1, -1], [+2, -2], [+2, -1]] },
  // Fully diminished: stacked m3s = 1, 6/5, 36/25, 216/125
  dim7: { quality: "dim7", voices: [[0, 0], [+1, -1], [+2, -2], [+3, -3]] },

  // ── 7-limit (septimal) ────────────────────────────────────────────────
  // 4:5:6:7 — the harmonic dom7 (m7 = 7/4 instead of 16/9)
  "septimal-dom7": { quality: "septimal-dom7", voices: [[0, 0], [0, +1], [+1, 0], [0, 0, +1]] },
  // 6:7:9 subminor triad — m3 = 7/6, P5 = 3/2
  "septimal-subminor": { quality: "septimal-subminor", voices: [[0, 0], [+1, 0, -1], [+1, 0]] },
  // 14:18:21 supermajor triad — M3 = 9/7, P5 = 3/2
  "septimal-supermajor": { quality: "septimal-supermajor", voices: [[0, 0], [+2, 0, -1], [+1, 0]] },
  // 7-limit "subminor 7" — root + 7/6 + 3/2 + 7/4
  "septimal-min7": { quality: "septimal-min7", voices: [[0, 0], [+1, 0, -1], [+1, 0], [0, 0, +1]] },

  // ── 11-limit (neutral) ────────────────────────────────────────────────
  // Neutral triad: root + 11/9 + 3/2.  11/9 = 11 / 3^2 → lattice [-2, 0, 0, +1].
  "neutral-triad": { quality: "neutral-triad", voices: [[0, 0], [-2, 0, 0, +1], [+1, 0]] },
  // 11-limit "wide-4" sus chord: root + 11/8 + 3/2.  11/8 → lattice [0, 0, 0, +1].
  "wide-sus": { quality: "wide-sus", voices: [[0, 0], [0, 0, 0, +1], [+1, 0]] },

  // ── 13-limit (tridecimal) ─────────────────────────────────────────────
  // Tridecimal triad — uses 13/8 as a wide M6-ish substitute for the 5th.
  "tridecimal-triad": { quality: "tridecimal-triad", voices: [[0, 0], [0, +1], [0, 0, 0, 0, +1]] },
};

/** Bucket a third interval (in cents) into a quality category. */
function classifyThird(cents: number): "sub3" | "m3" | "N3" | "M3" | "sup3" | "?" {
  if (cents < 280) return "sub3";
  if (cents < 332) return "m3";
  if (cents < 372) return "N3";
  if (cents < 422) return "M3";
  if (cents < 460) return "sup3";
  return "?";
}
/** Bucket a fifth interval (in cents) into a quality category. */
function classifyFifth(cents: number): "d5" | "P5" | "A5" | "?" {
  if (cents < 670) return "d5";
  if (cents < 715) return "P5";
  if (cents < 750) return "A5";
  return "?";
}
/** Bucket a seventh interval (in cents).  Distinguishes septimal 7/4
 *  (~969¢) from Pythagorean 16/9 (~996¢) and the major 7th. */
function classifySeventh(cents: number): "harm7" | "m7" | "M7" | "?" {
  if (cents < 985) return "harm7";   // 7/4 territory
  if (cents < 1060) return "m7";     // 16/9 / 9/5
  if (cents < 1130) return "M7";     // 15/8
  return "?";
}

/** Identify a chord's quality from its EDO-step intervals (root-relative).
 *  Returns one of the keys in VOICING_CATALOG, or null if no match.
 *  The returned quality is what voicingFor() should be called with. */
export function chordQualityFromSteps(steps: number[], edo: number): string | null {
  if (steps.length < 3) return null;
  const root = steps[0];
  const t3c = ((steps[1] - root) / edo) * 1200;
  const t5c = ((steps[2] - root) / edo) * 1200;
  const t7c = steps.length >= 4 ? ((steps[3] - root) / edo) * 1200 : null;
  const t3 = classifyThird(t3c);
  const t5 = classifyFifth(t5c);
  // Triads
  if (t7c === null) {
    if (t3 === "M3" && t5 === "P5") return "major";
    if (t3 === "m3" && t5 === "P5") return "minor";
    if (t3 === "m3" && t5 === "d5") return "dim";
    if (t3 === "M3" && t5 === "A5") return "aug";
    if (t3 === "N3" && t5 === "P5") return "neutral-triad";
    if (t3 === "sub3" && t5 === "P5") return "septimal-subminor";
    if (t3 === "sup3" && t5 === "P5") return "septimal-supermajor";
    return null;
  }
  // 7th chords
  const t7 = classifySeventh(t7c);
  if (t3 === "M3" && t5 === "P5") {
    if (t7 === "harm7") return "septimal-dom7";
    if (t7 === "m7") return "dom7";
    if (t7 === "M7") return "maj7";
  }
  if (t3 === "m3" && t5 === "P5") {
    if (t7 === "harm7") return "septimal-min7";
    if (t7 === "m7") return "min7";
  }
  if (t3 === "m3" && t5 === "d5") {
    if (t7 === "m7") return "m7b5";
    if (t7 === "harm7" || t7 === "M7") return "dim7";  // includes the bb7 = M6 enharmonic
  }
  return null;
}

/** Look up the per-note voicing for a quality.  Returns null when the
 *  quality isn't in the catalog (caller should fall back to leaving the
 *  chord unretuned). */
export function voicingFor(quality: string): ChordVoicing | null {
  return VOICING_CATALOG[quality] ?? null;
}

/** Coerce a higher-limit chord quality down to its closest 3+5-limit
 *  equivalent.  Used by the "Pure 3/5-limit" chord mode where the user
 *  wants pure-ratio retuning but only on the 3-axis (Pythagorean) and
 *  5-axis (classical JI) — septimal/undecimal/tridecimal chords get
 *  collapsed onto their closest classical cousin so the pump phenomena
 *  the mode demonstrates remain limited to the syntonic comma family.
 *  Returns null when no clean classical substitute exists (caller
 *  leaves the chord at its frozen EDO tuning in that case). */
export function coerceTo5Limit(quality: string): string | null {
  switch (quality) {
    // 5-limit qualities pass through.
    case "major":
    case "minor":
    case "dim":
    case "aug":
    case "maj7":
    case "min7":
    case "dom7":
    case "m7b5":
    case "dim7":
      return quality;
    // Septimal qualities map to their closest classical cousin.
    case "septimal-dom7":      return "dom7";
    case "septimal-min7":      return "min7";
    case "septimal-subminor":  return "minor";
    case "septimal-supermajor":return "major";
    // No clean 5-limit substitute: leave the chord frozen.
    case "neutral-triad":
    case "tridecimal-triad":
    case "wide-sus":
      return null;
    default:
      return null;
  }
}

/** Whether a lattice position uses any axis above the 5-limit (axes
 *  beyond the first two — 7-axis through 31-axis).  The "Pure 3/5-limit"
 *  drift trace uses this to project higher-prime motions onto their
 *  3+5 components (i.e. clamp those axes to zero) so the drift remains
 *  in the syntonic-comma family the mode is restricted to. */
export function projectTo5Limit(pos: LatticePos): LatticePos {
  return [pos[0] ?? 0, pos[1] ?? 0];
}

/** Convert a voicing's per-voice lattice positions to per-voice cent
 *  offsets from the chord root.  Each cents value sits in [0, 1200). */
export function voicingToCents(voicing: ChordVoicing): number[] {
  return voicing.voices.map(v => latticeToCents(v));
}

/** Convert a voicing to per-voice EDO-step offsets from the chord root.
 *  Octave bumps are applied so each voice ascends from the previous one
 *  (so a triad voicing returns [0, M3-step, P5-step], not [0, M3, P5%edo]). */
export function voicingToSteps(voicing: ChordVoicing, edo: number): number[] {
  const cents = voicingToCents(voicing);
  let prev = 0;
  return cents.map((c, i) => {
    if (i === 0) { prev = 0; return 0; }
    let step = Math.round((c / 1200) * edo);
    // Ensure ascending: if step lands below previous voice, bump octave(s).
    while (step <= prev) step += edo;
    prev = step;
    return step;
  });
}
