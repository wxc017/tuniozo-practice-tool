import { useState, useCallback, useEffect } from "react";
import {
  generateDurationPattern, applyRandomNoteModifications, cycleMixedNoteType,
  randomPartition, splitNote, canSplitNote, flattenGroupsForPlayback,
  KonnakolGroup, NoteType, MixedGroupPreset, MIXED_GROUP_PRESETS,
} from "@/lib/konnakolData";
import KonnakolNotation from "./KonnakolNotation";

type MixedNoteType = "normal" | "tie" | "rest";

const NOTE_TYPE_LABELS: Record<MixedNoteType, string> = {
  normal: "●",
  tie:    "~",
  rest:   "r",
};
const NOTE_TYPE_COLORS: Record<MixedNoteType, string> = {
  normal: "#9999ee",
  tie:    "#c8aa50",
  rest:   "#888",
};

function getNoteColor(t: NoteType): string {
  return NOTE_TYPE_COLORS[t as MixedNoteType] ?? "#9999ee";
}
function getNoteLabel(t: NoteType): string {
  return NOTE_TYPE_LABELS[t as MixedNoteType] ?? "●";
}

const MIXED_DISPLAY_TYPES: NoteType[] = ["normal", "tie", "rest"];

const CUSTOM_PRESETS_KEY = "konnakol_custom_presets";

const VALID_SLOT_VALUES = new Set([1, 2, 3, 4, 6, 8]);

function parseGroupChain(input: string): number[] | null {
  const parts = input.split(/[\s,+]+/).filter(Boolean);
  const nums = parts.map(Number);
  if (nums.some(n => isNaN(n) || !VALID_SLOT_VALUES.has(n))) return null;
  return nums;
}

const SLOT_LABELS: Record<number, string> = {
  1: "16th", 2: "8th", 3: "d8th", 4: "qtr", 6: "d.qtr", 8: "half",
};

function loadCustomPresets(): MixedGroupPreset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as MixedGroupPreset[];
  } catch {
    return [];
  }
}

function saveCustomPresets(presets: MixedGroupPreset[]): void {
  try {
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
  } catch { /* ignore */ }
}

type ModeType = "same" | "changing";

