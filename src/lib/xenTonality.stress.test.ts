// ── Septimal / Neutral diatonic stress tests ─────────────────────────
// Verifies the 4 new tonality families (Subminor Diatonic, Neutral
// Diatonic, Supermajor Diatonic, Subharmonic Diatonic) work end-to-end:
//   • mode-rotation degree maps are consistent with the parent scale
//   • position-aware degree labels are valid (no duplicates per mode)
//   • tonality banks emit primary + diatonic chords for every mode
//   • Roman-numeral case + suffix encode 3rd/7th quality correctly
//   • the 28 modes round-trip through the existing helpers without
//     blowing up under random tonics / EDOs.

import { describe, it, expect } from "vitest";
import {
  PATTERN_SCALE_FAMILIES,
  getModeDegreeMap,
  getScaleDiatonicSteps,
} from "./musicTheory";
import { getTonalityBanks, getTonalityNames } from "./tonalityBanks";

const EDO = 31;

const NEW_FAMILIES = [
  "Subminor Diatonic Family",
  "Neutral Diatonic Family",
  "Supermajor Diatonic Family",
  "Subharmonic Diatonic Family",
] as const;

const PARENTS: Record<string, number[]> = {
  "Subminor Diatonic Family":   [0, 5, 7, 13, 18, 20, 25],
  "Neutral Diatonic Family":    [0, 5, 9, 13, 18, 22, 27],
  "Supermajor Diatonic Family": [0, 5, 11, 13, 18, 24, 29],
  "Subharmonic Diatonic Family": [0, 5, 7, 13, 18, 20, 28],
};

describe("Xen tonality families — registration", () => {
  it("each new family has exactly 7 modes listed", () => {
    for (const fam of NEW_FAMILIES) {
      expect(PATTERN_SCALE_FAMILIES[fam]).toBeDefined();
      expect(PATTERN_SCALE_FAMILIES[fam].length).toBe(7);
    }
  });

  it("every mode in every new family resolves to a non-empty degree map", () => {
    for (const fam of NEW_FAMILIES) {
      for (const modeName of PATTERN_SCALE_FAMILIES[fam]) {
        const map = getModeDegreeMap(EDO, fam, modeName);
        expect(Object.keys(map).length).toBeGreaterThanOrEqual(7);
      }
    }
  });
});

describe("Xen tonality families — rotation correctness", () => {
  it("each mode's scale-step set equals a rotation of the parent", () => {
    for (const fam of NEW_FAMILIES) {
      const parent = PARENTS[fam];
      const modes = PATTERN_SCALE_FAMILIES[fam];
      for (let i = 0; i < modes.length; i++) {
        const map = getModeDegreeMap(EDO, fam, modes[i]);
        const steps = Object.values(map).sort((a, b) => a - b);
        // Compute the expected rotation manually
        const root = parent[i];
        const expected: number[] = [];
        for (let j = 0; j < parent.length; j++) {
          const k = (i + j) % parent.length;
          const wrap = (i + j) >= parent.length ? EDO : 0;
          expected.push(parent[k] + wrap - root);
        }
        expected.sort((a, b) => a - b);
        expect(steps).toEqual(expected);
      }
    }
  });

  it("mode 1 of each family always starts at step 0", () => {
    for (const fam of NEW_FAMILIES) {
      const map = getModeDegreeMap(EDO, fam, PATTERN_SCALE_FAMILIES[fam][0]);
      expect(map["1"]).toBe(0);
    }
  });

  it("getScaleDiatonicSteps returns 7 sorted steps per mode", () => {
    for (const fam of NEW_FAMILIES) {
      for (const modeName of PATTERN_SCALE_FAMILIES[fam]) {
        const steps = getScaleDiatonicSteps(fam, modeName, EDO);
        expect(steps.length).toBe(7);
        for (let i = 1; i < steps.length; i++) {
          expect(steps[i]).toBeGreaterThan(steps[i - 1]);
        }
        // First step is the tonic (position 1 = 0)
        expect(steps[0]).toBe(0);
      }
    }
  });
});

