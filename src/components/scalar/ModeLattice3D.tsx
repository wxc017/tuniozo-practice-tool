// ── Tonality lattice (3D) ────────────────────────────────────────────────
// Direct port of `Downloads/tonality-lattice-v2.html`, extended to seven
// families (Major / Harmonic Minor / Melodic Minor + Subminor / Neutral /
// Supermajor / Subharmonic Diatonic).  The layout is a 3D grid:
//   X = circle of fifths (15 keys, F♭ ... B♯).
//   Y = brightness (sharps relative to Major).
//   Z = family stack (7 layers from Major at front to Subharmonic
//       Diatonic at back).
//
// Click any node to drone that tonality.  The user's currently-selected
// tonality from the picker above appears highlighted at its grid cell.

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";

// ── Navigation helpers (ported from the harmonic lattice) ──────────────
// Reset the camera to a default 3/4 view whenever resetKey changes.
function CameraReset({ resetKey }: { resetKey: number }) {
  const { camera, controls } = useThree();
  const prevKey = useRef(resetKey);
  useEffect(() => {
    if (resetKey !== prevKey.current) {
      prevKey.current = resetKey;
      camera.position.set(10, 10, 36);
      camera.lookAt(0, 0, 0);
      const c = controls as { target?: { set: (x: number, y: number, z: number) => void }; update?: () => void } | null;
      if (c?.target) { c.target.set(0, 0, 0); c.update?.(); }
    }
  }, [resetKey, camera, controls]);
  return null;
}

// Arrow-key / WASD panning: move the orbit target in camera-relative
// directions.  Pan speed is scaled by camera distance so navigation
// stays usable as the user zooms in or out across the lattice.
function KeyboardPan() {
  const { controls, camera } = useThree();
  const pressed = useRef<Set<string>>(new Set());
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const d = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (e.key.startsWith("Arrow") || k === "w" || k === "a" || k === "s" || k === "d") {
        e.preventDefault();
        pressed.current.add(e.key.startsWith("Arrow") ? e.key : k);
      }
    };
    const u = (e: KeyboardEvent) => {
      pressed.current.delete(e.key);
      pressed.current.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", d);
    window.addEventListener("keyup", u);
    return () => {
      window.removeEventListener("keydown", d);
      window.removeEventListener("keyup", u);
    };
  }, []);
  useFrame(() => {
    if (!controls || pressed.current.size === 0) return;
    const c = controls as { target?: THREE.Vector3 };
    if (!c.target) return;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    // Scale step by orbit-target distance so panning feels consistent
    // whether zoomed in on a single knot or zoomed out on the whole lattice.
    const dist = camera.position.distanceTo(c.target);
    const step = Math.max(0.4, dist * 0.02);
    const d = new THREE.Vector3();
    if (pressed.current.has("ArrowLeft")  || pressed.current.has("a")) d.addScaledVector(right, -step);
    if (pressed.current.has("ArrowRight") || pressed.current.has("d")) d.addScaledVector(right,  step);
    if (pressed.current.has("ArrowUp")    || pressed.current.has("w")) d.addScaledVector(up,     step);
    if (pressed.current.has("ArrowDown")  || pressed.current.has("s")) d.addScaledVector(up,    -step);
    c.target.add(d);
    camera.position.add(d);
  });
  return null;
}

// Smoothly pan the orbit target to the focused node's position.
function CameraFocusCenter({ targetPos }: { targetPos: [number, number, number] | null }) {
  const { camera, controls } = useThree();
  const animating = useRef(false);
  const progress = useRef(0);
  const goalTarget = useRef(new THREE.Vector3());
  const startTarget = useRef(new THREE.Vector3());
  const startCamPos = useRef(new THREE.Vector3());
  const prevPos = useRef<[number, number, number] | null>(null);
  useEffect(() => {
    if (!targetPos) return;
    if (prevPos.current
        && prevPos.current[0] === targetPos[0]
        && prevPos.current[1] === targetPos[1]
        && prevPos.current[2] === targetPos[2]) return;
    prevPos.current = targetPos;
    const c = controls as { target?: THREE.Vector3 };
    if (!c?.target) return;
    startTarget.current.copy(c.target);
    startCamPos.current.copy(camera.position);
    goalTarget.current.set(...targetPos);
    progress.current = 0;
    animating.current = true;
  }, [targetPos, controls, camera]);
  useFrame(() => {
    if (!animating.current) return;
    const c = controls as { target?: THREE.Vector3; update?: () => void };
    if (!c?.target) return;
    progress.current = Math.min(1, progress.current + 0.06);
    const t = 1 - Math.pow(1 - progress.current, 3);
    const delta = new THREE.Vector3().subVectors(goalTarget.current, startTarget.current).multiplyScalar(t);
    c.target.copy(startTarget.current).add(delta);
    camera.position.copy(startCamPos.current).add(delta);
    c.update?.();
    if (progress.current >= 1) animating.current = false;
  });
  return null;
}
import { audioEngine } from "@/lib/audioEngine";
import {
  buildCylinderLattice, LATTICE_FAMILIES,
  scaleNoteNames, computeModulationEdges, sampleKnotCurve,
  intervalSteps,
  type TonalityLattice, type LatticeNode, type ModulationEdge,
  type KnotConfig, type PcExpansion,
} from "@/lib/tonalityLatticeLayout";
import { formatHalfAccidentals, getSolfege } from "@/lib/edoData";
import { formatRomanNumeral } from "@/lib/formatRoman";

interface Props {
  edo: number;
  rootPitch: number;
  tonicPc: number;
  anchorKey: string | null;     // `${family}::${mode}` from ScalarTab
  playVol?: number;
  onActiveModeChange?: (node: LatticeNode | null) => void;
}

