// ── EDO-Specific Music Theory Data ────────────────────────────────────
// Supports 12, 17, 19, 31, 53 EDO.
// All intervals expressed as step counts within the chosen EDO.

// ── Diatonic structure ────────────────────────────────────────────────
// T = major 2nd, s = minor 2nd (diatonic semitone), A1 = chromatic semitone (T-s)
// 53-EDO is handled specially because its 5-limit Ionian is non-uniform (T=9 or 8).
interface EdoParams { T: number; s: number; A1: number; }

const DIATONIC: Record<number, EdoParams> = {
  12: { T: 2, s: 1, A1: 1 },
  17: { T: 3, s: 1, A1: 2 },
  19: { T: 3, s: 2, A1: 1 },
  31: { T: 5, s: 3, A1: 2 },
  41: { T: 7, s: 3, A1: 4 },
  53: { T: 9, s: 5, A1: 4 }, // used only for derivations; Ionian=[0,9,17,22,31,39,48]
};

// ── Degree maps ───────────────────────────────────────────────────────
// Maps degree names to step counts above the root.
// For 53-EDO: uses 5-limit JI (M3=17, P4=22, P5=31, not Pythagorean 18/23/32).

function makeDegreeMap(T: number, s: number, A1: number): Record<string, number> {
  const edo = 5 * T + 2 * s;
  return {
    "1": 0, "b2": s, "2": T,
    "#2": T + A1, "b3": T + s,          // distinct in non-12 meantone (aug 2nd ≠ min 3rd)
    "3": 2 * T,
    "#3": 2 * T + A1,
    "4": 2 * T + s,
    "#4": 2 * T + s + A1,
    "b5": 3 * T + s - A1,             // diminished 5th = P5 - A1
    "5": 3 * T + s,
    "#5": 3 * T + s + A1,
    "b6": 3 * T + 2 * s,
    "6": 4 * T + s,
    "#6": 4 * T + s + A1,
    "b7": 4 * T + 2 * s,
    "7": 5 * T + s,
    "8": edo,
    "9": edo + T, "b9": edo + s, "#9": edo + T + s,
    "#11": edo + 2 * T + s + A1,
    "b13": edo + 3 * T + 2 * s,
  };
}

function make53DegreeMap(): Record<string, number> {
  // 5-limit JI approximations for 53-EDO
  const edo = 53;
  return {
    "1": 0, "b2": 5, "2": 9,
    "#2": 13, "b3": 14,          // aug 2nd = 9+4 = 13; min 3rd = 14
    "3": 17,
    "#3": 21,
    "4": 22,
    "#4": 26,
    "b5": 27,
    "5": 31,
    "#5": 35,
    "b6": 36,
    "6": 39,
    "#6": 43,
    "b7": 44,
    "7": 48,
    "8": edo,
    "9": 62, "b9": 58, "#9": 67,
    "#11": 79,
    "b13": 89,
  };
}

export function getDegreeMap(edo: number): Record<string, number> {
  if (edo === 53) return make53DegreeMap();
  const p = DIATONIC[edo] ?? DIATONIC[31];
  return makeDegreeMap(p.T, p.s, p.A1);
}

// ── Complete degree names (chain-of-fifths naming for every EDO step) ─
// Natural degrees sit at [0, T, 2T, 2T+s, 3T+s, 4T+s, 5T+s].
// Each # raises by A1, each b lowers by A1.
// For each step we pick the name with fewest accidentals; ties go to flats.

const _fullDegreeNamesCache: Record<number, string[]> = {};

export function getFullDegreeNames(edo: number): string[] {
  if (_fullDegreeNamesCache[edo]) return _fullDegreeNamesCache[edo];
  const p = DIATONIC[edo] ?? DIATONIC[31];
  const { T, s, A1 } = p;
  const naturals: [string, number][] = [
    ["1", 0], ["2", T], ["3", 2 * T],
    ["4", 2 * T + s], ["5", 3 * T + s],
    ["6", 4 * T + s], ["7", 5 * T + s],
  ];

  const names: string[] = new Array(edo);
  for (let step = 0; step < edo; step++) {
    let bestName = `${step}`;
    let bestAcc = Infinity;

    for (const [deg, pos] of naturals) {
      const up   = ((step - pos) % edo + edo) % edo;
      const down = ((pos - step) % edo + edo) % edo;

      if (up % A1 === 0) {
        const n = up / A1;
        if (n < bestAcc) { bestAcc = n; bestName = n === 0 ? deg : "#".repeat(n) + deg; }
      }
      if (down % A1 === 0) {
        const n = down / A1;
        // prefer flats on tie (<=)
        if (n > 0 && n <= bestAcc) { bestAcc = n; bestName = "b".repeat(n) + deg; }
      }
    }
    names[step] = bestName;
  }
  _fullDegreeNamesCache[edo] = names;
  return names;
}

// Minor degree map — same chromatic content, minor degrees (b3, b6, b7) are "natural"
export function getDegreeMapMinor(edo: number): Record<string, number> {
  return getDegreeMap(edo); // same map; phraseToSteps picks the right keys
}

// ── Key interval shortcuts ─────────────────────────────────────────────
export function getEDOIntervals(edo: number) {
  const dm = getDegreeMap(edo);
  return {
    m2: dm["b2"], M2: dm["2"],
    m3: dm["b3"], M3: dm["3"],
    P4: dm["4"],  A4: dm["#4"], d5: dm["b5"],
    P5: dm["5"],
    m6: dm["b6"], M6: dm["6"],
    m7: dm["b7"], M7: dm["7"],
    A1: DIATONIC[edo]?.A1 ?? dm["#4"] - dm["4"],
    A2: dm["#2"],
  };
}

// ── Interval name lists ────────────────────────────────────────────────
const INTERVAL_NAMES_12 = [
  "Unison","Minor 2nd","Major 2nd","Minor 3rd","Major 3rd",
  "Perfect 4th","Tritone","Perfect 5th","Minor 6th","Major 6th",
  "Minor 7th","Major 7th","Octave",
];

const INTERVAL_NAMES_17 = [
  "Unison","Minor 2nd","Neutral 2nd","Major 2nd",
  "Minor 3rd","Neutral 3rd","Major 3rd","Perfect 4th",
  "dim 5th","Aug 4th","Perfect 5th",
  "Minor 6th","Neutral 6th","Major 6th",
  "Minor 7th","Neutral 7th","Major 7th","Octave",
];

const INTERVAL_NAMES_19 = [
  "Unison","Diesis","Minor 2nd","Major 2nd","Aug 2nd",
  "Minor 3rd","Major 3rd","Sub-4th","Perfect 4th",
  "Aug 4th","dim 5th","Perfect 5th","Aug 5th",
  "Minor 6th","Major 6th","Sub-7th","Minor 7th","Major 7th",
  "Chromatic","Octave",
];

