// ── Rhythm Generation for Melodic Patterns ────────────────────────────────
//
// Theoretical foundations:
//
// 1. LERDAHL & JACKENDOFF, "A Generative Theory of Tonal Music" (1983)
//    — Metrical Well-Formedness Rules (MWFRs): meter is a hierarchy of
//      equidistant beats at multiple levels; every beat at level Lᵢ is
//      also a beat at Lᵢ₋₁.  Metric weight at position p = the deepest
//      level at which p is a beat.
//    — Metrical Preference Rules (MPRs): prefer regular alternation,
//      stronger weight where events (onsets, harmonic change, long notes)
//      coincide.  We implement MPR 5 (length → weight) in the phrase arc
//      and MPR 10 (parallelism) in the style transforms.
//
// 2. LONDON, "Hearing in Time" (2nd ed., 2012)
//    — Well-formedness for Non-Isochronous (NI) meters (Ch. 7):
//      adjacent beat-groups may only contain durations whose ratio ≤ 2:1
//      (no 4+1 groupings; 3+2 is the maximum asymmetry).
//    — Metric entrainment: the cycle period must fall within ~100 ms
//      (minimum IOI) to ~5–6 s (maximum cycle length).  We validate
//      groupings against the 2:1 ratio constraint.
//    — Many Meters Hypothesis: NI meters are distinct metric types, not
//      distortions of isochronous ones.  Our grouping engine treats each
//      time signature's partitions as first-class metric structures.
//
// 3. TOUSSAINT, "The Geometry of Musical Rhythm" (2013)
//    — Euclidean rhythms (Bjorklund's algorithm): E(k,n) distributes k
//      onsets among n slots as evenly as possible.  Many traditional
//      timeline patterns are Euclidean:
//        E(3,8)  = [x..x..x.]           tresillo
//        E(5,8)  = [x.xx.xx.]           cinquillo
//        E(5,16) = [x..x..x..x..x...]   bossa nova (approx.)
//        E(7,12) = [x.xx.xx.xx.xx.]     West African bell
//    — Rhythmic oddity property, maximal evenness, and the deep/shallow
//      distinction for onset patterns.  The clave and bossa patterns
//      below use Euclidean generation rather than hard-coded slot lists.
//    — Inter-onset-interval (IOI) vectors characterize rhythm families.
//
// Grid: Styles that imply triplet subdivision (shuffle) use beatSize=3
// (eighth-note-triplet grid). All others use beatSize=4 (16th-note grid).

import { generateAndSelectGrouping } from "./groupingSelector";

export type RhythmStyle =
  | "straight"
  | "syncopated"
  | "shuffle"
  | "tresillo"
  | "bossa"
  | "clave"
  | "funk"
  | "reggae"
  | "secondline"
  | "displaced";

/** True when the style uses a triplet grid (3 slots per beat) */
export function isTripletStyle(style: RhythmStyle): boolean {
  return style === "shuffle";
}

export interface RhythmResult {
  chordHits: number[];
  melodyHits: number[];
  totalSlots: number;
  beatsPerBar: number;
  beatSize: number;
  bottom: number;
  grouping: number[];
}

export const STYLE_INFO: { value: RhythmStyle; label: string; desc: string; color: string }[] = [
  { value: "straight",   label: "Straight",    desc: "On-the-beat, even emphasis",                   color: "#5a8a5a" },
  { value: "syncopated", label: "Syncopated",   desc: "Offbeat emphasis, anticipations",              color: "#c8aa50" },
  { value: "shuffle",    label: "Shuffle",      desc: "Triplet swing — long-short bounce",            color: "#c09060" },
  { value: "tresillo",   label: "Tresillo",     desc: "E(3,8) — habanera, reggaeton, afrobeat",       color: "#d09050" },
  { value: "bossa",      label: "Bossa",        desc: "E(5,16) — bossa nova anticipations",           color: "#60a0a0" },
  { value: "clave",      label: "Clave",        desc: "Son clave 3-2 — IOI [3,3,4,2,4]",             color: "#a06090" },
  { value: "funk",       label: "Funk",         desc: "Beat-1 heavy, 16th ghost-note pocket",         color: "#cc6666" },
  { value: "reggae",     label: "Reggae",       desc: "Chords on offbeats, bass on downbeats",        color: "#66aa66" },
  { value: "secondline", label: "Second Line",  desc: "New Orleans — dotted figures, polyrhythmic",   color: "#aa8866" },
  { value: "displaced",  label: "Displaced",    desc: "Push/pull — anticipations on every strong beat", color: "#8888cc" },
];

