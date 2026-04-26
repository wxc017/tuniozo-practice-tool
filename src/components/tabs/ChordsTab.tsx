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
  getAvailableThirdQualities,
} from "@/lib/edoData";
import { getTonalityBanks, getApproachChords, APPROACH_KINDS, APPROACH_LABELS, type TonalityBank, type ChordEntry, type ApproachKind } from "@/lib/tonalityBanks";
import { xenIntervalsForEdo } from "@/lib/tonalityChordPool";
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

// Tonality family taxonomy — mirrors the Mode Identification tab's
// Major / Harmonic Minor / Melodic Minor groups.  All seven modes of
// each parent scale are listed; tonalities not exposed by tonalityBanks
// for the current EDO are filtered out at render time.
const TONALITY_FAMILIES: { key: string; label: string; color: string; tonalities: string[] }[] = [
  { key: "major",    label: "MAJOR",          color: "#6a9aca",
    tonalities: ["Major","Dorian","Phrygian","Lydian","Mixolydian","Aeolian","Locrian"] },
  { key: "harmonic", label: "HARMONIC MINOR", color: "#c09050",
    tonalities: ["Harmonic Minor","Locrian #6","Ionian #5","Dorian #4","Phrygian Dominant","Lydian #2","Ultralocrian"] },
  { key: "melodic",  label: "MELODIC MINOR",  color: "#c06090",
    tonalities: ["Melodic Minor","Dorian b2","Lydian Augmented","Lydian Dominant","Mixolydian b6","Locrian #2","Altered"] },
];

// Standard third qualities are always shown in the 3RDS panel; xenharmonic
// thirds (subminor/neutral/supermajor/classic min/maj) move into a separate
// XEN section so the user can opt into microtonal chord types per-EDO
// without crowding the standard quality picker.
const STANDARD_THIRD_QUALITIES = new Set(["sus2", "min3", "maj3", "sus4"]);

