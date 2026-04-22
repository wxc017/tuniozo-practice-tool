import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useLS } from "@/lib/storage";
import { audioEngine } from "@/lib/audioEngine";
import { getEdoChordTypes, getLayoutFile, getFullDegreeNames, getAvailableThirdQualities, getAvailableSeventhQualities, pcToNoteName, pcToNoteNameWithEnharmonic, getDegreeMap, formatHalfAccidentals } from "@/lib/edoData";
import { renderAccidentals } from "@/lib/accidentalDisplay";
import { computeLayout, type LayoutResult } from "@/lib/lumatoneLayout";
import { ALL_VOICING_PATTERNS, VOICING_PATTERN_GROUPS, generateFunctionalLoop, PATTERN_SCALE_FAMILIES, getScaleDiatonicSteps } from "@/lib/musicTheory";
import LumatoneKeyboard from "@/components/LumatoneKeyboard";
import MelodicRhythm, { type RhythmTimingData } from "@/components/MelodicRhythm";
import {
  type HarmonyCategory,
  type NoteCategory,
  type ProgressionMode,
  type Tonality,
  type MelodicVocab,
  HARMONY_CATEGORIES,
  VOCAB_GROUPS,
  VOCAB_REQUIRED_CATS,
  VOCAB_MIN_NOTES,
  availableHarmonyCategories,
  randomMelodyWithAngularity,
  getLastDigitalShape,
  getLastTriadPairInfo,
  getLastHexatonicInfo,
  getLastPentatonicInfo,
  getLastIntervallicInfo,
  getLastCellType,
  pickChordForMelodyInRange,
  getIntervals,
  getContour,
  degreeName,
  chordExtensionName,
  toPc,
  octaveOffset,
  chordMelodyOverlap,
  classifyFit,
  classifyNoteCategory,
  generateProgression,
  toRomanNumeralParts,
  getSecDomLabel,
  generateCounterpoint,
  generateMultiTonicProgression,
  type MultiTonicCycle,
  type DrillChord,
  xenFamily,
  isStableMicro,
  toRomanNumeral,
} from "@/lib/melodicPatternData";

// ── Constants ────────────────────────────────────────────────────────

const SUPPORTED_EDOS = [12, 31, 41] as const;
type SupportedEdo = typeof SUPPORTED_EDOS[number];

const TONALITY_OPTIONS: { value: Tonality; label: string; color: string }[] = [
  { value: "major", label: "Major", color: "#5a8a5a" },
  { value: "minor", label: "Minor", color: "#c06090" },
  { value: "both",  label: "Both",  color: "#999" },
];

const HARMONY_GROUP_COLORS: Record<string, string> = {
  "Diatonic": "#5a8a5a", "Chromatic": "#c06090", "Extended": "#c8aa50", "Xenharmonic": "#8888cc",
};

const CATEGORY_OPTIONS: { value: NoteCategory; label: string; desc: string; color: string }[] = [
  { value: "ct",         label: "Chord Tones",       desc: "Notes in the chord",                                   color: "#5a8a5a" },
  { value: "diatonic",   label: "Stable Diatonic",   desc: "Natural tensions (9, 11, 13)",                         color: "#c8aa50" },
  { value: "chromatic",  label: "Tense Diatonic",    desc: "Chromatic tensions (b9, #11, b13…)",                   color: "#c06090" },
  { value: "micro",      label: "Stable Microtonal", desc: "7/11-limit consonances (7/4, 7/6, 11/8, 11/9…)",      color: "#7a9ec0" },
  { value: "microTense", label: "Tense Microtonal",  desc: "Higher-limit intervals — far from simple JI ratios",   color: "#8888cc" },
];

const FIT_COLORS = { fits: "#5a8a5a", kinda: "#c8aa50", clashes: "#c06090" };
const PATTERN_LENGTHS = [2, 3, 4, 5, 6, 7, 8] as const;
const CHORD_NOTE_COUNTS = [2, 3, 4, 5, 6, 7, 8] as const;
type Pipeline = "melody-first" | "chords-first" | "pattern-drill";

type PermutationMode = "original" | "retrograde" | `rotate${number}` | `swap${number}` | "all";

// ── Scales / modes for the Pattern Drill ────────────────────────────
// Reuses `PATTERN_SCALE_FAMILIES` + `getScaleDiatonicSteps` from musicTheory
// for the three heptatonic families (Ionian/Harmonic-min/Melodic-min and
// their modes), and layers on non-heptatonic scales (pentatonic / blues /
// whole-tone / half-whole / double-harmonic / Ryukyu / In) as degree
// strings so the same mode-picker covers everything the 2026 Course uses.
// Each entry lists the scale's degrees in "1 2 b3 #4"-style names; at
// lookup time they resolve through getDegreeMap(edo) so the SAME data
// works in 12 / 31 / 41-EDO.
const EXTRA_SCALE_FAMILY = "Other";
const EXTRA_SCALE_DEGREES: Record<string, string[]> = {
  "Major Pentatonic":       ["1","2","3","5","6"],
  "Minor Pentatonic":       ["1","b3","4","5","b7"],
  "Major Blues":            ["1","2","b3","3","5","6"],
  "Minor Blues":            ["1","b3","4","b5","5","b7"],
  "Whole Tone":             ["1","2","3","#4","#5","b7"],
  "Half-Whole Diminished":  ["1","b2","b3","3","#4","5","6","b7"],
  "Whole-Half Diminished":  ["1","2","b3","4","b5","b6","6","7"],
  "Double Harmonic":        ["1","b2","3","4","5","b6","7"],
  "Ryukyu Pentatonic":      ["1","3","4","5","7"],
  "In Pentatonic":          ["1","b2","4","5","b6"],
  "Hirajoshi":              ["1","2","b3","5","b6"],
  "Sus Pentatonic":         ["1","2","4","5","b7"],
};

/** Full list of { family, mode } options for the drill picker. */
const DRILL_SCALE_OPTIONS: { family: string; mode: string }[] = (() => {
  const out: { family: string; mode: string }[] = [];
  for (const [fam, modes] of Object.entries(PATTERN_SCALE_FAMILIES)) {
    for (const m of modes) out.push({ family: fam, mode: m });
  }
  for (const m of Object.keys(EXTRA_SCALE_DEGREES)) {
    out.push({ family: EXTRA_SCALE_FAMILY, mode: m });
  }
  return out;
})();

// ── Drill chord-pool categories ──────────────────────────────────────
// The drill replaces the 8-group roman-numeral palette (diatonic-major /
// diatonic-minor / harmonic-minor / melodic-minor / modal / secondary /
// tritone / xen) with a 6-category taxonomy intertwined with the active
// scale.  Diatonic = chords whose every PC is in the selected mode, so
// switching Ionian → Dorian reshapes the Diatonic bucket automatically.
type DrillChordCategory = "diatonic" | "modal" | "secdom" | "tritone" | "xen-stable" | "xen-tense";

const DRILL_CATEGORY_INFO: Record<DrillChordCategory, { label: string; color: string; desc: string }> = {
  "diatonic":   { label: "Diatonic",            color: "#5a8a5a", desc: "Every chord tone is in the active mode" },
  "modal":      { label: "Modal Interchange",   color: "#c8aa50", desc: "Borrowed from parallel modes (bII, bIII, iv, bVI, bVII, #IV…)" },
  "secdom":     { label: "Secondary Dominant",  color: "#c06090", desc: "V/ii, V/iii, V/IV, V/V, V/vi (and their 7ths)" },
  "tritone":    { label: "TT",                  color: "#8888cc", desc: "Tritone substitutions (TTV, TT/ii, …)" },
  "xen-stable": { label: "Microtonal Stable",   color: "#9a66c0", desc: "Xen thirds at low-limit JI consonances (7/6 subminor, 11/9 neutral, 9/7 supermajor, 5/4 / 6/5 classical)" },
  "xen-tense":  { label: "Microtonal Tense",    color: "#cc6a8a", desc: "Xen thirds off the JI grid (32/27 & 81/64 Pythagorean)" },
};

/** Microtonal stable/tense split by xen family.  Submin / neutral / supermaj
 *  and classical (5-limit) minor/major are low-limit-JI consonances → stable.
 *  Pythagorean min (32/27) and maj (81/64) are tense because their thirds
 *  sit off the 5-/7-/11-limit grid. */
const XEN_STABLE_FAMILIES = new Set(["xen_submin", "xen_neutral", "xen_supermaj", "xen_clmin", "xen_clmaj"]);
const XEN_TENSE_FAMILIES  = new Set(["xen_min", "xen_maj"]);

/** True when a PC-offset (relative to tonic) lands on a 12-EDO semitone
 *  within half an EDO step.  Used to split "modal interchange" (chromatic
 *  but 12-EDO) from "microtonal" (xenharmonic). */
function is12EdoChromatic(relStep: number, edo: number): boolean {
  const cents = (relStep / edo) * 1200;
  const nearestSemitone = Math.round(cents / 100);
  const halfEdoStep = (1200 / edo) / 2;
  return Math.abs(cents - nearestSemitone * 100) <= halfEdoStep + 1e-9;
}

/** Curated modal-interchange palette.  Each entry is a (relative degree,
 *  chord-type id) pair that practitioners actually borrow when stepping
 *  outside the active mode.  Covers the three big sources — parallel major
 *  ↔ parallel minor (Picardy I, iv/IV, bIII/iii, bVI/vi, bVII/vii…),
 *  harmonic minor (V/V7 in minor, vii°7, bIII+), melodic minor (iminmaj7,
 *  IV7 Lydian-dom, vii°/viiø7) — plus the classic modal flavors (bII
 *  Neapolitan from Phrygian, II/II7 from Lydian, #IV° from Lydian, vi° from
 *  Locrian).  The diatonic-skip in buildScaleAwareDrillPalette filters out
 *  whichever entries already belong to the current mode, so the SAME list
 *  works for every tonic — Ionian, Dorian, Phrygian, Lydian, Mixolydian,
 *  Aeolian, Locrian, etc. */
const BORROWED_CHORDS: { degRel: string; types: string[] }[] = [
  // Tonic: Picardy, parallel minor tonic, minmaj7 (harm/mel minor)
  { degRel: "1",  types: ["maj", "maj7", "min", "min7", "minmaj7"] },
  // Neapolitan + bII7 (sub-tritone flavor)
  { degRel: "b2", types: ["maj", "maj7", "dom7"] },
  // II (Lydian), II7 (V/V), ii (parallel major ii)
  { degRel: "2",  types: ["maj", "maj7", "dom7", "min", "min7"] },
  // bIII (Aeolian/Phrygian), bIII7 (Phrygian-dominant), bIII+ (harm/mel minor)
  { degRel: "b3", types: ["maj", "maj7", "dom7", "aug", "augmaj7"] },
  // III (harmonic-minor mediant), III7 (V/vi color), iii (parallel major)
  { degRel: "3",  types: ["maj", "maj7", "dom7", "min", "min7"] },
  // iv (parallel minor), IV (parallel major / Dorian), IV7 (Dorian / Lydian-dom)
  { degRel: "4",  types: ["min", "min7", "maj", "maj7", "dom7"] },
  // #IV°/#ivø7/#IV°7 (Lydian, sec dim), #IV7 (tritone flavor)
  { degRel: "#4", types: ["dim", "halfdim7", "dim7", "dom7"] },
  // V (harm-minor V in minor), V7 (essential dominant of minor), v (parallel
  //   minor / Dorian / Phrygian), vø7 (Locrian/Phrygian)
  { degRel: "5",  types: ["maj", "dom7", "min", "min7", "halfdim7"] },
  // bVI (Aeolian), bVImaj7, bVI7 (bluesy turnaround)
  { degRel: "b6", types: ["maj", "maj7", "dom7"] },
  // VI (Dorian / parallel major), vi (parallel major)
  { degRel: "6",  types: ["maj", "maj7", "min", "min7"] },
  // bVII (Mixo/Aeolian), bVII7, bvii (Phrygian/Locrian)
  { degRel: "b7", types: ["maj", "maj7", "dom7", "min", "min7"] },
  // vii° / viiø7 (Ionian), vii°7 (harm minor), vii (Lydian)
  { degRel: "7",  types: ["dim", "dim7", "halfdim7", "min", "min7"] },
];

/** Curated microtonal palette.  Restricts the Microtonal Stable / Tense
 *  buckets to triads + the signature 7th of each xen family — drops the
 *  long-tail voicings (sup_clm7, neu_maj6, …) that nobody actually uses.
 *  Combined with a "scale-degree roots only" loop, this keeps the bucket
 *  to a few dozen chords instead of hundreds. */
const CURATED_MICRO_TYPES = new Set([
  // Subminor (7/6) — bluesy
  "submin", "submin_h7", "submin_m7", "submin_sm7",
  // Neutral (11/9) — Arabic / Persian neutral
  "neutral", "neu_n7",
  // Supermajor (9/7) — bright xen
  "supermaj", "sup_sup7", "sup_h7",
  // Just minor (6/5) / major (5/4)
  "clmin", "clmin_clm7",
  "clmaj", "clmaj_clM7",
  // Pythagorean min (32/27) / maj (81/64) — only distinct in non-12 EDOs
  "min", "min_m7",
  "maj", "maj_M7",
  // Harmonic 7th over a regular major triad — blues dominant
  "harm7",
]);

/** Build the full six-category chord palette from scratch, given the
 *  active scale.  Diatonic + Sec Dom + TT are derived mechanically from
 *  the scale; Modal Interchange and the Microtonal buckets are restricted
 *  to curated allowlists (BORROWED_CHORDS, CURATED_MICRO_TYPES) — without
 *  the curation each mode would surface hundreds of unused combinations.
 *
 *  Categories (first-match-by-key wins via `seen`):
 *    Diatonic           — every chord PC is in the scale
 *    Secondary Dominant — dom7 rooted a P5 below a non-tonic scale degree
 *    TT                 — dom7 rooted a tritone from the Sec Dom root
 *    Modal Interchange  — (degree, type) pair from BORROWED_CHORDS that
 *                         isn't already diatonic
 *    Microtonal Stable  — chord rooted on a scale degree, type in
 *                         CURATED_MICRO_TYPES, all non-scale PCs are
 *                         11-/9-/7-/5-limit JI consonances (isStableMicro)
 *    Microtonal Tense   — same restriction, but at least one non-scale PC
 *                         falls off the JI grid (Pythagorean 32/27, 81/64)
 */