// ── Seeded PRNG ──────────────────────────────────────────────────────────

function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function pickRandom<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

// ── Bjorklund / Euclidean rhythm (Toussaint Ch. 8) ──────────────────────
//
// Distributes k onsets among n positions as evenly as possible.
// Returns an array of n booleans (true = onset).
// This is the mathematical core behind tresillo, cinquillo, bossa, etc.

function bjorklund(k: number, n: number): boolean[] {
  if (k >= n) return new Array(n).fill(true);
  if (k <= 0) return new Array(n).fill(false);

  // Bresenham-style construction (equivalent to Bjorklund's original
  // bit-sequence algorithm but simpler to follow).
  const pattern: boolean[] = new Array(n).fill(false);
  let bucket = 0;
  for (let i = 0; i < n; i++) {
    bucket += k;
    if (bucket >= n) {
      bucket -= n;
      pattern[i] = true;
    }
  }
  return pattern;
}

/** Convert Euclidean boolean pattern to onset slot indices. */
function euclideanOnsets(k: number, n: number, rotation: number = 0): number[] {
  const pattern = bjorklund(k, n);
  const slots: number[] = [];
  for (let i = 0; i < n; i++) {
    if (pattern[(i + rotation) % n]) slots.push(i);
  }
  return slots;
}

/** Compute IOI vector from onset slots (Toussaint's fundamental descriptor). */
function ioiVector(onsets: number[], totalSlots: number): number[] {
  if (onsets.length <= 1) return [totalSlots];
  const ioi: number[] = [];
  for (let i = 0; i < onsets.length; i++) {
    const next = onsets[(i + 1) % onsets.length];
    const curr = onsets[i];
    ioi.push(next > curr ? next - curr : totalSlots - curr + next);
  }
  return ioi;
}

// ── Grouping (London Ch. 4, 7) ──────────────────────────────────────────
//
// London's NI-meter well-formedness: adjacent groups must satisfy the
// 2:1 ratio constraint (no group can be more than double its neighbor).
// Groups of 2 and 3 are the primary building blocks of NI meters;
// groups of 4 appear only in isochronous contexts.

function londonWellFormed(grouping: number[]): boolean {
  for (let i = 1; i < grouping.length; i++) {
    const ratio = Math.max(grouping[i], grouping[i - 1]) /
                  Math.min(grouping[i], grouping[i - 1]);
    if (ratio > 2) return false;
  }
  return true;
}

function getGrouping(beatsPerBar: number, beatSize: number, bottom: number): number[] {
  if (bottom === 4) {
    // Isochronous meter: equal groups (GTTM MWFR 3 — beat regularity)
    return Array(beatsPerBar).fill(beatSize);
  }
  // NI meter: use the grouping engine, then validate London's constraint
  const totalSlots = beatsPerBar * beatSize;
  const maxPart = Math.min(totalSlots, 8);
  const result = generateAndSelectGrouping(totalSlots, "musical", maxPart);
  if (result && londonWellFormed(result)) return result;
  // Fallback: build from 2s and 3s (London's elementary NI groups)
  const groups: number[] = [];
  let rem = totalSlots;
  while (rem > 0) {
    if (rem >= 3 && rem !== 4) { groups.push(3); rem -= 3; }
    else if (rem >= 2) { groups.push(2); rem -= 2; }
    else { groups.push(1); rem -= 1; }
  }
  return groups;
}

