// ── Microtonal IPA-based solfege ─────────────────────────────────────────
//
// EDO-agnostic alternative to the standard do-re-mi solfege.  Each
// scale-degree pitch (in cents above the tonic) maps to one of ~50
// interval names organized by interval class (Unison, Second, Third,
// Fourth, Tritone, Fifth, Sixth, Seventh, Octave) with subcategory
// (Minor / Neutral / Major / Subminor / Supermajor / etc.) and size
// gradation (Small / Middle / Large) within each subcategory.
//
// The system uses IPA-derived pseudo-syllables for distinct pronunciation
// — Sais / Sai / Sail for the small / middle / large minor 2nds, etc. —
// so the syllable already encodes the interval's microtonal flavour.
// Useful for ear-training when do-re-mi's sub-12-EDO inflections feel
// limiting.
//
// Lookup: nameForCents(cents) finds the interval whose range contains
// the given cents value; ranges are inclusive on the lower bound and
// exclusive on the upper, with the unison and octave handled as
// equality.  Where multiple ranges overlap (e.g. Subfifths 640–672 with
// Fifths Small 640–695), the FIRST entry in the table wins — order
// preserves the user's preferred classification.

export interface MicrotonalSyllable {
  /** Interval class — Unison / Second / Third / Fourth / Tritone /
   *  Fifth / Sixth / Seventh / Octave / etc. */
  category: string;
  /** Subcategory — Minor / Neutral / Major / Subminor / Supermajor /
   *  Equable heptatonic / etc.  Empty when the category has no
   *  subcategory split (e.g. Comma, Octave). */
  subcategory: string;
  /** Lower bound of the cent range (inclusive). */
  centsLow: number;
  /** Upper bound of the cent range (exclusive, except for octave). */
  centsHigh: number;
  /** Pseudo-syllable label (Sais, Sai, Sail, Soos, Says, etc.) */
  label: string;
  /** IPA pronunciation guide. */
  ipa: string;
}

