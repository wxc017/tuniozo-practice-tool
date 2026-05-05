import { useState, useRef, useEffect, useMemo, useCallback, Fragment } from "react";
import { audioEngine } from "@/lib/audioEngine";
import { useLS, registerKnownOption, unregisterKnownOptionsForPrefix } from "@/lib/storage";
import type { TabSettingsSnapshot } from "@/App";
import { weightedRandomChoice } from "@/lib/stats";
import {
  LOOP_LENGTHS,
  getAllChordsForEdo, generateFunctionalLoop,
  triadQuality, intervalLabel, randomChoice, shuffle,
  ALL_VOICING_PATTERNS, VOICING_PATTERN_GROUPS, applyVoicingPattern,
  generateBassLine, generateMelodyLine,
  checkLowIntervalLimits, formatLilWarnings,
  type LilWarning,
} from "@/lib/musicTheory";
import {
  getExtLabelToSteps, getChordShapes, getEdoChordTypes, type EdoChordType,
  formatHalfAccidentals,
  getAvailableThirdQualities,
  getModeDegreeMap,
  getHeathwaiteSolfege,
  pcToNoteNameWithEnharmonic,
} from "@/lib/edoData";
import { syllableForEdoStep } from "@/lib/microtonalSolfege";
import { getTonalityBanks, getApproachChords, APPROACH_KINDS, APPROACH_LABELS, type TonalityBank, type ChordEntry, type ApproachKind } from "@/lib/tonalityBanks";
import { xenIntervalsForEdo, bankToScaleFamMode } from "@/lib/tonalityChordPool";
import { formatRomanNumeral, formatRomanNumeralWithFamily } from "@/lib/formatRoman";
import { JI_LIMIT_GROUPS, jiLimitGroupsForEdo, familyAbbreviationForTonality } from "@/lib/jiTonalityFamilies";
import { JI_SCALE_NAMES, getJiScaleCents, getJiScaleDegrees } from "@/lib/jiScaleData";
import { analyzeJiScale, COMMA_DRIFT_CATALOG } from "@/lib/jiChordAnalysis";
import { chordQualityFromSteps, voicingFor } from "@/lib/jiLattice";
import { limitForJiTonality } from "@/lib/jiTonalityFamilies";
import { tracePathDrifts, driftCentsToSteps, stripChordLabel, tracePath, latticeAdd, latticePosToRatio, latticeToEdoStep } from "@/lib/jiLattice";
import FloatingPanel from "@/components/FloatingPanel";
import JiScaleLattice from "@/components/JiScaleLattice";
import PianoKeyboard from "@/components/PianoKeyboard";
import GuitarFretboard from "@/components/GuitarFretboard";
import BassFretboard from "@/components/BassFretboard";
import LumatoneKeyboard from "@/components/LumatoneKeyboard";
import type { LayoutResult, ComputedKey } from "@/lib/lumatoneLayout";
import type { VisualizerType } from "@/App";
import { piperSpeak, piperPrewarm } from "@/lib/piperSpeech";
import { heathwaiteIpa } from "@/lib/solfegeSpeech";
import LatticeView from "@/components/LatticeView";

const JI_SCALE_NAMES_SET = new Set(JI_SCALE_NAMES);

// ── Inline TTS helper ────────────────────────────────────────────────────
// Speaks the supplied text via piper-wasm (neural TTS).  Falls back to
// the Web Speech API automatically inside piperSpeak if piper hasn't
// loaded or the model fetch fails.  stopPropagation on mousedown/click
// prevents the parent <button> (which plays the chord-tone pitch) from
// firing simultaneously.
function SaySpan({
  text, ipa, className, title,
}: { text: string; ipa: string | null; className?: string; title?: string }) {
  // Each syllable gets a small opaque box around it so it visually
  // separates from neighbouring labels in the chord-tone reveal.
  // The classNames passed in already control colour / size; the box
  // styling is added on top via background + border + padding.
  return (
    <span
      role="button"
      tabIndex={0}
      onMouseDown={e => e.stopPropagation()}
      onTouchStart={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation();
        e.preventDefault();
        piperSpeak(text, ipa ? { ipa } : undefined);
      }}
      title={title ?? `Hear "${text}"${ipa ? ` /${ipa}/` : ""} spoken`}
      className={`inline-block bg-white/5 border border-white/10 rounded px-1.5 py-[1px] my-[1px] ${className ?? ""}`}
    >
      {text}
    </span>
  );
}

interface SharedHighlightProps {
  highlightedPitches?: Set<number>;
  /** Active main-visualizer type, forwarded from App so the floating
   *  mini-visualizer can mirror whatever the user has selected at the
   *  top of the page. */
  vizType?: VisualizerType;
  /** Computed Lumatone layout when vizType === "lumatone".  Forwarded
   *  from App so the floating mini-visualizer can render Lumatone too. */
  layout?: LayoutResult | null;
  /** Click handler shared with the main visualizer so notes pressed on
   *  the floating mirror behave identically to the sticky one.  All
   *  on-screen visualizers (PianoKeyboard, GuitarFretboard,
   *  BassFretboard, LumatoneKeyboard) emit a `ComputedKey`-shaped
   *  payload so a single typed callback covers every viz. */
  onKeyClick?: (key: ComputedKey) => void;
}

interface Props extends SharedHighlightProps {
  tonicPc: number;
  lowestPitch: number;
  highestPitch: number;
  edo: number;
  onHighlight: (pcs: number[]) => void;
  responseMode: string;
  onResult: (text: string) => void;
  onPlay: (optionKey: string, label: string) => void;
  lastPlayed: React.MutableRefObject<{frames: number[][]; info: string} | null>;
  ensureAudio: () => Promise<void>;
  onShowOnKeyboard?: () => void;
  playVol?: number;
  layoutPitchRange?: { min: number; max: number };
  tabSettingsRef?: React.MutableRefObject<TabSettingsSnapshot | null>;
  answerButtons?: React.ReactNode;
  betaMode?: boolean;
}

const REGISTER_MODES = ["Fixed Register","Random Bass Octave","Random Full Register"];

// Tonality family taxonomy — mirrors the Mode Identification tab's
// Major / Harmonic Minor / Melodic Minor groups.  All seven modes of
// each parent scale are listed; tonalities not exposed by tonalityBanks
// for the current EDO are filtered out at render time.
interface TonalityFamilyGroup { key: string; label: string; color: string; tonalities: string[] }

