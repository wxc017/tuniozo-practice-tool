// ── Tonality-scoped chord banks for functional ear training ───────────
// Each tonality defines chords grouped by pedagogical level:
//   Primary → Diatonic → Secondary Dominants → Borrowings → Tritone Subs
//
// Chord entries are label-only references — actual shapes come from
// getBaseChords(edo) or are built dynamically from getChordShapes(edo).

import { getChordShapes, getModeDegreeMap } from "./edoData";
import { JI_FAMILY, JI_SCALE_NAMES } from "./jiScaleData";

// ── Types ─────────────────────────────────────────────────────────────

export interface ChordEntry {
  /** Roman numeral label */
  label: string;
  /** Steps above tonic (relative), or null → look up from base chord map */
  steps: number[] | null;
}

export interface TonalityLevel {
  name: string;
  chords: ChordEntry[];
}

export interface TonalityBank {
  name: string;
  levels: TonalityLevel[];
}

// Helper: wrap a label with null steps (looked up from base chord map)
const ref = (label: string): ChordEntry => ({ label, steps: null });

// Helper: build chord with explicit steps
const chord = (label: string, steps: number[]): ChordEntry => ({ label, steps });

// ── Approach-chord builders (per target) ──────────────────────────────
// Used by ChordsTab to toggle secondary-dominant / secondary-diminished /
// ii-V / tritone-sub approaches on a per-target basis.

export type ApproachKind = "secdom" | "secdim" | "iiV" | "TT";

export const APPROACH_KINDS: ApproachKind[] = ["secdom", "secdim", "iiV", "TT"];

export const APPROACH_LABELS: Record<ApproachKind, string> = {
  secdom: "V/",
  secdim: "vii°/",
  iiV: "ii-V",
  TT: "TT",
};

/**
 * Build the approach chord(s) leading to `targetLabel` for a given approach
 * kind. Returns [] if the target shape is unusable. ii-V flavor (minor vs
 * half-dim ii) follows the target's 3rd quality.
 */
export function getApproachChords(
  targetLabel: string,
  targetSteps: number[] | null,
  kind: ApproachKind,
  edo: number,
): ChordEntry[] {
  if (!targetSteps || targetSteps.length < 2) return [];
  const sh = getChordShapes(edo);
  const { MIN, DIM, M2, M3, P5, d5, m7, M7 } = sh;
  // Secondary dominants (V/X and TT/X) carry a dominant function and must
  // voice as dom7 — building them as plain major triads lets `voiceChord`
  // upgrade them to maj7, which is the wrong 7th quality.  Store the full
  // dom7 shape (root, M3, P5, m7) so getCompatibleTypes locks onto dom7.
  const dom7 = (r: number) => [r, r + M3, r + P5, r + m7];
  const min = (r: number) => MIN.map(s => s + r);
  const dim = (r: number) => DIM.map(s => s + r);
  const r = targetSteps[0];
  const isMajorTarget = (targetSteps[1] - r) === M3;
  switch (kind) {
    case "secdom":
      return [chord(`V/${targetLabel}`, dom7(r + P5))];
    case "secdim":
      // vii°/X — diminished triad a half-step below the target (or +M7)
      return [chord(`vii°/${targetLabel}`, dim(r + M7))];
    case "iiV":
      return isMajorTarget
        ? [chord(`ii/${targetLabel}`, min(r + M2)), chord(`V/${targetLabel}`, dom7(r + P5))]
        : [chord(`iiø/${targetLabel}`, dim(r + M2)), chord(`V/${targetLabel}`, dom7(r + P5))];
    case "TT":
      // Tritone-sub of V → also a dom7 (a half-step above the target)
      return [chord(`TT/${targetLabel}`, dom7(r + P5 + d5))];
  }
}

// ── Build banks for a given EDO ───────────────────────────────────────

