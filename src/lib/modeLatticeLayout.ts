// ── Mode-lattice layout ───────────────────────────────────────────────
// Radial shell layout centered on the user-selected anchor mode.
//   - Anchor sits at the origin.
//   - Concentric shells at increasing radii hold every other mode,
//     keyed by alteration distance from the anchor (= |pitchSet
//     symdiff anchorPitchSet| / 2).
//   - 0-alteration shell holds "relatives" — modes sharing the anchor's
//     pitch set on different roots (e.g. D Dorian for C Major).
//   - Each shell uses a different angular orientation so the shape
//     reads as a complex multi-axis sphere rather than concentric rings.
//   - Brightness biases the Y component slightly so within a shell,
//     brighter modes float upward.

import { PATTERN_SCALE_FAMILIES } from "./musicTheory";
import { getModeDegreeMap } from "./edoData";

export interface ModeNode {
  key: string;
  family: string;
  mode: string;
  rootPcOffset: number;     // pc offset from the user's tonic (0 = on tonic)
  scale: number[];          // step values from this node's own root
  pitchSet: number[];       // sorted pitch classes mod edo (relative to tonic)
  brightness: number;
  pos: [number, number, number];
  isRelative: boolean;      // true for satellites that share the anchor's notes
}

export interface ModeEdge {
  fromKey: string;
  toKey: string;
  alterations: number;      // 0, 1, 2, 3
}

export interface ModeLattice {
  nodes: ModeNode[];
  edges: ModeEdge[];
  byKey: Map<string, ModeNode>;
}

const FAMILY_ORDER = [
  "Major Family",
  "Harmonic Minor Family",
  "Melodic Minor Family",
  "Subminor Diatonic Family",
  "Neutral Diatonic Family",
  "Supermajor Diatonic Family",
  "Subharmonic Diatonic Family",
];

function sortedSteps(degMap: Record<string, number>): number[] {
  return Object.values(degMap).sort((a, b) => a - b);
}

function buildPitchSet(rootPcOffset: number, scale: number[], edo: number): number[] {
  return scale.map(s => ((rootPcOffset + s) % edo + edo) % edo).sort((a, b) => a - b);
}

function pitchSetDistance(a: number[], b: number[]): number {
  const setA = new Set(a);
  let symdiff = 0;
  for (const v of a) if (!b.includes(v)) symdiff++;
  for (const v of b) if (!setA.has(v)) symdiff++;
  return symdiff / 2;
}

// All 49 parallel modes rooted on the user's tonic (rootPcOffset = 0).
function buildParallelNodes(edo: number): ModeNode[] {
  const out: ModeNode[] = [];
  for (const family of FAMILY_ORDER) {
    const modes = PATTERN_SCALE_FAMILIES[family] ?? [];
    for (const modeName of modes) {
      const scale = sortedSteps(getModeDegreeMap(edo, family, modeName));
      if (scale.length !== 7) continue;
      out.push({
        key: `${family}::${modeName}::r0`,
        family,
        mode: modeName,
        rootPcOffset: 0,
        scale,
        pitchSet: buildPitchSet(0, scale, edo),
        brightness: scale.reduce((s, v) => s + v, 0),
        pos: [0, 0, 0],
        isRelative: false,
      });
    }
  }
  return out;
}

