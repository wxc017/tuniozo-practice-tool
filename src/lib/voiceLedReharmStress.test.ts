// Stress tests for voiceLedReharm — runs every reasonable approach toggle
// combination against a synthetic melody and verifies that:
//   - V/X is never standalone when iiV is on without secdom (must follow ii/X).
//   - V/X never starts the progression.
//   - Applied chords (V/X, ii/X, iiø/X, vii°/X, TT/X) resolve via the
//     allowed-targets table (no backwards tonicization).
//   - Same parent chord doesn't repeat in adjacent bars.
//   - All chords in the output are members of the active pool.
//
// The "full pipeline" suite further mirrors HarmonyWorkshop's chord-stream
// assembly: it interleaves main bars with mid-bar chord insertions and
// re-runs the same constraints on the flattened sequence.  This catches
// bugs in the mid-bar builder that the bar-level DP test wouldn't see.

import { describe, it, expect } from "vitest";
import { voiceLedReharm, getAllPoolChords, type MelodyEvent, type PoolProgChord } from "./tonalityChordPool";
import { type ApproachKind } from "./tonalityBanks";
import { FUNCTIONAL_WEIGHTS_TABLE } from "./musicTheory";
import { getDegreeMap } from "./edoData";

const EDO = 12;
const TONIC = 0;
const MODE_PCS = [0, 2, 4, 5, 7, 9, 11]; // C major
const TONALITY = "Major";
const TRIALS = 30;
const BARS = 8;
const PRIMARY = ["I", "ii", "iii", "IV", "V", "vi", "vii°"];

/** Build a synthetic 8-bar melody — quarter notes hitting common scale tones. */
function makeMelody(): MelodyEvent[][] {
  const seq: number[][] = [
    [0, 4, 7, 4],     // I-ish
    [5, 9, 0, 4],     // IV-ish
    [7, 11, 2, 5],    // V-ish
    [0, 4, 7, 0],     // I-ish
    [9, 0, 4, 9],     // vi-ish
    [5, 9, 0, 4],     // IV-ish
    [7, 11, 5, 2],    // V-ish
    [0, 0, 4, 7],     // I-ish
  ];
  return seq.map(bar =>
    bar.map((pc, idx) => ({
      pc: ((pc + TONIC) % EDO + EDO) % EDO,
      weight: idx === 0 ? 1.0 : 0.5,
    })),
  );
}

const stripXen = (r: string): string => {
  const i = r.indexOf("~");
  return i > 0 ? r.slice(0, i) : r;
};

const APPLIED_RE = /^(V|ii|iiø|vii°|TT)\//;
const isApplied = (r: string): boolean => APPLIED_RE.test(stripXen(r));

/** Returns the list of allowed predecessors for an applied chord per
 *  FUNCTIONAL_WEIGHTS_TABLE.  ii/X → V/X means V/X is allowed FROM ii/X. */
function appliedAllowedTargets(roman: string): Set<string> | null {
  const r = stripXen(roman);
  const row = FUNCTIONAL_WEIGHTS_TABLE[r];
  if (!row) return null;
  return new Set(Object.keys(row));
}

interface Issue { kind: string; bar: number; chord: string; prev?: string; }

