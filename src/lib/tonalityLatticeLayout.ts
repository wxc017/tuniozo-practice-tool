// ── Tonality lattice data model ──────────────────────────────────────────
// Direct port of the layout logic from
// `Downloads/tonality-lattice-v2.html`, extended from 3 families to 7
// (the reference's Major / Harmonic Minor / Melodic Minor plus the
// app's Subminor Diatonic / Neutral Diatonic / Supermajor Diatonic /
// Subharmonic Diatonic).
//
// The lattice is a 3D grid:
//   - X axis (column): which key, ordered by ascending fifths.
//   - Y axis (row):    brightness — number of sharps relative to Major,
//                      with Lydian = +1, Major = 0, Locrian = -5, etc.
//   - Z axis (depth):  which family — Major at z = 0, Harmonic Minor
//                      at z = 1, Melodic Minor at z = 2, then the four
//                      xen families at z = 3..6.
//
// Edges have three flavours:
//   - X-edges: same mode, adjacent key (one fifth of motion).
//   - Y-edges: same key, same family, brightness ±1 (one accidental
//              within a family).
//   - Z-edges: same key, between families, one accidental of difference
//              across the family stack.

import { getModeDegreeMap } from "./edoData";
import { PATTERN_SCALE_FAMILIES } from "./musicTheory";

// ── 15 keys via circle of fifths ────────────────────────────────────────
export interface LatticeKey {
  letter: string;
  accidental: string;
  name: string;          // 'C', 'F♯', 'B♭', etc.
  pc: number;            // pitch class within the user's EDO
}

const KEY_SPELLINGS = [
  { letter: "F", accidental: "♭", name: "F♭" },
  { letter: "C", accidental: "♭", name: "C♭" },
  { letter: "G", accidental: "♭", name: "G♭" },
  { letter: "D", accidental: "♭", name: "D♭" },
  { letter: "A", accidental: "♭", name: "A♭" },
  { letter: "E", accidental: "♭", name: "E♭" },
  { letter: "B", accidental: "♭", name: "B♭" },
  { letter: "F", accidental: "",  name: "F"  },
  { letter: "C", accidental: "",  name: "C"  },
  { letter: "G", accidental: "",  name: "G"  },
  { letter: "D", accidental: "",  name: "D"  },
  { letter: "A", accidental: "",  name: "A"  },
  { letter: "E", accidental: "",  name: "E"  },
  { letter: "B", accidental: "",  name: "B"  },
  { letter: "B", accidental: "♯", name: "B♯" },
];

const LETTER_PC_12: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const LETTER_PC_31: Record<string, number> = { C: 0, D: 5, E: 10, F: 13, G: 18, A: 23, B: 28 };

function accidentalSemitones(acc: string, edo: number): number {
  const step = edo === 31 ? 2 : 1;
  if (acc === "♯") return step;
  if (acc === "♭") return -step;
  if (acc === "♯♯" || acc === "𝄪") return 2 * step;
  if (acc === "♭♭" || acc === "𝄫") return -2 * step;
  return 0;
}

export function buildKeys(edo: number): LatticeKey[] {
  const letters = edo === 31 ? LETTER_PC_31 : LETTER_PC_12;
  return KEY_SPELLINGS.map(s => {
    const basePc = letters[s.letter] ?? 0;
    const adj = accidentalSemitones(s.accidental, edo);
    const pc = ((basePc + adj) % edo + edo) % edo;
    return { letter: s.letter, accidental: s.accidental, name: s.name, pc };
  });
}

// ── Families ────────────────────────────────────────────────────────────
export interface LatticeFamily {
  id: string;
  label: string;
  short: string;
  color: string;
  dim: string;
  zOrd: number;
  familyName: string;     // matches PATTERN_SCALE_FAMILIES key
}

export const LATTICE_FAMILIES: LatticeFamily[] = [
  { id: "major",       label: "Major / Diatonic",     short: "Maj",  color: "#5bc8f5", dim: "#0b1e35", zOrd: 0, familyName: "Major Family" },
  { id: "harmonic",    label: "Harmonic Minor",       short: "Hrm",  color: "#f5b030", dim: "#281804", zOrd: 1, familyName: "Harmonic Minor Family" },
  { id: "melodic",     label: "Melodic Minor",        short: "Mel",  color: "#4de898", dim: "#041f10", zOrd: 2, familyName: "Melodic Minor Family" },
  { id: "subminor",    label: "Subminor Diatonic",    short: "Sub",  color: "#7aaa6a", dim: "#13260c", zOrd: 3, familyName: "Subminor Diatonic Family" },
  { id: "neutral",     label: "Neutral Diatonic",     short: "Neu",  color: "#9a66c0", dim: "#1b0e26", zOrd: 4, familyName: "Neutral Diatonic Family" },
  { id: "supermajor",  label: "Supermajor Diatonic",  short: "Sup",  color: "#cc6a8a", dim: "#260e16", zOrd: 5, familyName: "Supermajor Diatonic Family" },
  { id: "subharmonic", label: "Subharmonic Diatonic", short: "Shr",  color: "#4a9ac7", dim: "#0b2030", zOrd: 6, familyName: "Subharmonic Diatonic Family" },
];

// ── Modes ───────────────────────────────────────────────────────────────
const MODE_SHORT: Record<string, string> = {
  "Lydian": "Lyd", "Major": "Maj", "Ionian": "Ion", "Mixolydian": "Mix",
  "Dorian": "Dor", "Aeolian": "Aeo", "Phrygian": "Phr", "Locrian": "Loc",
  "Harmonic Minor": "HMn", "Locrian #6": "L♯6", "Ionian #5": "I♯5",
  "Dorian #4": "D♯4", "Phrygian Dominant": "PDm", "Lydian #2": "L♯2", "Ultralocrian": "ULc",
  "Melodic Minor": "MMn", "Dorian b2": "D♭2", "Lydian Augmented": "LAg",
  "Lydian Dominant": "LDm", "Mixolydian b6": "M♭6", "Locrian #2": "L♯2", "Altered": "Alt",
  "Subminor Diatonic": "SbD",
  "Neutral Diatonic": "NeD",
  "Supermajor Diatonic": "SpD",
  "Subharmonic Diatonic": "ShD",
};

