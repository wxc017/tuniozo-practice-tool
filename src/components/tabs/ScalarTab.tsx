import { useCallback, useMemo, useRef, useState } from "react";
import { audioEngine } from "@/lib/audioEngine";
import { useLS } from "@/lib/storage";
import { formatHalfAccidentals, getModeDegreeMap, getSolfege, getHeathwaiteSolfege } from "@/lib/edoData";
import { syllableForEdoStep } from "@/lib/microtonalSolfege";
import { getTonalityBanks, type TonalityBank } from "@/lib/tonalityBanks";
import { bankToScaleFamMode } from "@/lib/tonalityChordPool";
import { jiLimitGroupsForEdo } from "@/lib/jiTonalityFamilies";
import { analyzeJiScale } from "@/lib/jiChordAnalysis";
import { JI_SCALE_NAMES } from "@/lib/jiScaleData";
import FloatingPanel from "@/components/FloatingPanel";

const JI_SCALE_NAMES_SET = new Set(JI_SCALE_NAMES);
import { formatRomanNumeral } from "@/lib/formatRoman";
import ModeLattice3D from "../scalar/ModeLattice3D";

interface Props {
  tonicPc: number;
  lowestPitch: number;
  highestPitch: number;
  edo: number;
  onHighlight: (pcs: number[]) => void;
  ensureAudio: () => Promise<void>;
  playVol?: number;
}

interface TonalityFamilyGroup { key: string; label: string; color: string; tonalities: string[] }

const TONALITY_FAMILIES: TonalityFamilyGroup[] = [
  { key: "major",    label: "MAJOR",          color: "#6a9aca",
    tonalities: ["Major","Dorian","Phrygian","Lydian","Mixolydian","Aeolian","Locrian"] },
  { key: "harmonic", label: "HARMONIC MINOR", color: "#c09050",
    tonalities: ["Harmonic Minor","Locrian #6","Ionian #5","Dorian #4","Phrygian Dominant","Lydian #2","Ultralocrian"] },
  { key: "melodic",  label: "MELODIC MINOR",  color: "#c06090",
    tonalities: ["Melodic Minor","Dorian b2","Lydian Augmented","Lydian Dominant","Mixolydian b6","Locrian #2","Altered"] },
  { key: "subminor",   label: "SUBMINOR DIATONIC",   color: "#7aaa6a",
    tonalities: ["Subminor Diatonic","Locrian s2 s5 s6","Supermajor Ionian","Dorian s3 bb4 s7","Subminor Phrygian m7","Supermajor Lydian M2 b5","Supermajor Mixolydian ##5 m7"] },
  { key: "neutral",    label: "NEUTRAL DIATONIC",    color: "#9a66c0",
    tonalities: ["Neutral Diatonic","Dorian N2 bb5 N6","Neutral Ionian","Ionian N3 ##4 N7","Neutral Dorian m7","Neutral Ionian M2 ##4","Neutral Dorian bb5 m7"] },
  { key: "supermajor", label: "SUPERMAJOR DIATONIC", color: "#cc6a8a",
    tonalities: ["Supermajor Diatonic","Dorian S2 ##5 S6","Subminor Phrygian","Lydian S3 b5 S7","Supermajor Mixolydian m7","Subminor Aeolian M2 bb4","Subminor Locrian m7"] },
  { key: "subharmonic",label: "SUBHARMONIC DIATONIC M7",color: "#4a9ac7",
    tonalities: ["Subharmonic Diatonic M7","Locrian s2 s5 N6","Supermajor Ionian #5","Dorian s3 ##4 s7","Phrygian s2 N3 s6","Supermajor Lydian #2 b5","Neutral Dorian b4 bb5 bb7"] },
  { key: "doubleharmonic", label: "DOUBLE HARMONIC", color: "#e08040",
    tonalities: ["Double Harmonic Major","Lydian #2 #6","Ultraphrygian","Hungarian Minor","Oriental","Ionian #2 #5","Locrian bb3 bb7"] },
  { key: "symmetric", label: "SYMMETRIC", color: "#5ab9b0",
    tonalities: [
      "Whole Tone","Half-Whole Diminished","Whole-Half Diminished",
      "Whole Tone (Half-Sharp)",
      "Half-Whole Diminished (Half-Sharp)",
      "Whole-Half Diminished (Half-Flat)",
    ] },
];

