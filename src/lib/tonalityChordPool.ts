// Shared pool-driven progression engine used by MelodicPatterns and
// HarmonyWorkshop.  Resolves tonality-bank entries (Primary / Diatonic /
// Modal Interchange / etc.) plus per-target approach toggles and per-chord
// xen-variant toggles into chord PCs, and walks the existing
// `generateFunctionalLoop` Markov chain over that pool to produce a
// musically-coherent progression.

import { generateFunctionalLoop, FUNCTIONAL_WEIGHTS_TABLE } from "@/lib/musicTheory";
import {
  type ProgressionMode,
  type Tonality,
} from "@/lib/melodicPatternData";
import {
  getApproachChords, getTonalityBanks,
  type ApproachKind,
} from "@/lib/tonalityBanks";
import { getBaseChords, getChordShapes, getEdoChordTypes } from "@/lib/edoData";

// ── Tonality families (mirrors ChordsTab) ────────────────────────────
export const TONALITY_FAMILIES: { key: string; label: string; color: string; tonalities: string[] }[] = [
  { key: "major",    label: "MAJOR",          color: "#6a9aca",
    tonalities: ["Major","Dorian","Phrygian","Lydian","Mixolydian","Aeolian","Locrian"] },
  { key: "harmonic", label: "HARMONIC MINOR", color: "#c09050",
    tonalities: ["Harmonic Minor","Locrian #6","Ionian #5","Dorian #4","Phrygian Dominant","Lydian #2","Ultralocrian"] },
  { key: "melodic",  label: "MELODIC MINOR",  color: "#c06090",
    tonalities: ["Melodic Minor","Dorian b2","Lydian Augmented","Lydian Dominant","Mixolydian b6","Locrian #2","Altered"] },
];

// Tonality bank name → (scaleFamily, scaleMode) used by the melody pool builder.
export function bankToScaleFamMode(tonality: string): [string, string] {
  if (tonality === "Major") return ["Major Family", "Ionian"];
  for (const f of TONALITY_FAMILIES) {
    if (f.tonalities.includes(tonality)) {
      const fam = f.key === "major" ? "Major Family"
               : f.key === "harmonic" ? "Harmonic Minor Family"
               : "Melodic Minor Family";
      return [fam, tonality];
    }
  }
  return ["Major Family", "Ionian"];
}

// Tonality → "major" | "minor" | "both".
export function bankToMajMinBoth(tonality: string): Tonality {
  const [, mode] = bankToScaleFamMode(tonality);
  const major = new Set([
    "Ionian","Lydian","Mixolydian","Ionian #5","Lydian Augmented","Lydian Dominant","Mixolydian b6","Lydian #2",
  ]);
  const minor = new Set([
    "Aeolian","Dorian","Phrygian","Locrian","Harmonic Minor","Locrian #6","Dorian #4","Phrygian Dominant",
    "Ultralocrian","Melodic Minor","Dorian b2","Locrian #2",
  ]);
  if (major.has(mode)) return "major";
  if (minor.has(mode)) return "minor";
  return "both";
}

// ── Xen variants ─────────────────────────────────────────────────────
// "neu" / "sub" / "sup" alter the chord's 3rd; "qrt" / "qnt" replace the
// stack with quartal / quintal voicings respectively.
export type XenKind = "neu" | "sub" | "sup" | "clmin" | "clmaj" | "qrt" | "qnt";
export const XEN_KINDS: XenKind[] = ["neu", "sub", "sup", "clmin", "clmaj", "qrt", "qnt"];
export const XEN_LABEL: Record<XenKind, string> = {
  neu: "neu", sub: "sub", sup: "sup",
  clmin: "cl.min", clmaj: "cl.maj",
  qrt: "qua", qnt: "quin",
};
export const XEN_COLOR: Record<XenKind, string> = {
  neu:   "#9a66c0", // neutral — purple
  sub:   "#7aaa6a", // subminor — green
  sup:   "#cc6a8a", // supermajor — pink
  clmin: "#5a8a5a", // classical minor (5-limit) — darker green
  clmaj: "#a85a78", // classical major (5-limit) — darker pink
  qrt:   "#4a9ac7", // quartal — teal
  qnt:   "#c8aa50", // quintal — amber
};
export const XEN_SUFFIX = "~"; // chord-label separator: "I~neu", "ii~sub", "I~qrt"