function modeShortLabel(modeName: string): string {
  return MODE_SHORT[modeName] ?? modeName.slice(0, 4);
}

export interface LatticeMode {
  family: LatticeFamily;
  name: string;
  short: string;
  scale: number[];        // step values from this mode's own root, sorted
  brightness: number;     // sum-of-steps minus Major's sum, in half-steps
}

function buildMode(family: LatticeFamily, modeName: string, edo: number): LatticeMode | null {
  const map = getModeDegreeMap(edo, family.familyName, modeName);
  const scale = Object.values(map).sort((a, b) => a - b);
  if (scale.length !== 7) return null;
  const major = edo === 31 ? [0, 5, 10, 13, 18, 23, 28] : [0, 2, 4, 5, 7, 9, 11];
  const majorSum = major.reduce((a, b) => a + b, 0);
  const scaleSum = scale.reduce((a, b) => a + b, 0);
  const semitoneSize = edo === 31 ? 2 : 1;   // chromatic semitone in the EDO
  const brightness = (scaleSum - majorSum) / semitoneSize;
  return { family, name: modeName, short: modeShortLabel(modeName), scale, brightness };
}

// ── Lattice nodes & edges ───────────────────────────────────────────────
export interface LatticeNode {
  id: string;
  key: LatticeKey;
  keyIdx: number;
  family: LatticeFamily;
  mode: LatticeMode;
  pos: [number, number, number];
  rootPc: number;             // absolute pc for this (key, mode) instance
  knotT: number;              // parameter on the family's torus knot, [0, 2π)
  modeRank: number;           // 0 = brightest mode in family, 6 = darkest
}

// One twisted torus knot T(P, Q, r, n) per root pc.  Each knot holds
// all 49 (family × mode) tonalities for that root — every parallel-
// mode and modal-interchange option lives on a single knot.  (P, Q)
// is fixed across every pc (a (3, 5) trefoil-style backbone); the
// per-pc parameter is `intervalR` — the interval class from the
// anchor — which the renderer turns into r helical strands twisting
// around the backbone with one full twist (n = 1).  So anchor's knot
// is unwound, m3-away knots have 3 strands twisting, TT-away has 6.
export interface KnotConfig {
  pc: number;
  center: [number, number, number];
  R: number;                  // major radius of the carrying torus
  r: number;                  // minor radius (tube radius)
  P: number;                  // long-way wraps (constant across pcs)
  Q: number;                  // short-way wraps (constant across pcs)
  intervalR: number;          // interval class from anchor: 0 (unison),
                              // 1 (m2/M7), 2 (M2/m7), 3 (m3/M6),
                              // 4 (M3/m6), 5 (P4/P5), 6 (TT)
  // Cable-knot fields.  When the user expands a pc via a specific
  // modulation, the new pc-knot becomes a cable wrapping its parent's
  // tube — this captures the parent-child relationship geometrically.
  parentPc: number | null;    // null for anchor, else the pc whose tube this cable rides
  wraps: number;              // m: number of wraps around parent's tube (= modSemis)
  cableOffset: number;        // δ: distance from parent's tube centre
  // u-offset along the parent's path so that the anchor-equivalent
  // mode of this cable lands at the source node's position — so the
  // cable visibly "starts from" the node the user expanded from.
  cableTOffset: number;
}

export interface LatticeEdge {
  fromId: string;
  toId: string;
  type: "x" | "y" | "z";
  alt: number;
  color: string;
}

export interface TonalityLattice {
  keys: LatticeKey[];
  families: LatticeFamily[];
  modes: Map<string, LatticeMode[]>;
  nodes: LatticeNode[];
  edges: LatticeEdge[];
  nodeMap: Map<string, LatticeNode>;
  // Per-root-pc knot configuration.  Lets the renderer draw a single
  // twisted-torus-knot tube for each expanded root, with all 49
  // (family × mode) tonalities of that root sampled along the knot.
  pcKnots: Map<number, KnotConfig>;
  // World-space extents (for camera framing).
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
}

// World-space spacing (R3F units).
const KW = 1.8;       // X spacing per key column
const BS = 1.2;       // Y spacing per brightness unit
const ZG = 1.5;       // Z spacing per family stack
const Z_EDGE_COLOR = "#22ddaa";
const Y_EDGE_BASE  = "#445d7a";
const X_EDGE_COLOR = "#1f3146";

function nodeId(keyIdx: number, family: LatticeFamily, modeName: string): string {
  return `${keyIdx}::${family.id}::${modeName}`;
}

function pitchSetDistance(a: LatticeNode, b: LatticeNode, edo: number): number {
  const setA = new Set(a.mode.scale.map(s => ((a.rootPc + s) % edo + edo) % edo));
  const setB = new Set(b.mode.scale.map(s => ((b.rootPc + s) % edo + edo) % edo));
  let symdiff = 0;
  for (const v of setA) if (!setB.has(v)) symdiff++;
  for (const v of setB) if (!setA.has(v)) symdiff++;
  return symdiff / 2;
}

let _cached: { edo: number; lattice: TonalityLattice } | null = null;