function buildScaleAwareDrillPalette(
  edo: number,
  tonicRoot: number,
  scalePcs: number[],
  chordTypes: ReturnType<typeof getEdoChordTypes>,
): Record<DrillChordCategory, DrillChord[]> {
  const scaleSet = new Set(scalePcs);
  const scaleDegsRel = scalePcs.map(pc => ((pc - tonicRoot) % edo + edo) % edo).sort((a, b) => a - b);
  const dm = getDegreeMap(edo);
  const P5 = dm["5"] ?? Math.round(edo * 7 / 12);
  const TT = Math.round(edo / 2);
  const m3Step = Math.round(edo * 3 / 12);
  const M3Step = Math.round(edo * 4 / 12);

  const cats: Record<DrillChordCategory, DrillChord[]> = {
    "diatonic": [], "modal": [], "secdom": [], "tritone": [], "xen-stable": [], "xen-tense": [],
  };
  const seen = new Set<string>();

  const push = (cat: DrillChordCategory, absRoot: number, type: ReturnType<typeof getEdoChordTypes>[number], romanOverride?: string) => {
    const absPcs = type.steps.map(s => ((absRoot + s) % edo + edo) % edo);
    const key = absPcs.slice().sort((a, b) => a - b).join(",") + "|" + type.id;
    if (seen.has(key)) return;
    seen.add(key);
    const relRoot = ((absRoot - tonicRoot) % edo + edo) % edo;
    const relPcs = absPcs.map(pc => ((pc - tonicRoot) % edo + edo) % edo);
    let roman = romanOverride ?? toRomanNumeral(edo, relRoot, type.abbr, relPcs);
    // Sus chords have no third, so toRomanNumeral defaults to uppercase.
    // For a diatonic sus, match the case to the scale's own third at this root.
    if (!romanOverride && (type.id === "sus2" || type.id === "sus4" || type.id === "dom7sus4")) {
      const hasMinor = scaleSet.has(((absRoot + m3Step) % edo + edo) % edo);
      const hasMajor = scaleSet.has(((absRoot + M3Step) % edo + edo) % edo);
      if (hasMinor && !hasMajor) {
        roman = roman.replace(/^([b#]*)([IVX]+)/, (_, acc, rn) => acc + rn.toLowerCase());
      }
    }
    cats[cat].push({ roman, root: relRoot, steps: type.steps, chordTypeId: type.id, group: cat });
  };

  // ── 1. Diatonic: chord types rooted on scale degrees whose PCs all lie
  //   in the scale.  This is the "all-in-scale" test from the old classifier,
  //   now applied to every chord type rather than only the curated palette.
  for (const root of scalePcs) {
    for (const type of chordTypes) {
      const absPcs = type.steps.map(s => ((root + s) % edo + edo) % edo);
      if (absPcs.every(pc => scaleSet.has(pc))) {
        push("diatonic", root, type);
      }
    }
  }

  // ── 2. Secondary Dominant + TT: for each non-tonic scale degree, a
  //   dom7 rooted a P5 below it (that's "V of D"), and its tritone sub.
  const dom7 = chordTypes.find(c => c.id === "dom7");
  const romanForDeg = (degRel: number): string => {
    const idx = scaleDegsRel.indexOf(degRel);
    const romanNums = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii"];
    return idx >= 0 && idx < romanNums.length ? romanNums[idx] : "?";
  };
  if (dom7) {
    for (const degRel of scaleDegsRel) {
      if (degRel === 0) continue; // V of tonic is just V — lives in Diatonic
      const targetPc = (tonicRoot + degRel) % edo;
      const secRoot  = ((targetPc + P5) % edo + edo) % edo;
      push("secdom",  secRoot, dom7, `V/${romanForDeg(degRel)}`);
      const ttRoot   = ((secRoot + TT) % edo + edo) % edo;
      push("tritone", ttRoot, dom7, `TT/${romanForDeg(degRel)}`);
    }
  }

  // ── 3. Modal Interchange: curated allowlist of borrowed (degree, type)
  //   pairs from BORROWED_CHORDS.  The diatonic-skip naturally hides any
  //   pair that's already in the active mode, so the same fixed list works
  //   across every tonic — Ionian surfaces bIII / iv / v / bVI / bVII etc.,
  //   Aeolian surfaces I (Picardy) / IV / II / vii°7 etc.
  for (const { degRel, types } of BORROWED_CHORDS) {
    const step = dm[degRel];
    if (step == null) continue;
    const absRoot = ((tonicRoot + step) % edo + edo) % edo;
    for (const typeId of types) {
      const type = chordTypes.find(c => c.id === typeId);
      if (!type) continue; // chord type not available in this EDO
      const absPcs = type.steps.map(s => ((absRoot + s) % edo + edo) % edo);
      if (absPcs.every(pc => scaleSet.has(pc))) continue; // already Diatonic
      push("modal", absRoot, type);
    }
  }

  // ── 4. Microtonal Stable / Tense: only roots on active scale degrees,
  //   only chord types from the per-family CURATED_MICRO_TYPES allowlist.
  //   Tense vs Stable still decided per non-scale PC via isStableMicro
  //   (Pythagorean 32/27, 81/64 → Tense; 7/6, 11/9, 9/7, 5/4, 6/5 → Stable).
  const microTypes = chordTypes.filter(t => CURATED_MICRO_TYPES.has(t.id));
  for (const root of scalePcs) {
    for (const type of microTypes) {
      const absPcs = type.steps.map(s => ((root + s) % edo + edo) % edo);
      if (absPcs.every(pc => scaleSet.has(pc))) continue;
      const nonScaleRels = absPcs
        .filter(pc => !scaleSet.has(pc))
        .map(pc => ((pc - tonicRoot) % edo + edo) % edo);
      const anyTense = nonScaleRels.some(r => !is12EdoChromatic(r, edo) && !isStableMicro(r, edo));
      const anyMicro = nonScaleRels.some(r => !is12EdoChromatic(r, edo));
      if (!anyMicro && !xenFamily(type.id, edo)) continue; // already Modal or Diatonic
      push(anyTense ? "xen-tense" : "xen-stable", root, type);
    }
  }

  return cats;
}

/** Build the active scale's pitch classes given a tonic + family/mode. */
function getScalePcs(edo: number, tonicRoot: number, family: string, mode: string): number[] {
  let steps: number[];
  if (family === EXTRA_SCALE_FAMILY) {
    const dm = getDegreeMap(edo);
    const names = EXTRA_SCALE_DEGREES[mode] ?? ["1","2","3","4","5","6","7"];
    steps = names.map(n => dm[n]).filter(s => s !== undefined).sort((a, b) => a - b);
  } else {
    steps = getScaleDiatonicSteps(family, mode, edo);
  }
  return steps.map(s => ((tonicRoot + s) % edo + edo) % edo);
}

/** Legacy — used by chords-first / melody-first pipelines that don't have
 *  a mode picker.  Always returns the natural (unaccidentaled) 7-note scale. */
function getDiatonicScale(edo: number, tonicRoot: number): number[] {
  const names = getFullDegreeNames(edo);
  const scale: number[] = [];
  for (let i = 0; i < edo; i++) {
    if (!names[i]?.match(/[#b]/)) {
      scale.push(((tonicRoot + i) % edo + edo) % edo);
    }
  }
  return scale;
}


/** A single note in a drill pattern.
 *  Degree mode: degree (1-7) + NoteCategory role. `rel` stores exact interval for non-diatonic.
 *  Interval-chain mode: `intervalChain` is a signed EDO-step offset from previous note. */
type PatternNote = { deg: number; cat: NoteCategory; rel?: number; intervalChain?: number };

/**
 * Resolve a PatternNote to a pitch class over a chord.
 * Category controls resolution strategy:
 *   ct         → match chord tones by degree
 *   diatonic   → diatonic scale degree
 *   chromatic/micro/microTense → use stored interval from chord root (rel),
 *     then verify the category still matches the new chord; if not, search
 *     nearby for the closest PC with the target category.
 */
function degreeToPc(
  note: PatternNote,
  chordSteps: number[],
  chordRoot: number,
  diatonicScale: number[],
  edo: number,
  tonicRoot: number,
  chordPcs: number[],
  tonality: Tonality,
): number {
  const { deg, cat, rel } = note;

  // ct: snap to the chord tone at this degree.
  // First pass — exact baseDeg name match (picks up "b3" / "#5" / "bb7" etc.).
  // Second pass — microtonal qualities spell their thirds/sevenths with double
  // accidentals that carry the *adjacent* baseDeg: a neutral third is "##2",
  // a supermajor 7th is "##6". For odd degrees (1/3/5/7) fall back to the
  // tertian chord-index — but require the step's effective degree (baseDeg +
  // 0.5 × sharps − 0.5 × flats) to be within ½ of the pattern degree, so
  // a sus4 "4" doesn't get grabbed by pattern "3".
  if (cat === "ct") {
    const parse = (step: number) => {
      const name = degreeName(step, edo);
      const m = name.match(/^([#b]*)(\d+)$/);
      if (!m) return null;
      const sharps = (m[1].match(/#/g) || []).length;
      const flats  = (m[1].match(/b/g) || []).length;
      const baseDeg = parseInt(m[2]);
      return { baseDeg, effDeg: baseDeg + 0.5 * sharps - 0.5 * flats };
    };
    for (const step of chordSteps) {
      const p = parse(step);
      if (p && p.baseDeg === deg) return ((chordRoot + step) % edo + edo) % edo;
    }
    if (deg === 1 || deg === 3 || deg === 5 || deg === 7) {
      const idx = (deg - 1) / 2;
      if (idx < chordSteps.length) {
        const p = parse(chordSteps[idx]);
        if (p && Math.abs(p.effDeg - deg) <= 0.5) {
          return ((chordRoot + chordSteps[idx]) % edo + edo) % edo;
        }
      }
    }
    // chord doesn't have this degree — fall through to diatonic
  }

  // Find the diatonic PC for this degree
  const rootIdx = diatonicScale.indexOf(((chordRoot % edo) + edo) % edo);
  let basePc: number;
  if (rootIdx >= 0) {
    const targetIdx = (rootIdx + deg - 1) % diatonicScale.length;
    basePc = diatonicScale[targetIdx];
  } else {
    let nearestIdx = 0, nearestDist = Infinity;
    for (let i = 0; i < diatonicScale.length; i++) {
      const d = Math.min(
        Math.abs(diatonicScale[i] - ((chordRoot % edo) + edo) % edo),
        edo - Math.abs(diatonicScale[i] - ((chordRoot % edo) + edo) % edo),
      );
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    }
    basePc = diatonicScale[(nearestIdx + deg - 1) % diatonicScale.length];
  }

  // For diatonic (or ct fallback), return the diatonic base PC
  if (cat === "diatonic" || cat === "ct") return basePc;

  // For chromatic / micro / microTense:
  // First try the stored interval directly (preserves the exact relationship).
  if (rel != null) {
    const directPc = ((chordRoot + rel) % edo + edo) % edo;
    const directCat = classifyNoteCategory(directPc, chordPcs, edo, tonicRoot, tonality);
    if (directCat === cat) return directPc;
    // Category changed under this chord — search nearby for closest match
  }

  // Search outward from the base (diatonic PC or rel-based PC) for a
  // PC whose category matches the target relative to the new chord.
  const searchBase = rel != null ? ((chordRoot + rel) % edo + edo) % edo : basePc;
  const maxSearch = Math.min(4, Math.floor(edo / 5));
  for (let offset = 0; offset <= maxSearch; offset++) {
    for (const dir of (offset === 0 ? [0] : [1, -1])) {
      const candidate = ((searchBase + dir * offset) % edo + edo) % edo;
      const candidateCat = classifyNoteCategory(candidate, chordPcs, edo, tonicRoot, tonality);
      if (candidateCat === cat) return candidate;
    }
  }
  // Final fallback: use the stored interval or diatonic base
  return rel != null ? ((chordRoot + rel) % edo + edo) % edo : basePc;
}

/** Realize a PatternNote[] pattern over a chord with smooth octave placement.
 *  `scaleOverride` lets the caller supply a non-natural-major scale (e.g.
 *  Dorian, Phrygian Dominant, Major Pentatonic, Whole Tone…) so degree
 *  resolution respects the active mode.  When omitted, falls back to the
 *  EDO's natural (unaccidentaled) 7-note scale — matches prior behavior. */
function realizePattern(
  notes: PatternNote[],
  chordSteps: number[],
  chordRoot: number,
  edo: number,
  tonicRoot: number,
  chordPcs: number[],
  tonality: Tonality,
  baseOctave: number = 4,
  scaleOverride?: number[],
): number[] {
  if (chordSteps.length === 0 || notes.length === 0) return [];
  const diatonicScale = scaleOverride ?? getDiatonicScale(edo, tonicRoot);
  const result: number[] = [];
  let prevPitch = chordRoot + (baseOctave - 4) * edo;
  for (let i = 0; i < notes.length; i++) {
    // Interval-chain mode: add signed interval to previous pitch
    if (notes[i].intervalChain != null) {
      if (i === 0) {
        // First note in an interval chain: start from chord root
        prevPitch = chordRoot + (baseOctave - 4) * edo;
      } else {
        prevPitch = prevPitch + notes[i].intervalChain!;
      }
      result.push(prevPitch);
      continue;
    }
    // Degree mode: resolve to PC then closest octave
    const pc = degreeToPc(notes[i], chordSteps, chordRoot, diatonicScale, edo, tonicRoot, chordPcs, tonality);
    if (i === 0) {
      prevPitch = pc + (baseOctave - 4) * edo;
    } else {
      let best = pc, bestDist = Infinity;
      for (let oct = -2; oct <= 2; oct++) {
        const candidate = pc + oct * edo;
        const dist = Math.abs(candidate - prevPitch);
        if (dist < bestDist) { bestDist = dist; best = candidate; }
      }
      prevPitch = best;
    }
    result.push(prevPitch);
  }
  return result;
}

/** Extract a PatternNote[] from a melody, classifying each note relative to the chord.
 *  Uses base scale degrees 1-7, not extension names (9/11/13).
 *  Each note carries its NoteCategory so the drill can re-apply the same role
 *  (ct, diatonic, chromatic, micro, microTense) over different chords. */
function extractDegreePattern(
  melody: number[], chordPcs: number[], edo: number,
  tonicRoot: number, tonality: Tonality,
  asIntervals: boolean = false,
): PatternNote[] {
  // Interval-chain extraction: compute signed intervals between consecutive pitches
  if (asIntervals && melody.length >= 2) {
    return melody.slice(1).map((pitch, i) => ({
      deg: 1, cat: "ct" as NoteCategory,
      intervalChain: pitch - melody[i],
    }));
  }
  // Degree extraction
  const chordRoot = chordPcs[0] ?? 0;
  return melody.map(absPitch => {
    const pc = ((absPitch % edo) + edo) % edo;
    const rel = ((pc - chordRoot) % edo + edo) % edo;
    const name = degreeName(rel, edo);
    const baseDeg = parseInt(name.replace(/[^0-9]/g, ""));
    const deg = isNaN(baseDeg) ? 1 : baseDeg;
    const cat = classifyNoteCategory(pc, chordPcs, edo, tonicRoot, tonality);
    const note: PatternNote = { deg, cat };
    if (cat !== "ct" && cat !== "diatonic") note.rel = rel;
    return note;
  });
}

/** Short category labels for display. */
const CAT_LABEL: Record<NoteCategory, string> = {
  ct: "", diatonic: "d", chromatic: "c", micro: "MTS", microTense: "MTT",
};
const CAT_COLOR: Record<NoteCategory, string> = {
  ct:         "border-[#aa66aa40] bg-[#aa66aa15] text-[#cc88cc]",
  diatonic:   "border-[#4a8a4a40] bg-[#1a2a1a] text-[#7aba7a]",
  chromatic:  "border-[#8a6a4a40] bg-[#2a1a0a] text-[#ba9a6a]",
  micro:      "border-[#4a7a9a40] bg-[#0a1a2a] text-[#6aaacc]",
  microTense: "border-[#9a4a4a40] bg-[#2a0a0a] text-[#cc6a6a]",
};

/** Format a PatternNote for text display / input.
 *
 *   "2"   — degree 2, natural (tracks whatever the current mode puts on 2)
 *   "b3"  — degree 3, flattened one step from the mode's natural 3
 *   "#4"  — degree 4, raised one step
 *
 *  Interval-chain mode stays as signed step counts ("+4 +3 -2"). */
function formatNote(n: PatternNote, edo?: number): string {
  // Interval-chain mode — unchanged.
  if (n.intervalChain != null) {
    return n.intervalChain >= 0 ? `+${n.intervalChain}` : `${n.intervalChain}`;
  }
  // ct / diatonic: in-mode, bare degree.
  if (n.cat === "ct" || n.cat === "diatonic") {
    return `${n.deg}`;
  }
  // Chromatic / micro / microTense: derive signed degree name ("b3", "#4")
  // from the stored `rel` EDO step.
  if (n.rel != null && edo) {
    const fullName = degreeName(n.rel, edo);           // e.g. "b3", "#4", "3"
    const digitMatch = fullName.match(/(\d+)$/);
    const digit = digitMatch ? digitMatch[1] : String(n.deg);
    if (fullName.includes("b")) return `b${digit}`;
    if (fullName.includes("#")) return `#${digit}`;
    return `${digit}`;
  }
  return `${n.deg}`;
}

/** Display the formatted note as JSX. Same as the text form — the prior
 *  "_0 / _- / _+" subscript tag was removed since the accidental prefix
 *  (b/#) already conveys the offset. */
function formatNoteJsx(n: PatternNote, edo?: number): React.ReactNode {
  return formatNote(n, edo);
}

/** Parse pattern input: "R 3 5 3" or "MTS:bb4 c:2 R" or "+4 +3 -2" → PatternNote[].
 *  Bare numbers default to "ct". Prefix cat:deg for specific categories.
 *  Tokens starting with +/- are interval-chain notes (signed EDO steps). */
function parsePatternInput(input: string, edo: number): PatternNote[] {
  const tokens = input.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return [];

  // Detect interval-chain mode: first token starts with + or -
  const firstToken = tokens[0];
  if (/^[+-]\d+$/.test(firstToken)) {
    const result: PatternNote[] = [];
    for (const token of tokens) {
      const m = token.match(/^([+-]?)(\d+)$/);
      if (m) {
        const sign = m[1] === "-" ? -1 : 1;
        const steps = parseInt(m[2]) * sign;
        result.push({ deg: 1, cat: "ct" as NoteCategory, intervalChain: steps });
      }
    }
    return result;
  }

  // Degree mode
  const catMap: Record<string, NoteCategory> = {
    "": "ct", "d": "diatonic", "c": "chromatic", "mts": "micro", "mtt": "microTense",
  };
  const names = getFullDegreeNames(edo);
  const nameToStep = new Map<string, number>();
  names.forEach((n, i) => { if (n) nameToStep.set(n.toLowerCase(), i); });

  return tokens.map(token => {
    const upper = token.toUpperCase();
    if (upper === "R") return { deg: 1, cat: "ct" as NoteCategory };

    // Accept the new display form: "2_0" / "b3_-" / "#4_+".  Strip the
    // trailing _0 / _- / _+ suffix so the rest of the parser sees a plain
    // degree token.  The suffix is purely visual — the category is already
    // encoded by the presence of an accidental (natural → diatonic/ct,
    // flat/sharp → chromatic).
    const suffixStripped = token.replace(/_[-+0]$/, "");

    // Check for prefix:deg format (e.g. "MTS:bb4", "c:2", "3")
    const m = suffixStripped.match(/^([a-zA-Z]*):?([#b]*\d+|R)$/i);
    if (m) {
      const prefix = (m[1] || "").toLowerCase();
      const degStr = m[2];
      if (degStr.toUpperCase() === "R") return { deg: 1, cat: catMap[prefix] ?? "ct" as NoteCategory };
      const baseDeg = parseInt(degStr.replace(/[^0-9]/g, ""));
      const cat = catMap[prefix] ?? "ct";
      if (!isNaN(baseDeg) && baseDeg >= 1) {
        const note: PatternNote = { deg: baseDeg, cat };
        // If there are accidentals, look up rel from the EDO degree names
        const step = nameToStep.get(degStr.toLowerCase());
        if (step != null && cat !== "ct" && cat !== "diatonic") note.rel = step;
        return note;
      }
    }
    // Plain number → ct
    const n = parseInt(token);
    if (!isNaN(n) && n >= 1) return { deg: n, cat: "ct" as NoteCategory };
    return null;
  }).filter((n): n is PatternNote => n !== null);
}

/** Generate permutations of a pattern.  Order matches PermutationMode:
 *  [0] Original, [1] Retrograde, [2..N] Rotations, [N+1..] Adjacent swaps.
 *  Adjacent swap i swaps positions i and i+1 (named "Swap i-j" with
 *  1-based labels so "Swap 1-2" exchanges the first two pitches). */
function getPatternPermutations(pattern: PatternNote[]): { name: string; pattern: PatternNote[] }[] {
  const perms: { name: string; pattern: PatternNote[] }[] = [
    { name: "Original", pattern },
    { name: "Retrograde", pattern: [...pattern].reverse() },
  ];
  for (let i = 1; i < pattern.length; i++) {
    perms.push({
      name: `Rotation ${i}`,
      pattern: [...pattern.slice(i), ...pattern.slice(0, i)],
    });
  }
  // Adjacent-pair swaps — "transformation: swap two pitches" from the 2026
  // Course.  Only adjacent pairs so the list stays compact (N−1 entries).
  for (let i = 0; i + 1 < pattern.length; i++) {
    const swapped = [...pattern];
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    perms.push({ name: `Swap ${i + 1}-${i + 2}`, pattern: swapped });
  }
  return perms;
}

/** Interpolate between two hex colors by t in [0,1] */
function lerpColor(a: string, b: string, t: number): string {
  const p = (s: string, o: number) => parseInt(s.slice(o, o + 2), 16);
  const r = Math.round(p(a, 1) * (1 - t) + p(b, 1) * t);
  const g = Math.round(p(a, 3) * (1 - t) + p(b, 3) * t);
  const bl = Math.round(p(a, 5) * (1 - t) + p(b, 5) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

function fitRangeColor(lo: number, hi: number): string {
  const mid = (lo + hi) / 2;
  if (mid <= 0.5) return lerpColor("#5a8a5a", "#c8aa50", mid * 2);
  return lerpColor("#c8aa50", "#c06090", (mid - 0.5) * 2);
}

function fitRangeLabel(lo: number, hi: number): string {
  if (lo === 0 && hi <= 0.2) return "Best fit";
  if (lo === 0 && hi <= 0.5) return "Good fit";
  if (lo >= 0.7)             return "Clash";
  if (lo === 0 && hi >= 0.9) return "Any";
  return "Mixed";
}

// ── Component ────────────────────────────────────────────────────────

interface SegmentState {
  chordPcs: number[];
  root: number;
  chordTypeId: string;
  roman?: string;
  melody: number[];
  cellType?: string | null;
  digitalShape?: string | null;
  triadPairInfo?: string | null;
  hexatonicInfo?: string | null;
  pentatonicInfo?: string | null;
  intervallicInfo?: string | null;
  melody2?: number[];  // SATB alto: below soprano (melody)
  melody3?: number[];  // SATB tenor: below alto
  melody4?: number[];  // SATB bass: lowest voice, root-heavy
  locked?: boolean;    // locked segments skip reshuffle
}

/** Capture cell metadata after a randomMelodyWithAngularity call. */
function captureBergonziMeta() {
  return {
    cellType: getLastCellType(),
    digitalShape: getLastDigitalShape(),
    triadPairInfo: getLastTriadPairInfo(),
    hexatonicInfo: getLastHexatonicInfo(),
    pentatonicInfo: getLastPentatonicInfo(),
    intervallicInfo: getLastIntervallicInfo(),
  };
}

export default function MelodicPatterns() {
  // v2: root-based Markov chain for harmonic progressions
  const [edo, setEdo] = useState<SupportedEdo>(31);
  const [tonicRoot, setTonicRoot] = useState(0);
  // Scale/mode picker drives ALL three pipelines — melody-first, chords-first,
  // and pattern-drill.  The legacy `tonality` ("major"|"minor"|"both") used by
  // the chord-progression / melody generators is derived from the mode below
  // (see `tonality` useMemo).  Old "set tonality" UI has been replaced by the
  // Scale/Mode dropdown.
  const [scaleFamily, setScaleFamily] = useLS<string>("lt_mp_scale_family", "Major Family");
  const [scaleMode,   setScaleMode]   = useLS<string>("lt_mp_scale_mode",   "Ionian");
  // Derive "major" / "minor" / "both" from the mode's characteristic 3rd:
  //   major-3rd modes (Ionian / Lydian / Mixolydian / Major Pent / blues-major / Ryukyu…) → "major"
  //   minor-3rd modes (Aeolian / Dorian / Phrygian / Locrian / Harm-min / Mel-min / Minor Pent / Hirajoshi / In…) → "minor"
  //   ambiguous-3rd modes (Whole Tone / Half-Whole / Altered / Lydian #2 / Double Harmonic…) → "both"
  const tonality: Tonality = useMemo(() => {
    const majorSide = new Set([
      "Ionian", "Lydian", "Mixolydian",
      "Ionian #5", "Lydian Augmented", "Lydian Dominant", "Mixolydian b6",
      "Lydian #5", "Major #5",
      "Major Pentatonic", "Major Blues", "Ryukyu Pentatonic",
    ]);
    const minorSide = new Set([
      "Aeolian", "Dorian", "Phrygian", "Locrian",
      "Harmonic Minor", "Locrian #6", "Dorian #4", "Phrygian Dominant",
      "Ultralocrian",
      "Melodic Minor", "Dorian b2", "Locrian #2",
      "Minor Pentatonic", "Minor Blues",
      "In Pentatonic", "Hirajoshi",
    ]);
    if (majorSide.has(scaleMode)) return "major";
    if (minorSide.has(scaleMode)) return "minor";
    return "both";
  }, [scaleMode]);
  // Back-compat: old preset restores call setTonality — route that through
  // the mode picker by snapping to Ionian / Aeolian / (keep current mode).
  const setTonality = useCallback((t: Tonality) => {
    if (t === "major") { setScaleFamily("Major Family"); setScaleMode("Ionian"); }
    else if (t === "minor") { setScaleFamily("Major Family"); setScaleMode("Aeolian"); }
    // "both" has no single mode equivalent — leave the current mode alone.
  }, [setScaleFamily, setScaleMode]);
  const [patternLength, setPatternLength] = useState(4);
  const [minChordNotes, setMinChordNotes] = useState(3);
  const [allowRepeats, setAllowRepeats] = useState(false);
  const [harmonyCats, setHarmonyCats] = useState<Set<HarmonyCategory>>(new Set(["functional"]));
  const toggleHarmony = (c: HarmonyCategory) => setHarmonyCats(prev => {
    const next = new Set(prev);
    if (next.has(c)) { if (next.size > 1) next.delete(c); }
    else next.add(c);
    return next;
  });
  const availableThirdQualities = useMemo(() => getAvailableThirdQualities(edo), [edo]);
  const [checkedThirdQualities, setCheckedThirdQualities] = useState<Set<string>>(new Set(["min3", "maj3"]));
  const toggleThirdQuality = (q: string) => setCheckedThirdQualities(prev => {
    const next = new Set(prev);
    if (next.has(q)) next.delete(q);
    else next.add(q);
    return next;
  });
  const availableSeventhQualities = useMemo(() => getAvailableSeventhQualities(edo), [edo]);
  const [checkedSeventhQualities, setCheckedSeventhQualities] = useState<Set<string>>(new Set(["min7", "maj7"]));
  const toggleSeventhQuality = (q: string) => setCheckedSeventhQualities(prev => {
    const next = new Set(prev);
    if (next.has(q)) next.delete(q);
    else next.add(q);
    return next;
  });
  const includeAltered = false; // Altered mode removed — always disabled
  const [progMode, setProgMode] = useState<ProgressionMode>("functional");
  const [enabledCats, setEnabledCats] = useState<Set<NoteCategory>>(new Set(["ct"]));
  const toggleCat = (cat: NoteCategory) => setEnabledCats(prev => {
    const next = new Set(prev);
    if (next.has(cat)) { if (next.size > 1) next.delete(cat); }
    else next.add(cat);
    return next;
  });
  const [playbackSpeed, setPlaybackSpeed] = useState(600);
  const [isPlaying, setIsPlaying] = useState(false);
  const [segmentCount, setSegmentCount] = useState(4);
  const [pipeline, setPipeline] = useState<Pipeline>("melody-first");
  const [fitRange, setFitRange] = useState<[number, number]>([0, 0.30]);
  const [bias, setBias] = useState(0.0);
  const [stepwise, setStepwise] = useState(true);
  const angularity = stepwise ? 0 : 1;
  const [vocab, setVocab] = useState<Set<MelodicVocab>>(new Set());
  const cellRes = "diatonic" as const;
  const [voiceCount, setVoiceCount] = useState<1 | 2 | 3 | 4>(1);
  const [multiTonic, setMultiTonic] = useState<MultiTonicCycle | null>(null);
  const [chordsPerCenter, setChordsPerCenter] = useState(2);
  // Only one vocab cell active at a time — selecting one deselects others
  const toggleVocab = (v: MelodicVocab) => setVocab(prev => {
    if (prev.has(v)) return new Set();  // toggle off
    return new Set([v]);                // select this one only
  });
  // Auto-deselect vocab if its required note categories are removed from the pool
  // or if melody notes drop below the vocab's minimum
  useEffect(() => {
    if (vocab.size === 0) return;
    const active = [...vocab][0] as MelodicVocab;
    const reqCats = VOCAB_REQUIRED_CATS[active] ?? [];
    const minNotes = VOCAB_MIN_NOTES[active] ?? 0;
    if ((reqCats.length > 0 && !reqCats.some(c => enabledCats.has(c))) ||
        patternLength < minNotes) {
      setVocab(new Set());
    }
  }, [enabledCats, vocab, patternLength]);
  // Backward compat derived booleans
  const useApproach = vocab.has("approach") || vocab.has("chromPass");
  const useEnclosure = vocab.has("enclosure");
  const [segments, setSegments] = useState<SegmentState[]>([]);
  const [activeSegment, setActiveSegment] = useState(0);
  const [chordBrowserIdx, setChordBrowserIdx] = useState<number | null>(null);
  const [sameChord, setSameChord] = useState(false); // chords-first: same chord across all segments

  // ── Pattern Drill state ──
  type DrillAddressing = "degree" | "interval";
  const [drillAddressing, setDrillAddressing] = useState<DrillAddressing>("degree");
  const [drillPatternInput, setDrillPatternInput] = useState("1 2 3 2");
  const [drillPattern, setDrillPattern] = useState<PatternNote[]>([
    { deg: 1, cat: "ct" }, { deg: 2, cat: "diatonic" }, { deg: 3, cat: "ct" }, { deg: 2, cat: "diatonic" },
  ]);
  const [drillChordInput, setDrillChordInput] = useState("");
  const [drillChords, setDrillChords] = useState<string[]>([]);
  const [drillPermutation, setDrillPermutation] = useState<PermutationMode>("original");
  const [savedPatterns, setSavedPatterns] = useLS<{ name: string; pattern: PatternNote[] }[]>("lt_saved_drill_patterns", []);
  // Drill reuses the shared scale/mode state declared at the top of the
  // component — same picker as the melody-first / chords-first pipelines.
  const drillScaleFamily = scaleFamily;
  const drillScaleMode   = scaleMode;
  const setDrillScaleFamily = setScaleFamily;
  const setDrillScaleMode   = setScaleMode;
  const playTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visualizerRef = useRef<HTMLDivElement>(null);
  const [visualizerVisible, setVisualizerVisible] = useState(true);
  // Metric weights from rhythm generator for melody-rhythm coupling
  const [rhythmWeights, setRhythmWeights] = useState<number[] | undefined>(undefined);
  const [rhythmTiming, setRhythmTiming] = useState<RhythmTimingData | null>(null);
  const handleMetricWeights = useCallback((weights: number[]) => {
    setRhythmWeights(weights);
  }, []);
  const handleRhythmTiming = useCallback((data: RhythmTimingData) => {
    setRhythmTiming(data);
  }, []);
  const fullPool = useMemo(() => Array.from({ length: edo }, (_, i) => i), [edo]);
  const allChordTypes = useMemo(() => getEdoChordTypes(edo), [edo]);
  const availableCats = useMemo(() => availableHarmonyCategories(edo), [edo]);

  // Reset EDO-dependent state when EDO changes
  useEffect(() => {
    setTonicRoot(prev => prev >= edo ? 0 : prev);
    setCheckedThirdQualities(new Set(["min3", "maj3"]));
    setCheckedSeventhQualities(new Set(["min7", "maj7"]));
    setDrillPattern([{ deg: 1, cat: "ct" }, { deg: 2, cat: "diatonic" }, { deg: 3, cat: "ct" }, { deg: 2, cat: "diatonic" }]);
    setDrillPatternInput("1 2 3 2");
  }, [edo]);

  // ── Presets ──
  interface MelodicPreset {
    name: string;
    edo: SupportedEdo; tonality: Tonality; pipeline: Pipeline;
    harmonyCats: string[]; enabledCats: string[];
    progMode: ProgressionMode; bias: number; stepwise: boolean;
    vocab: string[];
    patternLength: number; minChordNotes: number; segmentCount: number;
    fitRange: [number, number]; sameChord: boolean; playbackSpeed: number;
    // Legacy compat
    useApproach?: boolean; useEnclosure?: boolean;
  }
  const PRESET_KEY = "lt_melodic_presets";
  const [presets, setPresets] = useState<MelodicPreset[]>(() => {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); } catch { return []; }
  });
  const [presetName, setPresetName] = useState("");

  const savePreset = useCallback(() => {
    const name = presetName.trim() || `Preset ${presets.length + 1}`;
    const preset: MelodicPreset = {
      name, edo, tonality, pipeline,
      harmonyCats: [...harmonyCats], enabledCats: [...enabledCats],
      progMode, bias, stepwise, vocab: [...vocab],
      patternLength, minChordNotes, segmentCount,
      fitRange, sameChord, playbackSpeed,
    };
    const next = [...presets.filter(p => p.name !== name), preset];
    setPresets(next);
    localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    setPresetName("");
  }, [presetName, presets, edo, tonality, pipeline, harmonyCats, enabledCats, progMode, bias, stepwise, vocab, patternLength, minChordNotes, segmentCount, fitRange, sameChord, playbackSpeed]);

  const loadPreset = useCallback((p: MelodicPreset) => {
    setEdo(p.edo); setTonality(p.tonality); setPipeline(p.pipeline);
    setHarmonyCats(new Set(p.harmonyCats as HarmonyCategory[]));
    setEnabledCats(new Set(p.enabledCats as NoteCategory[]));
    setProgMode(p.progMode); setBias(p.bias); setStepwise(p.stepwise);
    // Load vocab (with legacy compat for old presets that had useApproach/useEnclosure)
    if (p.vocab) {
      setVocab(new Set(p.vocab as MelodicVocab[]));
    } else {
      const v = new Set<MelodicVocab>();
      if (p.useApproach) v.add("approach");
      if (p.useEnclosure) v.add("enclosure");
      setVocab(v);
    }
    setPatternLength(p.patternLength); setMinChordNotes(p.minChordNotes);
    setSegmentCount(p.segmentCount); setFitRange(p.fitRange);
    setSameChord(p.sameChord); setPlaybackSpeed(p.playbackSpeed);
  }, []);

  const deletePreset = useCallback((name: string) => {
    const next = presets.filter(p => p.name !== name);
    setPresets(next);
    localStorage.setItem(PRESET_KEY, JSON.stringify(next));
  }, [presets]);

  // ── Practice Log ──
  const LOG_KEY = "lt_melodic_practice_log";
  const [practiceLog, setPracticeLog] = useState<{ date: string; preset: string; duration: number; segments: number }[]>(() => {
    try { return JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch { return []; }
  });
  const sessionStart = useRef<number>(Date.now());
  const [showLog, setShowLog] = useState(false);

  const logSession = useCallback(() => {
    const elapsed = Math.round((Date.now() - sessionStart.current) / 60000); // minutes
    if (elapsed < 1) return; // skip very short sessions
    const entry = {
      date: new Date().toISOString().slice(0, 16),
      preset: presetName || `${edo}-EDO ${tonality} ${pipeline}`,
      duration: elapsed,
      segments: segments.length,
    };
    const next = [...practiceLog, entry].slice(-100); // keep last 100
    setPracticeLog(next);
    localStorage.setItem(LOG_KEY, JSON.stringify(next));
    sessionStart.current = Date.now();
  }, [practiceLog, presetName, edo, tonality, pipeline, segments.length]);

  // ── Lumatone layout ──
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  useEffect(() => {
    setLayout(null);
    fetch(getLayoutFile(edo))
      .then(r => r.json())
      .then(data => setLayout(computeLayout(data)))
      .catch(() => {});
  }, [edo]);

  // Highlight only during playback, one note/chord at a time
  const [activePcs, setActivePcs] = useState<Set<number>>(new Set());
  const highlightTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const playbackTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const cancelPlayback = useCallback(() => {
    playbackTimers.current.forEach(t => clearTimeout(t));
    playbackTimers.current = [];
    if (playTimeoutRef.current) { clearTimeout(playTimeoutRef.current); playTimeoutRef.current = null; }
    audioEngine.silencePlay();
  }, []);

  const clearHighlightTimers = useCallback(() => {
    highlightTimers.current.forEach(t => clearTimeout(t));
    highlightTimers.current = [];
    setActivePcs(new Set());
  }, []);

  // Convert absolute pitches to the Set of layout key pitches that match.
  // Highlights only the exact pitches being played (not all octave equivalents).
  const pitchesToHighlight = useCallback((absPitches: number[]) => {
    return new Set(absPitches);
  }, []);

  // Click a scale-degree cell: highlight that pitch class across every octave
  // on the visualizer and sound the note in the reference octave (abs = pc).
  const previewPc = useCallback((pc: number) => {
    const normPc = ((pc % edo) + edo) % edo;
    const abs: number[] = [];
    if (layout) {
      for (const k of layout.keys) {
        if (((k.pitch % edo) + edo) % edo === normPc) abs.push(k.pitch);
      }
    }
    setActivePcs(new Set(abs));
    void (async () => {
      if (!audioEngine.isReady()) await audioEngine.init(edo);
      else audioEngine.resume();
      audioEngine.playNote(normPc, edo, 0.8, 0.7);
    })();
  }, [edo, layout]);

  // Silent variant — highlight only, no audio. Used by the pattern-drill
  // section so clicking a degree shows it on the visualizer without
  // triggering playback.
  const previewPcSilent = useCallback((pc: number) => {
    const normPc = ((pc % edo) + edo) % edo;
    const abs: number[] = [];
    if (layout) {
      for (const k of layout.keys) {
        if (((k.pitch % edo) + edo) % edo === normPc) abs.push(k.pitch);
      }
    }
    setActivePcs(new Set(abs));
  }, [edo, layout]);

  // Compute per-note timing gaps from rhythm data or equal spacing
  const getNoteGapsMs = useCallback((noteCount: number): number[] => {
    if (rhythmTiming && rhythmTiming.durations.length === noteCount) {
      const barMs = noteCount * playbackSpeed;
      return rhythmTiming.durations.map(d => d * barMs);
    }
    return Array(noteCount).fill(playbackSpeed);
  }, [playbackSpeed, rhythmTiming]);

  const scheduleHighlights = useCallback((seg: SegmentState, melodyOnly: boolean, chordDelay?: number) => {
    clearHighlightTimers();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const melodyStart = melodyOnly ? 0 : (chordDelay ?? Math.max(600, playbackSpeed * 1.5));
    const noteGaps = getNoteGapsMs(seg.melody.length);

    // Chord: exact pitches as played (octave 3 → s + (3-4)*edo)
    if (!melodyOnly) {
      const chordAbsPitches = seg.chordPcs.map(s => s + (3 - 4) * edo);
      setActivePcs(pitchesToHighlight(chordAbsPitches));
      timers.push(setTimeout(() => setActivePcs(new Set()), melodyStart - 50));
    }

    // Melody notes: highlight synced to rhythm-derived durations
    let offset = 0;
    seg.melody.forEach((absPitch, i) => {
      const gapMs = noteGaps[i];
      const t0 = melodyStart + offset;
      const t1 = t0 + gapMs * 0.85;
      timers.push(setTimeout(() => setActivePcs(pitchesToHighlight([absPitch])), t0));
      timers.push(setTimeout(() => setActivePcs(new Set()), t1));
      offset += gapMs;
    });

    highlightTimers.current = timers;
  }, [edo, playbackSpeed, clearHighlightTimers, pitchesToHighlight, getNoteGapsMs]);

  const highlightedPitches = activePcs;

  // ── Helper: generate counterpoint voices using species techniques ──
  const makeVoices = useCallback((melody: number[], chordPcs: number[]) => {
    const melody2 = voiceCount >= 2 ? generateCounterpoint(
      melody, chordPcs, edo, enabledCats, bias, tonicRoot, tonality,
      1, [],
    ) : undefined;
    const melody3 = voiceCount >= 3 ? generateCounterpoint(
      melody, chordPcs, edo, enabledCats, bias, tonicRoot, tonality,
      2, melody2 ? [melody2] : [],
    ) : undefined;
    const melody4 = voiceCount >= 4 ? generateCounterpoint(
      melody, chordPcs, edo, enabledCats, bias, tonicRoot, tonality,
      3, [melody2!, melody3!].filter(Boolean),
    ) : undefined;
    return { melody2, melody3, melody4 };
  }, [voiceCount, edo, enabledCats, bias, tonicRoot, tonality]);

  // ═══════════════════════════════════════════════════════════════════
  // CHORDS-FIRST: generate chords → randomize melodies over them
  // Melody uses category toggles + angularity (no chord-fit slider)
  // ═══════════════════════════════════════════════════════════════════

  const generateChordsFirst = useCallback((count: number) => {
    // Generate progression — multi-tonic wraps the standard generator
    const prog = sameChord
      ? (() => { const one = generateProgression(edo, 1, harmonyCats, progMode, minChordNotes, tonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, includeAltered); if (!one[0]) return []; return Array.from({ length: count }, () => one[0]); })()
      : multiTonic
        ? generateMultiTonicProgression(edo, multiTonic, chordsPerCenter, harmonyCats, progMode, minChordNotes, tonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, includeAltered)
        : generateProgression(edo, count, harmonyCats, progMode, minChordNotes, tonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, includeAltered);
    const mw = rhythmWeights;
    const segs: SegmentState[] = [];
    const usedMelodies = new Set<string>();
    for (let i = 0; i < prog.length; i++) {
      const ch = prog[i];
      const prevEnd = segs.length > 0 ? segs[segs.length - 1].melody.at(-1) : undefined;
      const nextChordPcs = i + 1 < prog.length ? prog[i + 1].chordPcs : undefined;
      // Retry up to 5 times to avoid duplicate melodies across segments
      let melody: number[] = [];
      let bestMelody: number[] = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        melody = randomMelodyWithAngularity(fullPool, ch.chordPcs, patternLength, enabledCats, bias, allowRepeats, edo, angularity, true, useApproach, useEnclosure, mw, prevEnd, tonicRoot, i, prog.length, nextChordPcs, vocab, cellRes, tonality);
        if (attempt === 0) bestMelody = melody;
        const key = melody.map(n => ((n % edo) + edo) % edo).join(",");
        if (!usedMelodies.has(key)) { bestMelody = melody; usedMelodies.add(key); break; }
      }
      melody = bestMelody;
      const meta = captureBergonziMeta();
      // Generate counterpoint voices based on voiceCount
      // SATB: melody=soprano, v2=alto, v3=tenor, v4=bass
      const { melody2, melody3, melody4 } = makeVoices(melody, ch.chordPcs);
      segs.push({
        chordPcs: ch.chordPcs, root: ch.root, chordTypeId: ch.chordTypeId, roman: ch.roman,
        melody, melody2, melody3, melody4, ...meta,
      });
    }
    setSegments(segs);
    setActiveSegment(0);
  }, [edo, harmonyCats, progMode, fullPool, patternLength, enabledCats, bias, allowRepeats, minChordNotes, tonality, angularity, useApproach, useEnclosure, sameChord, makeVoices, multiTonic, chordsPerCenter, vocab, checkedThirdQualities, checkedSeventhQualities, includeAltered, rhythmWeights, tonicRoot]);

  const reshuffleMelodiesOverChords = useCallback(() => {
    const mw = rhythmWeights;
    setSegments(prev => {
      const segs: typeof prev = [];
      for (let i = 0; i < prev.length; i++) {
        const s = prev[i];
        if (s.locked) { segs.push(s); continue; }
        const prevEnd = segs.length > 0 ? segs[segs.length - 1].melody.at(-1) : undefined;
        const nextChordPcs = i + 1 < prev.length ? prev[i + 1].chordPcs : undefined;
        const melody = randomMelodyWithAngularity(fullPool, s.chordPcs, patternLength, enabledCats, bias, allowRepeats, edo, angularity, true, useApproach, useEnclosure, mw, prevEnd, tonicRoot, i, prev.length, nextChordPcs, vocab, cellRes, tonality);
        segs.push({
          ...s,
          melody, ...captureBergonziMeta(),
        });
      }
      return segs;
    });
  }, [edo, fullPool, patternLength, enabledCats, bias, allowRepeats, angularity, useApproach, useEnclosure, vocab, cellRes, tonality, tonicRoot, rhythmWeights]);

  // ═══════════════════════════════════════════════════════════════════
  // MELODY-FIRST: generate melodies → randomize chords by fit range
  // Melody stays fixed; chords change to fit within fitRange
  // ═══════════════════════════════════════════════════════════════════

  const generateMelodiesFirst = useCallback((count: number) => {
    // When vocab techniques are active (need chord context), generate a chord
    // progression FIRST, then create melodies over those chords. The melody
    // becomes the "fixed" side — reharmonize later finds other fitting chords.
    // When no vocab is active, generate melodies without chord context (original behavior).
    const hasVocab = vocab.size > 0;
    const mw = rhythmWeights;
    const segs: SegmentState[] = [];
    const usedMelodies = new Set<string>();

    if (hasVocab) {
      // Generate chords first so melody has chord context for vocab strategies
      const prog = generateProgression(edo, count, harmonyCats, progMode, minChordNotes, tonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, includeAltered);
      for (let i = 0; i < prog.length; i++) {
        const ch = prog[i];
        const prevEnd = segs.length > 0 ? segs[segs.length - 1].melody.at(-1) : undefined;
        const nextChordPcs = i + 1 < prog.length ? prog[i + 1].chordPcs : undefined;
        let melody: number[] = [];
        let bestMelody: number[] = [];
        for (let attempt = 0; attempt < 5; attempt++) {
          melody = randomMelodyWithAngularity(fullPool, ch.chordPcs, patternLength, enabledCats, bias, allowRepeats, edo, angularity, true, useApproach, useEnclosure, mw, prevEnd, tonicRoot, i, prog.length, nextChordPcs, vocab, cellRes, tonality);
          if (attempt === 0) bestMelody = melody;
          const key = melody.map(n => ((n % edo) + edo) % edo).join(",");
          if (!usedMelodies.has(key)) { bestMelody = melody; usedMelodies.add(key); break; }
        }
        const voices = makeVoices(bestMelody, ch.chordPcs);
        segs.push({ chordPcs: ch.chordPcs, root: ch.root, chordTypeId: ch.chordTypeId, roman: ch.roman, melody: bestMelody, ...voices, ...captureBergonziMeta() });
      }
    } else {
      // Generate chord progression via Markov chain first, then create melodies
      const prog = generateProgression(edo, count, harmonyCats, progMode, minChordNotes, tonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, includeAltered);
      for (let i = 0; i < prog.length; i++) {
        const ch = prog[i];
        const prevEnd = segs.length > 0 ? segs[segs.length - 1].melody.at(-1) : undefined;
        let melody: number[] = [];
        let bestMelody: number[] = [];
        for (let attempt = 0; attempt < 5; attempt++) {
          melody = randomMelodyWithAngularity(fullPool, ch.chordPcs, patternLength, enabledCats, bias, allowRepeats, edo, angularity, true, useApproach, useEnclosure, mw, prevEnd, tonicRoot, i, prog.length, i + 1 < prog.length ? prog[i + 1].chordPcs : undefined, undefined, "diatonic", tonality);
          if (attempt === 0) bestMelody = melody;
          const key = melody.map(n => ((n % edo) + edo) % edo).join(",");
          if (!usedMelodies.has(key)) { bestMelody = melody; usedMelodies.add(key); break; }
        }
        const voices = makeVoices(bestMelody, ch.chordPcs);
        segs.push({ chordPcs: ch.chordPcs, root: ch.root, chordTypeId: ch.chordTypeId, roman: ch.roman, melody: bestMelody, ...voices, ...captureBergonziMeta() });
      }
    }
    setSegments(segs);
    setActiveSegment(0);
  }, [edo, fullPool, patternLength, allowRepeats, harmonyCats, minChordNotes, tonality, enabledCats, bias, fitRange, angularity, useApproach, useEnclosure, makeVoices, checkedThirdQualities, checkedSeventhQualities, includeAltered, rhythmWeights, progMode, tonicRoot, vocab]);

  const reshuffleChordsOverMelodies = useCallback(() => {
    // Generate a new Markov chain progression, then assign chords to melodies.
    // This ensures harmonic coherence even when reharmonizing.
    setSegments(prev => {
      const unlocked = prev.filter(s => !s.locked).length;
      if (unlocked === 0) return prev;
      const prog = generateProgression(edo, unlocked, harmonyCats, progMode, minChordNotes, tonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, includeAltered);
      const result: typeof prev = [];
      let progIdx = 0;
      for (const s of prev) {
        if (s.locked) { result.push(s); continue; }
        const ch = prog[progIdx++];
        if (ch) {
          result.push({ ...s, chordPcs: ch.chordPcs, root: ch.root, chordTypeId: ch.chordTypeId, roman: ch.roman });
        } else {
          result.push(s);
        }
      }
      return result;
    });
  }, [edo, harmonyCats, progMode, minChordNotes, tonality, tonicRoot, checkedThirdQualities, checkedSeventhQualities, includeAltered]);

  // ═══════════════════════════════════════════════════════════════════

  const generate = useCallback((count: number) => {
    if (pipeline === "pattern-drill") return; // drill has its own generation
    if (pipeline === "chords-first") generateChordsFirst(count);
    else generateMelodiesFirst(count);
  }, [pipeline, generateChordsFirst, generateMelodiesFirst]);

  // Clear extra voices when voiceCount decreases
  useEffect(() => {
    setSegments(prev => prev.map(s => {
      const next = { ...s };
      if (voiceCount < 2) { next.melody2 = undefined; next.melody3 = undefined; next.melody4 = undefined; }
      else if (voiceCount < 3) { next.melody3 = undefined; next.melody4 = undefined; }
      else if (voiceCount < 4) { next.melody4 = undefined; }
      return next;
    }));
  }, [voiceCount]);

  // Category and rhythm-weight changes take effect on the NEXT generation;
  // existing segments are never silently regenerated.

  const randomizeSegmentMelody = (i: number) => {
    const mw = rhythmWeights;
    setSegments(prev => prev.map((s, idx) => {
      if (idx !== i) return s;
      const prevEnd = idx > 0 ? prev[idx - 1].melody.at(-1) : undefined;
      const melody = randomMelodyWithAngularity(
          fullPool, s.chordPcs, patternLength, enabledCats, bias, allowRepeats, edo, angularity,
          pipeline === "chords-first", useApproach, useEnclosure, mw, prevEnd, tonicRoot,
          0, 0, undefined, vocab, cellRes, tonality,
        );
      return { ...s, melody, ...captureBergonziMeta() };
    }));
  };

  const addSegment = () => {
    const mw = rhythmWeights;
    if (pipeline === "chords-first") {
      setSegments(prev => {
        // In sameChord mode, reuse the first segment's chord
        const ch = sameChord && prev.length > 0
          ? { chordPcs: prev[0].chordPcs, root: prev[0].root, chordTypeId: prev[0].chordTypeId, roman: prev[0].roman }
          : (() => { const p = generateProgression(edo, 1, harmonyCats, progMode, minChordNotes, tonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, includeAltered); return p[0]; })();
        if (!ch) return prev;
        const prevEnd = prev.length > 0 ? prev[prev.length - 1].melody.at(-1) : undefined;
        const melody = randomMelodyWithAngularity(fullPool, ch.chordPcs, patternLength, enabledCats, bias, allowRepeats, edo, angularity, true, useApproach, useEnclosure, mw, prevEnd, tonicRoot, 0, 0, undefined, vocab, cellRes, tonality);
        return [...prev, {
          chordPcs: ch.chordPcs, root: ch.root, chordTypeId: ch.chordTypeId, roman: ch.roman,
          melody, ...captureBergonziMeta(),
        }];
      });
    } else {
      setSegments(prev => {
        const prevEnd = prev.length > 0 ? prev[prev.length - 1].melody.at(-1) : undefined;
        const melody = randomMelodyWithAngularity(fullPool, [], patternLength, enabledCats, bias, allowRepeats, edo, angularity, false, useApproach, useEnclosure, mw, prevEnd, tonicRoot, 0, 0, undefined, vocab, cellRes, tonality);
        const bm = captureBergonziMeta();
        const match = pickChordForMelodyInRange(melody, edo, fitRange[0], fitRange[1], harmonyCats, minChordNotes, tonality, tonicRoot, undefined, checkedSeventhQualities, checkedThirdQualities, includeAltered);
        if (match) {
          return [...prev, { chordPcs: match.chordPcs, root: match.root, chordTypeId: match.chordTypeId, melody, ...bm }];
        }
        const prog = generateProgression(edo, 1, harmonyCats, "random", minChordNotes, tonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, includeAltered);
        const ch = prog[0];
        if (!ch) return prev;
        return [...prev, { chordPcs: ch.chordPcs, root: ch.root, chordTypeId: ch.chordTypeId, roman: ch.roman, melody, ...bm }];
      });
    }
  };

  const replaceChord = (segIdx: number, root: number, chordTypeId: string, chordPcs: number[]) => {
    setSegments(prev => prev.map((s, idx) =>
      idx === segIdx ? { ...s, root, chordTypeId, chordPcs, roman: undefined } : s,
    ));
    setChordBrowserIdx(null);
  };

  const removeSegment = (i: number) => {
    if (segments.length <= 1) return;
    setSegments(prev => {
      const next = prev.filter((_, idx) => idx !== i);
      if (activeSegment >= next.length) setActiveSegment(Math.max(0, next.length - 1));
      return next;
    });
  };

  const toggleLock = (i: number) => {
    setSegments(prev => prev.map((s, idx) => idx === i ? { ...s, locked: !s.locked } : s));
  };

  // Per-segment stepping: randomize just the "variable" side for one segment
  const stepSegmentChord = (i: number) => {
    setSegments(prev => prev.map((s, idx) => {
      if (idx !== i || s.locked) return s;
      const match = pickChordForMelodyInRange(s.melody, edo, fitRange[0], fitRange[1], harmonyCats, minChordNotes, tonality, tonicRoot, undefined, checkedSeventhQualities, checkedThirdQualities, includeAltered);
      if (match) return { ...s, chordPcs: match.chordPcs, root: match.root, chordTypeId: match.chordTypeId, roman: undefined };
      const prog = generateProgression(edo, 1, harmonyCats, "random", minChordNotes, tonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, includeAltered);
      const ch = prog[0];
      if (!ch) return s;
      return { ...s, chordPcs: ch.chordPcs, root: ch.root, chordTypeId: ch.chordTypeId, roman: ch.roman };
    }));
  };

  // Reharmonize around a specific segment: keep that segment's chord, regenerate all others
  // using the Markov chain so they flow musically to/from the anchor chord.
  const reharmonizeAround = (anchorIdx: number) => {
    setSegments(prev => {
      if (prev.length <= 1) return prev;
      const anchor = prev[anchorIdx];
      // Generate chords for positions before the anchor
      const beforeCount = anchorIdx;
      const afterCount = prev.length - anchorIdx - 1;
      // Generate a progression that ends at anchor position: generate beforeCount+1 chords,
      // use the first beforeCount (the +1 slot will be replaced by anchor)
      const beforeProg = beforeCount > 0
        ? generateProgression(edo, beforeCount, harmonyCats, progMode, minChordNotes, tonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, includeAltered)
        : [];
      // Generate chords continuing from anchor: seed a new progression starting from anchor's
      // harmonic neighborhood — generate afterCount+1, skip the first (anchor proxy), take the rest
      const afterProg = afterCount > 0
        ? generateProgression(edo, afterCount + 1, harmonyCats, progMode, minChordNotes, tonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, includeAltered).slice(1)
        : [];
      // Stitch: before chords + anchor (unchanged) + after chords
      const result: typeof prev = [];
      let beforeIdx = 0;
      let afterIdx = 0;
      for (let i = 0; i < prev.length; i++) {
        if (i === anchorIdx) {
          result.push(anchor);
        } else if (i < anchorIdx) {
          const ch = beforeProg[beforeIdx++];
          if (ch) {
            result.push({ ...prev[i], chordPcs: ch.chordPcs, root: ch.root, chordTypeId: ch.chordTypeId, roman: ch.roman });
          } else {
            result.push(prev[i]);
          }
        } else {
          const ch = afterProg[afterIdx++];
          if (ch) {
            result.push({ ...prev[i], chordPcs: ch.chordPcs, root: ch.root, chordTypeId: ch.chordTypeId, roman: ch.roman });
          } else {
            result.push(prev[i]);
          }
        }
      }
      return result;
    });
  };

  // ── Audio ──
  const ensureAudio = useCallback(async () => {
    if (!audioEngine.isReady()) await audioEngine.init(edo);
    else audioEngine.resume();
  }, [edo]);

  const playSegment = useCallback(async (seg: SegmentState) => {
    await ensureAudio();
    const chordNotes = seg.chordPcs.map(s => s + (3 - 4) * edo);
    const noteCount = seg.melody.length;
    const noteGapsMs = getNoteGapsMs(noteCount);

    const chordDelay = Math.max(600, playbackSpeed * 1.5);
    const melodyDuration = noteGapsMs.reduce((a, b) => a + b, 0);
    const chordSustain = (chordDelay + melodyDuration) / 1000;
    scheduleHighlights(seg, false, chordDelay);
    audioEngine.playChord(chordNotes, edo, chordSustain, 0.35);

    // Schedule melody notes with rhythm-derived duration
    setTimeout(() => {
      let offset = 0;
      for (let i = 0; i < noteCount; i++) {
        const gapMs = noteGapsMs[i];
        const noteDur = gapMs / 1000 * 0.85;
        setTimeout(() => {
          audioEngine.playNote(seg.melody[i], edo, noteDur, 0.7);
          // Counterpoint: play additional voices simultaneously at lower volumes
          if (seg.melody2 && seg.melody2[i] !== undefined) {
            audioEngine.playNote(seg.melody2[i], edo, noteDur, 0.45);
          }
          if (seg.melody3 && seg.melody3[i] !== undefined) {
            audioEngine.playNote(seg.melody3[i], edo, noteDur, 0.40);
          }
          if (seg.melody4 && seg.melody4[i] !== undefined) {
            audioEngine.playNote(seg.melody4[i], edo, noteDur, 0.35);
          }
        }, offset);
        offset += gapMs;
      }
    }, chordDelay);
  }, [edo, playbackSpeed, ensureAudio, scheduleHighlights, rhythmTiming]);

  const playAllSegments = useCallback(async () => {
    if (segments.length === 0) return;
    await ensureAudio();
    // Cancel any in-flight playback before starting new one
    cancelPlayback();
    clearHighlightTimers();
    setIsPlaying(true);
    const chordDelay = Math.max(600, playbackSpeed * 1.5);
    const noteGaps = getNoteGapsMs(patternLength);
    const melodyMs = noteGaps.reduce((a, b) => a + b, 0);
    const segDuration = chordDelay + melodyMs + 300;
    for (let i = 0; i < segments.length; i++) {
      const t = i * segDuration;
      playbackTimers.current.push(setTimeout(() => { setActiveSegment(i); playSegment(segments[i]); }, t));
    }
    playTimeoutRef.current = setTimeout(() => setIsPlaying(false), segments.length * segDuration);
  }, [segments, playbackSpeed, patternLength, playSegment, ensureAudio, rhythmTiming, cancelPlayback, clearHighlightTimers]);

  const playMelodyOnly = useCallback(async (seg: SegmentState) => {
    await ensureAudio();
    scheduleHighlights(seg, true);
    const noteGaps = getNoteGapsMs(seg.melody.length);
    let offset = 0;
    for (let i = 0; i < seg.melody.length; i++) {
      const gapMs = noteGaps[i];
      const noteDur = gapMs / 1000 * 0.85;
      setTimeout(() => {
        audioEngine.playNote(seg.melody[i], edo, noteDur, 0.7);
      }, offset);
      offset += gapMs;
    }
  }, [edo, ensureAudio, scheduleHighlights, getNoteGapsMs]);

  useEffect(() => {
    return () => { if (playTimeoutRef.current) clearTimeout(playTimeoutRef.current); clearHighlightTimers(); };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === " ") { e.preventDefault(); playAllSegments(); }
      if (e.key === "r") { e.preventDefault(); generate(segmentCount); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [playAllSegments, generate, segmentCount]);

  // Track whether visualizer is scrolled out of view
  useEffect(() => {
    const el = visualizerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisualizerVisible(entry.isIntersecting),
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [layout]);

  const reshuffleAction = pipeline === "melody-first" ? reshuffleChordsOverMelodies : reshuffleMelodiesOverChords;
  const generateLabel = pipeline === "melody-first" ? "New Melodies" : "New Chords";
  const reshuffleLabel = pipeline === "melody-first" ? "↻ Reharmonize" : "↻ New Melodies";

  return (
    <div className="max-w-[1400px] mx-auto py-4" style={{ paddingRight: 260 }}>
      {/* Main content */}
      <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-[#888] uppercase tracking-widest mb-1">Melodic Patterns</h2>
        <p className="text-[11px] text-[#555]">
          Fix one side, permute the other — internalize how melodies sound over chords
        </p>
      </div>

      {/* Pipeline tabs */}
      <div className="flex gap-2">
        <button onClick={() => setPipeline("melody-first")}
          className={`flex-1 py-2 text-xs rounded border transition-colors text-center ${
            pipeline === "melody-first"
              ? "bg-[#1a1a2a] border-[#8888cc] text-[#aaaaee]"
              : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
          }`}>
          <div className="font-bold">Melody Fixed → Chords Vary</div>
          <div className="text-[9px] mt-0.5 opacity-70">Lock melodies, explore different harmonizations</div>
        </button>
        <button onClick={() => setPipeline("chords-first")}
          className={`flex-1 py-2 text-xs rounded border transition-colors text-center ${
            pipeline === "chords-first"
              ? "bg-[#1a2a1a] border-[#5a8a5a] text-[#7aaa7a]"
              : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
          }`}>
          <div className="font-bold">Chords Fixed → Melodies Vary</div>
          <div className="text-[9px] mt-0.5 opacity-70">Lock chords, explore melody permutations</div>
        </button>
        <button onClick={() => setPipeline("pattern-drill")}
          className={`flex-1 py-2 text-xs rounded border transition-colors text-center ${
            pipeline === "pattern-drill"
              ? "bg-[#2a1a2a] border-[#aa66aa] text-[#cc88cc]"
              : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
          }`}>
          <div className="font-bold">Pattern Drill</div>
          <div className="text-[9px] mt-0.5 opacity-70">Lock a pattern, cycle through chord changes</div>
        </button>
      </div>

      {/* Lumatone visualizer */}
      <div ref={visualizerRef}>
        {layout && (
          <LumatoneKeyboard layout={layout} highlightedPitches={highlightedPitches} />
        )}
      </div>

      {/* ═══ Exploration pipelines (melody-first / chords-first) ═══ */}
      {pipeline !== "pattern-drill" && (<>
      {/* Row 1: Global settings */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1">EDO</label>
          <select value={edo} onChange={e => setEdo(Number(e.target.value) as SupportedEdo)}
            className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white focus:outline-none">
            {SUPPORTED_EDOS.map(n => <option key={n} value={n}>{n}-EDO</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1">Root</label>
          <select value={tonicRoot} onChange={e => setTonicRoot(Number(e.target.value))}
            className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white focus:outline-none">
            {Array.from({ length: edo }, (_, i) => (
              <option key={i} value={i}>{formatHalfAccidentals(pcToNoteNameWithEnharmonic(i, edo))}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1">Scale / Mode</label>
          <select
            value={`${scaleFamily}::${scaleMode}`}
            onChange={e => {
              const [fam, mode] = e.target.value.split("::");
              setScaleFamily(fam); setScaleMode(mode);
            }}
            className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 h-7 text-[11px] text-white focus:outline-none"
            title="Drives degree resolution, the derived major/minor tonality, and every pipeline's chord pool. Replaces the old Major/Minor/Both toggle.">
            {(() => {
              const byFam: Record<string, string[]> = {};
              for (const { family, mode } of DRILL_SCALE_OPTIONS) {
                (byFam[family] = byFam[family] ?? []).push(mode);
              }
              return Object.entries(byFam).map(([fam, modes]) => (
                <optgroup key={fam} label={fam}>
                  {modes.map(m => (
                    <option key={m} value={`${fam}::${m}`}>{m}</option>
                  ))}
                </optgroup>
              ));
            })()}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1">Melody Notes</label>
          <div className="flex gap-1">
            {PATTERN_LENGTHS.map(n => (
              <button key={n} onClick={() => setPatternLength(n)}
                className={`w-7 h-7 text-[11px] rounded border transition-colors ${
                  patternLength === n ? "bg-[#2a2a2a] border-[#555] text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}>{n}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1">Min Chord Notes</label>
          <div className="flex gap-1">
            {CHORD_NOTE_COUNTS.map(n => (
              <button key={n} onClick={() => setMinChordNotes(n)}
                className={`w-7 h-7 text-[11px] rounded border transition-colors ${
                  minChordNotes === n ? "bg-[#2a2a2a] border-[#555] text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}>{n}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1">Count</label>
          <div className="flex gap-1">
            {[2, 4, 6, 8, 12, 16].map(n => (
              <button key={n} onClick={() => setSegmentCount(n)}
                className={`px-2 h-7 text-[10px] rounded border transition-colors ${
                  segmentCount === n ? "bg-[#2a2a2a] border-[#555] text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}>{n}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1">Speed</label>
          <select value={playbackSpeed} onChange={e => setPlaybackSpeed(Number(e.target.value))}
            className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white focus:outline-none">
            <option value={250}>Very Fast</option>
            <option value={400}>Fast</option>
            <option value={600}>Medium</option>
            <option value={900}>Slow</option>
            <option value={1200}>Very Slow</option>
          </select>
        </div>
      </div>

      {/* Row 2: Harmony (non-xenharmonic categories) */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-[10px] text-[#666] uppercase tracking-wider">Harmony</span>
        {HARMONY_CATEGORIES.filter(c => availableCats.has(c.id) && c.group !== "Xenharmonic").map(c => {
          const on = harmonyCats.has(c.id);
          const color = HARMONY_GROUP_COLORS[c.group] ?? "#999";
          return (
            <button key={c.id} onClick={() => toggleHarmony(c.id)} title={`${c.desc} [${c.group}]`}
              className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
              }`}
              style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
              {c.label.replace("{edo}", String(edo))}
            </button>
          );
        })}
      </div>

      {/* Row 2b: 3rds + 7ths + Logic */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-[10px] text-[#666] uppercase tracking-wider">3rds</span>
        {availableThirdQualities.map(q => {
          const on = checkedThirdQualities.has(q.id);
          const color = "#7aaa6a";
          return (
            <button key={q.id} onClick={() => toggleThirdQuality(q.id)} title={q.desc}
              className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
              }`}
              style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
              {q.label}
            </button>
          );
        })}
        {availableSeventhQualities.length > 0 && <>
          <div className="border-l border-[#2a2a2a] h-5 mx-0.5" />
          <span className="text-[10px] text-[#666] uppercase tracking-wider">7ths</span>
          {availableSeventhQualities.map(q => {
            const on = checkedSeventhQualities.has(q.id);
            const color = "#b07acc";
            return (
              <button key={q.id} onClick={() => toggleSeventhQuality(q.id)} title={q.desc}
                className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                  on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
                {q.label}
              </button>
            );
          })}
        </>}
        <div className="border-l border-[#2a2a2a] h-5 mx-0.5" />
        <span className="text-[10px] text-[#666] uppercase tracking-wider">Logic</span>
        {([
          { value: "functional" as ProgressionMode, label: "Functional", desc: "Chords follow common-practice tendencies (T→PD→D→T)", color: "#6a9aca" },
          { value: "random" as ProgressionMode,     label: "Random",     desc: "Pick chords randomly from the pool",                  color: "#999" },
        ]).map(m => (
          <button key={m.value} onClick={() => setProgMode(m.value)} title={m.desc}
            className={`px-2 py-1 text-[10px] rounded border transition-colors ${
              progMode === m.value ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
            }`}
            style={progMode === m.value ? { backgroundColor: m.color + "30", borderColor: m.color, color: m.color } : {}}>
            {m.label}
          </button>
        ))}
      </div>

      {/* Row 3: Chord fit slider (melody-first only) */}
      {pipeline === "melody-first" && (
        <div className="flex items-center gap-2">
          <div className="flex flex-col gap-0.5" style={{ minWidth: 200 }}>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#666] uppercase tracking-wider">Chord Fit</span>
              <span className="text-[9px] font-mono" style={{ color: fitRangeColor(fitRange[0], fitRange[1]) }}>
                {fitRangeLabel(fitRange[0], fitRange[1])} ({Math.round(fitRange[0] * 100)}–{Math.round(fitRange[1] * 100)}%)
              </span>
            </div>
            <div className="relative h-5 flex items-center" style={{ touchAction: "none" }}>
              <div className="absolute inset-x-0 h-1.5 rounded-full" style={{
                background: "linear-gradient(to right, #5a8a5a, #c8aa50 50%, #c06090)"
              }} />
              <div className="absolute h-1.5 rounded-full" style={{
                left: `${fitRange[0] * 100}%`,
                width: `${(fitRange[1] - fitRange[0]) * 100}%`,
                background: fitRangeColor(fitRange[0], fitRange[1]),
                opacity: 0.6,
              }} />
              <input type="range" min={0} max={100} step={5} value={Math.round(fitRange[0] * 100)}
                onChange={e => {
                  const v = Number(e.target.value) / 100;
                  setFitRange(prev => [Math.max(0, Math.min(v, prev[1] - 0.05)), prev[1]]);
                }}
                className="fit-range-thumb absolute inset-x-0"
                style={{ pointerEvents: "none", background: "transparent", appearance: "none", WebkitAppearance: "none", height: 20, zIndex: 2 }}
              />
              <input type="range" min={0} max={100} step={5} value={Math.round(fitRange[1] * 100)}
                onChange={e => {
                  const v = Number(e.target.value) / 100;
                  setFitRange(prev => [prev[0], Math.max(v, prev[0] + 0.05)]);
                }}
                className="fit-range-thumb absolute inset-x-0"
                style={{ pointerEvents: "none", background: "transparent", appearance: "none", WebkitAppearance: "none", height: 20, zIndex: 3 }}
              />
              <div className="absolute top-3.5 left-0 text-[7px] text-[#5a8a5a]">Best</div>
              <div className="absolute top-3.5 right-0 text-[7px] text-[#c06090]">Clash</div>
            </div>
          </div>
        </div>
      )}

      {/* Row 4: Note Pool */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[#666] uppercase tracking-wider">Note Pool</span>
        {CATEGORY_OPTIONS.map(c => {
          const on = enabledCats.has(c.value);
          return (
            <button key={c.value} onClick={() => toggleCat(c.value)} title={c.desc}
              className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
              }`}
              style={on ? { backgroundColor: c.color + "30", borderColor: c.color, color: c.color } : {}}>
              {c.label}
            </button>
          );
        })}
      </div>

      {/* Row 5: Vocabulary */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-[#666] uppercase tracking-wider">Vocabulary</span>
        <button onClick={() => setStepwise(v => !v)}
          className={`px-2 py-1 text-[10px] rounded border transition-colors ${
            stepwise ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
          }`}
          style={stepwise ? { backgroundColor: "#5a8a5a30", borderColor: "#5a8a5a", color: "#5a8a5a" } : {}}
          title="Prefer stepwise motion between notes">Stepwise</button>
        <div className="border-l border-[#2a2a2a] h-4 mx-0.5" />
        {VOCAB_GROUPS.map(g => {
          const groupColors: Record<string, string> = {
            "Bebop Cells": "#c8aa50", "Classical Figures": "#8888cc", "Bergonzi Cells": "#6ab06a", "Universal Cells": "#c06090",
          };
          const color = groupColors[g.group] ?? "#999";
          return (
            <div key={g.group} className="flex items-center gap-1">
              <span className="text-[8px] uppercase tracking-wider" style={{ color: color + "77" }}>{g.group}</span>
              {g.items.map(item => {
                const on = vocab.has(item.id);
                const dimmed = vocab.size > 0 && !on; // dim others when one is selected
                // Disable if note pool doesn't include required categories
                const reqCats = VOCAB_REQUIRED_CATS[item.id] ?? [];
                const poolOk = reqCats.length === 0 || reqCats.some(c => enabledCats.has(c));
                const minNotes = VOCAB_MIN_NOTES[item.id] ?? 0;
                const notesOk = patternLength >= minNotes;
                const canUse = poolOk && notesOk;
                return (
                  <button key={item.id}
                    onClick={() => { if (canUse) toggleVocab(item.id); }}
                    disabled={!canUse}
                    title={!poolOk ? `Requires ${reqCats.map(c => {
                      const opt = CATEGORY_OPTIONS.find(o => o.value === c);
                      return opt ? opt.label : c;
                    }).join(" or ")} in Note Pool` : !notesOk ? `Requires ${minNotes}+ melody notes` : item.desc}
                    className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                      !canUse ? "bg-[#111] border-[#1a1a1a] text-[#333] cursor-not-allowed" :
                      on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                    }`}
                    style={{
                      ...(on && canUse ? { backgroundColor: color + "30", borderColor: color, color } : {}),
                      ...(dimmed && canUse ? { opacity: 0.3 } : {}),
                    }}>
                    {item.label}
                  </button>
                );
              })}
              {g !== VOCAB_GROUPS[VOCAB_GROUPS.length - 1] && <div className="border-l border-[#2a2a2a] h-4 mx-0.5" />}
            </div>
          );
        })}
      </div>

      {/* Row 6: Texture — voice count */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[#666] uppercase tracking-wider">Voices</span>
        {([1, 2, 3, 4] as const).map(n => {
          const active = voiceCount === n;
          const labels = ["1", "2", "3", "4"];
          const titles = [
            "Single voice",
            "2 voices (species counterpoint)",
            "3 voices (species counterpoint)",
            "4 voices (species counterpoint)",
          ];
          const colors = ["#5a8a5a", "#8888cc", "#c8aa50", "#c06090"];
          return (
            <button key={n} onClick={() => setVoiceCount(n)}
              className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                active ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
              }`}
              style={active ? { backgroundColor: colors[n - 1] + "30", borderColor: colors[n - 1], color: colors[n - 1] } : {}}
              title={titles[n - 1]}>{labels[n - 1]}</button>
          );
        })}
      </div>

      {/* Row 6b: Multi-tonic system (optional) */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[#666] uppercase tracking-wider">Key Cycle</span>
        <button onClick={() => setMultiTonic(null)}
          className={`px-2 py-1 text-[10px] rounded border transition-colors ${
            !multiTonic ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
          }`}
          style={!multiTonic ? { backgroundColor: "#5a8a5a30", borderColor: "#5a8a5a", color: "#5a8a5a" } : {}}
          title="Single key center — standard progression">Single Key</button>
        {([
          { value: "major3rd" as const, label: "Maj 3rds", color: "#c8aa50", title: "Coltrane changes — major-third cycle (C → E → A♭)" },
          { value: "minor3rd" as const, label: "Min 3rds", color: "#c06090", title: "Diminished axis — minor-third cycle (C → E♭ → G♭ → A)" },
          { value: "tritone" as const,  label: "Tritone",  color: "#8888cc", title: "Tritone axis — (C → F♯)" },
          { value: "wholeTone" as const, label: "Whole Tone", color: "#aa8866", title: "Whole-tone cycle through all keys by M2" },
        ]).map(opt => {
          const active = multiTonic === opt.value;
          return (
            <button key={opt.value} onClick={() => setMultiTonic(active ? null : opt.value)}
              className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                active ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
              }`}
              style={active ? { backgroundColor: opt.color + "30", borderColor: opt.color, color: opt.color } : {}}
              title={opt.title}>{opt.label}</button>
          );
        })}
        {multiTonic && (
          <div className="flex items-center gap-1 ml-2">
            <span className="text-[9px] text-[#666]">per key:</span>
            <input type="range" min={1} max={6} value={chordsPerCenter} onChange={e => setChordsPerCenter(Number(e.target.value))}
              className="w-16 h-1 accent-[#c8aa50]" />
            <span className="text-[10px] text-[#999] w-3">{chordsPerCenter}</span>
          </div>
        )}
      </div>

      <div className="flex gap-2 items-center">
        <button onClick={() => generate(segmentCount)}
          className="px-5 py-2 text-sm rounded border bg-[#0e1a0e] border-[#2a4a2a] text-[#5a8a5a] hover:text-[#7aaa7a] transition-colors font-bold">
          {generateLabel} {segmentCount}
        </button>
        <button onClick={reshuffleAction}
          className="px-5 py-2 text-sm rounded border bg-[#1a1a2a] border-[#3a3a5a] text-[#8888cc] hover:text-[#aaaaee] transition-colors font-bold">
          {reshuffleLabel}
        </button>
        {pipeline === "chords-first" && (
          <button onClick={() => setSameChord(v => !v)}
            className={`px-3 py-2 text-[10px] rounded border transition-colors ${
              sameChord ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
            }`}
            style={sameChord ? { backgroundColor: "#e0a04030", borderColor: "#e0a040", color: "#e0a040" } : {}}
            title="Use one chord for all segments — hear multiple melody permutations over the same harmony">
            Same Chord
          </button>
        )}
      </div>

      {/* Segments — 4 per row, equal width, horizontal scroll */}
      <div className="flex flex-wrap gap-2" style={{ maxWidth: "100%" }}>
        {segments.map((seg, i) => {
          const overlap = chordMelodyOverlap(seg.melody, seg.chordPcs, edo);
          const fit = classifyFit(overlap);
          const fitColor = FIT_COLORS[fit];
          const intervals = getIntervals(seg.melody);
          const contour = getContour(intervals);
          const ct = allChordTypes.find(c => c.id === seg.chordTypeId);
          const defaultParts = ct
            ? toRomanNumeralParts(edo, seg.root, ct)
            : { roman: "?", chordType: "Unknown" };
          // Use V/ notation for secondary dominants, then generation override, then default
          const secLabel = getSecDomLabel(edo, seg.root, seg.chordTypeId, harmonyCats);
          const roman = secLabel ?? seg.roman ?? defaultParts.roman;
          const romanParts = { roman, chordType: defaultParts.chordType };

          const isLocked = !!seg.locked;
          // In chords-first, the variable side is melody; in melody-first, it's chords
          const variableSide = pipeline === "chords-first" ? "melody" : "chord";

          return (
            <div key={i}
              className={`bg-[#0d0d0d] border rounded-lg p-3 transition-colors ${
                isLocked ? "border-[#e0a04060]" : activeSegment === i ? "border-[#3a3a3a]" : "border-[#1a1a1a]"
              }`}
              style={{ width: "calc(25% - 6px)", minWidth: 200, flexShrink: 0 }}
              onClick={() => setActiveSegment(i)}>

              {/* Chord name — top, prominent, distinct color */}
              <div className="text-center cursor-pointer mb-3"
                onClick={e => { e.stopPropagation(); setActivePcs(pitchesToHighlight(seg.chordPcs.map(s => s + (3 - 4) * edo))); }}>
                <div className="text-[18px] font-bold leading-tight hover:opacity-80 transition-colors"
                  style={{ color: "#c8a0e0" }}>{renderAccidentals(romanParts.roman)}</div>
                <div className="text-[10px] text-[#666] mt-0.5">{romanParts.chordType}</div>
                <div className="flex gap-1 mt-1 justify-center flex-wrap">
                  {seg.chordPcs.map((pc, j) => (
                    <span key={j} className="text-[9px] px-1 py-0.5 rounded bg-[#1a1a1a] text-[#666] border border-[#1e1e1e]">
                      {renderAccidentals(degreeName(pc, edo))}
                    </span>
                  ))}
                </div>
                <div className="mt-1">
                  <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ color: fitColor, backgroundColor: fitColor + "15" }}>
                    {Math.round(overlap * 100)}%
                  </span>
                </div>
                <div className="flex gap-1 mt-1 justify-center">
                  {pipeline === "melody-first" && (
                    <button onClick={e => { e.stopPropagation(); stepSegmentChord(i); }}
                      className="text-[9px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-[#8888cc] hover:text-[#aaaaee] hover:border-[#5a5a8a] transition-colors"
                      title="Try another chord">↻</button>
                  )}
                  {segments.length > 1 && (
                    <button onClick={e => { e.stopPropagation(); reharmonizeAround(i); }}
                      className="text-[9px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-[#cc8844] hover:text-[#eebb66] hover:border-[#8a6a3a] transition-colors"
                      title="Keep this chord, reharmonize all others around it">⟲</button>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); setChordBrowserIdx(i); }}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-[#666] hover:text-[#aaa] hover:border-[#444] transition-colors"
                  >browse</button>
                </div>
              </div>

              {/* Melody */}
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <button onClick={() => randomizeSegmentMelody(i)}
                    className="text-[10px] text-[#8888cc] hover:text-[#aaaaee] px-1"
                    title="Try another melody permutation">↻ melody</button>
                    {seg.cellType && (() => {
                      const detail = seg.digitalShape ? seg.digitalShape
                        : seg.triadPairInfo ? seg.triadPairInfo
                        : seg.hexatonicInfo ? seg.hexatonicInfo
                        : seg.pentatonicInfo ? seg.pentatonicInfo
                        : seg.intervallicInfo ? seg.intervallicInfo
                        : null;
                      const CELL_COLORS: Record<string, string> = {
                        approach: "#80e0e0", enclosure: "#80e0e0", chromPass: "#80e0e0",
                        passing: "#a0c0e0", neighbor: "#a0c0e0", cambiata: "#a0c0e0",
                        pentatonic: "#80e0a0", digital: "#c080e0", triadPair: "#80c0e0",
                        hexatonic: "#e0c080", intervallic: "#e080a0",
                      };
                      const color = CELL_COLORS[seg.cellType] ?? "#888";
                      return (
                        <span className="text-[9px] rounded px-1.5 py-0.5 border"
                          style={{ color, backgroundColor: color + "10", borderColor: color + "40" }}>
                          {seg.cellType}{detail ? ` ${detail}` : ""}
                        </span>
                      );
                    })()}
                  </div>
                  <div className="flex items-start gap-1 min-w-0">
                    {/* Row labels */}
                    <div className="flex flex-col items-end mr-0.5 flex-shrink-0" style={{ minWidth: 24 }}>
                      <span className="text-[8px] mb-0.5">&nbsp;</span>
                      <span className="text-[7px] text-[#c8aa50] uppercase tracking-wider flex items-center justify-end" style={{ height: 24 }}>key</span>
                      <span className="text-[7px] text-[#7a9ec0] uppercase tracking-wider flex items-center justify-end" style={{ height: 24, marginTop: 2 }}>chord</span>
                      <span className="text-[7px] text-[#9a7ac0] uppercase tracking-wider flex items-center justify-end" style={{ height: 24, marginTop: 2 }}>note</span>
                    </div>
                    {seg.melody.map((absPitch, j) => {
                      const pc = toPc(absPitch, edo);
                      const oct = octaveOffset(absPitch, edo);
                      const chordRoot = seg.chordPcs[0] ?? 0;
                      const relToChord = ((pc - chordRoot) % edo + edo) % edo;
                      const cat = classifyNoteCategory(pc, seg.chordPcs, edo, tonicRoot, tonality);
                      const catOpt = CATEGORY_OPTIONS.find(c => c.value === cat);
                      const catColor = catOpt?.color ?? "#666";
                      // Chord row: only use extension names (9, 11, 13) for actual chord tones;
                      // non-chord tones show plain degree (2, 4, 6) to avoid implying the chord has extensions it doesn't
                      const extName = cat === "ct" ? chordExtensionName(relToChord, edo) : degreeName(relToChord, edo);
                      const chordCatColor = cat === "ct" ? "#5a8a5a"
                        : /[#b]/.test(extName) ? "#c06090" : "#c8aa50";
                      const octLabel = oct > 0 ? ` +${oct}` : oct < 0 ? ` ${oct}` : "";
                      return (
                        <div key={j} className="flex flex-col items-center cursor-pointer flex-1 min-w-0"
                          onClick={e => { e.stopPropagation(); previewPc(pc); }}>
                          {j > 0 ? (
                            <span className="text-[8px] text-[#444] mb-0.5">
                              {intervals[j - 1] > 0 ? "+" : ""}{intervals[j - 1]}
                            </span>
                          ) : (
                            <span className="text-[8px] mb-0.5">&nbsp;</span>
                          )}
                          {/* Scale degree relative to tonic — colored by category */}
                          <span className="flex items-center justify-center rounded text-[9px] font-bold border hover:brightness-125 transition-all w-full overflow-hidden"
                            style={{ height: 24, borderColor: catColor + "80", backgroundColor: catColor + "15", color: catColor }}>
                            {renderAccidentals(degreeName(((pc - tonicRoot) % edo + edo) % edo, edo))}{octLabel && <span className="text-[8px] ml-0.5 opacity-70">{octLabel}</span>}
                          </span>
                          {/* Extension name relative to chord root — colored by chord function */}
                          <span className="flex items-center justify-center rounded text-[9px] font-bold border mt-0.5 hover:brightness-125 transition-all w-full overflow-hidden"
                            style={{ height: 24, borderColor: chordCatColor + "40", backgroundColor: chordCatColor + "08", color: chordCatColor + "99" }}>
                            {renderAccidentals(extName)}
                          </span>
                          {/* Note name */}
                          <span className="flex items-center justify-center rounded text-[9px] font-bold border mt-0.5 hover:brightness-125 transition-all w-full overflow-hidden"
                            style={{ height: 24, borderColor: "#9a7ac040", backgroundColor: "#9a7ac008", color: "#9a7ac099" }}>
                            {renderAccidentals(pcToNoteName(pc, edo))}
                          </span>
                        </div>
                      );
                    })}
                    <span className="text-[10px] text-[#444] self-end ml-1 font-mono flex-shrink-0">{contour}</span>
                  </div>
                  {/* Counterpoint voices (voice 1 = melody shown above, then voice 2→3→4) */}
                  {([
                    { key: "melody2" as const, notes: seg.melody2, label: "v2",  color: "#8888cc" },
                    { key: "melody3" as const, notes: seg.melody3, label: "v3", color: "#c8aa50" },
                    { key: "melody4" as const, notes: seg.melody4, label: "v4",  color: "#c06090" },
                  ]).map(voice => voice.notes && (
                    <div key={voice.key} className="flex items-start gap-1.5 mt-1 pt-1 border-t border-[#1a1a1a]">
                      <div className="flex flex-col items-end mr-0.5 flex-shrink-0" style={{ minWidth: 28 }}>
                        <span className="text-[7px] uppercase tracking-wider flex items-center justify-end" style={{ height: 28, color: voice.color }}>{voice.label}</span>
                      </div>
                      {voice.notes.map((absPitch, j) => {
                        const pcV = toPc(absPitch, edo);
                        const octV = octaveOffset(absPitch, edo);
                        const catV = classifyNoteCategory(pcV, seg.chordPcs, edo, tonicRoot, tonality);
                        const catOptV = CATEGORY_OPTIONS.find(c => c.value === catV);
                        const catColorV = catOptV?.color ?? "#666";
                        const octLabelV = octV > 0 ? ` +${octV}` : octV < 0 ? ` ${octV}` : "";
                        return (
                          <div key={j} className="flex flex-col items-center cursor-pointer"
                            onClick={e => { e.stopPropagation(); previewPc(pcV); }}>
                            <span className="w-12 h-7 flex items-center justify-center rounded text-[10px] font-bold border hover:brightness-125 transition-all"
                              style={{ borderColor: catColorV + "60", backgroundColor: catColorV + "10", color: catColorV + "cc" }}>
                              {renderAccidentals(degreeName(pcV, edo))}{octLabelV && <span className="text-[9px] ml-0.5 opacity-70">{octLabelV}</span>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>

              {/* Actions — compact row at bottom */}
              <div className="flex gap-1 mt-2 pt-2 border-t border-[#1a1a1a] flex-wrap justify-center">
                <button onClick={e => { e.stopPropagation(); toggleLock(i); }}
                  className={`px-1.5 py-0.5 text-[9px] rounded border transition-colors ${
                    isLocked
                      ? "bg-[#2a2010] border-[#e0a040] text-[#e0a040]"
                      : "bg-[#111] border-[#2a2a2a] text-[#555] hover:text-[#aaa]"
                  }`}
                  title={isLocked ? "Unlock" : "Lock"}>
                  {isLocked ? "🔒" : "🔓"}
                </button>
                <button onClick={e => {
                  e.stopPropagation();
                  const asIntervals = drillAddressing === "interval";
                  const notes = extractDegreePattern(seg.melody, seg.chordPcs, edo, tonicRoot, tonality === "both" ? "major" : tonality, asIntervals);
                  setDrillPattern(notes);
                  setDrillPatternInput(notes.map(n => formatNote(n, edo)).join(" "));
                  setPipeline("pattern-drill");
                }}
                  className="px-1.5 py-0.5 text-[9px] rounded bg-[#111] border border-[#2a2a2a] text-[#aa66aa] hover:text-[#cc88cc] transition-colors"
                  title="Send to Drill">drill</button>
                {segments.length > 1 && (
                  <button onClick={() => removeSegment(i)}
                    className="px-1.5 py-0.5 text-[9px] rounded bg-[#111] border border-[#2a2a2a] text-[#555] hover:text-[#e06060] transition-colors">✕</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Rhythm generator — metric weights feed into melody generation */}
      <div className="relative">
        <div className="absolute -top-1 right-0 text-[8px] text-[#444]">
          rhythm shapes melody weight
        </div>
        <MelodicRhythm melodyNoteCount={patternLength} onMetricWeights={handleMetricWeights} onRhythmTiming={handleRhythmTiming} />
      </div>

      {/* Play All + Export */}
      <div className="flex items-center justify-center gap-3">
        <button onClick={playAllSegments}
          className={`px-5 py-2.5 text-xs rounded border transition-colors ${
            isPlaying
              ? "bg-[#2a3a2a] border-[#5a8a5a] text-[#7aaa7a]"
              : "bg-[#1a2a1a] border-[#2a4a2a] text-[#5a8a5a] hover:bg-[#2a3a2a] hover:text-[#7aaa7a]"
          }`}>
          {isPlaying ? "Playing..." : "▶ Play All"}
        </button>
<span className="text-[9px] text-[#444]">Space = play all &nbsp; R = regenerate</span>
      </div>

      {/* Presets */}
      <div className="bg-[#111] border border-[#1e1e1e] rounded-lg p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] text-[#666] uppercase tracking-wider">Presets</span>
          <input value={presetName} onChange={e => setPresetName(e.target.value)}
            placeholder="Preset name..."
            className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-[10px] text-white placeholder-[#444] focus:outline-none focus:border-[#5a5a8a] flex-1"
            style={{ maxWidth: 160 }}
            onKeyDown={e => { if (e.key === "Enter") savePreset(); }}
          />
          <button onClick={savePreset}
            className="px-2 py-1 text-[10px] rounded border border-[#2a4a2a] text-[#5a8a5a] hover:text-[#7aaa7a] transition-colors">
            Save
          </button>
          <div className="border-l border-[#2a2a2a] h-4 mx-1" />
          <button onClick={logSession}
            className="px-2 py-1 text-[10px] rounded border border-[#3a3a5a] text-[#8888cc] hover:text-[#aaaaee] transition-colors"
            title="Log this practice session">
            Log Session
          </button>
          <button onClick={() => setShowLog(v => !v)}
            className="px-2 py-1 text-[10px] rounded border border-[#2a2a2a] text-[#555] hover:text-[#aaa] transition-colors">
            {showLog ? "Hide Log" : "History"}
          </button>
        </div>
        {presets.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {presets.map(p => (
              <div key={p.name} className="flex items-center gap-0.5">
                <button onClick={() => loadPreset(p)}
                  className="px-2 py-0.5 text-[10px] rounded border border-[#2a2a2a] text-[#888] hover:text-white hover:border-[#555] transition-colors">
                  {p.name}
                </button>
                <button onClick={() => deletePreset(p.name)}
                  className="text-[9px] text-[#444] hover:text-[#e06060] px-0.5">✕</button>
              </div>
            ))}
          </div>
        )}
        {showLog && (
          <div className="mt-2 border-t border-[#1a1a1a] pt-2">
            <div className="text-[9px] text-[#555] uppercase tracking-wider mb-1">Practice Log</div>
            {practiceLog.length === 0 ? (
              <div className="text-[10px] text-[#444]">No sessions logged yet</div>
            ) : (
              <div className="max-h-32 overflow-y-auto space-y-0.5">
                {[...practiceLog].reverse().map((entry, i) => (
                  <div key={i} className="flex gap-3 text-[10px] text-[#666]">
                    <span className="text-[#555] w-28 flex-shrink-0">{entry.date.replace("T", " ")}</span>
                    <span className="flex-1 truncate">{entry.preset}</span>
                    <span>{entry.duration}m</span>
                    <span>{entry.segments} seg</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-4 text-[10px] text-[#555] mt-2">
          <span>{pipeline === "melody-first" ? "Melody Fixed → Chords Vary" : "Chords Fixed → Melodies Vary"}{sameChord && pipeline === "chords-first" ? " (same chord)" : ""}</span>
          <span>Scale: {scaleMode} ({tonality})</span>
          <span>{allChordTypes.length} chord types in {edo}-EDO</span>
          <span>{segments.length} segments</span>
        </div>
      </div>
      </>)}{/* end exploration pipelines */}

      {/* ═══ Pattern Drill pipeline ═══ */}
      {pipeline === "pattern-drill" && (
        <PatternDrillSection
          edo={edo}
          tonicRoot={tonicRoot}
          tonality={tonality === "both" ? "major" : tonality}
          drillAddressing={drillAddressing}
          setDrillAddressing={setDrillAddressing}
          drillPattern={drillPattern}
          drillPatternInput={drillPatternInput}
          setDrillPatternInput={setDrillPatternInput}
          setDrillPattern={setDrillPattern}
          drillChords={drillChords}
          drillChordInput={drillChordInput}
          setDrillChordInput={setDrillChordInput}
          setDrillChords={setDrillChords}
          drillPermutation={drillPermutation}
          setDrillPermutation={setDrillPermutation}
          drillScaleFamily={drillScaleFamily}
          setDrillScaleFamily={setDrillScaleFamily}
          drillScaleMode={drillScaleMode}
          setDrillScaleMode={setDrillScaleMode}
          savedPatterns={savedPatterns}
          setSavedPatterns={setSavedPatterns}
          handleMetricWeights={handleMetricWeights}
          handleRhythmTiming={handleRhythmTiming}
          previewPc={previewPcSilent}
        />
      )}
      </div>{/* end space-y-5 */}
      {/* Fixed voicing reference — top right */}
      <div className="fixed top-16 right-4 z-30">
        <VoicingReference />
      </div>
      {/* Chord browser overlay */}
      {chordBrowserIdx != null && segments[chordBrowserIdx] && (
        <ChordBrowser
          melody={segments[chordBrowserIdx].melody}
          edo={edo}
          allChordTypes={allChordTypes}
          harmonyCats={harmonyCats}
          tonality={tonality}
          tonicRoot={tonicRoot}
          seventhFilter={checkedSeventhQualities}
          thirdFilter={checkedThirdQualities}
          includeAltered={includeAltered}
          onPick={(root, chordTypeId, chordPcs) => replaceChord(chordBrowserIdx, root, chordTypeId, chordPcs)}
          onClose={() => setChordBrowserIdx(null)}
        />
      )}
      {/* Floating visualizer — shown whenever the inline one is scrolled out of view */}
      {layout && !visualizerVisible && (
        <div className="fixed bottom-4 right-4 z-40 bg-[#0d0d0d]/95 border border-[#2a2a2a] rounded-xl shadow-2xl p-2"
          style={{ width: "min(45vw, 520px)" }}>
          <LumatoneKeyboard layout={layout} highlightedPitches={highlightedPitches} />
        </div>
      )}
    </div>
  );
}

// ── Pattern Drill Section ─────────────────────────────────────────────

function PatternDrillSection({
  edo, tonicRoot, tonality,
  drillAddressing, setDrillAddressing,
  drillPattern, drillPatternInput, setDrillPatternInput, setDrillPattern,
  drillChords, drillChordInput, setDrillChordInput, setDrillChords,
  drillPermutation, setDrillPermutation,
  drillScaleFamily, setDrillScaleFamily,
  drillScaleMode, setDrillScaleMode,
  savedPatterns, setSavedPatterns,
  handleMetricWeights, handleRhythmTiming,
  previewPc,
}: {
  edo: number;
  tonicRoot: number;
  tonality: Tonality;
  drillAddressing: "degree" | "interval";
  setDrillAddressing: (v: "degree" | "interval") => void;
  drillPattern: PatternNote[];
  drillPatternInput: string;
  setDrillPatternInput: (v: string) => void;
  setDrillPattern: (v: PatternNote[]) => void;
  drillChords: string[];
  drillChordInput: string;
  setDrillChordInput: (v: string) => void;
  setDrillChords: (v: string[]) => void;
  drillPermutation: PermutationMode;
  setDrillPermutation: (v: PermutationMode) => void;
  drillScaleFamily: string;
  setDrillScaleFamily: (v: string) => void;
  drillScaleMode: string;
  setDrillScaleMode: (v: string) => void;
  savedPatterns: { name: string; pattern: PatternNote[] }[];
  setSavedPatterns: (v: { name: string; pattern: PatternNote[] }[]) => void;
  handleMetricWeights: (weights: number[]) => void;
  handleRhythmTiming: (data: RhythmTimingData) => void;
  previewPc: (pc: number) => void;
}) {
  const [saveNameInput, setSaveNameInput] = useState("");
  const [checkedChords, setCheckedChords] = useState<Set<string>>(new Set());
  const fmtNote = (n: PatternNote) => formatNote(n, edo);
  const fmtNoteJsx = (n: PatternNote) => formatNoteJsx(n, edo);

  // Parse pattern input: "1 3 5 3" or "R 3 5 3" → PatternNote[]
  const applyPattern = useCallback((input: string) => {
    const nums = parsePatternInput(input, edo);
    if (nums.length > 0) setDrillPattern(nums);
  }, [setDrillPattern, edo]);

  // Toggle a chord in the checked set and automatically update drill progression
  const toggleChord = useCallback((roman: string) => {
    setCheckedChords(prev => {
      const next = new Set(prev);
      if (next.has(roman)) next.delete(roman); else next.add(roman);
      setDrillChords([...next]);
      return next;
    });
  }, [setDrillChords]);

  const removeChord = useCallback((idx: number) => {
    setDrillChords(drillChords.filter((_, i) => i !== idx));
  }, [drillChords, setDrillChords]);

  // Scale PCs for the active mode — drives degree resolution in realizePattern.
  const activeScalePcs = useMemo(
    () => getScalePcs(edo, tonicRoot, drillScaleFamily, drillScaleMode),
    [edo, tonicRoot, drillScaleFamily, drillScaleMode],
  );
  // All chord types available in the active EDO — reused by the scale-aware
  // palette builder so every mode change reshapes the full chord pool.
  const drillChordTypes = useMemo(() => getEdoChordTypes(edo), [edo]);

  // Flattened scale-aware palette: every chord the UI shows (diatonic + modal
  // interchange + sec dom + TT + microtonal stable/tense).  Used wherever the
  // drill section needs to look up a chord by its roman numeral or by (root,
  // type) — TT substitution, input validation, and Randomize's fallback pool.
  // Drives microtonal chords into Randomize that the legacy hand-authored
  // palette excluded.
  const romanChords = useMemo(() => {
    const byCat = buildScaleAwareDrillPalette(edo, tonicRoot, activeScalePcs, drillChordTypes);
    return Object.values(byCat).flat();
  }, [edo, tonicRoot, activeScalePcs, drillChordTypes]);

  // Resolve roman numeral to chord data
  const resolveChord = useCallback((roman: string) => {
    const match = romanChords.find(c => c.roman === roman);
    if (!match) return null;
    const root = ((match.root + tonicRoot) % edo + edo) % edo;
    const steps = match.steps; // already intervals from root
    const pcs = steps.map(s => ((s + root) % edo + edo) % edo);
    return { roman, root, steps, pcs };
  }, [romanChords, tonicRoot, edo]);

  // Get active permutations.  Permutation keys encode order:
  //   original, retrograde, rotate{i} (i = 1..N-1), swap{i} (swap positions i and i+1, i = 0..N-2).
  const activePerms = useMemo(() => {
    const all = getPatternPermutations(drillPattern);
    if (drillPermutation === "all") return all;
    if (drillPermutation === "original") return [all[0]];
    if (drillPermutation === "retrograde") return [all[1]];
    if (drillPermutation.startsWith("rotate")) {
      const rotIdx = parseInt(drillPermutation.replace("rotate", ""));
      if (!isNaN(rotIdx) && all[rotIdx + 1]) return [all[rotIdx + 1]];
    }
    if (drillPermutation.startsWith("swap")) {
      const swapIdx = parseInt(drillPermutation.replace("swap", ""));
      const base = 2 + Math.max(0, drillPattern.length - 1); // orig + retro + rotations
      if (!isNaN(swapIdx) && all[base + swapIdx]) return [all[base + swapIdx]];
    }
    return [all[0]];
  }, [drillPattern, drillPermutation]);

  // Build realized segments — every pattern resolution flows through the
  // active scale (Ionian / Dorian / Pentatonic / Altered / …).
  const drillSegments = useMemo(() => {
    const segs: { roman: string; perm: string; pattern: PatternNote[]; chordPcs: number[]; chordSteps: number[]; root: number; melody: number[] }[] = [];
    for (const chord of drillChords) {
      const resolved = resolveChord(chord);
      if (!resolved) continue;
      for (const perm of activePerms) {
        const melody = realizePattern(perm.pattern, resolved.steps, resolved.root, edo, tonicRoot, resolved.pcs, tonality, 4, activeScalePcs);
        segs.push({
          roman: chord,
          perm: perm.name,
          pattern: perm.pattern,
          chordPcs: resolved.pcs,
          chordSteps: resolved.steps,
          root: resolved.root,
          melody,
        });
      }
    }
    return segs;
  }, [drillChords, activePerms, resolveChord, edo, tonicRoot, tonality, activeScalePcs]);

  // Save the current pattern.  If the input box has unapplied edits we
  // parse + apply them first — otherwise clicking Save right after typing
  // would silently save the PREVIOUSLY applied pattern, which was the
  // source of the "it's not saving correctly" bug.
  const savePattern = useCallback(() => {
    const parsed = parsePatternInput(drillPatternInput, edo);
    const toSave = parsed.length > 0 ? parsed : drillPattern;
    if (parsed.length > 0) setDrillPattern(parsed);
    const name = `Pattern ${savedPatterns.length + 1}`;
    setSavedPatterns([...savedPatterns, { name, pattern: [...toSave] }]);
  }, [drillPatternInput, edo, drillPattern, setDrillPattern, savedPatterns, setSavedPatterns]);

  const allPerms = useMemo(() => getPatternPermutations(drillPattern), [drillPattern]);


  return (
    <>
      {/* Audiation ladder — cheat sheet of cognitive steps per cell.
          Each drill pattern should be cycled through these before moving
          on; the file's 198 cells × this 5-step ladder × all keys/modes/
          chords is what turns the material into an 8-year curriculum. */}
      <div className="bg-gradient-to-r from-[#0d0a14] to-[#0f0f0f] border border-[#2a1a3a] rounded-lg p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] text-[#aa66aa] uppercase tracking-widest font-semibold">Audiation Ladder</span>
          <span className="text-[9px] text-[#555]">— cycle every pattern through these 5 steps per key / mode / chord</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            { n: 1, label: "Sing on neutral syllable",    hint: "la / da — pitch contour only, no labels" },
            { n: 2, label: "Sing on solfège",              hint: "do re mi fa sol la ti — names the function" },
            { n: 3, label: "Inner-hear silently",          hint: "audiate without sound — the core skill" },
            { n: 4, label: "Transpose 12 keys + play",     hint: "move through all keys on your instrument" },
            { n: 5, label: "Improvise variations",         hint: "use it as a seed for free improvisation" },
          ].map(({ n, label, hint }) => (
            <div key={n} title={hint}
              className="flex items-center gap-1.5 bg-[#0a0a14] border border-[#1a1a2a] rounded-md px-2 py-1.5">
              <span className="flex items-center justify-center w-4 h-4 rounded-full bg-[#aa66aa25] border border-[#aa66aa60] text-[9px] font-bold text-[#cc88cc]">{n}</span>
              <span className="text-[10px] text-[#aaa]">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Scale / Mode — same state as the main settings row above; changing
          it here updates it there too and vice-versa. */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1">Scale / Mode</label>
          <select
            value={`${drillScaleFamily}::${drillScaleMode}`}
            onChange={e => {
              const [fam, mode] = e.target.value.split("::");
              setDrillScaleFamily(fam); setDrillScaleMode(mode);
            }}
            className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-white focus:outline-none"
            title="Scale used for degree resolution. Shared with the melody-first / chords-first pipelines.">
            {(() => {
              const byFam: Record<string, string[]> = {};
              for (const { family, mode } of DRILL_SCALE_OPTIONS) {
                (byFam[family] = byFam[family] ?? []).push(mode);
              }
              return Object.entries(byFam).map(([fam, modes]) => (
                <optgroup key={fam} label={fam}>
                  {modes.map(m => (
                    <option key={m} value={`${fam}::${m}`}>{m}</option>
                  ))}
                </optgroup>
              ));
            })()}
          </select>
        </div>
      </div>

      {/* Pattern input */}
      <div className="bg-[#111] border border-[#1e1e1e] rounded-lg p-3 space-y-3">
        <div className="flex items-center gap-3">
          <div className="text-[10px] text-[#aa66aa] uppercase tracking-wider font-medium">Pattern</div>
          <div className="flex gap-0.5">
            {(["degree", "interval"] as const).map(mode => (
              <button key={mode} onClick={() => setDrillAddressing(mode)}
                className={`px-2 py-0.5 text-[9px] rounded border transition-colors ${
                  drillAddressing === mode ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#555] hover:text-[#aaa]"
                }`}
                style={drillAddressing === mode ? { backgroundColor: "#aa66aa30", borderColor: "#aa66aa", color: "#cc88cc" } : {}}>
                {mode === "degree" ? "Degree" : "Interval Chain"}
              </button>
            ))}
          </div>
          <span className="text-[8px] text-[#555]">
            {drillAddressing === "degree" ? "e.g. 1 3 5 3" : "e.g. +4 +3 -2"}
          </span>
        </div>
        <div className="flex gap-2 items-center">
          <input
            value={drillPatternInput}
            onChange={e => setDrillPatternInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") applyPattern(drillPatternInput); }}
            placeholder={drillAddressing === "degree" ? "e.g. 1 2 3 2" : "e.g. +4 +3 -2 +5"}
            className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-1.5 text-sm text-white font-mono placeholder-[#444] focus:outline-none focus:border-[#aa66aa] flex-1"
            style={{ maxWidth: 200 }}
          />
          <button onClick={() => applyPattern(drillPatternInput)}
            className="px-3 py-1.5 text-[10px] rounded border border-[#aa66aa] text-[#cc88cc] hover:text-white transition-colors font-bold">
            Apply
          </button>
          <div className="border-l border-[#2a2a2a] h-5 mx-1" />
          <button onClick={savePattern}
            className="px-2 py-1.5 text-[10px] rounded border border-[#2a4a2a] text-[#5a8a5a] hover:text-[#7aaa7a] transition-colors">
            Save
          </button>
        </div>
        {/* Current pattern display */}
        <div className="flex gap-1 items-center flex-wrap">
          <span className="text-[9px] text-[#666] mr-1">Active:</span>
          {drillPattern.map((n, i) => (
            <span key={i} className={`px-2 py-1 text-xs font-mono rounded border ${CAT_COLOR[n.cat]}`}
              title={n.cat}>
              {fmtNoteJsx(n)}
            </span>
          ))}
        </div>
        {/* Saved patterns — click to load, + to append to the current
            pattern (pentascale transformation style: 1-3 + 3-5 → pentascale). */}
        {savedPatterns.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[9px] text-[#666] uppercase tracking-wider">Saved</span>
            <div className="flex flex-wrap gap-2">
              {savedPatterns.map((sp, i) => (
                <div key={i} className="flex items-center gap-1 bg-[#0d0d0d] border border-[#1e1e1e] rounded-lg px-2 py-1.5 cursor-pointer hover:border-[#aa66aa] transition-colors"
                  onClick={() => { setDrillPattern(sp.pattern); setDrillPatternInput(sp.pattern.map(fmtNote).join(" ")); }}>
                  <div className="flex gap-0.5">
                    {sp.pattern.map((n, j) => (
                      <span key={j} className={`px-1.5 py-0.5 text-[10px] font-mono rounded border ${CAT_COLOR[n.cat]}`}>
                        {fmtNoteJsx(n)}
                      </span>
                    ))}
                  </div>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      const combined = [...drillPattern, ...sp.pattern];
                      setDrillPattern(combined);
                      setDrillPatternInput(combined.map(fmtNote).join(" "));
                    }}
                    title="Append to current pattern (concatenation transform)"
                    className="text-[10px] text-[#5a8a5a] hover:text-[#7aaa7a] ml-1 px-1 font-bold">+</button>
                  <button onClick={e => { e.stopPropagation(); setSavedPatterns(savedPatterns.filter((_, j) => j !== i)); }}
                    className="text-[9px] text-[#333] hover:text-[#e06060] ml-0.5">✕</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Chord progression picker */}
      <div className="bg-[#111] border border-[#1e1e1e] rounded-lg p-3 space-y-3">
        <div className="text-[10px] text-[#aa66aa] uppercase tracking-wider font-medium">Chord Progression</div>
        {/* 6-category taxonomy — the entire palette is rebuilt per scale.
            Changing Ionian → Dorian → Phrygian Dominant reshapes not just
            Diatonic but also Modal Interchange, Secondary Dominant, TT,
            Microtonal Stable, and Microtonal Tense. */}
        {(() => {
          const byCat = buildScaleAwareDrillPalette(edo, tonicRoot, activeScalePcs, drillChordTypes);
          const CAT_ORDER: DrillChordCategory[] = ["diatonic", "modal", "secdom", "tritone", "xen-stable", "xen-tense"];
          return CAT_ORDER.map(cat => {
            const chords = byCat[cat];
            if (chords.length === 0) return null;
            const info = DRILL_CATEGORY_INFO[cat];
            const triads   = chords.filter(rc => rc.steps.length <= 3);
            const sevenths = chords.filter(rc => rc.steps.length >= 4);
            const renderBtn = (rc: DrillChord) => {
              const checked = checkedChords.has(rc.roman);
              return (
                <button key={rc.roman} onClick={() => toggleChord(rc.roman)}
                  className="px-1.5 py-0.5 text-[10px] rounded border transition-colors font-mono"
                  style={{
                    borderColor: checked ? info.color : info.color + "40",
                    backgroundColor: checked ? info.color + "25" : "transparent",
                    color: checked ? "#fff" : "#888",
                  }}>
                  {renderAccidentals(rc.roman)}
                </button>
              );
            };
            return (
              <div key={cat} className="space-y-1">
                {triads.length > 0 && (
                  <div className="flex flex-wrap gap-1 items-center">
                    <span className="text-[8px] uppercase tracking-wider mr-1 w-20 text-right flex-shrink-0"
                      style={{ color: info.color }}
                      title={info.desc}>
                      {info.label}
                    </span>
                    {triads.map(renderBtn)}
                  </div>
                )}
                {sevenths.length > 0 && (
                  <div className="flex flex-wrap gap-1 items-center">
                    <span className="w-20 flex-shrink-0" />
                    {sevenths.map(renderBtn)}
                  </div>
                )}
              </div>
            );
          });
        })()}
        {/* Action buttons + custom input */}
        <div className="flex gap-2 items-center">
          <input
            value={drillChordInput}
            onChange={e => setDrillChordInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                const chords = drillChordInput.trim().split(/[\s,]+/).filter(Boolean);
                const valid = chords.filter(c => romanChords.some(rc => rc.roman === c));
                if (valid.length > 0) { setDrillChords(valid); setDrillChordInput(""); }
              }
            }}
            placeholder="e.g. I V vi IV  (Enter to set all)"
            className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-1.5 text-[10px] text-white font-mono placeholder-[#444] focus:outline-none focus:border-[#aa66aa] flex-1"
          />
          <button onClick={() => { setDrillChords([]); setCheckedChords(new Set()); }}
            className="px-2 py-1.5 text-[10px] rounded border border-[#2a2a2a] text-[#555] hover:text-[#e06060] transition-colors">
            Clear
          </button>
        </div>
        {/* Selected progression + Randomize */}
        <div className="flex gap-1 items-center flex-wrap">
          {drillChords.length > 0 && (
            <>
              <span className="text-[9px] text-[#666] mr-1">Progression:</span>
              {drillChords.map((ch, i) => (
                <div key={i} className="flex items-center">
                  <span className="px-2 py-1 text-xs font-bold rounded border border-[#aa66aa40] bg-[#aa66aa15] text-[#cc88cc]">
                    {ch}
                  </span>
                  <button onClick={() => removeChord(i)}
                    className="text-[9px] text-[#444] hover:text-[#e06060] px-0.5 ml-0.5">✕</button>
                  {i < drillChords.length - 1 && <span className="text-[#333] mx-0.5">→</span>}
                </div>
              ))}
            </>
          )}
          <button onClick={() => {
              const pool = checkedChords.size >= 2 ? [...checkedChords] : romanChords.map(rc => rc.roman);
              const loop = generateFunctionalLoop(pool, Math.max(pool.length, 4));
              if (loop) setDrillChords(loop);
            }}
            className="ml-auto px-2 py-1.5 text-[10px] rounded border border-[#aa66aa40] text-[#aa66aa] hover:text-[#cc88cc] hover:border-[#aa66aa] transition-colors"
            title="Generate a functional progression via Markov chain">
            Randomize
          </button>
        </div>
      </div>

      {/* Permutation controls */}
      <div className="bg-[#111] border border-[#1e1e1e] rounded-lg p-3 space-y-3">
        <div className="flex items-center gap-2">
          <div className="text-[10px] text-[#aa66aa] uppercase tracking-wider font-medium">Permutations</div>
          <button onClick={() => setDrillPermutation("all")}
            className={`px-2 py-0.5 text-[9px] rounded border transition-colors ${
              drillPermutation === "all" ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
            }`}
            style={drillPermutation === "all" ? { backgroundColor: "#aa66aa30", borderColor: "#aa66aa", color: "#cc88cc" } : {}}>
            All
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {allPerms.map((p, i) => {
            // Order: [0]=original, [1]=retrograde, [2..N]=rotations (N−1 of
            // them), [N+1..2N-1]=adjacent swaps (N−1 of them).
            const rotCount = Math.max(0, drillPattern.length - 1);
            let key: PermutationMode;
            if (i === 0)                       key = "original";
            else if (i === 1)                  key = "retrograde";
            else if (i <= 1 + rotCount)        key = `rotate${i - 1}`;
            else                               key = `swap${i - 2 - rotCount}`;
            const isActive = drillPermutation === key || drillPermutation === "all";
            return (
              <div key={key}
                onClick={() => setDrillPermutation(key as PermutationMode)}
                className={`flex items-center gap-1 bg-[#0d0d0d] border rounded-lg px-2 py-1.5 cursor-pointer transition-colors ${
                  isActive ? "border-[#aa66aa]" : "border-[#1e1e1e] hover:border-[#aa66aa60]"
                }`}>
                <span className="text-[8px] text-[#666] mr-1 uppercase">{p.name}</span>
                <div className="flex gap-0.5">
                  {p.pattern.map((n, j) => (
                    <span key={j} className={`px-1.5 py-0.5 text-[10px] font-mono rounded border ${CAT_COLOR[n.cat]}`}>
                      {fmtNoteJsx(n)}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Drill segments display — card layout matching other modes */}
      {drillSegments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {drillSegments.map((seg, i) => {
            const intervals = getIntervals(seg.melody);
            const contour = getContour(intervals);
            return (
              <div key={i} className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-lg p-3"
                style={{ width: "calc(25% - 6px)", minWidth: 200, flexShrink: 0 }}>

                {/* Chord name — top, prominent */}
                <div className="text-center mb-3">
                  <div className="text-[18px] font-bold leading-tight" style={{ color: "#c8a0e0" }}>{renderAccidentals(seg.roman)}</div>
                  <div className="flex gap-1 mt-1 justify-center flex-wrap">
                    {seg.chordPcs.map((pc, j) => (
                      <span key={j} className="text-[9px] px-1 py-0.5 rounded bg-[#1a1a1a] text-[#666] border border-[#1e1e1e]">
                        {renderAccidentals(degreeName(((pc - tonicRoot) % edo + edo) % edo, edo))}
                      </span>
                    ))}
                  </div>
                  {activePerms.length > 1 && (
                    <div className="text-[8px] text-[#aa66aa] mt-1">{seg.perm}</div>
                  )}
                </div>

                {/* Melody */}
                <div className="min-w-0">
                  <div className="flex items-start gap-1 min-w-0">
                    {/* Row labels */}
                    <div className="flex flex-col items-end mr-0.5 flex-shrink-0" style={{ minWidth: 24 }}>
                      <span className="text-[8px] mb-0.5">&nbsp;</span>
                      <span className="text-[7px] text-[#c8aa50] uppercase tracking-wider flex items-center justify-end" style={{ height: 24 }}>key</span>
                      <span className="text-[7px] text-[#7a9ec0] uppercase tracking-wider flex items-center justify-end" style={{ height: 24, marginTop: 2 }}>chord</span>
                      <span className="text-[7px] text-[#9a7ac0] uppercase tracking-wider flex items-center justify-end" style={{ height: 24, marginTop: 2 }}>note</span>
                    </div>
                    {seg.melody.map((absPitch, j) => {
                      const pc = toPc(absPitch, edo);
                      const oct = octaveOffset(absPitch, edo);
                      const chordRoot = seg.root;
                      const relToChord = ((pc - chordRoot) % edo + edo) % edo;
                      const ctSet = new Set(seg.chordPcs);
                      const isCt = ctSet.has(pc);
                      const catColor = isCt ? "#5a8a5a" : "#c8aa50";
                      const extName = chordExtensionName(relToChord, edo);
                      const chordCatColor = isCt ? "#5a8a5a"
                        : /[#b]/.test(extName) ? "#c06090" : "#c8aa50";
                      const octLabel = oct > 0 ? ` +${oct}` : oct < 0 ? ` ${oct}` : "";
                      return (
                        <div key={j} className="flex flex-col items-center flex-1 min-w-0 cursor-pointer"
                          onClick={e => { e.stopPropagation(); previewPc(pc); }}>
                          {j > 0 ? (
                            <span className="text-[8px] text-[#444] mb-0.5">
                              {intervals[j - 1] > 0 ? "+" : ""}{intervals[j - 1]}
                            </span>
                          ) : (
                            <span className="text-[8px] mb-0.5">&nbsp;</span>
                          )}
                          <span className="flex items-center justify-center rounded text-[9px] font-bold border hover:brightness-125 transition-all w-full overflow-hidden"
                            style={{ height: 24, borderColor: catColor + "80", backgroundColor: catColor + "15", color: catColor }}>
                            {renderAccidentals(degreeName(((pc - tonicRoot) % edo + edo) % edo, edo))}{octLabel && <span className="text-[8px] ml-0.5 opacity-70">{octLabel}</span>}
                          </span>
                          <span className="flex items-center justify-center rounded text-[9px] font-bold border mt-0.5 hover:brightness-125 transition-all w-full overflow-hidden"
                            style={{ height: 24, borderColor: chordCatColor + "40", backgroundColor: chordCatColor + "08", color: chordCatColor + "99" }}>
                            {renderAccidentals(extName)}
                          </span>
                          <span className="flex items-center justify-center rounded text-[9px] font-bold border mt-0.5 hover:brightness-125 transition-all w-full overflow-hidden"
                            style={{ height: 24, borderColor: "#9a7ac040", backgroundColor: "#9a7ac008", color: "#9a7ac099" }}>
                            {renderAccidentals(pcToNoteName(pc, edo))}
                          </span>
                        </div>
                      );
                    })}
                    <span className="text-[10px] text-[#444] self-end ml-1 font-mono">{contour}</span>
                  </div>
                </div>

              </div>
            );
          })}
        </div>
      )}

      {/* Rhythm generator */}
      <div className="relative">
        <div className="absolute -top-1 right-0 text-[8px] text-[#444]">
          rhythm shapes melody weight
        </div>
        <MelodicRhythm melodyNoteCount={drillPattern.length} onMetricWeights={handleMetricWeights} onRhythmTiming={handleRhythmTiming} />
      </div>

      {drillSegments.length > 0 && (
        <div className="flex items-center justify-center gap-3">
          <span className="text-[9px] text-[#444]">{drillSegments.length} segments</span>
        </div>
      )}

      {drillChords.length === 0 && (
        <div className="text-center text-[11px] text-[#555] py-8">
          Select chords above to build your progression, then the pattern will be applied to each chord.
        </div>
      )}
    </>
  );
}

// ── Voicing Reference (read-only cheat sheet) ───────────────────────

// ── Chord Browser Overlay ─────────────────────────────────────────────

function ChordBrowser({
  melody,
  edo,
  allChordTypes,
  harmonyCats,
  tonality,
  tonicRoot,
  seventhFilter,
  thirdFilter,
  includeAltered,
  onPick,
  onClose,
}: {
  melody: number[];
  edo: number;
  allChordTypes: ReturnType<typeof getEdoChordTypes>;
  harmonyCats: Set<HarmonyCategory>;
  tonality: Tonality;
  tonicRoot: number;
  seventhFilter?: Set<string>;
  thirdFilter?: Set<string>;
  includeAltered?: boolean;
  onPick: (root: number, chordTypeId: string, chordPcs: number[]) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");

  // Build pool from selected harmony categories, then score by melody fit
  const ranked = useMemo(() => {
    // Use generateProgression with a large count to sample the pool, then deduplicate
    const pool = generateProgression(edo, 500, harmonyCats, "random", 2, tonality, tonicRoot, seventhFilter, thirdFilter, includeAltered);
    const seen = new Set<string>();
    const results: {
      root: number;
      chordTypeId: string;
      chordPcs: number[];
      overlap: number;
      name: string;
      roman: string;
    }[] = [];

    for (const ch of pool) {
      const key = `${ch.root}:${ch.chordTypeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ct = allChordTypes.find(c => c.id === ch.chordTypeId);
      if (!ct) continue;
      const overlap = chordMelodyOverlap(melody, ch.chordPcs, edo);
      results.push({
        root: ch.root,
        chordTypeId: ch.chordTypeId,
        chordPcs: ch.chordPcs,
        overlap,
        name: ct.name,
        roman: ch.roman,
      });
    }

    // Sort by overlap descending (highest overlap = best fit first)
    results.sort((a, b) => b.overlap - a.overlap);
    return results;
  }, [melody, edo, allChordTypes, harmonyCats, tonality, tonicRoot, seventhFilter, thirdFilter, includeAltered]);

  const filtered = search
    ? ranked.filter(c =>
        c.roman.toLowerCase().includes(search.toLowerCase()) ||
        c.name.toLowerCase().includes(search.toLowerCase()))
    : ranked;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-[#111] border border-[#2a2a2a] rounded-xl w-[480px] max-h-[70vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 pt-4 pb-2 border-b border-[#1a1a1a]">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-white">Choose Chord</h3>
            <button onClick={onClose} className="text-[#555] hover:text-white text-lg px-1">✕</button>
          </div>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search chords..."
            autoFocus
            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-1.5 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#5a5a8a]"
          />
          <div className="text-[9px] text-[#555] mt-1">{filtered.length} chords — sorted by melody fit (best first)</div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {filtered.slice(0, 200).map((c, i) => {
            const fit = classifyFit(c.overlap);
            const fitColor = FIT_COLORS[fit];
            return (
              <button
                key={`${c.chordTypeId}-${c.root}-${i}`}
                onClick={() => onPick(c.root, c.chordTypeId, c.chordPcs)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded hover:bg-[#1a1a1a] transition-colors text-left group"
              >
                {/* Fit indicator */}
                <span
                  className="text-[10px] font-mono w-10 text-right flex-shrink-0"
                  style={{ color: fitColor }}
                >
                  {Math.round(c.overlap * 100)}%
                </span>

                {/* Roman numeral */}
                <span className="text-sm font-bold text-white w-16 flex-shrink-0">{renderAccidentals(c.roman)}</span>

                {/* Chord type name */}
                <span className="text-[11px] text-[#888] flex-1 truncate">{c.name}</span>

                {/* PCs */}
                <span className="text-[9px] text-[#555] flex-shrink-0 inline-flex gap-1">
                  {c.chordPcs.map((pc, j) => (
                    <span key={j}>{renderAccidentals(degreeName(pc, edo))}</span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function VoicingReference() {
  const [activeTab, setActiveTab] = useState(VOICING_PATTERN_GROUPS[0]);
  const patterns = ALL_VOICING_PATTERNS.filter(p => p.group === activeTab);

  return (
    <div className="w-[240px]">
      <div className="bg-[#111] border border-[#1e1e1e] rounded-lg p-3">
        <p className="text-xs text-[#888] mb-1.5 font-medium">VOICINGS</p>
        <div className="flex flex-wrap gap-1 mb-2">
          {VOICING_PATTERN_GROUPS.map(g => {
            const isActive = activeTab === g;
            return (
              <button key={g} onClick={() => setActiveTab(g)}
                style={{
                  padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                  border: `1px solid ${isActive ? "#7173e6" : "#1a1a1a"}`,
                  background: isActive ? "#7173e618" : "#0e0e0e",
                  color: isActive ? "#9999ee" : "#444",
                  cursor: "pointer", transition: "all 0.12s",
                }}>
                {g}
              </button>
            );
          })}
        </div>
        <div className="bg-[#0e0e0e] border border-[#1a1a1a] rounded p-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {patterns.map(p => (
              <span key={p.id} className="text-[11px] font-mono text-[#aaa] py-0.5">
                {p.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
