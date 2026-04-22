import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  type DrumVoice, type VocalPattern, type VocalSlot,
  generateFromGrouping, generatePulseGrouping,
  applyGrooveVoicing, applySplits, parseGrouping,
  schedulePulseClick,
} from "@/lib/vocalPercussionData";
import type { KonnakolGroup, KonnakolNote } from "@/lib/konnakolData";
import { generateMusicalGrouping, generateAwkwardGrouping } from "@/lib/accentData";
import { generateAndSelectGrouping } from "@/lib/groupingSelector";
import KonnakolNotation from "./KonnakolNotation";
import PracticeLogSaveBar from "@/components/PracticeLogSaveBar";

/* Mixed Groups — pulse-driven rhythmic groupings (triplet + 16th).
 * Derived from VocalPercussion but with voices removed: noteheads render in
 * the default (neutral) style, there is no voice selection, no mute row, and
 * no color legend.  The internal voice is forced to "kick" so the generator
 * still produces valid VocalPatterns. */

const SINGLE_VOICE: DrumVoice[] = ["kick"];

function groupSizeToNotation(size: number, sixteenthMode = false): { duration: string; subdivision: number; noTuplet: boolean } {
  if (sixteenthMode) return { duration: "16", subdivision: size, noTuplet: true };
  if (size === 1) return { duration: "q", subdivision: 1, noTuplet: true };
  if (size === 2) return { duration: "8", subdivision: 2, noTuplet: true };
  if (size === 3) return { duration: "8", subdivision: 3, noTuplet: false };
  if (size === 4) return { duration: "16", subdivision: 4, noTuplet: true };
  if (size === 5) return { duration: "16", subdivision: 5, noTuplet: false };
  if (size === 6) return { duration: "16", subdivision: 6, noTuplet: false };
  if (size === 7) return { duration: "16", subdivision: 7, noTuplet: false };
  if (size === 8) return { duration: "32", subdivision: 8, noTuplet: true };
  return { duration: "16", subdivision: size, noTuplet: false };
}

function tryConsolidatedDuration(units: number, baseDuration: string): string | null {
  const baseToUnits: Record<string, number> = { "32": 0.5, "16": 1, "8": 2, "q": 4 };
  const baseUnit = baseToUnits[baseDuration] ?? 1;
  const totalUnits = units * baseUnit;
  const map: Record<number, string> = {
    0.5: "32", 1: "16", 1.5: "16.", 2: "8", 3: "8.",
    4: "q", 6: "q.", 8: "h", 12: "h.", 16: "w",
  };
  return map[totalUnits] ?? null;
}

function halfDuration(d: string): string {
  if (d === "q") return "8";
  if (d === "8") return "16";
  if (d === "16") return "32";
  return d;
}

/** Consolidate slots into KonnakolNotes WITHOUT voice colors — noteheads
 *  fall back to the default (white-on-black) style for a voice-agnostic
 *  rhythm display. */
function consolidateSlots(slots: VocalSlot[], baseDuration: string, isTuplet = false): KonnakolNote[] {
  const emitSplitPair = (slot: VocalSlot, dur: string): KonnakolNote[] => {
    const half = halfDuration(dur);
    return [
      { syllable: "", noteType: "normal" as const, accent: slot.isAccent, duration: half },
      { syllable: "", noteType: "normal" as const, accent: false, duration: half },
    ];
  };

  if (isTuplet) {
    const out: KonnakolNote[] = [];
    for (const slot of slots) {
      if (slot.isRest) {
        out.push({ syllable: "", noteType: "rest" as const, accent: false, duration: baseDuration });
        continue;
      }
      if (slot.isSplit) {
        out.push(...emitSplitPair(slot, baseDuration));
        continue;
      }
      out.push({
        syllable: "",
        noteType: "normal" as const,
        accent: slot.isAccent,
        duration: baseDuration,
      });
    }
    return out;
  }
  const out: KonnakolNote[] = [];
  let i = 0;
  while (i < slots.length) {
    const slot = slots[i];
    if (slot.isRest) {
      let n = 1;
      while (i + n < slots.length && slots[i + n].isRest) n++;
      const dur = tryConsolidatedDuration(n, baseDuration);
      if (dur !== null) {
        out.push({ syllable: "", noteType: "rest", accent: false, duration: dur });
      } else {
        for (let k = 0; k < n; k++) {
          out.push({ syllable: "", noteType: "rest", accent: false, duration: baseDuration });
        }
      }
      i += n;
    } else if (slot.isSplit) {
      out.push(...emitSplitPair(slot, baseDuration));
      i += 1;
    } else {
      let trailingRests = 0;
      while (i + 1 + trailingRests < slots.length && slots[i + 1 + trailingRests].isRest) {
        trailingRests++;
      }
      const dur = tryConsolidatedDuration(1 + trailingRests, baseDuration);
      if (dur !== null) {
        out.push({
          syllable: "",
          noteType: "normal",
          accent: slot.isAccent,
          duration: dur,
        });
        i += 1 + trailingRests;
      } else {
        out.push({
          syllable: "",
          noteType: "normal",
          accent: slot.isAccent,
          duration: baseDuration,
        });
        for (let k = 0; k < trailingRests; k++) {
          out.push({ syllable: "", noteType: "rest", accent: false, duration: baseDuration });
        }
        i += 1 + trailingRests;
      }
    }
  }
  return out;
}