export default function ChordsTab({
  tonicPc, lowestOct, highestOct, edo, onHighlight, responseMode, onResult, onPlay, lastPlayed, ensureAudio, playVol = 0.55, layoutPitchRange, tabSettingsRef, answerButtons
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
  const [passingTones, setPassingTones] = useLS<boolean>("lt_crd_passing_tones", false);
  const fhVoicesRef = useRef<{ chords: number[][]; bass: number[][]; melody: number[][]; appliedShapes: (number[] | null)[] } | null>(null);
  // Recency tracking for tonality picking — bias toward tonalities the
  // user hasn't seen lately so a multi-tonality pool actually rotates
  // instead of stochastically clumping on the same key.
  const tonalityPickCounter = useRef(0);
  const tonalityLastPickedAt = useRef<Map<string, number>>(new Map());

  useEffect(() => { isLoopingRef.current = isLooping; }, [isLooping]);

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

  // Tonality banks (one per mode) — Magic Mode is excluded from the new
  // multi-select picker; the family-grouped boxes only show real modes.
  const tonalityBanks = useMemo(() => getTonalityBanks(edo), [edo]);
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
    return map;
  }, [baseChordMap, tonalitySet, buildChordMapForTonality]);

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

  const voiceChord = useCallback((rn: string, stepsOverride: number[] | null, currentChordMap: Record<string, number[]>, prevChord: number[] | null = null, xenList: string[] = [], scaleRootsOverride?: number[] | null) => {
    // No voicing patterns selected → nothing to play
    if (patternNoteCounts.size === 0) return null;

    let shape = stepsOverride ?? currentChordMap[rn];
    if (!shape) return null;

    // Apply a random compatible chord type. The pool is the numeral's natural
    // type plus any per-numeral xen opt-ins; if the shape isn't in the
    // catalog at all, fall through with the raw shape.
    const compatTypes = getCompatibleTypes(shape, xenList);
    if (compatTypes.length > 0) {
      shape = applyChordType(shape, randomChoice(compatTypes));
    }

    const validCounts = Array.from(patternNoteCounts);
    if (validCounts.length === 0) return null;
    const targetNotes = randomChoice(validCounts);

    // If the selected voicing pattern expects a 7th (≥4 notes) but the applied
    // chord type is a triad, auto-extend with the diatonic 7th so the
    // "1 3 5 7" voicing actually has a 7th to voice.  Use the per-round
    // tonality's scale roots when supplied (multi-tonality loops can pick
    // a different tonality each round, so the global memo is wrong here).
    if (targetNotes >= 4 && shape.length === 3) {
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
  }, [checkedPatterns, patternNoteCounts, effectiveChecked, checkedExts, checkedExtCounts, extTendency, regMode, edo, tonicPc, lowestOct, highestOct, clampToLayout, getCompatibleTypes, applyChordType, edoChordTypes, diatonicScaleRoots]);

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
    // Thread each chord's voicing into the next so voiceChord can run its
    // voice-leading checklist against the previous chord's actual pitches.
    let prevVoicing: number[] | null = null;
    for (const rn of progression) {
      const xenList = xenForNumeral?.[rn] ?? [];
      const result = voiceChord(rn, null, useMap, prevVoicing, xenList, scaleRootsOverride);
      chords.push(result ? result.chordAbs : []);
      appliedShapes.push(result ? result.appliedShape : null);
      if (result && result.chordAbs.length > 0) prevVoicing = result.chordAbs;
    }
    const midOct = Math.floor((lowestOct + highestOct) / 2);
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
  }, [voiceChord, chordMap, bassLineMode, melodyMode, edo, tonicPc, lowestOct, highestOct, clampToLayout, layoutPitchRange, passingTones]);

  /** Play all active texture voices using the multi-voice scheduler. */
  const playVoices = useCallback((voices: { chords: number[][]; bass: number[][] }, gapMs: number, noteDur: number, vol: number) => {
    const voiceList: { frames: number[][]; noteDuration: number; gain: number }[] = [];
    if (textureLayers.has("harmony") && voices.chords.length) {
      voiceList.push({ frames: voices.chords, noteDuration: noteDur, gain: vol * harmonyVol });
    }
    if (textureLayers.has("bass") && voices.bass.length) {
      voiceList.push({ frames: voices.bass, noteDuration: noteDur * 1.2, gain: vol * bassVol });
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
    }
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

  return (
    <div className="space-y-5">
      {/* Tonality multi-select — family-grouped boxes (Mode ID style).
          Click a mode to add it to the pool. At play time a random
          tonality is chosen and only its chord pool is used. */}
      <div className="bg-[#0e0e0e] border border-[#1a1a1a] rounded p-2 space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-xs text-[#888] font-medium">TONALITIES</p>
          <button onClick={() => setTonalitySet(new Set(tonalityBanks.map(b => b.name)))}
            className="text-[9px] text-[#555] hover:text-[#9999ee] border border-[#222] rounded px-2 py-0.5">All</button>
          {TONALITY_FAMILIES.map(g => (
            <button key={g.key} onClick={() => setTonalitySet(prev => {
              const next = new Set(prev);
              for (const t of g.tonalities) if (banksByName[t]) next.add(t);
              return next;
            })}
              className="text-[9px] text-[#555] hover:text-[#aaa] border border-[#222] rounded px-2 py-0.5">
              +{g.label}
            </button>
          ))}
          <button onClick={() => setTonalitySet(new Set())}
            className="text-[9px] text-[#555] hover:text-[#aaa] border border-[#222] rounded px-2 py-0.5 ml-auto">Clear</button>
        </div>
        {TONALITY_FAMILIES.map(group => {
          const available = group.tonalities.filter(t => banksByName[t]);
          if (available.length === 0) return null;
          return (
            <div key={group.key}>
              <p className="text-[9px] mb-1 font-medium tracking-wider"
                 style={{ color: group.color }}>{group.label}</p>
              <div className="flex flex-wrap gap-1">
                {available.map(t => {
                  const on = tonalitySet.has(t);
                  return (
                    <button key={t} onClick={() => toggleTonality(t)}
                      className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                        on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                      }`}
                      style={on ? { backgroundColor: group.color + "30", borderColor: group.color, color: group.color } : {}}>
                      {t}
                    </button>
                  );
                })}
              </div>
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
                <p className="text-[10px] text-[#886622] mb-1 font-medium">TEXTURE LAYERS</p>
                <div className="flex gap-3">
                  {([
                    { layer: "harmony" as const, vol: harmonyVol, setVol: setHarmonyVol },
                    { layer: "bass" as const, vol: bassVol, setVol: setBassVol },
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

          {/* Extensions + Voicings (shared controls) */}
          <ExtensionControls
            extTendency={extTendency} setExtTendency={setExtTendency}
            checkedExts={checkedExts} setCheckedExts={setCheckedExts}
            checkedExtCounts={checkedExtCounts} setCheckedExtCounts={setCheckedExtCounts} toggleSet={toggleSet}
          />
          <VoicingPatternControls checkedPatterns={checkedPatterns} setCheckedPatterns={setCheckedPatterns} toggleSet={toggleSet} />

          <LilPreviewPanel checkedChords={effectiveChecked} chordMap={chordMap} edo={edo} tonicPc={tonicPc} lowestOct={lowestOct} highestOct={highestOct} getCompatibleTypes={getCompatibleTypes} applyChordType={applyChordType} />

      {/* ════════════════════════════════════════════════════════════════ */}
      {/* CHORD SELECTION (per checked tonality)                          */}
      {/* ════════════════════════════════════════════════════════════════ */}
      <div className="space-y-3">
        {Array.from(tonalitySet).map(t => {
          const bank = banksByName[t];
          if (!bank) return null;
          const family = TONALITY_FAMILIES.find(f => f.tonalities.includes(t));
          const accent = family?.color ?? "#7173e6";
          return (
            <ChordSelectionPanel
              key={t}
              tonality={t}
              accent={accent}
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

function VoicingPatternControls({ checkedPatterns, setCheckedPatterns, toggleSet }: {
  checkedPatterns: Set<string>; setCheckedPatterns: (s: Set<string>) => void;
  toggleSet: <T>(s: Set<T>, v: T) => Set<T>;
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
  // every other group still gets its own outer block.
  const SUS_GROUPS = ["Sus2", "Sus4"];
  const nonSus = VOICING_PATTERN_GROUPS.filter(g => !SUS_GROUPS.includes(g));
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
        {susAvailable.length > 0 && (
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
  qrt: "qua",
  qnt: "quin",
};
// Voicing-style xen toggles: not 3rd-quality alterations (they replace
// the chord's interval stack), so they're surfaced separately from the
// catalog-derived quality buttons but live in the same xenByTonality
// map.  Engine wiring: the chord-pool builder substitutes the parent
// chord's shape with a quartal/quintal stack when the variant is picked.
const XEN_VOICING_KINDS = ["qrt", "qnt"] as const;
type XenVoicingKind = typeof XEN_VOICING_KINDS[number];

function ChordSelectionPanel({
  tonality, accent, bank, edo, chordMap, checkedSet, toggleChord, setLevel,
  collapsedLevels, toggleLevel, approachMap, toggleApproach,
  xenMap, toggleXen,
}: {
  tonality: string;
  accent: string;
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
        <span className="text-[11px] font-semibold tracking-wide" style={{ color: accent }}>{tonality.toUpperCase()}</span>
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
                    // Pre-compute xen options so the cell layout knows
                    // whether the row will appear (drives spacer placement).
                    const xenOpts: { id: string; label: string }[] = (() => {
                      if (xenThirds.length === 0) return [];
                      const shape = entry.steps ?? chordMap[entry.label] ?? null;
                      if (!shape || shape.length < 2) return [];
                      const sh = getChordShapes(edo);
                      const root = shape[0];
                      const rels = shape.map(s => ((s - root) % edo + edo) % edo).sort((a, b) => a - b);
                      const numeralThird = rels[1];
                      if (numeralThird === sh.M2 || numeralThird === sh.P4) return [];
                      const mid = (sh.m3 + sh.M3) / 2;
                      const numeralIsMajor = numeralThird >= mid;
                      // EDO-specific allowlist: 17 has nothing, 19 has
                      // sub/sup but no neutral, 31 has sub/neu/sup, 41
                      // adds classical thirds.  Filter the catalog
                      // qualities to those exposed by the EDO table.
                      const xenAvail = xenIntervalsForEdo(edo);
                      const allowedIds = new Set(
                        (Object.keys(xenAvail) as Array<"neu" | "sub" | "sup" | "clmin" | "clmaj">)
                          .map(k => k + "3"),
                      );
                      const types = getEdoChordTypes(edo);
                      return xenThirds
                        .filter(q => allowedIds.has(q.id))
                        .filter(q => {
                          if (q.id === "neu3") return true;
                          const t = types.find(x => x.thirdQuality === q.id);
                          if (!t) return false;
                          return (t.third >= mid) === numeralIsMajor;
                        })
                        .map(q => ({ id: q.id, label: q.label }));
                    })();
                    const enabledXen = new Set(xenMap[entry.label] ?? []);
                    return (
                      <div key={entry.label}
                        className="rounded overflow-hidden border transition-colors flex flex-col h-full"
                        style={isChecked
                          ? { background: accent + "30", borderColor: accent }
                          : { background: "#141414", borderColor: "#1a1a1a" }}>
                        <button onClick={() => toggleChord(entry.label)}
                          className={`flex-1 w-full px-2 py-1 text-xs text-left transition-colors ${
                            isChecked ? "" : "text-[#666] hover:text-[#888]"
                          }`}
                          style={isChecked ? { color: accent } : undefined}>
                          {formatRomanNumeral(entry.label)}
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
                          <div className="flex flex-col gap-0.5 px-1 pb-1">
                            {xenOpts.length > 0 && (
                              <div className="flex gap-0.5">
                                {xenOpts.map(q => {
                                  const on = enabledXen.has(q.id);
                                  const color = XEN_QUALITY_COLOR[q.id] ?? "#c09050";
                                  return (
                                    <button key={q.id}
                                      onClick={() => isChecked ? toggleXen(entry.label, q.id) : toggleChord(entry.label)}
                                      title={isChecked ? `${entry.label} with ${q.label} 3rd` : `Click to enable ${entry.label}`}
                                      className={`flex-1 min-h-[24px] text-[10px] leading-tight px-1 py-1 rounded border transition-colors ${
                                        !isChecked ? "bg-[#141414] text-[#555] border-[#222] hover:text-[#aaa] hover:border-[#444]"
                                        : on ? "text-black font-semibold"
                                        : "bg-[#141414] text-[#888] border-[#333] hover:text-[#ddd] hover:border-[#555]"
                                      }`}
                                      style={isChecked && on ? { background: color, borderColor: color } : undefined}>
                                      {XEN_SHORT_LABEL[q.id] ?? q.label.toLowerCase()}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                            <div className="flex gap-0.5">
                              {XEN_VOICING_KINDS.map(k => {
                                const on = enabledXen.has(k);
                                const color = XEN_QUALITY_COLOR[k];
                                return (
                                  <button key={k}
                                    onClick={() => isChecked ? toggleXen(entry.label, k) : toggleChord(entry.label)}
                                    title={isChecked
                                      ? `${entry.label} as ${k === "qrt" ? "quartal (stacked 4ths)" : "quintal (stacked 5ths)"}`
                                      : `Click to enable ${entry.label}`}
                                    className={`flex-1 min-h-[24px] text-[10px] leading-tight px-1 py-1 rounded border transition-colors ${
                                      !isChecked ? "bg-[#141414] text-[#555] border-[#222] hover:text-[#aaa] hover:border-[#444]"
                                      : on ? "text-black font-semibold"
                                      : "bg-[#141414] text-[#888] border-[#333] hover:text-[#ddd] hover:border-[#555]"
                                    }`}
                                    style={isChecked && on ? { background: color, borderColor: color } : undefined}>
                                    {XEN_SHORT_LABEL[k]}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
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
