import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";
import { audioEngine } from "@/lib/audioEngine";
import { useLS } from "@/lib/storage";
import {
  NODES, GENERATOR_EDGES, COMMA_EDGES, OTONAL_EDGES, UTONAL_EDGES, OCTAVE_EDGES,
  POS_MAP, PRIME_COLORS, nodeKey, nodePos3D, ratioToCents, exponentLabel, intervalName,
  INTERVAL_NAMES,
  buildMultipleStacks, buildHarmonicSeries, harmonicChainPositions, buildCommaClusterData,
  buildCommaGroups,
  type HNode, type EdgeDef, type StackNode, type StackEdge, type HarmonicNode,
  type CommaClusterNode, type CommaClusterLabel, type CommaGroup,
} from "@/lib/harmonicGraph";
import {
  buildLattice, detectTopology, latticeInfo,
  generateTorusMesh, generateCylinderMesh, projectNodesToTopoSurface,
  intervalName as monzoIntervalName, intervalAllNames as monzoIntervalAllNames, monzoLabel, ratioToCents as monzoRatioToCents,
  ratioToNoteName, rootPcToFreq, ROOT_NOTE_OPTIONS,
  PRESET_CONFIGS, KNOWN_COMMAS, ALL_PRIMES, DEFAULT_PROJECTIONS, factorize, monzoToRatio,
  PRIME_COLORS as MONZO_PRIME_COLORS,
  temperedCents, temperedRatio,
  ratioToHEJILabel,
  type LatticeConfig, type LatticeNode, type LatticeEdge, type BuiltLattice,
  type CommaSpec, type TopologyInfo, type GridType, type TuningMethod,
} from "@/lib/latticeEngine";
import {
  buildTonnetz, tonnetzInfo,
  ratioToNoteName as tonnetzRatioToNoteName,
  TONNETZ_PRESETS, TONNETZ_PRIME_COLORS, LIMIT_PRIMES,
  buildEdoTonnetz, edoTonnetzInfo, edoNoteNameByPc,
  findEdoChordMoves, findJiChordMoves,
  findEdoParallelMoves, findJiParallelMoves,
  EDO_TONNETZ_PRESETS, EDO_TONNETZ_EDGE_COLORS,
  type TonnetzConfig, type TonnetzNode, type TonnetzTriad, type TonnetzData, type TonnetzEdge, type PLRLink,
  type EdoTonnetzConfig, type EdoTonnetzNode, type EdoTonnetzData, type EdoTonnetzEdge, type EdoTonnetzPLR,
  type ChordMove, type ParallelChordMove,
} from "@/lib/tonnetzEngine";
import {
  xenIntervalName, xenIntervalNames,
} from "@/lib/xenIntervals";
import { accidentalText } from "@/lib/hejiNotation";
import { COMMA_DB, edoTempersComma } from "@/lib/edoTemperamentData";

/** Pick a small set of 5-limit commas that vanish in the given EDO,
 *  forming a spanning kernel basis.  The 5-limit lattice has rank 2,
 *  so two independent commas collapse the lattice to its EDO classes
 *  exactly; we hand-feed three of the simplest vanishing 5-limit
 *  commas so the projection has redundant data even if one of them
 *  is linearly dependent.  This drives the Tonescape-style toroidal
 *  shape: P5 chain + M3 chain both wrap, producing a torus. */
function fiveLimitCommasForEdo(edo: number): { n: number; d: number; name: string }[] {
  return COMMA_DB
    .filter(c => c.category === "5-limit")
    .filter(c => edoTempersComma(edo, c.n, c.d))
    .sort((a, b) => a.cents - b.cents)
    .slice(0, 3)
    .map(c => ({ n: c.n, d: c.d, name: c.name }));
}

// ── Cents → nearest 12-TET note + deviation ─────────────────────
// ═══════════════════════════════════════════════════════════════
// Arrow-key panning: moves orbit center in camera-relative dirs
// ═══════════════════════════════════════════════════════════════

function CameraReset({ resetKey }: { resetKey: number }) {
  const { camera, controls } = useThree();
  const prevKey = useRef(resetKey);
  useEffect(() => {
    if (resetKey !== prevKey.current) {
      prevKey.current = resetKey;
      camera.position.set(10, 7, 10);
      camera.lookAt(0, 0, 0);
      const c = controls as any;
      if (c?.target) { c.target.set(0, 0, 0); c.update?.(); }
    }
  }, [resetKey, camera, controls]);
  return null;
}

function KeyboardPan() {
  const { controls, camera } = useThree();
  const pressed = useRef<Set<string>>(new Set());

  // register listeners once
  useState(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const d = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (e.key.startsWith("Arrow")) { e.preventDefault(); pressed.current.add(e.key); }
      else if (k === "w" || k === "a" || k === "s" || k === "d") {
        e.preventDefault();
        pressed.current.add(k);
      }
    };
    const u = (e: KeyboardEvent) => {
      pressed.current.delete(e.key);
      pressed.current.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", d);
    window.addEventListener("keyup", u);
    return () => { window.removeEventListener("keydown", d); window.removeEventListener("keyup", u); };
  });

  useFrame(() => {
    if (!controls || pressed.current.size === 0) return;
    const c = controls as any;
    if (!c.target) return;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const d = new THREE.Vector3();
    if (pressed.current.has("ArrowLeft")  || pressed.current.has("a")) d.addScaledVector(right, -0.4);
    if (pressed.current.has("ArrowRight") || pressed.current.has("d")) d.addScaledVector(right,  0.4);
    if (pressed.current.has("ArrowUp")    || pressed.current.has("w")) d.addScaledVector(up,     0.4);
    if (pressed.current.has("ArrowDown")  || pressed.current.has("s")) d.addScaledVector(up,    -0.4);
    c.target.add(d);
    camera.position.add(d);
  });
  return null;
}

/** Smoothly pan orbit target to the focused node's position */
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
    if (prevPos.current && prevPos.current[0] === targetPos[0] && prevPos.current[1] === targetPos[1] && prevPos.current[2] === targetPos[2]) return;
    prevPos.current = targetPos;
    const c = controls as any;
    if (!c?.target) return;
    startTarget.current.copy(c.target);
    startCamPos.current.copy(camera.position);
    goalTarget.current.set(...targetPos);
    progress.current = 0;
    animating.current = true;
  }, [targetPos, controls, camera]);

  useFrame(() => {
    if (!animating.current) return;
    const c = controls as any;
    if (!c?.target) return;
    progress.current = Math.min(1, progress.current + 0.06);
    const t = 1 - Math.pow(1 - progress.current, 3); // ease-out cubic
    const delta = new THREE.Vector3().subVectors(goalTarget.current, startTarget.current).multiplyScalar(t);
    c.target.copy(startTarget.current).add(delta);
    camera.position.copy(startCamPos.current).add(delta);
    c.update?.();
    if (progress.current >= 1) animating.current = false;
  });
  return null;
}

// ═══════════════════════════════════════════════════════════════
// 3D Node sphere
// ═══════════════════════════════════════════════════════════════

const NODE_RADIUS = 0.12;
const NODE_RADIUS_COMMA = 0.08;

interface NodeMeshProps {
  node: HNode;
  pos: [number, number, number];
  isActive: boolean;
  isHovered: boolean;
  onHover: (key: string | null) => void;
  onClick: (node: HNode) => void;
  labelMode: "intervals" | "ratios";
  rootPc?: number;
}