export default function KonnakolMixedPanel() {
  const [mode, setMode] = useState<ModeType>("same");

  const [customPresets, setCustomPresets] = useState<MixedGroupPreset[]>(() => loadCustomPresets());
  const [sameCustomInput, setSameCustomInput] = useState("");
  const [sameCustomError, setSameCustomError] = useState<string | null>(null);
  const [sameSelectedPresetIdx, setSameSelectedPresetIdx] = useState<{ type: "default" | "custom"; idx: number } | null>(null);
  const [sameGroups, setSameGroups] = useState<KonnakolGroup[]>([]);
  const [sameGenerated, setSameGenerated] = useState(false);
  const [sameFormula, setSameFormula] = useState<number[]>([]);
  const [samePulseCount, setSamePulseCount] = useState(16);

  const [changingCustomInput, setChangingCustomInput] = useState("");
  const [changingCustomError, setChangingCustomError] = useState<string | null>(null);
  const [changingSelectedPreset, setChangingSelectedPreset] = useState<number | null>(null);
  const [changingGroups, setChangingGroups] = useState<KonnakolGroup[]>([]);
  const [changingGenerated, setChangingGenerated] = useState(false);
  const [changingFormula, setChangingFormula] = useState<number[]>([]);

  useEffect(() => {
    saveCustomPresets(customPresets);
  }, [customPresets]);

  const handleSamePresetSelect = (type: "default" | "custom", idx: number) => {
    setSameSelectedPresetIdx({ type, idx });
    setSameCustomInput("");
    setSameCustomError(null);
  };

  const handleSaveCustom = useCallback(() => {
    const parsed = parseGroupChain(sameCustomInput);
    if (!parsed) {
      setSameCustomError("Enter durations 1–8 separated by + or spaces");
      return;
    }
    const label = parsed.join("+");
    if (customPresets.some(p => p.label === label)) {
      setSameCustomError("This pattern already exists");
      return;
    }
    const newPreset: MixedGroupPreset = {
      label,
      groups: parsed,
      description: `Custom: ${parsed.reduce((s, n) => s + n, 0)} pulses`,
    };
    setCustomPresets(prev => [...prev, newPreset]);
    setSameCustomError(null);
    setSameSelectedPresetIdx({ type: "custom", idx: customPresets.length });
    setSameCustomInput("");
  }, [sameCustomInput, customPresets]);

  const handleDeleteCustom = useCallback((idx: number) => {
    setCustomPresets(prev => {
      const next = prev.filter((_, i) => i !== idx);
      return next;
    });
    if (sameSelectedPresetIdx?.type === "custom" && sameSelectedPresetIdx.idx === idx) {
      setSameSelectedPresetIdx(null);
    } else if (sameSelectedPresetIdx?.type === "custom" && sameSelectedPresetIdx.idx > idx) {
      setSameSelectedPresetIdx({ type: "custom", idx: sameSelectedPresetIdx.idx - 1 });
    }
  }, [sameSelectedPresetIdx]);

  const handleSameGenerate = useCallback(() => {
    let durations: number[];

    if (sameCustomInput.trim()) {
      const parsed = parseGroupChain(sameCustomInput);
      if (!parsed) {
        setSameCustomError("Enter note durations 1–8 separated by + or spaces (1=16th, 2=8th, 3=d.8th, 4=qtr)");
        return;
      }
      setSameCustomError(null);
      durations = parsed;
    } else if (sameSelectedPresetIdx !== null) {
      const preset = sameSelectedPresetIdx.type === "custom"
        ? customPresets[sameSelectedPresetIdx.idx]
        : null;
      durations = preset?.groups ?? randomPartition(samePulseCount, 1, 4);
    } else {
      durations = randomPartition(samePulseCount, 1, 4);
    }

    if (durations.length === 0) return;

    setSameFormula(durations);
    const result = generateDurationPattern(durations);
    setSameGroups(result);
    setSameGenerated(true);
  }, [sameCustomInput, sameSelectedPresetIdx, customPresets, samePulseCount]);

  const handleSameNoteClick = useCallback((gi: number, ni: number) => {
    setSameGroups(prev => prev.map((g, gIdx) => {
      if (gIdx !== gi) return g;
      return {
        ...g,
        notes: g.notes.map((n, nIdx) => {
          if (nIdx !== ni) return n;
          const isVeryFirst = gIdx === 0 && nIdx === 0;
          let next = cycleMixedNoteType(n.noteType);
          if (isVeryFirst && next === "tie") next = cycleMixedNoteType(next);
          return { ...n, noteType: next };
        }),
      };
    }));
  }, []);

  const handleSameRandom = useCallback(() => {
    setSameGroups(prev => applyRandomNoteModifications(prev));
  }, []);

  const handleSameSplitNote = useCallback((gi: number, ni: number) => {
    setSameGroups(prev => splitNote(gi, ni, prev));
  }, []);

  const handleChangingPresetSelect = (idx: number) => {
    setChangingSelectedPreset(idx);
    setChangingCustomInput("");
    setChangingCustomError(null);
  };

  const handleChangingGenerate = useCallback(() => {
    let durations: number[];

    if (changingCustomInput.trim()) {
      const parsed = parseGroupChain(changingCustomInput);
      if (!parsed) {
        setChangingCustomError("Enter note durations 1–8 separated by + or spaces (1=16th, 2=8th, 3=d.8th, 4=qtr)");
        return;
      }
      setChangingCustomError(null);
      durations = parsed;
    } else if (changingSelectedPreset !== null) {
      durations = MIXED_GROUP_PRESETS[changingSelectedPreset]?.groups ?? [];
    } else {
      durations = [];
    }

    if (durations.length === 0) return;

    setChangingFormula(durations);
    const result = generateDurationPattern(durations);
    setChangingGroups(result);
    setChangingGenerated(true);
  }, [changingCustomInput, changingSelectedPreset]);

  const handleChangingNoteClick = useCallback((gi: number, ni: number) => {
    setChangingGroups(prev => prev.map((g, gIdx) => {
      if (gIdx !== gi) return g;
      return {
        ...g,
        notes: g.notes.map((n, nIdx) => {
          if (nIdx !== ni) return n;
          const isVeryFirst = gIdx === 0 && nIdx === 0;
          let next = cycleMixedNoteType(n.noteType);
          if (isVeryFirst && next === "tie") next = cycleMixedNoteType(next);
          return { ...n, noteType: next };
        }),
      };
    }));
  }, []);

  const handleChangingRandom = useCallback(() => {
    setChangingGroups(prev => applyRandomNoteModifications(prev));
  }, []);

  const handleChangingSplitNote = useCallback((gi: number, ni: number) => {
    setChangingGroups(prev => splitNote(gi, ni, prev));
  }, []);

  const sameTotalNotes = sameFormula.length > 0
    ? sameFormula.reduce((s, n) => s + n, 0)
    : sameGroups.reduce((s, g) => s + g.notes.length, 0);
  const SAME_PREVIEW_W = Math.max(500, Math.min(900, sameTotalNotes * 45 + 80));

  const changingTotalNotes = changingGroups.reduce((s, g) => s + g.notes.length, 0);
  const CHANGING_PREVIEW_W = Math.max(500, Math.min(900, changingTotalNotes * 45 + 80));

  const parsedChangingCustom = changingCustomInput.trim() ? parseGroupChain(changingCustomInput) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Mode selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: 1 }}>MODE</span>
        {(["same", "changing"] as ModeType[]).map(m => (
          <button key={m}
            onClick={() => setMode(m)}
            style={{
              padding: "4px 12px", borderRadius: 5, fontSize: 11, fontWeight: 700,
              border: `1.5px solid ${mode === m ? "#c8aa50" : "#222"}`,
              background: mode === m ? "#c8aa5022" : "#111",
              color: mode === m ? "#c8aa50" : "#555",
              cursor: "pointer",
            }}>
            {m === "same" ? "Same Subdivision" : "Changing Subdivision"}
          </button>
        ))}
      </div>

      {/* ── Same Subdivision ── */}
      {mode === "same" && (
        <>
          {/* Pulse count input */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: 1 }}>PULSES</span>
            <button
              onClick={() => setSamePulseCount(c => Math.max(2, c - 1))}
              style={{
                width: 26, height: 26, borderRadius: 4, fontSize: 14, fontWeight: 700,
                border: "1.5px solid #222", background: "#111", color: "#555", cursor: "pointer",
              }}>−</button>
            <input
              type="number"
              min={2}
              max={32}
              value={samePulseCount}
              onChange={e => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 2 && v <= 32) setSamePulseCount(v);
              }}
              style={{
                width: 52, height: 26, borderRadius: 4, fontSize: 13, fontWeight: 700,
                border: "1.5px solid #333", background: "#111", color: "#c8aa50",
                textAlign: "center", outline: "none",
              }}
            />
            <button
              onClick={() => setSamePulseCount(c => Math.min(32, c + 1))}
              style={{
                width: 26, height: 26, borderRadius: 4, fontSize: 14, fontWeight: 700,
                border: "1.5px solid #222", background: "#111", color: "#555", cursor: "pointer",
              }}>+</button>
            <span style={{ fontSize: 10, color: "#444" }}>total pulses (2–32)</span>
          </div>

          {/* Custom chain entry */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: 1 }}>CUSTOM CHAIN</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                placeholder="e.g. 1+2+2 or 4,4,4,4 (1=16th 2=8th 4=qtr)"
                value={sameCustomInput}
                onChange={e => { setSameCustomInput(e.target.value); setSameCustomError(null); setSameSelectedPresetIdx(null); }}
                style={{
                  flex: 1, maxWidth: 280, height: 32, borderRadius: 6, fontSize: 11,
                  border: `1.5px solid ${sameCustomError ? "#e06060" : "#222"}`,
                  background: "#111", color: "#ccc", padding: "0 10px", outline: "none",
                }}
              />
              <button
                onClick={handleSaveCustom}
                disabled={!sameCustomInput.trim()}
                style={{
                  padding: "0 12px", height: 32, borderRadius: 6, fontSize: 11, fontWeight: 700,
                  border: "1.5px solid #444", background: "#111",
                  color: sameCustomInput.trim() ? "#c8aa50" : "#333",
                  cursor: sameCustomInput.trim() ? "pointer" : "default",
                }}>
                Save
              </button>
              {sameCustomError && <span style={{ fontSize: 10, color: "#e06060" }}>{sameCustomError}</span>}
            </div>
            {sameCustomInput.trim() && !sameCustomError && (() => {
              const parsed = parseGroupChain(sameCustomInput);
              return parsed ? (
                <div style={{ fontSize: 10, color: "#555" }}>
                  Formula: {parsed.join(" + ")} = {parsed.reduce((s, n) => s + n, 0)} pulses
                </div>
              ) : null;
            })()}
          </div>

          {/* Custom preset bank (user-saved only) */}
          {customPresets.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: 1 }}>MY PRESETS</span>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {customPresets.map((p, i) => (
                  <div key={p.label} style={{ display: "flex", alignItems: "center", gap: 0 }}>
                    <button
                      onClick={() => handleSamePresetSelect("custom", i)}
                      title={p.description}
                      style={{
                        padding: "5px 10px", borderRadius: "5px 0 0 5px", fontSize: 11, fontWeight: 700,
                        border: `1.5px solid ${sameSelectedPresetIdx?.type === "custom" && sameSelectedPresetIdx.idx === i ? "#c8aa50" : "#1e1e1e"}`,
                        borderRight: "none",
                        background: sameSelectedPresetIdx?.type === "custom" && sameSelectedPresetIdx.idx === i ? "#c8aa5018" : "#0e0e0e",
                        color: sameSelectedPresetIdx?.type === "custom" && sameSelectedPresetIdx.idx === i ? "#c8aa50" : "#555",
                        cursor: "pointer", fontFamily: "monospace",
                      }}>
                      {p.label}
                    </button>
                    <button
                      onClick={() => handleDeleteCustom(i)}
                      title="Delete preset"
                      style={{
                        padding: "5px 7px", borderRadius: "0 5px 5px 0", fontSize: 10, fontWeight: 700,
                        border: `1.5px solid ${sameSelectedPresetIdx?.type === "custom" && sameSelectedPresetIdx.idx === i ? "#c8aa50" : "#1e1e1e"}`,
                        background: "#0e0e0e",
                        color: "#555",
                        cursor: "pointer",
                      }}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Generate button */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={handleSameGenerate}
              style={{
                padding: "0 20px", height: 34, borderRadius: 6, fontSize: 12, fontWeight: 700,
                border: "1.5px solid #c8aa50", background: "#c8aa5022", color: "#c8aa50",
                cursor: "pointer",
              }}>
              Generate
            </button>
          </div>

          {/* Notation preview */}
          {sameGenerated && sameGroups.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: "#555", fontFamily: "monospace" }}>
                  {sameFormula.join(" + ")} = {sameFormula.reduce((s, n) => s + n, 0)} pulses
                </span>
                <button
                  onClick={handleSameRandom}
                  style={{
                    padding: "3px 12px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                    border: "1.5px solid #333", background: "#111", color: "#888",
                    cursor: "pointer",
                  }}>
                  Random Modifications
                </button>
                {MIXED_DISPLAY_TYPES.map(t => (
                  <span key={t} style={{
                    fontSize: 10, padding: "2px 6px", borderRadius: 3,
                    background: "#111", border: `1px solid ${getNoteColor(t)}44`,
                    color: getNoteColor(t),
                  }}>
                    {getNoteLabel(t)} = {t}
                  </span>
                ))}
              </div>

              <div style={{ overflowX: "auto", background: "#0a0a0a", borderRadius: 8, border: "1px solid #1a1a1a", padding: 8 }}>
                <KonnakolNotation
                  groups={sameGroups}
                  width={SAME_PREVIEW_W}
                  height={140}
                  onNoteClick={handleSameNoteClick}
                  groupedSixteenths={sameFormula}
                  singleLine
                />
              </div>

              <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                {sameGroups.map((g, gi) =>
                  g.notes.map((n, ni) => (
                    <button
                      key={`${gi}-${ni}`}
                      onClick={() => handleSameNoteClick(gi, ni)}
                      title={`${n.noteType === "rest" ? "rest" : n.noteType === "tie" ? "tie" : n.syllable} | click to cycle type | right-click to split`}
                      onContextMenu={e => { e.preventDefault(); if (canSplitNote(n)) handleSameSplitNote(gi, ni); }}
                      style={{
                        padding: "4px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700,
                        border: `1.5px solid ${getNoteColor(n.noteType)}55`,
                        background: getNoteColor(n.noteType) + "15",
                        color: getNoteColor(n.noteType),
                        cursor: "pointer", minWidth: 30, textAlign: "center",
                      }}>
                      <div style={{ fontSize: 8, color: "#444", marginBottom: 1 }}>
                        {n.noteType === "rest" || n.noteType === "tie" ? "" : n.syllable}
                      </div>
                      <div>{getNoteLabel(n.noteType)}</div>
                      <div style={{ fontSize: 7, color: "#333", marginTop: 1 }}>
                        {SLOT_LABELS[sameFormula[gi]] ?? sameFormula[gi]}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {!sameGenerated && (
            <div style={{
              padding: 24, textAlign: "center", color: "#333", fontSize: 12,
              background: "#0a0a0a", borderRadius: 8, border: "1px solid #141414",
            }}>
              Set the pulse count and press Generate for a random grouping, or enter a custom chain
            </div>
          )}
        </>
      )}

      {/* ── Changing Subdivision ── */}
      {mode === "changing" && (
        <>
          {/* Custom entry */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: 1 }}>CUSTOM CHAIN</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                placeholder="e.g. 1+2+2 or 4,4,4,4 (1=16th 2=8th 4=qtr)"
                value={changingCustomInput}
                onChange={e => { setChangingCustomInput(e.target.value); setChangingCustomError(null); setChangingSelectedPreset(null); }}
                style={{
                  flex: 1, maxWidth: 280, height: 32, borderRadius: 6, fontSize: 11,
                  border: `1.5px solid ${changingCustomError ? "#e06060" : "#222"}`,
                  background: "#111", color: "#ccc", padding: "0 10px", outline: "none",
                }}
              />
              {changingCustomError && <span style={{ fontSize: 10, color: "#e06060" }}>{changingCustomError}</span>}
            </div>
            {changingCustomInput.trim() && !changingCustomError && parsedChangingCustom && (
              <div style={{ fontSize: 10, color: "#555" }}>
                Formula: {parsedChangingCustom.join(" + ")} = {parsedChangingCustom.reduce((s, n) => s + n, 0)} pulses
              </div>
            )}
          </div>

          {/* Preset bank */}
          {MIXED_GROUP_PRESETS.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: 1 }}>PRESET BANK</span>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {MIXED_GROUP_PRESETS.map((p, i) => (
                  <button key={p.label}
                    onClick={() => handleChangingPresetSelect(i)}
                    title={p.description}
                    style={{
                      padding: "5px 10px", borderRadius: 5, fontSize: 11, fontWeight: 700,
                      border: `1.5px solid ${changingSelectedPreset === i ? "#c8aa50" : "#1e1e1e"}`,
                      background: changingSelectedPreset === i ? "#c8aa5018" : "#0e0e0e",
                      color: changingSelectedPreset === i ? "#c8aa50" : "#444",
                      cursor: "pointer", fontFamily: "monospace",
                    }}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Generate button */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={handleChangingGenerate}
              disabled={!changingCustomInput.trim() && changingSelectedPreset === null}
              style={{
                padding: "0 20px", height: 34, borderRadius: 6, fontSize: 12, fontWeight: 700,
                border: "1.5px solid #c8aa50", background: "#c8aa5022", color: "#c8aa50",
                cursor: (!changingCustomInput.trim() && changingSelectedPreset === null) ? "default" : "pointer",
                opacity: (!changingCustomInput.trim() && changingSelectedPreset === null) ? 0.5 : 1,
              }}>
              Generate
            </button>
          </div>

          {!changingCustomInput.trim() && changingSelectedPreset === null && !changingGenerated && (
            <div style={{
              padding: 24, textAlign: "center", color: "#333", fontSize: 12,
              background: "#0a0a0a", borderRadius: 8, border: "1px solid #141414",
            }}>
              Enter a custom group chain, then press Generate
            </div>
          )}

          {/* Notation preview */}
          {changingGenerated && changingGroups.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: "#555", fontFamily: "monospace" }}>
                  {changingFormula.join(" + ")} = {changingFormula.reduce((s, n) => s + n, 0)} pulses
                </span>
                <button
                  onClick={handleChangingRandom}
                  style={{
                    padding: "3px 12px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                    border: "1.5px solid #333", background: "#111", color: "#888",
                    cursor: "pointer",
                  }}>
                  Random Modifications
                </button>
                {MIXED_DISPLAY_TYPES.map(t => (
                  <span key={t} style={{
                    fontSize: 10, padding: "2px 6px", borderRadius: 3,
                    background: "#111", border: `1px solid ${getNoteColor(t)}44`,
                    color: getNoteColor(t),
                  }}>
                    {getNoteLabel(t)} = {t}
                  </span>
                ))}
              </div>

              <div style={{ overflowX: "auto", background: "#0a0a0a", borderRadius: 8, border: "1px solid #1a1a1a", padding: 8 }}>
                <KonnakolNotation
                  groups={changingGroups}
                  width={CHANGING_PREVIEW_W}
                  height={140}
                  baseDuration="16"
                  noTuplets
                  onNoteClick={handleChangingNoteClick}
                  singleLine
                />
              </div>

              <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                {changingGroups.map((g, gi) =>
                  g.notes.map((n, ni) => (
                    <button
                      key={`${gi}-${ni}`}
                      onClick={() => handleChangingNoteClick(gi, ni)}
                      title={`${n.noteType === "rest" ? "rest" : n.noteType === "tie" ? "tie" : n.syllable} | click to cycle type | right-click to split`}
                      onContextMenu={e => { e.preventDefault(); if (canSplitNote(n)) handleChangingSplitNote(gi, ni); }}
                      style={{
                        padding: "4px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700,
                        border: `1.5px solid ${getNoteColor(n.noteType)}55`,
                        background: getNoteColor(n.noteType) + "15",
                        color: getNoteColor(n.noteType),
                        cursor: "pointer", minWidth: 30, textAlign: "center",
                      }}>
                      <div style={{ fontSize: 8, color: "#444", marginBottom: 1 }}>
                        {n.noteType === "rest" || n.noteType === "tie" ? "" : n.syllable}
                      </div>
                      <div>{getNoteLabel(n.noteType)}</div>
                      <div style={{ fontSize: 7, color: "#333", marginTop: 1 }}>
                        {SLOT_LABELS[changingFormula[gi]] ?? changingFormula[gi]}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