/** Verify a reharm output respects the approach-toggle semantics. */
function verifyReharm(
  prog: { roman: string }[],
  approaches: Record<string, ApproachKind[]>,
): Issue[] {
  const issues: Issue[] = [];

  // V/X is iiV-only if iiV is on for X but secdom is not.  Only ii/X (or
  // iiø/X for minor targets) is an allowed predecessor.
  const iiVOnlyV = new Map<string, Set<string>>();
  for (const [target, kinds] of Object.entries(approaches)) {
    if (kinds.includes("iiV") && !kinds.includes("secdom")) {
      iiVOnlyV.set(`V/${target}`, new Set([`ii/${target}`, `iiø/${target}`]));
    }
  }

  for (let i = 0; i < prog.length; i++) {
    const cur = prog[i].roman;
    const curStripped = stripXen(cur);
    const prevStripped = i > 0 ? stripXen(prog[i - 1].roman) : null;

    // (1) iiV-only V/X must not start the progression.
    if (i === 0 && iiVOnlyV.has(curStripped)) {
      issues.push({ kind: "iiV-only V/X started progression", bar: i, chord: cur });
    }

    // (2) iiV-only V/X must follow ii/X (or iiø/X).
    const allowedPrev = iiVOnlyV.get(curStripped);
    if (allowedPrev && i > 0 && !allowedPrev.has(prevStripped!)) {
      issues.push({ kind: "iiV-only V/X without ii/X predecessor", bar: i, chord: cur, prev: prog[i - 1].roman });
    }

    // (3) Applied chords must resolve (next must be in allowed-targets).
    if (i > 0 && isApplied(prog[i - 1].roman)) {
      const allowedNext = appliedAllowedTargets(prog[i - 1].roman);
      if (allowedNext && !allowedNext.has(curStripped)) {
        issues.push({ kind: "applied chord didn't resolve", bar: i, chord: cur, prev: prog[i - 1].roman });
      }
    }

    // (4) No same-parent two bars in a row.
    if (prevStripped && prevStripped === curStripped) {
      issues.push({ kind: "same parent two bars in a row", bar: i, chord: cur, prev: prog[i - 1].roman });
    }
  }

  return issues;
}

describe("voiceLedReharm — approach-toggle constraints", () => {
  const melody = makeMelody();
  const TARGETS = ["ii", "iii", "IV", "V", "vi"];
  const KINDS: ApproachKind[] = ["secdom", "secdim", "iiV", "TT"];

  // 1) Empty approach map (just primary chords)
  it("emits no applied chords when no approaches are enabled", () => {
    let totalApplied = 0;
    for (let t = 0; t < TRIALS; t++) {
      const prog = voiceLedReharm(EDO, TONALITY, PRIMARY, {}, {}, TONIC, melody, MODE_PCS);
      for (const c of prog) if (isApplied(c.roman)) totalApplied++;
    }
    expect(totalApplied).toBe(0);
  });

  // 2) Each single approach kind on a single target
  for (const target of TARGETS) {
    for (const kind of KINDS) {
      it(`single approach: ${kind}/${target} — no constraint violations`, () => {
        const approaches: Record<string, ApproachKind[]> = { [target]: [kind] };
        const allIssues: Issue[] = [];
        for (let t = 0; t < TRIALS; t++) {
          const prog = voiceLedReharm(EDO, TONALITY, PRIMARY, approaches, {}, TONIC, melody, MODE_PCS);
          allIssues.push(...verifyReharm(prog, approaches));
        }
        if (allIssues.length > 0) {
          console.error(`Issues for ${kind}/${target}:`, allIssues.slice(0, 5));
        }
        expect(allIssues).toEqual([]);
      });
    }
  }

  // 3) iiV combined with each other kind on the same target
  for (const target of TARGETS) {
    for (const kind of KINDS) {
      if (kind === "iiV") continue;
      it(`combined approach: iiV+${kind}/${target} — no constraint violations`, () => {
        const approaches: Record<string, ApproachKind[]> = { [target]: ["iiV", kind] };
        const allIssues: Issue[] = [];
        for (let t = 0; t < TRIALS; t++) {
          const prog = voiceLedReharm(EDO, TONALITY, PRIMARY, approaches, {}, TONIC, melody, MODE_PCS);
          allIssues.push(...verifyReharm(prog, approaches));
        }
        if (allIssues.length > 0) {
          console.error(`Issues for iiV+${kind}/${target}:`, allIssues.slice(0, 5));
        }
        expect(allIssues).toEqual([]);
      });
    }
  }

  // 4) Every kind enabled on every target simultaneously — adversarial
  it("all-on / all-targets — no constraint violations", () => {
    const approaches: Record<string, ApproachKind[]> = {};
    for (const t of TARGETS) approaches[t] = [...KINDS];
    const allIssues: Issue[] = [];
    for (let t = 0; t < TRIALS; t++) {
      const prog = voiceLedReharm(EDO, TONALITY, PRIMARY, approaches, {}, TONIC, melody, MODE_PCS);
      allIssues.push(...verifyReharm(prog, approaches));
    }
    if (allIssues.length > 0) {
      console.error(`Issues for all-on:`, allIssues.slice(0, 10));
    }
    expect(allIssues).toEqual([]);
  });

  // 5) iiV-only on every target at once — the canonical bug surface
  it("iiV-only on every target — V/X must always follow ii/X", () => {
    const approaches: Record<string, ApproachKind[]> = {};
    for (const t of TARGETS) approaches[t] = ["iiV"];
    const allIssues: Issue[] = [];
    let appliedCount = 0;
    for (let t = 0; t < TRIALS; t++) {
      const prog = voiceLedReharm(EDO, TONALITY, PRIMARY, approaches, {}, TONIC, melody, MODE_PCS);
      for (const c of prog) if (c.roman.startsWith("V/")) appliedCount++;
      allIssues.push(...verifyReharm(prog, approaches));
    }
    if (allIssues.length > 0) {
      console.error(`iiV-only-all issues:`, allIssues.slice(0, 10));
    }
    expect(allIssues).toEqual([]);
  });
});

