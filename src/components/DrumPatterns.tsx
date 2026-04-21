import { useState, useCallback, useEffect, useRef } from "react";
import PracticeLogSaveBar from "@/components/PracticeLogSaveBar";
import { readPendingRestore, getQuickmarks, setQuickmarks as saveQuickmarksToLS, Quickmark, addPracticeEntry, PracticeRating } from "@/lib/practiceLog";
import {
  GridType, GRID_SUBDIVS, BEAT_SLOT_LABELS,
  Permutation, permHits, getPerms,
  DrumMeasure,
  resolveSnareHits, resolveBassHits, resolveGhostHits,
  ostinatoHits, ostinatoOpen,
  PoolPreset, loadPoolPresets, savePoolPreset, deletePoolPreset,
} from "@/lib/drumData";
import { AccentSubdivision, AccentMeasureData, ACCENT_SUBDIV_BEAT_SLOTS } from "@/lib/accentData";
import VexDrumNotation, {
  VexDrumStrip, StripMeasureData,
} from "@/components/VexDrumNotation";
import AccentStudy, { AccentStudyStrip } from "@/components/AccentStudy";
import StickingsStudy, { StickingsStudyStrip } from "@/components/StickingsStudy";
import IndependenceStudy, { IndependenceStudyStrip } from "@/components/IndependenceStudy";
import { StickingMeasureData } from "@/lib/stickingsData";
import { IndependenceMeasureData, IndependenceGrid } from "@/lib/independenceData";
import TransformMode from "@/components/TransformMode";
import { TransformPattern } from "@/lib/transformData";
import ExportDialog from "@/components/ExportDialog";
import type { ExportSection } from "@/components/ExportDialog";
import { generateDrumOstinatoXML, generateAccentStudyXML } from "@/lib/drumMusicXml";
import {
  type KSPattern, type InterplayMeasureData,
  KS_PATTERNS, parsePhrase, randomPattern,
  buildInterplayMeasureFromPattern,
  hatHitsFromOstinato, hatOpenFromOstinato,
  hatPedalFromOstinato, hatCrashFromOstinato,
  parseCustomPattern,
  HIHAT_PATTERNS,
} from "@/lib/kickSnareInterplay";

// ── Constants ─────────────────────────────────────────────────────────────────

const VOICE_META = [
  { id: "O"  as const, label: "Ostinato", color: "#c8aa50", hasOpen: true  },
  { id: "S"  as const, label: "Snare",    color: "#9999ee", hasOpen: false },
  { id: "B"  as const, label: "Bass",     color: "#e06060", hasOpen: false },
  { id: "HH" as const, label: "HH Pedal", color: "#7aaa7a", hasOpen: false },
] as const;

const STRIP_MEASURE_W = 260;
const STRIP_MEASURE_H = 165;
const BUTTON_ROW_H    = 30;

const VOICE_BTN = [
  { id: "S",  label: "S",  title: "Snare",    color: "#9999ee" },
  { id: "B",  label: "B",  title: "Bass",     color: "#e06060" },
  { id: "O",  label: "O",  title: "Ostinato", color: "#c8aa50" },
  { id: "G",  label: "G",  title: "Ghost",    color: "#808080" },
  { id: "HH", label: "H",  title: "HH Pedal", color: "#7aaa7a" },
] as const;
type VoiceBtnId = typeof VOICE_BTN[number]["id"];

// ── Helper: DrumMeasure → StripMeasureData (for quickmark previews) ─────────

function measureToStripData(m: DrumMeasure, grid: GridType): StripMeasureData {
  const beatSize = GRID_SUBDIVS[grid] / 4;
  const perms = getPerms(grid);
  const oPerm = m.hhClosedPermId ? perms.find(p => p.id === m.hhClosedPermId) : null;
  const oHits = oPerm ? permHits(oPerm, grid) : [];
  const oOpen = getOpenHits(oHits, m.ostinatoOpenSlots ?? [], beatSize);
  const sHits = resolveSnareHits(m, grid);
  const bHits = resolveBassHits(m, grid);
  const gHits = resolveGhostHits(m, grid);
  const hPerm = m.hhOpenPermId ? perms.find(p => p.id === m.hhOpenPermId) : null;
  const hHits = hPerm ? permHits(hPerm, grid) : [];
  const hOpen = getOpenHits(hHits, m.hhFootOpenSlots ?? [], beatSize);
  const gDoubleHits: number[] = [];
  if (m.ghostDoubleSlots && m.ghostDoubleSlots.length > 0) {
    gHits.forEach(absSlot => {
      const beatSlot = absSlot % beatSize;
      if (m.ghostDoubleSlots![beatSlot]) gDoubleHits.push(absSlot);
    });
  }
  return {
    grid, ostinatoHits: oHits, ostinatoOpen: oOpen,
    snareHits: sHits, bassHits: bHits,
    hhFootHits: hHits, hhFootOpen: hOpen,
    ghostHits: gHits, ghostDoubleHits: gDoubleHits,
    accentFlags: m.accentSlots,
  };
}

// ── Helper: open-slot booleans → hit positions ─────────────────────────────

function getOpenHits(allHits: number[], openSlots: boolean[], beatSize: number): number[] {
  const result: number[] = [];
  for (let slot = 0; slot < beatSize; slot++) {
    if (openSlots[slot]) {
      for (let beat = 0; beat < 4; beat++) {
        const pos = slot + beat * beatSize;
        if (allHits.includes(pos)) result.push(pos);
      }
    }
  }
  return result;
}

// ── Helper: resolve all voice hits from a DrumMeasure ─────────────────────

function resolveMeasureHits(m: DrumMeasure, grid: GridType) {
  const beatSize = GRID_SUBDIVS[grid] / 4;
  const perms = getPerms(grid);

  const oPerm = m.hhClosedPermId ? perms.find(p => p.id === m.hhClosedPermId) : null;
  const oHits = oPerm ? permHits(oPerm, grid) : [];
  const oOpenPerm = m.ostinatoOpenPermId ? perms.find(p => p.id === m.ostinatoOpenPermId) : null;
  const oOpen = oOpenPerm ? permHits(oOpenPerm, grid) : getOpenHits(oHits, m.ostinatoOpenSlots ?? [], beatSize);

  const sHits = resolveSnareHits(m, grid);
  const bHits = resolveBassHits(m, grid);
  const gHits = resolveGhostHits(m, grid);

  const hPerm = m.hhOpenPermId ? perms.find(p => p.id === m.hhOpenPermId) : null;
  const hHits = hPerm ? permHits(hPerm, grid) : [];
  const hOpen = getOpenHits(hHits, m.hhFootOpenSlots ?? [], beatSize);

  // Ostinato double slots
  const oDoubleHits: number[] = [];
  if (m.ostinatoDoubleSlots && m.ostinatoDoubleSlots.length > 0) {
    oHits.forEach(absSlot => {
      const beatSlot = absSlot % beatSize;
      if (m.ostinatoDoubleSlots![beatSlot]) oDoubleHits.push(absSlot);
    });
  }

  // HH foot double slots
  const hDoubleHits: number[] = [];
  if (m.hhFootDoubleSlots && m.hhFootDoubleSlots.length > 0) {
    hHits.forEach(absSlot => {
      const beatSlot = absSlot % beatSize;
      if (m.hhFootDoubleSlots![beatSlot]) hDoubleHits.push(absSlot);
    });
  }

  // Ghost double: when permutation-based, the double pattern REPLACES the ghost hits
  // entirely (it's an independent permutation, not a modifier on existing hits).
  // Slot-based doubles remain a subset of existing ghost hits.
  const gDblPerm = m.ghostDoublePermId ? perms.find(p => p.id === m.ghostDoublePermId) : null;
  let gDoubleHits: number[];
  if (gDblPerm) {
    // Permutation-based: replace ghost hits with the double pattern
    const dblPositions = permHits(gDblPerm, grid);
    gHits.length = 0;
    gHits.push(...dblPositions);
    gDoubleHits = [...dblPositions]; // all hits are doubles
  } else {
    // Slot-based: doubles are a subset of existing ghost hits
    gDoubleHits = [];
    if (m.ghostDoubleSlots && m.ghostDoubleSlots.length > 0) {
      gHits.forEach(absSlot => {
        const beatSlot = absSlot % beatSize;
        if (m.ghostDoubleSlots![beatSlot]) gDoubleHits.push(absSlot);
      });
    }
  }

  // Snare double slots
  const sDoubleHits: number[] = [];
  if (m.snareDoubleSlots && m.snareDoubleSlots.length > 0) {
    sHits.forEach(absSlot => {
      const beatSlot = absSlot % beatSize;
      if (m.snareDoubleSlots![beatSlot]) sDoubleHits.push(absSlot);
    });
  }

  // Bass double slots
  const bDoubleHits: number[] = [];
  if (m.bassDoubleSlots && m.bassDoubleSlots.length > 0) {
    bHits.forEach(absSlot => {
      const beatSlot = absSlot % beatSize;
      if (m.bassDoubleSlots![beatSlot]) bDoubleHits.push(absSlot);
    });
  }

  return { oHits, oOpen, oDoubleHits, sHits, sDoubleHits, bHits, bDoubleHits, hHits, hOpen, hDoubleHits, gHits, gDoubleHits, accentSlots: m.accentSlots };
}

// ── VoicePermCard ─────────────────────────────────────────────────────────────

function VoicePermCard({ p, grid, isSelected, color, onSelect }: {
  p: Permutation;
  grid: GridType;
  isSelected: boolean;
  color: string;
  onSelect: () => void;
}) {
  const beatSize = GRID_SUBDIVS[grid] / 4;
  const DOT = 12;
  const GAP = 5;
  const PAD = 6;
  const cardW = beatSize * (DOT + GAP) - GAP + PAD * 2;

  const accent = isSelected ? color : "#555";
  const border = isSelected ? color : "#222";
  const bg     = isSelected ? color + "22" : "#0e0e0e";

  return (
    <button onClick={onSelect} style={{
      width: cardW, flexShrink: 0,
      padding: "6px 0 5px",
      borderRadius: 6,
      border: `1.5px solid ${border}`,
      background: bg,
      cursor: "pointer",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
    }}>
      <div style={{ display: "flex", gap: GAP, padding: `0 ${PAD}px` }}>
        {Array.from({ length: beatSize }, (_, i) => {
          const hit = p.beatSlots.includes(i);
          return (
            <div key={i} style={{
              width: DOT, height: DOT, borderRadius: "50%",
              background: hit ? accent : "transparent",
              border: `1.5px solid ${hit ? accent : "#2a2a2a"}`,
            }} />
          );
        })}
      </div>
      <span style={{ fontSize: 9, fontFamily: "monospace", fontWeight: 700, color: isSelected ? accent : "#444" }}>
        {p.label}
      </span>
    </button>
  );
}

// ── VoiceRow ──────────────────────────────────────────────────────────────────

