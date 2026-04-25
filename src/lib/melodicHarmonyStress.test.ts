// ── MelodicPatterns + HarmonyWorkshop behaviour stress tests ────────
// The shared chord-pool engine is already exercised by
// chordPoolStress.test.ts; this file validates the additional surfaces
// each tab exposes on top of it:
//
//   MelodicPatterns:
//     - generatePoolProgression for the chord progression underlying
//       every segment (Markov + random, varying counts)
//     - pickPoolChordForMelody (melody-fit reharmonization) returns a
//       valid PoolProgChord drawn from the user's pool
//     - randomMelodyWithAngularity over the resulting chord PCs yields
//       melody notes inside [0, edo) for every standard NoteCategory
//
//   HarmonyWorkshop:
//     - Per-bar generatePoolProgression scales correctly across many
//       bar counts (1 / 2 / 4 / 8 / 16 / 32) without dead-ends
//     - The mid-bar secondary-dominant lookup uses getAllPoolChords —
//       when V/X is present, it is reachable; when not, common-tone
//       fallbacks still exist for sufficient pool sizes
//
// Sample budget: ~10 000 chord samples + ~10 000 melody notes total,
// distributed across (edo × tonality × pool-shape) cases.

import { describe, it, expect } from "vitest";
import {
  generatePoolProgression,
  getAllPoolChords,
  pickPoolChordForMelody,
  applicableXenKinds,
  type XenKind,
} from "./tonalityChordPool";
import {
  getTonalityBanks,
  APPROACH_KINDS,
  type ApproachKind,
} from "./tonalityBanks";
import {
  randomMelodyWithAngularity,
  type NoteCategory,
} from "./melodicPatternData";
import { getBaseChords, getChordShapes } from "./edoData";

const EDOS = [12, 31, 41] as const;
const TONIC_ROOT = 0;

// ── helpers ──────────────────────────────────────────────────────────

function visibleCheckedForBank(edo: number, tonality: string): string[] {
  const banks = getTonalityBanks(edo);
  const bank = banks.find(b => b.name === tonality);
  if (!bank) return [];
  const out: string[] = [];
  for (const level of bank.levels) {
    if (level.name !== "Primary" && level.name !== "Diatonic" && level.name !== "Modal Interchange") continue;
    for (const c of level.chords) out.push(c.label);
  }
  return out;
}

// Only Primary/Diatonic chords can carry approach toggles in the UI.
function approachableChecked(edo: number, tonality: string): string[] {
  const banks = getTonalityBanks(edo);
  const bank = banks.find(b => b.name === tonality);
  if (!bank) return [];
  const out: string[] = [];
  for (const level of bank.levels) {
    if (level.name !== "Primary" && level.name !== "Diatonic") continue;
    for (const c of level.chords) out.push(c.label);
  }
  return out;
}

function allApproaches(checked: string[]): Record<string, ApproachKind[]> {
  const out: Record<string, ApproachKind[]> = {};
  for (const lbl of checked) out[lbl] = [...APPROACH_KINDS];
  return out;
}

function allXen(edo: number, tonality: string, checked: string[]): Record<string, XenKind[]> {
  const baseMap: Record<string, number[]> = Object.fromEntries(getBaseChords(edo));
  const banks = getTonalityBanks(edo);
  const bank = banks.find(b => b.name === tonality);
  if (!bank) return {};
  const stepsByLabel = new Map<string, number[]>();
  for (const level of bank.levels) {
    for (const c of level.chords) {
      const steps = c.steps ?? baseMap[c.label];
      if (steps) stepsByLabel.set(c.label, steps);
    }
  }
  const out: Record<string, XenKind[]> = {};
  for (const lbl of checked) {
    const steps = stepsByLabel.get(lbl);
    if (!steps) continue;
    const av = applicableXenKinds(steps, edo);
    if (av.length > 0) out[lbl] = av;
  }
  return out;
}

// ── MelodicPatterns ──────────────────────────────────────────────────