export function buildTonalityLattice(edo: number): TonalityLattice {
  if (_cached && _cached.edo === edo) return _cached.lattice;

  const keys = buildKeys(edo);
  const families = LATTICE_FAMILIES;
  const modes = new Map<string, LatticeMode[]>();

  for (const family of families) {
    const modeNames = PATTERN_SCALE_FAMILIES[family.familyName] ?? [];
    const list: LatticeMode[] = [];
    for (const modeName of modeNames) {
      const m = buildMode(family, modeName, edo);
      if (m) list.push(m);
    }
    modes.set(family.id, list);
  }

  const nodes: LatticeNode[] = [];
  const nodeMap = new Map<string, LatticeNode>();

  // Centre x-axis on the middle key.
  const xCentre = (keys.length - 1) / 2;
  // Centre z-axis on the middle family.
  const zCentre = (families.length - 1) / 2;

  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    for (const family of families) {
      const modeList = modes.get(family.id) ?? [];
      for (const mode of modeList) {
        const id = nodeId(ki, family, mode.name);
        const x = (ki - xCentre) * KW;
        const y = mode.brightness * BS;
        const z = (family.zOrd - zCentre) * ZG;
        const node: LatticeNode = {
          id, key, keyIdx: ki, family, mode,
          pos: [x, y, z],
          rootPc: key.pc,
          knotT: 0,
          modeRank: 0,
        };
        nodes.push(node);
        nodeMap.set(id, node);
      }
    }
  }

  // ── Edges ─────────────────────────────────────────────────────────────
  const edges: LatticeEdge[] = [];

  // X-edges: same family + same mode, adjacent key.
  for (const family of families) {
    const modeList = modes.get(family.id) ?? [];
    for (const mode of modeList) {
      for (let ki = 0; ki < keys.length - 1; ki++) {
        const fromId = nodeId(ki, family, mode.name);
        const toId = nodeId(ki + 1, family, mode.name);
        if (nodeMap.has(fromId) && nodeMap.has(toId)) {
          edges.push({ fromId, toId, type: "x", alt: 0, color: X_EDGE_COLOR });
        }
      }
    }
  }

  // Y-edges: same family + same key, brightness-adjacent modes.
  for (const family of families) {
    const sorted = (modes.get(family.id) ?? []).slice()
      .sort((a, b) => b.brightness - a.brightness);
    for (let ki = 0; ki < keys.length; ki++) {
      for (let i = 0; i < sorted.length - 1; i++) {
        const fromId = nodeId(ki, family, sorted[i].name);
        const toId = nodeId(ki, family, sorted[i + 1].name);
        if (nodeMap.has(fromId) && nodeMap.has(toId)) {
          edges.push({ fromId, toId, type: "y", alt: 0, color: family.color });
        }
      }
    }
  }

  // Z-edges: same key, cross-family, single-alteration pairs.
  for (let ki = 0; ki < keys.length; ki++) {
    const subset = nodes.filter(n => n.keyIdx === ki);
    for (let i = 0; i < subset.length; i++) {
      for (let j = i + 1; j < subset.length; j++) {
        const a = subset[i], b = subset[j];
        if (a.family === b.family) continue;
        const alt = pitchSetDistance(a, b, edo);
        if (alt === 1) {
          edges.push({ fromId: a.id, toId: b.id, type: "z", alt: 1, color: Z_EDGE_COLOR });
        }
      }
    }
  }

  // World-space bounds for camera framing.
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const n of nodes) {
    if (n.pos[0] < minX) minX = n.pos[0];
    if (n.pos[0] > maxX) maxX = n.pos[0];
    if (n.pos[1] < minY) minY = n.pos[1];
    if (n.pos[1] > maxY) maxY = n.pos[1];
    if (n.pos[2] < minZ) minZ = n.pos[2];
    if (n.pos[2] > maxZ) maxZ = n.pos[2];
  }

  const lattice: TonalityLattice = {
    keys, families, modes, nodes, edges, nodeMap,
    pcKnots: new Map(),         // unused for the flat grid layout
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
  };
  _cached = { edo, lattice };
  return lattice;
}

// ── Note-name helpers ───────────────────────────────────────────────────
// Convert a pitch class into a readable note name.  For 12-EDO this is
// a simple lookup; for 31-EDO we derive from the diatonic letter step
// (chromatic semitone = 2 steps) + appropriate accidental — this gives
// the same spellings the chain-of-fifths key list uses.
const NAMES_12_SHARP = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
const NAMES_12_FLAT  = ["C","D♭","D","E♭","E","F","G♭","G","A♭","A","B♭","B"];

export function pcToNoteName(pc: number, edo: number, prefer: "sharp" | "flat" = "sharp"): string {
  const norm = ((pc % edo) + edo) % edo;
  if (edo === 12) {
    return (prefer === "flat" ? NAMES_12_FLAT : NAMES_12_SHARP)[norm];
  }
  if (edo === 31) {
    // Find the closest 7-letter diatonic anchor and express the
    // remainder as ♯ / ♭ / 𝄲 / 𝄳.
    const LETTER_PCS: { letter: string; pc: number }[] = [
      { letter: "C", pc:  0 }, { letter: "D", pc:  5 }, { letter: "E", pc: 10 },
      { letter: "F", pc: 13 }, { letter: "G", pc: 18 }, { letter: "A", pc: 23 },
      { letter: "B", pc: 28 },
    ];
    let best = LETTER_PCS[0];
    let bestDist = 999;
    for (const lp of LETTER_PCS) {
      // Distance modulo edo (signed, smallest absolute value)
      let d = norm - lp.pc;
      if (d > edo / 2) d -= edo;
      if (d < -edo / 2) d += edo;
      if (Math.abs(d) < bestDist) { bestDist = Math.abs(d); best = lp; }
    }
    let d = norm - best.pc;
    if (d > edo / 2) d -= edo;
    if (d < -edo / 2) d += edo;
    if (d ===  0) return best.letter;
    if (d ===  1) return best.letter + "𝄲";    // half-sharp
    if (d === -1) return best.letter + "𝄳";    // half-flat
    if (d ===  2) return best.letter + "♯";    // sharp
    if (d === -2) return best.letter + "♭";    // flat
    if (d ===  3) return best.letter + "♯𝄲";   // 3 above (rare)
    if (d === -3) return best.letter + "♭𝄳";
    if (d ===  4) return best.letter + "♯♯";   // double sharp
    if (d === -4) return best.letter + "♭♭";
    return `${best.letter}${d > 0 ? "+" : ""}${d}`;
  }
  // Fallback for other EDOs: closest 12-EDO letter
  const pc12 = Math.round((norm / edo) * 12) % 12;
  return NAMES_12_SHARP[((pc12 % 12) + 12) % 12];
}

// All 7 note names for a (rootPc, modeScale) pair, in scale order.
export function scaleNoteNames(rootPc: number, scale: number[], edo: number): string[] {
  return scale.map(s => pcToNoteName(((rootPc + s) % edo + edo) % edo, edo));
}

// Lookup helper: find the lattice node that matches an (familyName, modeName,
// rootPc) triple — used to highlight whichever tonality the picker has selected.
export function findLatticeNode(
  lattice: TonalityLattice,
  familyName: string,
  modeName: string,
  tonicPc: number,
): LatticeNode | null {
  for (const n of lattice.nodes) {
    if (n.family.familyName === familyName && n.mode.name === modeName && n.rootPc === tonicPc) {
      return n;
    }
  }
  // Fallback: if exact pc not found (e.g. user's tonic on a microtonal pc),
  // prefer the unaccidentaled C row.
  for (const n of lattice.nodes) {
    if (n.family.familyName === familyName && n.mode.name === modeName && n.key.name === "C") {
      return n;
    }
  }
  return null;
}