function VoiceRow({ voiceId, label, color, hasOpen, hasDouble, count, setCount,
  permId, onAssign, openSlots, onToggleOpen, doubleSlots, onToggleDouble,
  maxFamily, excludeSlots, grid }: {
  voiceId: string;
  label: string;
  color: string;
  hasOpen: boolean;
  hasDouble?: boolean;
  count: number;
  setCount: (n: number) => void;
  permId: string | null;
  onAssign: (id: string) => void;
  openSlots: boolean[];
  onToggleOpen: (slot: number) => void;
  doubleSlots?: boolean[];
  onToggleDouble?: (slot: number) => void;
  maxFamily?: number;
  excludeSlots?: Set<number>;
  grid: GridType;
}) {
  const perms = getPerms(grid);
  const beatSize = GRID_SUBDIVS[grid] / 4;
  const maxF = maxFamily ?? 99;

  // Available counts: limited by maxFamily, and only families present after exclusion
  const availablePerms = excludeSlots && excludeSlots.size > 0
    ? perms.filter(p => p.family <= maxF && !p.beatSlots.some(s => excludeSlots.has(s)))
    : perms.filter(p => p.family <= maxF);

  const availCounts = [...new Set(availablePerms.map(p => p.family))].sort((a, b) => a - b);
  const filteredPerms = availablePerms.filter(p => p.family === count);
  const selPerm = availablePerms.find(p => p.id === permId);
  const toggleLabel = hasDouble ? "2x:" : "open:";

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 8,
      padding: "6px 12px", borderBottom: "1px solid #181818",
      minHeight: 52,
    }}>
      {/* Voice pill */}
      <div style={{ width: 62, flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color, letterSpacing: 1 }}>{voiceId}</div>
        <div style={{ fontSize: 8, color: "#3a3a3a", marginTop: 1 }}>{label}</div>
      </div>

      {/* Count tabs */}
      <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
        {availCounts.map(n => (
          <button key={n} onClick={() => setCount(n)}
            style={{
              width: 22, height: 22, borderRadius: 3, fontSize: 9, fontWeight: 700,
              border: `1px solid ${count === n ? color + "88" : "#1a1a1a"}`,
              background: count === n ? color + "22" : "#0e0e0e",
              color: count === n ? color : "#333",
              cursor: "pointer",
            }}>{n}</button>
        ))}
      </div>

      {/* Perm cards */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", flex: 1, alignItems: "center" }}>
        {filteredPerms.map(p => (
          <VoicePermCard key={p.id} p={p} grid={grid}
            isSelected={permId === p.id}
            color={color}
            onSelect={() => onAssign(p.id)} />
        ))}
        {filteredPerms.length === 0 && (
          <span style={{ fontSize: 9, color: "#2a2a2a" }}>—</span>
        )}
      </div>

      {/* Open/close toggles (O and HH Pedal) */}
      {hasOpen && (
        <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0, marginLeft: 4 }}>
          <span style={{ fontSize: 8, color: "#333" }}>open:</span>
          {Array.from({ length: beatSize }, (_, slot) => {
            const isHit  = !!selPerm?.beatSlots.includes(slot);
            const isOpen = openSlots[slot] ?? false;
            return (
              <button key={slot}
                onClick={() => { if (isHit) onToggleOpen(slot); }}
                disabled={!isHit}
                title={isHit ? (isOpen ? "Click to close" : "Click to open") : "No hit on this slot"}
                style={{
                  width: 20, height: 20, borderRadius: "50%",
                  border: `1.5px solid ${isHit ? (isOpen ? color : color + "55") : "#1e1e1e"}`,
                  background: isHit ? (isOpen ? color + "33" : "transparent") : "transparent",
                  color: isHit ? (isOpen ? color : color + "66") : "#2a2a2a",
                  fontSize: 11, cursor: isHit ? "pointer" : "default",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  lineHeight: 1, flexShrink: 0,
                }}>
                {isHit ? (isOpen ? "○" : "×") : "·"}
              </button>
            );
          })}
        </div>
      )}

      {/* Double-stroke toggles (Ghost row) */}
      {hasDouble && (
        <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0, marginLeft: 4 }}>
          <span style={{ fontSize: 8, color: "#444" }}>{toggleLabel}</span>
          {Array.from({ length: beatSize }, (_, slot) => {
            const isHit    = !!selPerm?.beatSlots.includes(slot);
            const isDbl    = (doubleSlots ?? [])[slot] ?? false;
            return (
              <button key={slot}
                onClick={() => { if (isHit && onToggleDouble) onToggleDouble(slot); }}
                disabled={!isHit}
                title={isHit ? (isDbl ? "Single stroke" : "Double stroke") : "No hit on this slot"}
                style={{
                  width: 20, height: 20, borderRadius: 3,
                  border: `1.5px solid ${isHit ? (isDbl ? color : color + "55") : "#1e1e1e"}`,
                  background: isHit ? (isDbl ? color + "33" : "transparent") : "transparent",
                  color: isHit ? (isDbl ? color : color + "66") : "#2a2a2a",
                  fontSize: 8, fontWeight: 700, cursor: isHit ? "pointer" : "default",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  lineHeight: 1, flexShrink: 0,
                }}>
                {isHit ? (isDbl ? "D" : "s") : "·"}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Multi-row phrase layout ────────────────────────────────────────────────

const BARS_PER_ROW = 4;
const PHRASE_GAP   = 24; // px gap between phrase segments on the same row

interface RowSegment {
  measures:    DrumMeasure[];
  indices:     number[];   // global measure indices
  phraseIdx:   number;
}

function buildRows(measures: DrumMeasure[], phraseBreaks: number[], barsPerRow = BARS_PER_ROW): RowSegment[][] {
  if (measures.length === 0) return [];
  const breakSet = new Set(phraseBreaks);

  // Split into phrases
  const phrases: { measures: DrumMeasure[]; indices: number[] }[] = [];
  let cur: { measures: DrumMeasure[]; indices: number[] } = { measures: [], indices: [] };
  for (let i = 0; i < measures.length; i++) {
    if (i > 0 && breakSet.has(i)) { phrases.push(cur); cur = { measures: [], indices: [] }; }
    cur.measures.push(measures[i]);
    cur.indices.push(i);
  }
  if (cur.measures.length > 0) phrases.push(cur);

  // Pack into rows of max barsPerRow, phrase boundaries may share a row
  const rows: RowSegment[][] = [];
  let row: RowSegment[] = [];
  let rowCount = 0;

  for (let pi = 0; pi < phrases.length; pi++) {
    const ph = phrases[pi];
    let pos = 0;
    while (pos < ph.measures.length) {
      const avail = barsPerRow - rowCount;
      if (avail === 0) { rows.push(row); row = []; rowCount = 0; }
      const take = Math.min(ph.measures.length - pos, barsPerRow - rowCount);
      row.push({ measures: ph.measures.slice(pos, pos + take), indices: ph.indices.slice(pos, pos + take), phraseIdx: pi });
      rowCount += take;
      pos += take;
      if (rowCount === barsPerRow) { rows.push(row); row = []; rowCount = 0; }
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

// ── Helper: set a voice's permutation ID on a measure ─────────────────────

function withVoicePerm(m: DrumMeasure, voice: VoiceBtnId | string, permId: string): DrumMeasure {
  switch (voice) {
    case "S":      return { ...m, snarePermId: permId };
    case "B":      return { ...m, bassPermId: permId };
    case "O":      return { ...m, hhClosedPermId: permId || undefined };
    case "G":      return { ...m, ghostPermId: permId || undefined };
    case "HH":     return { ...m, hhOpenPermId: permId || undefined };
    case "G-dbl":  return { ...m, ghostDoublePermId: permId || undefined };
    case "O-open": return { ...m, ostinatoOpenPermId: permId || undefined };
    default:       return m;
  }
}

// ── Perm-rotation panel helpers ────────────────────────────────────────────

const VOICE_FULLNAME: Record<VoiceBtnId, string> = {
  S: "Snare", B: "Bass", O: "Ostinato (hi-hat)", G: "Ghost", HH: "Hi-hat (foot)",
};

function getVoicePermId(m: DrumMeasure, voice: VoiceBtnId | string): string | undefined {
  switch (voice) {
    case "S":      return m.snarePermId    || undefined;
    case "B":      return m.bassPermId     || undefined;
    case "O":      return m.hhClosedPermId;
    case "G":      return m.ghostPermId;
    case "HH":     return m.hhOpenPermId;
    case "G-dbl":  return m.ghostDoublePermId;
    case "O-open": return m.ostinatoOpenPermId;
  }
}

function getCustomSeq(orderMap: Record<string, number>, ps: Permutation[]): string[] {
  return ps
    .filter(p => (orderMap[p.id] ?? 0) > 0)
    .sort((a, b) => (orderMap[a.id] ?? 0) - (orderMap[b.id] ?? 0))
    .map(p => p.id);
}

function PermPanel({
  measureIdx, measures, grid, voice,
  mode, limit, orderMap,
  rotateVoices, ghostDouble,
  onModeChange, onLimitChange, onOrderChange, onRotateVoiceToggle, onGhostDoubleToggle, onClose,
}: {
  measureIdx:            number;
  measures:              DrumMeasure[];
  grid:                  GridType;
  voice:                 VoiceBtnId;
  mode:                  "seq" | "rnd" | "custom";
  limit:                 number;
  orderMap:              Record<string, number>;
  rotateVoices:          VoiceBtnId[];
  ghostDouble:           boolean;
  onModeChange:          (m: "seq" | "rnd" | "custom") => void;
  onLimitChange:         (l: number) => void;
  onOrderChange:         (permId: string, pos: number) => void;
  onRotateVoiceToggle:   (v: VoiceBtnId) => void;
  onGhostDoubleToggle:   () => void;
  onClose:               () => void;
}) {
  const ps       = getPerms(grid);
  const m        = measures[measureIdx];
  const activeId = m ? getVoicePermId(m, voice) : undefined;
  const families = [...new Set(ps.map(p => p.family))].sort((a, b) => a - b);

  const BTN_SM: React.CSSProperties = {
    width: 18, height: 18, border: "1px solid #252525", background: "#141414",
    color: "#555", borderRadius: 3, cursor: "pointer", fontSize: 13,
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0, padding: 0, lineHeight: 1,
  };

  return (
    <div style={{
      background: "#0e0e0e",
      border: "1px solid #252525",
      borderRadius: 6,
      padding: "6px 8px 8px",
      width: "100%",
      boxSizing: "border-box",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4, gap: 4 }}>
        <span style={{ fontSize: 10, color: "#888", flex: 1 }}>
          M{measureIdx + 1}
        </span>
      </div>

      {/* Rotate voices row */}
      <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 4, flexWrap: "wrap" }}>
        <span style={{ fontSize: 9, color: "#666" }}>Rot:</span>
        {VOICE_BTN.map(vb => {
          const on = rotateVoices.includes(vb.id);
          return (
            <button key={vb.id} onClick={() => onRotateVoiceToggle(vb.id)}
              title={`${on ? "Stop rotating" : "Rotate"} ${vb.title}`}
              style={{
                padding: "1px 4px", borderRadius: 3, fontSize: 9, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${on ? vb.color : "#252525"}`,
                background: on ? vb.color + "28" : "#141414",
                color: on ? vb.color : "#444",
              }}>{vb.label}</button>
          );
        })}
        <button onClick={onGhostDoubleToggle}
          title="Double all ghost notes when rotating"
          style={{
            padding: "1px 4px", borderRadius: 3, fontSize: 9, fontWeight: 700, cursor: "pointer",
            border: `1px solid ${ghostDouble ? "#8888ff" : "#252525"}`,
            background: ghostDouble ? "#1a1a44" : "#141414",
            color: ghostDouble ? "#9999ff" : "#444",
          }}>G=dbl</button>
      </div>

      {/* Mode tabs */}
      <div style={{ display: "flex", gap: 2, marginBottom: 4 }}>
        {(["seq", "rnd", "custom"] as const).map(tab => (
          <button key={tab} onClick={() => onModeChange(tab)} style={{
            padding: "2px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700, cursor: "pointer",
            border: `1px solid ${mode === tab ? "#e0a040" : "#252525"}`,
            background: mode === tab ? "#2a1a0a" : "#141414",
            color: mode === tab ? "#e0a040" : "#555",
          }}>
            {tab === "seq" ? "→Seq" : tab === "rnd" ? "~Rnd" : "#Cust"}
          </button>
        ))}
      </div>

      {/* Limit (seq / rnd only) */}
      {mode !== "custom" && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: "#666" }}>Pool</span>
          <input
            type="number" min={0} value={limit === 0 ? "" : limit} placeholder="∞"
            onChange={e => { const v = parseInt(e.target.value, 10); onLimitChange(isNaN(v) || v <= 0 ? 0 : v); }}
            style={{
              width: 36, height: 18, textAlign: "center",
              background: "#141414", border: `1px solid ${limit > 0 ? "#c8aa50" : "#252525"}`,
              borderRadius: 3, color: limit > 0 ? "#c8aa50" : "#444", fontSize: 10, outline: "none",
            }}
          />
        </div>
      )}

      {/* Custom ordering legend */}
      {mode === "custom" && (
        <div style={{ fontSize: 9, color: "#555", marginBottom: 4 }}>
          Set position # to include. Blank = exclude.
        </div>
      )}

      {/* Perm list — families as side-by-side columns */}
      <div style={{ display: "flex", gap: 4, maxHeight: 200, overflowY: "auto", overflowX: "auto", paddingRight: 1 }}>
        {families.map(fam => {
          const group = ps.filter(p => p.family === fam);
          return (
            <div key={fam} style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 8, color: "#3a3a3a", textTransform: "uppercase", letterSpacing: 0.5, margin: "3px 0 2px", textAlign: "center" }}>
                {fam}
              </div>
              {group.map(p => {
                const isActive = p.id === activeId;
                const pos      = orderMap[p.id] ?? 0;
                return (
                  <div key={p.id} style={{
                    display: "flex", alignItems: "center", gap: 2,
                    padding: "1px 2px", borderRadius: 3, marginBottom: 1,
                    background: isActive ? "rgba(224,160,64,0.08)" : "transparent",
                  }}>
                    {mode === "custom" && (
                      <>
                        <button onClick={() => onOrderChange(p.id, Math.max(0, pos - 1))} style={BTN_SM}>−</button>
                        <input
                          type="number" min={0} value={pos === 0 ? "" : pos} placeholder="—"
                          onChange={e => { const v = parseInt(e.target.value, 10); onOrderChange(p.id, isNaN(v) || v < 0 ? 0 : v); }}
                          style={{
                            width: 22, height: 16, textAlign: "center",
                            background: "#0e0e0e", border: `1px solid ${pos > 0 ? "#c8aa50" : "#1e1e1e"}`,
                            borderRadius: 3, color: pos > 0 ? "#c8aa50" : "#444", fontSize: 9, outline: "none",
                          }}
                        />
                        <button onClick={() => onOrderChange(p.id, pos + 1)} style={BTN_SM}>+</button>
                      </>
                    )}
                    <span style={{ fontSize: 9, color: isActive ? "#e0a040" : "#555", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {isActive ? "◉" : "○"} {p.label}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

    </div>
  );
}

// ── Pool preset save/load bar ─────────────────────────────────────────────

function PoolPresetBar({ voiceKey, poolIds, onLoad }: {
  voiceKey: string;
  poolIds: string[];
  onLoad: (ids: string[]) => void;
}) {
  const [presets, setPresets] = useState<PoolPreset[]>(() => loadPoolPresets());
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const matching = presets.filter(p => p.voice === voiceKey);

  const handleSave = () => {
    if (!name.trim() || poolIds.length === 0) return;
    if (editingId) {
      // Update existing preset with current pool + new name
      const preset: PoolPreset = { id: editingId, name: name.trim(), voice: voiceKey, permIds: [...poolIds] };
      setPresets(savePoolPreset(preset));
      setEditingId(null);
    } else {
      const preset: PoolPreset = { id: Date.now().toString(), name: name.trim(), voice: voiceKey, permIds: [...poolIds] };
      setPresets(savePoolPreset(preset));
    }
    setName("");
  };

  const handleDelete = (id: string) => {
    if (editingId === id) { setEditingId(null); setName(""); }
    setPresets(deletePoolPreset(id));
  };

  const handleEdit = (p: PoolPreset) => {
    onLoad(p.permIds);         // load its perms into the pool
    setName(p.name);           // populate input with current name
    setEditingId(p.id);        // mark as editing
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, flexWrap: "wrap", marginBottom: 4 }}>
      {matching.map(p => (
        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 0 }}>
          <button onClick={() => onLoad(p.permIds)}
            title={`Load "${p.name}" (${p.permIds.length} perms)`}
            style={{
              padding: "1px 5px", borderRadius: "3px 0 0 3px", fontSize: 8, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${editingId === p.id ? "#60a0e0" : "#333"}`,
              borderRight: "none",
              background: editingId === p.id ? "#60a0e015" : "#1a1a1a",
              color: editingId === p.id ? "#60a0e0" : "#888",
            }}>{p.name}</button>
          <button onClick={() => handleEdit(p)}
            title="Edit preset"
            style={{
              padding: "1px 3px", borderRadius: 0, fontSize: 7, cursor: "pointer",
              border: `1px solid ${editingId === p.id ? "#60a0e0" : "#333"}`,
              borderLeft: "none", borderRight: "none",
              background: editingId === p.id ? "#60a0e015" : "#1a1a1a",
              color: editingId === p.id ? "#60a0e0" : "#555",
            }}>&#9998;</button>
          <button onClick={() => handleDelete(p.id)}
            title="Delete preset"
            style={{
              padding: "1px 3px", borderRadius: "0 3px 3px 0", fontSize: 8, fontWeight: 700, cursor: "pointer",
              border: `1px solid ${editingId === p.id ? "#60a0e0" : "#333"}`,
              borderLeft: "none",
              background: "#1a1a1a", color: "#555",
            }}>&times;</button>
        </div>
      ))}
      <input value={name} onChange={e => { setName(e.target.value); if (!e.target.value.trim()) setEditingId(null); }}
        onKeyDown={e => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") { setEditingId(null); setName(""); } }}
        placeholder="save pool…"
        style={{
          width: 60, height: 16, fontSize: 8, padding: "0 3px",
          background: "#0a0a0a",
          border: `1px solid ${editingId ? "#60a0e0" : "#222"}`,
          borderRadius: 3,
          color: editingId ? "#60a0e0" : "#666", outline: "none",
        }} />
      {name.trim() && poolIds.length > 0 && (
        <button onClick={handleSave} style={{
          padding: "1px 4px", borderRadius: 3, fontSize: 8, fontWeight: 700, cursor: "pointer",
          border: `1px solid ${editingId ? "#4080c0" : "#2a5a2a"}`,
          background: editingId ? "#0a1a2a" : "#0a1a0a",
          color: editingId ? "#60a0e0" : "#4a8a4a",
        }}>{editingId ? "Update" : "Save"}</button>
      )}
      {editingId && (
        <button onClick={() => { setEditingId(null); setName(""); }} style={{
          padding: "1px 4px", borderRadius: 3, fontSize: 8, fontWeight: 600, cursor: "pointer",
          border: "1px solid #333", background: "#1a1a1a", color: "#555",
        }}>Cancel</button>
      )}
    </div>
  );
}

// ── SimplePermPanel: checklist-only permutation selector (no rotation) ─────

function SimplePermPanel({
  measureIdx, measures, grid, voice,
  onSelectPerm, onClose,
  onToggleOpen, onToggleDouble,
  onSelectGhostDoublePerm,
  onSelectOstinatoOpenPerm,
  onTogglePool,
  onToggleSecondPool,
  onSetPool,
  onSetSecondPool,
}: {
  measureIdx:    number;
  measures:      DrumMeasure[];
  grid:          GridType;
  voice:         VoiceBtnId;
  onSelectPerm:  (measureIdx: number, voice: VoiceBtnId, permId: string) => void;
  onClose:       () => void;
  onToggleOpen?:   (measureIdx: number, voice: VoiceBtnId, slot: number) => void;
  onToggleDouble?: (measureIdx: number, voice: VoiceBtnId, slot: number) => void;
  onSelectGhostDoublePerm?: (measureIdx: number, permId: string) => void;
  onSelectOstinatoOpenPerm?: (measureIdx: number, permId: string) => void;
  onTogglePool?: (measureIdx: number, voice: VoiceBtnId, permId: string) => void;
  onToggleSecondPool?: (measureIdx: number, voice: VoiceBtnId, permId: string) => void;
  onSetPool?: (measureIdx: number, voice: VoiceBtnId, permIds: string[]) => void;
  onSetSecondPool?: (measureIdx: number, voice: VoiceBtnId, permIds: string[]) => void;
}) {
  const ps       = getPerms(grid);
  const beatSize = GRID_SUBDIVS[grid] / 4;
  const labels   = BEAT_SLOT_LABELS[grid];
  const m        = measures[measureIdx];
  const families = [...new Set(ps.map(p => p.family))].sort((a, b) => a - b);
  const isLocked = !!m?.rotationLocked;

  const activeId = m ? getVoicePermId(m, voice) : undefined;

  // Pool IDs for top panel — all voices are multi-select pools for permutation generation
  const topPoolIds: Set<string> = new Set(
    voice === "S" ? (Array.isArray(m?.snarePermPool) ? m!.snarePermPool : [])
    : voice === "B" ? (Array.isArray(m?.bassPermPool) ? m!.bassPermPool : [])
    : voice === "G" ? (Array.isArray(m?.ghostPermIds) ? m!.ghostPermIds : [])
    : voice === "O" ? (Array.isArray(m?.hhClosedPermIds) ? m!.hhClosedPermIds : [])
    : voice === "HH" ? (Array.isArray(m?.hhOpenPermPool) ? m!.hhOpenPermPool : [])
    : []
  );

  // Second perm panel: Ghost gets doubles, Ostinato gets open
  const showSecondPanel = voice === "G" || voice === "O";
  const secondActiveId = voice === "G" ? m?.ghostDoublePermId : voice === "O" ? m?.ostinatoOpenPermId : undefined;
  const secondPoolIds: Set<string> = new Set(
    voice === "G" ? (Array.isArray(m?.ghostDoublePermIds) ? m!.ghostDoublePermIds : [])
    : voice === "O" ? (Array.isArray(m?.ostinatoOpenPermIds) ? m!.ostinatoOpenPermIds : [])
    : []
  );
  const secondPanelLabel = voice === "G" ? "Doubles" : "Open";

  const voiceColor = VOICE_BTN.find(v => v.id === voice)?.color ?? "#888";

  return (
    <div style={{
      background: "#0e0e0e",
      border: "1px solid #252525",
      borderRadius: 6,
      padding: "6px 8px 8px",
      width: "100%",
      boxSizing: "border-box",
      overflow: "hidden",
      opacity: isLocked ? 0.35 : 1,
      pointerEvents: isLocked ? "none" : "auto",
      transition: "opacity 0.15s",
    }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4, gap: 4 }}>
        <span style={{ fontSize: 10, color: "#888", flex: 1 }}>
          M{measureIdx + 1}{isLocked ? " (locked)" : ""}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, color: voiceColor,
          letterSpacing: 1, padding: "1px 5px",
          border: `1px solid ${voiceColor}44`,
          borderRadius: 3, background: `${voiceColor}11`,
        }}>
          {VOICE_BTN.find(v => v.id === voice)?.title ?? voice}
        </span>
      </div>

      {/* ── Permutation pool checklist ── */}
      <PoolPresetBar
        voiceKey={voice}
        poolIds={[...topPoolIds]}
        onLoad={(ids) => { if (onSetPool) onSetPool(measureIdx, voice, ids); }}
      />
      <div style={{ display: "flex", gap: 4, maxHeight: 200, overflowY: "auto", overflowX: "auto", paddingRight: 1 }}>
        {families.map(fam => {
          const group = ps.filter(p => p.family === fam);
          return (
            <div key={fam} style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 8, color: "#3a3a3a", textTransform: "uppercase", letterSpacing: 0.5, margin: "3px 0 2px", textAlign: "center" }}>
                {fam}
              </div>
              {group.map(p => {
                const inPool = topPoolIds.has(p.id);
                return (
                  <div key={p.id}
                    onClick={() => { if (onTogglePool) onTogglePool(measureIdx, voice, p.id); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 3,
                      padding: "2px 3px", borderRadius: 3, marginBottom: 1,
                      cursor: "pointer",
                      background: inPool ? `${voiceColor}14` : "transparent",
                    }}>
                    <span style={{
                      width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                      border: `1.5px solid ${inPool ? voiceColor : "#333"}`,
                      background: inPool ? voiceColor : "transparent",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 8, color: "#0e0e0e", fontWeight: 700,
                    }}>
                      {inPool ? "✓" : ""}
                    </span>
                    <span style={{ fontSize: 9, color: inPool ? voiceColor : "#555", whiteSpace: "nowrap" }}>
                      {p.label}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* ── Second permutation panel: Ghost→Doubles, Ostinato→Open ── */}
      {showSecondPanel && (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid #1a1a1a" }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: voiceColor, letterSpacing: 1, marginBottom: 5, textTransform: "uppercase" }}>
            {secondPanelLabel}
          </div>
          <PoolPresetBar
            voiceKey={voice === "G" ? "G-dbl" : "O-open"}
            poolIds={[...secondPoolIds]}
            onLoad={(ids) => { if (onSetSecondPool) onSetSecondPool(measureIdx, voice, ids); }}
          />
          <div style={{ display: "flex", gap: 4, maxHeight: 200, overflowY: "auto", overflowX: "auto", paddingRight: 1 }}>
            {families.map(fam => {
              const group = ps.filter(p => p.family === fam);
              return (
                <div key={fam} style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 8, color: "#3a3a3a", textTransform: "uppercase", letterSpacing: 0.5, margin: "3px 0 2px", textAlign: "center" }}>
                    {fam}
                  </div>
                  {group.map(p => {
                    const inPool = secondPoolIds.has(p.id);
                    return (
                      <div key={p.id}
                        onClick={() => {
                          if (onToggleSecondPool) onToggleSecondPool(measureIdx, voice, p.id);
                        }}
                        style={{
                          display: "flex", alignItems: "center", gap: 3,
                          padding: "2px 3px", borderRadius: 3, marginBottom: 1,
                          cursor: "pointer",
                          background: inPool ? `${voiceColor}14` : "transparent",
                        }}>
                        <span style={{
                          width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                          border: `1.5px solid ${inPool ? voiceColor : "#333"}`,
                          background: inPool ? voiceColor : "transparent",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 8, color: "#0e0e0e", fontWeight: 700,
                        }}>
                          {inPool ? "✓" : ""}
                        </span>
                        <span style={{ fontSize: 9, color: inPool ? voiceColor : "#555", whiteSpace: "nowrap" }}>
                          {p.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── UniversalPermPanel: shared rotation axis applied to ALL measures ────────
// Reads/writes a separate `universalPools` state, NOT per-measure pools. Each
// checked perm = one variation where every measure uses that perm for the voice
// simultaneously. With pool {1, +} you get 2 generated phrases via Permutate.
function UniversalPermPanel({
  pools, grid, onTogglePoolAll, hasMeasures,
}: {
  pools:           Partial<Record<VoiceBtnId, string[]>>;
  grid:            GridType;
  onTogglePoolAll: (voice: VoiceBtnId, permId: string) => void;
  hasMeasures:     boolean;
}) {
  const [voice, setVoice] = useState<VoiceBtnId>("S");
  const ps       = getPerms(grid);
  const families = [...new Set(ps.map(p => p.family))].sort((a, b) => a - b);
  const voiceColor = VOICE_BTN.find(v => v.id === voice)?.color ?? "#888";
  const voicePool = pools[voice] ?? [];

  if (!hasMeasures) return null;

  return (
    <div style={{
      background: "#0a0a0a",
      border: "1px solid #222",
      borderRadius: 6,
      padding: "6px 10px 8px",
      margin: "0 0 8px",
      width: "100%",
      boxSizing: "border-box",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, color: "#888", letterSpacing: 2,
          textTransform: "uppercase",
        }}>
          Universal
        </span>
        <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
          {VOICE_BTN.map(v => {
            const on = voice === v.id;
            return (
              <button key={v.id}
                onClick={() => setVoice(v.id)}
                style={{
                  padding: "2px 8px", height: 22, borderRadius: 4, fontSize: 10, fontWeight: 700,
                  border: `1.5px solid ${on ? v.color : "#222"}`,
                  background: on ? `${v.color}22` : "#111",
                  color: on ? v.color : "#555",
                  cursor: "pointer",
                }}>
                {v.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Family-grouped permutation checklist */}
      <div style={{ display: "flex", gap: 4, maxHeight: 200, overflowY: "auto", overflowX: "auto" }}>
        {families.map(fam => {
          const group = ps.filter(p => p.family === fam);
          return (
            <div key={fam} style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 8, color: "#3a3a3a", textTransform: "uppercase",
                letterSpacing: 0.5, margin: "2px 0", textAlign: "center",
              }}>
                {fam}
              </div>
              {group.map(p => {
                const inPool = voicePool.includes(p.id);
                return (
                  <div key={p.id}
                    onClick={() => onTogglePoolAll(voice, p.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 3,
                      padding: "2px 3px", borderRadius: 3, marginBottom: 1,
                      cursor: "pointer",
                      background: inPool ? `${voiceColor}18` : "transparent",
                    }}>
                    <span style={{
                      width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                      border: `1.5px solid ${inPool ? voiceColor : "#333"}`,
                      background: inPool ? voiceColor : "transparent",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 8, color: "#0e0e0e", fontWeight: 700,
                    }}>
                      {inPool ? "✓" : ""}
                    </span>
                    <span style={{
                      fontSize: 9,
                      color: inPool ? voiceColor : "#555",
                      whiteSpace: "nowrap",
                    }}>
                      {p.label}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── MeasureStrip: multi-row connected staves, max 4 bars/row, phrase gaps ─
const STRIP_CLEF_EXTRA = 36;  // extra px on first stave for clef

function MeasureStrip({
  measures, grid, selectedIdx, onSelect, onDelete,
  activeBeat, measureVoice, onVoiceSelect, onMeasureNav,
  openPanels, onTogglePanel, onLockToggle,
  phraseBreaks, barsPerRow, permOriginalCount,
  indexOffset = 0,
  onAccentToggle,
}: {
  measures:      DrumMeasure[];
  grid:          GridType;
  selectedIdx:   number | null;
  onSelect:      (i: number) => void;
  onDelete:      () => void;
  activeBeat:    number | null;
  measureVoice:  Record<number, VoiceBtnId[]>;
  onVoiceSelect: (idx: number, v: VoiceBtnId) => void;
  onMeasureNav:  (idx: number, dir: "back" | "fwd") => void;
  openPanels:    Set<number>;
  onTogglePanel: (idx: number) => void;
  onLockToggle:  (idx: number) => void;
  phraseBreaks:  number[];
  barsPerRow?:   number;
  permOriginalCount?: number | null;
  indexOffset?:  number;
  onAccentToggle?: (measureIdx: number, slot: number) => void;
}) {
  const stripContainerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  useEffect(() => {
    const el = stripContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setContainerW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (measures.length === 0) return null;

  const allStripData: StripMeasureData[] = measures.map(m => {
    const { oHits, oOpen, oDoubleHits, sHits, sDoubleHits, bHits, bDoubleHits, hHits, hOpen, hDoubleHits, gHits, gDoubleHits, accentSlots } = resolveMeasureHits(m, grid);
    return { grid, ostinatoHits: oHits, ostinatoOpen: oOpen, ostinatoDoubleHits: oDoubleHits, snareHits: sHits, snareDoubleHits: sDoubleHits, bassHits: bHits, bassDoubleHits: bDoubleHits, hhFootHits: hHits, hhFootOpen: hOpen, hhFootDoubleHits: hDoubleHits, ghostHits: gHits, ghostDoubleHits: gDoubleHits, accentFlags: accentSlots };
  });

  const rows = buildRows(measures, phraseBreaks, barsPerRow);

  // Compute dynamic measure width so rows fit without horizontal scroll
  const effectiveBarsPerRow = barsPerRow ?? BARS_PER_ROW;
  // Use the actual max measures in any row (not the fixed barsPerRow cap)
  // so fewer measures expand to fill the available width instead of leaving empty space.
  const maxBarsInRow = rows.reduce((mx, r) => Math.max(mx, r.reduce((s, seg) => s + seg.measures.length, 0)), 1);
  const maxSegsInRow = rows.reduce((mx, r) => Math.max(mx, r.length), 1);
  const gapTotal = Math.max(0, maxSegsInRow - 1) * PHRASE_GAP;
  const measureW = containerW > 0
    ? Math.max(120, Math.min(STRIP_MEASURE_W, Math.floor((containerW - STRIP_CLEF_EXTRA - gapTotal) / maxBarsInRow)))
    : STRIP_MEASURE_W;

  const BTN: React.CSSProperties = { width: 26, height: 26, borderRadius: 4, flexShrink: 0, fontSize: 10, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" };

  const hasAnyAccent = measures.some(m => m.accentSlots?.some(Boolean));
  const stripH = hasAnyAccent ? STRIP_MEASURE_H + 25 : STRIP_MEASURE_H;
  const stripStaveY = hasAnyAccent ? 40 : undefined;

  return (
    <div ref={stripContainerRef}>
      {rows.map((row, rowIdx) => (
        <div key={rowIdx} style={{ marginBottom: 0 }}>

          {/* ── Accent toggle row (above notation) ──────────────── */}
          {onAccentToggle && (
          <div style={{ display: "flex", height: 18 }}>
            {row.map((seg, segIdx) => {
              const clefExtra = segIdx === 0 ? STRIP_CLEF_EXTRA : 0;
              return (
                <div key={`${rowIdx}-${segIdx}-a`} style={{ display: "flex", marginLeft: segIdx > 0 ? PHRASE_GAP : 0 }}>
                  {seg.measures.map((m, relI) => {
                    const globalI = seg.indices[relI] + indexOffset;
                    const w = relI === 0 ? measureW + clefExtra : measureW;
                    const beatSize = GRID_SUBDIVS[grid] / 4;
                    const accents = m.accentSlots ?? [];
                    // Match VexFlow stave layout: clef ~40px, then formatter distributes
                    // notes evenly across fmtW. First note centered in its column.
                    const isFirst = relI === 0 && segIdx === 0;
                    const staveClef = isFirst ? 40 : 0;
                    const fmtW = isFirst ? measureW - 8 : measureW - 12;
                    const noteStep = fmtW / beatSize;
                    const noteStart = staveClef + noteStep * 0.35;
                    return (
                      <div key={globalI} style={{ width: w, flexShrink: 0, position: "relative", height: 18 }}>
                        {Array.from({ length: beatSize }, (_, slot) => {
                          const isAccented = !!accents[slot];
                          const left = noteStart + slot * noteStep;
                          return (
                            <button key={slot}
                              title={isAccented ? "Remove accent" : "Add accent"}
                              onClick={e => { e.stopPropagation(); onAccentToggle(globalI, slot); }}
                              style={{
                                position: "absolute", left: left - 8, top: 0,
                                width: 16, height: 16, borderRadius: 2,
                                border: `1px solid ${isAccented ? "#e0a040" : "#2a2a2a"}`,
                                background: isAccented ? "#e0a04028" : "transparent",
                                color: isAccented ? "#e0a040" : "#444",
                                fontSize: 12, fontWeight: 900, cursor: "pointer",
                                display: "flex", alignItems: "center", justifyContent: "center",
                                padding: 0, lineHeight: 1,
                              }}>
                              &gt;
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          )}

          {/* ── Notation + overlays ─────────────────────────────── */}
          <div style={{ display: "flex", alignItems: "flex-start", height: stripH }}>
            {row.map((seg, segIdx) => {
              const showClef  = segIdx === 0;
              const clefExtra = showClef ? STRIP_CLEF_EXTRA : 0;
              const segStripData = seg.indices.map(i => allStripData[i]);
              const segKey = seg.indices.map(i => {
                const m = measures[i];
                return [m.snarePermId, m.bassPermId, m.hhClosedPermId ?? "", m.hhOpenPermId ?? "", m.ghostPermId ?? "", (m.accentSlots ?? []).join("")].join("|");
              }).join(",");

              return (
                <div key={`${rowIdx}-${segIdx}-n`} style={{
                  position: "relative", height: stripH, flexShrink: 0,
                  marginLeft: segIdx > 0 ? PHRASE_GAP : 0,
                }}>
                  <VexDrumStrip
                    key={segKey}
                    measures={segStripData}
                    measureWidth={measureW}
                    height={stripH}
                    staveY={stripStaveY}
                    oneBeatPerBar
                    showClef={showClef}
                  />
                  {seg.measures.map((_, relI) => {
                    const globalI = seg.indices[relI] + indexOffset;
                    const x     = relI === 0 ? 0 : clefExtra + relI * measureW;
                    const w     = relI === 0 ? measureW + clefExtra : measureW;
                    const isSel = selectedIdx === globalI;
                    const isAct = activeBeat === globalI;
                    return (
                      <div key={globalI} onClick={() => onSelect(globalI)} style={{
                        position: "absolute", top: 0, left: x, width: w, height: stripH,
                        cursor: "pointer",
                        border: isAct ? "1.5px solid #e0a040" : isSel ? "1.5px solid #3a3aaa" : "1.5px solid transparent",
                        background: isAct ? "rgba(224,160,64,0.07)" : "transparent",
                        borderRadius: 4, boxSizing: "border-box",
                        transition: "border-color 80ms, background 80ms",
                      }}>
                        <span style={{ position: "absolute", top: 3, left: 5, fontSize: 8, color: isAct ? "#e0a040" : "#333", fontWeight: 700, userSelect: "none" }}>
                          {globalI + 1}
                        </span>
                        {isSel && !isAct && (
                          <button onClick={e => { e.stopPropagation(); onDelete(); }}
                            style={{ position: "absolute", top: 4, right: 4, width: 16, height: 16, borderRadius: "50%", background: "#3a1a1a", border: "1px solid #6a3a3a", color: "#e06060", fontSize: 9, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* ── Per-measure button row ───────────────────────────── */}
          <div style={{ display: "flex", height: BUTTON_ROW_H }}>
            {row.map((seg, segIdx) => {
              const clefExtra = segIdx === 0 ? STRIP_CLEF_EXTRA : 0;
              return (
                <div key={`${rowIdx}-${segIdx}-b`} style={{ display: "flex", marginLeft: segIdx > 0 ? PHRASE_GAP + 7 : 0 }}>
                  {seg.measures.map((m, relI) => {
                    const globalI   = seg.indices[relI] + indexOffset;
                    const w         = relI === 0 ? measureW + clefExtra : measureW;
                    const isGenerated = permOriginalCount != null && globalI >= permOriginalCount;
                    const activeVoices = measureVoice[globalI] ?? [];
                    const panelOpen = openPanels.has(globalI);
                    const isAct     = activeBeat === globalI;
                    const isLocked  = !!m.rotationLocked;
                    return (
                      <div key={globalI} style={{
                        width: w, flexShrink: 0,
                        display: "flex", alignItems: "center",
                        padding: "0 5px", gap: 3,
                        background: isAct ? "rgba(224,160,64,0.06)" : "transparent",
                      }}>
                        {isGenerated ? null : (<>
                        <button
                          title={isLocked ? "Rotation locked — click to unlock" : "Click to lock this measure (prevent rotation)"}
                          onClick={e => { e.stopPropagation(); onLockToggle(globalI); }}
                          style={{ ...BTN, width: 22, height: 22, border: `1.5px solid ${isLocked ? "#c8aa50" : "#252525"}`, background: isLocked ? "#c8aa5022" : "#111", color: isLocked ? "#c8aa50" : "#444", fontSize: 12, flexShrink: 0 }}>
                          {isLocked ? "🔒" : "🔓"}
                        </button>
                        <div style={{ display: "flex", gap: 2, flexWrap: "nowrap", alignItems: "center", opacity: isLocked ? 0.35 : 1 }}>
                          {VOICE_BTN.map(vb => {
                            const isSel = activeVoices.includes(vb.id);
                            return (
                              <button key={vb.id}
                                title={isLocked ? `${vb.title} (rotation locked)` : vb.title}
                                onClick={() => { if (!isLocked) { onVoiceSelect(globalI, vb.id); } }}
                                style={{ ...BTN, border: `1.5px solid ${isSel ? vb.color : panelOpen ? "#333" : "#252525"}`, background: isSel ? vb.color + "28" : "#111", color: isSel ? vb.color : "#555", cursor: isLocked ? "default" : "pointer" }}>
                                {vb.label}
                              </button>
                            );
                          })}
                        </div>
                        </>)}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

        </div>
      ))}
    </div>
  );
}




// ── K/S pattern group (one per phrase-length bin) ─────────────────────────
//
// Pulled out of the parent so the group's tile grid can own a ResizeObserver
// and size every tile to fill available width.  Auto-fit columns let tiles
// expand when a length has few patterns (len=4 has 2, so two wide tiles
// beats five narrow ones).  Dimensions mirror the Beat Preview renderer so
// the notation comes out with matching stem/beam proportions.
const KS_TILE_MIN_W    = 260;
const KS_TILE_GAP      = 14;
const KS_TILE_H        = 180;

function KSPatternGroup({
  idx, len, pool, pick, onPick, isCustom, onRemoveCustom,
}: {
  idx:             number;
  len:             number;
  pool:            KSPattern[];
  pick:            KSPattern | null | undefined;
  onPick:          (idx: number, p: KSPattern) => void;
  isCustom:        (p: KSPattern) => boolean;
  onRemoveCustom:  (p: KSPattern) => void;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [tileW, setTileW] = useState(KS_TILE_MIN_W);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      // Match the auto-fit column width so VexDrumStrip gets the exact
      // px width the browser will render the tile at. Without this the
      // formatter cramps notes into a best-guess width and spacing drifts.
      const rowW = el.clientWidth;
      if (rowW <= 0) return;
      const cols = Math.max(1, Math.floor((rowW + KS_TILE_GAP) / (KS_TILE_MIN_W + KS_TILE_GAP)));
      setTileW(Math.floor((rowW - KS_TILE_GAP * (cols - 1)) / cols));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 8,
      padding: 12, border: "1px solid #2a1a1a", borderRadius: 5, background: "#14080a",
    }}>
      <span style={{ fontSize: 11, color: "#888", fontWeight: 700, letterSpacing: 2 }}>
        {len}/16
      </span>
      <div
        ref={gridRef}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(auto-fit, minmax(${KS_TILE_MIN_W}px, 1fr))`,
          gap: KS_TILE_GAP,
        }}>
        {pool.map(p => {
          const isSel  = pick?.label === p.label && pick?.notes === p.notes;
          const custom = isCustom(p);
          const localSnare: number[] = [];
          const localBass:  number[] = [];
          for (let i = 0; i < p.notes.length; i++) {
            if (p.notes[i] === "B") localBass.push(i);
            else if (p.notes[i] === "S") localSnare.push(i);
          }
          return (
            <div
              key={`${p.label}:${p.notes}`}
              onClick={() => onPick(idx, p)}
              style={{
                position: "relative",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", padding: 0, borderRadius: 5,
                border: `2px solid ${isSel ? "#e06070" : custom ? "#3a3a5a" : "#1e1e1e"}`,
                background: isSel ? "#2a0e10" : "#0a0a0a",
                height: KS_TILE_H, overflow: "hidden", lineHeight: 0,
              }}>
              {custom && (
                <button
                  onClick={e => { e.stopPropagation(); onRemoveCustom(p); }}
                  title="Remove custom pattern"
                  style={{
                    position: "absolute", top: 4, right: 4,
                    width: 22, height: 22, borderRadius: 4,
                    fontSize: 14, fontWeight: 700,
                    border: "1px solid #6a2a2a", background: "#2a0a0a", color: "#e06060",
                    cursor: "pointer", lineHeight: 1, padding: 0, zIndex: 2,
                  }}>×</button>
              )}
              <VexDrumStrip
                measures={[{
                  // Always a 16th grid for K/S tiles — the ostinato's
                  // subdivision (including triplet ostinatos) does NOT
                  // reshape the K/S beaming.  A triplet hi-hat pattern
                  // tiles across 16th slots; the tile just shows the plain
                  // kick/snare rhythm in its native 16th grouping.
                  grid: "16th",
                  ostinatoHits: [], ostinatoOpen: [],
                  snareHits: localSnare,
                  bassHits:  localBass,
                  hhFootHits: [], hhFootOpen: [],
                  ghostHits: [], ghostDoubleHits: [],
                  // No accentFlags on the selection preview — accents are
                  // added by the user after the phrase is committed to the
                  // final-preview strip below.
                  slotOverride: p.notes.length,
                }]}
                measureWidth={tileW - 12}
                height={KS_TILE_H}
                showClef={false}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── K/S Interplay final preview strip ──────────────────────────────────────
//
// Wrapped phrase display: each row holds up to MEASURES_PER_ROW bars rendered
// as ONE connected VexDrumStrip (so time sigs + barlines stay native).  Each
// row starts its own stave with a clef so the phrase reads top-to-bottom
// rather than scrolling right.  Snare-accent buttons pin to each snare's
// actual rendered x-position (reported by VexDrumStrip's onNoteSlotPositions
// callback) so they stay aligned regardless of beam-grouping and time-sig
// width.  Per-row widths scale both up AND down to fit the card's inner
// width, so the final note never gets clipped on the right and sparse
// phrases still fill the row.
const MEASURES_PER_ROW = 4;

function InterplayFinalStrip({
  measures, selectedIdx, onSelect, onToggleAccent,
}: {
  measures:      InterplayMeasureData[];
  selectedIdx:   number | null;
  onSelect:      (i: number | null) => void;
  onToggleAccent:(mIdx: number, sIdx: number) => void;
}) {
  const STRIP_H = 200;
  const CLEF_W  = 40;
  const PAD     = 4;          // trailing gutter after final barline
  const CARD_PAD = 8;         // matches the card's padding below
  const MIN_MEASURE_W = 90;   // readable floor before squishing breaks notation
  const widthFor = (slots: number) => 60 + slots * 48;

  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardW, setCardW] = useState<number>(0);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => setCardW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows: InterplayMeasureData[][] = [];
  for (let i = 0; i < measures.length; i += MEASURES_PER_ROW) {
    rows.push(measures.slice(i, i + MEASURES_PER_ROW));
  }

  return (
    <div ref={cardRef} style={{
      display: "flex", flexDirection: "column", gap: 8, alignSelf: "stretch",
      background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 6,
      padding: CARD_PAD,
    }}>
      {rows.map((rowMeasures, rowIdx) => (
        <InterplayFinalRow
          key={rowIdx}
          rowMeasures={rowMeasures}
          mIdxOffset={rowIdx * MEASURES_PER_ROW}
          cardW={cardW}
          cardPad={CARD_PAD}
          clefW={CLEF_W}
          pad={PAD}
          stripH={STRIP_H}
          minMeasureW={MIN_MEASURE_W}
          widthFor={widthFor}
          selectedIdx={selectedIdx}
          onSelect={onSelect}
          onToggleAccent={onToggleAccent}
        />
      ))}
    </div>
  );
}

function InterplayFinalRow({
  rowMeasures, mIdxOffset, cardW, cardPad, clefW, pad, stripH, minMeasureW,
  widthFor, selectedIdx, onSelect, onToggleAccent,
}: {
  rowMeasures:      InterplayMeasureData[];
  mIdxOffset:       number;
  cardW:            number;
  cardPad:          number;
  clefW:            number;
  pad:              number;
  stripH:           number;
  minMeasureW:      number;
  widthFor:         (slots: number) => number;
  selectedIdx:      number | null;
  onSelect:         (i: number | null) => void;
  onToggleAccent:   (mIdx: number, sIdx: number) => void;
}) {
  // Scale per-measure widths proportionally to fill (or shrink to fit) the
  // card's inner note area, with a readable minimum floor.
  const naturalWidths = rowMeasures.map(m => widthFor(m.totalSlots));
  const naturalSum    = naturalWidths.reduce((a, b) => a + b, 0);
  const available     = Math.max(0, cardW - cardPad * 2 - clefW - pad);
  const scale         = cardW > 0 && naturalSum > 0 ? available / naturalSum : 1;
  const widths        = naturalWidths.map(w => Math.max(minMeasureW, Math.floor(w * scale)));
  const totalW        = clefW + widths.reduce((a, b) => a + b, 0) + pad;

  // Actual rendered note x-positions keyed by "ri:slot" — populated by
  // VexDrumStrip's onNoteSlotPositions callback after layout.  Until that
  // fires (first paint), accent buttons fall back to an even slot estimate.
  // The callback replaces the map wholesale on every render, so stale entries
  // are discarded automatically when widths or hit sets change — no separate
  // invalidation effect (a parent-side reset runs after the child's callback
  // and wipes out the fresh positions, leaving buttons stuck on the fallback).
  const [notePos, setNotePos] = useState<Map<string, number>>(new Map());
  const handleNoteSlotPositions = useCallback(
    (positions: Array<{ measureIdx: number; slot: number; x: number }>) => {
      setNotePos(prev => {
        const next = new Map<string, number>();
        for (const p of positions) next.set(`${p.measureIdx}:${p.slot}`, p.x);
        if (prev.size === next.size) {
          let same = true;
          for (const [k, v] of next) {
            if (prev.get(k) !== v) { same = false; break; }
          }
          if (same) return prev;
        }
        return next;
      });
    },
    [],
  );

  const stripMeasures: StripMeasureData[] = rowMeasures.map(m => ({
    // Always a 16th grid for the committed phrase — a triplet ostinato
    // does NOT reshape the beaming.  The hi-hat pattern tiles continuously
    // across bars (handled when measures are built/re-tiled), but the
    // rendered 16ths keep their standard 4-slot beam groups so the notation
    // stays readable in any bar length.
    grid: "16th" as GridType,
    ostinatoHits: m.hatHits,
    ostinatoOpen: m.hatOpenHits,
    snareHits:    m.snareHits,
    bassHits:     m.bassHits,
    hhFootHits:   m.hhFootHits ?? [],
    hhFootOpen:   [],
    crashHits:    m.crashHits ?? [],
    ghostHits:    m.ghostHits,
    ghostDoubleHits: [],
    accentFlags:  m.accentFlags,
    slotOverride: m.totalSlots,
  }));

  return (
    <div style={{ position: "relative" }}>
      <div style={{ width: totalW, height: stripH, lineHeight: 0 }}>
        <VexDrumStrip
          measures={stripMeasures}
          measureWidths={widths}
          measureWidth={widths[0] ?? 100}
          height={stripH}
          showClef={true}
          showTimeSig={true}
          oneBeatPerBar={true}
          onNoteSlotPositions={handleNoteSlotPositions}
        />
      </div>
      {rowMeasures.map((m, ri) => {
        const mi       = mIdxOffset + ri;
        const measureX = clefW + widths.slice(0, ri).reduce((a, b) => a + b, 0);
        const measureW = widths[ri];
        // Fallback header width for the pre-callback estimate.  First measure
        // also carries a clef, so it gets a wider header gutter.
        const headerW   = ri === 0 ? 30 : 20;
        const noteAreaX = measureX + headerW;
        const noteAreaW = measureW - headerW - 8;
        const isSel     = selectedIdx === mi;
        return (
          <div key={mi}>
            <div
              onClick={() => onSelect(isSel ? null : mi)}
              style={{
                position: "absolute", top: 0, left: measureX, width: measureW, height: stripH,
                cursor: "pointer",
                border: isSel ? "1.5px solid #3a3aaa" : "1.5px solid transparent",
                borderRadius: 4, boxSizing: "border-box",
              }}
            />
            {m.snareHits.map(sIdx => {
              const measured = notePos.get(`${ri}:${sIdx}`);
              const cx = measured ?? (noteAreaX + ((sIdx + 0.5) / m.totalSlots) * noteAreaW);
              const on = m.accentFlags[sIdx];
              return (
                <button
                  key={`acc-${mi}-${sIdx}`}
                  onClick={e => { e.stopPropagation(); onToggleAccent(mi, sIdx); }}
                  title={on ? "Remove accent" : "Accent this snare"}
                  style={{
                    position: "absolute", bottom: 2, left: cx - 10,
                    width: 20, height: 20, borderRadius: 3,
                    fontSize: 12, fontWeight: 700, cursor: "pointer",
                    border: `1.5px solid ${on ? "#e0a040" : "#3a3a5a"}`,
                    background: on ? "#3a2a0e" : "#0e0e1a",
                    color: on ? "#e0a040" : "#9999ee",
                    padding: 0, lineHeight: 1,
                  }}>{on ? ">" : "·"}</button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DrumPatterns({
  metronomeBpm = 120,
  metronomeRunning = false,
  startMetronome,
  betaPlayRotation = false,
  betaTransform = false,
  restoreTrigger = 0,
}: {
  metronomeBpm?: number;
  metronomeRunning?: boolean;
  startMetronome?: () => Promise<void>;
  betaPlayRotation?: boolean;
  betaTransform?: boolean;
  restoreTrigger?: number;
}) {
  const [mode, setMode] = useState<"ostinato" | "accent" | "stickings" | "independence" | "transform" | "interplay">("ostinato");

  // ── Transform state ─────────────────────────────────────────────────────
  const [transformSource, setTransformSource] = useState<TransformPattern[]>([]);
  const [transformSourceTab, setTransformSourceTab] = useState<string>("ostinato");
  const [grid, setGrid] = useState<GridType>(() => {
    try { const raw = localStorage.getItem("lt_drum_grid"); return raw ? (raw as GridType) : "16th"; } catch { return "16th"; }
  });

  // ── Per-voice perm state ────────────────────────────────────────────────
  const [wOPermId, setWOPermId] = useState<string | null>(null);
  const [wSPermId, setWSPermId] = useState<string | null>(null);
  const [wBPermId, setWBPermId] = useState<string | null>(null);
  const [wHPermId, setWHPermId] = useState<string | null>(null);
  const [wGPermId, setWGPermId] = useState<string | null>(null);

  // ── Per-voice note-count filter ─────────────────────────────────────────
  const [oCount, setOCount] = useState(1);
  const [sCount, setSCount] = useState(1);
  const [bCount, setBCount] = useState(1);
  const [hCount, setHCount] = useState(1);
  const [gCount, setGCount] = useState(1);

  // ── Open-slot booleans (O and HH only, length = beatSize) ──────────────
  const [wOOpenSlots, setWOOpenSlots] = useState<boolean[]>([]);
  const [wHOpenSlots, setWHOpenSlots] = useState<boolean[]>([]);

  // ── Ghost double-stroke slots (length = beatSize) ───────────────────────
  const [wGDoubleSlots, setWGDoubleSlots] = useState<boolean[]>([]);

  // ── Practice log tag (persists between logs) ────────────────────────────
  const [practiceTag, setPracticeTag] = useState("isolation");

  // ── Exercise strip ──────────────────────────────────────────────────────
  const [measures, setMeasures]       = useState<DrumMeasure[]>(() => {
    try { const raw = localStorage.getItem("lt_drum_measures"); return raw ? JSON.parse(raw) : []; } catch { return []; }
  });
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  // ── Save / load ─────────────────────────────────────────────────────────

  // ── Phrase breaks (indices where a new phrase starts) ─────────────────
  const [phraseBreaks, setPhraseBreaks] = useState<number[]>([]);

  // ── Permutation generation tracking ────────────────────────────────────
  // null = no permutations generated; number = how many measures are in the original phrase.
  // Persisted so crash-recovery can distinguish generated rotations from user-authored originals
  // (otherwise all measures look like regular ones and the permutation can't be reshaped).
  const [permOriginalCount, setPermOriginalCount] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem("lt_drum_perm_orig");
      if (!raw) return null;
      const v = JSON.parse(raw);
      return typeof v === "number" ? v : null;
    } catch { return null; }
  });

  // ── Quickmarks (bookmarked ostinato snapshots) ────────────────────────
  const [quickmarks, setQuickmarksState] = useState<Quickmark[]>(() => getQuickmarks());
  const [qmOpen, setQmOpen] = useState(false);
  const [qmEditId, setQmEditId] = useState<string | null>(null);
  const [qmEditLabel, setQmEditLabel] = useState("");

  // Re-sync quickmarks when bookmarks are added from the practice log modal
  useEffect(() => {
    const sync = () => setQuickmarksState(getQuickmarks());
    window.addEventListener("quickmarks-changed", sync);
    return () => window.removeEventListener("quickmarks-changed", sync);
  }, []);

  const addQuickmark = useCallback(() => {
    if (measures.length === 0) return;
    const label = `${measures.length}m · ${grid}`;
    const qm: Quickmark = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label,
      measures: JSON.parse(JSON.stringify(measures)),
      grid,
      permOriginalCount,
      timestamp: Date.now(),
    };
    setQuickmarksState(prev => {
      const next = [qm, ...prev];
      saveQuickmarksToLS(next);
      return next;
    });
    setQmOpen(true);
  }, [measures, grid, permOriginalCount]);

  const loadQuickmark = useCallback((qm: Quickmark) => {
    const ms = qm.measures as DrumMeasure[];
    setMeasures(ms);
    setGrid(qm.grid as GridType);
    setPermOriginalCount(qm.permOriginalCount);
    setPhraseBreaks([]);
    setSelectedIdx(null);
  }, []);

  const deleteQuickmark = useCallback((id: string) => {
    setQuickmarksState(prev => {
      const next = prev.filter(q => q.id !== id);
      saveQuickmarksToLS(next);
      return next;
    });
  }, []);

  const renameQuickmark = useCallback((id: string, newLabel: string) => {
    setQuickmarksState(prev => {
      const next = prev.map(q => q.id === id ? { ...q, label: newLabel } : q);
      saveQuickmarksToLS(next);
      return next;
    });
    setQmEditId(null);
  }, []);

  // ── Playback / rotation ─────────────────────────────────────────────────
  const [accentBeats,  setAccentBeats]  = useState<("accent" | "normal" | "silent")[]>(["accent", "normal", "normal", "normal"]);
  const [rotationAmt,  setRotationAmt]  = useState(1);
  const [isPlaying,    setIsPlaying]    = useState(false);
  const [activeBeat,   setActiveBeat]   = useState<number | null>(null);
  const [countdownLeft,setCountdownLeft]= useState<number | null>(null);

  // Per-measure active voices (multi-select for showing panels)
  const [measureVoice, setMeasureVoice] = useState<Record<number, VoiceBtnId[]>>({});

  // Per-measure nav mode: sequential, random, or custom ordering
  const [measureMode,  setMeasureMode]  = useState<Record<number, "seq" | "rnd" | "custom">>({});
  // Per-measure permutation limit (0 = unlimited, used by seq/rnd modes)
  const [measureLimit, setMeasureLimit] = useState<Record<number, number>>({});
  // Per-measure custom perm order: { permId: position } (0 = excluded)
  const [measureOrder, setMeasureOrder] = useState<Record<number, Record<string, number>>>({});
  // Which measures' rotation panels are open (multiple allowed)
  const [openPanels, setOpenPanels] = useState<Set<number>>(new Set());

  // Per-measure voices to rotate (empty = rotate selected voice only)
  const [measureRotateVoices, setMeasureRotateVoices] = useState<Record<number, VoiceBtnId[]>>({});
  // Per-measure ghost-double-on-rotation toggle
  const [measureGhostDouble, setMeasureGhostDouble] = useState<Record<number, boolean>>({});

  // Universal pools per voice — single shared rotation axis applied identically
  // to every measure. Decoupled from per-measure pools entirely. With universal
  // pool {1, +} on Ostinato → 2 generated phrases (all measures use "1", then
  // all measures use "+"). Multiplies with per-measure pools as an outer axis.
  // Persisted alongside permOriginalCount so the permutation config survives reload.
  const [universalPools, setUniversalPools] = useState<Partial<Record<VoiceBtnId, string[]>>>(() => {
    try {
      const raw = localStorage.getItem("lt_drum_universal_pools");
      if (!raw) return {};
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? v : {};
    } catch { return {}; }
  });

  // ── Playback refs (avoid stale closures in setInterval) ─────────────────
  const intervalRef              = useRef<ReturnType<typeof setInterval> | null>(null);
  const measuresRef              = useRef(measures);
  const rotAmtRef                = useRef(rotationAmt);
  const measureLimitRef          = useRef(measureLimit);
  const measureOrderRef          = useRef(measureOrder);
  const accentBeatsRef           = useRef(accentBeats);
  const measureVoiceRef          = useRef(measureVoice);
  const measureModeRef           = useRef(measureMode);
  const measureRotateVoicesRef   = useRef(measureRotateVoices);
  const measureGhostDoubleRef    = useRef(measureGhostDouble);
  const gridRef                  = useRef(grid);
  const audioCtxRef              = useRef<AudioContext | null>(null);
  const pbRef                    = useRef({ beatIdx: 0, phraseCount: 0, isCountdown: true, countdownBeat: 0 });
  const beatPreviewRef           = useRef<HTMLDivElement>(null);
  const accentStripRef           = useRef<HTMLDivElement>(null);
  const ostinatoStripRef         = useRef<HTMLDivElement>(null);
  const composedStripRef         = useRef<HTMLDivElement>(null);
  const [composedStripW, setComposedStripW] = useState(0);
  const [showExport, setShowExport] = useState(false);

  useEffect(() => { measuresRef.current = measures; try { localStorage.setItem("lt_drum_measures", JSON.stringify(measures)); } catch { /* full */ } }, [measures]);
  useEffect(() => { rotAmtRef.current              = rotationAmt;         }, [rotationAmt]);
  useEffect(() => { measureLimitRef.current        = measureLimit;        }, [measureLimit]);
  useEffect(() => { measureOrderRef.current        = measureOrder;        }, [measureOrder]);
  useEffect(() => { accentBeatsRef.current         = accentBeats;        }, [accentBeats]);
  useEffect(() => { measureVoiceRef.current        = measureVoice;        }, [measureVoice]);
  useEffect(() => { measureModeRef.current         = measureMode;         }, [measureMode]);
  useEffect(() => { measureRotateVoicesRef.current = measureRotateVoices; }, [measureRotateVoices]);
  useEffect(() => { measureGhostDoubleRef.current  = measureGhostDouble;  }, [measureGhostDouble]);
  useEffect(() => { gridRef.current = grid; try { localStorage.setItem("lt_drum_grid", grid); } catch { /* full */ } }, [grid]);
  useEffect(() => {
    try { localStorage.setItem("lt_drum_perm_orig", JSON.stringify(permOriginalCount)); } catch { /* full */ }
  }, [permOriginalCount]);
  useEffect(() => {
    try { localStorage.setItem("lt_drum_universal_pools", JSON.stringify(universalPools)); } catch { /* full */ }
  }, [universalPools]);

  useEffect(() => {
    const el = composedStripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setComposedStripW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  // Restore from practice log — always appends to existing measures
  useEffect(() => {
    const drumData = readPendingRestore<{
      measures: DrumMeasure[];
      grid: GridType;
      permOriginalCount?: number | null;
      universalPools?: Partial<Record<VoiceBtnId, string[]>>;
    }>("drum");
    if (drumData) {
      if (drumData.grid) setGrid(drumData.grid as GridType);
      if (drumData.measures) {
        setMeasures(prev => prev.length > 0 ? [...prev, ...drumData.measures] : drumData.measures);
      }
      if (drumData.permOriginalCount != null) setPermOriginalCount(drumData.permOriginalCount);
      if (drumData.universalPools) setUniversalPools(drumData.universalPools);
      setMode("ostinato");
    }
    const accentData = readPendingRestore<{ measures: unknown[]; grid: string; importMode?: string }>("accent");
    if (accentData) {
      const incoming = (accentData.measures ?? []) as AccentMeasureData[];
      const importMode = accentData.importMode as "replace" | "phrase" | "line" | undefined;
      if (importMode === "line") {
        if (incoming.length > 0) incoming[0] = { ...incoming[0], lineBreak: true };
      }
      setAccentMeasures(prev => prev.length > 0 ? [...prev, ...incoming] : incoming);
      if (accentData.grid) setAccentGrid(accentData.grid as AccentSubdivision);
      setMode("accent");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreTrigger]);

  // Resize accentBeats when measure count changes
  useEffect(() => {
    const count = measures.length;
    setAccentBeats(prev => {
      const next: ("accent" | "normal" | "silent")[] = Array(count).fill("normal");
      for (let i = 0; i < Math.min(prev.length, count); i++) next[i] = prev[i];
      return next;
    });
  }, [measures.length]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, []);

  // ── Accent Study state ─────────────────────────────────────────────────
  const [accentMeasures, setAccentMeasures] = useState<AccentMeasureData[]>([]);
  const [accentGrid, setAccentGrid] = useState<AccentSubdivision>("16th");
  const [accentSelectedIdx, setAccentSelectedIdx] = useState<number | null>(null);

  // ── Stickings Study state ──────────────────────────────────────────────
  const [stickingMeasures, setStickingMeasures] = useState<StickingMeasureData[]>([]);
  const [stickingSelectedIdx, setStickingSelectedIdx] = useState<number | null>(null);

  // ── Independence Study state ────────────────────────────────────────────
  const [independenceMeasures, setIndependenceMeasures] = useState<IndependenceMeasureData[]>([]);
  const [independenceSelectedIdx, setIndependenceSelectedIdx] = useState<number | null>(null);
  const [independenceGrid, setIndependenceGrid] = useState<IndependenceGrid>("16th");

  // ── Pattern Ostinatos state ────────────────────────────────────────────────
  // Builder: phrase structure (e.g. "5+3") + one picked KSPattern per group.
  // Committing pushes each group as its own InterplayMeasureData — each with
  // its own time signature (length/16) — to `interplayMeasures`.
  const [interplayPhrase, setInterplayPhrase] = useState<string>("4+4+4+4");
  const [interplayPicks, setInterplayPicks] = useState<(KSPattern | null)[]>([]);
  // Null = no hi-hat; otherwise the OSTINATO_LIBRARY entry id (e.g. "o1", "o2").
  const [interplayOstinatoId, setInterplayOstinatoId] = useState<string | null>("o2");
  const [interplayMeasures, setInterplayMeasures] = useState<InterplayMeasureData[]>([]);
  const [interplaySelectedIdx, setInterplaySelectedIdx] = useState<number | null>(null);
  // User-added custom patterns, persisted to localStorage.  Flat array; filter
  // by length at UI render time so each group shows its matching customs.
  const [customPatterns, setCustomPatterns] = useState<KSPattern[]>(() => {
    try {
      const raw = localStorage.getItem("lt_interplay_customs");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem("lt_interplay_customs", JSON.stringify(customPatterns)); } catch {}
  }, [customPatterns]);
  const [customInput, setCustomInput] = useState<string>("");
  const parsedInterplayLengths = parsePhrase(interplayPhrase);
  // Sync picks array length to parsed phrase
  useEffect(() => {
    if (!parsedInterplayLengths) return;
    setInterplayPicks(prev => {
      const next = parsedInterplayLengths.map((len, i) =>
        prev[i] && prev[i]!.notes.length === len ? prev[i] : randomPattern(len),
      );
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interplayPhrase]);

  const rollInterplayGroup = useCallback((idx: number) => {
    setInterplayPicks(prev => {
      const next = [...prev];
      const lengths = parsePhrase(interplayPhrase);
      if (!lengths || !lengths[idx]) return prev;
      next[idx] = randomPattern(lengths[idx]);
      return next;
    });
  }, [interplayPhrase]);

  const rollInterplayAll = useCallback(() => {
    const lengths = parsePhrase(interplayPhrase);
    if (!lengths) return;
    setInterplayPicks(lengths.map(len => randomPattern(len)));
  }, [interplayPhrase]);

  /** Toggle the accent flag for `slotIdx` in interplay measure `mIdx`.
   *  ONLY snare slots are accentable — we never accent a kick here. */
  const toggleInterplayAccent = useCallback((mIdx: number, slotIdx: number) => {
    setInterplayMeasures(prev => prev.map((m, i) => {
      if (i !== mIdx) return m;
      if (!m.snareHits.includes(slotIdx)) return m;
      const next = [...m.accentFlags];
      next[slotIdx] = !next[slotIdx];
      return { ...m, accentFlags: next };
    }));
  }, []);

  /** Randomize snare accents "musically" across every committed measure.
   *  Rules:
   *    - First snare in each measure always accented (downbeat anchor).
   *    - Each other snare in the same measure gets a 40% chance of accent.
   *    - Kicks are never accented.
   *  This gives the phrase a strong-downbeat contour without being mechanical. */
  const randomizeSnareAccents = useCallback(() => {
    setInterplayMeasures(prev => prev.map(m => {
      const accentFlags = new Array<boolean>(m.totalSlots).fill(false);
      const snares = [...m.snareHits].sort((a, b) => a - b);
      if (snares.length > 0) accentFlags[snares[0]] = true;
      for (let i = 1; i < snares.length; i++) {
        if (Math.random() < 0.4) accentFlags[snares[i]] = true;
      }
      return { ...m, accentFlags };
    }));
  }, []);

  /** Clear all accents across every measure. */
  const clearInterplayAccents = useCallback(() => {
    setInterplayMeasures(prev => prev.map(m => ({
      ...m, accentFlags: new Array<boolean>(m.totalSlots).fill(false),
    })));
  }, []);

  /** Re-apply the current global hi-hat ostinato choice to every measure.
   *  Offsets accumulate across the phrase so the ostinato's repeating unit
   *  carries its phase over bar lines (important for 3-slot triplet patterns
   *  landing on non-multiple-of-3 bar lengths). */
  useEffect(() => {
    setInterplayMeasures(prev => {
      let slotOffset = 0;
      return prev.map(m => {
        const updated = {
          ...m,
          hatHits:     hatHitsFromOstinato(interplayOstinatoId, m.totalSlots, slotOffset),
          hatOpenHits: hatOpenFromOstinato(interplayOstinatoId, m.totalSlots, slotOffset),
          hhFootHits:  hatPedalFromOstinato(interplayOstinatoId, m.totalSlots, slotOffset),
          crashHits:   hatCrashFromOstinato(interplayOstinatoId, m.totalSlots, slotOffset),
        };
        slotOffset += m.totalSlots;
        return updated;
      });
    });
  }, [interplayOstinatoId]);

  /** Lookup: all patterns of a given length (Garstka library + user customs). */
  const poolForLength = useCallback((len: number): KSPattern[] => {
    const lib = KS_PATTERNS[len] ?? [];
    const cust = customPatterns.filter(p => p.notes.length === len);
    return [...lib, ...cust];
  }, [customPatterns]);

  /** True if this pattern is a user-added custom (can be deleted). */
  const isCustomPattern = useCallback((p: KSPattern) =>
    customPatterns.some(c => c.label === p.label && c.notes === p.notes),
  [customPatterns]);

  const addCustomPattern = useCallback(() => {
    const p = parseCustomPattern(customInput);
    if (!p) return;
    // Avoid duplicates (same label+notes)
    if (customPatterns.some(c => c.label === p.label && c.notes === p.notes)) {
      setCustomInput("");
      return;
    }
    if ((KS_PATTERNS[p.notes.length] ?? []).some(c => c.notes === p.notes)) {
      // Already in Garstka library — no need to duplicate
      setCustomInput("");
      return;
    }
    setCustomPatterns(prev => [...prev, p]);
    setCustomInput("");
  }, [customInput, customPatterns]);

  const removeCustomPattern = useCallback((p: KSPattern) => {
    setCustomPatterns(prev => prev.filter(c => !(c.label === p.label && c.notes === p.notes)));
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────
  const perms    = getPerms(grid);
  const subdivs  = GRID_SUBDIVS[grid];
  const beatSize = subdivs / 4;

  // Resolved hit arrays for the live preview
  const oPerm = perms.find(p => p.id === wOPermId);
  const sPerm = perms.find(p => p.id === wSPermId);
  const bPerm = perms.find(p => p.id === wBPermId);
  const hPerm = perms.find(p => p.id === wHPermId);
  const gPerm = perms.find(p => p.id === wGPermId);

  const prevOHits = oPerm ? permHits(oPerm, grid) : [];
  const prevOOpen = getOpenHits(prevOHits, wOOpenSlots, beatSize);
  const prevSHits = sPerm ? permHits(sPerm, grid) : [];
  const prevBHits = bPerm ? permHits(bPerm, grid) : [];
  const prevHHits = hPerm ? permHits(hPerm, grid) : [];
  const prevHOpen = getOpenHits(prevHHits, wHOpenSlots, beatSize);
  const prevGHits = gPerm ? permHits(gPerm, grid) : [];
  const prevGDoubleHits = getOpenHits(prevGHits, wGDoubleSlots, beatSize);

  // Ghost conflict: slots taken by snare
  const snareExcludeSlots = new Set<number>(sPerm?.beatSlots ?? []);

  // ── Reset on grid change ─────────────────────────────────────────────────
  useEffect(() => {
    setWOPermId(null);
    setWSPermId(null);
    setWBPermId(null);
    setWHPermId(null);
    setWGPermId(null);
    const bs = GRID_SUBDIVS[grid] / 4;
    setWOOpenSlots(Array(bs).fill(false));
    setWHOpenSlots(Array(bs).fill(false));
    setWGDoubleSlots(Array(bs).fill(false));
    setSelectedIdx(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const toggleOpen = useCallback((voice: "O" | "HH", slot: number) => {
    if (voice === "O") {
      setWOOpenSlots(prev => {
        const next = [...prev];
        while (next.length <= slot) next.push(false);
        next[slot] = !next[slot];
        return next;
      });
    } else {
      setWHOpenSlots(prev => {
        const next = [...prev];
        while (next.length <= slot) next.push(false);
        next[slot] = !next[slot];
        return next;
      });
    }
  }, []);

  const toggleDouble = useCallback((slot: number) => {
    setWGDoubleSlots(prev => {
      const next = [...prev];
      while (next.length <= slot) next.push(false);
      next[slot] = !next[slot];
      return next;
    });
  }, []);

  const buildMeasure = useCallback((): DrumMeasure => ({
    snarePermId:       wSPermId ?? "",
    bassPermId:        wBPermId ?? "",
    hhClosedPermId:    wOPermId ?? undefined,
    hhOpenPermId:      wHPermId ?? undefined,
    ghostPermId:       wGPermId ?? undefined,
    ostinatoOpenSlots: wOOpenSlots.some(Boolean) ? [...wOOpenSlots] : undefined,
    hhFootOpenSlots:   wHOpenSlots.some(Boolean) ? [...wHOpenSlots] : undefined,
    ghostDoubleSlots:  wGDoubleSlots.some(Boolean) ? [...wGDoubleSlots] : undefined,
  }), [wSPermId, wBPermId, wOPermId, wHPermId, wGPermId, wOOpenSlots, wHOpenSlots, wGDoubleSlots]);

  // Helper: clear all generated permutation copies, keeping only the original phrase
  const clearPermutations = useCallback(() => {
    if (permOriginalCount !== null) {
      setMeasures(prev => prev.slice(0, permOriginalCount));
      setPhraseBreaks([]);
      setPermOriginalCount(null);
    }
  }, [permOriginalCount]);

  const handleAdd = () => {
    if (permOriginalCount !== null) {
      // Adding a bar to the original phrase clears all permutation copies
      setMeasures(prev => [...prev.slice(0, permOriginalCount), buildMeasure()]);
      setPhraseBreaks([]);
      setPermOriginalCount(null);
    } else {
      setMeasures(prev => [...prev, buildMeasure()]);
    }
    setSelectedIdx(null);
  };

  /** Commit the current picks: every group becomes its own measure with its
   *  own time signature (length/16), appended to `interplayMeasures`.  The
   *  per-measure slot offset is the running total of preceding measures'
   *  totalSlots — including any already-committed ones — so the ostinato
   *  tiles continuously across the whole phrase. */
  const handleAddInterplay = useCallback(() => {
    const picked = interplayPicks.filter((p): p is KSPattern => p !== null);
    if (picked.length === 0) return;
    setInterplayMeasures(prev => {
      let slotOffset = prev.reduce((sum, m) => sum + m.totalSlots, 0);
      const built = picked.map(p => {
        const m = buildInterplayMeasureFromPattern(p, interplayOstinatoId, slotOffset);
        slotOffset += m.totalSlots;
        return m;
      });
      return [...prev, ...built];
    });
  }, [interplayPicks, interplayOstinatoId]);

  /** Replace the currently selected interplay measure with a new one built
   *  from the FIRST picked pattern.  The new measure inherits the replaced
   *  measure's slot position in the phrase so the ostinato phase is
   *  preserved. */
  const handleReplaceInterplay = useCallback(() => {
    if (interplaySelectedIdx === null) return;
    const picked = interplayPicks.filter((p): p is KSPattern => p !== null);
    if (picked.length === 0) return;
    setInterplayMeasures(prev => {
      const slotOffset = prev.slice(0, interplaySelectedIdx).reduce((s, m) => s + m.totalSlots, 0);
      const built = buildInterplayMeasureFromPattern(picked[0], interplayOstinatoId, slotOffset);
      return prev.map((old, i) => i === interplaySelectedIdx ? built : old);
    });
  }, [interplayPicks, interplayOstinatoId, interplaySelectedIdx]);

  const handleDeleteInterplay = useCallback(() => {
    if (interplaySelectedIdx === null) return;
    // Dropping a measure shifts every subsequent measure's position in the
    // phrase, so re-tile their ostinato hits from the new cumulative offset.
    setInterplayMeasures(prev => {
      const kept = prev.filter((_, i) => i !== interplaySelectedIdx);
      let slotOffset = 0;
      return kept.map(m => {
        const updated = {
          ...m,
          hatHits:     hatHitsFromOstinato(interplayOstinatoId, m.totalSlots, slotOffset),
          hatOpenHits: hatOpenFromOstinato(interplayOstinatoId, m.totalSlots, slotOffset),
          hhFootHits:  hatPedalFromOstinato(interplayOstinatoId, m.totalSlots, slotOffset),
          crashHits:   hatCrashFromOstinato(interplayOstinatoId, m.totalSlots, slotOffset),
        };
        slotOffset += m.totalSlots;
        return updated;
      });
    });
    setInterplaySelectedIdx(null);
  }, [interplaySelectedIdx, interplayOstinatoId]);

  const handleClearInterplay = useCallback(() => {
    setInterplayMeasures([]);
    setInterplaySelectedIdx(null);
  }, []);

  const handleReplace = () => {
    if (selectedIdx === null) return;
    // Only allow replacing measures in the original phrase
    if (permOriginalCount !== null && selectedIdx >= permOriginalCount) return;
    clearPermutations();
    setMeasures(prev => prev.map((m, i) => {
      if (i !== selectedIdx) return m;
      const built = buildMeasure();
      if (m.rotationLocked) built.rotationLocked = true;
      return built;
    }));
  };

  const handleDeleteSelected = () => {
    if (selectedIdx === null) return;
    // Only allow deleting measures in the original phrase
    if (permOriginalCount !== null && selectedIdx >= permOriginalCount) return;
    clearPermutations();
    setMeasures(prev => prev.filter((_, i) => i !== selectedIdx));
    setPhraseBreaks([]);
    setSelectedIdx(null);
  };

  // ── Add Permutations: Cartesian product across voice pools ──
  const handleAddPermutations = useCallback(() => {
    if (measures.length === 0) return;
    const origLen = permOriginalCount ?? measures.length;
    const origMeasures = measures.slice(0, origLen);
    const ps = getPerms(grid);
    if (ps.length === 0) return;

    // Build the effective pool for each original measure (family-filtered when no limit)
    const buildPool = (m: DrumMeasure, i: number): Permutation[] => {
      if (m.rotationLocked) return [];
      const rl = measureLimit[i] ?? 0;
      if (rl > 0) return ps.slice(0, Math.min(rl, ps.length));
      const voicesToRotate = (measureRotateVoices[i]?.length > 0)
        ? measureRotateVoices[i]
        : (measureVoice[i]?.length ? measureVoice[i] : ["S"] as VoiceBtnId[]);
      const families = new Set<number>();
      for (const voice of voicesToRotate) {
        const pid = getVoicePermId(m, voice);
        const p = ps.find(pp => pp.id === pid);
        if (p) families.add(p.family);
      }
      if (families.size === 0) return ps;
      return ps.filter(p => families.has(p.family));
    };

    // Helper: get the explicit pool for a voice, or null
    const getExplicitPool = (m: DrumMeasure, voice: VoiceBtnId): string[] | null => {
      if (voice === "S" && Array.isArray(m.snarePermPool) && m.snarePermPool.length > 0) return m.snarePermPool;
      if (voice === "B" && Array.isArray(m.bassPermPool) && m.bassPermPool.length > 0) return m.bassPermPool;
      if (voice === "G" && Array.isArray(m.ghostPermIds) && m.ghostPermIds.length > 0) return m.ghostPermIds;
      if (voice === "O" && Array.isArray(m.hhClosedPermIds) && m.hhClosedPermIds.length > 0) return m.hhClosedPermIds;
      if (voice === "HH" && Array.isArray(m.hhOpenPermPool) && m.hhOpenPermPool.length > 0) return m.hhOpenPermPool;
      return null;
    };

    // Build per-measure voice pool info for Cartesian product.
    // Ghost doubles and ostinato opens are treated as independent axes
    // so they permute separately from the main voice hits.
    type VoiceBtnIdExt = VoiceBtnId | "G-dbl" | "O-open";
    type VoicePool = { voice: VoiceBtnIdExt; pool: Permutation[] };
    const measureVoicePools: VoicePool[][] = origMeasures.map((m, i) => {
      if (m.rotationLocked) return [];
      // Collect voices that have explicit pools set
      const explicitVoices: VoiceBtnId[] = [];
      if (Array.isArray(m.snarePermPool) && m.snarePermPool.length > 0) explicitVoices.push("S");
      if (Array.isArray(m.bassPermPool) && m.bassPermPool.length > 0) explicitVoices.push("B");
      if (Array.isArray(m.ghostPermIds) && m.ghostPermIds.length > 0) explicitVoices.push("G");
      if (Array.isArray(m.hhClosedPermIds) && m.hhClosedPermIds.length > 0) explicitVoices.push("O");
      if (Array.isArray(m.hhOpenPermPool) && m.hhOpenPermPool.length > 0) explicitVoices.push("HH");

      const baseVoices = (measureRotateVoices[i]?.length > 0)
        ? measureRotateVoices[i]
        : (measureVoice[i]?.length ? measureVoice[i] : [] as VoiceBtnId[]);
      const voicesToRotate = [...new Set([...baseVoices, ...explicitVoices])];

      const pools: VoicePool[] = [];
      for (const voice of voicesToRotate) {
        const explicitIds = getExplicitPool(m, voice);
        // Only permute voices with explicit pools — without one, the voice
        // keeps its current pattern unchanged across permutations.
        if (!explicitIds || explicitIds.length === 0) continue;
        const pool = explicitIds.map(id => ps.find(p => p.id === id)).filter((p): p is Permutation => !!p);
        if (pool.length > 0) pools.push({ voice, pool });
      }

      // Ghost doubles: merge into same axis as ghost hits (additive, not multiplicative).
      // Each double entry becomes its own permutation alongside the ghost entries.
      if (Array.isArray(m.ghostDoublePermIds) && m.ghostDoublePermIds.length > 0) {
        const dblPool = m.ghostDoublePermIds
          .map(id => ps.find(p => p.id === id))
          .filter((p): p is Permutation => !!p);
        if (dblPool.length > 0) {
          // Find the ghost pool we already pushed and merge doubles into it
          const ghostAxis = pools.find(p => p.voice === "G");
          if (ghostAxis) {
            // Tag double perms so withVoicePerm can route them correctly
            for (const dp of dblPool) ghostAxis.pool.push({ ...dp, id: `dbl:${dp.id}` });
          } else {
            // No ghost hits selected — doubles stand alone as ghost-double axis
            pools.push({ voice: "G-dbl", pool: dblPool });
          }
        }
      }

      // Ostinato opens as independent axis
      if (Array.isArray(m.ostinatoOpenPermIds) && m.ostinatoOpenPermIds.length > 0) {
        const openPool = m.ostinatoOpenPermIds
          .map(id => ps.find(p => p.id === id))
          .filter((p): p is Permutation => !!p);
        if (openPool.length > 0) pools.push({ voice: "O-open", pool: openPool });
      }

      return pools;
    });

    // ── Universal axes: each entry is one shared rotation across ALL measures ──
    // Build axes from `universalPools`. Each axis is { voice, pool: Permutation[] }
    // and is treated as a SINGLE shared variation — index N = all measures get
    // pool[N] for that voice simultaneously.
    type UniversalAxis = { voice: VoiceBtnId; pool: Permutation[] };
    const universalAxes: UniversalAxis[] = [];
    for (const v of ["S", "B", "O", "G", "HH"] as VoiceBtnId[]) {
      const ids = universalPools[v];
      if (!ids || ids.length === 0) continue;
      const pool = ids.map(id => ps.find(p => p.id === id)).filter((p): p is Permutation => !!p);
      if (pool.length > 0) universalAxes.push({ voice: v, pool });
    }
    const universalCartesianSize = universalAxes.reduce((prod, ax) => prod * ax.pool.length, 1);
    const universalVoiceSet = new Set(universalAxes.map(a => a.voice));

    // Cartesian product size per measure = product of voice pool sizes,
    // EXCLUDING voices that are owned by the universal axis.
    const measureCartesianSize = measureVoicePools.map(pools =>
      pools.reduce((prod, vp) => universalVoiceSet.has(vp.voice as VoiceBtnId) ? prod : prod * vp.pool.length, 1),
    );
    const perMeasureTotal = measureCartesianSize.reduce((prod, sz) => prod * sz, 1);
    const totalCombinations = universalCartesianSize * perMeasureTotal;
    if (totalCombinations < 1) return;

    // Do NOT modify the original measures — keep them exactly as the user built them.
    const fixedOrigMeasures = origMeasures;

    // Generate all permutation copies (original phrase stays untouched)
    const allNewMeasures: DrumMeasure[] = [];
    const breaks: number[] = [];

    for (let step = 0; step < totalCombinations; step++) {
      if (step > 0) breaks.push(step * origLen);

      // Decompose: outer = universal indices, inner = per-measure indices.
      // Universal changes slowest (outermost), per-measure inner changes fastest.
      let rem = step;
      const measureSteps: number[] = new Array(origLen);
      for (let i = origLen - 1; i >= 0; i--) {
        measureSteps[i] = rem % measureCartesianSize[i];
        rem = Math.floor(rem / measureCartesianSize[i]);
      }
      const universalIndices: number[] = new Array(universalAxes.length);
      for (let u = universalAxes.length - 1; u >= 0; u--) {
        universalIndices[u] = rem % universalAxes[u].pool.length;
        rem = Math.floor(rem / universalAxes[u].pool.length);
      }

      const phraseCopy: DrumMeasure[] = fixedOrigMeasures.map((m, i) => {
        if (m.rotationLocked) return { ...m, rotationLocked: true };

        const mode = measureMode[i] ?? "seq";
        const allPools = measureVoicePools[i];
        // Per-measure pools EXCLUDING universal voices (those are handled separately)
        const pools = allPools.filter(vp => !universalVoiceSet.has(vp.voice as VoiceBtnId));

        let next = { ...m };

        // 1. Apply universal axis values — same perm for this voice on every measure
        for (let u = 0; u < universalAxes.length; u++) {
          const { voice, pool } = universalAxes[u];
          const permId = pool[universalIndices[u]].id;
          next = withVoicePerm(next, voice, permId);
        }

        if (pools.length === 0) {
          next.rotationLocked = true;
          return next;
        }

        // Decompose this measure's step into per-voice indices via div/mod (Cartesian product)
        // First voice = outermost (slowest changing), last voice = innermost (fastest changing)
        const measureStep = measureSteps[i];
        let remainder = measureStep;
        const voiceIndices: number[] = new Array(pools.length);
        for (let v = pools.length - 1; v >= 0; v--) {
          const sz = pools[v].pool.length;
          voiceIndices[v] = remainder % sz;
          remainder = Math.floor(remainder / sz);
        }

        for (let v = 0; v < pools.length; v++) {
          const { voice, pool: effectivePool } = pools[v];
          const idx = voiceIndices[v];

          let curPermId: string;
          if (mode === "rnd") {
            curPermId = effectivePool[Math.floor(Math.random() * effectivePool.length)].id;
          } else if (mode === "custom") {
            const seq = getCustomSeq(measureOrder[i] ?? {}, ps);
            if (seq.length === 0) {
              curPermId = getVoicePermId(m, voice) ?? ps[0]?.id ?? "";
            } else {
              curPermId = seq[idx % seq.length];
            }
          } else {
            // sequential — direct index into pool
            curPermId = effectivePool[idx].id;
          }
          // Handle merged ghost+double axis: dbl:-prefixed IDs go to G-dbl voice
          if (voice === "G" && curPermId.startsWith("dbl:")) {
            const realId = curPermId.slice(4);
            next = withVoicePerm(next, "G-dbl", realId);
            // Clear the normal ghost perm so only the double plays
            next = withVoicePerm(next, "G", "");
          } else if (voice === "G") {
            next = withVoicePerm(next, "G", curPermId);
            // Clear ghost-double so only the normal ghost plays
            next = withVoicePerm(next, "G-dbl", "");
          } else {
            next = withVoicePerm(next, voice, curPermId);
          }
        }

        next.rotationLocked = true;
        return next;
      });

      allNewMeasures.push(...phraseCopy);
    }

    setMeasures([...fixedOrigMeasures, ...allNewMeasures]);
    setPhraseBreaks(breaks);
    setPermOriginalCount(origLen);
    setSelectedIdx(null);
  }, [measures, permOriginalCount, grid, measureMode, measureLimit, measureOrder, measureVoice, measureRotateVoices, universalPools]);

  const handleClear = () => {
    setWOPermId(null);
    setWSPermId(null);
    setWBPermId(null);
    setWHPermId(null);
    setWGPermId(null);
    const bs = GRID_SUBDIVS[grid] / 4;
    setWOOpenSlots(Array(bs).fill(false));
    setWHOpenSlots(Array(bs).fill(false));
    setWGDoubleSlots(Array(bs).fill(false));
    setSelectedIdx(null);
  };

  // ── Playback handlers ──────────────────────────────────────────────────

  const stopPlay = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setIsPlaying(false);
    setActiveBeat(null);
    setCountdownLeft(null);
  }, []);

  const startPlay = useCallback(async () => {
    if (measuresRef.current.length === 0) return;
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }

    // Auto-start universal metronome if it isn't running
    if (!metronomeRunning && startMetronome) {
      try { await startMetronome(); } catch { /* ignore */ }
    }

    // Initialise local AudioContext for click sounds
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new AudioContext();
      }
      if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume();
    } catch { /* ignore if Web Audio unavailable */ }

    const countStart = 4; // always 4-beat count-in, independent of time signature
    pbRef.current = { beatIdx: 0, phraseCount: 0, isCountdown: true, countdownBeat: countStart };

    setIsPlaying(true);
    setCountdownLeft(countStart);
    setActiveBeat(null);

    const beatMs = Math.round(60000 / metronomeBpm);

    // beatPulseIdx counts playback beats (0-based), for per-beat accent lookup
    let beatPulseIdx = 0;

    const fireClick = (mode: "countdown" | "accent" | "normal" | "silent") => {
      if (mode === "silent") return;
      try {
        const ctx = audioCtxRef.current;
        if (!ctx) return;
        if (ctx.state === "suspended") ctx.resume();
        const t   = ctx.currentTime;
        const osc = ctx.createOscillator();
        const g   = ctx.createGain();
        osc.connect(g);
        g.connect(ctx.destination);
        osc.frequency.value = mode === "countdown" || mode === "accent" ? 1100 : 880;
        g.gain.setValueAtTime(mode === "countdown" || mode === "accent" ? 0.42 : 0.22, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        osc.start(t);
        osc.stop(t + 0.05);
      } catch { /* ignore */ }
    };

    intervalRef.current = setInterval(() => {
      const pb = pbRef.current;
      const ms = measuresRef.current;
      const ra = rotAmtRef.current;
      const ab = accentBeatsRef.current;

      if (pb.isCountdown) {
        pb.countdownBeat -= 1;
        fireClick("countdown");
        if (pb.countdownBeat <= 0) {
          pb.isCountdown = false;
          setCountdownLeft(null);
          // Show measure 0 and fire its first beat immediately
          setActiveBeat(0);
          const beatMode = ab[beatPulseIdx % ab.length] ?? "normal";
          fireClick(beatMode);
          beatPulseIdx += 1;
          // Advance to next measure right away (1-beat-per-bar: each interval tick = one measure)
          pb.beatIdx = (pb.beatIdx + 1) % ms.length;
          if (pb.beatIdx === 0) {
            pb.phraseCount += 1;
          }
        } else {
          setCountdownLeft(pb.countdownBeat);
        }
      } else {
        if (ms.length === 0) return;
        // 1-beat-per-bar: show current measure and advance on every tick
        setActiveBeat(pb.beatIdx);
        const beatMode = ab[beatPulseIdx % ab.length] ?? "normal";
        fireClick(beatMode);
        beatPulseIdx += 1;
        pb.beatIdx = (pb.beatIdx + 1) % ms.length;
        // Phrase wrap: all measures completed one pass
        if (pb.beatIdx === 0) {
          pb.phraseCount += 1;
          // ── Auto-rotate permutations every N complete phrases ────────
          const shouldRotate = ra > 0 && pb.phraseCount % ra === 0;
          if (shouldRotate) {
            const mv  = measureVoiceRef.current;
            const mm  = measureModeRef.current;
            const ml  = measureLimitRef.current;
            const mo  = measureOrderRef.current;
            const mrv = measureRotateVoicesRef.current;
            const mgd = measureGhostDoubleRef.current;
            const gr  = gridRef.current;
            setMeasures(prev => prev.map((m, i) => {
              if (m.rotationLocked) return m;
              const defaultVoices: VoiceBtnId[] = mv[i]?.length ? mv[i] : ["S"];
              const voicesToRotate: VoiceBtnId[] = (mrv[i] && mrv[i].length > 0) ? mrv[i] : defaultVoices;
              const mode = mm[i] ?? "seq";
              const ps   = getPerms(gr);
              if (ps.length === 0) return m;
              const rl   = ml[i] ?? 0;
              const pool = rl > 0 ? ps.slice(0, Math.min(rl, ps.length)) : ps;

              const stepPerm = (cur: string | undefined | null): string => {
                if (mode === "rnd") return pool[Math.floor(Math.random() * pool.length)].id;
                if (mode === "custom") {
                  const seq = getCustomSeq(mo[i] ?? {}, ps);
                  if (seq.length === 0) return cur ?? ps[0]?.id ?? "";
                  const j = seq.findIndex(id => id === (cur ?? ""));
                  return seq[(j + 1) % seq.length];
                }
                const j = pool.findIndex(p => p.id === (cur ?? ""));
                return pool[(j + 1) % pool.length].id;
              };

              let next = { ...m };
              if (voicesToRotate.includes("S"))  next = { ...next, snarePermId:    stepPerm(m.snarePermId)    };
              if (voicesToRotate.includes("B"))  next = { ...next, bassPermId:     stepPerm(m.bassPermId)     };
              if (voicesToRotate.includes("O"))  next = { ...next, hhClosedPermId: stepPerm(m.hhClosedPermId) };
              if (voicesToRotate.includes("G"))  next = { ...next, ghostPermId:    stepPerm(m.ghostPermId)    };
              if (voicesToRotate.includes("HH")) next = { ...next, hhOpenPermId:   stepPerm(m.hhOpenPermId)   };

              if (mgd[i]) {
                const bs = GRID_SUBDIVS[gr] / 4;
                next = { ...next, ghostDoubleSlots: Array(bs).fill(true) };
              }

              return next;
            }));
          }
        }
      }
    }, beatMs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metronomeBpm]);

  // ── Per-measure voice-select + back/forward ────────────────────────────

  const handleVoiceSelect = useCallback((idx: number, v: VoiceBtnId) => {
    setMeasureVoice(prev => {
      const cur = prev[idx] ?? [];
      const next = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v];
      // Close panel when no voices selected
      if (next.length === 0) {
        setOpenPanels(p => { const n = new Set(p); n.delete(idx); return n; });
      } else {
        setOpenPanels(p => new Set(p).add(idx));
      }
      return { ...prev, [idx]: next };
    });
  }, []);

  const handleModeChange = useCallback((idx: number, mode: "seq" | "rnd" | "custom") => {
    setMeasureMode(prev => ({ ...prev, [idx]: mode }));
  }, []);

  const handleOrderChange = useCallback((idx: number, permId: string, pos: number) => {
    setMeasureOrder(prev => ({
      ...prev,
      [idx]: { ...(prev[idx] ?? {}), [permId]: pos },
    }));
  }, []);

  const handleLimitChange = useCallback((idx: number, limit: number) => {
    setMeasureLimit(prev => ({ ...prev, [idx]: limit }));
  }, []);

  const handleRotateVoiceToggle = useCallback((idx: number, v: VoiceBtnId) => {
    setMeasureRotateVoices(prev => {
      const cur = prev[idx] ?? [];
      const next = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v];
      return { ...prev, [idx]: next };
    });
  }, []);

  const handleSimplePermSelect = useCallback((idx: number, voice: VoiceBtnId, permId: string) => {
    setMeasures(prev => prev.map((m, i) =>
      i === idx ? withVoicePerm(m, voice, permId) : m
    ));
  }, []);

  /** Universal pool toggle: add/remove `permId` from `voice`'s shared universal
   *  pool. Does NOT touch per-measure pools. The Permutate function treats
   *  this pool as one shared axis — each entry creates one variation where
   *  ALL measures use that perm for `voice` simultaneously. */
  const handleUniversalPoolToggle = useCallback((voice: VoiceBtnId, permId: string) => {
    setUniversalPools(prev => {
      const cur = prev[voice] ?? [];
      const has = cur.includes(permId);
      const next = has ? cur.filter(id => id !== permId) : [...cur, permId];
      return { ...prev, [voice]: next };
    });
  }, []);

  const handleSimpleOpenToggle = useCallback((idx: number, voice: VoiceBtnId, slot: number) => {
    setMeasures(prev => prev.map((m, i) => {
      if (i !== idx) return m;
      const bs = GRID_SUBDIVS[grid] / 4;
      if (voice === "O") {
        const slots = [...(m.ostinatoOpenSlots ?? Array(bs).fill(false))];
        while (slots.length <= slot) slots.push(false);
        slots[slot] = !slots[slot];
        return { ...m, ostinatoOpenSlots: slots.some(Boolean) ? slots : undefined };
      }
      if (voice === "HH") {
        const slots = [...(m.hhFootOpenSlots ?? Array(bs).fill(false))];
        while (slots.length <= slot) slots.push(false);
        slots[slot] = !slots[slot];
        return { ...m, hhFootOpenSlots: slots.some(Boolean) ? slots : undefined };
      }
      return m;
    }));
  }, [grid]);

  const handleSimpleDoubleToggle = useCallback((idx: number, voice: VoiceBtnId, slot: number) => {
    setMeasures(prev => prev.map((m, i) => {
      if (i !== idx) return m;
      const bs = GRID_SUBDIVS[grid] / 4;
      if (voice === "G") {
        const slots = [...(m.ghostDoubleSlots ?? Array(bs).fill(false))];
        while (slots.length <= slot) slots.push(false);
        slots[slot] = !slots[slot];
        return { ...m, ghostDoubleSlots: slots.some(Boolean) ? slots : undefined };
      }
      if (voice === "S") {
        const slots = [...(m.snareDoubleSlots ?? Array(bs).fill(false))];
        while (slots.length <= slot) slots.push(false);
        slots[slot] = !slots[slot];
        return { ...m, snareDoubleSlots: slots.some(Boolean) ? slots : undefined };
      }
      if (voice === "B") {
        const slots = [...(m.bassDoubleSlots ?? Array(bs).fill(false))];
        while (slots.length <= slot) slots.push(false);
        slots[slot] = !slots[slot];
        return { ...m, bassDoubleSlots: slots.some(Boolean) ? slots : undefined };
      }
      if (voice === "O") {
        const slots = [...(m.ostinatoDoubleSlots ?? Array(bs).fill(false))];
        while (slots.length <= slot) slots.push(false);
        slots[slot] = !slots[slot];
        return { ...m, ostinatoDoubleSlots: slots.some(Boolean) ? slots : undefined };
      }
      if (voice === "HH") {
        const slots = [...(m.hhFootDoubleSlots ?? Array(bs).fill(false))];
        while (slots.length <= slot) slots.push(false);
        slots[slot] = !slots[slot];
        return { ...m, hhFootDoubleSlots: slots.some(Boolean) ? slots : undefined };
      }
      return m;
    }));
  }, [grid]);

  const handleGhostDoubleToggle = useCallback((idx: number) => {
    setMeasureGhostDouble(prev => ({ ...prev, [idx]: !prev[idx] }));
  }, []);

  const handleLockToggle = useCallback((idx: number) => {
    setMeasures(prev => prev.map((m, i) =>
      i === idx ? { ...m, rotationLocked: !m.rotationLocked } : m
    ));
  }, []);

  const handleAccentToggle = useCallback((idx: number, slot: number) => {
    setMeasures(prev => {
      const beatSize = GRID_SUBDIVS[grid] / 4;
      const origLen = permOriginalCount ?? prev.length;
      // Build new accent array for the toggled measure
      const base = prev[idx];
      const newSlots = base.accentSlots ? [...base.accentSlots] : Array(beatSize).fill(false);
      while (newSlots.length < beatSize) newSlots.push(false);
      newSlots[slot] = !newSlots[slot];

      return prev.map((m, i) => {
        if (i === idx) return { ...m, accentSlots: newSlots };
        // Propagate: if toggling a source measure, update all its permutation copies
        if (permOriginalCount != null && idx < origLen) {
          const sourceIdx = idx;
          if (i >= origLen && (i - origLen) % origLen === sourceIdx) {
            return { ...m, accentSlots: [...newSlots] };
          }
        }
        return m;
      });
    });
  }, [grid, permOriginalCount]);

  const handleGhostDoublePermSelect = useCallback((idx: number, permId: string) => {
    setMeasures(prev => prev.map((m, i) =>
      i === idx ? { ...m, ghostDoublePermId: permId || undefined } : m
    ));
  }, []);

  const handleOstinatoOpenPermSelect = useCallback((idx: number, permId: string) => {
    setMeasures(prev => prev.map((m, i) =>
      i === idx ? { ...m, ostinatoOpenPermId: permId || undefined } : m
    ));
  }, []);

  // Pool toggles — multi-select for permutation generation (all voices)
  const handleTogglePool = useCallback((idx: number, voice: VoiceBtnId, permId: string) => {
    setMeasures(prev => prev.map((m, i) => {
      if (i !== idx) return m;
      const toggle = (cur: string[] | undefined): { list: string[] | undefined; added: boolean } => {
        const arr = Array.isArray(cur) ? [...cur] : [];
        const removing = arr.includes(permId);
        const next = removing ? arr.filter(id => id !== permId) : [...arr, permId];
        return { list: next.length ? next : undefined, added: !removing };
      };
      let poolField: Partial<DrumMeasure> = {};
      switch (voice) {
        case "S":  { const r = toggle(m.snarePermPool); poolField = { snarePermPool: r.list }; break; }
        case "B":  { const r = toggle(m.bassPermPool);  poolField = { bassPermPool: r.list };  break; }
        case "G":  { const r = toggle(m.ghostPermIds);  poolField = { ghostPermIds: r.list };  break; }
        case "O":  { const r = toggle(m.hhClosedPermIds); poolField = { hhClosedPermIds: r.list }; break; }
        case "HH": { const r = toggle(m.hhOpenPermPool); poolField = { hhOpenPermPool: r.list }; break; }
        default:   return m;
      }
      // Only update the pool list — do NOT change the original measure's active perm
      return { ...m, ...poolField };
    }));
  }, []);

  const handleToggleSecondPool = useCallback((idx: number, voice: VoiceBtnId, permId: string) => {
    setMeasures(prev => prev.map((m, i) => {
      if (i !== idx) return m;
      if (voice === "G") {
        const cur = Array.isArray(m.ghostDoublePermIds) ? [...m.ghostDoublePermIds] : [];
        const next = cur.includes(permId) ? cur.filter(id => id !== permId) : [...cur, permId];
        // Only update the pool — do NOT change the original measure's active double perm
        return { ...m, ghostDoublePermIds: next.length ? next : undefined };
      }
      if (voice === "O") {
        const cur = Array.isArray(m.ostinatoOpenPermIds) ? [...m.ostinatoOpenPermIds] : [];
        const next = cur.includes(permId) ? cur.filter(id => id !== permId) : [...cur, permId];
        // Only update the pool — do NOT change the original measure's active open perm
        return { ...m, ostinatoOpenPermIds: next.length ? next : undefined };
      }
      return m;
    }));
  }, []);

  const handleSetPool = useCallback((idx: number, voice: VoiceBtnId, permIds: string[]) => {
    setMeasures(prev => prev.map((m, i) => {
      if (i !== idx) return m;
      const val = permIds.length ? permIds : undefined;
      switch (voice) {
        case "S":  return { ...m, snarePermPool: val };
        case "B":  return { ...m, bassPermPool: val };
        case "G":  return { ...m, ghostPermIds: val };
        case "O":  return { ...m, hhClosedPermIds: val };
        case "HH": return { ...m, hhOpenPermPool: val };
        default:   return m;
      }
    }));
  }, []);

  const handleSetSecondPool = useCallback((idx: number, voice: VoiceBtnId, permIds: string[]) => {
    setMeasures(prev => prev.map((m, i) => {
      if (i !== idx) return m;
      const val = permIds.length ? permIds : undefined;
      if (voice === "G") return { ...m, ghostDoublePermIds: val };
      if (voice === "O") return { ...m, ostinatoOpenPermIds: val };
      return m;
    }));
  }, []);

  const handleMeasureNav = useCallback((measureIdx: number, dir: "back" | "fwd") => {
    setMeasures(prev => prev.map((m, i) => {
      if (i !== measureIdx) return m;
      const ps = getPerms(grid);
      if (ps.length === 0) return m;
      const voices = measureVoice[measureIdx]?.length ? measureVoice[measureIdx] : ["S"] as VoiceBtnId[];
      const mode  = measureMode[measureIdx] ?? "seq";
      const rl    = measureLimit[measureIdx] ?? 0;
      const pool  = rl > 0 ? ps.slice(0, Math.min(rl, ps.length)) : ps;

      const step = (cur: string | undefined | null): string => {
        if (mode === "custom") {
          const seq = getCustomSeq(measureOrder[measureIdx] ?? {}, ps);
          if (seq.length === 0) return cur ?? ps[0]?.id ?? "";
          const j = seq.findIndex(id => id === (cur ?? ""));
          if (dir === "fwd") return seq[(j + 1) % seq.length];
          return seq[(j - 1 + seq.length) % seq.length];
        }
        if (mode === "rnd") return pool[Math.floor(Math.random() * pool.length)].id;
        const j = pool.findIndex(p => p.id === (cur ?? ""));
        if (dir === "fwd") return pool[(j + 1) % pool.length].id;
        return pool[(j - 1 + pool.length) % pool.length].id;
      };

      let next = { ...m };
      for (const voice of voices) {
        switch (voice) {
          case "S":  next = { ...next, snarePermId:    step(next.snarePermId) }; break;
          case "B":  next = { ...next, bassPermId:     step(next.bassPermId) }; break;
          case "O":  next = { ...next, hhClosedPermId: step(next.hhClosedPermId) }; break;
          case "G":  next = { ...next, ghostPermId:    step(next.ghostPermId) }; break;
          case "HH": next = { ...next, hhOpenPermId:   step(next.hhOpenPermId) }; break;
        }
      }
      return next;
    }));
  }, [grid, measureVoice, measureMode, measureLimit, measureOrder]);

  const handleSelectFromStrip = (idx: number) => {
    if (selectedIdx === idx) {
      setSelectedIdx(null);
      setOpenPanels(prev => { const next = new Set(prev); next.delete(idx); return next; });
      return;
    }
    const m = measures[idx];
    setSelectedIdx(idx);
    setOpenPanels(prev => { const next = new Set(prev); next.add(idx); return next; });
    setWOPermId(m.hhClosedPermId ?? null);
    setWSPermId(m.snarePermId || null);
    setWBPermId(m.bassPermId || null);
    setWHPermId(m.hhOpenPermId ?? null);
    setWGPermId(m.ghostPermId ?? null);
    const bs = GRID_SUBDIVS[grid] / 4;
    setWOOpenSlots(m.ostinatoOpenSlots ?? Array(bs).fill(false));
    setWHOpenSlots(m.hhFootOpenSlots ?? Array(bs).fill(false));
    setWGDoubleSlots(m.ghostDoubleSlots ?? Array(bs).fill(false));
  };


  // ── Accent study handlers ──────────────────────────────────────────────
  const handleAccentSelectFromStrip = (idx: number) => {
    if (accentSelectedIdx === idx) { setAccentSelectedIdx(null); return; }
    setAccentSelectedIdx(idx);
  };

  const handleAccentDeleteSelected = () => {
    if (accentSelectedIdx === null) return;
    setAccentMeasures(prev => prev.filter((_, i) => i !== accentSelectedIdx));
    setAccentSelectedIdx(null);
  };

  // ── Stickings study handlers ──────────────────────────────────────────
  const handleStickingSelectFromStrip = (idx: number) => {
    if (stickingSelectedIdx === idx) { setStickingSelectedIdx(null); return; }
    setStickingSelectedIdx(idx);
  };

  const handleStickingDeleteSelected = () => {
    if (stickingSelectedIdx === null) return;
    setStickingMeasures(prev => prev.filter((_, i) => i !== stickingSelectedIdx));
    setStickingSelectedIdx(null);
  };

  // ── Transform import helpers ─────────────────────────────────────────────

  const importToTransform = useCallback((sourceTab: string, patterns: TransformPattern[]) => {
    setTransformSource(patterns);
    setTransformSourceTab(sourceTab);
    setMode("transform");
  }, []);

  const importIndependenceToTransform = useCallback(() => {
    if (independenceMeasures.length === 0) return;
    const measures = independenceSelectedIdx !== null ? [independenceMeasures[independenceSelectedIdx]] : independenceMeasures;
    const patterns: TransformPattern[] = measures.map(m => ({
      grid: m.grid as GridType,
      totalSlots: GRID_SUBDIVS[m.grid],
      beatSize: GRID_SUBDIVS[m.grid] / 4,
      cymbalHits: [...m.cymbalHits],
      cymbalOpen: [...m.cymbalOpen],
      snareHits: [...m.snareHits],
      bassHits: [...m.bassHits],
      hhFootHits: [...m.hhFootHits],
      ghostHits: [...m.ghostHits],
      tomHits: [],
      crashHits: [],
      accentFlags: [...m.snareAccents],
      stickings: new Array(GRID_SUBDIVS[m.grid]).fill(""),
      sourceTab: "independence" as const,
    }));
    importToTransform("independence", patterns);
  }, [independenceMeasures, independenceSelectedIdx, importToTransform]);

  const importAccentToTransform = useCallback(() => {
    if (accentMeasures.length === 0) return;
    const measures = accentSelectedIdx !== null ? [accentMeasures[accentSelectedIdx]] : accentMeasures;
    const patterns: TransformPattern[] = measures.map(m => {
      const slots = m.displaySlots ?? m.stickings.length ?? 16;
      return {
        grid: "16th" as GridType,
        totalSlots: slots,
        beatSize: Math.max(1, Math.floor(slots / 4)),
        cymbalHits: [],
        cymbalOpen: [],
        snareHits: [...m.snareHits],
        bassHits: [...m.bassHits],
        hhFootHits: [],
        ghostHits: [...m.ghostHits],
        tomHits: [...(m.tomHits ?? [])],
        crashHits: [...(m.crashHits ?? [])],
        accentFlags: [...m.accentFlags],
        stickings: [...m.stickings],
        sourceTab: "accent" as const,
      };
    });
    importToTransform("accent", patterns);
  }, [accentMeasures, accentSelectedIdx, importToTransform]);

  const importStickingsToTransform = useCallback(() => {
    if (stickingMeasures.length === 0) return;
    const measures = stickingSelectedIdx !== null ? [stickingMeasures[stickingSelectedIdx]] : stickingMeasures;
    const patterns: TransformPattern[] = measures.map(m => {
      const slots = m.totalSlots ?? m.stickings.length ?? 16;
      return {
        grid: "16th" as GridType,
        totalSlots: slots,
        beatSize: Math.max(1, Math.floor(slots / 4)),
        cymbalHits: [],
        cymbalOpen: [],
        snareHits: [...m.snareHits],
        bassHits: [...m.bassHits],
        hhFootHits: [],
        ghostHits: [],
        tomHits: [],
        crashHits: [],
        accentFlags: [...m.accentFlags],
        stickings: [...m.stickings],
        sourceTab: "stickings" as const,
      };
    });
    importToTransform("stickings", patterns);
  }, [stickingMeasures, stickingSelectedIdx, importToTransform]);

  const importOstinatoToTransform = useCallback(() => {
    if (measures.length === 0) return;
    const selected = selectedIdx !== null ? [measures[selectedIdx]] : measures;
    const patterns: TransformPattern[] = selected.map(m => {
      const resolved = resolveMeasureHits(m, grid);
      return {
        grid: grid as GridType,
        totalSlots: GRID_SUBDIVS[grid],
        beatSize: GRID_SUBDIVS[grid] / 4,
        cymbalHits: [...resolved.oHits],
        cymbalOpen: [...resolved.oOpen],
        snareHits: [...resolved.sHits],
        bassHits: [...resolved.bHits],
        hhFootHits: [...resolved.hHits],
        ghostHits: [...resolved.gHits],
        tomHits: [],
        crashHits: [],
        accentFlags: m.accentSlots ? [...m.accentSlots] : new Array(GRID_SUBDIVS[grid]).fill(false),
        stickings: new Array(GRID_SUBDIVS[grid]).fill(""),
        sourceTab: "ostinato" as const,
      };
    });
    importToTransform("ostinato", patterns);
  }, [measures, selectedIdx, grid, importToTransform]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0c0c0c", overflowY: "auto", overflowX: "hidden", maxWidth: 1152, margin: "0 auto", width: "100%" }}>

      {/* ══ MODE TABS ═════════════════════════════════════════════════════ */}
      <div style={{
        display: "flex", alignItems: "center", gap: 0,
        borderBottom: "1px solid #181818", flexShrink: 0,
      }}>
        <button onClick={() => setMode("ostinato")}
          style={{
            padding: "8px 16px", fontSize: 10, fontWeight: 700, letterSpacing: 3,
            textTransform: "uppercase", cursor: "pointer",
            border: "none", borderBottom: mode === "ostinato" ? "2px solid #7173e6" : "2px solid transparent",
            background: mode === "ostinato" ? "#0e0e14" : "transparent",
            color: mode === "ostinato" ? "#9999ee" : "#3a3a3a",
          }}>
          Fine Ostinatos
        </button>
        <button onClick={() => setMode("accent")}
          style={{
            padding: "8px 16px", fontSize: 10, fontWeight: 700, letterSpacing: 3,
            textTransform: "uppercase", cursor: "pointer",
            border: "none", borderBottom: mode === "accent" ? "2px solid #c8aa50" : "2px solid transparent",
            background: mode === "accent" ? "#0e0e08" : "transparent",
            color: mode === "accent" ? "#c8aa50" : "#3a3a3a",
          }}>
          Accent Study
        </button>
        <button onClick={() => setMode("stickings")}
          style={{
            padding: "8px 16px", fontSize: 10, fontWeight: 700, letterSpacing: 3,
            textTransform: "uppercase", cursor: "pointer",
            border: "none", borderBottom: mode === "stickings" ? "2px solid #60b0e0" : "2px solid transparent",
            background: mode === "stickings" ? "#0a0e14" : "transparent",
            color: mode === "stickings" ? "#60b0e0" : "#3a3a3a",
          }}>
          Stickings
        </button>
        <button onClick={() => setMode("independence")}
          style={{
            padding: "8px 16px", fontSize: 10, fontWeight: 700, letterSpacing: 3,
            textTransform: "uppercase", cursor: "pointer",
            border: "none", borderBottom: mode === "independence" ? "2px solid #50b080" : "2px solid transparent",
            background: mode === "independence" ? "#0a140e" : "transparent",
            color: mode === "independence" ? "#50b080" : "#3a3a3a",
          }}>
          Independence
        </button>
        {betaTransform && (
        <button onClick={() => setMode("transform")}
          style={{
            padding: "8px 16px", fontSize: 10, fontWeight: 700, letterSpacing: 3,
            textTransform: "uppercase", cursor: "pointer",
            border: "none", borderBottom: mode === "transform" ? "2px solid #c090e0" : "2px solid transparent",
            background: mode === "transform" ? "#0e0a14" : "transparent",
            color: mode === "transform" ? "#c090e0" : "#3a3a3a",
          }}>
          Transform
        </button>
        )}
        <button onClick={() => setMode("interplay")}
          style={{
            padding: "8px 16px", fontSize: 10, fontWeight: 700, letterSpacing: 3,
            textTransform: "uppercase", cursor: "pointer",
            border: "none", borderBottom: mode === "interplay" ? "2px solid #e06070" : "2px solid transparent",
            background: mode === "interplay" ? "#14080a" : "transparent",
            color: mode === "interplay" ? "#e06070" : "#3a3a3a",
          }}>
          Pattern Ostinatos
        </button>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, paddingRight: 8 }}>
          <button
            onClick={() => setShowExport(true)}
            style={{
              padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700,
              border: "1px solid #3a3a7a", background: "#1e1e3a", color: "#9a9cf8",
              cursor: "pointer", letterSpacing: 0.5,
            }}
          >↓ Export</button>
          <PracticeLogSaveBar
            mode={mode === "ostinato" ? "drum-ostinato" : mode === "accent" ? "accent-study" : mode === "independence" ? "independence-study" : mode === "transform" ? "drum-ostinato" : "stickings-study"}
            label={mode === "ostinato" ? "Drum Patterns · Ostinato" : mode === "accent" ? "Drum Patterns · Accent Study" : mode === "independence" ? "Drum Patterns · Independence" : mode === "transform" ? "Drum Patterns · Transform" : "Drum Patterns · Stickings"}
            hideRatingAndLog={mode === "accent" || mode === "stickings" || mode === "independence" || mode === "transform"}
            sourceOptions={[
              { value: "drum-ostinato",       label: "Ostinato" },
              { value: "accent-study",        label: "Accent Study" },
              { value: "stickings-study",     label: "Stickings" },
              { value: "independence-study",  label: "Independence" },
            ]}
            tagOptions={[
              { value: "isolation", label: "Isolation", color: "#e0a040" },
              { value: "context",   label: "Context",   color: "#7aaa7a" },
            ]}
            defaultTag={practiceTag}
            onTagChange={setPracticeTag}
            getMultiSnapshots={() => {
              // In stickings mode, split measures by lineBreak into separate entries
              if (mode === "stickings" && stickingMeasures.length > 0) {
                const groups: StickingMeasureData[][] = [];
                let cur: StickingMeasureData[] = [];
                for (const m of stickingMeasures) {
                  if (m.lineBreak && cur.length > 0) { groups.push(cur); cur = []; }
                  cur.push(m);
                }
                if (cur.length > 0) groups.push(cur);
                if (groups.length <= 1) return null;
                return groups.map((g, gi) => ({
                  preview: `Line ${gi + 1}: ${g.length} measure${g.length !== 1 ? "s" : ""} · Stickings`,
                  snapshot: { measures: g },
                  canRestore: false,
                }));
              }
              // In independence mode, split measures by lineBreak
              if (mode === "independence" && independenceMeasures.length > 0) {
                const groups: IndependenceMeasureData[][] = [];
                let cur2: IndependenceMeasureData[] = [];
                for (const m of independenceMeasures) {
                  if (m.lineBreak && cur2.length > 0) { groups.push(cur2); cur2 = []; }
                  cur2.push(m);
                }
                if (cur2.length > 0) groups.push(cur2);
                if (groups.length <= 1) return null;
                return groups.map((g, gi) => ({
                  preview: `Line ${gi + 1}: ${g.length} measure${g.length !== 1 ? "s" : ""} · Independence`,
                  snapshot: { measures: g, grid: independenceGrid },
                  canRestore: false,
                }));
              }
              // In accent-study mode, split measures by lineBreak into separate entries
              if (mode !== "accent" || accentMeasures.length === 0) return null;
              const groups: AccentMeasureData[][] = [];
              let cur: AccentMeasureData[] = [];
              for (const m of accentMeasures) {
                if (m.lineBreak && cur.length > 0) {
                  groups.push(cur);
                  cur = [];
                }
                cur.push(m);
              }
              if (cur.length > 0) groups.push(cur);
              if (groups.length <= 1) return null;
              return groups.map((g, gi) => ({
                preview: `Line ${gi + 1}: ${g.length} measure${g.length !== 1 ? "s" : ""} · Grid: ${accentGrid}`,
                snapshot: { measures: g, grid: accentGrid },
                canRestore: true,
              }));
            }}
            getSnapshot={() => {
              const src = mode === "ostinato" ? "drum-ostinato" : mode === "accent" ? "accent-study" : mode === "independence" ? "independence-study" : "stickings-study";
              if (src === "independence-study") {
                const preview = independenceMeasures.length > 0
                  ? `${independenceMeasures.length} measure${independenceMeasures.length !== 1 ? "s" : ""} · Independence · ${independenceGrid}`
                  : "No measures built yet";
                return {
                  preview,
                  snapshot: { measures: independenceMeasures, grid: independenceGrid },
                  canRestore: false,
                };
              } else if (src === "stickings-study") {
                const preview = stickingMeasures.length > 0
                  ? `${stickingMeasures.length} measure${stickingMeasures.length !== 1 ? "s" : ""} · Stickings`
                  : "No measures built yet";
                return {
                  preview,
                  snapshot: { measures: stickingMeasures },
                  canRestore: false,
                };
              } else if (src === "drum-ostinato") {
                // Build pool summary for preview
                const ps = getPerms(grid);
                const poolSummary: string[] = [];
                const origMeasures = measures.slice(0, permOriginalCount ?? measures.length);
                for (let mi = 0; mi < origMeasures.length; mi++) {
                  const m = origMeasures[mi];
                  const voicePools: string[] = [];
                  const describePool = (label: string, ids: string[] | undefined) => {
                    if (!ids || ids.length === 0) return;
                    const names = ids.map(id => ps.find(p => p.id === id)?.label ?? id).join(", ");
                    voicePools.push(`${label}: ${names}`);
                  };
                  describePool("S", m.snarePermPool);
                  describePool("B", m.bassPermPool);
                  describePool("G", m.ghostPermIds);
                  describePool("G-dbl", m.ghostDoublePermIds);
                  describePool("O", m.hhClosedPermIds);
                  describePool("O-open", m.ostinatoOpenPermIds);
                  describePool("HH", m.hhOpenPermPool);
                  if (voicePools.length > 0) poolSummary.push(`M${mi + 1}: ${voicePools.join(" | ")}`);
                }
                const poolLine = poolSummary.length > 0 ? ` · Pools: ${poolSummary.join("; ")}` : "";
                const preview = measures.length > 0
                  ? `${measures.length} measure${measures.length !== 1 ? "s" : ""} · Grid: ${grid}${poolLine}`
                  : "No measures built yet";
                return {
                  preview,
                  snapshot: { measures, grid, permOriginalCount, universalPools },
                  canRestore: measures.length > 0,
                };
              } else {
                const preview = accentMeasures.length > 0
                  ? `${accentMeasures.length} measure${accentMeasures.length !== 1 ? "s" : ""} · Grid: ${accentGrid}`
                  : "No measures built yet";
                return {
                  preview,
                  snapshot: { measures: accentMeasures, grid: accentGrid },
                  canRestore: accentMeasures.length > 0,
                };
              }
            }}
            getCapture={async () => {
              // Prefer the composed strip (shows accents & all measures) over beat preview
              const targetRef = mode === "ostinato"
                ? (composedStripRef.current ? composedStripRef : beatPreviewRef)
                : accentStripRef;
              if (!targetRef.current) return undefined;
              const { captureElement } = await import("@/lib/captureUtil");
              return captureElement(targetRef.current, "#0c0c0c");
            }}
            style={{ paddingTop: 2, paddingBottom: 2 }}
          />
        </div>
      </div>

      {/* ══ OSTINATO TOP BAR (only in ostinato mode) ═════════════════════ */}
      {mode === "ostinato" && <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "8px 12px", borderBottom: "1px solid #181818", flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 4, color: "#666", textTransform: "uppercase", marginRight: 4 }}>
          Fine Ostinatos
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <label style={{ fontSize: 10, color: "#444" }}>Pulse</label>
          <select value={grid} onChange={e => setGrid(e.target.value as GridType)}
            style={{ background: "#141414", border: "1px solid #222", borderRadius: 4, padding: "2px 6px", fontSize: 10, color: "#ccc", outline: "none" }}>
            <option value="8th">2</option>
            <option value="triplet">3</option>
            <option value="16th">4</option>
            <option value="quintuplet">5</option>
            <option value="sextuplet">6</option>
            <option value="septuplet">7</option>
            <option value="32nd">8</option>
          </select>
        </div>
      </div>}

      {/* ══ SECTION 1: FOUR VOICE ROWS (ostinato mode) ═════════════════ */}
      {mode === "ostinato" && <div style={{ flexShrink: 0, borderBottom: "1px solid #181818" }}>
        <div style={{ padding: "4px 12px 2px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 9, color: "#2a2a2a", fontWeight: 700, letterSpacing: 4, textTransform: "uppercase" }}>
            Build Pattern
          </span>
          <span style={{ fontSize: 8, color: "#2a2a2a" }}>
            — select notes per voice, then click + Add Measure
          </span>
        </div>

        {VOICE_META.map(vm => {
          const voiceId = vm.id;
          const permId =
            voiceId === "O"  ? wOPermId :
            voiceId === "S"  ? wSPermId :
            voiceId === "B"  ? wBPermId :
                               wHPermId;
          // Toggle: clicking same perm deselects it
          const onAssign =
            voiceId === "O"  ? (id: string) => setWOPermId(wOPermId === id ? null : id) :
            voiceId === "S"  ? (id: string) => setWSPermId(wSPermId === id ? null : id) :
            voiceId === "B"  ? (id: string) => setWBPermId(wBPermId === id ? null : id) :
                               (id: string) => setWHPermId(wHPermId === id ? null : id);
          const count =
            voiceId === "O"  ? oCount :
            voiceId === "S"  ? sCount :
            voiceId === "B"  ? bCount :
                               hCount;
          const setCount =
            voiceId === "O"  ? setOCount :
            voiceId === "S"  ? setSCount :
            voiceId === "B"  ? setBCount :
                               setHCount;
          const openSlots =
            voiceId === "O"  ? wOOpenSlots :
            voiceId === "HH" ? wHOpenSlots :
                               [];
          const onToggleOpen =
            voiceId === "O"  ? (s: number) => toggleOpen("O",  s) :
            voiceId === "HH" ? (s: number) => toggleOpen("HH", s) :
                               (_: number) => {};

          return (
            <VoiceRow key={voiceId}
              voiceId={voiceId} label={vm.label} color={vm.color} hasOpen={vm.hasOpen}
              count={count} setCount={setCount}
              permId={permId}
              onAssign={onAssign}
              openSlots={openSlots}
              onToggleOpen={onToggleOpen}
              grid={grid}
            />
          );
        })}

        {/* Ghost voice row (max 2 notes, conflict-checked against snare) */}
        <VoiceRow
          voiceId="G" label="Ghost" color="#888888"
          hasOpen={false} hasDouble={true}
          count={gCount} setCount={setGCount}
          permId={wGPermId}
          onAssign={(id: string) => setWGPermId(wGPermId === id ? null : id)}
          openSlots={[]}
          onToggleOpen={(_: number) => {}}
          doubleSlots={wGDoubleSlots}
          onToggleDouble={toggleDouble}
          maxFamily={2}
          excludeSlots={snareExcludeSlots}
          grid={grid}
        />

      </div>}

      {/* ══ SECTION 2: BEAT PREVIEW (ostinato mode) ═════════════════ */}
      {mode === "ostinato" && <div style={{ flexShrink: 0, minHeight: 190, display: "flex", gap: 8, padding: "8px 12px", overflow: "hidden" }}>

        {/* VexFlow preview */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 9, color: "#333", fontWeight: 700, letterSpacing: 4, textTransform: "uppercase", marginBottom: 6 }}>
            Beat Preview
          </div>
          <div style={{
            flex: 1, minHeight: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <div ref={beatPreviewRef} style={{
              width: 360, height: 180,
              background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 8,
              overflow: "hidden", lineHeight: 0, flexShrink: 0,
            }}>
              <VexDrumNotation
                grid={grid}
                ostinatoHits={prevOHits} ostinatoOpen={prevOOpen}
                snareHits={prevSHits} bassHits={prevBHits}
                hhFootHits={prevHHits} hhFootOpen={prevHOpen}
                ghostHits={prevGHits} ghostDoubleHits={prevGDoubleHits}
                width={360} height={180}
                beatOnly={true}
                showClef={true}
              />
            </div>
          </div>
        </div>

        {/* Action panel */}
        <div style={{ width: 108, flexShrink: 0, display: "flex", flexDirection: "column", gap: 5, paddingTop: 26 }}>
          <button onClick={handleAdd}
            style={{ width: "100%", padding: "8px 0", borderRadius: 5, border: "1px solid #4444aa", background: "#1a1a2a", color: "#9999ee", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
            + Add
          </button>
          <button onClick={handleReplace} disabled={selectedIdx === null || (permOriginalCount !== null && selectedIdx >= permOriginalCount)}
            style={{
              width: "100%", padding: "8px 0", borderRadius: 5, fontSize: 10, fontWeight: 500,
              cursor: selectedIdx !== null ? "pointer" : "not-allowed",
              border: `1px solid ${selectedIdx !== null ? "#4a3a1a" : "#1a1a1a"}`,
              background: selectedIdx !== null ? "#1e1a0e" : "transparent",
              color: selectedIdx !== null ? "#e0a040" : "#333",
            }}>
            Replace M{selectedIdx !== null ? selectedIdx + 1 : "–"}
          </button>
          <button onClick={handleClear}
            style={{ width: "100%", padding: "8px 0", borderRadius: 5, border: "1px solid #2a2a2a", background: "#141414", color: "#555", fontSize: 10, cursor: "pointer" }}>
            Clear
          </button>
        </div>
      </div>}

      {/* ══ ACCENT STUDY MODE CONTENT ════════════════════════════════════ */}
      {/* Always mounted (never unmounts) so generator state persists when switching modes */}
      <div style={{ display: mode === "accent" ? "flex" : "none", flexShrink: 0, flexDirection: "column" }}>
        <AccentStudy
          accentMeasures={accentMeasures}
          setAccentMeasures={setAccentMeasures}
          accentGrid={accentGrid}
          setAccentGrid={setAccentGrid}
          accentSelectedIdx={accentSelectedIdx}
          setAccentSelectedIdx={setAccentSelectedIdx}
        />
      </div>

      {/* ══ STICKINGS STUDY MODE CONTENT ═══════════════════════════════════ */}
      <div style={{ display: mode === "stickings" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column", overflow: "hidden" }}>
        <StickingsStudy
          stickingMeasures={stickingMeasures}
          setStickingMeasures={setStickingMeasures}
          stickingSelectedIdx={stickingSelectedIdx}
          setStickingSelectedIdx={setStickingSelectedIdx}
        />
      </div>

      {/* ══ INDEPENDENCE STUDY MODE CONTENT ════════════════════════════════ */}
      <div style={{ display: mode === "independence" ? "flex" : "none", flexShrink: 0, flexDirection: "column" }}>
        <IndependenceStudy
          independenceMeasures={independenceMeasures}
          setIndependenceMeasures={setIndependenceMeasures}
          independenceGrid={independenceGrid}
          setIndependenceGrid={setIndependenceGrid}
          independenceSelectedIdx={independenceSelectedIdx}
          setIndependenceSelectedIdx={setIndependenceSelectedIdx}
        />
      </div>

      {/* ══ TRANSFORM MODE CONTENT ═══════════════════════════════════════ */}
      <div style={{ display: mode === "transform" ? "flex" : "none", flexShrink: 0, flexDirection: "column" }}>
        <TransformMode
          source={transformSource}
          sourceTab={transformSourceTab}
          onAddLine={(patterns) => {
            // Add transformed patterns back to the source tab
            if (transformSourceTab === "independence") {
              const newMeasures: IndependenceMeasureData[] = patterns.map((p, i) => ({
                cymbalHits: p.cymbalHits,
                cymbalOpen: p.cymbalOpen,
                snareHits: p.snareHits,
                snareAccents: p.accentFlags,
                ghostHits: p.ghostHits,
                bassHits: p.bassHits,
                hhFootHits: p.hhFootHits,
                grid: (p.grid === "8th" || p.grid === "16th" || p.grid === "triplet" ? p.grid : "16th") as IndependenceGrid,
                beats: 4,
                lineBreak: i === 0,
              }));
              setIndependenceMeasures(prev => [...prev, ...newMeasures]);
              setMode("independence");
            } else if (transformSourceTab === "accent") {
              const newMeasures: AccentMeasureData[] = patterns.map((p, i) => ({
                snareHits: p.snareHits,
                ghostHits: p.ghostHits,
                bassHits: p.bassHits,
                tomHits: p.tomHits.length > 0 ? p.tomHits : undefined,
                crashHits: p.crashHits.length > 0 ? p.crashHits : undefined,
                accentFlags: p.accentFlags,
                stickings: p.stickings,
                grouping: [p.totalSlots],
                startMode: "accent" as const,
                sticking: "single" as const,
                bassOption: "none" as const,
                orchestration: "snare" as const,
                displaySlots: p.totalSlots,
                lineBreak: i === 0,
              }));
              setAccentMeasures(prev => [...prev, ...newMeasures]);
              setMode("accent");
            } else if (transformSourceTab === "stickings") {
              const newMeasures: StickingMeasureData[] = patterns.map((p, i) => ({
                snareHits: p.snareHits,
                bassHits: p.bassHits,
                accentFlags: p.accentFlags,
                stickings: p.stickings,
                groups: ["transformed"],
                totalSlots: p.totalSlots,
                beamGrouping: 4,
                lineBreak: i === 0,
              }));
              setStickingMeasures(prev => [...prev, ...newMeasures]);
              setMode("stickings");
            } else {
              // Ostinato or unknown — add as independence
              const newMeasures: IndependenceMeasureData[] = patterns.map((p, i) => ({
                cymbalHits: p.cymbalHits,
                cymbalOpen: p.cymbalOpen,
                snareHits: p.snareHits,
                snareAccents: p.accentFlags,
                ghostHits: p.ghostHits,
                bassHits: p.bassHits,
                hhFootHits: p.hhFootHits,
                grid: (p.grid === "8th" || p.grid === "16th" || p.grid === "triplet" ? p.grid : "16th") as IndependenceGrid,
                beats: 4,
                lineBreak: i === 0,
              }));
              setIndependenceMeasures(prev => [...prev, ...newMeasures]);
              setMode("independence");
            }
          }}
        />
      </div>

      {/* ══ K/S INTERPLAY MODE CONTENT ═════════════════════════════════════ */}
      <div style={{ display: mode === "interplay" ? "flex" : "none", flexShrink: 0, flexDirection: "column", padding: "16px 16px 20px", gap: 16, borderBottom: "1px solid #181818" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 3, color: "#e06070", textTransform: "uppercase" }}>
            Pattern Ostinatos
          </span>
          <button onClick={rollInterplayAll} disabled={!parsedInterplayLengths} style={{
            marginLeft: "auto", padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700,
            border: "1px solid #555", background: "#222", color: "#ccc",
            cursor: parsedInterplayLengths ? "pointer" : "not-allowed",
          }}>🎲 Roll all</button>
          <button onClick={handleReplaceInterplay} disabled={interplaySelectedIdx === null || !parsedInterplayLengths} style={{
            padding: "4px 12px", borderRadius: 4, fontSize: 10, fontWeight: 700,
            border: `1px solid ${interplaySelectedIdx !== null ? "#4a3a1a" : "#1a1a1a"}`,
            background: interplaySelectedIdx !== null ? "#1e1a0e" : "transparent",
            color: interplaySelectedIdx !== null ? "#e0a040" : "#333",
            cursor: interplaySelectedIdx !== null ? "pointer" : "not-allowed",
          }}>Replace selected</button>
        </div>

        {/* ── Hi-hat ostinato gallery (Garstka "Universal Function" patterns) ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 10, color: "#555", fontWeight: 700, letterSpacing: 3, textTransform: "uppercase" }}>
            Hi-hat ostinato
          </span>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {(() => {
              // All hi-hat tiles share the same box + stave geometry so the
              // line position is visually identical across the gallery.  Tile
              // height leaves a thin band above the staff for crash + tuplet
              // brackets and room below for the hh-foot pedal glyph.
              const TILE_W = 180, TILE_H = 180;
              const STAVE_Y = 50;
              const offTile = (
                <button
                  key="off"
                  onClick={() => setInterplayOstinatoId(null)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    padding: 4, borderRadius: 5, cursor: "pointer",
                    border: `1.5px solid ${interplayOstinatoId === null ? "#c8aa50" : "#1e1e1e"}`,
                    background: interplayOstinatoId === null ? "#1e1a0e" : "#0a0a0a",
                    color: interplayOstinatoId === null ? "#c8aa50" : "#666",
                    width: TILE_W, height: TILE_H, fontSize: 13, fontWeight: 700,
                  }}>off</button>
              );
              // 2-hit patterns where rests mark the measure boundaries —
              // render them with visible eighth/sixteenth rests instead of
              // implicit gaps so the boundary reads clearly.
              const REST_VISIBLE_IDS = new Set(["h4", "h7", "h8", "h10"]);
              const tiles = HIHAT_PATTERNS.map(h => {
                const isSel = interplayOstinatoId === h.id;
                // Preview shows the full pattern unit.  For triplet patterns the
                // unit is already 3 / 6 / 9 slots; for 16th patterns it's 4.
                const previewLen = h.length;
                const previewHits  = h.hits.filter(x => x < previewLen);
                const previewOpen  = h.open.filter(x => x < previewLen);
                const previewPedal = h.pedal.filter(x => x < previewLen);
                const previewCrash = h.crash.filter(x => x < previewLen);
                return (
                  <div key={h.id}
                    onClick={() => setInterplayOstinatoId(h.id)}
                    title={h.name}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      padding: 0, borderRadius: 5, cursor: "pointer",
                      border: `1.5px solid ${isSel ? "#c8aa50" : "#1e1e1e"}`,
                      background: isSel ? "#1e1a0e" : "#0a0a0a",
                      width: TILE_W, height: TILE_H, overflow: "hidden", lineHeight: 0,
                    }}>
                    <VexDrumStrip
                      measures={[{
                        grid: h.triplet ? "triplet" : "16th",
                        ostinatoHits: previewHits,
                        ostinatoOpen: previewOpen,
                        snareHits: [], bassHits: [],
                        hhFootHits: previewPedal, hhFootOpen: [],
                        crashHits: previewCrash,
                        ghostHits: [], ghostDoubleHits: [],
                        slotOverride: previewLen,
                        showRests: REST_VISIBLE_IDS.has(h.id),
                        // Patterns flagged to show rests also want short hits
                        // so the trailing rest glyph renders; other ostinatos
                        // keep the held-note notation (dotted 8ths, 8ths).
                        shortHits: REST_VISIBLE_IDS.has(h.id),
                        // Triplet patterns get a "3" tuplet bracket above each beat.
                        tupletNum: h.triplet ? 3 : undefined,
                      }]}
                      measureWidth={TILE_W - 10}
                      height={TILE_H}
                      staveY={STAVE_Y}
                      showClef={false}
                    />
                  </div>
                );
              });
              return [offTile, ...tiles];
            })()}
          </div>
        </div>

        {/* ── K/S pattern galleries, one per phrase group ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 10, color: "#555", fontWeight: 700, letterSpacing: 3, textTransform: "uppercase" }}>
            Kick / snare
          </span>

          {/* ── Custom input + phrase control ABOVE groups (saves across sessions via localStorage) ── */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            padding: "6px 10px", borderRadius: 5, background: "#0a0a14",
            border: "1px solid #1e1e2a",
          }}>
            <span style={{ fontSize: 10, color: "#7a7aaa", fontWeight: 700, letterSpacing: 1 }}>
              + custom
            </span>
            <input
              value={customInput}
              onChange={e => setCustomInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") addCustomPattern(); }}
              placeholder="BSBB"
              style={{
                width: 140, padding: "4px 8px", fontSize: 12, fontFamily: "monospace",
                borderRadius: 3, outline: "none", letterSpacing: 2, textTransform: "uppercase",
                border: "1px solid #333", background: "#0a0a0a", color: "#c8aa50",
              }}
            />
            <button onClick={addCustomPattern} disabled={!parseCustomPattern(customInput)} style={{
              padding: "4px 12px", borderRadius: 3, fontSize: 10, fontWeight: 700,
              border: "1px solid #3a3a5a", background: "#0e0e1a", color: "#7a7aaa",
              cursor: parseCustomPattern(customInput) ? "pointer" : "not-allowed",
            }}>save</button>
            <label style={{ fontSize: 10, color: "#666", marginLeft: 12 }}>Phrase</label>
            <input
              value={interplayPhrase}
              onChange={e => setInterplayPhrase(e.target.value)}
              placeholder="4+4+4+4"
              style={{
                width: 140, padding: "4px 8px", fontSize: 12, fontFamily: "monospace",
                borderRadius: 3, outline: "none", letterSpacing: 1,
                border: `1px solid ${parsedInterplayLengths ? "#333" : "#6a2a2a"}`,
                background: "#0a0a0a", color: parsedInterplayLengths ? "#ccc" : "#e06070",
              }}
            />
          </div>

          {parsedInterplayLengths && parsedInterplayLengths.map((len, idx) => {
              const pick = interplayPicks[idx];
              const pool = poolForLength(len);
              return (
                <KSPatternGroup
                  key={idx}
                  idx={idx}
                  len={len}
                  pool={pool}
                  pick={pick}
                  onPick={(groupIdx, p) => setInterplayPicks(prev => {
                    const out = [...prev];
                    out[groupIdx] = p;
                    return out;
                  })}
                  isCustom={isCustomPattern}
                  onRemoveCustom={removeCustomPattern}
                />
              );
            })}

          {/* ── + Add Phrase below the last group ── */}
          {parsedInterplayLengths && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 6 }}>
              <button onClick={handleAddInterplay} disabled={!parsedInterplayLengths} style={{
                padding: "8px 24px", borderRadius: 5, fontSize: 12, fontWeight: 700, letterSpacing: 2,
                border: "1.5px solid #4444aa", background: "#1a1a2a", color: "#9999ee",
                cursor: parsedInterplayLengths ? "pointer" : "not-allowed",
              }}>+ Add Phrase</button>
            </div>
          )}
        </div>

        {/* ── Final preview: one connected strip, each measure its own time sig ── */}
        {interplayMeasures.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 9, color: "#333", fontWeight: 700, letterSpacing: 4, textTransform: "uppercase" }}>
                Final preview
              </span>
              <button onClick={randomizeSnareAccents} title="Musical accent sprinkle on snares only (first snare of each measure always accented)" style={{
                padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700,
                border: "1px solid #3a3a5a", background: "#0e0e1a", color: "#9999ee", cursor: "pointer",
              }}>🎲 Randomize snare accents</button>
              <button onClick={clearInterplayAccents} style={{
                padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700,
                border: "1px solid #2a2a2a", background: "#141414", color: "#666", cursor: "pointer",
              }}>Clear accents</button>
              <button onClick={handleDeleteInterplay} disabled={interplaySelectedIdx === null} style={{
                marginLeft: "auto", padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700,
                border: `1px solid ${interplaySelectedIdx !== null ? "#6a2a2a" : "#1a1a1a"}`,
                background: interplaySelectedIdx !== null ? "#1e0a0a" : "transparent",
                color: interplaySelectedIdx !== null ? "#e06060" : "#333",
                cursor: interplaySelectedIdx !== null ? "pointer" : "not-allowed",
              }}>Delete selected</button>
              <button onClick={handleClearInterplay} style={{
                padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700,
                border: "1px solid #2a2a2a", background: "#141414", color: "#555", cursor: "pointer",
              }}>Clear</button>
            </div>

            <InterplayFinalStrip
              measures={interplayMeasures}
              selectedIdx={interplaySelectedIdx}
              onSelect={i => setInterplaySelectedIdx(i)}
              onToggleAccent={toggleInterplayAccent}
            />

            {/* Practice Log */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <PracticeLogSaveBar
                mode="drum-ostinato"
                label="Pattern Ostinatos"
                sourceOptions={[{ value: "drum-ostinato", label: "Pattern Ostinatos" }]}
                tagOptions={[
                  { value: "isolation", label: "Isolation", color: "#e0a040" },
                  { value: "context",   label: "Context",   color: "#7aaa7a" },
                ]}
                defaultTag={practiceTag}
                onTagChange={setPracticeTag}
                getSnapshot={() => {
                  const sig = interplayMeasures.map(m => `${m.totalSlots}/16`).join(" + ");
                  const labels = interplayMeasures.map(m => m.patternLabel).join(", ");
                  return {
                    preview: `${interplayMeasures.length} bars (${sig}) — ${labels}`,
                    snapshot: { interplayMeasures, interplayOstinatoId, interplayPhrase },
                    canRestore: false,
                  };
                }}
                getCapture={async () => undefined}
              />
            </div>
          </div>
        )}
      </div>

      {/* ══ SECTIONS 3 & 4: Strips — order depends on active mode ═══════ */}
      {/* Active-mode strip first; others below */}
      <div style={{ display: "flex", flexDirection: mode === "accent" ? "column" : mode === "stickings" ? "column" : mode === "independence" ? "column" : mode === "transform" ? "column" : "column-reverse" }}>

      {(accentMeasures.length > 0 || mode === "accent") && (
      <div ref={accentStripRef}>
      {betaTransform && accentMeasures.length > 0 && (
        <div style={{ padding: "2px 12px 0", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={importAccentToTransform} style={{
            padding: "2px 8px", borderRadius: 3, fontSize: 8, fontWeight: 600,
            cursor: "pointer", border: "1px solid #c090e044", background: "#c090e011", color: "#c090e0",
          }}>{accentSelectedIdx !== null ? `Transform M${accentSelectedIdx + 1}` : "Transform All"} →</button>
        </div>
      )}
      <AccentStudyStrip
        measures={accentMeasures}
        grid={accentGrid}
        selectedIdx={accentSelectedIdx}
        onSelect={handleAccentSelectFromStrip}
        onDelete={handleAccentDeleteSelected}
        onClearAll={() => { setAccentMeasures([]); setAccentSelectedIdx(null); }}
        onLog={(entries, logTag) => {
          // Group entries by lineIdx → one practice entry per line
          const byLine = new Map<number, typeof entries>();
          for (const e of entries) {
            const arr = byLine.get(e.lineIdx) ?? [];
            arr.push(e);
            byLine.set(e.lineIdx, arr);
          }
          for (const [lineIdx, lineEntries] of byLine) {
            const variantRatings: Record<string, number> = {};
            for (const e of lineEntries) {
              variantRatings[e.variant] = e.rating;
            }
            const best = lineEntries.reduce((a, b) => b.rating > a.rating ? b : a, lineEntries[0]);
            const variantSummary = lineEntries.map(e => `${e.variant} ${["","★","★★","★★★","★★★★","★★★★★"][e.rating]}`).join("  ");
            addPracticeEntry({
              mode: "accent-study",
              label: `Accent Study · Line ${lineIdx + 1}`,
              rating: best.rating as PracticeRating,
              preview: `Line ${lineIdx + 1}: ${best.measures.length} measure${best.measures.length !== 1 ? "s" : ""} · Grid: ${accentGrid}\n${variantSummary}`,
              snapshot: { measures: best.measures, grid: accentGrid, variantRatings },
              canRestore: true,
              tag: logTag || practiceTag || undefined,
            });
          }
        }}
      />
      </div>
      )}

      {(stickingMeasures.length > 0 || mode === "stickings") && (<>
      {/* ══ STICKINGS MEASURE STRIP ══════════════════════════════════════ */}
      {betaTransform && stickingMeasures.length > 0 && (
        <div style={{ padding: "2px 12px 0", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={importStickingsToTransform} style={{
            padding: "2px 8px", borderRadius: 3, fontSize: 8, fontWeight: 600,
            cursor: "pointer", border: "1px solid #c090e044", background: "#c090e011", color: "#c090e0",
          }}>{stickingSelectedIdx !== null ? `Transform M${stickingSelectedIdx + 1}` : "Transform All"} →</button>
        </div>
      )}
      <StickingsStudyStrip
        measures={stickingMeasures}
        selectedIdx={stickingSelectedIdx}
        onSelect={handleStickingSelectFromStrip}
        onDelete={handleStickingDeleteSelected}
        onClearAll={() => { setStickingMeasures([]); setStickingSelectedIdx(null); }}
        onLog={(entries, logTag) => {
          for (const e of entries) {
            addPracticeEntry({
              mode: "stickings-study",
              label: `Stickings · Line ${e.lineIdx + 1}`,
              rating: e.rating as PracticeRating,
              preview: `Line ${e.lineIdx + 1}: ${e.measures.length} measure${e.measures.length !== 1 ? "s" : ""} · Stickings: ${e.measures.map(m => m.groups.join(" + ")).join(" | ")}`,
              snapshot: { measures: e.measures },
              canRestore: false,
              tag: logTag || practiceTag || undefined,
            });
          }
        }}
      />
      </>)}

      {(independenceMeasures.length > 0 || mode === "independence") && (<>
      {/* ══ INDEPENDENCE MEASURE STRIP ═════════════════════════════════════ */}
      {betaTransform && independenceMeasures.length > 0 && (
        <div style={{ padding: "2px 12px 0", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={importIndependenceToTransform} style={{
            padding: "2px 8px", borderRadius: 3, fontSize: 8, fontWeight: 600,
            cursor: "pointer", border: "1px solid #c090e044", background: "#c090e011", color: "#c090e0",
          }}>{independenceSelectedIdx !== null ? `Transform M${independenceSelectedIdx + 1}` : "Transform All"} →</button>
        </div>
      )}
      <IndependenceStudyStrip
        measures={independenceMeasures}
        grid={independenceGrid}
        selectedIdx={independenceSelectedIdx}
        onSelect={(i) => { setIndependenceSelectedIdx(i); setMode("independence"); }}
        onDelete={() => {
          if (independenceSelectedIdx === null) return;
          setIndependenceMeasures(prev => prev.filter((_, i) => i !== independenceSelectedIdx));
          setIndependenceSelectedIdx(null);
        }}
        onClearAll={() => { setIndependenceMeasures([]); setIndependenceSelectedIdx(null); }}
        onLog={(entries, logTag) => {
          for (const e of entries) {
            addPracticeEntry({
              mode: "independence-study",
              label: `Independence · Line ${e.lineIdx + 1}`,
              rating: e.rating as PracticeRating,
              preview: `Line ${e.lineIdx + 1}: ${e.measures.length} measure${e.measures.length !== 1 ? "s" : ""} · Grid: ${independenceGrid}`,
              snapshot: { measures: e.measures, grid: independenceGrid },
              canRestore: false,
              tag: logTag || practiceTag || undefined,
            });
          }
        }}
      />
      </>)}

      {(measures.length > 0 || mode === "ostinato") && (
      <div ref={ostinatoStripRef} style={{ flexShrink: 0, borderTop: "1px solid #181818" }}>

        {/* ── Strip header ───────────────────────────────────────────── */}
        <div style={{ padding: "4px 12px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 9, color: "#9999ee", fontWeight: 700, letterSpacing: 4, textTransform: "uppercase" }}>
            Ostinato {measures.length > 0 && `(${measures.length})`}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {betaTransform && measures.length > 0 && (
              <button onClick={importOstinatoToTransform} style={{
                padding: "2px 8px", borderRadius: 3, fontSize: 8, fontWeight: 600,
                cursor: "pointer", border: "1px solid #c090e044", background: "#c090e011", color: "#c090e0",
              }}>{selectedIdx !== null ? `Transform M${selectedIdx + 1}` : "Transform All"} →</button>
            )}
            {/* Quickmarks toggle */}
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setQmOpen(prev => !prev)}
                title="Quickmarks"
                style={{
                  fontSize: 9, color: qmOpen ? "#c8aa50" : "#555", background: "none",
                  border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 3,
                }}
              >
                {qmOpen ? "▾" : "▸"} Quickmarks{quickmarks.length > 0 ? ` (${quickmarks.length})` : ""}
              </button>
            </div>
            {/* Bookmark current */}
            {measures.length > 0 && (
              <button onClick={addQuickmark}
                title="Bookmark current ostinato"
                style={{
                  fontSize: 9, color: "#c8aa50", background: "#1a1a0e", border: "1px solid #3a3a1a",
                  borderRadius: 4, padding: "1px 6px", cursor: "pointer", fontWeight: 600,
                }}>
                + Bookmark
              </button>
            )}
            {measures.length === 0 && quickmarks.length === 0 && (
              <span style={{ fontSize: 9, color: "#2a2a2a" }}>Add measures above</span>
            )}
            {measures.length > 0 && (
              <button onClick={() => { stopPlay(); setMeasures([]); setSelectedIdx(null); setPhraseBreaks([]); setPermOriginalCount(null); }}
                style={{ fontSize: 9, color: "#3a3a3a", background: "none", border: "none", cursor: "pointer" }}>
                Clear all
              </button>
            )}
          </div>
        </div>

        {/* ── Quickmarks menu ──────────────────────────────────────────── */}
        {qmOpen && (
          <div style={{
            padding: "4px 12px 6px", borderBottom: "1px solid #1a1a1a",
            display: "flex", flexWrap: "wrap", gap: 4,
          }}>
            {quickmarks.length === 0 && (
              <span style={{ fontSize: 9, color: "#2a2a2a" }}>No bookmarks yet — build a pattern and click + Bookmark</span>
            )}
            {quickmarks.map(qm => {
              const qmGrid = (qm.grid ?? "16th") as GridType;
              const qmMeasures = qm.measures as DrumMeasure[];
              const origCount = qm.permOriginalCount;
              const origMeasures = origCount != null ? qmMeasures.slice(0, origCount) : qmMeasures;
              const stripData = origMeasures.map(m => measureToStripData(m, qmGrid));
              const CLEF_W = 40;
              const perMeasure = 120;
              const notationW = CLEF_W + origMeasures.length * perMeasure;
              return (
                <div key={qm.id} style={{
                  padding: "4px 6px", borderRadius: 4,
                  background: "#0e0e0e", border: "1px solid #1a1a1a",
                  width: notationW + 20,
                  flexShrink: 0,
                }}>
                  {/* Header row: label + actions */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    {qmEditId === qm.id ? (
                      <input
                        autoFocus
                        value={qmEditLabel}
                        onChange={e => setQmEditLabel(e.target.value)}
                        onBlur={() => renameQuickmark(qm.id, qmEditLabel.trim() || qm.label)}
                        onKeyDown={e => { if (e.key === "Enter") renameQuickmark(qm.id, qmEditLabel.trim() || qm.label); if (e.key === "Escape") setQmEditId(null); }}
                        style={{
                          flex: 1, fontSize: 9, background: "#141414", border: "1px solid #3a3a3a",
                          borderRadius: 3, padding: "1px 4px", color: "#ddd", outline: "none",
                        }}
                      />
                    ) : (
                      <span
                        onDoubleClick={() => { setQmEditId(qm.id); setQmEditLabel(qm.label); }}
                        title="Double-click to rename"
                        style={{ flex: 1, fontSize: 9, color: "#aaa", cursor: "default", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {qm.label}
                      </span>
                    )}
                    <button
                      onClick={() => loadQuickmark(qm)}
                      title="Load this bookmark"
                      style={{
                        fontSize: 8, color: "#7aaa7a", background: "#0a1a0a", border: "1px solid #1a3a1a",
                        borderRadius: 3, padding: "1px 6px", cursor: "pointer", fontWeight: 600, flexShrink: 0,
                      }}>
                      Load
                    </button>
                    <button
                      onClick={() => deleteQuickmark(qm.id)}
                      title="Remove bookmark"
                      style={{
                        fontSize: 8, color: "#e06060", background: "none", border: "none",
                        cursor: "pointer", padding: "0 2px", flexShrink: 0,
                      }}>
                      x
                    </button>
                  </div>
                  {/* Notation preview */}
                  {stripData.length > 0 && (
                    <div style={{ overflowX: "auto", background: "#0a0a0a", borderRadius: 4, border: "1px solid #1a1a1a", padding: 4, lineHeight: 0 }}>
                      <VexDrumStrip
                        measures={stripData}
                        measureWidth={perMeasure}
                        height={165}
                        oneBeatPerBar
                        showClef
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Panels + Perms bar (always visible) ──────────────────── */}
        {measures.length > 0 && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            padding: "5px 14px", borderBottom: "1px solid #161616",
          }}>
            {/* Toggle all rotation panels */}
            {(() => {
              const origCount = permOriginalCount ?? measures.length;
              const origIndices = Array.from({ length: origCount }, (_, i) => i);
              const allOpen = origIndices.every(i => openPanels.has(i));
              return (
                <button
                  title={allOpen ? "Close all rotation panels" : "Open all rotation panels"}
                  onClick={() => {
                    if (allOpen) {
                      setOpenPanels(new Set());
                    } else {
                      setOpenPanels(new Set(origIndices));
                    }
                  }}
                  style={{
                    padding: "4px 10px", borderRadius: 5,
                    border: `1.5px solid ${allOpen ? "#8888ff" : "#2a2a2a"}`,
                    background: allOpen ? "#1a1a44" : "#141414",
                    color: allOpen ? "#9999ff" : "#555",
                    fontSize: 10, fontWeight: 700, cursor: "pointer",
                    letterSpacing: 0.5,
                  }}>
                  {allOpen ? "✕ Panels" : "⚙ Panels"}
                </button>
              );
            })()}

            {/* Add / Remove / Refresh Permutations */}
            {permOriginalCount !== null ? (<>
              <button
                title="Regenerate all permutation copies from current pool settings"
                onClick={handleAddPermutations}
                style={{
                  padding: "4px 10px", borderRadius: 5,
                  border: "1.5px solid #44aa44",
                  background: "#102a10",
                  color: "#7aaa7a",
                  fontSize: 10, fontWeight: 700, cursor: "pointer",
                  letterSpacing: 0.5,
                }}>
                ↻ Perms
              </button>
              <button
                title="Remove all permutation copies"
                onClick={clearPermutations}
                style={{
                  padding: "4px 10px", borderRadius: 5,
                  border: "1.5px solid #aa4444",
                  background: "#2a1010",
                  color: "#e06060",
                  fontSize: 10, fontWeight: 700, cursor: "pointer",
                  letterSpacing: 0.5,
                }}>
                ✕ Perms
              </button>
            </>) : (
              <button
                title="Duplicate the phrase for each permutation in the rotation pool"
                onClick={handleAddPermutations}
                style={{
                  padding: "4px 10px", borderRadius: 5,
                  border: "1.5px solid #44aa44",
                  background: "#102a10",
                  color: "#7aaa7a",
                  fontSize: 10, fontWeight: 700, cursor: "pointer",
                  letterSpacing: 0.5,
                }}>
                + Perms
              </button>
            )}
          </div>
        )}

        {/* ── Rotation playback bar (beta only: BPM, accents, rotation, play) ── */}
        {betaPlayRotation && (<div style={{
          display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
          padding: "7px 14px 7px", borderBottom: "1px solid #161616",
        }}>

          {/* BPM indicator (uses universal metronome) */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 10, color: "#555", letterSpacing: 1 }}>BPM</span>
            <span style={{
              fontSize: 14, fontWeight: 700,
              color: metronomeRunning ? "#e0a040" : "#777",
              minWidth: 36, textAlign: "right",
            }}>{metronomeBpm}</span>
          </div>

          {/* Divider */}
          <div style={{ width: 1, height: 28, background: "#222" }} />

          {/* Bar accent boxes — 3 states: accent → normal → silent, one per bar */}
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {accentBeats.map((state, bi) => {
              const cycle = (v: typeof state) =>
                v === "accent" ? "normal" : v === "normal" ? "silent" : "accent";
              const titles = { accent: "Accented", normal: "Normal", silent: "Silent" };
              const colors = {
                accent: { border: "#c8aa50", bg: "#c8aa5028", text: "#c8aa50" },
                normal: { border: "#3a3a3a",  bg: "#141414",   text: "#666"    },
                silent: { border: "#6a2020",  bg: "#1e0c0c",   text: "#944"    },
              };
              const c = colors[state];
              return (
                <button key={bi}
                  onClick={() => setAccentBeats(prev => prev.map((v, j) => j === bi ? cycle(v) : v))}
                  title={`Bar ${bi + 1}: ${titles[state]} — click to cycle`}
                  style={{
                    width: 24, height: 24, borderRadius: 4,
                    border: `1.5px solid ${c.border}`,
                    background: c.bg,
                    cursor: "pointer", fontSize: 10, fontWeight: 700,
                    color: c.text,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    textDecoration: state === "silent" ? "line-through" : "none",
                  }}>{bi + 1}</button>
              );
            })}
          </div>

          {/* Divider */}
          <div style={{ width: 1, height: 28, background: "#222" }} />

          {/* Rotation ↻ — how many phrase passes before advancing perm */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}
            title="Rotations: how many full phrase passes before advancing the permutation (0 = never)">
            <span style={{ fontSize: 16, color: "#666" }}>↻</span>
            <input type="number" value={rotationAmt} min={0} max={99}
              onChange={e => setRotationAmt(Math.max(0, Number(e.target.value) || 0))}
              style={{ width: 44, textAlign: "center", background: "#141414", border: "1px solid #2a2a2a", borderRadius: 4, color: "#eee", fontSize: 14, fontWeight: 600, padding: "3px 0", outline: "none" }} />
            <span style={{ fontSize: 9, color: "#444" }}>passes</span>
          </div>

          {/* Countdown dots */}
          {countdownLeft !== null && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} style={{
                  width: 10, height: 10, borderRadius: "50%",
                  background: i < countdownLeft ? "#c8aa50" : "#252525",
                  transition: "background 60ms",
                }} />
              ))}
            </div>
          )}

          {/* Play / Stop */}
          <button
            onClick={isPlaying ? stopPlay : startPlay}
            disabled={measures.length === 0}
            style={{
              marginLeft: "auto",
              padding: "6px 20px", borderRadius: 6,
              border: `1.5px solid ${isPlaying ? "#aa4444" : measures.length > 0 ? "#44aa44" : "#2a2a2a"}`,
              background: isPlaying ? "#2a1010" : measures.length > 0 ? "#102a10" : "#141414",
              color: isPlaying ? "#e06060" : measures.length > 0 ? "#7aaa7a" : "#444",
              fontSize: 13, fontWeight: 700, cursor: measures.length > 0 ? "pointer" : "not-allowed",
              letterSpacing: 1,
            }}>
            {isPlaying ? "■ Stop" : "▶ Play"}
          </button>
        </div>)}

        {/* ── Scrollable strip + panels ─────────────────────────────── */}
        <div ref={composedStripRef} style={{
          overflowX: "hidden",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "6px 16px 4px",
        }}>
          {measures.length > 0 ? (() => {
            const origLen = permOriginalCount ?? measures.length;
            const origMeasures = measures.slice(0, origLen);
            const permMeasures = permOriginalCount != null ? measures.slice(origLen) : [];
            const permBreaks = phraseBreaks.map(b => b - origLen).filter(b => b > 0);

            return (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
                {/* ── Universal permutations: shared rotation axis across all measures ─── */}
                <UniversalPermPanel
                  pools={universalPools}
                  grid={grid}
                  onTogglePoolAll={handleUniversalPoolToggle}
                  hasMeasures={origMeasures.length > 0}
                />

                {/* ── Source phrase — centered at top ────────────── */}
                {permOriginalCount != null && (
                  <div style={{ fontSize: 9, color: "#e0a040", fontWeight: 700, letterSpacing: 3, textTransform: "uppercase", marginBottom: 4 }}>
                    Source Phrase
                  </div>
                )}
                <MeasureStrip
                  measures={origMeasures}
                  grid={grid}
                  selectedIdx={selectedIdx}
                  onSelect={handleSelectFromStrip}
                  onDelete={handleDeleteSelected}
                  activeBeat={activeBeat}
                  measureVoice={measureVoice}
                  onVoiceSelect={handleVoiceSelect}
                  onMeasureNav={handleMeasureNav}
                  openPanels={openPanels}
                  onTogglePanel={(idx: number) => setOpenPanels(prev => {
                    const next = new Set(prev);
                    if (next.has(idx)) next.delete(idx); else next.add(idx);
                    return next;
                  })}
                  onLockToggle={handleLockToggle}
                  phraseBreaks={[]}
                  permOriginalCount={permOriginalCount}
                  onAccentToggle={handleAccentToggle}
                />

                {/* ── Rotation panels — directly below source phrase ── */}
                {openPanels.size > 0 && (() => {
                  const origRows = buildRows(origMeasures, []);
                  const panelMaxSegs = origRows.reduce((mx, r) => Math.max(mx, r.length), 1);
                  const panelGapTotal = Math.max(0, panelMaxSegs - 1) * PHRASE_GAP;
                  const panelMeasureW = composedStripW > 0
                    ? Math.max(120, Math.floor((composedStripW - STRIP_CLEF_EXTRA - panelGapTotal) / BARS_PER_ROW))
                    : STRIP_MEASURE_W;
                  return origRows.map((row, rowIdx) => {
                    const hasOpen = row.some(seg => seg.indices.some(i => openPanels.has(i)));
                    if (!hasOpen) return null;
                    return (
                      <div key={`panel-row-${rowIdx}`} style={{ display: "flex", padding: "4px 0 0" }}>
                        {row.map((seg, segIdx) => {
                          const showClef  = rowIdx === 0 && segIdx === 0;
                          const clefExtra = showClef ? STRIP_CLEF_EXTRA : 0;
                          return (
                            <div key={`panel-seg-${rowIdx}-${segIdx}`} style={{ display: "flex", marginLeft: segIdx > 0 ? PHRASE_GAP + 7 : 0 }}>
                              {seg.indices.map((absI, relI) => {
                                const w = relI === 0 ? panelMeasureW + clefExtra : panelMeasureW;
                                return (
                                  <div key={absI} style={{ width: w, flexShrink: 0, padding: "0 2px", boxSizing: "border-box" }}>
                                    {openPanels.has(absI) && measures[absI] ? (
                                      betaPlayRotation ? (
                                        <PermPanel
                                          measureIdx={absI}
                                          measures={measures}
                                          grid={grid}
                                          voice={(measureVoice[absI]?.[0]) ?? "S"}
                                          mode={measureMode[absI] ?? "seq"}
                                          limit={measureLimit[absI] ?? 0}
                                          orderMap={measureOrder[absI] ?? {}}
                                          rotateVoices={measureRotateVoices[absI] ?? []}
                                          ghostDouble={!!measureGhostDouble[absI]}
                                          onModeChange={mode => handleModeChange(absI, mode)}
                                          onLimitChange={limit => handleLimitChange(absI, limit)}
                                          onOrderChange={(permId, pos) => handleOrderChange(absI, permId, pos)}
                                          onRotateVoiceToggle={v => handleRotateVoiceToggle(absI, v)}
                                          onGhostDoubleToggle={() => handleGhostDoubleToggle(absI)}
                                          onClose={() => setOpenPanels(prev => { const next = new Set(prev); next.delete(absI); return next; })}
                                        />
                                      ) : (() => {
                                        const voices: VoiceBtnId[] = measureVoice[absI]?.length ? measureVoice[absI] : ["S"];
                                        return (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                          {voices.map(v => (
                                            <SimplePermPanel
                                              key={v}
                                              measureIdx={absI}
                                              measures={measures}
                                              grid={grid}
                                              voice={v}
                                              onSelectPerm={handleSimplePermSelect}
                                              onToggleOpen={handleSimpleOpenToggle}
                                              onToggleDouble={handleSimpleDoubleToggle}
                                              onSelectGhostDoublePerm={handleGhostDoublePermSelect}
                                              onSelectOstinatoOpenPerm={handleOstinatoOpenPermSelect}
                                              onTogglePool={handleTogglePool}
                                              onToggleSecondPool={handleToggleSecondPool}
                                              onSetPool={handleSetPool}
                                              onSetSecondPool={handleSetSecondPool}
                                              onClose={() => setOpenPanels(prev => { const next = new Set(prev); next.delete(absI); return next; })}
                                            />
                                          ))}
                                        </div>);
                                      })()
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    );
                  });
                })()}

                {/* ── Permutation copies — 2 phrases per row ────── */}
                {permMeasures.length > 0 && (
                  <div style={{ marginTop: 10, borderTop: "1px solid #1e1e1e", paddingTop: 6, width: "100%" }}>
                    <MeasureStrip
                      measures={permMeasures}
                      grid={grid}
                      selectedIdx={selectedIdx}
                      onSelect={handleSelectFromStrip}
                      onDelete={handleDeleteSelected}
                      activeBeat={activeBeat}
                      measureVoice={measureVoice}
                      onVoiceSelect={handleVoiceSelect}
                      onMeasureNav={handleMeasureNav}
                      openPanels={new Set()}
                      onTogglePanel={() => {}}
                      onLockToggle={handleLockToggle}
                      phraseBreaks={permBreaks}
                      barsPerRow={origLen * 2}
                      permOriginalCount={permOriginalCount}
                      indexOffset={origLen}
                    />
                  </div>
                )}
              </div>
            );
          })() : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", fontSize: 10, color: "#1e1e1e" }}>
              No measures yet — build a pattern and click + Add
            </div>
          )}
        </div>
      </div>
      )}

      </div> {/* end strip order wrapper */}

      {/* ══ EXPORT DIALOG ══════════════════════════════════════════════════ */}
      <ExportDialog
        open={showExport}
        onClose={() => setShowExport(false)}
        fileName="drum_patterns"
        sections={[
          {
            id: "ostinato",
            label: "Ostinato Measures",
            defaultTitle: "Fine Ostinatos",
            getElement: () => ostinatoStripRef.current,
            generateMusicXml: () => generateDrumOstinatoXML("Fine Ostinatos", measures, grid),
          },
          {
            id: "accent",
            label: "Accent Study Measures",
            defaultTitle: "Accent Study",
            getElement: () => accentStripRef.current,
            generateMusicXml: () => {
              const beatSlots = ACCENT_SUBDIV_BEAT_SLOTS[accentGrid];
              const beats = accentMeasures.length > 0
                ? Math.max(1, Math.round((accentMeasures[0].displaySlots ?? (beatSlots * 4)) / beatSlots))
                : 4;
              return generateAccentStudyXML("Accent Study", accentMeasures, accentGrid, beats);
            },
          },
        ] satisfies ExportSection[]}
      />

    </div>
  );
}