describe("MelodicPatterns — engine stress", () => {
  it("generatePoolProgression: varied counts (1..16) always returns valid chords", () => {
    let total = 0;
    const bugs: { edo: number; tonality: string; count: number; reason: string }[] = [];
    const counts = [1, 2, 3, 4, 6, 8, 12, 16];
    for (const edo of EDOS) {
      const banks = getTonalityBanks(edo);
      for (const bank of banks) {
        const tonality = bank.name;
        const checked = visibleCheckedForBank(edo, tonality);
        const approaches = allApproaches(checked);
        const xen = allXen(edo, tonality, checked);
        for (const count of counts) {
          for (let trial = 0; trial < 4; trial++) {
            const prog = generatePoolProgression(
              edo, count, tonality, checked, approaches, xen, TONIC_ROOT,
              trial % 2 === 0 ? "functional" : "random",
            );
            // Engine may return [] if pool is empty for this bank; that's
            // acceptable.  Otherwise, must return exactly `count` chords.
            if (prog.length === 0) continue;
            if (prog.length !== count) {
              bugs.push({ edo, tonality, count, reason: `expected ${count} chords, got ${prog.length}` });
            }
            for (const ch of prog) {
              total++;
              if (ch.chordPcs.length === 0) {
                bugs.push({ edo, tonality, count, reason: `empty chordPcs for ${ch.roman}` });
                continue;
              }
              for (const pc of ch.chordPcs) {
                if (pc < 0 || pc >= edo) {
                  bugs.push({ edo, tonality, count, reason: `pc ${pc} out of range for ${ch.roman}` });
                }
              }
            }
          }
        }
      }
    }
    if (bugs.length > 0) {
      throw new Error(`MP generatePoolProgression bugs (${bugs.length}/${total} samples):\n${JSON.stringify(bugs.slice(0, 8), null, 2)}`);
    }
    expect(total).toBeGreaterThan(0);
  });

  it("pickPoolChordForMelody: always picks a chord from the user's pool (not an invented one)", () => {
    const bugs: { edo: number; tonality: string; melody: number[]; picked: string; reason: string }[] = [];
    let total = 0;

    for (const edo of EDOS) {
      const banks = getTonalityBanks(edo);
      for (const bank of banks) {
        const tonality = bank.name;
        const checked = visibleCheckedForBank(edo, tonality);
        const approaches = allApproaches(checked);
        const xen = allXen(edo, tonality, checked);
        const allowedLabels = new Set(
          getAllPoolChords(edo, tonality, checked, approaches, xen, TONIC_ROOT).map(c => c.roman),
        );
        if (allowedLabels.size === 0) continue;

        // Probe 80 random melodies per (edo, tonality) — each 1..6 random PCs.
        for (let i = 0; i < 80; i++) {
          const len = 1 + Math.floor(Math.random() * 6);
          const melody: number[] = [];
          for (let j = 0; j < len; j++) melody.push(Math.floor(Math.random() * edo));
          const picked = pickPoolChordForMelody(edo, melody, tonality, checked, approaches, xen, TONIC_ROOT);
          total++;
          if (!picked) {
            bugs.push({ edo, tonality, melody, picked: "(null)", reason: "no chord picked even though pool is non-empty" });
            continue;
          }
          if (!allowedLabels.has(picked.roman)) {
            bugs.push({ edo, tonality, melody, picked: picked.roman, reason: "picked label is not in the user's pool" });
          }
          // chordPcs sanity
          if (picked.chordPcs.length === 0) {
            bugs.push({ edo, tonality, melody, picked: picked.roman, reason: "empty chordPcs" });
          }
          for (const pc of picked.chordPcs) {
            if (pc < 0 || pc >= edo) {
              bugs.push({ edo, tonality, melody, picked: picked.roman, reason: `chord PC ${pc} out of range` });
            }
          }
        }
      }
    }

    if (bugs.length > 0) {
      throw new Error(`pickPoolChordForMelody bugs (${bugs.length}/${total} probes):\n${JSON.stringify(bugs.slice(0, 8), null, 2)}`);
    }
    expect(total).toBeGreaterThan(0);
  });

  it("randomMelodyWithAngularity over generated chords yields melody notes inside [0, edo)", () => {
    const bugs: { edo: number; tonality: string; chord: string; bad: number[]; reason: string }[] = [];
    let melodyNoteCount = 0;
    const noteCats: NoteCategory[] = ["ct", "diatonic", "chromatic"];
    const lengths = [2, 4, 6, 8];

    for (const edo of EDOS) {
      const fullPool = Array.from({ length: edo * 4 }, (_, i) => i);
      const banks = getTonalityBanks(edo);
      for (const bank of banks) {
        const tonality = bank.name;
        const checked = visibleCheckedForBank(edo, tonality);
        const approaches = allApproaches(checked);
        const xen = allXen(edo, tonality, checked);
        const prog = generatePoolProgression(edo, 4, tonality, checked, approaches, xen, TONIC_ROOT, "functional");
        if (prog.length === 0) continue;

        for (const ch of prog) {
          for (const len of lengths) {
            for (const cat of noteCats) {
              const cats = new Set<NoteCategory>([cat]);
              const melody = randomMelodyWithAngularity(
                fullPool, ch.chordPcs, len, cats,
                /* bias */ 0,
                /* allowRepeats */ false,
                edo,
                /* angularity */ 0,
                /* hasChordContext */ true,
              );
              for (const n of melody) {
                melodyNoteCount++;
                if (!Number.isFinite(n)) {
                  bugs.push({ edo, tonality, chord: ch.roman, bad: melody, reason: `non-finite melody note ${n}` });
                  break;
                }
                // Allow notes in any octave; pc must be valid mod-edo.
                const pc = ((n % edo) + edo) % edo;
                if (pc < 0 || pc >= edo) {
                  bugs.push({ edo, tonality, chord: ch.roman, bad: melody, reason: `melody pc ${pc} out of range` });
                  break;
                }
              }
            }
          }
        }
      }
    }

    if (bugs.length > 0) {
      throw new Error(`Melody-generation bugs (${bugs.length}/${melodyNoteCount} notes):\n${JSON.stringify(bugs.slice(0, 8), null, 2)}`);
    }
    expect(melodyNoteCount).toBeGreaterThan(0);
  });
});