const INTERVAL_NAMES_31 = [
  "Perfect Unison",
  "Super Unison / Uber Unison",
  "Subminor Second",
  "Minor Second",
  "Greater Neutral Second",
  "Major Second",
  "Supermajor Second",
  "Subminor Third",
  "Minor Third",
  "Greater Neutral Third",
  "Major Third",
  "Supermajor Third",
  "Sub Fourth",
  "Perfect Fourth",
  "Uber Fourth",
  "Augmented Fourth",
  "Diminished Fifth",
  "Unter Fifth",
  "Perfect Fifth",
  "Super Fifth",
  "Subminor Sixth",
  "Minor Sixth",
  "Greater Neutral Sixth",
  "Major Sixth",
  "Supermajor Sixth",
  "Subminor Seventh",
  "Minor Seventh",
  "Greater Neutral Seventh",
  "Major Seventh",
  "Supermajor Seventh",
  "Sub Octave / Unter Octave",
  "Perfect Octave",
];

const INTERVAL_NAMES_41 = [
  "Perfect Unison",                                          // 0
  "Comma-Wide Unison",                                       // 1
  "Subminor 2nd",                                            // 2
  "Minor 2nd",                                               // 3
  "Classic Minor 2nd",                                       // 4
  "Neutral 2nd",                                             // 5
  "Classic Major 2nd",                                       // 6
  "Major 2nd",                                               // 7
  "Supermajor 2nd",                                          // 8
  "Subminor 3rd",                                            // 9
  "Minor 3rd",                                               // 10
  "Classic Minor 3rd",                                       // 11
  "Neutral 3rd",                                             // 12
  "Classic Major 3rd",                                       // 13
  "Major 3rd",                                               // 14
  "Supermajor 3rd",                                          // 15
  "Sub 4th",                                                 // 16
  "Perfect 4th",                                             // 17
  "Comma-Wide 4th",                                          // 18
  "Neutral 4th",                                             // 19
  "Diminished 5th",                                          // 20
  "Augmented 4th",                                           // 21
  "Neutral 5th",                                             // 22
  "Comma-Narrow 5th",                                        // 23
  "Perfect 5th",                                             // 24
  "Super 5th",                                               // 25
  "Subminor 6th",                                            // 26
  "Minor 6th",                                               // 27
  "Classic Minor 6th",                                       // 28
  "Neutral 6th",                                             // 29
  "Classic Major 6th",                                       // 30
  "Major 6th",                                               // 31
  "Supermajor 6th",                                          // 32
  "Subminor 7th",                                            // 33
  "Minor 7th",                                               // 34
  "Classic Minor 7th",                                       // 35
  "Neutral 7th",                                             // 36
  "Classic Major 7th",                                       // 37
  "Major 7th",                                               // 38
  "Supermajor 7th",                                          // 39
  "Comma-Narrow 8ve",                                        // 40
  "Perfect 8ve",                                             // 41
];

// 53-EDO: name key JI approximations, fill rest with step labels
function build53Names(): string[] {
  const keyNames: Record<number, string> = {
    0:"Unison", 1:"1-comma", 2:"2-comma", 3:"Diesis", 4:"Small chroma",
    5:"Minor 2nd (16/15)", 6:"Large min 2nd", 7:"Neutral 2nd-", 8:"Neutral 2nd",
    9:"Major 2nd (9/8)", 10:"Large M2", 11:"Aug 2nd-", 12:"Aug 2nd",
    13:"Submin 3rd", 14:"Minor 3rd (6/5)", 15:"Large min 3rd", 16:"Neutral 3rd",
    17:"Major 3rd (5/4)", 18:"Large M3", 19:"Subperf 4th-", 20:"Subperf 4th",
    21:"Narrow 4th", 22:"Perfect 4th (4/3)", 23:"Wide 4th", 24:"Aug 4th-",
    25:"Aug 4th", 26:"Aug 4th+", 27:"dim 5th", 28:"Narrow 5th+",
    29:"Narrow 5th", 30:"Narrow 5th-",
    31:"Perfect 5th (3/2)", 32:"Wide 5th", 33:"Aug 5th-", 34:"Aug 5th",
    35:"Aug 5th+", 36:"Minor 6th (8/5)", 37:"Large min 6th", 38:"Neutral 6th",
    39:"Major 6th (5/3)", 40:"Large M6", 41:"Submin 7th-", 42:"Submin 7th",
    43:"Submin 7th+", 44:"Minor 7th (9/5)", 45:"Large min 7th", 46:"Neutral 7th-",
    47:"Neutral 7th", 48:"Major 7th (15/8)", 49:"Large M7",
    50:"Sub-octave+", 51:"Sub-octave", 52:"Near-octave", 53:"Octave",
  };
  const out: string[] = [];
  for (let i = 0; i <= 53; i++) out.push(keyNames[i] ?? `${i} steps`);
  return out;
}

const INTERVAL_NAMES_53 = build53Names();

export function getIntervalNames(edo: number): string[] {
  if (edo === 12) return INTERVAL_NAMES_12;
  if (edo === 17) return INTERVAL_NAMES_17;
  if (edo === 19) return INTERVAL_NAMES_19;
  if (edo === 41) return INTERVAL_NAMES_41;
  if (edo === 53) return INTERVAL_NAMES_53;
  return INTERVAL_NAMES_31;
}

// ── Solfege ────────────────────────────────────────────────────────────

const SOLFEGE_31 = [
  "Do","Di","Ro","Ra",
  "Ru","Re","Ri",
  "Ma","Me","Mu","Mi",
  "Mo","Fe","Fa","Fu",
  "Fi","Se","Su","Sol",
  "Si","Lo","Le","Lu",
  "La","Li","Ta","Te",
  "Tu","Ti","To",
  "Da","Do",
];

const SOLFEGE_41 = [
  "Do","Di","Ro","Rih",
  "Ra","Ru","Reh","Re",
  "Ri","Ma","Meh","Me",
  "Mu","Mi","Maa","Mo",
  "Fe","Fa","Fih","Fu",
  "Fi","Se","Su","Sih",
  "Sol","Si","Lo","Leh",
  "Le","Lu","La","Laa",
  "Li","Ta","Teh","Te",
  "Tu","Ti","Taa","To",
  "Da","Do",
];

export function getSolfege(edo: number): string[] | null {
  if (edo === 31) return SOLFEGE_31;
  if (edo === 41) return SOLFEGE_41;
  return null;
}

// ── Chord shapes ───────────────────────────────────────────────────────
// Returns: { MAJ, MIN, DIM, P5, M2, LT, m3, M3, m7, M7, P4, m6, M6, d5 }
export function getChordShapes(edo: number) {
  const iv = getEDOIntervals(edo);
  return {
    MAJ: [0, iv.M3, iv.P5],
    MIN: [0, iv.m3, iv.P5],
    DIM: [0, iv.m3, iv.d5],
    AUG: [0, iv.M3, iv.P5 + iv.A1],
    SUS2: [0, iv.M2, iv.P5],
    SUS4: [0, iv.P4, iv.P5],
    P5: iv.P5, M2: iv.M2, LT: iv.M7,
    m3: iv.m3, M3: iv.M3, m7: iv.m7, M7: iv.M7,
    P4: iv.P4, m6: iv.m6, M6: iv.M6, d5: iv.d5,
    A1: iv.A1,
  };
}

