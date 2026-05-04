/**
 * TemperamentExplorer — Interactive temperament visualization
 *
 * Sub-tabs:
 *   1. Temper Lab    — animated 3D lattice showing comma tempering in real-time
 *   2. EDO Temper    — per-EDO deep-dive: description, intervals, commas, bounds, audio
 *   3. Fifth Quality — convergence of fifths across EDOs
 *   4. Ring Map      — ring/cycle structure for all EDOs
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";

import {
  buildLattice,
  computeEdoRingPositions,
  intervalName as monzoIntervalName,
  ratioToCents,
  getProjections,
  factorize,
  analyzeQuotientGroup,
  PRIME_COLORS as MONZO_PRIME_COLORS,
  type LatticeConfig,
  type BuiltLattice,
  type CommaSpec,
} from "@/lib/latticeEngine";

import {
  COMMA_DB,
  TEMPER_SCENARIOS,
  EDO_DATA,
  getAllEDOs,
  TEMPERAMENT_FAMILIES,
  FIFTH_TUNING_FAMILIES,
  classifyFifthTuningFamily,
  groupEdosByFifthFamily,
  classifyCommasForEdo,
  getEdoIntervals,
  findCommaBasis,
  commasNeededForEdo,
  computeMinBoundsForCommas,
  commaMinBounds,
  type EDOData,
  type CommaInfo,
} from "@/lib/edoTemperamentData";

import { EDO_DESCRIPTIONS } from "@/lib/edoDescriptions";
import { audioEngine } from "@/lib/audioEngine";

// ═══════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════

function useTooltip() {
  const ref = useRef<HTMLDivElement>(null);
  const show = useCallback((text: string) => { if (ref.current) { ref.current.textContent = text; ref.current.style.opacity = "1"; } }, []);
  const hide = useCallback(() => { if (ref.current) ref.current.style.opacity = "0"; }, []);
  return { ref, show, hide };
}

function TooltipBar({ innerRef }: { innerRef: React.RefObject<HTMLDivElement | null> }) {
  return <div ref={innerRef} className="text-xs text-[#ccc] bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 min-h-[22px] transition-opacity duration-75" style={{ opacity: 0 }}>{"\u00A0"}</div>;
}

// ── Shared 3D helpers ──
function LatticeCameraReset({ resetKey, positions }: { resetKey: number; positions?: Map<string, [number, number, number]> }) {
  const { camera, controls } = useThree();
  const prevKey = useRef(resetKey);
  useEffect(() => {
    if (resetKey !== prevKey.current) {
      prevKey.current = resetKey;
      // Compute bounding sphere of all positions to set camera distance
      let maxR = 0;
      if (positions && positions.size > 0) {
        for (const [, p] of positions) {
          const r = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
          if (r > maxR) maxR = r;
        }
      }
      const dist = Math.max(12, maxR * 2.2);
      const h = dist * 0.6;
      camera.position.set(dist, h, dist);
      camera.lookAt(0, 0, 0);
      const c = controls as any;
      if (c?.target) { c.target.set(0, 0, 0); c.update?.(); }
    }
  }, [resetKey, camera, controls, positions]);
  return null;
}

function LatticeCameraFocus({ targetPos }: { targetPos: [number, number, number] | null }) {
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
    const t = 1 - Math.pow(1 - progress.current, 3);
    const delta = new THREE.Vector3().subVectors(goalTarget.current, startTarget.current).multiplyScalar(t);
    c.target.copy(startTarget.current).add(delta);
    camera.position.copy(startCamPos.current).add(delta);
    c.update?.();
    if (progress.current >= 1) animating.current = false;
  });
  return null;
}

function LatticeKeyboardPan() {
  const { controls, camera } = useThree();
  const pressed = useRef<Set<string>>(new Set());
  useState(() => {
    const d = (e: KeyboardEvent) => { if (e.key.startsWith("Arrow")) { e.preventDefault(); pressed.current.add(e.key); } };
    const u = (e: KeyboardEvent) => pressed.current.delete(e.key);
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
    if (pressed.current.has("ArrowLeft"))  d.addScaledVector(right, -0.4);
    if (pressed.current.has("ArrowRight")) d.addScaledVector(right,  0.4);
    if (pressed.current.has("ArrowUp"))    d.addScaledVector(up,     0.4);
    if (pressed.current.has("ArrowDown"))  d.addScaledVector(up,    -0.4);
    c.target.add(d);
    camera.position.add(d);
  });
  return null;
}

const C4_FREQ = 261.63;
let audioInited = false;
async function ensureAudio(edo: number) {
  if (!audioInited) { await audioEngine.init(edo); audioInited = true; } else { audioEngine.resume(); }
}

function PlayBtn({ onClick, title, small }: { onClick: () => void; title?: string; small?: boolean }) {
  return (
    <button onClick={onClick} title={title}
      className={`${small ? "w-5 h-5 text-[9px]" : "w-6 h-6 text-[10px]"} flex items-center justify-center rounded bg-[#1a2a1a] border border-[#2a4a2a] text-[#7aaa7a] hover:bg-[#2a3a2a] hover:text-[#aaffaa] transition-colors flex-shrink-0`}>
      ▶
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════

// "families" sub-tab removed per request — the FamiliesPanel component
// is still defined below for potential reuse but is no longer reachable
// from the SubTab UI.  Default sub-tab now opens directly on EDO Temper.
type SubTab = "edo-temper" | "fifth-quality" | "ring-map" | "theory";
const SUB_TAB_LABELS: Record<SubTab, string> = {
  "edo-temper": "EDO Temper",
  "fifth-quality": "Fifth Quality",
  "ring-map": "Ring Structure",
  "theory": "Theory",
};

export default function TemperamentExplorer() {
  const [subTab, setSubTab] = useState<SubTab>("edo-temper");
  const [selectedEdo, setSelectedEdo] = useState(12);

  const navigateToEdoTemper = useCallback((edo: number) => {
    setSelectedEdo(edo);
    setSubTab("edo-temper");
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex gap-1 px-3 py-2 bg-[#111] border-b border-[#222] flex-shrink-0 flex-wrap">
        {(Object.keys(SUB_TAB_LABELS) as SubTab[]).map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${subTab === t ? "bg-[#7173e6] text-white" : "bg-[#1a1a1a] text-[#888] hover:text-white border border-[#2a2a2a]"}`}>
            {SUB_TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {/* Families sub-tab removed; FamiliesPanel kept defined for reuse */}
        {subTab === "edo-temper" && <EdoTemper selectedEdo={selectedEdo} setSelectedEdo={setSelectedEdo} />}
        {subTab === "fifth-quality" && <FifthQuality onSelectEdo={navigateToEdoTemper} />}
        {subTab === "ring-map" && <RingMap onSelectEdo={navigateToEdoTemper} />}
        {subTab === "theory" && <TheoryPanel />}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Family-grouped EDO selector — used inside EDO Temper.
// Every EDO 5..99 falls into exactly one fifth-tuning family
// (or "Other" if its best-fifth lands outside any band).  Inside
// each family, EDOs sort by fifth cents narrow → wide.
// ═══════════════════════════════════════════════════════════════