// Harmonic-series default per-note gains.  Same logic as before:
//   degree 1 → harmonic 1   (loudest)
//   degree 5 → harmonic 3
//   degree 3 → harmonic 5
//   degree 7 → harmonic 7
//   degree 2 → harmonic 9
//   degree 4 → harmonic 11
//   degree 6 → harmonic 13
const HARMONIC_BY_DEGREE: Record<number, number> = {
  1: 1, 2: 9, 3: 5, 4: 11, 5: 3, 6: 13, 7: 7,
};
const HARMONIC_GAIN_BASE = 1.6;
function harmonicSeriesGains(scale: number[]): number[] {
  return scale.map((_, idx) => {
    const degree = idx + 1;
    const h = HARMONIC_BY_DEGREE[degree] ?? 17;
    return HARMONIC_GAIN_BASE / Math.sqrt(h);
  });
}

// Pitch-set symmetric distance — used for the alteration count we
// stamp at each edge midpoint ("+1", "+2", ...).
function altDistance(a: LatticeNode, b: LatticeNode, edo: number): number {
  const setA = new Set(a.mode.scale.map(s => ((a.rootPc + s) % edo + edo) % edo));
  const setB = new Set(b.mode.scale.map(s => ((b.rootPc + s) % edo + edo) % edo));
  let symdiff = 0;
  for (const v of setA) if (!setB.has(v)) symdiff++;
  for (const v of setB) if (!setA.has(v)) symdiff++;
  return symdiff / 2;
}

// Cable colour by modulation interval — matches the modulation-ray
// palette so the cable visually echoes the ray that spawned it.
const SEMIS_TO_MOD_COLOR: Record<number, string> = {
  7:  "#9966ff", 5:  "#9966ff",   // P5 / P4 — purple
  4:  "#22ddaa", 8:  "#22ddaa",   // ±M3    — green
  3:  "#3aafff", 9:  "#3aafff",   // ±m3    — blue
  2:  "#ff5588", 10: "#ff5588",   // ±M2    — pink
  6:  "#ff9933",                  // TT     — orange
  1:  "#cc66ff", 11: "#cc66ff",   // ±m2    — light purple
};

// Modulation interval (in semitones) → pitch-set alt count between
// the same scale rooted on those two pcs.  Determined by the chain-
// of-fifths distance: each fifth adds one accidental.
const SEMIS_TO_ALT: Record<number, number> = {
  0: 0,
  7: 1,  5: 1,    // P5 / P4
  2: 2,  10: 2,   // M2 / m7
  3: 3,  9:  3,   // m3 / M6
  4: 4,  8:  4,   // M3 / m6
  1: 5,  11: 5,   // m2 / M7
  6: 6,           // TT
};

function darken(hex: string, amount: number): string {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color("#000000"), amount);
  return `#${c.getHexString()}`;
}

// Render one pc-knot.  Every pc renders as a plain (P, Q) torus knot
// — the anchor at the origin and each modulation satellite at an
// offset centre, so all the same-mode points (e.g. all the Ionians)
// line up at the same parameter t across knots.
function PcKnot({ cfg, isAnchorPc }: {
  cfg: KnotConfig;
  isAnchorPc: boolean;
}) {
  // Every pc-knot is a standalone (P, Q) torus knot — the anchor sits
  // at the origin and each modulation satellite sits at an offset
  // centre.  Same arc structure on every knot, so the anchor-mode
  // (e.g. all the Ionians) lines up at the same parameter t across
  // every knot in the scene.
  const isSatellite = !isAnchorPc;
  const satelliteColor = isSatellite ? (SEMIS_TO_MOD_COLOR[cfg.wraps] ?? "#a4d4ff") : "#a4d4ff";
  const color = isAnchorPc ? "#88bbff" : satelliteColor;
  const emissive = isAnchorPc ? "#264466" : darken(satelliteColor, 0.7);
  const emissiveIntensity = 0.55;

  const TUBE_RADIUS = 0.18;

  return (
    <group position={cfg.center}>
      <mesh rotation={[Math.PI / 2, 0, 0]} renderOrder={1}>
        <torusKnotGeometry args={[cfg.R, TUBE_RADIUS, 240, 14, cfg.P, cfg.Q]} />
        <meshStandardMaterial
          color={color} emissive={emissive}
          emissiveIntensity={emissiveIntensity}
          roughness={0.55} metalness={0} />
      </mesh>
    </group>
  );
}

interface NodeMeshProps {
  node: LatticeNode;
  edo: number;
  isAnchor: boolean;
  isActive: boolean;
  isHovered: boolean;
  isSelected: boolean;
  onHover: (id: string | null) => void;
  onClick: (node: LatticeNode, ev: ThreeEvent<MouseEvent>) => void;
}

// One colour per alteration distance from anchor.  arc 0 (anchor) is
// neutral white; arcs 1..6 progress through a hue ramp so close
// modulations read cool and distant ones hot.
const ALT_LEVEL_COLORS = [
  "#f5f5f5",   // alt 0: anchor — white
  "#88bbff",   // alt 1: P5/P4 — light blue
  "#22ddaa",   // alt 2: M2/m7 — teal
  "#9966ff",   // alt 3: m3/M6 — purple
  "#ff9933",   // alt 4: M3/m6 — orange
  "#ff5588",   // alt 5: m2/M7 — pink
  "#ffcc33",   // alt 6: TT — yellow
];
function altColor(altLevel: number | undefined): string {
  if (altLevel === undefined || altLevel < 0) return "#888";
  return ALT_LEVEL_COLORS[Math.min(altLevel, ALT_LEVEL_COLORS.length - 1)];
}