// ── Roman numeral base chords ─────────────────────────────────────────
export function getBaseChords(edo: number): [string, number[]][] {
  const { MAJ, MIN, DIM, M2, M3, m3, P4, P5, M6, m6, M7, m7 } = getChordShapes(edo);
  return [
    ["I",    MAJ.map(s => s)],
    ["ii",   MIN.map(s => s + M2)],
    ["iii",  MIN.map(s => s + M3)],
    ["IV",   MAJ.map(s => s + P4)],
    ["V",    MAJ.map(s => s + P5)],
    ["vi",   MIN.map(s => s + M6)],
    ["vii°", DIM.map(s => s + M7)],
    ["i",    MIN.map(s => s)],
    ["ii°",  DIM.map(s => s + M2)],
    ["III",  MAJ.map(s => s + m3)],
    ["iv",   MIN.map(s => s + P4)],
    ["v",    MIN.map(s => s + P5)],
    ["VI",   MAJ.map(s => s + m6)],
    ["VII",  MAJ.map(s => s + m7)],
    ["bIII", MAJ.map(s => s + m3)],
    ["bVI",  MAJ.map(s => s + m6)],
    ["bVII", MAJ.map(s => s + m7)],
  ];
}

// ── Chord drone types ─────────────────────────────────────────────────
export function getChordDroneTypes(edo: number): Record<string, number[]> {
  const iv = getEDOIntervals(edo);
  const { M3, m3, P4, P5, m7, M7, d5, A1 } = iv;
  const dim7 = m7 - A1; // diminished 7th
  return {
    "Major Triad":       [0, M3, P5],
    "Minor Triad":       [0, m3, P5],
    "Diminished Triad":  [0, m3, d5],
    "Augmented Triad":   [0, M3, P5 + A1],
    "Sus2 Triad":        [0, iv.M2, P5],
    "Sus4 Triad":        [0, P4, P5],
    "Major 7":           [0, M3, P5, M7],
    "Dominant 7":        [0, M3, P5, m7],
    "Minor 7":           [0, m3, P5, m7],
    "Minor Maj7":        [0, m3, P5, M7],
    "Half-Dim 7":        [0, m3, d5, m7],
    "Diminished 7":      [0, m3, d5, dim7],
    "Augmented Maj7":    [0, M3, P5 + A1, M7],
    "Dominant 7 Sus4":   [0, P4, P5, m7],
    // Microtonal types (only distinct when A1 >= 2)
    // Fifth-paired voicings listed first: 3rd and 7th are a P5 apart
    ...(A1 >= 2 ? (() => {
      const neut3 = Math.round((m3 + M3) / 2);
      const neut7 = neut3 + P5;            // P5 above neutral 3rd
      return {
        "Subminor Triad":    [0, m3 - 1, P5],
        "Supermajor Triad":  [0, M3 + 1, P5],
        "Neutral Triad":     [0, neut3, P5],
        "Subminor 7":        [0, m3 - 1, P5, m7 - 1],     // P5 between 3rd & 7th
        "Neutral 7":         [0, neut3, P5, neut7],         // P5 between 3rd & 7th
        "Supermajor 7":      [0, M3 + 1, P5, M7 + 1],     // P5 between 3rd & 7th
        "Harmonic 7":        [0, M3, P5, m7 - 1],
      };
    })() : {}),
  };
}

// ── EDO-specific chord type catalog ───────────────────────────────────
export interface EdoChordType {
  id: string;
  name: string;
  abbr: string;          // short label for UI
  steps: number[];       // intervals from root
  third: number;         // the 3rd interval in steps (for roman-numeral matching)
  category: "triad" | "seventh";
  thirdQuality?: string;   // e.g. "min3","maj3","neu3","sub3","sup3","sus2","sus4","dim3"
  seventhQuality?: string; // e.g. "harm7","min7","neu7","maj7" — only for seventh chords
  stable: number[];      // scale-degree offsets from root that are "stable" extensions
  avoid: number[];       // scale-degree offsets from root that are "avoid" notes
}