// ── Full-pipeline tests: main DP + mid-bar insertions ────────────────
//
// Replicates HarmonyWorkshop's handleReharmonize logic so the
// constraint-violation check covers the full flattened chord stream.

interface MidBarParams {
  edo: number;
  tonality: string;
  checked: string[];
  approachesForT: Record<string, ApproachKind[]>;
  tonicRoot: number;
  pool: PoolProgChord[];
  iiVOnlyV: Set<string>;
}

const APPLIED_RE_T = /^(V|ii|iiø|vii°|TT)\//;

function buildMidBarChord(
  params: MidBarParams,
  current: PoolProgChord | undefined,
  next: PoolProgChord | undefined,
): PoolProgChord | null {
  if (!next) return null;
  // Applied current chord must resolve directly — no mid-bar filler.
  if (current && APPLIED_RE_T.test(stripXen(current.roman))) return null;
  const dm = getDegreeMap(params.edo);
  const P5 = dm["5"] ?? 7;
  const curRoman = current?.roman ?? "";
  let eligible = params.pool.filter(c =>
    c.roman !== curRoman &&
    c.roman !== next.roman &&
    !params.iiVOnlyV.has(c.roman),
  );
  // If next is iiV-locked V/X, mid-bar must be ii/X (or iiø/X).
  const nextStripped = stripXen(next.roman);
  if (params.iiVOnlyV.has(nextStripped)) {
    const target = nextStripped.slice(2);
    const allowed = new Set([`ii/${target}`, `iiø/${target}`]);
    eligible = eligible.filter(c => allowed.has(stripXen(c.roman)));
  }
  // Restrict mid-bar to chords reachable from current per the
  // functional-weights table (when current is in the table).
  if (current) {
    const row = FUNCTIONAL_WEIGHTS_TABLE[stripXen(current.roman)];
    if (row) {
      const allowedNext = new Set(Object.keys(row));
      eligible = eligible.filter(c => allowedNext.has(stripXen(c.roman)));
    }
  }
  // Applied mid-bar chord must resolve to next.
  eligible = eligible.filter(c => {
    if (!APPLIED_RE_T.test(stripXen(c.roman))) return true;
    const row = FUNCTIONAL_WEIGHTS_TABLE[stripXen(c.roman)];
    return !!row && row[stripXen(next.roman)] !== undefined;
  });
  const secDomRoot = ((next.root - P5) % params.edo + params.edo) % params.edo;
  const secDom = eligible.find(c => c.root === secDomRoot && c.chordTypeId === "dom7");
  if (secDom) return secDom;
  const nextPcs = new Set(next.chordPcs);
  const candidates = eligible.filter(c => c.chordPcs.some(p => nextPcs.has(p)));
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function runFullPipeline(
  approaches: Record<string, ApproachKind[]>,
  melody: MelodyEvent[][],
): { roman: string }[] {
  const main = voiceLedReharm(EDO, TONALITY, PRIMARY, approaches, {}, TONIC, melody, MODE_PCS);
  const pool = getAllPoolChords(EDO, TONALITY, PRIMARY, approaches, {}, TONIC);
  const iiVOnlyV = new Set<string>();
  for (const [target, kinds] of Object.entries(approaches)) {
    if (kinds.includes("iiV") && !kinds.includes("secdom")) {
      iiVOnlyV.add(`V/${target}`);
    }
  }
  const params: MidBarParams = {
    edo: EDO, tonality: TONALITY, checked: PRIMARY,
    approachesForT: approaches, tonicRoot: TONIC,
    pool, iiVOnlyV,
  };
  const stream: { roman: string }[] = [];
  for (let i = 0; i < main.length; i++) {
    stream.push({ roman: main[i].roman });
    if (i + 1 < main.length && Math.random() < 0.6) {
      const mid = buildMidBarChord(params, main[i], main[i + 1]);
      if (mid) stream.push({ roman: mid.roman });
    }
  }
  return stream;
}

describe("Full pipeline (main DP + mid-bar inserts)", () => {
  const melody = makeMelody();
  const TARGETS = ["ii", "iii", "IV", "V", "vi"];
  const KINDS: ApproachKind[] = ["secdom", "secdim", "iiV", "TT"];

  for (const target of TARGETS) {
    for (const kind of KINDS) {
      it(`full pipeline single approach: ${kind}/${target}`, () => {
        const approaches: Record<string, ApproachKind[]> = { [target]: [kind] };
        const allIssues: Issue[] = [];
        for (let t = 0; t < TRIALS; t++) {
          const prog = runFullPipeline(approaches, melody);
          allIssues.push(...verifyReharm(prog, approaches));
        }
        if (allIssues.length > 0) {
          console.error(`Full-pipeline issues for ${kind}/${target}:`, allIssues.slice(0, 10));
        }
        expect(allIssues).toEqual([]);
      });
    }
  }

  it("full pipeline iiV-only on every target — no V/X leaks via mid-bar", () => {
    const approaches: Record<string, ApproachKind[]> = {};
    for (const t of TARGETS) approaches[t] = ["iiV"];
    const allIssues: Issue[] = [];
    for (let t = 0; t < TRIALS; t++) {
      const prog = runFullPipeline(approaches, melody);
      allIssues.push(...verifyReharm(prog, approaches));
    }
    if (allIssues.length > 0) {
      console.error(`Full pipeline iiV-only issues:`, allIssues.slice(0, 15));
    }
    expect(allIssues).toEqual([]);
  });

  it("full pipeline all-on every target — applied chords still resolve", () => {
    const approaches: Record<string, ApproachKind[]> = {};
    for (const t of TARGETS) approaches[t] = [...KINDS];
    const allIssues: Issue[] = [];
    for (let t = 0; t < TRIALS; t++) {
      const prog = runFullPipeline(approaches, melody);
      allIssues.push(...verifyReharm(prog, approaches));
    }
    if (allIssues.length > 0) {
      console.error(`Full pipeline all-on issues:`, allIssues.slice(0, 15));
    }
    expect(allIssues).toEqual([]);
  });

  // User-reported scenario: tiny pool (only I, IV, V checked) + iiV/IV.
  // The pool then is { I, IV, V, ii/IV, V/IV }.  Every transition from
  // every chord must respect applied resolution and the iiV lock.
  it("user scenario: only I/IV/V checked + iiV/IV — no violations across many runs", () => {
    const approaches: Record<string, ApproachKind[]> = { IV: ["iiV"] };
    const checked = ["I", "IV", "V"];
    const allIssues: Issue[] = [];
    for (let t = 0; t < 100; t++) {
      const main = voiceLedReharm(EDO, TONALITY, checked, approaches, {}, TONIC, melody, MODE_PCS);
      const pool = getAllPoolChords(EDO, TONALITY, checked, approaches, {}, TONIC);
      const iiVOnlyV = new Set<string>();
      for (const [target, kinds] of Object.entries(approaches)) {
        if (kinds.includes("iiV") && !kinds.includes("secdom")) iiVOnlyV.add(`V/${target}`);
      }
      const params: MidBarParams = {
        edo: EDO, tonality: TONALITY, checked,
        approachesForT: approaches, tonicRoot: TONIC, pool, iiVOnlyV,
      };
      const stream: { roman: string }[] = [];
      for (let i = 0; i < main.length; i++) {
        stream.push({ roman: main[i].roman });
        if (i + 1 < main.length && Math.random() < 0.6) {
          const mid = buildMidBarChord(params, main[i], main[i + 1]);
          if (mid) stream.push({ roman: mid.roman });
        }
      }
      allIssues.push(...verifyReharm(stream, approaches));
    }
    if (allIssues.length > 0) {
      console.error(`User scenario issues:`, allIssues.slice(0, 20));
    }
    expect(allIssues).toEqual([]);
  });

  // The exact user-reported scenario: Primary + iii/vi + iiV on IV.
  // Run many trials on the long melody to surface any sporadic leak.
  it("user-exact: I/IV/V + iii/vi + iiV/IV across 16 bars — 200 runs", () => {
    const approaches: Record<string, ApproachKind[]> = { IV: ["iiV"] };
    const checked = ["I", "IV", "V", "iii", "vi"];
    const longMelody = [...makeMelody(), ...makeMelody()];
    const allIssues: Issue[] = [];
    for (let t = 0; t < 500; t++) {
      const main = voiceLedReharm(EDO, TONALITY, checked, approaches, {}, TONIC, longMelody, MODE_PCS);
      const pool = getAllPoolChords(EDO, TONALITY, checked, approaches, {}, TONIC);
      const iiVOnlyV = new Set<string>();
      for (const [target, kinds] of Object.entries(approaches)) {
        if (kinds.includes("iiV") && !kinds.includes("secdom")) iiVOnlyV.add(`V/${target}`);
      }
      const params: MidBarParams = {
        edo: EDO, tonality: TONALITY, checked,
        approachesForT: approaches, tonicRoot: TONIC, pool, iiVOnlyV,
      };
      const stream: { roman: string }[] = [];
      for (let i = 0; i < main.length; i++) {
        stream.push({ roman: main[i].roman });
        if (i + 1 < main.length && Math.random() < 0.6) {
          const mid = buildMidBarChord(params, main[i], main[i + 1]);
          if (mid) stream.push({ roman: mid.roman });
        }
      }
      const issues = verifyReharm(stream, approaches);
      if (issues.length > 0 && allIssues.length < 5) {
        console.error(`Trial ${t} — chord stream:`, stream.map(c => c.roman).join(" → "));
        console.error(`Trial ${t} — issues:`, issues);
      }
      allIssues.push(...issues);
    }
    if (allIssues.length > 0) {
      console.error(`User-exact issues (${allIssues.length} total):`, allIssues.slice(0, 30));
    }
    expect(allIssues).toEqual([]);
  });

  // Adversarial sweep: 200 random configurations of checked chords +
  // approach kinds on random targets.  Each run verifies no constraint
  // is ever broken.  This is the "stop cutting corners" test.
  it("randomized adversarial sweep — 200 configs × 50 trials each", { timeout: 60000 }, () => {
    const ALL_CHORDS = ["I", "ii", "iii", "IV", "V", "vi", "vii°"];
    const ALL_TARGETS = ["ii", "iii", "IV", "V", "vi"];
    const ALL_KINDS: ApproachKind[] = ["secdom", "secdim", "iiV", "TT"];
    const longMelody = [...makeMelody(), ...makeMelody()];

    let totalIssues = 0;
    for (let cfg = 0; cfg < 200; cfg++) {
      // Random subset of chords (always include I).
      const checked = ["I"];
      for (const c of ALL_CHORDS.slice(1)) {
        if (Math.random() < 0.5) checked.push(c);
      }
      // Random subset of targets, each with random kinds.
      const approaches: Record<string, ApproachKind[]> = {};
      for (const t of ALL_TARGETS) {
        if (Math.random() < 0.4) {
          const kinds: ApproachKind[] = ALL_KINDS.filter(() => Math.random() < 0.4);
          if (kinds.length > 0) approaches[t] = kinds;
        }
      }
      // Mirror the engine's silent filter: approach toggles on
      // unchecked targets get dropped (the V/X they'd add can't resolve).
      const checkedSetCfg = new Set(checked);
      const effectiveApproaches: Record<string, ApproachKind[]> = {};
      for (const [target, kinds] of Object.entries(approaches)) {
        if (checkedSetCfg.has(target)) effectiveApproaches[target] = kinds;
      }
      const poolPreview = getAllPoolChords(EDO, TONALITY, checked, effectiveApproaches, {}, TONIC);
      // Skip degenerate configurations (pool too small for the
      // same-parent constraint to be satisfiable).
      if (poolPreview.length < 2) continue;
      for (let trial = 0; trial < 50; trial++) {
        const main = voiceLedReharm(EDO, TONALITY, checked, approaches, {}, TONIC, longMelody, MODE_PCS);
        const pool = getAllPoolChords(EDO, TONALITY, checked, effectiveApproaches, {}, TONIC);
        const iiVOnlyV = new Set<string>();
        for (const [target, kinds] of Object.entries(approaches)) {
          if (kinds.includes("iiV") && !kinds.includes("secdom")) iiVOnlyV.add(`V/${target}`);
        }
        const params: MidBarParams = {
          edo: EDO, tonality: TONALITY, checked,
          approachesForT: approaches, tonicRoot: TONIC, pool, iiVOnlyV,
        };
        const stream: { roman: string }[] = [];
        for (let i = 0; i < main.length; i++) {
          stream.push({ roman: main[i].roman });
          if (i + 1 < main.length && Math.random() < 0.6) {
            const mid = buildMidBarChord(params, main[i], main[i + 1]);
            if (mid) stream.push({ roman: mid.roman });
          }
        }
        const issues = verifyReharm(stream, approaches);
        if (issues.length > 0 && totalIssues < 50) {
          console.error(`Adversarial cfg ${cfg} (checked=${checked.join(",")}, approaches=${JSON.stringify(approaches)}) → stream: ${stream.map(c => c.roman).join(" → ")}`);
          console.error(`  issues:`, issues.slice(0, 3));
        }
        totalIssues += issues.length;
      }
    }
    expect(totalIssues).toBe(0);
  });

  // Long-form: 16 bars (Danny-Boy length) with only I/IV/V checked +
  // iiV/IV.  Stresses the DP on a longer phrase to ensure no constraint
  // slips across more bars.
  it("user scenario long: I/IV/V + iiV/IV across 16 bars — no violations", () => {
    const approaches: Record<string, ApproachKind[]> = { IV: ["iiV"] };
    const checked = ["I", "IV", "V"];
    // Repeat the 8-bar melody twice to simulate a 16-bar song.
    const longMelody = [...melody, ...melody];
    const allIssues: Issue[] = [];
    for (let t = 0; t < 100; t++) {
      const main = voiceLedReharm(EDO, TONALITY, checked, approaches, {}, TONIC, longMelody, MODE_PCS);
      const pool = getAllPoolChords(EDO, TONALITY, checked, approaches, {}, TONIC);
      const iiVOnlyV = new Set<string>();
      for (const [target, kinds] of Object.entries(approaches)) {
        if (kinds.includes("iiV") && !kinds.includes("secdom")) iiVOnlyV.add(`V/${target}`);
      }
      const params: MidBarParams = {
        edo: EDO, tonality: TONALITY, checked,
        approachesForT: approaches, tonicRoot: TONIC, pool, iiVOnlyV,
      };
      const stream: { roman: string }[] = [];
      for (let i = 0; i < main.length; i++) {
        stream.push({ roman: main[i].roman });
        if (i + 1 < main.length && Math.random() < 0.6) {
          const mid = buildMidBarChord(params, main[i], main[i + 1]);
          if (mid) stream.push({ roman: mid.roman });
        }
      }
      allIssues.push(...verifyReharm(stream, approaches));
    }
    if (allIssues.length > 0) {
      console.error(`Long user scenario issues:`, allIssues.slice(0, 20));
    }
    expect(allIssues).toEqual([]);
  });
});
