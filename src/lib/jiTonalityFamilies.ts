// ── JI Tonality Families (Pythagorean + Schismatic temperaments) ─────────
//
// Pythagorean (41-EDO) and Schismatic (53-EDO) preserve commatic
// distinctions that vanish under meantone, so the same nominal scale
// (e.g. "Major") can be tuned in multiple ways depending on which prime
// limit you commit to.  This file lists the curated set of scales that
// the Tonal Audiation tabs expose for those temperaments, organised by
// limit (3 → Pythagorean, 5 → 5-limit JI, 7 → septimal, 11 → neutral /
// Maqam) and then by family within each limit.
//
// Scale interval data is registered separately in edoData.ts via
// registerJiScales() so this file can stay UI-agnostic.

export type JiLimit = 3 | 5 | 7 | 11;

export interface JiFamily {
  /** Stable id for state persistence */
  key: string;
  /** Display label (e.g. "MAJOR-KEY") */
  label: string;
  /** Tonality names registered as scale data; click selects this scale */
  tonalities: string[];
}

export interface JiLimitGroup {
  limit: JiLimit;
  /** Display header — e.g. "3-LIMIT (Pythagorean)" */
  label: string;
  /** Hex colour for the limit's chip / header */
  color: string;
  /** Brief one-line description for tooltips / muted secondary text */
  blurb: string;
  /** Family groupings within this limit */
  families: JiFamily[];
}

/**
 * Curated JI tonality groups for the Pythagorean and Schismatic
 * temperaments.  Same shape applies to both 41-EDO and 53-EDO; the
 * underlying step counts differ but the conceptual scale names match.
 *
 * The "important scales per limit" set was scoped on 2026-05-03:
 *   3-limit  — 4 scales: Pythagorean Ionian / Aeolian / Dorian / Mixolydian
 *   5-limit  — 7 scales: JI Ionian / Dorian / Phrygian / Lydian / Mixolydian
 *               / Aeolian + JI Harmonic Minor
 *   7-limit  — 4 scales: Garibaldi[7] / Septimal Major / Septimal Minor
 *               / Septimal Diminished
 *   11-limit — 4 scales: Mohajira / Rast / Bayati / Hijaz
 *
 * The names here are the public tonality identifiers used by the picker;
 * registerJiScales() in edoData.ts maps them to actual step values for
 * each EDO.
 */
export const JI_LIMIT_GROUPS: JiLimitGroup[] = [
  {
    limit: 3,
    label: "3-LIMIT (Pythagorean)",
    color: "#c09050",
    blurb: "Pure 3:2 fifths only — thirds are 81/64 (~408¢), bright and tense.",
    families: [
      {
        key: "pyth-diatonic",
        label: "DIATONIC",
        tonalities: [
          "Pythagorean Ionian",
          "Pythagorean Aeolian",
          "Pythagorean Dorian",
          "Pythagorean Mixolydian",
        ],
      },
    ],
  },
  {
    limit: 5,
    label: "5-LIMIT (Just Intonation)",
    color: "#6a9aca",
    blurb: "Pure 5:4 thirds + 3:2 fifths — the classical JI palette.",
    families: [
      {
        key: "ji-diatonic",
        label: "DIATONIC",
        tonalities: [
          "JI Ionian",
          "JI Dorian",
          "JI Phrygian",
          "JI Lydian",
          "JI Mixolydian",
          "JI Aeolian",
        ],
      },
      {
        key: "ji-harmonic",
        label: "HARMONIC MINOR",
        tonalities: [
          "JI Harmonic Minor",
        ],
      },
    ],
  },
  {
    limit: 7,
    label: "7-LIMIT (Septimal)",
    color: "#7aaa6a",
    blurb: "Adds 7:4, 7:6, 7:5 — bluesy minor-7s, subminor 3rds, septimal tritones.",
    families: [
      {
        key: "septimal-mos",
        label: "SEPTIMAL MOS",
        tonalities: [
          "Garibaldi",
        ],
      },
      {
        key: "septimal-tertian",
        label: "TERTIAN",
        tonalities: [
          "Septimal Major",
          "Septimal Minor",
          "Septimal Diminished",
        ],
      },
    ],
  },
  {
    limit: 11,
    label: "11-LIMIT (Neutral / Maqam)",
    color: "#9a66c0",
    blurb: "Adds 11:9 neutral third, 11:8 wide 4th — Mohajira and the Maqam palette.",
    families: [
      {
        key: "neutral-diatonic",
        label: "NEUTRAL DIATONIC",
        tonalities: [
          "Mohajira",
        ],
      },
      {
        key: "maqam",
        label: "MAQAM",
        tonalities: [
          "Maqam Rast",
          "Maqam Bayati",
          "Maqam Hijaz",
        ],
      },
    ],
  },
];

/** Flat list of every JI tonality across every limit / family. */
export function allJiTonalities(): string[] {
  return JI_LIMIT_GROUPS.flatMap(g => g.families.flatMap(f => f.tonalities));
}

/** Reverse lookup: which limit does a given tonality belong to? */
export function limitForJiTonality(tonality: string): JiLimit | null {
  for (const g of JI_LIMIT_GROUPS) {
    for (const f of g.families) {
      if (f.tonalities.includes(tonality)) return g.limit;
    }
  }
  return null;
}