// EDO-specific table of xen 3rd intervals.  Each value is the step count
// (within one octave) for that interval, or undefined when the EDO
// doesn't expose a distinct quality at that pedagogical position.
//
//   17-EDO  →  m3=4 is already subminor-ish, M3=6 is supermajor-ish; no
//              distinct neutral / sub / sup beyond the defaults.
//   19-EDO  →  m3=5 / M3=6 are classical thirds; sub=4 and sup=7 exist
//              but there's no room for a neutral third.
//   31-EDO  →  full sub / neu / sup; no separate classical thirds (m3
//              already sits between Pythagorean and 5-limit).
//   41-EDO  →  m3 / M3 are Pythagorean; classical 5-limit thirds
//              (clmin / clmaj) sit one step inside, plus full
//              sub / neu / sup on either side.
export function xenIntervalsForEdo(edo: number): Partial<Record<"neu" | "sub" | "sup" | "clmin" | "clmaj", number>> {
  if (edo === 12 || edo === 17) return {};
  if (edo === 19) return { sub: 4, sup: 7 };
  if (edo === 31) return { neu: 9, sub: 7, sup: 11 };
  if (edo === 41) return { sub: 9, clmin: 11, neu: 12, clmaj: 13, sup: 15 };
  // Generic fallback for unsupported EDOs — derive sub / neu / sup, skip
  // clmin / clmaj since 5-limit splits aren't well-defined off the table.
  const sh = getChordShapes(edo);
  const distinct = (n: number) => n > 0 && n < edo
    && n !== sh.m3 && n !== sh.M3 && n !== sh.M2 && n !== sh.P4;
  const neu = Math.round((sh.m3 + sh.M3) / 2);
  const sub = sh.m3 - 1;
  const sup = sh.M3 + 1;
  return {
    ...(distinct(neu) ? { neu } : {}),
    ...(distinct(sub) ? { sub } : {}),
    ...(distinct(sup) ? { sup } : {}),
  };
}

export function applyXenKind(steps: number[], kind: XenKind, edo: number): number[] | null {
  if (steps.length < 2) return null;
  const sh = getChordShapes(edo);
  const root = steps[0];
  if (kind === "qrt") return [root, root + sh.P4, root + 2 * sh.P4];
  if (kind === "qnt") return [root, root + sh.P5, root + 2 * sh.P5];
  const xen = xenIntervalsForEdo(edo);
  const newThird = xen[kind];
  if (newThird === undefined) return null;
  const third = steps[1] - root;
  if (newThird === third) return null;
  return [root, root + newThird, ...steps.slice(2)];
}

export function applicableXenKinds(steps: number[], edo: number): XenKind[] {
  if (steps.length < 2) return [];
  const sh = getChordShapes(edo);
  const third = steps[1] - steps[0];
  const xen = xenIntervalsForEdo(edo);
  const out: XenKind[] = [];
  // Tertian alterations are filtered to the same major/minor side as the
  // chord's natural 3rd — neutral applies to either side when present.
  if (third === sh.M3) {
    if (xen.neu   !== undefined) out.push("neu");
    if (xen.clmaj !== undefined) out.push("clmaj");
    if (xen.sup   !== undefined) out.push("sup");
  } else if (third === sh.m3) {
    if (xen.neu   !== undefined) out.push("neu");
    if (xen.clmin !== undefined) out.push("clmin");
    if (xen.sub   !== undefined) out.push("sub");
  }
  // Quartal / quintal apply to any chord with at least a 3rd.
  out.push("qrt");
  out.push("qnt");
  return out;
}

// ── Chord-map / pool builders ────────────────────────────────────────

