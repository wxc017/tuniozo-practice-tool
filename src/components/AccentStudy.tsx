import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import type { ComponentType } from "react";
import {
  AccentSubdivision,
  AccentBeatCount,
  StartMode,
  Sticking,
  Interpretation,
  AccentInterpretation,
  TapInterpretation,
  BassOption,
  Orchestration,
  AccentMeasureData,
  AccentExercise,
  ACCENT_INTERPRETATION_LABELS,
  TAP_INTERPRETATION_LABELS,
  BASS_LABELS,
  ORCHESTRATION_LABELS,
  ACCENT_SUBDIV_LABELS,
  generateConstrainedGrouping,
  generateFreeGrouping,
  generateAwkwardGrouping,
  parseCustomGrouping,
  groupingToAccents,
  resolveAccentHits,
  generateStickings,
  paradiddleExpand,
  groupingLabel,
  loadAccentLog,
  saveAccentExercise,
  deleteAccentExercise,
  slotsPerBeat,
  totalSlots as calcTotalSlots,
  toRenderGrid,
  applyOrchestration,
} from "@/lib/accentData";
import { RATING_LABELS } from "@/lib/drumData";
import { localToday } from "@/lib/storage";
import VexDrumNotation, { VexDrumStrip, StripMeasureData } from "@/components/VexDrumNotation";
import { randomizeSlotMods as generateSlotMods } from "@/lib/musicalScoring";

const STRIP_BEAT_W    = 150;   // width per beat in the saved-measures strip
const STRIP_MEASURE_H = 150;
const STRIP_MEASURE_H_TUPLET = 200;
const STRIP_CLEF_EXTRA = 36;

const RATING_COLORS = ["", "#555", "#e06060", "#e0a040", "#7aaa7a", "#7173e6"];

function OptionPill<T extends string>({
  value,
  selected,
  onSelect,
  color,
}: {
  value: T;
  selected: boolean;
  onSelect: () => void;
  color: string;
}) {
  return (
    <button
      onClick={onSelect}
      style={{
        padding: "3px 8px",
        borderRadius: 4,
        fontSize: 9,
        fontWeight: 600,
        cursor: "pointer",
        border: `1px solid ${selected ? color + "88" : "#1a1a1a"}`,
        background: selected ? color + "22" : "#0e0e0e",
        color: selected ? color : "#444",
        whiteSpace: "nowrap",
      }}
    >
      {value}
    </button>
  );
}

function GroupingViz({
  grouping,
  accents,
  totalSlots,
  color,
}: {
  grouping: number[];
  accents: boolean[];
  totalSlots: number;
  color: string;
}) {
  const DOT = 10;
  const GAP = 3;
  const GROUP_GAP = 8;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: GROUP_GAP,
        padding: "6px 8px",
        background: "#0a0a0a",
        borderRadius: 6,
        overflowX: "auto",
      }}
    >
      {grouping.map((len, gi) => {
        const startIdx = grouping.slice(0, gi).reduce((a, b) => a + b, 0);
        return (
          <div
            key={gi}
            style={{
              display: "flex",
              gap: GAP,
              padding: "2px 4px",
              borderRadius: 4,
              border: `1px solid ${color}22`,
              background: `${color}08`,
            }}
          >
            {Array.from({ length: len }, (_, ni) => {
              const slotIdx = startIdx + ni;
              const isAccent = accents[slotIdx] ?? false;
              return (
                <div
                  key={ni}
                  style={{
                    width: DOT,
                    height: DOT,
                    borderRadius: "50%",
                    background: isAccent ? color : "transparent",
                    border: `1.5px solid ${isAccent ? color : "#2a2a2a"}`,
                  }}
                />
              );
            })}
          </div>
        );
      })}
      <span
        style={{
          fontSize: 8,
          color: "#333",
          fontFamily: "monospace",
          marginLeft: 4,
          flexShrink: 0,
        }}
      >
        {groupingLabel(grouping)}
      </span>
    </div>
  );
}

/** Interpretation variant descriptors */
const ACCENT_VARIANTS: { key: string; letter: string; label: string; field: AccentInterpretation | null }[] = [
  { key: "acc-n", letter: "N", label: "Accent: Normal",  field: null },
  { key: "acc-f", letter: "F", label: "Accent: Flams",   field: "accent-flam" },
  { key: "acc-d", letter: "D", label: "Accent: Doubles", field: "accent-double" },
  { key: "acc-b", letter: "B", label: "Accent: Buzz",    field: "accent-buzz" },
];
const TAP_VARIANTS: { key: string; letter: string; label: string; field: TapInterpretation | null }[] = [
  { key: "tap-n", letter: "N", label: "Tap: Normal",  field: null },
  { key: "tap-b", letter: "B", label: "Tap: Buzz",    field: "tap-buzz" },
  { key: "tap-f", letter: "F", label: "Tap: Flams",   field: "tap-flam" },
  { key: "tap-d", letter: "D", label: "Tap: Doubles", field: "tap-double" },
];

export type VariantRatings = Record<string, number>; // key = `${lineIdx}:${variantKey}`, value = 1-5 or 0