export function getTonalityBanks(edo: number, showSevenths: boolean = false): TonalityBank[] {
  const sh = getChordShapes(edo);
  const { MAJ, MIN, DIM, AUG, P5, M2, m3, M3, P4, d5, m6, M6, m7, M7, A1 } = sh;

  const maj = (root: number) => MAJ.map(s => s + root);
  const min = (root: number) => MIN.map(s => s + root);
  const dim = (root: number) => DIM.map(s => s + root);
  const aug = (root: number) => AUG.map(s => s + root);
  // Dom7 stack — used for V/X and TT/X so the voicing engine matches a
  // dom7 chord type rather than upgrading a triad to maj7.
  const dom7 = (root: number) => [root, root + M3, root + P5, root + m7];

  // Secondary dominant: V of target root (explicit dom7)
  const secV = (targetLabel: string, targetRoot: number): ChordEntry =>
    chord(`V/${targetLabel}`, dom7(targetRoot + P5));
  // Secondary ii-V (major target)
  const secIIV = (targetLabel: string, targetRoot: number): ChordEntry[] => [
    chord(`ii/${targetLabel}`, min(targetRoot + M2)),
    chord(`V/${targetLabel}`, dom7(targetRoot + P5)),
  ];
  // Secondary ii-V (minor target)
  const secIIoV = (targetLabel: string, targetRoot: number): ChordEntry[] => [
    chord(`iiø/${targetLabel}`, dim(targetRoot + M2)),
    chord(`V/${targetLabel}`, dom7(targetRoot + P5)),
  ];
  // Tritone sub — dominant function (dom7 a tritone from V)
  const ttSub = (targetLabel: string, targetRoot: number): ChordEntry =>
    chord(`TT/${targetLabel}`, dom7(targetRoot + P5 + d5));

  // ── Auto-build a mode bank from scale semitones ──
  // Stacks scale-step thirds to produce a triad at every degree, then
  // labels each triad with the right roman-numeral case (case = quality)
  // and accidental prefix (from the scaleDegrees label like "b3" / "#5").
  // Used for the exotic harmonic/melodic-minor modes that were missing
  // from the bank list — keeps them in sync with the Mode-ID taxonomy
  // without having to hand-write 7 more bespoke entries.
  const ROMAN_NUM: Record<string, string> = {
    "1": "I", "2": "II", "3": "III", "4": "IV",
    "5": "V", "6": "VI", "7": "VII",
  };
  const labelTriad = (degLabel: string, kind: "maj" | "min" | "dim" | "aug" | "other"): string => {
    const m = degLabel.match(/^([b#]+)?(\d+)$/);
    const prefix = m?.[1] ?? "";
    const num = m?.[2] ?? degLabel;
    let r = ROMAN_NUM[num] ?? num;
    if (kind === "min" || kind === "dim") r = r.toLowerCase();
    let suffix = "";
    if (kind === "dim") suffix = "°";
    else if (kind === "aug") suffix = "+";
    return prefix + r + suffix;
  };
  const buildModeFromScale = (
    name: string,
    degLabels: string[],
    scaleSemis: number[],
    primaryIdx: number[],
  ): TonalityBank => {
    const triads: { label: string; steps: number[]; idx: number; kind: string }[] = [];
    const aug5 = P5 + A1;
    const stepToCents = (steps: number) => (steps / edo) * 1200;
    for (let i = 0; i < scaleSemis.length; i++) {
      const root = scaleSemis[i];
      const third = scaleSemis[(i + 2) % scaleSemis.length] + (i + 2 >= scaleSemis.length ? edo : 0);
      const fifth = scaleSemis[(i + 4) % scaleSemis.length] + (i + 4 >= scaleSemis.length ? edo : 0);
      const t3 = third - root;
      const t5 = fifth - root;
      let kind: "maj" | "min" | "dim" | "aug" | "other" = "other";
      let steps: number[];
      if (t3 === M3 && t5 === P5)        { kind = "maj"; steps = maj(root); }
      else if (t3 === m3 && t5 === P5)   { kind = "min"; steps = min(root); }
      else if (t3 === m3 && t5 === d5)   { kind = "dim"; steps = dim(root); }
      else if (t3 === M3 && t5 === aug5) { kind = "aug"; steps = aug(root); }
      else {
        // Cent-zone fallback for prime-altered scale steps that don't
        // round exactly to the EDO's canonical M3 / m3.  Used by 7+
        // limit JI scales (Septimal / Tridecimal / Heptadecimal /
        // Nonadecimal / …) whose 3rd / 6th / 7th carry the named
        // prime.  Without this, e.g. Tridecimal Minor's i chord
        // (b3 = 13/11 ≈ 289¢ → step 10 in 41-EDO) wouldn't match
        // m3 (step 11) and the roman numeral would default to
        // uppercase "I" — wrong for a minor tonic.  The chord shape
        // stays as the actual scale tones [root, third, fifth] so the
        // prime-altered colour plays back; only the label's
        // upper/lowercase reflects the loosened classification.
        const t3c = stepToCents(t3);
        const t5c = stepToCents(t5);
        const t3Min = t3c >= 220 && t3c < 355;   // sub3 → canonical m3 → low-neutral
        const t3Maj = t3c >= 355 && t3c < 480;   // high-neutral → canonical M3 → super
        const t5P5  = t5c >= 670 && t5c < 740;   // P5 ± ~32¢
        const t5D5  = t5c >= 560 && t5c < 670;   // tritone / d5 band
        const t5A5  = t5c >= 740 && t5c < 830;   // aug5 band
        if (t3Maj && t5P5)      kind = "maj";
        else if (t3Min && t5P5) kind = "min";
        else if (t3Min && t5D5) kind = "dim";
        else if (t3Maj && t5A5) kind = "aug";
        steps = [root, third, fifth];
      }
      triads.push({ label: labelTriad(degLabels[i], kind), steps, idx: i, kind });
    }
    const primarySet = new Set(primaryIdx);
    const primaryEntries = primaryIdx
      .filter(i => i < triads.length)
      .map(i => chord(triads[i].label, triads[i].steps));
    const diatonicEntries = triads
      .filter(t => !primarySet.has(t.idx))
      .map(t => chord(t.label, t.steps));
    return {
      name,
      levels: [
        { name: "Primary", chords: primaryEntries },
        { name: "Diatonic", chords: diatonicEntries },
        ...functionLevels(diatonicEntries, primaryEntries),
      ],
    };
  };

  /**
   * Given a list of diatonic chord entries, auto-generate the Secondary
   * Dominants, Secondary II-Vs, and Tritone Subs levels.
   * `isMajorQuality` determines ii-V flavor for each target.
   */
  const functionLevels = (
    diatonicChords: ChordEntry[],
    primaryChords: ChordEntry[],
  ): TonalityLevel[] => {
    const allChords = [...primaryChords, ...diatonicChords];
    // Determine quality: major if steps match MAJ pattern (root, M3, P5)
    const isMajor = (e: ChordEntry) => {
      if (!e.steps || e.steps.length < 3) return false;
      const r = e.steps[0];
      return (e.steps[1] - r) === M3;
    };
    // Skip tonic (root=0) for secondary dominants
    const targets = allChords.filter(e => e.steps && e.steps[0] !== 0);

    const secDom: ChordEntry[] = [];
    const secIIVs: ChordEntry[] = [];
    const ttSubs: ChordEntry[] = [];

    for (const t of targets) {
      if (!t.steps) continue;
      const root = t.steps[0];
      secDom.push(secV(t.label, root));
      if (isMajor(t)) {
        secIIVs.push(...secIIV(t.label, root));
      } else {
        secIIVs.push(...secIIoV(t.label, root));
      }
    }

    // TT subs for tonic + most common targets
    const tonicEntry = primaryChords[0];
    if (tonicEntry?.steps) ttSubs.push(ttSub(tonicEntry.label, tonicEntry.steps[0]));
    // Add TT subs for a few strong-function chords
    for (const t of targets.slice(0, 4)) {
      if (t.steps) ttSubs.push(ttSub(t.label, t.steps[0]));
    }

    const levels: TonalityLevel[] = [];
    if (secDom.length) levels.push({ name: "Secondary Dominants", chords: secDom });
    if (secIIVs.length) levels.push({ name: "Secondary II-Vs", chords: secIIVs });
    if (ttSubs.length) levels.push({ name: "Tritone Subs", chords: ttSubs });
    return levels;
  };

  return [
    // ── MAJOR ───────────────────────────────────────────────────────
    {
      name: "Major",
      levels: [
        { name: "Primary", chords: [ref("I"), ref("IV"), ref("V")] },
        { name: "Diatonic", chords: [ref("ii"), ref("iii"), ref("vi"), ref("vii°")] },
        {
          name: "Secondary Dominants",
          chords: [
            secV("ii", M2), secV("iii", M3), secV("IV", P4),
            secV("V", P5), secV("vi", M6),
          ],
        },
        {
          // Curated modal-interchange set for Major.  Roughly ordered by
          // usage frequency across pop / rock / classical / jazz.  Covers
          // parallel-minor borrowings (iv, bVII, bVI, bIII, v, ii°),
          // Phrygian (bII / Neapolitan), Lydian (II, #iv°), and the
          // major-III chromatic mediant.
          name: "Modal Interchange",
          chords: [
            chord("iv",  min(P4)),         // parallel minor — extremely common
            chord("bVII", maj(m7)),        // Mixolydian / rock
            chord("bVI", maj(m6)),         // parallel minor
            chord("bIII", maj(m3)),        // parallel minor
            chord("bII", maj(m3 - M2)),    // Neapolitan (Phrygian)
            chord("v",   min(P5)),         // minor v (Mixolydian / minor)
            chord("ii°", dim(M2)),         // parallel minor
            chord("#iv°", dim(P4 + A1)),   // Lydian — raised 4 leading tone
            chord("II",  maj(M2)),         // Lydian / V/V color
            chord("III", maj(M3)),         // chromatic mediant
          ],
        },
        {
          name: "Secondary II-Vs",
          chords: [
            ...secIIoV("ii", M2), ...secIIoV("iii", M3),
            ...secIIV("IV", P4), ...secIIV("V", P5),
            ...secIIoV("vi", M6),
          ],
        },
        {
          name: "Tritone Subs",
          chords: [
            ttSub("I", 0), ttSub("ii", M2),
            ttSub("V", P5), ttSub("vi", M6),
          ],
        },
      ],
    },

    // ── HARMONIC MINOR ──────────────────────────────────────────────
    (() => {
      const pr = [chord("i", min(0)), chord("iv", min(P4)), chord("V", maj(P5))];
      const di = [chord("ii°", dim(M2)), chord("bIII+", aug(m3)), chord("bVI", maj(m6)), chord("vii°", dim(M7))];
      // Curated modal-interchange set for Harmonic Minor.  Covers
      // parallel-major Picardy (I), Phrygian Neapolitan (bII), natural
      // minor's bVII, Dorian-style IV, and parallel-major borrowings
      // (ii, iii, VI), plus Locrian bV tritone color and the minor v
      // (subtonic dominant from natural minor).
      const mi = [
        chord("I",    maj(0)),          // Picardy third
        chord("bII",  maj(m3 - M2)),    // Neapolitan (Phrygian)
        chord("bVII", maj(m7)),         // natural minor / Aeolian
        chord("IV",   maj(P4)),         // Dorian / melodic-minor color
        chord("ii",   min(M2)),         // parallel major
        chord("VI",   maj(M6)),         // parallel major / Dorian
        chord("iii",  min(M3)),         // parallel major
        chord("v",    min(P5)),         // natural-minor subtonic
        chord("bV",   maj(d5)),         // tritone color (Locrian)
      ];
      return { name: "Harmonic Minor", levels: [
        { name: "Primary", chords: pr },
        { name: "Diatonic", chords: di },
        { name: "Modal Interchange", chords: mi },
        ...functionLevels(di, pr),
      ] };
    })(),

    // ── DORIAN ──────────────────────────────────────────────────────
    (() => {
      const pr = [chord("i", min(0)), chord("IV", maj(P4)), chord("bVII", maj(m7))];
      const di = [chord("ii", min(M2)), chord("bIII", maj(m3)), chord("v", min(P5)), chord("vi°", dim(M6))];
      return { name: "Dorian", levels: [{ name: "Primary", chords: pr }, { name: "Diatonic", chords: di }, ...functionLevels(di, pr)] };
    })(),

    // ── MIXOLYDIAN ──────────────────────────────────────────────────
    (() => {
      const pr = [chord("I", maj(0)), chord("IV", maj(P4)), chord("bVII", maj(m7))];
      const di = [chord("ii", min(M2)), chord("iii°", dim(M3)), chord("v", min(P5)), chord("vi", min(M6))];
      return { name: "Mixolydian", levels: [{ name: "Primary", chords: pr }, { name: "Diatonic", chords: di }, ...functionLevels(di, pr)] };
    })(),

    // ── AEOLIAN / NATURAL MINOR ─────────────────────────────────────
    (() => {
      const pr = [chord("i", min(0)), chord("iv", min(P4)), chord("bVII", maj(m7))];
      const di = [chord("ii°", dim(M2)), chord("bIII", maj(m3)), chord("v", min(P5)), chord("bVI", maj(m6))];
      // Curated modal-interchange set for Aeolian — roughly ordered by
      // usage frequency.  Covers harmonic-minor cadence (V, vii°),
      // Dorian inflections (IV, VI), Picardy (I), Phrygian Neapolitan
      // (bII), jazz-minor ii, and Locrian bV tritone color.
      const mi = [
        chord("V",    maj(P5)),         // harmonic-minor cadence — extremely common
        chord("vii°", dim(M7)),         // leading-tone diminished
        chord("IV",   maj(P4)),         // Dorian major IV (rock / gospel)
        chord("I",    maj(0)),          // Picardy third
        chord("bII",  maj(m3 - M2)),    // Neapolitan (Phrygian)
        chord("VI",   maj(M6)),         // Dorian major VI
        chord("ii",   min(M2)),         // minor ii (parallel major)
        chord("bV",   maj(d5)),         // tritone color (Locrian)
      ];
      return { name: "Aeolian", levels: [
        { name: "Primary", chords: pr },
        { name: "Diatonic", chords: di },
        { name: "Modal Interchange", chords: mi },
        ...functionLevels(di, pr),
      ] };
    })(),

    // ── PHRYGIAN ────────────────────────────────────────────────────
    (() => {
      const pr = [chord("i", min(0)), chord("bII", maj(m3 - M2)), chord("bvii", min(m7))];
      const di = [chord("bIII", maj(m3)), chord("iv", min(P4)), chord("v°", dim(P5)), chord("bVI", maj(m6))];
      return { name: "Phrygian", levels: [{ name: "Primary", chords: pr }, { name: "Diatonic", chords: di }, ...functionLevels(di, pr)] };
    })(),

    // ── LYDIAN ──────────────────────────────────────────────────────
    (() => {
      const pr = [chord("I", maj(0)), chord("II", maj(M2)), chord("vii", min(M7))];
      const di = [chord("iii", min(M3)), chord("#iv°", dim(P4 + A1)), chord("V", maj(P5)), chord("vi", min(M6))];
      return { name: "Lydian", levels: [{ name: "Primary", chords: pr }, { name: "Diatonic", chords: di }, ...functionLevels(di, pr)] };
    })(),

    // ── LOCRIAN ─────────────────────────────────────────────────────
    (() => {
      const pr = [chord("i°", dim(0)), chord("bV", maj(d5)), chord("bvii", min(m7))];
      const di = [chord("bII", maj(m3 - M2)), chord("biii", min(m3)), chord("iv", min(P4)), chord("bVI", maj(m6))];
      return { name: "Locrian", levels: [{ name: "Primary", chords: pr }, { name: "Diatonic", chords: di }, ...functionLevels(di, pr)] };
    })(),

    // ── MELODIC MINOR ───────────────────────────────────────────────
    (() => {
      const pr = [chord("i", min(0)), chord("IV", maj(P4)), chord("V", maj(P5))];
      const di = [chord("ii", min(M2)), chord("bIII+", aug(m3)), chord("vi°", dim(M6)), chord("vii°", dim(M7))];
      return { name: "Melodic Minor", levels: [{ name: "Primary", chords: pr }, { name: "Diatonic", chords: di }, ...functionLevels(di, pr)] };
    })(),

    // ── MIXOLYDIAN b6 ───────────────────────────────────────────────
    (() => {
      const pr = [chord("I", maj(0)), chord("iv", min(P4)), chord("bVII", maj(m7))];
      const di = [chord("ii°", dim(M2)), chord("iii°", dim(M3)), chord("v", min(P5)), chord("bVI+", aug(m6))];
      return { name: "Mixolydian b6", levels: [{ name: "Primary", chords: pr }, { name: "Diatonic", chords: di }, ...functionLevels(di, pr)] };
    })(),

    // ── LYDIAN DOMINANT ─────────────────────────────────────────────
    (() => {
      const pr = [chord("I", maj(0)), chord("II", maj(M2)), chord("v", min(P5))];
      const di = [chord("iii°", dim(M3)), chord("#iv°", dim(P4 + A1)), chord("vi", min(M6)), chord("bVII+", aug(m7))];
      return { name: "Lydian Dominant", levels: [{ name: "Primary", chords: pr }, { name: "Diatonic", chords: di }, ...functionLevels(di, pr)] };
    })(),

    // ── PHRYGIAN DOMINANT (Hijaz) ───────────────────────────────────
    (() => {
      const pr = [chord("I", maj(0)), chord("bII", maj(m3 - M2)), chord("iv", min(P4))];
      const di = [chord("iii°", dim(M3)), chord("v°", dim(P5)), chord("bVI+", aug(m6)), chord("bvii", min(m7))];
      return { name: "Phrygian Dominant", levels: [{ name: "Primary", chords: pr }, { name: "Diatonic", chords: di }, ...functionLevels(di, pr)] };
    })(),

    // ── DORIAN #4 ───────────────────────────────────────────────────
    (() => {
      const pr = [chord("i", min(0)), chord("II", maj(M2)), chord("v", min(P5))];
      const di = [chord("bIII", maj(m3)), chord("#iv°", dim(P4 + A1)), chord("vi°", dim(M6)), chord("bVII+", aug(m7))];
      return { name: "Dorian #4", levels: [{ name: "Primary", chords: pr }, { name: "Diatonic", chords: di }, ...functionLevels(di, pr)] };
    })(),

    // ── LYDIAN #2 ───────────────────────────────────────────────────
    (() => {
      const pr = [chord("I", maj(0)), chord("VII", maj(M7))];
      const di = [chord("#ii°", dim(M2 + A1)), chord("iii", min(M3)), chord("#iv°", dim(P4 + A1)), chord("V+", aug(P5)), chord("vi", min(M6))];
      return { name: "Lydian #2", levels: [{ name: "Primary", chords: pr }, { name: "Diatonic", chords: di }, ...functionLevels(di, pr)] };
    })(),

    // ── Harmonic-minor family (auto-built from scale) ───────────────
    buildModeFromScale("Locrian #6",
      ["1","b2","b3","4","b5","6","b7"],
      [0, m3 - M2, m3, P4, d5, M6, m7],
      [0, 3, 6]),
    buildModeFromScale("Ionian #5",
      ["1","2","3","4","#5","6","7"],
      [0, M2, M3, P4, P5 + A1, M6, M7],
      [0, 3, 5]),
    buildModeFromScale("Ultralocrian",
      ["1","b2","b3","3","b5","b6","6"],
      [0, m3 - M2, m3, M3, d5, m6, M6],
      [0, 5, 6]),

    // ── Melodic-minor family (auto-built from scale) ────────────────
    buildModeFromScale("Dorian b2",
      ["1","b2","b3","4","5","6","b7"],
      [0, m3 - M2, m3, P4, P5, M6, m7],
      [0, 3, 6]),
    buildModeFromScale("Lydian Augmented",
      ["1","2","3","#4","#5","6","7"],
      [0, M2, M3, P4 + A1, P5 + A1, M6, M7],
      [0, 1, 5]),
    buildModeFromScale("Locrian #2",
      ["1","2","b3","4","b5","b6","b7"],
      [0, M2, m3, P4, d5, m6, m7],
      [0, 4, 6]),
    buildModeFromScale("Altered",
      ["1","b2","#2","3","b5","#5","b7"],
      [0, m3 - M2, m3, M3, d5, P5 + A1, m7],
      [0, 4, 6]),

    // ── Septimal / Neutral diatonic families (31-EDO only) ─────────────
    // Each family's 7 modes are programmatically generated by rotating
    // the parent scale, then labelling each chord with a Roman numeral
    // whose case reflects the 3rd quality.  The 7th-quality suffix is
    // hidden by default; pass showSevenths=true to expose it.
    ...(edo === 31 ? buildXenFamilyBanks(edo, showSevenths) : []),

    // ── Double Harmonic family (all EDOs) ──────────────────────────────
    // Heptatonic scale with two augmented seconds.  Modes generated from
    // the degree map registered in edoData.ts, then run through the
    // EDO-agnostic `buildModeFromScale` which auto-labels triads by their
    // actual third + fifth qualities.  Mark I/IV/V as primary like the
    // other heptatonic families.
    ...DBLH_MODES.map(modeName => buildBankFromRegisteredFamily(
      "Double Harmonic Family", modeName, edo, [0, 3, 4], buildModeFromScale,
    )),

    // ── Symmetric family (all EDOs) ────────────────────────────────────
    // Non-heptatonic.  Whole Tone has 6 notes, the two Diminished modes
    // have 8 each.  `buildModeFromScale` already handles variable scale
    // length via `% scale.length`; chord qualities surface naturally
    // (Whole Tone → all augmented triads; Diminished → all diminished
    // triads).  Only the tonic gets the "Primary" tier since I/IV/V
    // semantics don't carry over to symmetric scales.
    ...symmetricModesForEdo(edo).map(modeName => buildBankFromRegisteredFamily(
      "Symmetric Family", modeName, edo, [0], buildModeFromScale,
    )),

    // ── JI scales (Pythagorean / Schismatic temperaments) ──────────────
    // 41-EDO and 53-EDO get the 19 curated JI scales registered as the
    // "JI Family" in jiScaleData.ts.  Tonic-only as the primary tier
    // since I/IV/V semantics don't carry uniformly across all 19 (e.g.
    // Garibaldi[7] and Septimal Diminished have a tritone where the 5th
    // would sit).  All seven scale-degree triads still surface under
    // Diatonic.
    ...(edo === 41 || edo === 53 ? JI_SCALE_NAMES.map(modeName => buildBankFromRegisteredFamily(
      JI_FAMILY, modeName, edo, [0], buildModeFromScale,
    )) : []),
  ];
}

// Mode-name lists used to expand the new families inside getTonalityBanks.
// Kept in sync with PATTERN_SCALE_FAMILIES in musicTheory.ts and the
// degree-map builders in edoData.ts.
const DBLH_MODES = [
  "Double Harmonic Major","Lydian #2 #6","Ultraphrygian","Double Harmonic Minor",
  "Oriental","Ionian #2 #5","Locrian bb3 bb7",
];
const SYMMETRIC_MODES_BASE = [
  "Whole Tone","Half-Whole Diminished","Whole-Half Diminished",
];
// 31-EDO adds one half-sharp / half-flat variant per scale, varying the
// tritone-region accidental by one diesis.  Other EDOs collapse to base.
const SYMMETRIC_MODES_31_EXTRA = [
  "Whole Tone (Half-Sharp)",
  "Half-Whole Diminished (Half-Sharp)",
  "Whole-Half Diminished (Half-Flat)",
];
function symmetricModesForEdo(edo: number): string[] {
  return edo === 31 ? [...SYMMETRIC_MODES_BASE, ...SYMMETRIC_MODES_31_EXTRA] : SYMMETRIC_MODES_BASE;
}

// Pull a registered family/mode's degree map and feed it into the closure-
// scoped `buildModeFromScale` helper.  Hoisted so the body of
// getTonalityBanks can call it before its closures are defined; the
// `builder` parameter is the closure (different `edo` capture per call).
function buildBankFromRegisteredFamily(
  familyName: string,
  modeName: string,
  edo: number,
  primaryIdx: number[],
  builder: (name: string, degLabels: string[], scaleSemis: number[], primaryIdx: number[]) => TonalityBank,
): TonalityBank {
  const degMap = getModeDegreeMap(edo, familyName, modeName);
  const entries = Object.entries(degMap).sort((a, b) => a[1] - b[1]);
  const degLabels = entries.map(([deg]) => deg);
  const semis = entries.map(([, step]) => step);
  return builder(modeName, degLabels, semis, primaryIdx);
}

// ── Septimal / Neutral diatonic families ─────────────────────────────
// Build all 4 × 7 = 28 mode banks for the new tonality families.  Only
// emitted in 31-EDO since the parent scales rely on septimal / neutral
// step sizes that don't fit other tunings.
function buildXenFamilyBanks(edo: number, showSevenths: boolean): TonalityBank[] {
  const SUBMINOR     = [0, 5, 7, 13, 18, 20, 25];   // 1 2 sub3 4 5 sub6 sub7
  const NEUTRAL      = [0, 5, 9, 13, 18, 22, 27];   // 1 2 neu3 4 5 neu6 neu7
  const SUPERMAJOR   = [0, 5, 11, 13, 18, 24, 29];  // 1 2 sup3 4 5 sup6 sup7
  const SUBHARMONIC  = [0, 5, 7, 13, 18, 20, 28];   // 1 2 sub3 4 5 sub6 7

  // Mode names follow the "closest Greek mode + specific accidentals"
  // convention used by Western harmonic-minor / melodic-minor families
  // — see nameXenRotation() in musicTheory.ts for the algorithm.  Pure
  // sub / neu / sup variants collapse the three modal-tone alterations
  // into a leading "Subminor" / "Neutral" / "Supermajor" prefix.
  const SUBMINOR_MODES = [
    "Subminor Diatonic",
    "Locrian s2 s5 s6",
    "Supermajor Ionian",
    "Dorian s3 bb4 s7",
    "Subminor Phrygian m7",
    "Supermajor Lydian M2 b5",
    "Supermajor Mixolydian ##5 m7",
  ];
  const NEUTRAL_MODES = [
    "Neutral Diatonic",
    "Dorian N2 bb5 N6",
    "Neutral Ionian",
    "Ionian N3 ##4 N7",
    "Neutral Dorian m7",
    "Neutral Ionian M2 ##4",
    "Neutral Dorian bb5 m7",
  ];
  const SUPERMAJOR_MODES = [
    "Supermajor Diatonic",
    "Dorian S2 ##5 S6",
    "Subminor Phrygian",
    "Lydian S3 b5 S7",
    "Supermajor Mixolydian m7",
    "Subminor Aeolian M2 bb4",
    "Subminor Locrian m7",
  ];
  const SUBHARMONIC_MODES = [
    "Subharmonic Diatonic M7",
    "Locrian s2 s5 N6",
    "Supermajor Ionian #5",
    "Dorian s3 ##4 s7",
    "Phrygian s2 N3 s6",
    "Supermajor Lydian #2 b5",
    "Neutral Dorian b4 bb5 bb7",
  ];

  const out: TonalityBank[] = [];
  out.push(...buildOneXenFamilyBanks(SUBMINOR,    SUBMINOR_MODES, edo, showSevenths));
  out.push(...buildOneXenFamilyBanks(NEUTRAL,     NEUTRAL_MODES, edo, showSevenths));
  out.push(...buildOneXenFamilyBanks(SUPERMAJOR,  SUPERMAJOR_MODES, edo, showSevenths));
  out.push(...buildOneXenFamilyBanks(SUBHARMONIC, SUBHARMONIC_MODES, edo, showSevenths));
  return out;
}

// Roman numerals for scale degrees 1-7
const XEN_ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

// Major-scale reference (31-EDO and 12-EDO) used to compute the
// scale-degree alteration prefix on each chord's roman numeral.
// E.g. a chord whose root sits on a subminor 2nd is labelled ₛII
// (one chromatic step + one half-step below major II's expected
// position), mirroring how Western theory uses bIII to mean a III
// chord with a flat-2 root from major.
const MAJOR_REF_31 = [0, 5, 10, 13, 18, 23, 28];
const MAJOR_REF_12 = [0, 2, 4, 5, 7, 9, 11];

function rootDegreePrefix(rootStep: number, degreeIdx: number, edo: number): string {
  const ref = edo === 31 ? MAJOR_REF_31 : MAJOR_REF_12;
  const expected = ref[degreeIdx] ?? 0;
  const diff = rootStep - expected;
  if (edo === 31) {
    // Use the same single-letter family used in the superscripts:
    // s = sub (-3), N = neutral (-1), S = sup (+1).  Chromatic flats
    // and sharps still get b / # / bb / ##.
    if (diff ===  0) return "";
    if (diff === -1) return "N";   // half-flat (neutral) below major
    if (diff === -2) return "b";    // chromatic flat
    if (diff === -3) return "s";   // subminor (one half-step below ♭)
    if (diff === -4) return "bb";   // double flat
    if (diff === +1) return "S";   // half-sharp (super) above major
    if (diff === +2) return "#";    // chromatic sharp
    if (diff === +3) return "S#";  // sup-sharp
    if (diff === +4) return "##";   // double sharp
    return "";
  }
  // 12-EDO
  if (diff ===  0) return "";
  if (diff === -1) return "b";
  if (diff === -2) return "bb";
  if (diff === +1) return "#";
  if (diff === +2) return "##";
  return "";
}

// Classify a 3rd-interval (in 31-EDO) into one of: "sub", "m", "neu", "M", "sup", "?"
function classify3rd(thirdSemis: number): "sub" | "m" | "neu" | "M" | "sup" | "?" {
  if (thirdSemis === 7)  return "sub";
  if (thirdSemis === 8)  return "m";
  if (thirdSemis === 9)  return "neu";
  if (thirdSemis === 10) return "M";
  if (thirdSemis === 11) return "sup";
  return "?";
}
// Classify a 5th-interval (in 31-EDO).  Distinguishes the chromatic
// flat / sharp 5th from the half-flat / half-sharp variants that 31-EDO
// resolves separately:
//   step 15 = s5 (sub-perfect / tritone-aug-4 territory)
//   step 16 = b5 (diminished, chromatic flat)
//   step 17 = bb5 (half-flat, sub-perfect)
//   step 18 = P5 (perfect)
//   step 19 = ##5 (half-sharp, super-perfect)
//   step 20 = #5 (augmented, chromatic sharp)
function classify5th(fifthSemis: number): "subP" | "d" | "hd" | "P" | "hA" | "A" | "?" {
  if (fifthSemis === 15) return "subP";
  if (fifthSemis === 16) return "d";
  if (fifthSemis === 17) return "hd";
  if (fifthSemis === 18) return "P";
  if (fifthSemis === 19) return "hA";
  if (fifthSemis === 20) return "A";
  return "?";
}
// Classify a 7th-interval (in 31-EDO).
function classify7th(seventhSemis: number): "sub" | "m" | "neu" | "M" | "sup" | "?" {
  if (seventhSemis === 25) return "sub";
  if (seventhSemis === 26) return "m";
  if (seventhSemis === 27) return "neu";
  if (seventhSemis === 28) return "M";
  if (seventhSemis === 29) return "sup";
  return "?";
}

function buildOneXenFamilyBanks(parent: number[], modeNames: string[], edo: number, showSevenths: boolean): TonalityBank[] {
  const banks: TonalityBank[] = [];
  for (let modeIdx = 0; modeIdx < modeNames.length; modeIdx++) {
    banks.push(buildOneXenMode(parent, modeIdx, modeNames[modeIdx], edo, showSevenths));
  }
  return banks;
}

function buildOneXenMode(parent: number[], rotIdx: number, modeName: string, edo: number, showSevenths: boolean): TonalityBank {
  // Rotate the parent scale to start at rotIdx — this is the mode's scale.
  const scale: number[] = [];
  const root = parent[rotIdx];
  for (let i = 0; i < parent.length; i++) {
    const j = (rotIdx + i) % parent.length;
    const wrap = (rotIdx + i) >= parent.length ? edo : 0;
    scale.push(parent[j] + wrap - root);
  }

  // Build a 7th chord on each scale degree (1, 3, 5, 7 of the mode).
  type ChordRow = { label: string; steps: number[]; isMajor3: boolean; isPrimary: boolean };
  const rows: ChordRow[] = [];
  for (let i = 0; i < scale.length; i++) {
    const r = scale[i];
    const third = scale[(i + 2) % 7] + ((i + 2) >= 7 ? edo : 0);
    const fifth = scale[(i + 4) % 7] + ((i + 4) >= 7 ? edo : 0);
    const seventh = scale[(i + 6) % 7] + ((i + 6) >= 7 ? edo : 0);
    const t3 = third - r;
    const t5 = fifth - r;
    const t7 = seventh - r;
    const q3 = classify3rd(t3);
    const q5 = classify5th(t5);
    const q7 = classify7th(t7);

    // Roman numeral: uppercase for M/neu/sup 3rds, lowercase for sub/m
    // 3rds.  Neutral 3rds get uppercase since they sit halfway between
    // minor and major and read as an independent (non-minor-leaning)
    // chord quality in xenharmonic practice.
    const upper = q3 === "M" || q3 === "sup" || q3 === "neu";
    let roman = upper ? XEN_ROMAN[i] : XEN_ROMAN[i].toLowerCase();
    // Subminor 3rds get a regular-letter "s" prefix inline with the
    // roman numeral (e.g. "siv") so the chord reads visibly as
    // subminor rather than plain minor.  The redundant "s3" suffix
    // is then dropped (see below).  Earlier this used the Unicode
    // subscript "ₛ" but the user reported it rendered too small to
    // read at chord-button sizes — kept as a regular character so
    // it sits next to the numeral at full text size.
    if (q3 === "sub") roman = "s" + roman;
    // Scale-degree alteration: prepend ♭/♯/ₛ/ˢ etc. to the roman
    // numeral when the chord's root doesn't sit on the major-scale
    // expected position for that degree.  Mirrors Western theory's
    // bIII / #IV / etc. convention.
    const degPrefix = rootDegreePrefix(r, i, edo);
    if (degPrefix) roman = degPrefix + roman;
    // 5th-quality marker.  ° / + remain reserved for the chromatic
    // flat-5 / sharp-5 (the canonical diminished / augmented chord
    // qualities).  31-EDO's half-flat (bb5) and half-sharp (##5) 5ths,
    // plus the very-flat sub-5 (s5), surface in the superscript suffix
    // so the chord type is unambiguous on sight.
    if (q5 === "d") roman += "°";        // b5  (diminished)
    else if (q5 === "A") roman += "+";   // #5  (augmented)

    // Chord suffix lists non-standard 3rd / 5th / 7th qualities.  Order
    // is: 5th (when half-flat / half-sharp / sub) → 3rd → 7th.  Single-
    // letter qualifier system: s = sub, m = min, N = neu, M = maj, S = sup.
    //
    // step 15 (which classify5th calls "subP") reads more naturally as
    // an augmented 4th than as a sub-5th — in 31-EDO #4 (15) and b5 (16)
    // are distinct intervals, and step 15 IS the aug-4, not a flat 5.
    // So instead of labeling the chord with a fictional "s5", we surface
    // it as "no5 #4": the chord lacks a real 5th, and the 4th sits
    // raised where the 5th would be.
    const supParts: string[] = [];
    if (q5 === "hd") supParts.push("bb5");      // half-flat 5
    else if (q5 === "hA") supParts.push("##5"); // half-sharp 5
    else if (q5 === "subP") { supParts.push("no5"); supParts.push("#4"); }
    // (q3 === "sub" handled by the ₛ-prefix above; no s3 suffix.)
    if (q3 === "neu") supParts.push("N3");
    else if (q3 === "sup") supParts.push("S3");
    if (showSevenths) {
      if (q7 === "sub") supParts.push("s7");
      else if (q7 === "neu") supParts.push("N7");
      else if (q7 === "m" && upper) supParts.push("7");        // dom7
      else if (q7 === "M" && upper) supParts.push("M7");       // maj7
      else if (q7 === "M" && !upper) supParts.push("mM7");     // m-Maj7
      else if (q7 === "m" && !upper) supParts.push("m7");
      else if (q7 === "sup") supParts.push("S7");
    }
    // Space separates Roman numeral from chord-quality suffix; the
    // renderer (formatRomanNumeral) wraps the post-space portion in a
    // <sup> tag so the whole suffix appears as superscript.
    const suffix = supParts.length === 0 ? "" : ` ${supParts.join(" ")}`;
    const label = roman + suffix;
    const isMajor3 = upper;
    const isPrimary = (i === 0) || (i === 3) || (i === 4); // I / IV / V analogues
    rows.push({ label, steps: [r, third, fifth, seventh], isMajor3, isPrimary });
  }

  const primary = rows.filter(r => r.isPrimary).map(r => chord(r.label, r.steps));
  const diatonic = rows.filter(r => !r.isPrimary).map(r => chord(r.label, r.steps));
  return {
    name: modeName,
    levels: [
      { name: "Primary", chords: primary },
      { name: "Diatonic", chords: diatonic },
    ],
  };
}

/** "Magic Mode" — every possible chord quality on every chromatic root */
export function getMagicModeBank(edo: number): TonalityBank {
  const sh = getChordShapes(edo);
  const { MAJ, MIN, DIM, M2, m3, M3, P4, d5, P5, m6, M6, m7, M7, A1 } = sh;
  const s = edo === 12 ? 1 : edo === 17 ? 1 : edo === 19 ? 2 : edo === 31 ? 3 : 5;

  const maj = (r: number) => MAJ.map(x => x + r);
  const mn = (r: number) => MIN.map(x => x + r);
  const dm = (r: number) => DIM.map(x => x + r);

  const secV = (tl: string, tr: number): ChordEntry => chord(`V/${tl}`, maj(tr + P5));
  const secIIV = (tl: string, tr: number): ChordEntry[] => [chord(`ii/${tl}`, mn(tr + M2)), chord(`V/${tl}`, maj(tr + P5))];
  const secIIoV = (tl: string, tr: number): ChordEntry[] => [chord(`iiø/${tl}`, dm(tr + M2)), chord(`V/${tl}`, maj(tr + P5))];
  const ttSub = (tl: string, tr: number): ChordEntry => chord(`TT/${tl}`, maj(tr + P5 + d5));

  const allTriads: ChordEntry[] = [
    chord("I°", dm(0)),     chord("i", mn(0)),      chord("I", maj(0)),
    chord("bII", maj(s)),   chord("ii", mn(M2)),    chord("II", maj(M2)),
    chord("#ii°", dm(M2 + A1)),
    chord("biii", mn(m3)),  chord("bIII", maj(m3)),
    chord("iii", mn(M3)),   chord("III", maj(M3)),
    chord("iv", mn(P4)),    chord("IV", maj(P4)),
    chord("#iv°", dm(P4 + A1)), chord("#iv", mn(P4 + A1)),
    chord("bV", maj(d5)),
    chord("v", mn(P5)),     chord("V", maj(P5)),
    chord("#v°", dm(P5 + A1)),
    chord("bvi", mn(m6)),   chord("bVI", maj(m6)),
    chord("vi", mn(M6)),    chord("VI", maj(M6)),
    chord("bvii", mn(m7)),  chord("bVII", maj(m7)),
    chord("vii°", dm(M7)),  chord("vii", mn(M7)),   chord("VII", maj(M7)),
  ];

  // Secondary dominants for all non-tonic triads
  const secDoms: ChordEntry[] = [];
  const secIIVs: ChordEntry[] = [];
  const ttSubs: ChordEntry[] = [];
  for (const t of allTriads) {
    if (!t.steps || t.steps[0] === 0) continue;
    const r = t.steps[0];
    secDoms.push(secV(t.label, r));
    const isMaj = (t.steps[1] - r) === M3;
    if (isMaj) secIIVs.push(...secIIV(t.label, r));
    else secIIVs.push(...secIIoV(t.label, r));
    ttSubs.push(ttSub(t.label, r));
  }

  return {
    name: "Magic Mode",
    levels: [
      { name: "All Triads", chords: allTriads },
      { name: "Secondary Dominants", chords: secDoms },
      { name: "Secondary II-Vs", chords: secIIVs },
      { name: "Tritone Subs", chords: ttSubs },
    ],
  };
}

/** Get all tonality names (for selector dropdown) */
export function getTonalityNames(edo: number): string[] {
  return [...getTonalityBanks(edo).map(b => b.name), "Magic Mode"];
}
