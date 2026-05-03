// ── 3D mode lattice ───────────────────────────────────────────────────
// Renders the 49 modes (Major / Harmonic Minor / Melodic Minor / 4 xen
// families × 7 modes each) as nodes in 3D, with edges connecting modes
// whose scales differ by ≤ 2 positions.  Vertical position = brightness;
// horizontal position is force-directed so 1-alteration neighbours sit
// close together regardless of which family they belong to.
//
// Click a node → toggle a sustained drone of that mode's scale on the
// user's chosen root.  Click again → stop.

import { useMemo, useRef, useState, useEffect } from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";
import { audioEngine } from "@/lib/audioEngine";
import { getModeLattice, alterationFromAnchor, type ModeNode } from "@/lib/modeLatticeLayout";
import { formatHalfAccidentals } from "@/lib/edoData";

interface Props {
  edo: number;
  rootPitch: number;          // absolute pitch (within visualizer range) where the drone sits
  anchorKey: string | null;   // user's selected tonality key, or null
  playVol?: number;
  onActiveModeChange?: (mode: ModeNode | null) => void;
}

// Family → palette colour.  Mirrors the picker's family colours so the
// lattice reads as the same vocabulary the user just clicked through.
const FAMILY_COLOR: Record<string, string> = {
  "Major Family":             "#6a9aca",
  "Harmonic Minor Family":    "#c09050",
  "Melodic Minor Family":     "#c06090",
  "Subminor Diatonic Family": "#7aaa6a",
  "Neutral Diatonic Family":  "#9a66c0",
  "Supermajor Diatonic Family": "#cc6a8a",
  "Subharmonic Diatonic Family": "#4a9ac7",
};

interface NodeMeshProps {
  node: ModeNode;
  isAnchor: boolean;
  isActive: boolean;
  isHovered: boolean;
  alterationFromAnchor: number | null;
  onHover: (key: string | null) => void;
  onClick: (node: ModeNode) => void;
}