// ── LIMIT > FAMILY > MODES sectioning (mirrors ChordsTab) ────────────────
// Same structure as Spatial Audiation (ChordsTab) so the two tabs feel
// like a single picker.  Meantone EDOs (12 / 19 / 31) get the existing
// flat TONALITY_FAMILIES grouped into limit sections; JI EDOs (41 / 53)
// get the JI_LIMIT_GROUPS structure with sub-families per limit.

interface TonalitySection {
  key: string;
  label: string;
  color: string;
  families: { key: string; label: string; tonalities: string[] }[];
}

const MEANTONE_LIMIT_SECTIONS: { key: string; label: string; color: string; familyKeys: string[] }[] = [
  { key: "lim5",  label: "5-LIMIT (MEANTONE)", color: "#6a9aca",
    familyKeys: ["major", "harmonic", "melodic", "doubleharmonic"] },
  { key: "lim7",  label: "7-LIMIT (SEPTIMAL)", color: "#7aaa6a",
    familyKeys: ["subminor", "supermajor", "subharmonic"] },
  { key: "lim11", label: "11-LIMIT (NEUTRAL)", color: "#9a66c0",
    familyKeys: ["neutral"] },
  { key: "sym",   label: "SYMMETRIC",          color: "#5ab9b0",
    familyKeys: ["symmetric"] },
];

function tonalitySectionsForEdo(edo: number): TonalitySection[] {
  if (edo === 41 || edo === 53) {
    return jiLimitGroupsForEdo(edo).map(g => ({
      key: `limit-${g.limit}`,
      label: g.label,
      color: g.color,
      families: g.families.map(f => ({ key: f.key, label: f.label, tonalities: f.tonalities })),
    }));
  }
  return MEANTONE_LIMIT_SECTIONS
    .map(sec => ({
      key: sec.key,
      label: sec.label,
      color: sec.color,
      families: sec.familyKeys
        .map(fk => TONALITY_FAMILIES.find(f => f.key === fk))
        .filter((f): f is TonalityFamilyGroup => !!f)
        .map(f => ({ key: f.key, label: f.label, tonalities: f.tonalities })),
    }))
    .filter(sec => sec.families.length > 0);
}