export function buildChordMapForTonality(
  tonality: string, edo: number,
  approachesForT: Record<string, ApproachKind[]> = {},
  xenForT: Record<string, XenKind[]> = {},
): Record<string, number[]> {
  const baseMap: Record<string, number[]> = Object.fromEntries(getBaseChords(edo));
  const banks = getTonalityBanks(edo);
  const bank = banks.find(b => b.name === tonality);
  const map: Record<string, number[]> = { ...baseMap };
  if (bank) {
    for (const level of bank.levels) {
      for (const e of level.chords) {
        if (e.steps && !map[e.label]) map[e.label] = e.steps;
      }
    }
    // Approach targets — only Primary/Diatonic, since approaches don't
    // really make sense for borrowed (modal-interchange) chords.
    const approachTargets = new Map<string, number[]>();
    // Xen targets — every visible chord (Primary, Diatonic, AND Modal
    // Interchange), so MI chords like bVII can also pick up qrt/qnt etc.
    const xenTargets = new Map<string, number[]>();
    for (const level of bank.levels) {
      const isApproachLevel = level.name === "Primary" || level.name === "Diatonic";
      const isXenLevel = isApproachLevel || level.name === "Modal Interchange";
      for (const c of level.chords) {
        const steps = c.steps ?? baseMap[c.label];
        if (!steps) continue;
        if (isApproachLevel) approachTargets.set(c.label, steps);
        if (isXenLevel) xenTargets.set(c.label, steps);
      }
    }
    for (const [target, kinds] of Object.entries(approachesForT)) {
      const steps = approachTargets.get(target);
      if (!steps) continue;
      for (const kind of kinds) {
        for (const e of getApproachChords(target, steps, kind, edo)) {
          if (e.steps && !map[e.label]) map[e.label] = e.steps;
        }
      }
    }
    for (const [target, kinds] of Object.entries(xenForT)) {
      const steps = xenTargets.get(target);
      if (!steps) continue;
      for (const kind of kinds) {
        const variantSteps = applyXenKind(steps, kind, edo);
        if (!variantSteps) continue;
        const label = `${target}${XEN_SUFFIX}${kind}`;
        if (!map[label]) map[label] = variantSteps;
      }
    }
  }
  return map;
}

export function getEffectiveCheckedForTonality(
  tonality: string, edo: number,
  checked: string[],
  approachesForT: Record<string, ApproachKind[]>,
  xenForT: Record<string, XenKind[]> = {},
): string[] {
  const out = new Set(checked);
  const banks = getTonalityBanks(edo);
  const bank = banks.find(b => b.name === tonality);
  if (!bank) return Array.from(out);
  const baseMap: Record<string, number[]> = Object.fromEntries(getBaseChords(edo));
  const approachTargets = new Map<string, number[]>();
  const xenTargets = new Map<string, number[]>();
  for (const level of bank.levels) {
    const isApproachLevel = level.name === "Primary" || level.name === "Diatonic";
    const isXenLevel = isApproachLevel || level.name === "Modal Interchange";
    for (const c of level.chords) {
      const steps = c.steps ?? baseMap[c.label];
      if (!steps) continue;
      if (isApproachLevel) approachTargets.set(c.label, steps);
      if (isXenLevel) xenTargets.set(c.label, steps);
    }
  }
  for (const [target, kinds] of Object.entries(approachesForT)) {
    const steps = approachTargets.get(target);
    if (!steps) continue;
    for (const kind of kinds) {
      for (const e of getApproachChords(target, steps, kind, edo)) {
        // iiV adds BOTH ii/X and V/X — without V/X in the pool, the Markov
        // walk dead-ends ii/X straight into the target and the user hears
        // "ii/" with no V/ between it and X.  If secdom is also toggled,
        // the duplicate is fine (Set-add is idempotent).
        out.add(e.label);
      }
    }
  }
  for (const [target, kinds] of Object.entries(xenForT)) {
    const steps = xenTargets.get(target);
    if (!steps) continue;
    for (const kind of kinds) {
      const variantSteps = applyXenKind(steps, kind, edo);
      if (!variantSteps) continue;
      out.add(`${target}${XEN_SUFFIX}${kind}`);
    }
  }
  return Array.from(out);
}

function inferChordTypeId(steps: number[], edo: number): string {
  const chordTypes = getEdoChordTypes(edo);
  if (steps.length === 0) return "chord";
  const root = steps[0];
  const rels = steps.map(s => ((s - root) % edo + edo) % edo).sort((a, b) => a - b).join(",");
  for (const ct of chordTypes) {
    const ctRels = ct.steps.slice().sort((a, b) => a - b).join(",");
    if (ctRels === rels) return ct.id;
  }
  return "chord";
}

export interface PoolProgChord {
  roman: string;
  chordPcs: number[];
  root: number;
  chordTypeId: string;
}