/** Apply accents at the cumulative starting positions of `accentGrouping`.
 *  Example: grouping [4,3,3] over 10 slots → accents at slots 0, 4, 7. */
function applyAccentsFromGrouping(
  pattern: VocalPattern,
  accentGrouping: number[],
): VocalPattern {
  const totalSlots = pattern.groups.reduce((s, g) => s + g.size, 0);
  const accentStarts = new Set<number>();
  let cursor = 0;
  for (const size of accentGrouping) {
    if (cursor < totalSlots) accentStarts.add(cursor);
    cursor += size;
  }

  let globalIdx = 0;
  const groups = pattern.groups.map(g => {
    const slots = g.slots.map(s => {
      const isAccent = accentStarts.has(globalIdx);
      globalIdx++;
      return { ...s, isAccent };
    });
    return { ...g, slots };
  });
  return { ...pattern, groups };
}

function toKonnakolGroups(pattern: VocalPattern, sixteenthMode = false): KonnakolGroup[] {
  return pattern.groups.map(g => {
    const { duration, subdivision, noTuplet } = groupSizeToNotation(g.size, sixteenthMode);
    const isTuplet = !noTuplet;
    return { notes: consolidateSlots(g.slots, duration, isTuplet), subdivision, noTuplet };
  });
}

const DUR_SLOTS: Record<string, number> = { "32": 0.5, "16": 1, "8": 2, "q": 4 };

function slotsToDurations(slots: number): string[] {
  const out: string[] = [];
  let remaining = slots;
  for (const d of ["q", "8", "16", "32"] as const) {
    const s = DUR_SLOTS[d];
    while (remaining >= s - 1e-6) {
      out.push(d);
      remaining -= s;
    }
  }
  return out;
}

function groupVisualSlots(pattern: VocalPattern, sixteenthMode: boolean): number[] {
  return pattern.groups.map(g => {
    const { duration } = groupSizeToNotation(g.size, sixteenthMode);
    return g.size * (DUR_SLOTS[duration] ?? 1);
  });
}

function toPulseGroups(pattern: VocalPattern, numPulses: number, sixteenthMode = false): KonnakolGroup[] {
  const gSlots = groupVisualSlots(pattern, sixteenthMode);
  const totalVisualSlots = gSlots.reduce((s, x) => s + x, 0);
  const n = Math.max(1, Math.floor(numPulses));

  const pulseAt: number[] = [];
  for (let i = 0; i < n; i++) pulseAt.push((i * totalVisualSlots) / n);

  const out: KonnakolGroup[] = [];
  let groupStart = 0;
  for (let gi = 0; gi < pattern.groups.length; gi++) {
    const { subdivision } = groupSizeToNotation(pattern.groups[gi].size, sixteenthMode);
    const groupSize = gSlots[gi];
    const groupEnd = groupStart + groupSize;

    const localPulses: number[] = pulseAt
      .filter(p => p >= groupStart - 1e-6 && p < groupEnd - 1e-6)
      .map(p => p - groupStart);

    const notes: KonnakolNote[] = [];
    const emit = (slots: number, asRest: boolean, hidden: boolean) => {
      if (slots <= 1e-6) return;
      for (const d of slotsToDurations(slots)) {
        notes.push({
          syllable: "",
          noteType: asRest ? "rest" : "normal",
          accent: false,
          duration: d,
          hidden,
        });
      }
    };

    let localCursor = 0;
    for (let pi = 0; pi < localPulses.length; pi++) {
      const pPos = localPulses[pi];
      const gap = pPos - localCursor;
      if (gap > 1e-6) emit(gap, true, true);
      const nextGlobal = pi + 1 < localPulses.length
        ? localPulses[pi + 1] + groupStart
        : (pulseAt.find(p => p >= groupEnd - 1e-6) ?? totalVisualSlots);
      const room = Math.min(nextGlobal - (pPos + groupStart), groupEnd - (pPos + groupStart));
      const pulseDur = Math.max(1, Math.min(4, Math.floor(room)));
      emit(pulseDur, false, false);
      localCursor = pPos + pulseDur;
    }

    const tail = groupSize - localCursor;
    if (tail > 1e-6) emit(tail, true, true);

    out.push({ notes, subdivision, noTuplet: true });
    groupStart = groupEnd;
  }

  return out;
}

function PlainStaff({
  groups, width, height,
  pulseGroups, pulseHeight,
}: {
  groups: KonnakolGroup[];
  width: number;
  height: number;
  pulseGroups?: KonnakolGroup[] | null;
  pulseHeight?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={wrapRef}>
      <KonnakolNotation
        groups={groups}
        width={width}
        height={height}
        singleLine
        noteKey="f/5"
        pulseGroups={pulseGroups ?? undefined}
        pulseHeight={pulseHeight}
        stemless
      />
    </div>
  );
}
import type { GroupingMode } from "@/lib/groupingSelector";

/* ── Constants ────────────────────────────────────────────────────────────── */

