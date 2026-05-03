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

// Edges: every pair within 3 alterations gets one.  Relatives all
// share the anchor's pitch set, so every relative-relative pair is
// also 0-alt — but rendering all 21 of those creates a gold hairball.
// We restrict 0-alt edges to *spokes from the anchor* so the
// "same-notes" relationship reads cleanly.
function buildEdges(nodes: ModeNode[], anchorKey: string | null): ModeEdge[] {
  const out: ModeEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = pitchSetDistance(nodes[i].pitchSet, nodes[j].pitchSet);
      if (d === 0) {
        const involvesAnchor = nodes[i].key === anchorKey || nodes[j].key === anchorKey;
        if (involvesAnchor) {
          out.push({ fromKey: nodes[i].key, toKey: nodes[j].key, alterations: 0 });
        }
        continue;
      }
      if (d === 1 || d === 2 || d === 3) {
        out.push({ fromKey: nodes[i].key, toKey: nodes[j].key, alterations: d });
      }
    }
  }
  return out;
}

// Alteration-axis layout.  Every non-anchor mode is placed on the axis
// dedicated to its alteration distance from the anchor — so 1-alt
// modes (regardless of family) all line up on one axis, 2-alt on
// another axis, and so on.  This is what makes "C Mel Minor is 1-alt
// from C Ionian" visually obvious: it sits right next to anchor on
// the 1-alt line, not buried halfway down a separate "Mel Minor"
// axis.
//
// Within each alt-axis the modes are ordered by brightness so the
// reading direction "darker → brighter" stays consistent.
//
// Axis direction per alteration distance:
//   0 (relatives, same notes) → -Y (below anchor)
//   1                          → +Y (directly above)
//   2                          → +X (right)
//   3                          → -X (left)
//   4                          → +Z (forward)
//   5                          → -Z (back)
//   6+                         → diagonal
function familyAxisLayout(
  nodes: ModeNode[],
  anchorKey: string | null,
) {
  const anchor = anchorKey ? nodes.find(n => n.key === anchorKey) : null;

  // Group every non-anchor node by its alteration distance to the
  // anchor.  Anchor itself sits at the origin.
  const byAlt = new Map<number, ModeNode[]>();
  for (const node of nodes) {
    if (anchor && node.key === anchor.key) {
      node.pos = [0, 0, 0];
      continue;
    }
    const alt = anchor ? pitchSetDistance(anchor.pitchSet, node.pitchSet) : 1;
    if (!byAlt.has(alt)) byAlt.set(alt, []);
    byAlt.get(alt)!.push(node);
  }

  // Each alteration distance gets its own world-axis direction.  This
  // is what gives the "1-alt up, 2-alt right" reading pattern.  Higher
  // distances (rare) cycle through diagonal directions.
  const ALT_DIR: [number, number, number][] = [
    [0, -1, 0],                     // 0  — relatives, same notes (below)
    [0,  1, 0],                     // 1  — up
    [1,  0, 0],                     // 2  — right
    [-1, 0, 0],                     // 3  — left
    [0,  0,  1],                    // 4  — forward
    [0,  0, -1],                    // 5  — back
    [ 0.7,  0.7,  0],               // 6  — diagonal up-right
    [-0.7,  0.7,  0],               // 7  — diagonal up-left
    [ 0.7, -0.7,  0],               // 8  — diagonal down-right
    [-0.7, -0.7,  0],               // 9  — diagonal down-left
  ];

  const SPACING = 1.3;
  // Number of "lanes" per axis — if more than this many modes share an
  // alt distance, they're spread on a small disc perpendicular to the
  // axis so they don't pile on top of each other.
  const LANE_PERP_SPREAD = 0.85;

  for (const [alt, group] of byAlt) {
    const dir = ALT_DIR[alt] ?? ALT_DIR[ALT_DIR.length - 1];
    // Order by brightness ascending: darker mode closer to anchor,
    // brighter mode further out.
    group.sort((a, b) => a.brightness - b.brightness);

    // Build a perpendicular basis for spreading nodes that share the
    // same axis position.
    const upGuess: [number, number, number] = Math.abs(dir[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    let p1: [number, number, number] = [
      dir[1] * upGuess[2] - dir[2] * upGuess[1],
      dir[2] * upGuess[0] - dir[0] * upGuess[2],
      dir[0] * upGuess[1] - dir[1] * upGuess[0],
    ];
    const p1Len = Math.hypot(p1[0], p1[1], p1[2]) || 1;
    p1 = [p1[0] / p1Len, p1[1] / p1Len, p1[2] / p1Len];
    const p2: [number, number, number] = [
      dir[1] * p1[2] - dir[2] * p1[1],
      dir[2] * p1[0] - dir[0] * p1[2],
      dir[0] * p1[1] - dir[1] * p1[0],
    ];

    // Place modes along the axis.  At each axial position, fan a small
    // perpendicular ring if the axis has many modes — clusters of more
    // than ~3 nodes per axial slot get rotated around the axis so they
    // don't stack.
    const N = group.length;
    for (let i = 0; i < N; i++) {
      const axialDist = (i + 1) * SPACING;
      // Optional fan: nodes with the same axialDist offset get angular
      // spread.  Here we just leave them on the axis since brightness
      // is already a discriminator; each mode gets its own axialDist.
      const px = dir[0] * axialDist;
      const py = dir[1] * axialDist;
      const pz = dir[2] * axialDist;
      group[i].pos = [px, py, pz];
    }
    // Suppress unused warnings about p2/LANE_PERP_SPREAD reserved for
    // a future fan-out enhancement.
    void p2; void LANE_PERP_SPREAD;
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

  const edges = buildEdges(nodes, anchorKey);
  familyAxisLayout(nodes, anchorKey);

  const byKey = new Map(nodes.map(n => [n.key, n]));
  const lattice: ModeLattice = { nodes, edges, byKey };
  _cached = { key: cacheKey, lattice };
  return lattice;
}

export function alterationFromAnchor(anchor: ModeNode, other: ModeNode): number {
  return pitchSetDistance(anchor.pitchSet, other.pitchSet);
}