function NodeMesh({ node, isAnchor, isActive, isHovered, alterationFromAnchor: dAnchor, onHover, onClick }: NodeMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const baseColor = new THREE.Color(FAMILY_COLOR[node.family] ?? "#888");
  const emissive = new THREE.Color(FAMILY_COLOR[node.family] ?? "#888");

  // Slight breathing pulse when active so it stands out.
  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const targetScale = isActive ? 1.5 : isAnchor ? 1.3 : isHovered ? 1.2 : 1.0;
    const cur = meshRef.current.scale.x;
    meshRef.current.scale.setScalar(cur + (targetScale - cur) * Math.min(1, delta * 8));
  });

  // Dim nodes that are far from the anchor so the lattice has a focal
  // point.  Anchor itself + 1-alteration neighbours stay full saturation.
  let intensity = 1.0;
  if (dAnchor !== null) {
    if (dAnchor === 0) intensity = 1.0;
    else if (dAnchor === 1) intensity = 0.95;
    else if (dAnchor === 2) intensity = 0.7;
    else intensity = 0.35;
  }

  const r = isAnchor ? 0.16 : 0.12;

  return (
    <group position={node.pos}>
      <mesh
        ref={meshRef}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(node.key); }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onClick(node); }}>
        <sphereGeometry args={[r, 18, 14]} />
        <meshStandardMaterial
          color={baseColor.clone().multiplyScalar(intensity)}
          emissive={emissive.clone().multiplyScalar(isActive ? 0.6 : isAnchor ? 0.35 : 0.08)}
          roughness={0.45}
          metalness={0.2} />
      </mesh>
      {(isHovered || isActive || isAnchor) && (
        <Html center distanceFactor={8} style={{ pointerEvents: "none" }}>
          <div style={{
            background: "#0d0d0dee",
            border: `1px solid ${FAMILY_COLOR[node.family] ?? "#444"}`,
            color: FAMILY_COLOR[node.family] ?? "#ccc",
            padding: "3px 6px",
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 600,
            whiteSpace: "nowrap",
            transform: "translate(0, -28px)",
          }}>
            {formatHalfAccidentals(node.mode)}
            {dAnchor !== null && dAnchor > 0 && (
              <span style={{ color: "#888", fontWeight: 400, marginLeft: 6 }}>
                · {dAnchor} alt
              </span>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

interface SceneProps {
  anchorKey: string | null;
  activeKey: string | null;
  hoveredKey: string | null;
  onHover: (key: string | null) => void;
  onClick: (node: ModeNode) => void;
  edo: number;
}

function Scene({ anchorKey, activeKey, hoveredKey, onHover, onClick, edo }: SceneProps) {
  const lattice = useMemo(() => getModeLattice(edo), [edo]);
  const anchor = anchorKey ? lattice.byKey.get(anchorKey) ?? null : null;

  // Edge geometry: 1-alteration as solid bright lines, 2-alteration as
  // dashed dim lines.  Both rendered as drei <Line> for thickness control.
  const oneEdges = useMemo(() => {
    return lattice.edges.filter(e => e.alterations === 1).map((e, i) => {
      const a = lattice.byKey.get(e.fromKey)!.pos;
      const b = lattice.byKey.get(e.toKey)!.pos;
      return { key: `1-${i}`, points: [a, b] as [number, number, number][] };
    });
  }, [lattice]);

  const twoEdges = useMemo(() => {
    return lattice.edges.filter(e => e.alterations === 2).map((e, i) => {
      const a = lattice.byKey.get(e.fromKey)!.pos;
      const b = lattice.byKey.get(e.toKey)!.pos;
      return { key: `2-${i}`, points: [a, b] as [number, number, number][] };
    });
  }, [lattice]);

  return (
    <>
      <ambientLight intensity={0.4} />
      <pointLight position={[6, 6, 6]} intensity={1.0} />
      <pointLight position={[-6, -3, -6]} intensity={0.5} />

      {/* 2-alteration edges first (dim, dashed, behind) */}
      {twoEdges.map(e => (
        <Line key={e.key} points={e.points} color="#3a3a3a" lineWidth={1} dashed dashScale={20} gapSize={0.2} />
      ))}
      {/* 1-alteration edges (bright, solid, on top) */}
      {oneEdges.map(e => (
        <Line key={e.key} points={e.points} color="#7173e6" lineWidth={1.5} transparent opacity={0.55} />
      ))}

      {lattice.nodes.map(node => (
        <NodeMesh
          key={node.key}
          node={node}
          isAnchor={anchorKey === node.key}
          isActive={activeKey === node.key}
          isHovered={hoveredKey === node.key}
          alterationFromAnchor={anchor ? alterationFromAnchor(anchor, node) : null}
          onHover={onHover}
          onClick={onClick} />
      ))}

      <OrbitControls enableDamping dampingFactor={0.15} />
    </>
  );
}

export default function ModeLattice3D({ edo, rootPitch, anchorKey, playVol = 0.55, onActiveModeChange }: Props) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Stop drone on unmount.
  useEffect(() => {
    return () => {
      audioEngine.stopDrone();
    };
  }, []);

  // If anchor changes (user re-selects in the picker), stop the active
  // drone so we don't keep playing a stale scale.
  useEffect(() => {
    audioEngine.stopDrone();
    setActiveKey(null);
    onActiveModeChange?.(null);
  }, [anchorKey, onActiveModeChange]);

  const handleClick = useMemo(() => {
    return (node: ModeNode) => {
      // Toggle: clicking the active node stops the drone.
      if (activeKey === node.key) {
        audioEngine.stopDrone();
        setActiveKey(null);
        onActiveModeChange?.(null);
        return;
      }
      audioEngine.stopDrone();
      // Notes = the scale's step values offset to the user's root pitch.
      const notes = node.scale.map(s => rootPitch + s);
      // Boost the fundamental (step 0) so it reads clearly as "the root".
      const perNoteGains = node.scale.map(s => (s === 0 ? 1.6 : 0.85));
      audioEngine.startDrone(notes, edo, 0.06 * playVol * 4, perNoteGains);
      setActiveKey(node.key);
      onActiveModeChange?.(node);
    };
  }, [activeKey, edo, rootPitch, playVol, onActiveModeChange]);

  return (
    <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded overflow-hidden">
      <div className="px-3 py-2 flex items-center justify-between border-b border-[#1a1a1a]">
        <p className="text-[10px] tracking-wider font-semibold text-[#888]">
          MODE LATTICE — 49 modes, edges by alteration count
        </p>
        <div className="flex items-center gap-3 text-[9px] text-[#666]">
          <span><span style={{ color: "#7173e6" }}>━</span> 1 alt</span>
          <span><span style={{ color: "#3a3a3a" }}>┄</span> 2 alts</span>
          <span>↑ bright / ↓ dark</span>
        </div>
      </div>
      <div style={{ height: 480, background: "#0a0a0a" }}>
        <Canvas camera={{ position: [0, 0, 12], fov: 50 }}>
          <Scene
            anchorKey={anchorKey}
            activeKey={activeKey}
            hoveredKey={hoveredKey}
            onHover={setHoveredKey}
            onClick={handleClick}
            edo={edo} />
        </Canvas>
      </div>
      <div className="px-3 py-1.5 text-[9px] text-[#555] border-t border-[#1a1a1a] flex items-center gap-3">
        <span>Click a mode to drone its scale.  Click again to stop.</span>
        {activeKey && (
          <span style={{ color: "#9999ee" }}>
            playing: {formatHalfAccidentals(activeKey.split("::")[1])}
          </span>
        )}
      </div>
    </div>
  );
}