function FamilyGroupedEdoSelector({
  selectedEdo, onPick,
}: { selectedEdo: number; onPick: (edo: number) => void }) {
  const allEdos = Array.from({ length: 95 }, (_, i) => i + 5);
  const groups = useMemo(() => groupEdosByFifthFamily(allEdos, EDO_DATA), []);
  return (
    <div className="bg-[#0e0e0e] border border-[#222] rounded p-3 space-y-2">
      <div className="text-[10px] text-[#888] uppercase tracking-wider mb-1">
        Fifth-tuning families
      </div>
      {groups.map(g => {
        const fam = g.family;
        const minF = fam ? fam.fifthRange[0] : 0;
        const maxF = fam ? fam.fifthRange[1] : 0;
        const rangeLabel = fam
          ? (minF === maxF ? `${minF.toFixed(1)} ¢` : `${minF.toFixed(1)}–${maxF.toFixed(1)} ¢`)
          : "outside spectrum";
        return (
          <div key={fam?.name ?? "other"} className="border-l-2 border-[#2a2a4a] pl-2.5">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-xs font-semibold text-[#cfe6ff]">
                {fam?.name ?? "Other"}
              </span>
              <span className="text-[10px] text-[#666] font-mono">5th: {rangeLabel}</span>
            </div>
            {fam?.blurb && (
              <div className="text-[10px] text-[#777] leading-snug mb-1.5">{fam.blurb}</div>
            )}
            <div className="flex gap-1 flex-wrap">
              {g.edos.map(({ edo, fifthCents }) => (
                <button key={edo} onClick={() => onPick(edo)}
                  title={`${edo}-EDO · 5th = ${fifthCents.toFixed(2)} ¢`}
                  className={`px-2 py-0.5 text-[10px] rounded font-mono border ${
                    selectedEdo === edo
                      ? "bg-[#7173e6] text-white border-[#7173e6]"
                      : "bg-[#1a1a1a] text-[#aaa] border-[#2a2a2a] hover:text-white hover:border-[#3a3a5a]"
                  }`}>
                  {edo}
                  <span className="text-[8px] text-[#888] ml-1">{fifthCents.toFixed(1)}¢</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Fifth-tuning Families panel
// ═══════════════════════════════════════════════════════════════

function FamiliesPanel({ onSelectEdo }: { onSelectEdo: (edo: number) => void }) {
  return (
    <div className="px-4 py-4 max-w-5xl mx-auto">
      <h2 className="text-sm font-semibold text-[#aaa] tracking-wider uppercase mb-2">
        Diatonic spectrum of fifth tunings
      </h2>
      <p className="text-xs text-[#888] mb-5 leading-relaxed">
        Each EDO sits in exactly one fifth-tuning family based on the size of
        its best fifth.  Bands run from narrow (top) to wide (bottom) — the
        same ordering used in the Xenharmonic Wiki classification.  Click any
        EDO to open its full breakdown in EDO Temper.
      </p>
      <div className="space-y-4">
        {FIFTH_TUNING_FAMILIES.map(fam => {
          const minF = fam.fifthRange[0];
          const maxF = fam.fifthRange[1];
          const rangeLabel = minF === maxF
            ? `${minF.toFixed(1)} ¢`
            : `${minF.toFixed(1)}–${maxF.toFixed(1)} ¢`;
          return (
            <div key={fam.name}
                 className="bg-[#0e0e0e] border border-[#222] rounded p-3">
              <div className="flex items-baseline gap-2 flex-wrap mb-1">
                <h3 className="text-sm font-semibold text-[#cfe6ff]">{fam.name}</h3>
                <span className="text-[10px] text-[#666] font-mono">5th: {rangeLabel}</span>
              </div>
              <p className="text-xs text-[#aaa] leading-relaxed mb-2">{fam.blurb}</p>
              <p className="text-[11px] text-[#777] leading-relaxed mb-3">{fam.description}</p>
              <div className="flex gap-1.5 flex-wrap">
                {fam.edos.map(edo => {
                  const data = EDO_DATA.get(edo);
                  const fifthC = data?.ring.fifthCents.toFixed(1) ?? "—";
                  return (
                    <button key={edo} onClick={() => onSelectEdo(edo)}
                      title={`${edo}-TET · 5th = ${fifthC} ¢`}
                      className="px-2.5 py-1 rounded bg-[#1a1a1a] hover:bg-[#252550] border border-[#2a2a2a] hover:border-[#7173e6] transition-colors">
                      <span className="text-xs font-semibold text-[#ddd]">{edo}-TET</span>
                      <span className="text-[9px] text-[#666] ml-1.5 font-mono">{fifthC}¢</span>
                    </button>
                  );
                })}
                {fam.jiAnchors?.map(a => (
                  <span key={a.name}
                    className="px-2.5 py-1 rounded bg-[#0a0a0a] border border-[#1a1a1a] italic">
                    <span className="text-xs text-[#888]">{a.name}</span>
                    <span className="text-[9px] text-[#555] ml-1.5 font-mono">{a.cents.toFixed(2)}¢</span>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 1. TEMPER LAB
// ═══════════════════════════════════════════════════════════════

function TemperLab() {
  const [mode, setMode] = useState<"scenario" | "edo">("scenario");
  const [scenarioIdx, setScenarioIdx] = useState(0);
  const [selectedEdo, setSelectedEdo] = useState(12);
  const [activeCommaCount, setActiveCommaCount] = useState(0);
  const [animProgress, setAnimProgress] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [showEdges, setShowEdges] = useState(true);
  const [includePrime2, setIncludePrime2] = useState(false);

  const scenario = TEMPER_SCENARIOS[scenarioIdx];
  const edoData = EDO_DATA.get(selectedEdo);
  const edoCommaSeq: CommaSpec[] = useMemo(() =>
    edoData?.commasTempered.map(c => ({ n: c.n, d: c.d, name: c.name })) ?? [], [edoData]);

  const { primes, bounds, commaSequence } = useMemo(() => {
    if (mode === "scenario") {
      const sp = includePrime2 && !scenario.primes.includes(2) ? [2, ...scenario.primes] : scenario.primes;
      const sb = { ...scenario.bounds }; if (includePrime2 && !sb[2]) sb[2] = [-1, 1];
      return { primes: sp, bounds: sb, commaSequence: scenario.commaSequence };
    }
    const primesSet = new Set<number>();
    for (const c of edoCommaSeq) { const info = COMMA_DB.find(db => db.n === c.n && db.d === c.d); if (info) info.primes.forEach(p => { if (p !== 2) primesSet.add(p); }); }
    if (primesSet.size === 0) { primesSet.add(3); primesSet.add(5); }
    const nonTwo = Array.from(primesSet).sort((a, b) => a - b).slice(0, 3);
    const p = includePrime2 ? [2, ...nonTwo] : nonTwo;
    const b: Record<number, [number, number]> = {};
    if (includePrime2) b[2] = [-1, 1];
    if (nonTwo.length === 1) { const h = Math.min(Math.floor(selectedEdo / 2), 8); b[nonTwo[0]] = [-h, h]; }
    else if (nonTwo.length === 2) { b[nonTwo[0]] = [-5, 5]; b[nonTwo[1]] = [-3, 3]; }
    else { b[nonTwo[0]] = [-4, 4]; b[nonTwo[1]] = [-2, 2]; b[nonTwo[2]] = [-1, 1]; }
    const ps = new Set(p); const useOE = !includePrime2;
    const safe = edoCommaSeq.filter(c => { const info = COMMA_DB.find(db => db.n === c.n && db.d === c.d); if (!info) return false; return useOE ? info.primes.every(pr => pr === 2 || ps.has(pr)) : info.primes.every(pr => ps.has(pr)); });
    const picked: CommaSpec[] = []; const covered = new Set<number>();
    for (const c of safe) { if (picked.length >= p.length) break; const info = COMMA_DB.find(db => db.n === c.n && db.d === c.d); const rel = info ? (useOE ? info.primes.filter(pr => pr !== 2) : info.primes) : []; if (rel.some(pr => !covered.has(pr)) || !picked.length) { picked.push(c); rel.forEach(pr => covered.add(pr)); } }
    for (const c of safe) { if (picked.length >= p.length) break; if (!picked.some(pc => pc.n === c.n && pc.d === c.d)) picked.push(c); }
    return { primes: p, bounds: b, commaSequence: picked };
  }, [mode, scenario, selectedEdo, edoCommaSeq, includePrime2]);

  const cfg: LatticeConfig = useMemo(() => ({
    primes, bounds, octaveEquivalence: !includePrime2, showPrime2: includePrime2,
    projections: getProjections("triangle"), temperedCommas: [], gridType: "triangle" as const,
  }), [primes, bounds, includePrime2]);
  const uLat = useMemo(() => buildLattice(cfg), [cfg]);
  const tLats = useMemo(() => {
    const r: BuiltLattice[] = [uLat];
    for (let i = 0; i < commaSequence.length; i++) {
      const built = buildLattice({ ...cfg, temperedCommas: commaSequence.slice(0, i + 1) });
      // Use coset positions so equivalent nodes cluster visibly instead of collapsing
      r.push({ ...built, positions: built.cosetPositions });
    }
    return r;
  }, [cfg, commaSequence, uLat]);
  const from = tLats[activeCommaCount];
  const to = tLats[Math.min(activeCommaCount + (isAnimating ? 1 : 0), tLats.length - 1)];

  const addComma = useCallback(() => { if (activeCommaCount < commaSequence.length) { setIsAnimating(true); setAnimProgress(0); } }, [activeCommaCount, commaSequence.length]);
  const allCommas = useCallback(() => { setActiveCommaCount(commaSequence.length); setAnimProgress(0); setIsAnimating(false); }, [commaSequence.length]);
  const reset = useCallback(() => { setActiveCommaCount(0); setAnimProgress(0); setIsAnimating(false); }, []);
  const onDone = useCallback(() => { setActiveCommaCount(p => p + 1); setAnimProgress(0); setIsAnimating(false); }, []);
  const next = commaSequence[activeCommaCount];

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <div className="px-4 py-3 bg-[#0d0d0d] border-b border-[#1e1e1e] flex-shrink-0 space-y-2 max-h-[40vh] overflow-y-auto">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1">
            <button onClick={() => { setMode("scenario"); reset(); }} className={`px-2 py-1 text-xs rounded ${mode === "scenario" ? "bg-[#7173e6] text-white" : "bg-[#1a1a1a] text-[#888] border border-[#2a2a2a]"}`}>Scenarios</button>
            <button onClick={() => { setMode("edo"); reset(); }} className={`px-2 py-1 text-xs rounded ${mode === "edo" ? "bg-[#7173e6] text-white" : "bg-[#1a1a1a] text-[#888] border border-[#2a2a2a]"}`}>Per-EDO</button>
          </div>
          {mode === "scenario"
            ? <select value={scenarioIdx} onChange={e => { setScenarioIdx(+e.target.value); reset(); }} className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none max-w-xs">{TEMPER_SCENARIOS.map((s, i) => <option key={i} value={i}>{s.name}</option>)}</select>
            : <select value={selectedEdo} onChange={e => { setSelectedEdo(+e.target.value); reset(); }} className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">{Array.from({ length: 95 }, (_, i) => i + 5).map(n => <option key={n} value={n}>{n}-EDO ({EDO_DATA.get(n)?.commasTempered.length ?? 0})</option>)}</select>}
          <div className="flex items-center gap-2 ml-auto">
            <label className="text-xs text-[#666] flex items-center gap-1"><input type="checkbox" checked={includePrime2} onChange={e => { setIncludePrime2(e.target.checked); reset(); }} className="accent-[#ff4488]" /> Prime 2</label>
            <label className="text-xs text-[#666] flex items-center gap-1"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-[#7173e6]" /> Labels</label>
            <label className="text-xs text-[#666] flex items-center gap-1"><input type="checkbox" checked={showEdges} onChange={e => setShowEdges(e.target.checked)} className="accent-[#7173e6]" /> Edges</label>
          </div>
        </div>
        {mode === "scenario" && <p className="text-xs text-[#999] leading-relaxed">{scenario.description}</p>}
        <div className="flex items-center gap-3 text-[10px] text-[#555] font-mono flex-wrap">
          <span className="text-[#666] font-sans font-medium">Axes:</span>
          {primes.map(p => <span key={p} style={{ color: MONZO_PRIME_COLORS[p] ?? "#888" }}>{p}[{bounds[p]?.[0]},{bounds[p]?.[1]}]</span>)}
          {includePrime2 && <span className="text-[#886644] font-sans text-[9px] italic">— octave axis on</span>}
        </div>
        {commaSequence.length > 0 ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-[#666] font-medium">Commas:</span>
            {commaSequence.map((c, i) => <span key={i} className={`px-2 py-0.5 rounded text-[10px] font-mono ${i < activeCommaCount ? "bg-[#2a4a2a] text-[#7aaa7a] border border-[#3a6a3a]" : i === activeCommaCount ? "bg-[#3a2a1a] text-[#ddaa55] border border-[#5a4a2a]" : "bg-[#1a1a1a] text-[#555] border border-[#2a2a2a]"}`}>{c.n}/{c.d}</span>)}
            <div className="ml-auto flex gap-2">
              <button onClick={addComma} disabled={activeCommaCount >= commaSequence.length || isAnimating} className="px-3 py-1 rounded text-xs font-medium bg-[#7173e6] text-white disabled:opacity-30 disabled:cursor-not-allowed">{isAnimating ? "Tempering..." : next ? `Temper ${next.n}/${next.d}` : "Done"}</button>
              {commaSequence.length > 1 && activeCommaCount < commaSequence.length && <button onClick={allCommas} className="px-3 py-1 rounded text-xs bg-[#3a3a1a] text-[#ddaa55] border border-[#5a4a2a]">All</button>}
              <button onClick={reset} className="px-3 py-1 rounded text-xs bg-[#2a1a1a] text-[#cc6666] border border-[#5a2a2a]">Reset</button>
            </div>
          </div>
        ) : <div className="text-xs text-[#666] italic">No compatible commas for these primes/bounds.</div>}
        <div className="flex items-center gap-4 text-xs text-[#555]">
          <span>Nodes: {from.nodes.length}</span>
          <span>Classes: {from.temperingClasses || "—"}</span>
          {mode === "scenario" && scenario.resultEdos.length > 0 && activeCommaCount === commaSequence.length && <span className="text-[#7aaa7a]">EDOs: {scenario.resultEdos.join(", ")}</span>}
        </div>
      </div>
      <div className="flex-1 min-h-0 bg-[#080808]">
        <Canvas camera={{ position: [12, 8, 12], fov: 55, near: 0.1, far: 500 }}>
          <ambientLight intensity={0.7} /><pointLight position={[10, 20, 10]} intensity={1.0} /><pointLight position={[-10, -5, -10]} intensity={0.3} />
          <Scene from={from} to={to} animating={isAnimating} progress={animProgress} setProgress={setAnimProgress} onDone={onDone} labels={showLabels} edges={showEdges} />
          <OrbitControls makeDefault enableDamping dampingFactor={0.1} />

        </Canvas>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 3D Scene
// ═══════════════════════════════════════════════════════════════

function Scene({ from, to, animating, progress, setProgress, onDone, labels, edges, highlightClass, classColorOverride, onFocus, onNodeClick, activeDroneKeys, visibleKeys, embedLabels, showKernel, showFundamentalDomain }: {
  from: BuiltLattice; to: BuiltLattice; animating: boolean; progress: number;
  setProgress: (p: number) => void; onDone: () => void; labels: boolean; edges: boolean;
  highlightClass?: number | null; classColorOverride?: Map<number, string>; onFocus?: (key: string) => void;
  onNodeClick?: (key: string, n: number, d: number) => void; activeDroneKeys?: Set<string>;
  /** If set, only render nodes whose key is in this set */
  visibleKeys?: Set<string>;
  /** If set, override labels with embed info (step, cents, freq) */
  embedLabels?: Map<string, { step: number; cents: string; freq: string }>;
  /** Show comma direction arrows (kernel vectors) */
  showKernel?: boolean;
  /** Show fundamental domain parallelogram */
  showFundamentalDomain?: boolean;
}) {
  const pRef = useRef(0);
  useFrame((_, dt) => { if (!animating) return; pRef.current = Math.min(pRef.current + dt * 0.6, 1); setProgress(pRef.current); if (pRef.current >= 1) { pRef.current = 0; onDone(); } });
  useEffect(() => { if (animating) pRef.current = 0; }, [animating]);

  const ease = (t: number) => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
  const positions = useMemo(() => {
    const m = new Map<string, [number, number, number]>(); const t = animating ? ease(progress) : 0;
    for (const n of from.nodes) { const fp = from.positions.get(n.key), tp = to.positions.get(n.key); if (fp && tp) m.set(n.key, [fp[0]+(tp[0]-fp[0])*t, fp[1]+(tp[1]-fp[1])*t, fp[2]+(tp[2]-fp[2])*t]); else if (fp) m.set(n.key, fp); }
    return m;
  }, [from, to, progress, animating]);

  const defaultColors = ["#e06060","#60e060","#6060e0","#e0e060","#e060e0","#60e0e0","#ff8844","#44ff88","#8844ff","#ffaa66","#66ffaa","#aa66ff","#ff6688","#88ff66","#6688ff"];
  const classColors = useMemo(() => {
    if (classColorOverride && classColorOverride.size > 0) return classColorOverride;
    const m = new Map<number, string>(); let i = 0; const tgt = animating ? to : from;
    for (const [, id] of tgt.classMap) { if (!m.has(id)) { m.set(id, defaultColors[i % defaultColors.length]); i++; } }
    return m;
  }, [from, to, animating, classColorOverride]);

  const reps = useMemo(() => {
    const s = new Set<string>(); const tgt = animating ? to : from;
    const mem = new Map<number, string[]>();
    for (const [k, id] of tgt.classMap) { if (!mem.has(id)) mem.set(id, []); mem.get(id)!.push(k); }
    for (const [, ms] of mem) { let b = ms[0], bs = Infinity; for (const k of ms) { const [n, d] = k.split("/").map(Number); if (n+d < bs) { bs = n+d; b = k; } } s.add(b); }
    return s;
  }, [from, to, animating]);

  const labelSet = useMemo(() => {
    if (!labels) return new Set<string>(); const tgt = animating ? to : from;
    if (highlightClass != null) {
      // When a class is highlighted, show labels for all its members
      const s = new Set<string>();
      for (const [k, id] of tgt.classMap) { if (id === highlightClass) s.add(k); }
      return s;
    }
    if (tgt.classMap.size > 0) return reps;
    return new Set([...from.nodes].sort((a, b) => (a.monzo.n+a.monzo.d) - (b.monzo.n+b.monzo.d)).slice(0, 40).map(n => n.key));
  }, [labels, from, to, animating, reps, highlightClass]);

  const [hov, setHov] = useState<string | null>(null);

  const filteredNodes = useMemo(() =>
    visibleKeys ? from.nodes.filter(n => visibleKeys.has(n.key)) : from.nodes,
    [from.nodes, visibleKeys],
  );

  return (
    <>
      {filteredNodes.map(node => {
        const pos = positions.get(node.key); if (!pos || !isFinite(pos[0]) || !isFinite(pos[1]) || !isFinite(pos[2])) return null;
        const tgt = animating ? to : from; const tc = tgt.classMap.get(node.key);
        const isR = reps.has(node.key); const isH = hov === node.key;
        const isU = node.monzo.n === 1 && node.monzo.d === 1;
        const mg = animating && tc !== undefined;
        const isEmbed = !!embedLabels;
        const r = isEmbed ? 0.28 : node.monzo.isComma ? 0.10 : 0.18;
        const isDroning = activeDroneKeys?.has(`ring-${node.key}`);
        let c = "#4a4a5a"; if (isU) c = "#9395ea"; else if (tc !== undefined) c = classColors.get(tc) ?? c; else if (node.monzo.isComma) c = "#664455";
        const ei = mg ? 0.3 + progress * 0.5 : isDroning ? 0.8 : isH ? 0.4 : (highlightClass != null && tc === highlightClass) ? 0.5 : isEmbed ? 0.3 : 0.05;
        const isHighlighted = highlightClass != null && tc === highlightClass;
        const isDimmedByHighlight = highlightClass != null && tc !== highlightClass;
        const nodeOpacity = isDimmedByHighlight ? 0.08 : (!isR && tc !== undefined && !animating && !isEmbed ? 0.5 : 1);
        const nodeScale = mg ? 1+progress*0.3 : isH ? 1.4 : isDroning ? 1.5 : isHighlighted ? 1.3 : 1;
        const el = embedLabels?.get(node.key);
        return (
          <group key={node.key} position={pos}>
            <mesh scale={nodeScale} onPointerOver={() => setHov(node.key)} onPointerOut={() => setHov(null)} onClick={(e) => { e.stopPropagation(); if (e.nativeEvent.shiftKey && onFocus) { onFocus(node.key); } else if (onNodeClick) { onNodeClick(node.key, node.monzo.n, node.monzo.d); } }}>
              <sphereGeometry args={[r, 12, 8]} />
              <meshStandardMaterial color={c} emissive={c} emissiveIntensity={ei} transparent opacity={nodeOpacity} />
            </mesh>
            {el ? (
              /* Embed stage: show step number + cents + freq */
              <Html center style={{ pointerEvents: "none", userSelect: "none" }} position={[0, r + 0.3, 0]}>
                <div className="text-center whitespace-nowrap" style={{ transform: "scale(0.9)" }}>
                  <div className="text-[14px] font-bold font-mono" style={{ color: classColors.get(tc!) ?? "#bbb", textShadow: "0 0 6px #000" }}>{el.step}</div>
                  <div className="text-[10px] font-bold font-mono" style={{ color: "#7aaa7a", textShadow: "0 0 4px #000" }}>{el.cents}¢</div>
                  <div className="text-[8px] font-mono" style={{ color: "#888", textShadow: "0 0 3px #000" }}>{el.freq} Hz</div>
                  <div className="text-[8px]" style={{ color: "#666", textShadow: "0 0 3px #000" }}>{node.key}</div>
                </div>
              </Html>
            ) : (labelSet.has(node.key) || isH) ? (
              <Html center style={{ pointerEvents: "none", userSelect: "none" }} position={[0, r + 0.2, 0]}>
                <div className="text-center whitespace-nowrap" style={{ transform: "scale(0.8)" }}>
                  <div className="text-[11px] font-bold" style={{ color: isU ? "#bbc" : (tc !== undefined ? classColors.get(tc) ?? "#aaa" : "#bbb"), textShadow: "0 0 4px #000" }}>{node.key}</div>
                  <div className="text-[9px] text-[#999]" style={{ textShadow: "0 0 3px #000" }}>{monzoIntervalName(node.monzo.n, node.monzo.d)}</div>
                  <div className="text-[8px] text-[#666] font-mono">{ratioToCents(node.monzo.n, node.monzo.d).toFixed(0)}¢</div>
                </div>
              </Html>
            ) : null}
          </group>
        );
      })}
      {edges && from.edges.map((e, i) => {
        const fp = positions.get(e.from), tp = positions.get(e.to); if (!fp || !tp) return null;
        const tgt = animating ? to : from;
        const edgeDimmed = highlightClass != null && tgt.classMap.get(e.from) !== highlightClass && tgt.classMap.get(e.to) !== highlightClass;
        return <Line key={`e${i}`} points={[fp, tp]} color={e.type === "tempered" ? "#ff6644" : (MONZO_PRIME_COLORS[e.prime] ?? "#444")} lineWidth={e.type === "tempered" ? 2 : 1.5} transparent opacity={edgeDimmed ? 0.05 : (e.type === "tempered" ? 0.6 : 0.55)} />;
      })}
      {animating && to.edges.filter(e => e.type === "tempered").map((e, i) => {
        const fp = positions.get(e.from), tp = positions.get(e.to); if (!fp || !tp) return null;
        return <Line key={`t${i}`} points={[fp, tp]} color="#ff6644" lineWidth={2} transparent opacity={progress * 0.8} dashed dashSize={0.15} gapSize={0.1} />;
      })}
      {/* Kernel direction arrows — show which lattice directions commas collapse */}
      {showKernel && (animating ? to : from).commaDirections.map((cd, i) => {
        const len = 4;
        const start: [number, number, number] = [-cd.dir[0] * len, -cd.dir[1] * len, -cd.dir[2] * len];
        const end: [number, number, number] = [cd.dir[0] * len, cd.dir[1] * len, cd.dir[2] * len];
        return (
          <group key={`kernel-${i}`}>
            <Line points={[start, end]} color="#ff4466" lineWidth={3} transparent opacity={0.6} dashed dashSize={0.2} gapSize={0.12} />
            {/* Arrow tip */}
            <mesh position={end}>
              <sphereGeometry args={[0.15, 8, 6]} />
              <meshStandardMaterial color="#ff4466" emissive="#ff4466" emissiveIntensity={0.5} transparent opacity={0.7} />
            </mesh>
            <Html center position={[end[0] + cd.dir[0] * 0.5, end[1] + cd.dir[1] * 0.5 + 0.3, end[2] + cd.dir[2] * 0.5]} style={{ pointerEvents: "none" }}>
              <div className="text-[9px] font-mono whitespace-nowrap" style={{ color: "#ff6688", textShadow: "0 0 4px #000" }}>
                ker: {cd.name}
              </div>
            </Html>
          </group>
        );
      })}
      {/* Fundamental domain — parallelogram showing one representative per coset */}
      {showFundamentalDomain && (() => {
        const tgt = animating ? to : from;
        const fd = tgt.fundamentalDomain;
        if (!fd || fd.length < 2) return null;
        if (fd.length === 2) {
          // Line segment (rank-1 temperament generator)
          return <Line points={fd} color="#44ddaa" lineWidth={3} transparent opacity={0.5} />;
        }
        if (fd.length === 4) {
          // Parallelogram — draw as closed loop
          const closed = [...fd, fd[0]];
          return (
            <>
              <Line points={closed} color="#44ddaa" lineWidth={2.5} transparent opacity={0.5} />
              {/* Diagonal lines to show the domain area */}
              <Line points={[fd[0], fd[2]]} color="#44ddaa" lineWidth={1} transparent opacity={0.2} />
              <Line points={[fd[1], fd[3]]} color="#44ddaa" lineWidth={1} transparent opacity={0.2} />
              <Html center position={[(fd[0][0]+fd[2][0])/2, (fd[0][1]+fd[2][1])/2 + 0.4, (fd[0][2]+fd[2][2])/2]} style={{ pointerEvents: "none" }}>
                <div className="text-[9px] font-mono" style={{ color: "#44ddaa", textShadow: "0 0 4px #000" }}>
                  fundamental domain
                </div>
              </Html>
            </>
          );
        }
        return null;
      })()}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// Consistency & Zeta visualizations
// ═══════════════════════════════════════════════════════════════

/** Visual breakdown of odd-limit consistency */
function ConsistencyViz({ edo, consistencyLimit }: { edo: number; consistencyLimit: number }) {
  const stepCents = 1200 / edo;
  const bestMap = (ratio: number) => Math.round(1200 * Math.log2(ratio) / stepCents);

  // Build the odd numbers up to the consistency limit
  const odds: number[] = [];
  for (let i = 1; i <= consistencyLimit; i += 2) odds.push(i);

  // Check consistency for each pair and build a matrix
  const matrix = useMemo(() => {
    const rows: { a: number; b: number; ratio: string; jiCents: number; mapDirect: number; mapIndirect: number; consistent: boolean }[] = [];
    for (let i = 0; i < odds.length; i++) {
      for (let j = i + 1; j < odds.length; j++) {
        const a = odds[j], b = odds[i]; // larger / smaller
        const mapA = bestMap(a), mapB = bestMap(b);
        const mapRatio = bestMap(a / b);
        const consistent = mapRatio === (mapA - mapB);
        const jiCents = 1200 * Math.log2(a / b);
        rows.push({ a, b, ratio: `${a}/${b}`, jiCents, mapDirect: mapRatio, mapIndirect: mapA - mapB, consistent });
      }
    }
    return rows;
  }, [edo, consistencyLimit]);

  // Also check what fails at the next odd limit
  const nextLimit = consistencyLimit + 2;
  const nextOdds = [...odds, nextLimit];
  const failedPairs = useMemo(() => {
    const fails: { ratio: string; mapDirect: number; mapIndirect: number }[] = [];
    for (let i = 0; i < nextOdds.length; i++) {
      for (let j = i + 1; j < nextOdds.length; j++) {
        const a = nextOdds[j], b = nextOdds[i];
        const mapA = bestMap(a), mapB = bestMap(b);
        const mapRatio = bestMap(a / b);
        if (mapRatio !== (mapA - mapB)) {
          fails.push({ ratio: `${a}/${b}`, mapDirect: mapRatio, mapIndirect: mapA - mapB });
        }
      }
    }
    return fails;
  }, [edo, consistencyLimit]);

  // Visual: grid showing each odd number's best mapping
  const oddMappings = odds.map(o => ({ odd: o, steps: bestMap(o), cents: (bestMap(o) * stepCents), jiCents: 1200 * Math.log2(o), error: bestMap(o) * stepCents - 1200 * Math.log2(o) }));

  return (
    <div className="bg-[#0d1a0d] border border-[#2a4a2a] rounded-lg p-3 space-y-3">
      <div className="text-[10px] text-[#7aaa7a] font-medium">
        {consistencyLimit}-odd consistent: all ratios of odd numbers up to {consistencyLimit} map correctly
      </div>

      {/* Odd number mappings */}
      <div className="space-y-1">
        <div className="text-[9px] text-[#666] font-medium">Odd harmonics and their best EDO mapping</div>
        <div className="flex gap-1.5 flex-wrap">
          {oddMappings.map(m => {
            const absErr = Math.abs(m.error);
            const errColor = absErr < 5 ? "#4a8a4a" : absErr < 15 ? "#aa8833" : "#aa3333";
            return (
              <div key={m.odd} className="flex flex-col items-center gap-0.5 px-1.5 py-1 rounded bg-[#111] border border-[#1e1e1e]">
                <span className="text-[11px] font-mono font-bold text-[#bbb]">{m.odd}</span>
                <span className="text-[9px] font-mono text-[#9395ea]">{m.steps}s</span>
                <div className="w-full h-[3px] rounded-full" style={{ backgroundColor: "#1a1a1a" }}>
                  <div className="h-full rounded-full" style={{
                    width: `${Math.min(100, (absErr / (stepCents / 2)) * 100)}%`,
                    backgroundColor: errColor,
                  }} />
                </div>
                <span className="text-[8px] font-mono" style={{ color: errColor }}>{m.error > 0 ? "+" : ""}{m.error.toFixed(1)}¢</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Consistency grid — show pairs as a triangle matrix */}
      <div className="space-y-1">
        <div className="text-[9px] text-[#666] font-medium">
          Pair consistency: map({`a/b`}) = map({`a`}) − map({`b`})?
        </div>
        <div className="overflow-x-auto">
          <table className="border-collapse text-[9px]">
            <thead>
              <tr>
                <th className="px-1 py-0.5 text-[#555]"></th>
                {odds.slice(0, -1).map(b => (
                  <th key={b} className="px-1.5 py-0.5 text-[#888] font-mono font-bold">{b}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {odds.slice(1).map((a, ai) => (
                <tr key={a}>
                  <td className="px-1 py-0.5 text-[#888] font-mono font-bold text-right">{a}</td>
                  {odds.slice(0, ai + 1).map(b => {
                    const pair = matrix.find(m => m.a === a && m.b === b);
                    if (!pair) return <td key={b} />;
                    return (
                      <td key={b} className="px-1.5 py-0.5 text-center rounded"
                        style={{ backgroundColor: pair.consistent ? "#1a2a1a" : "#2a1a1a" }}
                        title={`${pair.ratio}: direct=${pair.mapDirect}s, indirect=${pair.mapIndirect}s — ${pair.jiCents.toFixed(1)}¢ JI`}>
                        <span style={{ color: pair.consistent ? "#7aaa7a" : "#cc4444" }}>
                          {pair.consistent ? "✓" : "✗"}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* What fails at the next limit — visual breakdown */}
      {failedPairs.length > 0 && (
        <div className="space-y-2 border-t border-[#2a1a1a] pt-2">
          <div className="text-[10px] font-medium text-[#cc6644]">
            Breaks at {nextLimit}-odd — {failedPairs.length} inconsistent pair{failedPairs.length > 1 ? "s" : ""}
          </div>
          <div className="space-y-1.5">
            {failedPairs.slice(0, 8).map(f => {
              const lo = Math.min(f.mapDirect, f.mapIndirect);
              const hi = Math.max(f.mapDirect, f.mapIndirect);
              const range = hi + 2; // padding
              const [num, den] = f.ratio.split("/").map(Number);
              const jiCents = 1200 * Math.log2(num / den);
              const directCents = f.mapDirect * stepCents;
              const indirectCents = f.mapIndirect * stepCents;
              const directErr = directCents - jiCents;
              const indirectErr = indirectCents - jiCents;
              return (
                <div key={f.ratio} className="bg-[#1a1010] border border-[#3a2020] rounded px-2 py-1.5">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-mono font-bold text-[#dda070]">{f.ratio}</span>
                    <span className="text-[8px] text-[#666]">{jiCents.toFixed(1)}¢ JI</span>
                  </div>
                  {/* Number line showing where direct and indirect land */}
                  <div className="relative h-[22px] mx-1">
                    {/* Step tick marks */}
                    {Array.from({ length: hi - lo + 3 }, (_, k) => lo - 1 + k).filter(s => s >= 0).map(s => {
                      const pct = ((s - lo + 1) / (hi - lo + 2)) * 100;
                      const isConflict = s === f.mapDirect || s === f.mapIndirect;
                      return (
                        <div key={s} className="absolute flex flex-col items-center" style={{ left: `${pct}%`, transform: "translateX(-50%)" }}>
                          <div className="w-[1px] h-[10px]" style={{ backgroundColor: isConflict ? "#555" : "#2a2a2a" }} />
                          <span className="text-[7px] font-mono" style={{ color: isConflict ? "#888" : "#333" }}>{s}</span>
                        </div>
                      );
                    })}
                    {/* Direct marker */}
                    <div className="absolute top-0 flex flex-col items-center" style={{
                      left: `${((f.mapDirect - lo + 1) / (hi - lo + 2)) * 100}%`,
                      transform: "translateX(-50%)"
                    }}>
                      <div className="w-[8px] h-[8px] rounded-full border-2" style={{
                        borderColor: "#ee8855", backgroundColor: "#ee885540"
                      }} />
                    </div>
                    {/* Indirect marker */}
                    <div className="absolute top-0 flex flex-col items-center" style={{
                      left: `${((f.mapIndirect - lo + 1) / (hi - lo + 2)) * 100}%`,
                      transform: "translateX(-50%)"
                    }}>
                      <div className="w-[8px] h-[8px] rounded-sm border-2" style={{
                        borderColor: "#9977cc", backgroundColor: "#9977cc40"
                      }} />
                    </div>
                    {/* Conflict arrow between the two */}
                    <div className="absolute top-[3px]" style={{
                      left: `${((Math.min(f.mapDirect, f.mapIndirect) - lo + 1) / (hi - lo + 2)) * 100}%`,
                      width: `${((Math.abs(f.mapDirect - f.mapIndirect)) / (hi - lo + 2)) * 100}%`,
                    }}>
                      <div className="h-[2px] w-full" style={{ background: "linear-gradient(90deg, #ee8855, #9977cc)" }} />
                    </div>
                  </div>
                  {/* Legend row */}
                  <div className="flex gap-3 mt-0.5">
                    <div className="flex items-center gap-1">
                      <div className="w-[6px] h-[6px] rounded-full border-2" style={{ borderColor: "#ee8855", backgroundColor: "#ee885540" }} />
                      <span className="text-[8px] font-mono text-[#ee8855]">direct = {f.mapDirect}s</span>
                      <span className="text-[7px] text-[#665544]">({directErr > 0 ? "+" : ""}{directErr.toFixed(1)}¢)</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-[6px] h-[6px] rounded-sm border-2" style={{ borderColor: "#9977cc", backgroundColor: "#9977cc40" }} />
                      <span className="text-[8px] font-mono text-[#9977cc]">indirect = {f.mapIndirect}s</span>
                      <span className="text-[7px] text-[#554466]">({indirectErr > 0 ? "+" : ""}{indirectErr.toFixed(1)}¢)</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {failedPairs.length > 8 && (
            <div className="text-[8px] text-[#555]">+{failedPairs.length - 8} more inconsistent pairs</div>
          )}
          <div className="text-[8px] text-[#555] leading-tight">
            <span className="text-[#ee8855]">●</span> direct = best step for the ratio itself &nbsp;
            <span className="text-[#9977cc]">■</span> indirect = difference of individual best steps.
            Consistency requires these to agree for all pairs.
          </div>
        </div>
      )}
    </div>
  );
}

/** Visual breakdown of zeta function properties */
function ZetaViz({ edo, harmonics }: { edo: number; harmonics: Record<number, { abs: number; rel: number; steps: number; reduced: number }> }) {
  const primes = [2, 3, 5, 7, 11, 13] as const;

  // Compute the zeta-like score for this EDO and nearby EDOs
  const zetaScore = (n: number) => {
    let sum = 0;
    for (const p of primes) {
      const exact = n * Math.log2(p);
      const frac = exact - Math.round(exact);
      sum += Math.cos(2 * Math.PI * frac);
    }
    return sum;
  };

  // Compute scores for a range of EDOs
  const range = useMemo(() => {
    const r: { edo: number; score: number; isCurrent: boolean }[] = [];
    const lo = Math.max(5, edo - 15), hi = Math.min(99, edo + 15);
    for (let n = lo; n <= hi; n++) {
      r.push({ edo: n, score: zetaScore(n), isCurrent: n === edo });
    }
    return r;
  }, [edo]);

  const maxScore = Math.max(...range.map(r => r.score));
  const minScore = Math.min(...range.map(r => r.score));
  const scoreRange = maxScore - minScore || 1;

  // Per-prime breakdown: how close is each prime to a whole number of steps?
  const primeBreakdown = primes.map(p => {
    const exact = edo * Math.log2(p);
    const rounded = Math.round(exact);
    const frac = exact - rounded;
    const contribution = Math.cos(2 * Math.PI * frac);
    return { prime: p, exactSteps: exact, bestStep: rounded, fractionalError: frac, contribution, maxContribution: 1 };
  });

  const barW = 400;
  const barH = 20;
  const chartH = 120;
  const chartPad = 20;

  return (
    <div className="bg-[#1a0d1a] border border-[#4a3a4a] rounded-lg p-3 space-y-3">
      <div className="text-[10px] text-[#cc88cc] font-medium">
        Zeta peak score — {edo}-EDO
      </div>
      <div className="text-[9px] text-[#777] leading-relaxed">
        A good EDO maps the harmonic series (2, 3, 5, 7, 11, 13 ...) onto whole numbers of steps with little rounding error.
        The <span className="text-[#cc88cc]">zeta peak score</span> adds up how close each prime harmonic lands to a whole step —
        if every prime lands perfectly, the score is 6 (one point per prime). EDOs that score high are
        "<span className="text-[#cc88cc]">zeta peak</span>" EDOs: they approximate many primes well at the same time, not just one or two.
      </div>

      {/* Per-prime breakdown */}
      <div className="space-y-1.5">
        <div className="text-[9px] text-[#666] font-medium">Per-prime breakdown — for each prime, how close does {edo}-EDO get to a whole number of steps?</div>
        {primeBreakdown.map(pb => {
          const errPct = Math.abs(pb.fractionalError);
          const quality = errPct < 0.1 ? "excellent" : errPct < 0.2 ? "good" : errPct < 0.35 ? "fair" : "poor";
          const qColor = quality === "excellent" ? "#7aaa7a" : quality === "good" ? "#aaaa5a" : quality === "fair" ? "#aa8833" : "#aa3333";
          const barFill = Math.max(0, (1 - errPct * 2)) * 100; // 0% error = 100% fill

          return (
            <div key={pb.prime} className="flex items-center gap-2">
              <span className="text-[10px] font-mono font-bold w-5 text-right" style={{ color: MONZO_PRIME_COLORS[pb.prime] ?? "#888" }}>{pb.prime}</span>
              <span className="text-[9px] font-mono text-[#888] w-[90px]">{pb.exactSteps.toFixed(3)} → {pb.bestStep}s</span>
              <div className="flex-1 h-[8px] rounded-full bg-[#1a1a1a] max-w-[200px] relative overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${barFill}%`, backgroundColor: qColor }} />
              </div>
              <span className="text-[8px] font-mono w-[50px]" style={{ color: qColor }}>
                {pb.fractionalError > 0 ? "+" : ""}{pb.fractionalError.toFixed(3)}
              </span>
              <span className="text-[8px] w-[50px]" style={{ color: qColor }}>{quality}</span>
            </div>
          );
        })}
      </div>

      {/* Zeta landscape chart — bar chart showing nearby EDOs */}
      <div className="space-y-1">
        <div className="text-[9px] text-[#666] font-medium">Nearby EDO comparison — taller bars mean more primes land close to whole steps</div>
        <svg width={barW + chartPad * 2} height={chartH + chartPad} viewBox={`0 0 ${barW + chartPad * 2} ${chartH + chartPad}`} className="block">
          {/* Threshold lines */}
          {[3.5, 4.5].map(thresh => {
            const y = chartH - ((thresh - minScore) / scoreRange) * (chartH - 10);
            if (y < 0 || y > chartH) return null;
            return (
              <g key={thresh}>
                <line x1={chartPad} y1={y} x2={barW + chartPad} y2={y} stroke="#333" strokeWidth={1} strokeDasharray="4 3" />
                <text x={barW + chartPad + 4} y={y + 3} fill="#555" fontSize={7}>{thresh === 4.5 ? "peak" : "integral"}</text>
              </g>
            );
          })}
          {/* Bars */}
          {range.map((r, i) => {
            const bW = Math.max(barW / range.length - 2, 3);
            const x = chartPad + (i / range.length) * barW;
            const h = Math.max(((r.score - minScore) / scoreRange) * (chartH - 10), 1);
            const y = chartH - h;
            const isPeak = r.score > 4.5;
            const isIntegral = r.score > 3.5;
            const color = r.isCurrent ? "#cc88cc" : isPeak ? "#9966aa" : isIntegral ? "#664477" : "#333";
            return (
              <g key={r.edo}>
                <rect x={x} y={y} width={bW} height={h} fill={color} rx={1}
                  opacity={r.isCurrent ? 1 : 0.7} stroke={r.isCurrent ? "#eeaaee" : "none"} strokeWidth={r.isCurrent ? 1.5 : 0} />
                {(r.isCurrent || isPeak) && (
                  <text x={x + bW / 2} y={y - 3} textAnchor="middle" fill={r.isCurrent ? "#eeaaee" : "#888"} fontSize={8} fontWeight={r.isCurrent ? "bold" : "normal"} fontFamily="monospace">
                    {r.edo}
                  </text>
                )}
              </g>
            );
          })}
          {/* X axis */}
          <line x1={chartPad} y1={chartH} x2={barW + chartPad} y2={chartH} stroke="#333" strokeWidth={1} />
        </svg>
      </div>

      <div className="text-[9px] text-[#888] leading-relaxed">
        For each prime p, we compute how far {edo}×log₂(p) is from the nearest whole number.
        A fractional part near 0 means the prime is well-tuned; near 0.5 means maximally out-of-tune.
        The score sums cos(2π × error) for primes 2–13: perfect tuning scores +1 per prime, worst scores −1.
        <br />
        Max possible = {primes.length}. <span className="text-[#cc88cc]">Above the "peak" line (4.5) → zeta peak EDO.</span>{" "}
        <span className="text-[#996699]">Above "integral" line (3.5) → zeta integral EDO.</span>{" "}
        Current: <span className="text-[#cc88cc] font-mono font-bold">{zetaScore(edo).toFixed(2)}</span>
      </div>
    </div>
  );
}

/** ────────────────────────────────────────────────────────────
 *  Zeta Integral Visualization
 *
 *  The Riemann zeta function evaluated at s = σ + 2πi·n/ln(2) measures
 *  how well n-EDO approximates the harmonic series with damping σ.
 *  • |ζ(s)| ≈ Σ_{k=1}^{K} k^{-σ} · cos(2π · n · log₂(k))
 *  • "Zeta integral" = ∫ |ζ(σ+it)|² dσ over a σ-range — a robust,
 *    weighting-independent quality measure.
 *  ──────────────────────────────────────────────────────────── */
function ZetaIntegralViz({ edo }: { edo: number }) {
  const K = 64; // harmonics to sum
  const sigmaMin = 1.5;
  const sigmaMax = 4.0;
  const sigmaSteps = 80;
  const dSigma = (sigmaMax - sigmaMin) / sigmaSteps;
  const LN2 = Math.LN2;

  // ── helpers ──
  const zetaMag = useCallback((n: number, sigma: number) => {
    let re = 0, im = 0;
    for (let k = 1; k <= K; k++) {
      const w = Math.pow(k, -sigma);
      const angle = 2 * Math.PI * n * Math.log(k) / LN2;
      re += w * Math.cos(angle);
      im += w * Math.sin(angle);
    }
    return Math.sqrt(re * re + im * im);
  }, []);

  const zetaIntegral = useCallback((n: number) => {
    // Trapezoidal integration of |ζ|² over σ
    let sum = 0;
    for (let i = 0; i <= sigmaSteps; i++) {
      const sigma = sigmaMin + i * dSigma;
      const mag = zetaMag(n, sigma);
      const w = (i === 0 || i === sigmaSteps) ? 0.5 : 1;
      sum += w * mag * mag;
    }
    return sum * dSigma;
  }, [zetaMag]);

  // ── 1. Curve data: |ζ(σ+it)| vs σ for selected EDO + neighbours ──
  const curveEdos = useMemo(() => {
    const candidates = new Set<number>();
    candidates.add(edo);
    for (let d = -3; d <= 3; d++) {
      const c = edo + d;
      if (c >= 2 && c <= 200) candidates.add(c);
    }
    return Array.from(candidates).sort((a, b) => a - b);
  }, [edo]);

  const curves = useMemo(() => {
    return curveEdos.map(n => {
      const pts: { sigma: number; mag: number }[] = [];
      for (let i = 0; i <= sigmaSteps; i++) {
        const sigma = sigmaMin + i * dSigma;
        pts.push({ sigma, mag: zetaMag(n, sigma) });
      }
      return { edo: n, pts, integral: zetaIntegral(n) };
    });
  }, [curveEdos, zetaMag, zetaIntegral]);

  // ── 2. Landscape: integral values for a range of EDOs ──
  const landscape = useMemo(() => {
    const lo = Math.max(2, edo - 20), hi = Math.min(200, edo + 20);
    const rows: { edo: number; integral: number; isCurrent: boolean }[] = [];
    for (let n = lo; n <= hi; n++) {
      rows.push({ edo: n, integral: zetaIntegral(n), isCurrent: n === edo });
    }
    return rows;
  }, [edo, zetaIntegral]);

  // ── 3. Per-harmonic contribution at σ=2 ──
  const sigma0 = 2.0;
  const harmonicBreakdown = useMemo(() => {
    const items: { k: number; weight: number; phase: number; contribution: number }[] = [];
    for (let k = 1; k <= 24; k++) {
      const w = Math.pow(k, -sigma0);
      const angle = 2 * Math.PI * edo * Math.log(k) / LN2;
      const cosVal = Math.cos(angle);
      items.push({ k, weight: w, phase: (angle % (2 * Math.PI)), contribution: w * cosVal });
    }
    return items;
  }, [edo]);

  // ── SVG dimensions ──
  const W = 440, curveH = 140, barH = 100, pad = 30;

  // curve scaling
  const allMags = curves.flatMap(c => c.pts.map(p => p.mag));
  const maxMag = Math.max(...allMags, 1);

  // landscape scaling
  const maxInt = Math.max(...landscape.map(r => r.integral), 0.01);
  const minInt = Math.min(...landscape.map(r => r.integral));
  const intRange = maxInt - minInt || 1;

  // Colours for nearby EDOs
  const palette = ["#cc88cc", "#6688cc", "#88cc88", "#ccaa44", "#cc6666", "#44cccc", "#aaaaaa"];

  return (
    <div className="bg-[#0d0d1a] border border-[#3a3a5a] rounded-lg p-3 space-y-4">
      <div className="text-[10px] text-[#8888cc] font-medium">
        Zeta integral — {edo}-EDO
      </div>
      <div className="text-[9px] text-[#777] leading-relaxed">
        The zeta peak score above checks primes 2–13 equally. But how important is harmonic 13 compared to harmonic 2?
        The <span className="text-[#8888cc]">zeta integral</span> answers this by sweeping through all possible weightings:
        the parameter <span className="font-mono">σ</span> controls how much we care about higher harmonics.
        Low σ = all harmonics matter equally; high σ = only the lowest harmonics (2, 3, 5) count.
        Instead of picking one σ, we <em>integrate over all of them</em> — giving a single robust number
        that doesn't depend on any arbitrary choice of which harmonics to prioritize.
      </div>

      {/* ── Curve: |ζ(σ+it)| vs σ ── */}
      <div className="space-y-1">
        <div className="text-[9px] text-[#666] font-medium">
          Harmonic fit vs. weighting — sweep σ from {sigmaMin} (all harmonics weighted equally) to {sigmaMax} (only low harmonics matter)
        </div>
        <svg width={W + pad * 2} height={curveH + pad + 12} viewBox={`0 0 ${W + pad * 2} ${curveH + pad + 12}`} className="block">
          {/* Grid lines */}
          {[0.25, 0.5, 0.75, 1.0].map(frac => {
            const y = curveH - frac * curveH;
            return <line key={frac} x1={pad} y1={y} x2={W + pad} y2={y} stroke="#1a1a2a" strokeWidth={1} />;
          })}
          {/* σ axis labels */}
          {[1.5, 2.0, 2.5, 3.0, 3.5, 4.0].map(s => {
            const x = pad + ((s - sigmaMin) / (sigmaMax - sigmaMin)) * W;
            return (
              <g key={s}>
                <line x1={x} y1={curveH} x2={x} y2={curveH + 4} stroke="#444" strokeWidth={1} />
                <text x={x} y={curveH + 12} textAnchor="middle" fill="#555" fontSize={7} fontFamily="monospace">σ={s}</text>
              </g>
            );
          })}
          {/* Curves */}
          {curves.map((curve, ci) => {
            const isCurrent = curve.edo === edo;
            const color = isCurrent ? palette[0] : palette[(ci % (palette.length - 1)) + 1];
            const d = curve.pts.map((p, i) => {
              const x = pad + ((p.sigma - sigmaMin) / (sigmaMax - sigmaMin)) * W;
              const y = curveH - (p.mag / maxMag) * curveH;
              return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
            }).join(" ");
            return (
              <g key={curve.edo}>
                <path d={d} fill="none" stroke={color} strokeWidth={isCurrent ? 2 : 1}
                  opacity={isCurrent ? 1 : 0.4} strokeLinejoin="round" />
                {isCurrent && (() => {
                  const peakPt = curve.pts.reduce((best, p) => p.mag > best.mag ? p : best, curve.pts[0]);
                  const px = pad + ((peakPt.sigma - sigmaMin) / (sigmaMax - sigmaMin)) * W;
                  const py = curveH - (peakPt.mag / maxMag) * curveH;
                  return <text x={px} y={py - 5} textAnchor="middle" fill={color} fontSize={8} fontWeight="bold" fontFamily="monospace">{curve.edo}</text>;
                })()}
              </g>
            );
          })}
          {/* Axes */}
          <line x1={pad} y1={0} x2={pad} y2={curveH} stroke="#333" strokeWidth={1} />
          <line x1={pad} y1={curveH} x2={W + pad} y2={curveH} stroke="#333" strokeWidth={1} />
          <text x={pad - 4} y={6} textAnchor="end" fill="#555" fontSize={7}>{maxMag.toFixed(1)}</text>
        </svg>
        {/* Legend */}
        <div className="flex gap-3 flex-wrap">
          {curves.map((curve, ci) => {
            const isCurrent = curve.edo === edo;
            const color = isCurrent ? palette[0] : palette[(ci % (palette.length - 1)) + 1];
            return (
              <span key={curve.edo} className="text-[8px] font-mono" style={{ color, opacity: isCurrent ? 1 : 0.6, fontWeight: isCurrent ? "bold" : "normal" }}>
                {curve.edo}-EDO (∫={curve.integral.toFixed(2)})
              </span>
            );
          })}
        </div>
      </div>

      {/* ── Zeta integral landscape ── */}
      <div className="space-y-1">
        <div className="text-[9px] text-[#666] font-medium">
          Zeta integral landscape — total area under the curve above, compared across nearby EDOs (taller = better overall harmonic fit)
        </div>
        <svg width={W + pad * 2} height={barH + pad} viewBox={`0 0 ${W + pad * 2} ${barH + pad}`} className="block">
          {landscape.map((r, i) => {
            const bW = Math.max(W / landscape.length - 1.5, 3);
            const x = pad + (i / landscape.length) * W;
            const h = Math.max(((r.integral - minInt) / intRange) * (barH - 10), 1);
            const y = barH - h;
            const isLocalPeak = i > 0 && i < landscape.length - 1 &&
              r.integral > landscape[i - 1].integral && r.integral > landscape[i + 1].integral;
            const color = r.isCurrent ? "#8888cc" : isLocalPeak ? "#6666aa" : "#2a2a44";
            return (
              <g key={r.edo}>
                <rect x={x} y={y} width={bW} height={h} fill={color} rx={1}
                  opacity={r.isCurrent ? 1 : 0.7}
                  stroke={r.isCurrent ? "#aaaaee" : "none"} strokeWidth={r.isCurrent ? 1.5 : 0} />
                {(r.isCurrent || isLocalPeak) && (
                  <text x={x + bW / 2} y={y - 3} textAnchor="middle"
                    fill={r.isCurrent ? "#aaaaee" : "#777"} fontSize={7} fontWeight={r.isCurrent ? "bold" : "normal"} fontFamily="monospace">
                    {r.edo}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={pad} y1={barH} x2={W + pad} y2={barH} stroke="#333" strokeWidth={1} />
        </svg>
      </div>

      {/* ── Per-harmonic contribution at σ=2 ── */}
      <div className="space-y-1">
        <div className="text-[9px] text-[#666] font-medium">
          Per-harmonic alignment (at σ={sigma0}) — does harmonic k land near a step of {edo}-EDO? Bars above the line = well-tuned, below = mistuned
        </div>
        <div className="flex gap-[2px] items-end h-[60px]">
          {harmonicBreakdown.map(h => {
            const maxC = Math.max(...harmonicBreakdown.map(x => Math.abs(x.contribution)));
            const half = 28; // max bar height in one direction (half of container)
            const normH = (h.contribution / (maxC || 1)) * half;
            const positive = h.contribution >= 0;
            const isPrime = [2, 3, 5, 7, 11, 13, 17, 19, 23].includes(h.k);
            return (
              <div key={h.k} className="flex flex-col items-center" style={{ width: 16 }}>
                <div className="relative w-[10px]" style={{ height: half * 2 }}>
                  <div
                    className="absolute w-full rounded-sm"
                    style={{
                      backgroundColor: positive ? (isPrime ? "#7788cc" : "#3a3a5a") : (isPrime ? "#cc6666" : "#5a3a3a"),
                      height: `${Math.abs(normH)}px`,
                      bottom: positive ? `${half}px` : undefined,
                      top: positive ? undefined : `${half}px`,
                    }}
                  />
                  <div className="absolute w-full h-[1px] bg-[#444]" style={{ top: `${half}px` }} />
                </div>
                <span className="text-[7px] font-mono" style={{ color: isPrime ? "#aabbee" : "#555" }}>{h.k}</span>
              </div>
            );
          })}
        </div>
        <div className="text-[8px] text-[#555]">
          <span className="text-[#7788cc]">■</span> positive (in-tune) &nbsp;
          <span className="text-[#cc6666]">■</span> negative (out-of-tune) &nbsp;
          <span className="text-[#aabbee]">bright</span> = prime harmonics
        </div>
      </div>

      {/* ── Summary ── */}
      <div className="text-[9px] text-[#888] leading-relaxed">
        <span className="text-[#666]">How it works:</span> For each harmonic k = 1, 2, 3 ... {K}, we check how close {edo}×log₂(k)
        is to a whole number, weighted by k⁻σ (higher σ → higher harmonics matter less).
        The curve above shows the total alignment score at each σ.
        The <span className="text-[#8888cc]">zeta integral</span> is the total area under that squared curve — a single number
        capturing how good {edo}-EDO is <em>regardless of which harmonics you prioritize</em>.
        <br />
        Integral: <span className="text-[#8888cc] font-mono font-bold">{zetaIntegral(edo).toFixed(3)}</span>
        {" · "}Best single-σ score: <span className="text-[#8888cc] font-mono font-bold">{Math.max(...(curves.find(c => c.edo === edo)?.pts.map(p => p.mag) ?? [0])).toFixed(3)}</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 2. EDO TEMPER — Deep per-EDO info
// ═══════════════════════════════════════════════════════════════

function EdoTemper({ selectedEdo, setSelectedEdo }: { selectedEdo: number; setSelectedEdo: (edo: number) => void }) {
  const [expandedDesc, setExpandedDesc] = useState(false);
  const [activeDrones, setActiveDrones] = useState<Set<string>>(new Set());
  const edoData = EDO_DATA.get(selectedEdo)!;
  const desc = EDO_DESCRIPTIONS[selectedEdo];
  const intervals = useMemo(() => getEdoIntervals(selectedEdo), [selectedEdo]);
  const primeList = [3, 5, 7, 11, 13, 17, 19, 23, 29, 31];

  // ── Comma analysis state ──
  const PRIME_LIMITS = [
    { label: "3-limit", primes: [2, 3] },
    { label: "5-limit", primes: [2, 3, 5] },
    { label: "7-limit", primes: [2, 3, 5, 7] },
    { label: "11-limit", primes: [2, 3, 5, 7, 11] },
    { label: "13-limit", primes: [2, 3, 5, 7, 11, 13] },
  ];
  const [primeLimitIdx, setPrimeLimitIdx] = useState(1); // 5-limit default
  const selectedPrimes = PRIME_LIMITS[primeLimitIdx].primes;
  const latticePrimes = selectedPrimes.filter(p => p !== 2);
  const commasNeeded = commasNeededForEdo(selectedPrimes);

  const allTemperedCommas = useMemo(() =>
    edoData.commasTempered.map(c => COMMA_DB.find(db => db.n === c.n && db.d === c.d)).filter(Boolean) as CommaInfo[],
    [edoData],
  );

  const { basis: basisCommas, dependent: dependentCommas } = useMemo(
    () => findCommaBasis(allTemperedCommas, selectedPrimes, true),
    [allTemperedCommas, selectedPrimes],
  );

  const outsideLimitCommas = useMemo(() => {
    const ps = new Set(selectedPrimes);
    return allTemperedCommas.filter(c => !c.primes.every(p => p === 2 || ps.has(p)));
  }, [allTemperedCommas, selectedPrimes]);

  const basisMinBounds = useMemo(() => computeMinBoundsForCommas(basisCommas, true), [basisCommas]);

  const [boundsOverride, setBoundsOverride] = useState<Record<number, [number, number]>>({});
  const activeBounds = useMemo(() => {
    const b: Record<number, [number, number]> = {};
    for (const p of latticePrimes) {
      const [minLo, minHi] = basisMinBounds[p] ?? [0, 0];
      const [ovLo, ovHi] = boundsOverride[p] ?? [0, 0];
      b[p] = [Math.min(minLo, ovLo), Math.max(minHi, ovHi)];
    }
    return b;
  }, [latticePrimes, basisMinBounds, boundsOverride]);

  const classified = useMemo(() => classifyCommasForEdo(selectedEdo, latticePrimes, activeBounds, true), [selectedEdo, latticePrimes, activeBounds]);
  const activeCm = classified.filter(c => c.fitsInBounds && c.primesAvailable);
  const needsExpCm = classified.filter(c => c.primesAvailable && !c.fitsInBounds);
  const wrongPCm = classified.filter(c => !c.primesAvailable);

  useEffect(() => { setBoundsOverride({}); }, [selectedEdo, primeLimitIdx]);

  const expandBound = useCallback((p: number, lo: number, hi: number) => {
    setBoundsOverride(prev => {
      const cur = prev[p] ?? [0, 0];
      return { ...prev, [p]: [Math.min(cur[0], lo), Math.max(cur[1], hi)] };
    });
  }, []);

  // Audio
  const playInterval = useCallback(async (step: number) => { await ensureAudio(selectedEdo); audioEngine.playSequence([[0], [step]], selectedEdo, 500, 0.8, 0.8); }, [selectedEdo]);
  const playComma = useCallback(async (n: number, d: number) => { await ensureAudio(selectedEdo); audioEngine.playRatioChord([1, n / d], 1.5, 0.7); }, [selectedEdo]);
  const playAB = useCallback(async (n: number, d: number) => {
    // A/B: first play JI ratio, then play the EDO approximation
    await ensureAudio(selectedEdo);
    const ratio = n / d;
    const ratioCents = 1200 * Math.log2(ratio);
    const step = 1200 / selectedEdo;
    const edoStep = Math.round(ratioCents / step);
    audioEngine.playRatioSequence([[1, ratio]], 600, 1.0, 0.7); // JI
    setTimeout(() => { audioEngine.playSequence([[0, edoStep]], selectedEdo, 600, 1.0, 0.7); }, 1200); // EDO
  }, [selectedEdo]);
  const playChord = useCallback(async (steps: number[]) => { await ensureAudio(selectedEdo); audioEngine.playChord(steps, selectedEdo, 1.5, 0.7); }, [selectedEdo]);
  const playScale = useCallback(async (steps: number[]) => {
    await ensureAudio(selectedEdo);
    const frames = [...steps, steps[0] + selectedEdo].map(s => [s]);
    audioEngine.playSequence(frames, selectedEdo, 300, 0.6, 0.7);
  }, [selectedEdo]);

  // Toggle an EDO interval drone (Cents click) — multiple simultaneous
  const toggleEdoDrone = useCallback(async (step: number) => {
    const key = `edo-${step}`;
    if (audioEngine.isIntervalDronePlaying(key)) {
      audioEngine.stopIntervalDroneByKey(key);
      setActiveDrones(prev => { const n = new Set(prev); n.delete(key); return n; });
    } else {
      await ensureAudio(selectedEdo);
      const freq = C4_FREQ * Math.pow(2, step / selectedEdo);
      audioEngine.startIntervalDrone(key, freq, 1.0);
      setActiveDrones(prev => new Set(prev).add(key));
    }
  }, [selectedEdo]);

  // Toggle a JI ratio drone (≈ JI click) — multiple simultaneous
  const toggleJiDrone = useCallback(async (n: number, d: number) => {
    const key = `ji-${n}/${d}`;
    if (audioEngine.isIntervalDronePlaying(key)) {
      audioEngine.stopIntervalDroneByKey(key);
      setActiveDrones(prev => { const s = new Set(prev); s.delete(key); return s; });
    } else {
      await ensureAudio(selectedEdo);
      const freq = C4_FREQ * (n / d);
      audioEngine.startIntervalDrone(key, freq, 1.0);
      setActiveDrones(prev => new Set(prev).add(key));
    }
  }, [selectedEdo]);

  // Toggle a chord drone — each note gets its own interval drone
  const toggleChordDrone = useCallback(async (steps: number[], name: string) => {
    const keys = steps.map(s => `ch-${name}-${s}`);
    const allPlaying = keys.every(k => audioEngine.isIntervalDronePlaying(k));
    if (allPlaying) {
      keys.forEach(k => audioEngine.stopIntervalDroneByKey(k));
      setActiveDrones(prev => { const n = new Set(prev); keys.forEach(k => n.delete(k)); n.delete(`ch-${name}`); return n; });
    } else {
      await ensureAudio(selectedEdo);
      const perNoteGain = Math.min(0.7, 1.8 / steps.length);
      keys.forEach((k, i) => {
        if (!audioEngine.isIntervalDronePlaying(k)) {
          const freq = C4_FREQ * Math.pow(2, steps[i] / selectedEdo);
          audioEngine.startIntervalDrone(k, freq, perNoteGain);
        }
      });
      setActiveDrones(prev => { const n = new Set(prev); keys.forEach(k => n.add(k)); n.add(`ch-${name}`); return n; });
    }
  }, [selectedEdo]);

  const toggleJiChordDrone = useCallback(async (jiApprox: string, name: string) => {
    const jiRatios = jiApprox.split(":").map(Number);
    const base = jiRatios[0];
    const ratios = jiRatios.map(r => r / base);
    const keys = ratios.map((_, i) => `ji-ch-${name}-${i}`);
    const groupKey = `ji-ch-${name}`;
    const allPlaying = keys.every(k => audioEngine.isIntervalDronePlaying(k));
    if (allPlaying) {
      keys.forEach(k => audioEngine.stopIntervalDroneByKey(k));
      setActiveDrones(prev => { const n = new Set(prev); keys.forEach(k => n.delete(k)); n.delete(groupKey); return n; });
    } else {
      await ensureAudio(selectedEdo);
      const perNoteGain = Math.min(0.7, 1.8 / ratios.length);
      keys.forEach((k, i) => {
        if (!audioEngine.isIntervalDronePlaying(k)) {
          const freq = C4_FREQ * ratios[i];
          audioEngine.startIntervalDrone(k, freq, perNoteGain);
        }
      });
      setActiveDrones(prev => { const n = new Set(prev); keys.forEach(k => n.add(k)); n.add(groupKey); return n; });
    }
  }, [selectedEdo]);

  // Stop all drones
  const stopAllDrones = useCallback(() => {
    audioEngine.stopAllIntervalDrones();
    audioEngine.stopDrone();
    setActiveDrones(new Set());
  }, []);

  // Circle of fifths SVG — compute all rings for multi-ring EDOs
  const cof = edoData.circleOfFifths;
  const cofR = 90, cofCx = 110, cofCy = 110;
  const RING_COLORS = ["#9395ea", "#e06060", "#60c060", "#e0c040", "#60c0e0", "#c060c0", "#ff8844", "#44ff88"];
  const allRings = useMemo(() => {
    const ringCount = edoData.ring.count;
    if (ringCount <= 1) return [cof];
    const fs = edoData.ring.fifthSteps;
    const rings: number[][] = [];
    for (let r = 0; r < ringCount; r++) {
      const ring: number[] = [];
      let pc = r;
      for (let i = 0; i < edoData.ring.notesPerRing; i++) {
        ring.push(pc);
        pc = (pc + fs) % selectedEdo;
      }
      rings.push(ring);
    }
    return rings;
  }, [cof, edoData.ring, selectedEdo]);

  return (
    <div className="p-4 space-y-4">
      {/* EDO selector grouped by fifth-tuning family — every EDO 5..99
          falls into exactly one band based on its actual best-fifth
          cents.  Inside each group, EDOs are sorted by fifth size. */}
      <FamilyGroupedEdoSelector
        selectedEdo={selectedEdo}
        onPick={n => { setSelectedEdo(n); setExpandedDesc(false); stopAllDrones(); }} />
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs text-[#888] font-medium">Or jump to</label>
        <select value={selectedEdo} onChange={e => { setSelectedEdo(+e.target.value); setExpandedDesc(false); stopAllDrones(); }}
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
          {Array.from({ length: 95 }, (_, i) => i + 5).map(n => <option key={n} value={n}>{n}-EDO</option>)}
        </select>
      </div>

      {/* Summary + badges */}
      <div className="bg-[#111] border border-[#222] rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-lg font-bold text-white">{selectedEdo}-EDO</h3>
          <span className="text-xs text-[#888]">{edoData.stepCents}¢/step</span>
          {edoData.isPrime && <span className="text-[10px] px-1.5 py-0.5 bg-[#1a1a3a] text-[#9395ea] border border-[#3a3a6a] rounded">Prime</span>}
          {edoData.consistencyLimit && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1a2a1a] text-[#7aaa7a] border border-[#3a6a3a]">
              {edoData.consistencyLimit}-odd consistent
            </span>
          )}
          {edoData.zetaProps.map(z => (
            <span key={z} className="text-[10px] px-1.5 py-0.5 rounded bg-[#2a1a2a] text-[#cc88cc] border border-[#4a3a4a]">
              {z}
            </span>
          ))}
          <PlayBtn onClick={async () => { await ensureAudio(selectedEdo); audioEngine.playSequence(Array.from({ length: selectedEdo + 1 }, (_, i) => [i]), selectedEdo, 200, 0.4, 0.7); }} title="Play chromatic scale" />
        </div>

        {/* Ring structure — visual */}
        <div className="flex items-center gap-3 flex-wrap">
          {edoData.ring.type === "single" ? (
            <div className="flex items-center gap-2">
              <svg width={28} height={28} viewBox="0 0 28 28">
                <circle cx={14} cy={14} r={11} fill="none" stroke="#7aaa7a" strokeWidth={2} />
                <circle cx={14} cy={3} r={2.5} fill="#7aaa7a" />
              </svg>
              <div className="text-xs">
                <span className="text-[#7aaa7a] font-bold">Single ring</span>
                <span className="text-[#888]"> — </span>
                <span className="text-[#bbb] font-mono">{edoData.ring.fifthSteps}</span>
                <span className="text-[#666]">-step fifth </span>
                <span className="text-[#888] font-mono">({edoData.ring.fifthCents}¢)</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <svg width={36} height={28} viewBox="0 0 36 28">
                {Array.from({ length: Math.min(edoData.ring.count, 4) }, (_, i) => {
                  const cx = 10 + i * 6;
                  return <circle key={i} cx={cx} cy={14} r={8 - i} fill="none" stroke="#ddaa55" strokeWidth={1.5} opacity={1 - i * 0.2} />;
                })}
              </svg>
              <div className="text-xs">
                <span className="text-[#ddaa55] font-bold">{edoData.ring.count} rings</span>
                <span className="text-[#888]"> × </span>
                <span className="text-[#bbb] font-mono">{edoData.ring.notesPerRing}</span>
                <span className="text-[#666]"> notes — fifth = </span>
                <span className="text-[#888] font-mono">{edoData.ring.fifthSteps} steps ({edoData.ring.fifthCents}¢)</span>
              </div>
            </div>
          )}
        </div>
        {/* Dual fifths — visual comparison bar */}
        {edoData.dualFifths && (() => {
          const just = 701.96;
          const sharp = edoData.dualFifths.sharp;
          const flat = edoData.dualFifths.flat;
          const range = 40; // ±40¢ from just
          const barW = 160;
          const toX = (cents: number) => Math.max(0, Math.min(barW, ((cents - just + range) / (range * 2)) * barW));
          return (
            <div className="space-y-1">
              <div className="text-[10px] text-[#666] font-medium">Dual fifths</div>
              <div className="flex items-center gap-2">
                <svg width={barW + 4} height={24} viewBox={`-2 0 ${barW + 4} 24`}>
                  {/* Track */}
                  <rect x={0} y={10} width={barW} height={4} rx={2} fill="#1a1a1a" />
                  {/* Just 3:2 marker */}
                  <line x1={toX(just)} y1={6} x2={toX(just)} y2={18} stroke="#555" strokeWidth={1} strokeDasharray="2 2" />
                  {/* Flat fifth */}
                  <circle cx={toX(flat.cents)} cy={12} r={4} fill="#6688cc" stroke="#88aaee" strokeWidth={1} />
                  {/* Sharp fifth */}
                  <circle cx={toX(sharp.cents)} cy={12} r={4} fill="#cc8844" stroke="#eeaa66" strokeWidth={1} />
                </svg>
                <div className="text-[10px] space-x-2">
                  <span style={{ color: "#88aaee" }}>♭{flat.steps}s {flat.cents}¢</span>
                  <span style={{ color: "#eeaa66" }}>♯{sharp.steps}s {sharp.cents}¢</span>
                </div>
              </div>
            </div>
          );
        })()}
        {/* Good subgroup — visual prime strip */}
        <div className="space-y-1.5">
          <div className="text-[10px] text-[#666] font-medium">Good subgroup</div>
          <div className="flex gap-1.5 flex-wrap items-end">
            {primeList.map(p => {
              const h = edoData.harmonics[p];
              if (!h) return null;
              const inSub = edoData.goodSubgroup.includes(p);
              const absErr = Math.abs(h.abs);
              const relErr = Math.abs(h.rel);
              const barH = Math.min(relErr / 50 * 24, 24);
              const errColor = absErr < 5 ? "#4a8a4a" : absErr < 15 ? "#aa8833" : "#aa3333";
              return (
                <div key={p} className="flex flex-col items-center gap-0.5" title={`${p}: ${h.abs > 0 ? "+" : ""}${h.abs.toFixed(1)}¢ (${h.rel.toFixed(0)}% rel)`}>
                  <div className="w-5 flex items-end justify-center" style={{ height: 26 }}>
                    <div style={{ width: 4, height: Math.max(barH, 2), backgroundColor: errColor, borderRadius: 1, opacity: inSub ? 1 : 0.4 }} />
                  </div>
                  <div className="flex items-center justify-center rounded-sm font-mono font-bold"
                    style={{
                      width: p >= 10 ? 22 : 18, height: 18, fontSize: 9,
                      backgroundColor: inSub ? (MONZO_PRIME_COLORS[p] ?? "#7aaa7a") + "25" : "#1a1a1a",
                      border: `1.5px solid ${inSub ? (MONZO_PRIME_COLORS[p] ?? "#7aaa7a") : "#2a2a2a"}`,
                      color: inSub ? (MONZO_PRIME_COLORS[p] ?? "#7aaa7a") : "#444",
                      boxShadow: inSub ? `0 0 6px ${(MONZO_PRIME_COLORS[p] ?? "#7aaa7a")}33` : "none",
                    }}>
                    {p}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {/* Subsets — visual EDO divisor circles */}
        {edoData.subsets.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] text-[#666] font-medium">Subset EDOs</div>
            <div className="flex gap-2 items-center flex-wrap">
              {edoData.subsets.map(sub => {
                const ratio = sub / selectedEdo;
                const size = Math.round(14 + ratio * 20);
                const hasData = EDO_DATA.has(sub);
                return (
                  <button key={sub}
                    onClick={() => hasData ? (setSelectedEdo(sub), setExpandedDesc(false)) : undefined}
                    className="flex flex-col items-center gap-0.5 group"
                    title={`${sub}-EDO (${selectedEdo} ÷ ${selectedEdo / sub})`}
                    style={{ cursor: hasData ? "pointer" : "default" }}>
                    <div className="rounded-full flex items-center justify-center font-mono font-bold transition-all"
                      style={{
                        width: size, height: size, fontSize: Math.max(size * 0.4, 8),
                        backgroundColor: "#9395ea18",
                        border: "1.5px solid #9395ea55",
                        color: "#9395ea",
                      }}>
                      {sub}
                    </div>
                  </button>
                );
              })}
              <span className="text-[10px] text-[#444] font-mono ml-1">⊂ {selectedEdo}</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Consistency Visualization ── */}
      {edoData.consistencyLimit && <ConsistencyViz edo={selectedEdo} consistencyLimit={edoData.consistencyLimit} />}

      {/* ── Zeta Visualization ── */}
      {edoData.zetaProps.length > 0 && <ZetaViz edo={selectedEdo} harmonics={edoData.harmonics} />}

      {/* ── Zeta Integral Visualization ── */}
      <ZetaIntegralViz edo={selectedEdo} />

      {/* Wiki description */}
      {desc && (
        <div className="bg-[#111] border border-[#222] rounded-lg p-4">
          <h4 className="text-xs font-bold text-[#999] mb-2">Description</h4>
          <p className="text-xs text-[#bbb] leading-relaxed whitespace-pre-wrap">
            {expandedDesc ? desc.desc : desc.desc.slice(0, 500) + (desc.desc.length > 500 ? "..." : "")}
          </p>
          {desc.desc.length > 500 && <button onClick={() => setExpandedDesc(!expandedDesc)} className="text-[10px] text-[#7173e6] hover:text-[#9395ea] mt-1">{expandedDesc ? "Show less" : "Show more"}</button>}
        </div>
      )}

      {/* Circle of Fifths — show all rings for multi-ring EDOs */}
      {cof.length > 1 && (
        <div className="bg-[#111] border border-[#222] rounded-lg p-4">
          <h4 className="text-xs font-bold text-[#999] mb-2">
            Circle of Fifths ({allRings.length > 1 ? `${allRings.length} rings × ${edoData.ring.notesPerRing} notes` : `${cof.length} notes`})
          </h4>
          <div className="flex flex-wrap gap-4">
            {allRings.map((ring, ri) => {
              const ringColor = RING_COLORS[ri % RING_COLORS.length];
              const edgeColor = ringColor + "55";
              return (
                <div key={ri} className="flex items-start gap-3">
                  <svg width={220} height={220} className="flex-shrink-0">
                    {ring.map((pc, i) => {
                      const angle = (i / ring.length) * 2 * Math.PI - Math.PI / 2;
                      const x = cofCx + cofR * Math.cos(angle);
                      const y = cofCy + cofR * Math.sin(angle);
                      const nextAngle = ((i + 1) / ring.length) * 2 * Math.PI - Math.PI / 2;
                      const nx = cofCx + cofR * Math.cos(nextAngle);
                      const ny = cofCy + cofR * Math.sin(nextAngle);
                      const isRoot = pc === 0;
                      return (
                        <g key={i}>
                          {i < ring.length - 1 && <line x1={x} y1={y} x2={nx} y2={ny} stroke={edgeColor} strokeWidth={1} />}
                          <circle cx={x} cy={y} r={isRoot ? 8 : 5}
                            fill={isRoot ? ringColor : ringColor + "33"}
                            stroke={isRoot ? "#bbc" : ringColor + "88"} strokeWidth={1} />
                          <text x={x} y={y + 3} textAnchor="middle" className="text-[7px] fill-[#ccc] font-mono">{pc}</text>
                        </g>
                      );
                    })}
                  </svg>
                  <div className="text-[10px] text-[#888] space-y-1 min-w-[140px]">
                    {allRings.length > 1 && (
                      <div style={{ color: ringColor }} className="font-bold">Ring {ri + 1}</div>
                    )}
                    <div>Stacking {edoData.ring.fifthSteps}-step fifths:</div>
                    <div className="font-mono text-[#666]">{ring.join(" → ")}</div>
                    {allRings.length === 1 && cof.length === selectedEdo && <div className="text-[#7aaa7a]">Full circle — all {selectedEdo} notes reached</div>}
                  </div>
                </div>
              );
            })}
          </div>
          {allRings.length > 1 && (
            <div className="text-[10px] text-[#ddaa55] mt-2">
              {allRings.length} independent rings of {edoData.ring.notesPerRing} notes — fifths don't connect all {selectedEdo} pitch classes
            </div>
          )}
        </div>
      )}

      {/* Harmonic errors with JI comparison */}
      <div className="bg-[#111] border border-[#222] rounded-lg p-4">
        <h4 className="text-xs font-bold text-[#999] mb-3">Prime Harmonic Errors</h4>
        <div className="space-y-1">
          {primeList.map(p => {
            const h = edoData.harmonics[p]; if (!h) return null;
            const pct = Math.min(Math.abs(h.abs) / 60 * 100, 100);
            const inSubgroup = edoData.goodSubgroup.includes(p);
            return (
              <div key={p} className="flex items-center gap-2">
                <span className="text-[10px] font-mono w-6 text-right font-bold" style={{ color: MONZO_PRIME_COLORS[p] ?? "#888" }}>{p}</span>
                {inSubgroup && <span className="w-1.5 h-1.5 rounded-full bg-[#4a8a4a] flex-shrink-0" title="In good subgroup" />}
                {!inSubgroup && <span className="w-1.5 h-1.5 flex-shrink-0" />}
                <div className="flex-1 h-4 bg-[#1a1a1a] rounded relative overflow-hidden">
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[#333]" />
                  <div className="absolute top-0.5 bottom-0.5 rounded-sm" style={{ width: `${pct/2}%`, left: h.abs > 0 ? "50%" : `${50-pct/2}%`, backgroundColor: Math.abs(h.abs) < 5 ? "#4a8a4a" : Math.abs(h.abs) < 15 ? "#aa8833" : "#aa3333" }} />
                </div>
                <span className="text-[10px] font-mono w-16 text-right" style={{ color: h.abs > 0 ? "#ffaa44" : "#66aaff" }}>{h.abs > 0 ? "+" : ""}{h.abs.toFixed(1)}¢</span>
                <span className="text-[9px] text-[#555] w-10 text-right">{h.steps}\{selectedEdo}</span>
                <PlayBtn small onClick={async () => { await ensureAudio(selectedEdo); audioEngine.playNote(h.reduced, selectedEdo); }} title={`Play EDO ~${p}`} />
                <button onClick={() => playAB(p, 1)} title={`A/B: JI ${p}/1 then EDO`}
                  className="w-5 h-5 text-[8px] flex items-center justify-center rounded bg-[#1a1a2a] border border-[#2a2a4a] text-[#8888cc] hover:text-[#aaaaff] flex-shrink-0">AB</button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Intervals with error bars */}
      <div className="bg-[#111] border border-[#222] rounded-lg p-4">
        <div className="flex items-center gap-3 mb-2">
          <h4 className="text-xs font-bold text-[#999]">Intervals ({selectedEdo} steps)</h4>
          {activeDrones.size > 0 && (
            <button onClick={stopAllDrones}
              className="text-[9px] px-2 py-0.5 rounded bg-[#2a1a1a] border border-[#4a2a2a] text-[#cc6666] hover:text-[#ff8888]">
              Stop all ({activeDrones.size})
            </button>
          )}
          <span className="text-[9px] text-[#555]">click Cents = EDO drone, click JI = just drone (multi)</span>
        </div>
        <table className="text-[10px] w-full" style={{ borderCollapse: "separate", borderSpacing: "0 1px" }}>
          <thead>
            <tr className="text-[#555]">
              <th className="text-left font-medium px-1 pb-1">Step</th>
              <th className="text-left font-medium px-1 pb-1">Cents</th>
              <th className="font-medium px-1 pb-1 text-center border-l border-[#222]" colSpan={2}>±10¢ · lowest limit</th>
              <th className="font-medium px-1 pb-1 text-center border-l border-[#222]" colSpan={2}>±5¢ · lowest limit</th>
              <th className="font-medium px-1 pb-1 text-center border-l border-[#222]" colSpan={2}>±2¢ · closest</th>
            </tr>
          </thead>
          <tbody>
          {intervals.map(iv => {
            const edoKey = `edo-${iv.step}`;
            const edoActive = activeDrones.has(edoKey);

            const renderJICells = (m: typeof iv.ji10) => {
              if (!m) return <><td className="text-[#222] text-center px-1 border-l border-[#222]">—</td><td></td></>;
              const jiKey = `ji-${m.ratioNums[0]}/${m.ratioNums[1]}`;
              const jiActive = activeDrones.has(jiKey);
              const limColor = MONZO_PRIME_COLORS[m.limit] ?? "#888";
              const errStr = `${m.errorCents > 0 ? "+" : ""}${m.errorCents.toFixed(1)}`;
              return (<>
                <td className={`font-mono cursor-pointer select-none px-1 border-l border-[#222] ${jiActive ? "bg-[#7aaa7a15]" : "hover:bg-[#ffffff06]"}`}
                  onClick={() => toggleJiDrone(m.ratioNums[0], m.ratioNums[1])}
                  title={`${m.ratio} = ${m.jiCents.toFixed(2)}¢ · err ${errStr}¢${m.name ? " · " + m.name : ""}\nClick to toggle JI drone`}>
                  <span style={{ color: jiActive ? "#fff" : "#ccc" }}>{m.ratio}</span>
                  {m.name && <span style={{ color: "#555", fontSize: 8, marginLeft: 4 }}>{m.name}</span>}
                </td>
                <td className={`font-mono select-none px-1 ${jiActive ? "bg-[#7aaa7a15]" : ""}`} style={{ whiteSpace: "nowrap" }}>
                  <span style={{ color: limColor, fontSize: 9 }}>{m.limit}</span>
                  <span style={{ color: Math.abs(m.errorCents) < 1 ? "#5a9a5a" : Math.abs(m.errorCents) < 3 ? "#7aaa7a" : Math.abs(m.errorCents) < 6 ? "#cc9933" : "#cc5544", fontSize: 9, marginLeft: 4 }}>{errStr}¢</span>
                </td>
              </>);
            };

            return (
            <tr key={iv.step} className="hover:bg-[#ffffff04]" style={{ borderBottom: "1px solid #181818" }}>
              <td className={`font-mono text-[#9395ea] cursor-pointer select-none rounded px-1 ${edoActive ? "bg-[#9395ea22]" : ""}`}
                onClick={() => toggleEdoDrone(iv.step)}>{iv.step}</td>
              <td className={`font-mono cursor-pointer select-none px-1 ${edoActive ? "bg-[#9395ea22] text-white" : "text-[#999]"}`}
                onClick={() => toggleEdoDrone(iv.step)} title="Toggle EDO drone">{iv.cents.toFixed(1)}</td>
              {renderJICells(iv.ji10)}
              {renderJICells(iv.ji5)}
              {renderJICells(iv.ji2)}
            </tr>
            );
          })}
          </tbody>
        </table>
      </div>

      {/* Chords */}
      {edoData.chords.length > 0 && (
        <div className="bg-[#111] border border-[#222] rounded-lg p-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="text-xs font-bold text-[#999]">Chords ({edoData.chords.length})</h4>
            <span className="text-[9px] text-[#555]">click to drone (multiple)</span>
          </div>
          <div className="grid grid-cols-[auto_auto_auto] gap-x-4 gap-y-1 text-[10px]">
            <span className="text-[#666] font-medium">Name</span><span className="text-[#666] font-medium">Steps (EDO)</span><span className="text-[#666] font-medium">≈ JI</span>
            {edoData.chords.map(ch => {
              const edoActive = activeDrones.has(`ch-${ch.name}`);
              const jiActive = activeDrones.has(`ji-ch-${ch.name}`);
              return (
              <React.Fragment key={ch.name}>
                <span className="text-[#bbb] select-none">{ch.name}</span>
                <span className={`font-mono cursor-pointer select-none rounded px-0.5 ${edoActive ? "bg-[#9395ea33] ring-1 ring-[#9395ea66] text-white" : "text-[#9395ea] hover:bg-[#ffffff08]"}`}
                  onClick={() => toggleChordDrone(ch.steps, ch.name)} title="Toggle EDO chord drone">{ch.steps.join("-")}</span>
                <span className={`font-mono cursor-pointer select-none rounded px-0.5 ${jiActive ? "bg-[#7aaa7a33] ring-1 ring-[#7aaa7a66] text-white" : "text-[#666] hover:bg-[#ffffff08]"}`}
                  onClick={() => toggleJiChordDrone(ch.jiApprox, ch.name)} title="Toggle JI chord drone">{ch.jiApprox}</span>
              </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {/* Scales */}
      {edoData.scales.length > 0 && (
        <div className="bg-[#111] border border-[#222] rounded-lg p-4">
          <h4 className="text-xs font-bold text-[#999] mb-2">Scales</h4>
          <div className="space-y-2">
            {edoData.scales.filter(s => s.name !== "Chromatic").map(s => (
              <div key={s.name} className="flex items-center gap-3">
                <span className="text-xs text-[#bbb] min-w-[80px]">{s.name}</span>
                <span className="text-[10px] font-mono text-[#666]">[{s.pattern}]</span>
                <span className="text-[10px] font-mono text-[#555]">{s.steps.length} notes</span>
                <PlayBtn small onClick={() => playScale(s.steps)} title={`Play ${s.name} scale`} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* MOS patterns */}
      {edoData.mosPatterns.length > 0 && (
        <div className="bg-[#111] border border-[#222] rounded-lg p-4">
          <h4 className="text-xs font-bold text-[#999] mb-2">MOS Patterns (from fifth generator)</h4>
          <div className="space-y-1">
            {edoData.mosPatterns.map((m, i) => (
              <div key={i} className="flex items-center gap-3 text-[10px]">
                <span className="text-[#9395ea] font-mono font-bold">{m.L}L {m.s}s</span>
                <span className="text-[#666] font-mono">[{m.steps}]</span>
                <span className="text-[#555]">{m.L + m.s} notes</span>
                <PlayBtn small onClick={async () => {
                  await ensureAudio(selectedEdo);
                  // Build scale from MOS pattern
                  const steps: number[] = [0]; let pos = 0;
                  for (const ch of m.steps.split(" ")) { pos += +ch; steps.push(pos); }
                  playScale(steps.slice(0, -1)); // remove the octave duplicate
                }} title={`Play ${m.L}L${m.s}s scale`} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Comma Analysis ── */}
      <div className="bg-[#111] border border-[#222] rounded-lg p-4 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h4 className="text-xs font-bold text-[#999]">Comma Analysis</h4>
          <div className="flex gap-1">
            {PRIME_LIMITS.map((pl, i) => (
              <button key={pl.label} onClick={() => setPrimeLimitIdx(i)}
                className={`px-2 py-0.5 text-[10px] rounded font-mono ${primeLimitIdx === i
                  ? "bg-[#7173e6] text-white"
                  : "bg-[#1a1a1a] text-[#888] border border-[#2a2a2a] hover:text-white"}`}>
                {pl.label}
              </button>
            ))}
          </div>
        </div>

        {/* Commas needed summary */}
        <div className="flex items-center gap-4 flex-wrap text-xs">
          <span className="text-[#bbb]">
            {PRIME_LIMITS[primeLimitIdx].label}: <strong className="text-[#9395ea]">{commasNeeded}</strong> independent comma{commasNeeded !== 1 ? "s" : ""} needed
            <span className="text-[#555] ml-1">({selectedPrimes.length} primes &minus; 1)</span>
          </span>
          <span className={`font-mono ${basisCommas.length >= commasNeeded ? "text-[#7aaa7a]" : "text-[#ddaa55]"}`}>
            {basisCommas.length} found in DB
            {basisCommas.length < commasNeeded && <span className="text-[#e06060] ml-1">(need {commasNeeded - basisCommas.length} more)</span>}
          </span>
          <span className="text-[#555]">{allTemperedCommas.length} total tempered</span>
        </div>

        {/* Independent basis */}
        {basisCommas.length > 0 && (
          <div>
            <div className="text-[10px] text-[#9395ea] font-medium mb-1.5">Independent Basis ({basisCommas.length}/{commasNeeded})</div>
            <div className="space-y-1">
              {basisCommas.map(c => {
                const monzoStr = c.monzo.slice(0, selectedPrimes.length).map((e, i) => e !== 0 ? `${selectedPrimes[i]}^${e}` : null).filter(Boolean).join(" · ");
                return (
                  <div key={`${c.n}/${c.d}`} className="flex items-center gap-2 px-2 py-1.5 rounded bg-[#1a1a2a] border border-[#2a2a4a]">
                    <span className="text-xs font-mono text-[#9395ea] min-w-[70px]">{c.n}/{c.d}</span>
                    <span className="text-[10px] text-[#bbb] min-w-[100px]">{c.name}</span>
                    <span className="text-[10px] text-[#666]">{c.cents.toFixed(1)}¢</span>
                    <span className="text-[9px] text-[#555] font-mono">[{monzoStr}]</span>
                    <PlayBtn small onClick={() => playComma(c.n, c.d)} title={`Hear ${c.name}`} />
                    <button onClick={() => playAB(c.n, c.d)} title="A/B: JI comma vs unison"
                      className="w-5 h-5 text-[8px] flex items-center justify-center rounded bg-[#1a1a2a] border border-[#2a2a4a] text-[#8888cc] hover:text-[#aaaaff] flex-shrink-0">AB</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Dependent commas */}
        {dependentCommas.length > 0 && (
          <div>
            <div className="text-[10px] text-[#7aaa7a] font-medium mb-1">Also Tempered — linearly dependent ({dependentCommas.length})</div>
            <div className="flex flex-wrap gap-1.5">
              {dependentCommas.map(c => (
                <div key={`${c.n}/${c.d}`} className="px-2 py-1 rounded bg-[#1a2a1a] border border-[#2a4a2a] text-xs flex items-center gap-1.5">
                  <span className="text-[#7aaa7a] font-mono">{c.n}/{c.d}</span>
                  <span className="text-[#555]">{c.name}</span>
                  <span className="text-[#444]">({c.cents.toFixed(1)}¢)</span>
                  <PlayBtn small onClick={() => playComma(c.n, c.d)} title={`Hear ${c.name}`} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Outside limit */}
        {outsideLimitCommas.length > 0 && (
          <div>
            <div className="text-[10px] text-[#666] font-medium mb-1">Outside {PRIME_LIMITS[primeLimitIdx].label} ({outsideLimitCommas.length})</div>
            <div className="flex flex-wrap gap-1">
              {outsideLimitCommas.map(c => (
                <span key={`${c.n}/${c.d}`} className="px-1.5 py-0.5 rounded bg-[#151515] border border-[#222] text-[10px] text-[#555] font-mono">
                  {c.n}/{c.d} <span className="text-[#444]">[{c.primes.filter(p => p !== 2).join(",")}]</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Lattice Bounds ── */}
      <div className="bg-[#111] border border-[#222] rounded-lg p-4 space-y-3">
        <h4 className="text-xs font-bold text-[#999]">Lattice Bounds</h4>
        <div className="text-[10px] text-[#666]">Auto-computed from basis commas. Expand to include more dependent commas.</div>

        <div className="space-y-2">
          {latticePrimes.map(p => {
            const [bLo, bHi] = activeBounds[p] ?? [0, 0];
            const [minLo, minHi] = basisMinBounds[p] ?? [0, 0];
            return (
              <div key={p} className="flex items-center gap-2">
                <span className="text-[10px] font-mono w-6 text-right font-bold" style={{ color: MONZO_PRIME_COLORS[p] ?? "#888" }}>{p}</span>
                <button onClick={() => expandBound(p, bLo - 1, bHi)}
                  className="w-5 h-5 rounded text-[10px] bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white flex items-center justify-center">−</button>
                <span className="text-[10px] font-mono text-[#bbb] min-w-[50px] text-center">[{bLo}, {bHi}]</span>
                <button onClick={() => expandBound(p, bLo, bHi + 1)}
                  className="w-5 h-5 rounded text-[10px] bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:text-white flex items-center justify-center">+</button>
                <span className="text-[9px] text-[#555]">basis min: [{minLo},{minHi}]</span>
              </div>
            );
          })}
        </div>

        <div className="text-[10px] text-[#888]">
          <span className="text-[#7aaa7a]">{activeCm.length} fit</span>
          {needsExpCm.length > 0 && <> · <span className="text-[#ddaa55]">{needsExpCm.length} need wider bounds</span></>}
          {wrongPCm.length > 0 && <> · <span className="text-[#666]">{wrongPCm.length} need higher primes</span></>}
        </div>

        {needsExpCm.length > 0 && (
          <div className="space-y-1">
            {needsExpCm.map(({ comma: c, minBounds: mb }) => {
              const neededBounds = Object.entries(mb).filter(([p]) => +p !== 2 && latticePrimes.includes(+p)).map(([p, [lo, hi]]) => {
                const [bLo, bHi] = activeBounds[+p] ?? [0, 0];
                if (lo >= bLo && hi <= bHi) return null;
                return { prime: +p, lo: Math.min(lo, bLo), hi: Math.max(hi, bHi), label: `${p}[${Math.min(lo, bLo)},${Math.max(hi, bHi)}]` };
              }).filter(Boolean) as { prime: number; lo: number; hi: number; label: string }[];
              return (
                <div key={`${c.n}/${c.d}`} className="flex items-center gap-2 text-xs flex-wrap">
                  <span className="font-mono text-[#ddaa55]">{c.n}/{c.d}</span>
                  <span className="text-[#666]">{c.name}</span>
                  {neededBounds.map(nb => (
                    <button key={nb.prime} onClick={() => expandBound(nb.prime, nb.lo, nb.hi)}
                      className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#2a2a1a] border border-[#4a4a2a] text-[#ddaa55] hover:text-white cursor-pointer">
                      expand {nb.label}
                    </button>
                  ))}
                  <PlayBtn small onClick={() => playComma(c.n, c.d)} title={`Hear ${c.name}`} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Tempered Lattice Preview */}
      <EdoLatticePreview latticePrimes={latticePrimes} bounds={activeBounds} basisCommas={basisCommas} selectedEdo={selectedEdo} />

      {/* Temperaments */}
      {edoData.temperaments.length > 0 && (
        <div className="bg-[#111] border border-[#222] rounded-lg p-4">
          <h4 className="text-xs font-bold text-[#999] mb-2">Temperament Families ({edoData.temperaments.length})</h4>
          <div className="space-y-2">
            {edoData.temperaments.map(name => {
              const f = TEMPERAMENT_FAMILIES.find(t => t.name === name);
              return (
                <div key={name} className="flex items-start gap-2 bg-[#0d0d0d] rounded px-3 py-2 border border-[#1e1e1e]">
                  <span className="text-xs font-bold text-[#9395ea] min-w-[90px]">{name}</span>
                  <div className="text-[10px] text-[#888]">{f?.description} <span className="text-[#555] ml-1">[{f?.commas.map(c => `${c.n}/${c.d}`).join(", ")}]</span></div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Ring guide: draws a faint circle and step markers in the 3D scene */
function RingGuide({ edo, classColorMap, classData }: {
  edo: number;
  classColorMap: Map<number, string>;
  classData: { id: number; color: string; rep: string; members: { key: string; name: string; cents: number }[] }[];
}) {
  const R = Math.max(3, edo * 0.35);
  // Draw ring circle as line segments
  const circlePoints: [number, number, number][] = [];
  const segments = Math.max(64, edo * 4);
  for (let i = 0; i <= segments; i++) {
    const angle = (2 * Math.PI * i) / segments - Math.PI / 2;
    circlePoints.push([R * Math.cos(angle), 0, R * Math.sin(angle)]);
  }

  // Step markers with labels
  const stepMarkers = useMemo(() => {
    const markers: { pos: [number, number, number]; step: number; color: string; rep: string; cents: number }[] = [];
    for (let step = 0; step < edo; step++) {
      const angle = (2 * Math.PI * step) / edo - Math.PI / 2;
      const x = (R + 0.8) * Math.cos(angle);
      const z = (R + 0.8) * Math.sin(angle);
      const cd = classData.find(c => c.id === step);
      markers.push({
        pos: [x, 0, z],
        step,
        color: classColorMap.get(step) ?? "#555",
        rep: cd?.rep ?? `step ${step}`,
        cents: step * (1200 / edo),
      });
    }
    return markers;
  }, [edo, R, classColorMap, classData]);

  return (
    <>
      <Line points={circlePoints} color="#333" lineWidth={1} transparent opacity={0.4} />
      {stepMarkers.map(m => (
        <group key={m.step} position={m.pos}>
          {/* Use lightweight spheres for large EDOs to avoid DOM overhead from Html overlays */}
          {edo <= 53 ? (
            <Html center style={{ pointerEvents: "none", userSelect: "none" }}>
              <div className="text-center whitespace-nowrap" style={{ transform: "scale(0.75)" }}>
                <div className="text-[10px] font-bold font-mono" style={{ color: m.color, textShadow: "0 0 4px #000" }}>{m.cents.toFixed(0)}¢</div>
                <div className="text-[8px] text-[#666] font-mono" style={{ textShadow: "0 0 3px #000" }}>step {m.step}</div>
              </div>
            </Html>
          ) : (
            <mesh>
              <sphereGeometry args={[0.25, 8, 6]} />
              <meshStandardMaterial color={m.color} emissive={m.color} emissiveIntensity={0.3} />
            </mesh>
          )}
        </group>
      ))}
    </>
  );
}

/**
 * Generating the EDO — 3-stage pipeline:
 *
 *   ratios  →  val  →  ℤ/n  →  cents
 *
 *   Stage 0: JI lattice (pure ratios in ℤⁿ)
 *   Stage 1 — TEMPER:  collapse commas → equivalence classes (ℤⁿ / ker)
 *   Stage 2 — VAL:     map classes → step numbers on the ring (val: ℤⁿ → ℤ/n)
 *   Stage 3 — EMBED:   assign cent sizes → actual frequencies (n ↦ 100n¢ for 12-EDO)
 *
 * The val already encodes both the tempering (kernel = what maps to 0 mod n)
 * and the ring structure. The embedding gives it geometry.
 */
type EdoPipelineStage = 0 | 1 | 2 | 3;
const PIPELINE_LABELS: Record<EdoPipelineStage, { label: string; desc: string; math: string; color: string }> = {
  0: { label: "JI Lattice", desc: "Pure ratios — infinite just intonation", math: "ℤⁿ", color: "#888" },
  1: { label: "Temper", desc: "Collapse commas → equivalence classes", math: "ℤⁿ / ker", color: "#7173e6" },
  2: { label: "Val", desc: "Map each class → step number on the ring", math: "val: ℤⁿ → ℤ/n", color: "#ddaa55" },
  3: { label: "Embed", desc: "Assign cent sizes → actual frequencies", math: "n ↦ step × cents", color: "#7aaa7a" },
};

function EdoLatticePreview({ latticePrimes, bounds, basisCommas, selectedEdo }: {
  latticePrimes: number[];
  bounds: Record<number, [number, number]>;
  basisCommas: CommaInfo[];
  selectedEdo: number;
}) {
  const [showLabels, setShowLabels] = useState(true);
  const [showEdges, setShowEdges] = useState(true);
  const [showKernel, setShowKernel] = useState(false);
  const [showFD, setShowFD] = useState(false);
  const [showDerivation, setShowDerivation] = useState(false);
  const [stage, setStage] = useState<EdoPipelineStage>(0);
  const [animProgress, setAnimProgress] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const [highlightClass, setHighlightClass] = useState<number | null>(null);
  const [cameraResetKey, setCameraResetKey] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [ringDroneKeys, setRingDroneKeys] = useState<Set<string>>(new Set());
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!canvasContainerRef.current) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else canvasContainerRef.current.requestFullscreen();
  }, []);

  const commaSpecs: CommaSpec[] = useMemo(
    () => basisCommas.map(c => ({ n: c.n, d: c.d, name: c.name })),
    [basisCommas],
  );

  // Reset when EDO/primes/bounds change
  useEffect(() => { setStage(0); setAnimProgress(0); setIsAnimating(false); setHighlightClass(null); setCameraResetKey(k => k + 1); }, [selectedEdo, latticePrimes.join(","), JSON.stringify(bounds)]);

  const stepCents = +(1200 / selectedEdo).toFixed(4);

  const cfg: LatticeConfig = useMemo(() => ({
    primes: latticePrimes,
    bounds,
    octaveEquivalence: true,
    showPrime2: false,
    projections: getProjections("triangle"),
    temperedCommas: [],
    gridType: "triangle" as const,
    edo: selectedEdo,
  }), [latticePrimes, bounds, selectedEdo]);

  // Stage 0: untempered JI lattice
  const uLat = useMemo(() => buildLattice(cfg), [cfg]);
  // Stage 1: fully tempered lattice (all commas at once)
  const tLat = useMemo(() =>
    commaSpecs.length > 0
      ? buildLattice({ ...cfg, temperedCommas: commaSpecs })
      : uLat,
    [cfg, commaSpecs, uLat],
  );
  // Stage 1 coset view: uses cosetPositions so equivalent nodes form visible
  // clusters instead of collapsing to a single point. This is the correct
  // geometric picture of the quotient Z^n / <commas>.
  const cosetLat = useMemo(() => {
    if (!tLat || tLat.cosetPositions.size === 0) return tLat;
    return { ...tLat, positions: tLat.cosetPositions };
  }, [tLat]);
  // Stage 2: ring layout (val assigns step numbers)
  const ringLat = useMemo(() => {
    if (!tLat || tLat.classMap.size === 0) return null;
    const ringPositions = computeEdoRingPositions(tLat, selectedEdo);
    return { ...tLat, positions: ringPositions };
  }, [tLat, selectedEdo]);

  // Determine the "from" and "to" lattices for animation based on stage transitions
  const stableStage = isAnimating ? Math.max(0, stage - 1) as EdoPipelineStage : stage;
  const targetStage = isAnimating ? stage : stage;

  const latForStage = useCallback((s: EdoPipelineStage): BuiltLattice => {
    if (s === 0) return uLat;
    if (s === 1) return cosetLat;
    if (s >= 2 && ringLat) return ringLat;
    return cosetLat; // fallback
  }, [uLat, cosetLat, ringLat]);

  const from = useMemo(() => latForStage(isAnimating ? stableStage : stage), [latForStage, isAnimating, stableStage, stage]);
  const to = useMemo(() => latForStage(targetStage), [latForStage, targetStage]);

  const currentLattice = latForStage(stage);
  const isOnRing = stage >= 2;
  const isEmbedded = stage >= 3;

  // Pipeline navigation
  const advance = useCallback(() => {
    if (stage >= 3 || isAnimating) return;
    const next = (stage + 1) as EdoPipelineStage;
    // Skip temper step if no commas
    if (next === 1 && commaSpecs.length === 0) {
      setStage(2 as EdoPipelineStage);
    } else {
      setStage(next);
    }
    setIsAnimating(true);
    setAnimProgress(0);
  }, [stage, isAnimating, commaSpecs.length]);

  const retreat = useCallback(() => {
    if (stage <= 0 || isAnimating) return;
    const prev = (stage - 1) as EdoPipelineStage;
    // Skip temper step if no commas
    if (prev === 1 && commaSpecs.length === 0) {
      setStage(0 as EdoPipelineStage);
    } else {
      setStage(prev);
    }
    setIsAnimating(true);
    setAnimProgress(0);
  }, [stage, isAnimating, commaSpecs.length]);

  const jumpTo = useCallback((target: EdoPipelineStage) => {
    if (isAnimating || target === stage) return;
    setStage(target);
    setIsAnimating(true);
    setAnimProgress(0);
  }, [isAnimating, stage]);

  const resetPipeline = useCallback(() => {
    setRingDroneKeys(prev => { for (const k of prev) audioEngine.stopIntervalDroneByKey(k); return new Set(); });
    setStage(0);
    setAnimProgress(0);
    setIsAnimating(false);
    setHighlightClass(null);
  }, []);

  const onAnimDone = useCallback(() => {
    setAnimProgress(0);
    setIsAnimating(false);
  }, []);

  // Ring drone: toggle a JI ratio drone on node click (with root drone)
  const toggleRingDrone = useCallback(async (key: string, n: number, d: number) => {
    const droneKey = `ring-${key}`;
    if (audioEngine.isIntervalDronePlaying(droneKey)) {
      audioEngine.stopIntervalDroneByKey(droneKey);
      setRingDroneKeys(prev => { const s = new Set(prev); s.delete(droneKey); return s; });
    } else {
      await ensureAudio(selectedEdo);
      // Use EDO step frequency (embedded) rather than JI ratio
      const jiCents = 1200 * Math.log2(n / d);
      const rawStep = Math.round(jiCents / (1200 / selectedEdo));
      // Octave-reduce to keep within one octave of C4
      const edoStep = ((rawStep % selectedEdo) + selectedEdo) % selectedEdo;
      const freq = C4_FREQ * Math.pow(2, edoStep / selectedEdo);
      audioEngine.startIntervalDrone(droneKey, freq, 0.7);
      setRingDroneKeys(prev => new Set(prev).add(droneKey));
    }
  }, [selectedEdo]);

  const stopAllRingDrones = useCallback(() => {
    setRingDroneKeys(prev => {
      for (const k of prev) audioEngine.stopIntervalDroneByKey(k);
      return new Set();
    });
  }, []);

  // Stop drones when leaving ring stages
  useEffect(() => {
    if (!isOnRing) stopAllRingDrones();
  }, [isOnRing, stopAllRingDrones]);

  // Build equivalence class data for the legend
  const CLASS_COLORS = ["#e06060","#60e060","#6060e0","#e0e060","#e060e0","#60e0e0","#ff8844","#44ff88","#8844ff","#ffaa66","#66ffaa","#aa66ff","#ff6688","#88ff66","#6688ff"];
  const classData = useMemo(() => {
    const lat = currentLattice;
    if (!lat.classMap || lat.classMap.size === 0) return [];
    const groups = new Map<number, { key: string; n: number; d: number; name: string; cents: number }[]>();
    for (const [k, id] of lat.classMap) {
      if (!groups.has(id)) groups.set(id, []);
      const [n, d] = k.split("/").map(Number);
      groups.get(id)!.push({ key: k, n, d, name: monzoIntervalName(n, d), cents: ratioToCents(n, d) });
    }
    const result: { id: number; color: string; rep: string; members: { key: string; name: string; cents: number }[] }[] = [];
    let ci = 0;
    for (const [id, members] of groups) {
      members.sort((a, b) => (a.n + a.d) - (b.n + b.d));
      result.push({
        id,
        color: CLASS_COLORS[ci % CLASS_COLORS.length],
        rep: members[0].key,
        members: members.map(m => ({ key: m.key, name: m.name, cents: m.cents })),
      });
      ci++;
    }
    result.sort((a, b) => a.members[0].cents - b.members[0].cents);
    return result;
  }, [currentLattice]);

  const classColorMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const cd of classData) m.set(cd.id, cd.color);
    return m;
  }, [classData]);

  // Derive val: for each class, compute the EDO step = round(1200 * log2(ratio) / stepCents)
  const valMap = useMemo(() => {
    const m = new Map<number, { step: number; cents: number; freq: number }>();
    for (const cd of classData) {
      const [n, d] = cd.rep.split("/").map(Number);
      const jiCents = 1200 * Math.log2(n / d);
      const edoStep = Math.round(jiCents / stepCents);
      const edoCents = edoStep * stepCents;
      const freq = C4_FREQ * Math.pow(2, edoStep / selectedEdo);
      m.set(cd.id, { step: ((edoStep % selectedEdo) + selectedEdo) % selectedEdo, cents: +edoCents.toFixed(2), freq });
    }
    return m;
  }, [classData, stepCents, selectedEdo]);

  // Embed stage: only show one representative node per EDO step class, with cent/freq labels
  const embedVisibleKeys = useMemo(() => {
    if (!isEmbedded) return undefined;
    const s = new Set<string>();
    for (const cd of classData) s.add(cd.rep); // one rep per class
    return s;
  }, [isEmbedded, classData]);

  const embedLabelMap = useMemo(() => {
    if (!isEmbedded) return undefined;
    const m = new Map<string, { step: number; cents: string; freq: string }>();
    for (const cd of classData) {
      const v = valMap.get(cd.id);
      if (v) m.set(cd.rep, { step: v.step, cents: v.cents.toFixed(1), freq: v.freq.toFixed(1) });
    }
    return m;
  }, [isEmbedded, classData, valMap]);

  // ── Debug: kernel analysis ──
  const [showDebug, setShowDebug] = useState(false);
  const debugInfo = useMemo(() => {
    // Compute comma monzos in the working dimension (octave-equiv → skip prime 2)
    const workingPrimes = latticePrimes; // already excludes 2 when octaveEq
    const allPrimes = [2, ...latticePrimes]; // full primes array as used by factorize
    const commaMonzos = commaSpecs.map(c => {
      const full = factorize(c.n, c.d, allPrimes, true);
      // Drop the prime-2 slot (index 0) since we're octave-equivalent
      return full.slice(1);
    });
    const dim = workingPrimes.length;

    // Filter out zero vectors (commas that vanish under octave equivalence)
    const nonZero = commaMonzos.filter(v => v.some(x => x !== 0));
    const zeroCount = commaMonzos.length - nonZero.length;

    // Compute rank via Gaussian elimination
    const rankMatrix = nonZero.map(r => [...r]);
    let rank = 0;
    const nCols = dim;
    const nRows = rankMatrix.length;
    for (let c = 0; c < nCols && rank < nRows; c++) {
      let pivot = -1;
      let bestAbs = 1e-10;
      for (let i = rank; i < nRows; i++) {
        if (Math.abs(rankMatrix[i][c]) > bestAbs) { bestAbs = Math.abs(rankMatrix[i][c]); pivot = i; }
      }
      if (pivot === -1) continue;
      [rankMatrix[rank], rankMatrix[pivot]] = [rankMatrix[pivot], rankMatrix[rank]];
      const scale = rankMatrix[rank][c];
      for (let j = c; j < nCols; j++) rankMatrix[rank][j] /= scale;
      for (let i = 0; i < nRows; i++) {
        if (i === rank) continue;
        const f = rankMatrix[i][c];
        if (Math.abs(f) < 1e-10) continue;
        for (let j = c; j < nCols; j++) rankMatrix[i][j] -= f * rankMatrix[rank][j];
      }
      rank++;
    }

    // Quotient group analysis via SNF
    const quotient = nonZero.length > 0
      ? analyzeQuotientGroup(nonZero, dim)
      : { invariantFactors: [], cyclicOrders: [], freeDims: dim, collapsedDims: 0 };

    // Determinant of the comma matrix (when square or via product of invariant factors)
    const groupSize = quotient.cyclicOrders.length > 0
      ? quotient.cyclicOrders.reduce((a, b) => a * b, 1)
      : (rank === 0 ? Infinity : 0);

    // Val vector
    const val = workingPrimes.map(p => Math.round(selectedEdo * Math.log2(p)));

    // Expected: for rank-1 temperament (EDO), need dim-1 independent commas
    const neededRank = dim - 1;
    const isFullyDetermined = rank >= neededRank;
    const isOverDetermined = rank > neededRank;
    const willCollapse = rank >= dim; // kills all dimensions

    return {
      workingPrimes,
      dim,
      commaMonzos: nonZero,
      zeroCount,
      rank,
      neededRank,
      isFullyDetermined,
      isOverDetermined,
      willCollapse,
      quotient,
      groupSize,
      val,
      allCommaLabels: commaSpecs.map((c, i) => ({
        label: `${c.n}/${c.d}`,
        name: c.name,
        monzo: commaMonzos[i] ?? [],
        isZero: commaMonzos[i]?.every(x => x === 0) ?? true,
      })),
    };
  }, [commaSpecs, latticePrimes, selectedEdo]);

  if (latticePrimes.length === 0 || uLat.nodes.length < 2) return null;

  const stageInfo = PIPELINE_LABELS[stage];
  const canAdvance = stage < 3 && !isAnimating;
  const canRetreat = stage > 0 && !isAnimating;
  const nextStageLabel = stage < 3 ? PIPELINE_LABELS[(stage + 1) as EdoPipelineStage] : null;

  return (
    <div className="bg-[#111] border border-[#222] rounded-lg p-4 space-y-3">
      {/* Pipeline header */}
      <div className="flex items-center gap-3 flex-wrap">
        <h4 className="text-xs font-bold text-[#999]">Generating {selectedEdo}-EDO</h4>
        <label className="text-xs text-[#666] flex items-center gap-1">
          <input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-[#7173e6]" />
          Labels
        </label>
        <label className="text-xs text-[#666] flex items-center gap-1">
          <input type="checkbox" checked={showEdges} onChange={e => setShowEdges(e.target.checked)} className="accent-[#7173e6]" />
          Edges
        </label>
        <label className="text-xs text-[#666] flex items-center gap-1">
          <input type="checkbox" checked={showKernel} onChange={e => setShowKernel(e.target.checked)} className="accent-[#ff4466]" />
          Kernel
        </label>
        <label className="text-xs text-[#666] flex items-center gap-1">
          <input type="checkbox" checked={showFD} onChange={e => setShowFD(e.target.checked)} className="accent-[#44ddaa]" />
          Fund. Domain
        </label>
        <span className="text-[10px] text-[#555]">{from.nodes.length} nodes</span>
        {currentLattice.temperingClasses > 0 && (
          <span className="text-[10px] text-[#7aaa7a]">{currentLattice.temperingClasses} classes</span>
        )}
      </div>

      {/* ── Pipeline stages ── */}
      <div className="space-y-2">
        {/* Stage indicators — clickable pipeline */}
        <div className="flex items-center gap-0">
          {([0, 1, 2, 3] as EdoPipelineStage[]).map((s, idx) => {
            const info = PIPELINE_LABELS[s];
            const isActive = s === stage;
            const isPast = s < stage;
            const isFuture = s > stage;
            const isSkipped = s === 1 && commaSpecs.length === 0;
            return (
              <React.Fragment key={s}>
                {idx > 0 && (
                  <div className="flex-shrink-0 w-6 flex items-center justify-center">
                    <svg width={20} height={12} viewBox="0 0 20 12">
                      <path d="M2 6 L15 6 M12 2 L18 6 L12 10" fill="none"
                        stroke={isPast ? info.color : "#333"} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                )}
                <button
                  onClick={() => !isSkipped && !isAnimating && jumpTo(s)}
                  disabled={isSkipped || isAnimating}
                  className={`px-3 py-1.5 rounded text-[10px] font-medium border transition-all flex-shrink-0 ${
                    isSkipped ? "opacity-20 cursor-not-allowed bg-[#111] border-[#1a1a1a] text-[#333]"
                    : isActive ? `border-2 shadow-lg`
                    : isPast ? "opacity-70"
                    : "opacity-50 hover:opacity-80"
                  }`}
                  style={{
                    borderColor: isActive ? info.color : isPast ? info.color + "66" : "#2a2a2a",
                    backgroundColor: isActive ? info.color + "22" : isPast ? info.color + "11" : "#111",
                    color: isActive ? info.color : isPast ? info.color + "aa" : "#555",
                    boxShadow: isActive ? `0 0 12px ${info.color}33` : "none",
                  }}
                >
                  {info.label}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Current stage description + math + action */}
        <div className="flex items-center gap-3 flex-wrap bg-[#0a0a0a] rounded px-3 py-2 border border-[#1a1a1a]">
          <span className="text-xs font-mono font-bold" style={{ color: stageInfo.color }}>{stageInfo.math}</span>
          <span className="text-[10px] text-[#888]">{stageInfo.desc}</span>
          {stage === 1 && commaSpecs.length > 0 && (
            <div className="flex gap-1 ml-auto flex-wrap">
              {commaSpecs.map((c, i) => (
                <span key={i} className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-[#2a4a2a] text-[#7aaa7a] border border-[#3a6a3a]">
                  {c.n}/{c.d}
                </span>
              ))}
            </div>
          )}
          {stage >= 2 && (
            <span className="text-[10px] font-mono ml-auto" style={{ color: PIPELINE_LABELS[2].color }}>
              v(p) = round({selectedEdo} · log₂ p)
            </span>
          )}
          {stage === 3 && (
            <span className="text-[10px] font-mono" style={{ color: PIPELINE_LABELS[3].color }}>
              step size = {stepCents}¢
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <button onClick={retreat} disabled={!canRetreat}
            className="px-3 py-1 rounded text-xs font-medium bg-[#1a1a1a] text-[#888] border border-[#2a2a2a] disabled:opacity-20 disabled:cursor-not-allowed hover:text-white transition-colors">
            ← Back
          </button>
          {nextStageLabel && (
            <button onClick={advance} disabled={!canAdvance}
              className="px-4 py-1 rounded text-xs font-bold border-2 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                borderColor: nextStageLabel.color,
                backgroundColor: nextStageLabel.color + "22",
                color: nextStageLabel.color,
                boxShadow: canAdvance ? `0 0 8px ${nextStageLabel.color}33` : "none",
              }}>
              {isAnimating ? "..." : nextStageLabel.label} →
            </button>
          )}
          {stage === 3 && !isAnimating && (
            <span className="text-[10px] font-bold px-2 py-1 rounded bg-[#1a2a1a] border border-[#2a4a2a]" style={{ color: PIPELINE_LABELS[3].color }}>
              {selectedEdo}-EDO complete
            </span>
          )}
          <button onClick={() => setShowDerivation(d => !d)}
            className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
              showDerivation ? "bg-[#1a1a2a] border-[#3a3a6a] text-[#9395ea]" : "bg-[#1a1a1a] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
            }`}>
            {showDerivation ? "Hide" : "Show"} Derivation
          </button>
          <button onClick={resetPipeline} className="px-3 py-1 rounded text-xs bg-[#2a1a1a] text-[#cc6666] border border-[#5a2a2a] ml-auto">Reset</button>
        </div>

        {/* ── Formal Derivation ── */}
        {showDerivation && (() => {
          const n = latticePrimes.length;
          const nonZeroCommas = debugInfo.allCommaLabels.filter(c => !c.isZero);
          const fifthMonzo = latticePrimes.map((_, i) => i === 0 ? 1 : 0);
          const fifthStep = fifthMonzo.reduce((s, e, j) => s + e * debugInfo.val[j], 0);
          const thirdMonzo = latticePrimes.length > 1 ? latticePrimes.map((_, i) => i === 1 ? 1 : 0) : null;
          const thirdStep = thirdMonzo ? thirdMonzo.reduce((s, e, j) => s + e * debugInfo.val[j], 0) : null;

          return (
          <div className="bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg p-5 space-y-5 text-[11px] leading-[1.7]">
            <h4 className="text-sm font-bold text-[#ccc]">Deriving {selectedEdo}-EDO</h4>

            {/* ════ Step 1: JI lattice ════ */}
            <div className="space-y-2 border-l-2 border-[#9395ea] pl-4">
              <div className="text-[#9395ea] font-bold text-xs">1. JI lattice — the space we start in</div>
              <div className="bg-[#111] rounded p-3 space-y-2">
                <div className="text-[#bbb]">
                  Every just intonation ratio is a product of prime powers. With octave equivalence
                  (ignoring powers of 2), each ratio maps to an exponent vector — a <strong className="text-white">monzo</strong>:
                </div>
                <div className="font-mono text-[#bbb] pl-3">
                  2<sup>a</sup> · {latticePrimes.map((p, i) => <span key={p}>{p}<sup>{String.fromCharCode(98 + i)}</sup>{i < n - 1 ? " · " : ""}</span>)}
                  {" "}↦ [{latticePrimes.map((_, i) => String.fromCharCode(98 + i)).join(", ")}] ∈ <span className="text-[#9395ea]">ℤ<sup>{n}</sup></span>
                </div>
                <div className="text-[#888] text-[10px] pl-3">
                  ℤ<sup>{n}</sup> means: all {n}-tuples of integers. Each coordinate counts how many times a prime appears.
                  This is the {n}D grid (lattice) you see on screen — <strong className="text-[#bbb]">infinite in every direction</strong>.
                </div>
                <div className="font-mono text-[10px] space-y-0.5 pl-3 border-t border-[#1e1e1e] pt-2 mt-1">
                  <div className="text-[#aaa]">3/2 → [{fifthMonzo.join(", ")}]<span className="text-[#666]">  (one step along the {latticePrimes[0]}-axis)</span></div>
                  {thirdMonzo && <div className="text-[#aaa]">5/4 → [{thirdMonzo.join(", ")}]<span className="text-[#666]">  (one step along the {latticePrimes[1]}-axis)</span></div>}
                  {n >= 2 && <div className="text-[#aaa]">9/8 → [{latticePrimes.map((_, i) => i === 0 ? 2 : 0).join(", ")}]<span className="text-[#666]">  (two fifths up = major 2nd)</span></div>}
                </div>
              </div>
            </div>

            {/* ════ Step 2: Tempering (FIRST) ════ */}
            <div className="space-y-2 border-l-2 pl-4" style={{ borderColor: PIPELINE_LABELS[1].color }}>
              <div className="font-bold text-xs" style={{ color: PIPELINE_LABELS[1].color }}>2. Tempering — defining equivalence</div>
              <div className="bg-[#111] rounded p-3 space-y-2">
                <div className="text-[#bbb]">
                  A <strong className="text-white">comma</strong> is a small JI interval — two different paths through the lattice that land
                  almost on the same pitch. <strong className="text-white">Tempering</strong> declares these commas equal to zero:
                </div>
                <div className="font-mono pl-3" style={{ color: PIPELINE_LABELS[1].color }}>
                  ℤ<sup>{n}</sup> / ⟨commas⟩
                </div>
                <div className="text-[#888] text-[10px] pl-3">
                  This is a <strong className="text-[#bbb]">quotient group</strong>: we take the infinite lattice ℤ<sup>{n}</sup> and declare that
                  any two points whose difference is a comma (or sum of commas) are <em>the same point</em>.
                  The slash "/" means "modulo" — collapse the comma directions to zero.
                </div>

                {nonZeroCommas.length > 0 && (
                  <div className="border-t border-[#1e1e1e] pt-2 mt-2 space-y-2.5">
                    <div className="text-[10px] text-[#666]">Commas in the kernel of {selectedEdo}-EDO:</div>
                    {nonZeroCommas.map((c, i) => {
                      const commaCents = COMMA_DB.find(db => `${db.n}/${db.d}` === c.label)?.cents ?? 0;
                      return (
                        <div key={i} className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-bold" style={{ color: PIPELINE_LABELS[1].color }}>{c.label}</span>
                            <span className="text-[#bbb]">{c.name}</span>
                            <span className="text-[#666]">({commaCents.toFixed(1)}¢)</span>
                          </div>
                          <div className="font-mono text-[10px] pl-3 text-[#aaa]">
                            monzo = [{c.monzo.join(", ")}]
                          </div>
                          <div className="text-[10px] pl-3 text-[#888]">
                            {c.label === "81/80" && <>
                              = 3<sup>4</sup> · 5<sup>-1</sup>. Four fifths up minus one third = nearly zero.
                              <br />Tempering this out means: <strong className="text-[#bbb]">the path "four fifths" and the path "one third + two octaves" lead to the same note</strong>.
                            </>}
                            {c.label === "128/125" && <>
                              = 5<sup>-3</sup>. Three major thirds (5/4)³ = 125/64 ≈ 2/1 but not exactly.
                              <br />Tempering this out means: <strong className="text-[#bbb]">three major thirds exactly equal one octave</strong>.
                            </>}
                            {c.label === "531441/524288" && <>
                              = 3<sup>12</sup>. Twelve fifths (3/2)¹² = 531441/4096 ≈ 128 = 2⁷ but not exactly.
                              <br />Tempering this out means: <strong className="text-[#bbb]">twelve fifths close the circle, landing back on the starting note</strong>.
                            </>}
                            {c.label === "225/224" && <>
                              = 3<sup>2</sup> · 5<sup>2</sup> · 7<sup>-1</sup>. The septimal kleisma — 15/14 ≈ 16/15.
                              <br />Tempering this out means: <strong className="text-[#bbb]">the two chromatic semitones (one from 7, one from 5) become identical</strong>.
                            </>}
                            {c.label === "64/63" && <>
                              = 3<sup>-2</sup> · 7<sup>-1</sup>. The septimal comma — 7/4 ≈ 16/9.
                              <br />Tempering this out means: <strong className="text-[#bbb]">the harmonic 7th and the Pythagorean minor 7th become the same interval</strong>.
                            </>}
                            {!["81/80", "128/125", "531441/524288", "225/224", "64/63"].includes(c.label) && <>
                              Declaring [{c.monzo.join(", ")}] = [0, ..., 0] in the lattice.
                            </>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="bg-[#111] rounded p-3 space-y-2">
                <div className="text-[10px] text-[#888]">
                  <strong className="text-[#bbb]">The algebra:</strong> the comma monzos form a matrix.
                  Its rank determines how many dimensions we collapse.
                </div>
                <div className="font-mono text-[10px] pl-3 text-[#aaa]">
                  Comma matrix rank: <strong style={{ color: debugInfo.rank >= debugInfo.neededRank ? "#7aaa7a" : "#ddaa55" }}>{debugInfo.rank}</strong>
                  <span className="text-[#666]"> / dim {n}</span>
                  <span className="text-[#555]"> — need rank {debugInfo.neededRank} (= {n} - 1) for a rank-1 temperament (= an EDO)</span>
                </div>
                {debugInfo.quotient.invariantFactors.length > 0 && (
                  <div className="font-mono text-[10px] pl-3 text-[#aaa]">
                    Quotient: ℤ<sup>{n}</sup> / ker ≅ <strong className="text-[#cc88cc]">{debugInfo.quotient.cyclicOrders.length > 0
                      ? debugInfo.quotient.cyclicOrders.map(d => `ℤ/${d}`).join(" × ")
                      : "ℤ"}{debugInfo.quotient.freeDims > 0 ? ` × ℤ${debugInfo.quotient.freeDims > 1 ? `^${debugInfo.quotient.freeDims}` : ""}` : ""}</strong>
                    <span className="text-[#666]"> — invariant factors [{debugInfo.quotient.invariantFactors.join(", ")}]</span>
                  </div>
                )}
                <div className="text-[10px] text-[#888] pl-3">
                  {debugInfo.quotient.cyclicOrders.length > 0 && <>
                    This means the tempered lattice has <strong className="text-[#bbb]">{debugInfo.groupSize}</strong> distinct classes.
                    {debugInfo.quotient.freeDims > 0 && <> The ℤ{debugInfo.quotient.freeDims > 1 ? `^${debugInfo.quotient.freeDims}` : ""} factor means {debugInfo.quotient.freeDims} dimension{debugInfo.quotient.freeDims > 1 ? "s remain" : " remains"} uncollapsed — more commas needed to fully determine the EDO.</>}
                    {debugInfo.quotient.freeDims === 0 && <> Every direction is collapsed — the system is fully determined.</>}
                  </>}
                </div>
              </div>
            </div>

            {/* ════ Step 3: Val ════ */}
            <div className="space-y-2 border-l-2 pl-4" style={{ borderColor: PIPELINE_LABELS[2].color }}>
              <div className="font-bold text-xs" style={{ color: PIPELINE_LABELS[2].color }}>3. Val — the map that realizes the quotient</div>
              <div className="bg-[#111] rounded p-3 space-y-2">
                <div className="text-[#bbb]">
                  The <strong className="text-white">val</strong> is a linear map from the lattice to step numbers.
                  It takes a monzo and returns which EDO step it lands on.
                  The formula for the <strong className="text-white">patent val</strong> (the best-approximation val):
                </div>
                <div className="font-mono pl-3" style={{ color: PIPELINE_LABELS[2].color }}>
                  v<sub>p</sub> = round({selectedEdo} · log₂ p)
                </div>
                <div className="text-[10px] text-[#888] pl-3">
                  For each prime p, this asks: "how many steps of {selectedEdo}-EDO is the best approximation of p?"
                  The round() is where the tempering happens — any rounding error is a comma being absorbed.
                </div>
                <div className="border-t border-[#1e1e1e] pt-2 mt-2 space-y-1">
                  {latticePrimes.map((p, i) => {
                    const exact = selectedEdo * Math.log2(p);
                    const rounded = debugInfo.val[i];
                    const exactCents = 1200 * Math.log2(p);
                    const edoCents = rounded * stepCents;
                    const err = edoCents - exactCents;
                    return (
                      <div key={p} className="font-mono text-[10px] pl-3 flex items-baseline gap-1 flex-wrap">
                        <span className="font-bold" style={{ color: MONZO_PRIME_COLORS[p] ?? "#bbb" }}>v({p})</span>
                        <span className="text-[#888]">= round({selectedEdo} × {Math.log2(p).toFixed(4)})</span>
                        <span className="text-[#888]">= round({exact.toFixed(3)})</span>
                        <span className="text-[#888]">=</span>
                        <span className="font-bold" style={{ color: PIPELINE_LABELS[2].color }}>{rounded}</span>
                        <span style={{ color: Math.abs(err) < 5 ? "#4a8a4a" : Math.abs(err) < 15 ? "#aa8833" : "#aa3333" }}>
                          ({err > 0 ? "+" : ""}{err.toFixed(1)}¢)
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="border-t border-[#1e1e1e] pt-2 mt-2">
                  <div className="font-mono text-[10px] pl-3 text-[#bbb]">
                    val = ⟨<span style={{ color: PIPELINE_LABELS[2].color }}>{debugInfo.val.join(", ")}</span>|
                  </div>
                  <div className="text-[10px] text-[#888] pl-3 mt-1">
                    To map any ratio: take its monzo, dot-product with the val, reduce mod {selectedEdo}.
                  </div>
                </div>

                {/* Worked examples */}
                <div className="border-t border-[#1e1e1e] pt-2 mt-2 space-y-1">
                  <div className="text-[10px] text-[#666]">Worked examples:</div>
                  <div className="font-mono text-[10px] pl-3 text-[#bbb]">
                    3/2 → [{fifthMonzo.join(",")}] · ⟨{debugInfo.val.join(",")}⟩ = {fifthMonzo.map((e, j) => `${e}·${debugInfo.val[j]}`).join("+")} = <strong style={{ color: PIPELINE_LABELS[2].color }}>{((fifthStep % selectedEdo) + selectedEdo) % selectedEdo}</strong>
                    <span className="text-[#555]"> (mod {selectedEdo})</span>
                  </div>
                  {thirdMonzo && thirdStep !== null && (
                    <div className="font-mono text-[10px] pl-3 text-[#bbb]">
                      5/4 → [{thirdMonzo.join(",")}] · ⟨{debugInfo.val.join(",")}⟩ = {thirdMonzo.map((e, j) => `${e}·${debugInfo.val[j]}`).join("+")} = <strong style={{ color: PIPELINE_LABELS[2].color }}>{((thirdStep % selectedEdo) + selectedEdo) % selectedEdo}</strong>
                      <span className="text-[#555]"> (mod {selectedEdo})</span>
                    </div>
                  )}

                  {/* Verify a comma maps to 0 */}
                  {nonZeroCommas.length > 0 && (() => {
                    const c = nonZeroCommas[0];
                    const valResult = c.monzo.reduce((s, e, j) => s + e * debugInfo.val[j], 0);
                    const modResult = ((valResult % selectedEdo) + selectedEdo) % selectedEdo;
                    return (
                      <div className="font-mono text-[10px] pl-3 text-[#bbb]">
                        {c.label} → [{c.monzo.join(",")}] · ⟨{debugInfo.val.join(",")}⟩ = {valResult} ≡ <strong className={modResult === 0 ? "text-[#7aaa7a]" : "text-[#cc6666]"}>{modResult}</strong>
                        <span className="text-[#555]"> (mod {selectedEdo})</span>
                        {modResult === 0 && <span className="text-[#7aaa7a]"> ← in the kernel</span>}
                      </div>
                    );
                  })()}
                </div>
              </div>
              <div className="text-[10px] text-[#888]">
                <strong className="text-[#bbb]">Key insight:</strong> the val <em>already encodes</em> the tempering.
                Its kernel (everything mapping to 0) is exactly the set of commas.
                You don't need to define tempering and val separately — the val <em>is</em> the tempered system.
              </div>
            </div>

            {/* ════ Step 4: Embedding ════ */}
            <div className="space-y-2 border-l-2 pl-4" style={{ borderColor: PIPELINE_LABELS[3].color }}>
              <div className="font-bold text-xs" style={{ color: PIPELINE_LABELS[3].color }}>4. Embedding — from abstract steps to pitch</div>
              <div className="bg-[#111] rounded p-3 space-y-2">
                <div className="text-[#bbb]">
                  The val gives us {selectedEdo} abstract step numbers (0 through {selectedEdo - 1}).
                  The <strong className="text-white">embedding</strong> turns these into actual pitch sizes by dividing
                  the octave (1200 cents) equally:
                </div>
                <div className="font-mono pl-3" style={{ color: PIPELINE_LABELS[3].color }}>
                  n ↦ n × (1200 / {selectedEdo}) = n × {stepCents}¢
                </div>
                <div className="font-mono text-[10px] pl-3 text-[#888]">
                  Frequency: f(n) = {C4_FREQ.toFixed(2)} × 2<sup>n/{selectedEdo}</sup> Hz
                </div>
                <div className="text-[10px] text-[#888] pl-3">
                  Without this step, the val gives a perfectly valid tuning system
                  but with no physical size assigned to each step.
                  The embedding is what makes it <em>equal</em>-tempered — every step gets the same {stepCents}¢.
                </div>
              </div>
            </div>

            {/* ════ Summary ════ */}
            <div className="border-t border-[#2a2a2a] pt-3 space-y-3">
              <div className="font-bold text-xs text-[#ccc]">Summary</div>
              <div className="bg-[#111] rounded p-3 space-y-3">
                <div className="flex items-center gap-2 flex-wrap font-mono text-[10px]">
                  <span className="px-2 py-1 rounded bg-[#1a1a1a] border border-[#2a2a2a] text-[#9395ea]">ℤ<sup>{n}</sup></span>
                  <span className="text-[#555]">→</span>
                  <span className="px-2 py-1 rounded border" style={{ borderColor: PIPELINE_LABELS[1].color + "66", color: PIPELINE_LABELS[1].color, backgroundColor: PIPELINE_LABELS[1].color + "11" }}>/ ker</span>
                  <span className="text-[#555]">→</span>
                  <span className="px-2 py-1 rounded border" style={{ borderColor: PIPELINE_LABELS[2].color + "66", color: PIPELINE_LABELS[2].color, backgroundColor: PIPELINE_LABELS[2].color + "11" }}>val</span>
                  <span className="text-[#555]">→</span>
                  <span className="px-2 py-1 rounded border border-[#cc88cc66] text-[#cc88cc] bg-[#cc88cc11]">ℤ/{selectedEdo}</span>
                  <span className="text-[#555]">→</span>
                  <span className="px-2 py-1 rounded border" style={{ borderColor: PIPELINE_LABELS[3].color + "66", color: PIPELINE_LABELS[3].color, backgroundColor: PIPELINE_LABELS[3].color + "11" }}>× {stepCents}¢</span>
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px]">
                  <span className="text-[#555] text-right">Tempering</span>
                  <span className="text-[#888]">defines equivalence — which intervals collapse to the same note</span>
                  <span className="text-[#555] text-right">Val</span>
                  <span className="text-[#888]">assigns a discrete step to each class — the usable form of the quotient</span>
                  <span className="text-[#555] text-right">Embedding</span>
                  <span className="text-[#888]">assigns physical size — without it, no sound, no cents</span>
                </div>
                <div className="text-[10px] text-[#888] border-t border-[#1e1e1e] pt-2">
                  The val already encodes both the tempering (kernel = what maps to 0 mod {selectedEdo})
                  and the ring structure. So in practice: <strong className="text-[#bbb]">EDO = val + step size</strong>.
                </div>
              </div>
            </div>
          </div>
          );
        })()}
      </div>

      {/* 3D Canvas */}
      <div ref={canvasContainerRef} className="bg-[#080808] rounded-xl border border-[#1a1a1a] relative overflow-hidden" style={{ height: "80vh" }}>
        {/* Navigation help */}
        <div className="absolute top-2 left-2 z-10 px-2.5 py-1.5 rounded text-[9px] bg-[#111]/70 text-[#555] backdrop-blur-sm border border-[#222] leading-relaxed">
          <span className="text-[#777]">Drag</span> rotate · <span className="text-[#777]">Right-drag</span> pan · <span className="text-[#777]">Scroll</span> zoom · <span className="text-[#777]">Arrow keys</span> pan · <span className="text-[#777]">Shift+click</span> focus
          {isOnRing && <><br /><span className="text-[#7aaa7a]">Click nodes</span> to toggle drone</>}
        </div>
        {/* Pipeline stage overlay */}
        <div className="absolute bottom-2 left-2 z-10 px-2.5 py-1.5 rounded text-[10px] bg-[#111]/80 backdrop-blur-sm border border-[#222]">
          <span className="font-mono font-bold" style={{ color: stageInfo.color }}>{stageInfo.label}</span>
          <span className="text-[#555] ml-2">{stageInfo.math}</span>
        </div>
        {/* Overlay controls */}
        <div className="absolute top-2 right-2 z-10 flex gap-1.5">
          {ringDroneKeys.size > 0 && (
            <button onClick={stopAllRingDrones}
              className="px-2 py-1 rounded text-[10px] font-medium border border-[#5a2a2a] bg-[#2a1111]/80 text-[#cc6666] hover:text-white hover:border-[#884444] backdrop-blur-sm transition-colors">
              Stop All
            </button>
          )}
          <button onClick={() => { setCameraResetKey(k => k + 1); setFocusKey(null); }}
            className="px-2 py-1 rounded text-[10px] font-medium border border-[#333] bg-[#111]/80 text-[#888] hover:text-white hover:border-[#555] backdrop-blur-sm transition-colors">
            Reset View
          </button>
          <button onClick={toggleFullscreen}
            className="px-2 py-1 rounded text-[10px] font-medium border border-[#333] bg-[#111]/80 text-[#888] hover:text-white hover:border-[#555] backdrop-blur-sm transition-colors">
            {isFullscreen ? "Exit FS" : "Fullscreen"}
          </button>
        </div>
        <Canvas camera={{ position: [12, 8, 12], fov: 55, near: 0.1, far: 500 }} gl={{ antialias: true, alpha: false }} onCreated={({ gl }) => { gl.setClearColor("#080808"); }} style={{ width: "100%", height: "100%", background: "#080808" }}>
          <ambientLight intensity={0.7} />
          <pointLight position={[10, 20, 10]} intensity={1.0} />
          <pointLight position={[-10, -5, -10]} intensity={0.3} />
          <Scene from={from} to={to} animating={isAnimating} progress={animProgress} setProgress={setAnimProgress} onDone={onAnimDone} labels={showLabels} edges={!isOnRing && showEdges} highlightClass={highlightClass} classColorOverride={classColorMap} onFocus={setFocusKey} onNodeClick={isOnRing ? toggleRingDrone : undefined} activeDroneKeys={ringDroneKeys} visibleKeys={embedVisibleKeys} embedLabels={embedLabelMap} showKernel={showKernel && stage >= 1} showFundamentalDomain={showFD && stage >= 1} />
          {isOnRing && !isAnimating && <RingGuide edo={selectedEdo} classColorMap={classColorMap} classData={classData} />}
          <LatticeCameraReset resetKey={cameraResetKey} positions={from.positions} />
          <LatticeCameraFocus targetPos={focusKey ? from.positions.get(focusKey) ?? null : null} />
          <LatticeKeyboardPan />
          <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={1} maxDistance={200} enablePan panSpeed={1.5} rotateSpeed={0.8} zoomSpeed={1.2} />
        </Canvas>
      </div>

      {/* ── Val + Embed detail panel ── */}
      {stage >= 2 && classData.length > 0 && (
        <div className="bg-[#0d0d0d] border border-[#1e1e1e] rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-3">
            <h4 className="text-xs font-bold" style={{ color: PIPELINE_LABELS[2].color }}>
              Val: ℤ{latticePrimes.length > 0 ? `^${latticePrimes.length}` : ""} → ℤ/{selectedEdo}
            </h4>
            <span className="text-[9px] text-[#555] font-mono">
              {latticePrimes.map(p => `v(${p})=${Math.round(selectedEdo * Math.log2(p))}`).join("  ")}
            </span>
          </div>
          {isEmbedded && (
            <div className="text-[9px] text-[#666]">
              <span style={{ color: PIPELINE_LABELS[3].color }} className="font-bold">Embedding: </span>
              step n → {stepCents}n¢ → {C4_FREQ.toFixed(2)} × 2^(n/{selectedEdo}) Hz
            </div>
          )}
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${isEmbedded ? "320px" : "260px"}, 1fr))` }}>
            {classData.map(cd => {
              const v = valMap.get(cd.id);
              if (!v) return null;
              return (
                <div
                  key={cd.id}
                  onClick={() => setHighlightClass(highlightClass === cd.id ? null : cd.id)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded border cursor-pointer transition-colors ${
                    highlightClass === cd.id
                      ? "bg-[#1a1a2a] border-[#4a4a6a]"
                      : highlightClass !== null
                      ? "bg-[#0a0a0a] border-[#1a1a1a] opacity-40"
                      : "bg-[#0d0d0d] border-[#1e1e1e] hover:border-[#3a3a3a]"
                  }`}
                >
                  <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: cd.color }} />
                  {/* Step number */}
                  <span className="text-[12px] font-mono font-bold min-w-[22px] text-right" style={{ color: PIPELINE_LABELS[2].color }}>
                    {v.step}
                  </span>
                  {/* Representative ratio */}
                  <span className="text-[10px] font-mono" style={{ color: cd.color }}>{cd.rep}</span>
                  <span className="text-[8px] text-[#666]">{cd.members[0].name}</span>
                  {/* Cents + freq (embed stage) */}
                  {isEmbedded && (
                    <>
                      <span className="text-[9px] font-mono ml-auto" style={{ color: PIPELINE_LABELS[3].color }}>{v.cents}¢</span>
                      <span className="text-[8px] font-mono text-[#666]">{v.freq.toFixed(1)}Hz</span>
                    </>
                  )}
                  {!isEmbedded && (
                    <span className="text-[8px] text-[#444] font-mono ml-auto">{cd.members.length} ratio{cd.members.length > 1 ? "s" : ""}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Equivalence class legend (stages 0-1: before val) */}
      {stage < 2 && classData.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-bold text-[#999]">Equivalence Classes ({classData.length})</h4>
            {highlightClass !== null && (
              <button onClick={() => setHighlightClass(null)} className="text-[10px] text-[#888] hover:text-white underline">Clear highlight</button>
            )}
          </div>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {classData.map(cd => (
              <div
                key={cd.id}
                onClick={() => setHighlightClass(highlightClass === cd.id ? null : cd.id)}
                className={`flex items-start gap-2 px-2 py-1.5 rounded border cursor-pointer transition-colors ${
                  highlightClass === cd.id
                    ? "bg-[#1a1a2a] border-[#4a4a6a]"
                    : highlightClass !== null
                    ? "bg-[#0a0a0a] border-[#1a1a1a] opacity-40"
                    : "bg-[#0d0d0d] border-[#1e1e1e] hover:border-[#3a3a3a]"
                }`}
              >
                <div className="w-3 h-3 rounded-full flex-shrink-0 mt-0.5" style={{ backgroundColor: cd.color, boxShadow: `0 0 6px ${cd.color}40` }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-bold font-mono" style={{ color: cd.color }}>{cd.rep}</span>
                    <span className="text-[9px] text-[#888]">{cd.members[0].name}</span>
                    <span className="text-[8px] text-[#555] font-mono">{cd.members[0].cents.toFixed(0)}¢</span>
                  </div>
                  {cd.members.length > 1 && (
                    <div className="flex flex-wrap gap-x-1.5 gap-y-0.5 mt-0.5">
                      {cd.members.slice(1).map(m => (
                        <span key={m.key} className="text-[9px] font-mono text-[#666]">{m.key}</span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="text-[8px] text-[#555] flex-shrink-0">{cd.members.length}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Kernel Debug Panel ── */}
      <div className="border-t border-[#1e1e1e] pt-2">
        <button onClick={() => setShowDebug(d => !d)}
          className="text-[9px] text-[#555] hover:text-[#888] font-mono transition-colors">
          {showDebug ? "▾" : "▸"} Kernel Debug
        </button>
        {showDebug && (
          <div className="mt-2 bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-3 space-y-3 font-mono text-[10px]">
            {/* Summary badges */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="px-2 py-0.5 rounded" style={{
                backgroundColor: debugInfo.willCollapse ? "#3a1a1a" : debugInfo.isFullyDetermined ? "#1a2a1a" : "#2a2a1a",
                border: `1px solid ${debugInfo.willCollapse ? "#6a2a2a" : debugInfo.isFullyDetermined ? "#2a5a2a" : "#4a4a2a"}`,
                color: debugInfo.willCollapse ? "#ee6666" : debugInfo.isFullyDetermined ? "#7aaa7a" : "#ddaa55",
              }}>
                rank {debugInfo.rank}/{debugInfo.dim} (need {debugInfo.neededRank})
              </span>
              <span className="px-2 py-0.5 rounded bg-[#1a1a2a] border border-[#2a2a4a] text-[#9395ea]">
                |G| = {debugInfo.groupSize === Infinity ? "∞ (no commas)" : debugInfo.groupSize === 0 ? "trivial" : debugInfo.groupSize}
              </span>
              {debugInfo.willCollapse && (
                <span className="px-2 py-0.5 rounded bg-[#3a1a1a] border border-[#6a2a2a] text-[#ff6666] font-bold">
                  WILL COLLAPSE — rank ≥ dim
                </span>
              )}
              {debugInfo.isOverDetermined && !debugInfo.willCollapse && (
                <span className="px-2 py-0.5 rounded bg-[#2a2a1a] border border-[#4a4a2a] text-[#ddaa55]">
                  over-determined ({debugInfo.rank} &gt; {debugInfo.neededRank})
                </span>
              )}
              {debugInfo.zeroCount > 0 && (
                <span className="px-2 py-0.5 rounded bg-[#2a1a1a] border border-[#4a2a2a] text-[#cc6666]">
                  {debugInfo.zeroCount} zero-vector comma{debugInfo.zeroCount > 1 ? "s" : ""} (octave-degenerate)
                </span>
              )}
            </div>

            {/* Working space */}
            <div className="text-[#888]">
              <span className="text-[#666]">Working space: </span>
              ℤ<sup>{debugInfo.dim}</sup> with primes [{debugInfo.workingPrimes.join(", ")}]
              <span className="text-[#555] ml-2">(octave-equivalent, prime 2 factored out)</span>
            </div>

            {/* Val vector */}
            <div>
              <span className="text-[#ddaa55]">val: </span>
              <span className="text-[#bbb]">⟨{debugInfo.val.join(", ")}|</span>
              <span className="text-[#555] ml-2">
                ({debugInfo.workingPrimes.map((p, i) => `v(${p})=${debugInfo.val[i]}`).join(", ")})
              </span>
            </div>

            {/* Kernel basis (comma monzos) */}
            {debugInfo.allCommaLabels.length > 0 && (
              <div className="space-y-1">
                <span className="text-[#9395ea]">Kernel basis (comma monzos):</span>
                {debugInfo.allCommaLabels.map((c, i) => (
                  <div key={i} className={`flex items-center gap-2 pl-2 ${c.isZero ? "opacity-40" : ""}`}>
                    <span className="text-[#bbb] min-w-[60px]">{c.label}</span>
                    <span className="text-[#666] min-w-[100px]">{c.name}</span>
                    <span className={c.isZero ? "text-[#cc4444]" : "text-[#888]"}>
                      [{c.monzo.join(", ")}]
                    </span>
                    {c.isZero && <span className="text-[#cc4444]">← zero (degenerate)</span>}
                  </div>
                ))}
              </div>
            )}

            {/* Quotient group structure */}
            <div className="space-y-1">
              <span className="text-[#7aaa7a]">Quotient group ℤ<sup>{debugInfo.dim}</sup> / ker:</span>
              <div className="pl-2 space-y-0.5">
                {debugInfo.quotient.invariantFactors.length > 0 ? (
                  <>
                    <div className="text-[#888]">
                      Invariant factors: [{debugInfo.quotient.invariantFactors.join(", ")}]
                    </div>
                    <div className="text-[#888]">
                      Cyclic orders: {debugInfo.quotient.cyclicOrders.length > 0
                        ? debugInfo.quotient.cyclicOrders.map(d => `ℤ/${d}`).join(" × ")
                        : "none (trivial)"}
                    </div>
                    <div className="text-[#888]">
                      Free dims: {debugInfo.quotient.freeDims} · Collapsed: {debugInfo.quotient.collapsedDims}
                    </div>
                    <div className="text-[#bbb]">
                      Group: {debugInfo.quotient.cyclicOrders.length > 0
                        ? debugInfo.quotient.cyclicOrders.map(d => `ℤ/${d}`).join(" × ")
                        : "ℤ"}
                      {debugInfo.quotient.freeDims > 0
                        ? ` × ℤ${debugInfo.quotient.freeDims > 1 ? `^${debugInfo.quotient.freeDims}` : ""}`
                        : ""}
                      {" "}≅ {debugInfo.groupSize === Infinity ? "∞" : `${debugInfo.groupSize} classes`}
                    </div>
                  </>
                ) : (
                  <div className="text-[#666]">No commas → group = ℤ<sup>{debugInfo.dim}</sup> (full JI)</div>
                )}
              </div>
            </div>

            {/* Derivation formula */}
            <div className="text-[#555] leading-relaxed border-t border-[#1a1a1a] pt-2">
              <div>EDO = val + step size</div>
              <div>val: p ↦ round({selectedEdo} · log₂ p)</div>
              <div>ker(val) = commas tempered out (map to 0 mod {selectedEdo})</div>
              <div>embedding: step n ↦ {stepCents}n¢</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 3. FIFTH QUALITY
// ═══════════════════════════════════════════════════════════════

function FifthQuality({ onSelectEdo }: { onSelectEdo?: (edo: number) => void }) {
  const edos = useMemo(() => getAllEDOs(), []);
  const tt = useTooltip();
  const jf = 701.955, mW = 800, bH = 12, mE = 50;
  return (
    <div className="p-4 space-y-3">
      <h3 className="text-sm font-bold text-[#ccc]">Fifth Quality by EDO (error from 701.955¢)</h3>
      <p className="text-xs text-[#666]">Green = within 5¢, yellow = 5–15¢, red = 15¢+. Red dot = multi-ring. Click to explore.</p>
      <TooltipBar innerRef={tt.ref} />
      <div className="overflow-y-auto max-h-[600px]">
        <svg width={mW} height={edos.length * (bH + 2) + 20} className="block">
          <line x1={mW/2} y1={0} x2={mW/2} y2={edos.length*(bH+2)} stroke="#444" strokeWidth={1} />
          {edos.map((e, i) => {
            const err = e.ring.fifthCents - jf; const ae = Math.abs(err); const bW = (ae / mE) * (mW/2 - 40); const x = err > 0 ? mW/2 : mW/2 - bW; const y = i * (bH + 2);
            return (
              <g key={e.edo} className="cursor-pointer"
                onClick={() => onSelectEdo?.(e.edo)}
                onMouseEnter={() => tt.show(`${e.edo}-EDO: fifth = ${e.ring.fifthSteps} steps / ${e.ring.fifthCents}¢ (${err > 0?"+":""}${err.toFixed(2)}¢)${e.ring.type === "multi" ? ` — ${e.ring.count} rings` : ""}`)}
                onMouseLeave={tt.hide}>
                <rect x={0} y={y} width={mW} height={bH} fill="transparent" />
                <rect x={x} y={y} width={Math.max(bW, 1)} height={bH} fill={ae > 15 ? "#aa3333" : ae > 5 ? "#aa8833" : "#4a8a4a"} opacity={0.8} rx={1} />
                <text x={mW/2-(err>0?4:-4)} y={y+bH-2} textAnchor={err>0?"end":"start"} className="text-[8px] fill-[#888] font-mono pointer-events-none">{e.edo}</text>
                {e.ring.type==="multi"&&<circle cx={35} cy={y+bH/2} r={2.5} fill="#e06060" className="pointer-events-none"/>}
              </g>
            );
          })}
          <text x={mW/2} y={edos.length*(bH+2)+14} textAnchor="middle" className="text-[8px] fill-[#666]">0¢</text>
          <text x={mW/4} y={edos.length*(bH+2)+14} textAnchor="middle" className="text-[8px] fill-[#6666ff]">flat</text>
          <text x={mW*3/4} y={edos.length*(bH+2)+14} textAnchor="middle" className="text-[8px] fill-[#ffaa44]">sharp</text>
        </svg>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 4. RING MAP
// ═══════════════════════════════════════════════════════════════

function RingMap({ onSelectEdo }: { onSelectEdo?: (edo: number) => void }) {
  const edos = useMemo(() => getAllEDOs(), []);
  const [primesOnly, setPrimesOnly] = useState(false);
  const tt = useTooltip();
  const filtered = useMemo(() => primesOnly ? edos.filter(e => e.isPrime) : edos, [edos, primesOnly]);
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-4">
        <h3 className="text-sm font-bold text-[#ccc]">Ring Structure by EDO</h3>
        <label className="text-xs text-[#666] flex items-center gap-1"><input type="checkbox" checked={primesOnly} onChange={e => setPrimesOnly(e.target.checked)} className="accent-[#7173e6]" /> Prime EDOs only</label>
      </div>
      <p className="text-xs text-[#666]">Single ring = fifths generate all notes. Red = multi-ring. Purple = prime. Click to explore.</p>
      <TooltipBar innerRef={tt.ref} />
      <div className="flex flex-wrap gap-2">
        {filtered.map(e => {
          const rc = e.ring.count; const isM = rc > 1; const sz = 28 + (isM ? rc * 2 : 0);
          return (
            <div key={e.edo} className="relative cursor-pointer hover:brightness-150 transition-all" style={{ width: sz, height: sz, borderRadius: "50%", border: `1.5px solid ${isM ? "#aa4444" : e.isPrime ? "#7173e6" : "#2a2a2a"}`, background: isM ? "#1a1111" : "#111", display: "flex", alignItems: "center", justifyContent: "center" }}
              onClick={() => onSelectEdo?.(e.edo)}
              onMouseEnter={() => tt.show(`${e.edo}-EDO: ${rc===1?`Single ring — fifth ${e.ring.fifthSteps} steps (${e.ring.fifthCents}¢)`:`${rc} rings of ${e.ring.notesPerRing}`}${e.isPrime?" [prime]":""}${e.temperaments.length?` — ${e.temperaments.join(", ")}`:""}`)}
              onMouseLeave={tt.hide}>
              <span className={`text-[9px] font-mono ${isM?"text-[#cc6666]":e.isPrime?"text-[#9395ea]":"text-[#888]"}`}>{e.edo}</span>
              {isM&&<span className="absolute -top-1 -right-1 text-[7px] bg-[#aa4444] text-white rounded-full w-3 h-3 flex items-center justify-center font-bold">{rc}</span>}
            </div>
          );
        })}
      </div>
      <h4 className="text-xs font-bold text-[#999] mt-4">Consistency Limits</h4>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-1 text-[9px]">
        {filtered.filter(e => e.consistencyLimit !== null && e.consistencyLimit! >= 5).map(e => (
          <div key={e.edo} className="flex items-center gap-1 bg-[#111] rounded px-1.5 py-0.5 border border-[#1e1e1e]">
            <span className="font-mono text-[#9395ea]">{e.edo}</span><span className="text-[#666]">→</span><span className="text-[#7aaa7a]">{e.consistencyLimit}-odd</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 5. THEORY — Tuning math reference
// ═══════════════════════════════════════════════════════════════

const TH = {
  h: "text-sm font-bold text-[#ccc] mt-5 mb-2 first:mt-0",
  h2: "text-xs font-bold text-[#999] mt-4 mb-1.5",
  p: "text-xs text-[#888] leading-relaxed mb-2",
  math: "font-mono text-[10px] bg-[#0d0d0d] border border-[#1e1e1e] rounded px-3 py-2 my-2 text-[#b0b0d0] whitespace-pre overflow-x-auto block",
  note: "text-[10px] text-[#666] italic leading-relaxed mb-2",
  kw: "text-[#9395ea]",
  em: "text-[#b0b0d0] not-italic",
  cmp: "border border-[#1e1e1e] rounded p-3 mb-3 bg-[#0a0a0a]",
  cmpH: "text-xs font-bold mb-1.5",
  tag: "text-[9px] font-mono px-1.5 py-0.5 rounded",
};

function TheoryPanel() {
  return (
    <div className="p-4 max-w-3xl space-y-1">

      {/* ── Shared Foundation ── */}
      <h3 className={TH.h}>Shared Foundation: Monzos & Commas</h3>
      <p className={TH.p}>
        All approaches below share the same representation. A just-intonation interval is encoded as
        a <span className={TH.kw}>monzo</span> — a vector of prime exponents. The ratio 5/4 (just major third) is
        the monzo <span className={TH.em}>[−2, 0, 1]</span> because 5/4 = 2<sup>−2</sup>·3<sup>0</sup>·5<sup>1</sup>.
      </p>
      <p className={TH.p}>
        A <span className={TH.kw}>comma</span> is a small JI interval that a temperament sets equal to unison.
        The syntonic comma 81/80 = <span className={TH.em}>[−4, 4, −1]</span> is the gap between four just fifths
        and a just major third (plus two octaves). Declaring it "zero" is what creates meantone temperament.
      </p>
      <p className={TH.p}>
        <span className={TH.kw}>Tempering</span> means choosing new (slightly detuned) sizes for each prime so that every
        comma evaluates to 0¢. The question is: when there are infinitely many valid detunings, which
        one is "best"?
      </p>

      {/* ── Tonescape ── */}
      <h3 className={TH.h}>Approach 1 — Tonescape / Direct Linear Solve</h3>
      <p className={TH.note}>Tonalsoft Tonescape Studio (Joe Monzo, ~2005)</p>
      <div className={TH.cmp}>
        <p className={`${TH.cmpH} text-[#cc9966]`}>Method</p>
        <p className={TH.p}>
          Tonescape builds a square linear system and solves it exactly. Each prime <i>p</i> gets an
          unknown <i>c<sub>p</sub></i> (its tempered size in cents). The constraints are:
        </p>
        <code className={TH.math}>{
`Fixed octave:   [1, 0, 0, …] · c = 1200
Comma → 0:      comma₁ · c = 0
Comma → 0:      comma₂ · c = 0
  ⋮`
        }</code>
        <p className={TH.p}>
          For an <i>n</i>-prime system, Tonescape requires exactly <i>n</i>−1 independent commas (plus
          the octave constraint) — giving <i>n</i> equations in <i>n</i> unknowns and a unique solution.
          This is why Tonescape's tonespace files always specify a full "TM-basis" of commas.
        </p>
        <p className={`${TH.cmpH} text-[#cc9966]`}>Strengths & Limits</p>
        <p className={TH.p}>
          For <span className={TH.kw}>EDOs</span> (rank-1 temperaments), this is exact and agrees with every other method —
          there is only one solution. For <span className={TH.kw}>higher-rank temperaments</span> (meantone, marvel, pajara…),
          the system is underdetermined unless you add extra constraints. Tonescape sidesteps the
          optimization problem entirely: it requires the user to fully specify the system rather than
          choosing an optimal point from infinitely many valid tunings.
        </p>
      </div>

      {/* ── Unweighted Projection ── */}
      <h3 className={TH.h}>Approach 2 — Euclidean Projection (unweighted)</h3>
      <p className={TH.note}>Used by this app for lattice visualization positions</p>
      <div className={TH.cmp}>
        <p className={`${TH.cmpH} text-[#7aaa7a]`}>Method</p>
        <p className={TH.p}>
          Commas span a subspace <i>V</i> in ℝ<sup>n</sup> (prime-exponent space). Tempering = projecting every
          monzo onto <i>V</i><sup>⊥</sup>, the orthogonal complement:
        </p>
        <code className={TH.math}>P = I − Cᵀ(CCᵀ)⁻¹C</code>
        <p className={TH.p}>
          This uses the standard Euclidean inner product — all prime axes are treated as equally important.
          Monzos differing by a comma project to the same point, which is geometrically correct, but the
          choice of <i>where</i> they land minimizes error in <b>exponent space</b>, not in perceptual (cents) space.
        </p>
        <p className={`${TH.cmpH} text-[#7aaa7a]`}>Why it's used for the lattice</p>
        <p className={TH.p}>
          Unweighted projection preserves the natural symmetry of the prime-exponent lattice, which
          makes the 3D visualization cleaner. The PCA step then aligns principal-variance axes with
          x/y/z so orbiting feels smooth. For visual geometry, perceptual weighting would distort axis
          proportions without any benefit.
        </p>
      </div>

      {/* ── TE Projection ── */}
      <h3 className={TH.h}>Approach 3 — Tenney-Euclidean (TE) Projection</h3>
      <p className={TH.note}>Gene Ward Smith, Graham Breed — standard in regular temperament theory; used by this app for pitch/tuning</p>
      <div className={TH.cmp}>
        <p className={`${TH.cmpH} text-[#9395ea]`}>Method</p>
        <p className={TH.p}>
          Same projection idea, but with a <span className={TH.kw}>Tenney-weighted</span> inner product.
          Each prime axis <i>i</i> is scaled by <i>w<sub>i</sub></i> = log<sub>2</sub>(<i>p<sub>i</sub></i>), reflecting
          that a 1-unit exponent change in prime 2 shifts pitch by 1200¢, but in prime 5 by ~2786¢.
          The weighted projection matrix is:
        </p>
        <code className={TH.math}>{
`P_TE = I − M⁻¹Cᵀ(CM⁻¹Cᵀ)⁻¹C

where  M = diag(log₂(p)²)    — the Tenney metric
       C = comma matrix (rows = comma monzos)`
        }</code>
        <p className={TH.p}>
          This minimizes the <span className={TH.kw}>RMS cents error</span> across all tempered primes, weighted by
          complexity. Errors in smaller primes (which participate in more consonances) are penalised
          more heavily. The resulting tuning is the TE optimum — the standard default in the xenharmonic
          community.
        </p>
        <p className={`${TH.cmpH} text-[#9395ea]`}>Concrete example</p>
        <p className={TH.p}>
          Tempering out the syntonic comma <span className={TH.em}>[−4, 4, −1]</span> in 5-limit meantone.
          The unweighted projection treats a 1-unit shift in the prime-2 exponent (1200¢) the same as a
          1-unit shift in the prime-5 exponent (2786¢). So it puts too much absolute error on the
          smaller primes. The TE projection distributes error proportionally to 1/log₂(p)², giving a
          meantone fifth of ~696.6¢ — the least-squares optimum in perceptual space.
        </p>
      </div>

      {/* ── Other approaches ── */}
      <h3 className={TH.h}>Other Approaches in the Literature</h3>

      <div className={TH.cmp}>
        <p className={`${TH.cmpH} text-[#cc6666]`}>TOP — Tenney Optimal in P-norm (minimax)</p>
        <p className={TH.note}>Paul Erlich</p>
        <p className={TH.p}>
          Instead of minimizing RMS error, TOP minimizes the <b>worst-case</b> relative error across all
          intervals, weighted by Tenney height (log<sub>2</sub>(<i>n·d</i>) for ratio <i>n/d</i>). This is an
          L<sup>∞</sup> (minimax) criterion rather than L<sup>2</sup> (least-squares). TOP tunings guarantee
          that no single interval is egregiously out of tune, at the cost of slightly higher average error.
          The octave is allowed to stretch or compress.
        </p>
      </div>

      <div className={TH.cmp}>
        <p className={`${TH.cmpH} text-[#cc6666]`}>POTE — Pure-Octave TE</p>
        <p className={TH.p}>
          Same as TE but with the octave constrained to exactly 1200¢. This is a common practical variant —
          most keyboards and DAWs assume pure octaves. Mathematically, it's a constrained least-squares
          problem: minimize TE error subject to <i>c</i><sub>2</sub> = 1200.
        </p>
      </div>

      <div className={TH.cmp}>
        <p className={`${TH.cmpH} text-[#cc6666]`}>CTE — Constrained TE</p>
        <p className={TH.note}>Keenan Pepper</p>
        <p className={TH.p}>
          A refinement of POTE that constrains each eigenmonzo (interval mapped exactly in JI) to remain
          pure, then minimizes TE error on the remaining degrees of freedom. This can preserve specific
          just intervals (e.g. a pure 3/2 fifth) while optimizing the rest.
        </p>
      </div>

      <div className={TH.cmp}>
        <p className={`${TH.cmpH} text-[#cc6666]`}>Frobenius / Weil / Kees</p>
        <p className={TH.p}>
          Alternative norms for the projection. <b>Weil</b> uses max(log <i>n</i>, log <i>d</i>) instead
          of log(<i>n·d</i>). <b>Kees</b> is Weil with octave equivalence. <b>Frobenius</b> weights by
          1/<i>p</i> rather than 1/log <i>p</i>. Each produces slightly different optimal tunings, but TE
          (Tenney-Euclidean, i.e. log-weighted L²) remains the community standard for general use.
        </p>
      </div>

      {/* ── Summary table ── */}
      <h3 className={TH.h}>Summary</h3>
      <div className="overflow-x-auto">
        <table className="text-[10px] border-collapse w-full">
          <thead>
            <tr className="text-left text-[#999] border-b border-[#222]">
              <th className="py-1.5 pr-3">Method</th>
              <th className="py-1.5 pr-3">Optimality</th>
              <th className="py-1.5 pr-3">Norm</th>
              <th className="py-1.5 pr-3">Octave</th>
              <th className="py-1.5">Used here</th>
            </tr>
          </thead>
          <tbody className="text-[#777]">
            <tr className="border-b border-[#1a1a1a]">
              <td className="py-1.5 pr-3 text-[#cc9966]">Tonescape</td>
              <td className="py-1.5 pr-3">Exact (fully determined)</td>
              <td className="py-1.5 pr-3">—</td>
              <td className="py-1.5 pr-3">Pure</td>
              <td className="py-1.5">—</td>
            </tr>
            <tr className="border-b border-[#1a1a1a]">
              <td className="py-1.5 pr-3 text-[#7aaa7a]">Euclidean</td>
              <td className="py-1.5 pr-3">Min RMS exponent error</td>
              <td className="py-1.5 pr-3">L² unweighted</td>
              <td className="py-1.5 pr-3">Free</td>
              <td className="py-1.5"><span className={`${TH.tag} bg-[#1a2a1a] text-[#7aaa7a]`}>lattice positions</span></td>
            </tr>
            <tr className="border-b border-[#1a1a1a]">
              <td className="py-1.5 pr-3 text-[#9395ea]">TE</td>
              <td className="py-1.5 pr-3">Min RMS cents error</td>
              <td className="py-1.5 pr-3">L² Tenney-weighted</td>
              <td className="py-1.5 pr-3">Free</td>
              <td className="py-1.5"><span className={`${TH.tag} bg-[#1a1a2a] text-[#9395ea]`}>pitch / tuning</span></td>
            </tr>
            <tr className="border-b border-[#1a1a1a]">
              <td className="py-1.5 pr-3 text-[#cc6666]">POTE</td>
              <td className="py-1.5 pr-3">Min RMS cents, octave fixed</td>
              <td className="py-1.5 pr-3">L² Tenney-weighted</td>
              <td className="py-1.5 pr-3">Pure</td>
              <td className="py-1.5">—</td>
            </tr>
            <tr className="border-b border-[#1a1a1a]">
              <td className="py-1.5 pr-3 text-[#cc6666]">TOP</td>
              <td className="py-1.5 pr-3">Min worst-case relative error</td>
              <td className="py-1.5 pr-3">L∞ Tenney-weighted</td>
              <td className="py-1.5 pr-3">Free</td>
              <td className="py-1.5">—</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-3 text-[#cc6666]">CTE</td>
              <td className="py-1.5 pr-3">Min TE with eigenmonzo constraints</td>
              <td className="py-1.5 pr-3">L² Tenney-weighted</td>
              <td className="py-1.5 pr-3">Pure</td>
              <td className="py-1.5">—</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className={`${TH.p} mt-3`}>
        For <b>EDOs</b> (rank-1), all methods produce the same tuning — the patent val uniquely determines
        each prime's cents value. The differences only matter for <b>higher-rank temperaments</b> (meantone,
        miracle, pajara, etc.) where the comma kernel leaves degrees of freedom in the tuning.
      </p>
    </div>
  );
}