function NodeMesh({ node, edo, isAnchor, isActive, isHovered, isSelected, onHover, onClick }: NodeMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  // Colour by alt distance from anchor — drops the family-colour ramp
  // entirely.  Brightness rank still applies a subtle dim so darker
  // modes within an arc are slightly muted.
  const rankT = node.modeRank / 6;
  const palette = altColor(node.altLevel);
  const baseColor = useMemo(() => {
    const c = new THREE.Color(palette);
    const neon = c.clone().lerp(new THREE.Color("#ffffff"), 0.35);
    const dark = c.clone().lerp(new THREE.Color("#000000"), 0.4);
    return neon.lerp(dark, rankT);
  }, [palette, rankT]);
  const emissive = baseColor;

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const target = isActive ? 1.7 : isAnchor ? 1.6 : isSelected ? 1.5 : isHovered ? 1.25 : 1.0;
    const cur = meshRef.current.scale.x;
    meshRef.current.scale.setScalar(cur + (target - cur) * Math.min(1, delta * 8));
  });

  // Anchor (the user's picker selection) is *much* bigger than the
  // other nodes so it always reads as the lattice's centre of attention.
  const r = isAnchor ? 0.55 : 0.22;

  return (
    <group position={node.pos}>
      <mesh
        ref={meshRef}
        renderOrder={2}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(node.id); }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onClick(node, e); }}>
        <sphereGeometry args={[r, 18, 14]} />
        <meshStandardMaterial
          color={baseColor}
          emissive={emissive}
          emissiveIntensity={
            (isActive ? 1.6 : isAnchor ? 1.1 : 0.7) * (1 - rankT * 0.65)
          }
          roughness={0.6}
          metalness={0}
          // Always render on top of the knot tube — without this the
          // transparent tube material renders over the sphere when
          // depths are close, clipping the node visually.
          depthTest={false}
          depthWrite={false} />
      </mesh>
      <Html center distanceFactor={isHovered || isActive || isAnchor || isSelected ? 8 : 11}
            style={{ pointerEvents: "none" }}>
        {isHovered || isActive || isAnchor || isSelected ? (
          <div style={{
            background: "#0a0a0aee",
            border: `1px solid ${palette}`,
            color: palette,
            padding: "3px 7px",
            borderRadius: 3,
            fontSize: 11,
            fontWeight: 700,
            whiteSpace: "nowrap",
            transform: "translate(0, -32px)",
            textAlign: "center",
          }}>
            <div>
              <span style={{ color: "#ddd", marginRight: 4 }}>{node.key.name}</span>
              {formatHalfAccidentals(node.mode.name)}
            </div>
            <div style={{
              fontSize: 9, fontWeight: 500, color: "#bbb",
              marginTop: 2, letterSpacing: 1,
            }}>
              {scaleNoteNames(node.rootPc, node.mode.scale, edo).join(" · ")}
            </div>
          </div>
        ) : (
          // Discrete always-on label — small, dim, no background.
          // Uses the full mode name (e.g. "D Dorian", "B♭ Mixolydian",
          // "F♯ Harmonic Minor") so the user can identify every node
          // by sight without hovering.
          <div style={{
            color: palette,
            opacity: 0.82,
            fontSize: 8.5,
            fontWeight: 600,
            whiteSpace: "nowrap",
            transform: "translate(0, -16px)",
            textShadow: "0 0 4px #000, 0 0 4px #000",
            letterSpacing: 0.2,
          }}>
            <span style={{ color: "#ddd", marginRight: 3 }}>{node.key.name}</span>
            {formatHalfAccidentals(node.mode.name)}
          </div>
        )}
      </Html>
    </group>
  );
}

interface SceneProps {
  lattice: TonalityLattice;
  edo: number;
  anchorId: string | null;
  anchorRootPc: number;
  activeId: string | null;
  hoveredId: string | null;
  selectedId: string | null;     // last-clicked node (alt-label reference)
  showRays: boolean;             // whether the modulation-ray overlay is on
  expandedRoots: Set<number>;    // pcs whose neighbourhoods are expanded
  showFamilies: Record<string, boolean>;
  showEdges: Record<string, boolean>;
  modulationEdges: ModulationEdge[];
  onHover: (id: string | null) => void;
  onClick: (node: LatticeNode, ev: ThreeEvent<MouseEvent>) => void;
  onExpand: (rootPc: number, modEdge?: ModulationEdge) => void;
  onCollapse: (rootPc: number) => void;
}

