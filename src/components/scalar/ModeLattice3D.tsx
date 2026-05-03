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
  scaleNoteNames, computeModulationEdges,
  type TonalityLattice, type LatticeNode, type ModulationEdge,
  type KnotConfig,
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

// One strand of a T(P, Q, r, n) twisted torus knot — a helical path
// that orbits the (P, Q) backbone with `twistN` full twists per
// t-loop, indexed as one of `strandCount` adjacent strands offset by
// `strandOffset` from the spine.  When r ≥ 2 we render `r` of these
// in parallel so the bundle visibly twists around itself.
class TwistedTorusKnotStrand extends THREE.Curve<THREE.Vector3> {
  constructor(
    private R: number, private r: number,
    private P: number, private Q: number,
    private strandIdx: number, private strandCount: number,
    private twistN: number, private strandOffset: number,
  ) { super(); }

  override getPoint(u: number, optionalTarget?: THREE.Vector3): THREE.Vector3 {
    const target = optionalTarget ?? new THREE.Vector3();
    const t = u * 2 * Math.PI;
    // (P, Q) torus knot path — matches three.js TorusKnotGeometry
    // (rotated π/2 around X so the carrying torus's axis is +Y).
    const phi = this.P * t;
    const theta = this.Q * t;
    const ringR = this.R + this.r * Math.cos(theta);
    const cx = ringR * Math.cos(phi);
    const cy = -this.r * Math.sin(theta);
    const cz = ringR * Math.sin(phi);
    // Tangent via tiny finite difference.
    const dt = 0.0005;
    const t2 = (u + dt) * 2 * Math.PI;
    const phi2 = this.P * t2;
    const theta2 = this.Q * t2;
    const ringR2 = this.R + this.r * Math.cos(theta2);
    let tx = ringR2 * Math.cos(phi2) - cx;
    let ty = -this.r * Math.sin(theta2) - cy;
    let tz = ringR2 * Math.sin(phi2) - cz;
    const tlen = Math.hypot(tx, ty, tz) || 1;
    tx /= tlen; ty /= tlen; tz /= tlen;
    // Normal = up × tangent.
    let nx = -tz, ny = 0, nz = tx;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen; ny /= nlen; nz /= nlen;
    // Binormal = tangent × normal.
    const bx = ty * nz - tz * ny;
    const by = tz * nx - tx * nz;
    const bz = tx * ny - ty * nx;
    // Strand angle: base offset by strand index, plus n full twists
    // accumulated over the t-loop.
    const alpha = (this.strandIdx / this.strandCount) * 2 * Math.PI + this.twistN * t;
    const ca = Math.cos(alpha), sa = Math.sin(alpha);
    return target.set(
      cx + this.strandOffset * (ca * nx + sa * bx),
      cy + this.strandOffset * (ca * ny + sa * by),
      cz + this.strandOffset * (ca * nz + sa * bz),
    );
  }
}