export function getEdoChordTypes(edo: number): EdoChordType[] {
  const iv = getEDOIntervals(edo);
  const { M2, m3, M3, P4, P5, m6, M6, m7, M7, d5, A1 } = iv;
  const dim7 = m7 - A1;
  const aug5 = P5 + A1;
  const types: EdoChordType[] = [];
  const seen = new Set<string>();

  const add = (t: Omit<EdoChordType, "stable" | "avoid"> & { stable?: number[]; avoid?: number[] }) => {
    const key = t.steps.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    types.push({ ...t, stable: t.stable ?? [], avoid: t.avoid ?? [] });
  };
  const T = (id: string, name: string, abbr: string, steps: number[], third: number) =>
    add({ id, name, abbr, steps, third, category: "triad" });
  const S = (id: string, name: string, abbr: string, steps: number[], third: number) =>
    add({ id, name, abbr, steps, third, category: "seventh" });

  // ── Standard types (from diatonic intervals) ──
  // For 41-EDO: diatonic m3=10 (inframinor) and M3=14 (ultramajor), NOT the
  // classic 6/5 and 5/4. So we skip standard triads/sevenths for 41 and let
  // the 41-EDO block provide everything with correct names and step values.
  if (edo !== 41) {
    T("maj",  "Major",          "Major",       [0, M3, P5], M3);
    T("min",  "Minor",          "Minor",       [0, m3, P5], m3);
    T("dim",  "Diminished",     "Diminished",  [0, m3, d5], m3);
    T("aug",  "Augmented",      "Augmented",   [0, M3, aug5], M3);
    T("sus2", "Suspended 2nd",  "Sus2",        [0, M2, P5], M2);
    T("sus4", "Suspended 4th",  "Sus4",        [0, P4, P5], P4);

    S("maj7",      "Major 7th",           "Maj7",    [0, M3, P5, M7], M3);
    S("dom7",      "Dominant 7th",        "Dom7",    [0, M3, P5, m7], M3);
    S("min7",      "Minor 7th",           "Min7",    [0, m3, P5, m7], m3);
    S("minmaj7",   "Minor-Major 7th",     "mMaj7",   [0, m3, P5, M7], m3);
    S("halfdim7",  "Half-Diminished 7th", "\u00F87", [0, m3, d5, m7], m3);
    S("dim7",      "Diminished 7th",      "\u00B07", [0, m3, d5, dim7], m3);
    S("augmaj7",   "Augmented Major 7th", "Maj7#5",  [0, M3, aug5, M7], M3);
    S("aug7",      "Augmented 7th",       "7#5",     [0, M3, aug5, m7], M3);
    S("dom7sus4",  "Dominant 7 Sus4",     "7sus4",   [0, P4, P5, m7], P4);
  }

  // ── 31-EDO ──
  // Thirds: 7=subminor 8=minor 9=neutral 10=major 11=supermajor
  // Fifths: 16=dim 18=P5 20=aug  |  Sevenths: 23=dim7 25=harm7 26=m7 27=neutral7 28=M7
  if (edo === 31) {
    // Triads
    T("submin",   "Subminor (7/6)",   "Subminor",   [0,7,18],  7);
    T("neutral",  "Neutral (11/9)",   "Neutral",    [0,9,18],  9);
    T("supermaj", "Supermajor (9/7)", "Supermajor", [0,11,18], 11);
    // Fifth-paired voicings first: 3rd + P5 = 7th (two interlocking fifths)
    // Subminor 7ths — 7+18=25, so Sub Harm7 is fifth-paired
    S("submin_h7", "Subminor Harm7", "Sub H7", [0,7,18,25], 7);
    S("submin_m7", "Subminor Min7",  "Sub m7", [0,7,18,26], 7);
    S("submin_M7", "Subminor Maj7",  "Sub M7", [0,7,18,28], 7);
    // Minor 7ths — 8+18=26, so Minor Min7 is fifth-paired (= standard min7)
    S("min_m7",    "Minor Min7",     "Min m7", [0,8,18,26], 8);
    S("min_h7",    "Minor Harm7",    "Min H7", [0,8,18,25], 8);
    // Neutral 7ths — 9+18=27, so Neutral Neutral7 is fifth-paired
    S("neu_n7",    "Neutral Neutral7","Neu N7", [0,9,18,27], 9);
    S("neu_h7",    "Neutral Harm7",  "Neu H7", [0,9,18,25], 9);
    S("neu_m7",    "Neutral Min7",   "Neu m7", [0,9,18,26], 9);
    S("neu_M7",    "Neutral Maj7",   "Neu M7", [0,9,18,28], 9);
    // Major 7ths — 10+18=28, so Major Maj7 is fifth-paired (= standard maj7)
    S("maj_M7",    "Major Maj7",     "Maj M7", [0,10,18,28], 10);
    S("harm7",     "Harmonic 7th",   "H7",     [0,10,18,25], 10);
    S("maj_n7",    "Major Neutral7", "Maj N7", [0,10,18,27], 10);
    // Supermajor 7ths — 11+18=29, so Supermajor Supermaj7 is fifth-paired
    S("sup_sup7",  "Supermajor Supermaj7","Sup SM7", [0,11,18,29], 11);
    S("sup_h7",    "Supermajor Harm7","Sup H7", [0,11,18,25], 11);
    S("sup_m7",    "Supermajor Min7", "Sup m7", [0,11,18,26], 11);
    S("sup_M7",    "Supermajor Maj7", "Sup M7", [0,11,18,28], 11);
  }

  // ── 41-EDO ──
  // Thirds: 9=subminor 10=minor 11=classic minor 12=neutral 13=classic major 14=major 15=supermajor
  // Fifths: 21=aug4/kw-dim5 22=unter5/cl-dim5 24=P5 26=submin6/cl-aug5 27=min6/kn-aug5
  // Sevenths: 30=cl.maj6 31=maj6 33=submin7 35=cl.min7 36=neutral7
  if (edo === 41) {
    // Triads — all 7 distinct P5 triads + dim/aug variants + sus
    T("submin",    "Subminor (7/6)",              "Subminor",       [0,9,24],  9);
    T("min",       "Minor (32/27)",               "Minor",          [0,10,24], 10);
    T("clmin",     "Classic Minor (6/5)",          "Classic Minor",   [0,11,24], 11);
    T("neutral",   "Neutral (11/9)",              "Neutral",         [0,12,24], 12);
    T("clmaj",     "Classic Major (5/4)",          "Classic Major",   [0,13,24], 13);
    T("maj",       "Major (81/64)",               "Major",          [0,14,24], 14);
    T("supermaj",  "Supermajor (9/7)",            "Supermajor",     [0,15,24], 15);
    T("dim_lo",    "Diminished (low)",            "Dim (low)",      [0,11,21], 11);
    T("dim_hi",    "Diminished (high)",           "Dim (high)",     [0,11,22], 11);
    T("aug_lo",    "Augmented (low)",             "Aug (low)",      [0,13,26], 13);
    T("aug_hi",    "Augmented (high)",            "Aug (high)",     [0,13,27], 13);
    T("sus2",      "Suspended 2nd",               "Sus2",           [0,7,24],  7);
    T("sus4",      "Suspended 4th",               "Sus4",           [0,17,24], 17);
    // Fifth-paired voicings first: 3rd + P5 = 7th (two interlocking fifths)
    // Subminor 7ths — 9+24=33, so Sub Submin7 is fifth-paired
    S("submin_sm7",    "Subminor Submin7",             "Sub sm7",      [0,9,24,33],  9);
    S("submin_maj6",   "Subminor Maj6",               "Sub Maj6",     [0,9,24,31],  9);
    S("submin_clm7",   "Subminor Classic Min7",        "Sub Classic m7", [0,9,24,35],  9);
    S("submin_n7",     "Subminor Neutral7",            "Sub N7",       [0,9,24,36],  9);
    // Minor 7ths — 10+24=34, so Minor Min7 (Pythagorean) is fifth-paired
    S("min_m7",        "Minor Min7",                   "Min m7",       [0,10,24,34], 10);
    S("min_maj6",      "Minor Maj6",                   "Min Maj6",     [0,10,24,31], 10);
    S("min_sm7",       "Minor Submin7",                "Min sm7",      [0,10,24,33], 10);
    S("min_clm7",      "Minor Classic Min7",           "Min Classic m7", [0,10,24,35], 10);
    S("min_n7",        "Minor Neutral7",               "Min N7",       [0,10,24,36], 10);
    // Classic Minor 7ths — 11+24=35, so Classic Min Classic Min7 is fifth-paired
    S("clmin_clm7",    "Classic Minor Classic Min7",    "Classic Min Classic m7",[0,11,24,35], 11);
    S("clmin_maj6",    "Classic Minor Maj6",            "Classic Min Maj6",      [0,11,24,31], 11);
    S("clmin_sm7",     "Classic Minor Submin7",         "Classic Min sm7",       [0,11,24,33], 11);
    S("clmin_n7",      "Classic Minor Neutral7",        "Classic Min N7",        [0,11,24,36], 11);
    // Neutral 7ths — 12+24=36, so Neutral Neutral7 is fifth-paired
    S("neu_n7",        "Neutral Neutral7",             "Neu N7",       [0,12,24,36], 12);
    S("neu_maj6",      "Neutral Maj6",                 "Neu Maj6",     [0,12,24,31], 12);
    S("neu_sm7",       "Neutral Submin7",              "Neu sm7",      [0,12,24,33], 12);
    S("neu_clm7",      "Neutral Classic Min7",         "Neu Classic m7", [0,12,24,35], 12);
    // Classic Major 7ths — 13+24=37, so Classic Maj Classic Maj7 is fifth-paired
    S("clmaj_clM7",    "Classic Major Classic Maj7",    "Classic Maj Classic M7",[0,13,24,37], 13);
    S("clmaj_maj6",    "Classic Major Maj6",            "Classic Maj Maj6",      [0,13,24,31], 13);
    S("clmaj_sm7",     "Classic Major Submin7",         "Classic Maj sm7",       [0,13,24,33], 13);
    S("clmaj_clm7",    "Classic Major Classic Min7",    "Classic Maj Classic m7",[0,13,24,35], 13);
    S("clmaj_n7",      "Classic Major Neutral7",        "Classic Maj N7",        [0,13,24,36], 13);
    // Major 7ths — 14+24=38, so Major Maj7 is fifth-paired
    S("maj_M7",        "Major Maj7",                   "Maj M7",       [0,14,24,38], 14);
    S("maj_maj6",      "Major Maj6",                   "Maj Maj6",     [0,14,24,31], 14);
    S("maj_sm7",       "Major Submin7",                "Maj sm7",      [0,14,24,33], 14);
    S("maj_clm7",      "Major Classic Min7",           "Maj Classic m7", [0,14,24,35], 14);
    S("maj_n7",        "Major Neutral7",               "Maj N7",       [0,14,24,36], 14);
    // Supermajor 7ths — 15+24=39, so Supermajor Supermaj7 is fifth-paired
    S("sup_sup7",      "Supermajor Supermaj7",         "Sup SM7",      [0,15,24,39], 15);
    S("sup_maj6",      "Supermajor Maj6",              "Sup Maj6",     [0,15,24,31], 15);
    S("sup_sm7",       "Supermajor Submin7",           "Sup sm7",      [0,15,24,33], 15);
    S("sup_clm7",      "Supermajor Classic Min7",      "Sup Classic m7", [0,15,24,35], 15);
    S("sup_n7",        "Supermajor Neutral7",          "Sup N7",       [0,15,24,36], 15);
    // Diminished 7ths
    S("halfdim_lo",    "Half-Dim (low)",               "\u00F87\u2193", [0,11,21,33], 11);
    S("halfdim_hi",    "Half-Dim (high)",              "\u00F87\u2191", [0,11,22,33], 11);
    S("dim7_lo",       "Dim7 (low)",                   "\u00B07\u2193", [0,11,21,30], 11);
    S("dim7_hi",       "Dim7 (high)",                  "\u00B07\u2191", [0,11,22,30], 11);
    // Augmented 7ths
    S("aug7_lo",       "Aug Submin7 (low)",            "Aug sm7\u2193",  [0,13,26,33], 13);
    S("augN7_lo",      "Aug Neutral7 (low)",           "Aug N7\u2193",   [0,13,26,36], 13);
    S("aug7_hi",       "Aug Submin7 (high)",           "Aug sm7\u2191",  [0,13,27,33], 13);
    S("augN7_hi",      "Aug Neutral7 (high)",          "Aug N7\u2191",   [0,13,27,36], 13);
    // Sus4 seventh
    S("dom7sus4",      "Suspended 4th Submin7",        "Sus4 sm7",      [0,17,24,33], 17);
  }

  // ── Generic microtonal fallback for other EDOs with A1 >= 2 ──
  if (A1 >= 2 && edo !== 31 && edo !== 41) {
    const subm3 = m3 - A1;
    const supm3 = M3 + A1;
    const neut3 = Math.round((m3 + M3) / 2);
    const harm7 = Math.round(1200 * Math.log2(7 / 4) / (1200 / edo));

    if (subm3 > 0) T("submin", "Subminor (7/6)", "Sub", [0, subm3, P5], subm3);
    if (neut3 !== m3 && neut3 !== M3) T("neutral", "Neutral (11/9)", "Neu", [0, neut3, P5], neut3);
    if (supm3 < P5) T("supermaj", "Supermajor (9/7)", "Sup", [0, supm3, P5], supm3);

    // Fifth-paired voicings first: 3rd + P5 = 7th (two interlocking fifths)
    if (subm3 > 0) {
      const sub7 = subm3 + P5;  // P5 above subminor 3rd
      S("submin_fp", "Subminor 7 (fifth-paired)", "Sub 7", [0, subm3, P5, sub7], subm3);
      if (sub7 !== m7) S("submin_m7", "Subminor Min7", "Sub m7", [0, subm3, P5, m7], subm3);
      if (sub7 !== M7) S("submin_M7", "Subminor Maj7", "Sub M7", [0, subm3, P5, M7], subm3);
    }
    if (neut3 !== m3 && neut3 !== M3) {
      const neut7 = neut3 + P5;  // P5 above neutral 3rd
      S("neu_fp", "Neutral 7 (fifth-paired)", "Neu 7", [0, neut3, P5, neut7], neut3);
    }
    if (supm3 < P5) {
      const sup7 = supm3 + P5;  // P5 above supermajor 3rd
      S("sup_fp", "Supermajor 7 (fifth-paired)", "Sup 7", [0, supm3, P5, sup7], supm3);
      if (sup7 !== m7) S("sup_m7", "Supermajor Min7", "Sup m7", [0, supm3, P5, m7], supm3);
      if (sup7 !== M7) S("sup_M7", "Supermajor Maj7", "Sup M7", [0, supm3, P5, M7], supm3);
    }
    if (harm7 > 0 && harm7 !== m7 && harm7 !== M7) {
      S("harm7", "Harmonic 7th (7/4)", "H7", [0, M3, P5, harm7], M3);
    }
  }

  // ── Compute thirdQuality and seventhQuality ──
  for (const t of types) {
    t.thirdQuality = computeThirdQuality(t.third, edo);
    if (t.category === "seventh" && t.steps.length >= 4) {
      t.seventhQuality = computeSeventhQuality(t.steps[3], edo);
    }
  }

  return types;
}