// ── Knot lattice (one twisted torus knot per root pc) ──────────────────
// Each root note (pitch class) is a single twisted torus knot
// T(P, Q, r, n) in 3D space.  All 49 tonalities sharing that root — 7
// families × 7 modes, i.e. every parallel-mode and modal-interchange
// option — sit on one knot together.  The user's anchor pc lands at
// the origin; modulating to a different root grows the structure with
// a new knot offset in the modulation's direction.
//
// (R, r) match three.js's TorusKnotGeometry (whose tube centre
// oscillates from R/2 to 3R/2 from origin), so the renderer can use
// TorusKnotGeometry directly for the unwound backbone and our nodes
// land exactly on it.
//
// (P, Q) is constant across every pc — a (3, 5) backbone.  The per-
// pc variation is the *twist count*: r = interval class from anchor
// (0..6).  m3 modulation gives 3 strands twisted around the backbone;
// tritone gives 6.  Anchor (r = 0) is unwound.
const KNOT_R = 8.0;
const KNOT_r = KNOT_R / 2;
const KNOT_P = 3;
const KNOT_Q = 5;
const KNOT_N = 49;             // 7 families × 7 modes per root

// 12-EDO semitone interval → interval class (= twist strand count r).
// Inversion-symmetric: m2 and M7 both give r = 1, P4 and P5 both r = 5.
const SEMIS_TO_INTERVAL_CLASS: Record<number, number> = {
  0: 0,
  1: 1,  11: 1,    // m2 / M7
  2: 2,  10: 2,    // M2 / m7
  3: 3,  9:  3,    // m3 / M6
  4: 4,  8:  4,    // M3 / m6
  5: 5,  7:  5,    // P4 / P5
  6: 6,            // TT
};

// 3D offset (unit-vector × spacing) for each interval from anchor.
// Indexed by 12-EDO-equivalent semitones modulo 12 — for 31-EDO we
// quantize the EDO interval to its nearest 12-EDO semitone for
// placement only (the actual pitch maths still uses the full EDO).
const PC_OFFSET_BY_SEMIS: Record<number, [number, number, number]> = {
  0:  [ 0,    0,    0],         // anchor
  7:  [ 1,    0,    0],         // +P5
  5:  [-1,    0,    0],         // +P4 (= −P5)
  4:  [ 0,    1,    0],         // +M3
  8:  [ 0,   -1,    0],         // −M3 (= +m6)
  3:  [ 0,    0.7,  0.7],       // +m3
  9:  [ 0,   -0.7, -0.7],       // −m3 (= +M6)
  2:  [ 0,    0,    1],         // +M2
  10: [ 0,    0,   -1],         // −M2 (= +m7)
  1:  [ 0.5,  0,    0.7],       // +m2
  11: [-0.5,  0,   -0.7],       // −m2 (= +M7)
  6:  [ 0.7,  0,   -0.7],       // tritone
};
const PC_KNOT_SPACING = 100;

// Local position on a (P, Q) torus knot at parameter t, relative to
// the knot's centre.  Matches three.js's TorusKnotGeometry path so
// that nodes built here land exactly on the rendered tube — the
// renderer applies a rotation of π/2 around X to put the carrying
// torus's axis along Y, and we negate y here to compensate.
export function knotPoint(R: number, r: number, P: number, Q: number, t: number): [number, number, number] {
  const phi   = P * t;
  const theta = Q * t;
  const ringR = R + r * Math.cos(theta);
  return [ringR * Math.cos(phi), -r * Math.sin(theta), ringR * Math.sin(phi)];
}

// Position on a CABLE around the parent's (P, Q) torus knot.  The
// cable wraps the parent's tube `wraps` times as it traverses the
// parent once, offset by `cableOffset` from the parent's tube
// centerline along the parent's local normal/binormal frame.  Used
// for modulated pc-knots so the new knot literally rides on the
// parent's tube — the parent-child relationship is geometric.
//
// `u` ∈ [0, 1) — same parameter space the parent uses (one full
// loop of the parent torus knot).
export function cablePoint(
  parentR: number, parentr: number,
  parentP: number, parentQ: number,
  parentCenter: [number, number, number],
  wraps: number, cableOffset: number,
  u: number,
): [number, number, number] {
  // Parent's point at u (local pre-translation).
  const t = u * 2 * Math.PI;
  const phi = parentP * t;
  const theta = parentQ * t;
  const ringR = parentR + parentr * Math.cos(theta);
  const px = parentCenter[0] + ringR * Math.cos(phi);
  const py = parentCenter[1] - parentr * Math.sin(theta);
  const pz = parentCenter[2] + ringR * Math.sin(phi);
  // Tangent via small finite difference along u.
  const du = 0.0005;
  const t2 = (u + du) * 2 * Math.PI;
  const phi2 = parentP * t2;
  const theta2 = parentQ * t2;
  const ringR2 = parentR + parentr * Math.cos(theta2);
  let tx = parentCenter[0] + ringR2 * Math.cos(phi2) - px;
  let ty = parentCenter[1] - parentr * Math.sin(theta2) - py;
  let tz = parentCenter[2] + ringR2 * Math.sin(phi2) - pz;
  const tlen = Math.hypot(tx, ty, tz) || 1;
  tx /= tlen; ty /= tlen; tz /= tlen;
  // Normal: up × tangent (world up = +Y).  Falls back to +X if the
  // tangent happens to be exactly ±Y.
  let nx = -tz, ny = 0, nz = tx;
  let nlen = Math.hypot(nx, ny, nz);
  if (nlen < 1e-6) { nx = 1; ny = 0; nz = 0; nlen = 1; }
  nx /= nlen; ny /= nlen; nz /= nlen;
  // Binormal = tangent × normal.
  const bx = ty * nz - tz * ny;
  const by = tz * nx - tx * nz;
  const bz = tx * ny - ty * nx;
  const alpha = wraps * 2 * Math.PI * u;
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  return [
    px + cableOffset * (ca * nx + sa * bx),
    py + cableOffset * (ca * ny + sa * by),
    pz + cableOffset * (ca * nz + sa * bz),
  ];
}