function NodeMesh({ node, pos, isActive, isHovered, onHover, onClick, labelMode, rootPc = 0 }: NodeMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const key = nodeKey(node);
  const isUnison = node.n === 1 && node.d === 1;
  const r = node.isComma ? NODE_RADIUS_COMMA : NODE_RADIUS;

  const color = useMemo(() => {
    if (isActive) return "#7173e6";
    if (isUnison) return "#9395ea";
    if (node.isComma) return "#553344";
    return "#3a3a4a";
  }, [isActive, isUnison, node.isComma]);

  const emissive = useMemo(() => {
    if (isActive) return "#7173e6";
    if (isHovered) return "#5a5cc8";
    return "#000000";
  }, [isActive, isHovered]);

  useFrame(() => {
    if (!meshRef.current) return;
    const scale = isHovered ? 1.3 : isActive ? 1.2 : 1;
    meshRef.current.scale.lerp(new THREE.Vector3(scale, scale, scale), 0.15);
  });

  return (
    <group position={pos}>
      <mesh
        ref={meshRef}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(key); }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onClick(node); }}
      >
        <sphereGeometry args={[r, 16, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={isHovered ? 0.6 : isActive ? 0.8 : 0}
          roughness={0.5}
          metalness={0.3}
        />
      </mesh>
      {/* Label */}
      <Html
        position={[0, r + 0.08, 0]}
        center
        distanceFactor={12}
        zIndexRange={[1, 0]}
        style={{ pointerEvents: "none" }}
      >
        <div style={{
          textAlign: "center",
          whiteSpace: "nowrap",
          textShadow: "0 0 6px rgba(0,0,0,0.95)",
          transition: "color 0.15s",
          lineHeight: 1.2,
        }}>
          {/* Note name on top */}
          <div style={{
            color: isHovered || isActive ? "#7df" : "#4ac",
            fontSize: node.isComma ? 7 : 11,
            fontFamily: "Inter, system-ui, sans-serif",
            fontWeight: 700,
          }}>
            {ratioToNoteName(node.n, node.d, rootPc)}
          </div>
          {labelMode === "intervals" ? (
            <>
              <div style={{
                color: isHovered || isActive ? "#fff" : "#999",
                fontSize: node.isComma ? 8 : 10,
                fontFamily: "Inter, system-ui, sans-serif",
                fontWeight: 600,
              }}>
                {intervalName(node)}
              </div>
              <div style={{
                color: isHovered || isActive ? "#aaa" : "#444",
                fontSize: node.isComma ? 7 : 8,
                fontFamily: "'Courier New', monospace",
                fontWeight: 400,
              }}>
                {key}
              </div>
            </>
          ) : (
            <div style={{
              color: isHovered || isActive ? "#fff" : "#999",
              fontSize: node.isComma ? 8 : 11,
              fontFamily: "'Courier New', monospace",
              fontWeight: 600,
            }}>
              {key}
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════
// Harmonic Chain Node (for Harmonic Series mode)
// ═══════════════════════════════════════════════════════════════

interface ChainNodeMeshProps {
  hNode: HarmonicNode;
  pos: [number, number, number];
  isActive: boolean;
  isHovered: boolean;
  onHover: (key: string | null) => void;
  onClick: (hNode: HarmonicNode) => void;
}

function ChainNodeMesh({ hNode, pos, isActive, isHovered, onHover, onClick }: ChainNodeMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const color = useMemo(() => {
    if (isActive) return "#7173e6";
    return "#3a3a4a";
  }, [isActive]);

  const emissive = useMemo(() => {
    if (isActive) return "#7173e6";
    if (isHovered) return "#5a5cc8";
    return "#000000";
  }, [isActive, isHovered]);

  useFrame(() => {
    if (!meshRef.current) return;
    const scale = isHovered ? 1.3 : isActive ? 1.2 : 1;
    meshRef.current.scale.lerp(new THREE.Vector3(scale, scale, scale), 0.15);
  });

  return (
    <group position={pos}>
      <mesh
        ref={meshRef}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(hNode.label); }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onClick(hNode); }}
      >
        <sphereGeometry args={[NODE_RADIUS, 16, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={isHovered ? 0.6 : isActive ? 0.8 : 0}
          roughness={0.5}
          metalness={0.3}
        />
      </mesh>
      <Html
        position={[0, NODE_RADIUS + 0.08, 0]}
        center
        distanceFactor={12}
        zIndexRange={[1, 0]}
        style={{ pointerEvents: "none" }}
      >
        <div style={{
          textAlign: "center",
          whiteSpace: "nowrap",
          textShadow: "0 0 6px rgba(0,0,0,0.95)",
          transition: "color 0.15s",
          lineHeight: 1.2,
        }}>
          <div style={{
            color: isHovered || isActive ? "#fff" : "#999",
            fontSize: 11,
            fontFamily: "'Courier New', monospace",
            fontWeight: 600,
          }}>
            {hNode.label}
          </div>
          {hNode.harmonic > 1 && (INTERVAL_NAMES[hNode.label] || intervalNameForHarmonic(hNode.n, hNode.d)) && (
            <div style={{
              color: isHovered || isActive ? "#c8aa50" : "#776830",
              fontSize: 7,
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 500,
            }}>
              {INTERVAL_NAMES[hNode.label] ?? intervalNameForHarmonic(hNode.n, hNode.d)}
            </div>
          )}
          <div style={{
            color: isHovered || isActive ? "#aaa" : "#555",
            fontSize: 8,
            fontFamily: "Inter, system-ui, sans-serif",
            fontWeight: 400,
          }}>
            H{hNode.harmonic}
          </div>
        </div>
      </Html>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════
// Edge lines (support custom posMap for chain layout)
// ═══════════════════════════════════════════════════════════════

interface EdgeGroupProps {
  edges: EdgeDef[];
  color: string;
  lineWidth: number;
  opacity: number;
  dashed?: boolean;
  dashScale?: number;
  posMap?: Map<string, [number, number, number]>;
}

function EdgeGroup({ edges, color, lineWidth, opacity, posMap }: EdgeGroupProps) {
  const positions = posMap ?? POS_MAP;
  const segments = useMemo(() => {
    const pts: [number, number, number][] = [];
    for (const e of edges) {
      const a = positions.get(e.from);
      const b = positions.get(e.to);
      if (a && b) { pts.push(a, b); }
    }
    return pts;
  }, [edges, positions]);

  if (segments.length === 0) return null;

  return (
    <lineSegments frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[new Float32Array(segments.flat()), 3]}
        />
      </bufferGeometry>
      <lineBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        linewidth={lineWidth}
        depthWrite={false}
      />
    </lineSegments>
  );
}

// For dashed and thick lines, use drei's Line (more expensive but supports width/dash)
function ThickEdgeGroup({ edges, color, lineWidth, opacity, dashed, dashScale, posMap }: EdgeGroupProps) {
  const positions = posMap ?? POS_MAP;
  if (edges.length === 0) return null;
  return (
    <>
      {edges.map((e, i) => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return null;
        return (
          <Line
            key={i}
            points={[a, b]}
            color={color}
            lineWidth={lineWidth}
            transparent
            opacity={opacity}
            dashed={dashed}
            dashScale={dashScale}
            dashSize={0.15}
            gapSize={0.1}
            depthWrite={false}
          />
        );
      })}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// Lattice Scene (used for all modes except "harmonic")
// ═══════════════════════════════════════════════════════════════

interface SceneProps {
  droneNodes: Set<string>;
  hoveredNode: string | null;
  onHover: (key: string | null) => void;
  onClickNode: (node: HNode) => void;
  showGen: Record<number, boolean>;
  showOtonal: boolean;
  showUtonal: boolean;
  showComma: boolean;
  showOctave: boolean;
  labelMode: "intervals" | "ratios";
  rootPc?: number;
}

function Scene({
  droneNodes, hoveredNode, onHover, onClickNode,
  showGen, showOtonal, showUtonal, showComma, showOctave, labelMode, rootPc = 0,
}: SceneProps) {
  const genByPrime = useMemo(() => {
    const map: Record<number, EdgeDef[]> = { 3: [], 5: [], 7: [], 11: [], 13: [] };
    for (const e of GENERATOR_EDGES) {
      if (e.prime) map[e.prime].push(e);
    }
    return map;
  }, []);

  return (
    <>
      <ambientLight intensity={0.6} />
      <pointLight position={[10, 10, 10]} intensity={0.8} />
      <pointLight position={[-8, -5, -10]} intensity={0.3} />

      {showOtonal && (
        <ThickEdgeGroup edges={OTONAL_EDGES} color="#ffffff" lineWidth={2.5} opacity={0.08} />
      )}
      {showUtonal && (
        <ThickEdgeGroup edges={UTONAL_EDGES} color="#888888" lineWidth={2.5} opacity={0.1} />
      )}
      {([3, 5, 7, 11, 13] as const).map(p =>
        showGen[p] && genByPrime[p].length > 0 ? (
          <EdgeGroup key={p} edges={genByPrime[p]}
            color={PRIME_COLORS[p]} lineWidth={1} opacity={0.5} />
        ) : null
      )}
      {showComma && (
        <ThickEdgeGroup edges={COMMA_EDGES} color="#ff4444" lineWidth={1.5} opacity={0.35}
          dashed dashScale={8} />
      )}
      {showOctave && (
        <EdgeGroup edges={OCTAVE_EDGES} color="#666666" lineWidth={1} opacity={0.4} />
      )}

      {NODES.map(node => {
        const key = nodeKey(node);
        return (
          <NodeMesh
            key={key}
            node={node}
            pos={nodePos3D(node)}
            isActive={droneNodes.has(key)}
            isHovered={hoveredNode === key}
            onHover={onHover}
            onClick={onClickNode}
            labelMode={labelMode}
            rootPc={rootPc}
          />
        );
      })}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        minDistance={3}
        maxDistance={60}
        enablePan
      />
      <KeyboardPan />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// Harmonic Chain Scene (ONLY for "harmonic" mode — linear chain)
// No lattice. No force layout. Deterministic linear positions.
// ═══════════════════════════════════════════════════════════════

interface HarmonicSceneProps {
  harmonicNodes: HarmonicNode[];
  harmonicEdges: EdgeDef[];
  posMap: Map<string, [number, number, number]>;
  droneNodes: Set<string>;
  hoveredNode: string | null;
  onHover: (key: string | null) => void;
  onClickNode: (hNode: HarmonicNode) => void;
  showIntervals: boolean;
}

/** Compute the interval ratio between two consecutive harmonics as a reduced fraction string + cents. */
function intervalBetween(a: HarmonicNode, b: HarmonicNode): { ratio: string; cents: number } {
  // Interval = b/a in terms of their ratios (n/d)
  let num = b.n * a.d;
  let den = b.d * a.n;
  // Ensure ascending
  if (num < den) { [num, den] = [den, num]; }
  const g = gcd(num, den);
  num /= g; den /= g;
  return { ratio: `${num}/${den}`, cents: ratioToCents(num, den) };
}

function gcd(a: number, b: number): number {
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

function HarmonicChainScene({
  harmonicNodes, harmonicEdges, posMap,
  droneNodes, hoveredNode, onHover, onClickNode, showIntervals,
}: HarmonicSceneProps) {
  // Pre-compute interval labels between consecutive nodes
  const intervalLabels = useMemo(() => {
    if (!showIntervals) return [];
    const labels: { pos: [number, number, number]; ratio: string; cents: number }[] = [];
    for (let i = 0; i < harmonicNodes.length - 1; i++) {
      const a = harmonicNodes[i];
      const b = harmonicNodes[i + 1];
      const pa = posMap.get(a.label);
      const pb = posMap.get(b.label);
      if (!pa || !pb) continue;
      const mid: [number, number, number] = [
        (pa[0] + pb[0]) / 2,
        (pa[1] + pb[1]) / 2 - 0.35,
        (pa[2] + pb[2]) / 2,
      ];
      const iv = intervalBetween(a, b);
      labels.push({ pos: mid, ...iv });
    }
    return labels;
  }, [showIntervals, harmonicNodes, posMap]);

  return (
    <>
      <ambientLight intensity={0.6} />
      <pointLight position={[10, 10, 10]} intensity={0.8} />
      <pointLight position={[-8, -5, -10]} intensity={0.3} />

      {/* Chain edges — consecutive neighbors only */}
      <EdgeGroup
        edges={harmonicEdges}
        color="#e87010"
        lineWidth={1}
        opacity={0.6}
        posMap={posMap}
      />

      {/* Interval labels between consecutive nodes */}
      {intervalLabels.map((iv, i) => (
        <Html
          key={i}
          position={iv.pos}
          center
          distanceFactor={12}
          zIndexRange={[1, 0]}
          style={{ pointerEvents: "none" }}
        >
          <div style={{
            textAlign: "center",
            whiteSpace: "nowrap",
            textShadow: "0 0 6px rgba(0,0,0,0.95)",
            lineHeight: 1.2,
          }}>
            <div style={{
              color: "#e87010",
              fontSize: 9,
              fontFamily: "'Courier New', monospace",
              fontWeight: 600,
            }}>
              {INTERVAL_NAMES[iv.ratio] ?? iv.ratio}
            </div>
            <div style={{
              color: "#665530",
              fontSize: 7,
              fontFamily: "'Courier New', monospace",
            }}>
              {iv.cents.toFixed(0)}¢
            </div>
          </div>
        </Html>
      ))}

      {harmonicNodes.map(hNode => {
        const p = posMap.get(hNode.label);
        if (!p) return null;
        return (
          <ChainNodeMesh
            key={hNode.label}
            hNode={hNode}
            pos={p}
            isActive={droneNodes.has(hNode.label)}
            isHovered={hoveredNode === hNode.label}
            onHover={onHover}
            onClick={onClickNode}
          />
        );
      })}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        minDistance={3}
        maxDistance={60}
        enablePan
      />
      <KeyboardPan />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// Stack Node (for Otonal/Utonal mode)
// ═══════════════════════════════════════════════════════════════

interface StackNodeMeshProps {
  node: StackNode;
  pos: [number, number, number];
  isActive: boolean;
  isHovered: boolean;
  onHover: (key: string | null) => void;
  onClick: (node: StackNode) => void;
}

function StackNodeMesh({ node, pos, isActive, isHovered, onHover, onClick }: StackNodeMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const posKey = `${node.stackId}:${node.harmonicLabel}`;
  const r = 0.14;

  const color = useMemo(() => {
    if (isActive) return "#7173e6";
    return "#3a3a4a";
  }, [isActive]);

  const emissive = useMemo(() => {
    if (isActive) return "#7173e6";
    if (isHovered) return "#5a5cc8";
    return "#000000";
  }, [isActive, isHovered]);

  useFrame(() => {
    if (!meshRef.current) return;
    const scale = isHovered ? 1.3 : isActive ? 1.2 : 1;
    meshRef.current.scale.lerp(new THREE.Vector3(scale, scale, scale), 0.15);
  });

  return (
    <group position={pos}>
      <mesh
        ref={meshRef}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(posKey); }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onClick(node); }}
      >
        <sphereGeometry args={[r, 16, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={isHovered ? 0.6 : isActive ? 0.8 : 0}
          roughness={0.5}
          metalness={0.3}
        />
      </mesh>
      <Html
        position={[0, r + 0.12, 0]}
        center
        distanceFactor={8}
        zIndexRange={[1, 0]}
        style={{ pointerEvents: "none" }}
      >
        <div style={{
          textAlign: "center",
          whiteSpace: "nowrap",
          textShadow: "0 0 6px rgba(0,0,0,0.95)",
          lineHeight: 1.3,
        }}>
          <div style={{
            color: isHovered || isActive ? "#fff" : "#bbb",
            fontSize: 13,
            fontFamily: "'Courier New', monospace",
            fontWeight: 700,
          }}>
            {node.harmonicLabel}
          </div>
          <div style={{
            color: isHovered || isActive ? "#aaa" : "#555",
            fontSize: 10,
            fontFamily: "'Courier New', monospace",
          }}>
            {node.label}
          </div>
          <div style={{
            color: "#444",
            fontSize: 8,
            fontFamily: "'Courier New', monospace",
          }}>
            {node.cents.toFixed(0)}¢
          </div>
        </div>
      </Html>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════
// Otonal / Utonal Stack Scene — own layout engine, no lattice
// ═══════════════════════════════════════════════════════════════

interface OtonalSceneProps {
  stackNodes: StackNode[];
  stackEdges: StackEdge[];
  positions: Map<string, [number, number, number]>;
  activeNodes: Set<string>;
  hoveredNode: string | null;
  onHover: (key: string | null) => void;
  onClickNode: (node: StackNode) => void;
}

function OtonalScene({
  stackNodes, stackEdges, positions, activeNodes, hoveredNode, onHover, onClickNode,
}: OtonalSceneProps) {
  return (
    <>
      <ambientLight intensity={0.6} />
      <pointLight position={[10, 10, 10]} intensity={0.8} />
      <pointLight position={[-8, -5, -10]} intensity={0.3} />

      {/* Stack edges: white lines connecting neighbors only */}
      {stackEdges.map((e, i) => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return null;
        return (
          <Line
            key={i}
            points={[a, b]}
            color="#ffffff"
            lineWidth={2}
            transparent
            opacity={0.25}
            depthWrite={false}
          />
        );
      })}

      {/* Stack nodes */}
      {stackNodes.map(node => {
        const posKey = `${node.stackId}:${node.harmonicLabel}`;
        const pos = positions.get(posKey);
        if (!pos) return null;
        return (
          <StackNodeMesh
            key={posKey}
            node={node}
            pos={pos}
            isActive={activeNodes.has(node.label)}
            isHovered={hoveredNode === posKey}
            onHover={onHover}
            onClick={onClickNode}
          />
        );
      })}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        minDistance={2}
        maxDistance={30}
        enablePan
      />
      <KeyboardPan />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// Pan/Zoom SVG wrapper + shared SVG defs
// ═══════════════════════════════════════════════════════════════

function usePanZoom(contentW: number, contentH: number) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [vb, setVb] = useState({ x: 0, y: 0, w: contentW, h: contentH });
  const dragging = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);

  // Reset viewBox when content size changes
  const prevSize = useRef({ w: contentW, h: contentH });
  if (prevSize.current.w !== contentW || prevSize.current.h !== contentH) {
    prevSize.current = { w: contentW, h: contentH };
    setVb({ x: 0, y: 0, w: contentW, h: contentH });
  }

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    setVb(v => {
      const nw = v.w * factor, nh = v.h * factor;
      return { x: v.x + (v.w - nw) * mx, y: v.y + (v.h - nh) * my, w: nw, h: nh };
    });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragging.current = { sx: e.clientX, sy: e.clientY, vx: vb.x, vy: vb.y };
  }, [vb.x, vb.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dx = (e.clientX - dragging.current.sx) / rect.width * vb.w;
    const dy = (e.clientY - dragging.current.sy) / rect.height * vb.h;
    setVb(v => ({ ...v, x: dragging.current!.vx + dx, y: dragging.current!.vy + dy }));
  }, [vb.w, vb.h]);

  const onPointerUp = useCallback(() => { dragging.current = null; }, []);

  return { containerRef, vb, onWheel, onPointerDown, onPointerMove, onPointerUp };
}

function SvgDefs() {
  return (
    <defs>
      {/* Sphere-like radial gradient: inactive */}
      <radialGradient id="ng-idle" cx="35%" cy="30%" r="65%">
        <stop offset="0%" stopColor="#5a5a6a" />
        <stop offset="100%" stopColor="#2a2a3a" />
      </radialGradient>
      {/* Sphere-like radial gradient: active */}
      <radialGradient id="ng-active" cx="35%" cy="30%" r="65%">
        <stop offset="0%" stopColor="#9395ea" />
        <stop offset="100%" stopColor="#5557b8" />
      </radialGradient>
      {/* Root node gradient */}
      <radialGradient id="ng-root" cx="35%" cy="30%" r="65%">
        <stop offset="0%" stopColor="#a5a7f0" />
        <stop offset="100%" stopColor="#6668c0" />
      </radialGradient>
      {/* Glow filter */}
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
      {/* Text shadow filter */}
      <filter id="tshadow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="2" />
        <feOffset dx="0" dy="0" />
        <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
    </defs>
  );
}

// ═══════════════════════════════════════════════════════════════
// CommaSvg — 2D SVG circle+line layout for comma pairs
// ═══════════════════════════════════════════════════════════════

function CommaSvg({ groups, droneNodes, onClickNode }: {
  groups: CommaGroup[]; droneNodes: Set<string>; onClickNode: (node: HNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(900);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setContainerW(e.contentRect.width);
    });
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const R = 26, pairGapX = 180, pairSpacingY = 80;
  const padTop = 80, padBot = 50;
  const numGroups = groups.length;

  const maxPairs = Math.max(...groups.map(g => g.pairs.length));
  const baseGroupW = pairGapX + R * 4 + 120;
  // Compute spacing so groups fill the full container width
  const totalBaseW = numGroups * baseGroupW;
  const remainingSpace = containerW - totalBaseW;
  const groupSpacingX = numGroups > 1 ? Math.max(20, remainingSpace / (numGroups - 1)) : 0;

  const groupLayouts = groups.map(group => ({
    group, w: baseGroupW, h: maxPairs * pairSpacingY + padTop + padBot,
  }));
  const totalW = containerW;
  const maxH = groupLayouts[0]?.h ?? 0;

  // Center all groups symmetrically
  const totalUsedW = numGroups * baseGroupW + (numGroups - 1) * groupSpacingX;
  let offsetX = (containerW - totalUsedW) / 2;

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", overflowY: "auto", overflowX: "hidden" }}>
      <svg width="100%" height={Math.max(maxH, 400)} viewBox={`0 0 ${totalW} ${maxH}`}
        preserveAspectRatio="xMidYMid meet" style={{ display: "block", minHeight: maxH }}>
        <SvgDefs />
        {groupLayouts.map((gl) => {
          const x0 = offsetX;
          offsetX += gl.w + groupSpacingX;
          const cx = x0 + gl.w / 2;
          return (
            <g key={gl.group.ratio}>
              <text x={cx} y={28} textAnchor="middle" fill="#ff5555" filter="url(#tshadow)"
                fontSize={20} fontWeight={700} fontFamily="Inter, system-ui, sans-serif">{gl.group.name}</text>
              <text x={cx} y={48} textAnchor="middle" fill="#884444"
                fontSize={14} fontFamily="'Courier New', monospace">{gl.group.ratio} · {gl.group.cents}</text>
              {gl.group.pairs.map((pair, pi) => {
                const py = padTop + pi * pairSpacingY + pairSpacingY / 2;
                const lx = cx - pairGapX / 2, rx = cx + pairGapX / 2;
                const lActive = droneNodes.has(pair.lowerKey), rActive = droneNodes.has(pair.higherKey);
                return (
                  <g key={pi}>
                    <line x1={lx + R} y1={py} x2={rx - R} y2={py}
                      stroke="#ff4444" strokeOpacity={0.35} strokeWidth={1} strokeDasharray="5 3" />
                    <rect x={cx - 24} y={py - 9} width={48} height={18} rx={4} fill="#1a1a2e" fillOpacity={0.85} />
                    <text x={cx} y={py} textAnchor="middle" dominantBaseline="central" fill="#aa6666"
                      fontSize={11} fontWeight={600} fontFamily="'Courier New', monospace">{gl.group.ratio}</text>
                    <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onClickNode(pair.lower); }}
                      filter={lActive ? "url(#glow)" : undefined}>
                      <circle cx={lx} cy={py} r={R} fill={lActive ? "url(#ng-active)" : "url(#ng-idle)"}
                        stroke={lActive ? "#9395ea" : "#444"} strokeWidth={1} />
                      <text x={lx} y={py + 1} textAnchor="middle" dominantBaseline="central"
                        fill={lActive ? "#fff" : "#ccc"} filter="url(#tshadow)"
                        fontSize={14} fontWeight={600} fontFamily="'Courier New', monospace">{pair.lowerKey}</text>
                    </g>
                    <text x={lx} y={py + R + 14} textAnchor="middle" fill={lActive ? "#aaa" : "#555"}
                      fontSize={11} fontFamily="Inter, system-ui, sans-serif">{pair.lowerName}</text>
                    <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onClickNode(pair.higher); }}
                      filter={rActive ? "url(#glow)" : undefined}>
                      <circle cx={rx} cy={py} r={R} fill={rActive ? "url(#ng-active)" : "url(#ng-idle)"}
                        stroke={rActive ? "#9395ea" : "#444"} strokeWidth={1} />
                      <text x={rx} y={py + 1} textAnchor="middle" dominantBaseline="central"
                        fill={rActive ? "#fff" : "#ccc"} filter="url(#tshadow)"
                        fontSize={14} fontWeight={600} fontFamily="'Courier New', monospace">{pair.higherKey}</text>
                    </g>
                    <text x={rx} y={py + R + 14} textAnchor="middle" fill={rActive ? "#aaa" : "#555"}
                      fontSize={11} fontFamily="Inter, system-ui, sans-serif">{pair.higherName}</text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Comma Cluster Scene — local relation clusters, NOT lattice (3D, legacy)
// ═══════════════════════════════════════════════════════════════

interface CommaNodeMeshProps {
  cNode: CommaClusterNode;
  pos: [number, number, number];
  isActive: boolean;
  isHovered: boolean;
  onHover: (key: string | null) => void;
  onClick: (node: HNode) => void;
  labelMode: "intervals" | "ratios";
}

function CommaNodeMesh({ cNode, pos, isActive, isHovered, onHover, onClick, labelMode }: CommaNodeMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const { node, posKey } = cNode;
  const isUnison = node.n === 1 && node.d === 1;
  const r = node.isComma ? NODE_RADIUS_COMMA : NODE_RADIUS;

  const color = useMemo(() => {
    if (isActive) return "#7173e6";
    if (isUnison) return "#9395ea";
    if (node.isComma) return "#553344";
    return "#3a3a4a";
  }, [isActive, isUnison, node.isComma]);

  const emissive = useMemo(() => {
    if (isActive) return "#7173e6";
    if (isHovered) return "#5a5cc8";
    return "#000000";
  }, [isActive, isHovered]);

  useFrame(() => {
    if (!meshRef.current) return;
    const scale = isHovered ? 1.3 : isActive ? 1.2 : 1;
    meshRef.current.scale.lerp(new THREE.Vector3(scale, scale, scale), 0.15);
  });

  const key = nodeKey(node);

  return (
    <group position={pos}>
      <mesh
        ref={meshRef}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(posKey); }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onClick(node); }}
      >
        <sphereGeometry args={[r, 16, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={isHovered ? 0.6 : isActive ? 0.8 : 0}
          roughness={0.5}
          metalness={0.3}
        />
      </mesh>
      <Html
        position={[0, r + 0.08, 0]}
        center
        distanceFactor={10}
        zIndexRange={[1, 0]}
        style={{ pointerEvents: "none" }}
      >
        <div style={{
          textAlign: "center",
          whiteSpace: "nowrap",
          textShadow: "0 0 6px rgba(0,0,0,0.95)",
          lineHeight: 1.2,
        }}>
          {labelMode === "intervals" ? (
            <>
              <div style={{
                color: isHovered || isActive ? "#fff" : "#999",
                fontSize: node.isComma ? 8 : 10,
                fontFamily: "Inter, system-ui, sans-serif",
                fontWeight: 600,
              }}>
                {intervalName(node)}
              </div>
              <div style={{
                color: isHovered || isActive ? "#aaa" : "#444",
                fontSize: node.isComma ? 7 : 8,
                fontFamily: "'Courier New', monospace",
                fontWeight: 400,
              }}>
                {key}
              </div>
            </>
          ) : (
            <div style={{
              color: isHovered || isActive ? "#fff" : "#999",
              fontSize: node.isComma ? 8 : 11,
              fontFamily: "'Courier New', monospace",
              fontWeight: 600,
            }}>
              {key}
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

interface CommaSceneProps {
  commaNodes: CommaClusterNode[];
  commaEdges: { from: string; to: string }[];
  positions: Map<string, [number, number, number]>;
  clusterLabels: CommaClusterLabel[];
  droneNodes: Set<string>;
  hoveredNode: string | null;
  onHover: (key: string | null) => void;
  onClickNode: (node: HNode) => void;
  labelMode: "intervals" | "ratios";
}

function CommaScene({
  commaNodes, commaEdges, positions, clusterLabels,
  droneNodes, hoveredNode, onHover, onClickNode, labelMode,
}: CommaSceneProps) {
  return (
    <>
      <ambientLight intensity={0.6} />
      <pointLight position={[10, 10, 10]} intensity={0.8} />
      <pointLight position={[-8, -5, -10]} intensity={0.3} />

      {/* Comma edges — red dashed lines */}
      {commaEdges.map((e, i) => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return null;
        return (
          <Line
            key={i}
            points={[a, b]}
            color="#ff4444"
            lineWidth={2}
            transparent
            opacity={0.6}
            dashed
            dashScale={8}
            dashSize={0.15}
            gapSize={0.1}
            depthWrite={false}
          />
        );
      })}

      {/* Cluster labels */}
      {clusterLabels.map((cl, i) => (
        <Html
          key={i}
          position={cl.pos}
          center
          distanceFactor={10}
          zIndexRange={[1, 0]}
          style={{ pointerEvents: "none" }}
        >
          <div style={{
            textAlign: "center",
            whiteSpace: "nowrap",
            textShadow: "0 0 6px rgba(0,0,0,0.95)",
            lineHeight: 1.3,
          }}>
            <div style={{
              color: "#ff4444",
              fontSize: 11,
              fontFamily: "Inter, system-ui, sans-serif",
              fontWeight: 700,
            }}>
              {cl.name}
            </div>
            <div style={{
              color: "#884444",
              fontSize: 9,
              fontFamily: "'Courier New', monospace",
            }}>
              {cl.ratio} · {cl.cents}
            </div>
          </div>
        </Html>
      ))}

      {/* Nodes */}
      {commaNodes.map(cNode => {
        const pos = positions.get(cNode.posKey);
        if (!pos) return null;
        return (
          <CommaNodeMesh
            key={cNode.posKey}
            cNode={cNode}
            pos={pos}
            isActive={droneNodes.has(cNode.key)}
            isHovered={hoveredNode === cNode.posKey}
            onHover={onHover}
            onClick={onClickNode}
            labelMode={labelMode}
          />
        );
      })}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        minDistance={2}
        maxDistance={40}
        enablePan
      />
      <KeyboardPan />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// 2D SVG: Otonal / Utonal stacks
// ═══════════════════════════════════════════════════════════════

function OtonalSvg({ stackData, stackIsUtonal, activeNodes, onClickNode }: {
  stackData: { nodes: StackNode[]; edges: StackEdge[]; positions: Map<string, [number, number, number]> };
  stackIsUtonal: boolean;
  activeNodes: Set<string>;
  onClickNode: (node: StackNode) => void;
}) {
  const R = 24;
  const stacks = new Map<number, StackNode[]>();
  for (const n of stackData.nodes) {
    if (!stacks.has(n.stackId)) stacks.set(n.stackId, []);
    stacks.get(n.stackId)!.push(n);
  }
  const stackArr = Array.from(stacks.entries()).map(([id, nodes]) => ({
    id, nodes: [...nodes].sort((a, b) => a.cents - b.cents),
  }));
  const nodeSpacingY = 90, stackSpacingX = 280;
  const padX = 120, padTop = 80, padBot = 60;
  const maxNodes = Math.max(...stackArr.map(s => s.nodes.length));
  const svgW = stackArr.length * stackSpacingX + padX;
  const svgH = maxNodes * nodeSpacingY + padTop + padBot;

  const pos = new Map<string, [number, number]>();
  for (let si = 0; si < stackArr.length; si++) {
    const { nodes } = stackArr[si];
    const cx = padX / 2 + si * stackSpacingX + stackSpacingX / 2;
    for (let ni = 0; ni < nodes.length; ni++) {
      pos.set(`${nodes[ni].stackId}:${nodes[ni].harmonicLabel}`, [cx, padTop + ni * nodeSpacingY + nodeSpacingY / 2]);
    }
  }

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" }}>
      <svg viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ display: "block", width: "100%", height: "100%", maxWidth: svgW * 1.5, maxHeight: svgH * 1.5 }}
        preserveAspectRatio="xMidYMid meet">
        <SvgDefs />
        {stackData.edges.map((e, i) => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#fff" strokeOpacity={0.15} strokeWidth={1.5} />;
        })}
        <text x={svgW / 2} y={30}
          textAnchor="middle" fill="#9395ea" filter="url(#tshadow)"
          fontSize={24} fontWeight={700} fontFamily="Inter, system-ui, sans-serif">
          {stackIsUtonal ? "Utonal" : "Otonal"}
        </text>
        {stackArr.map((s, si) => (
          <text key={`lbl-${s.id}`} x={padX / 2 + si * stackSpacingX + stackSpacingX / 2} y={54}
            textAnchor="middle" fill="#6668aa" filter="url(#tshadow)"
            fontSize={13} fontWeight={600} fontFamily="Inter, system-ui, sans-serif">
            Stack {s.nodes[0]?.harmonicLabel ?? s.id}
          </text>
        ))}
        {/* Interval labels between consecutive nodes in each stack */}
        {stackArr.map(s => s.nodes.map((node, ni) => {
          if (ni >= s.nodes.length - 1) return null;
          const nxt = s.nodes[ni + 1];
          const ka = `${node.stackId}:${node.harmonicLabel}`;
          const kb = `${nxt.stackId}:${nxt.harmonicLabel}`;
          const pa = pos.get(ka), pb = pos.get(kb);
          if (!pa || !pb) return null;
          let num = nxt.n * node.d, den = nxt.d * node.n;
          if (num < den) [num, den] = [den, num];
          const g = _gcd(num, den); num /= g; den /= g;
          const ratio = `${num}/${den}`;
          const name = INTERVAL_NAMES[ratio];
          const my = (pa[1] + pb[1]) / 2;
          return (
            <g key={`iv-${ka}-${kb}`}>
              <text x={pa[0] - R - 8} y={my - 3} textAnchor="end" fill="#e87010"
                fontSize={10} fontWeight={600} fontFamily="'Courier New', monospace">
                {name ?? ratio}</text>
              <text x={pa[0] - R - 8} y={my + 9} textAnchor="end" fill="#665530"
                fontSize={8} fontFamily="'Courier New', monospace">
                {(1200 * Math.log2(num / den)).toFixed(0)}¢</text>
            </g>
          );
        }))}
        {/* Interval labels from 1/1 (root) to each node */}
        {stackArr.map(s => {
          const root = s.nodes[0];
          if (!root) return null;
          return s.nodes.map((node, ni) => {
            if (ni === 0) return null; // skip root itself
            const pk = `${node.stackId}:${node.harmonicLabel}`;
            const p = pos.get(pk);
            if (!p) return null;
            let num = node.n * root.d, den = node.d * root.n;
            if (num < den) [num, den] = [den, num];
            const g = _gcd(num, den); num /= g; den /= g;
            const ratio = `${num}/${den}`;
            const name = INTERVAL_NAMES[ratio];
            return (
              <g key={`fromroot-${pk}`}>
                <text x={p[0] + R + 6} y={p[1] - 8} fill="#5a8a5a"
                  fontSize={10} fontWeight={600} fontFamily="'Courier New', monospace">
                  {name ?? ratio}</text>
                <text x={p[0] + R + 6} y={p[1] + 4} fill="#3a5a3a"
                  fontSize={8} fontFamily="'Courier New', monospace">
                  {ratio} · {(1200 * Math.log2(num / den)).toFixed(0)}¢</text>
              </g>
            );
          });
        })}
        {stackData.nodes.map(node => {
          const key = `${node.stackId}:${node.harmonicLabel}`;
          const p = pos.get(key);
          if (!p) return null;
          const isActive = activeNodes.has(node.label);
          const grad = isActive ? "url(#ng-active)" : "url(#ng-idle)";
          return (
            <g key={key} style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onClickNode(node); }}
              filter={isActive ? "url(#glow)" : undefined}>
              <circle cx={p[0]} cy={p[1]} r={R} fill={grad}
                stroke={isActive ? "#9395ea" : "#444"} strokeWidth={1.5} />
              <text x={p[0]} y={p[1] - 4} textAnchor="middle" fill={isActive ? "#fff" : "#ddd"} filter="url(#tshadow)"
                fontSize={14} fontWeight={700} fontFamily="'Courier New', monospace">H{node.harmonicLabel}</text>
              <text x={p[0]} y={p[1] + 11} textAnchor="middle" fill={isActive ? "#ccc" : "#999"}
                fontSize={11} fontFamily="'Courier New', monospace">{node.label}</text>
              <text x={p[0]} y={p[1] + R + 14} textAnchor="middle" fill="#444"
                fontSize={9} fontFamily="'Courier New', monospace">{node.cents.toFixed(0)}¢</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 2D SVG: Harmonic Series chain
// ═══════════════════════════════════════════════════════════════

function _gcd(a: number, b: number): number { while (b) { [a, b] = [b, a % b]; } return a; }

/** Octave-reduce a ratio and return its INTERVAL_NAMES key */
function intervalNameForHarmonic(n: number, d: number): string | null {
  // Octave-reduce to [1, 2)
  while (n / d >= 2) d *= 2;
  const g = _gcd(n, d); n /= g; d /= g;
  return INTERVAL_NAMES[`${n}/${d}`] ?? null;
}

function HarmonicSvg({ nodes, edges, droneNodes, onClickNode, showIntervals }: {
  nodes: HarmonicNode[]; edges: EdgeDef[]; droneNodes: Set<string>;
  onClickNode: (node: HarmonicNode) => void; showIntervals: boolean;
}) {
  const R = 18, spacing = 75, padX = 50, padY = 60;
  const svgW = nodes.length * spacing + padX;
  const svgH = padY * 2 + R * 2 + (showIntervals ? 54 : 40);
  const cy = svgH / 2;

  const posMap = new Map<string, [number, number]>();
  for (let i = 0; i < nodes.length; i++) {
    posMap.set(nodes[i].label, [padX / 2 + i * spacing + spacing / 2, cy]);
  }

  return (
    <div style={{ width: "100%", height: "100%", overflow: "auto" }}>
      <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ display: "block" }}>
        <SvgDefs />
        {edges.map((e, i) => {
          const a = posMap.get(e.from), b = posMap.get(e.to);
          if (!a || !b) return null;
          return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#e87010" strokeOpacity={0.35} strokeWidth={1} />;
        })}
        {showIntervals && nodes.map((nd, i) => {
          if (i >= nodes.length - 1) return null;
          const a = posMap.get(nd.label), b = posMap.get(nodes[i + 1].label);
          if (!a || !b) return null;
          const mx = (a[0] + b[0]) / 2;
          const nxt = nodes[i + 1];
          let num = nxt.n * nd.d, den = nxt.d * nd.n;
          if (num < den) [num, den] = [den, num];
          const g = _gcd(num, den); num /= g; den /= g;
          const ratio = `${num}/${den}`;
          const cents = (1200 * Math.log2(num / den)).toFixed(0);
          return (
            <g key={`iv-${i}`}>
              <text x={mx} y={cy - R - 12} textAnchor="middle" fill="#e87010" filter="url(#tshadow)"
                fontSize={8} fontWeight={600} fontFamily="'Courier New', monospace">
                {INTERVAL_NAMES[ratio] ?? ratio}</text>
              <text x={mx} y={cy - R - 3} textAnchor="middle" fill="#665530"
                fontSize={7} fontFamily="'Courier New', monospace">{cents}¢</text>
            </g>
          );
        })}
        {nodes.map(nd => {
          const p = posMap.get(nd.label);
          if (!p) return null;
          const isActive = droneNodes.has(nd.label);
          const isRoot = nd.harmonic === 1;
          const grad = isActive ? "url(#ng-active)" : "url(#ng-idle)";
          const ivName = !isRoot && showIntervals ? (INTERVAL_NAMES[nd.label] ?? intervalNameForHarmonic(nd.n, nd.d)) : null;
          return (
            <g key={nd.label} style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onClickNode(nd); }}
              filter={isActive ? "url(#glow)" : undefined}>
              <circle cx={p[0]} cy={p[1]} r={R} fill={grad}
                stroke={isActive ? "#9395ea" : "#444"} strokeWidth={1} />
              <text x={p[0]} y={p[1] - 2} textAnchor="middle" fill={isActive ? "#fff" : "#ddd"} filter="url(#tshadow)"
                fontSize={10} fontWeight={700} fontFamily="'Courier New', monospace">{nd.label}</text>
              <text x={p[0]} y={p[1] + 9} textAnchor="middle" fill={isActive ? "#ccc" : "#777"}
                fontSize={7} fontFamily="Inter, system-ui, sans-serif">H{nd.harmonic}</text>
              <text x={p[0]} y={p[1] + R + 13} textAnchor="middle" fill="#444"
                fontSize={7} fontFamily="'Courier New', monospace">{ratioToCents(nd.n, nd.d).toFixed(0)}¢</text>
              {ivName && (
                <text x={p[0]} y={p[1] + R + 24} textAnchor="middle" fill="#c8aa50"
                  fontSize={7} fontWeight={500} fontFamily="Inter, system-ui, sans-serif">{ivName}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 2D SVG: Interval Chain — each chain-of-fifths on its own row
// ═══════════════════════════════════════════════════════════════

/** Group key for chain rows: all prime exponents except the first prime (3).
 *  exps[] aligns 1:1 with primes[]. We skip the first (3-axis) and use the rest. */
function chainSigFromMonzo(exps: number[], _primes: number[]): string {
  return exps.slice(1).join(",");
}

/** Label describing the non-3 signature, e.g. "5¹" or "7⁻¹·11¹" */
function sigLabelFromPrimes(sig: string, primes: number[]): string {
  const vals = sig.split(",").map(Number);
  const SUP: Record<string, string> = {
    "-": "\u207B", "0": "\u2070", "1": "\u00B9", "2": "\u00B2", "3": "\u00B3",
    "4": "\u2074", "5": "\u2075", "6": "\u2076", "7": "\u2077", "8": "\u2078", "9": "\u2079",
  };
  const sup = (n: number) => String(n).split("").map(c => SUP[c] ?? c).join("");
  const parts: string[] = [];
  // primes[0] is 3 (the chain axis), so primes[1..] align with vals[0..]
  for (let i = 0; i < vals.length; i++) {
    if (vals[i]) parts.push(`${primes[i + 1]}${sup(vals[i])}`);
  }
  return parts.join("·") || "3-limit";
}

/** Zero-signature string for "3-limit" row detection */
function zeroSig(primes: number[]): string {
  return new Array(Math.max(0, primes.length - 1)).fill(0).join(",");
}

interface ChainRow {
  sig: string;
  label: string;
  nodes: LatticeNode[];    // sorted by a3 exponent
  minA3: number;
  maxA3: number;
}

function ChainSvg({ droneNodes, onClickNode, lattice, labelMode, rootPc = 0 }: {
  droneNodes: Set<string>;
  onClickNode: (node: LatticeNode) => void;
  lattice: BuiltLattice;
  labelMode: "intervals" | "ratios";
  rootPc?: number;
}) {
  const R = 18, spacingX = 85, rowH = 70, pad = 50, labelW = 80;
  const primes = lattice.primes.filter(p => p !== 2);
  const i3 = primes.indexOf(3); // index of prime 3 in the filtered list

  // Build chain rows grouped by non-3 exponents, sorted by a3 within each
  const rows: ChainRow[] = useMemo(() => {
    if (i3 < 0) return []; // need prime 3 for chains
    const groups = new Map<string, LatticeNode[]>();
    for (const nd of lattice.nodes) {
      if (nd.monzo.isComma) continue;
      const sig = chainSigFromMonzo(nd.monzo.exps, primes);
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig)!.push(nd);
    }
    const result: ChainRow[] = [];
    for (const [sig, nodes] of groups) {
      nodes.sort((a, b) => a.monzo.exps[i3] - b.monzo.exps[i3]);
      result.push({
        sig,
        label: sigLabelFromPrimes(sig, primes),
        nodes,
        minA3: nodes[0].monzo.exps[i3],
        maxA3: nodes[nodes.length - 1].monzo.exps[i3],
      });
    }
    const zs = zeroSig(primes);
    result.sort((a, b) => {
      if (a.sig === zs) return -1;
      if (b.sig === zs) return 1;
      const avgA = a.nodes.reduce((s, n) => s + n.monzo.n / n.monzo.d, 0) / a.nodes.length;
      const avgB = b.nodes.reduce((s, n) => s + n.monzo.n / n.monzo.d, 0) / b.nodes.length;
      return avgA - avgB;
    });
    return result;
  }, [lattice.nodes, primes, i3]);

  // Global a3 range for consistent X alignment across rows
  const globalMinA3 = useMemo(() => Math.min(...rows.map(r => r.minA3)), [rows]);
  const globalMaxA3 = useMemo(() => Math.max(...rows.map(r => r.maxA3)), [rows]);
  const cols = globalMaxA3 - globalMinA3 + 1;

  // Measure container width so SVG fills horizontally
  const cRef = useRef<HTMLDivElement>(null);
  const [cW, setCW] = useState(800);
  useEffect(() => {
    const el = cRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setCW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scale to fill container width; height follows naturally
  const naturalW = labelW + cols * spacingX + pad;
  const sc = cW / naturalW;
  const sRowH = rowH * sc;
  const sPad = pad * sc;
  const sR = R * sc;
  const sLW = labelW * sc;
  const svgH = rows.length * sRowH + sPad * 2;

  // Position map scaled to container width
  const posMap = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (let ri = 0; ri < rows.length; ri++) {
      const cy = sPad + ri * sRowH + sRowH / 2;
      for (const nd of rows[ri].nodes) {
        const cx = (labelW + (nd.monzo.exps[i3] - globalMinA3) * spacingX + spacingX / 2) * sc;
        map.set(nd.key, [cx, cy]);
      }
    }
    return map;
  }, [rows, globalMinA3, sc, sRowH, sPad, i3]);

  // Filter edges: only generator edges between visible nodes
  const visibleEdges = useMemo(
    () => lattice.edges.filter(e => e.type === "generator" && posMap.has(e.from) && posMap.has(e.to)),
    [lattice.edges, posMap],
  );

  // All non-comma nodes flat
  const allNodes = useMemo(() => rows.flatMap(r => r.nodes), [rows]);

  return (
    <div ref={cRef}
      style={{ width: "100%", height: "100%", overflowX: "hidden", overflowY: "auto" }}>
      <svg width={cW} height={svgH} style={{ display: "block" }}>
        <SvgDefs />
        {/* Row backgrounds and labels */}
        {rows.map((row, ri) => {
          const y = sPad + ri * sRowH;
          return (
            <g key={`row-${ri}`}>
              {ri % 2 === 1 && (
                <rect x={0} y={y} width={cW} height={sRowH}
                  fill="#ffffff" fillOpacity={0.015} />
              )}
              <text x={sLW - 6 * sc} y={y + sRowH / 2 + 3}
                textAnchor="end" fill="#555" fontSize={Math.max(8, 9 * sc)}
                fontWeight={500} fontFamily="'Courier New', monospace">
                {row.label}
              </text>
            </g>
          );
        })}
        {/* Edges */}
        {visibleEdges.map((e, i) => {
          const a = posMap.get(e.from), b = posMap.get(e.to);
          if (!a || !b) return null;
          const color = MONZO_PRIME_COLORS[e.prime] ?? "#555";
          const sameRow = Math.abs(a[1] - b[1]) < 1;
          return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
            stroke={color} strokeOpacity={sameRow ? 0.45 : 0.25}
            strokeWidth={sameRow ? 1.5 : 1}
            strokeDasharray={sameRow ? undefined : "4 3"} />;
        })}
        {/* Nodes */}
        {allNodes.map(nd => {
          const key = nd.key;
          const p = posMap.get(key);
          if (!p) return null;
          const isActive = droneNodes.has(key);
          const grad = isActive ? "url(#ng-active)" : "url(#ng-idle)";
          const iName = monzoIntervalName(nd.monzo.n, nd.monzo.d);
          const label = labelMode === "intervals" ? iName : key;
          const note = ratioToNoteName(nd.monzo.n, nd.monzo.d, rootPc);
          return (
            <g key={key} style={{ cursor: "pointer" }}
              onClick={(ev) => { ev.stopPropagation(); onClickNode(nd); }}
              filter={isActive ? "url(#glow)" : undefined}>
              <circle cx={p[0]} cy={p[1]} r={sR} fill={grad}
                stroke={isActive ? "#9395ea" : "#444"} strokeWidth={1} />
              {/* Note name on top */}
              <text x={p[0]} y={p[1] - 10 * sc} textAnchor="middle"
                fill={isActive ? "#7df" : "#4ac"}
                fontSize={Math.max(7, 10 * sc)} fontWeight={700}
                fontFamily="Inter, system-ui, sans-serif">{note}</text>
              <text x={p[0]} y={p[1] - 2 * sc} textAnchor="middle"
                fill={isActive ? "#fff" : "#ddd"}
                fontSize={Math.max(7, 9 * sc)} fontWeight={700}
                fontFamily="'Courier New', monospace">{label}</text>
              <text x={p[0]} y={p[1] + 9 * sc} textAnchor="middle"
                fill={isActive ? "#ccc" : "#555"}
                fontSize={Math.max(6, 7 * sc)} fontFamily="'Courier New', monospace">
                {labelMode === "intervals" ? key : iName}
              </text>
            </g>
          );
        })}
        {/* Column headers: a3 exponent */}
        {Array.from({ length: cols }, (_, i) => {
          const a3 = globalMinA3 + i;
          const cx = (labelW + i * spacingX + spacingX / 2) * sc;
          const SUP_D: Record<string, string> = {
            "-": "\u207B", "0": "\u2070", "1": "\u00B9", "2": "\u00B2", "3": "\u00B3",
            "4": "\u2074", "5": "\u2075", "6": "\u2076", "7": "\u2077", "8": "\u2078", "9": "\u2079",
          };
          const sup = String(a3).split("").map(c => SUP_D[c] ?? c).join("");
          return (
            <text key={`col-${i}`} x={cx} y={sPad - 6 * sc} textAnchor="middle"
              fill="#333" fontSize={Math.max(7, 8 * sc)} fontFamily="'Courier New', monospace">
              3{sup}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Main component
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Monzo Lattice Scene (arbitrary primes, tempering, topology)
// ═══════════════════════════════════════════════════════════════

interface MonzoNodeMeshProps {
  node: LatticeNode;
  pos: [number, number, number];
  isActive: boolean;
  /** Optional per-node override colour for the active highlight,
   *  used by the chord-tab harmonic-lattice toggle buttons to paint
   *  pinned chords each in their own colour. */
  activeColor?: string;
  isHovered: boolean;
  isFocused?: boolean;
  showLabel?: boolean;
  labelLOD?: boolean;
  labelDist?: number;
  onHover: (key: string | null) => void;
  onClick: (node: LatticeNode) => void;
  onFocus?: (key: string) => void;
  primes: number[];
  temperedClass?: number;
  classColorMap: Map<number, string>;
  rootPc?: number;
  /** Which label sub-layers are visible */
  showNoteNames?: boolean;
  showIntervals?: boolean;
  showRatios?: boolean;
  showMonzo?: boolean;
  showHeji?: boolean;
  /** When tempered, all ratio keys sharing this equivalence class */
  temperedSiblings?: string[];
  /** Whether this node is the "simplest" representative of its tempered class */
  isClassRep?: boolean;
  /** Whether this node is on the traced path */
  isOnPath?: boolean;
  /** Whether this node is an endpoint (origin/target) of the path — keeps labels + normal size */
  isPathEndpoint?: boolean;
  /** Whether this node is on a persistent (pinned/auto) path — labels stay visible */
  isPinnedPath?: boolean;
  /** Ctrl+click handler for pinning paths */
  onCtrlClick?: (node: LatticeNode) => void;
  /** Whether this node matches a custom ratio entry */
  isHighlighted?: boolean;
  /** Whether highlight mode is active (dims non-highlighted nodes) */
  highlightMode?: boolean;
  /** Whether this is a non-representative node shown in class view (translucent) */
  isNonRepClass?: boolean;
  /** Show equivalence class ID on label */
  showClassId?: boolean;
  /** EDO denominator for class labels — when set, the class ID is
   *  rendered as `N\edo` instead of `class N` so the user reads it as
   *  a tempered pitch step rather than an opaque cluster index. */
  edo?: number;
}

const TEMPER_CLASS_COLORS = [
  "#e06060", "#60e060", "#6060e0", "#e0e060", "#e060e0", "#60e0e0",
  "#ff8844", "#44ff88", "#8844ff", "#ffaa66", "#66ffaa", "#aa66ff",
];

function MonzoNodeMesh({ node, pos, isActive, activeColor, isHovered, isFocused, showLabel = true, labelLOD = false, labelDist = 15, onHover, onClick, onFocus, onCtrlClick, primes, temperedClass, classColorMap, rootPc, showNoteNames = true, showIntervals = true, showRatios = true, showMonzo = false, showHeji = false, temperedSiblings, isClassRep, isOnPath, isPathEndpoint, isPinnedPath, isHighlighted, highlightMode, isNonRepClass, showClassId, edo }: MonzoNodeMeshProps) {
  const isDimmed = (highlightMode && !isHighlighted && !isActive && !isFocused && !isOnPath) || isNonRepClass;
  // Bigger nodes by default — easier to read note labels and to
  // track which cells light up during chord playback.  In EDO
  // mode the dots get a further bump so the 12 / 31 / 41 / 53
  // reps stand out clearly against a black background.
  const baseR = node.monzo.isComma ? 0.18 : (edo !== undefined ? 0.55 : 0.36);
  const r = isHighlighted ? baseR * 1.3 : (isOnPath && !isPathEndpoint) ? baseR * 0.45 : baseR;
  const isUnison = node.monzo.n === 1 && node.monzo.d === 1;

  const color = useMemo(() => {
    if (isHighlighted) return "#44ddff";
    if (isOnPath && !isPathEndpoint) return "#ffffff";
    if (isFocused) return "#e0a030";
    if (isActive) return activeColor ?? "#7173e6";
    if (isPathEndpoint) return "#7df";
    // EDO context: suppress the unison-tonic accent + per-class
    // colour map.  All cells render in a single resting colour
    // (light enough to be unmistakable on a black background) so
    // the only thing that draws the eye is the active chord-tone
    // pulse (isActive above).
    if (edo !== undefined) return "#c8c8d0";
    if (isUnison) return "#9395ea";
    if (node.monzo.isComma) return "#553344";
    if (temperedClass !== undefined) return classColorMap.get(temperedClass) ?? "#3a3a4a";
    return "#3a3a4a";
  }, [isActive, activeColor, isUnison, isFocused, isOnPath, isPathEndpoint, isHighlighted, node.monzo.isComma, temperedClass, classColorMap, edo]);

  const emissive = useMemo(() => {
    if (isHighlighted) return "#44ddff";
    if (isOnPath && !isPathEndpoint) return "#ffffff";
    if (isFocused) return "#e0a030";
    if (isActive) return activeColor ?? "#7173e6";
    if (isPathEndpoint) return "#7df";
    if (isHovered) return "#5a5cc8";
    return "#000000";
  }, [isActive, activeColor, isHovered, isFocused, isOnPath, isPathEndpoint, isHighlighted]);

  const noteName = useMemo(() => ratioToNoteName(node.monzo.n, node.monzo.d, rootPc ?? 0), [node.monzo.n, node.monzo.d, rootPc]);

  // HEJI notation data (computed when HEJI layer is active)
  const hejiLabel = useMemo(() => {
    if (!showHeji) return null;
    return ratioToHEJILabel(node.monzo.n, node.monzo.d, rootPc ?? 0);
  }, [showHeji, node.monzo.n, node.monzo.d, rootPc]);

  // Only the class representative renders labels — prevents stacking at shared positions
  // Hide labels for intermediate hover-path nodes, but show on endpoints and pinned/auto paths
  const shouldShowLabel = showLabel && isClassRep !== false && (!isOnPath || isPathEndpoint || isPinnedPath);

  const intervalText = useMemo(() => {
    if (!showIntervals) return "";
    return monzoIntervalName(node.monzo.n, node.monzo.d);
  }, [showIntervals, node]);

  const allIntervalNames = useMemo(() => monzoIntervalAllNames(node.monzo.n, node.monzo.d), [node.monzo.n, node.monzo.d]);
  const hasMultipleNames = allIntervalNames.length > 1;

  // hasTemperedSiblings: true if this node has tempered equivalents — independent of label dedup
  const hasTemperedSiblings = temperedSiblings && temperedSiblings.length > 1;

  const isSmall = node.monzo.isComma;
  const hi = isHovered || isActive || isFocused;

  return (
    <group position={pos}>
      <mesh
        onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(node.key); }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.nativeEvent.shiftKey && onFocus) { onFocus(node.key); }
          else if ((e.nativeEvent.ctrlKey || e.nativeEvent.metaKey) && onCtrlClick) { onCtrlClick(node); }
          else { onClick(node); }
        }}
        scale={isHovered ? 1.3 : isActive ? 1.2 : isFocused ? 1.15 : 1}
      >
        <sphereGeometry args={[r, 12, 8]} />
        <meshStandardMaterial color={color} emissive={emissive}
          emissiveIntensity={isHighlighted ? 0.7 : isFocused ? 0.5 : isHovered ? 0.6 : isActive ? 0.8 : isPathEndpoint ? 0.5 : isOnPath ? 0.3 : 0}
          roughness={0.5} metalness={0.3}
          transparent={isDimmed} opacity={isDimmed ? 0.35 : 1} />
      </mesh>
      {shouldShowLabel && (
        <Html
          position={[0, r + 0.12, 0]}
          center
          distanceFactor={8}
          zIndexRange={[1, 0]}
          style={{ pointerEvents: "none" }}
        >
          <div style={{
            textAlign: "center",
            whiteSpace: "nowrap",
            textShadow: "0 0 6px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,1)",
            transition: "color 0.15s",
            lineHeight: 1.2,
          }}>
            {/* HEJI layer — note letter + accidental (blue) */}
            {showHeji && hejiLabel && (
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 1,
                color: hi ? "#88bbff" : "#5588cc",
                lineHeight: 1,
              }}>
                {/* Note letter (always shown) */}
                <span style={{
                  fontSize: isSmall ? 9 : 13,
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontWeight: 700,
                }}>
                  {hejiLabel.notation.letter}
                </span>
                {/* If there are comma modifiers → show HEJI2Text glyph (includes ♭/♯ + comma arrow) */}
                {/* If no commas but has accidental → show HEJI2Text base accidental */}
                {hejiLabel.accidentalSmufl ? (
                  <span style={{
                    fontSize: isSmall ? 12 : 18,
                    fontFamily: "'HEJI2'",
                    fontWeight: 400,
                  }}>
                    {hejiLabel.accidentalSmufl}
                  </span>
                ) : hejiLabel.notation.accidentals !== 0 ? (
                  <span style={{
                    fontSize: isSmall ? 9 : 13,
                    fontFamily: "Inter, system-ui, sans-serif",
                    fontWeight: 700,
                  }}>
                    {accidentalText(hejiLabel.notation.accidentals)}
                  </span>
                ) : null}
              </div>
            )}
            {showNoteNames && (
              <div style={{
                color: hi ? "#f0a0ff" : "#c070d0",
                // Bigger note names in EDO mode — easier to read at
                // arm's length when the lattice is the focus of
                // attention, not just an ornament.
                fontSize: edo !== undefined ? (isSmall ? 14 : 20) : (isSmall ? 9 : 14),
                fontFamily: "Inter, system-ui, sans-serif",
                fontWeight: 700,
              }}>
                {noteName}
              </div>
            )}
            {showIntervals && intervalText && (
              <div style={{
                color: hi ? "#fff" : "#999",
                fontSize: isSmall ? 10 : 13,
                fontFamily: "Inter, system-ui, sans-serif",
                fontWeight: 600,
              }}>
                {intervalText}
              </div>
            )}
            {showRatios && (!showIntervals || intervalText !== node.key) && (
              <div style={{
                color: hi ? "#e8c76a" : "#8a7540",
                fontSize: isSmall ? 9 : 11,
                fontFamily: "'Courier New', monospace",
                fontWeight: 400,
              }}>
                {node.key}
              </div>
            )}
            {showMonzo && (
              <div style={{
                color: hi ? "#c8b0ff" : "#8870aa",
                fontSize: isSmall ? 9 : 11,
                fontFamily: "'Courier New', monospace",
                fontWeight: 400,
              }}>
                {monzoLabel(node.monzo.exps, primes)}
              </div>
            )}
            {showClassId && temperedClass !== undefined && (
              <div style={{
                color: classColorMap.get(temperedClass) ?? "#888",
                // Larger step labels in EDO mode (e.g. "0\12") so
                // the user can read them at arm's length without
                // squinting.
                fontSize: edo !== undefined ? (isSmall ? 12 : 16) : (isSmall ? 9 : 11),
                fontFamily: "Inter, system-ui, sans-serif",
                fontWeight: 700,
              }}>
                {edo ? `${temperedClass}\\${edo}` : `class ${temperedClass}`}
              </div>
            )}
            {hasTemperedSiblings && !isHovered && (
              <div style={{
                color: "#664444",
                fontSize: 7,
                fontFamily: "Inter, system-ui, sans-serif",
                fontWeight: 500,
              }}>
                (+{temperedSiblings!.length - 1} tempered)
              </div>
            )}
          </div>
        </Html>
      )}
      {/* Tempered siblings tooltip — rendered independently of label dedup so it always shows on hover */}
      {hasTemperedSiblings && isHovered && (
        <Html
          position={[0, -(r + 0.06), 0]}
          center
          distanceFactor={12}
          zIndexRange={[10, 5]}
          style={{ pointerEvents: "none" }}
        >
          <div style={{
            padding: "4px 8px",
            background: "rgba(0,0,0,0.92)",
            borderRadius: 5,
            border: "1px solid #555",
            textAlign: "center",
            whiteSpace: "nowrap",
            textShadow: "0 0 4px rgba(0,0,0,1)",
          }}>
            <div style={{
              fontSize: 8,
              color: "#888",
              fontFamily: "Inter, system-ui, sans-serif",
              marginBottom: 2,
              fontWeight: 600,
            }}>
              tempered with
            </div>
            {temperedSiblings!.filter(k => k !== node.key).map(k => {
              const [ns, ds] = k.split("/");
              const kn = parseInt(ns, 10), kd = parseInt(ds || "1", 10);
              const iName = monzoIntervalName(kn, kd);
              return (
                <div key={k} style={{
                  color: "#ff9977",
                  fontSize: 10,
                  fontFamily: "'Courier New', monospace",
                  lineHeight: 1.5,
                  fontWeight: 600,
                  display: "flex",
                  gap: 6,
                  justifyContent: "center",
                }}>
                  <span>{k}</span>
                  {iName && <span style={{ color: "#cc8866", fontFamily: "Inter, system-ui, sans-serif", fontSize: 9 }}>{iName}</span>}
                </div>
              );
            })}
          </div>
        </Html>
      )}
      {/* Interval names tooltip on hover — shows all alternative names from the xen database */}
      {hasMultipleNames && isHovered && !hasTemperedSiblings && (
        <Html
          position={[0, -(r + 0.06), 0]}
          center
          distanceFactor={12}
          zIndexRange={[10, 5]}
          style={{ pointerEvents: "none" }}
        >
          <div style={{
            padding: "4px 8px",
            background: "rgba(0,0,0,0.92)",
            borderRadius: 5,
            border: "1px solid #444",
            textAlign: "center",
            whiteSpace: "nowrap",
            textShadow: "0 0 4px rgba(0,0,0,1)",
          }}>
            <div style={{
              fontSize: 8,
              color: "#888",
              fontFamily: "Inter, system-ui, sans-serif",
              marginBottom: 2,
              fontWeight: 600,
            }}>
              also known as
            </div>
            {allIntervalNames.slice(1).map((name, i) => (
              <div key={i} style={{
                color: "#aabbdd",
                fontSize: 9,
                fontFamily: "Inter, system-ui, sans-serif",
                lineHeight: 1.5,
                fontWeight: 500,
              }}>
                {name}
              </div>
            ))}
          </div>
        </Html>
      )}
    </group>
  );
}

interface MonzoSceneProps {
  lattice: BuiltLattice;
  topology: TopologyInfo;
  droneNodes: Set<string>;
  /** Optional per-node colour override — paints `isActive` nodes in
   *  the supplied colour instead of the default #7173e6.  Used by
   *  the chord-tab harmonic-lattice toggle buttons to render each
   *  pinned chord in a distinct colour. */
  nodeColorOverrides?: Map<string, string>;
  /** Curved arcs that arch up out of the lattice surface, one per
   *  comma-drift-compensated chord.  Each arc connects the chord's
   *  uncompensated class rep to its compensated rep so the user can
   *  see exactly which step the playback shifted by to keep the
   *  tonic anchored.  Arcs lift above the cylinder so they don't get
   *  visually confused with the in-plane P5 / M3 chains. */
  compensationArcs?: Array<{ fromClassId: number; toClassId: number; color: string; chordIdx: number }>;
  hoveredNode: string | null;
  onHover: (key: string | null) => void;
  onClickNode: (node: LatticeNode) => void;
  onFocusNode?: (key: string) => void;
  focusKey: string | null;
  showTopoSurface: boolean;
  layers: { nodes: boolean; primeEdges: boolean; temperedEdges: boolean; noteNames: boolean; intervals: boolean; ratios: boolean; monzo: boolean; heji: boolean; classes: boolean };
  pathMode: boolean;
  labelLOD: boolean;
  labelDist: number;
  rootPc: number;
  highlightedRatios?: Set<string>;
  autoPathTargets?: Set<string>;
  clearPinnedKey?: number;
}

function MonzoScene({ lattice, topology, droneNodes, nodeColorOverrides, compensationArcs, hoveredNode, onHover, onClickNode, onFocusNode, focusKey, showTopoSurface, layers, pathMode, labelLOD, labelDist, rootPc, highlightedRatios, autoPathTargets, clearPinnedKey }: MonzoSceneProps) {
  const useTopoPositions = showTopoSurface && (topology.type === "torus" || topology.type === "cylinder");
  const topoPositions = useMemo(() => {
    if (!useTopoPositions) return null;
    return projectNodesToTopoSurface(lattice, topology);
  }, [lattice, topology, useTopoPositions]);

  const topoMesh = useMemo(() => {
    if (!showTopoSurface) return null;
    if (topology.type === "torus") return generateTorusMesh(8, 3, 24, 12);
    if (topology.type === "cylinder") return generateCylinderMesh(6, 16, 24, 6);
    return null;
  }, [topology, showTopoSurface]);

  // Build color map for tempered equivalence classes
  const classColorMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const [, classId] of lattice.classMap) {
      if (!map.has(classId)) {
        map.set(classId, TEMPER_CLASS_COLORS[classId % TEMPER_CLASS_COLORS.length]);
      }
    }
    return map;
  }, [lattice.classMap]);

  // Build tempered siblings map and pick simplest representative per class
  // Only consider nodes actually present in the current (possibly filtered) lattice
  // Also deduplicate by position: when tempering lerps different-class reps to nearly
  // the same 3D position, only the simplest ratio keeps its label.
  const { siblingsMap, classRepSet, posLabelSet, dedupVisibleSet } = useMemo(() => {
    const visibleKeys = new Set(lattice.nodes.map(n => n.key));
    const members = new Map<number, string[]>();
    for (const [key, classId] of lattice.classMap) {
      if (!visibleKeys.has(key)) continue; // skip filtered-out nodes
      if (!members.has(classId)) members.set(classId, []);
      members.get(classId)!.push(key);
    }
    const sibMap = new Map<string, string[]>();
    const repSet = new Set<string>();
    for (const [, keys] of members) {
      if (keys.length < 2) continue;
      // Two-tier rep score:
      //   tier 0 = ratio is octave-reduced into [1, 2)
      //   tier 1 = anything else
      //   secondary = smallest n*d
      // Without the in-octave tier, the picker favours cells at
      // a=0 (since 2^0 = 1 makes n*d minimal), which collapses
      // every rep onto the prime-2 = 0 plane and flattens the
      // lattice.  Tonescape's TM-basis spreads cells across the
      // prime-2 axis precisely because it picks octave-reduced
      // representatives — that's where the toroidal 3D depth
      // comes from.
      let bestKey = keys[0];
      let bestTier = 2;
      let bestScore = Infinity;
      for (const k of keys) {
        const parts = k.split("/");
        const n = parseInt(parts[0], 10);
        const d = parts[1] ? parseInt(parts[1], 10) : 1;
        const ratio = n / d;
        const tier = (ratio >= 1 && ratio < 2) ? 0 : 1;
        const score = n * d;
        if (tier < bestTier || (tier === bestTier && score < bestScore)) {
          bestTier = tier;
          bestScore = score;
          bestKey = k;
        }
      }
      repSet.add(bestKey);
      for (const k of keys) sibMap.set(k, keys);
    }

    // Position-based dedup: group ALL nodes by rounded tempered position,
    // keep only the simplest ratio per position bucket.
    const posMap = topoPositions ?? lattice.positions;
    const POS_PRECISION = 100; // round to 0.01
    const buckets = new Map<string, { key: string; score: number }>();
    const labelSet = new Set<string>(); // keys that should show labels
    const dedupSet = new Set<string>(); // keys that survive full position-based dedup

    for (const node of lattice.nodes) {
      const pos = posMap.get(node.key) ?? node.pos3d;
      const bk = `${Math.round(pos[0] * POS_PRECISION)},${Math.round(pos[1] * POS_PRECISION)},${Math.round(pos[2] * POS_PRECISION)}`;
      const parts = node.key.split("/");
      const n = parseInt(parts[0], 10);
      const d = parts[1] ? parseInt(parts[1], 10) : 1;
      const score = n * d;
      const existing = buckets.get(bk);
      if (!existing || score < existing.score) {
        buckets.set(bk, { key: node.key, score });
      }
    }
    for (const { key } of buckets.values()) {
      labelSet.add(key);
      dedupSet.add(key);
    }

    return { siblingsMap: sibMap, classRepSet: repSet, posLabelSet: labelSet, dedupVisibleSet: dedupSet };
  }, [lattice.classMap, lattice.nodes, lattice.positions, topoPositions]);

  // BFS adjacency map for path mode or auto-path targets (built once per lattice)
  const hasAutoTargets = !!autoPathTargets && autoPathTargets.size > 0;
  const adjacency = useMemo(() => {
    if (!pathMode && !hasAutoTargets) return null;
    const adj = new Map<string, { neighbor: string; edge: LatticeEdge }[]>();
    for (const edge of lattice.edges) {
      if (edge.type !== "generator") continue;
      if (!adj.has(edge.from)) adj.set(edge.from, []);
      if (!adj.has(edge.to)) adj.set(edge.to, []);
      adj.get(edge.from)!.push({ neighbor: edge.to, edge });
      adj.get(edge.to)!.push({ neighbor: edge.from, edge });
    }
    return adj;
  }, [pathMode, hasAutoTargets, lattice.edges]);

  // BFS all shortest paths from focus to hovered node
  const pathEdgeSet = useMemo(() => {
    if (!pathMode || !adjacency || !hoveredNode) return null;
    const origin = focusKey ?? "1/1";
    if (hoveredNode === origin) return new Set<LatticeEdge>();
    // BFS to find shortest distance to every node
    const dist = new Map<string, number>([[origin, 0]]);
    const queue = [origin];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const d = dist.get(curr)!;
      for (const { neighbor } of adjacency.get(curr) ?? []) {
        if (!dist.has(neighbor)) {
          dist.set(neighbor, d + 1);
          queue.push(neighbor);
        }
      }
    }
    if (!dist.has(hoveredNode)) return null;
    // Collect all edges on any shortest path by backtracking from target
    // An edge (u,v) is on a shortest path if dist[u] + 1 === dist[v] or vice versa,
    // and the node closer to target is reachable on a shortest path to hoveredNode
    const targetDist = dist.get(hoveredNode)!;
    // Find all nodes on any shortest path (backtrack from target)
    const onPath = new Set<string>([hoveredNode]);
    const layers: string[][] = [];
    // Group nodes by distance
    const byDist = new Map<number, string[]>();
    for (const [k, d] of dist) {
      if (!byDist.has(d)) byDist.set(d, []);
      byDist.get(d)!.push(k);
    }
    // Backtrack: a node at distance d is on a shortest path if it connects to a node at d+1 that's on a shortest path
    for (let d = targetDist - 1; d >= 0; d--) {
      for (const node of byDist.get(d) ?? []) {
        for (const { neighbor } of adjacency.get(node) ?? []) {
          if (dist.get(neighbor) === d + 1 && onPath.has(neighbor)) {
            onPath.add(node);
            break;
          }
        }
      }
    }
    // Collect edges between consecutive-distance nodes that are both on a shortest path
    const edges = new Set<LatticeEdge>();
    for (const node of onPath) {
      const d = dist.get(node)!;
      for (const { neighbor, edge } of adjacency.get(node) ?? []) {
        if (dist.get(neighbor) === d + 1 && onPath.has(neighbor)) {
          edges.add(edge);
        }
      }
    }
    return edges;
  }, [pathMode, adjacency, hoveredNode, focusKey]);

  // Pinned path targets (ctrl+click toggles)
  const [pinnedTargets, setPinnedTargets] = useState<Set<string>>(new Set());

  // BFS helper: all shortest-path edges from origin to target
  const bfsAllShortestEdges = useCallback((target: string): Set<LatticeEdge> | null => {
    if (!adjacency) return null;
    const origin = focusKey ?? "1/1";
    if (target === origin) return new Set();
    const dist = new Map<string, number>([[origin, 0]]);
    const queue = [origin];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const d = dist.get(curr)!;
      for (const { neighbor } of adjacency.get(curr) ?? []) {
        if (!dist.has(neighbor)) { dist.set(neighbor, d + 1); queue.push(neighbor); }
      }
    }
    if (!dist.has(target)) return null;
    const targetDist = dist.get(target)!;
    const byDist = new Map<number, string[]>();
    for (const [k, d] of dist) { if (!byDist.has(d)) byDist.set(d, []); byDist.get(d)!.push(k); }
    const onPath = new Set<string>([target]);
    for (let d = targetDist - 1; d >= 0; d--) {
      for (const node of byDist.get(d) ?? []) {
        for (const { neighbor } of adjacency.get(node) ?? []) {
          if (dist.get(neighbor) === d + 1 && onPath.has(neighbor)) { onPath.add(node); break; }
        }
      }
    }
    const edges = new Set<LatticeEdge>();
    for (const node of onPath) {
      const d = dist.get(node)!;
      for (const { neighbor, edge } of adjacency.get(node) ?? []) {
        if (dist.get(neighbor) === d + 1 && onPath.has(neighbor)) edges.add(edge);
      }
    }
    return edges;
  }, [adjacency, focusKey]);

  // Auto-path edges: shortest paths from origin to all autoPathTargets
  const autoPathEdgeSet = useMemo(() => {
    if (!hasAutoTargets || !adjacency) return null;
    const all = new Set<LatticeEdge>();
    for (const target of autoPathTargets!) {
      const edges = bfsAllShortestEdges(target);
      if (edges) for (const e of edges) all.add(e);
    }
    return all.size > 0 ? all : null;
  }, [hasAutoTargets, autoPathTargets, bfsAllShortestEdges, adjacency]);

  // Pinned path edges (union of all pinned targets)
  const pinnedEdgeSet = useMemo(() => {
    if (!pathMode || pinnedTargets.size === 0) return null;
    const all = new Set<LatticeEdge>();
    for (const target of pinnedTargets) {
      const edges = bfsAllShortestEdges(target);
      if (edges) for (const e of edges) all.add(e);
    }
    return all.size > 0 ? all : null;
  }, [pathMode, pinnedTargets, bfsAllShortestEdges]);

  // Combined: hover path + pinned paths + auto paths
  const combinedEdgeSet = useMemo(() => {
    if (!pathEdgeSet && !pinnedEdgeSet && !autoPathEdgeSet) return null;
    const combined = new Set<LatticeEdge>();
    if (autoPathEdgeSet) for (const e of autoPathEdgeSet) combined.add(e);
    if (pinnedEdgeSet) for (const e of pinnedEdgeSet) combined.add(e);
    if (pathEdgeSet) for (const e of pathEdgeSet) combined.add(e);
    return combined.size > 0 ? combined : null;
  }, [pathEdgeSet, pinnedEdgeSet, autoPathEdgeSet]);

  const combinedNodeSet = useMemo(() => {
    if (!combinedEdgeSet) return null;
    const nodes = new Set<string>();
    for (const edge of combinedEdgeSet) { nodes.add(edge.from); nodes.add(edge.to); }
    return nodes;
  }, [combinedEdgeSet]);

  // Persistent path nodes (pinned + auto — NOT hover) — labels stay visible after mouse moves away
  const persistentPathNodeSet = useMemo(() => {
    if (!pinnedEdgeSet && !autoPathEdgeSet) return null;
    const nodes = new Set<string>();
    if (pinnedEdgeSet) for (const e of pinnedEdgeSet) { nodes.add(e.from); nodes.add(e.to); }
    if (autoPathEdgeSet) for (const e of autoPathEdgeSet) { nodes.add(e.from); nodes.add(e.to); }
    return nodes.size > 0 ? nodes : null;
  }, [pinnedEdgeSet, autoPathEdgeSet]);

  // Ctrl+click handler for pinning/unpinning paths
  const handleCtrlClick = useCallback((node: LatticeNode) => {
    setPinnedTargets(prev => {
      const next = new Set(prev);
      if (next.has(node.key)) next.delete(node.key);
      else next.add(node.key);
      return next;
    });
    // Also play the node
    onClickNode(node);
  }, [onClickNode]);

  // Clear pinned paths when path mode is turned off
  useEffect(() => { if (!pathMode) setPinnedTargets(new Set()); }, [pathMode]);

  // Clear pinned paths when parent signals deselect-all
  useEffect(() => { if (clearPinnedKey) setPinnedTargets(new Set()); }, [clearPinnedKey]);

  return (
    <>
      <ambientLight intensity={0.6} />
      <pointLight position={[10, 10, 10]} intensity={0.8} />
      <pointLight position={[-8, -5, -10]} intensity={0.3} />

      {/* Topo surface wireframe */}
      {topoMesh && (
        <>
          {topoMesh.rings.filter((_, i) => i % 3 === 0).map((ring, i) => (
            <Line key={`tr${i}`} points={ring} color="#1a1a3a" lineWidth={0.5} transparent opacity={0.3} />
          ))}
          {topoMesh.tubes.filter((_, i) => i % 3 === 0).map((tube, i) => (
            <Line key={`tt${i}`} points={tube} color="#1a1a3a" lineWidth={0.5} transparent opacity={0.3} />
          ))}
        </>
      )}

      {/* Generator edges — batched by prime for fewer draw calls */}
      {layers.primeEdges && (() => {
        // In path mode with no hover/pinned, show nothing
        if (pathMode && !combinedEdgeSet) return null;
        const posMap = layers.classes ? lattice.jiPositions : (topoPositions ?? lattice.positions);
        const byPrime = new Map<number, [number, number, number][]>();

        // EDO mode: synthesise edges between class reps by EDO step
        // relationship (rep@N → rep@(N+P5_step) for fifths, rep@N
        // → rep@(N+M3_step) for thirds).  The JI lattice's
        // generator edges only connect cells differing by ONE
        // prime-axis exponent — but the visible reps mostly DON'T
        // differ by one prime axis from their neighbours, so those
        // edges go off into hidden non-rep cells.  Drawing edges
        // straight between reps recovers the Tonescape look where
        // every visible node has its P5 + M3 neighbours connected.
        const edoMode = lattice.classMap.size > 0
          && lattice.config.temperedCommas.length === 0
          && typeof lattice.config.edo === "number";
        if (edoMode) {
          const edo = lattice.config.edo!;
          // Map from class id → visible rep key.  For multi-cell
          // classes the rep is in classRepSet; for single-cell
          // classes the only member is the rep.
          const classToRep = new Map<number, string>();
          const memberByClass = new Map<number, string[]>();
          for (const [key, classId] of lattice.classMap) {
            if (!memberByClass.has(classId)) memberByClass.set(classId, []);
            memberByClass.get(classId)!.push(key);
          }
          for (const [classId, members] of memberByClass) {
            const rep = members.find(k => classRepSet.has(k))
              ?? (members.length === 1 ? members[0] : null);
            if (rep) classToRep.set(classId, rep);
          }
          const p5Step = ((Math.round(edo * Math.log2(3 / 2)) % edo) + edo) % edo;
          const m3Step = ((Math.round(edo * Math.log2(5 / 4)) % edo) + edo) % edo;
          // Tonescape colour convention: P5 chain in magenta /
          // pink, M3 chain in green.  Hardcoded so the user reads
          // the chains by colour the same way as in the Tonescape
          // screenshots — bypasses MONZO_PRIME_COLORS which has
          // prime-3 as orange.
          const COLOR_P5 = "#e85ad0";  // magenta
          const COLOR_M3 = "#5cca5c";  // green
          const buckets: { color: string; pts: [number, number, number][] }[] = [
            { color: COLOR_P5, pts: [] },
            { color: COLOR_M3, pts: [] },
          ];
          const drawBucket = (fromClass: number, stepDelta: number, bucketIdx: number) => {
            const fromRep = classToRep.get(fromClass);
            const toRep = classToRep.get(((fromClass + stepDelta) % edo + edo) % edo);
            if (!fromRep || !toRep) return;
            const a = posMap.get(fromRep), b = posMap.get(toRep);
            if (!a || !b) return;
            buckets[bucketIdx].pts.push(a, b);
          };
          for (const classId of classToRep.keys()) {
            drawBucket(classId, p5Step, 0);
            drawBucket(classId, m3Step, 1);
          }
          return buckets.map(({ color, pts }, i) => pts.length === 0 ? null : (
            <lineSegments key={`ge-edo-${i}`} frustumCulled={false}>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  args={[new Float32Array(pts.flat()), 3]}
                />
              </bufferGeometry>
              <lineBasicMaterial color={color} transparent opacity={0.85} linewidth={2} />
            </lineSegments>
          ));
        }

        // Non-EDO path: original prime-axis edges from the JI lattice.
        for (const edge of lattice.edges) {
          if (edge.type !== "generator") continue;
          if (pathMode && combinedEdgeSet && !combinedEdgeSet.has(edge)) continue;
          if (dedupVisibleSet.size > 0 && (!dedupVisibleSet.has(edge.from) || !dedupVisibleSet.has(edge.to))) continue;
          const a = posMap.get(edge.from), b = posMap.get(edge.to);
          if (!a || !b) continue;
          if (!byPrime.has(edge.prime)) byPrime.set(edge.prime, []);
          const arr = byPrime.get(edge.prime)!;
          arr.push(a, b);
        }
        return [...byPrime.entries()].map(([prime, pts]) => (
          <lineSegments key={`ge-${prime}`} frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[new Float32Array(pts.flat()), 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial color={MONZO_PRIME_COLORS[prime] ?? "#555"} transparent opacity={pathMode ? 0.9 : 0.5} />
          </lineSegments>
        ));
      })()}

      {/* Comma-compensation edges — one straight line segment per
          chord that needed a non-zero drift offset.  The drifted
          node (uncompensated rep) is also painted red via the
          drone-nodes pipeline (see effect in LatticeView body).
          Edge connects red drifted node → played compensated node. */}
      {compensationArcs && compensationArcs.length > 0 && (() => {
        const posMap = topoPositions ?? lattice.positions;
        const classToRep = new Map<number, string>();
        const memberByClass = new Map<number, string[]>();
        for (const [key, classId] of lattice.classMap) {
          if (!memberByClass.has(classId)) memberByClass.set(classId, []);
          memberByClass.get(classId)!.push(key);
        }
        for (const [classId, members] of memberByClass) {
          const rep = members.find(k => classRepSet.has(k))
            ?? (members.length === 1 ? members[0] : null);
          if (rep) classToRep.set(classId, rep);
        }
        const pts: [number, number, number][] = [];
        for (const arc of compensationArcs) {
          const fromKey = classToRep.get(arc.fromClassId);
          const toKey = classToRep.get(arc.toClassId);
          if (!fromKey || !toKey) continue;
          const a = posMap.get(fromKey);
          const b = posMap.get(toKey);
          if (!a || !b) continue;
          pts.push(a, b);
        }
        if (pts.length === 0) return null;
        return (
          <lineSegments key="comp-edges" frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[new Float32Array(pts.flat()), 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial color="#ff5555" transparent opacity={0.9} linewidth={2} />
          </lineSegments>
        );
      })()}

      {/* Tempered edges — batched */}
      {layers.temperedEdges && (() => {
        if (pathMode && !combinedEdgeSet) return null;
        const posMap = layers.classes ? lattice.jiPositions : (topoPositions ?? lattice.positions);
        const pts: [number, number, number][] = [];
        for (const edge of lattice.edges) {
          if (edge.type !== "tempered") continue;
          if (pathMode && combinedEdgeSet && !combinedEdgeSet.has(edge)) continue;
          if (dedupVisibleSet.size > 0 && (!dedupVisibleSet.has(edge.from) || !dedupVisibleSet.has(edge.to))) continue;
          const a = posMap.get(edge.from), b = posMap.get(edge.to);
          if (!a || !b) continue;
          pts.push(a, b);
        }
        if (pts.length === 0) return null;
        return (
          <lineSegments key="te-all" frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[new Float32Array(pts.flat()), 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial color="#ff4444" transparent opacity={0.35} />
          </lineSegments>
        );
      })()}

      {/* Auto-path overlay: shortest paths to custom ratios (shown on top of normal edges) */}
      {!pathMode && autoPathEdgeSet && (() => {
        const posMap = topoPositions ?? lattice.positions;
        const byPrime = new Map<number, [number, number, number][]>();
        for (const edge of autoPathEdgeSet) {
          if (edge.type !== "generator") continue;
          const a = posMap.get(edge.from), b = posMap.get(edge.to);
          if (!a || !b) continue;
          if (!byPrime.has(edge.prime)) byPrime.set(edge.prime, []);
          const arr = byPrime.get(edge.prime)!;
          arr.push(a, b);
        }
        return [...byPrime.entries()].map(([prime, pts]) => (
          <lineSegments key={`ap-${prime}`} frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[new Float32Array(pts.flat()), 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial color={MONZO_PRIME_COLORS[prime] ?? "#fff"} transparent opacity={0.95} linewidth={2} />
          </lineSegments>
        ));
      })()}

      {/* Nodes:
           - Classes ON: show ALL nodes at their JI positions to visualize equivalence classes.
           - Dedupe ON: keep only one node per unique tempered position (simplest ratio wins).
           - Default (both off): show all nodes at their tempered positions (duplicates stack).
           - EDO class-rep filter: when val-based classes are active
             (lattice.classMap has entries) AND no commas were
             projected, drop every cell that's a non-rep member of
             a multi-cell class.  This is what produces the
             Tonescape-style 12-cells-for-12-EDO layout: one
             simplest-ratio rep per equivalence class. */}
      {layers.nodes && lattice.nodes
        .filter(node => {
          // EDO mode (val-based class assignment, no commas
          // applied) is owned exclusively by the class-rep filter
          // — drop the dedup filter so the two don't disagree.
          // (dedup picks smallest n*d at a 3D position, classRep
          // picks the octave-reduced cell preferring [1, 2) — for
          // most classes those two fight and the node is hidden
          // by one filter or the other, which is why most reps
          // weren't rendering.)
          const edoOwned = lattice.classMap.size > 0
            && lattice.config.temperedCommas.length === 0
            && typeof lattice.config.edo === "number";
          if (edoOwned) {
            if (siblingsMap.has(node.key) && !classRepSet.has(node.key)) return false;
            return true;
          }
          if (dedupVisibleSet.size > 0 && !dedupVisibleSet.has(node.key)) return false;
          if (lattice.classMap.size > 0
              && lattice.config.temperedCommas.length === 0
              && siblingsMap.has(node.key)
              && !classRepSet.has(node.key)) return false;
          return true;
        })
        .map(node => {
        // Path-endpoint highlight only fires when the user has
        // explicitly focused / hovered / pinned a node.  Previously
        // `focusKey ?? "1/1"` made the unison cell *always* count as
        // an origin endpoint, which kept it stuck in the cyan path-
        // endpoint colour even when no focus was set — exactly the
        // "1/1 always lit" bug.
        const nodeIsEndpoint = pinnedTargets.has(node.key)
          || hoveredNode === node.key
          || (focusKey != null && node.key === focusKey)
          || (autoPathTargets?.has(node.key) ?? false);
        const isNonRep = siblingsMap.has(node.key) && !classRepSet.has(node.key);
        return (
        <MonzoNodeMesh
          key={node.key}
          node={node}
          pos={layers.classes ? lattice.jiPositions.get(node.key) ?? node.pos3d : (topoPositions ?? lattice.positions).get(node.key) ?? node.pos3d}
          isActive={droneNodes.has(node.key)}
          activeColor={nodeColorOverrides?.get(node.key)}
          isHovered={hoveredNode === node.key}
          isFocused={focusKey === node.key}
          showLabel={layers.noteNames || layers.intervals || layers.ratios || layers.monzo || layers.heji}
          labelLOD={labelLOD}
          labelDist={labelDist}
          onHover={onHover}
          onClick={onClickNode}
          onFocus={onFocusNode}
          primes={lattice.primes}
          temperedClass={node.temperedClass}
          classColorMap={classColorMap}
          rootPc={rootPc}
          showNoteNames={layers.noteNames}
          showIntervals={layers.intervals}
          showRatios={layers.ratios}
          showMonzo={layers.monzo}
          showHeji={layers.heji}
          temperedSiblings={siblingsMap.get(node.key)}
          isClassRep={layers.classes || posLabelSet.has(node.key)}
          isOnPath={combinedNodeSet?.has(node.key) ?? false}
          isPathEndpoint={nodeIsEndpoint}
          isPinnedPath={persistentPathNodeSet?.has(node.key) ?? false}
          onCtrlClick={pathMode ? handleCtrlClick : undefined}
          isHighlighted={highlightedRatios?.has(node.key) ?? false}
          highlightMode={!!highlightedRatios && highlightedRatios.size > 0}
          isNonRepClass={false}
          showClassId={layers.classes}
          edo={lattice.config.edo}
        />);
      })}


      <CameraFocusCenter targetPos={focusKey ? (topoPositions ?? lattice.positions).get(focusKey) ?? null : null} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.08}
        minDistance={1} maxDistance={200} enablePan panSpeed={1.5} rotateSpeed={0.8} zoomSpeed={1.2} />
      <KeyboardPan />
      <MonzoStepper lattice={lattice} focusKey={focusKey} onFocusNode={onFocusNode} />
    </>
  );
}

/** Keyboard stepping: press number keys (3,5,7...) to step along prime axes from focused node.
 *  Shift+key steps backwards. */
// Keyboard rows for axis stepping: 1-0, q-p, a-l (up to ~30 keys)
const STEP_KEY_ROWS = [
  ["1","2","3","4","5","6","7","8","9","0"],
  ["q","w","e","r","t","y","u","i","o","p"],
  ["a","s","d","f","g","h","j","k","l"],
];
const STEP_KEYS = STEP_KEY_ROWS.flat();

/** Build display string for the stepping hint */
function buildStepHint(primes: number[]): string {
  const active = primes.filter(p => p !== 2);
  return active.map((p, i) => {
    const key = STEP_KEYS[i] ?? "?";
    return `${key}→×${p}`;
  }).join("  ");
}

function MonzoStepper({ lattice, focusKey, onFocusNode }: {
  lattice: BuiltLattice; focusKey: string | null; onFocusNode?: (key: string) => void;
}) {
  useEffect(() => {
    if (!onFocusNode) return;
    const activePrimes = lattice.primes.filter(p => p !== 2);

    const handler = (e: KeyboardEvent) => {
      // Don't intercept if typing in an input
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "SELECT") return;

      // Use e.code so Shift+key still maps correctly (e.key would give "!" for Shift+1, etc.)
      const codeLower = e.code.toLowerCase();
      let keyLower: string | undefined;
      if (codeLower.startsWith("digit")) keyLower = codeLower.slice(5); // "Digit1" -> "1"
      else if (codeLower.startsWith("key")) keyLower = codeLower.slice(3); // "KeyQ" -> "q"
      const slotIdx = keyLower ? STEP_KEYS.indexOf(keyLower) : -1;
      if (slotIdx === -1 || slotIdx >= activePrimes.length) return;

      const prime = activePrimes[slotIdx];
      const primeIdx = lattice.primes.indexOf(prime);
      if (primeIdx === -1) return;

      e.preventDefault();
      const currentKey = focusKey ?? "1/1";
      const currentNode = lattice.nodes.find(n => n.key === currentKey);
      if (!currentNode) return;

      // Build target exponents: current ± 1 in the prime direction
      const direction = e.shiftKey ? -1 : 1;
      const targetExps = [...currentNode.monzo.exps];
      targetExps[primeIdx] += direction;

      // Find the node with those exponents
      const target = lattice.nodes.find(n =>
        n.monzo.exps.length === targetExps.length &&
        n.monzo.exps.every((e, i) => e === targetExps[i])
      );
      if (target) {
        onFocusNode(target.key);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lattice, focusKey, onFocusNode]);
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Tonnetz 3D — Three.js scene for 7-limit and higher JI Tonnetz
// ═══════════════════════════════════════════════════════════════

interface Tonnetz3DProps {
  data: TonnetzData;
  droneNodes: Set<string>;
  hoveredNode: string | null;
  onHover: (key: string | null) => void;
  onClickNode: (node: TonnetzNode) => void;
  showNotes: boolean;
  showRatios: boolean;
  showCents: boolean;
  rootPc: number;
  showEdges: Record<number, boolean>;
  showOtonal: boolean;
  showUtonal: boolean;
  showPLR: boolean;
  selectedTriad: string | null;
  activeTriads?: Set<string>;
  hoveredTriad: string | null;
  onHoverTriad: (key: string | null) => void;
  onClickTriad: (key: string) => void;
  onPLRNavigate?: (link: PLRLink) => void;
}

/** Single node sphere + label in the 3D Tonnetz */
function TonnetzNodeMesh({ node, isActive, isHovered, onHover, onClick, showNotes = true, showRatios = true, showCents = true, rootPc }: {
  node: TonnetzNode;
  isActive: boolean;
  isHovered: boolean;
  onHover: (key: string | null) => void;
  onClick: (node: TonnetzNode) => void;
  showNotes?: boolean;
  showRatios?: boolean;
  showCents?: boolean;
  rootPc: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const isUnison = node.n === 1 && node.d === 1;
  const r = 0.12;

  const color = isActive ? "#7173e6" : isUnison ? "#9395ea" : "#3a3a4a";
  const emissive = isActive ? "#7173e6" : isHovered ? "#5a5cc8" : "#000000";

  useFrame(() => {
    if (!meshRef.current) return;
    const scale = isHovered ? 1.3 : isActive ? 1.2 : 1;
    meshRef.current.scale.lerp(new THREE.Vector3(scale, scale, scale), 0.15);
  });

  const noteName = tonnetzRatioToNoteName(node.n, node.d, rootPc);

  return (
    <group position={node.pos3d}>
      <mesh
        ref={meshRef}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(node.key); }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onClick(node); }}
      >
        <sphereGeometry args={[r, 16, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={isHovered ? 0.6 : isActive ? 0.8 : 0}
          roughness={0.5}
          metalness={0.3}
        />
      </mesh>
      {(showNotes || showRatios || showCents) && (
        <Html
          position={[0, r + 0.08, 0]}
          center
          distanceFactor={12}
          zIndexRange={[1, 0]}
          style={{ pointerEvents: "none" }}
        >
          <div style={{
            textAlign: "center",
            whiteSpace: "nowrap",
            textShadow: "0 0 6px rgba(0,0,0,0.95)",
            lineHeight: 1.2,
          }}>
            {showNotes && (
              <div style={{ color: isHovered || isActive ? "#7df" : "#4ac", fontSize: 10, fontWeight: 700, fontFamily: "Inter, system-ui, sans-serif" }}>
                {noteName}
              </div>
            )}
            {showRatios && (
              <div style={{ color: isHovered || isActive ? "#e8c76a" : "#8a7540", fontSize: 9, fontWeight: 600, fontFamily: "'Courier New', monospace" }}>
                {node.ratioKey}
              </div>
            )}
            {showCents && (
              <div style={{ color: isHovered || isActive ? "#fff" : "#999", fontSize: 8, fontWeight: 400, fontFamily: "'Courier New', monospace" }}>
                {Math.round(node.cents)}¢
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

/** A clickable simplex face in 3D (triangle for 5-limit, tetrahedron faces for 7-limit+) */
function TriadFace3D({ triad, nodeMap, isSelected, isHovered, onHover, onClick }: {
  triad: TonnetzTriad;
  nodeMap: Map<string, TonnetzNode>;
  isSelected: boolean;
  isHovered: boolean;
  onHover: (key: string | null) => void;
  onClick: (key: string) => void;
}) {
  const geom = useMemo(() => {
    const nodes = triad.nodeKeys.map(k => nodeMap.get(k)!).filter(Boolean);
    if (nodes.length < 3) return null;
    const verts: number[] = [];
    const indices: number[] = [];
    for (const n of nodes) verts.push(...n.pos3d);
    // All triangular faces of the simplex
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        for (let k = j + 1; k < nodes.length; k++) {
          indices.push(i, j, k);
        }
      }
    }
    return { verts: new Float32Array(verts), indices: new Uint16Array(indices) };
  }, [triad, nodeMap]);

  if (!geom) return null;

  const baseColor = triad.type === "otonal" ? "#4488ff" : "#ff6644";
  const opacity = isSelected ? 0.35 : isHovered ? 0.25 : 0.08;

  return (
    <mesh
      onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(triad.key); }}
      onPointerOut={() => onHover(null)}
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onClick(triad.key); }}
    >
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[geom.verts, 3]} />
        <bufferAttribute attach="index" args={[geom.indices, 1]} />
      </bufferGeometry>
      <meshBasicMaterial
        color={baseColor}
        transparent
        opacity={opacity}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

function Tonnetz3DScene({
  data, droneNodes, hoveredNode, onHover, onClickNode,
  showNotes, showRatios, showCents, rootPc, showEdges, showOtonal, showUtonal, showPLR,
  selectedTriad, activeTriads, hoveredTriad, onHoverTriad, onClickTriad,
  onPLRNavigate,
}: Tonnetz3DProps) {
  const visibleTriads = useMemo(() => {
    return data.triads.filter(t =>
      (t.type === "otonal" && showOtonal) || (t.type === "utonal" && showUtonal)
    );
  }, [data.triads, showOtonal, showUtonal]);

  const plrLinks = useMemo(() => {
    if (!showPLR || !selectedTriad) return [];
    return data.plrLinks.filter(l => l.from === selectedTriad);
  }, [data.plrLinks, showPLR, selectedTriad]);

  const triadMap = useMemo(() => new Map(data.triads.map(t => [t.key, t])), [data.triads]);

  // Batch edges by prime
  const edgeSegments = useMemo(() => {
    const byPrime = new Map<number, [number, number, number][]>();
    for (const edge of data.edges) {
      if (!showEdges[edge.prime]) continue;
      const a = data.nodeMap.get(edge.from);
      const b = data.nodeMap.get(edge.to);
      if (!a || !b) continue;
      if (!byPrime.has(edge.prime)) byPrime.set(edge.prime, []);
      byPrime.get(edge.prime)!.push(a.pos3d, b.pos3d);
    }
    return byPrime;
  }, [data.edges, data.nodeMap, showEdges]);

  // PLR line data
  const plrLineData = useMemo(() => {
    return plrLinks.map(link => {
      const fromTriad = triadMap.get(link.from);
      const toTriad = triadMap.get(link.to);
      if (!fromTriad || !toTriad) return null;
      const mid: [number, number, number] = [
        (fromTriad.center[0] + toTriad.center[0]) / 2,
        (fromTriad.center[1] + toTriad.center[1]) / 2,
        (fromTriad.center[2] + toTriad.center[2]) / 2,
      ];
      return { from: fromTriad.center, to: toTriad.center, mid, name: link.name, link };
    }).filter(Boolean) as { from: [number, number, number]; to: [number, number, number]; mid: [number, number, number]; name: string; link: PLRLink }[];
  }, [plrLinks, triadMap]);

  return (
    <>
      <ambientLight intensity={0.6} />
      <pointLight position={[10, 10, 10]} intensity={0.8} />
      <pointLight position={[-8, -5, -10]} intensity={0.3} />

      {/* Triad faces */}
      {visibleTriads.map(triad => (
        <TriadFace3D
          key={triad.key}
          triad={triad}
          nodeMap={data.nodeMap}
          isSelected={selectedTriad === triad.key || !!activeTriads?.has(triad.key)}
          isHovered={hoveredTriad === triad.key}
          onHover={onHoverTriad}
          onClick={onClickTriad}
        />
      ))}

      {/* Edges batched by prime */}
      {[...edgeSegments.entries()].map(([prime, pts]) => (
        <lineSegments key={`edge-${prime}`} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[new Float32Array(pts.flat()), 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color={TONNETZ_PRIME_COLORS[prime] ?? "#555"} transparent opacity={0.5} />
        </lineSegments>
      ))}

      {/* PLR links */}
      {plrLineData.map((link, i) => (
        <group key={i}>
          <Line
            points={[link.from, link.to]}
            color="#ffdd44"
            lineWidth={2}
            transparent
            opacity={0.7}
            dashed
            dashSize={0.3}
            gapSize={0.15}
          />
          <Html position={link.mid} center distanceFactor={12} zIndexRange={[1, 0]} style={{ pointerEvents: onPLRNavigate ? "auto" : "none" }}>
            <div
              onClick={onPLRNavigate ? (e: React.MouseEvent) => { e.stopPropagation(); onPLRNavigate(link.link); } : undefined}
              style={{
                background: "rgba(0,0,0,0.6)",
                color: "#ffdd44",
                fontSize: 11,
                fontWeight: 700,
                fontFamily: "Inter, system-ui, sans-serif",
                padding: "1px 6px",
                borderRadius: 3,
                cursor: onPLRNavigate ? "pointer" : "default",
              }}>
              {link.name}
            </div>
          </Html>
        </group>
      ))}

      {/* Nodes */}
      {data.nodes.map(node => (
        <TonnetzNodeMesh
          key={node.key}
          node={node}
          isActive={droneNodes.has(node.key)}
          isHovered={hoveredNode === node.key}
          onHover={onHover}
          onClick={onClickNode}
          showNotes={showNotes}
          showRatios={showRatios}
          showCents={showCents}
          rootPc={rootPc}
        />
      ))}

      <OrbitControls makeDefault enableDamping dampingFactor={0.12}
        minDistance={3} maxDistance={80} enablePan />
      <KeyboardPan />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// Tonnetz 2D SVG — flat neo-Riemannian Tonnetz with pan/zoom
// ═══════════════════════════════════════════════════════════════

interface TonnetzSvgProps {
  data: TonnetzData;
  droneNodes: Set<string>;
  hoveredNode: string | null;
  onHover: (key: string | null) => void;
  onClickNode: (node: TonnetzNode) => void;
  showNotes: boolean;
  showRatios: boolean;
  showCents: boolean;
  rootPc: number;
  showEdges: Record<number, boolean>;
  showOtonal: boolean;
  showUtonal: boolean;
  showPLR: boolean;
  selectedTriad: string | null;
  activeTriads?: Set<string>;
  hoveredTriad: string | null;
  onHoverTriad: (key: string | null) => void;
  onClickTriad: (key: string) => void;
  onPLRNavigate?: (link: PLRLink) => void;
  chordMoves?: ChordMove[];
  onChordMove?: (move: ChordMove) => void;
  parallelMoves?: ParallelChordMove[];
  onParallelMove?: (move: ParallelChordMove) => void;
}

function TonnetzSvg({
  data, droneNodes, hoveredNode, onHover, onClickNode,
  showNotes, showRatios, showCents, rootPc, showEdges, showOtonal, showUtonal, showPLR,
  selectedTriad, activeTriads, hoveredTriad, onHoverTriad, onClickTriad,
  onPLRNavigate, chordMoves, onChordMove, parallelMoves, onParallelMove,
}: TonnetzSvgProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // Pan/zoom state
  const [zoom, setZoom] = useState(30); // pixels per unit
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const dragRef = useRef<{ startX: number; startY: number; startPan: [number, number] } | null>(null);

  // Measure container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // World → screen transform: x_screen = x_world * zoom + cx + panX, y flipped
  const cx = size.w / 2 + pan[0];
  const cy = size.h / 2 + pan[1];
  const toScreen = useCallback((pos: [number, number, number]): [number, number] => {
    return [pos[0] * zoom + cx, -pos[1] * zoom + cy]; // flip Y so +Y is up
  }, [zoom, cx, cy]);

  // Mouse handlers for panning
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return; // left or middle
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPan: [...pan] };
  }, [pan]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPan([dragRef.current.startPan[0] + dx, dragRef.current.startPan[1] + dy]);
  }, []);

  const onMouseUp = useCallback(() => { dragRef.current = null; }, []);

  // Zoom with scroll wheel
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(z => Math.max(5, Math.min(200, z * factor)));
  }, []);

  // Triad map for PLR lookups
  const triadMap = useMemo(() => new Map(data.triads.map(t => [t.key, t])), [data.triads]);

  // Visible triads
  const visibleTriads = useMemo(() => {
    return data.triads.filter(t =>
      (t.type === "otonal" && showOtonal) || (t.type === "utonal" && showUtonal)
    );
  }, [data.triads, showOtonal, showUtonal]);

  // PLR links from selected triad
  const plrLinks = useMemo(() => {
    if (!showPLR || !selectedTriad) return [];
    return data.plrLinks.filter(l => l.from === selectedTriad);
  }, [data.plrLinks, showPLR, selectedTriad]);

  // ── Note search → shortest path ──────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");

  // Build adjacency from edges
  const adjacency = useMemo(() => {
    const adj = new Map<string, { neighbor: string; edge: TonnetzEdge }[]>();
    for (const edge of data.edges) {
      if (!adj.has(edge.from)) adj.set(edge.from, []);
      if (!adj.has(edge.to)) adj.set(edge.to, []);
      adj.get(edge.from)!.push({ neighbor: edge.to, edge });
      adj.get(edge.to)!.push({ neighbor: edge.from, edge });
    }
    return adj;
  }, [data.edges]);

  // Find target node by note name match
  const searchTargetKey = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return null;
    const qLower = q.toLowerCase();
    // Try exact match first, then prefix match
    for (const node of data.nodes) {
      const name = tonnetzRatioToNoteName(node.n, node.d, rootPc);
      if (name.toLowerCase() === qLower) return node.key;
    }
    // Try ratio match (e.g. "5/4")
    for (const node of data.nodes) {
      if (node.ratioKey.toLowerCase() === qLower) return node.key;
    }
    // Prefix match
    for (const node of data.nodes) {
      const name = tonnetzRatioToNoteName(node.n, node.d, rootPc);
      if (name.toLowerCase().startsWith(qLower)) return node.key;
    }
    return null;
  }, [searchQuery, data.nodes, rootPc]);

  // BFS shortest path from 1/1 to target
  const searchPathEdges = useMemo((): Set<TonnetzEdge> | null => {
    if (!searchTargetKey || !adjacency) return null;
    const origin = data.nodes.find(n => n.n === 1 && n.d === 1)?.key;
    if (!origin || searchTargetKey === origin) return null;
    const dist = new Map<string, number>([[origin, 0]]);
    const queue = [origin];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const d = dist.get(curr)!;
      for (const { neighbor } of adjacency.get(curr) ?? []) {
        if (!dist.has(neighbor)) { dist.set(neighbor, d + 1); queue.push(neighbor); }
      }
    }
    if (!dist.has(searchTargetKey)) return null;
    const targetDist = dist.get(searchTargetKey)!;
    const byDist = new Map<number, string[]>();
    for (const [k, d] of dist) { if (!byDist.has(d)) byDist.set(d, []); byDist.get(d)!.push(k); }
    const onPath = new Set<string>([searchTargetKey]);
    for (let d = targetDist - 1; d >= 0; d--) {
      for (const node of byDist.get(d) ?? []) {
        for (const { neighbor } of adjacency.get(node) ?? []) {
          if (dist.get(neighbor) === d + 1 && onPath.has(neighbor)) { onPath.add(node); break; }
        }
      }
    }
    const edges = new Set<TonnetzEdge>();
    for (const node of onPath) {
      const d = dist.get(node)!;
      for (const { neighbor, edge } of adjacency.get(node) ?? []) {
        if (dist.get(neighbor) === d + 1 && onPath.has(neighbor)) edges.add(edge);
      }
    }
    return edges.size > 0 ? edges : null;
  }, [searchTargetKey, adjacency, data.nodes]);

  const searchPathNodes = useMemo(() => {
    if (!searchPathEdges) return null;
    const nodes = new Set<string>();
    for (const e of searchPathEdges) { nodes.add(e.from); nodes.add(e.to); }
    return nodes;
  }, [searchPathEdges]);

  const nodeR = Math.max(4, Math.min(14, zoom * 0.35));
  const fontSize = Math.max(7, Math.min(12, zoom * 0.3));

  return (
    <div ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative", cursor: dragRef.current ? "grabbing" : "grab" }}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
      onWheel={onWheel}
    >
      <svg width={size.w} height={size.h} style={{ display: "block", background: "#080808" }}>
        <SvgDefs />

        {/* Triad faces (polygons) */}
        {visibleTriads.map(triad => {
          const nodes = triad.nodeKeys.map(k => data.nodeMap.get(k)!).filter(Boolean);
          if (nodes.length < 3) return null;
          const isSelected = selectedTriad === triad.key || !!activeTriads?.has(triad.key);
          const isHov = hoveredTriad === triad.key;
          const baseColor = triad.type === "otonal" ? "#4488ff" : "#ff6644";
          const opacity = isSelected ? 0.35 : isHov ? 0.25 : 0.08;
          const pts = nodes.map(n => toScreen(n.pos3d));
          const pointsStr = pts.map(p => `${p[0]},${p[1]}`).join(" ");
          return (
            <polygon key={triad.key} points={pointsStr}
              fill={baseColor} fillOpacity={opacity} stroke={baseColor} strokeOpacity={opacity * 0.8} strokeWidth={0.5}
              style={{ cursor: "pointer" }}
              onMouseOver={() => onHoverTriad(triad.key)}
              onMouseOut={() => onHoverTriad(null)}
              onClick={(e) => { e.stopPropagation(); onClickTriad(triad.key); }}
            />
          );
        })}

        {/* Edges */}
        {data.edges.map((edge, i) => {
          if (!showEdges[edge.prime]) return null;
          const a = data.nodeMap.get(edge.from);
          const b = data.nodeMap.get(edge.to);
          if (!a || !b) return null;
          const [ax, ay] = toScreen(a.pos3d);
          const [bx, by] = toScreen(b.pos3d);
          return (
            <line key={i} x1={ax} y1={ay} x2={bx} y2={by}
              stroke={TONNETZ_PRIME_COLORS[edge.prime] ?? "#555"}
              strokeOpacity={0.45} strokeWidth={1.2} />
          );
        })}

        {/* PLR links (dashed lines from selected triad to neighbors) — hidden when 4+ notes active */}
        {droneNodes.size <= 3 && plrLinks.map((link, i) => {
          const fromTriad = triadMap.get(link.from);
          const toTriad = triadMap.get(link.to);
          if (!fromTriad || !toTriad) return null;
          const [fx, fy] = toScreen(fromTriad.center);
          const [tx, ty] = toScreen(toTriad.center);
          const mx = (fx + tx) / 2;
          const my = (fy + ty) / 2;
          return (
            <g key={i} style={{ cursor: onPLRNavigate ? "pointer" : "default" }}
              onClick={onPLRNavigate ? (e) => { e.stopPropagation(); onPLRNavigate(link); } : undefined}>
              <line x1={fx} y1={fy} x2={tx} y2={ty}
                stroke="#ffdd44" strokeOpacity={0.7} strokeWidth={2}
                strokeDasharray="6 4" />
              <rect x={mx - 12} y={my - 9} width={24} height={16} rx={3}
                fill="rgba(0,0,0,0.6)" stroke="#ffdd44" strokeOpacity={onPLRNavigate ? 0.5 : 0} strokeWidth={1} />
              <text x={mx} y={my + 3} textAnchor="middle"
                fill="#ffdd44" fontSize={11} fontWeight={700}
                fontFamily="Inter, system-ui, sans-serif"
                style={{ pointerEvents: "none" }}>
                {link.name}
              </text>
            </g>
          );
        })}


        {/* Chord voice-leading move lines — hidden when 4+ notes active */}
        {droneNodes.size <= 3 && chordMoves && chordMoves.length > 0 && chordMoves.map((move, i) => {
          const fromNode = data.nodeMap.get(move.fromKey);
          const toNode = data.nodeMap.get(move.toKey);
          if (!fromNode || !toNode) return null;
          const [fx, fy] = toScreen(fromNode.pos3d);
          const [tx, ty] = toScreen(toNode.pos3d);
          const mx = (fx + tx) / 2;
          const my = (fy + ty) / 2;
          return (
            <g key={`cm-${i}`} style={{ cursor: "pointer" }}
              onClick={(e) => { e.stopPropagation(); onChordMove?.(move); }}>
              <line x1={fx} y1={fy} x2={tx} y2={ty}
                stroke="#ffdd44" strokeOpacity={0.5} strokeWidth={2}
                strokeDasharray="4 3" />
              <circle cx={tx} cy={ty} r={nodeR * 0.6}
                fill="#ffdd44" fillOpacity={0.3} stroke="#ffdd44" strokeOpacity={0.6} strokeWidth={1} />
              <rect x={mx - 14} y={my - 8} width={28} height={14} rx={3}
                fill="rgba(0,0,0,0.7)" />
              <text x={mx} y={my + 2} textAnchor="middle"
                fill="#ffdd44" fontSize={9} fontWeight={700}
                fontFamily="Inter, system-ui, sans-serif"
                style={{ pointerEvents: "none" }}>
                {move.direction}
              </text>
            </g>
          );
        })}

        {/* Parallel voice-leading lines (behind nodes) */}
        {parallelMoves && parallelMoves.length > 0 && parallelMoves.map((move, mi) =>
          move.voices.map((v, vi) => {
            const fromNode = data.nodeMap.get(v.fromKey);
            const toNode = data.nodeMap.get(v.toKey);
            if (!fromNode || !toNode) return null;
            const [fx, fy] = toScreen(fromNode.pos3d);
            const [tx, ty] = toScreen(toNode.pos3d);
            return (
              <g key={`pv-${mi}-${vi}`}>
                <line x1={fx} y1={fy} x2={tx} y2={ty}
                  stroke="#44ffaa" strokeOpacity={0.5} strokeWidth={2}
                  strokeDasharray="6 2" />
                <circle cx={tx} cy={ty} r={nodeR * 0.5}
                  fill="#44ffaa" fillOpacity={0.25} stroke="#44ffaa" strokeOpacity={0.5} strokeWidth={1} />
              </g>
            );
          })
        )}

        {/* Search shortest-path edges */}
        {searchPathEdges && [...searchPathEdges].map((edge, i) => {
          const a = data.nodeMap.get(edge.from);
          const b = data.nodeMap.get(edge.to);
          if (!a || !b) return null;
          const [ax, ay] = toScreen(a.pos3d);
          const [bx, by] = toScreen(b.pos3d);
          return (
            <line key={`sp-${i}`} x1={ax} y1={ay} x2={bx} y2={by}
              stroke="#ff44ff" strokeOpacity={0.9} strokeWidth={3} />
          );
        })}

        {/* Nodes */}
        {data.nodes.map(node => {
          const [sx, sy] = toScreen(node.pos3d);
          const isActive = droneNodes.has(node.key);
          const isHov = hoveredNode === node.key;
          const isUnison = node.n === 1 && node.d === 1;
          const isOnPath = searchPathNodes?.has(node.key) ?? false;
          const isTarget = node.key === searchTargetKey;
          const grad = isActive ? "url(#ng-active)" : isUnison ? "url(#ng-root)" : "url(#ng-idle)";
          const noteName = tonnetzRatioToNoteName(node.n, node.d, rootPc);
          return (
            <g key={node.key} style={{ cursor: "pointer" }}
              onMouseOver={() => onHover(node.key)}
              onMouseOut={() => onHover(null)}
              onClick={(e) => { e.stopPropagation(); onClickNode(node); }}
              filter={isActive ? "url(#glow)" : isTarget ? "url(#glow)" : undefined}
            >
              <circle cx={sx} cy={sy} r={isTarget ? nodeR * 1.3 : isHov ? nodeR * 1.2 : isActive ? nodeR * 1.1 : nodeR}
                fill={isTarget ? "#ff44ff" : grad}
                stroke={isTarget ? "#ff88ff" : isOnPath ? "#ff44ff" : isActive ? "#9395ea" : isHov ? "#5a5cc8" : "#444"}
                strokeWidth={isTarget || isOnPath ? 2 : 1} />
              {showNotes && (
                <text x={sx} y={sy - nodeR - 3} textAnchor="middle"
                  fill={isTarget ? "#ff88ff" : isOnPath ? "#ff88ff" : isHov || isActive ? "#7df" : "#4ac"}
                  fontSize={fontSize} fontWeight={700}
                  fontFamily="Inter, system-ui, sans-serif"
                  style={{ pointerEvents: "none" }}>
                  {noteName}
                </text>
              )}
              {showRatios && (
                <text x={sx} y={sy + (showNotes ? 3 : -nodeR - 3)} textAnchor="middle" dominantBaseline={showNotes ? "central" : undefined}
                  fill={isTarget ? "#e8c76a" : isHov || isActive ? "#e8c76a" : "#8a7540"}
                  fontSize={fontSize * 0.85} fontWeight={600}
                  fontFamily="'Courier New', monospace"
                  style={{ pointerEvents: "none" }}>
                  {node.ratioKey}
                </text>
              )}
              {showCents && (
                <text x={sx} y={sy + (showNotes || showRatios ? nodeR + fontSize * 0.6 : 3)} textAnchor="middle" dominantBaseline="central"
                  fill={isTarget ? "#fff" : isHov || isActive ? "#fff" : "#999"}
                  fontSize={fontSize * 0.75} fontWeight={400}
                  fontFamily="'Courier New', monospace"
                  style={{ pointerEvents: "none" }}>
                  {Math.round(node.cents)}¢
                </text>
              )}
            </g>
          );
        })}

        {/* Parallel voice-leading labels (above nodes) */}
        {parallelMoves && parallelMoves.length > 0 && parallelMoves.map((move, mi) => {
          let cx = 0, cy = 0, count = 0;
          for (const v of move.voices) {
            const fn = data.nodeMap.get(v.fromKey);
            const tn = data.nodeMap.get(v.toKey);
            if (fn && tn) {
              const [fx, fy] = toScreen(fn.pos3d);
              const [tx, ty] = toScreen(tn.pos3d);
              cx += (fx + tx) / 2; cy += (fy + ty) / 2; count++;
            }
          }
          if (count === 0) return null;
          cx /= count; cy /= count;
          return (
            <g key={`pml-${mi}`} style={{ cursor: "pointer" }}
              onClick={(e) => { e.stopPropagation(); onParallelMove?.(move); }}>
              <rect x={cx - 20} y={cy - 9} width={40} height={16} rx={4}
                fill="rgba(0,0,0,0.8)" stroke="#44ffaa" strokeOpacity={0.6} strokeWidth={1} />
              <text x={cx} y={cy + 2} textAnchor="middle"
                fill="#44ffaa" fontSize={9} fontWeight={700}
                fontFamily="Inter, system-ui, sans-serif"
                style={{ pointerEvents: "none" }}>
                ⇶ {move.direction}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Search input overlay — top right */}
      <div style={{ position: "absolute", top: 8, right: 8, zIndex: 10 }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Path to note\u2026"
          style={{
            width: 120,
            padding: "3px 8px",
            fontSize: 11,
            fontFamily: "Inter, system-ui, sans-serif",
            background: "rgba(0,0,0,0.7)",
            border: searchTargetKey ? "1px solid #ff44ff" : "1px solid #444",
            borderRadius: 6,
            color: "#ddd",
            outline: "none",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
        {searchQuery && !searchTargetKey && (
          <div style={{ fontSize: 9, color: "#888", marginTop: 2, textAlign: "right" }}>
            no match
          </div>
        )}
        {searchTargetKey && searchPathEdges && (
          <div style={{ fontSize: 9, color: "#ff88ff", marginTop: 2, textAlign: "right" }}>
            {searchPathEdges.size} step{searchPathEdges.size !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EDO Tonnetz 2D SVG — 12-EDO and 31-EDO Tonnetz with pan/zoom
// ═══════════════════════════════════════════════════════════════

interface EdoTonnetzSvgProps {
  data: EdoTonnetzData;
  droneNodes: Set<string>;
  hoveredNode: string | null;
  onHover: (key: string | null) => void;
  onClickNode: (node: EdoTonnetzNode) => void;
  showNotes: boolean;
  showSteps: boolean;
  showCents: boolean;
  rootPc: number;
  showEdges: Record<string, boolean>;
  showMajor: boolean;
  showMinor: boolean;
  showPLR: boolean;
  selectedTriad: string | null;
  activeTriads?: Set<string>;
  hoveredTriad: string | null;
  onHoverTriad: (key: string | null) => void;
  onClickTriad: (key: string) => void;
  onPLRNavigate?: (link: EdoTonnetzPLR) => void;
  chordMoves?: ChordMove[];
  onChordMove?: (move: ChordMove) => void;
  parallelMoves?: ParallelChordMove[];
  onParallelMove?: (move: ParallelChordMove) => void;
}

function EdoTonnetzSvg({
  data, droneNodes, hoveredNode, onHover, onClickNode,
  showNotes, showSteps, showCents, rootPc, showEdges, showMajor, showMinor, showPLR,
  selectedTriad, activeTriads, hoveredTriad, onHoverTriad, onClickTriad,
  onPLRNavigate, chordMoves, onChordMove, parallelMoves, onParallelMove,
}: EdoTonnetzSvgProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [zoom, setZoom] = useState(30);
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const dragRef = useRef<{ startX: number; startY: number; startPan: [number, number] } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const cx = size.w / 2 + pan[0];
  const cy = size.h / 2 + pan[1];
  const toScreen = useCallback((pos: [number, number]): [number, number] => {
    return [pos[0] * zoom + cx, -pos[1] * zoom + cy];
  }, [zoom, cx, cy]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPan: [...pan] };
  }, [pan]);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPan([dragRef.current.startPan[0] + dx, dragRef.current.startPan[1] + dy]);
  }, []);
  const onMouseUp = useCallback(() => { dragRef.current = null; }, []);
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(z => Math.max(5, Math.min(200, z * factor)));
  }, []);

  const triadMap = useMemo(() => new Map(data.triads.map(t => [t.key, t])), [data.triads]);
  const visibleTriads = useMemo(() => {
    return data.triads.filter(t =>
      (t.type === "major" && showMajor) || (t.type === "minor" && showMinor)
    );
  }, [data.triads, showMajor, showMinor]);

  const plrLinks = useMemo(() => {
    if (!showPLR || !selectedTriad) return [];
    return data.plrLinks.filter(l => l.from === selectedTriad);
  }, [data.plrLinks, showPLR, selectedTriad]);

  // ── Note search → shortest path ──────────────────────────────────
  const [edoSearchQuery, setEdoSearchQuery] = useState("");

  const edoAdjacency = useMemo(() => {
    const adj = new Map<string, { neighbor: string; edge: EdoTonnetzEdge }[]>();
    for (const edge of data.edges) {
      if (!adj.has(edge.from)) adj.set(edge.from, []);
      if (!adj.has(edge.to)) adj.set(edge.to, []);
      adj.get(edge.from)!.push({ neighbor: edge.to, edge });
      adj.get(edge.to)!.push({ neighbor: edge.from, edge });
    }
    return adj;
  }, [data.edges]);

  const edoSearchTargetKey = useMemo(() => {
    const q = edoSearchQuery.trim();
    if (!q) return null;
    const qLower = q.toLowerCase();
    const edo = data.config.edo;
    for (const node of data.nodes) {
      if (edoNoteNameByPc(node.pc, edo).toLowerCase() === qLower) return node.key;
    }
    for (const node of data.nodes) {
      if (edoNoteNameByPc(node.pc, edo).toLowerCase().startsWith(qLower)) return node.key;
    }
    return null;
  }, [edoSearchQuery, data.nodes, data.config.edo]);

  const edoSearchPathEdges = useMemo((): Set<EdoTonnetzEdge> | null => {
    if (!edoSearchTargetKey || !edoAdjacency) return null;
    const origin = data.nodes.find(n => n.pc === 0)?.key;
    if (!origin || edoSearchTargetKey === origin) return null;
    const dist = new Map<string, number>([[origin, 0]]);
    const queue = [origin];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const d = dist.get(curr)!;
      for (const { neighbor } of edoAdjacency.get(curr) ?? []) {
        if (!dist.has(neighbor)) { dist.set(neighbor, d + 1); queue.push(neighbor); }
      }
    }
    if (!dist.has(edoSearchTargetKey)) return null;
    const targetDist = dist.get(edoSearchTargetKey)!;
    const byDist = new Map<number, string[]>();
    for (const [k, d] of dist) { if (!byDist.has(d)) byDist.set(d, []); byDist.get(d)!.push(k); }
    const onPath = new Set<string>([edoSearchTargetKey]);
    for (let d = targetDist - 1; d >= 0; d--) {
      for (const node of byDist.get(d) ?? []) {
        for (const { neighbor } of edoAdjacency.get(node) ?? []) {
          if (dist.get(neighbor) === d + 1 && onPath.has(neighbor)) { onPath.add(node); break; }
        }
      }
    }
    const edges = new Set<EdoTonnetzEdge>();
    for (const node of onPath) {
      const d = dist.get(node)!;
      for (const { neighbor, edge } of edoAdjacency.get(node) ?? []) {
        if (dist.get(neighbor) === d + 1 && onPath.has(neighbor)) edges.add(edge);
      }
    }
    return edges.size > 0 ? edges : null;
  }, [edoSearchTargetKey, edoAdjacency, data.nodes]);

  const edoSearchPathNodes = useMemo(() => {
    if (!edoSearchPathEdges) return null;
    const nodes = new Set<string>();
    for (const e of edoSearchPathEdges) { nodes.add(e.from); nodes.add(e.to); }
    return nodes;
  }, [edoSearchPathEdges]);

  const nodeR = Math.max(4, Math.min(14, zoom * 0.35));
  const fontSize = Math.max(7, Math.min(12, zoom * 0.3));
  const edo = data.config.edo;

  return (
    <div ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative", cursor: dragRef.current ? "grabbing" : "grab" }}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
      onWheel={onWheel}
    >
      <svg width={size.w} height={size.h} style={{ display: "block", background: "#080808" }}>
        <SvgDefs />

        {/* Triad faces */}
        {visibleTriads.map(triad => {
          const tnodes = triad.nodeKeys.map(k => data.nodeMap.get(k)!).filter(Boolean);
          if (tnodes.length < 3) return null;
          const isSelected = selectedTriad === triad.key || !!activeTriads?.has(triad.key);
          const isHov = hoveredTriad === triad.key;
          const baseColor = triad.type === "major" ? "#4488ff" : "#ff6644";
          const opacity = isSelected ? 0.35 : isHov ? 0.25 : 0.08;
          const pts = tnodes.map(n => toScreen(n.pos2d));
          const pointsStr = pts.map(p => `${p[0]},${p[1]}`).join(" ");
          return (
            <polygon key={triad.key} points={pointsStr}
              fill={baseColor} fillOpacity={opacity} stroke={baseColor} strokeOpacity={opacity * 0.8} strokeWidth={0.5}
              style={{ cursor: "pointer" }}
              onMouseOver={() => onHoverTriad(triad.key)}
              onMouseOut={() => onHoverTriad(null)}
              onClick={(e) => { e.stopPropagation(); onClickTriad(triad.key); }}
            />
          );
        })}

        {/* Edges */}
        {data.edges.map((edge, i) => {
          if (!showEdges[edge.type]) return null;
          const a = data.nodeMap.get(edge.from);
          const b = data.nodeMap.get(edge.to);
          if (!a || !b) return null;
          const [ax, ay] = toScreen(a.pos2d);
          const [bx, by] = toScreen(b.pos2d);
          return (
            <line key={i} x1={ax} y1={ay} x2={bx} y2={by}
              stroke={EDO_TONNETZ_EDGE_COLORS[edge.type] ?? "#555"}
              strokeOpacity={0.45} strokeWidth={1.2} />
          );
        })}

        {/* PLR links — hidden when 4+ notes active */}
        {droneNodes.size <= 3 && plrLinks.map((link, i) => {
          const fromTriad = triadMap.get(link.from);
          const toTriad = triadMap.get(link.to);
          if (!fromTriad || !toTriad) return null;
          const [fx, fy] = toScreen(fromTriad.center);
          const [tx, ty] = toScreen(toTriad.center);
          const mx = (fx + tx) / 2;
          const my = (fy + ty) / 2;
          return (
            <g key={i} style={{ cursor: onPLRNavigate ? "pointer" : "default" }}
              onClick={onPLRNavigate ? (e) => { e.stopPropagation(); onPLRNavigate(link); } : undefined}>
              <line x1={fx} y1={fy} x2={tx} y2={ty}
                stroke="#ffdd44" strokeOpacity={0.7} strokeWidth={2}
                strokeDasharray="6 4" />
              <rect x={mx - 12} y={my - 9} width={24} height={16} rx={3}
                fill="rgba(0,0,0,0.6)" stroke="#ffdd44" strokeOpacity={onPLRNavigate ? 0.5 : 0} strokeWidth={1} />
              <text x={mx} y={my + 3} textAnchor="middle"
                fill="#ffdd44" fontSize={11} fontWeight={700}
                fontFamily="Inter, system-ui, sans-serif"
                style={{ pointerEvents: "none" }}>
                {link.name}
              </text>
            </g>
          );
        })}

        {/* Chord voice-leading move lines — hidden when 4+ notes active */}
        {droneNodes.size <= 3 && chordMoves && chordMoves.length > 0 && chordMoves.map((move, i) => {
          const fromNode = data.nodeMap.get(move.fromKey);
          const toNode = data.nodeMap.get(move.toKey);
          if (!fromNode || !toNode) return null;
          const [fx, fy] = toScreen(fromNode.pos2d);
          const [tx, ty] = toScreen(toNode.pos2d);
          const mx = (fx + tx) / 2;
          const my = (fy + ty) / 2;
          return (
            <g key={`cm-${i}`} style={{ cursor: "pointer" }}
              onClick={(e) => { e.stopPropagation(); onChordMove?.(move); }}>
              <line x1={fx} y1={fy} x2={tx} y2={ty}
                stroke="#ffdd44" strokeOpacity={0.5} strokeWidth={2}
                strokeDasharray="4 3" />
              <circle cx={tx} cy={ty} r={nodeR * 0.6}
                fill="#ffdd44" fillOpacity={0.3} stroke="#ffdd44" strokeOpacity={0.6} strokeWidth={1} />
              <rect x={mx - 14} y={my - 8} width={28} height={14} rx={3}
                fill="rgba(0,0,0,0.7)" />
              <text x={mx} y={my + 2} textAnchor="middle"
                fill="#ffdd44" fontSize={9} fontWeight={700}
                fontFamily="Inter, system-ui, sans-serif"
                style={{ pointerEvents: "none" }}>
                {move.direction}
              </text>
            </g>
          );
        })}

        {/* Parallel voice-leading lines (behind nodes) */}
        {parallelMoves && parallelMoves.length > 0 && parallelMoves.map((move, mi) =>
          move.voices.map((v, vi) => {
            const fromNode = data.nodeMap.get(v.fromKey);
            const toNode = data.nodeMap.get(v.toKey);
            if (!fromNode || !toNode) return null;
            const [fx, fy] = toScreen(fromNode.pos2d);
            const [tx, ty] = toScreen(toNode.pos2d);
            return (
              <g key={`pv-${mi}-${vi}`}>
                <line x1={fx} y1={fy} x2={tx} y2={ty}
                  stroke="#44ffaa" strokeOpacity={0.5} strokeWidth={2}
                  strokeDasharray="6 2" />
                <circle cx={tx} cy={ty} r={nodeR * 0.5}
                  fill="#44ffaa" fillOpacity={0.25} stroke="#44ffaa" strokeOpacity={0.5} strokeWidth={1} />
              </g>
            );
          })
        )}

        {/* Search shortest-path edges */}
        {edoSearchPathEdges && [...edoSearchPathEdges].map((edge, i) => {
          const a = data.nodeMap.get(edge.from);
          const b = data.nodeMap.get(edge.to);
          if (!a || !b) return null;
          const [ax, ay] = toScreen(a.pos2d);
          const [bx, by] = toScreen(b.pos2d);
          return (
            <line key={`sp-${i}`} x1={ax} y1={ay} x2={bx} y2={by}
              stroke="#ff44ff" strokeOpacity={0.9} strokeWidth={3} />
          );
        })}

        {/* Nodes */}
        {data.nodes.map(node => {
          const [sx, sy] = toScreen(node.pos2d);
          const isActive = droneNodes.has(node.key);
          const isHov = hoveredNode === node.key;
          const isRoot = node.pc === 0;
          const isOnPath = edoSearchPathNodes?.has(node.key) ?? false;
          const isTarget = node.key === edoSearchTargetKey;
          const grad = isActive ? "url(#ng-active)" : isRoot ? "url(#ng-root)" : "url(#ng-idle)";
          const noteName = edoNoteNameByPc(node.pc, edo);
          return (
            <g key={node.key} style={{ cursor: "pointer" }}
              onMouseOver={() => onHover(node.key)}
              onMouseOut={() => onHover(null)}
              onClick={(e) => { e.stopPropagation(); onClickNode(node); }}
              filter={isActive ? "url(#glow)" : isTarget ? "url(#glow)" : undefined}
            >
              <circle cx={sx} cy={sy} r={isTarget ? nodeR * 1.3 : isHov ? nodeR * 1.2 : isActive ? nodeR * 1.1 : nodeR}
                fill={isTarget ? "#ff44ff" : grad}
                stroke={isTarget ? "#ff88ff" : isOnPath ? "#ff44ff" : isActive ? "#9395ea" : isHov ? "#5a5cc8" : "#444"}
                strokeWidth={isTarget || isOnPath ? 2 : 1} />
              {showNotes && (
                <text x={sx} y={sy - nodeR - 3} textAnchor="middle"
                  fill={isTarget ? "#ff88ff" : isOnPath ? "#ff88ff" : isHov || isActive ? "#7df" : "#4ac"}
                  fontSize={fontSize} fontWeight={700}
                  fontFamily="Inter, system-ui, sans-serif"
                  style={{ pointerEvents: "none" }}>
                  {noteName}
                </text>
              )}
              {showSteps && (
                <text x={sx} y={sy + (showNotes ? 3 : -nodeR - 3)} textAnchor="middle" dominantBaseline={showNotes ? "central" : undefined}
                  fill={isTarget ? "#e8c76a" : isHov || isActive ? "#e8c76a" : "#8a7540"}
                  fontSize={fontSize * 0.85} fontWeight={600}
                  fontFamily="'Courier New', monospace"
                  style={{ pointerEvents: "none" }}>
                  {node.pc}
                </text>
              )}
              {showCents && (
                <text x={sx} y={sy + (showNotes || showSteps ? nodeR + fontSize * 0.6 : 3)} textAnchor="middle" dominantBaseline="central"
                  fill={isTarget ? "#fff" : isHov || isActive ? "#fff" : "#999"}
                  fontSize={fontSize * 0.75} fontWeight={400}
                  fontFamily="'Courier New', monospace"
                  style={{ pointerEvents: "none" }}>
                  {Math.round(node.cents)}¢
                </text>
              )}
            </g>
          );
        })}

        {/* Parallel voice-leading labels (above nodes) */}
        {parallelMoves && parallelMoves.length > 0 && parallelMoves.map((move, mi) => {
          let cx = 0, cy = 0, count = 0;
          for (const v of move.voices) {
            const fn = data.nodeMap.get(v.fromKey);
            const tn = data.nodeMap.get(v.toKey);
            if (fn && tn) {
              const [fx, fy] = toScreen(fn.pos2d);
              const [tx, ty] = toScreen(tn.pos2d);
              cx += (fx + tx) / 2; cy += (fy + ty) / 2; count++;
            }
          }
          if (count === 0) return null;
          cx /= count; cy /= count;
          return (
            <g key={`pml-${mi}`} style={{ cursor: "pointer" }}
              onClick={(e) => { e.stopPropagation(); onParallelMove?.(move); }}>
              <rect x={cx - 20} y={cy - 9} width={40} height={16} rx={4}
                fill="rgba(0,0,0,0.8)" stroke="#44ffaa" strokeOpacity={0.6} strokeWidth={1} />
              <text x={cx} y={cy + 2} textAnchor="middle"
                fill="#44ffaa" fontSize={9} fontWeight={700}
                fontFamily="Inter, system-ui, sans-serif"
                style={{ pointerEvents: "none" }}>
                ⇶ {move.direction}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Search input overlay — top right */}
      <div style={{ position: "absolute", top: 8, right: 8, zIndex: 10 }}>
        <input
          type="text"
          value={edoSearchQuery}
          onChange={(e) => setEdoSearchQuery(e.target.value)}
          placeholder="Path to note\u2026"
          style={{
            width: 120,
            padding: "3px 8px",
            fontSize: 11,
            fontFamily: "Inter, system-ui, sans-serif",
            background: "rgba(0,0,0,0.7)",
            border: edoSearchTargetKey ? "1px solid #ff44ff" : "1px solid #444",
            borderRadius: 6,
            color: "#ddd",
            outline: "none",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
        {edoSearchQuery && !edoSearchTargetKey && (
          <div style={{ fontSize: 9, color: "#888", marginTop: 2, textAlign: "right" }}>
            no match
          </div>
        )}
        {edoSearchTargetKey && edoSearchPathEdges && (
          <div style={{ fontSize: 9, color: "#ff88ff", marginTop: 2, textAlign: "right" }}>
            {edoSearchPathEdges.size} step{edoSearchPathEdges.size !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

type ViewMode = "lattice" | "harmonic" | "otonal" | "comma" | "chain" | "monzo";

// Tab order matters: Object.keys() iterates in insertion order, and the
// tab row uses that to render.  monzo (renamed "Lattice") is first so
// the section opens on the prime-factor lattice — what most users mean
// when they say "the harmonic lattice" — and the Tonnetz triadic graph
// sits in second position.
const MODE_LABELS: Record<ViewMode, string> = {
  monzo: "Lattice",            // the prime-factor JI lattice — default
  lattice: "Tonnetz",          // Riemannian triadic graph — moved to 2nd
  harmonic: "Harmonic Series",
  otonal: "Otonal / Utonal",
  comma: "Comma",
  chain: "Interval Chain",
};

function modeDefaults(mode: ViewMode) {
  const gen = { 3: false, 5: false, 7: false, 11: false, 13: false };
  switch (mode) {
    case "lattice":
      return { gen: { 3: true, 5: true, 7: true, 11: true, 13: true }, otonal: false, utonal: false, comma: false, octave: false };
    case "harmonic":
      return { gen, otonal: false, utonal: false, comma: false, octave: false };
    case "otonal":
      return { gen, otonal: true, utonal: true, comma: false, octave: false };
    case "comma":
      return { gen: { 3: true, 5: true, 7: true, 11: false, 13: false }, otonal: false, utonal: false, comma: true, octave: false };
    case "chain":
      return { gen: { ...gen, 3: true, 5: true }, otonal: false, utonal: false, comma: false, octave: false };
    case "monzo":
      return { gen, otonal: false, utonal: false, comma: false, octave: false };
  }
}

const LIMIT_OPTIONS = [0, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 127] as const;

type LatticeDroneMode = "Off" | "Single" | "Root+5th" | "Tanpura";

interface LatticeViewProps {
  /** Optional set of node keys (n/d ratio strings) to highlight from
   *  outside.  When provided, takes precedence over the internal
   *  custom-ratio / note-filter highlight pipeline so external callers
   *  (e.g. ChordsTab's Show-Answer overlay) can drive node highlights
   *  for a chord-progression trace.  Pass undefined / empty Set to fall
   *  back to the built-in highlighting behaviour. */
  externalHighlights?: Set<string>;
  /** Node key (n/d ratio string) for the currently active step in the
   *  external trace.  Surfaced as a transient drone-node so it pulses
   *  using the same visual treatment a clicked node gets — letting the
   *  caller animate a step-by-step walk by changing this value over
   *  time.  Pass null / undefined when no step is active. */
  activeNodeKey?: string | null;
  /** Multiple node keys for the currently active step.  When supplied,
   *  takes precedence over `activeNodeKey` — used by the chord-trace
   *  overlay to light up every chord-tone (root + 3rd + 5th + 7th)
   *  simultaneously, mirroring what the keyboard highlights during
   *  playback.  Pass an empty Set / undefined when nothing is active. */
  activeNodeKeys?: Set<string>;
  /** Active EDO step numbers (0..edo-1) to highlight.  Resolved
   *  through `lattice.classMap` so the rep cell of each class gets
   *  the active treatment regardless of which exact JI ratio the
   *  caller passed.  Lets chord-tone highlighting work even when
   *  comma drift moves a chord tone to a non-canonical JI cell —
   *  the EDO step stays well-defined and the right rep lights up. */
  activeClassIds?: Set<number>;
  /** When supplied, the monzo lattice's equivalence-class assignment
   *  switches to val-based for this EDO — i.e. every JI cell is
   *  coloured by which one of `edo` pitch classes it maps to, while
   *  the lattice itself stays at full rank in 3D.  Tonescape-style:
   *  the chain of fifths in 12-EDO becomes a visible helix because
   *  the cells keep their JI positions; only their colour grouping
   *  reflects the EDO collapse.  No `temperedCommas` are applied —
   *  collapsing the lattice rank produces a degenerate line that
   *  hides which structures the temperament actually preserves. */
  temperingForEdo?: number;
  /** When true, hide all controls (header, mode-tabs, drone /
   *  preset / temper / tuning panel, layers, etc.) and render only
   *  the 3D canvas.  Used when LatticeView is embedded as a
   *  read-only visualization in another panel where the parent has
   *  already configured tempering — the user doesn't need to see
   *  options that have been pre-decided for them. */
  chromeless?: boolean;
  /** Multi-colour pinned-chord overlays.  Each entry highlights its
   *  set of EDO equivalence classes in the supplied colour.  Used by
   *  the chord-tab harmonic-lattice toggle buttons so the user can
   *  pin two or more chords from the played progression and see each
   *  one rendered in a distinct colour at the same time.  When a
   *  single class appears in multiple overlays, the first overlay
   *  in the array wins. */
  pinnedChordOverlays?: Array<{ classes: Set<number>; color: string }>;
  /** Comma-compensation arcs — one per chord that needed a non-zero
   *  drift offset.  Each arc renders as a curve arching up out of
   *  the lattice from the chord's uncompensated rep to its
   *  compensated rep, so the user can see the exact EDO step the
   *  playback used to keep the tonic anchored. */
  compensationArcs?: Array<{ fromClassId: number; toClassId: number; color: string; chordIdx: number }>;
}

export default function LatticeView({ externalHighlights, activeNodeKey, activeNodeKeys, activeClassIds, temperingForEdo, chromeless = false, pinnedChordOverlays, compensationArcs }: LatticeViewProps = {}) {
  const [droneNodes, setDroneNodes] = useState<Set<string>>(new Set());
  // When the parent supplies `activeNodeKeys` (plural) or
  // `activeNodeKey` (singular), surface them through the standard
  // droneNodes set so they pick up the same pulsing/highlight visual
  // treatment a clicked node gets.  Plural takes precedence so the
  // chord-trace overlay can light up every chord tone simultaneously
  // (root + 3rd + 5th + 7th) while playback advances.  Internal user
  // clicks are clobbered while the external override is active, which
  // matches the rest of the externalHighlights override semantics.
  useEffect(() => {
    if (activeNodeKeys !== undefined) {
      setDroneNodes(new Set(activeNodeKeys));
      return;
    }
    if (activeNodeKey === undefined) return;
    setDroneNodes(activeNodeKey ? new Set([activeNodeKey]) : new Set());
  }, [activeNodeKey, activeNodeKeys]);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("monzo");
  // labelMode removed — ChainSvg now hardcoded to "intervals"
  const [cameraResetKey, setCameraResetKey] = useState(0);

  // ── Beta feature flags ──────────────────────────────────────────
  const [betaIntervalChain] = useLS<boolean>("lt_beta_interval_chain", false);
  const [betaComma] = useLS<boolean>("lt_beta_comma", false);

  // ── Persistent drone (tanpura / root+5th) ─────────────────────────
  const [latticeDroneMode, setLatticeDroneMode] = useLS<LatticeDroneMode>("lt_lattice_droneMode", "Off");
  const [latticeDroneVol, setLatticeDroneVol] = useLS<number>("lt_lattice_droneVol", 0.08);
  const [latticeDroneRoot, setLatticeDroneRoot] = useLS<number>("lt_lattice_droneRoot", 0); // 0-11 pitch class
  const [latticeDroneOctave, setLatticeDroneOctave] = useLS<number>("lt_lattice_droneOctave", 4);
  const [latticeDroneOn, setLatticeDroneOn] = useState(false);

  // ── Node-click drone volume ──────────────────────────────────────
  const [nodeVolMaster, setNodeVolMaster] = useLS<number>("lt_nodeVol_master", 0.1);
  const [nodeVolMap, setNodeVolMap] = useState<Record<string, number>>({});
  const [nodeVolAutoRamp, setNodeVolAutoRamp] = useLS<boolean>("lt_nodeVol_autoRamp", true);
  // Base volume for first note, ramp step per additional note
  const nodeVolRampBase = 0.3;
  const nodeVolRampStep = 0.15;

  // Harmonic Series mode state
  const [harmonicLimit, setHarmonicLimit] = useState(0);
  const [octaveReduce, setOctaveReduce] = useState(false);
  const [maxHarmonic, setMaxHarmonic] = useState(16);
  const [showIntervals, setShowIntervals] = useState(false);
  const [subharmonic, setSubharmonic] = useState(false);

  // Otonal/Utonal stack mode state
  const [stackBase, setStackBase] = useState(4);
  const [stackCount, setStackCount] = useState(4);
  const [stackIsUtonal, setStackIsUtonal] = useState(false);
  const [stackMultiple, setStackMultiple] = useState(1);
  const [stackActiveNodes, setStackActiveNodes] = useState<Set<string>>(new Set());

  // Comma mode state
  const [commaShowFromUnison, setCommaShowFromUnison] = useState(false);

  // Tonnetz mode state
  const [tonnetzPreset, setTonnetzPreset] = useState<string>("5-limit");
  const [tonnetzConfig, setTonnetzConfig] = useState<TonnetzConfig>(TONNETZ_PRESETS["5-limit"]);
  const [tonnetzShowNotes, setTonnetzShowNotes] = useState(true);
  const [tonnetzShowRatios, setTonnetzShowRatios] = useState(false);
  const [tonnetzShowCents, setTonnetzShowCents] = useState(false);
  const [tonnetzShowOtonal, setTonnetzShowOtonal] = useState(true);
  const [tonnetzShowUtonal, setTonnetzShowUtonal] = useState(true);
  const [tonnetzShowPLR, setTonnetzShowPLR] = useState(true);
  const [tonnetzSelectedTriad, setTonnetzSelectedTriad] = useState<string | null>(null);
  const [tonnetzHoveredTriad, setTonnetzHoveredTriad] = useState<string | null>(null);
  const [tonnetzShowEdges, setTonnetzShowEdges] = useState<Record<number, boolean>>({ 3: true, 5: true, 7: true, 11: true, 13: true });

  const tonnetzData = useMemo(() => buildTonnetz(tonnetzConfig), [tonnetzConfig]);
  const tonnetzInfoData = useMemo(() => tonnetzInfo(tonnetzData), [tonnetzData]);

  const handleTonnetzPresetChange = useCallback((presetName: string) => {
    setTonnetzPreset(presetName);
    if (TONNETZ_PRESETS[presetName]) {
      setTonnetzConfig(TONNETZ_PRESETS[presetName]);
      setTonnetzSelectedTriad(null);
    }
  }, []);

  // ── EDO Tonnetz sub-mode ─────────────────────────────────────────
  type TonnetzSubMode = "ji" | "12edo" | "31edo" | "53edo";
  const [tonnetzSubMode, setTonnetzSubMode] = useState<TonnetzSubMode>("ji");
  const [edoTonnetzPreset, setEdoTonnetzPreset] = useState<string>("12-EDO");
  const [edoTonnetzConfig, setEdoTonnetzConfig] = useState<EdoTonnetzConfig>(EDO_TONNETZ_PRESETS["12-EDO"]);
  const [edoTonnetzShowNotes, setEdoTonnetzShowNotes] = useState(true);
  const [edoTonnetzShowSteps, setEdoTonnetzShowSteps] = useState(false);
  const [edoTonnetzShowCents, setEdoTonnetzShowCents] = useState(false);
  const [edoTonnetzShowMajor, setEdoTonnetzShowMajor] = useState(true);
  const [edoTonnetzShowMinor, setEdoTonnetzShowMinor] = useState(true);
  const [edoTonnetzShowPLR, setEdoTonnetzShowPLR] = useState(true);
  const [edoTonnetzSelectedTriad, setEdoTonnetzSelectedTriad] = useState<string | null>(null);
  const [edoTonnetzHoveredTriad, setEdoTonnetzHoveredTriad] = useState<string | null>(null);
  const [edoTonnetzShowEdges, setEdoTonnetzShowEdges] = useState<Record<string, boolean>>({ fifth: true, majorThird: true, minorThird: true });

  const edoTonnetzData = useMemo(() => buildEdoTonnetz(edoTonnetzConfig), [edoTonnetzConfig]);
  const edoTonnetzInfoData = useMemo(() => edoTonnetzInfo(edoTonnetzData), [edoTonnetzData]);

  const handleEdoTonnetzPresetChange = useCallback((presetName: string) => {
    setEdoTonnetzPreset(presetName);
    if (EDO_TONNETZ_PRESETS[presetName]) {
      setEdoTonnetzConfig(EDO_TONNETZ_PRESETS[presetName]);
      setEdoTonnetzSelectedTriad(null);
    }
  }, []);

  const handleTonnetzSubModeChange = useCallback((mode: TonnetzSubMode) => {
    setTonnetzSubMode(mode);
    setDroneNodes(new Set());
    audioEngine.stopDrone();
    if (mode === "12edo") {
      setEdoTonnetzPreset("12-EDO");
      setEdoTonnetzConfig(EDO_TONNETZ_PRESETS["12-EDO"]);
    } else if (mode === "31edo") {
      setEdoTonnetzPreset("31-EDO");
      setEdoTonnetzConfig(EDO_TONNETZ_PRESETS["31-EDO"]);
    } else if (mode === "53edo") {
      setEdoTonnetzPreset("53-EDO");
      setEdoTonnetzConfig(EDO_TONNETZ_PRESETS["53-EDO"]);
    }
    setEdoTonnetzSelectedTriad(null);
    setTonnetzSelectedTriad(null);
  }, []);

  // Monzo lattice mode state
  const [monzoPreset, setMonzoPreset] = useState<string>("7-limit");
  const [monzoConfig, setMonzoConfig] = useState<LatticeConfig>(PRESET_CONFIGS["7-limit"]);

  // ── EDO auto-tempering ─────────────────────────────────────────────
  // Inspired by Tonalsoft's Tonescape: when an EDO is the active
  // tuning, we DON'T collapse the JI lattice down to a low-rank
  // quotient — that just produces a straight line for meantone EDOs
  // and destroys the spatial information the user wants to see.
  // Instead, we keep the lattice at its full 5-/7-limit dimension
  // and only set `monzoConfig.edo`, which switches equivalence-class
  // assignment to val-based (mapping each lattice node to one of
  // exactly `edo` classes).  Cells that share an EDO step then share
  // a class colour while staying at their pure-JI positions in 3D —
  // 12-EDO's chain of fifths becomes a visible helix/spiral instead
  // of a degenerate line, schismatic EDOs show their near-equivalent
  // paths as parallel ribbons, and the user can actually read what
  // the temperament preserves.  Bounds are widened on the 3-axis so
  // the spiral has room to wrap several times without being clipped.
  useEffect(() => {
    if (typeof temperingForEdo !== "number") return;
    // Tonescape "3,5-primespace toroidal lattice", matched to
    // 12-edo_3-5-space_tm-basis.tonespace.  Crucially:
    //  - octaveEquivalence: FALSE (prime-2 is a real spatial axis).
    //    With it ON, all cells project to a flat (b, c) plane —
    //    that's why the shape was a 2D rectangle instead of a 3D
    //    torus.  Off, prime-2 supplies the depth dimension and
    //    each cell sits at its (a, b, c) monzo coordinate via the
    //    standard linear projection.
    //  - showPrime2: TRUE (prime-2 edges drawn).
    //  - bounds 2:[-3, 4] is the same prime-2 span the .tonespace
    //    file uses for its 12 TM-basis cells.
    //  - gridType "square" → linear monzoTo3D projection.
    //  - temperedCommas: [] → the val drives class assignment;
    //    positions are NOT collapsed via V⊥ projection.
    //  - The class-rep filter on the render loop drops non-rep
    //    cells so 12-EDO renders 12 nodes, 31-EDO 31, etc.
    // Bounds must produce a (b, c) lattice large enough that the
    // step = (val[3]·b + val[5]·c) mod edo map covers every one of
    // the `edo` equivalence classes — otherwise high-EDO views are
    // missing nodes (53-EDO with the old [-3, 3] × [-2, 2] grid hit
    // only ~35 of the 53 classes since prime-2's val of 53 ≡ 0
    // mod 53 contributes nothing).  Walking the chain of fifths
    // alone covers all classes once `b` spans `edo` consecutive
    // values, so scale the prime-3 bound to ⌈edo/2⌉ for any EDO
    // where the default range falls short, and keep c at ±3 so
    // each b gets a vertical band of major-third neighbours.
    const halfEdo = Math.ceil(temperingForEdo / 2);
    const b3Bound = Math.max(3, halfEdo);
    const b5Bound = temperingForEdo >= 19 ? 3 : 2;
    setMonzoConfig(prev => ({
      ...prev,
      primes: [2, 3, 5],
      bounds: { 2: [-3, 4], 3: [-b3Bound, b3Bound], 5: [-b5Bound, b5Bound] },
      octaveEquivalence: false,
      showPrime2: true,
      edo: temperingForEdo,
      temperedCommas: [],
      // Parametric torus.  Cells project onto a torus surface
      // where each fifth advances the major angle by P5_step/edo
      // and each third advances the minor angle by M3_step/edo
      // (full turn).  After class-rep filtering, every visible
      // rep lands at its own clean (u, v) point on the torus,
      // and the synthesised P5 + M3 edges trace continuous
      // cycles around the surface instead of cutting chaotically
      // through 3D space.
      gridType: "toroidal",
      projections: DEFAULT_PROJECTIONS,
    }));
    setMonzoGridType("toroidal");
    setMonzoPreset(`${temperingForEdo}-EDO 3,5-primespace toroidal lattice`);
    // EDO context: keep prime edges visible (the M3 / P5 chains are
    // exactly what makes the toroidal structure legible), and
    // surface note names + class IDs so each cell reads as a real
    // pitch.  Hide the busier monzo / HEJI / interval / ratio
    // overlays so the torus stays uncluttered.
    setMonzoLayers(prev => ({
      ...prev,
      classes: true,
      noteNames: true,
      primeEdges: true,
      temperedEdges: false,
      intervals: false,
      ratios: false,
      monzo: false,
      heji: false,
    }));
  }, [temperingForEdo]);
  // monzoLabelMode removed — now individual layer toggles
  const [monzoShowTopo, setMonzoShowTopo] = useState(true);
  // Default to the Tonescape-style helical projection so anyone
  // opening the lattice — embedded or standalone — gets the
  // spiral / helix view automatically.  Square / triangle remain
  // available as manual overrides for users who explicitly want a
  // flat 2D-ish layout.
  const [monzoGridType, setMonzoGridType] = useState<GridType>("helical");
  const [customCommaInput, setCustomCommaInput] = useState("");
  const [jumpRatioInput, setJumpRatioInput] = useState("");

  // Custom ratios filter mode — auto-active when input has valid ratios
  const [customRatiosInput, setCustomRatiosInput] = useState("");
  const [customRatioPresets, setCustomRatioPresets] = useLS<Record<string, string>>("lt_monzo_ratioPresets", {});
  const [ratioPresetName, setRatioPresetName] = useState("");

  const parsedCustomRatios = useMemo((): Set<string> => {
    if (!customRatiosInput.trim()) return new Set();
    const keys = new Set<string>();
    const parts = customRatiosInput.split(/[,;\n\s]+/).filter(Boolean);
    for (const part of parts) {
      const match = part.trim().match(/^(\d+)\s*[/:]\s*(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10), d = parseInt(match[2], 10);
        if (n > 0 && d > 0) {
              // Normalize to canonical octave-reduced key (e.g. 3135/3072 → 1045/1024)
              const exps = factorize(n, d, [...ALL_PRIMES], true);
              const [cn, cd] = monzoToRatio(exps, [...ALL_PRIMES], true);
              keys.add(`${cn}/${cd}`);
            }
      }
    }
    return keys;
  }, [customRatiosInput]);

  const customRatiosActive = parsedCustomRatios.size > 0;
  const [customRatioNeighbors, setCustomRatioNeighbors] = useState(false);
  const [customRatioNeighborRadius, setCustomRatioNeighborRadius] = useState(1);

  const saveRatioPreset = useCallback(() => {
    const name = ratioPresetName.trim();
    if (!name || !customRatiosInput.trim()) return;
    setCustomRatioPresets(prev => ({ ...prev, [name]: customRatiosInput.trim() }));
    setRatioPresetName("");
  }, [ratioPresetName, customRatiosInput]);

  const loadRatioPreset = useCallback((name: string) => {
    const val = customRatioPresets[name];
    if (val) setCustomRatiosInput(val);
  }, [customRatioPresets]);

  const deleteRatioPreset = useCallback((name: string) => {
    setCustomRatioPresets(prev => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  const addCustomComma = useCallback(() => {
    const match = customCommaInput.trim().match(/^(\d+)\s*[/:]\s*(\d+)$/);
    if (!match) return;
    const n = parseInt(match[1], 10), d = parseInt(match[2], 10);
    if (n <= 0 || d <= 0 || n === d) return;
    // Don't add duplicates
    setMonzoConfig(prev => {
      if (prev.temperedCommas.some(c => c.n === n && c.d === d)) return prev;
      return { ...prev, temperedCommas: [...prev.temperedCommas, { n, d, name: `${n}/${d}` }] };
    });
    setMonzoPreset("Custom");
    setCustomCommaInput("");
  }, [customCommaInput]);

  // Layers system
  const [monzoLayers, setMonzoLayers] = useState({
    nodes: true,
    primeEdges: true,
    temperedEdges: false,
    noteNames: true,
    intervals: true,
    ratios: true,
    monzo: false,
    heji: false,
    classes: false,
  });
  const [monzoPathMode, setMonzoPathMode] = useState(false);

  const [clearPinnedKey, setClearPinnedKey] = useState(0);
  const toggleMonzoLayer = useCallback((key: keyof typeof monzoLayers) => {
    setMonzoLayers(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Neighborhood / focus mode
  const [monzoNeighborRadius, setMonzoNeighborRadius] = useState<number | null>(null);
  const [monzoFocusKey, setMonzoFocusKey] = useState<string | null>(null);
  // Label auto-hide
  const [monzoLabelLOD, setMonzoLabelLOD] = useState(false);
  const [monzoLabelDist, setMonzoLabelDist] = useState(20);
  const [noteFilterInput, setNoteFilterInput] = useState("");
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  // Fullscreen
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fsControlsOpen, setFsControlsOpen] = useState(false);
  useEffect(() => {
    const handler = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      if (!fs) setFsControlsOpen(false);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (!canvasContainerRef.current) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else canvasContainerRef.current.requestFullscreen();
  }, []);

  // Debounce monzoConfig so rapid bound clicks don't trigger expensive rebuilds
  const [debouncedConfig, setDebouncedConfig] = useState(monzoConfig);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedConfig(monzoConfig), 150);
    return () => clearTimeout(id);
  }, [monzoConfig]);

  // Auto-compute optimal lattice config from custom ratios
  // Factorize each custom ratio into monzo exponents for later filtering
  const customRatioMonzos = useMemo(() => {
    if (!customRatiosActive || parsedCustomRatios.size === 0) return null;
    const result = new Map<string, number[]>(); // key -> exponent vector (indexed by ALL_PRIMES)
    for (const key of parsedCustomRatios) {
      const [ns, ds] = key.split("/");
      const n = parseInt(ns, 10), d = parseInt(ds, 10);
      if (!n || !d) continue;
      result.set(key, factorize(n, d, [...ALL_PRIMES], true));
    }
    return result.size > 0 ? result : null;
  }, [customRatiosActive, parsedCustomRatios]);

  // Auto-expand monzoConfig bounds & primes to include all custom ratios
  useEffect(() => {
    if (!customRatioMonzos || customRatioMonzos.size === 0) return;
    setMonzoConfig(prev => {
      // Compute per-prime exponent ranges needed for the custom ratios
      const neededBounds = new Map<number, [number, number]>();
      for (const exps of customRatioMonzos.values()) {
        for (let i = 0; i < ALL_PRIMES.length; i++) {
          const e = exps[i];
          if (e === 0) continue;
          const p = ALL_PRIMES[i];
          if (p === 2) continue; // skip octave axis
          const cur = neededBounds.get(p) ?? [0, 0];
          cur[0] = Math.min(cur[0], e);
          cur[1] = Math.max(cur[1], e);
          neededBounds.set(p, cur);
        }
      }
      if (neededBounds.size === 0) return prev;

      // Merge needed primes and bounds into existing config
      const newPrimes = new Set(prev.primes);
      const newBounds = { ...prev.bounds };
      let changed = false;
      for (const [p, [lo, hi]] of neededBounds) {
        if (!newPrimes.has(p)) {
          newPrimes.add(p);
          newBounds[p] = [lo, hi];
          changed = true;
        } else {
          const [prevLo, prevHi] = newBounds[p] ?? [0, 0];
          const mergedLo = Math.min(prevLo, lo);
          const mergedHi = Math.max(prevHi, hi);
          if (mergedLo !== prevLo || mergedHi !== prevHi) {
            newBounds[p] = [mergedLo, mergedHi];
            changed = true;
          }
        }
      }
      if (!changed) return prev;

      // Ensure projections exist for new primes
      const newProjections = { ...prev.projections };
      for (const p of newPrimes) {
        if (!newProjections[p]) {
          newProjections[p] = DEFAULT_PROJECTIONS[p] ?? [0, 0, 0];
        }
      }

      return {
        ...prev,
        primes: [...newPrimes].sort((a, b) => a - b),
        bounds: newBounds,
        projections: newProjections,
      };
    });
  }, [customRatioMonzos]);

  const customRatiosConfig = useMemo((): LatticeConfig | null => {
    if (!customRatioMonzos) return null;
    // Compute per-prime exponent ranges from the custom ratios
    const boundsMap = new Map<number, [number, number]>();
    for (const exps of customRatioMonzos.values()) {
      for (let i = 0; i < ALL_PRIMES.length; i++) {
        const e = exps[i];
        if (e === 0) continue;
        const p = ALL_PRIMES[i];
        const cur = boundsMap.get(p) ?? [0, 0];
        cur[0] = Math.min(cur[0], e);
        cur[1] = Math.max(cur[1], e);
        boundsMap.set(p, cur);
      }
    }
    if (boundsMap.size === 0) return null;
    if (!boundsMap.has(3)) boundsMap.set(3, [0, 0]);
    if (!boundsMap.has(2)) boundsMap.set(2, [-1, 1]);
    const primes = [...boundsMap.keys()].sort((a, b) => a - b);

    // Expand bounds to include neighborhood radius around each ratio's exponents
    const radius = customRatioNeighbors ? customRatioNeighborRadius : 0;
    const bounds: Record<number, [number, number]> = {};
    for (const p of primes) {
      const [lo, hi] = boundsMap.get(p)!;
      bounds[p] = [lo - radius, hi + radius];
    }

    // Cap total node count to prevent renderer crashes.
    // Core bounds = exact ratio exponent ranges — must never be shrunk below these.
    const MAX_NODES = 5000;
    const nodeCount = () => primes.reduce((prod, p) => prod * (bounds[p][1] - bounds[p][0] + 1), 1);
    const coreBounds: Record<number, [number, number]> = {};
    for (const p of primes) {
      const [lo, hi] = boundsMap.get(p)!;
      coreBounds[p] = [lo, hi];
    }
    let safety = 200;
    while (nodeCount() > MAX_NODES && --safety > 0) {
      // Find the widest axis that still has neighborhood padding to trim
      let widestP = -1, widestExtra = 0;
      for (const p of primes) {
        const extra = (bounds[p][1] - bounds[p][0]) - (coreBounds[p][1] - coreBounds[p][0]);
        if (extra > widestExtra) { widestExtra = extra; widestP = p; }
      }
      if (widestP < 0 || widestExtra <= 0) break; // all axes at core bounds
      // Shrink from whichever side has more padding
      const padLo = coreBounds[widestP][0] - bounds[widestP][0];
      const padHi = bounds[widestP][1] - coreBounds[widestP][1];
      if (padLo >= padHi)
        bounds[widestP] = [bounds[widestP][0] + 1, bounds[widestP][1]];
      else
        bounds[widestP] = [bounds[widestP][0], bounds[widestP][1] - 1];
    }

    return {
      primes,
      bounds,
      octaveEquivalence: debouncedConfig.octaveEquivalence,
      showPrime2: false,
      projections: debouncedConfig.projections,
      temperedCommas: debouncedConfig.temperedCommas,
    };
  }, [customRatioMonzos, customRatioNeighbors, customRatioNeighborRadius, debouncedConfig]);

  const effectiveConfig = useMemo(() => {
    const base = customRatiosConfig ?? debouncedConfig;
    return { ...base, gridType: monzoGridType };
  }, [customRatiosConfig, debouncedConfig, monzoGridType]);
  const monzoLattice = useMemo(() => buildLattice(effectiveConfig), [effectiveConfig]);
  const monzoTopology = useMemo(() => {
    const base = detectTopology(effectiveConfig);
    // Toroidal / helical grid types lay every cell out as a helix on
    // a cylinder.  When no commas are tempered, detectTopology
    // returns "plane" — but the cells themselves already live on a
    // cylinder, so promote the topology so the cylinder mesh draws
    // behind them and the spiral visibly wraps a surface.
    if (base.type === "plane" && (monzoGridType === "toroidal" || monzoGridType === "helical")) {
      return {
        ...base,
        type: "cylinder" as const,
        description: monzoGridType === "toroidal"
          ? `Cylinder helix — chain of fifths wraps once per ${effectiveConfig.edo ?? "?"} steps`
          : "Cylinder helix — one turn per octave",
        bestGeometry: "cylinder" as const,
      };
    }
    return base;
  }, [effectiveConfig, monzoGridType]);
  const monzoInfo = useMemo(() => latticeInfo(monzoLattice), [monzoLattice]);

  // Resolve activeClassIds (EDO step numbers) to actual node keys
  // through the lattice's classMap.  Drives the same droneNodes set
  // as activeNodeKey/Keys, so the visual treatment is identical —
  // but the caller can highlight by EDO class instead of exact JI
  // ratio, which is what makes comma drift visible: a drifted chord
  // tone that lands on a non-canonical JI cell still resolves to
  // its EDO step and lights up that step's class rep.
  useEffect(() => {
    const liveActive = activeClassIds ?? new Set<number>();
    const pinnedClasses = new Set<number>();
    for (const overlay of pinnedChordOverlays ?? []) {
      for (const c of overlay.classes) pinnedClasses.add(c);
    }
    const driftedClasses = new Set<number>();
    for (const arc of compensationArcs ?? []) {
      driftedClasses.add(arc.fromClassId);
    }
    if (activeClassIds === undefined && pinnedClasses.size === 0 && driftedClasses.size === 0) return;
    if (liveActive.size === 0 && pinnedClasses.size === 0 && driftedClasses.size === 0) {
      setDroneNodes(new Set());
      return;
    }
    const keys = new Set<string>();
    for (const [key, classId] of monzoLattice.classMap) {
      if (liveActive.has(classId) || pinnedClasses.has(classId) || driftedClasses.has(classId)) keys.add(key);
    }
    setDroneNodes(keys);
  }, [activeClassIds, pinnedChordOverlays, compensationArcs, monzoLattice.classMap]);

  // Per-node colour override map.  Pinned-chord overlays paint their
  // class members in the overlay colour; drifted classes (the from-
  // ends of compensation arcs) paint RED so the user can see at a
  // glance which node had to be compensated for.  Drifted-red wins
  // over pinned colour because the compensation reading is the
  // important signal when a comma-pump occurred.
  const monzoNodeColorOverrides = useMemo(() => {
    const hasPins = (pinnedChordOverlays?.length ?? 0) > 0;
    const hasArcs = (compensationArcs?.length ?? 0) > 0;
    if (!hasPins && !hasArcs) return undefined;
    const map = new Map<string, string>();
    if (pinnedChordOverlays) {
      for (const overlay of pinnedChordOverlays) {
        for (const [key, classId] of monzoLattice.classMap) {
          if (!overlay.classes.has(classId)) continue;
          if (!map.has(key)) map.set(key, overlay.color);
        }
      }
    }
    if (compensationArcs) {
      const driftedClasses = new Set<number>();
      for (const arc of compensationArcs) driftedClasses.add(arc.fromClassId);
      for (const [key, classId] of monzoLattice.classMap) {
        if (driftedClasses.has(classId)) map.set(key, "#ff5555");
      }
    }
    return map.size > 0 ? map : undefined;
  }, [pinnedChordOverlays, compensationArcs, monzoLattice.classMap]);

  // Projection loss: ratio of variance lost when tempering collapses dimensions
  const projectionLoss = useMemo(() => {
    if (!monzoInfo.isTempered || monzoLattice.positions.size < 2) return null;
    // Compute total variance in JI positions vs tempered positions
    const ji: [number, number, number][] = [];
    const tp: [number, number, number][] = [];
    for (const [key] of monzoLattice.positions) {
      const j = monzoLattice.jiPositions.get(key);
      const t = monzoLattice.positions.get(key);
      if (j && t) { ji.push(j); tp.push(t); }
    }
    if (ji.length < 2) return null;
    const variance = (pts: [number, number, number][]) => {
      const n = pts.length;
      const cx = pts.reduce((s, p) => s + p[0], 0) / n;
      const cy = pts.reduce((s, p) => s + p[1], 0) / n;
      const cz = pts.reduce((s, p) => s + p[2], 0) / n;
      return pts.reduce((s, p) => s + (p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2, 0) / n;
    };
    const vJI = variance(ji);
    const vTP = variance(tp);
    if (vJI === 0) return null;
    return Math.max(0, Math.min(1, 1 - vTP / vJI));
  }, [monzoLattice, monzoInfo.isTempered]);

  // Generated scale: one pitch per equivalence class, sorted by cents.
  // Always includes prime 2 in the calculation so the TE projection has
  // a free dimension (the octave) even when commas fully span the
  // octave-equivalent axes.  Without this, rank-0 temperaments collapse
  // every pitch to 0 ¢.
  const generatedScale = useMemo(() => {
    const cfg = effectiveConfig;
    if (cfg.temperedCommas.length === 0) return null;

    // Full prime basis including 2 — needed so the projection matrix
    // always has at least one free generator (the octave).
    const fullPrimes = cfg.primes.includes(2) ? cfg.primes : [2, ...cfg.primes];

    // Filter commas to only those fully factorable in the prime basis.
    // e.g. 513/512 (involves prime 19) can't be expressed in [2,3,5,7]
    // — factorize silently drops the unfactorable remainder, creating a
    // bogus constraint that collapses distinct pitches to the same cents.
    const validCommas = cfg.temperedCommas.filter(c => {
      const exps = factorize(c.n, c.d, fullPrimes, false);
      // Reconstruct and compare — if remainder was dropped, it won't match
      let rn = 1, rd = 1;
      for (let i = 0; i < fullPrimes.length; i++) {
        if (exps[i] > 0) rn *= Math.pow(fullPrimes[i], exps[i]);
        else if (exps[i] < 0) rd *= Math.pow(fullPrimes[i], -exps[i]);
      }
      return Math.abs(rn / rd - c.n / c.d) < 1e-6;
    });
    if (validCommas.length === 0) return null;

    // Helper: compute tempered cents for a node using the full basis
    const nodeCents = (node: typeof monzoLattice.nodes[number]) => {
      const fullExps = factorize(node.monzo.n, node.monzo.d, fullPrimes, false);
      const c = temperedCents(fullExps, fullPrimes, validCommas, false, cfg.tuningMethod);
      return ((c % 1200) + 1200) % 1200;
    };

    // Build node lookup
    const nodeMap = new Map<string, typeof monzoLattice.nodes[number]>();
    for (const node of monzoLattice.nodes) nodeMap.set(node.key, node);

    if (monzoLattice.classMap.size > 0) {
      // Group nodes by class, pick simplest rep per class
      const classMembers = new Map<number, typeof monzoLattice.nodes[number][]>();
      for (const [key, classId] of monzoLattice.classMap) {
        const node = nodeMap.get(key);
        if (!node) continue;
        if (!classMembers.has(classId)) classMembers.set(classId, []);
        classMembers.get(classId)!.push(node);
      }

      const results: { cents: number; ratio: number; representatives: string[] }[] = [];
      for (const [, members] of classMembers) {
        let bestNode = members[0];
        let bestScore = Infinity;
        for (const m of members) {
          const score = m.monzo.n * m.monzo.d;
          if (score < bestScore) { bestScore = score; bestNode = m; }
        }
        const cents = nodeCents(bestNode);
        const reps = members
          .sort((a, b) => (a.monzo.n * a.monzo.d) - (b.monzo.n * b.monzo.d))
          .slice(0, 5)
          .map(m => m.key);
        results.push({ cents, ratio: Math.pow(2, cents / 1200), representatives: reps });
      }
      return results.sort((a, b) => a.cents - b.cents);
    }

    // Fallback: no classMap, group by rounded cents
    const seen = new Map<number, { cents: number; ratio: number; representatives: string[] }>();
    for (const node of monzoLattice.nodes) {
      const cents = nodeCents(node);
      const key = Math.round(cents * 1000);
      if (!seen.has(key)) {
        seen.set(key, { cents, ratio: Math.pow(2, cents / 1200), representatives: [node.key] });
      } else {
        const entry = seen.get(key)!;
        if (entry.representatives.length < 5) entry.representatives.push(node.key);
      }
    }
    return [...seen.values()].sort((a, b) => a.cents - b.cents);
  }, [monzoLattice, effectiveConfig]);

  const [showGeneratedScale, setShowGeneratedScale] = useState(false);

  // Note filter → matching node keys (for shortest-path display)
  // When tempering is active, compute the set of visible class-rep keys
  // (simplest ratio per equivalence class — same logic as MonzoScene)
  const temperedClassReps = useMemo((): Set<string> | null => {
    if (monzoLattice.classMap.size === 0) return null; // no tempering
    const members = new Map<number, string[]>();
    for (const [key, classId] of monzoLattice.classMap) {
      if (!members.has(classId)) members.set(classId, []);
      members.get(classId)!.push(key);
    }
    const reps = new Set<string>();
    for (const [, keys] of members) {
      if (keys.length < 2) continue;
      let bestKey = keys[0], bestScore = Infinity;
      for (const k of keys) {
        const parts = k.split("/");
        const n = parseInt(parts[0], 10), d = parts[1] ? parseInt(parts[1], 10) : 1;
        const score = n * d;
        if (score < bestScore) { bestScore = score; bestKey = k; }
      }
      reps.add(bestKey);
    }
    return reps.size > 0 ? reps : null;
  }, [monzoLattice.classMap]);

  // Note filter → matching node keys (for shortest-path display)
  // When tempering, only consider class-rep nodes (the visible ones)
  const noteFilterTargets = useMemo((): Set<string> | null => {
    const q = noteFilterInput.trim();
    if (!q) return null;
    const qNorm = q.toLowerCase().replace(/#/g, "♯").replace(/b/g, "♭");
    const useHeji = monzoLayers.heji;
    const isTempered = temperedClassReps !== null;
    const matches = new Set<string>();
    for (const n of monzoLattice.nodes) {
      // When tempering, skip hidden non-class-rep nodes
      if (isTempered && temperedClassReps!.size > 0
          && monzoLattice.classMap.has(n.key) && !temperedClassReps!.has(n.key)) continue;
      if (useHeji) {
        const heji = ratioToHEJILabel(n.monzo.n, n.monzo.d, latticeDroneRoot);
        const hejiLetter = heji.notation.letter.toLowerCase();
        const hejiText = heji.text.toLowerCase();
        if (hejiLetter === qNorm || hejiText.startsWith(qNorm)) {
          matches.add(n.key);
        }
      } else {
        const name = ratioToNoteName(n.monzo.n, n.monzo.d, latticeDroneRoot);
        const baseName = name.split(" ")[0].toLowerCase();
        if (baseName === qNorm || name.toLowerCase() === qNorm) {
          matches.add(n.key);
        }
      }
    }
    return matches.size > 0 ? matches : null;
  }, [noteFilterInput, monzoLattice, latticeDroneRoot, monzoLayers.heji, temperedClassReps]);

  const handleJumpToRatio = useCallback(() => {
    const match = jumpRatioInput.trim().match(/^(\d+)\s*[/:]\s*(\d+)$/);
    if (!match) return;
    const key = `${match[1]}/${match[2]}`;
    if (monzoLattice.nodes.some(n => n.key === key)) {
      setMonzoFocusKey(key);
      setJumpRatioInput("");
    }
  }, [jumpRatioInput, monzoLattice]);



  // Reset focus when lattice changes and focus node no longer exists
  useEffect(() => {
    if (monzoFocusKey && !monzoLattice.nodes.some(n => n.key === monzoFocusKey)) {
      setMonzoFocusKey(null);
    }
  }, [monzoLattice, monzoFocusKey]);

  // Filtered lattice for neighborhood/focus
  const filteredMonzoLattice = useMemo((): BuiltLattice => {
    let baseNodes = monzoLattice.nodes;

    // Custom ratios: show shortest connecting paths + optional neighborhoods
    if (customRatiosActive && customRatioMonzos && customRatioMonzos.size > 0) {
      // Build exponent vectors for each custom ratio from the built lattice
      const ratioExpsMap = new Map<string, number[]>();
      for (const [key] of customRatioMonzos) {
        const node = baseNodes.find(n => n.key === key);
        if (node) ratioExpsMap.set(key, node.monzo.exps);
      }

      if (ratioExpsMap.size > 0) {
        // Always compute MST shortest paths to connect all custom ratios
        const ratioKeys = [...ratioExpsMap.keys()];
        if (!ratioExpsMap.has("1/1")) {
          const rootNode = baseNodes.find(n => n.key === "1/1");
          if (rootNode) { ratioKeys.push("1/1"); ratioExpsMap.set("1/1", rootNode.monzo.exps); }
        }
        const pathExpsSet = new Set<string>();
        if (ratioKeys.length >= 2) {
          // Pairwise L1 distances → Kruskal's MST
          const mstEdges: { i: number; j: number }[] = [];
          const edgeList: { i: number; j: number; dist: number }[] = [];
          for (let i = 0; i < ratioKeys.length; i++) {
            for (let j = i + 1; j < ratioKeys.length; j++) {
              const a = ratioExpsMap.get(ratioKeys[i])!;
              const b = ratioExpsMap.get(ratioKeys[j])!;
              const dist = a.reduce((sum, e, k) => sum + Math.abs(e - (b[k] ?? 0)), 0);
              edgeList.push({ i, j, dist });
            }
          }
          edgeList.sort((a, b) => a.dist - b.dist);
          const parent = ratioKeys.map((_, i) => i);
          const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]));
          for (const e of edgeList) {
            const pi = find(e.i), pj = find(e.j);
            if (pi !== pj) { parent[pi] = pj; mstEdges.push(e); }
            if (mstEdges.length === ratioKeys.length - 1) break;
          }
          // Generate axis-aligned grid paths for each MST edge
          for (const e of mstEdges) {
            const from = ratioExpsMap.get(ratioKeys[e.i])!;
            const to = ratioExpsMap.get(ratioKeys[e.j])!;
            const cur = [...from];
            pathExpsSet.add(cur.join(","));
            for (let k = 0; k < cur.length; k++) {
              while (cur[k] !== to[k]) {
                cur[k] += cur[k] < to[k] ? 1 : -1;
                pathExpsSet.add([...cur].join(","));
              }
            }
          }
        }
        for (const exps of ratioExpsMap.values()) pathExpsSet.add(exps.join(","));

        // Filter: keep path nodes + optional L1 neighborhood around each ratio
        const nRadius = customRatioNeighbors ? customRatioNeighborRadius : 0;
        baseNodes = baseNodes.filter(n => {
          if (pathExpsSet.has(n.monzo.exps.join(","))) return true;
          if (nRadius > 0) {
            for (const [, centerExps] of ratioExpsMap) {
              const dist = n.monzo.exps.reduce(
                (sum, e, i) => sum + Math.abs(e - (centerExps[i] ?? 0)), 0
              );
              if (dist <= nRadius) return true;
            }
          }
          return false;
        });
      }
    }

    // Apply neighborhood filter (general, non-custom-ratios)
    if (!customRatiosActive && monzoNeighborRadius !== null) {
      const centerKey = monzoFocusKey ?? "1/1";
      const centerNode = baseNodes.find(n => n.key === centerKey);
      if (centerNode) {
        const centerExps = centerNode.monzo.exps;
        const radius = monzoNeighborRadius;
        baseNodes = baseNodes.filter(n => {
          const dist = n.monzo.exps.reduce((sum, e, i) => sum + Math.abs(e - (centerExps[i] ?? 0)), 0);
          return dist <= radius;
        });
      }
    }

    // Note name filter: hide all nodes except those on shortest paths to targets
    if (!customRatiosActive && noteFilterTargets && noteFilterTargets.size > 0) {
      // Build adjacency from current baseNodes
      const adjKeys = new Set(baseNodes.map(n => n.key));
      const adj = new Map<string, Array<{ neighbor: string }>>();
      for (const edge of monzoLattice.edges) {
        if (!adjKeys.has(edge.from) || !adjKeys.has(edge.to)) continue;
        if (!adj.has(edge.from)) adj.set(edge.from, []);
        if (!adj.has(edge.to)) adj.set(edge.to, []);
        adj.get(edge.from)!.push({ neighbor: edge.to });
        adj.get(edge.to)!.push({ neighbor: edge.from });
      }
      const origin = monzoFocusKey ?? "1/1";
      // BFS from origin to compute distances
      const dist = new Map<string, number>([[origin, 0]]);
      const queue = [origin];
      let qi = 0;
      while (qi < queue.length) {
        const curr = queue[qi++];
        const d = dist.get(curr)!;
        for (const { neighbor } of adj.get(curr) ?? []) {
          if (!dist.has(neighbor)) { dist.set(neighbor, d + 1); queue.push(neighbor); }
        }
      }
      // For each target, backward-trace all nodes on any shortest path
      const onPath = new Set<string>([origin]);
      for (const target of noteFilterTargets) {
        if (!dist.has(target)) continue;
        onPath.add(target);
        const targetDist = dist.get(target)!;
        const byDist = new Map<number, string[]>();
        for (const [k, d] of dist) {
          if (d <= targetDist) { if (!byDist.has(d)) byDist.set(d, []); byDist.get(d)!.push(k); }
        }
        for (let d = targetDist - 1; d >= 0; d--) {
          for (const node of byDist.get(d) ?? []) {
            for (const { neighbor } of adj.get(node) ?? []) {
              if (dist.get(neighbor) === d + 1 && onPath.has(neighbor)) { onPath.add(node); break; }
            }
          }
        }
      }
      baseNodes = baseNodes.filter(n => onPath.has(n.key));
    }

    if (baseNodes === monzoLattice.nodes) return monzoLattice;

    const visibleKeys = new Set(baseNodes.map(n => n.key));
    const visibleEdges = monzoLattice.edges.filter(e => visibleKeys.has(e.from) && visibleKeys.has(e.to));
    const visiblePositions = new Map<string, [number, number, number]>();
    for (const [k, v] of monzoLattice.positions) {
      if (visibleKeys.has(k)) visiblePositions.set(k, v);
    }

    return {
      ...monzoLattice,
      nodes: baseNodes,
      edges: visibleEdges,
      positions: visiblePositions,
    };
  }, [monzoLattice, monzoNeighborRadius, monzoFocusKey, latticeDroneRoot,
      customRatiosActive, customRatioMonzos, parsedCustomRatios, customRatioNeighbors, customRatioNeighborRadius,
      effectiveConfig, debouncedConfig, noteFilterTargets]);

  const handleMonzoPresetChange = useCallback((presetName: string) => {
    setMonzoPreset(presetName);
    if (PRESET_CONFIGS[presetName]) {
      setMonzoConfig(PRESET_CONFIGS[presetName]);
    }
  }, []);

  const toggleMonzoPrime = useCallback((prime: number) => {
    setMonzoConfig(prev => {
      const has = prev.primes.includes(prime);
      const newPrimes = has ? prev.primes.filter(p => p !== prime) : [...prev.primes, prime].sort((a, b) => a - b);
      const newBounds = { ...prev.bounds };
      if (!has) newBounds[prime] = [-1, 1];
      else delete newBounds[prime];
      return { ...prev, primes: newPrimes, bounds: newBounds };
    });
    setMonzoPreset("Custom");
  }, []);

  const setMonzoBound = useCallback((prime: number, side: "min" | "max", value: number) => {
    setMonzoConfig(prev => {
      const [oldMin, oldMax] = prev.bounds[prime] ?? [-1, 1];
      return {
        ...prev,
        bounds: { ...prev.bounds, [prime]: side === "min" ? [value, oldMax] : [oldMin, value] },
      };
    });
    setMonzoPreset("Custom");
  }, []);

  const ensureAudio = useCallback(async () => {
    if (!audioReady || !audioEngine.isReady()) { await audioEngine.init(); setAudioReady(true); }
    else audioEngine.resume();
  }, [audioReady]);

  // ── Tonnetz handlers (after ensureAudio) ─────────────────────────
  const handleTonnetzNodeClick = useCallback(async (node: TonnetzNode) => {
    await ensureAudio();
    const key = node.key;
    setDroneNodes(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else { next.add(key); }
      if (next.size === 0) {
        audioEngine.stopDrone();
      } else {
        const ratios = [...next].map(k => {
          const nd = tonnetzData.nodeMap.get(k);
          return nd ? nd.n / nd.d : 1;
        });
        audioEngine.startRatioDrone(ratios, 0.1, rootPcToFreq(latticeDroneRoot));
      }
      return next;
    });
  }, [ensureAudio, latticeDroneRoot, tonnetzData]);

  const handleTonnetzTriadClick = useCallback(async (triadKey: string) => {
    const deselecting = tonnetzSelectedTriad === triadKey;
    setTonnetzSelectedTriad(deselecting ? null : triadKey);
    await ensureAudio();
    const triad = tonnetzData.triads.find(t => t.key === triadKey);
    if (triad) {
      if (deselecting) {
        // Remove triad nodes from drone
        setDroneNodes(prev => {
          const next = new Set(prev);
          for (const k of triad.nodeKeys) next.delete(k);
          if (next.size === 0) audioEngine.stopDrone();
          else {
            const ratios = [...next].map(k => {
              const nd = tonnetzData.nodeMap.get(k);
              return nd ? nd.n / nd.d : 1;
            });
            audioEngine.startRatioDrone(ratios, 0.1, rootPcToFreq(latticeDroneRoot));
          }
          return next;
        });
      } else {
        // Add triad nodes to drone (merge with existing selections)
        setDroneNodes(prev => {
          const next = new Set(prev);
          for (const k of triad.nodeKeys) next.add(k);
          const ratios = [...next].map(k => {
            const nd = tonnetzData.nodeMap.get(k);
            return nd ? nd.n / nd.d : 1;
          });
          audioEngine.startRatioDrone(ratios, 0.1, rootPcToFreq(latticeDroneRoot));
          return next;
        });
      }
    }
  }, [ensureAudio, tonnetzData, latticeDroneRoot, tonnetzSelectedTriad]);

  const handleTonnetzPLRNavigate = useCallback(async (link: PLRLink) => {
    setTonnetzSelectedTriad(link.to);
    await ensureAudio();
    const sourceTriad = tonnetzData.triads.find(t => t.key === link.from);
    const targetTriad = tonnetzData.triads.find(t => t.key === link.to);
    if (targetTriad) {
      setDroneNodes(prev => {
        const next = new Set(prev);
        // Remove source triad nodes, then add target triad nodes (preserves other selections)
        if (sourceTriad) {
          for (const k of sourceTriad.nodeKeys) next.delete(k);
        }
        for (const k of targetTriad.nodeKeys) next.add(k);
        const ratios = [...next].map(k => {
          const nd = tonnetzData.nodeMap.get(k);
          return nd ? nd.n / nd.d : 1;
        });
        audioEngine.startRatioDrone(ratios, 0.1, rootPcToFreq(latticeDroneRoot));
        return next;
      });
    }
  }, [ensureAudio, latticeDroneRoot, tonnetzData]);

  const setTonnetzBound = useCallback((prime: number, side: "min" | "max", value: number) => {
    setTonnetzConfig(prev => {
      const [oldMin, oldMax] = prev.bounds[prime] ?? [-2, 2];
      return { ...prev, bounds: { ...prev.bounds, [prime]: side === "min" ? [value, oldMax] : [oldMin, value] } };
    });
    setTonnetzPreset("Custom");
  }, []);

  // ── EDO Tonnetz handlers ───────────────────────────────────────────
  const handleEdoTonnetzNodeClick = useCallback(async (node: EdoTonnetzNode) => {
    await ensureAudio();
    const key = node.key;
    setDroneNodes(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else { next.add(key); }
      if (next.size === 0) {
        audioEngine.stopDrone();
      } else {
        const edo = edoTonnetzData.config.edo;
        // Convert EDO pitch classes to absolute steps relative to C4 (abs=0)
        const absNotes = [...next].map(k => {
          const nd = edoTonnetzData.nodeMap.get(k);
          return nd ? nd.pc : 0;
        });
        audioEngine.startDrone(absNotes, edo, 0.1);
      }
      return next;
    });
  }, [ensureAudio, edoTonnetzData]);

  const handleEdoTonnetzTriadClick = useCallback(async (triadKey: string) => {
    const deselecting = edoTonnetzSelectedTriad === triadKey;
    setEdoTonnetzSelectedTriad(deselecting ? null : triadKey);
    await ensureAudio();
    const triad = edoTonnetzData.triads.find(t => t.key === triadKey);
    if (triad) {
      const edo = edoTonnetzData.config.edo;
      if (deselecting) {
        setDroneNodes(prev => {
          const next = new Set(prev);
          for (const k of triad.nodeKeys) next.delete(k);
          if (next.size === 0) audioEngine.stopDrone();
          else {
            const absNotes = [...next].map(k => {
              const nd = edoTonnetzData.nodeMap.get(k);
              return nd ? nd.pc : 0;
            });
            audioEngine.startDrone(absNotes, edo, 0.1);
          }
          return next;
        });
      } else {
        setDroneNodes(prev => {
          const next = new Set(prev);
          for (const k of triad.nodeKeys) next.add(k);
          const absNotes = [...next].map(k => {
            const nd = edoTonnetzData.nodeMap.get(k);
            return nd ? nd.pc : 0;
          });
          audioEngine.startDrone(absNotes, edo, 0.1);
          return next;
        });
      }
    }
  }, [ensureAudio, edoTonnetzData, edoTonnetzSelectedTriad]);

  const handleEdoTonnetzPLRNavigate = useCallback(async (link: EdoTonnetzPLR) => {
    setEdoTonnetzSelectedTriad(link.to);
    await ensureAudio();
    const sourceTriad = edoTonnetzData.triads.find(t => t.key === link.from);
    const targetTriad = edoTonnetzData.triads.find(t => t.key === link.to);
    if (targetTriad) {
      const edo = edoTonnetzData.config.edo;
      setDroneNodes(prev => {
        const next = new Set(prev);
        if (sourceTriad) {
          for (const k of sourceTriad.nodeKeys) next.delete(k);
        }
        for (const k of targetTriad.nodeKeys) next.add(k);
        const absNotes = [...next].map(k => {
          const nd = edoTonnetzData.nodeMap.get(k);
          return nd ? nd.pc : 0;
        });
        audioEngine.startDrone(absNotes, edo, 0.1);
        return next;
      });
    }
  }, [ensureAudio, edoTonnetzData]);

  // ── Detect which triads are fully selected (all nodes in droneNodes) ──
  const activeTriadKeys = useMemo((): Set<string> => {
    if (droneNodes.size < 3) return new Set();
    const active = new Set<string>();
    if (tonnetzSubMode === "ji") {
      for (const triad of tonnetzData.triads) {
        if (triad.nodeKeys.every(k => droneNodes.has(k))) active.add(triad.key);
      }
    } else {
      for (const triad of edoTonnetzData.triads) {
        if (triad.nodeKeys.every(k => droneNodes.has(k))) active.add(triad.key);
      }
    }
    return active;
  }, [droneNodes, tonnetzSubMode, tonnetzData, edoTonnetzData]);

  // Keep tonnetzSelectedTriad in sync with activeTriadKeys
  useEffect(() => {
    if (activeTriadKeys.size > 0) {
      // Pick the most recently added triad (last in iteration order)
      const keys = [...activeTriadKeys];
      setTonnetzSelectedTriad(keys[keys.length - 1]);
    } else if (droneNodes.size === 0) {
      setTonnetzSelectedTriad(null);
      setEdoTonnetzSelectedTriad(null);
    }
  }, [activeTriadKeys, droneNodes.size]);

  // ── Generalized chord moves (N-note voice leading) ─────────────────
  const chordMoves = useMemo((): ChordMove[] => {
    if (droneNodes.size < 2 || viewMode !== "lattice") return [];
    const keys = [...droneNodes];
    if (tonnetzSubMode === "ji") {
      return findJiChordMoves(keys, tonnetzData, latticeDroneRoot);
    } else {
      return findEdoChordMoves(keys, edoTonnetzData);
    }
  }, [droneNodes, viewMode, tonnetzSubMode, tonnetzData, edoTonnetzData, latticeDroneRoot]);

  const movesByDirection = useMemo(() => {
    const map = new Map<string, ChordMove[]>();
    for (const m of chordMoves) {
      const arr = map.get(m.direction) ?? [];
      arr.push(m);
      map.set(m.direction, arr);
    }
    return map;
  }, [chordMoves]);

  // ── Parallel chord moves (all voices shift together) ────────────────
  const parallelMoves = useMemo((): ParallelChordMove[] => {
    if (droneNodes.size < 4 || viewMode !== "lattice") return [];
    const keys = [...droneNodes];
    if (tonnetzSubMode === "ji") {
      return findJiParallelMoves(keys, tonnetzData, latticeDroneRoot);
    } else {
      return findEdoParallelMoves(keys, edoTonnetzData);
    }
  }, [droneNodes, viewMode, tonnetzSubMode, tonnetzData, edoTonnetzData, latticeDroneRoot]);

  const handleChordMoveNavigate = useCallback(async (move: ChordMove) => {
    await ensureAudio();
    const newKeys = new Set(move.resultKeys);
    setDroneNodes(newKeys);

    if (tonnetzSubMode === "ji") {
      const ratios = move.resultKeys.map(k => {
        const nd = tonnetzData.nodeMap.get(k);
        return nd ? nd.n / nd.d : 1;
      });
      audioEngine.startRatioDrone(ratios, 0.1, rootPcToFreq(latticeDroneRoot));
    } else {
      const edo = edoTonnetzData.config.edo;
      const absNotes = move.resultKeys.map(k => {
        const nd = edoTonnetzData.nodeMap.get(k);
        return nd ? nd.pc : 0;
      });
      audioEngine.startDrone(absNotes, edo, 0.1);
    }
  }, [ensureAudio, tonnetzSubMode, tonnetzData, edoTonnetzData, latticeDroneRoot]);

  const handleParallelMoveNavigate = useCallback(async (move: ParallelChordMove) => {
    await ensureAudio();
    const newKeys = new Set(move.resultKeys);
    setDroneNodes(newKeys);

    if (tonnetzSubMode === "ji") {
      const ratios = move.resultKeys.map(k => {
        const nd = tonnetzData.nodeMap.get(k);
        return nd ? nd.n / nd.d : 1;
      });
      audioEngine.startRatioDrone(ratios, 0.1, rootPcToFreq(latticeDroneRoot));
    } else {
      const edo = edoTonnetzData.config.edo;
      const absNotes = move.resultKeys.map(k => {
        const nd = edoTonnetzData.nodeMap.get(k);
        return nd ? nd.pc : 0;
      });
      audioEngine.startDrone(absNotes, edo, 0.1);
    }
  }, [ensureAudio, tonnetzSubMode, tonnetzData, edoTonnetzData, latticeDroneRoot]);

  // ── Keyboard shortcuts for PLR navigation ─────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (viewMode !== "lattice") return;
      // Ignore if typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toUpperCase();
      if (key !== "P" && key !== "L" && key !== "R") return;

      if (tonnetzSubMode === "ji" && tonnetzSelectedTriad) {
        const links = tonnetzData.plrByTriad.get(tonnetzSelectedTriad) ?? [];
        const match = links.find(l => l.name.toUpperCase() === key);
        if (match) { e.preventDefault(); handleTonnetzPLRNavigate(match); }
      } else if (tonnetzSubMode !== "ji" && edoTonnetzSelectedTriad) {
        const links = edoTonnetzData.plrByTriad.get(edoTonnetzSelectedTriad) ?? [];
        const match = links.find(l => l.name.toUpperCase() === key);
        if (match) { e.preventDefault(); handleEdoTonnetzPLRNavigate(match); }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewMode, tonnetzSubMode, tonnetzSelectedTriad, edoTonnetzSelectedTriad,
      tonnetzData, edoTonnetzData, handleTonnetzPLRNavigate, handleEdoTonnetzPLRNavigate]);

  // ── Persistent drone helpers ──────────────────────────────────────
  const buildLatticeDroneRatios = useCallback((mode: LatticeDroneMode): number[] => {
    // Base frequency ratio = 1.0 (root). Shifted by rootPcToFreq for actual Hz.
    if (mode === "Single")    return [1];
    if (mode === "Root+5th")  return [1, 3 / 2];
    if (mode === "Tanpura")   return [1, 3 / 2, 2]; // root, 5th, octave above
    return [];
  }, []);

  const startLatticeDrone = useCallback(async (mode: LatticeDroneMode, vol: number, rootPc: number, oct?: number) => {
    if (mode === "Off") { audioEngine.stopDrone(); setLatticeDroneOn(false); return; }
    await ensureAudio();
    const ratios = buildLatticeDroneRatios(mode);
    const baseFreq = rootPcToFreq(rootPc) * Math.pow(2, (oct ?? latticeDroneOctave) - 4);
    audioEngine.startRatioDrone(ratios, vol, baseFreq);
    setLatticeDroneOn(true);
  }, [ensureAudio, buildLatticeDroneRatios, latticeDroneOctave]);

  const stopLatticeDrone = useCallback(() => {
    audioEngine.stopDrone();
    setLatticeDroneOn(false);
  }, []);

  // Compute per-note gains: when autoRamp is on, each successive note gets louder
  const computePerNoteGains = useCallback((keys: string[], volMap: Record<string, number>): number[] => {
    return keys.map((k, i) => {
      if (volMap[k] !== undefined) return volMap[k];
      if (!nodeVolAutoRamp) return 1.0;
      return Math.min(1.0, nodeVolRampBase + i * nodeVolRampStep);
    });
  }, [nodeVolAutoRamp, nodeVolRampBase, nodeVolRampStep]);

  // Start node-click drone with per-note volumes
  const startNodeDrone = useCallback((ratios: number[], keys: string[], volMap: Record<string, number>) => {
    const perNote = computePerNoteGains(keys, volMap);
    audioEngine.startRatioDrone(ratios, nodeVolMaster, rootPcToFreq(latticeDroneRoot), perNote);
  }, [computePerNoteGains, nodeVolMaster, latticeDroneRoot]);

  // Restart drone when params change while it's on
  useEffect(() => {
    if (!latticeDroneOn || latticeDroneMode === "Off") return;
    const ratios = buildLatticeDroneRatios(latticeDroneMode);
    if (ratios.length === 0) return;
    const baseFreq = rootPcToFreq(latticeDroneRoot);
    audioEngine.startRatioDrone(ratios, latticeDroneVol, baseFreq);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latticeDroneMode, latticeDroneRoot]);

  // Update volume in real time
  useEffect(() => {
    if (latticeDroneOn) audioEngine.setDroneGain(latticeDroneVol);
  }, [latticeDroneVol, latticeDroneOn]);

  // Update node-click drone master volume in real time
  useEffect(() => {
    const hasNodeDrone = droneNodes.size > 0 || stackActiveNodes.size > 0;
    if (hasNodeDrone && !latticeDroneOn) audioEngine.setDroneGain(nodeVolMaster);
  }, [nodeVolMaster, droneNodes.size, stackActiveNodes.size, latticeDroneOn]);

  // Update individual note volumes in real time
  useEffect(() => {
    const activeKeys = [...droneNodes, ...stackActiveNodes];
    if (activeKeys.length === 0) return;
    const gains = computePerNoteGains(activeKeys, nodeVolMap);
    gains.forEach((g, i) => audioEngine.setDroneNoteGain(i, g));
  }, [nodeVolMap, droneNodes, stackActiveNodes, computePerNoteGains]);

  const toggleMonzoComma = useCallback((comma: CommaSpec) => {
    setMonzoConfig(prev => {
      const has = prev.temperedCommas.some(c => c.n === comma.n && c.d === comma.d);
      return {
        ...prev,
        temperedCommas: has
          ? prev.temperedCommas.filter(c => !(c.n === comma.n && c.d === comma.d))
          : [...prev.temperedCommas, comma],
      };
    });
    setMonzoPreset("Custom");
  }, []);

  const handleMonzoNodeClick = useCallback(async (node: LatticeNode) => {
    await ensureAudio();
    const key = node.key;
    setDroneNodes(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      if (next.size === 0) {
        audioEngine.stopDrone();
        setNodeVolMap({});
      } else {
        const keys = [...next];
        const cfg = effectiveConfig;
        const isTempered = cfg.temperedCommas.length > 0;
        const ratios = keys.map(k => {
          const nd = monzoLattice.nodes.find(n => n.key === k);
          if (!nd) return 1;
          // Use tempered pitch when commas are active so equivalent nodes
          // produce the same frequency — the audible result of tempering
          if (isTempered) {
            return temperedRatio(nd.monzo.exps, cfg.primes, cfg.temperedCommas, cfg.octaveEquivalence, cfg.tuningMethod);
          }
          return nd.monzo.n / nd.monzo.d;
        });
        startNodeDrone(ratios, keys, nodeVolMap);
      }
      return next;
    });
  }, [ensureAudio, monzoLattice, effectiveConfig, startNodeDrone, nodeVolMap]);

  const defaults = modeDefaults(viewMode);
  const [showGen, setShowGen] = useState<Record<number, boolean>>(defaults.gen);
  const [showOtonal, setShowOtonal] = useState(defaults.otonal);
  const [showUtonal, setShowUtonal] = useState(defaults.utonal);
  const [showComma, setShowComma] = useState(defaults.comma);
  const [showOctave, setShowOctave] = useState(defaults.octave);

  const switchMode = (mode: ViewMode) => {
    // Clear node-click drones, but keep persistent drone running
    setDroneNodes(new Set());
    setStackActiveNodes(new Set());
    setNodeVolMap({});
    if (latticeDroneOn && latticeDroneMode !== "Off") {
      // Restart persistent drone (node-click may have overridden it)
      const ratios = buildLatticeDroneRatios(latticeDroneMode);
      audioEngine.startRatioDrone(ratios, latticeDroneVol, rootPcToFreq(latticeDroneRoot));
    } else {
      audioEngine.stopDrone();
    }
    setViewMode(mode);
    const d = modeDefaults(mode);
    setShowGen(d.gen);
    setShowOtonal(d.otonal);
    setShowUtonal(d.utonal);
    setShowComma(d.comma);
    setShowOctave(d.octave);
  };

  // Build harmonic series data (memoized, deterministic positions)
  const harmonicData = useMemo(() => {
    const data = buildHarmonicSeries(maxHarmonic, harmonicLimit, octaveReduce, subharmonic);
    const positions = harmonicChainPositions(data.nodes);
    return { ...data, positions };
  }, [maxHarmonic, harmonicLimit, octaveReduce, subharmonic]);

  const isHarmonicMode = viewMode === "harmonic";
  const isOtonalMode = viewMode === "otonal";
  const isCommaMode = viewMode === "comma";
  const isChainMode = viewMode === "chain";
  const isMonzoMode = viewMode === "monzo";

  // Build comma cluster data (memoized, static)
  const commaData = useMemo(() => buildCommaClusterData(), []);
  const commaGroups = useMemo(() => buildCommaGroups(), []);

  // Build stack data for otonal/utonal mode
  const stackData = useMemo(() => {
    const bases = Array.from({ length: stackMultiple }, (_, i) => stackBase + i);
    return buildMultipleStacks(bases, stackCount, stackIsUtonal);
  }, [stackBase, stackCount, stackIsUtonal, stackMultiple]);

  const handleNodeClick = useCallback(async (node: HNode) => {
    await ensureAudio();
    const key = nodeKey(node);
    setDroneNodes(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else { next.add(key); }
      if (next.size === 0) {
        audioEngine.stopDrone();
        setNodeVolMap({});
      } else {
        const keys = [...next];
        const ratios = keys.map(k => {
          const nd = NODES.find(n => nodeKey(n) === k);
          return nd ? nd.n / nd.d : 1;
        });
        startNodeDrone(ratios, keys, nodeVolMap);
      }
      return next;
    });
  }, [ensureAudio, startNodeDrone, nodeVolMap]);

  const handleChainNodeClick = useCallback(async (hNode: HarmonicNode) => {
    await ensureAudio();
    const key = hNode.label;
    setDroneNodes(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else { next.add(key); }
      if (next.size === 0) {
        audioEngine.stopDrone();
        setNodeVolMap({});
      } else {
        const keys = [...next];
        const ratios: number[] = [];
        for (const k of keys) {
          const hn = harmonicData.nodes.find(n => n.label === k);
          if (hn) ratios.push(hn.n / hn.d); else ratios.push(1);
        }
        startNodeDrone(ratios, keys, nodeVolMap);
      }
      return next;
    });
  }, [ensureAudio, harmonicData.nodes, startNodeDrone, nodeVolMap]);

  // Toggle a node in a stack (otonal/utonal mode)
  const handleStackNodeClick = useCallback(async (node: StackNode) => {
    await ensureAudio();
    const key = node.label;
    setStackActiveNodes(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else { next.add(key); }
      if (next.size === 0) {
        audioEngine.stopDrone();
        setNodeVolMap({});
      } else {
        const keys = [...next];
        const ratios = keys.map(k => {
          const [n, d] = k.split("/").map(Number);
          return n / d;
        });
        startNodeDrone(ratios, keys, nodeVolMap);
      }
      return next;
    });
  }, [ensureAudio, startNodeDrone, nodeVolMap]);

  const clearDrone = useCallback(() => {
    setDroneNodes(new Set());
    setStackActiveNodes(new Set());
    setNodeVolMap({});
    setClearPinnedKey(k => k + 1);
    // If persistent drone is active, restart it; otherwise stop all
    if (latticeDroneOn && latticeDroneMode !== "Off") {
      const ratios = buildLatticeDroneRatios(latticeDroneMode);
      audioEngine.startRatioDrone(ratios, latticeDroneVol, rootPcToFreq(latticeDroneRoot));
    } else {
      audioEngine.stopDrone();
    }
  }, [latticeDroneOn, latticeDroneMode, latticeDroneVol, latticeDroneRoot, buildLatticeDroneRatios]);

  const toggleGen = (p: number) => setShowGen(prev => ({ ...prev, [p]: !prev[p] }));

  const activeNode = hoveredNode || (droneNodes.size > 0 ? [...droneNodes][droneNodes.size - 1] : null);
  // In comma mode, hoveredNode is a posKey like "0:5/4" — extract the original key
  const infoKey = isCommaMode && activeNode?.includes(":")
    ? activeNode.split(":").slice(1).join(":")
    : activeNode;
  const infoData = infoKey ? NODES.find(n => nodeKey(n) === infoKey) : null;
  const harmonicInfoNode = isHarmonicMode && infoKey
    ? harmonicData.nodes.find(n => n.label === infoKey)
    : null;

  // Stack header label e.g. "4:5:6:7"
  const stackLabel = useMemo(() => {
    if (!isOtonalMode) return "";
    const bases = Array.from({ length: stackMultiple }, (_, i) => stackBase + i);
    return bases.map(b => {
      const nums = Array.from({ length: stackCount }, (_, i) =>
        stackIsUtonal ? `1/${b + i}` : `${b + i}`
      );
      return nums.join(":");
    }).join("  |  ");
  }, [isOtonalMode, stackBase, stackCount, stackIsUtonal, stackMultiple]);

  const activeDroneCount = isOtonalMode ? stackActiveNodes.size : droneNodes.size;

  return (
    <div
      className={chromeless ? "w-full h-full flex flex-col" : "w-full py-2 px-4 flex flex-col"}
      style={chromeless ? undefined : { minHeight: "calc(100vh - 48px)" }}
    >
      {!chromeless && (
      <div className="flex-shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-sm font-semibold text-[#888] uppercase tracking-widest">
            {viewMode === "lattice"
              ? (tonnetzSubMode === "ji" ? "Tonnetz (JI)" : tonnetzSubMode === "31edo" ? "Tonnetz (31-EDO)" : "Tonnetz (53-EDO)")
              : isMonzoMode ? "Monzo Lattice"
              : isOtonalMode ? "Otonal / Utonal Stacks"
              : isCommaMode ? "Comma Relations"
              : isChainMode ? "Interval Chain"
              : "Harmonic Experience Graph"}
          </h2>
          <button onClick={() => setControlsCollapsed(c => !c)}
            className="px-1.5 py-0.5 rounded text-[10px] font-medium border border-[#333] text-[#555] hover:text-white hover:border-[#555] transition-colors"
            title={controlsCollapsed ? "Show controls" : "Hide controls"}>
            {controlsCollapsed ? "▼ Show" : "▲ Hide"}
          </button>
        </div>
        {((!controlsCollapsed && !isFullscreen) || (isFullscreen && fsControlsOpen)) && (() => {
          const inner = (
          <>
        <p className="text-xs text-[#444] mb-3">
          {viewMode === "lattice"
            ? (tonnetzSubMode === "ji"
              ? `${tonnetzInfoData.nodeCount} nodes · ${tonnetzInfoData.otonalCount} otonal · ${tonnetzInfoData.utonalCount} utonal · ${tonnetzData.plrLinks.length / 2} PLR links. Click faces to navigate.`
              : `${edoTonnetzInfoData.uniquePcs}/${edoTonnetzData.config.edo} pitch classes · ${edoTonnetzInfoData.nodeCount} grid nodes · ${edoTonnetzInfoData.majorCount} major · ${edoTonnetzInfoData.minorCount} minor triads. Click faces to navigate.`
            )
            : isMonzoMode
            ? `${monzoInfo.dimension}D · ${monzoInfo.nodeCount} nodes${monzoLattice.temperingClasses ? ` · ${monzoLattice.temperingClasses} classes` : ""} · ${monzoTopology.description}`
            : isOtonalMode
            ? "Click nodes to drone. Adjust base and count below."
            : isCommaMode
              ? "Pairs of nearby ratios grouped by comma type. Click nodes to drone."
              : isHarmonicMode
                ? "Scroll to zoom. Click nodes to drone — click again to remove."
                : isChainMode
                  ? `2D interval chain · ${monzoLattice.nodes.length} nodes. Configure primes & bounds above. Click nodes to drone.`
                  : "Drag to rotate. Scroll to zoom. Click nodes to drone — click again to remove."
          }
          {activeDroneCount > 0 && (
            <button onClick={clearDrone}
              className="ml-2 px-2 py-0.5 rounded text-[10px] border border-[#333] text-[#888] hover:text-white hover:border-[#555] transition-colors">
              Clear {activeDroneCount} note{activeDroneCount > 1 ? "s" : ""}
            </button>
          )}
        </p>

        {/* ── Tanpura / Drone strip ── */}
        <div className="flex flex-wrap gap-2 items-center mb-3 py-1.5 px-2 rounded bg-[#0c0c0c] border border-[#1a1a1a]">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold text-[#666] uppercase tracking-widest">Drone</span>
            {latticeDroneOn && <span className="w-2 h-2 rounded-full bg-[#7173e6] animate-pulse" />}
          </div>
          {/* Mode buttons */}
          {(["Off", "Single", "Root+5th", "Tanpura"] as LatticeDroneMode[]).map(m => (
            <button key={m}
              onClick={async () => {
                setLatticeDroneMode(m);
                if (m === "Off") { stopLatticeDrone(); }
                else { await startLatticeDrone(m, latticeDroneVol, latticeDroneRoot); }
              }}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                latticeDroneMode === m && (m === "Off" ? !latticeDroneOn : latticeDroneOn)
                  ? m === "Off"
                    ? "bg-[#1a1a1a] border-[#333] text-[#888]"
                    : "bg-[#7173e6] border-[#7173e6] text-white"
                  : "bg-[#111] border-[#222] text-[#444] hover:text-[#aaa] hover:border-[#444]"
              }`}>
              {m}
            </button>
          ))}
          <div className="w-px h-5 bg-[#222]" />
          {/* Root note selector */}
          <label className="text-[10px] text-[#555] flex items-center gap-1">
            Root
            <select
              value={latticeDroneRoot}
              onChange={async (e) => {
                const pc = Number(e.target.value);
                setLatticeDroneRoot(pc);
                if (latticeDroneOn && latticeDroneMode !== "Off") {
                  await ensureAudio();
                  const ratios = buildLatticeDroneRatios(latticeDroneMode);
                  audioEngine.startRatioDrone(ratios, latticeDroneVol, rootPcToFreq(pc));
                }
              }}
              className="bg-[#141414] border border-[#333] text-white text-xs rounded px-1.5 py-0.5"
            >
              {ROOT_NOTE_OPTIONS.map((name, i) => (
                <option key={i} value={i}>{name}</option>
              ))}
            </select>
          </label>
          <div className="w-px h-5 bg-[#222]" />
          {/* Octave selector */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-[#555]">Oct</span>
            {[2, 3, 4, 5, 6].map(o => (
              <button key={o}
                onClick={async () => {
                  setLatticeDroneOctave(o);
                  if (latticeDroneOn && latticeDroneMode !== "Off") {
                    await startLatticeDrone(latticeDroneMode, latticeDroneVol, latticeDroneRoot, o);
                  }
                }}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border ${
                  latticeDroneOctave === o
                    ? "bg-[#7173e6] text-white border-[#7173e6]"
                    : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                }`}>
                {o}
              </button>
            ))}
          </div>
          <div className="w-px h-5 bg-[#222]" />
          {/* Volume slider */}
          <label className="text-[10px] text-[#555] flex items-center gap-1">
            Vol
            <input type="range" min={0} max={0.3} step={0.005} value={latticeDroneVol}
              onChange={e => setLatticeDroneVol(Number(e.target.value))}
              className="w-16 accent-[#7173e6]" />
            <span className="text-[10px] text-[#444] w-6 text-right">{Math.round(latticeDroneVol * 100 / 0.3)}%</span>
          </label>
        </div>

        {/* ── Node Volume Controls ── */}
        {activeDroneCount > 0 && (
          <div className="flex flex-wrap gap-2 items-center mb-3 py-1.5 px-2 rounded bg-[#0c0c0c] border border-[#1a1a1a]">
            <span className="text-[10px] font-semibold text-[#666] uppercase tracking-widest">Node Vol</span>
            <label className="text-[10px] text-[#555] flex items-center gap-1">
              Master
              <input type="range" min={0} max={0.3} step={0.005} value={nodeVolMaster}
                onChange={e => setNodeVolMaster(Number(e.target.value))}
                className="w-16 accent-[#e67171]" />
              <span className="text-[10px] text-[#444] w-6 text-right">{Math.round(nodeVolMaster * 100 / 0.3)}%</span>
            </label>
            <div className="w-px h-5 bg-[#222]" />
            <button
              onClick={() => setNodeVolAutoRamp(!nodeVolAutoRamp)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors border ${
                nodeVolAutoRamp
                  ? "bg-[#e67171] border-[#e67171] text-white"
                  : "bg-[#111] border-[#222] text-[#444] hover:text-[#aaa]"
              }`}>
              Crescendo
            </button>
            <div className="w-px h-5 bg-[#222]" />
            {(isOtonalMode ? [...stackActiveNodes] : [...droneNodes]).map((key, i) => (
              <label key={key} className="text-[10px] text-[#555] flex items-center gap-1">
                <span className="max-w-[60px] truncate" title={key}>{key}</span>
                <input type="range" min={0} max={1} step={0.02}
                  value={nodeVolMap[key] ?? (nodeVolAutoRamp ? Math.min(1.0, nodeVolRampBase + i * nodeVolRampStep) : 1.0)}
                  onChange={e => setNodeVolMap(prev => ({ ...prev, [key]: Number(e.target.value) }))}
                  className="w-12 accent-[#e6a871]" />
                <span className="text-[10px] text-[#444] w-6 text-right">
                  {Math.round((nodeVolMap[key] ?? (nodeVolAutoRamp ? Math.min(1.0, nodeVolRampBase + i * nodeVolRampStep) : 1.0)) * 100)}%
                </span>
              </label>
            ))}
          </div>
        )}

        {/* Mode tabs */}
        <div className="flex gap-1 flex-wrap mb-3">
          {(Object.keys(MODE_LABELS) as ViewMode[]).filter(m =>
            (m !== "chain" || betaIntervalChain) && (m !== "comma" || betaComma)
            && m !== "harmonic" && m !== "otonal"
          ).map(m => (
            <button key={m} onClick={() => switchMode(m)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                viewMode === m
                  ? "bg-[#7173e6] text-white"
                  : "bg-[#141414] text-[#555] hover:text-[#aaa] hover:bg-[#1a1a1a] border border-[#222]"
              }`}>
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>

        {/* Harmonic Series controls (only in harmonic mode) */}
        {isHarmonicMode && (
          <div className="flex flex-wrap gap-1.5 mb-3 items-center">
            <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Limit</span>
            {LIMIT_OPTIONS.map(l => (
              <button key={l} onClick={() => setHarmonicLimit(l)}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                  harmonicLimit === l
                    ? "bg-[#7173e6] text-white border-[#7173e6]"
                    : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                }`}>
                {l === 0 ? "All" : l}
              </button>
            ))}
            <div className="w-px h-5 bg-[#222]" />
            <button onClick={() => setSubharmonic(!subharmonic)}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                subharmonic
                  ? "bg-[#1a1a1a] text-[#ccc] border-[#7173e6]"
                  : "bg-[#111] text-[#444] border-[#222]"
              }`}>
              Subharmonic
            </button>
            <button onClick={() => setOctaveReduce(!octaveReduce)}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                octaveReduce
                  ? "bg-[#1a1a1a] text-[#ccc] border-[#e87010]"
                  : "bg-[#111] text-[#444] border-[#222]"
              }`}>
              Octave Reduce
            </button>
            <div className="w-px h-5 bg-[#222]" />
            <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Max</span>
            <input
              type="range" min={4} max={32} value={maxHarmonic}
              onChange={e => setMaxHarmonic(Number(e.target.value))}
              className="w-20 accent-[#7173e6]"
            />
            <span className="text-xs text-[#666] font-mono">{maxHarmonic}</span>
            <div className="w-px h-5 bg-[#222]" />
            <button onClick={() => setShowIntervals(!showIntervals)}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                showIntervals
                  ? "bg-[#1a1a1a] text-[#ccc] border-[#e87010]"
                  : "bg-[#111] text-[#444] border-[#222]"
              }`}>
              Intervals
            </button>
          </div>
        )}

        {/* Otonal/Utonal stack controls */}
        {isOtonalMode && (
          <div className="flex flex-wrap gap-2 mb-3 items-center">
            {/* Otonal / Utonal toggle */}
            <div className="flex rounded overflow-hidden border border-[#333]">
              <button
                onClick={() => setStackIsUtonal(false)}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  !stackIsUtonal ? "bg-[#7173e6] text-white" : "bg-[#141414] text-[#555] hover:text-[#aaa]"
                }`}>
                Otonal
              </button>
              <button
                onClick={() => setStackIsUtonal(true)}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  stackIsUtonal ? "bg-[#7173e6] text-white" : "bg-[#141414] text-[#555] hover:text-[#aaa]"
                }`}>
                Utonal
              </button>
            </div>
            <div className="w-px h-5 bg-[#222]" />
            <label className="text-xs text-[#666] flex items-center gap-1">
              Base
              <select
                value={stackBase}
                onChange={e => setStackBase(Number(e.target.value))}
                className="bg-[#141414] border border-[#333] text-white text-xs rounded px-2 py-1"
              >
                {Array.from({ length: 13 }, (_, i) => i + 2).map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[#666] flex items-center gap-1">
              Count
              <select
                value={stackCount}
                onChange={e => setStackCount(Number(e.target.value))}
                className="bg-[#141414] border border-[#333] text-white text-xs rounded px-2 py-1"
              >
                {[3, 4, 5, 6, 7, 8].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[#666] flex items-center gap-1">
              Stacks
              <select
                value={stackMultiple}
                onChange={e => setStackMultiple(Number(e.target.value))}
                className="bg-[#141414] border border-[#333] text-white text-xs rounded px-2 py-1"
              >
                {[1, 2, 3, 4, 5].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <div className="w-px h-5 bg-[#222]" />
            <span className="text-xs text-[#555] font-mono">{stackLabel}</span>
          </div>
        )}

        {/* Comma mode controls */}
        {isCommaMode && (
          <div className="flex flex-wrap gap-1.5 mb-3 items-center">
            <button onClick={() => setCommaShowFromUnison(!commaShowFromUnison)}
              className={`px-2 py-1 rounded text-xs font-medium border transition-colors ${
                commaShowFromUnison
                  ? "bg-[#1a1a1a] text-[#ccc] border-[#ff5555]"
                  : "bg-[#111] text-[#444] border-[#222]"
              }`}>
              From 1/1
            </button>
          </div>
        )}

        {/* Monzo Lattice / Interval Chain controls */}
        {(isMonzoMode || isChainMode) && (
          <div className="flex flex-col gap-2 mb-3">
            {/* Preset selector */}
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Preset</span>
              {Object.keys(PRESET_CONFIGS).map(name => (
                <button key={name} onClick={() => handleMonzoPresetChange(name)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                    monzoPreset === name
                      ? "bg-[#7173e6] text-white border-[#7173e6]"
                      : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                  }`}>
                  {name}
                </button>
              ))}
            </div>
            {/* Grid type toggle */}
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Grid</span>
              {(["helical", "square", "triangle"] as const).map(gt => (
                <button key={gt} onClick={() => setMonzoGridType(gt)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                    monzoGridType === gt
                      ? "bg-[#7173e6] text-white border-[#7173e6]"
                      : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                  }`}>
                  {gt === "square" ? "Square (90\u00B0)" : gt === "triangle" ? "Triangle (60\u00B0)" : "Helical (Tonescape)"}
                </button>
              ))}
            </div>
            {/* Octave equivalence toggle */}
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Octave Eq</span>
              <button
                onClick={() => {
                  setMonzoConfig(prev => ({ ...prev, octaveEquivalence: !prev.octaveEquivalence }));
                  setMonzoPreset("Custom");
                }}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                  monzoConfig.octaveEquivalence
                    ? "bg-[#7173e6] text-white border-[#7173e6]"
                    : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                }`}>
                {monzoConfig.octaveEquivalence ? "ON" : "OFF"}
              </button>
              <span className="text-[9px] text-[#444]">
                {monzoConfig.octaveEquivalence ? "ratios folded into [1, 2)" : "prime 2 axis active"}
              </span>
            </div>
            {/* Prime axes */}
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Primes</span>
              {ALL_PRIMES.map(p => (
                <button key={p} onClick={() => toggleMonzoPrime(p)}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors border ${
                    monzoConfig.primes.includes(p)
                      ? "bg-[#1a1a1a] text-white"
                      : "bg-[#111] text-[#444] border-[#222]"
                  }`}
                  style={monzoConfig.primes.includes(p) ? { borderColor: MONZO_PRIME_COLORS[p], color: MONZO_PRIME_COLORS[p] } : undefined}>
                  {p}
                </button>
              ))}
            </div>
            {/* Per-axis bounds */}
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Bounds</span>
              {monzoConfig.primes.map(p => {
                const [lo, hi] = monzoConfig.bounds[p] ?? [-1, 1];
                return (
                  <div key={p} className="flex items-center gap-0.5 text-xs">
                    <span style={{ color: MONZO_PRIME_COLORS[p] }} className="font-mono font-bold">{p}:</span>
                    <input type="number" value={lo} min={-10} max={0}
                      onChange={e => setMonzoBound(p, "min", Number(e.target.value))}
                      className="w-10 bg-[#141414] border border-[#333] text-white text-xs rounded px-1 py-0.5 text-center" />
                    <span className="text-[#444]">to</span>
                    <input type="number" value={hi} min={0} max={10}
                      onChange={e => setMonzoBound(p, "max", Number(e.target.value))}
                      className="w-10 bg-[#141414] border border-[#333] text-white text-xs rounded px-1 py-0.5 text-center" />
                  </div>
                );
              })}
            </div>
            {/* Tempering commas (monzo only) */}
            {isMonzoMode && (<>
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Temper</span>
              {KNOWN_COMMAS.map(c => {
                const active = monzoConfig.temperedCommas.some(tc => tc.n === c.n && tc.d === c.d);
                return (
                  <button key={`${c.n}/${c.d}`} onClick={() => toggleMonzoComma(c)}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                      active
                        ? "bg-[#2a1a1a] text-[#ff6666] border-[#ff4444]"
                        : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                    }`}>
                    {c.n}/{c.d}
                    <span className="ml-1 text-[9px] opacity-60">{c.name}</span>
                  </button>
                );
              })}
              <div className="w-px h-5 bg-[#222]" />
              <input
                type="text"
                placeholder="n/d"
                value={customCommaInput}
                onChange={e => setCustomCommaInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") addCustomComma(); }}
                className="w-16 bg-[#141414] border border-[#333] text-white text-xs font-mono rounded px-1.5 py-1 text-center focus:outline-none focus:border-[#ff4444] placeholder:text-[#333]"
              />
              <button onClick={addCustomComma}
                className="px-2 py-1 rounded text-xs font-medium transition-colors border bg-[#111] text-[#444] border-[#222] hover:text-[#ff6666] hover:border-[#ff4444]">
                + Temper
              </button>
              {/* Show custom (non-preset) commas with remove button */}
              {monzoConfig.temperedCommas
                .filter(tc => !KNOWN_COMMAS.some(kc => kc.n === tc.n && kc.d === tc.d))
                .map(tc => (
                  <button key={`custom-${tc.n}/${tc.d}`}
                    onClick={() => toggleMonzoComma(tc)}
                    className="px-2 py-1 rounded text-xs font-medium transition-colors border bg-[#2a1a1a] text-[#ff6666] border-[#ff4444]">
                    {tc.n}/{tc.d} ×
                  </button>
                ))}
            </div>
            {/* Tuning method selector — only shown when commas are active */}
            {monzoConfig.temperedCommas.length > 0 && (
              <div className="flex flex-wrap gap-1.5 items-start">
                <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1 pt-1">Tuning</span>
                <div className="flex gap-1 flex-wrap">
                  {([
                    ["TE", "TE", "Tenney-Euclidean — min RMS cents error (octave may stretch)"],
                    ["POTE", "POTE", "Pure-Octave TE — same as TE but octave pinned to 1200¢"],
                    ["TOP", "TOP", "Tenney Optimal — min worst-case relative error (octave may stretch)"],
                    ["CTE", "CTE", "Constrained TE — eigenmonzos stay pure, octave pinned"],
                    ["Euclidean", "Euc", "Unweighted — all primes treated equally (exponent-space error)"],
                  ] as [TuningMethod, string, string][]).map(([method, label, tooltip]) => {
                    const active = (monzoConfig.tuningMethod ?? "TE") === method;
                    return (
                      <button key={method} title={tooltip}
                        onClick={() => setMonzoConfig(prev => ({ ...prev, tuningMethod: method }))}
                        className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                          active
                            ? "bg-[#1a1a2e] text-[#9395ea] border-[#9395ea]"
                            : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                        }`}>
                        {label}
                      </button>
                    );
                  })}
                </div>
                <span className="text-[9px] text-[#333] pt-1">
                  {(monzoConfig.tuningMethod ?? "TE") === "TE" && "min RMS cents error · octave may stretch"}
                  {monzoConfig.tuningMethod === "POTE" && "min RMS cents · octave = 1200¢"}
                  {monzoConfig.tuningMethod === "TOP" && "min worst-case error · octave may stretch"}
                  {monzoConfig.tuningMethod === "CTE" && "eigenmonzos pure · octave = 1200¢"}
                  {monzoConfig.tuningMethod === "Euclidean" && "unweighted · min exponent error"}
                </span>
                <div className="w-px h-4 bg-[#222]" />
              </div>
            )}
            {/* Generated Scale — shows unique tempered pitches when commas active */}
            {generatedScale && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowGeneratedScale(v => !v)}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                      showGeneratedScale
                        ? "bg-[#1a2a1a] text-[#7aaa7a] border-[#3a6a3a]"
                        : "bg-[#111] text-[#444] border-[#222] hover:text-[#7aaa7a]"
                    }`}>
                    Generated Scale ({generatedScale.length} pitches)
                  </button>
                  {showGeneratedScale && (
                    <button onClick={async () => {
                      await ensureAudio();
                      const ratios = generatedScale.map(p => p.ratio);
                      const frames = [...ratios, ratios[0] * 2].map(r => [r]);
                      audioEngine.playRatioSequence(frames, 300, 0.6, 0.7);
                    }}
                      className="px-2 py-1 rounded text-xs font-medium transition-colors border bg-[#111] text-[#444] border-[#222] hover:text-[#7aaa7a] hover:border-[#3a6a3a]">
                      Play Scale
                    </button>
                  )}
                </div>
                {showGeneratedScale && (
                  <div className="bg-[#0a0a0a] border border-[#1e1e1e] rounded p-2 max-h-48 overflow-y-auto">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="text-[#555] text-[10px]">
                          <th className="text-left px-1 pb-1">#</th>
                          <th className="text-right px-1 pb-1">Cents</th>
                          <th className="text-right px-1 pb-1">Ratio</th>
                          <th className="text-left px-1 pb-1">Representatives</th>
                        </tr>
                      </thead>
                      <tbody>
                        {generatedScale.map((p, i) => (
                          <tr key={i} className="hover:bg-[#1a1a1a] cursor-pointer" onClick={async () => {
                            await ensureAudio();
                            audioEngine.playRatioNote(p.ratio, 0.8, 0.7);
                          }}>
                            <td className="text-[#555] px-1 py-0.5">{i}</td>
                            <td className="text-[#7aaa7a] text-right px-1 py-0.5">{p.cents.toFixed(1)}</td>
                            <td className="text-[#aaa] text-right px-1 py-0.5">{p.ratio.toFixed(4)}</td>
                            <td className="text-[#666] px-1 py-0.5 truncate max-w-[200px]">{p.representatives.join(", ")}{p.representatives.length >= 5 ? " …" : ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
            {/* Display options */}
            <div className="flex flex-wrap gap-1.5 items-center">
              {monzoTopology.type !== "plane" && (
                <button onClick={() => setMonzoShowTopo(!monzoShowTopo)}
                  className={`px-2 py-1 rounded text-xs font-medium border transition-colors ${
                    monzoShowTopo
                      ? "bg-[#1a1a2a] text-[#8888ff] border-[#6666cc]"
                      : "bg-[#111] text-[#444] border-[#222]"
                  }`}>
                  {monzoTopology.type === "torus" ? "🍩 Torus" : monzoTopology.type === "cylinder" ? "⊙ Cylinder" : "Topology"}
                </button>
              )}
              <span className="text-[10px] text-[#444] ml-2">
                {monzoInfo.isTempered && `Rank ${monzoTopology.rank} · ${monzoTopology.commasTempered} comma${monzoTopology.commasTempered > 1 ? "s" : ""}`}
                {projectionLoss !== null && (
                  <span className="ml-2" title="Fraction of harmonic information lost by tempering (variance reduction in 3D position space)">
                    · Loss {(projectionLoss * 100).toFixed(1)}%
                  </span>
                )}
              </span>
            </div>
            {/* Layers */}
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Layers</span>
              {(["nodes", "primeEdges", "temperedEdges", "noteNames", "intervals", "ratios", "monzo", "heji", "classes"] as const).map(lk => {
                const labels: Record<string, string> = { nodes: "Nodes", primeEdges: "Edges", temperedEdges: "Tempered", noteNames: "12TET", intervals: "Intervals", ratios: "Ratios", monzo: "Monzo", heji: "HEJI", classes: "Classes" };
                const classCount = monzoLattice.temperingClasses;
                const isClassBtn = lk === "classes";
                return (
                  <button key={lk} onClick={() => toggleMonzoLayer(lk)}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                      monzoLayers[lk]
                        ? isClassBtn && classCount ? "bg-[#2a1a2a] text-[#e060e0] border-[#e060e0]" : "bg-[#1a1a1a] text-[#ccc] border-[#555]"
                        : isClassBtn && !classCount ? "bg-[#111] text-[#333] border-[#1a1a1a] cursor-default" : "bg-[#111] text-[#444] border-[#222]"
                    }`}
                    disabled={isClassBtn && !classCount}>
                    {labels[lk]}{isClassBtn && classCount ? ` (${classCount})` : ""}
                  </button>
                );
              })}
              <div className="w-px h-4 bg-[#222]" />
              <button onClick={() => setMonzoPathMode(!monzoPathMode)}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                  monzoPathMode
                    ? "bg-[#7173e6] text-white border-[#7173e6]"
                    : "bg-[#111] text-[#444] border-[#222]"
                }`}>
                Path Mode
              </button>
              {monzoPathMode && (
                <span className="text-[10px] text-[#888]">Hover to see paths · Ctrl+click to pin</span>
              )}
            </div>
            {/* Neighborhood / Focus */}
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Neighborhood</span>
              <button onClick={() => setMonzoNeighborRadius(monzoNeighborRadius === null ? 2 : null)}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                  monzoNeighborRadius !== null
                    ? "bg-[#1a2a1a] text-[#66cc66] border-[#448844]"
                    : "bg-[#111] text-[#444] border-[#222]"
                }`}>
                {monzoNeighborRadius !== null ? "On" : "Off"}
              </button>
              {monzoNeighborRadius !== null && (
                <>
                  <span className="text-[10px] text-[#555]">r=</span>
                  {[1, 2, 3, 4, 5, 6].map(r => (
                    <button key={r} onClick={() => setMonzoNeighborRadius(r)}
                      className={`w-6 h-6 rounded text-xs font-mono font-medium transition-colors border ${
                        monzoNeighborRadius === r
                          ? "bg-[#1a2a1a] text-[#66cc66] border-[#448844]"
                          : "bg-[#111] text-[#444] border-[#222]"
                      }`}>
                      {r}
                    </button>
                  ))}
                </>
              )}
            </div>
            {/* Custom Ratios filter */}
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Custom Ratios</span>
                {customRatiosActive && (
                  <button onClick={() => setCustomRatiosInput("")}
                    className="px-2 py-1 rounded text-xs font-medium transition-colors border bg-[#1a1a2a] text-[#66aaff] border-[#4488cc] hover:text-white">
                    Clear
                  </button>
                )}
                {customRatiosActive && parsedCustomRatios.size > 0 && (
                  <span className="text-[10px] text-[#555]">
                    {parsedCustomRatios.size} ratio{parsedCustomRatios.size !== 1 ? "s" : ""} matched
                    {(() => {
                      const missing = [...parsedCustomRatios].filter(k => !monzoLattice.nodes.some(n => n.key === k));
                      return missing.length > 0
                        ? ` · ${missing.length} not in lattice: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`
                        : "";
                    })()}
                  </span>
                )}
              </div>
              <>
                  <textarea
                    value={customRatiosInput}
                    onChange={e => setCustomRatiosInput(e.target.value)}
                    placeholder="Paste ratios: 3/2, 5/4, 7/4, 9/8 …"
                    rows={Math.max(2, customRatiosInput.split("\n").length)}
                    className="w-full bg-[#141414] border border-[#333] text-white text-xs font-mono rounded px-2 py-1.5 focus:outline-none focus:border-[#4488cc] placeholder:text-[#333] resize-y"
                  />
                  {/* Preset save */}
                  <div className="flex gap-1 items-center">
                    <input
                      type="text"
                      value={ratioPresetName}
                      onChange={e => setRatioPresetName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") saveRatioPreset(); }}
                      placeholder="Preset name"
                      className="flex-1 bg-[#141414] border border-[#333] text-white text-xs rounded px-1.5 py-1 focus:outline-none focus:border-[#4488cc] placeholder:text-[#333]"
                    />
                    <button onClick={saveRatioPreset}
                      className="px-2 py-1 rounded text-xs font-medium transition-colors border bg-[#111] text-[#444] border-[#222] hover:text-[#66aaff] hover:border-[#4488cc]">
                      Save
                    </button>
                  </div>
                  {/* Saved presets */}
                  {Object.keys(customRatioPresets).length > 0 && (
                    <div className="flex flex-wrap gap-1 items-center">
                      <span className="text-[10px] text-[#555]">Presets:</span>
                      {Object.keys(customRatioPresets).map(name => (
                        <div key={name} className="flex items-center gap-0">
                          <button onClick={() => loadRatioPreset(name)}
                            className={`px-2 py-0.5 rounded-l text-xs font-medium transition-colors border border-r-0 ${
                              customRatiosInput === customRatioPresets[name]
                                ? "bg-[#1a1a2a] text-[#66aaff] border-[#4488cc]"
                                : "bg-[#111] text-[#666] border-[#222] hover:text-[#66aaff]"
                            }`}>
                            {name}
                          </button>
                          <button onClick={() => deleteRatioPreset(name)}
                            className="px-1 py-0.5 rounded-r text-[10px] font-medium transition-colors border bg-[#111] text-[#444] border-[#222] hover:text-[#ff6666] hover:border-[#ff4444]"
                            title={`Delete "${name}"`}>
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
            </div>
            {/* Neighbors of Custom Ratios */}
            {customRatiosActive && (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap gap-1.5 items-center">
                  <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Neighbors of Custom Ratios</span>
                  <button onClick={() => setCustomRatioNeighbors(v => !v)}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                      customRatioNeighbors
                        ? "bg-[#1a2a1a] text-[#66cc66] border-[#448844]"
                        : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                    }`}>
                    {customRatioNeighbors ? "On" : "Off"}
                  </button>
                  {customRatioNeighbors && (
                    <>
                      <span className="text-[10px] text-[#555]">r=</span>
                      {[1, 2, 3, 4, 5, 6].map(r => (
                        <button key={r} onClick={() => setCustomRatioNeighborRadius(r)}
                          className={`w-6 h-6 rounded text-xs font-mono font-medium transition-colors border ${
                            customRatioNeighborRadius === r
                              ? "bg-[#1a2a1a] text-[#66cc66] border-[#448844]"
                              : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                          }`}>
                          {r}
                        </button>
                      ))}
                    </>
                  )}
                </div>
                {customRatioNeighbors && (
                  <div className="flex flex-wrap gap-1.5 items-center text-[10px] text-[#444]">
                    Showing L1 neighbors within radius {customRatioNeighborRadius} of {parsedCustomRatios.size} custom ratio{parsedCustomRatios.size !== 1 ? "s" : ""}
                  </div>
                )}
              </div>
            )}
            </>)}
          </div>
        )}

        {/* Tonnetz controls (only in lattice/tonnetz mode) */}
        {viewMode === "lattice" && (
          <div className="flex flex-col gap-2 mb-3">
            {/* Sub-mode selector: JI / 31-EDO / 53-EDO */}
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Tuning</span>
              {([["ji", "Just Intonation"], ["31edo", "31-EDO"], ["53edo", "53-EDO"]] as const).map(([mode, label]) => (
                <button key={mode} onClick={() => handleTonnetzSubModeChange(mode as any)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                    tonnetzSubMode === mode
                      ? "bg-[#7173e6] text-white border-[#7173e6]"
                      : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                  }`}>
                  {label}
                </button>
              ))}
            </div>

            {/* JI-specific controls */}
            {tonnetzSubMode === "ji" && (<>
              {/* Preset + Limit */}
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Preset</span>
                {Object.keys(TONNETZ_PRESETS).map(name => (
                  <button key={name} onClick={() => handleTonnetzPresetChange(name)}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                      tonnetzPreset === name
                        ? "bg-[#7173e6] text-white border-[#7173e6]"
                        : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                    }`}>
                    {name}
                  </button>
                ))}
              </div>
              {/* Edge toggles per prime */}
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Edges</span>
                {(LIMIT_PRIMES[tonnetzConfig.limit] ?? []).map(p => (
                  <button key={p} onClick={() => setTonnetzShowEdges(prev => ({ ...prev, [p]: !prev[p] }))}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors border ${
                      tonnetzShowEdges[p]
                        ? "bg-[#1a1a1a] text-white"
                        : "bg-[#111] text-[#444] border-[#222]"
                    }`}
                    style={tonnetzShowEdges[p] ? { borderColor: TONNETZ_PRIME_COLORS[p], color: TONNETZ_PRIME_COLORS[p] } : undefined}
                  >
                    <span className="w-3 h-0.5 rounded-full inline-block"
                      style={{ backgroundColor: TONNETZ_PRIME_COLORS[p] }} />
                    ×{p}
                  </button>
                ))}
                <div className="w-px h-5 bg-[#222]" />
                <button onClick={() => setTonnetzShowOtonal(!tonnetzShowOtonal)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                    tonnetzShowOtonal
                      ? "bg-[#1a1a2a] text-[#6699ff] border-[#4488ff]"
                      : "bg-[#111] text-[#444] border-[#222]"
                  }`}>
                  Otonal
                </button>
                <button onClick={() => setTonnetzShowUtonal(!tonnetzShowUtonal)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                    tonnetzShowUtonal
                      ? "bg-[#2a1a1a] text-[#ff8866] border-[#ff6644]"
                      : "bg-[#111] text-[#444] border-[#222]"
                  }`}>
                  Utonal
                </button>
                <div className="w-px h-5 bg-[#222]" />
                <button onClick={() => setTonnetzShowPLR(!tonnetzShowPLR)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                    tonnetzShowPLR
                      ? "bg-[#2a2a1a] text-[#ffdd44] border-[#ddbb33]"
                      : "bg-[#111] text-[#444] border-[#222]"
                  }`}>
                  PLR
                </button>
                <div className="w-px h-5 bg-[#222]" />
                <ToggleBtn on={tonnetzShowNotes} set={setTonnetzShowNotes} onColor="#4ac" label="Notes" />
                <ToggleBtn on={tonnetzShowRatios} set={setTonnetzShowRatios} onColor="#e8c76a" label="Ratios" />
                <ToggleBtn on={tonnetzShowCents} set={setTonnetzShowCents} onColor="#888" label="Cents" />
              </div>
              {/* Bounds per prime */}
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Bounds</span>
                {[2, ...(LIMIT_PRIMES[tonnetzConfig.limit] ?? [])].map(p => {
                  const [bMin, bMax] = tonnetzConfig.bounds[p] ?? [-2, 2];
                  const color = TONNETZ_PRIME_COLORS[p] ?? "#888";
                  return (
                    <div key={p} className="flex items-center gap-1.5 text-[11px] rounded" style={{ border: `1px solid ${color}60`, padding: "3px 8px", backgroundColor: "#0d0d0d" }}>
                      <span className="font-bold" style={{ color }}>×{p}</span>
                      <input type="number" value={bMin} onChange={e => setTonnetzBound(p, "min", Number(e.target.value))}
                        className="w-10 bg-[#141414] text-white text-[11px] rounded px-1.5 py-0.5 text-center font-mono focus:outline-none"
                        style={{ border: `1px solid ${color}40` }} />
                      <span className="text-[#888] font-bold">..</span>
                      <input type="number" value={bMax} onChange={e => setTonnetzBound(p, "max", Number(e.target.value))}
                        className="w-10 bg-[#141414] text-white text-[11px] rounded px-1.5 py-0.5 text-center font-mono focus:outline-none"
                        style={{ border: `1px solid ${color}40` }} />
                    </div>
                  );
                })}
              </div>
              {/* PLR navigation for all active triads */}
              {activeTriadKeys.size > 0 && (() => {
                const triadEntries = [...activeTriadKeys].map(tk => {
                  const triad = tonnetzData.triads.find(t => t.key === tk);
                  const links = (tonnetzData.plrByTriad.get(tk) ?? [])
                    .filter(l => !activeTriadKeys.has(l.to)); // exclude directions to other active triads
                  return { triad, links, key: tk };
                }).filter(e => e.triad && e.links.length > 0);
                if (triadEntries.length === 0) return null;
                return (
                  <div className="flex flex-col gap-1.5 py-1.5 px-2 rounded bg-[#0c0c0c] border border-[#1a1a1a]">
                    {triadEntries.map(({ triad, links, key: tk }) => {
                      const chordNotes = triad!.nodeKeys.map(k => {
                        const nd = tonnetzData.nodeMap.get(k);
                        return nd ? tonnetzRatioToNoteName(nd.n, nd.d, latticeDroneRoot) : "?";
                      }).join(" ");
                      return (
                        <div key={tk} className="flex flex-wrap gap-1.5 items-center">
                          <span className="text-[10px] text-[#888] font-mono mr-1">
                            {triad!.type === "otonal" ? "Maj" : "Min"}: {chordNotes}
                          </span>
                          {links.map((link, i) => (
                            <button key={i} onClick={() => handleTonnetzPLRNavigate(link)}
                              className="px-2.5 py-1 rounded text-xs font-bold transition-colors border border-[#ddbb33] bg-[#1a1a10] text-[#ffdd44] hover:bg-[#2a2a1a] hover:text-white">
                              {link.name}
                              <span className="text-[9px] font-normal text-[#888] ml-1">({link.description})</span>
                            </button>
                          ))}
                        </div>
                      );
                    })}
                    <button onClick={() => { setDroneNodes(new Set()); setTonnetzSelectedTriad(null); }}
                      className="px-2 py-1 rounded text-[10px] border border-[#333] text-[#555] hover:text-white transition-colors self-end">
                      Clear
                    </button>
                  </div>
                );
              })()}
            </>)}

            {/* EDO-specific controls (12-EDO and 31-EDO) */}
            {tonnetzSubMode !== "ji" && (<>
              {/* EDO Preset */}
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Preset</span>
                {Object.keys(EDO_TONNETZ_PRESETS)
                  .filter(name => name.startsWith(tonnetzSubMode === "12edo" ? "12-" : tonnetzSubMode === "31edo" ? "31-" : "53-"))
                  .map(name => (
                  <button key={name} onClick={() => handleEdoTonnetzPresetChange(name)}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                      edoTonnetzPreset === name
                        ? "bg-[#7173e6] text-white border-[#7173e6]"
                        : "bg-[#111] text-[#444] border-[#222] hover:text-[#aaa]"
                    }`}>
                    {name}
                  </button>
                ))}
              </div>
              {/* Edge toggles */}
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Edges</span>
                {(["fifth", "majorThird", "minorThird"] as const).map(type => (
                  <button key={type} onClick={() => setEdoTonnetzShowEdges(prev => ({ ...prev, [type]: !prev[type] }))}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors border ${
                      edoTonnetzShowEdges[type]
                        ? "bg-[#1a1a1a] text-white"
                        : "bg-[#111] text-[#444] border-[#222]"
                    }`}
                    style={edoTonnetzShowEdges[type] ? { borderColor: EDO_TONNETZ_EDGE_COLORS[type], color: EDO_TONNETZ_EDGE_COLORS[type] } : undefined}
                  >
                    <span className="w-3 h-0.5 rounded-full inline-block"
                      style={{ backgroundColor: EDO_TONNETZ_EDGE_COLORS[type] }} />
                    {type === "fifth" ? `5th (${edoTonnetzConfig.fifth})` : type === "majorThird" ? `M3 (${edoTonnetzConfig.majorThird})` : `m3 (${((edoTonnetzConfig.fifth - edoTonnetzConfig.majorThird) % edoTonnetzConfig.edo + edoTonnetzConfig.edo) % edoTonnetzConfig.edo})`}
                  </button>
                ))}
                <div className="w-px h-5 bg-[#222]" />
                <button onClick={() => setEdoTonnetzShowMajor(!edoTonnetzShowMajor)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                    edoTonnetzShowMajor
                      ? "bg-[#1a1a2a] text-[#6699ff] border-[#4488ff]"
                      : "bg-[#111] text-[#444] border-[#222]"
                  }`}>
                  Major
                </button>
                <button onClick={() => setEdoTonnetzShowMinor(!edoTonnetzShowMinor)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                    edoTonnetzShowMinor
                      ? "bg-[#2a1a1a] text-[#ff8866] border-[#ff6644]"
                      : "bg-[#111] text-[#444] border-[#222]"
                  }`}>
                  Minor
                </button>
                <div className="w-px h-5 bg-[#222]" />
                <button onClick={() => setEdoTonnetzShowPLR(!edoTonnetzShowPLR)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                    edoTonnetzShowPLR
                      ? "bg-[#2a2a1a] text-[#ffdd44] border-[#ddbb33]"
                      : "bg-[#111] text-[#444] border-[#222]"
                  }`}>
                  PLR
                </button>
                <div className="w-px h-5 bg-[#222]" />
                <ToggleBtn on={edoTonnetzShowNotes} set={setEdoTonnetzShowNotes} onColor="#4ac" label="Notes" />
                <ToggleBtn on={edoTonnetzShowSteps} set={setEdoTonnetzShowSteps} onColor="#e8c76a" label="Steps" />
                <ToggleBtn on={edoTonnetzShowCents} set={setEdoTonnetzShowCents} onColor="#888" label="Cents" />
              </div>
              {/* Grid size */}
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-[10px] text-[#555] uppercase tracking-wider mr-1">Grid</span>
                <div className="flex items-center gap-0.5 text-[10px]">
                  <span className="text-[#e87010]">Cols</span>
                  <input type="number" value={edoTonnetzConfig.cols} min={1} max={20}
                    onChange={e => { setEdoTonnetzConfig(prev => ({ ...prev, cols: Number(e.target.value) })); setEdoTonnetzPreset("Custom"); }}
                    className="w-8 bg-[#141414] border border-[#333] text-white text-[10px] rounded px-1 py-0.5 text-center" />
                </div>
                <div className="flex items-center gap-0.5 text-[10px]">
                  <span className="text-[#22cc44]">Rows</span>
                  <input type="number" value={edoTonnetzConfig.rows} min={1} max={15}
                    onChange={e => { setEdoTonnetzConfig(prev => ({ ...prev, rows: Number(e.target.value) })); setEdoTonnetzPreset("Custom"); }}
                    className="w-8 bg-[#141414] border border-[#333] text-white text-[10px] rounded px-1 py-0.5 text-center" />
                </div>
              </div>
              {/* EDO PLR navigation for all active triads */}
              {activeTriadKeys.size > 0 && (() => {
                const triadEntries = [...activeTriadKeys].map(tk => {
                  const triad = edoTonnetzData.triads.find(t => t.key === tk);
                  const links = (edoTonnetzData.plrByTriad.get(tk) ?? [])
                    .filter(l => !activeTriadKeys.has(l.to));
                  return { triad, links, key: tk };
                }).filter(e => e.triad && e.links.length > 0);
                if (triadEntries.length === 0) return null;
                return (
                  <div className="flex flex-col gap-1.5 py-1.5 px-2 rounded bg-[#0c0c0c] border border-[#1a1a1a]">
                    {triadEntries.map(({ triad, links, key: tk }) => {
                      const chordNotes = triad!.nodeKeys.map(k => {
                        const nd = edoTonnetzData.nodeMap.get(k);
                        return nd ? edoNoteNameByPc(nd.pc, edoTonnetzData.config.edo) : "?";
                      }).join(" ");
                      return (
                        <div key={tk} className="flex flex-wrap gap-1.5 items-center">
                          <span className="text-[10px] text-[#888] font-mono mr-1">
                            {triad!.type === "major" ? "Maj" : "Min"}: {chordNotes}
                          </span>
                          {links.map((link, i) => (
                            <button key={i} onClick={() => handleEdoTonnetzPLRNavigate(link)}
                              className="px-2.5 py-1 rounded text-xs font-bold transition-colors border border-[#ddbb33] bg-[#1a1a10] text-[#ffdd44] hover:bg-[#2a2a1a] hover:text-white">
                              {link.name}
                              <span className="text-[9px] font-normal text-[#888] ml-1">({link.description})</span>
                            </button>
                          ))}
                        </div>
                      );
                    })}
                    <button onClick={() => { setDroneNodes(new Set()); setEdoTonnetzSelectedTriad(null); }}
                      className="px-2 py-1 rounded text-[10px] border border-[#333] text-[#555] hover:text-white transition-colors self-end">
                      Clear
                    </button>
                  </div>
                );
              })()}
            </>)}

            {/* Voice leading removed — chord moves shown in canvas overlay instead */}
          </div>
        )}

        {/* Layer toggles (hidden in harmonic, otonal, comma, monzo, chain, and lattice modes) */}
        {!isHarmonicMode && !isOtonalMode && !isCommaMode && !isMonzoMode && !isChainMode && viewMode !== "lattice" && (
          <div className="flex flex-wrap gap-1.5 mb-3 items-center">
            {([3, 5, 7, 11, 13] as const).map(p => (
              <button key={p} onClick={() => toggleGen(p)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors border ${
                  showGen[p]
                    ? "bg-[#1a1a1a] text-white"
                    : "bg-[#111] text-[#444] border-[#222]"
                }`}
                style={showGen[p] ? { borderColor: PRIME_COLORS[p], color: PRIME_COLORS[p] } : undefined}
              >
                <span className="w-3 h-0.5 rounded-full inline-block"
                  style={{ backgroundColor: PRIME_COLORS[p] }} />
                ×{p}
              </button>
            ))}
            {!isChainMode && (
              <>
                <div className="w-px h-5 bg-[#222]" />
                <ToggleBtn on={showOtonal} set={setShowOtonal}
                  onColor="#888" label="Otonal" />
                <ToggleBtn on={showUtonal} set={setShowUtonal}
                  onColor="#666" label="Utonal" />
                <div className="w-px h-5 bg-[#222]" />
                <ToggleBtn on={showComma} set={setShowComma}
                  onColor="#ff4444" label="Comma" />
                <ToggleBtn on={showOctave} set={setShowOctave}
                  onColor="#666" label="Octave" />
              </>
            )}
          </div>
        )}

        {/* Info bar */}
        <div className="h-5 mb-2">
          {isHarmonicMode && harmonicInfoNode && (
            <span className="text-xs text-[#666]">
              <span className="text-white font-semibold">H{harmonicInfoNode.harmonic}</span>
              <span className="text-[#444] mx-1.5">·</span>
              <span className="text-[#999] font-mono">{harmonicInfoNode.label}</span>
              <span className="text-[#444] mx-1.5">·</span>
              <span className="text-[#777]">{ratioToCents(harmonicInfoNode.n, harmonicInfoNode.d).toFixed(1)}¢</span>
            </span>
          )}
          {isMonzoMode && (() => {
            const displayKey = hoveredNode ?? monzoFocusKey ?? null;
            const mNode = displayKey ? monzoLattice.nodes.find(n => n.key === displayKey) : null;
            const dist = mNode ? mNode.monzo.exps.reduce((s, e) => s + Math.abs(e), 0) : 0;
            const activePrimes = monzoConfig.primes.filter(p => p !== 2);
            return (
              <span className="text-xs text-[#666]">
                {mNode ? (
                  <>
                    <span className="text-white font-semibold">{monzoIntervalName(mNode.monzo.n, mNode.monzo.d)}</span>
                    <span className="text-[#444] mx-1.5">·</span>
                    <span className="text-[#999] font-mono">{mNode.key}</span>
                    <span className="text-[#444] mx-1.5">·</span>
                    <span className="text-[#777]">{monzoRatioToCents(mNode.monzo.n, mNode.monzo.d).toFixed(1)}¢</span>
                    <span className="text-[#333] mx-1.5">·</span>
                    <span className="text-[#555]">{monzoLabel(mNode.monzo.exps, monzoLattice.primes)}</span>
                    <span className="text-[#333] mx-1.5">·</span>
                    <span className="text-[#555]">d={dist}</span>
                    {(() => {
                      const allNames = monzoIntervalAllNames(mNode.monzo.n, mNode.monzo.d);
                      return allNames.length > 1 ? (
                        <span className="text-[#555] ml-1 text-[10px]">(aka {allNames.slice(1).join(", ")})</span>
                      ) : null;
                    })()}
                    {mNode.temperedClass !== undefined && (() => {
                      // Find all siblings in this tempered class
                      const classId = mNode.temperedClass;
                      const siblings = monzoLattice.nodes.filter(
                        n => n.temperedClass === classId && n.key !== mNode.key
                      );
                      return (
                        <>
                          <span className="text-[#ff6666] ml-2">class {classId}</span>
                          {siblings.length > 0 && (
                            <span className="text-[#ff9966] ml-2">
                              = {siblings.map(s => s.key).join(", ")}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </>
                ) : (
                  <>
                    <span className="text-[#555]">{filteredMonzoLattice.nodes.length} nodes</span>
                    <span className="text-[#333] mx-1.5">·</span>
                    <span className="text-[#555]">primes: {activePrimes.join(", ")}</span>
                    {monzoFocusKey && (
                      <>
                        <span className="text-[#333] mx-1.5">·</span>
                        <span className="text-[#e0a030]">center: {monzoFocusKey}</span>
                      </>
                    )}
                  </>
                )}
              </span>
            );
          })()}
          {viewMode === "lattice" && tonnetzSubMode === "ji" && (() => {
            const hNode = hoveredNode ? tonnetzData.nodeMap.get(hoveredNode) : null;
            const hTriad = tonnetzHoveredTriad ? tonnetzData.triads.find(t => t.key === tonnetzHoveredTriad) : null;
            if (hTriad) {
              const notes = hTriad.nodeKeys.map(k => {
                const nd = tonnetzData.nodeMap.get(k);
                return nd ? `${tonnetzRatioToNoteName(nd.n, nd.d, latticeDroneRoot)} (${nd.ratioKey})` : "?";
              });
              return (
                <span className="text-xs text-[#666]">
                  <span className="font-semibold" style={{ color: hTriad.type === "otonal" ? "#6699ff" : "#ff8866" }}>
                    {hTriad.type === "otonal" ? "Otonal" : "Utonal"}
                  </span>
                  <span className="text-[#444] mx-1.5">·</span>
                  <span className="text-[#999]">{notes.join("  ")}</span>
                </span>
              );
            }
            if (hNode) {
              const xenName = xenIntervalName(hNode.n, hNode.d);
              const xenAll = xenIntervalNames(hNode.n, hNode.d);
              return (
                <span className="text-xs text-[#666]">
                  <span className="text-white font-semibold">{tonnetzRatioToNoteName(hNode.n, hNode.d, latticeDroneRoot)}</span>
                  <span className="text-[#444] mx-1.5">·</span>
                  <span className="text-[#999] font-mono">{hNode.ratioKey}</span>
                  <span className="text-[#444] mx-1.5">·</span>
                  <span className="text-[#777]">{hNode.cents.toFixed(1)}¢</span>
                  <span className="text-[#444] mx-1.5">·</span>
                  <span className="text-[#aad]">{xenName}</span>
                  {xenAll.length > 1 && (
                    <span className="text-[#555] ml-1 text-[10px]">({xenAll.slice(1).join(", ")})</span>
                  )}
                </span>
              );
            }
            return null;
          })()}
          {viewMode === "lattice" && tonnetzSubMode !== "ji" && (() => {
            const hNode = hoveredNode ? edoTonnetzData.nodeMap.get(hoveredNode) : null;
            const hTriad = edoTonnetzHoveredTriad ? edoTonnetzData.triads.find(t => t.key === edoTonnetzHoveredTriad) : null;
            const edo = edoTonnetzData.config.edo;
            if (hTriad) {
              const notes = hTriad.nodeKeys.map(k => {
                const nd = edoTonnetzData.nodeMap.get(k);
                return nd ? `${edoNoteNameByPc(nd.pc, edo)} (${nd.pc})` : "?";
              });
              return (
                <span className="text-xs text-[#666]">
                  <span className="font-semibold" style={{ color: hTriad.type === "major" ? "#6699ff" : "#ff8866" }}>
                    {hTriad.type === "major" ? "Major" : "Minor"}
                  </span>
                  <span className="text-[#444] mx-1.5">·</span>
                  <span className="text-[#999]">{notes.join("  ")}</span>
                </span>
              );
            }
            if (hNode) {
              return (
                <span className="text-xs text-[#666]">
                  <span className="text-white font-semibold">{edoNoteNameByPc(hNode.pc, edo)}</span>
                  <span className="text-[#444] mx-1.5">·</span>
                  <span className="text-[#999] font-mono">step {hNode.pc}/{edo}</span>
                  <span className="text-[#444] mx-1.5">·</span>
                  <span className="text-[#777]">{hNode.cents.toFixed(1)}¢</span>
                </span>
              );
            }
            return null;
          })()}
          {!isHarmonicMode && !isOtonalMode && !isMonzoMode && viewMode !== "lattice" && infoData && (() => {
            const xenName = xenIntervalName(infoData.n, infoData.d);
            const xenAll = xenIntervalNames(infoData.n, infoData.d);
            return (
              <span className="text-xs text-[#666]">
                <span className="text-white font-semibold">{intervalName(infoData)}</span>
                <span className="text-[#444] mx-1.5">·</span>
                <span className="text-[#999] font-mono">{infoData.n}/{infoData.d}</span>
                <span className="text-[#444] mx-1.5">·</span>
                <span className="text-[#777]">{ratioToCents(infoData.n, infoData.d).toFixed(1)}¢</span>
                <span className="text-[#333] mx-1.5">·</span>
                <span className="text-[#555]">{exponentLabel(infoData)}</span>
                <span className="text-[#444] mx-1.5">·</span>
                <span className="text-[#aad]">{xenName}</span>
                {xenAll.length > 1 && (
                  <span className="text-[#555] ml-1 text-[10px]">({xenAll.slice(1).join(", ")})</span>
                )}
              </span>
            );
          })()}
        </div>
          </>
          );
          if (isFullscreen && canvasContainerRef.current) {
            return createPortal(
              <div className="absolute top-10 left-2 right-60 z-20 max-h-[80vh] overflow-y-auto rounded-lg bg-[#0a0a0a]/95 backdrop-blur-md border border-[#333] p-4" onClick={e => e.stopPropagation()}>
                {inner}
              </div>,
              canvasContainerRef.current
            );
          }
          return inner;
        })()}
      </div>
      )}{/* /chromeless gate on controls block */}

      {/* 3D Canvas */}
      <div
        ref={canvasContainerRef}
        className={`rounded-xl border border-[#1a1a1a] bg-[#080808] relative ${isCommaMode ? "overflow-auto" : "overflow-hidden"}`}
        style={chromeless ? { flex: 1, minHeight: 0 } : { height: "80vh" }}
      >
        {/* Navigation help */}
        {(
          <div className="absolute top-2 left-2 z-10 px-2.5 py-1.5 rounded text-[9px] bg-[#111]/70 text-[#555] backdrop-blur-sm border border-[#222] leading-relaxed">
            {isMonzoMode ? (
              <><span className="text-[#777]">Drag</span> rotate · <span className="text-[#777]">Right-drag</span> pan · <span className="text-[#777]">Scroll</span> zoom · <span className="text-[#777]">Arrow keys</span> pan · <span className="text-[#777]">Click</span> play · <span className="text-[#777]">Shift+click</span> focus</>
            ) : viewMode === "lattice" && tonnetzSubMode === "ji" && tonnetzConfig.limit >= 7 ? (
              <><span className="text-[#777]">Drag</span> rotate · <span className="text-[#777]">Right-drag</span> pan · <span className="text-[#777]">Scroll</span> zoom · <span className="text-[#777]">Arrow keys</span> pan · <span className="text-[#777]">Click</span> play</>
            ) : viewMode === "lattice" ? (
              <><span className="text-[#777]">Drag</span> pan · <span className="text-[#777]">Scroll</span> zoom · <span className="text-[#777]">Click</span> play</>
            ) : (
              <><span className="text-[#777]">Drag</span> rotate · <span className="text-[#777]">Right-drag</span> pan · <span className="text-[#777]">Scroll</span> zoom · <span className="text-[#777]">Arrow keys</span> pan</>
            )}
          </div>
        )}
        {/* Canvas overlay controls */}
        {(
        <div className="absolute top-2 right-2 z-10 flex flex-col gap-1.5 items-end">
          <div className="flex gap-1.5">
            {(isMonzoMode || (viewMode === "lattice" && tonnetzSubMode === "ji" && tonnetzConfig.limit >= 7)) && (
              <button
                onClick={() => setCameraResetKey(k => k + 1)}
                className="px-2 py-1 rounded text-[10px] font-medium border border-[#333] bg-[#111]/80 text-[#888] hover:text-white hover:border-[#555] backdrop-blur-sm transition-colors"
              >
                Reset View
              </button>
            )}
            {activeDroneCount > 0 && (
              <button
                onClick={() => {
                  setDroneNodes(new Set());
                  setStackActiveNodes(new Set());
                  setNodeVolMap({});
                  setTonnetzSelectedTriad(null);
                  setEdoTonnetzSelectedTriad(null);
                  setClearPinnedKey(k => k + 1);
                  if (latticeDroneOn && latticeDroneMode !== "Off") {
                    const ratios = buildLatticeDroneRatios(latticeDroneMode);
                    audioEngine.startRatioDrone(ratios, latticeDroneVol, rootPcToFreq(latticeDroneRoot));
                  } else {
                    audioEngine.stopDrone();
                  }
                }}
                className="px-2 py-1 rounded text-[10px] font-medium border border-[#333] bg-[#111]/80 text-[#888] hover:text-white hover:border-[#555] backdrop-blur-sm transition-colors"
              >
                Deselect All
              </button>
            )}
            <button
              onClick={toggleFullscreen}
              className="px-2 py-1 rounded text-[10px] font-medium border border-[#333] bg-[#111]/80 text-[#888] hover:text-white hover:border-[#555] backdrop-blur-sm transition-colors"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? "Exit FS" : "Fullscreen"}
            </button>
            {isFullscreen && (
              <button
                onClick={() => setFsControlsOpen(o => !o)}
                className={`px-2 py-1 rounded text-[10px] font-medium border backdrop-blur-sm transition-colors ${
                  fsControlsOpen
                    ? "border-[#7173e6] bg-[#7173e6]/30 text-white"
                    : "border-[#333] bg-[#111]/80 text-[#888] hover:text-white hover:border-[#555]"
                }`}
                title="Toggle controls panel"
              >
                {fsControlsOpen ? "Hide Controls" : "Controls"}
              </button>
            )}
          </div>
          {isMonzoMode && (
            <div className="flex gap-1">
              <input
                type="text" value={jumpRatioInput}
                onChange={e => setJumpRatioInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleJumpToRatio(); }}
                placeholder="5/4"
                className="w-14 bg-[#111]/80 border border-[#333] rounded px-1.5 py-0.5 text-[10px] text-white focus:outline-none focus:border-[#555] backdrop-blur-sm font-mono text-center placeholder:text-[#444]"
              />
              <button onClick={handleJumpToRatio}
                className="px-1.5 py-0.5 rounded text-[9px] font-medium border border-[#333] bg-[#111]/80 text-[#888] hover:text-white hover:border-[#555] backdrop-blur-sm transition-colors">
                Focus
              </button>
            </div>
          )}
          {isMonzoMode && (
            <div className="flex gap-1 items-center">
              <input
                type="text" value={noteFilterInput}
                onChange={e => setNoteFilterInput(e.target.value)}
                placeholder="C#"
                className="w-14 bg-[#111]/80 border border-[#333] rounded px-1.5 py-0.5 text-[10px] text-white focus:outline-none focus:border-[#555] backdrop-blur-sm text-center placeholder:text-[#444]"
                title="Filter by note name — shows only matching nodes and edges from focus"
              />
              {noteFilterInput && (
                <button onClick={() => setNoteFilterInput("")}
                  className="px-1.5 py-0.5 rounded text-[9px] font-medium border border-[#333] bg-[#111]/80 text-[#888] hover:text-white hover:border-[#555] backdrop-blur-sm transition-colors">
                  Clear
                </button>
              )}
              <span className="text-[9px] text-[#555]">Note</span>
            </div>
          )}
        </div>
        )}
        {/* Keyboard stepping hint */}
        {isMonzoMode && (
          <div className="absolute bottom-2 left-2 z-10 px-2.5 py-1.5 rounded text-[9px] bg-[#111]/80 text-[#666] backdrop-blur-sm border border-[#222] font-mono leading-relaxed" style={{ maxWidth: "60%" }}>
            {buildStepHint(monzoConfig.primes)} <span className="text-[#555]">· Shift = reverse</span>
          </div>
        )}
        {isMonzoMode ? (
          <Canvas
            camera={{ position: [10, 7, 10] as const, fov: 55, near: 0.1, far: 500 }}
            gl={{ antialias: true, alpha: false }}
            onCreated={({ gl }) => { gl.setClearColor("#080808"); }}
            style={{ width: "100%", height: "100%", background: "#080808" }}
          >
            <CameraReset resetKey={cameraResetKey} />
            <MonzoScene
              lattice={filteredMonzoLattice}
              topology={monzoTopology}
              droneNodes={droneNodes}
              nodeColorOverrides={monzoNodeColorOverrides}
              compensationArcs={compensationArcs}
              hoveredNode={hoveredNode}
              onHover={setHoveredNode}
              onClickNode={handleMonzoNodeClick}
              onFocusNode={setMonzoFocusKey}
              focusKey={monzoFocusKey}
              showTopoSurface={monzoShowTopo}
              layers={monzoLayers}
              pathMode={monzoPathMode}
              labelLOD={monzoLabelLOD}
              labelDist={monzoLabelDist}
              rootPc={latticeDroneRoot}
              highlightedRatios={
                externalHighlights && externalHighlights.size > 0
                  ? externalHighlights
                  : (customRatiosActive ? parsedCustomRatios : noteFilterTargets ?? undefined)
              }
              autoPathTargets={
                externalHighlights && externalHighlights.size > 0
                  ? externalHighlights
                  : (customRatiosActive ? parsedCustomRatios : noteFilterTargets ?? undefined)
              }
              clearPinnedKey={clearPinnedKey}
            />
          </Canvas>
        ) : isOtonalMode ? (
          <OtonalSvg
            stackData={stackData}
            stackIsUtonal={stackIsUtonal}
            activeNodes={stackActiveNodes}
            onClickNode={handleStackNodeClick}
          />
        ) : isCommaMode ? (
          <CommaSvg
            groups={commaGroups}
            droneNodes={droneNodes}
            onClickNode={async (node: HNode) => { await ensureAudio(); handleNodeClick(node); }}
          />
        ) : isHarmonicMode ? (
          <HarmonicSvg
            nodes={harmonicData.nodes}
            edges={harmonicData.edges}
            droneNodes={droneNodes}
            onClickNode={handleChainNodeClick}
            showIntervals={showIntervals}
          />
        ) : isChainMode ? (
          <ChainSvg
            droneNodes={droneNodes}
            onClickNode={async (node: LatticeNode) => {
              await ensureAudio();
              const key = node.key;
              setDroneNodes(prev => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key); else next.add(key);
                if (next.size === 0) {
                  audioEngine.stopDrone();
                  setNodeVolMap({});
                } else {
                  const keys = [...next];
                  const ratios = keys.map(k => {
                    const nd = monzoLattice.nodes.find(n => n.key === k);
                    return nd ? nd.monzo.n / nd.monzo.d : 1;
                  });
                  startNodeDrone(ratios, keys, nodeVolMap);
                }
                return next;
              });
            }}
            lattice={monzoLattice}
            labelMode="intervals"
            rootPc={latticeDroneRoot}
          />
        ) : tonnetzSubMode === "ji" && tonnetzConfig.limit >= 7 ? (
          <Canvas
            camera={{ position: [16, 10, 16] as const, fov: 50, near: 0.1, far: 200 }}
            gl={{ antialias: true, alpha: false }}
            onCreated={({ gl }) => { gl.setClearColor("#080808"); }}
            style={{ width: "100%", height: "100%", background: "#080808" }}
          >
            <CameraReset resetKey={cameraResetKey} />
            <Tonnetz3DScene
              data={tonnetzData}
              droneNodes={droneNodes}
              hoveredNode={hoveredNode}
              onHover={setHoveredNode}
              onClickNode={handleTonnetzNodeClick}
              showNotes={tonnetzShowNotes}
              showRatios={tonnetzShowRatios}
              showCents={tonnetzShowCents}
              rootPc={latticeDroneRoot}
              showEdges={tonnetzShowEdges}
              showOtonal={tonnetzShowOtonal}
              showUtonal={tonnetzShowUtonal}
              showPLR={tonnetzShowPLR}
              selectedTriad={tonnetzSelectedTriad}
              activeTriads={activeTriadKeys}
              hoveredTriad={tonnetzHoveredTriad}
              onHoverTriad={setTonnetzHoveredTriad}
              onClickTriad={handleTonnetzTriadClick}
              onPLRNavigate={handleTonnetzPLRNavigate}
            />
          </Canvas>
        ) : tonnetzSubMode === "ji" ? (
          <TonnetzSvg
            data={tonnetzData}
            droneNodes={droneNodes}
            hoveredNode={hoveredNode}
            onHover={setHoveredNode}
            onClickNode={handleTonnetzNodeClick}
            showNotes={tonnetzShowNotes}
            showRatios={tonnetzShowRatios}
            showCents={tonnetzShowCents}
            rootPc={latticeDroneRoot}
            showEdges={tonnetzShowEdges}
            showOtonal={tonnetzShowOtonal}
            showUtonal={tonnetzShowUtonal}
            showPLR={tonnetzShowPLR}
            selectedTriad={tonnetzSelectedTriad}
            activeTriads={activeTriadKeys}
            hoveredTriad={tonnetzHoveredTriad}
            onHoverTriad={setTonnetzHoveredTriad}
            onClickTriad={handleTonnetzTriadClick}
            onPLRNavigate={handleTonnetzPLRNavigate}
            chordMoves={chordMoves}
            onChordMove={handleChordMoveNavigate}
            parallelMoves={parallelMoves}
            onParallelMove={handleParallelMoveNavigate}
          />
        ) : (
          <EdoTonnetzSvg
            data={edoTonnetzData}
            droneNodes={droneNodes}
            hoveredNode={hoveredNode}
            onHover={setHoveredNode}
            onClickNode={handleEdoTonnetzNodeClick}
            showNotes={edoTonnetzShowNotes}
            showSteps={edoTonnetzShowSteps}
            showCents={edoTonnetzShowCents}
            rootPc={latticeDroneRoot}
            showEdges={edoTonnetzShowEdges}
            showMajor={edoTonnetzShowMajor}
            showMinor={edoTonnetzShowMinor}
            showPLR={edoTonnetzShowPLR}
            selectedTriad={edoTonnetzSelectedTriad}
            activeTriads={activeTriadKeys}
            hoveredTriad={edoTonnetzHoveredTriad}
            onHoverTriad={setEdoTonnetzHoveredTriad}
            onClickTriad={handleEdoTonnetzTriadClick}
            onPLRNavigate={handleEdoTonnetzPLRNavigate}
            chordMoves={chordMoves}
            onChordMove={handleChordMoveNavigate}
            parallelMoves={parallelMoves}
            onParallelMove={handleParallelMoveNavigate}
          />
        )}
      </div>

      {!chromeless && (<>
      {/* Voice Leading panel */}
      {viewMode === "lattice" && droneNodes.size >= 3 && droneNodes.size <= 3 && chordMoves.length > 0 && (
        <details className="mt-3 flex-shrink-0" open>
          <summary className="text-xs text-[#444] cursor-pointer hover:text-[#888] transition-colors">
            Voice Leading · {chordMoves.length} moves
          </summary>
          <div className="mt-2 space-y-1.5">
            {[...movesByDirection.entries()].map(([dir, moves]) => (
              <div key={dir} className="flex items-start gap-2">
                <span className="text-[10px] font-mono text-[#ffdd44] w-12 flex-shrink-0 pt-0.5 text-right">
                  {dir}
                </span>
                <div className="flex flex-wrap gap-1">
                  {moves.map((move, i) => (
                    <button
                      key={i}
                      onClick={() => handleChordMoveNavigate(move)}
                      className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#111] border border-[#333] text-[#aaa] hover:bg-[#1a1a2a] hover:border-[#ffdd44] hover:text-[#ffdd44] transition-colors cursor-pointer"
                    >
                      {move.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Parallel voice leading (all voices shift together) */}
      {viewMode === "lattice" && parallelMoves.length > 0 && (
        <details className="mt-3 flex-shrink-0" open>
          <summary className="text-xs text-[#444] cursor-pointer hover:text-[#888] transition-colors">
            Parallel Voice Leading · {parallelMoves.length} moves
          </summary>
          <div className="mt-2 space-y-1.5">
            {parallelMoves.map((move, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-[10px] font-mono text-[#44ffaa] w-12 flex-shrink-0 pt-0.5 text-right">
                  {move.direction}
                </span>
                <button
                  onClick={() => handleParallelMoveNavigate(move)}
                  className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#111] border border-[#333] text-[#aaa] hover:bg-[#0a1a15] hover:border-[#44ffaa] hover:text-[#44ffaa] transition-colors cursor-pointer"
                >
                  {move.voices.map(v => v.label).join(", ")}
                </button>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Ratio table */}
      <details className="mt-3 flex-shrink-0">
        <summary className="text-xs text-[#444] cursor-pointer hover:text-[#888] transition-colors">
          {viewMode === "lattice"
            ? (tonnetzSubMode === "ji"
              ? `${tonnetzData.nodes.length} pitch classes · ${tonnetzInfoData.triadCount} simplices`
              : `${edoTonnetzInfoData.uniquePcs} pitch classes · ${edoTonnetzInfoData.triadCount} triads (${edoTonnetzData.config.edo}-EDO)`)
            : isHarmonicMode
            ? `${harmonicData.nodes.length} harmonics`
            : `All ${NODES.length} ratios`
          }
        </summary>
        <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-1">
          {viewMode === "lattice" && tonnetzSubMode === "ji"
            ? [...tonnetzData.nodes]
                .sort((a, b) => a.n / a.d - b.n / b.d)
                .map(node => (
                  <button key={node.key} onClick={() => handleTonnetzNodeClick(node)}
                    className={`px-2 py-1 rounded text-xs font-mono text-left border transition-colors ${
                      droneNodes.has(node.key)
                        ? "bg-[#171730] border-[#7173e6] text-[#7173e6]"
                        : "bg-[#111] border-[#1a1a1a] text-[#666] hover:text-[#ccc] hover:border-[#333]"
                    }`}>
                    <span className="font-semibold">{tonnetzRatioToNoteName(node.n, node.d, latticeDroneRoot)}</span>
                    <span className="text-[#444] ml-1">{node.ratioKey}</span>
                    <span className="text-[#333] ml-1">{node.cents.toFixed(0)}¢</span>
                  </button>
                ))
            : viewMode === "lattice" && tonnetzSubMode !== "ji"
            ? (() => {
                // Show unique pitch classes sorted by step number
                const edo = edoTonnetzData.config.edo;
                const seen = new Set<number>();
                const unique: EdoTonnetzNode[] = [];
                for (const n of edoTonnetzData.nodes) {
                  if (!seen.has(n.pc)) { seen.add(n.pc); unique.push(n); }
                }
                unique.sort((a, b) => a.pc - b.pc);
                return unique.map(node => (
                  <button key={node.pc} onClick={() => handleEdoTonnetzNodeClick(node)}
                    className={`px-2 py-1 rounded text-xs font-mono text-left border transition-colors ${
                      droneNodes.has(node.key)
                        ? "bg-[#171730] border-[#7173e6] text-[#7173e6]"
                        : "bg-[#111] border-[#1a1a1a] text-[#666] hover:text-[#ccc] hover:border-[#333]"
                    }`}>
                    <span className="font-semibold">{edoNoteNameByPc(node.pc, edo)}</span>
                    <span className="text-[#444] ml-1">{node.pc}</span>
                    <span className="text-[#333] ml-1">{node.cents.toFixed(0)}¢</span>
                  </button>
                ));
              })()
            : isHarmonicMode
            ? harmonicData.nodes.map(hNode => (
                <button key={hNode.label} onClick={() => handleChainNodeClick(hNode)}
                  className={`px-2 py-1 rounded text-xs font-mono text-left border transition-colors ${
                    droneNodes.has(hNode.label)
                      ? "bg-[#171730] border-[#7173e6] text-[#7173e6]"
                      : "bg-[#111] border-[#1a1a1a] text-[#666] hover:text-[#ccc] hover:border-[#333]"
                  }`}>
                  <span className="font-semibold">H{hNode.harmonic}</span>
                  <span className="text-[#444] ml-1">{hNode.label}</span>
                  <span className="text-[#333] ml-1">{ratioToCents(hNode.n, hNode.d).toFixed(0)}¢</span>
                </button>
              ))
            : [...NODES]
                .sort((a, b) => a.n / a.d - b.n / b.d)
                .map(node => {
                  const key = nodeKey(node);
                  const cents = ratioToCents(node.n, node.d);
                  return (
                    <button key={key} onClick={() => handleNodeClick(node)}
                      className={`px-2 py-1 rounded text-xs font-mono text-left border transition-colors ${
                        droneNodes.has(key)
                          ? "bg-[#171730] border-[#7173e6] text-[#7173e6]"
                          : node.isComma
                          ? "bg-[#111] border-[#1a1a1a] text-[#555] hover:text-[#999] hover:border-[#333]"
                          : "bg-[#111] border-[#1a1a1a] text-[#666] hover:text-[#ccc] hover:border-[#333]"
                      }`}>
                      <span className="font-semibold">{intervalName(node)}</span>
                      <span className="text-[#444] ml-1">{key}</span>
                      <span className="text-[#333] ml-1">{cents.toFixed(0)}¢</span>
                    </button>
                  );
                })
          }
        </div>
      </details>
      </>)}{/* /chromeless gate on auxiliary panels */}
    </div>
  );
}

function ToggleBtn({ on, set, onColor, label }: {
  on: boolean; set: (v: boolean) => void; onColor: string; label: string;
}) {
  return (
    <button onClick={() => set(!on)}
      className={`px-2 py-1 rounded text-xs font-medium border transition-colors ${
        on ? "bg-[#1a1a1a] text-[#ccc]" : "bg-[#111] text-[#444] border-[#222]"
      }`}
      style={on ? { borderColor: onColor } : undefined}
    >
      {label}
    </button>
  );
}