function AccentStrip({
  measures,
  grid,
  selectedIdx,
  onSelect,
  onDelete,
  variantRatings,
  onVariantRatingChange,
}: {
  measures: AccentMeasureData[];
  grid: AccentSubdivision;
  selectedIdx: number | null;
  onSelect: (i: number) => void;
  onDelete: () => void;
  variantRatings: VariantRatings;
  onVariantRatingChange: (key: string, rating: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setContainerW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const STAR_COLORS = ["", "#e06060", "#e0a040", "#c8aa50", "#7aaa7a", "#7173e6"];


  if (measures.length === 0) return null;

  // Split measures into lines based on lineBreak flag
  const lines: { measure: AccentMeasureData; globalIdx: number }[][] = [[]];
  for (let i = 0; i < measures.length; i++) {
    if (measures[i].lineBreak && lines[lines.length - 1].length > 0) {
      lines.push([]);
    }
    lines[lines.length - 1].push({ measure: measures[i], globalIdx: i });
  }

  // Group consecutive lines that share a phraseId — one rating per group (shown on last line)
  const groupLeader: number[] = lines.map((_, i) => i);
  for (let i = 1; i < lines.length; i++) {
    const prevPid = lines[i - 1][0]?.measure.phraseId;
    const currPid = lines[i][0]?.measure.phraseId;
    if (prevPid && prevPid === currPid) groupLeader[i] = groupLeader[i - 1];
  }
  const isLastOfGroup = (lineIdx: number) =>
    lineIdx === lines.length - 1 || groupLeader[lineIdx + 1] !== groupLeader[lineIdx];

  return (
    <div ref={containerRef} style={{ display: "flex", flexDirection: "column", gap: 2, width: "100%" }}>
      {lines.map((line, lineIdx) => {
        const lineBeatData: StripMeasureData[] = [];
        // Track each measure's beat range (inclusive lo / exclusive hi) so we
        // can split overlays across row chunks below.
        const lineLayouts: { startBeat: number; endBeat: number; globalIdx: number }[] = [];
        let beatCursor = 0;

        // Count total beats in this line to compute dynamic width
        let totalBeatsInLine = 0;
        for (const { measure: m } of line) {
          if (m.beatSubdivs && m.beatSubdivs.length > 0) {
            totalBeatsInLine += m.beatSubdivs.length;
          } else {
            const mbs = slotsPerBeat(m.subdivision ?? grid);
            const dbs = m.useParadiddle ? mbs * 2 : mbs;
            const ts = m.displaySlots ?? m.stickings.length ?? dbs;
            totalBeatsInLine += Math.max(1, Math.round(ts / dbs));
          }
        }

        // Match the preview's beat-width formula so the line spacing is
        // identical to the live preview — rows are capped at 4 beats so the
        // denominator is min(totalBeats, 4), giving 175px when ≥4 beats are
        // shown and larger when fewer.
        const STAR_AREA = 420;
        const rowBeatDenom = Math.min(totalBeatsInLine, 4);
        const beatW = Math.max(100, Math.min(200, 700 / rowBeatDenom));

        for (let j = 0; j < line.length; j++) {
          const { measure: m, globalIdx } = line[j];

          // Mixed subdivision measures: use per-beat info
          if (m.beatSubdivs && m.beatSubdivs.length > 0) {
            const beatCount = m.beatSubdivs.length;
            lineLayouts.push({ startBeat: beatCursor, endBeat: beatCursor + beatCount, globalIdx });

            let cursor = 0;
            for (const beat of m.beatSubdivs) {
              const lo = cursor;
              const hi = cursor + beat.n;
              // Quarter-note beats: use 8th grid with 2 slots so the note renders as a quarter
              const isQuarter = beat.subdiv === "quarter" && beat.n === 1;
              const beatGrid = isQuarter ? "8th" as const : toRenderGrid(beat.subdiv as AccentSubdivision);
              const beatSlotOverride = isQuarter ? 2 : beat.n;
              const tupletNum = beat.subdiv === "triplet" ? 3
                : beat.subdiv === "quintuplet" ? 5
                : beat.subdiv === "sextuplet" ? 6
                : beat.subdiv === "septuplet" ? 7
                : undefined;
              lineBeatData.push({
                grid: beatGrid,
                ostinatoHits: [],
                ostinatoOpen: [],
                snareHits: isQuarter ? [0] : m.snareHits.filter(s => s >= lo && s < hi).map(s => s - lo),
                bassHits: m.bassHits.filter(s => s >= lo && s < hi).map(s => s - lo),
                hhFootHits: [],
                hhFootOpen: [],
                ghostHits: m.ghostHits.filter(s => s >= lo && s < hi).map(s => s - lo),
                ghostDoubleHits: [],
                tomHits: (m.tomHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
                crashHits: (m.crashHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
                accentFlags: m.accentFlags.slice(lo, hi),
                stickings: m.stickings.slice(lo, hi),
                slotOverride: beatSlotOverride,
                tupletNum,
                accentInterpretation: m.accentInterpretation,
                tapInterpretation: m.tapInterpretation,
                showRests: true,
                hideGhostParens: true,
                bassStemUp: true,
              });
              cursor = hi;
            }
            beatCursor += beatCount;
            continue;
          }

          const mSubdiv = m.subdivision ?? grid;
          const hasMeasureSplits = m.splitSlots && m.splitSlots.length > 0;
          const mRenderGrid = hasMeasureSplits ? "32nd" as const : toRenderGrid(mSubdiv);
          const mBeatSlots = hasMeasureSplits ? slotsPerBeat(mSubdiv) * 2 : slotsPerBeat(mSubdiv);
          const displayBeatSlots = m.useParadiddle ? mBeatSlots * 2 : mBeatSlots;
          const totalSlots = m.displaySlots ?? m.stickings.length ?? displayBeatSlots;
          const beatCount = Math.max(1, Math.round(totalSlots / displayBeatSlots));

          lineLayouts.push({ startBeat: beatCursor, endBeat: beatCursor + beatCount, globalIdx });

          for (let b = 0; b < beatCount; b++) {
            const lo = b * displayBeatSlots;
            const hi = lo + displayBeatSlots;
            lineBeatData.push({
              grid: mRenderGrid,
              ostinatoHits: [],
              ostinatoOpen: [],
              snareHits: m.snareHits.filter(s => s >= lo && s < hi).map(s => s - lo),
              bassHits: m.bassHits.filter(s => s >= lo && s < hi).map(s => s - lo),
              hhFootHits: [],
              hhFootOpen: [],
              ghostHits: m.ghostHits.filter(s => s >= lo && s < hi).map(s => s - lo),
              ghostDoubleHits: [],
              tomHits: (m.tomHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
              crashHits: (m.crashHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
              accentFlags: m.accentFlags.slice(lo, hi),
              stickings: m.stickings.slice(lo, hi),
              slotOverride: displayBeatSlots,
              accentInterpretation: m.accentInterpretation,
              tapInterpretation: m.tapInterpretation,
              showRests: true,
              hideGhostParens: true,
              bassStemUp: true,
            });
          }
          beatCursor += beatCount;
        }

        // Match the live preview's height/staveY rules so the line render looks
        // identical to the preview. Preview uses 240/70 when crashes are present,
        // 200/50 otherwise; we keep the tuplet-aware fallback for odd subdivisions.
        const hasTuplets = lineBeatData.some(d => d.tupletNum && d.tupletNum > 1);
        const hasCrashes = lineBeatData.some(d => d.crashHits && d.crashHits.length > 0);
        const lineH = hasCrashes ? 240 : (hasTuplets ? STRIP_MEASURE_H_TUPLET : 200);
        const lineStaveY = hasCrashes ? 70 : 50;

        // Split the line into rows of up to 4 beats (mirrors the preview's
        // 4-beat chunking), so a 7-beat line wraps into 4 + 3 instead of one
        // continuous strip.
        const ROW_BEATS = 4;
        const rowChunks: { data: StripMeasureData[]; rowStartBeat: number }[] = [];
        for (let rb = 0; rb < lineBeatData.length; rb += ROW_BEATS) {
          rowChunks.push({
            data: lineBeatData.slice(rb, rb + ROW_BEATS),
            rowStartBeat: rb,
          });
        }

        const lineMeasures = line.map(l => l.measure);

        return (
          <div key={lineIdx} style={{ display: "flex", alignItems: "flex-start", gap: 4, flexShrink: 0, width: "100%" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
              {rowChunks.map((row, rowIdx) => {
                const rowBeatCount = row.data.length;
                // VexDrumStrip always draws its own clef at the start of each
                // strip, so every row gets clef space.
                const rowW = STRIP_CLEF_EXTRA + rowBeatCount * beatW;
                return (
                  <div key={rowIdx} style={{ position: "relative", height: lineH, width: rowW, flexShrink: 0 }}>
                    <VexDrumStrip
                      measures={row.data}
                      measureWidth={beatW}
                      height={lineH}
                      staveY={lineStaveY}
                    />
                    {lineLayouts.map(({ startBeat, endBeat, globalIdx }) => {
                      // Clip the measure's beat range against this row's range.
                      const rowLo = row.rowStartBeat;
                      const rowHi = rowLo + rowBeatCount;
                      const lo = Math.max(startBeat, rowLo);
                      const hi = Math.min(endBeat, rowHi);
                      if (lo >= hi) return null;
                      // Beats start after the clef; overlay spans clipped beat range.
                      const x = STRIP_CLEF_EXTRA + (lo - rowLo) * beatW;
                      const w = (hi - lo) * beatW;
                      const isSel = selectedIdx === globalIdx;
                      return (
                        <div
                          key={globalIdx}
                          onClick={() => onSelect(globalIdx)}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: x,
                            width: w,
                            height: lineH,
                            cursor: "pointer",
                            border: isSel ? "1.5px solid #aa6633" : "1.5px solid transparent",
                            borderRadius: 4,
                            boxSizing: "border-box",
                          }}
                        >
                          {isSel && lo === startBeat && (
                            <button
                              onClick={(e) => { e.stopPropagation(); onDelete(); }}
                              style={{
                                position: "absolute",
                                top: 4,
                                right: 4,
                                width: 16,
                                height: 16,
                                borderRadius: "50%",
                                background: "#3a1a1a",
                                border: "1px solid #6a3a3a",
                                color: "#e06060",
                                fontSize: 9,
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            {/* Interpretation variant badges with per-variant star ratings — one per phrase group */}
            <div style={{
              display: "flex", flexDirection: "column", gap: 3,
              flexShrink: 0, marginLeft: "auto",
              width: STAR_AREA - 4,
              visibility: isLastOfGroup(lineIdx) ? "visible" : "hidden",
            }}>
              {/* Accent variants */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "#666", fontSize: 10, width: 30, textAlign: "right", fontWeight: 600 }}>Acc</span>
                {ACCENT_VARIANTS.map(v => {
                  const rKey = `${groupLeader[lineIdx]}:${v.key}`;
                  const r = variantRatings[rKey] ?? 0;
                  return (
                    <div key={v.key} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <span title={v.label} style={{
                        display: "inline-block", width: 20, height: 20, lineHeight: "20px",
                        textAlign: "center", borderRadius: 3, fontSize: 11, fontWeight: 700,
                        background: r > 0 ? `${STAR_COLORS[r]}22` : "#1a1a1a",
                        color: r > 0 ? STAR_COLORS[r] : "#444",
                        border: `1px solid ${r > 0 ? `${STAR_COLORS[r]}44` : "#252525"}`,
                      }}>{v.letter}</span>
                        <div style={{ display: "flex", gap: 0 }}>
                          {[1, 2, 3, 4, 5].map(star => (
                            <button key={star}
                              onClick={() => onVariantRatingChange(rKey, r === star ? 0 : star)}
                              title={["", "Hard", "Tough", "OK", "Good", "Easy"][star]}
                              style={{
                                background: "none", border: "none", cursor: "pointer",
                                fontSize: 13, padding: "0 1px", lineHeight: 1,
                                color: star <= r ? STAR_COLORS[r] : "#1a1a1a",
                              }}
                            >★</button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Tap variants */}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "#666", fontSize: 10, width: 30, textAlign: "right", fontWeight: 600 }}>Tap</span>
                {TAP_VARIANTS.map(v => {
                  const rKey = `${groupLeader[lineIdx]}:${v.key}`;
                  const r = variantRatings[rKey] ?? 0;
                  return (
                    <div key={v.key} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <span title={v.label} style={{
                        display: "inline-block", width: 20, height: 20, lineHeight: "20px",
                        textAlign: "center", borderRadius: 3, fontSize: 11, fontWeight: 700,
                        background: r > 0 ? `${STAR_COLORS[r]}22` : "#1a1a1a",
                        color: r > 0 ? STAR_COLORS[r] : "#444",
                        border: `1px solid ${r > 0 ? `${STAR_COLORS[r]}44` : "#252525"}`,
                      }}>{v.letter}</span>
                      <div style={{ display: "flex", gap: 0 }}>
                        {[1, 2, 3, 4, 5].map(star => (
                          <button key={star}
                            onClick={() => onVariantRatingChange(rKey, r === star ? 0 : star)}
                            title={["", "Hard", "Tough", "OK", "Good", "Easy"][star]}
                            style={{
                              background: "none", border: "none", cursor: "pointer",
                              fontSize: 13, padding: "0 1px", lineHeight: 1,
                              color: star <= r ? STAR_COLORS[r] : "#1a1a1a",
                            }}
                          >★</button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const LOG_MEASURE_W = 260;
const LOG_MEASURE_H = 200;

function AccentLogPreview({ ex }: { ex: AccentExercise }) {
  const renderGrid = toRenderGrid(ex.subdivision);
  const stripData: StripMeasureData[] = ex.measures.map((m) => ({
    grid: renderGrid,
    ostinatoHits: [],
    ostinatoOpen: [],
    snareHits: m.snareHits,
    bassHits: m.bassHits,
    hhFootHits: [],
    hhFootOpen: [],
    ghostHits: m.ghostHits ?? [],
    ghostDoubleHits: [],
    tomHits: m.tomHits ?? [],
    accentFlags: m.accentFlags,
    stickings: m.stickings,
    slotOverride: m.displaySlots,
    accentInterpretation: m.accentInterpretation,
    tapInterpretation: m.tapInterpretation,
    showRests: true,
    hideGhostParens: true,
    bassStemUp: true,
  }));
  if (stripData.length === 0) return null;
  return (
    <div style={{ overflowX: "auto", marginTop: 6 }}>
      <VexDrumStrip
        measures={stripData}
        measureWidth={LOG_MEASURE_W}
        height={LOG_MEASURE_H}
        fullBar={true}
        staveY={5}
      />
    </div>
  );
}

type AccentFilter = AccentInterpretation | "normal" | "all";
type TapFilter = TapInterpretation | "normal" | "all";

function AccentLogModal({
  onClose,
  onLoad,
}: {
  onClose: () => void;
  onLoad: (ex: AccentExercise) => void;
}) {
  const [log, setLog] = useState<AccentExercise[]>(() => loadAccentLog());
  const [accentFilter, setAccentFilter] = useState<AccentFilter>("all");
  const [tapFilter, setTapFilter] = useState<TapFilter>("all");

  function handleDelete(id: string) {
    deleteAccentExercise(id);
    setLog(loadAccentLog());
  }

  // Derive which accent/tap values exist in the log for showing only relevant pills
  const hasAccent = (v: AccentFilter) =>
    v === "all" || log.some(ex => {
      const a = ex.accentInterpretation ?? ex.measures[0]?.accentInterpretation;
      return v === "normal" ? !a : a === v;
    });
  const hasTap = (v: TapFilter) =>
    v === "all" || log.some(ex => {
      const t = ex.tapInterpretation ?? ex.measures[0]?.tapInterpretation;
      return v === "normal" ? !t : t === v;
    });

  const filtered = log.filter(ex => {
    const a = ex.accentInterpretation ?? ex.measures[0]?.accentInterpretation;
    const t = ex.tapInterpretation ?? ex.measures[0]?.tapInterpretation;
    const matchA = accentFilter === "all" || (accentFilter === "normal" ? !a : a === accentFilter);
    const matchT = tapFilter === "all" || (tapFilter === "normal" ? !t : t === tapFilter);
    return matchA && matchT;
  });

  const pillStyle = (active: boolean, color: string): React.CSSProperties => ({
    padding: "2px 7px",
    borderRadius: 4,
    fontSize: 9,
    fontWeight: 600,
    cursor: "pointer",
    border: `1px solid ${active ? color + "88" : "#1a1a1a"}`,
    background: active ? color + "22" : "#0e0e0e",
    color: active ? color : "#444",
    whiteSpace: "nowrap",
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "#0e0e0e",
          border: "1px solid #2a2a2a",
          borderRadius: 8,
          width: 920,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid #1a1a1a",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#666",
              letterSpacing: 4,
            }}
          >
            ACCENT STUDIES
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "#555",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
        {/* Filter pills */}
        <div style={{ padding: "6px 14px 2px", borderBottom: "1px solid #1a1a1a", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 8, color: "#555", fontWeight: 700, letterSpacing: 2 }}>ACCENT</span>
            <div style={{ display: "flex", gap: 3 }}>
              <button onClick={() => setAccentFilter("all")} style={pillStyle(accentFilter === "all", "#888")}>All</button>
              {hasAccent("normal") && (
                <button onClick={() => setAccentFilter("normal")} style={pillStyle(accentFilter === "normal", "#aaa")}>Normal</button>
              )}
              {(Object.keys(ACCENT_INTERPRETATION_LABELS) as AccentInterpretation[]).filter(k => hasAccent(k)).map(k => (
                <button key={k} onClick={() => setAccentFilter(k)} style={pillStyle(accentFilter === k, "#c8aa50")}>
                  {ACCENT_INTERPRETATION_LABELS[k]}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 8, color: "#555", fontWeight: 700, letterSpacing: 2, marginLeft: 8 }}>TAP</span>
            <div style={{ display: "flex", gap: 3 }}>
              <button onClick={() => setTapFilter("all")} style={pillStyle(tapFilter === "all", "#888")}>All</button>
              {hasTap("normal") && (
                <button onClick={() => setTapFilter("normal")} style={pillStyle(tapFilter === "normal", "#aaa")}>Normal</button>
              )}
              {(Object.keys(TAP_INTERPRETATION_LABELS) as TapInterpretation[]).filter(k => hasTap(k)).map(k => (
                <button key={k} onClick={() => setTapFilter(k)} style={pillStyle(tapFilter === k, "#7173e6")}>
                  {TAP_INTERPRETATION_LABELS[k]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 14px" }}>
          {filtered.length === 0 && (
            <div
              style={{
                fontSize: 10,
                color: "#333",
                textAlign: "center",
                padding: "24px 0",
              }}
            >
              {log.length === 0 ? "No saved accent studies yet." : "No studies match these filters."}
            </div>
          )}
          {filtered.map((ex) => (
            <div
              key={ex.id}
              style={{
                marginBottom: 10,
                padding: "8px 10px",
                borderRadius: 5,
                border: "1px solid #1a1a1a",
                background: "#0c0c0c",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 4,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#ddd",
                      letterSpacing: 0.3,
                    }}
                  >
                    {ex.name || "Untitled"}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {ex.rating > 0 && (
                      <span
                        style={{
                          fontSize: 9,
                          padding: "1px 5px",
                          borderRadius: 3,
                          background: "#1a1a1a",
                          color: RATING_COLORS[ex.rating],
                        }}
                      >
                        {RATING_LABELS[ex.rating]}
                      </span>
                    )}
                    <span style={{ fontSize: 9, color: "#444" }}>
                      {ex.date}
                    </span>
                    <span style={{ fontSize: 9, color: "#444" }}>
                      {ex.subdivision} · {groupingLabel(ex.grouping)}
                    </span>
                    {(ex.accentInterpretation || ex.measures[0]?.accentInterpretation) && (
                      <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: "#1a1a0e", color: "#c8aa50", border: "1px solid #3a3a1a" }}>
                        A: {ACCENT_INTERPRETATION_LABELS[(ex.accentInterpretation ?? ex.measures[0]?.accentInterpretation) as AccentInterpretation]}
                      </span>
                    )}
                    {(ex.tapInterpretation || ex.measures[0]?.tapInterpretation) && (
                      <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: "#0e0e1a", color: "#7173e6", border: "1px solid #1a1a3a" }}>
                        T: {TAP_INTERPRETATION_LABELS[(ex.tapInterpretation ?? ex.measures[0]?.tapInterpretation) as TapInterpretation]}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => handleDelete(ex.id)}
                    title="Delete study"
                    aria-label="Delete study"
                    style={{
                      padding: "2px 7px",
                      background: "#1a0e0e",
                      border: "1px solid #5a2a2a",
                      color: "#c05050",
                      borderRadius: 4,
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    ✕
                  </button>
                  <button
                    onClick={() => onLoad(ex)}
                    style={{
                      padding: "2px 8px",
                      background: "#1a1a0e",
                      border: "1px solid #6a5a2a",
                      color: "#c8aa50",
                      borderRadius: 4,
                      fontSize: 9,
                      cursor: "pointer",
                    }}
                  >
                    Load
                  </button>
                </div>
              </div>
              <AccentLogPreview ex={ex} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export interface AccentStudyStripProps {
  measures: AccentMeasureData[];
  grid: AccentSubdivision;
  selectedIdx: number | null;
  onSelect: (i: number) => void;
  onDelete: () => void;
  onClearAll: () => void;
  onLog?: (entries: { variant: string; rating: number; measures: AccentMeasureData[]; lineIdx: number }[], tag?: string) => void;
}

export function AccentStudyStrip({
  measures,
  grid,
  selectedIdx,
  onSelect,
  onDelete,
  onClearAll,
  onLog,
}: AccentStudyStripProps) {
  const [variantRatings, setVariantRatings] = useState<VariantRatings>({});
  const [flash, setFlash] = useState("");
  const [saving, setSaving] = useState(false);
  const [tag, setTag] = useState<"isolation" | "context">("isolation");

  const handleVariantRatingChange = useCallback((key: string, rating: number) => {
    setVariantRatings(prev => ({ ...prev, [key]: rating }));
  }, []);

  const lines = useMemo(() => {
    const result: AccentMeasureData[][] = [[]];
    for (const m of measures) {
      if (m.lineBreak && result[result.length - 1].length > 0) result.push([]);
      result[result.length - 1].push(m);
    }
    return result;
  }, [measures]);

  // Leader line idx per line — lines sharing a phraseId share a leader.
  // The rating key for any line in a group is `${leader}:${variantKey}`.
  const groupLeader = useMemo(() => {
    const leaders = lines.map((_, i) => i);
    for (let i = 1; i < lines.length; i++) {
      const prevPid = lines[i - 1][0]?.phraseId;
      const currPid = lines[i][0]?.phraseId;
      if (prevPid && prevPid === currPid) leaders[i] = leaders[i - 1];
    }
    return leaders;
  }, [lines]);

  const handleLog = useCallback(() => {
    const entries: { variant: string; rating: number; measures: AccentMeasureData[]; lineIdx: number }[] = [];
    for (const [key, rating] of Object.entries(variantRatings)) {
      if (rating <= 0) continue;
      const [lineStr, variantKey] = key.split(":");
      const leaderIdx = parseInt(lineStr, 10);
      if (isNaN(leaderIdx) || !lines[leaderIdx]) continue;
      const accV = ACCENT_VARIANTS.find(v => v.key === variantKey);
      const tapV = TAP_VARIANTS.find(v => v.key === variantKey);
      const label = accV?.label ?? tapV?.label ?? variantKey;
      // Combine all lines in the phrase group (leader + any following lines sharing the group)
      const groupMeasures = lines
        .filter((_, i) => groupLeader[i] === leaderIdx)
        .flat();
      // Stamp the interpretation onto the measures snapshot
      const stampedMeasures = groupMeasures.map(m => ({
        ...m,
        accentInterpretation: accV ? (accV.field ?? undefined) : m.accentInterpretation,
        tapInterpretation: tapV ? (tapV.field ?? undefined) : m.tapInterpretation,
      }));
      entries.push({ variant: label, rating, measures: stampedMeasures, lineIdx: leaderIdx });
    }
    if (entries.length === 0) return;
    setSaving(true);
    onLog?.(entries, tag);
    setSaving(false);
    setFlash(`Logged ${entries.length}!`);
    setTimeout(() => setFlash(""), 2000);
  }, [variantRatings, lines, groupLeader, onLog, tag]);

  const ratedCount = Object.values(variantRatings).filter(r => r > 0).length;

  return (
    <div style={{ flexShrink: 0, borderTop: "1px solid #181818" }}>
      <div style={{ padding: "4px 12px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 9, color: "#c8aa50", fontWeight: 700, letterSpacing: 4, textTransform: "uppercase" }}>
            Accent Study {measures.length > 0 && `(${measures.length})`}
          </span>
          {measures.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <select
                value={tag}
                onChange={e => setTag(e.target.value as "isolation" | "context")}
                style={{
                  background: "#141414",
                  border: `1px solid ${tag === "isolation" ? "#e0a040" : "#7aaa7a"}44`,
                  borderRadius: 4,
                  padding: "2px 6px",
                  fontSize: 9,
                  color: tag === "isolation" ? "#e0a040" : "#7aaa7a",
                  outline: "none",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <option value="isolation">Isolation</option>
                <option value="context">Context</option>
              </select>
              <button onClick={handleLog} disabled={saving || ratedCount === 0} style={{
                padding: "2px 8px", background: saving ? "#1a2a1a" : "#0e1a0e",
                border: "1px solid #2a5a2a", color: saving ? "#7aaa7a" : ratedCount > 0 ? "#5a9a5a" : "#2a3a2a",
                borderRadius: 4, fontSize: 9, fontWeight: 600,
                cursor: (saving || ratedCount === 0) ? "default" : "pointer", letterSpacing: 1,
              }}>
                {saving ? "\u2026" : ratedCount > 0 ? `+ LOG (${ratedCount})` : "+ LOG"}
              </button>
              {flash && <span style={{ fontSize: 8, color: "#7aaa7a", letterSpacing: 1 }}>{flash}</span>}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {measures.length === 0 && <span style={{ fontSize: 9, color: "#2a2a2a" }}>Generate an accent pattern below</span>}
          {measures.length > 0 && (
            <button onClick={onClearAll} style={{ fontSize: 9, color: "#3a3a3a", background: "none", border: "none", cursor: "pointer" }}>Clear all</button>
          )}
        </div>
      </div>
      <div style={{ overflowX: "auto", display: "flex", justifyContent: "center", padding: "6px 16px 10px", minHeight: STRIP_MEASURE_H + 20, alignItems: "flex-start" }}>
        {measures.length > 0 ? (
          <AccentStrip measures={measures} grid={grid} selectedIdx={selectedIdx} onSelect={onSelect} onDelete={onDelete}
            variantRatings={variantRatings} onVariantRatingChange={handleVariantRatingChange} />
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", fontSize: 10, color: "#1e1e1e" }}>
            No accent measures yet
          </div>
        )}
      </div>
    </div>
  );
}

export default function AccentStudy({
  accentMeasures,
  setAccentMeasures,
  accentGrid,
  setAccentGrid,
  accentSelectedIdx,
  setAccentSelectedIdx,
}: {
  accentMeasures: AccentMeasureData[];
  setAccentMeasures: React.Dispatch<React.SetStateAction<AccentMeasureData[]>>;
  accentGrid: AccentSubdivision;
  setAccentGrid: (g: AccentSubdivision) => void;
  accentSelectedIdx: number | null;
  setAccentSelectedIdx: (i: number | null) => void;
}) {
  // Lazy-load ComposedStudyBrowser — private file, gitignored.
  // Only appears in local dev; absent on public GitHub builds.
  const [ComposedBrowser, setComposedBrowser] = useState<ComponentType<{
    onImportMeasures: (measures: AccentMeasureData[], mode: "phrase" | "line", grid: AccentSubdivision) => void;
  }> | null>(null);
  useEffect(() => {
    const loaders = import.meta.glob("./ComposedStudyBrows*.tsx");
    const loader = loaders["./ComposedStudyBrowser.tsx"];
    if (loader) {
      loader().then((m: any) => setComposedBrowser(() => m.default)).catch(() => {});
    }
  }, []);
  const [accentTab, setAccentTab] = useState<"generator" | "composed">("generator");
  const [beats, setBeats] = useState<AccentBeatCount>(4);
  const [patternMode, setPatternMode] = useState<"musical" | "awkward" | "both">("musical");
  const [startMode, setStartMode] = useState<StartMode>("accent");
  const [accentInterpretation, setAccentInterpretation] =
    useState<AccentInterpretation | null>(null);
  const [tapInterpretation, setTapInterpretation] =
    useState<TapInterpretation | null>(null);
  const [allowOdd, setAllowOdd] = useState(false);
  const [allowEven, setAllowEven] = useState(false);
  const [useParadiddle, setUseParadiddle] = useState(false);
  const [useSingle, setUseSingle] = useState(true);
  const [biasR, setBiasR] = useState(true);
  const [bassOption, setBassOption] = useState<BassOption>("none");
  const [orchestration, setOrchestration] =
    useState<Orchestration>("snare");
  const [grouping, setGrouping] = useState<number[]>([4, 4, 4, 4]);
  const [accents, setAccents] = useState<boolean[]>([]);
  const [rating, setRating] = useState(0);
  const [exerciseName, setExerciseName] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const [seenGroupings, setSeenGroupings] = useState<number[][]>([]);

  const slotCount = calcTotalSlots(accentGrid, beats);
  const [customInput, setCustomInput] = useState("");
  const [customError, setCustomError] = useState("");
  const [autoCalcBeats, setAutoCalcBeats] = useState(false);

  /** Apply a custom grouping string. If autoCalcBeats is on, derive `beats`
   *  from the sum instead of requiring the input to match the current slotCount. */
  const applyCustomGrouping = useCallback(() => {
    if (!autoCalcBeats) {
      const parsed = parseCustomGrouping(customInput, slotCount);
      if (parsed) { setGrouping(parsed); setCustomError(""); }
      else setCustomError(`must sum to ${slotCount}`);
      return;
    }
    const parts = customInput
      .split(/[-,+\s]+/)
      .map(s => parseInt(s, 10))
      .filter(n => !isNaN(n) && n > 0);
    if (parts.length === 0) { setCustomError("enter a grouping"); return; }
    const sum = parts.reduce((a, b) => a + b, 0);
    const spb = slotsPerBeat(accentGrid);
    if (sum % spb !== 0) {
      setCustomError(`sum ${sum} not divisible by ${spb}`);
      return;
    }
    const derived = sum / spb;
    if (derived < 1 || derived > 8) {
      setCustomError(`needs ${derived} beats (1–8)`);
      return;
    }
    setBeats(derived as AccentBeatCount);
    setGrouping(parts);
    setCustomError("");
  }, [autoCalcBeats, customInput, slotCount, accentGrid]);
  const [restSlots, setRestSlots] = useState<Set<number>>(new Set());
  const [splitSlots, setSplitSlots] = useState<Set<number>>(new Set());

  // Reset rest/split when grid or beats change
  useEffect(() => { setRestSlots(new Set()); setSplitSlots(new Set()); }, [accentGrid, beats]);

  const regenAccents = useCallback(
    (grp: number[], mode: StartMode) => {
      setAccents(groupingToAccents(grp, mode));
    },
    [],
  );

  useEffect(() => {
    regenAccents(grouping, startMode);
  }, [grouping, startMode, regenAccents]);

  // Choose generator based on patternMode.
  const pickGrouping = useCallback(
    (exclude: number[]) => {
      const useAwkward = patternMode === "awkward" || (patternMode === "both" && Math.random() < 0.5);
      let result: number[];
      if (useAwkward) result = generateAwkwardGrouping(accentGrid, beats, exclude, seenGroupings);
      else if (useSingle && !allowOdd && !allowEven) result = generateFreeGrouping(accentGrid, beats, exclude, seenGroupings);
      else result = generateConstrainedGrouping(accentGrid, beats, allowOdd, allowEven, exclude, seenGroupings);
      setSeenGroupings(prev => [...prev, result]);
      return result;
    },
    [patternMode, useSingle, allowOdd, allowEven, accentGrid, beats, seenGroupings],
  );

  // Track the previous "sticking-is-Single" state so we can detect the
  // Single → (Odd/Even/Paradiddle) transition and preserve the user's
  // existing pattern instead of regenerating.
  const prevIsSingleRef = useRef(useSingle && !useParadiddle && !allowOdd && !allowEven);

  useEffect(() => {
    const isSingle = useSingle && !useParadiddle && !allowOdd && !allowEven;
    const wasSingle = prevIsSingleRef.current;
    prevIsSingleRef.current = isSingle;

    // Single → (Odd/Even/Paradiddle): keep the current grouping.  Any
    // grouping is a valid single-stroke grouping, and the sticking
    // interpretation handles fall-back when it doesn't fit the new
    // constraint (see activeSticking + stickingWarning below).
    if (wasSingle && !isSingle) return;

    setGrouping(pickGrouping(grouping));
  }, [accentGrid, beats, allowOdd, allowEven, useSingle, useParadiddle]);

  // Regenerate when pattern mode changes
  useEffect(() => {
    setGrouping(prev => pickGrouping(prev));
  }, [patternMode]);

  const handleGenerate = () => {
    setGrouping(pickGrouping(grouping));
  };

  const handleRegenAccents = () => {
    regenAccents(grouping, startMode);
  };

  const normalResolved = useMemo(
    () => resolveAccentHits(accents, bassOption),
    [accents, bassOption],
  );

  const paradiddleResolved = useMemo(
    () => useParadiddle ? paradiddleExpand(accents, grouping, bassOption, biasR) : null,
    [useParadiddle, accents, grouping, bassOption, biasR],
  );

  const allSnareHits  = useParadiddle ? paradiddleResolved!.snareHits  : normalResolved.snareHits;
  const allGhostHits  = useParadiddle ? paradiddleResolved!.ghostHits  : normalResolved.ghostHits;
  const allBassHits   = useParadiddle ? paradiddleResolved!.bassHits   : normalResolved.bassHits;
  const allAccentFlags = useParadiddle ? paradiddleResolved!.accentFlags : normalResolved.accentFlags;
  const displaySlots  = useParadiddle ? slotCount * 2 : slotCount;

  const orchResult = useMemo(
    () => applyOrchestration(allSnareHits, allAccentFlags, orchestration),
    [allSnareHits, allAccentFlags, orchestration],
  );
  const orchSnareHits = orchResult.snareHits;
  const orchTomHits   = orchResult.tomHits;
  const orchCrashHits = orchResult.crashHits;

  const renderGrid = toRenderGrid(accentGrid);
  const beatSlots = slotsPerBeat(accentGrid);

  // Check whether the CURRENT grouping is compatible with the selected
  // sticking constraint.  Odd-only wants every group to be odd-sized;
  // Even-only wants every group to be even-sized.  If the current grouping
  // mixes sizes, keep the single-stroke interpretation until the user also
  // enables the complementary constraint — the user's pattern stays intact.
  const onlyOddSelected  = allowOdd  && !allowEven;
  const onlyEvenSelected = allowEven && !allowOdd;
  const groupingHasEven = grouping.some(g => g % 2 === 0);
  const groupingHasOdd  = grouping.some(g => g % 2 === 1);
  const oddIncompatible  = onlyOddSelected  && groupingHasEven;
  const evenIncompatible = onlyEvenSelected && groupingHasOdd;
  const stickingWarning: string | null =
    oddIncompatible
      ? "Pattern has even-sized groups — enable Even too to play odd/even sticking. Falling back to single strokes."
      : evenIncompatible
      ? "Pattern has odd-sized groups — enable Odd too to play odd/even sticking. Falling back to single strokes."
      : null;

  const activeSticking: Sticking = useParadiddle ? "paradiddle"
    : useSingle ? "single"
    : (oddIncompatible || evenIncompatible) ? "single"
    : allowOdd && !allowEven ? "odd"
    : allowEven && !allowOdd ? "even"
    : "odd";

  const normalStickings = useMemo(
    () => generateStickings(
      beatSlots * beats,
      activeSticking,
      grouping,
      biasR,
    ),
    [beatSlots, beats, activeSticking, grouping, biasR],
  );

  const allStickings  = useParadiddle ? paradiddleResolved!.stickings  : normalStickings;
  const displayBeatSlots = useParadiddle ? beatSlots * 2 : beatSlots;

  // Apply rest/split modifications to build expanded arrays
  // When splits exist, each original slot maps to 2 positions in a 32nd grid.
  // Unsplit slots occupy position [2*i] only; split slots occupy [2*i] and [2*i+1].
  const hasSplits = splitSlots.size > 0;
  const modified = useMemo(() => {
    const totalDisplay = displayBeatSlots * beats;
    if (!hasSplits) {
      // No splits — just apply rests by removing from hit arrays
      const filterRests = (hits: number[]): number[] =>
        hits.filter(h => !restSlots.has(h));
      return {
        snareHits: filterRests(orchSnareHits),
        ghostHits: filterRests(allGhostHits),
        bassHits: filterRests(allBassHits),
        tomHits: filterRests(orchTomHits),
        crashHits: filterRests(orchCrashHits),
        accentFlags: [...allAccentFlags],
        stickings: [...allStickings],
        expandTotal: totalDisplay,
        perBeatSlots: Array.from({ length: beats }, () => displayBeatSlots),
      };
    }
    // Splits exist → expand to 32nd grid (each original slot = 2 positions)
    const expandTotal = totalDisplay * 2;
    const remapHits = (hits: number[]): number[] => {
      const out: number[] = [];
      for (const h of hits) {
        if (restSlots.has(h)) continue;
        out.push(h * 2); // first 32nd position
        if (splitSlots.has(h)) out.push(h * 2 + 1); // second 32nd position
      }
      return out;
    };
    // Expand boolean/string arrays to 32nd grid
    const expandBools = (arr: boolean[]): boolean[] => {
      const out: boolean[] = [];
      for (let i = 0; i < totalDisplay; i++) {
        out.push(arr[i] ?? false);
        // Second 32nd note of a split never gets the accent
        out.push(false);
      }
      return out;
    };
    const expandStrings = (arr: string[]): string[] => {
      const out: string[] = [];
      for (let i = 0; i < totalDisplay; i++) {
        out.push(arr[i] ?? "");
        out.push(splitSlots.has(i) ? (arr[i] ?? "") : "");
      }
      return out;
    };
    return {
      snareHits: remapHits(orchSnareHits),
      ghostHits: remapHits(allGhostHits),
      bassHits: remapHits(allBassHits),
      tomHits: remapHits(orchTomHits),
      crashHits: remapHits(orchCrashHits),
      accentFlags: expandBools(allAccentFlags),
      stickings: expandStrings(allStickings),
      expandTotal,
      perBeatSlots: Array.from({ length: beats }, () => displayBeatSlots * 2),
    };
  }, [orchSnareHits, allGhostHits, allBassHits, orchTomHits, orchCrashHits, allAccentFlags, allStickings, displayBeatSlots, beats, restSlots, splitSlots, hasSplits]);

  // When splits exist, use 32nd grid so VexFlow renders 32nd-note beaming
  const effectiveGrid = hasSplits ? "32nd" as const : renderGrid;

  const previewStripData: StripMeasureData[] = useMemo(() => {
    const beatMeasures: StripMeasureData[] = [];
    let cursor = 0;
    for (let b = 0; b < beats; b++) {
      const bSlots = modified.perBeatSlots[b];
      const lo = cursor;
      const hi = cursor + bSlots;
      beatMeasures.push({
        grid: effectiveGrid,
        ostinatoHits: [],
        ostinatoOpen: [],
        snareHits: modified.snareHits.filter(i => i >= lo && i < hi).map(i => i - lo),
        bassHits: modified.bassHits.filter(i => i >= lo && i < hi).map(i => i - lo),
        hhFootHits: [],
        hhFootOpen: [],
        ghostHits: modified.ghostHits.filter(i => i >= lo && i < hi).map(i => i - lo),
        ghostDoubleHits: [],
        tomHits: modified.tomHits.filter(i => i >= lo && i < hi).map(i => i - lo),
        crashHits: modified.crashHits.filter(i => i >= lo && i < hi).map(i => i - lo),
        accentFlags: modified.accentFlags.slice(lo, hi),
        stickings: modified.stickings.slice(lo, hi),
        slotOverride: bSlots,
        accentInterpretation: accentInterpretation ?? undefined,
        tapInterpretation: tapInterpretation ?? undefined,
        showRests: true,
        hideGhostParens: true,
        bassStemUp: true,
      });
      cursor = hi;
    }
    return beatMeasures;
  }, [modified, effectiveGrid, beats, accentInterpretation, tapInterpretation]);

  const buildMeasure = useCallback(
    (): AccentMeasureData => ({
      snareHits: [...modified.snareHits],
      ghostHits: [...modified.ghostHits],
      bassHits: [...modified.bassHits],
      tomHits: [...modified.tomHits],
      crashHits: [...modified.crashHits],
      accentFlags: [...modified.accentFlags],
      stickings: [...modified.stickings],
      grouping: [...grouping],
      startMode,
      accentInterpretation: accentInterpretation ?? undefined,
      tapInterpretation: tapInterpretation ?? undefined,
      sticking: activeSticking,
      allowOdd,
      allowEven,
      useParadiddle,
      useSingle,
      biasR,
      bassOption,
      orchestration,
      displaySlots: modified.expandTotal,
      restSlots: restSlots.size > 0 ? [...restSlots] : undefined,
      splitSlots: splitSlots.size > 0 ? [...splitSlots] : undefined,
      subdivision: accentGrid,
    }),
    [
      modified,
      grouping,
      startMode,
      accentInterpretation,
      tapInterpretation,
      allowOdd,
      allowEven,
      useParadiddle,
      useSingle,
      biasR,
      bassOption,
      orchestration,
      restSlots,
      splitSlots,
      accentGrid,
    ],
  );

  const handleAdd = (lineBreak?: boolean) => {
    const m = buildMeasure();
    if (lineBreak) m.lineBreak = true;
    setAccentMeasures((prev) => [...prev, m]);
    setAccentSelectedIdx(null);
  };

  const handleReplace = () => {
    if (accentSelectedIdx === null) return;
    setAccentMeasures((prev) =>
      prev.map((m, i) => (i === accentSelectedIdx ? buildMeasure() : m)),
    );
  };

  const handleSave = () => {
    saveAccentExercise({
      id: Date.now().toString(),
      name: exerciseName,
      date: localToday(),
      subdivision: accentGrid,
      beats,
      measures: [...accentMeasures],
      rating,
      grouping: [...grouping],
      startMode,
      accentInterpretation: accentInterpretation ?? undefined,
      tapInterpretation: tapInterpretation ?? undefined,
      sticking: activeSticking,
      allowOdd,
      allowEven,
      useParadiddle,
      useSingle,
      biasR,
      bassOption,
      orchestration,
    });
    setSavedMsg(true);
    setTimeout(() => setSavedMsg(false), 2000);
  };

  const handleLoadExercise = (ex: AccentExercise) => {
    setAccentGrid(ex.subdivision);
    const legacyBeats = (ex as unknown as { length?: number }).length;
    setBeats(((ex.beats ?? legacyBeats ?? 4) as AccentBeatCount));
    setGrouping(ex.grouping);
    setStartMode(ex.startMode);
    // Backward compat: map legacy single interpretation to split fields
    const legacyInterp = ex.interpretation as Interpretation | undefined;
    if (ex.accentInterpretation) {
      setAccentInterpretation(ex.accentInterpretation);
    } else if (legacyInterp === "accent-flam" || legacyInterp === "accent-double") {
      setAccentInterpretation(legacyInterp);
    } else {
      setAccentInterpretation(null);
    }
    if (ex.tapInterpretation) {
      setTapInterpretation(ex.tapInterpretation);
    } else if (legacyInterp === "tap-buzz" || legacyInterp === "tap-flam" || legacyInterp === "tap-double") {
      setTapInterpretation(legacyInterp);
    } else {
      setTapInterpretation(null);
    }
    // Load new sticking flags; fall back gracefully for legacy exercises
    if (ex.allowOdd !== undefined || ex.allowEven !== undefined || ex.useParadiddle !== undefined || ex.useSingle !== undefined) {
      setAllowOdd(ex.allowOdd ?? false);
      setAllowEven(ex.allowEven ?? false);
      setUseParadiddle(ex.useParadiddle ?? false);
      setUseSingle(ex.useSingle ?? false);
    } else {
      const legacySticking = ex.sticking ?? "single";
      setUseParadiddle(legacySticking === "paradiddle");
      setUseSingle(legacySticking !== "paradiddle");
      setAllowOdd(false);
      setAllowEven(false);
    }
    setBiasR(ex.biasR ?? true);
    const loadedBass = ex.bassOption;
    setBassOption(loadedBass === "none" || loadedBass === "replace-accents" || loadedBass === "replace-taps" ? loadedBass : "none");
    setOrchestration(ex.orchestration);
    setAccentMeasures(ex.measures);
    setRating(ex.rating);
    setExerciseName(ex.name);
    setAccentSelectedIdx(null);
    setShowLog(false);
  };

  // Stable import handler — uses refs to avoid stale closures
  const gridRef = useRef(accentGrid);
  gridRef.current = accentGrid;
  const handleComposedImport = useCallback((measures: AccentMeasureData[], mode: "phrase" | "line", grid: AccentSubdivision) => {
    const hasGridDependent = accentMeasures.some(m => !m.beatSubdivs || m.beatSubdivs.length === 0);
    if (grid !== gridRef.current && !hasGridDependent) setAccentGrid(grid);
    const autoSplit = measures.length > 2;
    const phraseId  = autoSplit ? `p${Date.now()}_${Math.random().toString(36).slice(2, 7)}` : undefined;
    const incoming = measures.map((m, i) => {
      const isFirstOfImport = i === 0;
      const startsNewPair   = i > 0 && i % 2 === 0;
      const shouldBreak     =
        (mode === "line" && isFirstOfImport) ||
        (autoSplit && startsNewPair);
      const out: AccentMeasureData = shouldBreak ? { ...m, lineBreak: true as const } : { ...m };
      if (phraseId) out.phraseId = phraseId;
      return out;
    });
    setAccentMeasures(prev => [...prev, ...incoming]);
  }, [accentMeasures, setAccentGrid, setAccentMeasures]);

  const accentColor = "#c8aa50";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#0c0c0c",
        overflow: "hidden",
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          padding: "8px 12px",
          borderBottom: "1px solid #181818",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 4,
            color: accentColor,
            textTransform: "uppercase",
            marginRight: 4,
          }}
        >
          Accent Study
        </span>

        {ComposedBrowser && (
          <div style={{ display: "flex", gap: 2, marginRight: 8 }}>
            {(["generator", "composed"] as const).map(tab => {
              const isActive = accentTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setAccentTab(tab)}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 3,
                    border: isActive ? `1px solid ${accentColor}66` : "1px solid #1a1a1a",
                    background: isActive ? accentColor + "15" : "transparent",
                    color: isActive ? accentColor : "#444",
                    fontSize: 9,
                    fontWeight: isActive ? 700 : 400,
                    cursor: "pointer",
                    textTransform: "capitalize",
                    letterSpacing: 0.5,
                  }}
                >
                  {tab}
                </button>
              );
            })}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 4, ...(ComposedBrowser && accentTab !== "generator" ? { display: "none" } : {}) }}>
          <label style={{ fontSize: 10, color: "#444" }}>Grid</label>
          <select
            value={accentGrid}
            onChange={(e) =>
              setAccentGrid(e.target.value as AccentSubdivision)
            }
            style={{
              background: "#141414",
              border: "1px solid #222",
              borderRadius: 4,
              padding: "2px 6px",
              fontSize: 10,
              color: "#ccc",
              outline: "none",
            }}
          >
            {(Object.keys(ACCENT_SUBDIV_LABELS) as AccentSubdivision[]).map(k => (
              <option key={k} value={k}>{ACCENT_SUBDIV_LABELS[k]}</option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4, ...(ComposedBrowser && accentTab !== "generator" ? { display: "none" } : {}) }}>
          <label style={{ fontSize: 10, color: "#444" }}>Beats</label>
          {([1, 2, 3, 4, 5, 6, 7, 8] as AccentBeatCount[]).map((n) => (
            <button
              key={n}
              onClick={() => setBeats(n)}
              style={{
                width: 22,
                height: 22,
                borderRadius: 3,
                fontSize: 9,
                fontWeight: 700,
                border: `1px solid ${beats === n ? accentColor + "88" : "#1a1a1a"}`,
                background: beats === n ? accentColor + "22" : "#0e0e0e",
                color: beats === n ? accentColor : "#333",
                cursor: "pointer",
              }}
            >
              {n}
            </button>
          ))}
        </div>

        {/* Save/Load bar removed */}
      </div>

      {/* ── Composed tab (only if private file is present) ── */}
      {ComposedBrowser && accentTab === "composed" && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 12px" }}>
          <ComposedBrowser onImportMeasures={handleComposedImport} />
        </div>
      )}

      {/* ── Generator ── */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: ComposedBrowser && accentTab !== "generator" ? "none" : "flex",
          gap: 8,
          padding: "8px 12px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            overflow: "auto",
          }}
        >
          <div
            style={{
              fontSize: 9,
              color: "#333",
              fontWeight: 700,
              letterSpacing: 4,
              textTransform: "uppercase",
            }}
          >
            Preview
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflowX: "auto",
            }}
          >
            <div
              style={{
                background: "#0f0f0f",
                border: "1px solid #1e1e1e",
                borderRadius: 8,
                overflow: "hidden",
                lineHeight: 0,
                flexShrink: 0,
                padding: "4px 0",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {(() => {
                const chunks: StripMeasureData[][] = [];
                for (let i = 0; i < previewStripData.length; i += 4) {
                  chunks.push(previewStripData.slice(i, i + 4));
                }
                const rowBeatDenom = Math.min(beats, 4);
                return chunks.map((chunk, rowIdx) => (
                  <VexDrumStrip
                    key={rowIdx}
                    measures={chunk}
                    measureWidth={Math.max(100, Math.min(200, 700 / rowBeatDenom))}
                    height={orchCrashHits.length > 0 ? 240 : 200}
                    staveY={orchCrashHits.length > 0 ? 70 : 50}
                  />
                ));
              })()}
            </div>
          </div>

          {/* ── Slot modifications: rest / 32nd toggle ── */}
          <div style={{ marginTop: 2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 8, color: "#444", letterSpacing: 2, textTransform: "uppercase", fontWeight: 700 }}>
                Slot Mods
              </span>
              {(() => {
                const totalDisplay = displayBeatSlots * beats;
                const handleSlotMods = (mode: "musical" | "awkward") => {
                  const result = generateSlotMods(mode, totalDisplay, displayBeatSlots, 80, allAccentFlags);
                  setRestSlots(result.rests);
                  setSplitSlots(result.splits);
                };
                return (<>
                  <button onClick={() => handleSlotMods("musical")}
                    style={{
                      padding: "2px 8px", borderRadius: 3, fontSize: 8, fontWeight: 600,
                      cursor: "pointer", border: "1px solid #7aaa7a55", background: "#7aaa7a12", color: "#7aaa7a",
                    }}>Musical</button>
                  <button onClick={() => handleSlotMods("awkward")}
                    style={{
                      padding: "2px 8px", borderRadius: 3, fontSize: 8, fontWeight: 600,
                      cursor: "pointer", border: "1px solid #e0606055", background: "#e0606012", color: "#e06060",
                    }}>Awkward</button>
                </>);
              })()}
              {(restSlots.size > 0 || splitSlots.size > 0) && (
                <button
                  onClick={() => { setRestSlots(new Set()); setSplitSlots(new Set()); }}
                  style={{
                    padding: "2px 8px", borderRadius: 3, fontSize: 8, fontWeight: 600,
                    cursor: "pointer", border: "1px solid #333", background: "#0e0e0e", color: "#555",
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
              {Array.from({ length: displayBeatSlots * beats }, (_, i) => {
                const isRest = restSlots.has(i);
                const isSplit = splitSlots.has(i);
                const isAccent = allAccentFlags[i];
                const beatBoundary = i > 0 && i % displayBeatSlots === 0;
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex", flexDirection: "column", gap: 1, alignItems: "center",
                      marginLeft: beatBoundary ? 6 : 0,
                    }}
                  >
                    <div style={{
                      fontSize: 7, color: isAccent ? accentColor : "#333",
                      fontWeight: 700, lineHeight: 1, height: 8,
                    }}>
                      {isAccent ? ">" : ""}
                    </div>
                    <button
                      onClick={() => {
                        setRestSlots(prev => {
                          const next = new Set(prev);
                          if (next.has(i)) next.delete(i);
                          else { next.add(i); setSplitSlots(p => { const n = new Set(p); n.delete(i); return n; }); }
                          return next;
                        });
                      }}
                      title={`Slot ${i + 1}: ${isRest ? "remove rest" : "add rest"}`}
                      style={{
                        width: 18, height: 16, borderRadius: 2, fontSize: 7, fontWeight: 700,
                        cursor: "pointer", lineHeight: 1, padding: 0,
                        border: `1px solid ${isRest ? "#e06060" : "#1a1a1a"}`,
                        background: isRest ? "#e0606030" : "#0a0a0a",
                        color: isRest ? "#e06060" : "#333",
                      }}
                    >
                      R
                    </button>
                    <button
                      onClick={() => {
                        setSplitSlots(prev => {
                          const next = new Set(prev);
                          if (next.has(i)) next.delete(i);
                          else { next.add(i); setRestSlots(p => { const n = new Set(p); n.delete(i); return n; }); }
                          return next;
                        });
                      }}
                      title={`Slot ${i + 1}: ${isSplit ? "unsplit" : "split to 32nds"}`}
                      style={{
                        width: 18, height: 16, borderRadius: 2, fontSize: 6, fontWeight: 700,
                        cursor: "pointer", lineHeight: 1, padding: 0,
                        border: `1px solid ${isSplit ? "#9999ee" : "#1a1a1a"}`,
                        background: isSplit ? "#9999ee30" : "#0a0a0a",
                        color: isSplit ? "#9999ee" : "#333",
                      }}
                    >
                      32
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div
            style={{
              fontSize: 9,
              color: "#333",
              fontWeight: 700,
              letterSpacing: 4,
              textTransform: "uppercase",
              marginTop: 4,
            }}
          >
            Grouping
          </div>
          <GroupingViz
            grouping={grouping}
            accents={accents}
            totalSlots={slotCount}
            color={accentColor}
          />

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontSize: 9,
                fontFamily: "monospace",
                color: "#666",
                letterSpacing: 1,
              }}
            >
              {groupingLabel(grouping)}
            </span>
            {(["musical", "awkward", "both"] as const).map(m => (
              <button
                key={m}
                onClick={() => setPatternMode(m)}
                style={{
                  padding: "3px 8px",
                  borderRadius: 3,
                  fontSize: 9,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: `1px solid ${patternMode === m ? accentColor + "88" : "#1a1a1a"}`,
                  background: patternMode === m ? accentColor + "22" : "#0e0e0e",
                  color: patternMode === m ? accentColor : "#444",
                  textTransform: "capitalize",
                }}
              >
                {m}
              </button>
            ))}
            {seenGroupings.length > 0 && (
              <button
                onClick={() => setSeenGroupings([])}
                style={{
                  padding: "3px 6px",
                  borderRadius: 3,
                  fontSize: 8,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: "1px solid #333",
                  background: "#0e0e0e",
                  color: "#555",
                }}
                title={`Reset ${seenGroupings.length} seen groupings`}
              >
                reset seen ({seenGroupings.length})
              </button>
            )}
            <button
              onClick={handleGenerate}
              style={{
                padding: "3px 10px",
                borderRadius: 3,
                fontSize: 9,
                fontWeight: 700,
                cursor: "pointer",
                border: `1px solid ${accentColor}44`,
                background: accentColor + "11",
                color: accentColor,
              }}
            >
              Generate
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="text"
                value={customInput}
                onChange={(e) => {
                  setCustomInput(e.target.value);
                  setCustomError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCustomGrouping();
                }}
                placeholder={
                  autoCalcBeats
                    ? `custom (e.g. 3-4-5-4) auto-beats`
                    : `custom (e.g. 3-4-5-4) sum=${slotCount}`
                }
                style={{
                  width: 180,
                  padding: "3px 6px",
                  borderRadius: 3,
                  fontSize: 9,
                  fontFamily: "monospace",
                  border: `1px solid ${customError ? "#c44" : "#1a1a1a"}`,
                  background: "#0a0a0a",
                  color: "#888",
                  outline: "none",
                }}
              />
              <button
                onClick={applyCustomGrouping}
                style={{
                  padding: "3px 7px",
                  fontSize: 9,
                  fontFamily: "monospace",
                  borderRadius: 3,
                  border: "1px solid #333",
                  background: "#1a1a1a",
                  color: "#aaa",
                  cursor: "pointer",
                  lineHeight: 1,
                }}
              >
                Apply
              </button>
              <label
                title="Auto-calculate beats from the grouping sum instead of requiring it to match"
                style={{
                  display: "flex", alignItems: "center", gap: 3,
                  fontSize: 8, fontFamily: "monospace",
                  color: autoCalcBeats ? accentColor : "#555",
                  cursor: "pointer", userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={autoCalcBeats}
                  onChange={(e) => {
                    setAutoCalcBeats(e.target.checked);
                    setCustomError("");
                  }}
                  style={{ accentColor, width: 10, height: 10, margin: 0, cursor: "pointer" }}
                />
                calc beats
              </label>
              {customError && (
                <span style={{ fontSize: 8, color: "#c44" }}>{customError}</span>
              )}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              marginTop: 4,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 8,
                  color: "#444",
                  marginBottom: 4,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              >
                Start Mode
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {(["accent", "random"] as StartMode[]).map((m) => (
                  <OptionPill
                    key={m}
                    value={m}
                    selected={startMode === m}
                    onSelect={() => {
                      setStartMode(m);
                      if (m === "random") handleRegenAccents();
                    }}
                    color={accentColor}
                  />
                ))}
              </div>
            </div>

            <div>
              <div
                style={{
                  fontSize: 8,
                  color: "#444",
                  marginBottom: 4,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              >
                Accents
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {(Object.keys(ACCENT_INTERPRETATION_LABELS) as AccentInterpretation[]).map(k => (
                  <OptionPill
                    key={k}
                    value={ACCENT_INTERPRETATION_LABELS[k]}
                    selected={accentInterpretation === k}
                    onSelect={() => setAccentInterpretation(prev => prev === k ? null : k)}
                    color={accentColor}
                  />
                ))}
              </div>
            </div>

            <div>
              <div
                style={{
                  fontSize: 8,
                  color: "#444",
                  marginBottom: 4,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              >
                Taps
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {(Object.keys(TAP_INTERPRETATION_LABELS) as TapInterpretation[]).map(k => (
                  <OptionPill
                    key={k}
                    value={TAP_INTERPRETATION_LABELS[k]}
                    selected={tapInterpretation === k}
                    onSelect={() => setTapInterpretation(prev => prev === k ? null : k)}
                    color={accentColor}
                  />
                ))}
              </div>
            </div>

            <div>
              <div
                style={{
                  fontSize: 8,
                  color: "#444",
                  marginBottom: 4,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              >
                Sticking
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                <OptionPill
                  value="Odd Sticking"
                  selected={allowOdd}
                  onSelect={() => {
                    const next = !allowOdd;
                    setAllowOdd(next);
                    if (next) { setUseParadiddle(false); setUseSingle(false); }
                  }}
                  color={accentColor}
                />
                <OptionPill
                  value="Even Sticking"
                  selected={allowEven}
                  onSelect={() => {
                    const next = !allowEven;
                    setAllowEven(next);
                    if (next) { setUseParadiddle(false); setUseSingle(false); }
                  }}
                  color={accentColor}
                />
                <OptionPill
                  value="Paradiddle"
                  selected={useParadiddle}
                  onSelect={() => {
                    setUseParadiddle(true);
                    setUseSingle(false);
                    setAllowOdd(false);
                    setAllowEven(false);
                  }}
                  color={accentColor}
                />
                <OptionPill
                  value="Single Strokes"
                  selected={useSingle}
                  onSelect={() => {
                    const next = !useSingle;
                    setUseSingle(next);
                    if (next) { setUseParadiddle(false); setAllowOdd(false); setAllowEven(false); }
                  }}
                  color={accentColor}
                />
              </div>
              {stickingWarning && (
                <div
                  style={{
                    marginTop: 4,
                    padding: "3px 6px",
                    fontSize: 9,
                    color: "#e0a040",
                    background: "#e0a04015",
                    border: "1px solid #e0a04040",
                    borderRadius: 3,
                    lineHeight: 1.4,
                  }}
                >
                  ⚠ {stickingWarning}
                </div>
              )}
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                <OptionPill
                  value="R Lead"
                  selected={biasR}
                  onSelect={() => setBiasR(true)}
                  color={accentColor}
                />
                <OptionPill
                  value="L Lead"
                  selected={!biasR}
                  onSelect={() => setBiasR(false)}
                  color={accentColor}
                />
              </div>
            </div>

            <div>
              <div
                style={{
                  fontSize: 8,
                  color: "#444",
                  marginBottom: 4,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              >
                Bass
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {(Object.keys(BASS_LABELS) as BassOption[]).map((k) => (
                  <OptionPill
                    key={k}
                    value={BASS_LABELS[k]}
                    selected={bassOption === k}
                    onSelect={() => setBassOption(k)}
                    color={accentColor}
                  />
                ))}
              </div>
            </div>

            <div>
              <div
                style={{
                  fontSize: 8,
                  color: "#444",
                  marginBottom: 4,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              >
                Orchestration
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {(Object.keys(ORCHESTRATION_LABELS) as Orchestration[]).map(
                  (k) => (
                    <OptionPill
                      key={k}
                      value={ORCHESTRATION_LABELS[k]}
                      selected={orchestration === k}
                      onSelect={() => setOrchestration(k)}
                      color={accentColor}
                    />
                  ),
                )}
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            width: 108,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 5,
            paddingTop: 26,
          }}
        >
          <div style={{ display: "flex", gap: 4, width: "100%" }}>
            <button
              onClick={() => handleAdd(false)}
              style={{
                flex: 1,
                padding: "8px 0",
                borderRadius: 5,
                border: `1px solid ${accentColor}88`,
                background: accentColor + "15",
                color: accentColor,
                fontSize: 9,
                fontWeight: 600,
                cursor: "pointer",
              }}
              title="Add to current phrase"
            >
              + Phrase
            </button>
            <button
              onClick={() => handleAdd(true)}
              style={{
                flex: 1,
                padding: "8px 0",
                borderRadius: 5,
                border: `1px solid ${accentColor}88`,
                background: accentColor + "15",
                color: accentColor,
                fontSize: 9,
                fontWeight: 600,
                cursor: "pointer",
              }}
              title="Add to a new line"
            >
              + Line
            </button>
          </div>
          <button
            onClick={handleReplace}
            disabled={accentSelectedIdx === null}
            style={{
              width: "100%",
              padding: "8px 0",
              borderRadius: 5,
              fontSize: 10,
              fontWeight: 500,
              cursor:
                accentSelectedIdx !== null ? "pointer" : "not-allowed",
              border: `1px solid ${accentSelectedIdx !== null ? "#4a3a1a" : "#1a1a1a"}`,
              background:
                accentSelectedIdx !== null ? "#1e1a0e" : "transparent",
              color: accentSelectedIdx !== null ? "#e0a040" : "#333",
            }}
          >
            Replace M
            {accentSelectedIdx !== null ? accentSelectedIdx + 1 : "–"}
          </button>
          <button
            onClick={handleGenerate}
            style={{
              width: "100%",
              padding: "8px 0",
              borderRadius: 5,
              border: `1px solid ${accentColor}44`,
              background: accentColor + "11",
              color: accentColor,
              fontSize: 10,
              cursor: "pointer",
            }}
          >
            Generate
          </button>
        </div>
      </div>

      {showLog && (
        <AccentLogModal
          onClose={() => setShowLog(false)}
          onLoad={handleLoadExercise}
        />
      )}
    </div>
  );
}