// Pool-driven progression generator (Markov walk over user-checked labels).
export function generatePoolProgression(
  edo: number,
  count: number,
  tonality: string,
  checked: string[],
  approachesForT: Record<string, ApproachKind[]>,
  xenForT: Record<string, XenKind[]>,
  tonicRoot: number,
  mode: ProgressionMode,
): PoolProgChord[] {
  if (count <= 0) return [];
  const chordMap = buildChordMapForTonality(tonality, edo, approachesForT, xenForT);
  const effective = getEffectiveCheckedForTonality(tonality, edo, checked, approachesForT, xenForT)
    .filter(l => chordMap[l] && chordMap[l].length > 0);
  if (effective.length === 0) return [];

  let labels: string[] | null = null;
  if (mode === "functional") {
    const banks = getTonalityBanks(edo);
    const bank = banks.find(b => b.name === tonality);
    const diatonicSet = new Set<string>();
    if (bank) {
      for (const level of bank.levels) {
        if (level.name === "Primary" || level.name === "Diatonic") {
          for (const c of level.chords) diatonicSet.add(c.label);
        }
      }
    }
    const boost = new Set<string>();
    for (const lbl of effective) if (!diatonicSet.has(lbl)) boost.add(lbl);
    // Xen-variant labels share their parent chord's transitions in the Markov
    // graph — substitute parent for the walk and remap variants afterwards.
    const variantToParent = new Map<string, string>();
    const markovAvailable = effective.map(lbl => {
      const idx = lbl.indexOf(XEN_SUFFIX);
      if (idx > 0) {
        const parent = lbl.slice(0, idx);
        variantToParent.set(lbl, parent);
        return parent;
      }
      return lbl;
    });
    const markovBoost = new Set<string>();
    for (const lbl of boost) {
      const parent = variantToParent.get(lbl) ?? lbl;
      markovBoost.add(parent);
    }
    // iiV-only constraint: if the user enabled iiV for target X but NOT
    // secdom, the V/X dominant must be reached via ii/X (or iiø/X for
    // minor targets), not picked directly from I/IV/etc.  Without this
    // the Markov walk would jump straight to V/X — secdom semantics —
    // even though only the ii-V approach is on.
    const baseMap: Record<string, number[]> = Object.fromEntries(getBaseChords(edo));
    const approachTargets = new Map<string, number[]>();
    if (bank) {
      for (const level of bank.levels) {
        if (level.name !== "Primary" && level.name !== "Diatonic") continue;
        for (const c of level.chords) {
          const steps = c.steps ?? baseMap[c.label];
          if (steps) approachTargets.set(c.label, steps);
        }
      }
    }
    const restricted = new Map<string, Set<string>>();
    for (const [target, kinds] of Object.entries(approachesForT)) {
      const hasIIV = kinds.includes("iiV");
      const hasSecdom = kinds.includes("secdom");
      if (!hasIIV || hasSecdom) continue;
      const steps = approachTargets.get(target);
      if (!steps) continue;
      const iiVChords = getApproachChords(target, steps, "iiV", edo);
      const ii = iiVChords.find(c => c.label.startsWith("ii/") || c.label.startsWith("iiø/"));
      const v  = iiVChords.find(c => c.label.startsWith("V/"));
      if (ii && v) {
        restricted.set(v.label, new Set([ii.label]));
      }
    }
    const parentLabels = generateFunctionalLoop(markovAvailable, count, 300, markovBoost, restricted);
    if (parentLabels) {
      const variantsByParent = new Map<string, string[]>();
      for (const lbl of effective) {
        const idx = lbl.indexOf(XEN_SUFFIX);
        if (idx > 0) {
          const parent = lbl.slice(0, idx);
          if (!variantsByParent.has(parent)) variantsByParent.set(parent, []);
          variantsByParent.get(parent)!.push(lbl);
        }
      }
      const parentChecked = new Set(effective.filter(l => !l.includes(XEN_SUFFIX)));
      labels = parentLabels.map(parent => {
        const variants = variantsByParent.get(parent) ?? [];
        const candidates: string[] = [];
        if (parentChecked.has(parent)) candidates.push(parent);
        candidates.push(...variants);
        if (candidates.length === 0) return parent;
        return candidates[Math.floor(Math.random() * candidates.length)];
      });
    }
  }
  if (!labels) {
    labels = Array.from({ length: count }, () => effective[Math.floor(Math.random() * effective.length)]);
  }

  return labels.map(roman => {
    const steps = chordMap[roman] ?? [0];
    const chordPcs = steps.map(s => ((s + tonicRoot) % edo + edo) % edo);
    const root = ((steps[0] + tonicRoot) % edo + edo) % edo;
    return { roman, chordPcs, root, chordTypeId: inferChordTypeId(steps, edo) };
  });
}

