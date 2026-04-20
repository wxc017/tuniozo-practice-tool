import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  SubdivisionN,
  SUBDIVISION_PERMUTATIONS, Permutation,
  KonnakolGroup, KonnakolNote,
  NoteType, canSplitNote,
} from "@/lib/konnakolData";
import {
  Renderer, Stave, StaveNote, StaveNoteStruct, Voice, Formatter,
  Annotation, Barline, Beam, StaveTie, Tuplet, Dot,
} from "vexflow";
import KonnakolNotation from "./KonnakolNotation";
import KonnakolNoteControls from "./KonnakolNoteControls";
import { readPendingRestore } from "@/lib/practiceLog";

// ── Constants ─────────────────────────────────────────────────────────────────

const SUBDIVISIONS: SubdivisionN[] = [3, 4, 5, 6, 7, 8];
const SNARE_KEY = "f/5";
export const ROW_STAVE_Y = 40;
export const ROW_H = 120;
export const CARD_W = 220;

// ── Data types ────────────────────────────────────────────────────────────────

interface SelectedItem { subdiv: SubdivisionN; permIdx: number; showTuplet: boolean }
interface PreviewBeat { perm: Permutation; subdiv: SubdivisionN; showTuplet: boolean }

// ── Utilities ─────────────────────────────────────────────────────────────────

function slotCount(dur: string, dots?: number): number {
  const base: Record<string, number> = { "32": 0.5, "16": 1, "8": 2, "q": 4, "h": 8 };
  const b = base[dur] ?? 1;
  if (!dots) return b;
  let total = b, add = b / 2;
  for (let i = 0; i < dots; i++) { total += add; add /= 2; }
  return total;
}

function countPermNotes(perm: Permutation): number {
  return perm.reduce((s, g) => s + g.notes.length, 0);
}

function maxPermConsecutiveSixteenths(perm: Permutation): number {
  let max = 0, cur = 0;
  for (const group of perm) {
    for (const note of group.notes) {
      if (note.dur === "16" && !note.dots) { cur++; if (cur > max) max = cur; }
      else cur = 0;
    }
  }
  return max;
}

// ── Tuplet equivalence filter ─────────────────────────────────────────────────
// When tuplet mode is on (1 beat), remove permutations from subdivisions 5-8
// whose rhythm already exists in subdivision 3 or 4 (e.g. a dotted quarter in
// subdivision 6 fills one beat, same as a quarter note in subdivision 4).

function gcd(a: number, b: number): number { while (b) { [a, b] = [b, a % b]; } return a; }

function permComposition(perm: Permutation): number[] {
  const comp: number[] = [];
  let cur = 0;
  for (const g of perm) for (const n of g.notes) {
    const s = slotCount(n.dur, n.dots);
    if (n.tie) cur += s; else { if (cur > 0) comp.push(cur); cur = s; }
  }
  if (cur > 0) comp.push(cur);
  return comp;
}

function isEquivToLowerSubdiv(perm: Permutation, subdiv: number): boolean {
  if (subdiv <= 4) return false;
  const comp = permComposition(perm);
  const f3 = subdiv / gcd(3, subdiv);
  if (comp.every(p => p % f3 === 0)) return true;
  const f4 = subdiv / gcd(4, subdiv);
  if (comp.every(p => p % f4 === 0)) return true;
  return false;
}

// ── VexFlow renderer ──────────────────────────────────────────────────────────

const TUPLET_SUBDIVS = new Set([3, 5, 6, 7]);
// For triplets (3), force equal 8th-note durations for standard notation.
// For 5, 6, 7: keep original note durations — only add the tuplet bracket over them.
const TUPLET_BASE_DUR: Partial<Record<number, string>> = { 3: "8" };
const DUR_SLOTS: Record<string, number> = { "32": 0.5, "16": 1, "8": 2, "q": 4, "h": 8 };
// Subdivision 8 in tuplet mode = 8 notes per beat = 32nd-note grid → halve all durations
const HALVE_DUR: Record<string, string> = { h: "q", q: "8", "8": "16", "16": "32" };