export default function ScalarTab({
  tonicPc, lowestPitch, highestPitch, edo, onHighlight, ensureAudio, playVol = 0.55,
}: Props) {
  const [selected, setSelected] = useLS<string>("lt_scalar_tonality", "Major");
  const [activeFamilyColor, setActiveFamilyColor] = useState<string>("#6a9aca");
  // Solfege system toggle — two options:
  //   "heathwaite" — Andrew Heathwaite's solfege (the canonical do-re-mi
  //                   system, with consistent tetrachordal vowel mirroring
  //                   between the lower and upper tetrachords).  Falls back
  //                   to the legacy EDO solfege outside 31-EDO.
  //   "microtonal" — IPA-derived interval-name system keyed by cents
  //                   (Sais / Sai / Sail / Soos / …); works in any EDO.
  const [solfegeKind, setSolfegeKind] = useLS<"heathwaite" | "microtonal">(
    "lt_scalar_solfege_kind", "heathwaite"
  );
  const frameTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Drone state: tracks whether a syllable is currently sustained, plus
  // the press-hold timer that fires after 2s of holding to start it.
  const [dronedStep, setDronedStep] = useState<number | null>(null);
  const droneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Highlighted-chord state: which chord's ⬚ button is "on".  The
  // highlight stays lit on the keyboard until the user clicks that same
  // button again (toggle).  Identified by `${level}-${idx}` so the same
  // Roman numeral can appear in multiple levels without colliding.
  const [highlightedChordKey, setHighlightedChordKey] = useState<string | null>(null);

  // All tonality banks for the current EDO.  showSevenths = true so the
  // chord pool exposes 7th-quality suffixes (Scalar Exploration is a
  // reference view; we want to see everything).
  const tonalityBanks = useMemo(() => getTonalityBanks(edo, true), [edo]);
  const banksByName = useMemo(() => {
    const m: Record<string, TonalityBank> = {};
    for (const b of tonalityBanks) m[b.name] = b;
    return m;
  }, [tonalityBanks]);

  // The currently-selected tonality's scale, solfège, and chord pool.
  const view = useMemo(() => {
    const bank = banksByName[selected];
    if (!bank) return null;
    const [fam, mode] = bankToScaleFamMode(selected);
    const degMap = getModeDegreeMap(edo, fam, mode);
    const entries = Object.entries(degMap).sort((a, b) => a[1] - b[1]);
    const solfege = getSolfege(edo);
    const scale = entries.map(([degree, step]) => ({
      degree,
      step,
      solfege: solfege ? solfege[step] : String(step),
    }));
    return { bank, scale };
  }, [banksByName, selected, edo]);

  // Anchor key for the 3D lattice — `${family}::${mode}` of the
  // currently-selected tonality.  bankToScaleFamMode gives us the pair.
  const anchorKey = useMemo(() => {
    if (!banksByName[selected]) return null;
    const [fam, mode] = bankToScaleFamMode(selected);
    return `${fam}::${mode}`;
  }, [banksByName, selected]);

  const baseTonic = lowestPitch + (((tonicPc - lowestPitch) % edo) + edo) % edo;

  // Helper: clear any pending highlight scheduling, stop audio, kill
  // any active syllable drone.
  const stop = useCallback(() => {
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    if (droneTimerRef.current) { clearTimeout(droneTimerRef.current); droneTimerRef.current = null; }
    audioEngine.stopDrone();
    audioEngine.silencePlay();
    setDronedStep(null);
    setHighlightedChordKey(null);
    onHighlight([]);
  }, [onHighlight]);

  // Sequence playback: ascending scale 1-2-3-4-5-6-7-1', then a 5-second
  // hold on the full scale so the shape stays lit on the visualizer.
  const playSequence = useCallback(async () => {
    if (!view) return;
    await ensureAudio();
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    audioEngine.stopDrone();
    setDronedStep(null);
    const stepsAsc = view.scale.map(s => s.step);
    const allSteps = [...stepsAsc, stepsAsc[0] + edo];
    const frames = allSteps.map(s => [baseTonic + s]);
    const noteDur = 0.55;
    const gapMs = 500;
    const HOLD_MS = 5000;
    audioEngine.playMultiVoice(
      [{ frames, noteDuration: noteDur, gain: playVol * 1.6 }],
      edo, gapMs, frames.length
    );
    for (let i = 0; i < frames.length; i++) {
      const id = setTimeout(() => onHighlight(frames[i]), i * gapMs);
      frameTimers.current.push(id);
    }
    const allNotes = allSteps.map(s => baseTonic + s);
    const holdStart = frames.length * gapMs;
    const holdId = setTimeout(() => onHighlight(allNotes), holdStart);
    frameTimers.current.push(holdId);
    const clearId = setTimeout(() => onHighlight([]), holdStart + HOLD_MS);
    frameTimers.current.push(clearId);
  }, [view, baseTonic, edo, ensureAudio, playVol, onHighlight]);

  // Static highlight: light up the entire scale at once on the keyboard.
  // Stays lit until the user takes another action — no auto-clear.
  const highlightAll = useCallback(() => {
    if (!view) return;
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    audioEngine.stopDrone();
    setDronedStep(null);
    setHighlightedChordKey(null);
    const allSteps = [...view.scale.map(s => s.step), view.scale[0].step + edo];
    onHighlight(allSteps.map(s => baseTonic + s));
  }, [view, baseTonic, edo, onHighlight]);

  // Play a single chord (its pitches simultaneously).  The highlight
  // sticks for the duration of the audio, then stays — any subsequent
  // action (another chord click, a different highlight, or Clear)
  // overrides it.  No timed auto-clear, matching the Highlight Scale
  // button's sticky behaviour.
  const playChord = useCallback(async (steps: number[]) => {
    if (!steps || steps.length === 0) return;
    await ensureAudio();
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    audioEngine.stopDrone();
    setDronedStep(null);
    setHighlightedChordKey(null);
    const pitches = steps.map(s => baseTonic + s);
    audioEngine.playMultiVoice(
      [{ frames: [pitches], noteDuration: 1.4, gain: playVol * 1.6 }],
      edo, 0, 1
    );
    onHighlight(pitches);
  }, [baseTonic, edo, ensureAudio, playVol, onHighlight]);

  // Sticky highlight for a chord — no audio, no auto-clear.  Stays lit
  // until the user takes another action.
  // Toggle a chord's keyboard highlight.  If the requested chord is
  // already the active one, clear; otherwise switch to it.  Stays on
  // until the user clicks the same ⬚ again (or another action wipes it).
  const toggleChordHighlight = useCallback((key: string, steps: number[]) => {
    if (!steps || steps.length === 0) return;
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    audioEngine.stopDrone();
    setDronedStep(null);
    if (highlightedChordKey === key) {
      setHighlightedChordKey(null);
      onHighlight([]);
    } else {
      setHighlightedChordKey(key);
      onHighlight(steps.map(s => baseTonic + s));
    }
  }, [baseTonic, onHighlight, highlightedChordKey]);

  // ── Syllable interaction ─────────────────────────────────────────
  // - Quick click → play the tone (single transient note).
  // - Press-and-hold ≥ 2s → start a sustained drone on that pitch.
  // - Click again on the droning syllable → stop drone.
  // - Clicking any syllable while a drone is active first stops the drone.
  const playSyllable = useCallback(async (step: number) => {
    await ensureAudio();
    const pitch = baseTonic + step;
    audioEngine.playMultiVoice(
      [{ frames: [[pitch]], noteDuration: 0.7, gain: playVol * 1.2 }],
      edo, 0, 1
    );
    onHighlight([pitch]);
  }, [baseTonic, edo, ensureAudio, playVol, onHighlight]);

  const startSyllableDrone = useCallback(async (step: number) => {
    await ensureAudio();
    audioEngine.stopDrone();
    audioEngine.startDrone([baseTonic + step], edo, 0.07);
    onHighlight([baseTonic + step]);
    setDronedStep(step);
  }, [baseTonic, edo, ensureAudio, onHighlight]);

  const stopSyllableDrone = useCallback(() => {
    audioEngine.stopDrone();
    setDronedStep(null);
  }, []);

  const onSyllablePressStart = useCallback((step: number) => {
    // If something is already droning, treat this press as the toggle-off
    // gesture instead of a fresh play.
    if (dronedStep !== null) {
      stopSyllableDrone();
      return;
    }
    playSyllable(step);
    if (droneTimerRef.current) clearTimeout(droneTimerRef.current);
    droneTimerRef.current = setTimeout(() => {
      startSyllableDrone(step);
      droneTimerRef.current = null;
    }, 2000);
  }, [dronedStep, playSyllable, startSyllableDrone, stopSyllableDrone]);

  const onSyllablePressEnd = useCallback(() => {
    // Released before the 2s threshold — cancel the pending drone.
    if (droneTimerRef.current) {
      clearTimeout(droneTimerRef.current);
      droneTimerRef.current = null;
    }
  }, []);

  return (
    <div className="space-y-4">
      {/* ── Info panel for the selected tonality (renders right below
          the sticky visualizer at the top of the tab). ── */}
      {view && (
        <div className="bg-[#0e0e0e] border rounded p-4 space-y-3"
             style={{ borderColor: activeFamilyColor + "40" }}>
          <div className="flex items-center gap-3 flex-wrap">
            <h3 className="text-base font-semibold"
                style={{ color: activeFamilyColor }}>
              {formatHalfAccidentals(selected)}
            </h3>
            <button onClick={playSequence}
              className="text-[11px] px-3 py-1 rounded border border-[#2a2a2a] bg-[#141414] text-[#aaa] hover:text-white hover:border-[#444]">
              ▶ Play Scale
            </button>
            <button onClick={highlightAll}
              className="text-[11px] px-3 py-1 rounded border border-[#2a2a2a] bg-[#141414] text-[#aaa] hover:text-white hover:border-[#444]">
              ⬚ Highlight Scale
            </button>
            <button onClick={stop}
              className="text-[11px] px-3 py-1 rounded border border-[#2a2a2a] bg-[#141414] text-[#666] hover:text-[#aaa]">
              Clear
            </button>
          </div>

          {/* Solfege system toggle — Heathwaite (default Do-Re-Mi-style)
              or Microtonal (IPA interval-name system from cents). */}
          <div className="flex items-center gap-1 mb-1 flex-wrap">
            <span className="text-[10px] text-[#666] mr-1">SOLFEGE</span>
            {(["heathwaite", "microtonal"] as const).map(k => {
              const active = solfegeKind === k;
              const label = k === "heathwaite" ? "Heathwaite" : "Microtonal";
              return (
                <button key={k}
                  onClick={() => setSolfegeKind(k)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors border ${
                    active
                      ? "bg-[#1a1a3a] border-[#5b5be6] text-[#9999ee]"
                      : "bg-[#0e0e0e] border-[#222] text-[#555] hover:text-[#888]"
                  }`}>
                  {label}
                </button>
              );
            })}
          </div>

          {/* Solfege + degree row.  Click to play the tone; press-and-
              hold ≥ 2s to start a drone on that pitch (click again to
              stop). */}
          <div className="flex flex-wrap gap-2">
            {view.scale.map(s => {
              const droning = dronedStep === s.step;
              const microtonal = syllableForEdoStep(s.step, edo);
              const heathwaiteTable = getHeathwaiteSolfege(edo);
              const heathwaiteLabel = heathwaiteTable ? heathwaiteTable[s.step] : null;
              const labelText = solfegeKind === "microtonal"
                ? microtonal.label
                : (heathwaiteLabel ?? s.solfege);  // heathwaite, falling back to legacy EDO solfege
              const tooltipDetail = solfegeKind === "microtonal"
                ? `${microtonal.label}  /${microtonal.ipa}/  ·  ${microtonal.category}${microtonal.subcategory ? " · " + microtonal.subcategory : ""}`
                : `${labelText} (Heathwaite)`;
              return (
                <button key={s.step}
                  onMouseDown={() => onSyllablePressStart(s.step)}
                  onMouseUp={onSyllablePressEnd}
                  onMouseLeave={onSyllablePressEnd}
                  onTouchStart={(e) => { e.preventDefault(); onSyllablePressStart(s.step); }}
                  onTouchEnd={onSyllablePressEnd}
                  title={`Click: play ${tooltipDetail}.  Hold 2s: drone.`}
                  className="flex flex-col items-center px-3 py-2 rounded border transition-colors select-none"
                  style={{
                    borderColor: droning ? activeFamilyColor : activeFamilyColor + "30",
                    background: droning ? activeFamilyColor + "40" : activeFamilyColor + "10",
                    boxShadow: droning ? `0 0 0 2px ${activeFamilyColor}55 inset` : undefined,
                  }}>
                  <span className="text-base font-bold"
                        style={{ color: activeFamilyColor }}>
                    {labelText}
                  </span>
                  {solfegeKind === "microtonal" && (
                    <span className="text-[8px] text-[#666] font-mono mt-0.5">
                      /{microtonal.ipa}/
                    </span>
                  )}
                  <span className="text-[10px] text-[#888] mt-0.5">
                    {formatHalfAccidentals(s.degree)}
                  </span>
                  <span className="text-[9px] text-[#555]">
                    {droning ? "🔊 drone" : `▶ step ${s.step}`}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Chord pool — Primary + Diatonic */}
          {view.bank.levels
            .filter(l => l.name === "Primary" || l.name === "Diatonic")
            .map(level => (
              <div key={level.name}
                   className="rounded p-2 border border-[#1a1a1a] bg-[#0a0a0a]">
                <p className="text-[10px] mb-1.5 font-semibold tracking-wider"
                   style={{ color: activeFamilyColor }}>
                  {level.name.toUpperCase()}
                </p>
                <div className="flex flex-wrap gap-2">
                  {level.chords.map((entry, i) => {
                    const key = `${level.name}-${i}`;
                    const lit = highlightedChordKey === key;
                    return (
                      <span key={key} className="inline-flex items-stretch">
                        <button
                          onClick={() => entry.steps && playChord(entry.steps)}
                          title={entry.steps
                            ? `Play ${entry.label} — ${entry.steps.join(", ")}`
                            : entry.label}
                          className="px-4 py-2.5 text-xl font-semibold rounded-l border-y border-l border-[#2a2a2a] bg-[#141414] text-[#bbb] hover:text-white hover:border-[#444] transition-colors">
                          {formatRomanNumeral(entry.label)}
                        </button>
                        <button
                          onClick={() => entry.steps && toggleChordHighlight(key, entry.steps)}
                          title={lit
                            ? `Click to clear highlight on ${entry.label}`
                            : `Highlight ${entry.label} on keyboard — stays until clicked again`}
                          className="px-2 py-2.5 text-[11px] rounded-r border-y border-r transition-colors"
                          style={lit
                            ? { borderColor: activeFamilyColor,
                                background: activeFamilyColor + "30",
                                color: activeFamilyColor }
                            : { borderColor: "#2a2a2a",
                                background: "#0d0d0d",
                                color: "#555" }}>
                          ⬚
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* ── Tonality picker (large buttons, single-select) — LIMIT >
          FAMILY > MODES hierarchy mirroring Spatial Audiation. ── */}
      <div className="bg-[#0e0e0e] border border-[#1a1a1a] rounded p-3 space-y-3">
        {tonalitySectionsForEdo(edo).map(section => {
          const usableFamilies = section.families
            .map(f => ({ ...f, tonalities: f.tonalities.filter(t => banksByName[t]) }))
            .filter(f => f.tonalities.length > 0);
          if (usableFamilies.length === 0) return null;
          return (
            <div key={section.key} className="space-y-1.5">
              <p className="text-[10px] font-bold tracking-widest border-b border-[#1a1a1a] pb-0.5"
                 style={{ color: section.color }}>{section.label}</p>
              {usableFamilies.map(family => (
                <div key={family.key} className="ml-2">
                  <p className="text-[9px] mb-1 font-medium tracking-wider text-[#666]">
                    {family.label}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {family.tonalities.map(t => {
                      const on = selected === t;
                      return (
                        <button key={t}
                          onClick={() => { setSelected(t); setActiveFamilyColor(section.color); }}
                          className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                            on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                          }`}
                          style={on
                            ? { backgroundColor: section.color + "30", borderColor: section.color, color: section.color }
                            : undefined}>
                          {formatHalfAccidentals(t)}
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

      {/* ── 3D mode lattice ────────────────────────────────────────
          All 49 modes arranged by force-directed simulation in X-Z;
          Y locks to brightness so bright modes float and dark ones
          sink.  The selected tonality from the picker above acts as
          the visual anchor.  Click any mode to drone its scale on
          the user's root pitch. ── */}
      <ModeLattice3D
        edo={edo}
        rootPitch={baseTonic}
        tonicPc={tonicPc}
        anchorKey={anchorKey}
        playVol={playVol} />
    </div>
  );
}