// Enumerate every chord in one tonality's effective pool.
export function getAllPoolChords(
  edo: number, tonality: string, checked: string[],
  approachesForT: Record<string, ApproachKind[]>,
  xenForT: Record<string, XenKind[]>,
  tonicRoot: number,
): PoolProgChord[] {
  const chordMap = buildChordMapForTonality(tonality, edo, approachesForT, xenForT);
  const effective = getEffectiveCheckedForTonality(tonality, edo, checked, approachesForT, xenForT)
    .filter(l => chordMap[l] && chordMap[l].length > 0);
  return effective.map(roman => {
    const steps = chordMap[roman];
    const chordPcs = steps.map(s => ((s + tonicRoot) % edo + edo) % edo);
    const root = ((steps[0] + tonicRoot) % edo + edo) % edo;
    return { roman, chordPcs, root, chordTypeId: inferChordTypeId(steps, edo) };
  });
}

// Pick one chord from the pool whose PCs best fit a melody.
export function pickPoolChordForMelody(
  edo: number, melodyPcs: number[],
  tonality: string, checked: string[],
  approachesForT: Record<string, ApproachKind[]>,
  xenForT: Record<string, XenKind[]>,
  tonicRoot: number,
): PoolProgChord | null {
  const chordMap = buildChordMapForTonality(tonality, edo, approachesForT, xenForT);
  const effective = getEffectiveCheckedForTonality(tonality, edo, checked, approachesForT, xenForT)
    .filter(l => chordMap[l] && chordMap[l].length > 0);
  if (effective.length === 0) return null;
  const melodyPcSet = new Set(melodyPcs.map(p => ((p % edo) + edo) % edo));
  let best: { label: string; score: number } | null = null;
  for (const label of effective) {
    const steps = chordMap[label];
    const pcs = steps.map(s => ((s + tonicRoot) % edo + edo) % edo);
    let overlap = 0;
    for (const pc of pcs) if (melodyPcSet.has(pc)) overlap++;
    const score = overlap / Math.max(1, pcs.length);
    if (!best || score > best.score) best = { label, score };
  }
  if (!best) return null;
  const steps = chordMap[best.label];
  const chordPcs = steps.map(s => ((s + tonicRoot) % edo + edo) % edo);
  const root = ((steps[0] + tonicRoot) % edo + edo) % edo;
  return { roman: best.label, chordPcs, root, chordTypeId: inferChordTypeId(steps, edo) };
}

// ── Voice-leading-optimal reharmonizer ────────────────────────────────
// Picks chords to fit the actual melody bar-by-bar, ranking candidates
// by (1) melody-fit (chord-tone presence weighted by metric strength /
// duration), (2) voice-leading distance from the previous chord, and
// (3) functional-harmony tendency from FUNCTIONAL_WEIGHTS_TABLE.  Cadence
// bonuses bias the start toward tonic and the end toward V→I or i.
//
// Algorithm: Viterbi-style DP over bars × chord-pool.  O(N · M^2) where
// N = bar count and M = pool size.  Pool sizes are typically ≤ 50 and
// songs ≤ 32 bars, so total work is well under 100k ops per reharm.
//
// Works for every chord in the pool, including secondary dominants,
// ii-V approaches, modal interchange, and xen variants — voice-leading
// uses the chord's actual PCs, and the functional-weight lookup strips
// xen suffixes (~neu, ~qrt) so variants share their parent's tendencies.

export interface MelodyEvent {
  pc: number;       // pitch class (0..edo-1), or -1 for rest
  weight: number;   // metric-strength × duration weight
}

const stripXenSuffix = (roman: string): string => {
  const i = roman.indexOf(XEN_SUFFIX);
  return i > 0 ? roman.slice(0, i) : roman;
};

const HOME_TONICS = new Set(["I", "i"]);
const DOMINANTS = new Set(["V", "v"]);

