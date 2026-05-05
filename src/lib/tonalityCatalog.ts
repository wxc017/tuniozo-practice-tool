// ── Shared per-EDO tonality catalog ──────────────────────────────────
//
// Both ChordsTab and ModeIdentificationTab need the same "which scale
// families/tonalities are available in this EDO" picker layout.  The
// data used to live inside ChordsTab; per direct user direction
// (2026-05-05): "include tonalities from chords in mode id" — moved
// here so both tabs render the same hierarchy.
//
// Structure: each EDO maps to a list of TonalitySection (one per limit
// or family colour group).  Each section carries one or more families,
// and each family lists its tonalities (named scales registered in
// edoData.ts via registerJiScales / pattern maps).
//
// Per-EDO layouts:
//   12 / 19 / 31 → curated meantone / xen sections (TWELVE/NINETEEN/
//                  THIRTY_ONE_EDO_SECTIONS below)
//   41 / 53      → JI parent + modes layout from jiTonalityFamilies.ts
//   other        → MEANTONE_LIMIT_SECTIONS prime-limit fallback

import { jiLimitGroupsForEdo } from "./jiTonalityFamilies";

export interface TonalityFamilyGroup {
  key: string;
  label: string;
  color: string;
  tonalities: string[];
}

export interface TonalitySection {
  key: string;
  label: string;
  color: string;
  families: { key: string; label: string; tonalities: string[] }[];
}

export const TONALITY_FAMILIES: TonalityFamilyGroup[] = [
  { key: "major",    label: "MAJOR",          color: "#6a9aca",
    tonalities: ["Major","Dorian","Phrygian","Lydian","Mixolydian","Aeolian","Locrian"] },
  { key: "harmonic", label: "HARMONIC MINOR", color: "#c09050",
    tonalities: ["Harmonic Minor","Locrian #6","Ionian #5","Dorian #4","Phrygian Dominant","Lydian #2","Ultralocrian"] },
  { key: "melodic",  label: "MELODIC MINOR",  color: "#c06090",
    tonalities: ["Melodic Minor","Dorian b2","Lydian Augmented","Lydian Dominant","Mixolydian b6","Locrian #2","Altered"] },
  // Septimal / neutral diatonic families (31-EDO).  Mode names use the
  // harmonic-minor / melodic-minor convention with single-letter
  // qualifiers (s = sub, m = min, N = neu, M = maj, S = sup, # = aug).
  { key: "subminor",   label: "SUBMINOR DIATONIC",   color: "#7aaa6a",
    tonalities: ["Subminor Diatonic","Locrian s2 s5 s6","Supermajor Ionian","Dorian s3 bb4 s7","Subminor Phrygian m7","Supermajor Lydian M2 b5","Supermajor Mixolydian ##5 m7"] },
  { key: "neutral",    label: "NEUTRAL DIATONIC",    color: "#9a66c0",
    tonalities: ["Neutral Diatonic","Dorian N2 bb5 N6","Neutral Ionian","Ionian N3 ##4 N7","Neutral Dorian m7","Neutral Ionian M2 ##4","Neutral Dorian bb5 m7"] },
  { key: "supermajor", label: "SUPERMAJOR DIATONIC", color: "#cc6a8a",
    tonalities: ["Supermajor Diatonic","Dorian S2 ##5 S6","Subminor Phrygian","Lydian S3 b5 S7","Supermajor Mixolydian m7","Subminor Aeolian M2 bb4","Subminor Locrian m7"] },
  { key: "subharmonic",label: "SUBHARMONIC DIATONIC M7",color: "#4a9ac7",
    tonalities: ["Subharmonic Diatonic M7","Locrian s2 s5 N6","Supermajor Ionian #5","Dorian s3 ##4 s7","Phrygian s2 N3 s6","Supermajor Lydian #2 b5","Neutral Dorian b4 bb5 bb7"] },
  { key: "doubleharmonic", label: "DOUBLE HARMONIC", color: "#e08040",
    tonalities: ["Double Harmonic Minor","Double Harmonic Major","Lydian #2 #6","Ultraphrygian","Oriental","Ionian #2 #5","Locrian bb3 bb7"] },
  { key: "symmetric", label: "SYMMETRIC", color: "#5ab9b0",
    tonalities: [
      "Whole Tone","Half-Whole Diminished","Whole-Half Diminished",
      "Whole Tone (Half-Sharp)",
      "Half-Whole Diminished (Half-Sharp)",
      "Whole-Half Diminished (Half-Flat)",
    ] },
];

const MEANTONE_LIMIT_SECTIONS: { key: string; label: string; color: string; familyKeys: string[] }[] = [
  { key: "lim5",  label: "5-LIMIT (MEANTONE)", color: "#6a9aca",
    familyKeys: ["major", "harmonic", "melodic", "doubleharmonic"] },
  { key: "lim7",  label: "7-LIMIT (SEPTIMAL)", color: "#7aaa6a",
    familyKeys: ["subminor", "supermajor", "subharmonic"] },
  { key: "lim11", label: "11-LIMIT (NEUTRAL)", color: "#9a66c0",
    familyKeys: ["neutral"] },
  { key: "sym",   label: "SYMMETRIC",          color: "#5ab9b0",
    familyKeys: ["symmetric"] },
];

interface CuratedSection { key: string; label: string; color: string; familyKey: string }