/** Derive a third-quality id from the absolute step of the 3rd interval. */
function computeThirdQuality(step: number, edo: number): string {
  const iv = getEDOIntervals(edo);
  const { m3, M3, M2, P4, A1 } = iv;

  // Sus voicings
  if (step === M2) return "sus2";
  if (step === P4) return "sus4";

  // EDO-specific mappings
  if (edo === 31) {
    if (step === 7) return "sub3";   // subminor (7/6)
    if (step === 8) return "min3";
    if (step === 9) return "neu3";   // neutral (11/9)
    if (step === 10) return "maj3";
    if (step === 11) return "sup3";  // supermajor (9/7)
  }
  if (edo === 41) {
    if (step === 9) return "sub3";   // subminor
    if (step === 10) return "min3";  // minor (32/27)
    if (step === 11) return "clmin3"; // classic minor (6/5)
    if (step === 12) return "neu3";  // neutral (11/9)
    if (step === 13) return "clmaj3"; // classic major (5/4)
    if (step === 14) return "maj3";  // major (81/64)
    if (step === 15) return "sup3";  // supermajor (9/7)
    if (step === 7) return "sus2";
    if (step === 17) return "sus4";
  }
  // Generic fallback
  if (step === m3) return "min3";
  if (step === M3) return "maj3";
  if (step < m3) return "sub3";
  if (step === m3 + A1 || (step > m3 && step < M3)) return "neu3";
  if (step > M3) return "sup3";
  return "min3";
}

