import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  StickingPattern,
  StickingMeasureData,
  STICKING_PATTERNS,
  getAvailablePatterns,
  buildStickingMeasure,
  filledCount,
  SLOTS_PER_BEAT,
  DEFAULT_PULSE_COUNT,
  MIN_PULSE_COUNT,
  MAX_PULSE_COUNT,
  uniformBeamGroups,
  beamRanges,
  resolveBeamGroups,
  randomizeStickings,
  StickingMode,
} from "@/lib/stickingsData";
import { VexDrumStrip, StripMeasureData } from "@/components/VexDrumNotation";

/* ── colour constants ──────────────────────────────────────────────── */
const TAB_COLOR = "#60b0e0";
const R_COLOR = "#7aaa7a";
const L_COLOR = "#9a9cf8";
const K_COLOR = "#e06060";
// Hand-agnostic snare (used for the BSS / BSSS / BSSSS voice-only patterns).
// Distinct from R/L so it reads as "snare, either hand" at a glance.
const S_COLOR = "#c0c0c0";
const SLOT_EMPTY = "#1a1a1a";

const STRIP_BEAT_W = 150;
const STRIP_MEASURE_H = 150;
const STRIP_CLEF_EXTRA = 36;
const STAR_COLORS = ["", "#e06060", "#e0a040", "#c8aa50", "#7aaa7a", "#7173e6"];

/* ══════════════════════════════════════════════════════════════════════
   StickingsStudyStrip — renders saved sticking measures in notation
   with per-line star ratings and logging
   ══════════════════════════════════════════════════════════════════════ */

export interface StickingsStripProps {
  measures: StickingMeasureData[];
  selectedIdx: number | null;
  onSelect: (i: number) => void;
  onDelete: () => void;
  onClearAll: () => void;
  onLog?: (entries: { rating: number; measures: StickingMeasureData[]; lineIdx: number }[], tag?: string) => void;
}