// ── GTTM Metric Hierarchy (Lerdahl & Jackendoff Ch. 4) ─────────────────
//
// MWFR 1: every beat at level Lᵢ is a beat at all levels Lⱼ where j < i.
// MWFR 2: at each level, beats are equally spaced (isochronous meters)
//         or spaced by the NI-meter's group structure.
// MWFR 4: beats at each level must include the first beat of the group.
//
// Metric weight at position p = number of metric levels at which p is a
// beat, normalized to [0, 1].  This is the standard interpretation of
// GTTM's "dot" notation for metric grids.
//
// For a 4/4 bar with 16th-note resolution (16 slots):
//   Level 0 (16th):  all 16 positions           — depth 1
//   Level 1 (8th):   0, 2, 4, 6, 8, 10, 12, 14  — depth 2
//   Level 2 (quarter): 0, 4, 8, 12               — depth 3
//   Level 3 (half):  0, 8                         — depth 4
//   Level 4 (whole): 0                            — depth 5
//
// For NI meters, recursive subdivision follows the grouping structure:
// at each level, group boundaries are beats.

function metricWeights(grouping: number[], totalSlots: number): number[] {
  const depth = new Array(totalSlots).fill(0);

  // Level 0: every slot is a beat at the finest level
  for (let i = 0; i < totalSlots; i++) depth[i] = 1;

  // Level 1: group-internal subdivision — for groups of size g,
  // the midpoint (and for g=4, the quarter-points) get an extra level.
  let pos = 0;
  for (const gSize of grouping) {
    // Group start already gets credit from higher levels below.
    // Internal beats at the half-beat level:
    if (gSize >= 2) {
      const mid = Math.floor(gSize / 2);
      depth[pos + mid] += 1;
    }
    // For groups of 4: quarter-points give 8th-note level beats
    if (gSize === 4) {
      depth[pos + 1] += 0; // 16th level only (already counted)
      depth[pos + 3] += 0;
    }
    pos += gSize;
  }

  // Level 2: group starts (= tactus / beat level)
  pos = 0;
  for (const gSize of grouping) {
    depth[pos] += 1;
    pos += gSize;
  }

  // Level 3: hypermetric grouping — pairs of groups
  // (GTTM: strong-weak alternation at the next level up)
  pos = 0;
  for (let g = 0; g < grouping.length; g++) {
    if (g % 2 === 0) depth[pos] += 1;
    pos += grouping[g];
  }

  // Level 4: downbeat of the bar
  depth[0] += 1;

  // Normalize to [0, 1]
  const maxDepth = Math.max(...depth);
  return depth.map(d => d / maxDepth);
}

// ── Style transforms ─────────────────────────────────────────────────────
//
// Each style modifies the base GTTM metric weights using principles from
// all three sources:
// — Syncopation = onset on a weak position coinciding with absence on the
//   next stronger position (GTTM MPR 4, London Ch. 9)
// — Timeline patterns use Euclidean generation (Toussaint)
// — Layer differentiation follows London's entrainment theory: chord layer
//   tracks the tactus, melody layer subdivides more freely

