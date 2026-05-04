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

export type JiLimit = 3 | 5 | 7 | 11 | 13 | 17 | 19 | 23 | 29 | 31;

// Per-EDO limit availability.  41-EDO has decent approximations for every
// prime up to 31; 53-EDO is excellent on 5 / 13 and decent on 7 / 19 but
// poor on 11 / 17 / 23 / 29 / 31, so we restrict its picker to limits
// where the rounded-to-EDO scales remain musically faithful.
export const JI_LIMITS_PER_EDO: Record<number, JiLimit[]> = {
  41: [3, 5, 7, 11, 13, 17, 19, 23, 29, 31],
  53: [3, 5, 7, 11, 13, 19],
};

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
    label: "PYTHAGOREAN (3-LIMIT)",
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
    label: "JUST INTONATION (5-LIMIT)",
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
    label: "SEPTIMAL (7-LIMIT)",
    color: "#7aaa6a",
    blurb: "Adds 7:4, 7:6, 7:5 — bluesy minor-7s, subminor 3rds, septimal tritones.",
    families: [
      {
        key: "septimal-mos",
        label: "MOS",
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
      {
        key: "septimal-modal",
        label: "MODAL",
        tonalities: [
          "Septimal Lydian",
          "Septimal Phrygian",
        ],
      },
    ],
  },
  {
    limit: 11,
    label: "NEUTRAL / MAQAM (11-LIMIT)",
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
          "Maqam Saba",
          "Maqam Huzam",
          "Maqam Nahawand",
          "Maqam Kurd",
          "Maqam Nikriz",
        ],
      },
    ],
  },
  {
    limit: 13,
    label: "TRIDECIMAL (13-LIMIT)",
    color: "#c84a8a",
    blurb: "Adds 13:8 (~841¢) and 13:11 (~289¢) — the supraminor / wide-6th colour.",
    families: [
      {
        key: "tridecimal-tertian",
        label: "TERTIAN",
        tonalities: [
          "Tridecimal Major",
          "Tridecimal Minor",
        ],
      },
      {
        key: "tridecimal-modal",
        label: "MODAL",
        tonalities: [
          "Tridecimal Lydian",
        ],
      },
      {
        key: "tridecimal-maqam",
        label: "MAQAM",
        tonalities: [
          "Maqam Sikah",
          "Maqam Awj Iraq",
        ],
      },
    ],
  },
  {
    limit: 17,
    label: "HEPTADECIMAL (17-LIMIT)",
    color: "#5a9aca",
    blurb: "17:16 (~105¢) gives a small supraminor 2nd; 17:9 (~1101¢) a wide leading-tone.",
    families: [
      {
        key: "heptadecimal-tertian",
        label: "TERTIAN",
        tonalities: [
          "Heptadecimal Major",
          "Heptadecimal Minor",
        ],
      },
      {
        key: "heptadecimal-other",
        label: "MODAL",
        tonalities: [
          "Heptadecimal Hijaz",
        ],
      },
    ],
  },
  {
    limit: 19,
    label: "NONADECIMAL (19-LIMIT)",
    color: "#5acca0",
    blurb: "19:16 (~298¢) lands between Pythagorean and 5-limit minor 3rds; 19:15 (~409¢) gives a wide M3.",
    families: [
      {
        key: "nonadecimal-tertian",
        label: "TERTIAN",
        tonalities: [
          "Nonadecimal Major",
          "Nonadecimal Minor",
        ],
      },
    ],
  },
  {
    limit: 23,
    label: "VICESIMOTERTIAL (23-LIMIT)",
    color: "#caac5a",
    blurb: "Major 7 lifts to 23/12; minor b3 lifts to 23/19 supraminor — recognisable Major / Minor with one 23-prime colour-tone.",
    families: [
      {
        key: "23-tertian",
        label: "TERTIAN",
        tonalities: ["Vicesimotertial Major", "Vicesimotertial Minor"],
      },
    ],
  },
  {
    limit: 29,
    label: "VICENOVENAL (29-LIMIT)",
    color: "#aa6a5a",
    blurb: "Major b7 borrows 29/16; Minor's b3 / b6 nudge into 29-territory at the modal tones.",
    families: [
      {
        key: "29-tertian",
        label: "TERTIAN",
        tonalities: ["Vicenovenal Major", "Vicenovenal Minor"],
      },
    ],
  },
  {
    limit: 31,
    label: "TRIGESIMOPRIMAL (31-LIMIT)",
    color: "#ca6acc",
    blurb: "Major 7 = 31/16 wide leading-tone; Minor b3 / b6 use 31-prime substitutes — Aeolian tilted into 31-flavour.",
    families: [
      {
        key: "31-tertian",
        label: "TERTIAN",
        tonalities: ["Trigesimoprimal Major", "Trigesimoprimal Minor"],
      },
    ],
  },
];

/** JI limit groups available for a given EDO.  41-EDO sees everything;
 *  53-EDO is filtered to limits where the EDO-rounded scale stays
 *  musically faithful (5-limit core + 7 / 11 / 13 / 19 it handles well). */
export function jiLimitGroupsForEdo(edo: number): JiLimitGroup[] {
  const allowed = JI_LIMITS_PER_EDO[edo];
  if (!allowed) return JI_LIMIT_GROUPS;
  const set = new Set(allowed);
  return JI_LIMIT_GROUPS.filter(g => set.has(g.limit));
}

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