function Scene({
  lattice, edo, anchorId, anchorRootPc, activeId, hoveredId, selectedId, showRays, expandedRoots,
  showFamilies, showEdges, modulationEdges, onHover, onClick, onExpand, onCollapse,
}: SceneProps) {
  // Show every y/z edge between currently-visible nodes (those whose
  // root pc has been expanded).  Each edge curves along the torus
  // surface that holds both endpoints — we interpolate (φ, θ) along
  // the shortest angular path between the two nodes' coordinates and
  // sample the torus formula at each step.  Each edge is annotated
  // with its pitch-set symmetric distance at the curved midpoint.
  const visibleEdges = useMemo(() => {
    type Pair = {
      color: string;
      type: "y" | "z" | "bridge";
      points: [number, number, number][];
      mid: [number, number, number];
      alt: number;
      fromId: string;
      toId: string;
    };
    const NSAMPLES = 18;
    const TWO_PI = 2 * Math.PI;
    const out: Pair[] = [];
    for (const e of lattice.edges) {
      if (e.type === "x") continue;
      const a = lattice.nodeMap.get(e.fromId);
      const b = lattice.nodeMap.get(e.toId);
      if (!a || !b) continue;
      if (!expandedRoots.has(a.rootPc) || !expandedRoots.has(b.rootPc)) continue;
      if (!showFamilies[a.family.id] || !showFamilies[b.family.id]) continue;
      // Bridges aren't a user-toggleable edge type; only y/z get
      // gated on showEdges (which only has y/z keys).  Without this
      // exemption the bridges silently fall through `!showEdges["bridge"]`
      // === !undefined === true and disappear from visibleEdges.
      if (e.type !== "bridge" && !showEdges[e.type]) continue;
      // y/z edges always live within a single pc-knot — same root,
      // so both endpoints sit on the same knot.  We curve the edge
      // along the actual knot path: torus-surface (φ, θ) interpolation
      // for plain torus pcs, and cable-curve u-interpolation for
      // cable pcs.  Either way we sample the path between endpoints
      // along the shortest angular / parameter path.
      const cfg = lattice.pcKnots.get(a.rootPc);
      const parentCfg = cfg?.parentPc !== undefined && cfg?.parentPc !== null
        ? lattice.pcKnots.get(cfg.parentPc) ?? null
        : null;
      let points: [number, number, number][];
      let mid: [number, number, number];
      if (cfg && a.rootPc === b.rootPc) {
        // Sample the knot's *own* path between the two endpoints
        // (using knotPoint for torus knots or cablePoint for cables)
        // so the edge follows the knot curve itself, not an
        // independent (φ, θ) shortest-angular path on the torus.
        const uA = a.knotT / TWO_PI;
        const uB = b.knotT / TWO_PI;
        let dU = uB - uA;
        if (dU >  0.5) dU -= 1;
        if (dU < -0.5) dU += 1;
        points = [];
        for (let s = 0; s <= NSAMPLES; s++) {
          const u = ((uA + (s / NSAMPLES) * dU) % 1 + 1) % 1;
          points.push(sampleKnotCurve(cfg, parentCfg, u));
        }
        mid = points[Math.floor(points.length / 2)];
      } else {
        // Fallback (shouldn't happen for y/z which are within-knot).
        points = [a.pos, b.pos];
        mid = [
          (a.pos[0] + b.pos[0]) / 2,
          (a.pos[1] + b.pos[1]) / 2,
          (a.pos[2] + b.pos[2]) / 2,
        ];
      }
      const alt = altDistance(a, b, edo);
      out.push({
        color: e.color, type: e.type as "y" | "z" | "bridge",
        points, mid, alt,
        fromId: a.id, toId: b.id,
      });
    }
    out.sort((a, b) => (a.type === "z" ? 1 : 0) - (b.type === "z" ? 1 : 0));
    return out;
  }, [lattice, expandedRoots, showFamilies, showEdges, edo]);

  return (
    <>
      <ambientLight intensity={0.55} />
      <pointLight position={[10, 10, 10]} intensity={1.2} />
      <pointLight position={[-10, -5, -10]} intensity={0.7} />
      <pointLight position={[0, 0, 14]} intensity={0.7} />

      {/* One twisted torus knot T(P, Q, r, n) per expanded root pc.
          (P, Q) is constant — a (3, 5) trefoil-style backbone — and
          the per-pc parameter is r = interval class from anchor:
          anchor's knot stays unwound; m3 modulations spiral with 3
          strands; tritone modulations spiral with 6.  Twist count is
          a direct visual readout of *which* modulation got you here. */}
      {Array.from(lattice.pcKnots.values()).map(cfg => {
        if (!expandedRoots.has(cfg.pc)) return null;
        return (
          <PcKnot key={`pcknot-${cfg.pc}`}
                  cfg={cfg}
                  isAnchorPc={cfg.pc === anchorRootPc} />
        );
      })}

      {/* For every expanded cable, drop a small label at its source
          (the spot on the parent's tube the cable was spawned from)
          showing the modulation's alt distance — so the user can read
          "this cable is +1 alt from its parent" directly off the
          structure, without having to Ctrl-click to see rays. */}
      {Array.from(lattice.pcKnots.values()).map(cfg => {
        // Tag each satellite knot with its modulation interval (the
        // semis from the parent's anchor pc) so the user can read
        // "this is the +M2 knot" off the layout.  Anchor has
        // sourceNodeId === null and is skipped.
        if (!cfg.sourceNodeId) return null;
        if (!expandedRoots.has(cfg.pc)) return null;
        const altCount = SEMIS_TO_ALT[cfg.wraps] ?? 0;
        const cableColor = SEMIS_TO_MOD_COLOR[cfg.wraps] ?? "#a4d4ff";
        const labelPos: [number, number, number] = [
          cfg.center[0],
          cfg.center[1] + cfg.R + cfg.r + 1.2,
          cfg.center[2],
        ];
        return (
          <Html key={`sat-alt-${cfg.pc}`}
                position={labelPos} center distanceFactor={9}
                style={{ pointerEvents: "none" }}>
            <div style={{
              background: "#0a0a0add",
              border: `1px solid ${cableColor}`,
              color: cableColor,
              padding: "0 2px",
              borderRadius: 1,
              fontSize: 6,
              fontWeight: 700,
              lineHeight: "7px",
              whiteSpace: "nowrap",
            }}>
              +{altCount}
            </div>
          </Html>
        );
      })}

      {/* Modulation spokes — short clickable rays sticking out from
          the selected node, one per interval modulation.  Same UX
          as the pre-refactor cable-knot model (a "+" ghost-sphere
          close to the source with a label), just rendered against
          synthetic directions since the cross-root targets aren't
          in the lattice anymore. */}
      {showRays && selectedId && (() => {
        const sourceNode = lattice.nodeMap.get(selectedId);
        if (!sourceNode) return null;
        const sourcePos = new THREE.Vector3(...sourceNode.pos);
        const GHOST_DISTANCE = 1.6;
        const MOD_SPOKES: Array<{ label: string; color: string; dir: [number, number, number]; semis: number }> = [
          { label: "+P5", color: "#9966ff", dir: [ 1,  0,  0],     semis: 7 },
          { label: "+P4", color: "#9966ff", dir: [-1,  0,  0],     semis: 5 },
          { label: "+M3", color: "#22ddaa", dir: [ 0,  1,  0],     semis: 4 },
          { label: "−M3", color: "#22ddaa", dir: [ 0, -1,  0],     semis: 8 },
          { label: "+m3", color: "#3aafff", dir: [ 0.7, 0,  0.7],  semis: 3 },
          { label: "−m3", color: "#3aafff", dir: [-0.7, 0, -0.7],  semis: 9 },
          { label: "+M2", color: "#ff5588", dir: [ 0,  0,  1],     semis: 2 },
          { label: "−M2", color: "#ff5588", dir: [ 0,  0, -1],     semis: 10 },
          { label: "TT",  color: "#ff9933", dir: [ 0.7,  0.5, -0.7], semis: 6 },
        ];
        return MOD_SPOKES.map((m, i) => {
          const dirV = new THREE.Vector3(...m.dir).normalize().multiplyScalar(GHOST_DISTANCE);
          const endV = sourcePos.clone().add(dirV);
          const endPos: [number, number, number] = [endV.x, endV.y, endV.z];
          return (
            <group key={`spoke-${i}`}>
              <Line
                points={[sourceNode.pos, endPos]}
                color={m.color}
                lineWidth={1.6}
                transparent opacity={0.75}
                dashed dashScale={20} gapSize={0.3}
                renderOrder={3}
                depthTest={false}
                depthWrite={false} />
              <mesh
                position={endPos}
                onClick={(e: ThreeEvent<MouseEvent>) => {
                  e.stopPropagation();
                  // Click a spoke → spawn a cable knot for that
                  // modulation's target pc.  Build a synthetic
                  // ModulationEdge so the existing onExpand handler
                  // can record source + semis into pcExpansionInfo.
                  const targetPc = (sourceNode.rootPc + intervalSteps(edo, m.semis)) % edo;
                  const fakeEdge: ModulationEdge = {
                    fromNode: sourceNode,
                    toNode: sourceNode,
                    kind: "interval",
                    label: m.label,
                    color: m.color,
                    semis: m.semis,
                  };
                  onExpand(targetPc, fakeEdge);
                }}
                onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); document.body.style.cursor = "pointer"; }}
                onPointerOut={() => { document.body.style.cursor = "default"; }}>
                <sphereGeometry args={[0.12, 14, 10]} />
                <meshStandardMaterial
                  color={m.color}
                  emissive={m.color}
                  emissiveIntensity={0.5}
                  transparent opacity={0.9} />
              </mesh>
              <Html position={endPos} center distanceFactor={9}
                    style={{ pointerEvents: "none" }}>
                <div style={{
                  color: m.color,
                  fontSize: 10,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  transform: "translate(0, -18px)",
                  textShadow: "0 0 4px #000",
                  letterSpacing: 0.3,
                }}>
                  {m.label}
                </div>
              </Html>
            </group>
          );
        });
      })()}

      {/* (Old modulationEdges-based rays removed: with the same-root
          lattice they drew parallel-mode / modal-interchange "edges"
          which the user explicitly does NOT want when Ctrl-clicking.
          The synthetic spokes block above is the only modulation
          overlay.) */}

      {visibleEdges.map((e, i) => {
        // Both bridge edges (between arcs) and y-edges (alt 1/2
        // pairs) show their +N label persistently — they're the
        // lattice's primary structural readout of "how far apart are
        // these two tonalities".
        const isBridge = e.type === "bridge";
        const labelVisible = isBridge || e.type === "y" || e.type === "z";
        return (
          <group key={`${e.type}-${i}`}>
            <Line points={e.points} color={e.color}
              lineWidth={isBridge ? 3.6 : e.type === "z" ? 3.2 : 2.6}
              transparent opacity={isBridge ? 0.95 : e.type === "z" ? 1 : 0.9}
              renderOrder={2}
              depthTest={false}
              depthWrite={false} />
            {labelVisible && (
              isBridge ? (
                // Bridge labels render at fixed screen size (no
                // distanceFactor) so they're always visible regardless
                // of camera zoom — they're the lattice's primary
                // structural readout and shouldn't shrink.
                <Html position={e.mid} center
                      style={{ pointerEvents: "none" }}
                      zIndexRange={[100, 0]}>
                  <div style={{
                    background: "#0a0a0aee",
                    border: "1px solid #ccddee",
                    color: "#ffffff",
                    padding: "0 2px",
                    borderRadius: 1,
                    fontSize: 5,
                    fontWeight: 700,
                    lineHeight: "6px",
                    whiteSpace: "nowrap",
                  }}>
                    +{e.alt}
                  </div>
                </Html>
              ) : (
                <Html position={e.mid} center distanceFactor={9}
                      style={{ pointerEvents: "none" }}>
                  <div style={{
                    background: "#0a0a0acc",
                    border: `1px solid ${e.color}`,
                    color: e.color,
                    padding: "0 1px",
                    borderRadius: 1,
                    fontSize: 5,
                    fontWeight: 700,
                    lineHeight: "6px",
                    whiteSpace: "nowrap",
                  }}>
                    +{e.alt}
                  </div>
                </Html>
              )
            )}
          </group>
        );
      })}

      {lattice.nodes.map(node => {
        if (!showFamilies[node.family.id]) return null;
        // All 588 tonalities live on the unified knot now (organised
        // by alt distance from anchor) — there's no expansion gate
        // anymore, every node is visible by default.
        return (
          <NodeMesh
            key={node.id}
            node={node}
            edo={edo}
            isAnchor={anchorId === node.id}
            isActive={activeId === node.id}
            isHovered={hoveredId === node.id}
            isSelected={selectedId === node.id}
            onHover={onHover}
            onClick={onClick} />
        );
      })}

      <OrbitControls makeDefault enableDamping dampingFactor={0.15} />
    </>
  );
}