// Sample any pc-knot's curve at parameter u — branches between plain
// torus knot (anchor) and cable knot (modulated).  Renderer uses this
// for curving edges along the actual knot path.  `u` is in [0, 1) in
// the knot's local frame (anchor-equivalent mode at u = 0); for cables
// the parent's-frame parameter has cableTOffset added so the anchor-
// equivalent mode coincides with the source node's parent position.
export function sampleKnotCurve(
  cfg: KnotConfig,
  parentCfg: KnotConfig | null,
  u: number,
): [number, number, number] {
  if (cfg.parentPc !== null && parentCfg) {
    const uParent = (u + cfg.cableTOffset) % 1;
    return cablePoint(
      parentCfg.R, parentCfg.r, parentCfg.P, parentCfg.Q, parentCfg.center,
      cfg.wraps, cfg.cableOffset, uParent,
    );
  }
  const [lx, ly, lz] = knotPoint(cfg.R, cfg.r, cfg.P, cfg.Q, u * 2 * Math.PI);
  return [cfg.center[0] + lx, cfg.center[1] + ly, cfg.center[2] + lz];
}

// Per-pc expansion record.  When the user clicks a "+" ghost on a
// modulation ray to expand a new pc, we record which node was the
// source (so we know the parent pc) and the modulation's interval.
// Together these turn the new pc-knot into a cable knot wrapping the
// parent's tube with `modSemis` wraps.
export interface PcExpansion {
  sourceNodeId: string;
  modSemis: number;
}

