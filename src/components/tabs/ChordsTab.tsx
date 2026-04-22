import { useState, useRef, useEffect, useMemo, useCallback } from "react";
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
  getAvailableThirdQualities, getAvailableSeventhQualities, getAvailableFifthQualities,
  computeFifthQuality,
} from "@/lib/edoData";
import { getTonalityBanks, getMagicModeBank, getTonalityNames, type TonalityBank, type ChordEntry } from "@/lib/tonalityBanks";
import { formatRomanNumeral } from "@/lib/formatRoman";

interface Props {
  tonicPc: number;
  lowestOct: number;
  highestOct: number;
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
}

const REGISTER_MODES = ["Fixed Register","Random Bass Octave","Random Full Register"];

// Chord-type tier ordering for the Progressions selector.
// Classification walks 3rd by 3rd outward from the roman numeral's natural
// 3rd: exact match → any diatonic (m3/M3/sus) → xenharmonic same side → xen
// opposite side.  See `classifyChordType` below for the side/diatonic rules.
const CHORD_TYPE_MODES = ["diatonic", "chromatic-diatonic", "diatonic-xen", "chromatic-xen"] as const;
type ChordTypeMode = typeof CHORD_TYPE_MODES[number];
const CHORD_TYPE_MODE_LABELS: Record<ChordTypeMode, string> = {
  "diatonic":           "Diatonic",
  "chromatic-diatonic": "Chromatic Diatonic",
  "diatonic-xen":       "Diatonic Xenharmonic",
  "chromatic-xen":      "Chromatic Xenharmonic",
};
const CHORD_TYPE_MODE_HINTS: Record<ChordTypeMode, string> = {
  "diatonic":           "Exact match on 3rd, 5th, and 7th for each roman numeral's diatonic chord.",
  "chromatic-diatonic": "Plays any chord whose 3rd, 5th, and 7th are in your selected qualities, built on each roman numeral's root.",
  "diatonic-xen":       "Same as Chromatic, but restricted to xenharmonic chord types on the same side (major/minor) as the roman numeral.",
  "chromatic-xen":      "Same as Chromatic, but restricted to xenharmonic chord types on the opposite side from the roman numeral.",
};