function applyStyle(
  weights: number[],
  style: RhythmStyle,
  grouping: number[],
  layer: "chord" | "melody",
  beatSize: number,
): number[] {
  const w = [...weights];
  const totalSlots = w.length;

  // Precompute structural positions
  const groupStarts = new Set<number>();
  const groupMids = new Set<number>();
  const anticipations = new Set<number>();
  let pos = 0;
  for (const gSize of grouping) {
    groupStarts.add(pos);
    if (gSize >= 3) groupMids.add(pos + Math.floor(gSize / 2));
    if (pos > 0) anticipations.add(pos - 1);
    pos += gSize;
  }
  anticipations.add(totalSlots - 1);

  switch (style) {
    case "straight":
      // Pure metric hierarchy — reinforce GTTM depth, suppress sub-beat
      // This is the "default" where weight = metric depth directly.
      // MPR 5 (preference for strong positions) at its purest.
      for (let i = 0; i < totalSlots; i++) {
        if (groupStarts.has(i)) w[i] *= 1.3;
        else if (groupMids.has(i)) w[i] *= 1.1;
        else w[i] *= 0.6;
      }
      break;

    case "syncopated":
      // GTTM syncopation: weight shifted from strong to adjacent weak
      // positions (MPR 4 violation as expressive device).
      // London (Ch. 9): syncopation = onset where the metric hierarchy
      // predicts silence, silence where it predicts onset.
      for (let i = 0; i < totalSlots; i++) {
        if (i === 0) { w[i] *= 1.0; continue; }
        if (groupStarts.has(i)) w[i] *= 0.4;  // suppress strong beats
        else w[i] = Math.max(w[i] * 2.0, 0.5); // boost weak positions
      }
      // Anticipations (the slot before a strong beat) — London's
      // "phase shift" syncopation
      for (const a of anticipations) w[a] = Math.max(w[a], 0.7);
      break;

    case "shuffle":
      // Triplet grid (beatSize=3): slots 0, 1, 2 per beat.
      // London (Ch. 6): swing as a distinct metric type, not a distortion
      // of duple.  The long-short pattern (2:1 ratio) is itself a metric
      // level.  Slot 0 = beat, slot 2 = the "and" in swing feel,
      // slot 1 = suppressed middle triplet partial.
      for (let i = 0; i < totalSlots; i++) {
        const posInBeat = i % beatSize;
        if (posInBeat === 0) {
          w[i] = Math.max(w[i] * 1.4, 0.6);
        } else if (posInBeat === 2) {
          w[i] = Math.max(w[i] * 2.0, 0.55);
        } else {
          w[i] *= 0.15;
        }
      }
      break;

    case "tresillo": {
      // Toussaint: E(3,8) = tresillo, IOI vector [3,3,2].
      // The fundamental Afro-Cuban timeline, also present in habanera,
      // reggaeton, and afrobeat.  We generate the Euclidean pattern and
      // use its onsets as weight anchors rather than hard-coding slots.
      const tresilloOnsets = new Set(euclideanOnsets(3, 8));
      for (let i = 0; i < totalSlots; i++) {
        const posInCell = i % 8;
        if (tresilloOnsets.has(posInCell)) {
          // Euclidean onset positions
          w[i] = Math.max(w[i] * 2.5, 0.7);
        } else {
          // Check IOI proximity: positions adjacent to onsets get mild weight
          const prevInCell = (posInCell + 7) % 8;
          if (tresilloOnsets.has(prevInCell)) {
            w[i] *= 0.3; // post-onset — tension zone
          } else {
            w[i] *= 0.15;
          }
        }
      }
      w[0] = Math.max(w[0], 0.9);
      break;
    }

    case "bossa": {
      // Toussaint: bossa nova as approximate E(5,16), with the
      // characteristic anticipation of beat 2 and beat 4.
      // IOI vector ≈ [3,3,4,3,3] — maximally even 5-in-16.
      // The anticipation pattern is what distinguishes bossa from
      // a straight E(5,16) — we shift selected onsets back by 1 slot.
      const bossaOnsets = new Set(euclideanOnsets(5, 16));
      for (let i = 0; i < totalSlots; i++) {
        const posInCycle = i % 16;
        if (bossaOnsets.has(posInCycle)) {
          w[i] = Math.max(w[i] * 2.0, 0.65);
        } else if (bossaOnsets.has((posInCycle + 1) % 16)) {
          // Anticipation slot (one before a Euclidean onset)
          w[i] = Math.max(w[i] * 1.8, 0.6);
        } else if (groupStarts.has(i) && i !== 0) {
          w[i] *= 0.6;
        }
      }
      // End-of-bar anticipation
      w[totalSlots - 1] = Math.max(w[totalSlots - 1], 0.6);
      break;
    }

    case "clave": {
      // Toussaint: son clave 3-2, IOI vector [3,3,4,2,4].
      // This is NOT Euclidean — it's one of the most important
      // non-Euclidean timelines, characterized by its asymmetric
      // 3-side (dense) and 2-side (sparse) halves.
      // 3-side onsets at 0, 3, 6; 2-side onsets at 10, 12
      // (in a 16-slot cycle).
      const clavePattern = [0, 3, 6, 10, 12]; // son clave 3-2
      const claveOnsets = new Set(clavePattern);
      const half = Math.floor(totalSlots / 2);
      for (let i = 0; i < totalSlots; i++) {
        const posInCycle = i % 16;
        if (claveOnsets.has(posInCycle)) {
          w[i] = Math.max(w[i] * 2.5, 0.7);
        } else if (i < half) {
          // 3-side: denser, more off-beat activity allowed
          if (!groupStarts.has(i)) w[i] = Math.max(w[i] * 1.5, 0.4);
        } else {
          // 2-side: sparser, more on-beat
          if (groupStarts.has(i)) w[i] *= 1.3;
          else w[i] *= 0.5;
        }
      }
      break;
    }

    case "funk":
      // Heavy beat 1, then dense 16th-note ghost activity.
      // London (Ch. 6): metric depth still operative at fast subdivisions;
      // the "pocket" is a strong-weak pattern at the 16th-note level.
      // GTTM: MPR 5 (length) inverted — short events on weak positions
      // create groove through density rather than accent.
      w[0] = Math.max(w[0], 1.0);
      for (let i = 0; i < totalSlots; i++) {
        if (i === 0) continue;
        if (groupStarts.has(i)) {
          w[i] *= layer === "chord" ? 1.2 : 0.6;
        } else {
          if (layer === "melody") {
            w[i] = Math.max(w[i] * 2.5, 0.4);
          } else {
            w[i] *= 0.3;
          }
        }
      }
      break;

    case "reggae":
      // London: the reggae "skank" is a distinct metric type where the
      // chord layer entrains to the offbeat.  This is not syncopation
      // (which implies a normative on-beat) but a genuine alternative
      // metric entrainment — the offbeat IS the referent.
      for (let i = 0; i < totalSlots; i++) {
        if (layer === "chord") {
          if (groupStarts.has(i)) {
            w[i] *= i === 0 ? 0.1 : 0.05;
          } else if (groupMids.has(i)) {
            w[i] = Math.max(w[i] * 3.0, 0.8);
          } else {
            w[i] *= 0.2;
          }
        } else {
          if (groupStarts.has(i)) w[i] *= 1.2;
          else if (groupMids.has(i)) w[i] = Math.max(w[i] * 1.5, 0.3);
        }
      }
      break;

    case "secondline": {
      // New Orleans second line: dotted-8th + 16th figures create a
      // 3-against-4 hemiola.  Toussaint: this relates to E(3,4) at the
      // beat level — 3 accents distributed over 4 subdivisions, generating
      // the characteristic dotted rhythm.
      // The backbeat (2 and 4) is heavy — London's "metric accent on
      // relatively weak beats" as a genre convention.
      for (let i = 0; i < totalSlots; i++) {
        const posInBeat = i % beatSize;
        if (posInBeat === 0) {
          w[i] *= 1.1;
        } else if (posInBeat === 3 && beatSize === 4) {
          // The "a" — dotted 8th landing, characteristic second line
          w[i] = Math.max(w[i] * 2.5, 0.6);
        } else if (posInBeat === 1) {
          // "e" — supports dotted figures from previous beat
          w[i] = Math.max(w[i] * 1.5, 0.3);
        } else {
          w[i] *= 0.8;
        }
      }
      // Backbeat emphasis (beats 2 and 4)
      for (let g = 0; g < grouping.length; g++) {
        if (g % 2 === 1) {
          let gStart = 0;
          for (let j = 0; j < g; j++) gStart += grouping[j];
          w[gStart] = Math.max(w[gStart], 0.8);
        }
      }
      break;
    }

    case "displaced":
      // Systematic anticipation: every strong-beat onset is shifted to
      // the preceding weak slot.  London (Ch. 9): this creates a phase
      // displacement where the perceived downbeat leads the metric
      // downbeat — the listener's entrainment "pulls forward."
      // GTTM: maximal conflict between metric and grouping structure.
      for (let i = 0; i < totalSlots; i++) {
        if (i === 0) {
          w[i] *= layer === "chord" ? 0.5 : 0.2;
        } else if (groupStarts.has(i)) {
          w[i] *= 0.15;
        }
      }
      for (const a of anticipations) {
        w[a] = Math.max(w[a], 0.85);
      }
      break;
  }

  return w;
}

