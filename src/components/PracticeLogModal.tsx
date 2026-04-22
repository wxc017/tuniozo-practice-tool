import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from "react";
import {
  PracticeLogEntry, PracticeLogData,
  getPracticeLog, deletePracticeEntry, restorePracticeEntry, movePracticeEntry, getDatesWithEntries,
  getEntriesForDate, updatePracticeEntry,
  addQuickmarkFromSnapshot,
} from "@/lib/practiceLog";
import { getDailyStats, accuracy, setImportBias } from "@/lib/stats";
import type { TabSettingsSnapshot, SettingsGroup } from "@/App";
import type { KonnakolGroup } from "@/lib/konnakolData";
import KonnakolNotation from "./KonnakolNotation";
import type { DrumMeasure, GridType } from "@/lib/drumData";
import {
  getPerms, permHits, GRID_SUBDIVS,
  resolveSnareHits, resolveBassHits, resolveGhostHits,
} from "@/lib/drumData";
import type { AccentMeasureData, AccentSubdivision } from "@/lib/accentData";
import { slotsPerBeat, toRenderGrid } from "@/lib/accentData";
import { VexDrumStrip } from "@/components/VexDrumNotation";
import type { StripMeasureData } from "@/components/VexDrumNotation";
import type { InterplayMeasureData } from "@/lib/kickSnareInterplay";

// ── Types ──────────────────────────────────────────────────────────────────

export type AccentImportMode = "replace" | "phrase" | "line";