export default function ModeLattice3D({ edo, rootPitch, tonicPc, anchorKey, playVol = 0.55, onActiveModeChange }: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeNode, setActiveNode] = useState<LatticeNode | null>(null);
  const [perNoteGains, setPerNoteGains] = useState<number[]>([]);

  // Click-driven exploration state.  selectedId tracks which node has
  // its modulation rays visible; expandedRoots is the set of root pcs
  // whose 49-node neighbourhoods are rendered.  Initially only the
  // anchor's tonic is expanded — the user grows the lattice outward
  // by clicking the "+" ghost at the tip of any modulation ray, and
  // shrinks it via the "×" button on the midpoint of an expanded ray.
  // pcExpansionInfo records which modulation each pc was expanded
  // *via* (source node + interval semitones), used by the layout to
  // turn that pc's knot into a cable wrapping the source's knot.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Ray-visibility toggle: only when the user has Ctrl-clicked do we
  // render the modulation-ray overlay.  Plain clicks update selectedId
  // (so the alt labels shift to that node) but don't switch rays on.
  const [showRays, setShowRays] = useState(false);
  // Plain-click re-anchor: stores an internal lattice anchor that
  // overrides the picker prop.  When the user plain-clicks a node,
  // the lattice reorients with that node as "main scale" and arcs
  // recompute by alt distance from there.  Resets to null whenever
  // the picker (anchorKey / tonicPc props) changes externally.
  const [latticeAnchor, setLatticeAnchor] = useState<{
    tonicPc: number; familyName: string; modeName: string;
  } | null>(null);
  const effectiveTonicPc = latticeAnchor?.tonicPc ?? tonicPc;
  const anchorRootPc = useMemo(
    () => ((effectiveTonicPc % edo) + edo) % edo,
    [effectiveTonicPc, edo],
  );
  const [expandedRoots, setExpandedRoots] = useState<Set<number>>(
    () => new Set([anchorRootPc])
  );
  const [pcExpansionInfo, setPcExpansionInfo] = useState<Map<number, PcExpansion>>(
    () => new Map()
  );

  // Camera-reset counter: bumping this triggers <CameraReset> to snap
  // the orbit camera back to its default 3/4 view.
  const [cameraResetKey, setCameraResetKey] = useState(0);

  // Shift+click sets this so the orbit target smoothly animates to
  // the chosen node — overrides the default focus heuristic
  // (active → selected → anchor) until it's reset.
  const [cameraFocusId, setCameraFocusId] = useState<string | null>(null);

  // When the picker (external anchorKey / tonicPc) changes, drop any
  // internal lattice re-anchor so the picker selection takes over.
  useEffect(() => {
    setLatticeAnchor(null);
  }, [anchorKey, tonicPc]);

  // Family / edge visibility toggles.
  const [showFamilies, setShowFamilies] = useState<Record<string, boolean>>(
    Object.fromEntries(LATTICE_FAMILIES.map(f => [f.id, true]))
  );
  const [showEdges, setShowEdges] = useState<Record<string, boolean>>({
    y: true, z: true,
  });

  // Parse the anchor's family + mode out of the picker selection.
  const [pickerAnchorFamilyName, pickerAnchorModeName] = useMemo(() => {
    if (!anchorKey) return [null, null] as [string | null, string | null];
    const [f, m] = anchorKey.split("::");
    return [f ?? null, m ?? null] as [string | null, string | null];
  }, [anchorKey]);
  // Effective anchor: internal re-anchor (from plain click) overrides
  // the picker.  Used everywhere downstream for layout + lookup.
  const anchorFamilyName = latticeAnchor?.familyName ?? pickerAnchorFamilyName;
  const anchorModeName = latticeAnchor?.modeName ?? pickerAnchorModeName;

  // Reset expansion when the EFFECTIVE anchor changes — covers both
  // the picker changing externally AND the user plain-clicking a
  // node (which sets the internal latticeAnchor).
  useEffect(() => {
    setExpandedRoots(new Set([anchorRootPc]));
    setPcExpansionInfo(new Map());
    setSelectedId(null);
    setShowRays(false);
    setCameraFocusId(null);
  }, [anchorRootPc, anchorFamilyName, anchorModeName]);

  // Per-pc-knot lattice rebuilds when the effective anchor changes,
  // so plain-clicking a node reorients the entire alt-arc structure.
  const lattice = useMemo(
    () => buildCylinderLattice(edo, effectiveTonicPc, anchorFamilyName, anchorModeName, pcExpansionInfo),
    [edo, effectiveTonicPc, anchorFamilyName, anchorModeName, pcExpansionInfo]
  );

  const anchorId = useMemo(() => {
    if (!anchorFamilyName || !anchorModeName) return null;
    const family = LATTICE_FAMILIES.find(f => f.familyName === anchorFamilyName);
    if (!family) return null;
    for (const n of lattice.nodes) {
      if (n.family.id === family.id
          && n.mode.name === anchorModeName
          && n.rootPc === anchorRootPc) {
        return n.id;
      }
    }
    return null;
  }, [lattice, anchorFamilyName, anchorModeName, anchorRootPc]);

  // Modulation edges: rays from whichever node the user has selected
  // (or the anchor by default if nothing's been clicked yet).  Empty
  // until the user clicks a node, so the initial view is just the
  // anchor's column without ray clutter.  Filtered to *interval*
  // modulations only (P5, P4, M3, m3, M2, TT, etc.) — the parallel-
  // mode and modal-interchange rays are noise here since those
  // relationships are already shown by the y/z edges within each knot.
  const modulationEdges = useMemo<ModulationEdge[]>(() => {
    const sourceId = selectedId ?? anchorId;
    if (!sourceId) return [];
    const node = lattice.nodeMap.get(sourceId);
    if (!node) return [];
    return computeModulationEdges(lattice, node, edo);
  }, [lattice, selectedId, anchorId, edo]);

  useEffect(() => {
    return () => { audioEngine.stopDrone(); };
  }, []);

  // Reset drone when picker selection changes.
  useEffect(() => {
    audioEngine.stopDrone();
    setActiveId(null);
    setActiveNode(null);
    setPerNoteGains([]);
    onActiveModeChange?.(null);
  }, [anchorKey, onActiveModeChange]);

  const startDroneFor = useCallback((node: LatticeNode, gains: number[]) => {
    audioEngine.stopDrone();
    // Map node's pc + scale steps to absolute pitches.  rootPitch is
    // the tonicPc-anchored absolute pitch in the user's range; we shift
    // by (node.rootPc - tonicPc) to land on this node's actual key.
    const offset = ((node.rootPc - tonicPc) % edo + edo) % edo;
    const base = rootPitch + offset;
    const notes = node.mode.scale.map(s => base + s);
    audioEngine.startDrone(notes, edo, 0.06 * playVol * 4, gains);
  }, [rootPitch, tonicPc, edo, playVol]);

  const handleClick = useCallback((node: LatticeNode, ev: ThreeEvent<MouseEvent>) => {
    // Read the underlying DOM event for modifier keys — matches the
    // harmonic lattice's pattern, which is reliable across R3F versions.
    const native = ev.nativeEvent as MouseEvent;
    const ctrl = native.ctrlKey || native.metaKey;
    const shift = native.shiftKey;
    if (shift) {
      // Shift+click: focus the camera on this node.
      setCameraFocusId(node.id);
      return;
    }
    // Every click updates selectedId so alt labels + (when on) the
    // modulation ray overlay always shift to the last-clicked node.
    const alreadyOnForThis = showRays && selectedId === node.id;
    setSelectedId(node.id);
    if (ctrl) {
      // Ctrl+click: toggle the ray overlay.  If rays were already
      // showing FOR THIS node, turn them off; otherwise turn on so
      // the new node's rays appear.
      setShowRays(!alreadyOnForThis);
      return;
    }
    // Plain click: re-anchor the lattice on this node (so it becomes
    // the "main scale" and arcs reorient by alt distance from here),
    // then toggle the drone.  The reset useEffect on anchorRootPc
    // clears expandedRoots / pcExpansionInfo / showRays automatically.
    setLatticeAnchor({
      tonicPc: node.rootPc,
      familyName: node.family.familyName,
      modeName: node.mode.name,
    });
    if (activeId === node.id) {
      audioEngine.stopDrone();
      setActiveId(null);
      setActiveNode(null);
      setPerNoteGains([]);
      onActiveModeChange?.(null);
      return;
    }
    const gains = harmonicSeriesGains(node.mode.scale);
    setPerNoteGains(gains);
    setActiveId(node.id);
    setActiveNode(node);
    onActiveModeChange?.(node);
    startDroneFor(node, gains);
  }, [activeId, startDroneFor, onActiveModeChange, showRays, selectedId]);

  // Click a "+" ghost at the tip of a modulation ray to expand that
  // root's 49-node neighbourhood.  If the modulation is an interval
  // mod (the only kind whose target is a different pc), we also
  // record the source node + interval so the layout can turn the
  // new pc-knot into a cable wrapping the source's knot.
  const handleExpand = useCallback((rootPc: number, modEdge?: ModulationEdge) => {
    const norm = ((rootPc % edo) + edo) % edo;
    setExpandedRoots(prev => {
      const next = new Set(prev);
      next.add(norm);
      return next;
    });
    if (modEdge && modEdge.kind === "interval" && modEdge.semis !== undefined) {
      setPcExpansionInfo(prev => {
        const next = new Map(prev);
        next.set(norm, {
          sourceNodeId: modEdge.fromNode.id,
          modSemis: modEdge.semis!,
        });
        return next;
      });
    }
    // Hide the modulation-spoke overlay once the user has picked a
    // direction — otherwise the spokes keep hovering over the source
    // node after the satellite is already on screen.
    setShowRays(false);
  }, [edo]);

  // Click the mid-edge "×" on an expanded modulation to collapse that
  // neighbourhood back out of view.  Anchor's own root is structural
  // and never collapsible — the Scene also guards this, but we
  // double-check here so a stray callback can't leave the lattice empty.
  const handleCollapse = useCallback((rootPc: number) => {
    const norm = ((rootPc % edo) + edo) % edo;
    if (norm === anchorRootPc) return;
    setExpandedRoots(prev => {
      if (!prev.has(norm)) return prev;
      const next = new Set(prev);
      next.delete(norm);
      return next;
    });
    // Drop any expansion info recorded for this pc — if the user
    // re-expands later via a different modulation, the new path wins.
    setPcExpansionInfo(prev => {
      if (!prev.has(norm)) return prev;
      const next = new Map(prev);
      next.delete(norm);
      return next;
    });
    // If the user just collapsed the neighbourhood that contained the
    // currently-selected node, drop the selection so we don't keep
    // drawing rays from a now-invisible source.
    setSelectedId(prev => {
      if (!prev) return prev;
      const node = lattice.nodeMap.get(prev);
      if (!node) return prev;
      return node.rootPc === norm ? null : prev;
    });
  }, [edo, anchorRootPc, lattice]);

  const handleReset = useCallback(() => {
    audioEngine.stopDrone();
    setActiveId(null);
    setActiveNode(null);
    setPerNoteGains([]);
    setSelectedId(null);
    setShowRays(false);
    setCameraFocusId(null);
    setLatticeAnchor(null);
    setExpandedRoots(new Set([((tonicPc % edo) + edo) % edo]));
    setPcExpansionInfo(new Map());
    setCameraResetKey(k => k + 1);
    onActiveModeChange?.(null);
  }, [tonicPc, edo, onActiveModeChange]);

  // Focus target for the orbit camera.  Shift+click pins to a
  // specific node; otherwise fall back to whichever node is currently
  // the user's centre of attention — active drone, then selected
  // node, then anchor.
  const focusPos = useMemo<[number, number, number] | null>(() => {
    const id = cameraFocusId ?? activeId ?? selectedId ?? anchorId;
    if (!id) return null;
    const node = lattice.nodeMap.get(id);
    return node ? node.pos : null;
  }, [cameraFocusId, activeId, selectedId, anchorId, lattice]);

  const updateGain = useCallback((index: number, value: number) => {
    if (!activeNode) return;
    const next = [...perNoteGains];
    next[index] = value;
    setPerNoteGains(next);
    startDroneFor(activeNode, next);
  }, [activeNode, perNoteGains, startDroneFor]);

  const resetGains = useCallback(() => {
    if (!activeNode) return;
    const gains = harmonicSeriesGains(activeNode.mode.scale);
    setPerNoteGains(gains);
    startDroneFor(activeNode, gains);
  }, [activeNode, startDroneFor]);

  const solfege = useMemo(() => getSolfege(edo), [edo]);

  // Initial camera position — close enough to see the anchor knot
  // clearly at startup; the user zooms out (or expands neighbouring
  // roots) as they grow the structure.
  const cameraPos: [number, number, number] = [10, 10, 36];

  return (
    <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded overflow-hidden">
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap border-b border-[#1a1a1a]">
        <p className="text-[10px] tracking-wider font-semibold text-[#888] mr-2">
          TONALITY LATTICE · {expandedRoots.size} {expandedRoots.size === 1 ? "KEY" : "KEYS"} EXPANDED
        </p>
        <button
          onClick={handleReset}
          className="text-[9px] px-2 py-0.5 rounded border border-[#2a2a2a] bg-[#141414] text-[#888] hover:text-[#ccc]">
          reset
        </button>
        <button
          onClick={() => setCameraResetKey(k => k + 1)}
          className="text-[9px] px-2 py-0.5 rounded border border-[#2a2a2a] bg-[#141414] text-[#888] hover:text-[#ccc] mr-2"
          title="Reset camera view (orbit position, zoom, target)">
          reset view
        </button>
      </div>

      <div style={{ height: 540, background: "#050b16" }}>
        <Canvas camera={{ position: cameraPos, fov: 45 }}>
          <CameraReset resetKey={cameraResetKey} />
          <KeyboardPan />
          <CameraFocusCenter targetPos={focusPos} />
          <Scene
            lattice={lattice}
            edo={edo}
            anchorId={anchorId}
            anchorRootPc={anchorRootPc}
            activeId={activeId}
            hoveredId={hoveredId}
            selectedId={selectedId}
            showRays={showRays}
            expandedRoots={expandedRoots}
            showFamilies={showFamilies}
            showEdges={showEdges}
            modulationEdges={modulationEdges}
            onHover={setHoveredId}
            onClick={handleClick}
            onExpand={handleExpand}
            onCollapse={handleCollapse} />
        </Canvas>
      </div>

      {activeNode && (
        <div className="px-3 py-2 border-t border-[#1a1a1a] bg-[#0d0d0d]">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[10px] tracking-wider font-semibold"
                  style={{ color: activeNode.family.color }}>
              DRONE MIXER · {activeNode.key.name} {formatHalfAccidentals(activeNode.mode.name)}
            </span>
            <button onClick={resetGains}
              className="text-[9px] px-2 py-0.5 rounded border border-[#2a2a2a] bg-[#141414] text-[#888] hover:text-[#ccc]">
              reset
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {activeNode.mode.scale.map((step, i) => {
              const isRoot = step === 0;
              const harmonicDefaults = harmonicSeriesGains(activeNode.mode.scale);
              const v = perNoteGains[i] ?? harmonicDefaults[i];
              const label = solfege ? solfege[step] : `step ${step}`;
              return (
                <div key={i}
                     className="flex flex-col items-center px-2 py-1 rounded border border-[#1f1f1f] bg-[#0a0a0a]"
                     style={{ minWidth: 56 }}>
                  <span className="text-[10px] font-bold"
                        style={{ color: isRoot ? activeNode.family.color : "#aaa" }}>
                    {label}
                  </span>
                  <input type="range" min={0} max={2} step={0.01} value={v}
                    onChange={(e) => updateGain(i, parseFloat(e.target.value))}
                    style={{ width: 56, accentColor: isRoot ? activeNode.family.color : "#666" }} />
                  <span className="text-[8px] text-[#555]">{v.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Info strip — shows the active or hovered node's notes so the
          user can read them without zooming into the floating label. */}
      {(() => {
        const focus = activeNode
          ?? (hoveredId ? lattice.nodeMap.get(hoveredId) ?? null : null)
          ?? (anchorId  ? lattice.nodeMap.get(anchorId)  ?? null : null);
        if (!focus) return null;
        const notes = scaleNoteNames(focus.rootPc, focus.mode.scale, edo);
        return (
          <div className="px-3 py-2 border-t border-[#1a1a1a] bg-[#0d0d0d]"
               style={{ borderTopColor: focus.family.color + "30" }}>
            <div className="flex items-baseline gap-3 flex-wrap">
              <span style={{ color: focus.family.color, fontSize: 13, fontWeight: 700 }}>
                {focus.key.name} {formatHalfAccidentals(focus.mode.name)}
              </span>
              <span className="text-[9px] text-[#666] tracking-wider">
                {focus.family.label.toUpperCase()}
              </span>
              <span className="ml-auto text-[10px] text-[#888] font-mono tracking-wider">
                {notes.join("   ")}
              </span>
            </div>
          </div>
        );
      })()}

      <div className="px-3 py-1.5 text-[9px] text-[#555] border-t border-[#1a1a1a] flex items-center gap-3">
        <span>Click a node to drone it; <b>Ctrl+click</b> to show its modulation rays; <b>Shift+click</b> to focus the camera on it.  Drag to orbit, scroll to zoom, <b>WASD / arrow keys</b> to pan.  Click "+" to grow a key into the lattice; click "×" on the mid-edge to collapse it back.</span>
        {activeNode && (
          <span style={{ color: activeNode.family.color }}>
            playing: {activeNode.key.name} {formatHalfAccidentals(activeNode.mode.name)}
          </span>
        )}
      </div>
    </div>
  );
}

// Suppress unused import warning if formatRomanNumeral isn't referenced
// from this file's UI yet — kept in scope so future selection/info
// panels can show Roman numerals consistently with the rest of the tab.
void formatRomanNumeral;