// ── Phrase arc ────────────────────────────────────────────────────────────
//
// GTTM Ch. 3 (grouping structure): musical phrases have internal shape.
// The arc models the tendency for phrase-initial and phrase-final events
// to be weighted differently from phrase-medial ones.
// MPR 2 (strong-beat early): initial events tend to be stronger.
// MPR 1 (parallelism): repeated shapes at the phrase level.

function phraseArc(
  totalSlots: number,
  layer: "chord" | "melody",
  rng: () => number,
): number[] {
  const arc = new Array(totalSlots).fill(1);

  if (layer === "chord") {
    // Chords: gentle arch — GTTM grouping preference for phrase-initial
    // harmonic change, with a slight arch for internal motion
    for (let i = 0; i < totalSlots; i++) {
      const t = i / totalSlots;
      arc[i] = 0.3 + 0.2 * Math.sin(t * Math.PI);
    }
  } else {
    // Melody: varied contour shapes (GTTM MPR 1 — parallelism allows
    // multiple valid phrase shapes)
    const shape = Math.floor(rng() * 4);
    for (let i = 0; i < totalSlots; i++) {
      const t = i / totalSlots;
      switch (shape) {
        case 0: arc[i] = 0.8 - 0.3 * t;              break; // front-loaded
        case 1: arc[i] = 0.5 + 0.3 * t;              break; // back-loaded
        case 2: arc[i] = 0.5 + 0.4 * Math.sin(t * Math.PI); break; // arch
        case 3: arc[i] = 0.7;                         break; // flat
      }
    }
  }
  return arc;
}

