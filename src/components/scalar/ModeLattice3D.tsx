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
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";
import { audioEngine } from "@/lib/audioEngine";
import {
  buildTonalityLattice, findLatticeNode, filterToAnchor, LATTICE_FAMILIES,
  type TonalityLattice, type LatticeNode,
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

interface NodeMeshProps {
  node: LatticeNode;
  isAnchor: boolean;
  isActive: boolean;
  isHovered: boolean;
  onHover: (id: string | null) => void;
  onClick: (node: LatticeNode) => void;
}

function NodeMesh({ node, isAnchor, isActive, isHovered, onHover, onClick }: NodeMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const baseColor = useMemo(() => new THREE.Color(node.family.color), [node.family.color]);
  const emissive = baseColor;

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const target = isActive ? 1.6 : isAnchor ? 1.4 : isHovered ? 1.2 : 1.0;
    const cur = meshRef.current.scale.x;
    meshRef.current.scale.setScalar(cur + (target - cur) * Math.min(1, delta * 8));
  });

  const r = isAnchor ? 0.18 : 0.13;
  const opacity = isAnchor || isActive || isHovered ? 1 : 0.85;

  return (
    <group position={node.pos}>
      <mesh
        ref={meshRef}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(node.id); }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onClick(node); }}>
        <sphereGeometry args={[r, 18, 14]} />
        <meshStandardMaterial
          color={baseColor}
          emissive={emissive}
          emissiveIntensity={isActive ? 0.9 : isAnchor ? 0.55 : 0.18}
          roughness={0.35}
          metalness={0.4}
          transparent={opacity < 1}
          opacity={opacity} />
      </mesh>
      {(isHovered || isActive || isAnchor) && (
        <Html center distanceFactor={8} style={{ pointerEvents: "none" }}>
          <div style={{
            background: "#0a0a0aee",
            border: `1px solid ${node.family.color}`,
            color: node.family.color,
            padding: "2px 6px",
            borderRadius: 3,
            fontSize: 11,
            fontWeight: 700,
            whiteSpace: "nowrap",
            transform: "translate(0, -22px)",
          }}>
            <span style={{ color: "#ddd", marginRight: 4 }}>{node.key.name}</span>
            {formatHalfAccidentals(node.mode.name)}
          </div>
        </Html>
      )}
    </group>
  );
}

interface SceneProps {
  lattice: TonalityLattice;
  anchorId: string | null;
  activeId: string | null;
  hoveredId: string | null;
  showFamilies: Record<string, boolean>;
  showEdges: Record<string, boolean>;
  onHover: (id: string | null) => void;
  onClick: (node: LatticeNode) => void;
}