// Render one pc's knot as either a plain (P, Q) torus knot (anchor,
// r = 0) or as `r` strands twisting around the (P, Q) backbone with
// one full twist (r ≥ 2).  Twist count = interval class from anchor:
// m3 modulations are 3-stranded, TT modulations are 6-stranded.
function PcKnot({ cfg, isAnchorPc }: { cfg: KnotConfig; isAnchorPc: boolean }) {
  const r = cfg.intervalR;
  const strandCount = Math.max(2, r);
  // Twist count = r, so distant modulations don't just look like
  // "more strands" but visibly *spiral more* per loop.  Anchor (r=0)
  // is rendered separately as a plain (P, Q) torus knot.
  const TWIST_N = Math.max(2, r);
  const STRAND_OFFSET = 1.6;
  const STRAND_TUBE = 0.18;

  const strands = useMemo(() => {
    if (r === 0) return [];
    return Array.from({ length: strandCount }, (_, i) =>
      new TwistedTorusKnotStrand(
        cfg.R, cfg.r, cfg.P, cfg.Q,
        i, strandCount, TWIST_N, STRAND_OFFSET,
      )
    );
  }, [cfg.R, cfg.r, cfg.P, cfg.Q, r, strandCount, TWIST_N]);

  const color = isAnchorPc ? "#88bbff" : "#5577aa";
  const emissive = isAnchorPc ? "#264466" : "#101a26";
  const emissiveIntensity = isAnchorPc ? 0.55 : 0.25;
  const opacity = isAnchorPc ? 0.75 : 0.5;

  // Faint shell of the carrying torus the knot lives on.  Helps the
  // user read the (R, r) torus shape that the knot/strand bundle is
  // wound around, without visually competing with the strands.
  const shell = (
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[cfg.R, cfg.r, 18, 64]} />
      <meshStandardMaterial
        color={isAnchorPc ? "#3a4a66" : "#2a3340"}
        transparent opacity={0.09}
        side={THREE.DoubleSide}
        depthWrite={false} />
    </mesh>
  );

  if (r === 0) {
    return (
      <group position={cfg.center}>
        {shell}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusKnotGeometry args={[cfg.R, 0.18, 240, 14, cfg.P, cfg.Q]} />
          <meshStandardMaterial
            color={color} emissive={emissive}
            emissiveIntensity={emissiveIntensity}
            roughness={0.55} metalness={0.35}
            transparent opacity={opacity}
            depthWrite={false} />
        </mesh>
      </group>
    );
  }

  return (
    <group position={cfg.center}>
      {shell}
      {strands.map((curve, i) => (
        <mesh key={i}>
          <tubeGeometry args={[curve, 320, STRAND_TUBE, 8, true]} />
          <meshStandardMaterial
            color={color} emissive={emissive}
            emissiveIntensity={emissiveIntensity}
            roughness={0.55} metalness={0.35}
            transparent opacity={opacity}
            depthWrite={false} />
        </mesh>
      ))}
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

function NodeMesh({ node, edo, isAnchor, isActive, isHovered, isSelected, onHover, onClick }: NodeMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  // Single smooth colour ramp from "neon" (rank 0, family hue lerped
  // toward white) to "near-black" (rank 6, family hue lerped toward
  // black) with linear interpolation in between.  No opacity scaling
  // — the gradient lives entirely in colour + emissive intensity so
  // the nodes stay fully solid and easy to see against the knot tube.
  const rankT = node.modeRank / 6;
  const baseColor = useMemo(() => {
    const family = new THREE.Color(node.family.color);
    const neon = family.clone().lerp(new THREE.Color("#ffffff"), 0.55);
    const dark = family.clone().lerp(new THREE.Color("#000000"), 0.88);
    return neon.lerp(dark, rankT);
  }, [node.family.color, rankT]);
  const emissive = baseColor;

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const target = isActive ? 1.6 : isAnchor ? 1.4 : isSelected ? 1.45 : isHovered ? 1.2 : 1.0;
    const cur = meshRef.current.scale.x;
    meshRef.current.scale.setScalar(cur + (target - cur) * Math.min(1, delta * 8));
  });

  const r = isAnchor ? 0.32 : 0.22;

  return (
    <group position={node.pos}>
      <mesh
        ref={meshRef}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(node.id); }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onClick(node, e); }}>
        <sphereGeometry args={[r, 18, 14]} />
        <meshStandardMaterial
          color={baseColor}
          emissive={emissive}
          // Smooth emissive falloff matching the colour ramp:
          // brightest mode glows hard, darkest barely glows.  No
          // opacity transparency — the dimming is entirely in light.
          emissiveIntensity={
            (isActive ? 1.3 : isAnchor ? 0.9 : 0.45) * (1 - rankT * 0.85)
          }
          roughness={0.3}
          metalness={0.45} />
      </mesh>
      <Html center distanceFactor={isHovered || isActive || isAnchor || isSelected ? 8 : 11}
            style={{ pointerEvents: "none" }}>
        {isHovered || isActive || isAnchor || isSelected ? (
          <div style={{
            background: "#0a0a0aee",
            border: `1px solid ${node.family.color}`,
            color: node.family.color,
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
          // Includes the key's root letter alongside the mode short
          // name (e.g. "D Dor", "B♭ Mix", "F♯ HMn") so the user can
          // identify every node by sight without hovering.
          <div style={{
            color: node.family.color,
            opacity: 0.82,
            fontSize: 8.5,
            fontWeight: 600,
            whiteSpace: "nowrap",
            transform: "translate(0, -16px)",
            textShadow: "0 0 4px #000, 0 0 4px #000",
            letterSpacing: 0.2,
          }}>
            <span style={{ color: "#ddd", marginRight: 3 }}>{node.key.name}</span>
            {formatHalfAccidentals(node.mode.short)}
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
  selectedId: string | null;     // node whose modulation rays are visible
  expandedRoots: Set<number>;    // pcs whose neighbourhoods are expanded
  showFamilies: Record<string, boolean>;
  showEdges: Record<string, boolean>;
  modulationEdges: ModulationEdge[];
  onHover: (id: string | null) => void;
  onClick: (node: LatticeNode, ev: ThreeEvent<MouseEvent>) => void;
  onExpand: (rootPc: number) => void;
  onCollapse: (rootPc: number) => void;
}

function Scene({
  lattice, edo, anchorId, anchorRootPc, activeId, hoveredId, selectedId, expandedRoots,
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
      type: "y" | "z";
      points: [number, number, number][];
      mid: [number, number, number];
      alt: number;
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
      if (!showEdges[e.type]) continue;
      // y/z edges always live within a single pc-knot — same root,
      // so both endpoints sit on the same torus.  Interpolate (φ, θ)
      // along the shortest angular path and sample 3D positions back
      // out of the torus parameterisation.
      const cfg = lattice.pcKnots.get(a.rootPc);
      let points: [number, number, number][];
      let mid: [number, number, number];
      if (cfg && a.rootPc === b.rootPc) {
        const phiA = cfg.P * a.knotT;
        const thetaA = cfg.Q * a.knotT;
        const phiB = cfg.P * b.knotT;
        const thetaB = cfg.Q * b.knotT;
        // Reduce to the shortest signed angular difference in [-π, π].
        // φ and θ are multi-wound (φ goes up to P·2π) so a single 2π
        // shift isn't enough — first take the difference modulo 2π,
        // then flip sign if it exceeds π.
        const shortestAngle = (raw: number): number => {
          let x = ((raw % TWO_PI) + TWO_PI) % TWO_PI;
          if (x > Math.PI) x -= TWO_PI;
          return x;
        };
        const dPhi = shortestAngle(phiB - phiA);
        const dTheta = shortestAngle(thetaB - thetaA);
        points = [];
        for (let s = 0; s <= NSAMPLES; s++) {
          const u = s / NSAMPLES;
          const phi = phiA + u * dPhi;
          const theta = thetaA + u * dTheta;
          const ringR = cfg.R + cfg.r * Math.cos(theta);
          points.push([
            cfg.center[0] + ringR * Math.cos(phi),
            cfg.center[1] - cfg.r * Math.sin(theta),
            cfg.center[2] + ringR * Math.sin(phi),
          ]);
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
      out.push({ color: e.color, type: e.type as "y" | "z", points, mid, alt });
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

      {/* Modulation rays from the user-selected node.  Drawn last so
          they sit on top of regular edges.  Three states per ray:
          - Destination root not expanded: dashed line ending in a
            "+" ghost marker the user can click to grow that key's
            neighbourhood into the lattice.
          - Destination expanded: solid line, with a small "×" toggle
            button at the midpoint that collapses the expansion when
            clicked.  We never offer a collapse button on the anchor's
            own root — that one is structural and always shown. */}
      {selectedId && modulationEdges.map((m, i) => {
        const expanded = expandedRoots.has(m.toNode.rootPc);
        const isAnchorTarget = m.toNode.rootPc === anchorRootPc;
        const fromV = new THREE.Vector3(...m.fromNode.pos);
        const toV   = new THREE.Vector3(...m.toNode.pos);
        // Ghost marker at 60% of the way out — only used when collapsed.
        const ghostV = expanded
          ? toV
          : fromV.clone().lerp(toV, 0.6);
        // Midpoint marker (for the "×" collapse toggle when expanded).
        const midV = fromV.clone().lerp(toV, 0.5);
        return (
          <group key={`mod-${i}`}>
            <Line
              points={[m.fromNode.pos, [ghostV.x, ghostV.y, ghostV.z]]}
              color={m.color}
              lineWidth={expanded ? 2.4 : 1.6}
              transparent opacity={expanded ? 0.95 : 0.75}
              dashed={!expanded}
              dashScale={20}
              gapSize={0.3} />
            {!expanded && (
              <group position={[ghostV.x, ghostV.y, ghostV.z]}>
                <mesh
                  onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onExpand(m.toNode.rootPc); }}
                  onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); document.body.style.cursor = "pointer"; }}
                  onPointerOut={() => { document.body.style.cursor = "default"; }}>
                  <sphereGeometry args={[0.12, 14, 10]} />
                  <meshStandardMaterial
                    color={m.color}
                    emissive={m.color}
                    emissiveIntensity={0.5}
                    transparent opacity={0.9} />
                </mesh>
                <Html center distanceFactor={9} style={{ pointerEvents: "none" }}>
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
            )}
            {expanded && !isAnchorTarget && (
              <group position={[midV.x, midV.y, midV.z]}>
                <mesh
                  onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onCollapse(m.toNode.rootPc); }}
                  onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); document.body.style.cursor = "pointer"; }}
                  onPointerOut={() => { document.body.style.cursor = "default"; }}>
                  <sphereGeometry args={[0.10, 14, 10]} />
                  <meshStandardMaterial
                    color={m.color}
                    emissive={m.color}
                    emissiveIntensity={0.6}
                    transparent opacity={0.95} />
                </mesh>
                <Html center distanceFactor={9} style={{ pointerEvents: "none" }}>
                  <div style={{
                    background: "#0a0a0aee",
                    border: `1px solid ${m.color}`,
                    color: m.color,
                    padding: "1px 5px",
                    borderRadius: 8,
                    fontSize: 10,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                    transform: "translate(0, -16px)",
                    letterSpacing: 0.3,
                  }}>
                    × {m.label}
                  </div>
                </Html>
              </group>
            )}
          </group>
        );
      })}

      {visibleEdges.map((e, i) => (
        <group key={`${e.type}-${i}`}>
          <Line points={e.points} color={e.color}
            lineWidth={e.type === "z" ? 2.0 : 1.6}
            transparent opacity={e.type === "z" ? 0.9 : 0.75} />
          <Html position={e.mid} center distanceFactor={15}
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
        </group>
      ))}

      {lattice.nodes.map(node => {
        if (!showFamilies[node.family.id]) return null;
        // Hide nodes whose root pc isn't expanded — only the anchor's
        // tonic (and any user-expanded neighbourhood roots) should show.
        if (!expandedRoots.has(node.rootPc)) return null;
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

      <OrbitControls enableDamping dampingFactor={0.15} />
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const anchorRootPc = useMemo(() => ((tonicPc % edo) + edo) % edo, [tonicPc, edo]);
  const [expandedRoots, setExpandedRoots] = useState<Set<number>>(
    () => new Set([anchorRootPc])
  );

  // Camera-reset counter: bumping this triggers <CameraReset> to snap
  // the orbit camera back to its default 3/4 view.
  const [cameraResetKey, setCameraResetKey] = useState(0);

  // Shift+click sets this so the orbit target smoothly animates to
  // the chosen node — overrides the default focus heuristic
  // (active → selected → anchor) until it's reset.
  const [cameraFocusId, setCameraFocusId] = useState<string | null>(null);

  // Reset expansion when the user changes their tonic / anchor —
  // start over with only the new anchor's neighbourhood visible.
  useEffect(() => {
    setExpandedRoots(new Set([anchorRootPc]));
    setSelectedId(null);
    setCameraFocusId(null);
  }, [anchorRootPc, anchorKey]);

  // Family / edge visibility toggles.
  const [showFamilies, setShowFamilies] = useState<Record<string, boolean>>(
    Object.fromEntries(LATTICE_FAMILIES.map(f => [f.id, true]))
  );
  const [showEdges, setShowEdges] = useState<Record<string, boolean>>({
    y: true, z: true,
  });

  // Parse the anchor's family + mode out of the picker selection.
  const [anchorFamilyName, anchorModeName] = useMemo(() => {
    if (!anchorKey) return [null, null] as [string | null, string | null];
    const [f, m] = anchorKey.split("::");
    return [f ?? null, m ?? null] as [string | null, string | null];
  }, [anchorKey]);

  // Multi-key cylinder lattice — 15 keys × 7 families × 7 modes = 735
  // nodes, distributed on 7 concentric vertical cylinders (one per
  // family), with the anchor's key rotated to θ = 0 and its brightness
  // centred at y = 0 so it lands at front-and-centre.
  const lattice = useMemo(
    () => buildCylinderLattice(edo, tonicPc, anchorFamilyName, anchorModeName),
    [edo, tonicPc, anchorFamilyName, anchorModeName]
  );

  // Find the anchor's id within the cylinder lattice — its keyIdx
  // depends on which spelling matches tonicPc.
  const anchorId = useMemo(() => {
    if (!anchorFamilyName || !anchorModeName) return null;
    const family = LATTICE_FAMILIES.find(f => f.familyName === anchorFamilyName);
    if (!family) return null;
    for (const n of lattice.nodes) {
      if (n.family.id === family.id
          && n.mode.name === anchorModeName
          && n.rootPc === ((tonicPc % edo) + edo) % edo) {
        return n.id;
      }
    }
    return null;
  }, [lattice, anchorFamilyName, anchorModeName, tonicPc, edo]);

  // Modulation edges: rays from whichever node the user has selected
  // (or the anchor by default if nothing's been clicked yet).  Empty
  // until the user clicks a node, so the initial view is just the
  // anchor's column without ray clutter.
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
    const ctrl = ev.ctrlKey || ev.metaKey;
    const shift = ev.shiftKey;
    if (shift) {
      // Shift+click: focus the camera on this node — animate the orbit
      // target without affecting the drone or the modulation overlay.
      setCameraFocusId(node.id);
      return;
    }
    if (ctrl) {
      // Ctrl/⌘+click: toggle the modulation overlay for this node.
      // Doesn't affect the drone — keeps the picker / mixer intact.
      setSelectedId(prev => prev === node.id ? null : node.id);
      return;
    }
    // Plain click: toggle the drone for this node.  Modulation rays
    // stay hidden (or attached to whichever node was last Ctrl-clicked).
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
  }, [activeId, startDroneFor, onActiveModeChange]);

  // Click a "+" ghost at the tip of a modulation ray to expand that
  // root's 49-node neighbourhood (parallel modes + modal interchange).
  const handleExpand = useCallback((rootPc: number) => {
    setExpandedRoots(prev => {
      const next = new Set(prev);
      next.add(((rootPc % edo) + edo) % edo);
      return next;
    });
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
    setCameraFocusId(null);
    setExpandedRoots(new Set([anchorRootPc]));
    setCameraResetKey(k => k + 1);
    onActiveModeChange?.(null);
  }, [anchorRootPc, onActiveModeChange]);

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
        {LATTICE_FAMILIES.map(f => (
          <button key={f.id}
            onClick={() => setShowFamilies(s => ({ ...s, [f.id]: !s[f.id] }))}
            className="text-[9px] px-2 py-0.5 rounded border transition-colors"
            style={{
              borderColor: showFamilies[f.id] ? f.color : "#222",
              background: showFamilies[f.id] ? f.dim : "transparent",
              color: showFamilies[f.id] ? f.color : "#444",
            }}>
            <span style={{
              display: "inline-block", width: 6, height: 6,
              borderRadius: "50%", background: f.color, marginRight: 4,
              opacity: showFamilies[f.id] ? 1 : 0.3,
            }} />
            {f.short}
          </button>
        ))}
        <span className="ml-2 text-[8px] text-[#444]">EDGES</span>
        {[
          { id: "y", label: "Y · brightness", color: "#445d7a" },
          { id: "z", label: "Z · alteration", color: "#22ddaa" },
        ].map(e => (
          <button key={e.id}
            onClick={() => setShowEdges(s => ({ ...s, [e.id]: !s[e.id] }))}
            className="text-[9px] px-2 py-0.5 rounded border transition-colors"
            style={{
              borderColor: showEdges[e.id] ? e.color : "#222",
              color: showEdges[e.id] ? e.color : "#444",
            }}>
            {e.label}
          </button>
        ))}
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