// ── Hit generation ───────────────────────────────────────────────────────
//
// Stochastic onset placement: probability at each slot =
//   metric_weight × phrase_arc × density_target
// This is the computational realization of GTTM's preference-rule
// interaction — multiple factors combine to determine onset likelihood.

function generateHits(
  weights: number[],
  arc: number[],
  targetDensity: number,
  rng: () => number,
): number[] {
  const totalSlots = weights.length;
  const hits: number[] = [];
  for (let i = 0; i < totalSlots; i++) {
    const prob = weights[i] * arc[i] * targetDensity;
    if (rng() < prob) {
      hits.push(i);
    }
  }
  return hits;
}

// ── Density targets ──────────────────────────────────────────────────────
//
// London (Ch. 5): metric well-formedness constrains how many events
// can occur per cycle.  Too sparse → loss of metric entrainment;
// too dense → loss of hierarchical differentiation.
// These ranges are calibrated to stay within London's "metric window."

export type DensityBias = "spacious" | "auto" | "busy";

// Widened floors let generations land anywhere from sparse to busy.
// Bias rescales the sampled density into a half-range WITHOUT consuming
// extra rng draws, so the same seed + style produces the same underlying
// rhythmic pattern — only the hit count slides up (busy) or down (spacious).
function biasDensity(d: number, lo: number, hi: number, bias: DensityBias): number {
  if (bias === "auto") return d;
  const mid = (lo + hi) / 2;
  const t = (hi > lo) ? (d - lo) / (hi - lo) : 0;
  return bias === "spacious" ? lo + t * (mid - lo) : mid + t * (hi - mid);
}

