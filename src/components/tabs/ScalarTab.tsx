import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { audioEngine } from "@/lib/audioEngine";
import { useLS } from "@/lib/storage";
import { formatHalfAccidentals, getModeDegreeMap, getSolfege, getHeathwaiteSolfege, getBaseChords, getChordShapes, pcToNoteNameWithEnharmonic } from "@/lib/edoData";
import { syllableForEdoStep } from "@/lib/microtonalSolfege";
import { piperSpeak, piperPrewarm } from "@/lib/piperSpeech";
import { heathwaiteIpa } from "@/lib/solfegeSpeech";
import { getTonalityBanks, type TonalityBank } from "@/lib/tonalityBanks";
import { bankToScaleFamMode } from "@/lib/tonalityChordPool";
import { jiLimitGroupsForEdo } from "@/lib/jiTonalityFamilies";
import { KNOWN_INTERVALS } from "@/lib/jiChordAnalysis";
import { JI_SCALE_NAMES } from "@/lib/jiScaleData";
import FloatingPanel from "@/components/FloatingPanel";
import NotationLegend from "@/components/NotationLegend";

const JI_SCALE_NAMES_SET = new Set(JI_SCALE_NAMES);
import { formatRomanNumeral } from "@/lib/formatRoman";
import ModeLattice3D from "../scalar/ModeLattice3D";