export function buildCylinderLattice(
  edo: number,
  tonicPc: number,
  anchorFamilyName: string | null,
  anchorModeName: string | null,
  expansionInfo: Map<number, PcExpansion> = new Map(),
): TonalityLattice {
  const keys = buildKeys(edo);
  const families = LATTICE_FAMILIES;
  const modes = new Map<string, LatticeMode[]>();
  for (const family of families) {
    const modeNames = PATTERN_SCALE_FAMILIES[family.familyName] ?? [];
    const list: LatticeMode[] = [];
    for (const modeName of modeNames) {
      const m = buildMode(family, modeName, edo);
      if (m) list.push(m);
    }
    modes.set(family.id, list);
  }

  // Brightness ranks within each family (rank 0 = brightest).  Each
  // root's torus knot orders modes within a family by this rank so
  // adjacent ranks land at adjacent positions on the knot's short way.
  const familyRank = new Map<string, Map<string, number>>();
  for (const family of families) {
    const list = (modes.get(family.id) ?? []).slice()
      .sort((a, b) => b.brightness - a.brightness);
    const rmap = new Map<string, number>();
    list.forEach((m, i) => rmap.set(m.name, i));
    familyRank.set(family.id, rmap);
  }

  const anchorFamily = anchorFamilyName
    ? families.find(f => f.familyName === anchorFamilyName) ?? null
    : null;
  const anchorModeIdx = anchorFamily && anchorModeName
    ? familyRank.get(anchorFamily.id)?.get(anchorModeName) ?? 0
    : 0;
  const anchorPc = ((tonicPc % edo) + edo) % edo;

  // Pick one canonical key per unique pc (so we don't build duplicate
  // knots for enharmonic spellings like F♭ and E in 12-EDO).
  const seenPcs = new Set<number>();
  const uniqueKeys: { keyIdx: number; key: LatticeKey }[] = [];
  for (let ki = 0; ki < keys.length; ki++) {
    const k = keys[ki];
    if (seenPcs.has(k.pc)) continue;
    seenPcs.add(k.pc);
    uniqueKeys.push({ keyIdx: ki, key: k });
  }

  // Knot centre per pc.  Anchor pc at origin; everything else placed
  // at PC_OFFSET_BY_SEMIS × spacing in 3D — close consonances (P5/P4)
  // sit east/west of anchor, M3/m3 above/diagonal, M2/m2 in front of
  // / behind, tritone furthest.
  const TWO_PI = 2 * Math.PI;
  function semis12From(pcA: number, pcB: number): number {
    const delta = ((pcB - pcA) % edo + edo) % edo;
    return ((Math.round((delta / edo) * 12) % 12) + 12) % 12;
  }
  // Order on each pc-knot: k = familyIdx · 7 + modeIdx, so each
  // family is a contiguous 7-mode arc on the knot.  Shift t so the
  // user's anchor (familyIdx, modeIdx) lands at t = 0 for every knot
  // — that way "the same tonality" sits at the front of every root's
  // knot (or aligns with the source node, for cables).
  const anchorFamilyIdx = anchorFamily?.zOrd ?? 0;
  const tAnchor = ((anchorFamilyIdx * 7 + anchorModeIdx) / KNOT_N) * TWO_PI;

  const pcKnots = new Map<number, KnotConfig>();
  const nodes: LatticeNode[] = [];
  const nodeMap = new Map<string, LatticeNode>();

  // Build all nodes for one pc-knot, given its KnotConfig.  Position
  // is sampled from the appropriate curve (torus or cable).
  function buildPcNodes(key: LatticeKey, keyIdx: number, cfg: KnotConfig): void {
    const parentCfg = cfg.parentPc !== null ? pcKnots.get(cfg.parentPc) ?? null : null;
    for (const family of families) {
      const modeList = modes.get(family.id) ?? [];
      const familyIdx = family.zOrd;
      for (const mode of modeList) {
        const modeIdx = familyRank.get(family.id)?.get(mode.name) ?? 0;
        const k = familyIdx * 7 + modeIdx;
        const tRaw = (k / KNOT_N) * TWO_PI;
        const t = ((tRaw - tAnchor) % TWO_PI + TWO_PI) % TWO_PI;
        const u = t / TWO_PI;
        const pos = sampleKnotCurve(cfg, parentCfg, u);
        const id = `${keyIdx}::${family.id}::${mode.name}`;
        const node: LatticeNode = {
          id, key, keyIdx, family, mode, pos,
          rootPc: key.pc,
          knotT: t,
          modeRank: modeIdx,
        };
        nodes.push(node);
        nodeMap.set(id, node);
      }
    }
  }

  // 1. Build the anchor pc as a plain torus knot at the origin.
  const anchorKeyEntry = uniqueKeys.find(uk => uk.key.pc === anchorPc);
  if (anchorKeyEntry) {
    const cfg: KnotConfig = {
      pc: anchorPc, center: [0, 0, 0],
      R: KNOT_R, r: KNOT_r, P: KNOT_P, Q: KNOT_Q,
      intervalR: 0,
      parentPc: null, wraps: 0, cableOffset: 0, cableTOffset: 0,
    };
    pcKnots.set(anchorPc, cfg);
    buildPcNodes(anchorKeyEntry.key, anchorKeyEntry.keyIdx, cfg);
  }

  // 2. BFS-process expansions: each pc whose source node is already
  //    built becomes a cable knot wrapping the source's pc-knot.
  let progress = true;
  while (progress) {
    progress = false;
    for (const [childPc, info] of expansionInfo) {
      if (pcKnots.has(childPc)) continue;
      const sourceNode = nodeMap.get(info.sourceNodeId);
      if (!sourceNode) continue;     // wait until parent is built
      const parentPc = sourceNode.rootPc;
      const parentCfg = pcKnots.get(parentPc);
      if (!parentCfg) continue;
      const childKeyEntry = uniqueKeys.find(uk => uk.key.pc === childPc);
      if (!childKeyEntry) continue;
      const cfg: KnotConfig = {
        pc: childPc, center: [0, 0, 0],   // unused for cable knots
        R: KNOT_R, r: KNOT_r, P: KNOT_P, Q: KNOT_Q,
        intervalR: 0,
        parentPc,
        wraps: info.modSemis,
        cableOffset: parentCfg.r * 0.45,
        cableTOffset: sourceNode.knotT / TWO_PI,
      };
      pcKnots.set(childPc, cfg);
      buildPcNodes(childKeyEntry.key, childKeyEntry.keyIdx, cfg);
      progress = true;
    }
  }

  // 3. Remaining pcs (no expansion info or unresolved): fall back to
  //    a standalone torus knot at the static PC_OFFSET_BY_SEMIS slot.
  //    These are the pcs the user hasn't yet expanded; they're built
  //    so the lattice has them but the renderer hides them.
  for (const { key, keyIdx } of uniqueKeys) {
    if (pcKnots.has(key.pc)) continue;
    const semis = semis12From(anchorPc, key.pc);
    const dir = PC_OFFSET_BY_SEMIS[semis] ?? [0, 0, 0];
    const cfg: KnotConfig = {
      pc: key.pc,
      center: [dir[0] * PC_KNOT_SPACING, dir[1] * PC_KNOT_SPACING, dir[2] * PC_KNOT_SPACING],
      R: KNOT_R, r: KNOT_r, P: KNOT_P, Q: KNOT_Q,
      intervalR: SEMIS_TO_INTERVAL_CLASS[semis] ?? 0,
      parentPc: null, wraps: 0, cableOffset: 0, cableTOffset: 0,
    };
    pcKnots.set(key.pc, cfg);
    buildPcNodes(key, keyIdx, cfg);
  }

  // Edges (same musical relationships as before; only positions changed).
  const edges: LatticeEdge[] = [];

  // X-edges: same family + same mode, adjacent key.
  for (const family of families) {
    const modeList = modes.get(family.id) ?? [];
    for (const mode of modeList) {
      for (let ki = 0; ki < keys.length - 1; ki++) {
        const fromId = `${ki}::${family.id}::${mode.name}`;
        const toId = `${ki + 1}::${family.id}::${mode.name}`;
        if (nodeMap.has(fromId) && nodeMap.has(toId)) {
          edges.push({ fromId, toId, type: "x", alt: 0, color: X_EDGE_COLOR });
        }
      }
    }
  }

  // Helper: pitch-set symmetric distance / 2 between two nodes.
  const altOf = (a: LatticeNode, b: LatticeNode): number => {
    const setA = new Set(a.mode.scale.map(s => ((a.rootPc + s) % edo + edo) % edo));
    const setB = new Set(b.mode.scale.map(s => ((b.rootPc + s) % edo + edo) % edo));
    let symdiff = 0;
    for (const v of setA) if (!setB.has(v)) symdiff++;
    for (const v of setB) if (!setA.has(v)) symdiff++;
    return symdiff / 2;
  };

  // Y/Z edges: every same-root-pc pair whose alteration distance is
  // 1 or 2, so the closest neighbours of any node always read as
  // +1 / +2 rather than whatever brightness-rank-adjacent gave us
  // (which can land at +3, +4 in the more chromatic families).
  // Within-family pairs are tagged "y", cross-family "z" — the
  // renderer colours them differently.
  for (let ki = 0; ki < keys.length; ki++) {
    const subset = nodes.filter(n => n.keyIdx === ki);
    for (let i = 0; i < subset.length; i++) {
      for (let j = i + 1; j < subset.length; j++) {
        const a = subset[i], b = subset[j];
        const alt = altOf(a, b);
        if (alt !== 1 && alt !== 2) continue;
        const sameFam = a.family === b.family;
        edges.push({
          fromId: a.id,
          toId: b.id,
          type: sameFam ? "y" : "z",
          alt,
          color: sameFam ? a.family.color : Z_EDGE_COLOR,
        });
      }
    }
  }

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const n of nodes) {
    if (n.pos[0] < minX) minX = n.pos[0];
    if (n.pos[0] > maxX) maxX = n.pos[0];
    if (n.pos[1] < minY) minY = n.pos[1];
    if (n.pos[1] > maxY) maxY = n.pos[1];
    if (n.pos[2] < minZ) minZ = n.pos[2];
    if (n.pos[2] > maxZ) maxZ = n.pos[2];
  }

  return {
    keys, families, modes,
    nodes, edges, nodeMap, pcKnots,
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
  };
}

// Knot params (kept under the old name so callers don't need to be
// rewritten — the renderer just reads R/r off the per-family config now).
export const CYLINDER_PARAMS = {
  R0: KNOT_R,
  DR: 0,
  BRIGHTNESS_UNIT: 1.0,
};