function chordDensity(style: RhythmStyle, rng: () => number, bias: DensityBias = "auto"): number {
  // Straight should feel like classical/pop downbeat phrasing — one or two
  // chord hits per bar, not a carpet. Keep the upper end well below 1.0 so
  // probability × weight × arc doesn't saturate the slot grid.
  const base: Record<RhythmStyle, [number, number]> = {
    straight:   [0.20, 0.55],
    syncopated: [0.40, 1.4],
    shuffle:    [0.40, 1.3],
    tresillo:   [0.40, 1.3],
    bossa:      [0.40, 1.4],
    clave:      [0.40, 1.3],
    funk:       [0.25, 0.9],
    reggae:     [0.50, 1.6],
    secondline: [0.35, 1.2],
    displaced:  [0.35, 1.2],
  };
  const [lo, hi] = base[style];
  return biasDensity(lo + rng() * (hi - lo), lo, hi, bias);
}

function melodyDensity(style: RhythmStyle, rng: () => number, bias: DensityBias = "auto"): number {
  // Straight melodies should breathe — half-note / quarter-note phrasing
  // rather than constant sixteenth-note chatter.
  const base: Record<RhythmStyle, [number, number]> = {
    straight:   [0.30, 0.70],
    syncopated: [0.65, 1.8],
    shuffle:    [0.55, 1.5],
    tresillo:   [0.55, 1.6],
    bossa:      [0.55, 1.6],
    clave:      [0.65, 1.8],
    funk:       [0.80, 2.2],
    reggae:     [0.45, 1.4],
    secondline: [0.65, 1.8],
    displaced:  [0.55, 1.6],
  };
  const [lo, hi] = base[style];
  return biasDensity(lo + rng() * (hi - lo), lo, hi, bias);
}

// ── Metric weight export for melody-rhythm coupling ──────────────────────

export function melodyPositionStrengths(
  beatsPerBar: number,
  beatSize: number,
  style: RhythmStyle,
  melodyHitSlots: number[],
  bottom: number,
): number[] {
  const grouping = getGrouping(beatsPerBar, beatSize, bottom);
  const totalSlots = beatsPerBar * beatSize;
  const baseWeights = metricWeights(grouping, totalSlots);
  const styled = applyStyle(baseWeights, style, grouping, "melody", beatSize);

  const strengths = melodyHitSlots.map(slot =>
    slot >= 0 && slot < totalSlots ? styled[slot] : 0.3
  );
  const max = Math.max(...strengths, 0.001);
  return strengths.map(s => s / max);
}

// ── Main Generator ────────────────────────────────────────────────────────