// Curated interval-name table.  Order matters — first match wins on
// overlapping ranges.  Source data: user-provided spec (2026-05-04).
export const MICROTONAL_SOLFEGE: MicrotonalSyllable[] = [
  { category: "Unison", subcategory: "",                     centsLow: 0,    centsHigh: 0.001, label: "A",     ipa: "a" },
  { category: "Comma",  subcategory: "",                     centsLow: 0.001, centsHigh: 30,   label: "O",     ipa: "ɒ" },
  { category: "Dieses", subcategory: "",                     centsLow: 30,   centsHigh: 60,    label: "Ee",    ipa: "i" },

  // Seconds
  { category: "Second", subcategory: "Minor — Small",        centsLow: 60,   centsHigh: 80,    label: "Sais",  ipa: "saɪs" },
  { category: "Second", subcategory: "Minor — Middle",       centsLow: 80,   centsHigh: 100,   label: "Sai",   ipa: "saɪ" },
  { category: "Second", subcategory: "Minor — Large",        centsLow: 100,  centsHigh: 125,   label: "Sail",  ipa: "saɪl" },
  { category: "Second", subcategory: "Neutral — Small",      centsLow: 125,  centsHigh: 135,   label: "Soos",  ipa: "sus" },
  { category: "Second", subcategory: "Neutral — Middle",     centsLow: 135,  centsHigh: 160,   label: "Soo",   ipa: "su" },
  { category: "Second", subcategory: "Neutral — Large",      centsLow: 160,  centsHigh: 170,   label: "Sool",  ipa: "sul" },
  { category: "Second", subcategory: "Equable Heptatonic",   centsLow: 170,  centsHigh: 182,   label: "Ha",    ipa: "ha" },
  { category: "Second", subcategory: "Major — Small",        centsLow: 182,  centsHigh: 200,   label: "Says",  ipa: "seɪs" },
  { category: "Second", subcategory: "Major — Middle",       centsLow: 200,  centsHigh: 220,   label: "Say",   ipa: "seɪ" },
  { category: "Second", subcategory: "Major — Large",        centsLow: 220,  centsHigh: 240,   label: "Sayl",  ipa: "seɪl" },

  // Semifourth (Interseptimal Maj2-min3)
  { category: "Semifourth", subcategory: "Interseptimal",    centsLow: 240,  centsHigh: 260,   label: "Fe",    ipa: "fɛ" },

  // Thirds
  { category: "Third",  subcategory: "Minor — Small",        centsLow: 260,  centsHigh: 280,   label: "Thais", ipa: "θaɪs" },
  { category: "Third",  subcategory: "Minor — Middle",       centsLow: 280,  centsHigh: 300,   label: "Thai",  ipa: "θaɪ" },
  { category: "Third",  subcategory: "Minor — Large",        centsLow: 300,  centsHigh: 330,   label: "Thail", ipa: "θaɪl" },
  { category: "Third",  subcategory: "Neutral — Small",      centsLow: 330,  centsHigh: 342,   label: "Thoos", ipa: "θus" },
  { category: "Third",  subcategory: "Neutral — Middle",     centsLow: 342,  centsHigh: 360,   label: "Thoo",  ipa: "θu" },
  { category: "Third",  subcategory: "Neutral — Large",      centsLow: 360,  centsHigh: 372,   label: "Thool", ipa: "θul" },
  { category: "Third",  subcategory: "Major — Small",        centsLow: 372,  centsHigh: 400,   label: "Thays", ipa: "θeɪs" },
  { category: "Third",  subcategory: "Major — Middle",       centsLow: 400,  centsHigh: 423,   label: "Thay",  ipa: "θeɪ" },
  { category: "Third",  subcategory: "Major — Large",        centsLow: 423,  centsHigh: 440,   label: "Thayl", ipa: "θeɪl" },

  // Semisixth (Interseptimal Maj3-4)
  { category: "Semisixth", subcategory: "Interseptimal",     centsLow: 440,  centsHigh: 468,   label: "Ke",    ipa: "kɛ" },

  // Fourths
  { category: "Fourth", subcategory: "Small",                centsLow: 468,  centsHigh: 491,   label: "Fos",   ipa: "fɔs" },
  { category: "Fourth", subcategory: "Middle",               centsLow: 491,  centsHigh: 505,   label: "Fo",    ipa: "fɔ" },
  { category: "Fourth", subcategory: "Large",                centsLow: 505,  centsHigh: 528,   label: "Fol",   ipa: "fɔl" },
  { category: "Superfourth", subcategory: "",                centsLow: 528,  centsHigh: 560,   label: "Foo",   ipa: "fu" },

  // Tritones
  { category: "Tritone", subcategory: "Small",               centsLow: 560,  centsHigh: 577,   label: "Trais", ipa: "traɪs" },
  { category: "Tritone", subcategory: "Middle",              centsLow: 577,  centsHigh: 623,   label: "Trai",  ipa: "traɪ" },
  { category: "Tritone", subcategory: "Large",               centsLow: 623,  centsHigh: 640,   label: "Trail", ipa: "traɪl" },

  // Fifths (Subfifths first since they precede Fifths in the source table)
  { category: "Subfifth", subcategory: "",                   centsLow: 640,  centsHigh: 672,   label: "Fu",    ipa: "fʌ" },
  { category: "Fifth",   subcategory: "Small",               centsLow: 672,  centsHigh: 695,   label: "Fis",   ipa: "fɪs" },
  { category: "Fifth",   subcategory: "Middle",              centsLow: 695,  centsHigh: 709,   label: "Fi",    ipa: "fɪ" },
  { category: "Fifth",   subcategory: "Large",               centsLow: 709,  centsHigh: 732,   label: "Fil",   ipa: "fɪl" },

  // Semitenth (Interseptimal 5-min6)
  { category: "Semitenth", subcategory: "Interseptimal",     centsLow: 732,  centsHigh: 760,   label: "Te",    ipa: "tɛ" },

  // Sixths
  { category: "Sixth",  subcategory: "Minor — Small",        centsLow: 760,  centsHigh: 777,   label: "Kais",  ipa: "kaɪs" },
  { category: "Sixth",  subcategory: "Minor — Middle",       centsLow: 777,  centsHigh: 800,   label: "Kai",   ipa: "kaɪ" },
  { category: "Sixth",  subcategory: "Minor — Large",        centsLow: 800,  centsHigh: 828,   label: "Kail",  ipa: "kaɪl" },
  { category: "Sixth",  subcategory: "Neutral — Small",      centsLow: 828,  centsHigh: 840,   label: "Koos",  ipa: "kus" },
  { category: "Sixth",  subcategory: "Neutral — Middle",     centsLow: 840,  centsHigh: 858,   label: "Koo",   ipa: "ku" },
  { category: "Sixth",  subcategory: "Neutral — Large",      centsLow: 858,  centsHigh: 870,   label: "Kool",  ipa: "kul" },
  { category: "Sixth",  subcategory: "Major — Small",        centsLow: 870,  centsHigh: 900,   label: "Kays",  ipa: "keɪs" },
  { category: "Sixth",  subcategory: "Major — Middle",       centsLow: 900,  centsHigh: 920,   label: "Kay",   ipa: "keɪ" },
  { category: "Sixth",  subcategory: "Major — Large",        centsLow: 920,  centsHigh: 940,   label: "Kayl",  ipa: "keɪl" },

  // Semitwelfth (Interseptimal Maj6-min7)
  { category: "Semitwelfth", subcategory: "Interseptimal",   centsLow: 940,  centsHigh: 960,   label: "Twe",   ipa: "twɛ" },

  // Sevenths
  { category: "Seventh", subcategory: "Minor — Small",       centsLow: 960,  centsHigh: 987,   label: "Vais",  ipa: "vaɪs" },
  { category: "Seventh", subcategory: "Minor — Middle",      centsLow: 987,  centsHigh: 1000,  label: "Vai",   ipa: "vaɪ" },
  { category: "Seventh", subcategory: "Minor — Large",       centsLow: 1000, centsHigh: 1018,  label: "Vail",  ipa: "vaɪl" },
  { category: "Seventh", subcategory: "Equable Heptatonic",  centsLow: 1018, centsHigh: 1030,  label: "Ho",    ipa: "hɒ" },
  { category: "Seventh", subcategory: "Neutral — Small",     centsLow: 1030, centsHigh: 1043,  label: "Voos",  ipa: "vus" },
  { category: "Seventh", subcategory: "Neutral — Middle",    centsLow: 1043, centsHigh: 1065,  label: "Voo",   ipa: "vu" },
  { category: "Seventh", subcategory: "Neutral — Large",     centsLow: 1065, centsHigh: 1075,  label: "Vool",  ipa: "vul" },
  { category: "Seventh", subcategory: "Major — Small",       centsLow: 1075, centsHigh: 1100,  label: "Vays",  ipa: "veɪs" },
  { category: "Seventh", subcategory: "Major — Middle",      centsLow: 1100, centsHigh: 1120,  label: "Vay",   ipa: "veɪ" },
  { category: "Seventh", subcategory: "Major — Large",       centsLow: 1120, centsHigh: 1140,  label: "Vayl",  ipa: "veɪl" },

  // Octave neighbours
  { category: "Octave less diesis", subcategory: "",         centsLow: 1140, centsHigh: 1170,  label: "Dee",   ipa: "di" },
  { category: "Octave less comma",  subcategory: "",         centsLow: 1170, centsHigh: 1199.999, label: "Co",  ipa: "kɒ" },
  { category: "Octave",  subcategory: "",                    centsLow: 1199.999, centsHigh: 1200.001, label: "A", ipa: "a" },
];

/** Look up the microtonal syllable that matches a given cents value.
 *  Cents are octave-reduced into [0, 1200] before matching.  Returns
 *  the Unison entry for cents === 0 and Octave for cents close to 1200. */
export function syllableForCents(cents: number): MicrotonalSyllable {
  // Octave-reduce
  let c = cents % 1200;
  if (c < 0) c += 1200;
  for (const entry of MICROTONAL_SOLFEGE) {
    if (c >= entry.centsLow && c < entry.centsHigh) return entry;
  }
  // Fallback (shouldn't happen given the table covers [0, 1200])
  return MICROTONAL_SOLFEGE[0];
}

/** Convert an EDO step to its microtonal syllable. */
export function syllableForEdoStep(step: number, edo: number): MicrotonalSyllable {
  const cents = (step / edo) * 1200;
  return syllableForCents(cents);
}