// ── Modulation edges from a chosen anchor ───────────────────────────────
// For an anchor tonality, generate "modulation edges" pointing at every
// nearby destination — common key-modulation intervals (P5, P4, M2, m2,
// M3, m3, tritone), parallel-mode shifts within the same family, and
// modal-interchange siblings (same root, different family).  The
// renderer draws these as labelled rays from the anchor so the user can
// see the network of related tonalities at a glance.
export interface ModulationEdge {
  fromNode: LatticeNode;
  toNode: LatticeNode;
  kind: "interval" | "parallel" | "interchange";
  label: string;        // short label for display, e.g. "+P5", "Lyd", "Mel"
  color: string;
  // For kind === "interval", the 12-EDO semitones of the modulation
  // (used as the cable knot's wrap parameter when expanded).
  // Undefined / 0 for parallel and modal-interchange edges.
  semis?: number;
}

function intervalSteps(edo: number, semitones12: number): number {
  // Map 12-EDO semitones to the active EDO's step count.
  if (edo === 12) return semitones12;
  if (edo === 31) {
    const map12to31: Record<number, number> = {
      0: 0, 1: 2, 2: 5, 3: 8, 4: 10, 5: 13,
      6: 15, 7: 18, 8: 21, 9: 23, 10: 26, 11: 28,
    };
    return map12to31[semitones12] ?? Math.round((semitones12 / 12) * edo);
  }
  return Math.round((semitones12 / 12) * edo);
}

const INTERVAL_MODULATIONS: { semis12: number; label: string; color: string }[] = [
  { semis12: 7,  label: "+5",   color: "#9966ff" },   // up a fifth
  { semis12: 5,  label: "+4",   color: "#9966ff" },   // up a fourth
  { semis12: 2,  label: "+M2",  color: "#ff5588" },   // up a major 2nd
  { semis12: 10, label: "−M2",  color: "#ff5588" },   // down a major 2nd
  { semis12: 4,  label: "+M3",  color: "#22ddaa" },   // up a major 3rd
  { semis12: 8,  label: "−M3",  color: "#22ddaa" },   // down a major 3rd
  { semis12: 3,  label: "+m3",  color: "#3aafff" },   // up a minor 3rd
  { semis12: 9,  label: "−m3",  color: "#3aafff" },   // down a minor 3rd
  { semis12: 6,  label: "TT",   color: "#ff9933" },   // tritone
];

export function computeModulationEdges(
  lattice: TonalityLattice,
  anchor: LatticeNode,
  edo: number,
): ModulationEdge[] {
  const out: ModulationEdge[] = [];

  // 1. Interval-based key modulations: same family + same mode, root
  //    shifted by each common interval.
  for (const iv of INTERVAL_MODULATIONS) {
    const targetPc = (anchor.rootPc + intervalSteps(edo, iv.semis12)) % edo;
    const target = lattice.nodes.find(n =>
      n.family.id === anchor.family.id
      && n.mode.name === anchor.mode.name
      && n.rootPc === targetPc
    );
    if (target && target.id !== anchor.id) {
      out.push({
        fromNode: anchor,
        toNode: target,
        kind: "interval",
        label: iv.label,
        color: iv.color,
        semis: iv.semis12,
      });
    }
  }

  // 2. Parallel-mode shifts within the same family: same rootPc,
  //    different mode of the same family.
  for (const node of lattice.nodes) {
    if (node.id === anchor.id) continue;
    if (node.family.id !== anchor.family.id) continue;
    if (node.rootPc !== anchor.rootPc) continue;
    out.push({
      fromNode: anchor,
      toNode: node,
      kind: "parallel",
      label: node.mode.short,
      color: anchor.family.color,
    });
  }

  // 3. Modal interchange: same rootPc, different family.  We add one
  //    edge per family — to that family's brightness-matched mode if
  //    available, otherwise its parent (rank 0).
  const seenFamilies = new Set<string>([anchor.family.id]);
  for (const node of lattice.nodes) {
    if (node.id === anchor.id) continue;
    if (node.rootPc !== anchor.rootPc) continue;
    if (seenFamilies.has(node.family.id)) continue;
    if (node.mode.brightness !== anchor.mode.brightness) continue;
    seenFamilies.add(node.family.id);
    out.push({
      fromNode: anchor,
      toNode: node,
      kind: "interchange",
      label: node.family.short,
      color: node.family.color,
    });
  }

  return out;
}

// ── Single-key torus layout ─────────────────────────────────────────────
// All 49 modes (7 families × 7 modes) for ONE key — the user's tonic.
// Each (family, mode) pair lands on the surface of a twisted torus:
//   u (major circle) → which family.   Anchor's family at u = 0.
//   v (minor circle) → mode brightness rank within family.
//   v_twisted = v + TWIST · u so the cross-section rotates as we go
//   around — gives a twisted-torus topology rather than a flat ring.
//
// Y-edges = same family, brightness ±1 (arcs along the minor circle).
// Z-edges = cross-family pairs whose pitch sets differ by 1 note
// (chord across the surface, often a short tube between adjacent
// family rings).  No X-edges — this view is locked to a single key.
//
// Torus parameters: R = 4 (major radius), r = 1.5 (minor), TWIST = 1
// (one full minor-circle rotation per major loop).
export const TORUS_PARAMS = { R: 4.0, r: 1.5, TWIST: 1 };

