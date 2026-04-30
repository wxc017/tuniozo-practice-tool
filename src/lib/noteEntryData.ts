// ── Types ──────────────────────────────────────────────────────────────────────

export type ClefType = "treble" | "bass";
export type Duration = "w" | "h" | "q" | "8" | "16" | "32";
export type AccidentalType = "n" | "b" | "#";

/** Notehead glyph variants supported by VexFlow.  Used in drum mode
 *  to distinguish drums (default round head), cymbals (X), bells /
 *  cross-sticks (circle-X), rim shots (diamond), etc.  Harmonic mode
 *  ignores this field. */
export type NoteheadType = "default" | "x" | "circle-x" | "diamond" | "triangle";

/** VexFlow key suffix for a notehead.  Append directly to the pitch
 *  string (e.g. `"c/5" + NOTEHEAD_SUFFIX.x`  →  `"c/5/x2"`). */
export const NOTEHEAD_SUFFIX: Record<NoteheadType, string> = {
  "default":  "",
  "x":        "/x2",
  "circle-x": "/x3",
  "diamond":  "/d0",
  "triangle": "/t1",
};

export const NOTEHEAD_LABELS: Record<NoteheadType, string> = {
  "default":  "Drum",
  "x":        "X (Cymbal)",
  "circle-x": "Ø (Bell / Cross-stick)",
  "diamond":  "◇ (Rim-shot)",
  "triangle": "△ (Variant)",
};

export const NOTEHEAD_ORDER: NoteheadType[] = ["default", "x", "circle-x", "diamond", "triangle"];

// ── Drum-mode articulations & stickings ─────────────────────────────
// Mirrors the semantics of `accentData.ts` (used by AccentStudy /
// VexDrumNotation) so the rendering style is consistent across the
// app: accent = ">"  ghost = parens  flam = 1 grace note  drag = 2.
export type DrumArticulation = "normal" | "accent" | "ghost" | "flam" | "drag";

export const DRUM_ARTIC_LABELS: Record<DrumArticulation, string> = {
  normal: "Normal",
  accent: "Accent (>)",
  ghost:  "Ghost ( )",
  flam:   "Flam",
  drag:   "Drag",
};

export const DRUM_ARTIC_ORDER: DrumArticulation[] = ["normal", "accent", "ghost", "flam", "drag"];

/** Stick assignment shown above a note (R = right, L = left).  Same
 *  letter convention as `accentData.Sticking` derivations. */
export type DrumStick = "R" | "L";

export const DURATION_SLOTS: Record<Duration, number> = {
  w: 32, h: 16, q: 8, "8": 4, "16": 2, "32": 1,
};

export const DURATION_ORDER: Duration[] = ["w", "h", "q", "8", "16", "32"];

export const VF_DURATION_MAP: Record<Duration, string> = {
  w: "w", h: "h", q: "q", "8": "8", "16": "16", "32": "32",
};

export const DURATION_LABELS: Record<Duration, string> = {
  w: "𝅝", h: "𝅗𝅥", q: "𝅘𝅥", "8": "𝅘𝅥𝅮", "16": "𝅘𝅥𝅯", "32": "𝅘𝅥𝅰",
};

export const DURATION_NAMES: Record<Duration, string> = {
  w: "Whole", h: "Half", q: "Quarter", "8": "8th", "16": "16th", "32": "32nd",
};

export interface NoteData {
  id: string;
  measure: number;
  startSlot: number;
  duration: Duration;
  dotted?: boolean;
  pitch: string;
  accidental?: AccidentalType;
  isTieStart?: boolean;
  isTieEnd?: boolean;
  bendSteps?: number;
  isRest: boolean;
  /** Optional notehead glyph (drum mode).  Falls back to "default"
   *  when absent — harmonic mode never sets this so its rendering is
   *  unchanged. */
  notehead?: NoteheadType;
  /** Drum-mode articulation: accent / ghost / flam / drag.  Absent or
   *  "normal" → no extra modifier.  Harmonic mode ignores this. */
  articulation?: DrumArticulation;
  /** Drum-mode stick assignment ("R" / "L") shown above the note. */
  stick?: DrumStick;
  /** Drum-mode tuplet number (3 = triplet, 5 = quintuplet, 6 = sextuplet,
   *  7 = septuplet).  Consecutive notes sharing the same tuplet value
   *  get wrapped in a single VexFlow Tuplet bracket at render time. */
  tuplet?: 3 | 5 | 6 | 7;
}

/** Actual slot count occupied by a note, accounting for the dot (1.5×). */
export function noteSlots(n: Pick<NoteData, "duration" | "dotted">): number {
  const base = DURATION_SLOTS[n.duration];
  return n.dotted ? base * 1.5 : base;
}

export interface MeasureTimeSig {
  num: number;
  den: number;
}

export interface ScoreSetup {
  clef: ClefType;
  keySignature: number;
  defaultTimeSig: MeasureTimeSig;
  barCount: number;
  perBarTimeSig?: Record<number, MeasureTimeSig>;
  /** Per-bar Volta label ("A", "B", "C", "1.", "2.", etc.).  Drum
   *  mode renders this as a 1st/2nd/3rd-ending bracket above the
   *  bar.  Multi-bar voltas are inferred by adjacent bars sharing
   *  the same label. */
  perBarVolta?: Record<number, string>;
}