function melodyFitScore(
  chordPcs: Set<number>,
  modeSet: Set<number>,
  events: MelodyEvent[],
): number {
  let s = 0;
  for (const e of events) {
    if (e.pc < 0) continue;
    if (chordPcs.has(e.pc))      s += 2.0 * e.weight; // chord tone
    else if (modeSet.has(e.pc))  s += 0.4 * e.weight; // color/extension
    else                          s -= 1.2 * e.weight; // chromatic clash
  }
  return s;
}

// Sum of nearest-neighbour wrap-around distances (lower = smoother VL).
function voiceLeadDist(prev: number[], next: number[], edo: number): number {
  let total = 0;
  for (const p of next) {
    let best = edo;
    for (const q of prev) {
      const d = ((p - q) % edo + edo) % edo;
      const wrap = Math.min(d, edo - d);
      if (wrap < best) best = wrap;
    }
    total += best;
  }
  // Normalize by chord size so 4-note chords don't get penalized over triads.
  return total / Math.max(1, next.length);
}

// Applied chords (V/X, ii/X, iiø/X, vii°/X, TT/X) carry a forced
// resolution: V/V *must* resolve to V, ii/V to V/V or V, etc.  Without
// this, the DP happily strings tonicizations together backwards
// (V/V → ii/V → V/V) because the melody fits and they're all "non-
// primary" boosted.  Treat any move from an applied chord that isn't
// in its allowed target list as a hard violation.
const APPLIED_RE = /^(V|ii|iiø|vii°|TT)\//;
const isAppliedChord = (roman: string): boolean =>
  APPLIED_RE.test(stripXenSuffix(roman));

function functionalScore(prev: string, next: string): number {
  const prevR = stripXenSuffix(prev);
  const nextR = stripXenSuffix(next);
  const row = FUNCTIONAL_WEIGHTS_TABLE[prevR];
  const w = row?.[nextR];
  if (w !== undefined) return w;
  // Applied chord with no allowed transition to next → resolution
  // violation.  Strong negative score so even a perfect melody fit
  // can't pull the DP into a backwards tonicization.
  if (isAppliedChord(prev)) return -10;
  return 0;
}

// Cadence preference at the final bar: tonic > half-cadence on V > others.
function endBonus(roman: string): number {
  const r = stripXenSuffix(roman);
  if (HOME_TONICS.has(r)) return 4;
  if (DOMINANTS.has(r))   return 1.5; // half cadence
  return 0;
}

function startBonus(roman: string): number {
  const r = stripXenSuffix(roman);
  if (HOME_TONICS.has(r)) return 2;
  return 0;
}