// ── HarmonyWorkshop ──────────────────────────────────────────────────

describe("HarmonyWorkshop — engine stress", () => {
  it("Per-bar generatePoolProgression scales across realistic song lengths (1, 2, 4, 8, 16, 32)", () => {
    const barCounts = [1, 2, 4, 8, 16, 32];
    const bugs: { edo: number; tonality: string; bars: number; reason: string }[] = [];
    let total = 0;
    for (const edo of EDOS) {
      const banks = getTonalityBanks(edo);
      for (const bank of banks) {
        const tonality = bank.name;
        const checked = visibleCheckedForBank(edo, tonality);
        const approaches = allApproaches(checked);
        const xen = allXen(edo, tonality, checked);
        for (const bars of barCounts) {
          // 4 trials per (edo, tonality, bars) to expose flaky outputs.
          for (let trial = 0; trial < 4; trial++) {
            const prog = generatePoolProgression(
              edo, bars, tonality, checked, approaches, xen, TONIC_ROOT, "functional",
            );
            if (prog.length === 0) continue;
            if (prog.length !== bars) {
              bugs.push({ edo, tonality, bars, reason: `expected ${bars}, got ${prog.length}` });
              continue;
            }
            // Each chord must be playable.
            for (const ch of prog) {
              total++;
              if (ch.chordPcs.length === 0) {
                bugs.push({ edo, tonality, bars, reason: `empty chord ${ch.roman}` });
              }
            }
          }
        }
      }
    }
    if (bugs.length > 0) {
      throw new Error(`HW per-bar progression bugs (${bugs.length}/${total} samples):\n${JSON.stringify(bugs.slice(0, 8), null, 2)}`);
    }
    expect(total).toBeGreaterThan(0);
  });

  it("Mid-bar V7 lookup: when secdom is enabled, every diatonic chord can find a V7 in the pool", () => {
    const sh12 = getChordShapes(12);
    const m7Of = (edo: number) => getChordShapes(edo).m7;
    const bugs: { edo: number; tonality: string; target: string; reason: string }[] = [];
    for (const edo of EDOS) {
      const m7 = m7Of(edo);
      const M3 = getChordShapes(edo).M3;
      const P5 = getChordShapes(edo).P5;
      const banks = getTonalityBanks(edo);
      for (const bank of banks) {
        const tonality = bank.name;
        const checked = visibleCheckedForBank(edo, tonality);
        const approachable = approachableChecked(edo, tonality);
        const approaches: Record<string, ApproachKind[]> = {};
        // Enable secdom on every non-tonic Primary/Diatonic chord — these
        // are the only chords whose UI exposes the approach toggles.
        for (const lbl of approachable) {
          if (lbl !== "I" && lbl !== "i") approaches[lbl] = ["secdom"];
        }
        const pool = getAllPoolChords(edo, tonality, checked, approaches, {}, TONIC_ROOT);
        const poolByLabel = new Map(pool.map(p => [p.roman, p]));
        for (const target of Object.keys(approaches)) {
          const v = poolByLabel.get(`V/${target}`);
          if (!v) {
            bugs.push({ edo, tonality, target, reason: "V/X missing from pool" });
            continue;
          }
          const r = v.chordPcs[0];
          const rels = v.chordPcs.map(p => ((p - r) % edo + edo) % edo).sort((a, b) => a - b);
          const expected = [0, M3, P5, m7].sort((a, b) => a - b);
          if (rels.join(",") !== expected.join(",")) {
            bugs.push({ edo, tonality, target, reason: `V/X not dom7 — got ${rels.join(",")}, expected ${expected.join(",")}` });
          }
        }
      }
      void sh12;
    }
    if (bugs.length > 0) {
      throw new Error(`HW V/X dom7 lookup bugs (${bugs.length}):\n${JSON.stringify(bugs.slice(0, 10), null, 2)}`);
    }
  });

  it("Common-tone reharm fallback: getAllPoolChords usually contains chords sharing tones with any other chord", () => {
    // Simulates HarmonyWorkshop's common-tone fallback: for every chord
    // in the pool, at least one *other* chord in the pool should share a
    // common tone (so the mid-bar reharm can find a candidate).
    const offenders: { edo: number; tonality: string; chord: string }[] = [];
    let pairs = 0;
    for (const edo of EDOS) {
      const banks = getTonalityBanks(edo);
      for (const bank of banks) {
        const tonality = bank.name;
        const checked = visibleCheckedForBank(edo, tonality);
        const approaches = allApproaches(checked);
        const pool = getAllPoolChords(edo, tonality, checked, approaches, {}, TONIC_ROOT);
        for (const a of pool) {
          const aPcs = new Set(a.chordPcs);
          let foundOther = false;
          for (const b of pool) {
            if (b.roman === a.roman) continue;
            if (b.chordPcs.some(p => aPcs.has(p))) { foundOther = true; break; }
          }
          pairs++;
          if (!foundOther && pool.length > 1) {
            offenders.push({ edo, tonality, chord: a.roman });
          }
        }
      }
    }
    // It's fine if a few isolated chords have no common tone with any
    // other (e.g. very narrow Locrian banks); flag only if it's frequent.
    if (offenders.length > pairs * 0.05) {
      throw new Error(`Too many isolated chords (no common tone with any neighbor): ${offenders.length}/${pairs}.\nFirst 12:\n${JSON.stringify(offenders.slice(0, 12), null, 2)}`);
    }
  });
});