export function buildSingleKeyLattice(
  edo: number,
  tonicPc: number,
  anchorFamilyName: string | null,
  anchorModeName: string | null,
): TonalityLattice {
  const families = LATTICE_FAMILIES;
  const modes = new Map<string, LatticeMode[]>();
  for (const family of families) {
    const modeNames = PATTERN_SCALE_FAMILIES[family.familyName] ?? [];
    const list: LatticeMode[] = [];
    for (const modeName of modeNames) {
      const m = buildMode(family, modeName, edo);
      if (m) list.push(m);
    }
    modes.set(family.id, list);
  }

  // Brightness ranks within each family (0 = darkest, 6 = brightest).
  const familyRank = new Map<string, Map<string, number>>();
  for (const family of families) {
    const list = (modes.get(family.id) ?? []).slice()
      .sort((a, b) => a.brightness - b.brightness);
    const rmap = new Map<string, number>();
    list.forEach((m, i) => rmap.set(m.name, i));
    familyRank.set(family.id, rmap);
  }

  const anchorFamily = anchorFamilyName
    ? families.find(f => f.familyName === anchorFamilyName) ?? null
    : null;
  const anchorRank = anchorFamily && anchorModeName
    ? familyRank.get(anchorFamily.id)?.get(anchorModeName) ?? 0
    : 0;

  // Synthetic "key" for this view — name resolved from tonicPc so the
  // labels read e.g. "C Ionian" / "F♯ Lydian" rather than blank.
  const pcNorm = ((tonicPc % edo) + edo) % edo;
  const synthKey: LatticeKey = {
    letter: "",
    accidental: "",
    name: pcToNoteName(pcNorm, edo),
    pc: pcNorm,
  };

  const { R, r, TWIST } = TORUS_PARAMS;
  const FAM_N = families.length;
  const MODE_N = 7;

  const nodes: LatticeNode[] = [];
  const nodeMap = new Map<string, LatticeNode>();

  for (const family of families) {
    const modeList = modes.get(family.id) ?? [];
    for (const mode of modeList) {
      const id = `0::${family.id}::${mode.name}`;

      // Family rotation around the major circle, anchor's family at u = 0.
      const familyOffset = anchorFamily
        ? family.zOrd - anchorFamily.zOrd
        : family.zOrd;
      const u = (familyOffset / FAM_N) * Math.PI * 2;

      // Mode rotation around the minor circle, anchor's mode at v = 0.
      const modeRank = familyRank.get(family.id)?.get(mode.name) ?? 0;
      const modeOffset = modeRank - anchorRank;
      const v = (modeOffset / MODE_N) * Math.PI * 2;

      // Twist so the cross-section rotates as we travel around the
      // major circle — gives the twisted-torus look.
      const vTwisted = v + TWIST * u;
      const cosV = Math.cos(vTwisted);
      const x = (R + r * cosV) * Math.cos(u);
      const y = r * Math.sin(vTwisted);
      const z = (R + r * cosV) * Math.sin(u);

      const node: LatticeNode = {
        id,
        key: synthKey,
        keyIdx: 0,
        family,
        mode,
        pos: [x, y, z],
        rootPc: synthKey.pc,
        knotT: 0,
        modeRank: 0,
      };
      nodes.push(node);
      nodeMap.set(id, node);
    }
  }

  // Y-edges: same family, brightness-adjacent modes.
  const edges: LatticeEdge[] = [];
  for (const family of families) {
    const list = (modes.get(family.id) ?? []).slice()
      .sort((a, b) => a.brightness - b.brightness);
    for (let i = 0; i < list.length - 1; i++) {
      const fromId = `0::${family.id}::${list[i].name}`;
      const toId   = `0::${family.id}::${list[i + 1].name}`;
      if (nodeMap.has(fromId) && nodeMap.has(toId)) {
        edges.push({ fromId, toId, type: "y", alt: 0, color: family.color });
      }
    }
  }

  // Z-edges: cross-family pairs at the same key with 1-alt distance.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.family === b.family) continue;
      const setA = new Set(a.mode.scale.map(s => ((tonicPc + s) % edo + edo) % edo));
      const setB = new Set(b.mode.scale.map(s => ((tonicPc + s) % edo + edo) % edo));
      let symdiff = 0;
      for (const v of setA) if (!setB.has(v)) symdiff++;
      for (const v of setB) if (!setA.has(v)) symdiff++;
      if (symdiff / 2 === 1) {
        edges.push({ fromId: a.id, toId: b.id, type: "z", alt: 1, color: Z_EDGE_COLOR });
      }
    }
  }

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const n of nodes) {
    if (n.pos[0] < minX) minX = n.pos[0];
    if (n.pos[0] > maxX) maxX = n.pos[0];
    if (n.pos[1] < minY) minY = n.pos[1];
    if (n.pos[1] > maxY) maxY = n.pos[1];
    if (n.pos[2] < minZ) minZ = n.pos[2];
    if (n.pos[2] > maxZ) maxZ = n.pos[2];
  }

  return {
    keys: [synthKey],
    families,
    modes,
    nodes,
    edges,
    nodeMap,
    pcKnots: new Map(),
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
  };
}

// Filter the full lattice down to "anchor's neighbourhood": every node
// reachable from the anchor within `maxHops` edge steps, with positions
// recentred so the anchor lands at world origin.  Used when the user
// wants the lattice rendered "in reference to" their selected scale —
// it strips away keys / families that don't directly relate.
export function filterToAnchor(
  lattice: TonalityLattice,
  anchorId: string,
  maxHops: number,
): TonalityLattice {
  if (!lattice.nodeMap.has(anchorId)) return lattice;

  // BFS over the edge graph.
  const reachable = new Set<string>([anchorId]);
  let frontier: Set<string> = new Set([anchorId]);
  for (let hop = 0; hop < maxHops; hop++) {
    const next = new Set<string>();
    for (const e of lattice.edges) {
      if (frontier.has(e.fromId) && !reachable.has(e.toId)) next.add(e.toId);
      if (frontier.has(e.toId) && !reachable.has(e.fromId)) next.add(e.fromId);
    }
    next.forEach(id => reachable.add(id));
    frontier = next;
    if (next.size === 0) break;
  }

  const anchor = lattice.nodeMap.get(anchorId)!;
  const [aX, aY, aZ] = anchor.pos;

  const nodes = lattice.nodes
    .filter(n => reachable.has(n.id))
    .map(n => ({
      ...n,
      pos: [n.pos[0] - aX, n.pos[1] - aY, n.pos[2] - aZ] as [number, number, number],
    }));

  const edges = lattice.edges.filter(e =>
    reachable.has(e.fromId) && reachable.has(e.toId)
  );

  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const n of nodes) {
    if (n.pos[0] < minX) minX = n.pos[0];
    if (n.pos[0] > maxX) maxX = n.pos[0];
    if (n.pos[1] < minY) minY = n.pos[1];
    if (n.pos[1] > maxY) maxY = n.pos[1];
    if (n.pos[2] < minZ) minZ = n.pos[2];
    if (n.pos[2] > maxZ) maxZ = n.pos[2];
  }

  return {
    keys: lattice.keys,
    families: lattice.families,
    modes: lattice.modes,
    nodes,
    edges,
    nodeMap,
    pcKnots: lattice.pcKnots,
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
  };
}