/** Derive a seventh-quality id from the absolute step of the 7th interval. */
function computeSeventhQuality(step: number, edo: number): string {
  const iv = getEDOIntervals(edo);
  const { m7, M7, A1 } = iv;
  const dim7 = m7 - A1;

  // EDO-specific mappings for microtonal sevenths
  if (edo === 31) {
    if (step === 25) return "harm7";   // 7/4
    if (step === 26) return "min7";
    if (step === 27) return "neu7";
    if (step === 28) return "maj7";
    if (step === 29) return "sup7";
  }
  if (edo === 41) {
    if (step === 30) return "clmaj6";  // classic major 6th / dim-ish 7th
    if (step === 31) return "maj6";
    if (step === 33) return "sm7";     // subminor 7th
    if (step === 34) return "min7";    // Pythagorean minor 7th
    if (step === 35) return "clmin7";  // classic minor 7th (5-limit)
    if (step === 36) return "neu7";
    if (step === 37) return "clmaj7";  // classic major 7th
    if (step === 38) return "maj7";
    if (step === 39) return "sup7";
  }
  // Generic fallback
  if (step === dim7) return "dim7";
  if (step === m7) return "min7";
  if (step === M7) return "maj7";
  // Approximate: anything between dim7 and m7 is harm7-ish, etc.
  if (step < m7) return "harm7";
  if (step < M7) return "neu7";
  return "sup7";
}

/** Metadata for quality UI buttons. */
export interface QualityInfo {
  id: string;
  label: string;
  desc: string;
}

/** Get available third qualities for a given EDO, in order from low to high. */
export function getAvailableThirdQualities(edo: number): QualityInfo[] {
  const types = getEdoChordTypes(edo);
  const seen = new Set<string>();
  const order: string[] = [];
  const sorted = [...types].sort((a, b) => a.third - b.third);
  for (const t of sorted) {
    if (t.thirdQuality && !seen.has(t.thirdQuality)) {
      seen.add(t.thirdQuality);
      order.push(t.thirdQuality);
    }
  }
  return order.map(id => ({ id, label: THIRD_QUALITY_LABELS[id] ?? id, desc: THIRD_QUALITY_DESCS[id] ?? "" }));
}

const THIRD_QUALITY_LABELS: Record<string, string> = {
  sus2: "Sus2",
  sub3: "Subminor",
  min3: "Minor",
  clmin3: "Cl. Minor",
  neu3: "Neutral",
  clmaj3: "Cl. Major",
  maj3: "Major",
  sup3: "Supermajor",
  sus4: "Sus4",
};

const THIRD_QUALITY_DESCS: Record<string, string> = {
  sus2: "Suspended 2nd",
  sub3: "Subminor 3rd (7/6)",
  min3: "Minor 3rd",
  clmin3: "Classic minor 3rd (6/5)",
  neu3: "Neutral 3rd (11/9)",
  clmaj3: "Classic major 3rd (5/4)",
  maj3: "Major 3rd",
  sup3: "Supermajor 3rd (9/7)",
  sus4: "Suspended 4th",
};

/** Get available seventh qualities for a given EDO, in order from low to high. */
export function getAvailableSeventhQualities(edo: number): QualityInfo[] {
  const types = getEdoChordTypes(edo);
  const seen = new Set<string>();
  const order: string[] = [];
  // Collect unique seventhQuality values in step-ascending order
  const sorted = types
    .filter(t => t.seventhQuality)
    .sort((a, b) => a.steps[3] - b.steps[3]);
  for (const t of sorted) {
    if (!seen.has(t.seventhQuality!)) {
      seen.add(t.seventhQuality!);
      order.push(t.seventhQuality!);
    }
  }
  return order.map(id => ({ id, label: SEVENTH_QUALITY_LABELS[id] ?? id, desc: SEVENTH_QUALITY_DESCS[id] ?? "" }));
}

const SEVENTH_QUALITY_LABELS: Record<string, string> = {
  dim7: "Dim7",
  clmaj6: "Cl. Maj6",
  maj6: "Maj6",
  harm7: "Harm7",
  sm7: "Submin7",
  min7: "Min7",
  clmin7: "Cl. Min7",
  neu7: "Neutral7",
  clmaj7: "Cl. Maj7",
  maj7: "Maj7",
  sup7: "Super7",
};

const SEVENTH_QUALITY_DESCS: Record<string, string> = {
  dim7: "Diminished 7th",
  clmaj6: "Classic major 6th (≈ dim 7th)",
  maj6: "Major 6th",
  harm7: "Harmonic 7th (7/4)",
  sm7: "Subminor 7th",
  min7: "Minor 7th",
  clmin7: "Classic minor 7th (5-limit)",
  neu7: "Neutral 7th (11/6)",
  clmaj7: "Classic major 7th (15/8)",
  maj7: "Major 7th",
  sup7: "Supermajor 7th",
};

/** Derive a fifth-quality id from the absolute step of the 5th interval. */
export function computeFifthQuality(step: number, edo: number): string {
  const { P5, A1 } = getEDOIntervals(edo);
  const dim5 = P5 - A1;
  const aug5 = P5 + A1;
  if (step === P5)   return "P5";
  if (step === dim5) return "dim5";
  if (step === aug5) return "aug5";
  if (step > dim5 && step < P5) return "unter5";
  if (step > P5 && step < aug5) return "super5";
  if (step < dim5) return "dim5_lo";
  return "aug5_hi";
}

const FIFTH_QUALITY_LABELS: Record<string, string> = {
  dim5_lo: "Dim↓",
  dim5:    "Dim",
  unter5:  "Unter",
  P5:      "Perfect",
  super5:  "Super",
  aug5:    "Aug",
  aug5_hi: "Aug↑",
};

const FIFTH_QUALITY_DESCS: Record<string, string> = {
  dim5_lo: "Very flat 5th (below standard dim5)",
  dim5:    "Diminished 5th",
  unter5:  "Unter 5th (between dim and perfect)",
  P5:      "Perfect 5th",
  super5:  "Super 5th (between perfect and aug)",
  aug5:    "Augmented 5th",
  aug5_hi: "Very sharp 5th (above standard aug5)",
};

/** Get available fifth qualities for a given EDO, in order from low to high. */
export function getAvailableFifthQualities(edo: number): QualityInfo[] {
  const types = getEdoChordTypes(edo);
  const seen = new Set<string>();
  const order: { id: string; step: number }[] = [];
  for (const t of types) {
    if (t.steps.length < 3) continue;
    const step = t.steps[2];
    const id = computeFifthQuality(step, edo);
    if (seen.has(id)) continue;
    seen.add(id);
    order.push({ id, step });
  }
  order.sort((a, b) => a.step - b.step);
  return order.map(({ id }) => ({ id, label: FIFTH_QUALITY_LABELS[id] ?? id, desc: FIFTH_QUALITY_DESCS[id] ?? "" }));
}