export default function ChordsTab({
  tonicPc, lowestOct, highestOct, edo, onHighlight, responseMode, onResult, onPlay, lastPlayed, ensureAudio, playVol = 0.55, layoutPitchRange, tabSettingsRef, answerButtons
}: Props) {
  const frameTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ── Chord selection state ───────────────────────────────────────────
  const [checkedChords, setCheckedChords] = useLS<Set<string>>("lt_crd_chords",
    new Set(["I","IV","V","vi","ii","iii","vii°"])
  );
  const [regMode, setRegMode] = useLS<string>("lt_crd_regMode", "Fixed Register");
  const [extTendency, setExtTendency] = useLS<string>("lt_crd_extTend", "Any");
  // "7th" is intentionally excluded from the extension UI — the 7th is
  // already carried by seventh-chord voicing patterns (1 3 5 7, etc.).
  // Default is empty so nothing is added on top of the triad/7th voicing.
  const [checkedExts, setCheckedExts] = useLS<Set<string>>("lt_crd_exts", new Set());
  const [checkedExtCounts, setCheckedExtCounts] = useLS<Set<number>>("lt_crd_extCounts", new Set([0, 1]));
  const [checkedPatterns, setCheckedPatterns] = useLS<Set<string>>("lt_crd_vpatterns", new Set(["t-135"]));
  // Quality filters — which 3rd/5th/7th qualities are allowed in the pool.
  // Triads always pass the 3rd+5th gate; seventh chords additionally require
  // their 7th quality to be checked. An empty checkedSevenths means "no
  // seventh chords" (triads only).
  const [checkedThirds, setCheckedThirds] = useLS<Set<string>>("lt_crd_thirds",
    new Set(["min3", "maj3"]));
  const [checkedFifths, setCheckedFifths] = useLS<Set<string>>("lt_crd_fifths",
    new Set(["P5", "dim5", "aug5"]));
  const [checkedSevenths, setCheckedSevenths] = useLS<Set<string>>("lt_crd_sevenths",
    new Set(["min7", "maj7", "dim7"]));
  // Chord-type progression mode for Progressions.  Four tiers,
  // classified by the candidate's 3rd relative to the roman numeral's 3rd:
  //   "diatonic"            — exact match (IV → IV only)
  //   "chromatic-diatonic"  — any standard m3/M3/sus type, regardless of
  //                            numeral (IV → IV, IV7, iv, iv7, IVsus, …)
  //   "diatonic-xen"        — xenharmonic 3rds on the SAME side as the
  //                            numeral (IV → IV-neutral, IV-supermaj, …)
  //   "chromatic-xen"       — xenharmonic 3rds on the OPPOSITE side
  //                            (IV → iv-subminor, …)
  // Legacy values ("any"/"by-third") are migrated on load.
  const [chordTypeModeRaw, setChordTypeModeRaw] = useLS<string>("lt_crd_chordTypeMode", "chromatic-diatonic");
  const chordTypeModeResolved: ChordTypeMode =
    chordTypeModeRaw === "any"      ? "chromatic-diatonic" :
    chordTypeModeRaw === "by-third" ? "diatonic" :
    (CHORD_TYPE_MODES as readonly string[]).includes(chordTypeModeRaw)
      ? (chordTypeModeRaw as ChordTypeMode)
      : "chromatic-diatonic";
  // 12 EDO has no xenharmonic chord types, so the xen tiers collapse to
  // their non-xen counterparts.
  const chordTypeMode: ChordTypeMode =
    edo === 12 && (chordTypeModeResolved === "diatonic-xen" || chordTypeModeResolved === "chromatic-xen")
      ? "chromatic-diatonic"
      : chordTypeModeResolved;
  const setChordTypeMode = (m: ChordTypeMode) => setChordTypeModeRaw(m);

  // Tonality state
  const [tonality, setTonality] = useLS<string>("lt_crd_tonality", "Major");
  const [collapsedLevels, setCollapsedLevels] = useState<Set<string>>(new Set());

  // ── Progression state ──────────────────────────────────────────────
  const [loopLength, setLoopLength] = useLS<number>("lt_crd_fh_len", 4);
  const [loopGap, setLoopGap] = useLS<number>("lt_crd_fh_gap", 1.5);
  const [chordDur, setChordDur] = useLS<number>("lt_crd_fh_dur", 0.65);
  const [isLooping, setIsLooping] = useState(false);
  const loopTimerId = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoopingRef = useRef(false);
  const [currentLoop, setCurrentLoop] = useState<string[] | null>(null);
  const [loopInfo, setLoopInfo] = useState<string>("");
  const [fhDetailInfo, setFhDetailInfo] = useState<string>("");
  const [fhShowAnswer, setFhShowAnswer] = useState(false);
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
  const [arpEnabled, setArpEnabled] = useLS<boolean>("lt_crd_arp_enabled", false);
  const [arpBpm, setArpBpm] = useLS<number>("lt_crd_arp_bpm", 100);
  const [passingTones, setPassingTones] = useLS<boolean>("lt_crd_passing_tones", false);
  const fhVoicesRef = useRef<{ chords: number[][]; bass: number[][]; melody: number[][]; appliedShapes: (number[] | null)[] } | null>(null);

  useEffect(() => { isLoopingRef.current = isLooping; }, [isLooping]);

  useEffect(() => {
    unregisterKnownOptionsForPrefix("crd:");
    Array.from(checkedChords).forEach(rn => {
      registerKnownOption(`crd:fh:${rn}`, `Chords: ${rn}`);
    });
    return () => unregisterKnownOptionsForPrefix("crd:");
  }, [checkedChords]);

  // Publish settings snapshot for history panel
  useEffect(() => {
    if (!tabSettingsRef) return;
    const voicingLabels = ALL_VOICING_PATTERNS.filter(p => checkedPatterns.has(p.id)).map(p => p.label);
    const extLabels = Array.from(checkedExts);
    const extCountLabels = Array.from(checkedExtCounts).sort().map(String);
    const texLayerLabels = Array.from(textureLayers);

    tabSettingsRef.current = {
      title: "Progressions",
      groups: [
        { label: "Roman Numerals", items: Array.from(checkedChords) },
        { label: "Ext Tendency", items: [extTendency] },
        { label: "Voicings", items: voicingLabels },
        { label: "Extensions", items: extLabels.length ? extLabels : ["none"] },
        { label: "# Extensions", items: extCountLabels },
        { label: "Tier", items: [CHORD_TYPE_MODE_LABELS[chordTypeMode]] },
        { label: "3rds", items: Array.from(checkedThirds) },
        { label: "5ths", items: Array.from(checkedFifths) },
        { label: "7ths", items: Array.from(checkedSevenths) },
        { label: "Settings", items: [
          `Loop: ${loopLength}`,
          `Spacing: ${loopGap}s`,
          `Duration: ${chordDur}s`,
          `Register: ${regMode}`,
          `Layers: ${texLayerLabels.join(", ") || "Harmony"}`,
          `Tonality: ${tonality}`,
        ]},
      ],
    };
  }, [checkedChords, extTendency, checkedPatterns, checkedExts, checkedExtCounts,
      checkedThirds, checkedFifths, checkedSevenths, chordTypeMode, loopLength, loopGap, chordDur, regMode, textureLayers, tonality, edo, tabSettingsRef]);

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

  // Get active tonality bank
  const tonalityBanks = useMemo(() => getTonalityBanks(edo), [edo]);
  const magicBank = useMemo(() => getMagicModeBank(edo), [edo]);
  const tonalityNames = useMemo(() => getTonalityNames(edo), [edo]);

  const activeBank: TonalityBank | null = useMemo(() => {
    if (tonality === "Magic Mode") return magicBank;
    return tonalityBanks.find(b => b.name === tonality) ?? tonalityBanks[0] ?? null;
  }, [tonality, tonalityBanks, magicBank]);

  // Merge tonality-specific chord shapes into base map
  const chordMap = useMemo(() => {
    const map = { ...baseChordMap };
    if (activeBank) {
      for (const level of activeBank.levels) {
        for (const entry of level.chords) {
          if (entry.steps && !map[entry.label]) {
            map[entry.label] = entry.steps;
          }
        }
      }
    }
    return map;
  }, [baseChordMap, activeBank]);

  // Filter chords by whether their type matches the checked chord types
  const edoChordTypes = useMemo(() => getEdoChordTypes(edo), [edo]);

  // Diatonic scale roots for the active tonality, sorted ascending pc. Used
  // to compute the natural 7th on each scale degree so "1 3 5 7" voicings
  // respect the key (e.g. I → Imaj7 in Major, V → V7, never Vmaj7).
  // Bank entries often have steps=null (ref lookups) so resolve each label
  // through chordMap — which already merges baseChordMap with bank overrides.
  const diatonicScaleRoots = useMemo<number[] | null>(() => {
    if (!activeBank) return null;
    const roots = new Set<number>();
    for (const level of activeBank.levels) {
      if (level.name !== "Primary" && level.name !== "Diatonic") continue;
      for (const c of level.chords) {
        const steps = c.steps ?? chordMap[c.label];
        if (steps && steps.length > 0) {
          roots.add(((steps[0] % edo) + edo) % edo);
        }
      }
    }
    if (roots.size !== 7) return null;
    return Array.from(roots).sort((a, b) => a - b);
  }, [activeBank, chordMap, edo]);

  // Get the pool of checked chord types that are compatible with a roman numeral's shape.
  // Returns the matching types so the caller can pick one and rebuild the chord.
  //
  // Both the 3rd AND (for seventh chords) the 7th feed classification:
  //   diatonic            → 3rd exactly matches the numeral's 3rd.  If the
  //                         numeral shape already carries a 7th, the
  //                         candidate's 7th must match exactly too; if the
  //                         numeral is a triad, only triad candidates qualify
  //                         (so "V diatonic" doesn't quietly add a 7th —
  //                         pick "V7" as the numeral for that).
  //   chromatic-diatonic  → every component is a standard 12-EDO interval:
  //                         3rd ∈ {m3, M3, M2, P4}, 7th ∈ {m7, M7, dim7}.
  //                         Any numeral pairs with any such type (IV → IV,
  //                         IV7, iv, iv7, IVsus, …).
  //   diatonic-xen        → at least one component is xenharmonic AND the
  //                         type's side (major/minorish) matches the
  //                         numeral's side.  E.g. IV (major-side) →
  //                         IVneutral, IVsupermaj.
  //   chromatic-xen       → at least one xen component AND opposite side.
  //                         E.g. IV → ivsubminor.
  //
  // Side of a type: if its 3rd is xen, use the 3rd's nearest-standard side;
  // else if its 7th is xen, use the 7th's side; else the 3rd's side (only
  // reached when fully standard, in which case the xen tiers exclude it).
  const getCompatibleTypes = useCallback((shape: number[]): EdoChordType[] => {
    const root = shape[0];
    const rels = shape.map(s => ((s - root) % edo + edo) % edo).sort((a, b) => a - b);
    const chordThird   = rels.length >= 2 ? rels[1] : -1;
    const chordFifth   = rels.length >= 3 ? rels[2] : null;
    const chordSeventh = rels.length >= 4 ? rels[3] : null;
    const { m3: minThird, M3: majThird, m7: min7th, M7: maj7th, M2, P4, A1 } = getChordShapes(edo);
    const dim7 = min7th - A1;

    const numeralIsMajor = Math.abs(chordThird - majThird) <= Math.abs(chordThird - minThird);
    const isStdThird   = (th: number) => th === majThird || th === minThird || th === M2 || th === P4;
    const isStd7th     = (sv: number) => sv === maj7th || sv === min7th || sv === dim7;
    const sideOfThird  = (th: number) => Math.abs(th - majThird) <= Math.abs(th - minThird);
    const sideOf7th    = (sv: number) => Math.abs(sv - maj7th) <= Math.abs(sv - min7th);

    // Diatonic 7th above this root in the current tonality, if the root is
    // a scale degree. Used to force "1 3 5 7" voicings on triads to match
    // the key (I → Imaj7 in major, V → V7, etc.) rather than softening to
    // "any m7/M7".
    const rootNorm = ((root % edo) + edo) % edo;
    let diatonicSeventh: number | null = null;
    if (diatonicScaleRoots) {
      const idx = diatonicScaleRoots.indexOf(rootNorm);
      if (idx >= 0) {
        const seventhRoot = diatonicScaleRoots[(idx + 6) % diatonicScaleRoots.length];
        diatonicSeventh = ((seventhRoot - rootNorm) % edo + edo) % edo;
      }
    }

    // Quality-filter gate: 3rd + 5th must be in the user's checked sets,
    // and either the 7th quality is checked (for seventh chords) or `no7`
    // is checked (for triads).
    const qualityAllows = (t: EdoChordType): boolean => {
      if (t.thirdQuality && !checkedThirds.has(t.thirdQuality)) return false;
      const fifthStep = t.steps.length >= 3 ? t.steps[2] : null;
      if (fifthStep !== null) {
        const fq = computeFifthQuality(fifthStep, edo);
        if (!checkedFifths.has(fq)) return false;
      }
      if (t.category === "seventh") {
        if (!t.seventhQuality || !checkedSevenths.has(t.seventhQuality)) return false;
      }
      return true;
    };

    return edoChordTypes.filter(t => {
      if (!qualityAllows(t)) return false;
      const tThird   = t.third;
      const tFifth   = t.steps.length >= 3 ? t.steps[2] : null;
      const tSeventh = t.category === "seventh" ? t.steps[3] : null;
      const t3rdStd  = isStdThird(tThird);
      const t7thStd  = tSeventh === null ? true : isStd7th(tSeventh);
      const tAllStd  = t3rdStd && t7thStd;
      // Side: 3rd is the dominant signal; fall back to 7th only when the 3rd
      // is standard.  Standard-3rd + xen-7th types (e.g. min_h7) get their
      // side from the 7th so they land on the right xen tier.
      const tSide = !t3rdStd ? sideOfThird(tThird)
                   : (tSeventh !== null && !t7thStd) ? sideOf7th(tSeventh)
                   : sideOfThird(tThird);

      switch (chordTypeMode) {
        case "diatonic": {
          // Sus types always allowed on any side (triads only — a seventh
          // sus would need a scale-aware 7th choice we don't have here).
          if (tThird === M2 || tThird === P4) return tSeventh === null;
          const thirdMatches = tThird === chordThird;
          if (!thirdMatches) return false;
          // Require the 5th to match too — otherwise "Diminished" matches
          // vi (same m3, different 5th) and "Augmented" matches IV, producing
          // non-diatonic chord qualities.
          if (chordFifth !== null && tFifth !== null && tFifth !== chordFifth) return false;
          if (chordSeventh === null) {
            if (tSeventh === null) return true;
            // Scale-degree root: require the exact diatonic 7th for the key
            // (e.g. I in major → M7 only, never m7).
            if (diatonicSeventh !== null) return tSeventh === diatonicSeventh;
            // Non-scale root (e.g. secondary dominant targets that aren't
            // triad-built): fall back to standard m7/M7.
            return tSeventh === maj7th || tSeventh === min7th;
          }
          // 7th numeral: require exact 7th match.
          return tSeventh !== null && tSeventh === chordSeventh;
        }
        case "chromatic-diatonic":
          return tAllStd;
        case "diatonic-xen":
          return !tAllStd && tSide === numeralIsMajor;
        case "chromatic-xen":
          return !tAllStd && tSide !== numeralIsMajor;
      }
    });
  }, [edo, edoChordTypes, checkedThirds, checkedFifths, checkedSevenths, chordTypeMode, diatonicScaleRoots]);

  // Build a chord shape by applying a chord type's intervals to a roman numeral's root
  const applyChordType = useCallback((shape: number[], type: EdoChordType): number[] => {
    const root = shape[0];
    return type.steps.map(s => root + s);
  }, []);

  // Check if any chord type is compatible (for filtering the roman numeral pool)
  const chordMatchesType = useCallback((shape: number[]): boolean => {
    return getCompatibleTypes(shape).length > 0;
  }, [getCompatibleTypes]);

  // Roman numerals that actually have at least one compatible chord type
  // under the current 3rd/5th/7th + tier selection. Empty → Play is
  // disabled with a hint telling the user to broaden their filters.
  const playablePool = useMemo(() => {
    return Array.from(checkedChords).filter(rn => {
      const shape = chordMap[rn];
      return shape ? chordMatchesType(shape) : false;
    });
  }, [checkedChords, chordMap, chordMatchesType]);

  // Whether any selected voicing pattern is playable under the current
  // 7th selection. If the user hasn't checked any 7ths, patterns that
  // require ≥4 notes (like "1 3 5 7") can't be realized as triads, so
  // they drop out and the Play button needs to grey out if nothing is
  // left.
  const hasPlayableVoicing = useMemo(() => {
    const counts = Array.from(ALL_VOICING_PATTERNS)
      .filter(p => checkedPatterns.has(p.id))
      .flatMap(p => {
        const lo = p.minNotes;
        const hi = p.maxNotes ?? 7;
        const out: number[] = [];
        for (let n = lo; n <= hi; n++) out.push(n);
        return out;
      });
    if (counts.length === 0) return false;
    if (checkedSevenths.size === 0) return counts.some(n => n < 4);
    return true;
  }, [checkedPatterns, checkedSevenths]);

  const canPlay = playablePool.length > 0 && hasPlayableVoicing;
  const disabledReason =
    playablePool.length === 0
      ? "No suitable chord pool — loosen 3rd/5th/7th or switch tier."
      : !hasPlayableVoicing
        ? "No triad voicing selected — pick a 3-note voicing or enable at least one 7th."
        : null;

  // When tonality changes, auto-select its primary chords
  const prevTonality = useRef(tonality);
  useEffect(() => {
    if (prevTonality.current !== tonality) {
      prevTonality.current = tonality;
      if (activeBank) {
        const primary = activeBank.levels[0];
        if (primary) {
          setCheckedChords(new Set(primary.chords.map(c => c.label)));
        }
      }
    }
  }, [tonality, activeBank, setCheckedChords]);

  // ── Shared voicing pipeline ─────────────────────────────────────────

  // Derive the set of valid note counts from the selected voicing patterns
  const patternNoteCounts = useMemo(() => {
    const counts = new Set<number>();
    for (const p of ALL_VOICING_PATTERNS) {
      if (!checkedPatterns.has(p.id)) continue;
      const lo = p.minNotes;
      const hi = p.maxNotes ?? 7;
      for (let n = lo; n <= hi; n++) counts.add(n);
    }
    return counts;
  }, [checkedPatterns]);

  const voiceChord = useCallback((rn: string, stepsOverride: number[] | null, currentChordMap: Record<string, number[]>, prevChord: number[] | null = null) => {
    // No voicing patterns selected → nothing to play
    if (patternNoteCounts.size === 0) return null;

    let shape = stepsOverride ?? currentChordMap[rn];
    if (!shape) return null;

    // Apply a random compatible chord type — if none match the user's
    // quality filters (3rd/5th/7th + tier), refuse to voice this chord
    // rather than silently falling back to the raw roman-numeral shape.
    const compatTypes = getCompatibleTypes(shape);
    if (compatTypes.length === 0) return null;
    shape = applyChordType(shape, randomChoice(compatTypes));

    // Target note count is drawn from what the selected patterns support.
    // If the user hasn't checked any 7ths, drop any ≥4-note voicings from
    // the pool so the output stays triadic.
    let validCounts = Array.from(patternNoteCounts);
    if (checkedSevenths.size === 0) validCounts = validCounts.filter(n => n < 4);
    if (validCounts.length === 0) return null;
    const targetNotes = randomChoice(validCounts);

    // If the selected voicing pattern expects a 7th (≥4 notes) but the applied
    // chord type is a triad, auto-extend with the diatonic 7th so the
    // "1 3 5 7" voicing actually has a 7th to voice. In non-diatonic modes
    // fall back to a plain minor 7th.
    if (targetNotes >= 4 && shape.length === 3) {
      const rootPc = ((shape[0] % edo) + edo) % edo;
      let seventhInterval: number | null = null;
      if (chordTypeMode === "diatonic" && diatonicScaleRoots) {
        const idx = diatonicScaleRoots.indexOf(rootPc);
        if (idx >= 0) {
          const seventhRootPc = diatonicScaleRoots[(idx + 6) % diatonicScaleRoots.length];
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
    const checkedRomans = Array.from(checkedChords).filter(r => currentChordMap[r]);
    for (const rn2 of checkedRomans) {
      for (const s of currentChordMap[rn2] ?? []) scalePcs.add(((s % edo) + edo) % edo);
    }

    const rootStep = shape[0];

    // Pick a "reference" octave to build the chord content (extension picking
    // uses absolute-pitch dedup, so we need a concrete octave for that step).
    const refOctave = lowestOct + Math.floor(Math.random() * (highestOct - lowestOct + 1));
    const refRootAbs = tonicPc + (refOctave - 4) * edo + rootStep;
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
    // can re-realize it at any candidate octave during voice-leading search.
    const relSteps = chordAbsRef.map(n => n - refRootAbs);
    const buildVoicing = (oct: number, pattern: typeof ALL_VOICING_PATTERNS[number]): number[] => {
      const rootAbs = tonicPc + (oct - 4) * edo + rootStep;
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
    // the exercise range [lowestRootAbs, highestRootAbs]. Inversions can
    // push the root above the bass, so we gate on the bass — not the root
    // — to keep the whole chord anchored in the user's window.
    const lowestRootAbs  = tonicPc + (lowestOct  - 4) * edo;
    const highestRootAbs = tonicPc + (highestOct - 4) * edo;
    const bassInRange = (voicing: number[]): boolean => {
      if (voicing.length === 0) return false;
      const low = Math.min(...voicing);
      return low >= lowestRootAbs && low <= highestRootAbs;
    };
    // How far the bass sits outside the range (0 = in range). Used as a
    // fallback tiebreaker when no candidate has its bass inside the window.
    const bassOffset = (voicing: number[]): number => {
      if (voicing.length === 0) return Infinity;
      const low = Math.min(...voicing);
      if (low < lowestRootAbs) return lowestRootAbs - low;
      if (low > highestRootAbs) return low - highestRootAbs;
      return 0;
    };

    // Enumerate every (octave, pattern) candidate in a window wider than
    // the exercise range, since inversion patterns can shift the realized
    // bass up or down from its content-root octave.
    const searchLo = lowestOct - 2;
    const searchHi = highestOct + 2;
    const allCandidates: number[][] = [];
    for (let oct = searchLo; oct <= searchHi; oct++) {
      for (const pat of compatPatterns) {
        const cand = buildVoicing(oct, pat);
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
        chordAbs = buildVoicing(refOctave, randomChoice(compatPatterns));
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
        chordAbs = buildVoicing(refOctave, randomChoice(compatPatterns));
      }
    }

    return { chordAbs, voicingType: "pattern", quality: triadQuality(shape, edo), appliedShape: [...shape] };
  }, [checkedPatterns, patternNoteCounts, checkedChords, checkedExts, checkedExtCounts, extTendency, regMode, edo, tonicPc, lowestOct, highestOct, clampToLayout, getCompatibleTypes, applyChordType, edoChordTypes, chordTypeMode, diatonicScaleRoots, checkedSevenths]);

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

  const buildLoopFrames = useCallback((progression: string[]): { chords: number[][]; bass: number[][]; melody: number[][]; appliedShapes: (number[] | null)[] } => {
    const chords: number[][] = [];
    const appliedShapes: (number[] | null)[] = [];
    // Thread each chord's voicing into the next so voiceChord can run its
    // voice-leading checklist against the previous chord's actual pitches.
    let prevVoicing: number[] | null = null;
    for (const rn of progression) {
      const result = voiceChord(rn, null, chordMap, prevVoicing);
      chords.push(result ? result.chordAbs : []);
      appliedShapes.push(result ? result.appliedShape : null);
      if (result && result.chordAbs.length > 0) prevVoicing = result.chordAbs;
    }
    const midOct = Math.floor((lowestOct + highestOct) / 2);
    // Always generate all voices so Show Answer has complete info;
    // playVoices filters by textureLayers for audio output
    const bassOct = midOct - 2;
    // Place melody above the highest chord note when possible
    const highestChordOct = chords.length > 0
      ? Math.floor(Math.max(...chords.flat()) / edo) + 4
      : midOct + 1;
    const melOct = Math.max(midOct, highestChordOct);
    const validShapes = appliedShapes.filter((s): s is number[] => s !== null);
    const bass = generateBassLine(validShapes, edo, tonicPc, bassOct, bassLineMode);
    const melody = generateMelodyLine(validShapes, edo, tonicPc, melOct, melodyMode);

    // Chords are already clamped by voiceChord — only clamp bass & melody
    const layoutMax = layoutPitchRange?.max ?? Infinity;
    for (let i = 0; i < melody.length; i++) {
      melody[i] = clampToLayout(melody[i]);
      // If clamping emptied the frame, fallback: use the highest chord note
      const subdivsMel = Math.max(1, Math.round(melody.length / chords.length));
      const chordIdxMel = Math.min(Math.floor(i / subdivsMel), chords.length - 1);
      if (melody[i].length === 0 && chords[chordIdxMel]?.length) {
        const topNote = Math.max(...chords[chordIdxMel]);
        melody[i] = [topNote + edo]; // one octave above highest chord note
      }
      // Ensure melody is always above the highest chord note
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
          // Don't go below the keyboard's lowest key
          while (n < layoutMin) n += edo;
          return n;
        });
      }
    } else {
      for (let i = 0; i < bass.length; i++) bass[i] = clampToLayout(bass[i]);
    }

    // ── Arpeggiation: replace block chords with musical broken-chord patterns ──
    // Bass note first, then chord tones in varied patterns (Alberti, ascending, etc.)
    if (arpEnabled) {
      const arpChords: number[][] = [];
      const patterns = [
        [0, 2, 1, 2],     // Alberti bass: low-high-mid-high
        [0, 1, 2, 1],     // low-mid-high-mid
        [0, 1, 2, 0],     // ascending + return
        [2, 1, 0, 1],     // descending + return
        [0, 2, 0, 1],     // bass-top-bass-mid
        [0, 1, 0, 2],     // bass-mid-bass-top
      ];
      for (let ci = 0; ci < chords.length; ci++) {
        const chord = chords[ci];
        if (chord.length === 0) { arpChords.push([], [], [], []); continue; }
        const sorted = [...chord].sort((a, b) => a - b);
        // Pick a pattern — vary per chord for musicality
        const pat = patterns[ci % patterns.length];
        for (const idx of pat) {
          const noteIdx = Math.min(idx, sorted.length - 1);
          arpChords.push([sorted[noteIdx]]);
        }
      }
      chords.length = 0;
      chords.push(...arpChords);
    }

    // ── Passing tones: add diatonic passing tones between melody notes ──
    if (passingTones && melody.length > 1) {
      const withPassing: number[][] = [];
      for (let i = 0; i < melody.length; i++) {
        withPassing.push(melody[i]);
        if (i < melody.length - 1 && melody[i].length > 0 && melody[i + 1].length > 0) {
          const from = melody[i][0];
          const to = melody[i + 1][0];
          const diff = to - from;
          // Only add passing tone if the interval is larger than a step
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
  }, [voiceChord, chordMap, bassLineMode, melodyMode, edo, tonicPc, lowestOct, highestOct, clampToLayout, layoutPitchRange, arpEnabled, passingTones]);

  /** Play all active texture voices using the multi-voice scheduler. */
  const playVoices = useCallback((voices: { chords: number[][]; bass: number[][]; melody: number[][] }, gapMs: number, noteDur: number, vol: number) => {
    const voiceList: { frames: number[][]; noteDuration: number; gain: number }[] = [];
    if (textureLayers.has("harmony") && voices.chords.length) {
      voiceList.push({ frames: voices.chords, noteDuration: noteDur, gain: vol * harmonyVol });
    }
    if (textureLayers.has("bass") && voices.bass.length) {
      voiceList.push({ frames: voices.bass, noteDuration: noteDur * 1.2, gain: vol * bassVol });
    }
    if (textureLayers.has("melody") && voices.melody.length) {
      voiceList.push({ frames: voices.melody, noteDuration: noteDur * 0.8, gain: vol * melodyVol });
    }
    if (voiceList.length === 0) return;
    audioEngine.playMultiVoice(voiceList, edo, gapMs, voices.chords.length || 1);
  }, [textureLayers, edo, harmonyVol, bassVol, melodyVol]);

  /** Build a unified highlight timeline from all voices, merging events at the same time.
   *  Only includes voices whose texture layer is active. */
  const highlightAllVoices = useCallback((voices: { chords: number[][]; bass: number[][]; melody: number[][] }, gapMs: number) => {
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    const n = voices.chords.length;
    if (n === 0) return;

    // Only include voices for active texture layers
    const activeBass = textureLayers.has("bass") ? voices.bass : [];
    const activeMelody = textureLayers.has("melody") ? voices.melody : [];

    // Figure out subdivisions for each voice
    const bassSubdivs = activeBass.length > 0 ? Math.max(1, Math.round(activeBass.length / n)) : 0;
    const melSubdivs = activeMelody.length > 0 ? Math.max(1, Math.round(activeMelody.length / n)) : 0;
    const maxSubdivs = Math.max(1, bassSubdivs, melSubdivs);
    const subGap = gapMs / maxSubdivs;

    for (let slot = 0; slot < n; slot++) {
      for (let sub = 0; sub < maxSubdivs; sub++) {
        const t = slot * gapMs + sub * subGap;
        const notes: number[] = textureLayers.has("harmony") ? [...(voices.chords[slot] || [])] : [];
        // Add bass frame for this sub-beat
        if (bassSubdivs > 0) {
          const bassIdx = slot * bassSubdivs + Math.min(sub, bassSubdivs - 1);
          if (bassIdx < activeBass.length) notes.push(...activeBass[bassIdx]);
        }
        // Add melody frame for this sub-beat
        if (melSubdivs > 0) {
          const melIdx = slot * melSubdivs + Math.min(sub, melSubdivs - 1);
          if (melIdx < activeMelody.length) notes.push(...activeMelody[melIdx]);
        }
        const id = setTimeout(() => onHighlight(notes), t);
        frameTimers.current.push(id);
      }
    }
  }, [onHighlight, textureLayers]);

  const playLoopIteration = useCallback((voices: { chords: number[][]; bass: number[][]; melody: number[][] }, gapMs: number, noteDur: number) => {
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
        const newVoices = buildLoopFrames(loop);
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

    const checkedRomans = Array.from(checkedChords).filter(r => chordMap[r]);
    if (checkedRomans.length < 2) {
      setLoopInfo("Select at least 2 chords.");
      return;
    }

    const progression = generateFunctionalLoop(checkedRomans, loopLength);
    if (!progression) {
      setLoopInfo("Could not build a valid loop from these chords.");
      return;
    }

    setCurrentLoop(progression);
    const voices = buildLoopFrames(progression);
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
      // Melody
      if (textureLayers.has("melody") && voices.melody.length > 0) {
        const subdivs = Math.max(1, Math.round(voices.melody.length / progression.length));
        const melSlice = voices.melody.slice(idx * subdivs, (idx + 1) * subdivs);
        const melNames = melSlice.map(f => f.map(n => intervalLabel(((n - tonicPc) % edo + edo) % edo, edo)).join(",")).join(" → ");
        detailLines.push(`Melody: ${melNames}`);
      }
      // "from Do" and "in context" show ONLY the chord (harmony) notes
      if (voices.chords[idx]?.length) {
        const chordRoot = applied ? tonicPc + applied[0] : tonicPc;
        const chordNotes = [...voices.chords[idx]].sort((a, b) => a - b);
        const tonicNames = chordNotes.map(n => intervalLabel(((n - tonicPc) % edo + edo) % edo, edo));
        const rootNames = chordNotes.map(n => intervalLabel(((n - chordRoot) % edo + edo) % edo, edo));
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
    setFhShowAnswer(false);
    fhFramesRef.current = voices.chords;
    fhVoicesRef.current = voices;
    lastPlayed.current = { frames: voices.chords, info };
    onPlay(`crd:fh:${info}`, `Chords: ${info}`);
    onResult(`Listen to the loop...`);

    // Play once — when arpeggiated, derive gap from BPM (each chord = 1 beat)
    const gapMs = arpEnabled ? (60000 / arpBpm) : loopGap * 1000;
    const noteDur = arpEnabled ? (60 / arpBpm) : chordDur; // quarter note duration
    setIsLooping(true);
    playVoices(voices, gapMs, noteDur, playVol * 0.7);
    // Total duration: for arpeggiated, chordCount = original progression length * 4
    const totalChords = arpEnabled ? voices.chords.length / 4 : voices.chords.length;
    const d = setTimeout(() => { setIsLooping(false); }, totalChords * gapMs + 500);
    frameTimers.current.push(d);
  }, [ensureAudio, stopLoop, checkedChords, chordMap, loopLength, loopGap, chordDur, buildLoopFrames, playVoices, onPlay, onResult, edo, tonicPc, playVol, textureLayers, arpEnabled, arpBpm]);

  const replayFunctionalLoop = useCallback(() => {
    const voices = fhVoicesRef.current;
    if (!voices || !voices.chords.length || isLooping) return;
    const gapMs = arpEnabled ? (60000 / arpBpm) : loopGap * 1000;
    const noteDur = arpEnabled ? (60 / arpBpm) * 0.25 : chordDur;
    setIsLooping(true);
    playVoices(voices, gapMs, noteDur, playVol * 0.7);
    const totalChords = arpEnabled ? voices.chords.length / 4 : voices.chords.length;
    const d = setTimeout(() => setIsLooping(false), totalChords * gapMs + 500);
    frameTimers.current.push(d);
  }, [playVoices, playVol, isLooping, loopGap, chordDur, arpEnabled, arpBpm]);

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

  const selectLevel = (chords: ChordEntry[]) => {
    setCheckedChords(prev => { const n = new Set(prev); for (const c of chords) n.add(c.label); return n; });
  };

  const deselectLevel = (chords: ChordEntry[]) => {
    const labels = new Set(chords.map(c => c.label));
    setCheckedChords(prev => { const n = new Set(prev); for (const l of labels) n.delete(l); return n; });
  };

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* Tonality selector row */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs text-[#888] font-medium">TONALITY</label>
        <select value={tonality} onChange={e => setTonality(e.target.value)}
          className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-xs text-white focus:outline-none">
          {tonalityNames.map(t => <option key={t}>{t}</option>)}
        </select>
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
                <p className="text-[10px] text-[#886622] mb-1 font-medium">TEXTURE LAYERS</p>
                <div className="flex gap-3">
                  {([
                    { layer: "harmony" as const, vol: harmonyVol, setVol: setHarmonyVol },
                    { layer: "bass" as const, vol: bassVol, setVol: setBassVol },
                    { layer: "melody" as const, vol: melodyVol, setVol: setMelodyVol },
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
              {textureLayers.has("bass") && (
                <div>
                  <p className="text-[10px] text-[#886622] mb-1 font-medium">BASS MODE</p>
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
              {textureLayers.has("melody") && (
                <div>
                  <p className="text-[10px] text-[#886622] mb-1 font-medium">MELODY MODE</p>
                  <div className="flex gap-1">
                    {(["chord-tone", "scalar", "arpeggiate"] as const).map(m => {
                      const active = melodyMode === m;
                      return (
                        <button key={m} onClick={() => setMelodyMode(m)}
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
              {/* Arpeggio + Passing Tones */}
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={arpEnabled}
                    onChange={() => setArpEnabled(!arpEnabled)}
                    className="accent-[#e0a040]" />
                  <span className="text-xs" style={{ color: arpEnabled ? "#e0a040" : "#555" }}>
                    Arpeggiate
                  </span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={passingTones}
                    onChange={() => setPassingTones(!passingTones)}
                    className="accent-[#e0a040]" />
                  <span className="text-xs" style={{ color: passingTones ? "#e0a040" : "#555" }}>
                    Passing Tones
                  </span>
                </label>
              </div>
              {arpEnabled && (
                <div>
                  <p className="text-[10px] text-[#886622] mb-1 font-medium">BPM</p>
                  <input type="number" min={40} max={240} step={5} value={arpBpm}
                    onChange={e => setArpBpm(Math.max(40, Math.min(240, parseInt(e.target.value) || 100)))}
                    className="w-16 bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-xs text-white text-center focus:outline-none"
                  />
                </div>
              )}
            </div>

            {/* Play / Stop / Replay / Show Answer */}
            <div className="flex gap-2 flex-wrap items-center">
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

            {/* Answer — only visible after clicking Show Answer */}
            {fhShowAnswer && fhDetailInfo && (
              <div className="bg-[#1a1a0a] border border-[#3a3a1a] rounded p-3 text-xs text-[#c8a850] font-mono whitespace-pre">{fhDetailInfo}</div>
            )}
          </div>

          {/* Voicing types + extensions (shared controls) */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <ExtensionControls
              extTendency={extTendency} setExtTendency={setExtTendency}
              checkedExts={checkedExts} setCheckedExts={setCheckedExts}
              checkedExtCounts={checkedExtCounts} setCheckedExtCounts={setCheckedExtCounts} toggleSet={toggleSet}
            />
            <VoicingPatternControls checkedPatterns={checkedPatterns} setCheckedPatterns={setCheckedPatterns} toggleSet={toggleSet} />
            <QualityControls
              edo={edo}
              checkedThirds={checkedThirds} setCheckedThirds={setCheckedThirds}
              checkedFifths={checkedFifths} setCheckedFifths={setCheckedFifths}
              checkedSevenths={checkedSevenths} setCheckedSevenths={setCheckedSevenths}
              chordTypeMode={chordTypeMode} setChordTypeMode={setChordTypeMode}
              toggleSet={toggleSet}
            />
          </div>

          <LilPreviewPanel checkedChords={checkedChords} chordMap={chordMap} edo={edo} tonicPc={tonicPc} lowestOct={lowestOct} highestOct={highestOct} getCompatibleTypes={getCompatibleTypes} applyChordType={applyChordType} />

      {/* ════════════════════════════════════════════════════════════════ */}
      {/* CHORD SELECTION                                                */}
      {/* ════════════════════════════════════════════════════════════════ */}
      <ChordSelectionPanel
        activeBank={activeBank}
        checkedChords={checkedChords} setCheckedChords={setCheckedChords}
        collapsedLevels={collapsedLevels} toggleLevel={toggleLevel}
        selectLevel={selectLevel} deselectLevel={deselectLevel}
        toggleSet={toggleSet}
      />
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

function VoicingPatternControls({ checkedPatterns, setCheckedPatterns, toggleSet }: {
  checkedPatterns: Set<string>; setCheckedPatterns: (s: Set<string>) => void;
  toggleSet: <T>(s: Set<T>, v: T) => Set<T>;
}) {
  const [activeTab, setActiveTab] = useState(VOICING_PATTERN_GROUPS[0]);

  const selectGroup = (g: string) => {
    const ids = ALL_VOICING_PATTERNS.filter(p => p.group === g).map(p => p.id);
    const n = new Set(checkedPatterns); ids.forEach(id => n.add(id)); setCheckedPatterns(n);
  };
  const deselectGroup = (g: string) => {
    const ids = new Set(ALL_VOICING_PATTERNS.filter(p => p.group === g).map(p => p.id));
    const n = new Set(checkedPatterns); ids.forEach(id => n.delete(id)); setCheckedPatterns(n);
  };

  const patterns = ALL_VOICING_PATTERNS.filter(p => p.group === activeTab);
  const totalChecked = ALL_VOICING_PATTERNS.filter(p => checkedPatterns.has(p.id)).length;

  return (
    <div>
      <p className="text-xs text-[#888] mb-1.5 font-medium">VOICINGS <span className="text-[#555] font-normal">({totalChecked} selected)</span></p>
      {/* Tabs */}
      <div className="flex flex-wrap gap-1 mb-2">
        {VOICING_PATTERN_GROUPS.map(g => {
          const count = ALL_VOICING_PATTERNS.filter(p => p.group === g && checkedPatterns.has(p.id)).length;
          const isActive = activeTab === g;
          return (
            <button key={g} onClick={() => setActiveTab(g)}
              style={{
                padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                border: `1px solid ${isActive ? "#7173e6" : count > 0 ? "#333" : "#1a1a1a"}`,
                background: isActive ? "#7173e618" : count > 0 ? "#161622" : "#0e0e0e",
                color: isActive ? "#9999ee" : count > 0 ? "#888" : "#444",
                cursor: "pointer", transition: "all 0.12s",
              }}>
              {g}{count > 0 && <span style={{ marginLeft: 3, color: "#7173e6", fontSize: 9 }}>{count}</span>}
            </button>
          );
        })}
      </div>
      {/* Active panel — per-pattern toggle buttons matching 3rd/5th/7th style */}
      <div className="bg-[#0e0e0e] border border-[#1a1a1a] rounded p-2">
        <div className="flex items-center gap-2 mb-1.5">
          <button onClick={() => selectGroup(activeTab)}
            className="text-[9px] text-[#555] hover:text-[#9999ee] border border-[#222] rounded px-2 py-0.5">All</button>
          <button onClick={() => deselectGroup(activeTab)}
            className="text-[9px] text-[#555] hover:text-[#e06060] border border-[#222] rounded px-2 py-0.5">None</button>
        </div>
        <div className="flex flex-wrap gap-1">
          {patterns.map(p => {
            const on = checkedPatterns.has(p.id);
            const color = "#9999ee";
            return (
              <button key={p.id} onClick={() => setCheckedPatterns(toggleSet(checkedPatterns, p.id))}
                className={`px-2 py-1 text-[10px] font-mono rounded border transition-colors ${
                  on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
                {p.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function QualityControls({
  edo, checkedThirds, setCheckedThirds,
  checkedFifths, setCheckedFifths,
  checkedSevenths, setCheckedSevenths,
  chordTypeMode, setChordTypeMode, toggleSet,
}: {
  edo: number;
  checkedThirds: Set<string>; setCheckedThirds: (s: Set<string>) => void;
  checkedFifths: Set<string>; setCheckedFifths: (s: Set<string>) => void;
  checkedSevenths: Set<string>; setCheckedSevenths: (s: Set<string>) => void;
  chordTypeMode: ChordTypeMode; setChordTypeMode: (v: ChordTypeMode) => void;
  toggleSet: <T>(s: Set<T>, v: T) => Set<T>;
}) {
  const thirds   = useMemo(() => getAvailableThirdQualities(edo), [edo]);
  const fifths   = useMemo(() => getAvailableFifthQualities(edo), [edo]);
  const sevenths = useMemo(() => getAvailableSeventhQualities(edo), [edo]);

  const tierList: { value: ChordTypeMode; label: string; color: string }[] = [
    { value: "diatonic",           label: "Diatonic",              color: "#6a9aca" },
    { value: "chromatic-diatonic", label: "Chromatic",             color: "#9999ee" },
    { value: "diatonic-xen",       label: "Diatonic Xen",          color: "#c09050" },
    { value: "chromatic-xen",      label: "Chromatic Xen",         color: "#c06090" },
  ];
  const visibleTiers = tierList.filter(t => edo !== 12 || (t.value !== "diatonic-xen" && t.value !== "chromatic-xen"));

  return (
    <div className="space-y-2">
      {/* Tier — button row like Melodic Patterns */}
      <div>
        <p className="text-xs text-[#888] mb-1 font-medium">TIER</p>
        <div className="flex flex-wrap gap-1">
          {visibleTiers.map(t => {
            const on = chordTypeMode === t.value;
            return (
              <button key={t.value} onClick={() => setChordTypeMode(t.value)} title={CHORD_TYPE_MODE_HINTS[t.value]}
                className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                  on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: t.color + "30", borderColor: t.color, color: t.color } : {}}>
                {t.label}
              </button>
            );
          })}
        </div>
        <p className="text-[9px] text-[#444] mt-0.5">
          {CHORD_TYPE_MODE_HINTS[chordTypeMode]}
        </p>
      </div>

      {/* 3rds */}
      <div>
        <p className="text-xs text-[#888] mb-1 font-medium">3RDS</p>
        <div className="flex flex-wrap gap-1">
          {thirds.map(q => {
            const on = checkedThirds.has(q.id);
            const color = "#7aaa6a";
            return (
              <button key={q.id} onClick={() => setCheckedThirds(toggleSet(checkedThirds, q.id))} title={q.desc}
                className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                  on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
                {q.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 5ths */}
      <div>
        <p className="text-xs text-[#888] mb-1 font-medium">5THS</p>
        <div className="flex flex-wrap gap-1">
          {fifths.map(q => {
            const on = checkedFifths.has(q.id);
            const color = "#c8a860";
            return (
              <button key={q.id} onClick={() => setCheckedFifths(toggleSet(checkedFifths, q.id))} title={q.desc}
                className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                  on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
                {q.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 7ths — empty selection means "triads only". */}
      <div>
        <p className="text-xs text-[#888] mb-1 font-medium">7THS</p>
        <div className="flex flex-wrap gap-1">
          {sevenths.map(q => {
            const on = checkedSevenths.has(q.id);
            const color = "#b07acc";
            return (
              <button key={q.id} onClick={() => setCheckedSevenths(toggleSet(checkedSevenths, q.id))} title={q.desc}
                className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                  on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
                {q.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LilPreviewPanel({ checkedChords, chordMap, edo, tonicPc, lowestOct, highestOct, getCompatibleTypes, applyChordType }: {
  checkedChords: Set<string>; chordMap: Record<string, number[]>;
  edo: number; tonicPc: number; lowestOct: number; highestOct: number;
  getCompatibleTypes: (shape: number[]) => EdoChordType[];
  applyChordType: (shape: number[], type: EdoChordType) => number[];
}) {
  const [expanded, setExpanded] = useState(true);

  const results = useMemo(() => {
    const checkedRomans = Array.from(checkedChords).filter(r => chordMap[r]);
    const out: { rn: string; ok: boolean; warnings: LilWarning[] }[] = [];

    // Check at both the mid-octave (normal placement) and lowest octave (worst case)
    const midOct = Math.floor((lowestOct + highestOct) / 2);
    const octaves = [midOct, lowestOct];

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
        for (const oct of octaves) {
          const rootAbs = tonicPc + (oct - 4) * edo + rootStep;
          const chordAbs = shape.map(s => rootAbs + (s - rootStep)).sort((a, b) => a - b);
          const w = checkLowIntervalLimits(chordAbs, edo);
          if (w.length > worst.length) worst = w;
        }
      }
      out.push({ rn, ok: worst.length === 0, warnings: worst });
    }
    return out;
  }, [checkedChords, chordMap, edo, tonicPc, lowestOct, highestOct, getCompatibleTypes, applyChordType]);

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

function ChordSelectionPanel({ activeBank, checkedChords, setCheckedChords, collapsedLevels, toggleLevel, selectLevel, deselectLevel, toggleSet }: {
  activeBank: TonalityBank | null;
  checkedChords: Set<string>; setCheckedChords: (s: Set<string>) => void;
  collapsedLevels: Set<string>;
  toggleLevel: (name: string) => void;
  selectLevel: (chords: ChordEntry[]) => void;
  deselectLevel: (chords: ChordEntry[]) => void;
  toggleSet: <T>(s: Set<T>, v: T) => Set<T>;
}) {
  return (
    <div>
      {activeBank && (
        <div className="space-y-2">
          {activeBank.levels.map(level => {
            const isCollapsed = collapsedLevels.has(level.name);
            const allChecked = level.chords.every(c => checkedChords.has(c.label));
            const someChecked = level.chords.some(c => checkedChords.has(c.label));
            return (
              <div key={level.name} className="border border-[#1a1a1a] rounded overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-[#0e0e0e] cursor-pointer select-none"
                  onClick={() => toggleLevel(level.name)}>
                  <span className="text-[10px] text-[#555] w-3">{isCollapsed ? "▸" : "▾"}</span>
                  <span className="text-xs text-[#888] font-medium flex-1">{level.name}</span>
                  <span className="text-[10px] text-[#444]">{level.chords.filter(c => checkedChords.has(c.label)).length}/{level.chords.length}</span>
                  <button onClick={e => { e.stopPropagation(); allChecked ? deselectLevel(level.chords) : selectLevel(level.chords); }}
                    className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                      allChecked ? "border-[#7173e6] text-[#7173e6]"
                        : someChecked ? "border-[#444] text-[#888]"
                        : "border-[#222] text-[#555]"
                    }`}>
                    {allChecked ? "Clear" : "All"}
                  </button>
                </div>
                {!isCollapsed && (
                  <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-1 p-2">
                    {level.chords.map(entry => (
                      <label key={entry.label} className={`flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer transition-colors ${
                        checkedChords.has(entry.label) ? "bg-[#1a1a2a] text-[#9999ee]" : "bg-[#141414] text-[#666] hover:bg-[#1e1e1e]"
                      }`}>
                        <input type="checkbox" checked={checkedChords.has(entry.label)}
                          onChange={() => setCheckedChords(toggleSet(checkedChords, entry.label))}
                          className="accent-[#7173e6]" />
                        {formatRomanNumeral(entry.label)}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
