// ── Mode-lattice layout ───────────────────────────────────────────────
// Builds the data backing the 3D mode lattice that lives in the Scalar
// Exploration tab.  Pure logic — no React, no DOM, no audio.
//
// Output:
//   - 49 mode nodes (7 families × 7 modes), each with brightness +
//     pre-computed (x, y, z) position.
//   - Edge list connecting every pair of modes whose scales differ in
//     at most 2 positions, tagged by alteration count.
//
// The layout is force-directed in the X-Z plane while Y is locked to
// the mode's brightness (sum of scale steps, normalized).  This makes
// brightness immediately readable (bright = up, dark = down) while the
// horizontal position reflects which modes share notes.

import { PATTERN_SCALE_FAMILIES } from "./musicTheory";
import { getModeDegreeMap } from "./edoData";

export interface ModeNode {
  key: string;          // unique id, e.g. "Major Family::Lydian"
  family: string;       // e.g. "Major Family"
  mode: string;         // e.g. "Lydian"
  scale: number[];      // sorted step values within one octave (length 7)
  brightness: number;   // sum of scale steps — used for Y position
  pos: [number, number, number];   // (x, y, z) after layout
}

export interface ModeEdge {
  fromKey: string;
  toKey: string;
  alterations: number;  // 1 or 2 — how many positions differ
}

export interface ModeLattice {
  nodes: ModeNode[];
  edges: ModeEdge[];
  byKey: Map<string, ModeNode>;
}

// Order families left-to-right along X; within each family modes are
// initialised at the family's X-band before force-direction takes over.
const FAMILY_ORDER = [
  "Major Family",
  "Harmonic Minor Family",
  "Melodic Minor Family",
  "Subminor Diatonic Family",
  "Neutral Diatonic Family",
  "Supermajor Diatonic Family",
  "Subharmonic Diatonic Family",
];

// Deterministic PRNG so the layout is identical every session — no
// "where did Lydian go this time?" surprise on reload.
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildNodes(edo: number): ModeNode[] {
  const out: ModeNode[] = [];
  for (const family of FAMILY_ORDER) {
    const modes = PATTERN_SCALE_FAMILIES[family] ?? [];
    for (const modeName of modes) {
      const map = getModeDegreeMap(edo, family, modeName);
      const steps = Object.values(map).sort((a, b) => a - b);
      if (steps.length !== 7) continue;
      const brightness = steps.reduce((s, v) => s + v, 0);
      out.push({
        key: `${family}::${modeName}`,
        family,
        mode: modeName,
        scale: steps,
        brightness,
        pos: [0, 0, 0],
      });
    }
  }
  return out;
}

// Per-position-displacement distance.  Two scales rooted on the same
// note: distance = number of scale-degree positions where they differ.
// Equivalent to |A symdiff B| / 2 over the pitch-class sets.
function alterationDistance(a: number[], b: number[]): number {
  const setA = new Set(a);
  let diff = 0;
  for (const v of a) if (!setA.has(v) || !b.includes(v)) {/* unreachable */}
  // Symmetric difference counted in halves.
  let symdiff = 0;
  for (const v of a) if (!b.includes(v)) symdiff++;
  for (const v of b) if (!a.includes(v)) symdiff++;
  return symdiff / 2;
}

function buildEdges(nodes: ModeNode[]): ModeEdge[] {
  const out: ModeEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = alterationDistance(nodes[i].scale, nodes[j].scale);
      if (d === 1 || d === 2) {
        out.push({ fromKey: nodes[i].key, toKey: nodes[j].key, alterations: d });
      }
    }
  }
  return out;
}