// 6 relative satellites for the anchor — the other rotations of its
// family parent on different roots, all sharing the anchor's pitch set.
//
// Math: anchor mode i with absolute root R_anchor implies all rotations
// share a "base offset" A = R_anchor - parent[i-1].  Mode m's relative
// root = A + parent[m-1].  Working in (pc - tonic) space, R_anchor of
// the parallel anchor is 0, so A = -parent[i-1] mod edo.
function buildRelativeNodes(
  anchorFamily: string,
  anchorMode: string,
  edo: number,
): ModeNode[] {
  const familyModes = PATTERN_SCALE_FAMILIES[anchorFamily];
  if (!familyModes) return [];
  const anchorIdx = familyModes.indexOf(anchorMode);
  if (anchorIdx < 0) return [];

  // The "parent" scale = mode 1's intervals.  All modes are rotations
  // of this parent.
  const parent = sortedSteps(getModeDegreeMap(edo, anchorFamily, familyModes[0]));
  if (parent.length !== 7) return [];

  const A = ((0 - parent[anchorIdx]) % edo + edo) % edo;

  const out: ModeNode[] = [];
  for (let m = 0; m < familyModes.length; m++) {
    if (m === anchorIdx) continue;
    const modeName = familyModes[m];
    const scale = sortedSteps(getModeDegreeMap(edo, anchorFamily, modeName));
    if (scale.length !== 7) continue;
    const rootPcOffset = (A + parent[m]) % edo;
    out.push({
      key: `${anchorFamily}::${modeName}::r${rootPcOffset}`,
      family: anchorFamily,
      mode: modeName,
      rootPcOffset,
      scale,
      pitchSet: buildPitchSet(rootPcOffset, scale, edo),
      brightness: scale.reduce((s, v) => s + v, 0),
      pos: [0, 0, 0],
      isRelative: true,
    });
  }
  return out;
}

// Edges: every pair within 3 alterations gets one.  Relatives share the
// anchor's pitch set so their distance is 0 from the anchor (the
// "same-notes" edge).
function buildEdges(nodes: ModeNode[]): ModeEdge[] {
  const out: ModeEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = pitchSetDistance(nodes[i].pitchSet, nodes[j].pitchSet);
      if (d === 0 || d === 1 || d === 2 || d === 3) {
        out.push({ fromKey: nodes[i].key, toKey: nodes[j].key, alterations: d });
      }
    }
  }
  return out;
}

