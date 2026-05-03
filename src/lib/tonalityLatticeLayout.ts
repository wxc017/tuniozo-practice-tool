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
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
  };
  _cached = { edo, lattice };
  return lattice;
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
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
  };
}