export function generateRhythm(
  beatsPerBar: number,
  beatSize: number,
  style: RhythmStyle,
  melodyNotes: number,
  seed?: number,
  bottom: number = 4,
  densityBias: DensityBias = "auto",
): RhythmResult {
  const rng = makeRng(seed ?? (Date.now() ^ Math.floor(Math.random() * 999999)));
  const totalSlots = beatsPerBar * beatSize;

  const grouping = getGrouping(beatsPerBar, beatSize, bottom);
  const baseWeights = metricWeights(grouping, totalSlots);

  const chordWeights = applyStyle(baseWeights, style, grouping, "chord", beatSize);
  const melodyWeights = applyStyle(baseWeights, style, grouping, "melody", beatSize);

  const chordArc = phraseArc(totalSlots, "chord", rng);
  const melodyArc = phraseArc(totalSlots, "melody", rng);

  const cDensity = chordDensity(style, rng, densityBias);
  const mDensity = melodyDensity(style, rng, densityBias);

  let chordHits = generateHits(chordWeights, chordArc, cDensity, rng);
  let melodyHits = generateHits(melodyWeights, melodyArc, mDensity, rng);

  // ── Guarantees ──
  // GTTM MWFR 4: the first beat of a group must be present at some level.
  // Ensure at least one chord onset.
  if (chordHits.length === 0) {
    chordHits.push(0);
  }

  // London: chord layer tracks the tactus (fewer, stronger beats);
  // melody subdivides more freely.  If chord ended up denser, swap.
  // Done before melody snapping so the snap targets the actual melody layer.
  if (chordHits.length > melodyHits.length) {
    [chordHits, melodyHits] = [melodyHits, chordHits];
    if (!chordHits.includes(0)) {
      chordHits.push(0);
      chordHits.sort((a, b) => a - b);
    }
  }

  // ── Chord/melody coordination ──
  // The two layers play simultaneously — generating them independently
  // leaves the chord attacks unsupported and the pattern incoherent when
  // played together.  Fold every chord onset into the melody so each
  // chord hit lands with a matching melodic onset; melody can still have
  // additional hits between chords.  Before the merge we subtract the
  // expected overlap from the melody target so the final count stays close
  // to what the user requested.
  const minMelody = Math.max(1, melodyNotes);
  const chordSet = new Set(chordHits);
  // Estimated overlap from the base generator: ~chordCount hits on average
  // will already have landed on chord-hit slots.  We reserve room for the
  // forced merge by treating overlap as "free" melody slots.
  const baseMelodyUniques = melodyHits.filter(h => !chordSet.has(h)).length;
  const rawCount = baseMelodyUniques + chordHits.length;
  const multiple = Math.max(1, Math.round(rawCount / minMelody));
  const target = Math.max(chordHits.length, multiple * minMelody);

  // Pad/trim the non-chord melody portion to hit `target - chordHits.length`
  // unique melodic onsets.  Chord slots are preserved in melody as forced
  // anchors; only the "extra" melody hits are shuffled.
  let extraMelody = melodyHits.filter(h => !chordSet.has(h));
  const extraTarget = Math.max(0, target - chordHits.length);

  if (extraMelody.length < extraTarget) {
    // Pad: add hits at best metric positions (GTTM preference-rule
    // weighted selection — higher metric weight = more likely fill).
    const hitSet = new Set([...chordHits, ...extraMelody]);
    const candidates = Array.from({ length: totalSlots }, (_, i) => i)
      .filter(i => !hitSet.has(i))
      .map(i => ({ slot: i, score: melodyWeights[i] * melodyArc[i] }));
    while (extraMelody.length < extraTarget && candidates.length > 0) {
      const totalScore = candidates.reduce((sum, c) => sum + c.score, 0);
      if (totalScore <= 0) break;
      let r = rng() * totalScore;
      let pick = candidates.length - 1;
      for (let j = 0; j < candidates.length; j++) {
        r -= candidates[j].score;
        if (r <= 0) { pick = j; break; }
      }
      extraMelody.push(candidates[pick].slot);
      candidates.splice(pick, 1);
    }
  } else if (extraMelody.length > extraTarget) {
    // Trim: drop metrically weakest hits (lowest GTTM depth).
    extraMelody = extraMelody
      .map(slot => ({ slot, score: melodyWeights[slot] * melodyArc[slot] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, extraTarget)
      .map(x => x.slot);
  }

  // Merge chord onsets back in — every chord attack now has a matching
  // melodic onset so the two layers line up when played together.
  melodyHits = [...new Set([...chordHits, ...extraMelody])].sort((a, b) => a - b);

  return {
    chordHits,
    melodyHits,
    totalSlots,
    beatsPerBar,
    beatSize,
    bottom,
    grouping,
  };
}