/** Voice-leading-optimal reharmonization across `melodyByBar`. */
export function voiceLedReharm(
  edo: number,
  tonality: string,
  checked: string[],
  approachesForT: Record<string, ApproachKind[]>,
  xenForT: Record<string, XenKind[]>,
  tonicRoot: number,
  melodyByBar: MelodyEvent[][],
  modePcs: number[],
): PoolProgChord[] {
  const N = melodyByBar.length;
  if (N === 0) return [];
  // Drop approach toggles for targets that aren't in the checked pool.
  // Without this, V/X / ii/X / vii°/X / TT/X enter the pool but their
  // resolution target X never can — every transition out becomes a
  // dead-end and the DP collapses to "I → I → I" via the relaxation
  // fallback.  An approach toggled on an unchecked target is a UI
  // mismatch; silently filtering keeps the engine well-behaved.
  const checkedSet = new Set(checked);
  const filteredApproaches: Record<string, ApproachKind[]> = {};
  for (const [target, kinds] of Object.entries(approachesForT)) {
    if (checkedSet.has(target)) filteredApproaches[target] = kinds;
  }
  approachesForT = filteredApproaches;
  const pool = getAllPoolChords(edo, tonality, checked, approachesForT, xenForT, tonicRoot);
  if (pool.length === 0) return [];
  const M = pool.length;

  const modeSet = new Set(modePcs.map(p => ((p % edo) + edo) % edo));
  const chordPcSets = pool.map(c => new Set(c.chordPcs.map(p => ((p % edo) + edo) % edo)));

  // Identify the Primary tier so the DP can boost everything else.
  // Without this, voice-leading + functional weights pull the answer
  // straight to I/IV/V every bar — opting into Diatonic/MI/approach/xen
  // chords would visibly do nothing.  Boosted chords get a bonus that
  // tips ties (and small margins) in their favour, so the reharm
  // actually exercises the user's selections.
  const banks = getTonalityBanks(edo);
  const bank = banks.find(b => b.name === tonality);
  const primarySet = new Set<string>();
  if (bank) {
    const primary = bank.levels.find(l => l.name === "Primary");
    if (primary) for (const c of primary.chords) primarySet.add(c.label);
  }
  // Per-chord boost: any pool chord whose parent label isn't Primary.
  // Xen variants (I~neu) and approach chords (V/IV, ii/V, TT/V) all
  // qualify because their parent or label is not in Primary.
  const NON_PRIMARY_BOOST = 0.9;
  const boosts: number[] = pool.map(c => {
    const parent = stripXenSuffix(c.roman);
    return primarySet.has(parent) ? 0 : NON_PRIMARY_BOOST;
  });

  // iiV-only restriction: targets where iiV is on but secdom is OFF mean
  // V/X must follow ii/X (or iiø/X for minor targets).  Without this the
  // DP picks V/X freely from any predecessor — exactly the "V/IV
  // appearing standalone" symptom.  Build a Map<V/X-label, allowed-prevs>
  // and use it to gate transitions and disallow V/X as a starting chord.
  const baseMap: Record<string, number[]> = Object.fromEntries(getBaseChords(edo));
  const approachTargets = new Map<string, number[]>();
  if (bank) {
    for (const level of bank.levels) {
      if (level.name !== "Primary" && level.name !== "Diatonic") continue;
      for (const c of level.chords) {
        const steps = c.steps ?? baseMap[c.label];
        if (steps) approachTargets.set(c.label, steps);
      }
    }
  }
  const restrictedPrev = new Map<string, Set<string>>();
  for (const [target, kinds] of Object.entries(approachesForT)) {
    const hasIIV = kinds.includes("iiV");
    const hasSecdom = kinds.includes("secdom");
    if (!hasIIV || hasSecdom) continue;
    const steps = approachTargets.get(target);
    if (!steps) continue;
    const iiVChords = getApproachChords(target, steps, "iiV", edo);
    const ii = iiVChords.find(c => c.label.startsWith("ii/") || c.label.startsWith("iiø/"));
    const v  = iiVChords.find(c => c.label.startsWith("V/"));
    if (ii && v) restrictedPrev.set(v.label, new Set([ii.label]));
  }
  const isRestricted = (roman: string): boolean => restrictedPrev.has(stripXenSuffix(roman));

  // Per-bar melody-fit scores (independent of previous chord).
  // The non-primary boost is folded in here so it applies uniformly per
  // bar regardless of which chord came before.  A small per-cell random
  // jitter is added so successive reharmonizations of the same melody
  // don't produce identical chord paths — chords whose score is close
  // to optimal get to swap places between runs, while clearly inferior
  // candidates still lose.
  const NOISE_AMP = 1.4;
  const noise = () => (Math.random() - 0.5) * NOISE_AMP;
  const fit: number[][] = melodyByBar.map((events, _i) => {
    void _i;
    return chordPcSets.map((set, j) => melodyFitScore(set, modeSet, events) + boosts[j] + noise());
  });

  // Coefficients balancing the three forces.  Tuned so melody-fit
  // dominates when the melody is informative, voice-leading wins ties,
  // and functional weights nudge progressions toward common cadences.
  const A_FIT  = 1.0;
  const B_VL   = 0.6;
  const G_FUNC = 1.0;

  // dp[i][j] = best cumulative score reaching chord j at bar i.
  // back[i][j] = best previous chord index.
  const dp: number[][] = Array.from({ length: N }, () => new Array(M).fill(-Infinity));
  const back: number[][] = Array.from({ length: N }, () => new Array(M).fill(-1));

  for (let j = 0; j < M; j++) {
    // Restricted chords (iiV-only V/X) can never be the first chord —
    // they have no predecessor, so the iiV requirement is unmeetable.
    if (isRestricted(pool[j].roman)) continue;
    dp[0][j] = A_FIT * fit[0][j] + startBonus(pool[j].roman);
  }

  for (let i = 1; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const fitJ = A_FIT * fit[i][j];
      const allowedPrev = restrictedPrev.get(stripXenSuffix(pool[j].roman));
      const jStripped = stripXenSuffix(pool[j].roman);
      let best = -Infinity, bestK = -1;
      for (let k = 0; k < M; k++) {
        if (dp[i - 1][k] === -Infinity) continue;
        const kStripped = stripXenSuffix(pool[k].roman);
        // Don't pick the same chord two bars in a row — feels static.
        // Same parent counts as same too (so I and I~neu can't repeat).
        if (kStripped === jStripped) continue;
        // iiV-only V/X is reachable only from ii/X (or iiø/X).
        if (allowedPrev && !allowedPrev.has(kStripped)) continue;
        // Applied prev (V/X, ii/X, iiø/X, vii°/X, TT/X) must resolve
        // to a chord in its FUNCTIONAL_WEIGHTS row.  Hard skip — a
        // negative-score penalty wasn't strong enough to keep the DP
        // from chaining tonicizations backwards (V/V → ii/V → …).
        if (isAppliedChord(pool[k].roman)) {
          const row = FUNCTIONAL_WEIGHTS_TABLE[kStripped];
          if (!row || row[jStripped] === undefined) continue;
        }
        const score = dp[i - 1][k]
          + fitJ
          - B_VL  * voiceLeadDist(pool[k].chordPcs, pool[j].chordPcs, edo)
          + G_FUNC * functionalScore(pool[k].roman, pool[j].roman);
        if (score > best) { best = score; bestK = k; }
      }
      // Fall back to allowing repeats if the no-repeat constraint left
      // no candidates (tiny pool).  Restricted chords and applied-prev
      // resolution stay enforced — better to leave dp[i][j] = -Infinity
      // than to insert a backwards V/X or a non-resolving applied move.
      if (bestK < 0 && !allowedPrev) {
        for (let k = 0; k < M; k++) {
          if (dp[i - 1][k] === -Infinity) continue;
          if (isAppliedChord(pool[k].roman)) {
            const row = FUNCTIONAL_WEIGHTS_TABLE[stripXenSuffix(pool[k].roman)];
            if (!row || row[jStripped] === undefined) continue;
          }
          const score = dp[i - 1][k]
            + fitJ
            - B_VL  * voiceLeadDist(pool[k].chordPcs, pool[j].chordPcs, edo)
            + G_FUNC * functionalScore(pool[k].roman, pool[j].roman);
          if (score > best) { best = score; bestK = k; }
        }
      }
      dp[i][j] = best;
      back[i][j] = bestK;
    }
    // If every cell at this bar is unreachable (e.g. pool too small to
    // satisfy applied resolution everywhere), retroactively relax the
    // applied-resolution constraint for this bar so the chain can
    // continue.  This only fires in degenerate setups; the iiV-lock and
    // same-parent rule still hold.
    if (dp[i].every(v => v === -Infinity)) {
      for (let j = 0; j < M; j++) {
        const allowedPrev = restrictedPrev.get(stripXenSuffix(pool[j].roman));
        const jStripped = stripXenSuffix(pool[j].roman);
        let best = -Infinity, bestK = -1;
        for (let k = 0; k < M; k++) {
          if (dp[i - 1][k] === -Infinity) continue;
          if (stripXenSuffix(pool[k].roman) === jStripped) continue;
          if (allowedPrev && !allowedPrev.has(stripXenSuffix(pool[k].roman))) continue;
          // Applied-resolution skipped here as the relaxation step.
          const score = dp[i - 1][k] + A_FIT * fit[i][j]
            - B_VL * voiceLeadDist(pool[k].chordPcs, pool[j].chordPcs, edo);
          if (score > best) { best = score; bestK = k; }
        }
        dp[i][j] = best;
        back[i][j] = bestK;
      }
    }
  }

  // Pick the best end chord with cadence bonus added in.
  let lastJ = 0, lastBest = -Infinity;
  for (let j = 0; j < M; j++) {
    const s = dp[N - 1][j] + endBonus(pool[j].roman);
    if (s > lastBest) { lastBest = s; lastJ = j; }
  }

  const path: number[] = new Array(N);
  path[N - 1] = lastJ;
  for (let i = N - 1; i > 0; i--) path[i - 1] = back[i][path[i]];

  return path.map(j => pool[j]);
}
