import { useState, useCallback, useEffect, useRef } from "react";
import {
  CYCLE_RATIOS, CycleRatio, canSplitNote,
  KonnakolGroup, NoteType, getSyllablesForSize,
  applyCompositionAsTies, type Permutation,
} from "@/lib/konnakolData";
import KonnakolNotation from "./KonnakolNotation";
import KonnakolNoteControls from "./KonnakolNoteControls";
import { readPendingRestore } from "@/lib/practiceLog";
import type { KonnakolLogData } from "./KonnakolBasicPanel";

export interface CyclesExportData {
  groups: KonnakolGroup[];
  getElement: () => HTMLElement | null;
}

/** Standard tuplet base: how many notes the tuplet replaces (notesOccupied) */
function standardTupletBase(n: number): number | null {
  if (n === 1 || n === 2 || n === 4 || n === 8 || n === 16) return null; // no tuplet needed
  if (n === 3) return 2;
  if (n === 5 || n === 6) return 4;
  if (n === 7) return 4;
  if (n >= 9 && n <= 12) return 8;
  if (n >= 13) return Math.pow(2, Math.floor(Math.log2(n)));
  return null;
}

/** Build cycle groups — b groups of a-tuplets, accent every b'th note */
function buildCycleGroups(ratio: CycleRatio): KonnakolGroup[] {
  const { a, b } = ratio;
  const tupletSyllables = getSyllablesForSize(a);
  const groups: KonnakolGroup[] = [];

  for (let i = 0; i < b; i++) {
    const notes = [];
    for (let k = 0; k < a; k++) {
      const linearIdx = i * a + k;
      notes.push({
        syllable: tupletSyllables[k],
        noteType: "normal" as NoteType,
        accent: linearIdx % b === 0,
        isTieStart: false,
      });
    }
    groups.push({ notes, subdivision: a });
  }
  return groups;
}