export function renderPermutation(
  el: HTMLElement,
  perm: Permutation,
  W: number,
  H: number,
  staveY = ROW_STAVE_Y,
  sylFontSize = 7,
  subdivision?: number,
  showTuplet = false,
): void {
  el.innerHTML = "";

  const renderer = new Renderer(el as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(W, H);
  const ctx = renderer.getContext();
  ctx.setFont("Arial", 9);

  // Force equal note durations when in tuplet mode → symmetric grid spacing
  const baseTupletDur = showTuplet && subdivision ? TUPLET_BASE_DUR[subdivision] : undefined;
  const halveDur = showTuplet && subdivision === 8;

  const allEntries = perm.flatMap(g => g.notes);

  const entrySlots = allEntries.map(entry => {
    if (baseTupletDur) return DUR_SLOTS[baseTupletDur] ?? 1;
    const d = halveDur ? (HALVE_DUR[entry.dur] ?? entry.dur) : entry.dur;
    return slotCount(d, entry.dots);
  });
  const totalSlots = entrySlots.reduce((a, b) => a + b, 0);

  const stave = new Stave(4, staveY, W - 8);
  stave.setNumLines(1);
  stave.setBegBarType(Barline.type.NONE);
  stave.setEndBarType(Barline.type.NONE);
  stave.setContext(ctx).draw();

  const vfNotes: StaveNote[] = [];
  const tieConnections: [number, number][] = [];

  for (const entry of allEntries) {
    const dur  = baseTupletDur ?? (halveDur ? (HALVE_DUR[entry.dur] ?? entry.dur) : entry.dur);
    const dots = baseTupletDur ? 0 : (entry.dots ?? 0);

    const sn = new StaveNote({
      keys: [SNARE_KEY],
      duration: dur,
      dots,
      stemDirection: 1,
    } as StaveNoteStruct);

    if (!baseTupletDur && entry.dots) {
      for (let d = 0; d < entry.dots; d++) {
        try { Dot.buildAndAttach([sn], { all: true }); } catch { /* */ }
      }
    }

    if (entry.syl) {
      try {
        const ann = new Annotation(entry.syl);
        ann.setFont("Arial", sylFontSize, "normal");
        ann.setVerticalJustification(Annotation.VerticalJustify.BOTTOM);
        sn.addModifier(ann);
      } catch { /* */ }
    }

    if (!baseTupletDur && entry.tie && vfNotes.length > 0) {
      tieConnections.push([vfNotes.length - 1, vfNotes.length]);
    }
    vfNotes.push(sn);
  }

  if (vfNotes.length === 0) return;

  const beams = Beam.generateBeams(vfNotes, { maintainStemDirections: true });

  const voice = new Voice({ numBeats: totalSlots, beatValue: 16 });
  (voice as unknown as { setMode(m: number): void }).setMode(2);
  voice.addTickables(vfNotes);

  const gridStartX = 8;
  const gridEndX = W - 8 - 14;
  const gridW = Math.max(10, gridEndX - gridStartX);
  new Formatter().joinVoices([voice]).format([voice], gridW);

  // Reposition each note to its exact proportional slot position
  let cumSlots = 0;
  vfNotes.forEach((vfn, i) => {
    const targetX = gridStartX + (cumSlots / totalSlots) * gridW;
    const formattedX = (vfn as unknown as { getAbsoluteX(): number }).getAbsoluteX();
    (vfn as unknown as { setXShift(n: number): void }).setXShift(targetX - formattedX);
    cumSlots += entrySlots[i];
  });

  voice.draw(ctx, stave);
  beams.forEach(b => b.setContext(ctx).draw());

  for (const [i, j] of tieConnections) {
    try {
      new StaveTie({ firstNote: vfNotes[i], lastNote: vfNotes[j], firstIndexes: [0], lastIndexes: [0] })
        .setContext(ctx).draw();
    } catch { /* */ }
  }

  if (showTuplet && subdivision && TUPLET_SUBDIVS.has(subdivision) && vfNotes.length >= 1) {
    try {
      new Tuplet(vfNotes, {
        numNotes: subdivision,
        notesOccupied: vfNotes.length,
        ratioed: false,
        bracketed: true,
        location: 1,
      }).setContext(ctx).draw();
    } catch { /* */ }
  }

  const svg = el.querySelector("svg");
  if (svg) (svg as SVGSVGElement).style.filter = "invert(1)";
}

// ── CompositionRow ────────────────────────────────────────────────────────────

function CompositionRow({
  perm, subdivision, selected, onClick, dimmed, showTuplet,
}: {
  perm: Permutation;
  subdivision: SubdivisionN;
  selected: boolean;
  onClick: () => void;
  dimmed?: boolean;
  showTuplet?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      renderPermutation(el, perm, CARD_W, ROW_H, ROW_STAVE_Y, 7, subdivision, showTuplet);
    } catch (err) {
      console.warn("CompositionRow render error:", err);
    }
  }, [perm, subdivision, showTuplet]);

  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "2px 5px", borderRadius: 6, cursor: "pointer",
        border: `1.5px solid ${selected ? "#9999ee" : "#1e1e1e"}`,
        background: selected ? "#9999ee1a" : "#0a0a0a",
        opacity: dimmed ? 0.35 : 1,
        transition: "all 80ms", width: "100%",
      }}
    >
      <div ref={ref} style={{ width: CARD_W, height: ROW_H, flexShrink: 0, overflow: "hidden" }} />
    </button>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export interface KonnakolExportData {
  groups: KonnakolGroup[];
  getElement: () => HTMLElement | null;
}