interface Props {
  tonicPc: number;
  setTonicPc: (pc: number) => void;
  lowestPitch: number;
  highestPitch: number;
  edo: number;
  onHighlight: (pcs: number[]) => void;
  ensureAudio: () => Promise<void>;
  playVol?: number;
  /** Optional element to portal the lower section (tonality picker +
   *  reverb knob + 3D mode lattice) into.  When provided, those three
   *  blocks render into that DOM node instead of inline; the upper
   *  chord-highlight content (tuning families + chord overlay + info
   *  panel) stays in place.  App.tsx uses this to keep the upper
   *  content INSIDE the sticky-visualizer wrapper while the lower
   *  content renders OUTSIDE — so the visualizer releases once the
   *  user scrolls past the chord-highlight stuff (per direct user
   *  direction 2026-05-05: "the visualizer should disappear after i
   *  pass the chords highlight stuff"). */
  lowerSectionPortalTarget?: HTMLElement | null;
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
    tonalities: ["Neutral Diatonic","Dorian n2 bb5 n6","Neutral Ionian","Ionian n3 ##4 n7","Neutral Dorian m7","Neutral Ionian M2 ##4","Neutral Dorian bb5 m7"] },
  { key: "supermajor", label: "SUPERMAJOR DIATONIC", color: "#cc6a8a",
    tonalities: ["Supermajor Diatonic","Dorian S2 ##5 S6","Subminor Phrygian","Lydian S3 b5 S7","Supermajor Mixolydian m7","Subminor Aeolian M2 bb4","Subminor Locrian m7"] },
  { key: "subharmonic",label: "SUBHARMONIC DIATONIC M7",color: "#4a9ac7",
    tonalities: ["Subharmonic Diatonic M7","Locrian s2 s5 n6","Supermajor Ionian #5","Dorian s3 ##4 s7","Phrygian s2 n3 s6","Supermajor Lydian #2 b5","Neutral Dorian b4 bb5 bb7"] },
  { key: "doubleharmonic", label: "DOUBLE HARMONIC", color: "#e08040",
    tonalities: ["Double Harmonic Minor","Double Harmonic Major","Lydian #2 #6","Ultraphrygian","Oriental","Ionian #2 #5","Locrian bb3 bb7"] },
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
    // Unique key per section — for 41/53-EDO every family is registered
    // at limit=5 by familiesAsLimitGroups, so a bare limit-${g.limit}
    // collides across sections (React duplicate-key warning).
    return jiLimitGroupsForEdo(edo).map((g, i) => ({
      key: `limit-${g.limit}-${i}-${g.label}`,
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
  tonicPc, setTonicPc, lowestPitch, highestPitch, edo, onHighlight, ensureAudio, playVol = 0.55,
  lowerSectionPortalTarget,
}: Props) {
  const [selected, setSelected] = useLS<string>("lt_scalar_tonality", "Major");
  const [activeFamilyColor, setActiveFamilyColor] = useState<string>("#6a9aca");

  // Reverb dry/wet — per direct user direction (2026-05-05): Scalar
  // Explorations gets a wet knob so chord-spelling listening exercises
  // can ring out into a hall.  audioEngine has a global reverb send
  // that's bypassed by default; this tab opens it on mount and closes
  // it on unmount so other sections aren't drenched.
  const [reverbWet, setReverbWet] = useLS<number>("lt_scalar_reverbWet", 0.0);
  useEffect(() => {
    audioEngine.setReverbWet(reverbWet);
  }, [reverbWet]);
  useEffect(() => {
    return () => { audioEngine.setReverbWet(0); };
  }, []);
  // Recover from a stale tonality selection.  If the user previously
  // picked a tonality that doesn't exist in the current EDO's banks
  // (e.g. selected "JI Ionian" in 41-EDO, then switched to 31-EDO
  // where it's not registered), `view` would resolve to null and
  // none of the per-tonality UI (scale row, chord pool, lattice) would
  // render — making the whole tab look broken.  Snap to "Major" in
  // that case so the picker stays usable.
  useEffect(() => {
    // tonalityBanks is built from getTonalityBanks(edo) above; we recompute
    // it here rather than depending on it directly to keep the effect
    // narrow on edo changes only.
    const banks = getTonalityBanks(edo, true);
    if (!banks.some(b => b.name === selected)) {
      setSelected("Major");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edo]);
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
  // 19-EDO has no Heathwaite table; coerce the kind so the syllables
  // shown match what's actually defined.
  useEffect(() => {
    if (edo === 19 && solfegeKind === "heathwaite") setSolfegeKind("microtonal");
  }, [edo, solfegeKind, setSolfegeKind]);
  // Pre-warm piper TTS on mount so the first syllable click doesn't
  // pay the worker-cold-start latency.  Fire-and-forget.
  useEffect(() => {
    piperPrewarm(["Do", "Re", "Mi", "Fa", "Sol", "La", "Ti"]);
  }, []);
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
  // True while playSequence's ascending run + 5 s sustained hold are
  // still in flight.  Used to disable Play Scale so the user can't
  // stack overlapping playbacks of the same scale.
  const [isPlayingSequence, setIsPlayingSequence] = useState(false);
  const playSequenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (playSequenceTimer.current) {
      clearTimeout(playSequenceTimer.current);
      playSequenceTimer.current = null;
      setIsPlayingSequence(false);
    }
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
    // Lock the Play Scale button until the run + sustained hold both
    // finish — clearing any prior lockout so a Clear / new scale
    // doesn't leave the button stuck disabled.
    if (playSequenceTimer.current) clearTimeout(playSequenceTimer.current);
    setIsPlayingSequence(true);
    playSequenceTimer.current = setTimeout(() => {
      setIsPlayingSequence(false);
      playSequenceTimer.current = null;
    }, holdStart + HOLD_MS);
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
  // Base chord map for the current EDO — used as a fallback when a
  // chord entry has steps: null (e.g. ref("I") / ref("IV") in the Major
  // bank, which intentionally defer to the EDO-wide base map).  Without
  // this fallback those chord buttons did nothing because the call
  // site short-circuited on `(() => { const s = resolveChordSteps(entry.label, entry.steps); if (s) playChord(s); })()`.
  const baseChordMap = useMemo<Record<string, number[]>>(
    () => Object.fromEntries(getBaseChords(edo)),
    [edo],
  );
  const resolveChordSteps = useCallback((label: string, steps: number[] | null): number[] | null => {
    return steps ?? baseChordMap[label] ?? null;
  }, [baseChordMap]);

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
      {/* ── Root note picker — every other section that uses tonicPc
          either has its own (Tonal Audiation) or doesn't need a UI for
          it.  Scalar Explorations needed one too per direct user
          direction (2026-05-05): "to select a root note in scalar
          explorations is missing, i dont see a way to select one". */}
      <div className="bg-[#0e0e0e] border border-[#222] rounded px-3 py-2 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-[#888] uppercase tracking-wider">Root</span>
        <select value={tonicPc}
          onChange={e => setTonicPc(Number(e.target.value))}
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
          {Array.from({ length: edo }, (_, i) => (
            <option key={i} value={i}>{formatHalfAccidentals(pcToNoteNameWithEnharmonic(i, edo) ?? "", edo)}</option>
          ))}
        </select>
        <div className="ml-auto"><NotationLegend /></div>
      </div>

      {/* ── Tuning-family EDO selector — Temperament-Explorer style.
          Three families now supported here, mirroring Tonal Audiation:
          Meantone (12 / 19 / 31), Pythagorean (41), Schismatic (53). ── */}
      <div className="bg-[#0e0e0e] border border-[#222] rounded p-3 space-y-2">
        <div className="text-[10px] text-[#888] uppercase tracking-wider">Tuning families</div>
        {([
          {
            name: "Meantone",
            tone: "#cfe6ff",
            range: "5th ≈ 696–702 ¢",
            blurb: "Syntonic comma vanishes; pure thirds emerge from stacks of slightly-flat fifths.  Standard Western functional harmony works without comma adjustments.",
            edos: [
              { n: 12, fifthCents: 700.0 },
              { n: 19, fifthCents: 694.74 },
              { n: 31, fifthCents: 696.77 },
            ],
          },
          {
            name: "Pythagorean",
            tone: "#e6cfa0",
            range: "5th ≈ 702 ¢",
            blurb: "Pure 3:2 fifths chain unhindered; thirds stack to the Pythagorean major-3rd 81/64.  41-EDO sits a hair sharp of pure Pythagorean and supports rich 7-/11-limit JI.",
            edos: [
              { n: 41, fifthCents: 702.44 },
            ],
          },
          {
            name: "Schismatic",
            tone: "#cfe6cf",
            range: "5th ≈ 702 ¢",
            blurb: "Schisma 32805/32768 vanishes; pure 5/4 thirds reach via 8 fifths down.  53-EDO is the canonical schismatic tuning, near-pure on 3-, 5-, and 7-limit ratios alike.",
            edos: [
              { n: 53, fifthCents: 701.89 },
            ],
          },
        ] as const).map(group => (
          <div key={group.name} className="border-l-2 border-[#2a2a4a] pl-2.5">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-xs font-semibold" style={{ color: group.tone }}>{group.name}</span>
              <span className="text-[10px] text-[#666] font-mono">{group.range}</span>
            </div>
            <div className="text-[10px] text-[#777] leading-snug mb-1.5">{group.blurb}</div>
            <div className="flex gap-1 flex-wrap">
              {group.edos.map(({ n, fifthCents }) => {
                const active = edo === n;
                return (
                  <button key={n}
                    onClick={() => window.dispatchEvent(new CustomEvent("app-set-edo", { detail: n }))}
                    title={`${n}-EDO · 5th = ${fifthCents.toFixed(2)} ¢`}
                    className={`px-2 py-0.5 text-[10px] rounded font-mono border transition-colors ${
                      active
                        ? "bg-[#7173e6] text-white border-[#7173e6]"
                        : "bg-[#1a1a1a] text-[#aaa] border-[#2a2a2a] hover:text-white hover:border-[#3a3a5a]"
                    }`}>
                    {n}
                    <span className="text-[8px] text-[#888] ml-1">{fifthCents.toFixed(1)}¢</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── Floating chord-analysis overlay — top-right when a chord
          is highlighted in the chord-pool below.  Shows per-interval
          info for ONLY the highlighted chord (not the whole scale):
          for each note, the cents from chord root, the closest JI
          ratio with its exact cents, the EDO-step approximation in
          this tuning, and the cents error of the EDO step from the
          ideal JI ratio.  Mirrors the EDO Temper interval table in
          Temperament Explorer. ── */}
      {selected && highlightedChordKey && view && (() => {
        // Resolve the highlighted chord.  highlightedChordKey is
        // shaped "<level>-<index>" (e.g. "Primary-0", "Diatonic-2"),
        // matching the bank-level grouping the picker renders.
        const [levelName, idxStr] = highlightedChordKey.split("-");
        const level = view.bank.levels.find(l => l.name === levelName);
        const idx = Number(idxStr);
        const entry = level?.chords[idx];
        if (!entry) return null;
        const steps = resolveChordSteps(entry.label, entry.steps);
        if (!steps || steps.length === 0) return null;

        // Build the per-interval rows.  Convert each step to cents
        // from the chord root (steps[0]), find the closest entry in
        // the JI catalog, compute the EDO-step error.
        const stepCents = 1200 / edo;
        type Row = {
          position: string;       // root / 3rd / 5th / etc.
          stepFromRoot: number;   // EDO-step distance from chord root
          edoCents: number;       // cents of the EDO step
          jiRatio: string;        // closest known JI ratio
          jiCents: number;        // exact cents of that JI ratio
          jiName: string;         // human-readable name (Just M3 etc.)
          jiKind: string;         // pure-3 / pure-5 / pure-7 / pure-11 / wolf
          errorCents: number;     // edoCents - jiCents
        };
        const POS_NAMES = ["Root", "3rd", "5th", "7th", "9th", "11th", "13th"];
        const rootStep = steps[0];
        const rows: Row[] = steps.map((s, i) => {
          const stepFromRoot = ((s - rootStep) % edo + edo) % edo;
          const edoCents = stepFromRoot * stepCents;
          // Find the JI interval with smallest cents distance
          // (octave-reduce both before comparing).
          const target = ((edoCents % 1200) + 1200) % 1200;
          let best = KNOWN_INTERVALS[0];
          let bestErr = Infinity;
          for (const iv of KNOWN_INTERVALS) {
            const ivc = ((iv.cents % 1200) + 1200) % 1200;
            const e = Math.abs(ivc - target);
            const wrapped = Math.min(e, 1200 - e);
            if (wrapped < bestErr) { bestErr = wrapped; best = iv; }
          }
          return {
            position: POS_NAMES[i] ?? `Tone ${i + 1}`,
            stepFromRoot,
            edoCents,
            jiRatio: best.ratio,
            jiCents: best.cents,
            jiName: best.name,
            jiKind: best.kind,
            errorCents: edoCents - best.cents,
          };
        });

        const tagColor = (k: string) => {
          if (k === "wolf") return "#cc6a8a";
          if (k === "pure-3") return "#9999cc";
          if (k === "pure-5") return "#6acca0";
          if (k === "pure-7") return "#cc8855";
          if (k === "pure-11") return "#9a66c0";
          return "#888";
        };
        const errColor = (e: number) => {
          const a = Math.abs(e);
          if (a < 3) return "#5cca8a";
          if (a < 8) return "#c8aa50";
          return "#cc6a8a";
        };

        return (
          <FloatingPanel
            position="top-right"
            title={`CHORD: ${entry.label} · ${selected}`}
            accent="#5b5be6"
            storageKey="lt_scalar_analysis_panel_collapsed"
          >
            <div className="grid grid-cols-[42px_60px_1fr_60px_50px] gap-x-2 gap-y-1 text-[10px] items-baseline">
              <span className="text-[#555] font-medium">Pos</span>
              <span className="text-[#555] font-medium">EDO</span>
              <span className="text-[#555] font-medium">JI</span>
              <span className="text-[#555] font-medium text-right">JI ¢</span>
              <span className="text-[#555] font-medium text-right">Err</span>
              {rows.map((r, i) => (
                <span key={i} style={{ display: "contents" }}>
                  <span className="text-[#aaa] font-mono">{r.position}</span>
                  <span className="text-[#aaa] font-mono">
                    {r.stepFromRoot}\{edo}
                    <span className="text-[#666] ml-1">({r.edoCents.toFixed(0)}¢)</span>
                  </span>
                  <span className="font-mono" style={{ color: tagColor(r.jiKind) }}>
                    {r.jiRatio}
                    <span className="text-[#666] ml-1 font-sans not-italic">{r.jiName}</span>
                  </span>
                  <span className="text-[#888] font-mono text-right">{r.jiCents.toFixed(1)}</span>
                  <span className="font-mono text-right font-semibold" style={{ color: errColor(r.errorCents) }}>
                    {r.errorCents >= 0 ? "+" : ""}{r.errorCents.toFixed(1)}¢
                  </span>
                </span>
              ))}
            </div>
            <p className="text-[9px] text-[#666] italic mt-2">
              Each row: the chord-tone's EDO step (cents in parens),
              closest just-intonation ratio + name, that ratio's exact
              cents, and the EDO step's error from it.  Green = close
              (&lt;3¢), amber = moderate, pink = poor or wolf.
            </p>
          </FloatingPanel>
        );
      })()}

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
              disabled={isPlayingSequence}
              title={isPlayingSequence ? "Already playing — wait for it to finish" : undefined}
              className="text-[11px] px-3 py-1 rounded border border-[#2a2a2a] bg-[#141414] text-[#aaa] hover:text-white hover:border-[#444] disabled:opacity-50 disabled:cursor-not-allowed">
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
              or Microtonal (IPA interval-name system from cents).
              Heathwaite has no published syllable table for 19-EDO, so
              the option is hidden there and the kind is forced to
              microtonal. */}
          <div className="flex items-center gap-1 mb-1 flex-wrap">
            <span className="text-[10px] text-[#666] mr-1">SOLFEGE</span>
            {(["heathwaite", "microtonal"] as const)
              .filter(k => !(k === "heathwaite" && edo === 19))
              .map(k => {
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
                  {/* The syllable label itself is the TTS trigger —
                      click it to hear the syllable spoken (Web Speech
                      API).  stopPropagation prevents the parent button
                      from also firing the play-tone handler.  IPA shown
                      below for microtonal syllables as the canonical
                      pronunciation reference. */}
                  <span
                    role="button"
                    tabIndex={0}
                    onMouseDown={e => e.stopPropagation()}
                    onTouchStart={e => e.stopPropagation()}
                    onClick={e => {
                      e.stopPropagation();
                      e.preventDefault();
                      // Heathwaite syllables get their IPA from the
                      // heathwaiteIpa() lookup so "Do" reads as
                      // /doʊ/ (sung "doh") not /duː/ (English "do").
                      const ipa = solfegeKind === "microtonal"
                        ? microtonal.ipa
                        : heathwaiteIpa(labelText);
                      piperSpeak(labelText, ipa ? { ipa } : undefined);
                    }}
                    className="inline-block bg-white/5 border border-white/10 rounded px-2 py-0.5 text-base font-bold cursor-pointer hover:underline"
                    style={{ color: activeFamilyColor }}
                    title={`Hear "${labelText}"${solfegeKind === "microtonal" ? ` /${microtonal.ipa}/` : ""} spoken`}
                  >
                    {labelText}
                  </span>
                  {/* IPA reference moved to tooltip only (the /xxx/
                      display below the syllable was visual noise). */}
                  <span className="text-[10px] text-[#888] mt-0.5">
                    {formatHalfAccidentals(s.degree)}
                  </span>
                  {droning && (
                    <span className="text-[9px] text-[#5cca8a]">🔊 drone</span>
                  )}
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
                          onClick={() => { const s = resolveChordSteps(entry.label, entry.steps); if (s) playChord(s); }}
                          title={(() => {
                            const s = resolveChordSteps(entry.label, entry.steps);
                            return s ? `Play ${entry.label} — ${s.join(", ")}` : entry.label;
                          })()}
                          className="px-4 py-2.5 text-xl font-semibold rounded-l border-y border-l border-[#2a2a2a] bg-[#141414] text-[#bbb] hover:text-white hover:border-[#444] transition-colors">
                          {formatRomanNumeral(entry.label)}
                        </button>
                        <button
                          onClick={() => { const s = resolveChordSteps(entry.label, entry.steps); if (s) toggleChordHighlight(key, s); }}
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

      {/* ── Lower section: tonality picker + reverb + 3D mode lattice
          ────────────────────────────────────────────────────────────
          When lowerSectionPortalTarget is set, this whole block
          renders into that DOM node instead of inline.  App.tsx uses
          that to push the lower section OUTSIDE the sticky-visualizer
          wrapper, so the visualizer scrolls away once the user has
          passed the chord-highlight content above (per direct user
          direction 2026-05-05). */}
      {(() => {
        const lowerSection = (
          <div className="space-y-4">
            {/* Tonality picker (large buttons, single-select) — LIMIT >
                FAMILY > MODES hierarchy mirroring Spatial Audiation. */}
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

            {/* Reverb (dry/wet) — sits next to the 3D mode lattice
                because the wet send is most useful when previewing
                scale alterations on click. */}
            <div className="bg-[#0e0e0e] border border-[#222] rounded px-3 py-2 flex items-center gap-3">
              <span className="text-[10px] text-[#888] uppercase tracking-wider">Reverb</span>
              <span className="text-[10px] text-[#555]">Dry</span>
              <input
                type="range" min={0} max={1} step={0.01}
                value={reverbWet}
                onChange={e => setReverbWet(Number(e.target.value))}
                className="w-40 accent-[#7173e6]"
              />
              <span className="text-[10px] text-[#555]">Wet</span>
              <span className="text-[10px] text-[#666] font-mono w-10 text-right">{Math.round(reverbWet * 100)}%</span>
            </div>

            {/* 3D mode lattice — all 49 modes arranged by force-directed
                simulation in X-Z; Y locks to brightness so bright modes
                float and dark ones sink.  Click any mode to drone its
                scale on the user's root pitch. */}
            <ModeLattice3D
              edo={edo}
              rootPitch={baseTonic}
              tonicPc={tonicPc}
              anchorKey={anchorKey}
              playVol={playVol} />
          </div>
        );
        return lowerSectionPortalTarget
          ? createPortal(lowerSection, lowerSectionPortalTarget)
          : lowerSection;
      })()}
    </div>
  );
}