interface Props {
  onClose: () => void;
  onLoadEntry: (entry: PracticeLogEntry, importMode?: AccentImportMode) => void;
  /** Number of accent line/phrase imports queued so far (shown as badge) */
  accentQueueCount?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateHeader(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

// ── Drum measure → strip data helper ──────────────────────────────────────

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

/** Convert InterplayMeasureData[] into StripMeasureData[] for live rendering
 *  in the practice-log preview. Matches InterplayFinalRow's mapping so the
 *  saved phrase reads the same as it did in Pattern Ostinato's final strip. */
function interplayMeasuresToStrip(measures: InterplayMeasureData[]): StripMeasureData[] {
  return measures.map(m => ({
    grid: "16th" as const,
    ostinatoHits:    m.hatHits,
    ostinatoOpen:    m.hatOpenHits,
    snareHits:       m.snareHits,
    bassHits:        m.bassHits,
    hhFootHits:      m.hhFootHits ?? [],
    hhFootOpen:      [],
    crashHits:       m.crashHits ?? [],
    ghostHits:       m.ghostHits,
    ghostDoubleHits: [],
    accentFlags:     m.accentFlags,
    slotOverride:    m.totalSlots,
  }));
}

/** Convert AccentMeasureData[] into per-beat StripMeasureData[] for live rendering. */
function subdivToGrid(s: string): GridType {
  if (s === "8th" || s === "16th" || s === "triplet") return s;
  if (s === "quintuplet" || s === "sextuplet" || s === "septuplet") return s;
  if (s === "32nd") return "32nd";
  if (s === "quarter") return "8th"; // quarter = 1 slot, render as 8th grid with 1 hit
  return "16th";
}

function accentMeasuresToStrip(measures: AccentMeasureData[], grid: AccentSubdivision): StripMeasureData[] {
  const result: StripMeasureData[] = [];
  for (const m of measures) {
    // If we have per-beat subdivision info (from composed studies), use it
    if (m.beatSubdivs && m.beatSubdivs.length > 0) {
      let cursor = 0;
      for (const beat of m.beatSubdivs) {
        const lo = cursor;
        const hi = cursor + beat.n;
        const beatGrid = subdivToGrid(beat.subdiv);
        const tupletNum = beat.subdiv === "triplet" ? 3
          : beat.subdiv === "quintuplet" ? 5
          : beat.subdiv === "sextuplet" ? 6
          : beat.subdiv === "septuplet" ? 7
          : undefined;
        result.push({
          grid: beatGrid,
          ostinatoHits: [],
          ostinatoOpen: [],
          snareHits: (m.snareHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
          bassHits: (m.bassHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
          hhFootHits: [],
          hhFootOpen: [],
          ghostHits: (m.ghostHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
          ghostDoubleHits: [],
          tomHits: (m.tomHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
          crashHits: (m.crashHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
          accentFlags: (m.accentFlags ?? []).slice(lo, hi),
          stickings: (m.stickings ?? []).slice(lo, hi),
          slotOverride: beat.n,
          tupletNum,
          accentInterpretation: m.accentInterpretation,
          tapInterpretation: m.tapInterpretation,
          showRests: true,
          hideGhostParens: true,
          bassStemUp: true,
        });
        cursor = hi;
      }
      continue;
    }

    // Match AccentStudyStrip's per-measure logic: honor the measure's own
    // subdivision (may differ from the top-level snapshot grid) AND upscale
    // to a 32nd grid when splitSlots are present, since the saved
    // displaySlots is already expanded 2× in that case.  Without this, a
    // split measure preview renders at double the beat count and reads as
    // the wrong grouping (e.g. groups-of-6 for what the user saved as a
    // 4-beat 16th phrase with a couple of splits).
    const mSubdiv            = m.subdivision ?? grid;
    const hasMeasureSplits   = !!m.splitSlots && m.splitSlots.length > 0;
    const mRenderGrid        = hasMeasureSplits ? ("32nd" as const) : toRenderGrid(mSubdiv);
    const mBeatSlots         = hasMeasureSplits ? slotsPerBeat(mSubdiv) * 2 : slotsPerBeat(mSubdiv);
    const displayBeatSlots   = m.useParadiddle ? mBeatSlots * 2 : mBeatSlots;
    const totalSlots         = m.displaySlots ?? m.stickings?.length ?? displayBeatSlots;
    const beatCount          = Math.max(1, Math.round(totalSlots / displayBeatSlots));
    for (let b = 0; b < beatCount; b++) {
      const lo = b * displayBeatSlots;
      const hi = lo + displayBeatSlots;
      result.push({
        grid: mRenderGrid,
        ostinatoHits: [],
        ostinatoOpen: [],
        snareHits: (m.snareHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
        bassHits: (m.bassHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
        hhFootHits: [],
        hhFootOpen: [],
        ghostHits: (m.ghostHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
        ghostDoubleHits: [],
        tomHits: (m.tomHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
        crashHits: (m.crashHits ?? []).filter(s => s >= lo && s < hi).map(s => s - lo),
        accentFlags: (m.accentFlags ?? []).slice(lo, hi),
        stickings: (m.stickings ?? []).slice(lo, hi),
        slotOverride: displayBeatSlots,
        accentInterpretation: m.accentInterpretation,
        tapInterpretation: m.tapInterpretation,
        showRests: true,
        hideGhostParens: true,
        bassStemUp: true,
      });
    }
  }
  return result;
}

const STAR_COLORS = ["", "#e06060", "#e0a040", "#c8aa50", "#7aaa7a", "#7173e6"];
const STAR_LABELS = ["", "Hard", "Tough", "OK", "Good", "Easy"];

const MODE_COLORS: Record<string, string> = {
  "ear-trainer": "#7173e6",
  "drum-ostinato": "#c8aa50",
  "accent-study": "#9999ee",
  "konnakol": "#e06060",
  "konnakol-basic": "#e06060",
  "konnakol-cycles": "#e06060",
  "konnakol-mixed": "#e06060",
  "chord-chart": "#7aaa7a",
  "note-entry": "#e0a040",
  "phrase-decomposition": "#e0a040",
};

type ModeFilter = "all" | string;

const MODE_FILTER_TABS: { key: ModeFilter; label: string; modes: string[] }[] = [
  { key: "all",       label: "All",        modes: [] },
  { key: "ear",       label: "Spatial",     modes: ["ear-trainer"] },
  { key: "ostinato",  label: "Ostinato",   modes: ["drum-ostinato"] },
  { key: "accent",    label: "Accent",     modes: ["accent-study"] },
  { key: "konnakol",  label: "Konnakol",   modes: ["konnakol", "konnakol-basic", "konnakol-cycles", "konnakol-mixed"] },
  { key: "chord",     label: "Chords",     modes: ["chord-chart"] },
  { key: "note",      label: "Note Entry", modes: ["note-entry"] },
  { key: "phrase",    label: "Phrase",      modes: ["phrase-decomposition"] },
];

function modeColor(mode: string): string {
  return MODE_COLORS[mode] ?? "#666";
}

const TAG_META: Record<string, { label: string; color: string }> = {
  isolation: { label: "Isolation", color: "#e0a040" },
  context:   { label: "Context",   color: "#7aaa7a" },
};

/** Extract ostinato pattern key from a drum-ostinato entry's snapshot.
 *  Groups by the ostinato perm ID of the first measure (the "base pattern"). */

// ── Accent notation preview (scales SVG to fit container) ─────────────────

function AccentNotationPreview({ measures, grid }: { measures: AccentMeasureData[]; grid: AccentSubdivision }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const stripData = useMemo(() => accentMeasuresToStrip(measures, grid), [measures, grid]);
  const hasAccents = stripData.some(d => d.accentFlags?.some(Boolean));
  const stripH = hasAccents ? 190 : 160;
  const MW = 160;
  const CLEF_EXTRA = 40;
  const naturalW = CLEF_EXTRA + stripData.length * MW;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const available = el.clientWidth - 12; // minus padding
    setScale(available >= naturalW ? 1 : available / naturalW);
  }, [naturalW]);

  return (
    <div ref={wrapRef} style={{ background: "#0a0a0a", borderRadius: 4, border: "1px solid #1a1a1a", padding: 6, marginBottom: 4, lineHeight: 0, overflow: "hidden" }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", height: stripH * scale }}>
        <VexDrumStrip
          measures={stripData}
          measureWidth={MW}
          height={stripH}
          staveY={hasAccents ? 40 : undefined}
          oneBeatPerBar
          showClef
        />
      </div>
    </div>
  );
}

// ── Calendar Component ─────────────────────────────────────────────────────

function Calendar({
  year,
  month,
  datesWithEntries,
  selectedDate,
  onSelectDate,
}: {
  year: number;
  month: number;  // 0-indexed
  datesWithEntries: Set<string>;
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
}) {
  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);
  const startDow = firstDay.getDay(); // 0 = Sun
  const totalDays = lastDay.getDate();
  const today = isoToday();

  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);

  function toISO(d: number): string {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 }}>
        {DAY_LABELS.map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: 9, color: "#444", padding: "3px 0", fontWeight: 700, letterSpacing: 1 }}>
            {d}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {cells.map((d, i) => {
          if (d === null) return <div key={`e-${i}`} />;
          const iso = toISO(d);
          const hasEntries = datesWithEntries.has(iso);
          const isToday = iso === today;
          const isSelected = iso === selectedDate;
          return (
            <button
              key={iso}
              onClick={() => onSelectDate(iso)}
              style={{
                position: "relative",
                padding: "6px 2px",
                borderRadius: 5,
                border: isSelected
                  ? "1.5px solid #7173e6"
                  : isToday
                    ? "1.5px solid #2a2a5a"
                    : "1.5px solid transparent",
                background: isSelected ? "#1a1a3a" : isToday ? "#111122" : "#0e0e0e",
                color: isSelected ? "#9999ee" : isToday ? "#7173e6" : hasEntries ? "#aaa" : "#444",
                fontSize: 11,
                fontWeight: isToday ? 700 : 400,
                cursor: "pointer",
                textAlign: "center",
                transition: "all 60ms",
              }}
            >
              {d}
              {hasEntries && (
                <div style={{
                  position: "absolute",
                  bottom: 2,
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: isSelected ? "#9999ee" : "#7173e6",
                }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Bookmark Button (reusable) ────────────────────────────────────────────

function BookmarkButton({ onClick }: { onClick: () => void }) {
  const [flash, setFlash] = useState(false);
  return (
    <button
      onClick={() => { onClick(); setFlash(true); setTimeout(() => setFlash(false), 1200); }}
      title="Add to quickmarks"
      style={{
        padding: "3px 10px",
        background: flash ? "#1a1a0e" : "#111",
        border: `1px solid ${flash ? "#c8aa50" : "#333"}`,
        color: flash ? "#c8aa50" : "#888",
        borderRadius: 4,
        fontSize: 9,
        fontWeight: 600,
        cursor: "pointer",
        letterSpacing: 1,
        transition: "all 80ms",
      }}
      onMouseEnter={e => {
        if (!flash) {
          (e.currentTarget as HTMLElement).style.background = "#1a1a0e";
          (e.currentTarget as HTMLElement).style.borderColor = "#c8aa50";
          (e.currentTarget as HTMLElement).style.color = "#c8aa50";
        }
      }}
      onMouseLeave={e => {
        if (!flash) {
          (e.currentTarget as HTMLElement).style.background = "#111";
          (e.currentTarget as HTMLElement).style.borderColor = "#333";
          (e.currentTarget as HTMLElement).style.color = "#888";
        }
      }}
    >
      {flash ? "Bookmarked!" : "+ Bookmark"}
    </button>
  );
}

// ── Ear-Trainer Entry Body (collapsible settings + results, matching history panel) ──

function EarTrainerEntryBody({ entry, onLoad }: { entry: PracticeLogEntry; onLoad: () => void }) {
  const settings = entry.snapshot.settingsSnapshot as TabSettingsSnapshot;
  const biasKeys = entry.snapshot.biasKeys as Record<string, { c: number; w: number }> | undefined;
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const [withBias, setWithBias] = useState(false);

  const toggleSection = (s: string) => setOpenSections(prev => {
    const next = new Set(prev);
    if (next.has(s)) next.delete(s); else next.add(s);
    return next;
  });

  // Parse results from preview text
  const previewLines = entry.preview.split("\n");
  const headerLine = previewLines[0] ?? "";
  const missedItems: { label: string; c: number; w: number }[] = [];
  const correctItems: { label: string; c: number }[] = [];
  let section: "none" | "missed" | "correct" = "none";
  for (const line of previewLines) {
    const trimmed = line.trim();
    if (trimmed === "MISSED:") { section = "missed"; continue; }
    if (trimmed === "CORRECT:") { section = "correct"; continue; }
    if (section === "missed") {
      const m = trimmed.match(/^(.+?)\s+(\d+)✓\s+(\d+)✗\s+\d+%$/);
      if (m) missedItems.push({ label: m[1], c: +m[2], w: +m[3] });
    } else if (section === "correct") {
      const m = trimmed.match(/^(.+?)\s+(\d+)✓/);
      if (m) correctItems.push({ label: m[1], c: +m[2] });
    }
  }
  const totalC = missedItems.reduce((s, v) => s + v.c, 0) + correctItems.reduce((s, v) => s + v.c, 0);
  const totalW = missedItems.reduce((s, v) => s + v.w, 0);

  const hasBiasData = biasKeys && Object.keys(biasKeys).length > 0;

  return (
    <div style={{ background: "#0e0e0e", border: "1px solid #1e1e1e", borderRadius: 6, overflow: "hidden", marginBottom: 6 }}>
      {/* Title + summary */}
      <div style={{ padding: "6px 10px", fontSize: 11, color: "#999", fontWeight: 600 }}>
        {settings.title}
        {(totalC + totalW) > 0 && (
          <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 10 }}>
            <span style={{ color: "#5a8a5a" }}>{totalC}✓</span>{" "}
            <span style={{ color: "#aa5555" }}>{totalW}✗</span>
          </span>
        )}
      </div>

      {/* Collapsible settings groups */}
      <div style={{ padding: "0 6px 4px" }}>
        {settings.groups.map(group => (
          <div key={group.label} style={{ borderLeft: "2px solid #222", marginLeft: 4 }}>
            <div
              onClick={() => toggleSection(group.label)}
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 6px", cursor: "pointer", userSelect: "none" }}
            >
              <span style={{ fontSize: 8, color: "#444" }}>{openSections.has(group.label) ? "▾" : "▸"}</span>
              <span style={{ fontSize: 9, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>{group.label}</span>
              <span style={{ fontSize: 9, color: "#444" }}>({group.items.length})</span>
            </div>
            {openSections.has(group.label) && (
              <div style={{ paddingLeft: 16, paddingRight: 8, paddingBottom: 2, display: "flex", flexWrap: "wrap", gap: "0 8px" }}>
                {group.items.map((item, i) => (
                  <span key={i} style={{ fontSize: 10, color: "#888" }}>{item}</span>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Results section */}
        {(missedItems.length > 0 || correctItems.length > 0) && (
          <div style={{ borderLeft: "2px solid #333", marginLeft: 4 }}>
            <div
              onClick={() => toggleSection("__results__")}
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 6px", cursor: "pointer", userSelect: "none" }}
            >
              <span style={{ fontSize: 8, color: "#444" }}>{openSections.has("__results__") ? "▾" : "▸"}</span>
              <span style={{ fontSize: 9, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>Results</span>
              <span style={{ fontSize: 9, color: "#5a8a5a" }}>{totalC}✓</span>
              <span style={{ fontSize: 9, color: "#aa5555" }}>{totalW}✗</span>
            </div>
            {openSections.has("__results__") && (
              <div style={{ paddingLeft: 12, paddingRight: 8, paddingBottom: 4 }}>
                {missedItems.map((v, i) => {
                  const t = v.c + v.w;
                  const p = t ? Math.round(100 * v.c / t) : 0;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "1px 6px", borderRadius: 4, fontSize: 11, background: "#1a1111", border: "1px solid #2a1a1a", marginBottom: 1 }}>
                      <span style={{ flex: 1, color: "#aa8888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.label}</span>
                      <span style={{ color: "#5a8a5a", fontVariantNumeric: "tabular-nums", fontSize: 10 }}>{v.c}✓</span>
                      <span style={{ color: "#cc5555", fontVariantNumeric: "tabular-nums", fontSize: 10 }}>{v.w}✗</span>
                      <span style={{ color: "#886666", fontVariantNumeric: "tabular-nums", width: 28, textAlign: "right", fontSize: 10 }}>{p}%</span>
                    </div>
                  );
                })}
                {correctItems.map((v, i) => (
                  <div key={`c${i}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "1px 6px", fontSize: 11, marginBottom: 1 }}>
                    <span style={{ flex: 1, color: "#667766", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.label}</span>
                    <span style={{ color: "#4a7a4a", fontVariantNumeric: "tabular-nums", fontSize: 10 }}>{v.c}✓</span>
                    <span style={{ color: "#556655", fontVariantNumeric: "tabular-nums", width: 28, textAlign: "right", fontSize: 10 }}>100%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Import + Bias buttons */}
      {entry.canRestore && (
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "4px 10px 6px" }}>
          {hasBiasData && (
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 9, color: withBias ? "#e0a040" : "#555" }}>
              <input
                type="checkbox"
                checked={withBias}
                onChange={e => setWithBias(e.target.checked)}
                style={{ accentColor: "#e0a040" }}
              />
              Bias towards missed
            </label>
          )}
          <button
            onClick={() => {
              if (withBias && biasKeys) {
                setImportBias(biasKeys);
              }
              onLoad();
            }}
            style={{
              padding: "3px 10px",
              background: "#111",
              border: "1px solid #333",
              color: "#888",
              borderRadius: 4,
              fontSize: 9,
              fontWeight: 600,
              cursor: "pointer",
              letterSpacing: 1,
              transition: "all 80ms",
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = "#1a1a2a";
              (e.currentTarget as HTMLElement).style.borderColor = "#7173e6";
              (e.currentTarget as HTMLElement).style.color = "#9999ee";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = "#111";
              (e.currentTarget as HTMLElement).style.borderColor = "#333";
              (e.currentTarget as HTMLElement).style.color = "#888";
            }}
          >
            ↩ Import
          </button>
        </div>
      )}
    </div>
  );
}

// ── Entry Card ─────────────────────────────────────────────────────────────

const TAG_CYCLE = ["isolation", "context", undefined] as const;

function EntryCard({
  entry,
  onDelete,
  onLoad,
  onLoadAccent,
  onBookmark,
  onMoveStart,
  onRatingChange,
  onTagChange,
  isMoving,
}: {
  entry: PracticeLogEntry;
  onDelete: () => void;
  onLoad: () => void;
  onLoadAccent?: (mode: AccentImportMode) => void;
  onBookmark?: () => void;
  onMoveStart: () => void;
  onRatingChange: (rating: number) => void;
  onTagChange: (tag: string | undefined) => void;
  isMoving: boolean;
}) {
  const color = modeColor(entry.mode);

  return (
    <div style={{
      marginBottom: 8,
      padding: "10px 12px",
      borderRadius: 6,
      border: isMoving ? "1px solid #c8aa50" : "1px solid #1e1e1e",
      background: isMoving ? "#1a1a0e" : "#0c0c0c",
      transition: "all 80ms",
    }}>
      {/* Top row: label + time + move + delete */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: 1,
          padding: "2px 7px", borderRadius: 10,
          background: color + "22", color,
        }}>
          {entry.label}
        </span>

        {/* Tag badge — click to cycle: isolation → context → none */}
        <button
          title={entry.tag ? `${TAG_META[entry.tag]?.label ?? entry.tag} (click to change)` : "Set tag (isolation / context)"}
          onClick={() => {
            const idx = TAG_CYCLE.indexOf(entry.tag as typeof TAG_CYCLE[number]);
            const next = TAG_CYCLE[(idx + 1) % TAG_CYCLE.length];
            onTagChange(next);
          }}
          style={{
            fontSize: 8, fontWeight: 700, letterSpacing: 0.5,
            padding: "2px 6px", borderRadius: 10, cursor: "pointer",
            border: entry.tag && TAG_META[entry.tag]
              ? `1px solid ${TAG_META[entry.tag].color}44`
              : "1px dashed #333",
            background: entry.tag && TAG_META[entry.tag]
              ? TAG_META[entry.tag].color + "22"
              : "transparent",
            color: entry.tag && TAG_META[entry.tag]
              ? TAG_META[entry.tag].color
              : "#444",
            textTransform: "uppercase",
            transition: "all 80ms",
          }}
        >
          {entry.tag && TAG_META[entry.tag] ? TAG_META[entry.tag].label : "tag"}
        </button>

        {/* Clickable star rating — hidden for accent-study (per-variant stars shown in pills) */}
        {entry.mode !== "accent-study" && (
        <span style={{ display: "flex", alignItems: "center", gap: 1 }}>
          {[1, 2, 3, 4, 5].map(star => (
            <button key={star}
              onClick={() => onRatingChange(entry.rating === star ? 0 : star)}
              title={`${STAR_LABELS[star]}${entry.rating === star ? " (click to clear)" : ""}`}
              style={{
                background: "none", border: "none", cursor: "pointer",
                fontSize: 11, padding: 0, lineHeight: 1,
                color: star <= entry.rating ? STAR_COLORS[entry.rating] : "#2a2a2a",
                transition: "color 60ms",
              }}
            >★</button>
          ))}
          {entry.rating > 0 && (
            <span style={{ fontSize: 8, color: STAR_COLORS[entry.rating], marginLeft: 2 }}>
              {STAR_LABELS[entry.rating]}
            </span>
          )}
        </span>
        )}

        <span style={{ fontSize: 9, color: "#444", marginLeft: "auto" }}>
          {formatTime(entry.timestamp)}
        </span>

        <button
          onClick={onMoveStart}
          title={isMoving ? "Cancel move" : "Move to another day"}
          style={{
            background: "none", border: "none",
            color: isMoving ? "#c8aa50" : "#333", cursor: "pointer", fontSize: 11,
            padding: "0 2px", lineHeight: 1,
            transition: "color 80ms",
          }}
          onMouseEnter={e => (e.currentTarget.style.color = isMoving ? "#e0c060" : "#c8aa50")}
          onMouseLeave={e => (e.currentTarget.style.color = isMoving ? "#c8aa50" : "#333")}
        >
          ↷
        </button>

        <button
          onClick={onDelete}
          title="Delete entry"
          style={{
            background: "none", border: "1px solid #2a1a1a",
            borderRadius: 3, color: "#664444", cursor: "pointer", fontSize: 11,
            padding: "1px 4px", lineHeight: 1,
            transition: "all 80ms",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "#e06060"; e.currentTarget.style.borderColor = "#5a2a2a"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "#664444"; e.currentTarget.style.borderColor = "#2a1a1a"; }}
        >
          ✕
        </button>
      </div>

      {/* Konnakol notation preview (rendered live, not screenshot) */}
      {entry.mode === "konnakol-cycles" && (entry.snapshot.groups as KonnakolGroup[] | undefined)?.length ? (() => {
        const groups = entry.snapshot.groups as KonnakolGroup[];
        const totalNotes = groups.reduce((s, g) => s + g.notes.length, 0);
        const w = Math.max(400, Math.min(900, totalNotes * 45 + 80));
        return (
          <div style={{ overflowX: "auto", background: "#0a0a0a", borderRadius: 4, border: "1px solid #1a1a1a", padding: 6, marginBottom: 6 }}>
            <KonnakolNotation groups={groups} width={w} height={140} baseDuration="16" noTuplets />
          </div>
        );
      })() : entry.mode === "konnakol-mixed" && (entry.snapshot.chainGroups as KonnakolGroup[] | undefined)?.length ? (() => {
        const groups = entry.snapshot.chainGroups as KonnakolGroup[];
        const formula = entry.snapshot.chainFormula as number[] | undefined;
        const totalNotes = (formula ?? []).reduce((s: number, n: number) => s + n, 0);
        const w = Math.max(400, Math.min(900, totalNotes * 45 + 80));
        return (
          <div style={{ overflowX: "auto", background: "#0a0a0a", borderRadius: 4, border: "1px solid #1a1a1a", padding: 6, marginBottom: 6 }}>
            <KonnakolNotation groups={groups} width={w} height={140} groupedSixteenths={formula} />
          </div>
        );
      })() : null}

      {/* Drum ostinato notation preview (rendered live) + perm settings */}
      {entry.mode === "drum-ostinato" && (entry.snapshot.measures as DrumMeasure[] | undefined)?.length ? (() => {
        const measures = entry.snapshot.measures as DrumMeasure[];
        const grid = (entry.snapshot.grid as GridType) ?? "16th";
        const origCount = (entry.snapshot.permOriginalCount as number | null | undefined) ?? null;
        const origMeasures = origCount != null ? measures.slice(0, origCount) : measures;
        const stripData = origMeasures.map(m => measureToStripData(m, grid));
        const hasAccents = stripData.some(d => d.accentFlags?.some(Boolean));
        const stripH = hasAccents ? 190 : 160;
        const mw = 280;
        const perms = getPerms(grid);
        return (<>
          <div style={{ overflowX: "auto", background: "#0a0a0a", borderRadius: 4, border: "1px solid #1a1a1a", padding: 6, marginBottom: 4, lineHeight: 0 }}>
            <VexDrumStrip
              measures={stripData}
              measureWidth={mw}
              height={stripH}
              staveY={hasAccents ? 40 : undefined}
              oneBeatPerBar
              showClef
            />
          </div>
          {/* Perm settings summary */}
          <div style={{ fontSize: 9, color: "#555", padding: "2px 4px", marginBottom: 6, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ color: "#666" }}>
              {origMeasures.length} beat{origMeasures.length !== 1 ? "s" : ""} · {grid}
              {origCount != null && measures.length > origCount && (
                <span style={{ color: "#c8aa50" }}> · {measures.length / origCount} perms</span>
              )}
            </span>
            {origMeasures.map((m, mi) => {
              const pools: string[] = [];
              const desc = (label: string, ids: string[] | undefined) => {
                if (!ids || ids.length === 0) return;
                const names = ids.map(id => perms.find(p => p.id === id)?.label ?? "?").join(", ");
                pools.push(`${label}: ${names}`);
              };
              desc("S", m.snarePermPool);
              desc("B", m.bassPermPool);
              desc("G", m.ghostPermIds);
              desc("G-dbl", m.ghostDoublePermIds);
              desc("O", m.hhClosedPermIds);
              desc("O-open", m.ostinatoOpenPermIds);
              desc("HH", m.hhOpenPermPool);
              if (pools.length === 0) return null;
              return (
                <span key={mi} style={{ color: "#444" }}>
                  M{mi + 1}: {pools.join(" | ")}
                </span>
              );
            })}
          </div>
        </>);
      })() : null}

      {/* Pattern Ostinato (interplay) notation preview */}
      {entry.mode === "drum-ostinato" && (entry.snapshot.interplayMeasures as InterplayMeasureData[] | undefined)?.length ? (() => {
        const ipMeasures = entry.snapshot.interplayMeasures as InterplayMeasureData[];
        const stripData = interplayMeasuresToStrip(ipMeasures);
        const hasAccents = stripData.some(d => d.accentFlags?.some(Boolean));
        const stripH = hasAccents ? 190 : 160;
        const widths = ipMeasures.map(m => 60 + m.totalSlots * 48);
        return (
          <div style={{ overflowX: "auto", background: "#0a0a0a", borderRadius: 4, border: "1px solid #1a1a1a", padding: 6, marginBottom: 6, lineHeight: 0 }}>
            <VexDrumStrip
              measures={stripData}
              measureWidths={widths}
              measureWidth={widths[0] ?? 100}
              height={stripH}
              staveY={hasAccents ? 40 : undefined}
              showClef
              showTimeSig
              oneBeatPerBar
            />
          </div>
        );
      })() : null}

      {/* Accent study: notation preview + compact variant ratings with stars */}
      {entry.mode === "accent-study" && (() => {
        const measures = entry.snapshot.measures as AccentMeasureData[] | undefined;
        const grid = entry.snapshot.grid as AccentSubdivision | undefined;
        const vr = entry.snapshot.variantRatings as Record<string, number> | undefined;
        const RATING_COLORS = ["", "#e06060", "#e0a040", "#c8aa50", "#7aaa7a", "#7173e6"];
        return (<>
          {measures?.length && grid ? (
            <AccentNotationPreview measures={measures} grid={grid} />
          ) : null}
          {vr && Object.keys(vr).length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 8px", background: "#0a0a0a", borderRadius: 4, border: "1px solid #1a1a1a", marginBottom: 6 }}>
              {Object.entries(vr).map(([variant, r]) => (
                <span key={variant} style={{
                  fontSize: 10, padding: "2px 8px", borderRadius: 3,
                  background: `${RATING_COLORS[r]}15`,
                  border: `1px solid ${RATING_COLORS[r]}44`,
                  color: RATING_COLORS[r],
                  fontWeight: 600,
                  display: "inline-flex", alignItems: "center", gap: 4,
                }}>
                  {variant} <span style={{ letterSpacing: -1 }}>{"★".repeat(r)}<span style={{ opacity: 0.2 }}>{"★".repeat(5 - r)}</span></span>
                </span>
              ))}
            </div>
          ) : null}
        </>);
      })()}

      {/* Image preview (screenshot) — skip for drum modes that render live above */}
      {!(entry.mode === "drum-ostinato" || entry.mode === "accent-study") && (entry.snapshot.imagePreview as string | undefined) && (
        <div style={{
          borderRadius: 4,
          overflow: "hidden",
          marginBottom: 6,
          border: "1px solid #1a1a1a",
          lineHeight: 0,
        }}>
          <img
            src={entry.snapshot.imagePreview as string}
            alt="Preview"
            style={{ width: "100%", display: "block" }}
          />
        </div>
      )}

      {/* Ear-trainer: collapsible settings + stats (matches history panel) */}
      {entry.mode === "ear-trainer" && (entry.snapshot.settingsSnapshot as TabSettingsSnapshot | undefined) ? (
        <EarTrainerEntryBody entry={entry} onLoad={onLoad} />
      ) : (
        <>
          {/* Text preview (shown when no image and no notation) */}
          {!(entry.snapshot.imagePreview as string | undefined)
            && !(entry.mode === "konnakol-cycles" && (entry.snapshot.groups as KonnakolGroup[] | undefined)?.length)
            && !(entry.mode === "konnakol-mixed" && (entry.snapshot.chainGroups as KonnakolGroup[] | undefined)?.length)
            && !(entry.mode === "drum-ostinato" && (entry.snapshot.measures as DrumMeasure[] | undefined)?.length)
            && !(entry.mode === "drum-ostinato" && (entry.snapshot.interplayMeasures as InterplayMeasureData[] | undefined)?.length)
            && !(entry.mode === "accent-study" && ((entry.snapshot.variantRatings && Object.keys(entry.snapshot.variantRatings as Record<string, number>).length > 0) || (entry.snapshot.measures as AccentMeasureData[] | undefined)?.length))
            && (
            <div style={{
              fontSize: 10, color: "#666",
              padding: "6px 8px",
              background: "#111",
              borderRadius: 4,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              marginBottom: entry.canRestore ? 6 : 0,
            }}>
              {entry.preview || <span style={{ color: "#333", fontStyle: "italic" }}>No preview</span>}
            </div>
          )}

          {/* Load button(s) */}
          {entry.canRestore && entry.mode === "accent-study" && onLoadAccent ? (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
              {(["phrase", "line", "replace"] as AccentImportMode[]).map(mode => {
                const label = mode === "phrase" ? "+ Phrase" : mode === "line" ? "+ Line" : "↩ Replace";
                const hoverBg = mode === "replace" ? "#1a1a2a" : "#1a1a0e";
                const hoverBorder = mode === "replace" ? "#7173e6" : "#c8aa50";
                const hoverColor = mode === "replace" ? "#9999ee" : "#e0c060";
                return (
                  <button
                    key={mode}
                    onClick={() => onLoadAccent(mode)}
                    style={{
                      padding: "3px 10px",
                      background: "#111",
                      border: "1px solid #333",
                      color: "#888",
                      borderRadius: 4,
                      fontSize: 9,
                      fontWeight: 600,
                      cursor: "pointer",
                      letterSpacing: 1,
                      transition: "all 80ms",
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLElement).style.background = hoverBg;
                      (e.currentTarget as HTMLElement).style.borderColor = hoverBorder;
                      (e.currentTarget as HTMLElement).style.color = hoverColor;
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.background = "#111";
                      (e.currentTarget as HTMLElement).style.borderColor = "#333";
                      (e.currentTarget as HTMLElement).style.color = "#888";
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : entry.canRestore ? (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
              {onBookmark && (
                <BookmarkButton onClick={onBookmark} />
              )}
              <button
                onClick={onLoad}
                style={{
                  padding: "3px 10px",
                  background: "#111",
                  border: "1px solid #333",
                  color: "#888",
                  borderRadius: 4,
                  fontSize: 9,
                  fontWeight: 600,
                  cursor: "pointer",
                  letterSpacing: 1,
                  transition: "all 80ms",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = "#1a1a2a";
                  (e.currentTarget as HTMLElement).style.borderColor = "#7173e6";
                  (e.currentTarget as HTMLElement).style.color = "#9999ee";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = "#111";
                  (e.currentTarget as HTMLElement).style.borderColor = "#333";
                  (e.currentTarget as HTMLElement).style.color = "#888";
                }}
              >
                ↩ Load Back In
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ── Day Stats Dropdown ──────────────────────────────────────────────────────

function DayStatsDropdown({ dateStr }: { dateStr: string }) {
  const [open, setOpen] = useState(false);
  const daily = getDailyStats()[dateStr];
  if (!daily || Object.keys(daily).length === 0) return null;

  let totalC = 0, totalW = 0;
  const rows = Object.entries(daily)
    .map(([key, e]) => {
      totalC += e.correct;
      totalW += e.wrong;
      return { key, label: e.label, c: e.correct, w: e.wrong };
    })
    .sort((a, b) => (b.c + b.w) - (a.c + a.w));

  const total = totalC + totalW;

  return (
    <div style={{ marginBottom: 10 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          background: "none", border: "none", cursor: "pointer",
          padding: "2px 0", width: "100%",
        }}
      >
        <span style={{ fontSize: 9, color: "#444", transition: "transform 80ms", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
        <span style={{ fontSize: 10, color: "#666" }}>
          <span style={{ color: "#5cca5c" }}>✓{totalC}</span>
          {" "}
          <span style={{ color: "#e06060" }}>✗{totalW}</span>
          {" "}
          <span style={{ color: "#555" }}>{accuracy(totalC, totalW)}</span>
          <span style={{ color: "#333", marginLeft: 6 }}>({total} answers)</span>
        </span>
      </button>
      {open && (
        <div style={{
          marginTop: 4, padding: "6px 8px",
          background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: 5,
        }}>
          {rows.map(r => (
            <div key={r.key} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "3px 0", fontSize: 10,
            }}>
              <span style={{ color: "#555", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.label}
              </span>
              <span style={{ color: "#5cca5c", minWidth: 28, textAlign: "right" }}>✓{r.c}</span>
              <span style={{ color: "#e06060", minWidth: 28, textAlign: "right" }}>✗{r.w}</span>
              <span style={{ color: "#555", minWidth: 32, textAlign: "right" }}>{accuracy(r.c, r.w)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Modal ─────────────────────────────────────────────────────────────

export default function PracticeLogModal({ onClose, onLoadEntry, accentQueueCount = 0 }: Props) {
  const today = isoToday();
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [calYear,  setCalYear]  = useState(() => new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth());
  const [log, setLog] = useState<PracticeLogData>(() => getPracticeLog());
  const [datesWithEntries, setDatesWithEntries] = useState<Set<string>>(() => getDatesWithEntries());

  const [undoEntry, setUndoEntry] = useState<PracticeLogEntry | null>(null);
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");   // "all" | "isolation" | "context" | "untagged"
  const [accentVariantFilter, setAccentVariantFilter] = useState<string>("all");
  const [movingEntry, setMovingEntry] = useState<{ id: string; fromDate: string } | null>(null);

  const refresh = useCallback(() => {
    setLog(getPracticeLog());
    setDatesWithEntries(getDatesWithEntries());
  }, []);

  // Refresh when modal opens
  useEffect(() => { refresh(); }, [refresh]);

  const allEntries = log[selectedDate] ?? [];
  const activeTab = MODE_FILTER_TABS.find(t => t.key === modeFilter);
  const tagMatch = (e: PracticeLogEntry) =>
    tagFilter === "all" ? true
    : tagFilter === "untagged" ? !e.tag
    : e.tag === tagFilter;
  const accentVariantMatch = (e: PracticeLogEntry) =>
    accentVariantFilter === "all" || e.mode !== "accent-study"
      ? true
      : (e.snapshot?.variant as string | undefined) === accentVariantFilter;
  const entries = (modeFilter === "all"
    ? allEntries
    : allEntries.filter(e => activeTab?.modes.includes(e.mode))
  ).filter(tagMatch).filter(accentVariantMatch);


  const handleDelete = (id: string) => {
    const removed = deletePracticeEntry(selectedDate, id);
    if (removed) setUndoEntry(removed);
    refresh();
  };

  const handleUndo = () => {
    if (!undoEntry) return;
    restorePracticeEntry(undoEntry);
    setUndoEntry(null);
    refresh();
  };

  const handleMoveStart = (entryId: string) => {
    if (movingEntry?.id === entryId) {
      setMovingEntry(null);  // toggle off
    } else {
      setMovingEntry({ id: entryId, fromDate: selectedDate });
    }
  };

  const handleCalendarSelect = (date: string) => {
    if (movingEntry) {
      if (date !== movingEntry.fromDate) {
        movePracticeEntry(movingEntry.fromDate, movingEntry.id, date);
        setMovingEntry(null);
        refresh();
        setSelectedDate(date);  // jump to target day
      } else {
        setMovingEntry(null);  // clicked same day = cancel
      }
    } else {
      setSelectedDate(date);
    }
  };

  const handleLoad = (entry: PracticeLogEntry, importMode?: AccentImportMode) => {
    onLoadEntry(entry, importMode);
    // For additive accent imports (line/phrase), keep modal open so user can pick more
    if (importMode !== "line" && importMode !== "phrase") {
      onClose();
    }
  };

  const prevMonth = () => {
    setCalMonth(m => {
      if (m === 0) { setCalYear(y => y - 1); return 11; }
      return m - 1;
    });
  };

  const nextMonth = () => {
    setCalMonth(m => {
      if (m === 11) { setCalYear(y => y + 1); return 0; }
      return m + 1;
    });
  };

  const goToday = () => {
    const now = new Date();
    setCalYear(now.getFullYear());
    setCalMonth(now.getMonth());
    setSelectedDate(today);
  };

  const monthLabel = new Date(calYear, calMonth, 1).toLocaleDateString(undefined, {
    month: "long", year: "numeric",
  });

  const isThisMonth = calYear === new Date().getFullYear() && calMonth === new Date().getMonth();

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.85)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        paddingTop: 32, paddingBottom: 32,
        overflowY: "auto",
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "#0d0d0d",
        border: "1px solid #1e1e1e",
        borderRadius: 10,
        width: "calc(100vw - 64px)",
        maxWidth: 1200,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        height: "calc(100vh - 64px)",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid #1a1a1a",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 4, color: "#555", textTransform: "uppercase" }}>
              Practice Log
            </span>
            {undoEntry && (
              <button
                onClick={handleUndo}
                style={{
                  padding: "2px 8px",
                  background: "#1a1a0e",
                  border: "1px solid #4a4a2a",
                  color: "#c8aa50",
                  borderRadius: 4,
                  fontSize: 9,
                  fontWeight: 600,
                  cursor: "pointer",
                  letterSpacing: 0.5,
                  transition: "all 80ms",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = "#2a2a1a";
                  (e.currentTarget as HTMLElement).style.color = "#e0c060";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = "#1a1a0e";
                  (e.currentTarget as HTMLElement).style.color = "#c8aa50";
                }}
              >
                Undo delete
              </button>
            )}
            {accentQueueCount > 0 && (
              <span style={{
                fontSize: 9, fontWeight: 600, letterSpacing: 0.5,
                padding: "2px 8px", borderRadius: 10,
                background: "#9999ee22", color: "#9999ee",
              }}>
                {accentQueueCount} queued
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {accentQueueCount > 0 && (
              <button
                onClick={onClose}
                style={{
                  padding: "3px 10px",
                  background: "#1a1a2a",
                  border: "1px solid #7173e6",
                  color: "#9999ee",
                  borderRadius: 4,
                  fontSize: 9,
                  fontWeight: 600,
                  cursor: "pointer",
                  letterSpacing: 1,
                  transition: "all 80ms",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = "#2a2a4a";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = "#1a1a2a";
                }}
              >
                Done — Import All
              </button>
            )}
            <button
              onClick={onClose}
              style={{ background: "none", border: "none", color: "#555", fontSize: 16, cursor: "pointer", padding: "0 4px" }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body: two-column layout */}
        <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>

          {/* Left: Calendar */}
          <div style={{
            width: 280,
            flexShrink: 0,
            borderRight: "1px solid #1a1a1a",
            padding: "14px 14px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            overflowY: "auto",
          }}>
            {/* Month navigation */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
              <button onClick={prevMonth} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, padding: "2px 6px" }}>‹</button>
              <span style={{ fontSize: 11, color: "#aaa", fontWeight: 600, flex: 1, textAlign: "center" }}>{monthLabel}</span>
              <button onClick={nextMonth} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, padding: "2px 6px" }}>›</button>
            </div>

            <Calendar
              year={calYear}
              month={calMonth}
              datesWithEntries={datesWithEntries}
              selectedDate={selectedDate}
              onSelectDate={handleCalendarSelect}
            />

            {movingEntry && (
              <div style={{
                padding: "6px 8px",
                background: "#1a1a0e",
                border: "1px solid #4a4a2a",
                borderRadius: 5,
                fontSize: 9,
                color: "#c8aa50",
                textAlign: "center",
                lineHeight: 1.5,
              }}>
                Click a date to move entry
                <br />
                <button
                  onClick={() => setMovingEntry(null)}
                  style={{
                    marginTop: 4, padding: "2px 8px",
                    background: "none", border: "1px solid #333",
                    color: "#666", borderRadius: 3,
                    fontSize: 9, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            )}

            {!isThisMonth && (
              <button
                onClick={goToday}
                style={{
                  marginTop: 4, padding: "4px 0",
                  background: "#111", border: "1px solid #222", borderRadius: 4,
                  color: "#555", fontSize: 10, cursor: "pointer",
                }}
              >
                Today
              </button>
            )}

            {/* Summary */}
            <div style={{ borderTop: "1px solid #151515", paddingTop: 10 }}>
              <div style={{ fontSize: 9, color: "#333", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>This Month</div>
              {(() => {
                const prefix = `${calYear}-${String(calMonth + 1).padStart(2, "0")}`;
                const days = [...datesWithEntries].filter(d => d.startsWith(prefix));
                const total = days.reduce((sum, d) => sum + (log[d]?.length ?? 0), 0);
                return (
                  <div style={{ fontSize: 10, color: "#555" }}>
                    <span style={{ color: "#7173e6" }}>{days.length}</span> days active
                    {" · "}
                    <span style={{ color: "#7173e6" }}>{total}</span> entries
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Right: Day detail */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
            {/* Mode filter tabs */}
            <div style={{
              display: "flex", gap: 2, padding: "10px 16px 0",
              flexWrap: "wrap", flexShrink: 0,
            }}>
              {MODE_FILTER_TABS.map(tab => {
                // Only show tabs that have entries on this date
                const hasEntries = tab.key === "all"
                  || allEntries.some(e => tab.modes.includes(e.mode));
                if (!hasEntries) return null;
                const isActive = modeFilter === tab.key;
                const tabColor = tab.key === "all" ? "#888"
                  : MODE_COLORS[tab.modes[0]] ?? "#666";
                return (
                  <button
                    key={tab.key}
                    onClick={() => { setModeFilter(tab.key); if (tab.key !== "accent") setAccentVariantFilter("all"); }}
                    style={{
                      padding: "3px 9px",
                      borderRadius: 4,
                      border: isActive ? `1px solid ${tabColor}` : "1px solid transparent",
                      background: isActive ? tabColor + "18" : "transparent",
                      color: isActive ? tabColor : "#444",
                      fontSize: 9,
                      fontWeight: isActive ? 700 : 500,
                      letterSpacing: 0.5,
                      cursor: "pointer",
                      transition: "all 80ms",
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "10px 16px 14px", minWidth: 0 }}>

            {/* Tag sub-filter */}
            {(() => {
              // Collect unique tags across visible entries for this mode
              const relevantEntries = modeFilter === "all"
                  ? allEntries
                  : allEntries.filter(e => activeTab?.modes.includes(e.mode));
              const tags = new Set(relevantEntries.map(e => e.tag).filter(Boolean));
              if (tags.size === 0) return null;
              const filters = [
                { key: "all", label: "All", color: "#666" },
                ...Array.from(tags).map(t => ({ key: t!, label: TAG_META[t!]?.label ?? t!, color: TAG_META[t!]?.color ?? "#666" })),
                { key: "untagged", label: "Untagged", color: "#444" },
              ];
              return (
                <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                  {filters.map(f => {
                    const active = tagFilter === f.key;
                    return (
                      <button
                        key={f.key}
                        onClick={() => setTagFilter(f.key)}
                        style={{
                          padding: "2px 8px", borderRadius: 10, fontSize: 8, fontWeight: 700,
                          letterSpacing: 0.5, textTransform: "uppercase", cursor: "pointer",
                          border: `1px solid ${active ? f.color : "#1a1a1a"}`,
                          background: active ? f.color + "22" : "transparent",
                          color: active ? f.color : "#3a3a3a",
                          transition: "all 80ms",
                        }}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              );
            })()}

            {/* Accent interpretation sub-filter — two rows: accents then taps */}
            {modeFilter === "accent" && (() => {
              const allAccent = Object.values(log).flat().filter(e => e.mode === "accent-study" && tagMatch(e));
              const accVariants: string[] = [];
              const tapVariants: string[] = [];
              const seen = new Set<string>();
              for (const e of allAccent) {
                const v = (e.snapshot?.variant as string | undefined) ?? "";
                if (!v || seen.has(v)) continue;
                seen.add(v);
                if (v.startsWith("Accent:")) accVariants.push(v);
                else if (v.startsWith("Tap:")) tapVariants.push(v);
              }
              if (accVariants.length + tapVariants.length <= 1) return null;
              const pillBtn = (val: string, label: string, color: string) => {
                const active = accentVariantFilter === val;
                return (
                  <button
                    key={val}
                    onClick={() => setAccentVariantFilter(active ? "all" : val)}
                    style={{
                      padding: "2px 8px", borderRadius: 10, fontSize: 8, fontWeight: 700,
                      letterSpacing: 0.5, cursor: "pointer",
                      border: `1px solid ${active ? color : "#1a1a1a"}`,
                      background: active ? color + "22" : "transparent",
                      color: active ? color : "#3a3a3a",
                    }}
                  >{label}</button>
                );
              };
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <span style={{ fontSize: 7, color: "#444", fontWeight: 700, letterSpacing: 1.5, minWidth: 42 }}>ACCENT</span>
                    <button
                      onClick={() => setAccentVariantFilter("all")}
                      style={{
                        padding: "2px 8px", borderRadius: 10, fontSize: 8, fontWeight: 700,
                        letterSpacing: 0.5, cursor: "pointer",
                        border: `1px solid ${accentVariantFilter === "all" ? "#888" : "#1a1a1a"}`,
                        background: accentVariantFilter === "all" ? "#88888822" : "transparent",
                        color: accentVariantFilter === "all" ? "#888" : "#3a3a3a",
                      }}
                    >All</button>
                    {accVariants.map(v => pillBtn(v, v.replace("Accent: ", ""), "#c8aa50"))}
                  </div>
                  {tapVariants.length > 0 && (
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <span style={{ fontSize: 7, color: "#444", fontWeight: 700, letterSpacing: 1.5, minWidth: 42 }}>TAP</span>
                      <button
                        onClick={() => setAccentVariantFilter("all")}
                        style={{
                          padding: "2px 8px", borderRadius: 10, fontSize: 8, fontWeight: 700,
                          letterSpacing: 0.5, cursor: "pointer",
                          border: `1px solid ${accentVariantFilter === "all" ? "#888" : "#1a1a1a"}`,
                          background: accentVariantFilter === "all" ? "#88888822" : "transparent",
                          color: accentVariantFilter === "all" ? "#888" : "#3a3a3a",
                        }}
                      >All</button>
                      {tapVariants.map(v => pillBtn(v, v.replace("Tap: ", ""), "#7173e6"))}
                    </div>
                  )}
                </div>
              );
            })()}

            <div style={{
              fontSize: 10, color: "#555", marginBottom: 12,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span>{formatDateHeader(selectedDate)}</span>
              {selectedDate === today && (
                <span style={{ fontSize: 9, color: "#7173e6", letterSpacing: 1 }}>TODAY</span>
              )}
            </div>

            {entries.length === 0 ? (
              <div style={{
                padding: "32px 0", textAlign: "center",
                fontSize: 10, color: "#2a2a2a",
                fontStyle: "italic",
              }}>
                Nothing logged on this day.
              </div>
            ) : (
              entries.map(entry => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  onDelete={() => handleDelete(entry.id)}
                  onLoad={() => handleLoad(entry)}
                  onLoadAccent={entry.mode === "accent-study" ? (mode) => handleLoad(entry, mode) : undefined}
                  onBookmark={entry.mode === "drum-ostinato" && entry.canRestore
                    ? () => addQuickmarkFromSnapshot(entry.snapshot)
                    : undefined}
                  onRatingChange={(r) => { updatePracticeEntry(entry.date, entry.id, { rating: r as 0|1|2|3|4|5 }); refresh(); }}
                  onTagChange={(t) => { updatePracticeEntry(entry.date, entry.id, { tag: t }); refresh(); }}
                  onMoveStart={() => handleMoveStart(entry.id)}
                  isMoving={movingEntry?.id === entry.id}
                />
              ))
            )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