// ── Extension label → steps ───────────────────────────────────────────
export function getExtLabelToSteps(edo: number): Record<string, number[]> {
  const dm = getDegreeMap(edo);
  const ed = edo;
  return {
    "2nd":  [dm["2"]],
    "4th":  [dm["4"]],
    "6th":  [dm["6"]],
    "7th":  [dm["b7"], dm["7"]],
    "9th":  [ed + dm["2"]],
    "11th": [ed + dm["4"]],
    "13th": [ed + dm["6"]],
    "b9":   [ed + dm["b2"]],
    "#9":   [ed + dm["b3"]],
    "#11":  [ed + dm["#4"]],
    "b13":  [ed + dm["b6"]],
  };
}

// ── Shell voicing ranges ──────────────────────────────────────────────
// Returns [thirdsMin, thirdsMax, seventhsMin, seventhsMax]
export function getShellRanges(edo: number): [number, number, number, number] {
  const dm = getDegreeMap(edo);
  return [dm["2"], dm["4"], dm["6"], dm["7"]];
  // thirds zone: M2 → P4 (catches m3, M3 and neighbours)
  // sevenths zone: M6 → M7 (catches m7, M7)
}

// ── Scale/mode maps ───────────────────────────────────────────────────
// Returns PATTERN_SCALE_MAPS equivalent for any EDO.

type ModeMap = Record<string, number>;
type ScaleFamilyMap = Record<string, ModeMap>;

// Build diatonic modes from a step pattern (7 rotations of Ionian).
function buildDiatonicModes(
  pattern: number[],
  modeNames: string[],
  degreeNames: string[][]
): ScaleFamilyMap {
  const result: ScaleFamilyMap = {};
  for (let i = 0; i < 7; i++) {
    const rot = [...pattern.slice(i), ...pattern.slice(0, i)];
    const cumsum = [0];
    for (const step of rot.slice(0, 6)) cumsum.push(cumsum[cumsum.length - 1] + step);
    const map: ModeMap = {};
    for (let j = 0; j < 7; j++) map[degreeNames[i][j]] = cumsum[j];
    result[modeNames[i]] = map;
  }
  return result;
}

const DIATONIC_MODE_NAMES = ["Ionian","Dorian","Phrygian","Lydian","Mixolydian","Aeolian","Locrian"];
const DIATONIC_DEGREE_NAMES = [
  ["1","2","3","4","5","6","7"],
  ["1","2","b3","4","5","6","b7"],
  ["1","b2","b3","4","5","b6","b7"],
  ["1","2","3","#4","5","6","7"],
  ["1","2","3","4","5","6","b7"],
  ["1","2","b3","4","5","b6","b7"],
  ["1","b2","b3","4","b5","b6","b7"],
];

const HARM_MODE_NAMES = [
  "Harmonic Minor","Locrian #6","Ionian #5","Dorian #4",
  "Phrygian Dominant","Lydian #2","Ultralocrian"
];
const HARM_DEGREE_NAMES = [
  ["1","2","b3","4","5","b6","7"],
  ["1","b2","b3","4","b5","6","b7"],
  ["1","2","3","4","#5","6","7"],
  ["1","2","b3","#4","5","6","b7"],
  ["1","b2","3","4","5","b6","b7"],
  ["1","#2","3","#4","5","6","7"],
  ["1","b2","b3","3","b5","b6","6"],
];

const MEL_MODE_NAMES = [
  "Melodic Minor","Dorian b2","Lydian Augmented","Lydian Dominant",
  "Mixolydian b6","Locrian #2","Altered"
];
const MEL_DEGREE_NAMES = [
  ["1","2","b3","4","5","6","7"],
  ["1","b2","b3","4","5","6","b7"],
  ["1","2","3","#4","#5","6","7"],
  ["1","2","3","#4","5","6","b7"],
  ["1","2","3","4","5","b6","b7"],
  ["1","2","b3","4","b5","b6","b7"],
  ["1","b2","#2","3","b5","#5","b7"],
];

function getPatternMaps(edo: number): Record<string, ScaleFamilyMap> {
  const p = DIATONIC[edo] ?? DIATONIC[31];
  const T = p.T, s = p.s, A1 = p.A1;
  const A2 = T + A1; // augmented second interval

  let ionianPat: number[], harmPat: number[], melPat: number[];

  if (edo === 53) {
    // 5-limit Ionian: [0,9,17,22,31,39,48], pattern [9,8,5,9,8,9,5]
    ionianPat = [9, 8, 5, 9, 8, 9, 5];
    // Harmonic minor: [0,9,14,22,31,36,48], pattern [9,5,8,9,5,12,5]
    harmPat = [9, 5, 8, 9, 5, 12, 5];
    // Melodic minor: [0,9,14,22,31,39,48], pattern [9,5,8,9,8,9,5]
    melPat = [9, 5, 8, 9, 8, 9, 5];
  } else {
    ionianPat = [T, T, s, T, T, T, s];
    harmPat   = [T, s, T, T, s, A2, s];
    melPat    = [T, s, T, T, T, T, s];
  }

  return {
    "Major Family":         buildDiatonicModes(ionianPat, DIATONIC_MODE_NAMES, DIATONIC_DEGREE_NAMES),
    "Harmonic Minor Family":buildDiatonicModes(harmPat,   HARM_MODE_NAMES,     HARM_DEGREE_NAMES),
    "Melodic Minor Family": buildDiatonicModes(melPat,    MEL_MODE_NAMES,      MEL_DEGREE_NAMES),
  };
}

// Cache the results so we don't recalculate every render
const _patternMapsCache: Record<number, Record<string, ScaleFamilyMap>> = {};

export function getPatternScaleMaps(edo: number): Record<string, ScaleFamilyMap> {
  if (!_patternMapsCache[edo]) _patternMapsCache[edo] = getPatternMaps(edo);
  return _patternMapsCache[edo];
}

export function getModeDegreeMap(edo: number, scaleFam: string, modeName: string): ModeMap {
  const maps = getPatternScaleMaps(edo);
  return maps[scaleFam]?.[modeName] ?? getDegreeMap(edo);
}

// ── Pitch class → note name (0 = C, with enharmonic spelling) ────────
const DEGREE_TO_LETTER: Record<string, string> = {
  "1": "C", "2": "D", "3": "E", "4": "F", "5": "G", "6": "A", "7": "B",
};

/**
 * Replace double-sharps/double-flats with half-sharp (𝄲) / half-flat (𝄳) glyphs.
 * Why: in 31-EDO displays, "##"/"bb" (and their 𝄪/𝄫 forms) read as visual clutter;
 * the half accidentals compress to a single glyph. Applied at display sites only —
 * parsing code still sees the raw ASCII form.
 */