describe("Xen tonality families — degree labels", () => {
  it("every degree label is unique within its mode", () => {
    for (const fam of NEW_FAMILIES) {
      for (const modeName of PATTERN_SCALE_FAMILIES[fam]) {
        const map = getModeDegreeMap(EDO, fam, modeName);
        const keys = Object.keys(map);
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
  });

  it("every step value is unique within its mode (no two labels share a step)", () => {
    for (const fam of NEW_FAMILIES) {
      for (const modeName of PATTERN_SCALE_FAMILIES[fam]) {
        const map = getModeDegreeMap(EDO, fam, modeName);
        const steps = Object.values(map);
        expect(new Set(steps).size).toBe(steps.length);
      }
    }
  });

  it("mode 1 of each canonical family uses the canonical labels (single-letter system)", () => {
    expect(getModeDegreeMap(EDO, "Subminor Diatonic Family", "Subminor Diatonic"))
      .toEqual({ "1": 0, "2": 5, "s3": 7, "4": 13, "5": 18, "s6": 20, "s7": 25 });
    expect(getModeDegreeMap(EDO, "Neutral Diatonic Family", "Neutral Diatonic"))
      .toEqual({ "1": 0, "2": 5, "n3": 9, "4": 13, "5": 18, "n6": 22, "n7": 27 });
    expect(getModeDegreeMap(EDO, "Supermajor Diatonic Family", "Supermajor Diatonic"))
      .toEqual({ "1": 0, "2": 5, "S3": 11, "4": 13, "5": 18, "S6": 24, "S7": 29 });
    expect(getModeDegreeMap(EDO, "Subharmonic Diatonic Family", "Subharmonic Diatonic M7"))
      .toEqual({ "1": 0, "2": 5, "s3": 7, "4": 13, "5": 18, "s6": 20, "7": 28 });
  });

  it("each rotation produces an interval pattern that matches the parent rotated", () => {
    // For each family, log out the rotation maps so failures show
    // exactly which step values landed where.  Uses the same rotation
    // formula as the helper.
    for (const fam of NEW_FAMILIES) {
      const parent = PARENTS[fam];
      const modeNames = PATTERN_SCALE_FAMILIES[fam];
      for (let rotIdx = 0; rotIdx < modeNames.length; rotIdx++) {
        const map = getModeDegreeMap(EDO, fam, modeNames[rotIdx]);
        const steps = Object.values(map).sort((a, b) => a - b);
        // Mode 1 always starts at 0 and ends below octave.
        expect(steps[0]).toBe(0);
        expect(steps[6]).toBeLessThan(EDO);
        // Every label is unique.
        expect(new Set(Object.keys(map)).size).toBe(7);
        // Intervals match the rotated parent.
        const expected: number[] = [];
        const root = parent[rotIdx];
        for (let i = 0; i < parent.length; i++) {
          const k = (rotIdx + i) % parent.length;
          const wrap = (rotIdx + i) >= parent.length ? EDO : 0;
          expected.push(parent[k] + wrap - root);
        }
        expected.sort((a, b) => a - b);
        expect(steps).toEqual(expected);
      }
    }
  });
});

describe("Xen tonality banks", () => {
  it("each new mode appears in getTonalityNames(31)", () => {
    const names = new Set(getTonalityNames(EDO));
    for (const fam of NEW_FAMILIES) {
      for (const modeName of PATTERN_SCALE_FAMILIES[fam]) {
        expect(names.has(modeName)).toBe(true);
      }
    }
  });

  it("every new mode has a tonality bank with Primary + Diatonic levels", () => {
    const banks = getTonalityBanks(EDO);
    const banksByName = new Map(banks.map(b => [b.name, b]));
    for (const fam of NEW_FAMILIES) {
      for (const modeName of PATTERN_SCALE_FAMILIES[fam]) {
        const bank = banksByName.get(modeName);
        expect(bank).toBeDefined();
        if (!bank) continue;
        const levelNames = bank.levels.map(l => l.name);
        expect(levelNames).toContain("Primary");
        expect(levelNames).toContain("Diatonic");
      }
    }
  });

  it("Primary + Diatonic together yield exactly 7 chord rows per mode", () => {
    const banks = getTonalityBanks(EDO);
    const banksByName = new Map(banks.map(b => [b.name, b]));
    for (const fam of NEW_FAMILIES) {
      for (const modeName of PATTERN_SCALE_FAMILIES[fam]) {
        const bank = banksByName.get(modeName)!;
        const all = bank.levels
          .filter(l => l.name === "Primary" || l.name === "Diatonic")
          .flatMap(l => l.chords);
        expect(all.length).toBe(7);
      }
    }
  });

  it("every chord has 4 stacked steps (root, 3rd, 5th, 7th)", () => {
    const banks = getTonalityBanks(EDO);
    const banksByName = new Map(banks.map(b => [b.name, b]));
    for (const fam of NEW_FAMILIES) {
      for (const modeName of PATTERN_SCALE_FAMILIES[fam]) {
        const bank = banksByName.get(modeName)!;
        for (const lvl of bank.levels) {
          for (const c of lvl.chords) {
            expect(c.steps).toBeDefined();
            expect(c.steps?.length).toBe(4);
            // Steps are strictly ascending
            for (let i = 1; i < (c.steps?.length ?? 0); i++) {
              expect(c.steps![i]).toBeGreaterThan(c.steps![i - 1]);
            }
          }
        }
      }
    }
  });
});

describe("Xen tonality banks — Roman-numeral labels", () => {
  it("the I-chord of mode 1 in each family carries the right 3rd-quality suffix (single-letter system)", () => {
    // showSevenths=true so the tonic chords also expose the 7th suffix
    // and we can verify the full label.
    const banks = getTonalityBanks(EDO, true);
    const banksByName = new Map(banks.map(b => [b.name, b]));
    const tonicLabel = (modeName: string) => {
      const bank = banksByName.get(modeName)!;
      const primary = bank.levels.find(l => l.name === "Primary")!;
      const tonic = primary.chords.find(c => c.steps?.[0] === 0)!;
      return tonic.label;
    };
    // Subminor Diatonic — ₛi prefix (subminor 3rd) + s7 (subminor 7th)
    const subTonic = tonicLabel("Subminor Diatonic");
    expect(subTonic.startsWith("ₛi")).toBe(true);
    expect(subTonic).toContain("s7");
    // Supermajor Diatonic — S3 + S7
    const supTonic = tonicLabel("Supermajor Diatonic");
    expect(supTonic.startsWith("I")).toBe(true);
    expect(supTonic).toContain("S3");
    expect(supTonic).toContain("S7");
    // Neutral Diatonic — n3 + n7
    const neuTonic = tonicLabel("Neutral Diatonic");
    expect(neuTonic).toContain("n3");
    expect(neuTonic).toContain("n7");
    // Subharmonic Diatonic M7 — ₛi prefix (subminor 3rd) + mM7 (major 7th)
    const shTonic = tonicLabel("Subharmonic Diatonic M7");
    expect(shTonic.startsWith("ₛi")).toBe(true);
    expect(shTonic).toContain("mM7");
  });

  it("by default (showSevenths=false) the chord label hides the 7th-quality suffix", () => {
    const banks = getTonalityBanks(EDO);   // default false
    const banksByName = new Map(banks.map(b => [b.name, b]));
    const tonicLabel = (modeName: string) => {
      const bank = banksByName.get(modeName)!;
      const primary = bank.levels.find(l => l.name === "Primary")!;
      return primary.chords.find(c => c.steps?.[0] === 0)!.label;
    };
    // Subminor Diatonic with no sevenths exposed: only the ₛ prefix
    // marks the chord as subminor; no s7 / m7 / 7 / Maj7 should appear.
    const subTonic = tonicLabel("Subminor Diatonic");
    expect(subTonic.startsWith("ₛi")).toBe(true);
    expect(subTonic).not.toMatch(/s7|m7|n7|S7|M7/);
  });
});