export interface SyncPoint {
  measure: number;
  timestamp: number;
}

export type Instrument = "harmonic" | "drum";

export interface NoteEntryProject {
  id: string;
  title: string;
  setup: ScoreSetup;
  notes: NoteData[];
  syncPoints: SyncPoint[];
  youtubeUrl: string;
  createdAt: number;
  /** Instrument family — picked at score creation.  Legacy projects
   *  without this field are treated as "harmonic". */
  instrument?: Instrument;
}

// ── Utilities ──────────────────────────────────────────────────────────────────

export function measureSlots(ts: MeasureTimeSig): number {
  return ts.num * (32 / ts.den);
}

export const KEY_NAMES: Record<number, string> = {
  0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#",
  "-1": "F", "-2": "Bb", "-3": "Eb", "-4": "Ab", "-5": "Db", "-6": "Gb", "-7": "Cb",
};

export const KEY_LABELS: Record<number, string> = {
  0: "C maj", 1: "G maj", 2: "D maj", 3: "A maj", 4: "E maj", 5: "B maj", 6: "F# maj", 7: "C# maj",
  "-1": "F maj", "-2": "Bb maj", "-3": "Eb maj", "-4": "Ab maj", "-5": "Db maj", "-6": "Gb maj", "-7": "Cb maj",
};

// Treble clef: lineIdx 0 = F5 (top staff line), steps of 0.5 going down.
// Offset of 4 maps lineIdx -2 → index 0.
const TREBLE_PITCHES: string[] = [
  "c/6", "b/5", "a/5", "g/5",   // lineIdx -2, -1.5, -1, -0.5
  "f/5", "e/5", "d/5", "c/5",   // lineIdx 0, 0.5, 1, 1.5
  "b/4", "a/4", "g/4", "f/4",   // lineIdx 2, 2.5, 3, 3.5
  "e/4", "d/4", "c/4", "b/3",   // lineIdx 4, 4.5, 5, 5.5
  "a/3", "g/3", "f/3", "e/3",   // lineIdx 6, 6.5, 7, 7.5
];

// Bass clef: lineIdx 0 = A3 (top staff line)
const BASS_PITCHES: string[] = [
  "e/4", "d/4", "c/4", "b/3",   // lineIdx -2, -1.5, -1, -0.5
  "a/3", "g/3", "f/3", "e/3",   // lineIdx 0, 0.5, 1, 1.5
  "d/3", "c/3", "b/2", "a/2",   // lineIdx 2, 2.5, 3, 3.5
  "g/2", "f/2", "e/2", "d/2",   // lineIdx 4, 4.5, 5, 5.5
  "c/2", "b/1", "a/1", "g/1",   // lineIdx 6, 6.5, 7, 7.5
];

export function linePosToPitch(lineIdx: number, clef: ClefType): string {
  const pitches = clef === "treble" ? TREBLE_PITCHES : BASS_PITCHES;
  const idx = Math.round(lineIdx * 2) + 4;
  return pitches[Math.max(0, Math.min(pitches.length - 1, idx))];
}

export function pitchToLineIdx(pitch: string, clef: ClefType): number {
  const pitches = clef === "treble" ? TREBLE_PITCHES : BASS_PITCHES;
  const idx = pitches.indexOf(pitch);
  if (idx < 0) return 2;
  return (idx - 4) / 2;
}

export function decomposeSlotsToRests(slots: number): Duration[] {
  const result: Duration[] = [];
  const order: [number, Duration][] = [
    [32, "w"], [16, "h"], [8, "q"], [4, "8"], [2, "16"], [1, "32"],
  ];
  let remaining = slots;
  for (const [size, dur] of order) {
    while (remaining >= size) {
      result.push(dur);
      remaining -= size;
    }
  }
  return result;
}

export interface RestSpec { dur: Duration; dotted: boolean; slots: number; }

// Like decomposeSlotsToRests but prefers dotted rests (e.g. dotted half instead
// of half + quarter) matching standard notation practice.
export function decomposeSlotsToRestSpecs(slots: number): RestSpec[] {
  const table: [number, Duration, boolean][] = [
    [32, "w",   false],
    [24, "h",   true ],
    [16, "h",   false],
    [12, "q",   true ],
    [8,  "q",   false],
    [6,  "8",   true ],
    [4,  "8",   false],
    [3,  "16",  true ],
    [2,  "16",  false],
    [1,  "32",  false],
  ];
  const result: RestSpec[] = [];
  let remaining = slots;
  for (const [size, dur, dotted] of table) {
    while (remaining >= size) {
      result.push({ dur, dotted, slots: size });
      remaining -= size;
    }
  }
  return result;
}

// ── Persistence ────────────────────────────────────────────────────────────────

const LS_KEY = "lt_note_entry_projects";

export function loadProjects(): NoteEntryProject[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as NoteEntryProject[]) : [];
  } catch {
    return [];
  }
}