const GROUPING_MODES: { value: GroupingMode; label: string; color: string }[] = [
  { value: "musical", label: "Musical", color: "#60c0a0" },
  { value: "awkward", label: "Awkward", color: "#e09060" },
  { value: "both",    label: "Both",    color: "#9999ee" },
];

/* ── Pattern Display ──────────────────────────────────────────────────────── */

function PatternDisplay({
  pattern, numPulses, sixteenthMode,
}: {
  pattern: VocalPattern;
  numPulses: number | null;
  sixteenthMode: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [availW, setAvailW] = useState(1000);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth - 24;
      setAvailW(Math.max(320, w));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const konnakolMainGroups = useMemo(() => toKonnakolGroups(pattern, sixteenthMode), [pattern, sixteenthMode]);
  const konnakolPulseGroups = useMemo(
    () => (numPulses && numPulses > 0 ? toPulseGroups(pattern, numPulses, sixteenthMode) : null),
    [pattern, numPulses, sixteenthMode],
  );

  const bars = useMemo(() => {
    if (!pattern.meterBeats) {
      return [{
        groups: konnakolMainGroups,
        pulseGroups: konnakolPulseGroups,
        groupRange: [0, pattern.groups.length] as [number, number],
      }];
    }
    const meter = pattern.meterBeats;
    const out: Array<{
      groups: KonnakolGroup[];
      pulseGroups: KonnakolGroup[] | null;
      groupRange: [number, number];
    }> = [];
    for (let gi = 0; gi < konnakolMainGroups.length; gi += meter) {
      const slice = konnakolMainGroups.slice(gi, gi + meter);
      const pulseSlice = konnakolPulseGroups ? konnakolPulseGroups.slice(gi, gi + meter) : null;
      out.push({
        groups: slice,
        pulseGroups: pulseSlice,
        groupRange: [gi, Math.min(gi + meter, konnakolMainGroups.length)] as [number, number],
      });
    }
    return out;
  }, [pattern, konnakolMainGroups, konnakolPulseGroups]);

  const PER_NOTE_PX = 42;
  const ROW_OVERHEAD_PX = 40;
  const splitBarIntoRows = (
    groups: KonnakolGroup[],
    pulseGroups: KonnakolGroup[] | null,
    maxW: number,
  ) => {
    type Row = {
      groups: KonnakolGroup[];
      pulseGroups: KonnakolGroup[] | null;
      width: number;
    };
    const rows: Row[] = [];
    const rowBudget = Math.max(320, maxW);
    let rowStart = 0;
    let rowNoteLen = 0;

    const flush = (endGi: number) => {
      const slice = groups.slice(rowStart, endGi);
      const pulseSlice = pulseGroups ? pulseGroups.slice(rowStart, endGi) : null;
      const totalNoteLen = slice.reduce((s, g) => s + g.notes.length, 0);
      const naturalW = totalNoteLen * PER_NOTE_PX + ROW_OVERHEAD_PX;
      const width = Math.min(rowBudget, Math.max(280, naturalW));
      rows.push({ groups: slice, pulseGroups: pulseSlice, width });
    };

    for (let gi = 0; gi < groups.length; gi++) {
      const len = groups[gi].notes.length;
      const projected = (rowNoteLen + len) * PER_NOTE_PX + ROW_OVERHEAD_PX;
      if (rowNoteLen > 0 && projected > rowBudget) {
        flush(gi);
        rowStart = gi;
        rowNoteLen = len;
      } else {
        rowNoteLen += len;
      }
    }
    if (rowStart < groups.length) flush(groups.length);
    return rows;
  };

  const accentStructure = (() => {
    const positions: number[] = [];
    let idx = 0;
    for (const g of pattern.groups) {
      for (const s of g.slots) {
        if (s.isAccent) positions.push(idx);
        idx++;
      }
    }
    if (positions.length === 0) return { grouping: pattern.grouping };
    const grouping: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      const next = i + 1 < positions.length ? positions[i + 1] : pattern.totalSlots;
      grouping.push(next - positions[i]);
    }
    return { grouping };
  })();

  return (
    <div ref={hostRef} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "#c8aa50", fontWeight: 700 }}>
          {accentStructure.grouping.join(" + ")}
        </span>
        {accentStructure.grouping.join(",") !== pattern.grouping.join(",") && (
          <span style={{ fontSize: 10, color: "#666" }}>
            over subdiv {pattern.grouping.join("+")}
          </span>
        )}
        <span style={{ fontSize: 10, color: "#444" }}>
          = {pattern.totalSlots} notes
        </span>
      </div>

      {bars.map((bar, barIdx) => {
        const rows = splitBarIntoRows(bar.groups, bar.pulseGroups, availW);
        return (
          <div key={barIdx} style={{
            display: "flex", flexDirection: "column", gap: 6,
            background: "#0a0a0a", borderRadius: 8, border: "1px solid #1a1a1a",
            padding: "6px 10px",
          }}>
            {bars.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  fontSize: 9, fontWeight: 700, color: "#9999ee", letterSpacing: 1,
                }}>BAR {barIdx + 1}</span>
                <span style={{ fontSize: 8, color: "#444" }}>
                  groups {bar.groupRange[0] + 1}–{bar.groupRange[1]}
                </span>
              </div>
            )}

            {rows.map((row, rowIdx) => (
              <div key={rowIdx} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <PlainStaff
                  groups={row.groups}
                  width={row.width}
                  height={180}
                  pulseGroups={row.pulseGroups}
                  pulseHeight={row.pulseGroups && row.pulseGroups.length > 0 ? 140 : undefined}
                />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/* ── Main Component ───────────────────────────────────────────────────────── */

export default function MixedGroups() {
  const [groupingMode, setGroupingMode] = useState<GroupingMode>("musical");
  // Only triplet (3) and 16th (4) are allowed for Mixed Groups.  Stored as a
  // settable set so the user can restrict to just one of them.
  // Subdivision is fixed to 16th (4) — triplet/other subdivisions removed.
  const allowedSubdivisions: number[] = [4];
  const [numPulses, setNumPulses] = useState<number>(16);
  // Mixed Groups mode: pick one subdivision, render mix of its groupings.
  const [mixedGroupsMode, setMixedGroupsMode] = useState(true);
  // Groupings mode: uniform N-sized groups (tuplets), with accents placed by
  // the Musical/Awkward/Both picker independently of the N-grouping.  The
  // two modes are mutually exclusive — toggling one clears the other.
  const [groupingsMode, setGroupingsMode] = useState(false);
  const [groupingSize, setGroupingSize] = useState<number>(4);
  // Custom accent spacing. Empty → accents fall on pattern's group starts.
  // Single number "4" → accent every 4 slots. "4+3+3" → accents at 0, 4, 7.
  const [accentWriteIn, setAccentWriteIn] = useState("");
  const [splits32Enabled, setSplits32Enabled] = useState(false);

  const canUseMixedGroupsMode = allowedSubdivisions.length > 0;
  const effectiveMixedGroupsMode = mixedGroupsMode && canUseMixedGroupsMode && !groupingsMode;

  const [pattern, setPattern] = useState<VocalPattern | null>(null);
  const [history, setHistory] = useState<VocalPattern[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  const [practiceTag, setPracticeTag] = useState<string>("isolation");
  const patternCaptureRef = useRef<HTMLDivElement>(null);

  const prevGroupingsRef = useRef<number[][]>([]);

  // ── Metronome ─────────────────────────────────────────────────────────
  // One click per pulse. Individual circles toggle per-pulse mute; a periodic
  // "silence every N for N" pattern alternates N pulses audible with N
  // pulses silent (both counts share the same N).
  // Default: every circle muted so no clicks play until the user opts in.
  // Pre-populate with a wide index range so resizing metronomePulses later
  // still starts those new pulses muted.
  const [mutedPulses, setMutedPulses] = useState<Set<number>>(
    () => new Set(Array.from({ length: 128 }, (_, i) => i)),
  );
  const [silenceEveryEnabled, setSilenceEveryEnabled] = useState(false);
  const [silenceEveryN, setSilenceEveryN] = useState(4);
  const [silenceForN, setSilenceForN] = useState(4);
  const [metronomeBpm, setMetronomeBpm] = useState(80);
  const [metronomePulses, setMetronomePulses] = useState(16);
  const [metronomePlaying, setMetronomePlaying] = useState(false);
  const [activePulse, setActivePulse] = useState<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stopRef = useRef(false);
  // Refs mirror the latest state so the running scheduler can pick up
  // changes (mute toggles, bpm, pulse count, silence pattern) without
  // being restarted — avoids the audible hiccup of stop-then-start.
  const mutedPulsesRef = useRef<Set<number>>(mutedPulses);
  const silenceEveryEnabledRef = useRef(silenceEveryEnabled);
  const silenceEveryNRef = useRef(silenceEveryN);
  const silenceForNRef = useRef(silenceForN);
  const metronomeBpmRef = useRef(metronomeBpm);
  const metronomePulsesRef = useRef(metronomePulses);
  useEffect(() => { mutedPulsesRef.current = mutedPulses; }, [mutedPulses]);
  useEffect(() => { silenceEveryEnabledRef.current = silenceEveryEnabled; }, [silenceEveryEnabled]);
  useEffect(() => { silenceEveryNRef.current = silenceEveryN; }, [silenceEveryN]);
  useEffect(() => { silenceForNRef.current = silenceForN; }, [silenceForN]);
  useEffect(() => { metronomeBpmRef.current = metronomeBpm; }, [metronomeBpm]);
  useEffect(() => { metronomePulsesRef.current = metronomePulses; }, [metronomePulses]);

  const ensureAudio = useCallback(async () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed")
      audioCtxRef.current = new AudioContext();
    if (audioCtxRef.current.state === "suspended")
      await audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  const stopMetronome = useCallback(() => {
    stopRef.current = true;
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    setMetronomePlaying(false);
    setActivePulse(null);
  }, []);

  const startMetronome = useCallback(async () => {
    stopMetronome();
    const ctx = await ensureAudio();
    stopRef.current = false;
    setMetronomePlaying(true);

    // Scheduler fires once per pulse, reads the latest state refs, schedules
    // the upcoming click in AudioContext time (with a ~40 ms lookahead), then
    // reschedules itself. Any state change propagates on the NEXT pulse with
    // no audible gap.
    let pulseCounter = 0;
    const tick = () => {
      if (stopRef.current) return;
      const bpm = metronomeBpmRef.current;
      const mp = Math.max(1, metronomePulsesRef.current);
      const secPerPulse = 60 / bpm;
      const idxInCycle = pulseCounter % mp;

      setActivePulse(idxInCycle);

      const muted = mutedPulsesRef.current.has(idxInCycle);
      const period = silenceEveryNRef.current + silenceForNRef.current;
      const periodicMuted = silenceEveryEnabledRef.current
        && silenceEveryNRef.current > 0 && silenceForNRef.current > 0
        && (idxInCycle % period) >= silenceEveryNRef.current;

      if (!muted && !periodicMuted) {
        schedulePulseClick(ctx, ctx.currentTime + 0.04, 0.5);
      }

      pulseCounter++;
      timersRef.current.push(setTimeout(tick, secPerPulse * 1000));
    };

    tick();
  }, [ensureAudio, stopMetronome]);

  useEffect(() => () => { stopMetronome(); }, [stopMetronome]);

  const togglePulseMute = useCallback((i: number) => {
    setMutedPulses(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }, []);

  const generate = useCallback(() => {
    let pat: VocalPattern;
    // If true, the accent-from-grouping step below should compute an accent
    // partition from Musical/Awkward/Both instead of falling back to the
    // pattern's natural group starts. Used by Groupings mode.
    let forceAccentFromGroupingMode = false;

    const SUBDIV_LABELS: Record<number, "triplet" | "16th"> = { 3: "triplet", 4: "16th" };

    if (groupingsMode) {
      // Uniform N-sized groups. Pattern span ≈ numPulses slots (rounded to
      // a whole multiple of N). Each group renders as its natural tuplet:
      //   N=3 triplet, N=4 flat 16ths, N=5 quintuplet, N=6 sextuplet, etc.
      const N = Math.max(2, Math.min(12, Math.floor(groupingSize) || 4));
      const groupCount = Math.max(1, Math.round(numPulses / N));
      const g = Array(groupCount).fill(N);
      pat = generateFromGrouping(g, SINGLE_VOICE, 0);
      forceAccentFromGroupingMode = true;
    } else if (effectiveMixedGroupsMode) {
      // Pick one subdivision from the allowed set and generate a
      // musical/awkward grouping at that density. Triplets render as real
      // tuplet brackets; 16ths render flat.
      const pool = allowedSubdivisions.filter(n => SUBDIV_LABELS[n]);
      const chosen = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : 4;
      const beats = Math.max(1, Math.round(numPulses / chosen));
      let g: number[];
      if (chosen === 3) {
        // Triplet subdivision: enforce uniform size-3 groups so every group
        // is a proper triplet.  The musical-grouping generator's palette can
        // include 5/6/7 which render as quintuplet/sextuplet/septuplet
        // brackets — wrong for a triplet context.
        g = Array(beats).fill(3);
      } else {
        const picker = groupingMode === "awkward" ? generateAwkwardGrouping : generateMusicalGrouping;
        g = picker(SUBDIV_LABELS[chosen], beats, [], prevGroupingsRef.current);
      }
      pat = generateFromGrouping(g, SINGLE_VOICE, 0);
      prevGroupingsRef.current.push(g);
      if (prevGroupingsRef.current.length > 20) prevGroupingsRef.current.shift();
    } else {
      const g = generatePulseGrouping(numPulses, allowedSubdivisions, groupingMode, prevGroupingsRef.current);
      pat = generateFromGrouping(g, SINGLE_VOICE, 0);
      prevGroupingsRef.current.push(g);
      if (prevGroupingsRef.current.length > 20) prevGroupingsRef.current.shift();
    }

    // Accent placement:
    //   - write-in non-empty + valid → override with that grouping
    //   - else if Groupings mode → use Musical/Awkward/Both partition of
    //     totalSlots (creates cross-rhythm against the uniform N-groups)
    //   - else → keep pattern's natural group-start accents
    const writeIn = accentWriteIn.trim();
    const totalSlots = pat.groups.reduce((s, g) => s + g.size, 0);
    const parsedWriteIn = writeIn ? parseGrouping(writeIn) : null;

    if (parsedWriteIn && parsedWriteIn.length > 0) {
      const grp = parsedWriteIn.length === 1
        ? Array(Math.max(1, Math.ceil(totalSlots / parsedWriteIn[0]))).fill(parsedWriteIn[0])
        : parsedWriteIn;
      pat = applyAccentsFromGrouping(pat, grp);
    } else if (forceAccentFromGroupingMode) {
      const mode = groupingMode === "both"
        ? (Math.random() < 0.5 ? "musical" : "awkward")
        : groupingMode;
      const accentGrp = generateAndSelectGrouping(totalSlots, mode) ?? [totalSlots];
      pat = applyAccentsFromGrouping(pat, accentGrp);
    }

    pat = applyGrooveVoicing(pat, SINGLE_VOICE, { suppressHat: false });

    const splitSizes = new Set<number>();
    if (splits32Enabled) splitSizes.add(4);
    if (splitSizes.size > 0) pat = applySplits(pat, splitSizes);

    setPattern(pat);
    setHistory(prev => [...prev, pat]);
    setHistoryIdx(prev => prev + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPulses, groupingMode, splits32Enabled, effectiveMixedGroupsMode, groupingsMode, groupingSize, accentWriteIn]);

  useEffect(() => { if (!pattern) generate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectHistory = useCallback((idx: number) => {
    setPattern(history[idx]);
    setHistoryIdx(idx);
  }, [history]);

  const chk = (on: boolean, color: string) => ({
    width: 16, height: 16, borderRadius: 4, cursor: "pointer",
    border: `1.5px solid ${on ? color : "#333"}`,
    background: on ? color + "33" : "#111",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 10, color: on ? color : "transparent", flexShrink: 0,
  } as const);

  return (
    <div style={{ margin: "0 auto", padding: "8px 4px", width: "100%" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>

        {/* LEFT: Controls */}
        <div style={{
          display: "flex", flexDirection: "column", gap: 12,
          minWidth: 210, maxWidth: 250, flexShrink: 0,
          background: "#0e0e0e", borderRadius: 10, border: "1px solid #1a1a1a",
          padding: "14px 12px",
        }}>

          {/* Pulses — the cycle length in 16th-note slots. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="number" min={1} max={64} value={numPulses}
                onChange={e => {
                  const v = Number(e.target.value) || 1;
                  setNumPulses(Math.max(1, Math.min(64, v)));
                }}
                style={{
                  width: 48, height: 28, borderRadius: 5, fontSize: 12,
                  border: "1.5px solid #2a2a2a", background: "#111",
                  color: "#c8aa50", textAlign: "center", outline: "none",
                }}
              />
              <span style={{ fontSize: 9, color: "#555", marginLeft: 2, marginRight: 4 }}>pulses</span>
              {[8, 12, 16, 20, 24].map(n => (
                <button key={n} onClick={() => setNumPulses(n)} style={{
                  width: 24, height: 22, borderRadius: 4, fontSize: 9, fontWeight: 700,
                  border: `1px solid ${numPulses === n ? "#c8aa50" : "#1e1e1e"}`,
                  background: numPulses === n ? "#c8aa5022" : "#111",
                  color: numPulses === n ? "#c8aa50" : "#444", cursor: "pointer",
                }}>{n}</button>
              ))}
            </div>
          </div>

          {/* Accents — pick the grouping flavor used to place accents on the
              pattern. Musical/Awkward/Both also seed the rhythm partition.
              The write-in overrides accent placement: "4" → every 4 slots;
              "4+3+3" → accents at slots 0, 4, 7. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10, color: "#555", fontWeight: 700, letterSpacing: 1 }}>ACCENTS</span>
            <div style={{ display: "flex", gap: 3 }}>
              {GROUPING_MODES.map(m => {
                const on = groupingMode === m.value;
                return (
                  <button key={m.value} onClick={() => setGroupingMode(m.value)} style={{
                    flex: 1, height: 22, borderRadius: 4, fontSize: 10, fontWeight: 700,
                    border: `1.5px solid ${on ? m.color : "#222"}`,
                    background: on ? m.color + "22" : "#111",
                    color: on ? m.color : "#555", cursor: "pointer",
                  }}>{m.label}</button>
                );
              })}
            </div>
            <input
              value={accentWriteIn}
              onChange={e => setAccentWriteIn(e.target.value)}
              placeholder="e.g. 4  or  4+3+3"
              style={{
                height: 26, borderRadius: 4, fontSize: 11, fontWeight: 600,
                border: `1.5px solid ${accentWriteIn.trim() && parseGrouping(accentWriteIn) ? "#e09060" : accentWriteIn.trim() ? "#e0606066" : "#2a2a2a"}`,
                background: "#111", color: "#e09060", textAlign: "center", outline: "none", padding: "0 8px",
              }}
            />
          </div>


          {/* Mode toggles */}
          <div style={{ display: "flex", flexDirection: "column", gap: 7, borderTop: "1px solid #1a1a1a", paddingTop: 10 }}>

            {/* Mixed Groups toggle — picks one subdivision (3 or 4) and
                generates a musical/awkward partition at that density. */}
            <div
              onClick={canUseMixedGroupsMode ? () => {
                setMixedGroupsMode(v => !v);
                setGroupingsMode(false);
              } : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                cursor: canUseMixedGroupsMode ? "pointer" : "not-allowed",
                opacity: canUseMixedGroupsMode ? 1 : 0.35,
              }}
              title={canUseMixedGroupsMode ? "" : "Enable a subdivision to use"}
            >
              <div style={chk(effectiveMixedGroupsMode, "#60c0a0")}>{effectiveMixedGroupsMode && "✓"}</div>
              <span style={{
                fontSize: 11, fontWeight: 600,
                color: effectiveMixedGroupsMode ? "#60c0a0" : "#555",
              }}>
                Mixed Groups
              </span>
            </div>

            {/* Groupings toggle — uniform N-sized groups (tuplets) with
                accents placed by the Musical/Awkward/Both partition,
                creating a cross-rhythm against the N-groups. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div
                onClick={() => {
                  setGroupingsMode(v => !v);
                  setMixedGroupsMode(false);
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                }}
              >
                <div style={chk(groupingsMode, "#9999ee")}>{groupingsMode && "✓"}</div>
                <span style={{
                  fontSize: 11, fontWeight: 600,
                  color: groupingsMode ? "#9999ee" : "#555",
                }}>
                  Groupings
                </span>
              </div>
              {groupingsMode && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 24 }}>
                  <span style={{ fontSize: 10, color: "#888" }}>size</span>
                  <input type="number" min={2} max={12} value={groupingSize}
                    onChange={e => {
                      const v = Number(e.target.value) || 4;
                      setGroupingSize(Math.max(2, Math.min(12, v)));
                    }}
                    style={{
                      width: 46, height: 22, borderRadius: 4, padding: "0 6px",
                      border: "1px solid #222", background: "#111",
                      color: "#9999ee", fontSize: 11, fontWeight: 700, textAlign: "center", outline: "none",
                    }}
                  />
                  {[3, 4, 5, 6, 7].map(n => (
                    <button key={n} onClick={() => setGroupingSize(n)} style={{
                      width: 22, height: 20, borderRadius: 4, fontSize: 9, fontWeight: 700,
                      border: `1px solid ${groupingSize === n ? "#9999ee" : "#1e1e1e"}`,
                      background: groupingSize === n ? "#9999ee22" : "#111",
                      color: groupingSize === n ? "#9999ee" : "#444", cursor: "pointer",
                    }}>{n}</button>
                  ))}
                </div>
              )}
            </div>

            {/* Splits — split selected 16ths into 32nd pairs. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, color: "#555", fontWeight: 700, letterSpacing: 1 }}>SPLITS</span>
              <button
                onClick={() => setSplits32Enabled(v => !v)}
                title="Split 16ths into 32nd pairs"
                style={{
                  height: 22, borderRadius: 4, fontSize: 9, fontWeight: 700,
                  border: `1.5px solid ${splits32Enabled ? "#9999ee" : "#222"}`,
                  background: splits32Enabled ? "#9999ee22" : "#111",
                  color: splits32Enabled ? "#9999ee" : "#444",
                  cursor: "pointer",
                }}
              >32nd</button>
            </div>
          </div>

          {/* Generate */}
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2 }}>
            <button onClick={generate} style={{
              height: 34, borderRadius: 6, fontSize: 12, fontWeight: 700,
              border: "1.5px solid #c8aa50", background: "#c8aa5022",
              color: "#c8aa50", cursor: "pointer",
            }}>Generate</button>
          </div>

          {history.length > 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 160, overflowY: "auto" }}>
              <span style={{ fontSize: 9, color: "#444", fontWeight: 700, letterSpacing: 1 }}>HISTORY</span>
              {history.map((pat, i) => (
                <button key={i} onClick={() => selectHistory(i)} style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "3px 8px", borderRadius: 5, textAlign: "left",
                  border: `1px solid ${i === historyIdx ? "#9999ee44" : "#151515"}`,
                  background: i === historyIdx ? "#9999ee0d" : "transparent",
                  color: i === historyIdx ? "#9999ee" : "#444", cursor: "pointer", fontSize: 10,
                }}>
                  <span style={{ color: "#333" }}>#{i + 1}</span>
                  <span>{(pat.phraseGrouping ?? pat.grouping).join("+")}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT: Pattern */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <PracticeLogSaveBar
            mode="mixed-groups"
            label="Mixed Groups"
            tagOptions={[
              { value: "isolation", label: "Isolation", color: "#e0a040" },
              { value: "context",   label: "Context",   color: "#7aaa7a" },
            ]}
            defaultTag={practiceTag}
            onTagChange={setPracticeTag}
            getSnapshot={() => {
              if (!pattern) {
                return { preview: "No pattern generated yet", snapshot: {}, canRestore: false };
              }
              const preview = [
                `${pattern.totalSlots} notes`,
                `Grouping: ${pattern.grouping.join("+")}`,
                `Accents: ${groupingMode}${accentWriteIn.trim() ? ` (${accentWriteIn.trim()})` : ""}`,
                `${numPulses} pulses`,
              ].join(" · ");
              return {
                preview,
                snapshot: {
                  pattern,
                  groupingMode,
                  accentWriteIn,
                  numPulses,
                  mixedGroupsMode,
                  groupingsMode,
                  groupingSize,
                  splits32Enabled,
                },
                canRestore: false,
              };
            }}
            getCapture={async () => {
              if (!patternCaptureRef.current) return undefined;
              const { captureElement } = await import("@/lib/captureUtil");
              return captureElement(patternCaptureRef.current, "#0c0c0c");
            }}
          />

          {pattern ? (
            <div ref={patternCaptureRef} style={{
              background: "#0e0e0e", borderRadius: 10, border: "1px solid #1a1a1a",
              padding: "8px 8px",
            }}>
              <PatternDisplay
                pattern={pattern}
                numPulses={null}
                sixteenthMode={true}
              />
            </div>
          ) : (
            <div style={{
              background: "#0e0e0e", borderRadius: 10, border: "1px solid #1a1a1a",
              padding: "40px 20px", textAlign: "center", color: "#333", fontSize: 12,
            }}>
              Click <strong style={{ color: "#c8aa50" }}>Generate</strong> to create a pattern
            </div>
          )}

          {/* Metronome — one circle per pulse. Click a circle to mute just
              that pulse. "Silence every N" alternates N-pulse blocks of
              audible/silent clicks. */}
          <div style={{
            background: "#0e0e0e", borderRadius: 10, border: "1px solid #1a1a1a",
            padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 9, color: "#444", fontWeight: 700, letterSpacing: 1.5 }}>
                METRONOME
              </span>
              <button onClick={metronomePlaying ? stopMetronome : startMetronome} style={{
                height: 24, padding: "0 10px", borderRadius: 5, fontSize: 10, fontWeight: 700,
                border: `1.5px solid ${metronomePlaying ? "#e06060" : "#60c0a0"}`,
                background: metronomePlaying ? "#e0606022" : "#60c0a022",
                color: metronomePlaying ? "#e06060" : "#60c0a0", cursor: "pointer",
              }}>{metronomePlaying ? "Stop" : "Play"}</button>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, color: "#555" }}>BPM</span>
                <input type="number" min={30} max={300} value={metronomeBpm}
                  onChange={e => setMetronomeBpm(Math.max(30, Math.min(300, Number(e.target.value) || 80)))}
                  style={{
                    width: 48, height: 22, borderRadius: 4, fontSize: 11, fontWeight: 700,
                    border: "1.5px solid #2a2a2a", background: "#111",
                    color: "#60c0a0", textAlign: "center", outline: "none",
                  }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, color: "#555" }}>pulses</span>
                <input type="number" min={1} max={64} value={metronomePulses}
                  onChange={e => setMetronomePulses(Math.max(1, Math.min(64, Number(e.target.value) || 16)))}
                  style={{
                    width: 44, height: 22, borderRadius: 4, fontSize: 11, fontWeight: 700,
                    border: "1.5px solid #2a2a2a", background: "#111",
                    color: "#60c0a0", textAlign: "center", outline: "none",
                  }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}
                title="After N audible pulses, silence M pulses, then repeat">
                <div
                  onClick={() => setSilenceEveryEnabled(v => !v)}
                  style={chk(silenceEveryEnabled, "#e09060")}
                >{silenceEveryEnabled && "✓"}</div>
                <span style={{ fontSize: 10, color: silenceEveryEnabled ? "#e09060" : "#555" }}>
                  Silence every
                </span>
                <input type="number" min={1} max={64} value={silenceEveryN}
                  onChange={e => setSilenceEveryN(Math.max(1, Math.min(64, Number(e.target.value) || 4)))}
                  style={{
                    width: 38, height: 22, borderRadius: 4, fontSize: 10, fontWeight: 700,
                    border: `1px solid ${silenceEveryEnabled ? "#e0906066" : "#2a2a2a"}`,
                    background: "#111",
                    color: silenceEveryEnabled ? "#e09060" : "#555",
                    textAlign: "center", outline: "none",
                    opacity: silenceEveryEnabled ? 1 : 0.5,
                  }}
                  disabled={!silenceEveryEnabled}
                />
                <span style={{ fontSize: 10, color: silenceEveryEnabled ? "#e09060" : "#555" }}>
                  for
                </span>
                <input type="number" min={1} max={64} value={silenceForN}
                  onChange={e => setSilenceForN(Math.max(1, Math.min(64, Number(e.target.value) || 4)))}
                  style={{
                    width: 38, height: 22, borderRadius: 4, fontSize: 10, fontWeight: 700,
                    border: `1px solid ${silenceEveryEnabled ? "#e0906066" : "#2a2a2a"}`,
                    background: "#111",
                    color: silenceEveryEnabled ? "#e09060" : "#555",
                    textAlign: "center", outline: "none",
                    opacity: silenceEveryEnabled ? 1 : 0.5,
                  }}
                  disabled={!silenceEveryEnabled}
                />
                <span style={{ fontSize: 10, color: silenceEveryEnabled ? "#e09060" : "#555" }}>
                  pulses
                </span>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {Array.from({ length: Math.max(1, metronomePulses) }, (_, i) => {
                const individuallyMuted = mutedPulses.has(i);
                const periodicallyMuted = silenceEveryEnabled && silenceEveryN > 0 && silenceForN > 0
                  && (i % (silenceEveryN + silenceForN)) >= silenceEveryN;
                const silenced = individuallyMuted || periodicallyMuted;
                const active = activePulse === i;
                return (
                  <button
                    key={i}
                    onClick={() => togglePulseMute(i)}
                    title={`Pulse ${i + 1}${individuallyMuted ? " (muted)" : periodicallyMuted ? " (silenced by pattern)" : ""}`}
                    style={{
                      width: 22, height: 22, borderRadius: "50%", padding: 0,
                      border: `2px solid ${active ? "#c8aa50" : silenced ? "#333" : "#60c0a0"}`,
                      background: active ? "#c8aa5044" : silenced ? "#111" : "#60c0a033",
                      cursor: "pointer",
                      transition: "background 80ms, border-color 80ms",
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