function Scene({ lattice, anchorId, activeId, hoveredId, showFamilies, showEdges, onHover, onClick }: SceneProps) {
  // Edges grouped by type for separate render passes.
  const edgesByType = useMemo(() => {
    const out: Record<string, LatticeNode["pos"][]> = { x: [], y: [], z: [] };
    for (const e of lattice.edges) {
      const a = lattice.nodeMap.get(e.fromId);
      const b = lattice.nodeMap.get(e.toId);
      if (!a || !b) continue;
      if (!showFamilies[a.family.id] || !showFamilies[b.family.id]) continue;
      if (!showEdges[e.type]) continue;
      const arr = out[e.type];
      arr.push(a.pos);
      arr.push(b.pos);
    }
    return out;
  }, [lattice, showFamilies, showEdges]);

  // Build edge geometry.  We push pairs of points and let Line draw them.
  const xPts = edgesByType.x;
  const yPts = edgesByType.y;
  const zPts = edgesByType.z;

  return (
    <>
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} intensity={1.2} />
      <pointLight position={[-10, -5, -10]} intensity={0.7} />
      <pointLight position={[0, 0, 14]} intensity={0.6} />

      {/* X-edges (key fifths) — thin, dashed, low opacity */}
      {xPts.length > 1 && Array.from({ length: xPts.length / 2 }).map((_, i) => (
        <Line key={`x-${i}`}
          points={[xPts[i * 2], xPts[i * 2 + 1]]}
          color="#1f3146" lineWidth={0.8} dashed dashScale={30} gapSize={0.4}
          transparent opacity={0.4} />
      ))}

      {/* Y-edges (brightness within family) — family color, thin */}
      {yPts.length > 1 && Array.from({ length: yPts.length / 2 }).map((_, i) => {
        const a = yPts[i * 2];
        const b = yPts[i * 2 + 1];
        // Find which family by its position (z); we look up via the
        // y-pts come in family order, so just match z to a family color.
        const z = a[2];
        const fam = LATTICE_FAMILIES.find(f => Math.abs((f.zOrd - (LATTICE_FAMILIES.length - 1) / 2) * 1.5 - z) < 0.01);
        const color = fam?.color ?? "#445d7a";
        return (
          <Line key={`y-${i}`} points={[a, b]} color={color} lineWidth={1.0} transparent opacity={0.32} />
        );
      })}

      {/* Z-edges (cross-family, 1-alt) — bright accent */}
      {zPts.length > 1 && Array.from({ length: zPts.length / 2 }).map((_, i) => (
        <Line key={`z-${i}`}
          points={[zPts[i * 2], zPts[i * 2 + 1]]}
          color="#22ddaa" lineWidth={1.5} transparent opacity={0.55} />
      ))}

      {lattice.nodes.map(node => {
        if (!showFamilies[node.family.id]) return null;
        return (
          <NodeMesh
            key={node.id}
            node={node}
            isAnchor={anchorId === node.id}
            isActive={activeId === node.id}
            isHovered={hoveredId === node.id}
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

  // Family / edge visibility toggles.
  const [showFamilies, setShowFamilies] = useState<Record<string, boolean>>(
    Object.fromEntries(LATTICE_FAMILIES.map(f => [f.id, true]))
  );
  const [showEdges, setShowEdges] = useState<Record<string, boolean>>({
    x: true, y: true, z: true,
  });
  // Anchor-neighbourhood radius: 0 = anchor only, 1 = direct neighbours,
  // 2 = adds 2-hop, etc.  null = show full lattice (no filter).
  const [anchorHops, setAnchorHops] = useState<number | null>(2);

  const fullLattice = useMemo(() => buildTonalityLattice(edo), [edo]);

  // Resolve the user's selected tonality from the picker into a lattice
  // node so we can highlight it.  Look up against the FULL lattice
  // first — the filter step happens after.
  const fullAnchorId = useMemo(() => {
    if (!anchorKey) return null;
    const [familyName, modeName] = anchorKey.split("::");
    if (!familyName || !modeName) return null;
    const node = findLatticeNode(fullLattice, familyName, modeName, tonicPc);
    return node?.id ?? null;
  }, [fullLattice, anchorKey, tonicPc]);

  // Either show the whole lattice, or filter it down to "anchor's
  // neighbourhood within N hops" centred on the anchor.
  const lattice = useMemo(() => {
    if (anchorHops === null || !fullAnchorId) return fullLattice;
    return filterToAnchor(fullLattice, fullAnchorId, anchorHops);
  }, [fullLattice, fullAnchorId, anchorHops]);

  // After filtering, the anchor's id is unchanged but its position is
  // now at world origin.
  const anchorId = fullAnchorId;

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

  const handleClick = useCallback((node: LatticeNode) => {
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

  // Initial camera position scaled to the lattice extents — pull back
  // along +Z so the whole grid is visible from the front.
  const cameraPos = useMemo<[number, number, number]>(() => {
    const w = lattice.bounds.maxX - lattice.bounds.minX;
    const h = lattice.bounds.maxY - lattice.bounds.minY;
    const dist = Math.max(w, h) * 0.85;
    return [0, 0, dist + 8];
  }, [lattice]);

  return (
    <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded overflow-hidden">
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap border-b border-[#1a1a1a]">
        <p className="text-[10px] tracking-wider font-semibold text-[#888] mr-2">
          TONALITY LATTICE
          {anchorHops !== null && fullAnchorId
            ? ` · ANCHOR + ${anchorHops}-HOP NEIGHBOURHOOD (${lattice.nodes.length} NODES)`
            : ` · ALL ${lattice.nodes.length} NODES`}
        </p>
        {/* Anchor-radius selector */}
        <div className="flex items-center gap-1 mr-2">
          <span className="text-[8px] text-[#444]">RADIUS</span>
          {([1, 2, 3, null] as (number | null)[]).map((h, i) => (
            <button key={i}
              onClick={() => setAnchorHops(h)}
              className="text-[9px] px-2 py-0.5 rounded border transition-colors"
              style={{
                borderColor: anchorHops === h ? "#7173e6" : "#222",
                background: anchorHops === h ? "#1a1a2e" : "transparent",
                color: anchorHops === h ? "#9999ee" : "#444",
              }}>
              {h === null ? "all" : `${h}`}
            </button>
          ))}
        </div>
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
          { id: "x", label: "X · fifths",     color: "#1f3146" },
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
          <Scene
            lattice={lattice}
            anchorId={anchorId}
            activeId={activeId}
            hoveredId={hoveredId}
            showFamilies={showFamilies}
            showEdges={showEdges}
            onHover={setHoveredId}
            onClick={handleClick} />
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

      <div className="px-3 py-1.5 text-[9px] text-[#555] border-t border-[#1a1a1a] flex items-center gap-3">
        <span>Click any node to drone its tonality.  Drag to orbit, scroll to zoom.</span>
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