export function saveProject(project: NoteEntryProject): void {
  const all = loadProjects();
  const idx = all.findIndex(p => p.id === project.id);
  if (idx >= 0) all[idx] = project;
  else all.push(project);
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

export function deleteProject(id: string): void {
  localStorage.setItem(LS_KEY, JSON.stringify(loadProjects().filter(p => p.id !== id)));
}

export function newProject(title: string, setup: ScoreSetup): NoteEntryProject {
  return {
    id: crypto.randomUUID(),
    title,
    setup,
    notes: [],
    syncPoints: [],
    youtubeUrl: "",
    createdAt: Date.now(),
  };
}

// ── MusicXML export ────────────────────────────────────────────────────────────

export function generateMusicXML(project: NoteEntryProject): string {
  const { setup, notes, title } = project;
  const { clef, keySignature, defaultTimeSig, barCount } = setup;

  const DIV = 8; // divisions per quarter note

  const durToInfo: Record<Duration, { type: string; dur: number }> = {
    "w":  { type: "whole",   dur: 32 },
    "h":  { type: "half",    dur: 16 },
    "q":  { type: "quarter", dur: 8  },
    "8":  { type: "eighth",  dur: 4  },
    "16": { type: "16th",    dur: 2  },
    "32": { type: "32nd",    dur: 1  },
  };

  const clefSign = clef === "bass" ? "F" : "G";
  const clefLine = clef === "bass" ? 4 : 2;

  function parsePitch(p: string): { step: string; octave: number } {
    const [s, o] = p.split("/");
    return { step: s.toUpperCase(), octave: parseInt(o) };
  }

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>${title}</part-name></score-part>
  </part-list>
  <part id="P1">
`;

  for (let m = 0; m < barCount; m++) {
    const ts = setup.perBarTimeSig?.[m] ?? defaultTimeSig;
    const totalSlots = measureSlots(ts);
    const mNotes = notes
      .filter(n => n.measure === m)
      .sort((a, b) => a.startSlot - b.startSlot);

    xml += `    <measure number="${m + 1}">\n`;
    if (m === 0) {
      xml += `      <attributes>\n`;
      xml += `        <divisions>${DIV}</divisions>\n`;
      xml += `        <key><fifths>${keySignature}</fifths></key>\n`;
      xml += `        <time><beats>${ts.num}</beats><beat-type>${ts.den}</beat-type></time>\n`;
      xml += `        <clef><sign>${clefSign}</sign><line>${clefLine}</line></clef>\n`;
      xml += `      </attributes>\n`;
    } else {
      const prevTs = setup.perBarTimeSig?.[m - 1] ?? defaultTimeSig;
      if (ts.num !== prevTs.num || ts.den !== prevTs.den) {
        xml += `      <attributes><time><beats>${ts.num}</beats><beat-type>${ts.den}</beat-type></time></attributes>\n`;
      }
    }

    const emitRest = (dur: Duration) => {
      const { type, dur: d } = durToInfo[dur];
      xml += `      <note><rest/><duration>${d}</duration><type>${type}</type></note>\n`;
    };

    let cursor = 0;
    for (let ni = 0; ni < mNotes.length; ni++) {
      const n = mNotes[ni];
      // Chord: 2nd+ pitched note at the same slot as the previous pitched note
      const prevPitched = ni > 0 ? mNotes.slice(0, ni).reverse().find(p => !p.isRest) : undefined;
      const isChord = !n.isRest && prevPitched && prevPitched.startSlot === n.startSlot;

      if (!isChord && n.startSlot > cursor) {
        decomposeSlotsToRests(n.startSlot - cursor).forEach(emitRest);
      }
      if (n.isRest) {
        emitRest(n.duration);
      } else {
        const { type, dur: d } = durToInfo[n.duration];
        const dotDur = n.dotted ? Math.round(d * 1.5) : d;
        const { step, octave } = parsePitch(n.pitch);
        xml += `      <note>\n`;
        if (isChord) xml += `        <chord/>\n`;
        xml += `        <pitch><step>${step}</step>`;
        if (n.accidental === "#") xml += `<alter>1</alter>`;
        if (n.accidental === "b") xml += `<alter>-1</alter>`;
        xml += `<octave>${octave}</octave></pitch>\n`;
        xml += `        <duration>${dotDur}</duration><type>${type}</type>${n.dotted ? "<dot/>" : ""}\n`;
        if (n.isTieStart) xml += `        <tie type="start"/>\n`;
        if (n.isTieEnd)   xml += `        <tie type="stop"/>\n`;
        if (n.bendSteps)  xml += `        <notations><technical><bend><bend-alter>${n.bendSteps}</bend-alter></bend></technical></notations>\n`;
        xml += `      </note>\n`;
      }
      if (!isChord) cursor = n.startSlot + noteSlots(n);
    }
    if (cursor < totalSlots) {
      decomposeSlotsToRests(totalSlots - cursor).forEach(emitRest);
    }

    xml += `    </measure>\n`;
  }

  xml += `  </part>\n</score-partwise>`;
  return xml;
}