const TONALITY_FAMILIES: TonalityFamilyGroup[] = [
  { key: "major",    label: "MAJOR",          color: "#6a9aca",
    tonalities: ["Major","Dorian","Phrygian","Lydian","Mixolydian","Aeolian","Locrian"] },
  { key: "harmonic", label: "HARMONIC MINOR", color: "#c09050",
    tonalities: ["Harmonic Minor","Locrian #6","Ionian #5","Dorian #4","Phrygian Dominant","Lydian #2","Ultralocrian"] },
  { key: "melodic",  label: "MELODIC MINOR",  color: "#c06090",
    tonalities: ["Melodic Minor","Dorian b2","Lydian Augmented","Lydian Dominant","Mixolydian b6","Locrian #2","Altered"] },
  // Septimal / neutral diatonic families (31-EDO).  Mode names use the
  // harmonic-minor / melodic-minor convention with single-letter
  // qualifiers (s = sub, m = min, N = neu, M = maj, S = sup, # = aug).
  { key: "subminor",   label: "SUBMINOR DIATONIC",   color: "#7aaa6a",
    tonalities: ["Subminor Diatonic","Locrian s2 s5 s6","Supermajor Ionian","Dorian s3 bb4 s7","Subminor Phrygian m7","Supermajor Lydian M2 b5","Supermajor Mixolydian ##5 m7"] },
  { key: "neutral",    label: "NEUTRAL DIATONIC",    color: "#9a66c0",
    tonalities: ["Neutral Diatonic","Dorian N2 bb5 N6","Neutral Ionian","Ionian N3 ##4 N7","Neutral Dorian m7","Neutral Ionian M2 ##4","Neutral Dorian bb5 m7"] },
  { key: "supermajor", label: "SUPERMAJOR DIATONIC", color: "#cc6a8a",
    tonalities: ["Supermajor Diatonic","Dorian S2 ##5 S6","Subminor Phrygian","Lydian S3 b5 S7","Supermajor Mixolydian m7","Subminor Aeolian M2 bb4","Subminor Locrian m7"] },
  { key: "subharmonic",label: "SUBHARMONIC DIATONIC M7",color: "#4a9ac7",
    tonalities: ["Subharmonic Diatonic M7","Locrian s2 s5 N6","Supermajor Ionian #5","Dorian s3 ##4 s7","Phrygian s2 N3 s6","Supermajor Lydian #2 b5","Neutral Dorian b4 bb5 bb7"] },
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

// JI temperaments (Pythagorean / Schismatic) get a separate family list
// derived from JI_LIMIT_GROUPS — one row per limit (3 / 5 / 7 / 11 …).
// Each row's tonalities are the flattened scales across that limit's
// sub-families (DIATONIC, HARMONIC MINOR, MAQAM, etc.).  Filtered per
// EDO via JI_LIMITS_PER_EDO so 53-EDO only shows the limits it
// approximates well.  (Kept for back-compat callers; the new picker
// render uses tonalitySectionsForEdo below for the LIMIT > FAMILY >
// MODES hierarchy.)
function tonalityFamiliesForEdo(edo: number): TonalityFamilyGroup[] {
  if (edo === 41 || edo === 53) {
    return jiLimitGroupsForEdo(edo).map(g => ({
      key: `limit-${g.limit}`,
      label: g.label,
      color: g.color,
      tonalities: g.families.flatMap(f => f.tonalities),
    }));
  }
  return TONALITY_FAMILIES;
}

// ── LIMIT > FAMILY > MODES sectioning for the picker ─────────────────────
// The picker renders three nested levels.  Each section is one LIMIT
// (5-LIMIT, 7-LIMIT, etc.); inside each section the existing families
// (MAJOR / HARMONIC MINOR / DIATONIC / TERTIAN / MAQAM / etc.) keep
// their current sub-grouping; tonality buttons sit at the bottom level.
//
// For Meantone EDOs (12 / 19 / 31), we group the existing flat
// TONALITY_FAMILIES into limit sections by family key.  Xen-flavoured
// families (Subminor / Supermajor / Subharmonic / Neutral / Symmetric)
// only materialise in 31-EDO because they need 31's intervallic
// resolution; Symmetric appears in both 12 and 31.
//
// For JI EDOs (41 / 53), JI_LIMIT_GROUPS already carries the limit →
// family → tonalities structure, so the conversion is one-for-one.

interface TonalitySection {
  key: string;
  label: string;          // e.g. "5-LIMIT (MEANTONE)" or "PYTHAGOREAN"
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

// ── Per-EDO curated tonality lists ───────────────────────────────────────
// Per direct user direction (2026-05-05): each EDO gets a focused
// section list rather than the full prime-limit grouping.  Keys
// reference TONALITY_FAMILIES family keys; section labels use the
// "DIATONIC X" naming so all EDOs read with the same vocabulary even
// though the underlying scales come from different sources.

interface CuratedSection { key: string; label: string; color: string; familyKey: string }

const TWELVE_EDO_SECTIONS: CuratedSection[] = [
  { key: "12-major",      label: "DIATONIC MAJOR",                color: "#6a9aca", familyKey: "major" },
  { key: "12-harmonic",   label: "DIATONIC HARMONIC MINOR",       color: "#c09050", familyKey: "harmonic" },
  { key: "12-melodic",    label: "DIATONIC MELODIC MINOR",        color: "#c06090", familyKey: "melodic" },
  { key: "12-doubleh",    label: "DIATONIC DOUBLE HARMONIC MINOR", color: "#e08040", familyKey: "doubleharmonic" },
  { key: "12-sym",        label: "SYMMETRICAL",                   color: "#5ab9b0", familyKey: "symmetric" },
];

// 31-EDO drops Classic Major (a 41/53-only commatic distinction),
// adds Diatonic Harmonic Minor (was missing) and Diatonic Neutral
// (was missing).  The xen families (Subminor / Supermajor /
// Subharmonic) are 31-EDO-native via buildXenFamilyBanks.
const THIRTY_ONE_EDO_SECTIONS: CuratedSection[] = [
  { key: "31-major",      label: "DIATONIC MAJOR",                color: "#6a9aca", familyKey: "major" },
  { key: "31-harmonic",   label: "DIATONIC HARMONIC MINOR",       color: "#c09050", familyKey: "harmonic" },
  { key: "31-melodic",    label: "DIATONIC MELODIC MINOR",        color: "#c06090", familyKey: "melodic" },
  { key: "31-doubleh",    label: "DIATONIC DOUBLE HARMONIC MINOR", color: "#e08040", familyKey: "doubleharmonic" },
  { key: "31-subminor",   label: "DIATONIC SUBMINOR",             color: "#7aaa6a", familyKey: "subminor" },
  { key: "31-supermajor", label: "DIATONIC SUPERMAJOR",           color: "#cc6a8a", familyKey: "supermajor" },
  { key: "31-subharm",    label: "DIATONIC SUBHARMONIC MINOR M7", color: "#4a9ac7", familyKey: "subharmonic" },
  { key: "31-neutral",    label: "DIATONIC NEUTRAL",              color: "#9a66c0", familyKey: "neutral" },
  { key: "31-sym",        label: "SYMMETRICAL",                   color: "#5ab9b0", familyKey: "symmetric" },
];

const NINETEEN_EDO_SECTIONS: CuratedSection[] = [
  { key: "19-major",      label: "DIATONIC MAJOR",                color: "#6a9aca", familyKey: "major" },
  { key: "19-harmonic",   label: "DIATONIC HARMONIC MINOR",       color: "#c09050", familyKey: "harmonic" },
  { key: "19-melodic",    label: "DIATONIC MELODIC MINOR",        color: "#c06090", familyKey: "melodic" },
  { key: "19-doubleh",    label: "DIATONIC DOUBLE HARMONIC MINOR", color: "#e08040", familyKey: "doubleharmonic" },
  { key: "19-sym",        label: "SYMMETRICAL",                   color: "#5ab9b0", familyKey: "symmetric" },
];

function curatedSectionsToTonalitySections(curated: CuratedSection[]): TonalitySection[] {
  return curated
    .map(sec => {
      const fam = TONALITY_FAMILIES.find(f => f.key === sec.familyKey);
      if (!fam) return null;
      return {
        key: sec.key,
        label: sec.label,
        color: sec.color,
        families: [{ key: fam.key, label: "MODES", tonalities: fam.tonalities }],
      } as TonalitySection;
    })
    .filter((s): s is TonalitySection => s !== null);
}

function tonalitySectionsForEdo(edo: number): TonalitySection[] {
  if (edo === 41 || edo === 53) {
    return jiLimitGroupsForEdo(edo).map(g => ({
      key: `limit-${g.limit}`,
      label: g.label,
      color: g.color,
      families: g.families.map(f => ({ key: f.key, label: f.label, tonalities: f.tonalities })),
    }));
  }
  if (edo === 12) return curatedSectionsToTonalitySections(TWELVE_EDO_SECTIONS);
  if (edo === 31) return curatedSectionsToTonalitySections(THIRTY_ONE_EDO_SECTIONS);
  if (edo === 19) return curatedSectionsToTonalitySections(NINETEEN_EDO_SECTIONS);
  // Other EDOs fall back to the original prime-limit-grouped meantone layout.
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

// Standard third qualities are always shown in the 3RDS panel; xenharmonic
// thirds (subminor/neutral/supermajor/classic min/maj) move into a separate
// XEN section so the user can opt into microtonal chord types per-EDO
// without crowding the standard quality picker.
const STANDARD_THIRD_QUALITIES = new Set(["sus2", "min3", "maj3", "sus4"]);

export default function ChordsTab({
  tonicPc, lowestPitch, highestPitch, edo, onHighlight, responseMode, onResult, onPlay, lastPlayed, ensureAudio, playVol = 0.55, layoutPitchRange, tabSettingsRef, answerButtons, highlightedPitches, vizType, layout, onKeyClick, betaMode = false,
}: Props) {
  const frameTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ── Chord selection state ───────────────────────────────────────────
  // Per-tonality checked chord labels.  Each tonality gets its own pool
  // (Primary + Diatonic chords + per-target approach toggles).  At play
  // time we pick a random tonality from `tonalitySet` and use only that
  // tonality's pool.
  const [checkedByTonality, setCheckedByTonality] = useLS<Record<string, string[]>>(
    "lt_crd_checkedByTon",
    { Major: ["I","IV","V","ii","iii","vi","vii°"] },
  );
  // Back-compat: combined view used by global gates (canPlay, previews).
  // Derived below from `checkedByTonality` ∪ approach chords across all
  // active tonalities.
  const [regMode, setRegMode] = useLS<string>("lt_crd_regMode", "Fixed Register");
  // JI progression mode (only meaningful in 41/53 EDO).
  //   "frozen"   — scale's actual step values; wolves baked in on
  //                certain scale degrees, tonic stays put.
  //   "adaptive" — chord *shapes* stay at their EDO frozen tunings, but
  //                each chord's whole position drifts according to the
  //                accumulated lattice walk through the progression.
  //                The user hears the comma pump as a tonic that drifts,
  //                without each chord's interior being forced pure.
  // "pure5" (per-chord pure 3+5-limit retuning) was removed — both
  // remaining modes already convey the drift behaviour cleanly without
  // forcing-pure-ratios changing chord identities.  Stale localStorage
  // values reading "pure5" coerce to "adaptive".
  const [jiMode, setJiMode] = useLS<"frozen" | "adaptive">(
    "lt_crd_jiMode",
    "frozen",
  );
  useEffect(() => {
    if ((jiMode as string) === "pure5") setJiMode("adaptive");
  }, [jiMode, setJiMode]);
  const [extTendency, setExtTendency] = useLS<string>("lt_crd_extTend", "Any");
  // "7th" is intentionally excluded from the extension UI — the 7th is
  // already carried by seventh-chord voicing patterns (1 3 5 7, etc.).
  // Default is empty so nothing is added on top of the triad/7th voicing.
  const [checkedExts, setCheckedExts] = useLS<Set<string>>("lt_crd_exts", new Set());
  const [checkedExtCounts, setCheckedExtCounts] = useLS<Set<number>>("lt_crd_extCounts", new Set([0, 1]));
  const [checkedPatterns, setCheckedPatterns] = useLS<Set<string>>("lt_crd_vpatterns", new Set(["t-135"]));
  // Per-tonality, per-numeral xenharmonic chord-type opt-ins.  Each entry is
  // a list of xen 3rd-quality IDs (e.g. "neu3","sub3","sup3") that the user
  // wants to add to that numeral's chord pool. An empty list = play the
  // numeral's natural quality only. Inner key = numeral label, value = list.
  const [xenByTonality, setXenByTonality] = useLS<Record<string, Record<string, string[]>>>(
    "lt_crd_xenByTon", {});
  const toggleXenForNumeral = useCallback((tonality: string, numeral: string, xenId: string) => {
    setXenByTonality(prev => {
      const tonMap = prev[tonality] ?? {};
      const existing = tonMap[numeral] ?? [];
      const has = existing.includes(xenId);
      const next = has ? existing.filter(x => x !== xenId) : [...existing, xenId];
      const tonCopy = { ...tonMap };
      if (next.length === 0) delete tonCopy[numeral]; else tonCopy[numeral] = next;
      const copy = { ...prev };
      if (Object.keys(tonCopy).length === 0) delete copy[tonality]; else copy[tonality] = tonCopy;
      return copy;
    });
  }, [setXenByTonality]);
  // Combined qua/quin toggle: the per-chord card surfaces stacked-4ths and
  // stacked-5ths voicings as one button. "On" if either kind is enabled;
  // clicking removes both (mixed state collapses to off) or adds both.
  const toggleXenStackForNumeral = useCallback((tonality: string, numeral: string) => {
    setXenByTonality(prev => {
      const tonMap = prev[tonality] ?? {};
      const existing = tonMap[numeral] ?? [];
      const hasAny = existing.includes("qrt") || existing.includes("qnt");
      const next = hasAny
        ? existing.filter(x => x !== "qrt" && x !== "qnt")
        : [...existing, "qrt", "qnt"];
      const tonCopy = { ...tonMap };
      if (next.length === 0) delete tonCopy[numeral]; else tonCopy[numeral] = next;
      const copy = { ...prev };
      if (Object.keys(tonCopy).length === 0) delete copy[tonality]; else copy[tonality] = tonCopy;
      return copy;
    });
  }, [setXenByTonality]);

  // Tonality multi-select. The user picks one or more modes (boxes); at
  // play time a random one is chosen and only its pool drives the loop.
  const [tonalitySet, setTonalitySet] = useLS<Set<string>>("lt_crd_tonalities", new Set(["Major"]));
  const [collapsedLevels, setCollapsedLevels] = useState<Set<string>>(new Set());

  // Approach-chord toggles, scoped per tonality.  Outer key = tonality
  // name; inner key = target chord label; value = enabled approach kinds.
  const [approachesByTonality, setApproachesByTonality] = useLS<Record<string, Record<string, ApproachKind[]>>>(
    "lt_crd_approachesByTon", {});
  const toggleApproach = useCallback((tonality: string, target: string, kind: ApproachKind) => {
    setApproachesByTonality(prev => {
      const tonMap = prev[tonality] ?? {};
      const existing = tonMap[target] ?? [];
      const has = existing.includes(kind);
      const next = has ? existing.filter(k => k !== kind) : [...existing, kind];
      const tonCopy = { ...tonMap };
      if (next.length === 0) delete tonCopy[target]; else tonCopy[target] = next;
      const copy = { ...prev };
      if (Object.keys(tonCopy).length === 0) delete copy[tonality]; else copy[tonality] = tonCopy;
      return copy;
    });
  }, [setApproachesByTonality]);

  // Toggle membership in the tonality multi-select; auto-seeds primary
  // chords for newly added tonalities so they're playable out of the box.
  const toggleTonality = useCallback((name: string) => {
    setTonalitySet(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, [setTonalitySet]);

  // ── Progression state ──────────────────────────────────────────────
  const [loopLength, setLoopLength] = useLS<number>("lt_crd_fh_len", 4);
  const [loopGap, setLoopGap] = useLS<number>("lt_crd_fh_gap", 1.5);
  const [chordDur, setChordDur] = useLS<number>("lt_crd_fh_dur", 0.65);
  const [isLooping, setIsLooping] = useState(false);
  // Currently-playing tonality preview (the small ▶ button per scale).
  // Used to disable the same scale's ▶ while its preview run + 5 s
  // hold are still in flight, so the user can't stack multiple
  // overlapping playbacks of the same scale.  Other scales' buttons
  // remain clickable — clicking a different one will cancel the
  // previous via frameTimers + audioEngine.silencePlay.
  const [playingTonality, setPlayingTonality] = useState<string | null>(null);
  const playingTonalityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loopTimerId = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoopingRef = useRef(false);
  const [currentLoop, setCurrentLoop] = useState<string[] | null>(null);
  const [loopInfo, setLoopInfo] = useState<string>("");
  const [fhDetailInfo, setFhDetailInfo] = useState<string>("");
  const [fhShowAnswer, setFhShowAnswer] = useState(false);
  // Pre-warm piper TTS for the most common syllables on first
  // mount so the first user click on a syllable doesn't pay the
  // ~5–10 s cold-start cost (worker init + ONNX runtime fetch +
  // voice model fetch).  Fires fire-and-forget — the UI stays
  // usable while warming proceeds in the background, and unwarmed
  // syllables fall back to Web Speech instantly via piperSpeak.
  useEffect(() => {
    piperPrewarm(["Do", "Re", "Mi", "Fa", "Sol", "La", "Ti"]);
  }, []);
  // Index of the chord whose lattice node is currently lit during
  // playback.  Driven by the same chord-onset timer that
  // highlightAllVoices uses (see playLoopIteration) so the lattice
  // walk on screen is synchronized with what the user hears.  -1
  // means no chord is active right now.
  const [currentChordIdx, setCurrentChordIdx] = useState(-1);
  // The transition currently being previewed for voice-leading
  // arrows.  When set to N, the harmonic lattice flashes arrows
  // showing the voice motion from chord N → chord N+1.  Driven by
  // the playback scheduler (see playLoopIteration / highlightAllVoices)
  // so the arrows light up briefly *before* each chord onsets, giving
  // the user a split-second preview of the voice motion that's about
  // to happen.  null = no preview right now.
  const [voiceLeadTransitionIdx, setVoiceLeadTransitionIdx] = useState<number | null>(null);
  // Indices of progression chords the user has pinned via the
  // bottom-left toggle buttons on the harmonic lattice.  Each pinned
  // chord renders its own colour overlay on the lattice so the user
  // can compare two or more chords' EDO classes at a glance.
  const [pinnedChordIdxs, setPinnedChordIdxs] = useState<Set<number>>(new Set());
  // Structured answer data — drives the rebuilt Show Answer reveal
  // (clickable tones + Heathwaite + Microtonal solfege per note + a
  // floating lattice box at top showing the active scale's lattice).
  // fhDetailInfo (the legacy text representation) is kept around for
  // back-compat / debugging but no longer rendered.
  type FhAnswerChord = {
    index: number;
    numeral: string;
    quality: string;
    notes: number[];          // absolute pitches in playback order
    chordRootPc: number;      // pitch-class of the chord root
  };
  interface FhAnswer {
    progression: string[];
    chords: FhAnswerChord[];
    scaleTonality: string | null;   // first selected tonality (for the lattice box)
  }
  const [fhAnswer, setFhAnswer] = useState<FhAnswer | null>(null);
  const fhFramesRef = useRef<number[][] | null>(null);

  // ── Polyphonic Realization state ────────────────────────────────────
  type BassLineMode = "root" | "root-fifth" | "passing" | "walking";
  type MelodyMode = "chord-tone" | "scalar" | "arpeggiate";
  const [textureLayers, setTextureLayers] = useLS<Set<string>>("lt_crd_texture", new Set(["harmony"]));
  const [bassLineMode, setBassLineMode] = useLS<BassLineMode>("lt_crd_bass_line_mode", "root");
  const [melodyMode, setMelodyMode] = useLS<MelodyMode>("lt_crd_melody_mode", "chord-tone");
  const [harmonyVol, setHarmonyVol] = useLS<number>("lt_crd_vol_harmony", 0.7);
  const [bassVol, setBassVol] = useLS<number>("lt_crd_vol_bass", 0.55);
  const [melodyVol, setMelodyVol] = useLS<number>("lt_crd_vol_melody", 0.75);
  const [passingTones, setPassingTones] = useLS<boolean>("lt_crd_passing_tones", false);
  const fhVoicesRef = useRef<{ chords: number[][]; bass: number[][]; melody: number[][]; appliedShapes: (number[] | null)[] } | null>(null);
  // Capture the picked tonality's chord map / xen map / scale roots so
  // loop iterations after the first preserve them.  Without these refs
  // the setTimeout closure called buildLoopFrames(loop) with no override
  // args — meaning xenList=[] for every chord on iteration 2+, and
  // qrt/qnt toggles never fired again.
  const loopChordMapRef = useRef<Record<string, number[]> | null>(null);
  // Latest progression's lattice-drift trace.  Populated by buildLoopFrames
  // when Adaptive JI is on, so the drift indicator UI can read it back
  // without recomputing.  Stored as a ref instead of state to avoid a
  // re-render every loop iteration.
  const latticeDriftsRef = useRef<{ progression: string[]; drifts: number[] | null } | null>(null);
  // Re-render trigger so the drift indicator updates after each
  // buildLoopFrames call (refs alone don't trigger re-renders).
  const [latticeRevision, setLatticeRevision] = useState(0);

  // Pin-on-scroll state for the Play / Replay / Got-it row.  CSS
  // position:sticky was unreliable inside the chord tab's nested flex
  // layout (the rule worked for some scroll positions but not others
  // — likely a nested-flex-sticky interaction), so we drive pinning
  // explicitly via two IntersectionObserver sentinels: one just above
  // the button row that flips `pinPlayRow` true once it leaves the
  // viewport upward, and one just below the harmonic lattice that
  // flips it back false once that sentinel also leaves upward.  When
  // pinned, the row renders as position:fixed at top:0 and a matching
  // spacer keeps the surrounding layout from collapsing.
  const [pinPlayRow, setPinPlayRow] = useState(false);
  const playRowSentinelRef = useRef<HTMLDivElement | null>(null);
  const latticeEndSentinelRef = useRef<HTMLDivElement | null>(null);
  const playRowAboveRef = useRef(false);   // sentinel-before scrolled past
  const latticeAboveRef = useRef(false);   // sentinel-after scrolled past

  useEffect(() => {
    const before = playRowSentinelRef.current;
    const after = latticeEndSentinelRef.current;
    if (!before || !after) return;
    const recompute = () => {
      // Pin only when we've scrolled past the natural button row
      // position AND the harmonic lattice is still in flow above us.
      setPinPlayRow(playRowAboveRef.current && !latticeAboveRef.current);
    };
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          // boundingClientRect.top < 0 means the sentinel has scrolled
          // up past the viewport top.  isIntersecting === false alone
          // also fires when scrolled DOWN past the bottom, which
          // we don't care about — distinguish via boundingClientRect.
          const above = !e.isIntersecting && e.boundingClientRect.top < 0;
          if (e.target === before) playRowAboveRef.current = above;
          else if (e.target === after) latticeAboveRef.current = above;
        }
        recompute();
      },
      // rootMargin top:0 so the sentinel "leaves" precisely when its
      // top edge crosses the viewport top.
      { rootMargin: "0px 0px 0px 0px", threshold: [0, 1] },
    );
    obs.observe(before);
    obs.observe(after);
    return () => obs.disconnect();
  }, []);
  const loopXenMapRef = useRef<Record<string, string[]> | null>(null);
  const loopScaleRootsRef = useRef<number[] | null>(null);
  // Recency tracking for tonality picking — bias toward tonalities the
  // user hasn't seen lately so a multi-tonality pool actually rotates
  // instead of stochastically clumping on the same key.
  const tonalityPickCounter = useRef(0);
  const tonalityLastPickedAt = useRef<Map<string, number>>(new Map());

  useEffect(() => { isLoopingRef.current = isLooping; }, [isLooping]);

  // Clear progression / answer-reveal state when the EDO changes —
  // a Major progression generated in 12-EDO has no meaning in 41-EDO
  // (where "Major" isn't a registered tonality), so the answer panel
  // would otherwise persist scale names + chord pitches that don't
  // exist in the new system.  Also drop tonalities that don't have
  // a bank in the new EDO so the picker doesn't hold stale entries.
  useEffect(() => {
    setFhAnswer(null);
    setFhShowAnswer(false);
    setFhDetailInfo("");
    fhFramesRef.current = null;
    setPinnedChordIdxs(new Set());
    setTonalitySet(prev => {
      const stripJiNames = !(edo === 41 || edo === 53);
      const filtered = [...prev].filter(t => {
        // Drop tonalities that don't have a bank in the new EDO.
        if (!banksByName[t]) return false;
        // Defensive (per user direction 2026-05-05): when switching
        // to an EDO that isn't 41 or 53, also drop any tonality
        // whose name starts with "Diatonic " — those are JI scale
        // names registered only for 41 / 53 in jiScaleData.ts and
        // should never persist into other EDO pickers.  Without
        // this, a "Diatonic Major" picked in 41-EDO would remain
        // selected (and potentially listed) when the user flips to
        // 31-EDO.
        if (stripJiNames && t.startsWith("Diatonic ")) return false;
        return true;
      });
      if (filtered.length === prev.size) return prev;
      return new Set(filtered);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edo]);

  useEffect(() => {
    unregisterKnownOptionsForPrefix("crd:");
    const all = new Set<string>();
    for (const labels of Object.values(checkedByTonality)) for (const l of labels) all.add(l);
    all.forEach(rn => registerKnownOption(`crd:fh:${rn}`, `Chords: ${rn}`));
    return () => unregisterKnownOptionsForPrefix("crd:");
  }, [checkedByTonality]);

  // Publish settings snapshot for history panel
  useEffect(() => {
    if (!tabSettingsRef) return;
    const voicingLabels = ALL_VOICING_PATTERNS.filter(p => checkedPatterns.has(p.id)).map(p => p.label);
    const extLabels = Array.from(checkedExts);
    const extCountLabels = Array.from(checkedExtCounts).sort().map(String);
    const texLayerLabels = Array.from(textureLayers);
    const allRomans = new Set<string>();
    for (const labels of Object.values(checkedByTonality)) for (const l of labels) allRomans.add(l);
    const xenLabels: string[] = [];
    for (const [t, perRn] of Object.entries(xenByTonality)) {
      for (const [rn, ids] of Object.entries(perRn)) {
        if (ids.length > 0) xenLabels.push(`${t}/${rn}: ${ids.join(",")}`);
      }
    }

    tabSettingsRef.current = {
      title: "Progressions",
      groups: [
        { label: "Roman Numerals", items: Array.from(allRomans) },
        { label: "Ext Tendency", items: [extTendency] },
        { label: "Voicings", items: voicingLabels },
        { label: "Extensions", items: extLabels.length ? extLabels : ["none"] },
        { label: "# Extensions", items: extCountLabels },
        { label: "Xen", items: xenLabels.length ? xenLabels : ["none"] },
        { label: "Settings", items: [
          `Loop: ${loopLength}`,
          `Spacing: ${loopGap}s`,
          `Duration: ${chordDur}s`,
          `Register: ${regMode}`,
          `Layers: ${texLayerLabels.join(", ") || "Harmony"}`,
          `Tonalities: ${Array.from(tonalitySet).join(", ") || "none"}`,
        ]},
      ],
    };
  }, [checkedByTonality, extTendency, checkedPatterns, checkedExts, checkedExtCounts,
      xenByTonality, loopLength, loopGap, chordDur, regMode, textureLayers, tonalitySet, edo, tabSettingsRef]);

  // Clamp notes to the keyboard's physical pitch range.
  // Avoids losing voices by deduplicating collapsed octaves.
  const clampToLayout = useCallback((notes: number[]): number[] => {
    if (!layoutPitchRange) return notes;
    const { min, max } = layoutPitchRange;
    const clamped: number[] = [];
    for (const n of notes) {
      let v = n;
      while (v < min) v += edo;
      while (v > max) v -= edo;
      // Always keep the note — never drop it even if it's outside the range
      if (v < min || v > max) v = n;
      clamped.push(v);
    }
    return clamped;
  }, [layoutPitchRange, edo]);

  const toggleSet = <T,>(set: Set<T>, val: T) => {
    const n = new Set(set);
    if (n.has(val)) n.delete(val); else n.add(val);
    return n;
  };

  // Build chord map: label → raw steps (relative to tonic root = 0)
  const allChords = getAllChordsForEdo(edo);
  const baseChordMap = Object.fromEntries(allChords.map(([n, s]) => [n, s]));

  // Toggle: when on, chord-pool Roman numerals expose the 7th-quality
  // suffix (e.g. "iii (s3 s7)"); when off, only the 3rd-quality suffix
  // shows ("iii (s3)").  Default is off — the chord shape always
  // includes the 7th note, but the label stays compact.
  const [showSevenths, setShowSevenths] = useLS<boolean>("lt_crd_show_sevenths", false);

  // Tonality banks (one per mode) — Magic Mode is excluded from the new
  // multi-select picker; the family-grouped boxes only show real modes.
  const tonalityBanks = useMemo(() => getTonalityBanks(edo, showSevenths), [edo, showSevenths]);
  const banksByName = useMemo(() => {
    const map: Record<string, TonalityBank> = {};
    for (const b of tonalityBanks) map[b.name] = b;
    return map;
  }, [tonalityBanks]);

  // ── Per-tonality builders ────────────────────────────────────────────
  // For a tonality T, return the (target → steps) map for its
  // Primary/Diatonic levels. Used both to evaluate approach toggles and
  // to render the per-tonality chord cards.
  const buildPrimaryDiatonicTargets = useCallback((t: string): Map<string, number[]> => {
    const out = new Map<string, number[]>();
    const bank = banksByName[t];
    if (!bank) return out;
    for (const level of bank.levels) {
      if (level.name !== "Primary" && level.name !== "Diatonic") continue;
      for (const c of level.chords) {
        const steps = c.steps ?? baseChordMap[c.label];
        if (steps) out.set(c.label, steps);
      }
    }
    return out;
  }, [banksByName, baseChordMap]);

  // Approach chord entries for a single tonality.
  // ii-V's V/X part is owned by the V/ (secdom) toggle — drop it here so
  // the V only appears in the pool when V/ is also enabled separately.
  const buildApproachEntriesForTonality = useCallback((t: string): ChordEntry[] => {
    const targets = buildPrimaryDiatonicTargets(t);
    const approaches = approachesByTonality[t] ?? {};
    const out: ChordEntry[] = [];
    const seen = new Set<string>();
    for (const [target, kinds] of Object.entries(approaches)) {
      const steps = targets.get(target);
      if (!steps) continue;
      for (const kind of kinds) {
        for (const e of getApproachChords(target, steps, kind, edo)) {
          if (kind === "iiV" && e.label.startsWith("V/")) continue;
          if (seen.has(e.label)) continue;
          seen.add(e.label);
          out.push(e);
        }
      }
    }
    return out;
  }, [approachesByTonality, buildPrimaryDiatonicTargets, edo]);

  // Full chord-shape map for a single tonality (base + bank + approaches).
  const buildChordMapForTonality = useCallback((t: string): Record<string, number[]> => {
    const map: Record<string, number[]> = { ...baseChordMap };
    const bank = banksByName[t];
    if (bank) {
      for (const level of bank.levels) {
        for (const entry of level.chords) {
          if (entry.steps && !map[entry.label]) map[entry.label] = entry.steps;
        }
      }
    }
    for (const e of buildApproachEntriesForTonality(t)) {
      if (e.steps && !map[e.label]) map[e.label] = e.steps;
    }
    return map;
  }, [baseChordMap, banksByName, buildApproachEntriesForTonality]);

  // Pool of pitch-class roots (ascending) for a tonality's diatonic scale —
  // used by getCompatibleTypes to force the right diatonic 7th.
  const buildDiatonicScaleRootsForTonality = useCallback((t: string): number[] | null => {
    const bank = banksByName[t];
    if (!bank) return null;
    const map = buildChordMapForTonality(t);
    const roots = new Set<number>();
    for (const level of bank.levels) {
      if (level.name !== "Primary" && level.name !== "Diatonic") continue;
      for (const c of level.chords) {
        const steps = c.steps ?? map[c.label];
        if (steps && steps.length > 0) roots.add(((steps[0] % edo) + edo) % edo);
      }
    }
    if (roots.size !== 7) return null;
    return Array.from(roots).sort((a, b) => a - b);
  }, [banksByName, buildChordMapForTonality, edo]);

  // Effective pool labels for one tonality: checked chords ∪ approach
  // chord labels generated from approachesByTonality[t].
  const buildEffectiveCheckedForTonality = useCallback((t: string): Set<string> => {
    const s = new Set(checkedByTonality[t] ?? []);
    for (const e of buildApproachEntriesForTonality(t)) s.add(e.label);
    return s;
  }, [checkedByTonality, buildApproachEntriesForTonality]);

  // ── Global (union) memos ─────────────────────────────────────────────
  // Used by canPlay gates, LilPreviewPanel, and the extension scale
  // builder where a single combined view across all active tonalities is
  // sufficient.

  // Union chord map. Labels with the same name share the same shape across
  // the bundled tonalities (verified by tonalityBanks conventions), so the
  // first hit wins and conflicts don't arise.
  const chordMap = useMemo(() => {
    const map: Record<string, number[]> = { ...baseChordMap };
    for (const t of tonalitySet) {
      const tMap = buildChordMapForTonality(t);
      for (const [k, v] of Object.entries(tMap)) {
        if (!map[k]) map[k] = v;
      }
    }
    // Frozen and Adaptive both keep chord interiors at their frozen
    // EDO tuning — Adaptive only differs by applying the chord-by-
    // chord lattice drift offset later in buildLoopFrames.  No
    // per-chord pure-ratio retuning happens in either mode.
    return map;
  }, [baseChordMap, tonalitySet, buildChordMapForTonality, jiMode, edo]);

  const effectiveChecked = useMemo(() => {
    const s = new Set<string>();
    for (const t of tonalitySet) for (const l of buildEffectiveCheckedForTonality(t)) s.add(l);
    return s;
  }, [tonalitySet, buildEffectiveCheckedForTonality]);

  // Combined approach labels across all active tonalities — passed as the
  // boost set to generateFunctionalLoop. (Only relevant inside
  // startFunctionalLoop after a single tonality has been chosen, but a
  // union is still valid since approach labels are tonality-specific.)
  const approachLabels = useMemo(() => {
    const s = new Set<string>();
    for (const t of tonalitySet) for (const e of buildApproachEntriesForTonality(t)) s.add(e.label);
    return s;
  }, [tonalitySet, buildApproachEntriesForTonality]);

  // Filter chords by whether their type matches the checked chord types
  const edoChordTypes = useMemo(() => getEdoChordTypes(edo), [edo]);

  // Default diatonic scale roots — derived from the *first* active
  // tonality (deterministic for stability of the canPlay gate).  Loops
  // pass per-tonality scale roots through voiceChord at play time.
  const diatonicScaleRoots = useMemo<number[] | null>(() => {
    const first = Array.from(tonalitySet)[0];
    if (!first) return null;
    return buildDiatonicScaleRootsForTonality(first);
  }, [tonalitySet, buildDiatonicScaleRootsForTonality]);

  // Get the pool of chord types compatible with a roman numeral's shape.
  // The natural type — whose intervals match the numeral's shape exactly — is
  // always in the pool. The user opts into xenharmonic types per-numeral via
  // `xenList` (an array of xen 3rd-quality IDs); each toggled quality adds
  // every catalog chord type with that 3rd, in the same triad/seventh
  // category as the numeral, with the numeral's 5th.
  const getCompatibleTypes = useCallback((shape: number[], xenList: string[] = []): EdoChordType[] => {
    const root = shape[0];
    const rels = shape.map(s => ((s - root) % edo + edo) % edo).sort((a, b) => a - b);
    const numeralThird   = rels.length >= 2 ? rels[1] : -1;
    const numeralFifth   = rels.length >= 3 ? rels[2] : null;
    const numeralSeventh = rels.length >= 4 ? rels[3] : null;
    const numeralIsSeventh = numeralSeventh !== null;
    const xenSet = new Set(xenList);

    return edoChordTypes.filter(t => {
      const tIsSeventh = t.category === "seventh";
      if (tIsSeventh !== numeralIsSeventh) return false;

      const tFifth = t.steps.length >= 3 ? t.steps[2] : null;
      if (numeralFifth !== null && tFifth !== null && tFifth !== numeralFifth) return false;

      const naturalMatch = t.third === numeralThird;
      const xenMatch = !!t.thirdQuality && xenSet.has(t.thirdQuality);
      if (!naturalMatch && !xenMatch) return false;

      // Natural-3rd match for a 7th numeral must also match the 7th interval
      // (e.g. I7 in major → only Imaj7, not also Idom7).
      if (numeralIsSeventh && naturalMatch && !xenMatch && t.steps[3] !== numeralSeventh) return false;

      return true;
    });
  }, [edo, edoChordTypes]);

  // Build a chord shape by applying a chord type's intervals to a roman numeral's root
  const applyChordType = useCallback((shape: number[], type: EdoChordType): number[] => {
    const root = shape[0];
    return type.steps.map(s => root + s);
  }, []);

  // Check if any chord type is compatible (for filtering the roman numeral pool)
  const chordMatchesType = useCallback((shape: number[]): boolean => {
    return getCompatibleTypes(shape).length > 0;
  }, [getCompatibleTypes]);

  // Roman numerals that actually have a compatible natural chord type.
  // With per-numeral xen toggles the gate rarely closes — every numeral whose
  // shape exists in the catalog passes — but we keep this so unsupported
  // shapes still produce a clear "couldn't voice" message.
  const playablePool = useMemo(() => {
    return Array.from(effectiveChecked).filter(rn => {
      const shape = chordMap[rn];
      return shape ? chordMatchesType(shape) : false;
    });
  }, [effectiveChecked, chordMap, chordMatchesType]);

  const hasPlayableVoicing = useMemo(() => {
    return ALL_VOICING_PATTERNS.some(p => checkedPatterns.has(p.id));
  }, [checkedPatterns]);

  const canPlay = playablePool.length > 0 && hasPlayableVoicing;
  const disabledReason =
    playablePool.length === 0
      ? "No suitable chord pool — loosen 3rd/5th/7th or switch tier."
      : !hasPlayableVoicing
        ? "No triad voicing selected — pick a 3-note voicing or enable at least one 7th."
        : null;

  // Seed primary chords for any newly-added tonality. Without this a
  // freshly toggled mode would have an empty pool and refuse to play.
  useEffect(() => {
    setCheckedByTonality(prev => {
      let changed = false;
      const next = { ...prev };
      for (const t of tonalitySet) {
        if (next[t]) continue;
        const bank = banksByName[t];
        const primary = bank?.levels[0];
        if (primary) {
          next[t] = primary.chords.map(c => c.label);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tonalitySet, banksByName, setCheckedByTonality]);

  // ── Shared voicing pipeline ─────────────────────────────────────────

  // Derive the set of valid note counts from the selected voicing patterns.
  // Stack patterns (Quartal / Quintal) advertise a fixed note count via
  // `stack.n`; chord-tone patterns use [minNotes, maxNotes].
  const patternNoteCounts = useMemo(() => {
    const counts = new Set<number>();
    for (const p of ALL_VOICING_PATTERNS) {
      if (!checkedPatterns.has(p.id)) continue;
      if (p.stack) { counts.add(p.stack.n); continue; }
      const lo = p.minNotes;
      const hi = p.maxNotes ?? 7;
      for (let n = lo; n <= hi; n++) counts.add(n);
    }
    return counts;
  }, [checkedPatterns]);

  const voiceChord = useCallback((rn: string, stepsOverride: number[] | null, currentChordMap: Record<string, number[]>, prevChord: number[] | null = null, xenList: string[] = [], scaleRootsOverride?: number[] | null) => {
    // No voicing patterns selected → nothing to play
    if (patternNoteCounts.size === 0) return null;

    let shape = stepsOverride ?? currentChordMap[rn];
    if (!shape) return null;

    const validCounts = Array.from(patternNoteCounts);
    if (validCounts.length === 0) return null;
    const targetNotes = randomChoice(validCounts);

    // Apply a random compatible chord type. The pool is the numeral's natural
    // type plus any per-numeral xen opt-ins; if the shape isn't in the
    // catalog at all, fall through with the raw shape.  Quartal (qrt) and
    // quintal (qnt) toggles aren't 3rd-quality alterations — they replace
    // the stack entirely — so they're added as separate shape variants
    // sized to match targetNotes (so 3-, 4-, and 5-note voicings each
    // get a properly-stacked quartal/quintal voicing instead of being
    // extended with a diatonic 7th that breaks the stack).
    const compatTypes = getCompatibleTypes(shape, xenList);
    const shapeVariants: { steps: number[]; kind: "natural" | "qrt" | "qnt" }[] =
      compatTypes.map(t => ({ steps: applyChordType(shape, t), kind: "natural" }));
    const sh2 = getChordShapes(edo);
    const rootShapeStep = shape[0];
    // Quartal / quintal voicings: closed stacks at the size the user's
    // voicing pattern asked for.  Each subsequent note sits a P4 (or P5)
    // above the previous, so 4-stack and 5-stack quartals naturally
    // ascend past the octave — Show Answer flags those notes with
    // "(+1 oct)" so the reader can see which scale degree was lifted.
    //   • 3-stack qrt  →  1, 4, b7
    //   • 4-stack qrt  →  1, 4, b7, b3(+1 oct)
    //   • 5-stack qrt  →  1, 4, b7, b3(+1 oct), b6(+1 oct)  (McCoy Tyner)
    //   • Top-third qrt (4/5 notes) → quartal stack capped with an M3
    //     above the highest 4th — "Maiden Voyage" / "So What" sonority
    //     (root + b3 + M3 produces the characteristic #9 compound).
    //   • Quintal mirrors the 3/4/5-stack pattern, P5s instead of P4s.
    const buildStack = (root: number, intervalSteps: number, n: number): number[] => {
      const out = [root];
      for (let k = 1; k < n; k++) out.push(root + k * intervalSteps);
      return out;
    };
    if (xenList.includes("qrt")) {
      const n = Math.max(3, Math.min(5, targetNotes));
      shapeVariants.push({ steps: buildStack(rootShapeStep, sh2.P4, n), kind: "qrt" });
      if (n >= 4) {
        const stack = buildStack(rootShapeStep, sh2.P4, n - 1);
        stack.push(stack[stack.length - 1] + sh2.M3);
        shapeVariants.push({ steps: stack, kind: "qrt" });
      }
    }
    if (xenList.includes("qnt")) {
      const n = Math.max(3, Math.min(5, targetNotes));
      shapeVariants.push({ steps: buildStack(rootShapeStep, sh2.P5, n), kind: "qnt" });
    }
    let shapeKind: "natural" | "qrt" | "qnt" = "natural";
    if (shapeVariants.length > 0) {
      const picked = randomChoice(shapeVariants);
      shape = picked.steps;
      shapeKind = picked.kind;
    }

    // For natural triads only: if the voicing pattern expects a 7th
    // (≥4 notes), auto-extend with the diatonic 7th of the round's
    // tonality (so I7 voices as Imaj7 in C major, not Idom7).  Quartal
    // and quintal variants are already sized to targetNotes; they skip
    // both this extension and the upper-extension fill below.
    const isXenStack = shapeKind === "qrt" || shapeKind === "qnt";
    if (!isXenStack && targetNotes >= 4 && shape.length === 3) {
      const scaleRoots = scaleRootsOverride !== undefined ? scaleRootsOverride : diatonicScaleRoots;
      const rootPc = ((shape[0] % edo) + edo) % edo;
      let seventhInterval: number | null = null;
      if (scaleRoots) {
        const idx = scaleRoots.indexOf(rootPc);
        if (idx >= 0) {
          const seventhRootPc = scaleRoots[(idx + 6) % scaleRoots.length];
          seventhInterval = ((seventhRootPc - rootPc) % edo + edo) % edo;
        }
      }
      if (seventhInterval === null) {
        seventhInterval = getChordShapes(edo).m7;
      }
      shape = [...shape, shape[0] + seventhInterval];
    }

    const k_ext = Math.max(0, targetNotes - shape.length);

    const scalePcs = new Set<number>();
    const checkedRomans = Array.from(effectiveChecked).filter(r => currentChordMap[r]);
    for (const rn2 of checkedRomans) {
      for (const s of currentChordMap[rn2] ?? []) scalePcs.add(((s % edo) + edo) % edo);
    }

    const rootStep = shape[0];

    // Pick a "reference" tonic-aligned anchor pitch within the user's range
    // to build the chord content (extension picking uses absolute-pitch
    // dedup, so we need a concrete absolute root for that step).
    const tonicAnchors: number[] = [];
    for (let p = lowestPitch + (((tonicPc - lowestPitch) % edo) + edo) % edo; p <= highestPitch; p += edo) {
      tonicAnchors.push(p);
    }
    const refTonic = tonicAnchors.length
      ? tonicAnchors[Math.floor(Math.random() * tonicAnchors.length)]
      : lowestPitch;
    const refRootAbs = refTonic + rootStep;
    let chordAbsRef = shape.map(s => refRootAbs + (s - rootStep));

    // Find the matching chord type for per-type stable/avoid filtering
    const chordRels = shape.map(s => ((s - rootStep) % edo + edo) % edo).sort((a, b) => a - b);
    const matchedType = edoChordTypes.find(t => {
      const tKey = t.steps.join(",");
      return chordRels.join(",") === tKey || chordRels.join(",").startsWith(tKey + ",");
    });

    const buildExtPool = (strict: boolean): number[] => {
      const pool: number[] = [];
      for (const lbl of checkedExts) {
        // 7th is carried by seventh-chord voicings, not as a generic ext.
        if (lbl === "7th") continue;
        for (const s of getExtLabelToSteps(edo)[lbl] ?? []) {
          if (strict && matchedType && (matchedType.stable.length > 0 || matchedType.avoid.length > 0)) {
            const relPc = ((s) % edo + edo) % edo;
            if (extTendency === "Stable" && !matchedType.stable.includes(relPc)) continue;
            if (extTendency === "Avoid"  && !matchedType.avoid.includes(relPc)) continue;
          } else if (strict) {
            const pc = ((rootStep + s) % edo + edo) % edo;
            if (extTendency === "Stable" && !scalePcs.has(pc)) continue;
            if (extTendency === "Avoid"  &&  scalePcs.has(pc)) continue;
          }
          pool.push(s);
        }
      }
      return pool;
    };
    let extStepPool = buildExtPool(true);
    if (extStepPool.length === 0 && extTendency !== "Any") extStepPool = buildExtPool(false);

    // Split extensions: lower (2/4/6 — within the first octave) fill
    // voicing-pattern slots like any other chord tone; upper (9/11/13
    // and their alterations — steps ≥ edo) always sit on top of the
    // voicing so they read as real compound extensions.
    const lowerExtSteps = extStepPool.filter(s => s < edo);
    const upperExtSteps = extStepPool.filter(s => s >= edo);

    if (k_ext > 0 && lowerExtSteps.length > 0) {
      const existing = new Set(chordAbsRef);
      const candidates = lowerExtSteps.map(s => refRootAbs + s).filter(n => !existing.has(n));
      shuffle(candidates);
      chordAbsRef = [...chordAbsRef, ...candidates.slice(0, k_ext)].sort((a, b) => a - b);
    }

    if (chordAbsRef.length > targetNotes) {
      chordAbsRef = chordAbsRef.slice(0, targetNotes);
    }

    // Pick the set of upper extensions to stack on top — count comes from
    // # EXTENSIONS (checkedExtCounts), capped by how many upper qualities
    // the user checked. If #EXTENSIONS has no value ≥1, no upper ext plays.
    const extCountOpts = Array.from(checkedExtCounts).filter(n => n > 0);
    const kUpper = extCountOpts.length > 0
      ? Math.min(randomChoice(extCountOpts), upperExtSteps.length)
      : 0;
    const upperExtStepsPicked = kUpper > 0
      ? shuffle([...upperExtSteps]).slice(0, kUpper)
      : [];

    // Must match a selected voicing pattern — no fallback
    const nNotes = chordAbsRef.length;
    const compatPatterns = ALL_VOICING_PATTERNS.filter(p =>
      checkedPatterns.has(p.id) && nNotes >= p.minNotes && (!p.maxNotes || nNotes <= p.maxNotes)
    );
    if (compatPatterns.length === 0) return null;

    // Capture chord content as steps relative to the reference root, so we
    // can re-realize it at any candidate root pitch during voice-leading search.
    const relSteps = chordAbsRef.map(n => n - refRootAbs);
    const buildVoicing = (rootAbs: number, pattern: typeof ALL_VOICING_PATTERNS[number]): number[] => {
      const content = relSteps.map(s => rootAbs + s).sort((a, b) => a - b);
      const voiced = applyVoicingPattern(content, edo, pattern);
      // Stack upper extensions above the voicing's current top, each one
      // octave-shifted up as needed so 9/11/13 always sit higher than the
      // chord's 1/3/5/7 — regardless of the pattern (including inversions).
      if (upperExtStepsPicked.length > 0) {
        const sortedExts = [...upperExtStepsPicked].sort((a, b) => a - b);
        for (const extStep of sortedExts) {
          let note = rootAbs + extStep;
          const top = voiced.length > 0 ? Math.max(...voiced) : rootAbs;
          while (note <= top) note += edo;
          voiced.push(note);
        }
      }
      return clampToLayout(voiced);
    };

    // Bass gate: the LOWEST note of the realized voicing must sit inside
    // the exercise range [lowestPitch, highestPitch]. Inversions can push
    // the root above the bass, so we gate on the bass — not the root —
    // to keep the whole chord anchored in the user's window.
    const bassInRange = (voicing: number[]): boolean => {
      if (voicing.length === 0) return false;
      const low = Math.min(...voicing);
      return low >= lowestPitch && low <= highestPitch;
    };
    // How far the bass sits outside the range (0 = in range). Used as a
    // fallback tiebreaker when no candidate has its bass inside the window.
    const bassOffset = (voicing: number[]): number => {
      if (voicing.length === 0) return Infinity;
      const low = Math.min(...voicing);
      if (low < lowestPitch) return lowestPitch - low;
      if (low > highestPitch) return low - highestPitch;
      return 0;
    };

    // Enumerate every (root-pitch, pattern) candidate over a window wider
    // than the exercise range, since inversion patterns can shift the
    // realized bass up or down from its content-root pitch.  Roots are
    // sampled on the chord's pc cycle (rootStep above each tonic-aligned
    // pitch) — one root per edo step in the search window.
    const searchLo = lowestPitch - 2 * edo;
    const searchHi = highestPitch + 2 * edo;
    const firstRoot = searchLo + (((tonicPc + rootStep - searchLo) % edo) + edo) % edo;
    const allCandidates: number[][] = [];
    for (let rootAbs = firstRoot; rootAbs <= searchHi; rootAbs += edo) {
      for (const pat of compatPatterns) {
        const cand = buildVoicing(rootAbs, pat);
        if (cand.length > 0) allCandidates.push(cand);
      }
    }

    let chordAbs: number[];
    if (prevChord && prevChord.length > 0) {
      // Voice-leading by minimum total movement: for every candidate
      // measure how far each of its notes is from the nearest note in the
      // previous chord and sum. Walk candidates from nearest to farthest
      // and pick the first whose bass is in range — that's "nearest
      // voicing whose lowest note fits the exercise range".
      const distToPrev = (cand: number[]): number => {
        let total = 0;
        for (const n of cand) {
          let min = Infinity;
          for (const p of prevChord) {
            const d = Math.abs(n - p);
            if (d < min) min = d;
          }
          total += min;
        }
        return total;
      };
      const scored = allCandidates
        .map(v => ({ voicing: v, dist: distToPrev(v), offset: bassOffset(v) }))
        .sort((a, b) => a.dist - b.dist);
      const inRange = scored.filter(s => s.offset === 0);
      if (inRange.length > 0) {
        // Among candidates tied at the minimum in-range distance, pick one
        // at random so loops don't lock onto the same exact voicing.
        const minDist = inRange[0].dist;
        const best = inRange.filter(s => s.dist === minDist);
        chordAbs = randomChoice(best).voicing;
      } else if (scored.length > 0) {
        // No in-range candidate: pick the one whose bass is closest to
        // the range, tiebroken by voice-leading distance.
        const byOffset = [...scored].sort((a, b) => a.offset - b.offset || a.dist - b.dist);
        chordAbs = byOffset[0].voicing;
      } else {
        chordAbs = buildVoicing(refRootAbs, randomChoice(compatPatterns));
      }
    } else {
      // First chord: random pick among voicings whose bass is in range.
      // If none exist, fall back to the candidate whose bass is closest
      // to the range.
      const inRange = allCandidates.filter(bassInRange);
      if (inRange.length > 0) {
        chordAbs = randomChoice(inRange);
      } else if (allCandidates.length > 0) {
        const byOffset = [...allCandidates].sort((a, b) => bassOffset(a) - bassOffset(b));
        chordAbs = byOffset[0];
      } else {
        chordAbs = buildVoicing(refRootAbs, randomChoice(compatPatterns));
      }
    }

    return { chordAbs, voicingType: "pattern", quality: triadQuality(shape, edo), appliedShape: [...shape] };
  }, [checkedPatterns, patternNoteCounts, effectiveChecked, checkedExts, checkedExtCounts, extTendency, regMode, edo, tonicPc, lowestPitch, highestPitch, clampToLayout, getCompatibleTypes, applyChordType, edoChordTypes, diatonicScaleRoots]);

  // ── Progressions: loop engine ───────────────────────────────────────

  const stopLoop = useCallback(() => {
    if (loopTimerId.current !== null) {
      clearTimeout(loopTimerId.current);
      loopTimerId.current = null;
    }
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    isLoopingRef.current = false;
    setIsLooping(false);
    audioEngine.silencePlay();
  }, []);

  const buildLoopFrames = useCallback((progression: string[], chordMapOverride?: Record<string, number[]>, xenForNumeral?: Record<string, string[]>, scaleRootsOverride?: number[] | null): { chords: number[][]; bass: number[][]; melody: number[][]; appliedShapes: (number[] | null)[] } => {
    const useMap = chordMapOverride ?? chordMap;
    const chords: number[][] = [];
    const appliedShapes: (number[] | null)[] = [];

    // Adaptive JI lattice: compute the cumulative comma drift for each
    // chord in the progression by tracing chord transitions on the
    // 5-limit (3-axis, 5-axis) prime lattice.  When the chain pumps
    // (e.g. I-vi-ii-V-I), each chord after the pump carries a syntonic-
    // comma offset that shifts its absolute pitch by a few cents — this
    // is the audible drift.  Frozen mode keeps drifts at 0.
    const useLattice = jiMode === "adaptive" && (edo === 41 || edo === 53);
    // Always compute drift cents for 41/53-EDO progressions so the
    // Live Lattice Trace surfaces the conceptual comma walk in both
    // Frozen and Adaptive modes — only the playback-side compensation
    // is gated on jiMode.  In Frozen mode the displayed drift is
    // what *would* happen on a pure-intervals walk; in Adaptive mode
    // the playback subtracts that drift so the tonic stays anchored.
    const isJiEdo = edo === 41 || edo === 53;
    const driftsCents = isJiEdo ? tracePathDrifts(progression) : null;
    latticeDriftsRef.current = { progression, drifts: driftsCents };
    setLatticeRevision(v => v + 1);

    // Thread each chord's voicing into the next so voiceChord can run its
    // voice-leading checklist against the previous chord's actual pitches.
    let prevVoicing: number[] | null = null;
    for (let i = 0; i < progression.length; i++) {
      const rn = progression[i];
      const xenList = xenForNumeral?.[rn] ?? [];
      const result = voiceChord(rn, null, useMap, prevVoicing, xenList, scaleRootsOverride);
      let chordAbs = result ? result.chordAbs : [];
      // Adaptive JI mode: COMPENSATE for the cumulative comma drift
      // instead of letting it accumulate.  The drift is still computed
      // and surfaced in the Live Lattice Trace so the user can see how
      // far each chord *would* drift on a pure-intervals walk — but
      // the actual playback subtracts that offset so the tonic stays
      // anchored.  In 41/53-EDO the EDO step values are already pure
      // enough for the chord intervals (≤1¢ off 5-limit JI) that
      // anchoring the chord roots at their frozen positions gives
      // perceptually pure-sounding chords without the cadence pumping
      // the tonic out of tune.
      let shapeForRecord: number[] | null = result ? result.appliedShape : null;
      if (useLattice && driftsCents && chordAbs.length > 0) {
        const offsetSteps = driftCentsToSteps(driftsCents[i], edo);
        if (offsetSteps !== 0) {
          chordAbs = chordAbs.map(p => p - offsetSteps);
          // Apply the SAME compensation to the recorded chord shape so
          // downstream consumers (Show Answer chord cards, lattice
          // highlight, etc.) derive `chordRootPc` from the post-comp
          // root — otherwise `notes` and `appliedShape[0]` disagree by
          // exactly the comp-step count, and chord-relative interval
          // labels read as nonsense ("Minor 7th" instead of "Perfect
          // Unison" for the root, etc.).  This is the root-cause of
          // the "Do version is buggy" report from 2026-05-04.
          if (shapeForRecord) shapeForRecord = shapeForRecord.map(p => p - offsetSteps);
        }
      }
      chords.push(chordAbs);
      appliedShapes.push(shapeForRecord);
      if (chordAbs.length > 0) prevVoicing = chordAbs;
    }
    // Derive octave indices from the absolute-pitch range — generateBassLine
    // and generateMelodyLine still take octave indices internally.
    const midPitch = Math.floor((lowestPitch + highestPitch) / 2);
    const midOct = 4 + Math.floor((midPitch - tonicPc) / edo);
    const bassOct = midOct - 2;
    const highestChordOct = chords.length > 0
      ? Math.floor(Math.max(...chords.flat()) / edo) + 4
      : midOct + 1;
    const melOct = Math.max(midOct, highestChordOct);
    const validShapes = appliedShapes.filter((s): s is number[] => s !== null);
    const bass = generateBassLine(validShapes, edo, tonicPc, bassOct, bassLineMode);
    const melody = generateMelodyLine(validShapes, edo, tonicPc, melOct, melodyMode);

    // Clamp melody into the layout window and keep it above the chords.
    const layoutMax = layoutPitchRange?.max ?? Infinity;
    for (let i = 0; i < melody.length; i++) {
      melody[i] = clampToLayout(melody[i]);
      const subdivsMel = Math.max(1, Math.round(melody.length / chords.length));
      const chordIdxMel = Math.min(Math.floor(i / subdivsMel), chords.length - 1);
      if (melody[i].length === 0 && chords[chordIdxMel]?.length) {
        const topNote = Math.max(...chords[chordIdxMel]);
        melody[i] = [topNote + edo];
      }
      if (chords[chordIdxMel]?.length) {
        const highestChordNote = Math.max(...chords[chordIdxMel]);
        melody[i] = melody[i].map(n => {
          while (n <= highestChordNote) n += edo;
          while (n > layoutMax) n -= edo;
          return n;
        });
      }
    }

    // Ensure bass notes are always below the lowest chord note,
    // then clamp to layout floor (never go below the keyboard)
    const layoutMin = layoutPitchRange?.min ?? -Infinity;
    if (bass.length > 0 && chords.length > 0) {
      for (let i = 0; i < bass.length; i++) {
        const subdivs = Math.max(1, Math.round(bass.length / chords.length));
        const chordIdx = Math.min(Math.floor(i / subdivs), chords.length - 1);
        const lowestChordNote = Math.min(...chords[chordIdx]);
        bass[i] = bass[i].map(n => {
          while (n >= lowestChordNote) n -= edo;
          while (n < layoutMin) n += edo;
          return n;
        });
      }
    } else {
      for (let i = 0; i < bass.length; i++) bass[i] = clampToLayout(bass[i]);
    }

    if (passingTones && melody.length > 1) {
      const withPassing: number[][] = [];
      for (let i = 0; i < melody.length; i++) {
        withPassing.push(melody[i]);
        if (i < melody.length - 1 && melody[i].length > 0 && melody[i + 1].length > 0) {
          const from = melody[i][0];
          const to = melody[i + 1][0];
          const diff = to - from;
          if (Math.abs(diff) > 2 && Math.abs(diff) <= edo / 2) {
            const mid = Math.round((from + to) / 2);
            withPassing.push([mid]);
          }
        }
      }
      melody.length = 0;
      melody.push(...withPassing);
    }

    return { chords, bass, melody, appliedShapes };
  }, [voiceChord, chordMap, bassLineMode, melodyMode, edo, tonicPc, lowestPitch, highestPitch, clampToLayout, layoutPitchRange, passingTones, jiMode]);

  /** Play all active texture voices using the multi-voice scheduler.
   *  CHORD_BOOST compensates for the playMultiVoice 1/sqrt(noteCount)
   *  attenuation: with 4-note voicings, vol * harmonyVol gets divided by
   *  ~2, so a 0.55 * 0.7 input ends up around 0.19 — half of Mode ID's
   *  0.7 single-note default.  Multiply up so chord-mode hits a
   *  comparable loudness without changing the user-facing slider. */
  // Preview a tonality's parent scale: ascending 1-2-3-4-5-6-7-1' as
  // single notes, then a 5-second sustain of the whole scale highlighted
  // at once so the user can scan the shape on the visualizer.  Used by
  // the small ▶ button on each mode in the tonality picker.
  const previewTonalityScale = useCallback(async (tonality: string) => {
    await ensureAudio();
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    const [fam, mode] = bankToScaleFamMode(tonality);
    const map = getModeDegreeMap(edo, fam, mode);
    const steps = Object.values(map).sort((a, b) => a - b);
    if (steps.length === 0) return;
    const allSteps = [...steps, steps[0] + edo];   // append octave
    // Center the preview around the user's exercise range so it sits on
    // the visualizer.  Anchor on the lowest tonic ≥ lowestPitch.
    const baseTonic = lowestPitch + (((tonicPc - lowestPitch) % edo) + edo) % edo;
    const frames = allSteps.map(s => [baseTonic + s]);
    const noteDur = 0.55;
    const gapMs = 500;
    const HOLD_MS = 5000;   // full-scale highlight after the sequence
    audioEngine.playMultiVoice(
      [{ frames, noteDuration: noteDur, gain: playVol * harmonyVol * 1.6 }],
      edo, gapMs, frames.length
    );
    for (let i = 0; i < frames.length; i++) {
      const id = setTimeout(() => onHighlight(frames[i]), i * gapMs);
      frameTimers.current.push(id);
    }
    // After the ascending run, light up the whole scale at once for 5s.
    const allNotes = allSteps.map(s => baseTonic + s);
    const holdStart = frames.length * gapMs;
    const holdId = setTimeout(() => onHighlight(allNotes), holdStart);
    frameTimers.current.push(holdId);
    const clearId = setTimeout(() => onHighlight([]), holdStart + HOLD_MS);
    frameTimers.current.push(clearId);
    // Block re-triggering this same scale until the ascending run +
    // 5 s sustained hold both finish.  Clicking a different scale's
    // ▶ cancels everything via the frameTimers clear at the top of
    // this function and re-arms the lockout for the new scale.
    if (playingTonalityTimer.current) clearTimeout(playingTonalityTimer.current);
    setPlayingTonality(tonality);
    playingTonalityTimer.current = setTimeout(() => {
      setPlayingTonality(null);
      playingTonalityTimer.current = null;
    }, holdStart + HOLD_MS);
  }, [edo, tonicPc, lowestPitch, playVol, harmonyVol, ensureAudio, onHighlight]);

  const CHORD_BOOST = 2.2;
  const BASS_BOOST = 1.6;
  const playVoices = useCallback((voices: { chords: number[][]; bass: number[][] }, gapMs: number, noteDur: number, vol: number) => {
    const voiceList: { frames: number[][]; noteDuration: number; gain: number }[] = [];
    if (textureLayers.has("harmony") && voices.chords.length) {
      voiceList.push({ frames: voices.chords, noteDuration: noteDur, gain: vol * harmonyVol * CHORD_BOOST });
    }
    if (textureLayers.has("bass") && voices.bass.length) {
      voiceList.push({ frames: voices.bass, noteDuration: noteDur * 1.2, gain: vol * bassVol * BASS_BOOST });
    }
    if (voiceList.length === 0) return;
    audioEngine.playMultiVoice(voiceList, edo, gapMs, voices.chords.length || 1);
  }, [textureLayers, edo, harmonyVol, bassVol]);

  /** Build a unified highlight timeline from all voices, merging events at the same time.
   *  Only includes voices whose texture layer is active. */
  const highlightAllVoices = useCallback((voices: { chords: number[][]; bass: number[][] }, gapMs: number) => {
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    const n = voices.chords.length;
    if (n === 0) return;

    const activeBass = textureLayers.has("bass") ? voices.bass : [];
    const bassSubdivs = activeBass.length > 0 ? Math.max(1, Math.round(activeBass.length / n)) : 0;
    const maxSubdivs = Math.max(1, bassSubdivs);
    const subGap = gapMs / maxSubdivs;

    for (let slot = 0; slot < n; slot++) {
      for (let sub = 0; sub < maxSubdivs; sub++) {
        const t = slot * gapMs + sub * subGap;
        const notes: number[] = textureLayers.has("harmony") ? [...(voices.chords[slot] || [])] : [];
        if (bassSubdivs > 0) {
          const bassIdx = slot * bassSubdivs + Math.min(sub, bassSubdivs - 1);
          if (bassIdx < activeBass.length) notes.push(...activeBass[bassIdx]);
        }
        const id = setTimeout(() => onHighlight(notes), t);
        frameTimers.current.push(id);
      }
      // Lattice chord-onset pulse — fires once per chord boundary.
      // Each chord lights up ALL its chord-tones at once on the
      // lattice (mirroring the keyboard, which lights all chord
      // pitches during the same slot).  When the next chord starts
      // its slot, the lattice switches to that chord's tones.
      const id = setTimeout(() => setCurrentChordIdx(slot), slot * gapMs);
      frameTimers.current.push(id);
    }
    // Voice-leading preview window.  Arrow for the i → i+1 transition
    // appears ~280ms BEFORE chord (i+1) onsets and stays on for a
    // further ~480ms INTO chord (i+1) — total visible ~760ms — so the
    // arrow lingers well past the new chord's start and the user has
    // time to actually trace which note moved where without it being
    // gone before the new chord finishes registering.
    const VOICE_LEAD_PREVIEW_PRE_MS = 280;
    const VOICE_LEAD_HOLD_POST_MS = 480;
    for (let slot = 1; slot < n; slot++) {
      const onsetMs = slot * gapMs;
      const showAt = Math.max(0, onsetMs - VOICE_LEAD_PREVIEW_PRE_MS);
      const hideAt = onsetMs + VOICE_LEAD_HOLD_POST_MS;
      const showId = setTimeout(() => setVoiceLeadTransitionIdx(slot - 1), showAt);
      const hideId = setTimeout(() => {
        // Only clear if this slot is still the active transition —
        // otherwise the next slot's showId may have already advanced
        // the index and our hide would clobber it.
        setVoiceLeadTransitionIdx(prev => (prev === slot - 1 ? null : prev));
      }, hideAt);
      frameTimers.current.push(showId, hideId);
    }
    // Drop the active highlight just after the final chord's onset
    // so the lattice doesn't stay frozen on the last chord forever.
    const clearId = setTimeout(() => setCurrentChordIdx(-1), n * gapMs + 100);
    frameTimers.current.push(clearId);
    const clearVlId = setTimeout(() => setVoiceLeadTransitionIdx(null), n * gapMs + 100);
    frameTimers.current.push(clearVlId);
  }, [onHighlight, textureLayers]);

  const playLoopIteration = useCallback((voices: { chords: number[][]; bass: number[][] }, gapMs: number, noteDur: number) => {
    if (!voices.chords.length) return;
    playVoices(voices, gapMs, noteDur, playVol);
    highlightAllVoices(voices, gapMs);

    if (isLoopingRef.current) {
      const seqDur = (voices.chords.length - 1) * gapMs + noteDur * 1000 + 250;
      const totalMs = seqDur + loopGap * 1000;
      loopTimerId.current = setTimeout(() => {
        loopTimerId.current = null;
        const loop = currentLoop;
        if (!loop || !isLoopingRef.current) return;
        // Re-voice with the tonality's preserved chord map + xen toggles
        // so qrt/qnt and other xen variants keep firing on every
        // iteration, not just the first.
        const newVoices = buildLoopFrames(
          loop,
          loopChordMapRef.current ?? undefined,
          loopXenMapRef.current ?? undefined,
          loopScaleRootsRef.current,
        );
        if (newVoices.chords.some(c => c.length > 0)) {
          lastPlayed.current = { frames: newVoices.chords, info: loop.join(" → ") };
          fhVoicesRef.current = newVoices;
          playLoopIteration(newVoices, gapMs, noteDur);
        }
      }, totalMs);
    }
  }, [playVoices, playVol, loopGap, currentLoop, buildLoopFrames, highlightAllVoices]);

  const startFunctionalLoop = useCallback(async () => {
    await ensureAudio();
    stopLoop();

    // Randomize the tonality for this play. Filter to ones that have ≥2
    // checked chords so we don't pick a tonality with an empty pool.
    const usableTonalities = Array.from(tonalitySet).filter(t => {
      const eff = buildEffectiveCheckedForTonality(t);
      return eff.size >= 2;
    });
    if (usableTonalities.length === 0) {
      setLoopInfo("Select at least 2 chords in a tonality.");
      return;
    }
    // Recency-weighted pick: tonalities not chosen recently get higher
    // weight, capped at (pool size + 3) so the bias doesn't blow up over
    // a long session.  A tonality never picked before is treated as
    // older than any picked one.
    tonalityPickCounter.current++;
    const now = tonalityPickCounter.current;
    const cap = usableTonalities.length + 3;
    const weights = usableTonalities.map(t => {
      const lastAt = tonalityLastPickedAt.current.get(t);
      const age = lastAt === undefined ? cap : now - lastAt;
      return Math.min(age, cap);
    });
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * totalWeight;
    let pickedTonality = usableTonalities[usableTonalities.length - 1];
    for (let i = 0; i < usableTonalities.length; i++) {
      r -= weights[i];
      if (r <= 0) { pickedTonality = usableTonalities[i]; break; }
    }
    tonalityLastPickedAt.current.set(pickedTonality, now);
    const tonalityChordMap = buildChordMapForTonality(pickedTonality);
    const tonalityEffective = buildEffectiveCheckedForTonality(pickedTonality);
    const tonalityApproachLabels = new Set(buildApproachEntriesForTonality(pickedTonality).map(e => e.label));
    const tonalityXen = xenByTonality[pickedTonality] ?? {};
    const tonalityScaleRoots = buildDiatonicScaleRootsForTonality(pickedTonality);

    const checkedRomans = Array.from(tonalityEffective).filter(r => tonalityChordMap[r]);
    if (checkedRomans.length < 2) {
      setLoopInfo("Select at least 2 chords.");
      return;
    }

    const progression = generateFunctionalLoop(checkedRomans, loopLength, 300, tonalityApproachLabels);
    if (!progression) {
      setLoopInfo("Could not build a valid loop from these chords.");
      return;
    }

    setCurrentLoop(progression);
    // Persist the picked tonality's pool so loop iterations after the
    // first keep using the same xen toggles + chord map.
    loopChordMapRef.current = tonalityChordMap;
    loopXenMapRef.current = tonalityXen;
    loopScaleRootsRef.current = tonalityScaleRoots;
    const voices = buildLoopFrames(progression, tonalityChordMap, tonalityXen, tonalityScaleRoots);
    if (!voices.chords.some(c => c.length > 0)) {
      setLoopInfo("Could not voice these chords.");
      return;
    }

    // Build detailed info for "Show Answer"
    const detailLines: string[] = [`Loop: ${progression.join(" → ")}`, ""];
    for (let idx = 0; idx < progression.length; idx++) {
      const rn = progression[idx];
      const applied = voices.appliedShapes[idx];
      const quality = applied ? triadQuality(applied, edo) : "?";
      detailLines.push(`[${idx + 1}] ${rn} (${quality})`);
      // Bass
      if (textureLayers.has("bass") && voices.bass.length > 0) {
        const subdivs = Math.max(1, Math.round(voices.bass.length / progression.length));
        const bassSlice = voices.bass.slice(idx * subdivs, (idx + 1) * subdivs);
        const bassNames = bassSlice.map(f => f.map(n => intervalLabel(((n - tonicPc) % edo + edo) % edo, edo)).join(",")).join(" → ");
        detailLines.push(`Bass:   ${bassNames}`);
      }
      // "from Do" and "in context" show ONLY the chord (harmony) notes.
      // A "+N" tag appears ONLY when a note has been lifted ABOVE its
      // natural ascending placement.  In a closed-position voicing the
      // notes ascend naturally and get no tags — even when an inversion
      // forces 1 or 3 into the next octave above the bass (that climb
      // is implied by the bottom-to-top sequence).  The tag appears
      // only when an explicit spread / drop / quartal-stack mechanism
      // pushes the note an octave further.
      if (voices.chords[idx]?.length) {
        const chordNotes = [...voices.chords[idx]].sort((a, b) => a - b);
        const lowest = chordNotes[0];
        // Chain natural ascending positions: each note's natural is the
        // lowest absolute pitch (with its pitch class) that sits above
        // the previous note's natural placement.
        const natural: number[] = [chordNotes[0]];
        for (let i = 1; i < chordNotes.length; i++) {
          const pc = ((chordNotes[i] % edo) + edo) % edo;
          let nat = pc + Math.floor(natural[i - 1] / edo) * edo;
          while (nat <= natural[i - 1]) nat += edo;
          natural.push(nat);
        }
        const refForPc = (refPc: number): number => {
          const pc = ((refPc % edo) + edo) % edo;
          const offset = ((lowest - pc) % edo + edo) % edo;
          return lowest - offset;
        };
        const tonicRef = refForPc(tonicPc);
        const chordRootPc = applied ? ((applied[0] % edo) + edo) % edo : 0;
        const rootRef = refForPc(tonicPc + chordRootPc);
        const labelWithOct = (n: number, ref: number, idx: number): string => {
          const rel = n - ref;
          const pc = ((rel % edo) + edo) % edo;
          const oct = Math.floor((n - natural[idx]) / edo);
          const base = intervalLabel(pc, edo);
          return oct > 0 ? `${base}+${oct}` : base;
        };
        const tonicNames = chordNotes.map((n, i) => labelWithOct(n, tonicRef, i));
        const rootNames = chordNotes.map((n, i) => labelWithOct(n, rootRef, i));
        detailLines.push(`Chord from Do:    [${tonicNames.join(", ")}]`);
        detailLines.push(`Chord in context: [${rootNames.join(", ")}]`);
        const lilWarn = formatLilWarnings(checkLowIntervalLimits(chordNotes, edo), edo);
        if (lilWarn) detailLines.push(lilWarn);
      }
      if (idx < progression.length - 1) detailLines.push("─".repeat(28));
    }

    const info = progression.join(" → ");
    setLoopInfo(info);
    setFhDetailInfo(detailLines.join("\n"));
    // Build the structured answer for the rebuilt Show Answer panel.
    // Per-chord pitches come straight from voices.chords (sorted) so
    // each tone button in the UI plays the exact pitch the loop heard.
    const structuredChords: FhAnswerChord[] = progression.map((rn, idx) => {
      const applied = voices.appliedShapes[idx];
      const quality = applied ? triadQuality(applied, edo) : "?";
      const notes = voices.chords[idx]?.length
        ? [...voices.chords[idx]].sort((a, b) => a - b)
        : [];
      const chordRootPc = applied ? ((applied[0] % edo) + edo) % edo : 0;
      return { index: idx + 1, numeral: rn, quality, notes, chordRootPc };
    });
    setFhAnswer({
      progression,
      chords: structuredChords,
      scaleTonality: pickedTonality ?? null,
    });
    setFhShowAnswer(false);
    fhFramesRef.current = voices.chords;
    fhVoicesRef.current = voices;
    lastPlayed.current = { frames: voices.chords, info };
    onPlay(`crd:fh:${info}`, `Chords: ${info}`);
    onResult(`Listen to the loop...`);

    const gapMs = loopGap * 1000;
    const noteDur = chordDur;
    setIsLooping(true);
    playVoices(voices, gapMs, noteDur, playVol * 0.7);
    const d = setTimeout(() => { setIsLooping(false); }, voices.chords.length * gapMs + 500);
    frameTimers.current.push(d);
  }, [ensureAudio, stopLoop, tonalitySet, buildEffectiveCheckedForTonality, buildChordMapForTonality, buildApproachEntriesForTonality, buildDiatonicScaleRootsForTonality, lastPlayed, loopLength, loopGap, chordDur, buildLoopFrames, playVoices, onPlay, onResult, edo, tonicPc, playVol, textureLayers, xenByTonality]);

  const replayFunctionalLoop = useCallback(() => {
    const voices = fhVoicesRef.current;
    if (!voices || !voices.chords.length || isLooping) return;
    const gapMs = loopGap * 1000;
    const noteDur = chordDur;
    setIsLooping(true);
    playVoices(voices, gapMs, noteDur, playVol * 0.7);
    const d = setTimeout(() => setIsLooping(false), voices.chords.length * gapMs + 500);
    frameTimers.current.push(d);
  }, [playVoices, playVol, isLooping, loopGap, chordDur]);

  const showFhAnswer = useCallback(async () => {
    await ensureAudio();
    setFhShowAnswer(true);
    setIsLooping(true);
    const voices = fhVoicesRef.current;
    if (voices && voices.chords.length) {
      const gapMs = loopGap * 1000;
      // Play all voices together
      playVoices(voices, gapMs, chordDur, playVol * 0.7);
      // Highlight all voices with subdivisions
      highlightAllVoices(voices, gapMs);
      const doneId = setTimeout(() => setIsLooping(false), voices.chords.length * gapMs + 500);
      frameTimers.current.push(doneId);
    }
  }, [ensureAudio, playVoices, highlightAllVoices, playVol, loopGap, chordDur]);

  // Stop loop on unmount
  useEffect(() => {
    return () => stopLoop();
  }, [stopLoop]);

  // ── UI helpers ──────────────────────────────────────────────────────

  const toggleLevel = (name: string) => {
    setCollapsedLevels(prev => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  };

  // Toggle a single chord label inside a tonality's checked pool.
  const toggleChordForTonality = useCallback((tonality: string, label: string) => {
    setCheckedByTonality(prev => {
      const list = prev[tonality] ?? [];
      const has = list.includes(label);
      const next = has ? list.filter(l => l !== label) : [...list, label];
      return { ...prev, [tonality]: next };
    });
  }, [setCheckedByTonality]);

  // Bulk select / clear a level's chords for one tonality.
  const setLevelForTonality = useCallback((tonality: string, levelChords: ChordEntry[], select: boolean) => {
    setCheckedByTonality(prev => {
      const list = new Set(prev[tonality] ?? []);
      for (const c of levelChords) {
        if (select) list.add(c.label); else list.delete(c.label);
      }
      return { ...prev, [tonality]: Array.from(list) };
    });
  }, [setCheckedByTonality]);

  // ── Render ──────────────────────────────────────────────────────────

  // Selected JI tonalities (subset of tonalitySet whose names are in the
  // JI scale catalog) — drives the per-tonality chord-status panel below.
  const selectedJiTonalities = (edo === 41 || edo === 53)
    ? Array.from(tonalitySet).filter(t => JI_SCALE_NAMES_SET.has(t))
    : [];

  return (
    <div className="space-y-5">
      {/* Chord-analysis is no longer rendered as an always-on
          floating panel — instead, when the user opens Show Answer
          each chord row pulls its own analysis row (3rd / 5th /
          pure-vs-wolf) from analyzeJiScale of the active scale
          tonality and displays it inline.  See the chord-row map
          inside the Show Answer reveal further down. */}

      {/* JI progression mode selector (41/53 EDO only).  Two modes:
            FROZEN   — scale's actual step values verbatim; certain
                       scale-degree triads wolf, the syntonic comma is
                       audible.  Tonic stays put.  Muted blue accent.
            ADAPTIVE — chord shapes stay at their frozen EDO tunings, but
                       the whole progression drifts as the lattice walks
                       through it (comma pumps audibly shift the tonic).
                       Green accent. */}
      {(edo === 41 || edo === 53) && (() => {
        const modeBorderBg = jiMode === "frozen"
          ? "border-[#3a3a8a] bg-[#0e0e1a]"
          : "border-[#3a8a5a] bg-[#0e1a14]";
        return (
        <div className={`rounded border-2 p-3 transition-colors ${modeBorderBg}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[10px] text-[#888] font-semibold tracking-wider mr-1">PROGRESSION MODE</p>
            {([
              { id: "frozen",   label: "Frozen JI Progressions", color: "#5b5be6" },
              { id: "adaptive", label: "Adaptive Drift",         color: "#5cca8a" },
            ] as const).map(opt => (
              <button key={opt.id}
                onClick={() => setJiMode(opt.id)}
                className={`px-3 py-1.5 rounded text-[11px] font-medium transition-colors border-2 ${
                  jiMode === opt.id
                    ? "text-white"
                    : "bg-[#111] text-[#666] hover:text-[#aaa] border-[#2a2a2a]"
                }`}
                style={jiMode === opt.id ? { backgroundColor: opt.color + "30", borderColor: opt.color, color: opt.color } : {}}>
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-[#888] italic mt-2">
            {jiMode === "frozen"
              ? "Each scale's chord pool uses the scale's actual step values verbatim.  One chord per scale wolfs (look for ✗ in the analysis below) — that's the syntonic comma made audible.  Tonic stays put."
              : "Chord shapes stay at their frozen EDO tunings.  The lattice walk through the progression is computed and surfaced in the Live Lattice Trace, but the playback compensates for the cumulative comma so the tonic stays anchored — what you hear is pure-interval chords without the cadence pumping the tonic out of tune.  41/53-EDO's step values are themselves within 1¢ of 5-limit JI, so anchoring the roots at the frozen positions already gives perceptually pure intervals."}
          </p>
        </div>
        );
      })()}

      {/* Comma Drift Reference catalog removed — the Live Lattice
          Trace now lives inside the Show Answer reveal further down,
          gated on Adaptive JI mode + 41/53 EDO + an active progression. */}

      {/* Per-selected-JI-tonality chord-purity table.  Walks each scale-
          degree triad, classifies the third and fifth against the JI
          interval catalog, marks pure vs wolf positions.  Same data
          regardless of EDO (41 vs 53) since the analysis lives on the
          underlying JI ratios, not the EDO step rounding. */}
      {/* The chord-analysis table and the JI lattice viewer are now
          rendered as floating panels (top-right + bottom-right) instead
          of consuming in-flow space.  See the FloatingPanel section
          below the picker. */}

      {/* Tonality multi-select — family-grouped boxes (Mode ID style).
          Click a mode to add it to the pool. At play time a random
          tonality is chosen and only its chord pool is used. */}
      <div className="bg-[#0e0e0e] border border-[#1a1a1a] rounded p-2 space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-xs text-[#888] font-medium">TONALITIES</p>
          <button onClick={() => setTonalitySet(new Set())}
            className="text-[9px] text-[#555] hover:text-[#aaa] border border-[#222] rounded px-2 py-0.5 ml-auto">Clear</button>
        </div>
        {tonalitySectionsForEdo(edo).map(section => {
          // Filter families to those with at least one bank-backed
          // tonality available for this EDO; drop empty sections so the
          // picker doesn't render headers for limits with no scales.
          // Defensive guard (per user direction 2026-05-05): for any
          // EDO that's NOT 41 or 53, strip any tonality whose name
          // starts with "Diatonic " — those are JI scale names that
          // belong only to the curated 41/53 picker.  Even if they
          // sneak into the section list through some other code path,
          // they shouldn't reach the user.
          const stripJiNames = !(edo === 41 || edo === 53);
          const usableFamilies = section.families
            .map(f => ({
              ...f,
              tonalities: f.tonalities
                .filter(t => banksByName[t])
                .filter(t => !stripJiNames || !t.startsWith("Diatonic ")),
            }))
            .filter(f => f.tonalities.length > 0);
          if (usableFamilies.length === 0) return null;
          return (
            <div key={section.key} className="space-y-1.5">
              {/* Section header — the LIMIT name (5-LIMIT, 7-LIMIT, etc.). */}
              <p className="text-[10px] font-bold tracking-widest border-b border-[#1a1a1a] pb-0.5"
                 style={{ color: section.color }}>{section.label}</p>
              {usableFamilies.map(family => (
                <div key={family.key} className="ml-2">
                  {/* Family sub-header (DIATONIC / TERTIAN / MAQAM / etc.) */}
                  <p className="text-[9px] mb-1 font-medium tracking-wider text-[#666]">
                    {family.label}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {family.tonalities.map(t => {
                      const on = tonalitySet.has(t);
                      return (
                        <span key={t} className="inline-flex items-stretch">
                          <button onClick={() => toggleTonality(t)}
                            className={`px-2 py-1 text-[10px] rounded-l border-y border-l transition-colors ${
                              on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                            }`}
                            style={on ? { backgroundColor: section.color + "30", borderColor: section.color, color: section.color } : {}}>
                            {formatHalfAccidentals(t, edo)}
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); previewTonalityScale(t); }}
                            disabled={playingTonality === t}
                            title={playingTonality === t ? "Already playing — wait for it to finish" : "Preview scale"}
                            className={`px-1.5 py-1 text-[9px] rounded-r border-y border-r transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                              on ? "" : "bg-[#0a0a0a] border-[#2a2a2a] text-[#555] hover:text-[#aaa]"
                            }`}
                            style={on ? { backgroundColor: section.color + "20", borderColor: section.color, color: section.color } : {}}>
                            ▶
                          </button>
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* ════════════════════════════════════════════════════════════════ */}
      {/* PROGRESSIONS section                                           */}
      {/* ════════════════════════════════════════════════════════════════ */}
      <div className="bg-[#141008] border border-[#2a2210] rounded-lg px-4 py-3 space-y-3">
            <p className="text-xs text-[#a08840] leading-relaxed">
              Automatically builds looping progressions from your selected chords using functional-harmony rules.
              The engine finds chord movements that make musical sense and loops them continuously.
            </p>

            {/* Controls row */}
            <div className="flex gap-4 flex-wrap items-end">
              <div>
                <p className="text-[10px] text-[#886622] mb-1 font-medium">LOOP LENGTH</p>
                <div className="flex gap-1">
                  {LOOP_LENGTHS.map(n => (
                    <button key={n} onClick={() => setLoopLength(n)}
                      style={{
                        width: 28, height: 28, borderRadius: 4, fontSize: 11, fontWeight: 700,
                        border: `1.5px solid ${loopLength === n ? "#e0a040" : "#1a1a1a"}`,
                        background: loopLength === n ? "#e0a04018" : "#0e0e0e",
                        color: loopLength === n ? "#e0a040" : "#444",
                        cursor: "pointer",
                      }}
                    >{n}</button>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-[10px] text-[#886622] mb-1 font-medium">SPACING (s)</p>
                <input type="number" min={0.5} max={10} step={0.5} value={loopGap}
                  onChange={e => setLoopGap(Math.max(0.5, Math.min(10, parseFloat(e.target.value) || 0.5)))}
                  className="w-16 bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-xs text-white text-center focus:outline-none"
                />
              </div>
              <div>
                <p className="text-[10px] text-[#886622] mb-1 font-medium">DURATION (s)</p>
                <input type="number" min={0.1} max={8} step={0.1} value={chordDur}
                  onChange={e => setChordDur(Math.max(0.1, Math.min(8, parseFloat(e.target.value) || 0.5)))}
                  className="w-16 bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-xs text-white text-center focus:outline-none"
                />
              </div>

              {/* Voicing controls inline */}
              <VoicingControls
                regMode={regMode} setRegMode={setRegMode}
                compact
              />
            </div>

            {/* ── Texture Layers ── */}
            <div className="flex gap-4 flex-wrap items-end">
              <div>
                <p className="text-[10px] text-[#886622] mb-1 font-medium">TEXTURE</p>
                <div className="flex gap-3">
                  {([
                    { layer: "harmony" as const, vol: harmonyVol, setVol: setHarmonyVol },
                  ]).map(({ layer, vol, setVol }) => {
                    const checked = textureLayers.has(layer);
                    return (
                      <div key={layer} className="flex flex-col items-center gap-0.5">
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input type="checkbox" checked={checked}
                            onChange={() => setTextureLayers(toggleSet(textureLayers, layer))}
                            className="accent-[#e0a040]" />
                          <span className="text-xs" style={{ color: checked ? "#e0a040" : "#555" }}>
                            {layer.charAt(0).toUpperCase() + layer.slice(1)}
                          </span>
                        </label>
                        {checked && (
                          <input type="range" min={0} max={1} step={0.05} value={vol}
                            onChange={e => setVol(parseFloat(e.target.value))}
                            title={`${layer} vol: ${Math.round(vol * 100)}%`}
                            style={{ width: 60, accentColor: "#e0a040" }} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* Bass layer + BASS MODE selector intentionally removed —
                  Tonal Audiation chord progressions are harmony-only.
                  The bassLineMode state still exists but is never read by
                  the playback path (textureLayers no longer admits "bass"),
                  so the bass-line generator is effectively a no-op. */}
              {false && (
                <div>
                  <div className="flex gap-1">
                    {(["root", "root-fifth", "passing", "walking"] as const).map(m => {
                      const active = bassLineMode === m;
                      return (
                        <button key={m} onClick={() => setBassLineMode(m)}
                          style={{
                            padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                            border: `1.5px solid ${active ? "#e0a040" : "#1a1a1a"}`,
                            background: active ? "#e0a04018" : "#0e0e0e",
                            color: active ? "#e0a040" : "#444",
                            cursor: "pointer",
                          }}
                        >{m}</button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Sentinel: lives just above the play row.  The
                IntersectionObserver above flips `pinPlayRow` true
                once this sentinel scrolls up past the viewport top. */}
            <div ref={playRowSentinelRef} aria-hidden style={{ height: 1 }} />

            {/* Play / Stop / Replay / Show Answer — pinned to the
                viewport top via position:fixed when the user has
                scrolled past the row's natural position AND the
                harmonic lattice hasn't yet fully scrolled out.  CSS
                position:sticky was unreliable inside the chord tab's
                nested flex layout, so the IntersectionObserver
                sentinels (just above this row + just after the
                lattice) drive the pinning explicitly.  When pinned
                we render a matching-height spacer below so the
                following content doesn't collapse upward. */}
            <div className={
                pinPlayRow
                  ? "flex gap-2 flex-wrap items-center fixed top-0 left-0 right-0 z-50 bg-[#0d0d0d] py-2 px-4 border-b border-[#1e1e1e] shadow-md shadow-black/40"
                  : "flex gap-2 flex-wrap items-center bg-[#0d0d0d] py-2 -mx-4 px-4 border-b border-[#1e1e1e]"
              }>
              <button onClick={startFunctionalLoop} disabled={isLooping || !canPlay}
                title={disabledReason ?? undefined}
                className="bg-[#e0a040] hover:bg-[#c89030] disabled:opacity-50 disabled:cursor-not-allowed text-black px-5 py-2 rounded text-sm font-bold transition-colors">
                Play
              </button>
              {disabledReason && (
                <span className="text-[10px] text-[#c06060]">{disabledReason}</span>
              )}
              {isLooping && (
                <button onClick={stopLoop}
                  className="bg-[#3a1a1a] hover:bg-[#4a2020] border border-[#6a3a3a] text-[#e06060] px-4 py-2 rounded text-sm font-bold transition-colors">
                  Stop
                </button>
              )}
              {fhFramesRef.current && fhFramesRef.current.length > 0 && !isLooping && (
                <button onClick={replayFunctionalLoop}
                  className="bg-[#1e1e1e] hover:bg-[#2a2a2a] border border-[#333] text-[#aaa] px-4 py-2 rounded text-sm transition-colors">
                  Replay
                </button>
              )}
              {fhDetailInfo && (
                <button onClick={showFhAnswer} disabled={isLooping}
                  className="bg-[#1e1e1e] hover:bg-[#2a2a2a] disabled:opacity-50 border border-[#444] text-[#e0a040] px-4 py-2 rounded text-sm transition-colors">
                  {fhShowAnswer ? "Replay Answer" : "Show Answer"}
                </button>
              )}
              {answerButtons}
            </div>
            {/* Layout spacer — only present while the row is pinned
                (rendered as fixed and pulled out of the flow), so the
                following content doesn't visually jump upward. */}
            {pinPlayRow && <div aria-hidden style={{ height: 56 }} />}

            {/* Answer — only visible after clicking Show Answer.
                Per-chord rows with clickable tone buttons; each tone
                shows its interval-from-tonic name plus both solfege
                systems (Heathwaite + Microtonal IPA) so the user can
                see the same note labelled three ways at once.  Click
                the tone to hear it through the audio engine. */}
            {fhShowAnswer && fhAnswer && (() => {
              const heathwaiteTable = getHeathwaiteSolfege(edo);
              // JI chord-row analysis (3rd / 5th / pure vs wolf) for
              // the currently-played scale tonality, when it's a JI
              // tonality.  Indexed by Roman numeral so each chord row
              // can show its own row inline instead of relying on a
              // separate floating panel.
              const ROMAN_INDEX: Record<string, number> = {
                I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6,
              };
              const tagColor = (k: string) => {
                if (k === "wolf") return "#cc6a8a";
                if (k === "off-grid") return "#c8aa50";
                if (k === "pure-3") return "#9999cc";
                if (k === "pure-5") return "#6acca0";
                if (k === "pure-7") return "#cc8855";
                if (k === "pure-11") return "#9a66c0";
                return "#888";
              };
              const jiAnalysis = fhAnswer.scaleTonality && JI_SCALE_NAMES_SET.has(fhAnswer.scaleTonality)
                ? analyzeJiScale(fhAnswer.scaleTonality)
                : null;
              const analysisForChord = (numeral: string) => {
                if (!jiAnalysis) return null;
                const stripped = stripChordLabel(numeral);
                const idx = ROMAN_INDEX[stripped.replace(/[^IVX]/gi, "").toUpperCase()];
                if (idx === undefined) return null;
                return jiAnalysis[idx] ?? null;
              };
              return (
                <div className="bg-[#1a1a0a] border border-[#3a3a1a] rounded p-3 space-y-3">
                  <div className="flex items-baseline gap-2 pb-1.5 border-b border-[#3a3a1a]">
                    <p className="text-[10px] text-[#888] font-semibold tracking-wider">LOOP</p>
                    <p className="text-[12px] text-[#c8a850] font-mono">
                      {(() => {
                        const prefix = (edo === 41 || edo === 53) && fhAnswer.scaleTonality
                          ? familyAbbreviationForTonality(fhAnswer.scaleTonality)
                          : null;
                        return fhAnswer.progression.map((rn, i) => (
                          <Fragment key={i}>
                            {i > 0 && " → "}
                            {formatRomanNumeralWithFamily(rn, prefix)}
                          </Fragment>
                        ));
                      })()}
                    </p>
                    {fhAnswer.scaleTonality && (
                      <p className="text-[10px] text-[#888] ml-auto italic">
                        Scale: {fhAnswer.scaleTonality}
                      </p>
                    )}
                  </div>
                  {/* Single-column body — chord-tone reveal stretches
                      full width.  The right-column live visualizer
                      mirror was removed; the App-level main visualizer
                      stays sticky at the top of the page so the user
                      always has a keyboard view of the active chord. */}
                  <div className="space-y-3">
                  {/* Live lattice trace — meaningful in Adaptive and
                      Pure 3/5-limit modes on 41/53-EDO.  Shows each
                      chord in the progression with its accumulated
                      drift in cents, colour-coded green / amber / pink
                      by magnitude. */}
                  {(edo === 41 || edo === 53) && (() => {
                    void latticeRevision;
                    const trace = latticeDriftsRef.current;
                    if (!trace || !trace.drifts) return null;
                    const drifts = trace.drifts;
                    const finalDrift = drifts[drifts.length - 1] ?? 0;
                    const maxAbsDrift = Math.max(...drifts.map(d => Math.abs(d)));
                    return (
                      <div className="rounded border border-[#3a8a5a] bg-[#0e1a14] p-3">
                        <div className="flex items-baseline gap-2 mb-2">
                          <p className="text-[10px] text-[#5cca8a] font-semibold tracking-wider">LIVE LATTICE TRACE</p>
                          <span className="text-[9px] text-[#888]">
                            Final drift: <span className="font-mono" style={{ color: Math.abs(finalDrift) < 1 ? "#5cca8a" : "#cc6a8a" }}>
                              {finalDrift >= 0 ? "+" : ""}{finalDrift.toFixed(1)}¢
                            </span>
                            {" · "}
                            Peak: <span className="font-mono text-[#ccc]">{maxAbsDrift.toFixed(1)}¢</span>
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {trace.progression.map((chord, i) => {
                            const drift = drifts[i];
                            const driftAbs = Math.abs(drift);
                            const driftColor = driftAbs < 1 ? "#5cca8a" : driftAbs < 15 ? "#c8aa50" : "#cc6a8a";
                            return (
                              <div key={i} className="flex flex-col items-center px-2 py-1 rounded border border-[#222] bg-[#0a1410]">
                                <span className="text-[10px] text-[#aaa] font-mono">{stripChordLabel(chord)}</span>
                                <span className="text-[9px] font-mono" style={{ color: driftColor }}>
                                  {drift >= 0 ? "+" : ""}{drift.toFixed(1)}¢
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                  {/* Chord cards laid out side by side (flex-wrap)
                      so the user sees the whole progression at a
                      glance and the cards reflow onto multiple rows
                      only when the viewport is too narrow.  Each card
                      keeps its internal stacked-tone layout — chord-
                      relative gold on top, scale-relative mauve below
                      per note. */}
                  <div className="flex flex-wrap gap-2 items-start">
                  {fhAnswer.chords.map(chord => {
                    const ana = analysisForChord(chord.numeral);
                    // Comma-compensation note for this chord, if any.
                    // Only fires when in Adaptive mode AND the chord
                    // accumulated a non-zero EDO-step compensation; the
                    // text spells out which root pitch was bent and by
                    // how many cents to keep the tonic anchored.
                    const driftsForNote = latticeDriftsRef.current?.drifts ?? null;
                    let commaNote: { from: string; to: string; cents: number; steps: number } | null = null;
                    if (jiMode === "adaptive" && driftsForNote && (edo === 41 || edo === 53)) {
                      const idx = chord.index - 1;
                      if (idx >= 0 && idx < driftsForNote.length) {
                        const driftCents = driftsForNote[idx];
                        const steps = driftCentsToSteps(driftCents, edo);
                        if (steps !== 0) {
                          // chord.chordRootPc is post-comp.  Pre-comp =
                          // post + steps (the audio engine subtracted
                          // `steps` from each tone, so the un-compensated
                          // pitch sits `steps` higher).
                          const postRootPc = chord.chordRootPc;
                          const preRootPc = ((postRootPc + steps) % edo + edo) % edo;
                          const preAbsPc = ((tonicPc + preRootPc) % edo + edo) % edo;
                          const postAbsPc = ((tonicPc + postRootPc) % edo + edo) % edo;
                          commaNote = {
                            from: pcToNoteNameWithEnharmonic(preAbsPc, edo) ?? `${preAbsPc}\\${edo}`,
                            to: pcToNoteNameWithEnharmonic(postAbsPc, edo) ?? `${postAbsPc}\\${edo}`,
                            cents: -driftCents,
                            steps: -steps,
                          };
                        }
                      }
                    }
                    return (
                    <div key={chord.index} className="space-y-1 flex-shrink-0 rounded border border-[#1a1a14] bg-[#0c0a08] p-2">
                      <p className="text-[10px] text-[#c8a850] font-medium flex items-baseline gap-2 flex-wrap">
                        <span>[{chord.index}] <span className="font-mono text-[12px]">{(() => {
                          const prefix = (edo === 41 || edo === 53) && fhAnswer.scaleTonality
                            ? familyAbbreviationForTonality(fhAnswer.scaleTonality)
                            : null;
                          return formatRomanNumeralWithFamily(chord.numeral, prefix);
                        })()}</span></span>
                        <span className="text-[#888]">({chord.quality})</span>
                        {ana && (
                          <span className="text-[9px] flex items-baseline gap-1 ml-2 px-1.5 py-0.5 rounded border border-[#222] bg-[#0a0a0a]">
                            <span className="text-[#555]">3rd</span>
                            <span className="font-mono" style={{ color: tagColor(ana.third.kind) }}>{ana.third.ratio}</span>
                            <span className="text-[#333]">·</span>
                            <span className="text-[#555]">5th</span>
                            <span className="font-mono" style={{ color: tagColor(ana.fifth.kind) }}>{ana.fifth.ratio}</span>
                            <span className="text-[#333]">·</span>
                            <span style={{ color: ana.pure ? "#5cca5c" : "#cc6a8a", fontWeight: 600 }}>
                              {ana.pure ? "✓" : "✗ Wolf"}
                            </span>
                          </span>
                        )}
                      </p>
                      {commaNote && (
                        <p className="text-[10px] text-[#cc6a8a] flex items-baseline gap-1.5 px-1.5 py-0.5 rounded border border-[#3a1a2a] bg-[#1a0a14]">
                          <span className="font-semibold tracking-wider">COMMA FIX</span>
                          <span className="text-[#aaa]">root</span>
                          <span className="font-mono text-[#e0c860]">{commaNote.from}</span>
                          <span className="text-[#cc6a8a]">→</span>
                          <span className="font-mono text-[#5cca5c]">{commaNote.to}</span>
                          <span className="text-[#888]">
                            ({commaNote.steps > 0 ? "+" : ""}{commaNote.steps} step{Math.abs(commaNote.steps) !== 1 ? "s" : ""}, {commaNote.cents > 0 ? "+" : ""}{commaNote.cents.toFixed(1)}¢)
                          </span>
                          <span className="text-[#666] italic">— bent to keep the tonic anchored, otherwise this chord's root would drift away from {pcToNoteNameWithEnharmonic(tonicPc, edo) ?? "the tonic"}</span>
                        </p>
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        {chord.notes.map((pitch, i) => {
                          // Two reference frames per tone:
                          //   "scale" — pitch class relative to tonic (Do = 1)
                          //   "chord" — pitch class relative to chord root
                          // Solfege labels (Heathwaite + Microtonal IPA) computed
                          // for each frame so the user sees the same note named
                          // four ways: chord 3rd vs scale 5th, etc.
                          const pcFromTonic = ((pitch - tonicPc) % edo + edo) % edo;
                          const pcFromChord = ((pcFromTonic - chord.chordRootPc) % edo + edo) % edo;

                          const intervalScale = intervalLabel(pcFromTonic, edo);
                          const heathwaiteScale = heathwaiteTable ? heathwaiteTable[pcFromTonic] ?? "—" : "—";
                          const microScale = syllableForEdoStep(pcFromTonic, edo);

                          const intervalChord = intervalLabel(pcFromChord, edo);
                          const heathwaiteChord = heathwaiteTable ? heathwaiteTable[pcFromChord] ?? "—" : "—";
                          const microChord = syllableForEdoStep(pcFromChord, edo);

                          return (
                            <button key={i}
                              onClick={async () => {
                                await ensureAudio();
                                audioEngine.playNote(pitch, edo, 0.7, 0.6);
                              }}
                              title={
                                `▶ click main button to play pitch\n` +
                                `Click any syllable to hear it spoken.\n` +
                                `chord-relative: ${intervalChord} · ${heathwaiteChord} · ${microChord.label} /${microChord.ipa}/\n` +
                                `scale-relative: ${intervalScale} · ${heathwaiteScale} · ${microScale.label} /${microScale.ipa}/`
                              }
                              className="flex flex-col items-center px-2 py-1 rounded border border-[#3a3a1a] bg-[#2a1a0a] hover:bg-[#3a2a1a] hover:border-[#c8a850] transition-colors min-w-[64px]">
                              {/* Chord-relative block (gold).  Each syllable
                                  is an independent clickable that triggers
                                  TTS via the browser's Web Speech API.
                                  stopPropagation prevents the parent button
                                  from also firing the pitch-play handler. */}
                              <span className="text-[10px] text-[#e0c860] font-bold leading-tight">
                                {intervalChord}
                              </span>
                              <SaySpan text={heathwaiteChord} ipa={heathwaiteIpa(heathwaiteChord)}
                                className="text-[9px] text-[#aaa] leading-tight px-1 rounded hover:bg-[#3a3a1a] cursor-pointer"
                                title={`Hear "${heathwaiteChord}" spoken`} />
                              <SaySpan text={microChord.label} ipa={microChord.ipa}
                                className="text-[8px] text-[#777] font-mono leading-tight px-1 rounded hover:bg-[#3a3a1a] cursor-pointer"
                                title={`Hear "${microChord.label}" /${microChord.ipa}/ spoken`} />
                              <span className="block w-full border-t border-[#3a3a1a] my-1"></span>
                              {/* Scale-relative block (mauve) */}
                              <span className="text-[10px] text-[#c896c8] font-bold leading-tight">
                                {intervalScale}
                              </span>
                              <SaySpan text={heathwaiteScale} ipa={heathwaiteIpa(heathwaiteScale)}
                                className="text-[9px] text-[#aaa] leading-tight px-1 rounded hover:bg-[#3a3a1a] cursor-pointer"
                                title={`Hear "${heathwaiteScale}" spoken`} />
                              <SaySpan text={microScale.label} ipa={microScale.ipa}
                                className="text-[8px] text-[#777] font-mono leading-tight px-1 rounded hover:bg-[#3a3a1a] cursor-pointer"
                                title={`Hear "${microScale.label}" /${microScale.ipa}/ spoken`} />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    );
                  })}
                  </div>{/* end side-by-side chord-card row */}
                  </div>{/* end chord-tone column */}

                  {/* Full-width Harmonic Lattice — re-uses the main
                      LatticeView (3D Tonnetz / Monzo viewer) and
                      auto-tempers it to the active EDO so the
                      visualization matches the playback (12-EDO
                      heavily collapses cells; 41/53-EDO mostly
                      preserves distinctions; meantone EDOs squash
                      81/80 specifically).  Each chord-root in the
                      progression converts to an "n/d" ratio key and
                      is fed in as `externalHighlights`; the
                      currently-sounding chord becomes
                      `activeNodeKey` so the same chord-onset timer
                      that drives the keyboard highlight also drives
                      the lattice's pulsing node. */}
                  {fhAnswer.progression.length > 0 && (() => {
                    // The lattice is the Tonescape "3,5-primespace
                    // toroidal lattice" — 5-limit cells projected
                    // linearly with the EDO's vanishing commas
                    // tempered out, producing a torus where each
                    // visible cell is one EDO equivalence class.
                    // Class reps are picked by simplest JI ratio,
                    // so chord tones at (0,0)=1/1, (0,1)=5/4,
                    // (1,0)=3/2, (1,-1)=6/5, … land on the visible
                    // nodes directly without any chain-of-fifths
                    // remapping.
                    const positions = tracePath(fhAnswer.progression);
                    // Per-chord compensation step.  In Adaptive mode the
                    // audio engine subtracts this from each chord-tone
                    // before playback so the tonic stays anchored; the
                    // visual highlight has to match what's actually
                    // playing, so we apply the same subtraction here.
                    // In Frozen mode the compensation is zero and the
                    // chord plays at the drifted position verbatim.
                    void latticeRevision;
                    const driftsForCompPre = latticeDriftsRef.current?.drifts ?? null;
                    const compStepPerChord: number[] = positions.map((_, i) => {
                      if (jiMode !== "adaptive") return 0;
                      if (!driftsForCompPre || i >= driftsForCompPre.length) return 0;
                      return driftCentsToSteps(driftsForCompPre[i], edo);
                    });
                    // Per-chord chord-tone EDO classes — drives the
                    // lattice highlight.  Built from the lattice walk's
                    // drifted positions, then shifted back by the per-
                    // chord comp step so the highlight matches the
                    // post-compensation pitches the audio actually
                    // plays.  In Frozen mode comp step is 0 and the
                    // highlight stays at the drifted position (which is
                    // also what plays).  In Adaptive mode the highlight
                    // lands on the compensated rep, leaving the drifted
                    // rep free to receive a separate red marker from
                    // the compensation-arc pipeline.
                    const classesPerChord: Set<number>[] = positions.map((root, i) => {
                      const chord = fhAnswer.chords[i];
                      let quality = chord ? chordQualityFromSteps(chord.notes, edo) : null;
                      if (!quality) {
                        const stripped = chord ? stripChordLabel(chord.numeral) : "";
                        if (stripped.endsWith("°")) quality = "dim";
                        else if (stripped.endsWith("ø")) quality = "m7b5";
                        else quality = /^[A-Z]/.test(stripped) ? "major" : "minor";
                      }
                      const v = voicingFor(quality) ?? voicingFor("major")!;
                      const drifted = v.voices.map(vp => latticeToEdoStep(latticeAdd(root, vp), edo));
                      const comp = compStepPerChord[i];
                      const out = new Set<number>();
                      for (const c of drifted) out.add(((c - comp) % edo + edo) % edo);
                      return out;
                    });
                    const activeClasses = currentChordIdx >= 0 && currentChordIdx < classesPerChord.length
                      ? classesPerChord[currentChordIdx]
                      : new Set<number>();
                    // Per-pinned-chord overlay palette.  Picked from
                    // distinct hues so 2-3 simultaneous toggles stay
                    // visually distinguishable on the dark lattice
                    // background; cycles past 8 pinned chords (rare).
                    const PIN_PALETTE = [
                      "#e85ad0",  // magenta
                      "#5cca5c",  // green
                      "#e0a040",  // amber
                      "#5acca0",  // teal
                      "#cc6a8a",  // rose
                      "#9a66c0",  // violet
                      "#c8aa50",  // gold
                      "#5acce0",  // cyan
                    ];
                    const pinnedOverlays = [...pinnedChordIdxs]
                      .filter(i => i >= 0 && i < classesPerChord.length)
                      .map(i => ({
                        classes: classesPerChord[i],
                        color: PIN_PALETTE[i % PIN_PALETTE.length],
                      }));
                    // Comma-compensation arcs.  For each chord that
                    // ended up with a non-zero EDO-step compensation,
                    // draw an arc from the chord's uncompensated root
                    // class to its compensated root class so the user
                    // can see the exact step the playback shifted by.
                    // Gated on Adaptive mode — in Frozen mode no audio
                    // compensation actually runs, so showing a red arc
                    // would be misleading (the user would see "this is
                    // being compensated" while still hearing the drift).
                    const driftsForArcs = latticeDriftsRef.current?.drifts ?? null;
                    const compensationArcs: Array<{ fromClassId: number; toClassId: number; color: string; chordIdx: number }> = [];
                    if (driftsForArcs && jiMode === "adaptive") {
                      for (let i = 0; i < positions.length && i < driftsForArcs.length; i++) {
                        const compStep = compStepPerChord[i];
                        if (compStep === 0) continue;
                        // Only render the compensation indicator on
                        // chords the user is currently highlighting —
                        // either the live-playback chord or one the
                        // user pinned via the chord-toggle buttons.
                        // Showing arrows for every drifted chord at
                        // once would clutter the lattice with
                        // information the user can't act on.
                        const isHighlighted = currentChordIdx === i || pinnedChordIdxs.has(i);
                        if (!isHighlighted) continue;
                        const rootClass = latticeToEdoStep(positions[i], edo);
                        const fromClassId = ((rootClass) % edo + edo) % edo;
                        const toClassId = ((rootClass - compStep) % edo + edo) % edo;
                        compensationArcs.push({
                          fromClassId,
                          toClassId,
                          color: PIN_PALETTE[i % PIN_PALETTE.length],
                          chordIdx: i,
                        });
                      }
                    }
                    // Voice-leading arrows for the active preview
                    // transition (set ~220ms before each chord onsets
                    // by the playback scheduler in highlightAllVoices).
                    // For each moving voice between chord N and N+1,
                    // pair the source pitch class to the destination
                    // pitch class via minimum-cost assignment so the
                    // arrows trace the smallest-move voice leading.
                    // Common tones (held voices) are filtered out and
                    // get no arrow.  All arrows for the same transition
                    // share `index = N+1` (1-based).
                    let voiceLeadingArrows: Array<{ fromClassId: number; toClassId: number; index: number; color: string }> | undefined;
                    if (voiceLeadTransitionIdx !== null
                        && voiceLeadTransitionIdx >= 0
                        && voiceLeadTransitionIdx + 1 < classesPerChord.length) {
                      const fromSet = classesPerChord[voiceLeadTransitionIdx];
                      const toSet = classesPerChord[voiceLeadTransitionIdx + 1];
                      const fromOnly = [...fromSet].filter(p => !toSet.has(p));
                      const toOnly = [...toSet].filter(p => !fromSet.has(p));
                      const pairCount = Math.min(fromOnly.length, toOnly.length);
                      if (pairCount > 0 && pairCount <= 5) {
                        // Brute-force minimum-cost assignment.  Up to
                        // 5! = 120 perms — trivial; chord pools rarely
                        // exceed 4 moving voices.
                        const permute = (arr: number[]): number[][] => {
                          if (arr.length <= 1) return [arr.slice()];
                          const out: number[][] = [];
                          for (let i = 0; i < arr.length; i++) {
                            const rest = arr.slice(0, i).concat(arr.slice(i + 1));
                            for (const sub of permute(rest)) out.push([arr[i], ...sub]);
                          }
                          return out;
                        };
                        let bestPairs: Array<[number, number]> = [];
                        let bestCost = Infinity;
                        for (const perm of permute(toOnly)) {
                          let cost = 0;
                          for (let i = 0; i < pairCount; i++) {
                            const diff = Math.abs(fromOnly[i] - perm[i]);
                            cost += Math.min(diff, edo - diff);
                          }
                          if (cost < bestCost) {
                            bestCost = cost;
                            bestPairs = fromOnly.slice(0, pairCount).map((f, i) => [f, perm[i]] as [number, number]);
                          }
                        }
                        const idx = voiceLeadTransitionIdx + 1;
                        const color = PIN_PALETTE[voiceLeadTransitionIdx % PIN_PALETTE.length];
                        voiceLeadingArrows = bestPairs.map(([f, t]) => ({
                          fromClassId: f, toClassId: t, index: idx, color,
                        }));
                      }
                    }
                    const togglePin = (i: number) => {
                      setPinnedChordIdxs(prev => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        return next;
                      });
                    };
                    return (
                      <div className="rounded border border-[#3a3a5a] bg-[#0a0a14] mt-2 overflow-hidden">
                        <div className="px-3 py-2 border-b border-[#3a3a5a] flex items-baseline gap-2">
                          <p className="text-[10px] text-[#7a7af0] font-semibold tracking-wider">HARMONIC LATTICE</p>
                          <p className="text-[10px] text-[#666] italic">
                            auto-tempered for {edo}-EDO · cells the temperament collapses share a position
                          </p>
                          {pinnedChordIdxs.size > 0 && (
                            <button
                              onClick={() => setPinnedChordIdxs(new Set())}
                              className="ml-auto text-[10px] px-2 py-0.5 rounded border border-[#3a3a5a] text-[#7a7af0] hover:bg-[#1a1a2a]"
                            >Clear pins</button>
                          )}
                        </div>
                        <div style={{ position: "relative", width: "100%", height: "70vh", overflow: "hidden" }}>
                          <LatticeView
                            activeClassIds={activeClasses}
                            pinnedChordOverlays={pinnedOverlays}
                            compensationArcs={compensationArcs}
                            voiceLeadingArrows={voiceLeadingArrows}
                            temperingForEdo={edo}
                            chromeless
                          />
                          {/* Per-chord toggle buttons in the bottom-
                              left corner of the lattice canvas.  Each
                              button is the chord's roman numeral; the
                              accent border / fill matches the colour
                              the lattice will use to highlight that
                              chord's notes.  Multiple toggles render
                              all pinned chords in their distinct
                              colours simultaneously. */}
                          <div
                            className="absolute bottom-2 left-2 flex flex-wrap gap-1 z-10"
                            style={{ maxWidth: "60%" }}
                          >
                            {fhAnswer.progression.map((rn, i) => {
                              const on = pinnedChordIdxs.has(i);
                              const color = PIN_PALETTE[i % PIN_PALETTE.length];
                              const familyPrefix = (edo === 41 || edo === 53) && fhAnswer.scaleTonality
                                ? familyAbbreviationForTonality(fhAnswer.scaleTonality)
                                : null;
                              return (
                                <button
                                  key={i}
                                  onClick={() => togglePin(i)}
                                  title={on ? `Unpin ${rn}` : `Pin ${rn} — highlight in ${color}`}
                                  className="px-2 py-1 text-[11px] font-mono rounded border-2 transition-colors bg-[#0a0a14cc] backdrop-blur-sm"
                                  style={on
                                    ? { borderColor: color, color: "#fff", backgroundColor: color + "40" }
                                    : { borderColor: "#3a3a5a", color: "#888" }}
                                >
                                  <span className="mr-0.5 text-[8px] opacity-60">[{i + 1}]</span>
                                  {formatRomanNumeralWithFamily(rn, familyPrefix)}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

            {/* Sentinel just after the harmonic lattice — when this
                scrolls past the viewport top, the IntersectionObserver
                flips `pinPlayRow` back to false so the play row
                releases instead of riding the rest of the page. */}
            <div ref={latticeEndSentinelRef} aria-hidden style={{ height: 1 }} />

          </div>

          {/* Extensions + Voicings (shared controls) */}
          <ExtensionControls
            extTendency={extTendency} setExtTendency={setExtTendency}
            checkedExts={checkedExts} setCheckedExts={setCheckedExts}
            checkedExtCounts={checkedExtCounts} setCheckedExtCounts={setCheckedExtCounts} toggleSet={toggleSet}
          />
          <VoicingPatternControls checkedPatterns={checkedPatterns} setCheckedPatterns={setCheckedPatterns} toggleSet={toggleSet} betaMode={betaMode} />

          <LilPreviewPanel checkedChords={effectiveChecked} chordMap={chordMap} edo={edo} tonicPc={tonicPc} lowestPitch={lowestPitch} highestPitch={highestPitch} getCompatibleTypes={getCompatibleTypes} applyChordType={applyChordType} />

      {/* ════════════════════════════════════════════════════════════════ */}
      {/* CHORD SELECTION (per checked tonality)                          */}
      {/* ════════════════════════════════════════════════════════════════ */}
      <div className="space-y-3">
        {Array.from(tonalitySet).map(t => {
          const bank = banksByName[t];
          if (!bank) return null;
          const family = tonalityFamiliesForEdo(edo).find(f => f.tonalities.includes(t));
          const accent = family?.color ?? "#7173e6";
          // 41/53-EDO: family-name superscript prefix on roman numerals
          // so chords from different prime-limit families (Tridecimal vs
          // Heptadecimal vs Nonadecimal …) don't collide visually.
          const familyPrefix = (edo === 41 || edo === 53)
            ? familyAbbreviationForTonality(t)
            : null;
          return (
            <ChordSelectionPanel
              key={t}
              tonality={t}
              accent={accent}
              familyPrefix={familyPrefix}
              bank={bank}
              edo={edo}
              chordMap={chordMap}
              checkedSet={new Set(checkedByTonality[t] ?? [])}
              toggleChord={(label) => toggleChordForTonality(t, label)}
              setLevel={(levelChords, select) => setLevelForTonality(t, levelChords, select)}
              collapsedLevels={collapsedLevels}
              toggleLevel={toggleLevel}
              approachMap={approachesByTonality[t] ?? {}}
              toggleApproach={(target, kind) => toggleApproach(t, target, kind)}
              xenMap={xenByTonality[t] ?? {}}
              toggleXen={(numeral, xenId) => toggleXenForNumeral(t, numeral, xenId)}
              toggleXenStack={(numeral) => toggleXenStackForNumeral(t, numeral)}
            />
          );
        })}
        {tonalitySet.size === 0 && (
          <div className="text-xs text-[#666] italic px-3 py-2 border border-[#222] rounded">
            Pick at least one tonality above to choose chords.
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Extracted sub-components for shared controls
// ══════════════════════════════════════════════════════════════════════

function VoicingControls({ regMode, setRegMode, compact }: {
  regMode: string; setRegMode: (v: string) => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "flex gap-3 flex-wrap items-end" : "space-y-3"}>
      <div>
        <label className="text-xs text-[#888] block mb-1">Register</label>
        <select value={regMode} onChange={e => setRegMode(e.target.value)}
          className="w-full bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-xs text-white focus:outline-none">
          {REGISTER_MODES.map(m => <option key={m}>{m}</option>)}
        </select>
      </div>
    </div>
  );
}

// 7th is omitted here — the 7th of a chord is already expressed via the
// seventh-chord voicing patterns (1 3 5 7, etc.), so exposing it as a
// generic extension would add it twice.
const EXTENSION_LABELS_UI = ["2nd", "4th", "6th", "9th", "11th", "13th"];
const EXT_COUNTS = [1, 2, 3, 4];

function ExtensionControls({ extTendency, setExtTendency, checkedExts, setCheckedExts, checkedExtCounts, setCheckedExtCounts, toggleSet }: {
  extTendency: string; setExtTendency: (v: string) => void;
  checkedExts: Set<string>; setCheckedExts: (s: Set<string>) => void;
  checkedExtCounts: Set<number>; setCheckedExtCounts: (s: Set<number>) => void;
  toggleSet: <T>(s: Set<T>, v: T) => Set<T>;
}) {
  const tendencyOpts: { value: string; color: string; desc: string }[] = [
    { value: "Any",    color: "#9999ee", desc: "Any extension allowed" },
    { value: "Stable", color: "#7aaa6a", desc: "Prefer stable (chord-tone-ish) extensions" },
    { value: "Avoid",  color: "#c06060", desc: "Prefer avoid-note extensions" },
  ];
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs text-[#888] mb-1.5 font-medium">EXT TENDENCY</p>
        <div className="flex flex-wrap gap-1">
          {tendencyOpts.map(o => {
            const on = extTendency === o.value;
            return (
              <button key={o.value} onClick={() => setExtTendency(o.value)} title={o.desc}
                className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                  on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: o.color + "30", borderColor: o.color, color: o.color } : {}}>
                {o.value}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <p className="text-xs text-[#888] mb-1.5 font-medium">EXTENSIONS</p>
        <div className="flex flex-wrap gap-1">
          {EXTENSION_LABELS_UI.map(lbl => {
            const on = checkedExts.has(lbl);
            const color = "#b07acc";
            return (
              <button key={lbl} onClick={() => setCheckedExts(toggleSet(checkedExts, lbl))}
                className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                  on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
                {lbl}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <p className="text-xs text-[#888] mb-1.5 font-medium"># EXTENSIONS</p>
        <div className="flex flex-wrap gap-1">
          {EXT_COUNTS.map(n => {
            const on = checkedExtCounts.has(n);
            const color = "#c8a860";
            return (
              <button key={n} onClick={() => setCheckedExtCounts(toggleSet(checkedExtCounts, n))}
                className={`px-2 py-1 text-[10px] rounded border transition-colors min-w-[28px] ${
                  on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
                {n}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function VoicingPatternControls({ checkedPatterns, setCheckedPatterns, toggleSet, betaMode = false }: {
  checkedPatterns: Set<string>; setCheckedPatterns: (s: Set<string>) => void;
  toggleSet: <T>(s: Set<T>, v: T) => Set<T>;
  betaMode?: boolean;
}) {
  const selectGroup = (g: string) => {
    const ids = ALL_VOICING_PATTERNS.filter(p => p.group === g).map(p => p.id);
    const n = new Set(checkedPatterns); ids.forEach(id => n.add(id)); setCheckedPatterns(n);
  };
  const deselectGroup = (g: string) => {
    const ids = new Set(ALL_VOICING_PATTERNS.filter(p => p.group === g).map(p => p.id));
    const n = new Set(checkedPatterns); ids.forEach(id => n.delete(id)); setCheckedPatterns(n);
  };

  const totalChecked = ALL_VOICING_PATTERNS.filter(p => checkedPatterns.has(p.id)).length;
  // Sus2 and Sus4 are merged into a single "Sus" section with sub-tabs;
  // every other group still gets its own outer block.  Quartal /
  // Quintal / Sus voicings are gated behind beta — they're advanced
  // colour voicings most users won't reach for in everyday chord
  // training, so the standard view stays focused on inversions.
  const SUS_GROUPS = ["Sus2", "Sus4"];
  const BETA_ONLY_GROUPS = new Set(["Quartal", "Quintal", "Sus2", "Sus4"]);
  const nonSus = VOICING_PATTERN_GROUPS
    .filter(g => !SUS_GROUPS.includes(g))
    .filter(g => betaMode || !BETA_ONLY_GROUPS.has(g));
  const susAvailable = SUS_GROUPS.filter(g => ALL_VOICING_PATTERNS.some(p => p.group === g));
  const [susTab, setSusTab] = useState<string>(susAvailable[0] ?? "Sus2");
  const susTabPatterns = ALL_VOICING_PATTERNS.filter(p => p.group === susTab);
  const susTotalCount = SUS_GROUPS.reduce(
    (acc, g) => acc + ALL_VOICING_PATTERNS.filter(p => p.group === g && checkedPatterns.has(p.id)).length,
    0,
  );

  const renderGroup = (g: string) => {
    const patterns = ALL_VOICING_PATTERNS.filter(p => p.group === g);
    const count = patterns.filter(p => checkedPatterns.has(p.id)).length;
    return (
      <div key={g} className="flex flex-col">
        <div className="flex items-center gap-1.5 mb-1">
          <p className="text-[10px] text-[#888] font-medium uppercase tracking-wide">
            {g}{count > 0 && <span className="ml-1 text-[#7173e6] font-normal">({count})</span>}
          </p>
          <button onClick={() => selectGroup(g)}
            className="text-[9px] text-[#555] hover:text-[#9999ee] border border-[#222] rounded px-1 py-0.5">All</button>
          <button onClick={() => deselectGroup(g)}
            className="text-[9px] text-[#555] hover:text-[#e06060] border border-[#222] rounded px-1 py-0.5">None</button>
        </div>
        <div className="flex flex-wrap gap-1">
          {patterns.map(p => {
            const on = checkedPatterns.has(p.id);
            const color = "#9999ee";
            return (
              <button key={p.id} onClick={() => setCheckedPatterns(toggleSet(checkedPatterns, p.id))}
                className={`px-1.5 py-0.5 text-[10px] font-mono rounded border transition-colors ${
                  on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
                {p.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div>
      <p className="text-xs text-[#888] mb-1 font-medium">VOICINGS <span className="text-[#555] font-normal">({totalChecked} selected)</span></p>
      <div className="flex flex-wrap gap-x-6 gap-y-3 items-start">
        {nonSus.map(g => {
          // Force 3rd Inversion onto its own row beneath 2nd Inversion.
          const node = renderGroup(g);
          if (g === "3rd Inversion") {
            return (
              <div key={`break-${g}`} className="flex flex-wrap gap-x-6 gap-y-3" style={{ flexBasis: "100%" }}>
                {node}
              </div>
            );
          }
          return node;
        })}
        {betaMode && susAvailable.length > 0 && (
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5 mb-1">
              <p className="text-[10px] text-[#888] font-medium uppercase tracking-wide">
                SUS{susTotalCount > 0 && <span className="ml-1 text-[#7173e6] font-normal">({susTotalCount})</span>}
              </p>
              {susAvailable.map(g => {
                const active = susTab === g;
                const groupCount = ALL_VOICING_PATTERNS.filter(p => p.group === g && checkedPatterns.has(p.id)).length;
                return (
                  <button key={g} onClick={() => setSusTab(g)}
                    className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
                      active ? "text-[#9999ee] border-[#7173e6] bg-[#7173e618]"
                             : "text-[#555] border-[#222] hover:text-[#aaa]"
                    }`}>
                    {g}{groupCount > 0 && <span className="ml-1 text-[#7173e6]">({groupCount})</span>}
                  </button>
                );
              })}
              <button onClick={() => selectGroup(susTab)}
                className="text-[9px] text-[#555] hover:text-[#9999ee] border border-[#222] rounded px-1 py-0.5">All</button>
              <button onClick={() => deselectGroup(susTab)}
                className="text-[9px] text-[#555] hover:text-[#e06060] border border-[#222] rounded px-1 py-0.5">None</button>
            </div>
            <div className="flex flex-wrap gap-1">
              {susTabPatterns.map(p => {
                const on = checkedPatterns.has(p.id);
                const color = "#9999ee";
                return (
                  <button key={p.id} onClick={() => setCheckedPatterns(toggleSet(checkedPatterns, p.id))}
                    className={`px-1.5 py-0.5 text-[10px] font-mono rounded border transition-colors ${
                      on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                    }`}
                    style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LilPreviewPanel({ checkedChords, chordMap, edo, tonicPc, lowestPitch, highestPitch, getCompatibleTypes, applyChordType }: {
  checkedChords: Set<string>; chordMap: Record<string, number[]>;
  edo: number; tonicPc: number; lowestPitch: number; highestPitch: number;
  getCompatibleTypes: (shape: number[]) => EdoChordType[];
  applyChordType: (shape: number[], type: EdoChordType) => number[];
}) {
  const [expanded, setExpanded] = useState(true);

  const results = useMemo(() => {
    const checkedRomans = Array.from(checkedChords).filter(r => chordMap[r]);
    const out: { rn: string; ok: boolean; warnings: LilWarning[] }[] = [];

    // Check at both the mid-pitch tonic anchor (normal placement) and the
    // lowest tonic anchor (worst case for low-interval limits).
    const lowTonic = lowestPitch + (((tonicPc - lowestPitch) % edo) + edo) % edo;
    const midPitch = Math.floor((lowestPitch + highestPitch) / 2);
    const midTonic = midPitch - (((midPitch - tonicPc) % edo) + edo) % edo;
    const tonicAnchors = [midTonic, lowTonic];

    for (const rn of checkedRomans) {
      const baseShape = chordMap[rn];
      if (!baseShape) continue;

      // Get all chord types that could be applied to this numeral
      const compatTypes = getCompatibleTypes(baseShape);
      const shapesToCheck = compatTypes.length > 0
        ? compatTypes.map(t => applyChordType(baseShape, t))
        : [baseShape];

      let worst: LilWarning[] = [];
      for (const shape of shapesToCheck) {
        const rootStep = shape[0];
        for (const tonicAbs of tonicAnchors) {
          const rootAbs = tonicAbs + rootStep;
          const chordAbs = shape.map(s => rootAbs + (s - rootStep)).sort((a, b) => a - b);
          const w = checkLowIntervalLimits(chordAbs, edo);
          if (w.length > worst.length) worst = w;
        }
      }
      out.push({ rn, ok: worst.length === 0, warnings: worst });
    }
    return out;
  }, [checkedChords, chordMap, edo, tonicPc, lowestPitch, highestPitch, getCompatibleTypes, applyChordType]);

  const problemCount = results.filter(r => !r.ok).length;

  return (
    <div className="flex flex-col h-full">
      <button onClick={() => setExpanded(!expanded)}
        style={{
          padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700,
          border: `1.5px solid ${problemCount > 0 ? "#e06060" : "#2a3a2a"}`,
          background: problemCount > 0 ? "#e0606018" : "#0e1a0e",
          color: problemCount > 0 ? "#e06060" : "#5a8a5a",
          cursor: "pointer", transition: "all 0.15s",
          letterSpacing: 0.5,
        }}>
        ⚠ LIL {problemCount > 0 ? `(${problemCount} at risk)` : "(all clear)"}
        <span style={{ marginLeft: 4, fontSize: 8, color: "#555" }}>{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="mt-2 bg-[#0e0e0e] border border-[#1a1a1a] rounded p-2 space-y-0.5 flex-1"
          style={{ overflowY: "auto" }}>
          {results.map(({ rn, ok, warnings }) => (
            <div key={rn} className="flex items-start gap-2 text-[11px] font-mono"
              style={{ color: ok ? "#4a6a4a" : "#e06060", padding: "1px 0" }}>
              <span style={{ minWidth: 48, fontWeight: 600 }}>{formatRomanNumeral(rn)}</span>
              {ok
                ? <span style={{ color: "#3a5a3a" }}>OK</span>
                : <span>{warnings.map(w => {
                    const gapName = intervalLabel(w.gapSteps, edo);
                    const minName = intervalLabel(w.minSteps, edo);
                    return `${gapName} in ${w.region} (need ≥ ${minName})`;
                  }).join("; ")}</span>
              }
            </div>
          ))}
          {results.length === 0 && (
            <p className="text-[10px] text-[#444]">No chords selected.</p>
          )}
        </div>
      )}
    </div>
  );
}

// Per-kind colors matching MelodicPatterns' xen toggles
const XEN_QUALITY_COLOR: Record<string, string> = {
  sub3:    "#7aaa6a", // subminor — green
  clmin3:  "#7aaa6a",
  neu3:    "#9a66c0", // neutral — purple
  clmaj3:  "#cc6a8a",
  sup3:    "#cc6a8a", // supermajor — pink
  qrt:     "#4a9ac7", // quartal — teal
  qnt:     "#c8aa50", // quintal — amber
};
// Short labels for xen 3rd toggles under each numeral.
const XEN_SHORT_LABEL: Record<string, string> = {
  sub3: "sub",
  clmin3: "cl.min",
  neu3: "neu",
  clmaj3: "cl.maj",
  sup3: "sup",
};
// Voicing-style xen toggles: not 3rd-quality alterations (they replace
// the chord's interval stack), so they're surfaced separately from the
// catalog-derived quality buttons but live in the same xenByTonality
// map.  Engine wiring: the chord-pool builder substitutes the parent
// chord's shape with a quartal/quintal stack when the variant is picked.
// The UI exposes them as a single combined "qua/quin" button — toggling
// adds/removes both stack variants together.

function ChordSelectionPanel({
  tonality, accent, familyPrefix, bank, edo, chordMap, checkedSet, toggleChord, setLevel,
  collapsedLevels, toggleLevel, approachMap, toggleApproach,
  xenMap, toggleXen, toggleXenStack,
}: {
  tonality: string;
  accent: string;
  familyPrefix: string | null;
  bank: TonalityBank;
  edo: number;
  chordMap: Record<string, number[]>;
  checkedSet: Set<string>;
  toggleChord: (label: string) => void;
  setLevel: (chords: ChordEntry[], select: boolean) => void;
  collapsedLevels: Set<string>;
  toggleLevel: (name: string) => void;
  approachMap: Record<string, ApproachKind[]>;
  toggleApproach: (target: string, kind: ApproachKind) => void;
  xenMap: Record<string, string[]>;
  toggleXen: (numeral: string, xenId: string) => void;
  toggleXenStack: (numeral: string) => void;
}) {
  // Xen 3rd qualities available in this EDO (everything not in the
  // standard set: subminor, neutral, supermajor, classical min/maj for
  // 41-EDO, etc.).  Filtering the per-chord options against this list
  // keeps 41-EDO's classical thirds alongside 31-EDO's neu/sub/sup.
  const xenThirds = useMemo(
    () => getAvailableThirdQualities(edo).filter(q => !STANDARD_THIRD_QUALITIES.has(q.id)),
    [edo],
  );

  // Per-target approach toggles replace the standalone approach levels.
  // Modal Interchange ships its own borrowed-chord rows alongside Primary
  // and Diatonic; the auto-generated approach levels stay hidden.
  const VISIBLE_LEVELS = new Set(["Primary", "Diatonic", "Modal Interchange"]);
  const APPROACH_COLORS: Record<ApproachKind, string> = {
    secdom: "#c77a4a",
    secdim: "#a86bb8",
    iiV:    "#4a9ac7",
    TT:     "#c7a14a",
  };
  const visibleLevels = bank.levels.filter(l => VISIBLE_LEVELS.has(l.name));
  return (
    <div className="border rounded overflow-hidden" style={{ borderColor: accent + "40" }}>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#0a0a0a]">
        <span className="text-[11px] font-semibold tracking-wide" style={{ color: accent, textTransform: "none" }}>{formatHalfAccidentals(tonality, edo)}</span>
      </div>
      <div className="space-y-2 p-2">
        {visibleLevels.map(level => {
          const collapseKey = `${tonality}::${level.name}`;
          const isCollapsed = collapsedLevels.has(collapseKey);
          const allChecked = level.chords.every(c => checkedSet.has(c.label));
          const someChecked = level.chords.some(c => checkedSet.has(c.label));
          return (
            <div key={level.name} className="border border-[#1a1a1a] rounded overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[#0e0e0e] cursor-pointer select-none"
                onClick={() => toggleLevel(collapseKey)}>
                <span className="text-[10px] text-[#555] w-3">{isCollapsed ? "▸" : "▾"}</span>
                <span className="text-xs text-[#888] font-medium flex-1">{level.name}</span>
                <span className="text-[10px] text-[#444]">{level.chords.filter(c => checkedSet.has(c.label)).length}/{level.chords.length}</span>
                <button onClick={e => { e.stopPropagation(); setLevel(level.chords, !allChecked); }}
                  className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                    allChecked ? "" : someChecked ? "border-[#444] text-[#888]" : "border-[#222] text-[#555]"
                  }`}
                  style={allChecked ? { borderColor: accent, color: accent } : undefined}>
                  {allChecked ? "Clear" : "All"}
                </button>
              </div>
              {!isCollapsed && (
                <div className="grid gap-1 p-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 auto-rows-fr">
                  {level.chords.map(entry => {
                    const isChecked = checkedSet.has(entry.label);
                    const enabledApproaches = new Set(approachMap[entry.label] ?? []);
                    // Tonic doesn't need its own approach toggles — V/I,
                    // vii°/I, ii-V→I, and TT/I are already covered by V,
                    // vii°, the cadence flow, and bII respectively.
                    // Detect by label (handles Major's null-steps refs)
                    // plus by root step (handles explicit-shape banks).
                    const TONIC_LABELS = new Set(["I", "i", "I°", "i°", "I+", "i+"]);
                    const isTonic = TONIC_LABELS.has(entry.label) || (entry.steps != null && entry.steps[0] === 0);
                    const showApproaches = !isTonic && level.name !== "Modal Interchange";
                    return (
                      <div key={entry.label}
                        className="rounded overflow-hidden border transition-colors flex flex-col h-full"
                        style={isChecked
                          ? { background: accent + "30", borderColor: accent }
                          : { background: "#141414", borderColor: "#1a1a1a" }}>
                        <button onClick={() => toggleChord(entry.label)}
                          className={`flex-1 w-full px-2 py-1.5 text-base font-semibold text-left transition-colors ${
                            isChecked ? "" : "text-[#666] hover:text-[#888]"
                          }`}
                          style={isChecked ? { color: accent } : undefined}>
                          {formatRomanNumeralWithFamily(entry.label, familyPrefix)}
                        </button>
                        <div className="flex flex-col gap-0.5">
                          {showApproaches && (
                            <div className="flex gap-0.5 px-1 pt-1">
                              {APPROACH_KINDS.map(k => {
                                const on = enabledApproaches.has(k);
                                const color = APPROACH_COLORS[k];
                                return (
                                  <button key={k}
                                    onClick={() => isChecked ? toggleApproach(entry.label, k) : toggleChord(entry.label)}
                                    title={isChecked ? `${APPROACH_LABELS[k]}${entry.label}` : `Click to enable ${entry.label}`}
                                    className={`flex-1 min-h-[24px] text-[10px] leading-tight px-1 py-1 rounded border transition-colors ${
                                      !isChecked ? "bg-[#141414] text-[#555] border-[#222] hover:text-[#aaa] hover:border-[#444]"
                                      : on ? "text-black font-semibold"
                                      : "bg-[#1a1a1a] text-[#888] border-[#333] hover:text-[#ddd] hover:border-[#555]"
                                    }`}
                                    style={isChecked && on ? { background: color, borderColor: color } : undefined}>
                                    {APPROACH_LABELS[k]}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          {/* Xen 3rd-quality + qua/quin toggles removed —
                              the new septimal/neutral tonality families
                              (Subminor / Neutral / Supermajor Diatonic)
                              cover the same chord variants at the
                              tonality level instead of per-numeral. */}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