export function formatHalfAccidentals(s: string): string {
  return s
    .replace(/##/g, "𝄲")
    .replace(/bb/g, "𝄳")
    .replace(/𝄪/g, "𝄲")
    .replace(/𝄫/g, "𝄳");
}

const _pcNoteNamesCache: Record<number, string[]> = {};

/**
 * Convert a pitch class to a note name where pc 0 = C.
 * Uses getFullDegreeNames() to derive the letter + accidentals for any EDO.
 * Accidentals: # → ♯, b → ♭, ## → 𝄪, bb → 𝄫 (single chars for double).
 */
export function pcToNoteName(pc: number, edo: number): string {
  if (!_pcNoteNamesCache[edo]) {
    const degNames = getFullDegreeNames(edo);
    _pcNoteNamesCache[edo] = degNames.map(dn => {
      // Extract accidentals and degree number
      const match = dn.match(/^([#b]*)(\d+)$/);
      if (!match) return dn; // fallback for unparseable
      const [, acc, degNum] = match;
      const letter = DEGREE_TO_LETTER[degNum];
      if (!letter) return dn;

      // Convert accidentals to Unicode symbols
      let sym = "";
      let i = 0;
      while (i < acc.length) {
        if (acc[i] === "#" && acc[i + 1] === "#") { sym += "𝄪"; i += 2; }
        else if (acc[i] === "b" && acc[i + 1] === "b") { sym += "𝄫"; i += 2; }
        else if (acc[i] === "#") { sym += "♯"; i++; }
        else if (acc[i] === "b") { sym += "♭"; i++; }
        else { sym += acc[i]; i++; }
      }
      return letter + sym;
    });
  }
  const names = _pcNoteNamesCache[edo];
  return names[((pc % edo) + edo) % edo] ?? `${pc}`;
}

/** All note names for an EDO (0 = C), for use in selectors */
export function getAllNoteNames(edo: number): string[] {
  // Ensure cache is populated
  pcToNoteName(0, edo);
  return _pcNoteNamesCache[edo];
}

const _enharmonicCache: Record<number, string[]> = {};

/**
 * Note name with enharmonic alternatives shown, e.g. "G♭ / F♯".
 * A spelling is kept as an alternative only when its resulting key signature
 * is within 6 accidentals as EITHER a major or a minor tonic — e.g. C♯
 * survives because C♯ minor is only 4 sharps, even though C♯ major is 7.
 * The primary (fewest-accidental) name is always shown.
 */
const MAX_KEY_SIG_ACC = 6;

// Position on the circle of fifths relative to C (C=0, G=+1, F=−1, …).
// Major key accidental count = |fifthOffset|;
// natural-minor key accidental count = |fifthOffset − 3|.
const DEGREE_FIFTH_OFFSET: Record<string, number> = {
  "1": 0, "2": 2, "3": 4, "4": -1, "5": 1, "6": 3, "7": 5,
};

function fifthOffset(degNum: string, acc: string): number {
  const base = DEGREE_FIFTH_OFFSET[degNum] ?? 0;
  let delta = 0;
  for (const ch of acc) {
    if (ch === "#") delta += 1;
    else if (ch === "b") delta -= 1;
  }
  return base + 7 * delta;
}

function keySigWithinLimit(degNum: string, acc: string, limit = MAX_KEY_SIG_ACC): boolean {
  const f = fifthOffset(degNum, acc);
  return Math.abs(f) <= limit || Math.abs(f - 3) <= limit;
}

export function pcToNoteNameWithEnharmonic(pc: number, edo: number): string {
  if (!_enharmonicCache[edo]) {
    const p = DIATONIC[edo] ?? DIATONIC[31];
    const { T, s, A1 } = p;
    const naturals: [string, number][] = [
      ["1", 0], ["2", T], ["3", 2 * T],
      ["4", 2 * T + s], ["5", 3 * T + s],
      ["6", 4 * T + s], ["7", 5 * T + s],
    ];

    const toSymbol = (acc: string, degNum: string) => {
      const letter = DEGREE_TO_LETTER[degNum];
      if (!letter) return null;
      let sym = "";
      let i = 0;
      while (i < acc.length) {
        if (acc[i] === "#" && acc[i + 1] === "#") { sym += "𝄪"; i += 2; }
        else if (acc[i] === "b" && acc[i + 1] === "b") { sym += "𝄫"; i += 2; }
        else if (acc[i] === "#") { sym += "♯"; i++; }
        else if (acc[i] === "b") { sym += "♭"; i++; }
        else { sym += acc[i]; i++; }
      }
      return letter + sym;
    };

    const primary = getAllNoteNames(edo);
    const result: string[] = new Array(edo);

    // Upper bound on accidentals to search: 6 is enough for any
    // key-signature-viable spelling, but search deeper to ensure we find
    // at least one name per step even when the primary itself is many
    // accidentals away from any natural.
    const MAX_SEARCH_ACC = 12;

    for (let step = 0; step < edo; step++) {
      type Cand = { name: string; acc: number; keep: boolean };
      const cands: Cand[] = [];
      for (const [deg, pos] of naturals) {
        if (pos === step) {
          const n = toSymbol("", deg);
          if (n) cands.push({ name: n, acc: 0, keep: true });
        }
        for (let k = 1; k <= MAX_SEARCH_ACC; k++) {
          const sharpAcc = "#".repeat(k);
          const flatAcc = "b".repeat(k);
          const sharpStep = ((pos + k * A1) % edo + edo) % edo;
          if (sharpStep === step) {
            const n = toSymbol(sharpAcc, deg);
            if (n) cands.push({ name: n, acc: k, keep: keySigWithinLimit(deg, sharpAcc) });
          }
          const flatStep = ((pos - k * A1) % edo + edo) % edo;
          if (flatStep === step) {
            const n = toSymbol(flatAcc, deg);
            if (n) cands.push({ name: n, acc: k, keep: keySigWithinLimit(deg, flatAcc) });
          }
        }
      }
      cands.sort((a, b) => a.acc - b.acc);
      const seen = new Set<string>();
      const unique: Cand[] = [];
      for (const c of cands) {
        if (!seen.has(c.name)) { seen.add(c.name); unique.push(c); }
      }
      const primaryName = primary[step];
      const pIdx = unique.findIndex(c => c.name === primaryName);
      let ordered: Cand[];
      if (pIdx > 0) {
        ordered = [unique[pIdx], ...unique.slice(0, pIdx), ...unique.slice(pIdx + 1)];
      } else if (pIdx < 0) {
        ordered = [{ name: primaryName, acc: 0, keep: true }, ...unique];
      } else {
        ordered = unique;
      }
      // Always keep the primary; filter alts by key-signature viability.
      const names = ordered.filter((c, i) => i === 0 || c.keep).map(c => c.name);
      result[step] = names.length > 1 ? names.join(" / ") : names[0];
    }
    _enharmonicCache[edo] = result;
  }
  const names = _enharmonicCache[edo];
  return names[((pc % edo) + edo) % edo] ?? `${pc}`;
}

// ── Layout JSON file for each EDO ────────────────────────────────────
export function getLayoutFile(edo: number): string {
  const base = import.meta.env.BASE_URL ?? "/";
  return `${base}lumatone_layout_${edo}edo.json`;
}

// ── Supported EDO list ────────────────────────────────────────────────
export const SUPPORTED_EDOS = [12, 17, 19, 31, 41, 53];
