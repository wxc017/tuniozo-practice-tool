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

// Per-EDO limit availability.  Per direct user direction (2026-05-04),
// a higher-limit family is only listed if its named prime's M3 / m3 is
// DISTINCTIVE in the EDO step grid — i.e. the prime's ratio beats every
// simpler-prime alternative by n*d at the step it rounds to.  Under
// that rule, 17 / 19 / 23 / 29 / 31-LIMIT all fail in both 41-EDO and
// 53-EDO (their thirds collide with simpler primes — see jiScaleData.ts
// for the per-prime collision table).  7-LIMIT also fails the prior
// 3-6-7 prime-purity rule.  Only 11-LIMIT (Mohajira's 11/9 distinctive
// b3) and 13-LIMIT (Tridecimal Diatonic Major/Minor's 13/10 + 13/11
// distinctive thirds) survive among higher limits.
export const JI_LIMITS_PER_EDO: Record<number, JiLimit[]> = {
  41: [3, 5, 11, 13],
  53: [3, 5, 11, 13],
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
  // 7-LIMIT (Septimal) was pruned: under the 3-6-7 prime-purity rule
  // (a higher-limit scale must carry its named prime at the 3rd, 6th,
  // and 7th), no 7-limit scale in the previous catalog qualified —
  // Garibaldi's 3-6-7 are Pythagorean, Septimal Major's 3rd and 6th
  // are 5-limit (5/4 + 5/3), Septimal Minor's b6 is 5-limit (8/5).
  // Slot reserved for a future curated 7-limit scale.
  {
    limit: 11,
    label: "NEUTRAL (11-LIMIT)",
    color: "#9a66c0",
    blurb: "Adds 11:9 neutral third, 11:8 wide 4th — Mohajira's neutral diatonic.",
    families: [
      {
        key: "neutral-diatonic",
        label: "NEUTRAL DIATONIC",
        tonalities: [
          "Mohajira",
        ],
      },
      // Maqam family pruned: every Maqam variant in the previous
      // catalog mixes 5-limit / 3-limit tones at one of the 3rd / 6th
      // / 7th positions, so none survive the prime-purity rule.
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
          "Tridecimal Diatonic Major",
          "Tridecimal Diatonic Minor",
        ],
      },
      // Modal / Maqam variants pruned (Tridecimal Lydian's 3 + 7 are
      // 5-limit; Maqam Sikah / Awj Iraq's 7th is 11-limit).
    ],
  },
  // 17 / 19 / 23 / 29 / 31-LIMIT families pruned: every higher-limit
  // M3 / m3 candidate collides with a simpler prime ratio that wins
  // the class-rep at its EDO step in both 41-EDO and 53-EDO, so the
  // user can't actually hear / see the named prime as the chord's
  // third — the displayed third is the simpler-prime equivalent.
  // See jiScaleData.ts for the full collision table.
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

/**
 * Per-limit subscript marker used to disambiguate roman-numeral
 * chord labels across JI prime-limit families in 41/53-EDO.
 * Rendered as a leading subscript so the user sees "ⱼᵢi" /
 * "₁₃IV" / etc.  5-limit gets the "JI" tag rather than a plain "5"
 * — a digit alone reads as a chord-extension number (5-chord) and
 * the 5-limit family is already conventionally referred to as
 * "Just Intonation" / "JI" throughout the app's scale names
 * (JI Ionian, JI Dorian, …).  Other limits stay as prime-number
 * digits because numbers above 5 don't collide with chord-shape
 * vocabulary.
 */
const LIMIT_ABBREV: Record<JiLimit, string> = {
  3: "3",
  5: "JI",
  7: "7",
  11: "11",
  13: "13",
  17: "17",
  19: "19",
  23: "23",
  29: "29",
  31: "31",
};

/** Family abbreviation for a tonality, or null if the tonality isn't
 *  a curated JI scale.  Used as a superscript prefix in chord-name
 *  rendering so the user can tell e.g. "Tridecimal I" from
 *  "Heptadecimal I" at a glance. */
export function familyAbbreviationForTonality(tonality: string): string | null {
  const limit = limitForJiTonality(tonality);
  if (limit === null) return null;
  return LIMIT_ABBREV[limit];
}