export function StickingsStudyStrip({
  measures,
  selectedIdx,
  onSelect,
  onDelete,
  onClearAll,
  onLog,
}: StickingsStripProps) {
  const [lineRatings, setLineRatings] = useState<Record<number, number>>({});
  const [flash, setFlash] = useState("");
  const [saving, setSaving] = useState(false);
  const [tag, setTag] = useState<"isolation" | "context">("isolation");
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setContainerW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lines = useMemo(() => {
    const result: { startIdx: number; measures: StickingMeasureData[] }[] = [];
    let cur: StickingMeasureData[] = [];
    let startIdx = 0;
    for (let i = 0; i < measures.length; i++) {
      if (measures[i].lineBreak && cur.length > 0) {
        result.push({ startIdx, measures: cur });
        cur = [];
        startIdx = i;
      }
      cur.push(measures[i]);
    }
    if (cur.length > 0) result.push({ startIdx, measures: cur });
    return result;
  }, [measures]);

  const handleLog = useCallback(() => {
    const entries: { rating: number; measures: StickingMeasureData[]; lineIdx: number }[] = [];
    for (const [key, rating] of Object.entries(lineRatings)) {
      if (rating <= 0) continue;
      const lineIdx = parseInt(key, 10);
      if (isNaN(lineIdx) || !lines[lineIdx]) continue;
      entries.push({ rating, measures: lines[lineIdx].measures, lineIdx });
    }
    if (entries.length === 0) return;
    setSaving(true);
    onLog?.(entries, tag);
    setSaving(false);
    setFlash(`Logged ${entries.length}!`);
    setTimeout(() => setFlash(""), 2000);
  }, [lineRatings, lines, onLog, tag]);

  const ratedCount = Object.values(lineRatings).filter(r => r > 0).length;

  return (
    <div ref={containerRef} style={{ flexShrink: 0, borderTop: "1px solid #181818" }}>
      {/* ── Header with log controls ── */}
      <div style={{ padding: "4px 12px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 9, color: TAB_COLOR, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase" }}>
            Stickings {measures.length > 0 && `(${measures.length})`}
          </span>
          {measures.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <select
                value={tag}
                onChange={e => setTag(e.target.value as "isolation" | "context")}
                style={{
                  background: "#141414",
                  border: `1px solid ${tag === "isolation" ? "#e0a040" : "#7aaa7a"}44`,
                  borderRadius: 4, padding: "2px 6px", fontSize: 9,
                  color: tag === "isolation" ? "#e0a040" : "#7aaa7a",
                  outline: "none", fontWeight: 600, cursor: "pointer",
                }}
              >
                <option value="isolation">Isolation</option>
                <option value="context">Context</option>
              </select>
              <button onClick={handleLog} disabled={saving || ratedCount === 0} style={{
                padding: "2px 8px", background: saving ? "#1a2a1a" : "#0e1a0e",
                border: "1px solid #2a5a2a",
                color: saving ? "#7aaa7a" : ratedCount > 0 ? "#5a9a5a" : "#2a3a2a",
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
          {selectedIdx !== null && (
            <button onClick={onDelete} style={{
              fontSize: 9, padding: "2px 8px", borderRadius: 3,
              border: "1px solid #c44", background: "#1a0808", color: "#c44", cursor: "pointer",
            }}>Delete M{selectedIdx + 1}</button>
          )}
          {measures.length > 0 && (
            <button onClick={onClearAll} style={{ fontSize: 9, color: "#3a3a3a", background: "none", border: "none", cursor: "pointer" }}>Clear all</button>
          )}
        </div>
      </div>

      {/* ── Lines with notation + ratings ── */}
      <div style={{ overflowX: "auto", display: "flex", justifyContent: measures.length > 0 ? "flex-start" : "center", flexDirection: "column", padding: "6px 16px 10px", minHeight: STRIP_MEASURE_H + 20, alignItems: "flex-start" }}>
        {measures.length === 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", fontSize: 10, color: "#1e1e1e" }}>
            No sticking measures yet
          </div>
        )}
        {lines.map((line, lineIdx) => {
          const totalBeats = line.measures.reduce((sum, m) => beamRanges(resolveBeamGroups(m), m.totalSlots ?? DEFAULT_PULSE_COUNT).length + sum, 0);
          const STAR_AREA = 120;
          const availW = containerW > 0 ? containerW - STRIP_CLEF_EXTRA - STAR_AREA : 0;
          const beatW = containerW > 0
            ? Math.min(STRIP_BEAT_W, Math.max(40, Math.floor(availW / totalBeats)))
            : STRIP_BEAT_W;

          const lineBeatData: StripMeasureData[] = [];
          const lineLayouts: { x: number; w: number; globalIdx: number }[] = [];
          let beatCursor = 0;

          // First pass: collect beat slot counts for proportional widths
          const allRanges: { lo: number; hi: number; mIdx: number }[] = [];
          for (let j = 0; j < line.measures.length; j++) {
            const m = line.measures[j];
            const mSlots = m.totalSlots ?? DEFAULT_PULSE_COUNT;
            const mRanges = beamRanges(resolveBeamGroups(m), mSlots);
            for (const r of mRanges) allRanges.push({ ...r, mIdx: j });
          }
          const totalSlotCount = allRanges.reduce((s, r) => s + (r.hi - r.lo), 0);

          // Compute per-beat widths proportional to slot count
          const perBeatW = allRanges.map(r => {
            const slots = r.hi - r.lo;
            return totalSlotCount > 0
              ? Math.max(40, Math.round(availW * slots / totalSlotCount))
              : beatW;
          });

          for (let j = 0; j < line.measures.length; j++) {
            const m = line.measures[j];
            const mSlots = m.totalSlots ?? DEFAULT_PULSE_COUNT;
            const mRanges = beamRanges(resolveBeamGroups(m), mSlots);
            const mBeats = mRanges.length;
            const globalIdx = line.startIdx + j;
            const mBeatWidths = perBeatW.slice(beatCursor, beatCursor + mBeats);
            const mTotalW = mBeatWidths.reduce((a, b) => a + b, 0);
            const xOffset = perBeatW.slice(0, beatCursor).reduce((a, b) => a + b, 0);
            const x = j === 0 ? 0 : STRIP_CLEF_EXTRA + xOffset;
            const w = j === 0
              ? mTotalW + STRIP_CLEF_EXTRA
              : mTotalW;
            lineLayouts.push({ x, w, globalIdx });

            for (const { lo, hi } of mRanges) {
              const beatSlots = hi - lo;
              lineBeatData.push({
                grid: "16th",
                ostinatoHits: [],
                ostinatoOpen: [],
                snareHits: m.snareHits.filter(s => s >= lo && s < hi).map(s => s - lo),
                bassHits: m.bassHits.filter(s => s >= lo && s < hi).map(s => s - lo),
                hhFootHits: [],
                hhFootOpen: [],
                ghostHits: [],
                ghostDoubleHits: [],
                accentFlags: m.accentFlags.slice(lo, hi),
                stickings: m.stickings.slice(lo, hi),
                showRests: true,
                hideGhostParens: true,
                bassStemUp: true,
                slotOverride: beatSlots,
              });
            }
            beatCursor += mBeats;
          }

          const totalW = STRIP_CLEF_EXTRA + perBeatW.reduce((a, b) => a + b, 0);
          const r = lineRatings[lineIdx] ?? 0;

          return (
            <div key={lineIdx} style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, width: "100%", marginBottom: 2 }}>
              <div style={{ position: "relative", height: STRIP_MEASURE_H, width: totalW, flexShrink: 0 }}>
                <VexDrumStrip measures={lineBeatData} measureWidth={beatW} measureWidths={perBeatW} height={STRIP_MEASURE_H} />
                {lineLayouts.map(({ x, w, globalIdx }) => {
                  const isSel = selectedIdx === globalIdx;
                  return (
                    <div
                      key={globalIdx}
                      onClick={() => onSelect(globalIdx)}
                      style={{
                        position: "absolute", top: 0, left: x, width: w, height: STRIP_MEASURE_H,
                        cursor: "pointer",
                        border: isSel ? `1.5px solid ${TAB_COLOR}` : "1.5px solid transparent",
                        borderRadius: 4, boxSizing: "border-box",
                      }}
                    >
                      {isSel && (
                        <button
                          onClick={e => { e.stopPropagation(); onDelete(); }}
                          style={{
                            position: "absolute", top: 4, right: 4, width: 16, height: 16,
                            borderRadius: "50%", background: "#3a1a1a", border: "1px solid #6a3a3a",
                            color: "#e06060", fontSize: 9, cursor: "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                        >x</button>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* Per-line star rating */}
              <div style={{ display: "flex", flexDirection: "column", gap: 3, flexShrink: 0, marginLeft: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  <span style={{ color: "#666", fontSize: 9, width: 20, textAlign: "right", fontWeight: 600 }}>L{lineIdx + 1}</span>
                  <div style={{ display: "flex", gap: 0 }}>
                    {[1, 2, 3, 4, 5].map(star => (
                      <button key={star}
                        onClick={() => setLineRatings(prev => ({ ...prev, [lineIdx]: r === star ? 0 : star }))}
                        title={["", "Hard", "Tough", "OK", "Good", "Easy"][star]}
                        style={{
                          background: "none", border: "none", cursor: "pointer",
                          fontSize: 15, padding: "0 1px", lineHeight: 1,
                          color: star <= r ? STAR_COLORS[r] : "#1a1a1a",
                        }}
                      >&#9733;</button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Rudiment family classification ────────────────────────────────── */

const RUDIMENT_FAMILIES = [
  { key: "single",     label: "Single",     color: "#7aaa7a" },
  { key: "double",     label: "Double",     color: "#9a9cf8" },
  { key: "paradiddle", label: "Paradiddle", color: "#e0a040" },
  { key: "combo",      label: "Combo",      color: "#60b0e0" },
  { key: "fill",       label: "Generic",    color: "#888888" },
  { key: "basic",      label: "Basic",      color: "#666666" },
] as const;

/** Map a pattern label → broad rudiment family key */
function rudimentFamily(label: string): string {
  const b = label.replace(/\s*\(K@[\d,]+\)/, "").trim();
  if (/^(right|left|kick|single stroke|double (right|left)|kick \+|(right|left) \+ kick)$/.test(b)) return "basic";
  if (/single stroke/i.test(b) || /alternating/i.test(b)) return "single";
  if (/double stroke/i.test(b)) return "double";
  if (/para/i.test(b)) return "paradiddle";
  if (/double lead|double roll combo|double \+ single|triple|reverse \+|combo/i.test(b)) return "combo";
  return "fill";
}

/* ══════════════════════════════════════════════════════════════════════
   StickingsStudy — main builder UI
   ══════════════════════════════════════════════════════════════════════ */

export default function StickingsStudy({
  stickingMeasures,
  setStickingMeasures,
  stickingSelectedIdx,
  setStickingSelectedIdx,
}: {
  stickingMeasures: StickingMeasureData[];
  setStickingMeasures: React.Dispatch<React.SetStateAction<StickingMeasureData[]>>;
  stickingSelectedIdx: number | null;
  setStickingSelectedIdx: (i: number | null) => void;
}) {
  const [chosen, setChosen] = useState<StickingPattern[]>([]);
  const [pulseCount, setPulseCount] = useState(DEFAULT_PULSE_COUNT);
  const [pulseInput, setPulseInput] = useState(String(DEFAULT_PULSE_COUNT));
  const [beamGroups, setBeamGroups] = useState<number[]>(() => uniformBeamGroups(DEFAULT_PULSE_COUNT));
  const [beamInput, setBeamInput] = useState(() => uniformBeamGroups(DEFAULT_PULSE_COUNT).join("+"));
  const filled = filledCount(chosen);
  const remaining = pulseCount - filled;
  const isFull = remaining === 0;

  // Auto-sync beam grouping to the chosen pattern sizes so phrase boundaries
  // show up in the beaming (e.g. picking BSSS + KRR + RKL + RLRKL renders as
  // beams of 4 + 3 + 3 + 5 instead of uniform 4+4+4+4). Any trailing unfilled
  // slots collapse into one final group. Skipped when no patterns are chosen
  // so manually-typed groupings (which reset `chosen` to []) are preserved.
  useEffect(() => {
    if (chosen.length === 0) return;
    const groups = chosen.map(p => p.group);
    const sum = groups.reduce((a, b) => a + b, 0);
    if (sum < pulseCount) groups.push(pulseCount - sum);
    setBeamGroups(groups);
    setBeamInput(groups.join("+"));
  }, [chosen, pulseCount]);

  // Filter state: which groups, kick-counts, and rudiment families are visible
  const [enabledGroups, setEnabledGroups] = useState<Set<number>>(() => new Set([1, 2, 3, 4, 5, 6, 7]));
  const [enabledKicks, setEnabledKicks] = useState<Set<number>>(() => new Set([0, 1, 2, 3]));
  const [enabledFamilies, setEnabledFamilies] = useState<Set<string>>(() => new Set(RUDIMENT_FAMILIES.map(f => f.key)));
  const [maskInput, setMaskInput] = useState("");
  const [stickingMode, setStickingMode] = useState<StickingMode>("musical");

  const toggleSet = <T,>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, val: T) =>
    setter(prev => { const n = new Set(prev); n.has(val) ? n.delete(val) : n.add(val); return n; });

  const available = useMemo(() => getAvailablePatterns(remaining), [remaining]);

  // Count kicks in a pattern string
  const kickCount = (pat: string) => pat.split("").filter(c => c === "K").length;

  // Parse mask: uppercase R/L/K are constraints, anything else is wildcard
  const parsedMask = useMemo(() => {
    const raw = maskInput.toUpperCase();
    const chars: (string | null)[] = [];
    for (const ch of raw) {
      if (ch === "R" || ch === "L" || ch === "K" || ch === "B" || ch === "S") chars.push(ch);
      else if (ch === "_" || ch === "." || ch === " " || ch === "*") chars.push(null);
      // skip other chars
    }
    return chars.length > 0 ? chars : null;
  }, [maskInput]);

  const matchesMask = (pattern: string): boolean => {
    if (!parsedMask) return true;
    // Pattern must be at least as long as the mask's constrained positions
    for (let i = 0; i < parsedMask.length; i++) {
      if (parsedMask[i] !== null) {
        if (i >= pattern.length || pattern[i] !== parsedMask[i]) return false;
      }
    }
    return true;
  };

  // Group available patterns by size, then sub-group by kick count, applying all filters
  const byGroup = useMemo(() => {
    const map = new Map<number, { kicks: number; patterns: StickingPattern[] }[]>();
    for (const p of available) {
      if (!enabledGroups.has(p.group)) continue;
      const kc = kickCount(p.pattern);
      if (!enabledKicks.has(kc)) continue;
      if (!enabledFamilies.has(rudimentFamily(p.label))) continue;
      if (!matchesMask(p.pattern)) continue;
      const arr = map.get(p.group) ?? [];
      let sub = arr.find(s => s.kicks === kc);
      if (!sub) { sub = { kicks: kc, patterns: [] }; arr.push(sub); }
      sub.patterns.push(p);
      map.set(p.group, arr);
    }
    return map;
  }, [available, enabledGroups, enabledKicks, enabledFamilies, parsedMask]);

  const visibleCount = useMemo(() => {
    let n = 0;
    for (const subs of byGroup.values()) for (const s of subs) n += s.patterns.length;
    return n;
  }, [byGroup]);

  const pickPattern = (p: StickingPattern) => {
    setChosen(prev => [...prev, p]);
  };

  const undoLast = () => {
    setChosen(prev => prev.slice(0, -1));
  };

  const clearBuild = () => {
    setChosen([]);
  };

  // Flatten chosen patterns into a stickings array (may be < 16)
  const currentStickings = useMemo(() => {
    const arr: string[] = [];
    for (const p of chosen) for (const ch of p.pattern) arr.push(ch);
    return arr;
  }, [chosen]);

  // Preview strip data
  const previewRanges = useMemo(() => beamRanges(beamGroups, pulseCount), [beamGroups, pulseCount]);
  const previewStripData: StripMeasureData[] = useMemo(() => {
    return previewRanges.map(({ lo, hi }) => {
      const snareHits: number[] = [];
      const bassHits: number[] = [];
      const stickings: string[] = [];
      const accentFlags: boolean[] = [];
      for (let s = lo; s < hi; s++) {
        if (s < currentStickings.length) {
          const ch = currentStickings[s];
          if (ch === "K" || ch === "B") bassHits.push(s - lo);
          else snareHits.push(s - lo);
          stickings.push(ch);
          accentFlags.push(false);
        } else {
          stickings.push("");
          accentFlags.push(false);
        }
      }
      return {
        grid: "16th" as const,
        ostinatoHits: [],
        ostinatoOpen: [],
        snareHits,
        bassHits,
        hhFootHits: [],
        hhFootOpen: [],
        ghostHits: [],
        ghostDoubleHits: [],
        accentFlags,
        stickings,
        showRests: true,
        hideGhostParens: true,
        bassStemUp: true,
        // Each range renders as its own stave; without slotOverride a 3- or
        // 5-slot phrase would be clipped to the grid's natural 4-slot beat.
        slotOverride: hi - lo,
      };
    });
  }, [currentStickings, previewRanges]);

  // Proportional per-group width so a 5-slot phrase gets more room than a
  // 3-slot one. Uniform grouping still renders evenly because every group has
  // the same slot count.
  const previewMeasureWidths = useMemo(() => {
    const budget = 600;
    const slotW = pulseCount > 0 ? Math.max(10, budget / pulseCount) : 37.5;
    return previewRanges.map(({ lo, hi }) => Math.max(40, Math.round((hi - lo) * slotW)));
  }, [previewRanges, pulseCount]);
  const previewMeasureWidth = previewMeasureWidths[0] ?? 150;

  const buildMeasure = useCallback((): StickingMeasureData => {
    return buildStickingMeasure(chosen, pulseCount, beamGroups);
  }, [chosen, pulseCount, beamGroups]);

  const handleAdd = (lineBreak?: boolean) => {
    if (!isFull) return;
    const m = buildMeasure();
    if (lineBreak) m.lineBreak = true;
    setStickingMeasures(prev => [...prev, m]);
    setStickingSelectedIdx(null);
    setChosen([]);
  };

  const handleReplace = () => {
    if (stickingSelectedIdx === null || !isFull) return;
    setStickingMeasures(prev =>
      prev.map((m, i) => (i === stickingSelectedIdx ? buildMeasure() : m)),
    );
    setChosen([]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", background: "#0c0c0c", overflow: "hidden", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 12px", borderBottom: "1px solid #181818", flexShrink: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 4, color: TAB_COLOR, textTransform: "uppercase", marginRight: 4 }}>
          Stickings
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "#888", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Pulses</span>
          <input
            type="text"
            inputMode="numeric"
            value={pulseInput}
            onChange={e => {
              const raw = e.target.value;
              setPulseInput(raw);
              const v = parseInt(raw, 10);
              if (!isNaN(v) && v >= MIN_PULSE_COUNT && v <= MAX_PULSE_COUNT && v !== pulseCount) {
                setPulseCount(v); setChosen([]);
                const g = uniformBeamGroups(v);
                setBeamGroups(g); setBeamInput(g.join("+"));
              }
            }}
            onBlur={() => {
              const v = parseInt(pulseInput, 10);
              const clamped = isNaN(v) ? pulseCount : Math.max(MIN_PULSE_COUNT, Math.min(MAX_PULSE_COUNT, v));
              setPulseInput(String(clamped));
              if (clamped !== pulseCount) {
                setPulseCount(clamped); setChosen([]);
                const g = uniformBeamGroups(clamped);
                setBeamGroups(g); setBeamInput(g.join("+"));
              }
            }}
            style={{
              width: 44, fontSize: 13, color: TAB_COLOR, fontWeight: 700, textAlign: "center",
              background: "#141414", border: "1px solid #333", borderRadius: 4,
              outline: "none", padding: "3px 4px",
            }}
            title={`Pulses per measure (${MIN_PULSE_COUNT}–${MAX_PULSE_COUNT})`}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "#888", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Grouping</span>
          {(() => {
            const sum = beamGroups.reduce((a, b) => a + b, 0);
            const valid = sum === pulseCount && beamGroups.every(g => g >= 1);
            return (
              <input
                value={beamInput}
                onChange={e => {
                  const raw = e.target.value;
                  setBeamInput(raw);
                  const nums = raw.split("+").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n >= 1);
                  if (nums.length === 0) return;
                  const newSum = nums.reduce((a, b) => a + b, 0);
                  if (newSum === pulseCount) {
                    setBeamGroups(nums);
                  } else if (newSum >= MIN_PULSE_COUNT && newSum <= MAX_PULSE_COUNT) {
                    // Grouping doesn't match current pulses — adopt the grouping's sum
                    // as the new pulse count, so "5+3+5" just works without the user
                    // having to adjust pulses first.
                    setPulseCount(newSum);
                    setPulseInput(String(newSum));
                    setBeamGroups(nums);
                    setChosen([]);
                  }
                }}
                onBlur={() => {
                  // On blur, snap to current valid groups
                  setBeamInput(beamGroups.join("+"));
                }}
                style={{
                  width: Math.max(72, beamInput.length * 9 + 20), fontSize: 13, fontWeight: 700,
                  fontFamily: "monospace", letterSpacing: 1, textAlign: "center",
                  background: "#141414", borderRadius: 4, padding: "3px 6px",
                  border: `1px solid ${valid ? "#333" : "#663333"}`,
                  color: valid ? TAB_COLOR : "#e06060",
                  outline: "none",
                }}
                title={`Grouping (e.g. 5+3+2+6). If the sum doesn't match the current pulse count, pulses auto-adjusts to match.`}
              />
            );
          })()}
        </div>

        <span style={{ fontSize: 9, color: "#555", letterSpacing: 2, textTransform: "uppercase", fontWeight: 600, marginLeft: "auto" }}>
          Low Bass Drum Density
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8, padding: "0 12px 8px", overflow: "hidden" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0, minHeight: 0 }}>

          {/* ── Fixed preview + slots (does not scroll) ── */}
          <div style={{ flexShrink: 0, paddingTop: 8, paddingBottom: 8, borderBottom: "1px solid #181818" }}>

          {/* ── Preview ── */}
          <div style={{ fontSize: 9, color: "#333", fontWeight: 700, letterSpacing: 4, textTransform: "uppercase" }}>Preview</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", overflowX: "auto" }}>
            <div style={{ background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 8, overflow: "hidden", lineHeight: 0, flexShrink: 0, padding: "4px 0" }}>
              <VexDrumStrip measures={previewStripData} measureWidth={previewMeasureWidth} measureWidths={previewMeasureWidths} height={200} staveY={50} />
            </div>
          </div>

          {/* ── Slot visualisation ── */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 1 }}>
              {(() => {
                const slotW = pulseCount <= 16 ? 18 : Math.max(10, Math.floor(288 / pulseCount));
                const slotH = pulseCount <= 16 ? 22 : Math.max(14, Math.floor(352 / pulseCount));
                const slotFont = pulseCount <= 16 ? 9 : Math.max(6, Math.floor(144 / pulseCount));
                const gapSize = pulseCount <= 16 ? 6 : Math.max(2, Math.floor(96 / pulseCount));
                const groupGap = pulseCount <= 16 ? 4 : Math.max(2, Math.floor(64 / pulseCount));
                // Build set of beam boundary indices from beamGroups
                const beamStarts = new Set<number>();
                let cursor = 0;
                for (const g of beamGroups) { if (cursor > 0) beamStarts.add(cursor); cursor += g; }
                return Array.from({ length: pulseCount }, (_, i) => {
                const ch = i < currentStickings.length ? currentStickings[i] : null;
                const bg = ch === "R" ? R_COLOR : ch === "L" ? L_COLOR : ch === "K" || ch === "B" ? K_COLOR : ch === "S" ? S_COLOR : SLOT_EMPTY;
                const isBeamBoundary = i === 0 || beamStarts.has(i);
                // Show sticking-pattern group boundaries
                const isGroupStart = (() => {
                  let offset = 0;
                  for (const p of chosen) {
                    if (i === offset && offset > 0) return true;
                    offset += p.group;
                  }
                  return false;
                })();
                return (
                  <div key={i} style={{
                    width: slotW, height: slotH, borderRadius: 3,
                    background: bg + (ch ? "" : ""),
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: slotFont, fontWeight: 700, color: ch ? "#000" : "#333",
                    marginLeft: isGroupStart ? groupGap : (isBeamBoundary && i > 0 ? gapSize : 0),
                    border: isBeamBoundary ? `1px solid #333` : "1px solid #1a1a1a",
                  }}>
                    {ch ?? "·"}
                  </div>
                );
              });
              })()}
            </div>
            <span style={{ fontSize: 10, color: isFull ? "#7aaa7a" : "#666", fontWeight: 600 }}>
              {filled}/{pulseCount}
            </span>
            {chosen.length > 0 && (
              <button onClick={undoLast} style={{
                padding: "3px 8px", borderRadius: 3, fontSize: 9, fontWeight: 600,
                border: "1px solid #444", background: "#1a1a1a", color: "#888", cursor: "pointer",
              }}>Undo</button>
            )}
            {chosen.length > 0 && (
              <button onClick={clearBuild} style={{
                padding: "3px 8px", borderRadius: 3, fontSize: 9, fontWeight: 600,
                border: "1px solid #333", background: "#141414", color: "#555", cursor: "pointer",
              }}>Clear</button>
            )}
            {(["musical", "awkward", "both"] as const).map(m => (
              <button
                key={m}
                onClick={() => setStickingMode(m)}
                style={{
                  padding: "3px 8px", borderRadius: 3, fontSize: 9, fontWeight: 600,
                  cursor: "pointer", textTransform: "capitalize",
                  border: `1px solid ${stickingMode === m ? TAB_COLOR + "88" : "#1a1a1a"}`,
                  background: stickingMode === m ? TAB_COLOR + "22" : "#0e0e0e",
                  color: stickingMode === m ? TAB_COLOR : "#444",
                }}
              >{m}</button>
            ))}
            {!isFull && (
              <button onClick={() => {
                const result = randomizeStickings(remaining, stickingMode, enabledKicks, enabledGroups, enabledFamilies);
                if (result) setChosen(prev => [...prev, ...result]);
              }} style={{
                padding: "3px 8px", borderRadius: 3, fontSize: 9, fontWeight: 600,
                border: `1px solid ${TAB_COLOR}55`, background: `${TAB_COLOR}12`, color: TAB_COLOR, cursor: "pointer",
              }}>Fill</button>
            )}
            <button onClick={() => {
              const result = randomizeStickings(pulseCount, stickingMode, enabledKicks, enabledGroups, enabledFamilies);
              if (result) setChosen(result);
            }} style={{
              padding: "3px 8px", borderRadius: 3, fontSize: 9, fontWeight: 600,
              border: "1px solid #e0a04055", background: "#e0a04012", color: "#e0a040", cursor: "pointer",
            }}>Randomize</button>
            {!isFull && (
              <input
                type="text"
                placeholder={`Type R/L/K (${remaining} left)`}
                onKeyDown={e => {
                  if (e.key !== "Enter") return;
                  const raw = (e.target as HTMLInputElement).value.toUpperCase().replace(/[^RLK]/g, "");
                  if (raw.length === 0 || raw.length > remaining) return;
                  setChosen(prev => [...prev, { pattern: raw, group: raw.length, label: "custom" }]);
                  (e.target as HTMLInputElement).value = "";
                }}
                style={{
                  width: 120, padding: "3px 6px", borderRadius: 3, fontSize: 10,
                  fontFamily: "monospace", letterSpacing: 2, fontWeight: 600,
                  border: `1px solid ${TAB_COLOR}44`, background: "#0a0a0a",
                  color: TAB_COLOR, outline: "none",
                }}
              />
            )}
          </div>

          {/* ── Chosen groups summary ── */}
          {chosen.length > 0 && (
            <div style={{ fontSize: 9, color: "#555", fontFamily: "monospace" }}>
              {chosen.map((p, i) => (
                <span key={i} style={{ marginRight: 6 }}>
                  <span style={{ color: TAB_COLOR }}>{p.pattern}</span>
                  <span style={{ color: "#333" }}>({p.group})</span>
                </span>
              ))}
            </div>
          )}
          </div>{/* end fixed preview */}

          {/* ── Scrollable pattern picker ── */}
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingTop: 4 }}>
          {/* ── Pattern picker ── */}
          {!isFull && (
            <div style={{ display: "flex", flexDirection: "column", gap: 0, marginTop: 4 }}>

              {/* ── Sticky filter bar ── */}
              <div style={{
                position: "sticky", top: 0, zIndex: 5,
                background: "#0c0c0c", paddingBottom: 6, paddingTop: 2,
                borderBottom: "1px solid #181818",
                display: "flex", flexDirection: "column", gap: 5,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 9, color: "#333", fontWeight: 700, letterSpacing: 4, textTransform: "uppercase" }}>
                    Pick Sticking ({remaining} slots left)
                  </span>
                  <span style={{ fontSize: 8, color: "#2a2a2a" }}>{visibleCount} shown</span>
                </div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  {/* Group toggles */}
                  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <span style={{ fontSize: 7, color: "#444", letterSpacing: 1, fontWeight: 600, textTransform: "uppercase", marginRight: 1 }}>Grp</span>
                    {[1, 2, 3, 4, 5, 6, 7].filter(g => g <= remaining).map(g => (
                      <button key={g} onClick={() => toggleSet(setEnabledGroups, g)} style={{
                        width: 18, height: 16, borderRadius: 3, fontSize: 8, fontWeight: 700,
                        border: `1px solid ${enabledGroups.has(g) ? TAB_COLOR + "66" : "#222"}`,
                        background: enabledGroups.has(g) ? TAB_COLOR + "18" : "#111",
                        color: enabledGroups.has(g) ? TAB_COLOR : "#333",
                        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                      }}>{g}</button>
                    ))}
                  </div>
                  {/* Kick-count toggles */}
                  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <span style={{ fontSize: 7, color: "#444", letterSpacing: 1, fontWeight: 600, textTransform: "uppercase", marginRight: 1 }}>Kicks</span>
                    {([
                      [0, "Hands"],
                      [1, "1K"],
                      [2, "2K"],
                      [3, "3K"],
                    ] as [number, string][]).map(([k, lbl]) => (
                      <button key={k} onClick={() => toggleSet(setEnabledKicks, k)} style={{
                        padding: "1px 5px", borderRadius: 3, fontSize: 7, fontWeight: 700, letterSpacing: 1,
                        border: `1px solid ${enabledKicks.has(k) ? (k === 0 ? "#888888" : K_COLOR) + "55" : "#222"}`,
                        background: enabledKicks.has(k) ? (k === 0 ? "#88888812" : K_COLOR + "12") : "#111",
                        color: enabledKicks.has(k) ? (k === 0 ? "#999999" : K_COLOR) : "#333",
                        cursor: "pointer",
                      }}>{lbl}</button>
                    ))}
                  </div>
                  {/* Rudiment family toggles */}
                  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <span style={{ fontSize: 7, color: "#444", letterSpacing: 1, fontWeight: 600, textTransform: "uppercase", marginRight: 1 }}>Family</span>
                    {RUDIMENT_FAMILIES.map(f => (
                      <button key={f.key} onClick={() => toggleSet(setEnabledFamilies, f.key)} style={{
                        padding: "1px 5px", borderRadius: 3, fontSize: 7, fontWeight: 700, letterSpacing: 1,
                        border: `1px solid ${enabledFamilies.has(f.key) ? f.color + "55" : "#222"}`,
                        background: enabledFamilies.has(f.key) ? f.color + "12" : "#111",
                        color: enabledFamilies.has(f.key) ? f.color : "#333",
                        cursor: "pointer",
                      }}>{f.label}</button>
                    ))}
                  </div>
                  {/* Position mask filter — 7 clickable boxes */}
                  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <span style={{ fontSize: 7, color: "#444", letterSpacing: 1, fontWeight: 600, textTransform: "uppercase", marginRight: 1 }}>Mask</span>
                    {[0, 1, 2, 3, 4, 5, 6].map(i => {
                      const ch = maskInput[i] ?? "";
                      const upper = ch.toUpperCase();
                      const isSet = upper === "R" || upper === "L" || upper === "K";
                      const color = upper === "R" ? R_COLOR : upper === "L" ? L_COLOR : upper === "K" || upper === "B" ? K_COLOR : upper === "S" ? S_COLOR : "#333";
                      return (
                        <input
                          key={i}
                          type="text"
                          maxLength={1}
                          value={isSet ? upper : ""}
                          placeholder="_"
                          onChange={e => {
                            const v = e.target.value.toUpperCase();
                            const valid = v === "R" || v === "L" || v === "K" ? v : "";
                            setMaskInput(prev => {
                              const arr = prev.padEnd(7, "_").split("");
                              arr[i] = valid || "_";
                              // Trim trailing underscores
                              let s = arr.join("");
                              while (s.endsWith("_") && s.length > 0) s = s.slice(0, -1);
                              return s;
                            });
                            // Auto-advance to next box
                            if (valid) {
                              const next = e.target.parentElement?.nextElementSibling?.querySelector("input") as HTMLInputElement | null;
                              next?.focus();
                            }
                          }}
                          onKeyDown={e => {
                            if (e.key === "Backspace" && !isSet) {
                              // Move to previous box
                              const prev = (e.target as HTMLElement).parentElement?.previousElementSibling?.querySelector("input") as HTMLInputElement | null;
                              prev?.focus();
                            }
                          }}
                          style={{
                            width: 20, height: 20, borderRadius: 3, fontSize: 10, fontWeight: 700,
                            fontFamily: "monospace", textAlign: "center", padding: 0,
                            border: `1px solid ${isSet ? color + "88" : "#2a2a2a"}`,
                            background: isSet ? color + "18" : "#111",
                            color: isSet ? color : "#333",
                            outline: "none", caretColor: TAB_COLOR,
                          }}
                        />
                      );
                    })}
                    {maskInput && (
                      <button onClick={() => setMaskInput("")} style={{
                        fontSize: 9, color: "#555", background: "none", border: "none", cursor: "pointer",
                        padding: "0 2px",
                      }}>x</button>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Pattern buttons by group > kick sub-section ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>
              {[1, 2, 3, 4, 5, 6, 7].map(g => {
                const subs = byGroup.get(g);
                if (!subs || subs.length === 0) return null;
                const KICK_LABELS = ["Hands only", "1 kick", "2 kicks"];
                return (
                  <div key={g}>
                    <div style={{ fontSize: 8, color: "#444", marginBottom: 3, letterSpacing: 2, textTransform: "uppercase" }}>
                      Group of {g}
                    </div>
                    {subs.map(sub => (
                      <div key={sub.kicks} style={{ marginBottom: 4 }}>
                        {g >= 3 && (
                          <div style={{
                            fontSize: 7, color: sub.kicks === 0 ? "#555" : K_COLOR + "88",
                            letterSpacing: 1, textTransform: "uppercase", fontWeight: 600, marginBottom: 2, marginLeft: 2,
                          }}>
                            {KICK_LABELS[sub.kicks] ?? `${sub.kicks} kicks`}
                            <span style={{ color: "#2a2a2a", marginLeft: 4 }}>({sub.patterns.length})</span>
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {sub.patterns.map(p => {
                            const fam = RUDIMENT_FAMILIES.find(f => f.key === rudimentFamily(p.label));
                            return (
                              <button
                                key={p.pattern}
                                onClick={() => pickPattern(p)}
                                title={`${p.label}  [${fam?.label ?? ""}]`}
                                style={{
                                  padding: "4px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                                  fontFamily: "monospace", letterSpacing: 2,
                                  border: `1px solid ${(fam?.color ?? TAB_COLOR) + "33"}`,
                                  background: (fam?.color ?? TAB_COLOR) + "08",
                                  color: TAB_COLOR,
                                  cursor: "pointer",
                                  lineHeight: 1.2,
                                }}
                              >
                                {p.pattern.split("").map((ch, ci) => (
                                  <span key={ci} style={{
                                    color: ch === "R" ? R_COLOR : ch === "L" ? L_COLOR : ch === "S" ? S_COLOR : K_COLOR,
                                  }}>{ch}</span>
                                ))}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
              </div>
            </div>
          )}

          {/* ── Full message ── */}
          {isFull && (
            <div style={{ fontSize: 10, color: "#7aaa7a", fontWeight: 600, marginTop: 4 }}>
              Measure complete — add to notation below.
            </div>
          )}
          </div>{/* end scrollable pattern picker */}
        </div>

        {/* ── Action buttons (right column) ── */}
        <div style={{ width: 108, flexShrink: 0, display: "flex", flexDirection: "column", gap: 5, paddingTop: 26 }}>
          <div style={{ display: "flex", gap: 4, width: "100%" }}>
            <button
              onClick={() => handleAdd(false)}
              disabled={!isFull}
              style={{
                flex: 1, padding: "8px 0", borderRadius: 5, fontSize: 9, fontWeight: 600, cursor: isFull ? "pointer" : "not-allowed",
                border: `1px solid ${isFull ? TAB_COLOR + "88" : "#1a1a1a"}`,
                background: isFull ? TAB_COLOR + "15" : "transparent",
                color: isFull ? TAB_COLOR : "#333",
              }}
              title="Add to current phrase"
            >+ Phrase</button>
            <button
              onClick={() => handleAdd(true)}
              disabled={!isFull}
              style={{
                flex: 1, padding: "8px 0", borderRadius: 5, fontSize: 9, fontWeight: 600, cursor: isFull ? "pointer" : "not-allowed",
                border: `1px solid ${isFull ? TAB_COLOR + "88" : "#1a1a1a"}`,
                background: isFull ? TAB_COLOR + "15" : "transparent",
                color: isFull ? TAB_COLOR : "#333",
              }}
              title="Add to a new line"
            >+ Line</button>
          </div>
          <button
            onClick={handleReplace}
            disabled={stickingSelectedIdx === null || !isFull}
            style={{
              width: "100%", padding: "8px 0", borderRadius: 5, fontSize: 10, fontWeight: 500,
              cursor: stickingSelectedIdx !== null && isFull ? "pointer" : "not-allowed",
              border: `1px solid ${stickingSelectedIdx !== null && isFull ? "#4a3a1a" : "#1a1a1a"}`,
              background: stickingSelectedIdx !== null && isFull ? "#1e1a0e" : "transparent",
              color: stickingSelectedIdx !== null && isFull ? "#e0a040" : "#333",
            }}
          >
            Replace M{stickingSelectedIdx !== null ? stickingSelectedIdx + 1 : "–"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function measureToStripData(m: StickingMeasureData): StripMeasureData[] {
  const mSlots = m.totalSlots ?? DEFAULT_PULSE_COUNT;
  const ranges = beamRanges(resolveBeamGroups(m), mSlots);
  const beats: StripMeasureData[] = [];
  for (const { lo, hi } of ranges) {
    beats.push({
      grid: "16th",
      ostinatoHits: [],
      ostinatoOpen: [],
      snareHits: m.snareHits.filter(i => i >= lo && i < hi).map(i => i - lo),
      bassHits: m.bassHits.filter(i => i >= lo && i < hi).map(i => i - lo),
      hhFootHits: [],
      hhFootOpen: [],
      ghostHits: [],
      ghostDoubleHits: [],
      accentFlags: m.accentFlags.slice(lo, hi),
      stickings: m.stickings.slice(lo, hi),
      showRests: true,
      hideGhostParens: true,
      bassStemUp: true,
      slotOverride: hi - lo,
    });
  }
  return beats;
}