// Radial shell layout.  Anchor at origin.  Each non-anchor node sits on
// a shell whose radius is proportional to its alteration distance from
// the anchor.  Within a shell, the Fibonacci spiral spreads nodes
// evenly across the sphere; each shell's spiral starts from a different
// "pole" (rotated golden-angle offset) so the alteration classes occupy
// visually distinct axes — the user reads the structure as a complex
// many-axis sphere rather than concentric rings.
function radialLayout(
  nodes: ModeNode[],
  anchorKey: string | null,
) {
  const anchorIdx = anchorKey ? nodes.findIndex(n => n.key === anchorKey) : -1;
  const anchor = anchorIdx >= 0 ? nodes[anchorIdx] : null;

  // Group nodes by distance bucket.
  const buckets = new Map<number, ModeNode[]>();
  for (const node of nodes) {
    if (anchor && node.key === anchor.key) {
      node.pos = [0, 0, 0];
      continue;
    }
    const d = anchor ? pitchSetDistance(anchor.pitchSet, node.pitchSet) : 1;
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d)!.push(node);
  }

  const SHELL_RADIUS = (d: number) => 0.7 + d * 1.4;
  const GOLDEN = Math.PI * (1 + Math.sqrt(5));

  // Brightness range for the per-node Y bias.
  let bMin = Infinity, bMax = -Infinity;
  for (const n of nodes) { bMin = Math.min(bMin, n.brightness); bMax = Math.max(bMax, n.brightness); }
  const bRange = Math.max(1, bMax - bMin);

  for (const [d, bucket] of buckets) {
    const r = SHELL_RADIUS(d);
    // Per-shell rotation offset so the alteration classes occupy
    // different axes — 0-alt clusters near +Y, 1-alt near +X, 2-alt
    // near +Z, 3-alt diagonal.
    const polarTilt = (d * 1.05) % (Math.PI * 0.95);
    const azimuthOffset = d * 1.7;

    const N = bucket.length;
    for (let i = 0; i < N; i++) {
      const k = i + 0.5;
      // Standard Fibonacci-sphere spiral with per-shell tilt + offset.
      const yFrac = 1 - 2 * k / N;
      const phi = Math.acos(yFrac);
      const theta = GOLDEN * k + azimuthOffset;

      // Rotate the spiral's "north pole" so each shell points along a
      // different cardinal direction.  d = 0 → +Y, 1 → +X, 2 → -Y,
      // 3 → +Z, 4 → -X, 5 → -Z, then repeats.
      const POLE_DIRS: [number, number, number][] = [
        [0, 1, 0], [1, 0, 0], [0, -1, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1],
      ];
      const poleIdx = d % POLE_DIRS.length;
      const pole = POLE_DIRS[poleIdx];

      // Build a local frame (u, v, w=pole) and place the spiral on it.
      // pre-rotated point on canonical sphere (north pole at +Y)
      const px = Math.sin(phi) * Math.cos(theta);
      const py = Math.cos(phi);
      const pz = Math.sin(phi) * Math.sin(theta);

      // Rotate canonical (+Y pole) frame into pole direction.  Build
      // rotation that maps (0,1,0) → pole.
      let rx: number, ry: number, rz: number;
      if (Math.abs(pole[1] - 1) < 1e-9) {
        // Already at +Y pole.
        rx = px; ry = py; rz = pz;
      } else if (Math.abs(pole[1] + 1) < 1e-9) {
        // Flip to -Y.
        rx = px; ry = -py; rz = -pz;
      } else {
        // Rodrigues for general rotation from (0,1,0) to pole.
        const ax = pole[2];
        const ay = 0;
        const az = -pole[0];
        const al = Math.sqrt(ax * ax + az * az) || 1;
        const axis = [ax / al, ay / al, az / al];
        const cos = pole[1];
        const sin = al;
        const k1 = (axis[0] * px + axis[1] * py + axis[2] * pz) * (1 - cos);
        rx = px * cos + (axis[1] * pz - axis[2] * py) * sin + axis[0] * k1;
        ry = py * cos + (axis[2] * px - axis[0] * pz) * sin + axis[1] * k1;
        rz = pz * cos + (axis[0] * py - axis[1] * px) * sin + axis[2] * k1;
      }

      // Apply per-shell polar tilt — small wobble so shells don't
      // perfectly nest.
      const ct = Math.cos(polarTilt), st = Math.sin(polarTilt);
      const fx = rx * ct + rz * st;
      const fy = ry;
      const fz = -rx * st + rz * ct;

      // Brightness Y bias (within shell, bright floats up).
      const bBias = ((bucket[i].brightness - bMin) / bRange - 0.5) * 0.6;

      bucket[i].pos = [fx * r, fy * r + bBias, fz * r];
    }
  }
}

let _cached: { key: string; lattice: ModeLattice } | null = null;

export function getModeLattice(
  edo: number,
  anchorFamily: string | null,
  anchorMode: string | null,
): ModeLattice {
  const cacheKey = `${edo}::${anchorFamily ?? "_"}::${anchorMode ?? "_"}`;
  if (_cached && _cached.key === cacheKey) return _cached.lattice;

  const parallel = buildParallelNodes(edo);
  const relatives = (anchorFamily && anchorMode)
    ? buildRelativeNodes(anchorFamily, anchorMode, edo)
    : [];
  const nodes = [...parallel, ...relatives];

  const anchorKey = (anchorFamily && anchorMode)
    ? `${anchorFamily}::${anchorMode}::r0`
    : null;

  const edges = buildEdges(nodes);
  radialLayout(nodes, anchorKey);

  const byKey = new Map(nodes.map(n => [n.key, n]));
  const lattice: ModeLattice = { nodes, edges, byKey };
  _cached = { key: cacheKey, lattice };
  return lattice;
}

export function alterationFromAnchor(anchor: ModeNode, other: ModeNode): number {
  return pitchSetDistance(anchor.pitchSet, other.pitchSet);
}