// Force-directed layout in the X-Z plane only (Y is locked to brightness).
//   - Springs attract along edges (rest length depends on alteration count).
//   - Coulomb-style repulsion between every pair keeps the cloud spread.
//   - Cooling schedule shrinks the step size each iteration.
function runForceLayout(nodes: ModeNode[], edges: ModeEdge[], rand: () => number) {
  const N = nodes.length;

  // Brightness → Y in [-3, 3].
  let bMin = Infinity, bMax = -Infinity;
  for (const n of nodes) { bMin = Math.min(bMin, n.brightness); bMax = Math.max(bMax, n.brightness); }
  const bRange = Math.max(1, bMax - bMin);
  for (const n of nodes) {
    n.pos[1] = ((n.brightness - bMin) / bRange) * 6 - 3;
  }

  // Initial X-Z scattering: family-banded along X with random jitter so
  // identical-family modes don't all start on the same point.
  const FAMILY_X: Record<string, number> = {};
  for (let i = 0; i < FAMILY_ORDER.length; i++) {
    FAMILY_X[FAMILY_ORDER[i]] = (i - (FAMILY_ORDER.length - 1) / 2) * 1.5;
  }
  for (const n of nodes) {
    n.pos[0] = (FAMILY_X[n.family] ?? 0) + (rand() - 0.5) * 1.5;
    n.pos[2] = (rand() - 0.5) * 4;
  }

  // Tunable constants.
  const REPULSION = 0.55;     // magnitude of pairwise repulsion
  const SPRING_1 = 1.0;        // attraction strength along 1-alt edges
  const SPRING_2 = 0.25;       // attraction strength along 2-alt edges (weaker)
  const REST_1 = 1.5;
  const REST_2 = 3.0;
  const ITERS = 350;
  const INITIAL_STEP = 0.18;
  const COOLING = 0.992;

  // Edge lookup for spring force.
  const edgeMap = new Map<string, ModeEdge[]>();
  for (const e of edges) {
    if (!edgeMap.has(e.fromKey)) edgeMap.set(e.fromKey, []);
    if (!edgeMap.has(e.toKey)) edgeMap.set(e.toKey, []);
    edgeMap.get(e.fromKey)!.push(e);
    edgeMap.get(e.toKey)!.push(e);
  }
  const idxByKey = new Map<string, number>();
  nodes.forEach((n, i) => idxByKey.set(n.key, i));

  const fx = new Array(N).fill(0);
  const fz = new Array(N).fill(0);

  let step = INITIAL_STEP;
  for (let iter = 0; iter < ITERS; iter++) {
    fx.fill(0);
    fz.fill(0);

    // Pairwise repulsion (X-Z only).
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const dx = nodes[i].pos[0] - nodes[j].pos[0];
        const dz = nodes[i].pos[2] - nodes[j].pos[2];
        const r2 = dx * dx + dz * dz + 0.05;
        const r = Math.sqrt(r2);
        const f = REPULSION / r2;
        const ux = dx / r, uz = dz / r;
        fx[i] += f * ux; fz[i] += f * uz;
        fx[j] -= f * ux; fz[j] -= f * uz;
      }
    }

    // Spring attraction along edges (X-Z only).
    for (const e of edges) {
      const i = idxByKey.get(e.fromKey)!;
      const j = idxByKey.get(e.toKey)!;
      const dx = nodes[j].pos[0] - nodes[i].pos[0];
      const dz = nodes[j].pos[2] - nodes[i].pos[2];
      const r = Math.sqrt(dx * dx + dz * dz + 0.0001);
      const k = e.alterations === 1 ? SPRING_1 : SPRING_2;
      const rest = e.alterations === 1 ? REST_1 : REST_2;
      const f = k * (r - rest);
      const ux = dx / r, uz = dz / r;
      fx[i] += f * ux; fz[i] += f * uz;
      fx[j] -= f * ux; fz[j] -= f * uz;
    }

    // Apply forces.
    for (let i = 0; i < N; i++) {
      nodes[i].pos[0] += step * fx[i];
      nodes[i].pos[2] += step * fz[i];
    }

    step *= COOLING;
  }
}

let _cached: { edo: number; lattice: ModeLattice } | null = null;

export function getModeLattice(edo: number): ModeLattice {
  if (_cached && _cached.edo === edo) return _cached.lattice;
  const nodes = buildNodes(edo);
  const edges = buildEdges(nodes);
  runForceLayout(nodes, edges, mulberry32(0x53cafe));
  const byKey = new Map(nodes.map(n => [n.key, n]));
  const lattice: ModeLattice = { nodes, edges, byKey };
  _cached = { edo, lattice };
  return lattice;
}

// Helper used by the renderer to highlight relations to the anchor.
export function alterationFromAnchor(
  anchor: ModeNode,
  other: ModeNode,
): number {
  return alterationDistance(anchor.scale, other.scale);
}