export default function KonnakolCyclesPanel({ onExportData, onLogData }: { onExportData?: (data: CyclesExportData) => void; onLogData?: (data: KonnakolLogData | null) => void } = {}) {
  const notationRef = useRef<HTMLDivElement>(null);
  const [selectedRatio, setSelectedRatio] = useState<CycleRatio | null>(null);
  const [groups, setGroups] = useState<KonnakolGroup[]>([]);
  const [generated, setGenerated] = useState(false);
  const [modStyle, setModStyle] = useState<"musical" | "awkward" | "both" | null>(null);
  const [notePositions, setNotePositions] = useState<number[]>([]);
  // Export/log
  useEffect(() => {
    if (generated && groups.length > 0) {
      onExportData?.({ groups, getElement: () => notationRef.current });
      onLogData?.({
        getSnapshot: () => ({
          preview: `Cycle ${selectedRatio?.label ?? ""} — ${groups.reduce((s, g) => s + g.notes.length, 0)} pulses`,
          snapshot: { selectedRatio, groups } as unknown as Record<string, unknown>,
          canRestore: true,
        }),
      });
    } else {
      onLogData?.(null);
    }
  }, [generated, groups, selectedRatio, onLogData]);

  const applyModStyle = (grps: KonnakolGroup[], style: "musical" | "awkward" | "both"): KonnakolGroup[] =>
    grps.map((group, gi) => ({
      ...group,
      notes: group.notes.flatMap((note, ni) => {
        if (gi === 0 && ni === 0) return [{ ...note, noteType: "normal" as NoteType, isTieStart: false }];
        const r = Math.random();
        let noteType: NoteType = "normal";
        let isTieStart = false;
        const splitChance = style === "musical" ? 0.12 : style === "awkward" ? 0.2 : 0.15;
        if (canSplitNote(note) && Math.random() < splitChance) {
          return [
            { ...note, noteType: "normal" as NoteType, isTieStart: false, duration: "32" },
            { ...note, noteType: "normal" as NoteType, isTieStart: false, accent: false, duration: "32" },
          ];
        }
        if (style === "musical") {
          if (ni > 0 && ni % 2 === 1 && r < 0.3) noteType = "tie";
          else if (r < 0.1) noteType = "rest";
          else if (r < 0.2) isTieStart = true;
        } else if (style === "awkward") {
          if (ni === 0 && r < 0.35) noteType = "rest";
          else if (r < 0.25) noteType = "tie";
          else if (r < 0.4) noteType = "rest";
          else if (r < 0.55) isTieStart = true;
        } else {
          if (r < 0.2) noteType = "tie";
          else if (r < 0.35) noteType = "rest";
          else if (r < 0.5) isTieStart = true;
        }
        return [{ ...note, noteType, isTieStart }];
      }),
    }));

  // Auto-generate when ratio is selected
  const regenerate = useCallback((ratio: CycleRatio, style: typeof modStyle) => {
    const result = buildCycleGroups(ratio);
    const final = style ? applyModStyle(result, style) : result;
    setGroups(final);
    setGenerated(true);
  }, []);

  const handleRatioSelect = (ratio: CycleRatio) => {
    setSelectedRatio(ratio);
    regenerate(ratio, modStyle);
  };

  const handleCycleTie = useCallback((gi: number, ni: number) => {
    setGroups(prev => prev.map((g, gIdx) => gIdx !== gi ? g : {
      ...g, notes: g.notes.map((n, nIdx) => {
        if (nIdx !== ni) return n;
        const isTied = n.noteType === "tie" || !!n.isTieStart;
        return { ...n, noteType: (isTied ? "normal" : "tie") as NoteType, isTieStart: false };
      }),
    }));
  }, []);

  const handleToggleRest = useCallback((gi: number, ni: number) => {
    setGroups(prev => prev.map((g, gIdx) => gIdx !== gi ? g : {
      ...g, notes: g.notes.map((n, nIdx) => nIdx !== ni ? n : {
        ...n, noteType: (n.noteType === "rest" ? "normal" : "rest") as NoteType,
      }),
    }));
  }, []);

  const handleSubdivReplace = useCallback((gi: number, perm: Permutation) => {
    setGroups(prev => prev.map((g, i) => i === gi ? applyCompositionAsTies(g, perm) : g));
  }, []);

  const handleToggle32 = useCallback((gi: number, ni: number) => {
    setGroups(prev => {
      const g = prev[gi];
      if (!g) return prev;
      const note = g.notes[ni];
      if (!note) return prev;
      if (note.duration === "32") {
        const next = g.notes[ni + 1];
        const is32Pair = next && next.duration === "32";
        if (!is32Pair) return prev;
        const newNotes = [...g.notes];
        newNotes.splice(ni + 1, 1);
        newNotes[ni] = { ...newNotes[ni], duration: "16" };
        return prev.map((gg, i) => i === gi ? { ...gg, notes: newNotes } : gg);
      } else {
        const newNotes = [...g.notes];
        newNotes[ni] = { ...note, duration: "32" };
        newNotes.splice(ni + 1, 0, { ...note, duration: "32", accent: false });
        return prev.map((gg, i) => i === gi ? { ...gg, notes: newNotes } : gg);
      }
    });
  }, []);

  // Restore from practice log
  useEffect(() => {
    const data = readPendingRestore<{ selectedRatio: CycleRatio; groups: KonnakolGroup[] }>("konnakol_cycles");
    if (data) {
      if (data.selectedRatio) setSelectedRatio(data.selectedRatio);
      if (data.groups) { setGroups(data.groups); setGenerated(true); }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalNotes = groups.reduce((s, g) => s + g.notes.length, 0);
  const cycleFormula = groups.map(g => g.notes.length);
  const PREVIEW_W = Math.max(500, Math.min(900, totalNotes * 45 + 80));

  // Auto tuplet bracket for cycles (e.g. 5:4 → each group shows "5" bracket)
  const cycleTupletBase = selectedRatio ? standardTupletBase(selectedRatio.a) : null;
  const effectiveYValues = cycleTupletBase != null && cycleTupletBase > 0
    ? groups.map(() => cycleTupletBase!)
    : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Cycle bank */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: 1 }}>SELECT CYCLE RATIO</span>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {CYCLE_RATIOS.map(ratio => {
            const isSelected = selectedRatio?.label === ratio.label;
            return (
              <button key={ratio.label}
                onClick={() => handleRatioSelect(ratio)}
                title={ratio.description}
                style={{
                  padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 700,
                  border: `1.5px solid ${isSelected ? "#7aaa7a" : "#1e1e1e"}`,
                  background: isSelected ? "#7aaa7a18" : "#0e0e0e",
                  color: isSelected ? "#7aaa7a" : "#444",
                  cursor: "pointer", fontFamily: "monospace",
                  transition: "all 80ms",
                }}>
                {ratio.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Notation preview */}
      {generated && groups.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "#e06060", fontFamily: "monospace", fontWeight: 700 }}>
              {selectedRatio?.label} — {totalNotes} pulses
            </span>
          </div>

          <div ref={notationRef} style={{ background: "#0a0a0a", borderRadius: 8, border: "1px solid #1a1a1a", padding: 8 }}>
            <KonnakolNotation
              groups={groups}
              width={PREVIEW_W}
              height={effectiveYValues ? 160 : 140}
              groupedSixteenths={cycleFormula}
              singleLine
              onNotePositions={setNotePositions}
              groupYValues={effectiveYValues}
            />
            <KonnakolNoteControls groups={groups} previewW={PREVIEW_W}
              notePositions={notePositions}
              onTie={handleCycleTie} onToggle32={handleToggle32} onToggleRest={handleToggleRest}
              onSubdivReplace={handleSubdivReplace} />
            {/* Randomize mods row */}
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
              <span style={{ fontSize: 10, color: "#555", fontWeight: 600 }}>Mods:</span>
              {([["musical", "#60c0a0"], ["awkward", "#e09060"], ["both", "#9999ee"]] as const).map(([s, c]) => {
                const on = modStyle === s;
                return (
                  <button key={s} onClick={() => setModStyle(prev => prev === s ? null : s)}
                    style={{ padding: "0 8px", height: 22, borderRadius: 4, fontSize: 10, fontWeight: 700,
                      border: `1.5px solid ${on ? c : c + "44"}`, background: on ? c + "30" : c + "0a", color: on ? c : c + "66",
                      cursor: "pointer", transition: "all 80ms" }}>
                    {s}
                  </button>
                );
              })}
              <button
                onClick={() => {
                  if (!modStyle || !selectedRatio) return;
                  regenerate(selectedRatio, modStyle);
                }}
                style={{ padding: "0 8px", height: 22, borderRadius: 4, fontSize: 10, fontWeight: 700,
                  border: "1.5px solid #c8aa5066", background: "#c8aa5015", color: modStyle ? "#c8aa50" : "#c8aa5044",
                  cursor: modStyle ? "pointer" : "default", transition: "all 80ms" }}>
                Roll
              </button>
            </div>
          </div>
        </div>
      )}

      {!generated && (
        <div style={{
          padding: 24, textAlign: "center", color: "#333", fontSize: 12,
          background: "#0a0a0a", borderRadius: 8, border: "1px solid #141414",
        }}>
          Select a cycle ratio from the bank above
        </div>
      )}
    </div>
  );
}