const TWELVE_EDO_SECTIONS: CuratedSection[] = [
  { key: "12-major",      label: "DIATONIC MAJOR",                color: "#6a9aca", familyKey: "major" },
  { key: "12-harmonic",   label: "DIATONIC HARMONIC MINOR",       color: "#c09050", familyKey: "harmonic" },
  { key: "12-melodic",    label: "DIATONIC MELODIC MINOR",        color: "#c06090", familyKey: "melodic" },
  { key: "12-doubleh",    label: "DIATONIC DOUBLE HARMONIC MINOR", color: "#e08040", familyKey: "doubleharmonic" },
  { key: "12-sym",        label: "SYMMETRICAL",                   color: "#5ab9b0", familyKey: "symmetric" },
];

const THIRTY_ONE_EDO_SECTIONS: CuratedSection[] = [
  { key: "31-major",      label: "DIATONIC MAJOR",                color: "#6a9aca", familyKey: "major" },
  { key: "31-harmonic",   label: "DIATONIC HARMONIC MINOR",       color: "#c09050", familyKey: "harmonic" },
  { key: "31-melodic",    label: "DIATONIC MELODIC MINOR",        color: "#c06090", familyKey: "melodic" },
  { key: "31-doubleh",    label: "DIATONIC DOUBLE HARMONIC MINOR", color: "#e08040", familyKey: "doubleharmonic" },
  { key: "31-subminor",   label: "DIATONIC SUBMINOR",             color: "#7aaa6a", familyKey: "subminor" },
  { key: "31-supermajor", label: "DIATONIC SUPERMAJOR",           color: "#cc6a8a", familyKey: "supermajor" },
  { key: "31-subharm",    label: "DIATONIC SUBHARMONIC MINOR M7", color: "#4a9ac7", familyKey: "subharmonic" },
  { key: "31-neutral",    label: "DIATONIC NEUTRAL",              color: "#9a66c0", familyKey: "neutral" },
  { key: "31-sym",        label: "SYMMETRICAL",                   color: "#5ab9b0", familyKey: "symmetric" },
];

const NINETEEN_EDO_SECTIONS: CuratedSection[] = [
  { key: "19-major",      label: "DIATONIC MAJOR",                color: "#6a9aca", familyKey: "major" },
  { key: "19-harmonic",   label: "DIATONIC HARMONIC MINOR",       color: "#c09050", familyKey: "harmonic" },
  { key: "19-melodic",    label: "DIATONIC MELODIC MINOR",        color: "#c06090", familyKey: "melodic" },
  { key: "19-doubleh",    label: "DIATONIC DOUBLE HARMONIC MINOR", color: "#e08040", familyKey: "doubleharmonic" },
  { key: "19-sym",        label: "SYMMETRICAL",                   color: "#5ab9b0", familyKey: "symmetric" },
];

function curatedSectionsToTonalitySections(curated: CuratedSection[]): TonalitySection[] {
  return curated
    .map(sec => {
      const fam = TONALITY_FAMILIES.find(f => f.key === sec.familyKey);
      if (!fam) return null;
      return {
        key: sec.key,
        label: sec.label,
        color: sec.color,
        families: [{ key: fam.key, label: "MODES", tonalities: fam.tonalities }],
      } as TonalitySection;
    })
    .filter((s): s is TonalitySection => s !== null);
}

/** Per-EDO tonality picker layout.  Used by both ChordsTab and
 *  ModeIdentificationTab so the two tabs always show the same hierarchy
 *  for a given EDO. */
export function tonalitySectionsForEdo(edo: number): TonalitySection[] {
  if (edo === 41 || edo === 53) {
    return jiLimitGroupsForEdo(edo).map(g => ({
      key: `limit-${g.limit}`,
      label: g.label,
      color: g.color,
      families: g.families.map(f => ({ key: f.key, label: f.label, tonalities: f.tonalities })),
    }));
  }
  if (edo === 12) return curatedSectionsToTonalitySections(TWELVE_EDO_SECTIONS);
  if (edo === 31) return curatedSectionsToTonalitySections(THIRTY_ONE_EDO_SECTIONS);
  if (edo === 19) return curatedSectionsToTonalitySections(NINETEEN_EDO_SECTIONS);
  // Other EDOs fall back to the original prime-limit-grouped meantone layout.
  return MEANTONE_LIMIT_SECTIONS
    .map(sec => ({
      key: sec.key,
      label: sec.label,
      color: sec.color,
      families: sec.familyKeys
        .map(fk => TONALITY_FAMILIES.find(f => f.key === fk))
        .filter((f): f is TonalityFamilyGroup => !!f)
        .map(f => ({ key: f.key, label: f.label, tonalities: f.tonalities })),
    }))
    .filter(sec => sec.families.length > 0);
}

/** Back-compat: the flat per-EDO tonality family list used by older
 *  callers that just want "every available tonality" without sectioning.
 *  Returns a denormalised version of tonalitySectionsForEdo. */
export function tonalityFamiliesForEdo(edo: number): TonalityFamilyGroup[] {
  if (edo === 41 || edo === 53) {
    return jiLimitGroupsForEdo(edo).map(g => ({
      key: `limit-${g.limit}`,
      label: g.label,
      color: g.color,
      tonalities: g.families.flatMap(f => f.tonalities),
    }));
  }
  return TONALITY_FAMILIES;
}