export interface KonnakolLogData {
  getSnapshot: () => { preview: string; snapshot: Record<string, unknown>; canRestore: boolean };
}

export default function KonnakolBasicPanel({ onExportData, onLogData }: { onExportData?: (data: KonnakolExportData) => void; onLogData?: (key: "subdivisions" | "mixed", data: KonnakolLogData | null) => void } = {}) {
  // ── Subdivision section state ──────────────────────────────────────────────
  const [subdivision, setSubdivision] = useState<SubdivisionN>(4);
  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([]);
  const [sixFilter, setSixFilter] = useState<number | null>(null);
  const [beats, setBeats] = useState<number>(4);
  const [preview, setPreview] = useState<PreviewBeat[] | null>(null);
  const [showTuplet, setShowTuplet] = useState(false);

  const previewStaveRef = useRef<HTMLDivElement>(null);

  // ── Subdivision modification state ────────────────────────────────────────
  const [subdivGroups, setSubdivGroups] = useState<KonnakolGroup[]>([]);
  const [subdivModStyle, setSubdivModStyle] = useState<"musical" | "awkward" | "both" | null>(null);
  const [subdivNotePositions, setSubdivNotePositions] = useState<number[]>([]);

  // ── Export data callback ────────────────────────────────────────────────────
  useEffect(() => {
    onExportData?.({ groups: subdivGroups, getElement: () => previewStaveRef.current });
  }, [subdivGroups, onExportData]);

  // ── Log data callback ─────────────────────────────────────────────────────
  useEffect(() => {
    if (preview && preview.length > 0) {
      onLogData?.("subdivisions", {
        getSnapshot: () => ({
          preview: `${beats} beat${beats !== 1 ? "s" : ""}, subdiv ${subdivision} — ${preview.length} beat pattern`,
          snapshot: { subdivision, selectedItems, beats, preview },
          canRestore: true,
        }),
      });
    } else {
      onLogData?.("subdivisions", null);
    }
  }, [preview, beats, subdivision, selectedItems, onLogData]);

  // ── Restore from practice log ──────────────────────────────────────────────
  useEffect(() => {
    const data = readPendingRestore<{
      subdivision: SubdivisionN;
      selectedItems: SelectedItem[];
      beats: number;
      preview: PreviewBeat[] | null;
    }>("konnakol_basic");
    if (data) {
      if (data.subdivision) setSubdivision(data.subdivision);
      if (data.selectedItems) setSelectedItems(data.selectedItems);
      if (data.beats) setBeats(data.beats);
      if (data.preview) setPreview(data.preview);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Subdivision handlers ───────────────────────────────────────────────────
  const perms = SUBDIVISION_PERMUTATIONS[subdivision];

  const filteredPermIdxs = useMemo(() => {
    let idxs = perms.map((_, i) => i);
    if (showTuplet) idxs = idxs.filter(i => !isEquivToLowerSubdiv(perms[i], subdivision));
    if (sixFilter !== null) idxs = idxs.filter(i => maxPermConsecutiveSixteenths(perms[i]) === sixFilter);
    return idxs;
  }, [perms, sixFilter, showTuplet, subdivision]);

  const sixFilterOptions = useMemo(
    () => Array.from(new Set(perms.map(maxPermConsecutiveSixteenths))).sort((a, b) => a - b),
    [perms],
  );

  useEffect(() => {
    if (sixFilter !== null && !sixFilterOptions.includes(sixFilter)) setSixFilter(null);
  }, [sixFilterOptions, sixFilter]);

  const isItemSelected = (subdiv: SubdivisionN, permIdx: number, tuplet: boolean) =>
    selectedItems.some(it => it.subdiv === subdiv && it.permIdx === permIdx && it.showTuplet === tuplet);

  const toggleSelect = useCallback((subdiv: SubdivisionN, permIdx: number) => {
    setSelectedItems(prev => {
      const exists = prev.some(it => it.subdiv === subdiv && it.permIdx === permIdx && it.showTuplet === showTuplet);
      return exists
        ? prev.filter(it => !(it.subdiv === subdiv && it.permIdx === permIdx && it.showTuplet === showTuplet))
        : [...prev, { subdiv, permIdx, showTuplet }];
    });
  }, [showTuplet]);

  const removeSelected = useCallback((pos: number) => {
    setSelectedItems(prev => prev.filter((_, i) => i !== pos));
  }, []);

  // ── Preview → KonnakolGroup conversion ─────────────────────────────────────
  const previewToGroups = useCallback((beats: PreviewBeat[]): KonnakolGroup[] =>
    beats.map(beat => {
      const notes: KonnakolNote[] = [];
      for (const group of beat.perm) {
        for (const note of group.notes) {
          notes.push({
            syllable: note.syl || "",
            noteType: (note.tie ? "tie" : "normal") as NoteType,
            duration: note.dur + (note.dots ? ".".repeat(note.dots) : ""),
            accent: false,
            isTieStart: false,
          });
        }
      }
      if (notes.length > 0) notes[0].accent = true;
      return { notes, subdivision: beat.subdiv, noTuplet: !beat.showTuplet };
    }), []);

  const applyModStyle = useCallback((grps: KonnakolGroup[], style: "musical" | "awkward" | "both"): KonnakolGroup[] =>
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
    })), []);

  const handleRandomize = useCallback(() => {
    if (selectedItems.length === 0) { setPreview(null); setSubdivGroups([]); return; }
    const result: PreviewBeat[] = [];
    for (let b = 0; b < beats; b++) {
      const pick = selectedItems[Math.floor(Math.random() * selectedItems.length)];
      result.push({
        perm: SUBDIVISION_PERMUTATIONS[pick.subdiv][pick.permIdx],
        subdiv: pick.subdiv,
        showTuplet: pick.showTuplet,
      });
    }
    setPreview(result);
    const groups = previewToGroups(result);
    setSubdivGroups(subdivModStyle ? applyModStyle(groups, subdivModStyle) : groups);
  }, [selectedItems, beats, previewToGroups, subdivModStyle, applyModStyle]);

  // Auto-generate when selection or beats changes
  useEffect(() => {
    handleRandomize();
  }, [handleRandomize]);

  // ── Subdivision per-note modification handlers ────────────────────────────
  const handleSubdivCycleTie = useCallback((gi: number, ni: number) => {
    setSubdivGroups(prev => prev.map((g, gIdx) => gIdx !== gi ? g : {
      ...g, notes: g.notes.map((n, nIdx) => {
        if (nIdx !== ni) return n;
        const isTied = n.noteType === "tie" || !!n.isTieStart;
        return { ...n, noteType: (isTied ? "normal" : "tie") as NoteType, isTieStart: false };
      }),
    }));
  }, []);

  const handleSubdivToggleRest = useCallback((gi: number, ni: number) => {
    setSubdivGroups(prev => prev.map((g, gIdx) => gIdx !== gi ? g : {
      ...g, notes: g.notes.map((n, nIdx) => nIdx !== ni ? n : {
        ...n, noteType: (n.noteType === "rest" ? "normal" : "rest") as NoteType,
      }),
    }));
  }, []);

  const handleSubdivToggle32 = useCallback((gi: number, ni: number) => {
    setSubdivGroups(prev => {
      const g = prev[gi];
      if (!g) return prev;
      const note = g.notes[ni];
      if (!note) return prev;
      const isSplit = note.duration === "32";
      if (isSplit) {
        const next = g.notes[ni + 1];
        if (!next || next.duration !== "32") return prev;
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

  const SUBDIV_COLOR: Record<SubdivisionN, string> = {
    3: "#e06060", 4: "#9999ee", 5: "#c8aa50", 6: "#60c0a0", 7: "#e09060", 8: "#9090e0",
  };

  const subdivTotalNotes = subdivGroups.reduce((s, g) => s + g.notes.length, 0);
  const SUBDIV_PREVIEW_W = Math.max(500, Math.min(900, subdivTotalNotes * 45 + 80));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* ── Subdivision selector ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: 1 }}>SUBDIVISION</span>
        <div style={{ display: "flex", gap: 4 }}>
          {SUBDIVISIONS.map(s => (
            <button key={s} onClick={() => setSubdivision(s)} style={{
              width: 32, height: 32, borderRadius: 6, fontSize: 11, fontWeight: 700,
              border: `1.5px solid ${subdivision === s ? SUBDIV_COLOR[s] : "#222"}`,
              background: subdivision === s ? SUBDIV_COLOR[s] + "22" : "#111",
              color: subdivision === s ? SUBDIV_COLOR[s] : "#555",
              cursor: "pointer",
            }}>
              {s}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 9, color: "#444" }}>{perms.length} patterns</span>
        <button onClick={() => setShowTuplet(v => !v)} style={{
          padding: "2px 10px", height: 24, borderRadius: 4, fontSize: 10, fontWeight: 700,
          border: `1.5px solid ${showTuplet ? "#c8aa50" : "#222"}`,
          background: showTuplet ? "#c8aa5022" : "#111",
          color: showTuplet ? "#c8aa50" : "#555", cursor: "pointer", marginLeft: 4,
        }}>tuplet</button>
      </div>

      {/* Max-consecutive-sixteenths filter */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: "#555", fontWeight: 700, letterSpacing: 1 }}>16ths GROUPED</span>
        <button onClick={() => setSixFilter(null)} style={{
          padding: "2px 10px", height: 24, borderRadius: 4, fontSize: 10, fontWeight: 700,
          border: `1.5px solid ${sixFilter === null ? "#9999ee" : "#222"}`,
          background: sixFilter === null ? "#9999ee22" : "#111",
          color: sixFilter === null ? "#9999ee" : "#555", cursor: "pointer",
        }}>ALL</button>
        {sixFilterOptions.map(n => (
          <button key={n} onClick={() => setSixFilter(sixFilter === n ? null : n)} style={{
            width: 26, height: 24, borderRadius: 4, fontSize: 10, fontWeight: 700,
            border: `1.5px solid ${sixFilter === n ? "#c8aa50" : "#222"}`,
            background: sixFilter === n ? "#c8aa5022" : "#111",
            color: sixFilter === n ? "#c8aa50" : "#555", cursor: "pointer",
          }}>{n}</button>
        ))}
        <span style={{ fontSize: 9, color: "#333" }}>
          {filteredPermIdxs.length} / {perms.length}
        </span>
      </div>

      {/* Two-column layout */}
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>

        {/* LEFT — Selected + beat count + Randomize */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 160 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, color: "#666", fontWeight: 700, letterSpacing: 1 }}>SELECTED</span>
            {selectedItems.length > 0 && (
              <span style={{ fontSize: 9, color: "#444" }}>{selectedItems.length}</span>
            )}
          </div>
          <div style={{
            display: "flex", flexDirection: "column", gap: 3,
            minHeight: 60, maxHeight: 460, overflowY: "auto",
            padding: "4px", background: "#080808", borderRadius: 8, border: "1px solid #181818",
          }}>
            {selectedItems.length === 0 ? (
              <div style={{ padding: "16px 8px", color: "#2a2a2a", fontSize: 10, textAlign: "center", lineHeight: 1.5 }}>
                Click patterns on the right to add them here
              </div>
            ) : (
              selectedItems.map((item, pos) => (
                <div key={pos} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, color: SUBDIV_COLOR[item.subdiv],
                    minWidth: 10, textAlign: "center", flexShrink: 0,
                  }} title={`Subdivision ${item.subdiv}`}>{item.subdiv}</span>
                  <CompositionRow
                    perm={SUBDIVISION_PERMUTATIONS[item.subdiv][item.permIdx]}
                    subdivision={item.subdiv}
                    selected={true}
                    onClick={() => removeSelected(pos)}
                    showTuplet={item.showTuplet}
                  />
                </div>
              ))
            )}
          </div>

          {/* Beat count + Randomize */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
            <input
              type="number" min={1} max={32} value={beats}
              onChange={e => setBeats(Math.max(1, Math.min(32, Number(e.target.value) || 1)))}
              style={{
                width: 44, height: 32, borderRadius: 5, fontSize: 12,
                border: "1.5px solid #2a2a2a", background: "#111",
                color: "#c8aa50", textAlign: "center", outline: "none",
              }}
              title="Number of beats"
            />
            <span style={{ fontSize: 9, color: "#444" }}>beats</span>
            <button
              onClick={handleRandomize}
              disabled={selectedItems.length === 0}
              style={{
                padding: "0 14px", height: 32, borderRadius: 6, fontSize: 11, fontWeight: 700,
                border: `1.5px solid ${selectedItems.length > 0 ? "#9999ee" : "#222"}`,
                background: selectedItems.length > 0 ? "#9999ee22" : "#111",
                color: selectedItems.length > 0 ? "#9999ee" : "#333",
                cursor: selectedItems.length > 0 ? "pointer" : "default",
                transition: "all 80ms",
              }}
            >
              Randomize
            </button>
          </div>
        </div>

        {/* RIGHT — Patterns bank */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 10, color: "#666", fontWeight: 700, letterSpacing: 1 }}>
            PATTERNS
          </span>
          <div style={{
            display: "grid", gridTemplateColumns: `repeat(2, ${CARD_W}px)`,
            gap: 4, maxHeight: 560, overflowY: "auto",
            padding: "4px 4px 4px 2px",
          }}>
            {filteredPermIdxs.length === 0 ? (
              <div style={{ padding: "16px 10px", color: "#2a2a2a", fontSize: 10 }}>
                No patterns match this filter
              </div>
            ) : (
              filteredPermIdxs.map(idx => (
                <CompositionRow
                  key={`${subdivision}-${idx}`}
                  perm={perms[idx]}
                  subdivision={subdivision}
                  selected={isItemSelected(subdivision, idx, showTuplet)}
                  dimmed={selectedItems.some(it => it.subdiv === subdivision && it.showTuplet === showTuplet) && !isItemSelected(subdivision, idx, showTuplet)}
                  onClick={() => toggleSelect(subdivision, idx)}
                  showTuplet={showTuplet}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Preview */}
      {preview && preview.length > 0 && subdivGroups.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: 1 }}>PREVIEW</span>
          <div ref={previewStaveRef} style={{ background: "#0a0a0a", borderRadius: 8, border: "1px solid #1a1a1a", padding: 8 }}>
            <KonnakolNotation
              groups={subdivGroups}
              width={SUBDIV_PREVIEW_W}
              height={140}
              singleLine
              onNotePositions={setSubdivNotePositions}
            />
            <KonnakolNoteControls groups={subdivGroups} previewW={SUBDIV_PREVIEW_W}
              notePositions={subdivNotePositions}
              onTie={handleSubdivCycleTie} onToggle32={handleSubdivToggle32} onToggleRest={handleSubdivToggleRest} />
            {/* Randomize style selector */}
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
              <span style={{ fontSize: 10, color: "#555", fontWeight: 600 }}>Randomize mods:</span>
              {([["musical", "#60c0a0"], ["awkward", "#e09060"], ["both", "#9999ee"]] as const).map(([s, c]) => {
                const on = subdivModStyle === s;
                return (
                  <button key={s} onClick={() => setSubdivModStyle(prev => prev === s ? null : s)}
                    style={{ padding: "0 8px", height: 22, borderRadius: 4, fontSize: 10, fontWeight: 700,
                      border: `1.5px solid ${on ? c : c + "44"}`, background: on ? c + "30" : c + "0a", color: on ? c : c + "66",
                      cursor: "pointer", transition: "all 80ms" }}>
                    {s}
                  </button>
                );
              })}
              <button
                onClick={() => {
                  if (!subdivModStyle || !preview) return;
                  setSubdivGroups(applyModStyle(previewToGroups(preview), subdivModStyle));
                }}
                style={{ padding: "0 8px", height: 22, borderRadius: 4, fontSize: 10, fontWeight: 700,
                  border: "1.5px solid #c8aa5066", background: "#c8aa5015", color: subdivModStyle ? "#c8aa50" : "#c8aa5044",
                  cursor: subdivModStyle ? "pointer" : "default", transition: "all 80ms" }}>
                Roll
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
