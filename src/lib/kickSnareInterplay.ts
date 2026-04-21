/**
 * Kick/Snare interplay — patterns drawn from Matt Garstka's "Universal Function
 * Kick Snare Patterns" sheet.  Each pattern's length (3..14) is also its time
 * signature numerator over /16.  Committing a phrase like "5+3" produces two
 * separate measures: a 5/16 bar followed by a 3/16 bar.
 *
 * Notation in pattern strings:
 *   "B" = kick (bass), "S" = snare.
 * Accents are expressed as 0-based slot indices within the pattern.
 *
 * Note on transcriptions: the PDF is a reference sheet; I've transcribed each
 * labeled pattern based on its Garstka name and visible contour.  If any of
 * the specific note sequences don't match your reference recording, edit the
 * entry here — labels and lengths are authoritative, notes/accents are
 * educated best-effort.
 */

export interface KSPattern {
  label:   string;            // "A", "B", "Lenny White", "F+A", ...
  notes:   string;            // length = slot count
  accents: number[];          // default accent slot indices within this pattern
  desc?:   string;
}

/** Garstka's universal K/S patterns, keyed by slot count (= time-sig numerator /16). */
export const KS_PATTERNS: Record<number, KSPattern[]> = {
  // ── 3/16 ─────────────────────────────────────────────────────────────────
  3: [
    { label: "A",            notes: "BSB", accents: [0] },
  ],
  // ── 4/16 ─────────────────────────────────────────────────────────────────
  4: [
    { label: "B",            notes: "BSSB", accents: [0],    desc: "Inverted doubles" },
    { label: "C",            notes: "BBSS", accents: [0] },
  ],
  // ── 5/16 ─────────────────────────────────────────────────────────────────
  5: [
    { label: "D",            notes: "BSSBS", accents: [0] },
    { label: "E",            notes: "BSBSB", accents: [0, 2, 4] },
    { label: "D-opp",        notes: "SBBSB", accents: [0], desc: "D Opposite" },
  ],
  // ── 6/16 ─────────────────────────────────────────────────────────────────
  6: [
    { label: "F",            notes: "BSSBBS", accents: [0, 3], desc: "Inverted Paradiddlediddle" },
    { label: "G",            notes: "BSBBSS", accents: [0, 3], desc: "Paradiddlediddle" },
    { label: "F-opp",        notes: "SBBSSB", accents: [0, 3], desc: "F Opposite" },
  ],
  // ── 7/16 ─────────────────────────────────────────────────────────────────
  7: [
    { label: "B+A",          notes: "BSSBBSB", accents: [0, 4] },
    { label: "H",            notes: "BSBSBSB", accents: [0, 2, 4, 6] },
    { label: "A+C",          notes: "BSBBBSS", accents: [0, 3] },
    { label: "B+A-opp",      notes: "SBBSSBS", accents: [0, 4], desc: "B+A Opposite" },
    { label: "H-opp",        notes: "SBSBSBS", accents: [0, 2, 4, 6], desc: "H Opposite" },
  ],
  // ── 8/16 ─────────────────────────────────────────────────────────────────
  8: [
    { label: "I",            notes: "BSBBSBSS", accents: [0, 4] },
    { label: "J",            notes: "BSKKSSKS".replace(/K/g, "B"), accents: [0, 4], desc: "Lenny White Groove" },
    { label: "K",            notes: "BSSBSBSB", accents: [0, 3, 5, 7], desc: "Inverted Paradiddle" },
  ],
  // ── 9/16 ─────────────────────────────────────────────────────────────────
  9: [
    { label: "L",            notes: "BSSBSBSSB", accents: [0, 3, 5] },
    { label: "M",            notes: "BSSBSBSBS", accents: [0, 3, 5, 7] },
    { label: "L-opp",        notes: "SBBSBSBBS", accents: [0, 3, 5], desc: "L Opposite" },
    { label: "F+A",          notes: "BSSBBSBSB", accents: [0, 3, 6], desc: "F plus A" },
    { label: "C+E",          notes: "BBSSBSBSB", accents: [0, 2, 4, 6, 8], desc: "C plus E" },
  ],
  // ── 10/16 ────────────────────────────────────────────────────────────────
  10: [
    { label: "B+F",          notes: "BSSBBSSBBS", accents: [0, 4], desc: "B plus F" },
  ],
  // ── 12/16 ────────────────────────────────────────────────────────────────
  12: [
    { label: "N",            notes: "BSBBSBSBBSBS", accents: [0, 3, 6, 9], desc: "Inverted Double Paradiddle" },
  ],
  // ── 14/16 ────────────────────────────────────────────────────────────────
  14: [
    { label: "K+F",          notes: "BSSBSBSBBSSBBS", accents: [0, 3, 5, 7, 10], desc: "K plus F" },
  ],
};

/** All slot counts we have patterns for. */
export const KS_LENGTHS: number[] = Object.keys(KS_PATTERNS)
  .map(n => parseInt(n, 10))
  .sort((a, b) => a - b);

/** Parse a phrase-structure string like "4+4+4+4" or "5+3" into a number[].
 *  Returns null on parse failure or when any part has no patterns in the library. */
export function parsePhrase(input: string): number[] | null {
  const parts = input.split("+").map(s => parseInt(s.trim(), 10));
  if (parts.some(n => !Number.isFinite(n) || n < 1)) return null;
  if (parts.some(n => !KS_PATTERNS[n] || KS_PATTERNS[n].length === 0)) return null;
  return parts;
}

/** Pick a random pattern for the given length. */
export function randomPattern(length: number): KSPattern | null {
  const pool = KS_PATTERNS[length];
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Hi-hat / ride ostinato — Garstka "Universal Function" patterns ───────
//
// Library transcribed from the two Garstka PDFs:
//   "Universal Function 16th note Hihat/Ride Patterns"   (#1–14)
//   "Universal Function Triplet Hihat/Ride Patterns"     (#15–25)
//
// Each entry has `hits` (slot indices where the hat lands), `open` (subset of
// hits rendered as open hi-hat "o"), and `length` (the base measure length
// the pattern was authored for — 16 for 16th-note patterns, 12 for triplet).
// For interplay measures with a different `totalSlots`, `hatHitsFromOstinato`
// takes the prefix (hits < totalSlots).

export interface HihatPattern {
  id:     string;         // "h1" .. "h14"
  name:   string;         // Garstka's number / description
  length: number;         // repeating unit length in slots
  hits:   number[];       // hat-closed hit positions (includes `+` and `o`)
  open:   number[];       // open-hat positions (subset of hits)
  pedal:  number[];       // hi-hat foot-pedal positions
  crash:  number[];       // crash-cymbal positions
  triplet?: boolean;      // true → rendered over a triplet-tuplet grid
}

/** Parse a user-spec string like "+ - + - | + - + -" into hit/open/pedal/crash
 *  arrays.
 *  Legend:
 *    `+` / `x` closed hat, `o` open hat, `p` hh foot-pedal, `c` crash, `-` rest.
 *  Whitespace and `|` separators are ignored so the string can be formatted for
 *  readability. */
function parseHatSpec(spec: string): {
  hits: number[]; open: number[]; pedal: number[]; crash: number[]; length: number;
} {
  const clean = spec.replace(/[\s|]/g, "");
  const hits: number[] = [];
  const open: number[] = [];
  const pedal: number[] = [];
  const crash: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i].toLowerCase();
    if (c === "x" || c === "+" || c === "o") hits.push(i);
    if (c === "o") open.push(i);
    if (c === "p") pedal.push(i);
    if (c === "c") crash.push(i);
  }
  return { hits, open, pedal, crash, length: clean.length };
}

const mk = (id: string, name: string, spec: string, opts: { triplet?: boolean } = {}): HihatPattern => {
  const p = parseHatSpec(spec);
  return {
    id, name, length: p.length,
    hits: p.hits, open: p.open, pedal: p.pedal, crash: p.crash,
    triplet: opts.triplet,
  };
};

export const HIHAT_PATTERNS: HihatPattern[] = [
  // One-measure patterns, 4 beats per measure.
  // Legend: `+` closed hat, `o` open hat, `-` rest.
  // Rests at the measure edges are intentional boundary markers for 2-hit
  // groups like ++--, --++, -++- — they dictate where the measure ends/begins.
  mk("h1",  "1 – +-+-",   "+ - + -"),
  mk("h2",  "2 – +---",   "+ - - -"),
  mk("h3",  "3 – ++++",   "+ + + +"),
  mk("h4",  "4 – --+-",   "- - + -"),
  mk("h5",  "5 – +-++",   "+ - + +"),
  mk("h6",  "6 – +++-",   "+ + + -"),
  mk("h7",  "7 – ++--",   "+ + - -"),
  mk("h8",  "8 – --++",   "- - + +"),
  mk("h9",  "9 – +--+",   "+ - - +"),
  mk("h10", "10 – -++-",  "- + + -"),
  mk("h11", "11 – +o+-",  "+ o + -"),
  mk("h12", "12 – +-+o",  "+ - + o"),
  mk("h13", "13 – o-++",  "o - + +"),
  mk("h14", "14 – ++o-",  "+ + o -"),
];

/** Find the hi-hat pattern for the given id (or "off" → null). */
export function getHihat(id: string | null): HihatPattern | null {
  if (!id || id === "off") return null;
  return HIHAT_PATTERNS.find(h => h.id === id) ?? null;
}

/** Hi-hat closed-hit positions for a measure of `totalSlots`.  The pattern's
 *  native `length` is treated as the repeating unit — if the measure is
 *  shorter we take the prefix, longer we tile.  `slotOffset` is the measure's
 *  position in a continuous tiling across a phrase (i.e. sum of totalSlots
 *  of preceding measures), so a 3-slot ostinato carries its phase across bars
 *  instead of restarting from the downbeat of every bar. */
export function hatHitsFromOstinato(id: string | null, totalSlots: number, slotOffset = 0): number[] {
  const h = getHihat(id);
  if (!h) return [];
  return tileHits(h.hits, h.length, totalSlots, slotOffset);
}

/** Hi-hat open-hit positions — same tiling as hatHitsFromOstinato. */
export function hatOpenFromOstinato(id: string | null, totalSlots: number, slotOffset = 0): number[] {
  const h = getHihat(id);
  if (!h) return [];
  return tileHits(h.open, h.length, totalSlots, slotOffset);
}

/** Hi-hat foot-pedal positions from the pattern, tiled across the measure. */
export function hatPedalFromOstinato(id: string | null, totalSlots: number, slotOffset = 0): number[] {
  const h = getHihat(id);
  if (!h) return [];
  return tileHits(h.pedal, h.length, totalSlots, slotOffset);
}

/** Crash-cymbal positions from the pattern, tiled across the measure. */
export function hatCrashFromOstinato(id: string | null, totalSlots: number, slotOffset = 0): number[] {
  const h = getHihat(id);
  if (!h) return [];
  return tileHits(h.crash, h.length, totalSlots, slotOffset);
}

// Tile a hit pattern (slot indices within one unit) across a measure of
// `totalSlots`, treating the measure as starting at `slotOffset` inside a
// longer continuous stream.  Hits that fall within [0, totalSlots) of this
// measure are returned as LOCAL slot indices.
function tileHits(hits: number[], unit: number, totalSlots: number, slotOffset = 0): number[] {
  if (unit <= 0) return [];
  const out: number[] = [];
  // Find the first base ≤ slotOffset so we pick up any hits already inside
  // this measure's window, then walk forward until we've passed it.
  const startBase = Math.floor(slotOffset / unit) * unit;
  for (let base = startBase; base < slotOffset + totalSlots; base += unit) {
    for (const h of hits) {
      const abs = base + h;
      const local = abs - slotOffset;
      if (local >= 0 && local < totalSlots) out.push(local);
    }
  }
  return out;
}

// ── Committed interplay measures ─────────────────────────────────────────

/** One committed measure of K/S interplay.  Each pattern's length is its time
 *  signature numerator over /16 — a 5-slot pattern is a 5/16 bar. */
export interface InterplayMeasureData {
  patternLabel: string;       // the KSPattern.label used (or "custom")
  totalSlots:   number;       // also the time sig numerator (/16)
  snareHits:    number[];     // slot indices within the measure
  bassHits:     number[];
  hatHits:      number[];     // hi-hat closed hits (from ostinato)
  hatOpenHits:  number[];     // hi-hat open hits (from ostinato's open16)
  hhFootHits:   number[];     // hi-hat foot-pedal hits (from ostinato)
  crashHits:    number[];     // crash-cymbal hits (from ostinato)
  ghostHits:    number[];
  accentFlags:  boolean[];    // length = totalSlots
  lineBreak?:   boolean;
}

/** Build a single committed measure from a KSPattern + hi-hat choice.
 *  Default accents are filtered to snare-only — a pattern's accent-on-kick
 *  position is dropped here since kicks can't be accented in this mode.
 *  `slotOffset` is the measure's position in a continuous tiling stream
 *  (sum of totalSlots of preceding measures in the phrase) so the ostinato
 *  carries its phase across bar lines. */
export function buildInterplayMeasureFromPattern(
  p: KSPattern,
  ostinatoId: string | null = null,
  slotOffset = 0,
): InterplayMeasureData {
  const totalSlots = p.notes.length;

  const snareHits: number[] = [];
  const bassHits:  number[] = [];
  for (let i = 0; i < totalSlots; i++) {
    if (p.notes[i] === "B") bassHits.push(i);
    else if (p.notes[i] === "S") snareHits.push(i);
  }
  const snareSet = new Set(snareHits);
  const accentFlags = new Array<boolean>(totalSlots).fill(false);
  for (const a of p.accents) {
    if (a < totalSlots && snareSet.has(a)) accentFlags[a] = true;
  }

  return {
    patternLabel: p.label,
    totalSlots,
    snareHits,
    bassHits,
    hatHits:     hatHitsFromOstinato(ostinatoId, totalSlots, slotOffset),
    hatOpenHits: hatOpenFromOstinato(ostinatoId, totalSlots, slotOffset),
    hhFootHits:  hatPedalFromOstinato(ostinatoId, totalSlots, slotOffset),
    crashHits:   hatCrashFromOstinato(ostinatoId, totalSlots, slotOffset),
    ghostHits:   [],
    accentFlags,
  };
}

/** Parse a user-typed sticking string into a KSPattern (or return null).
 *  Accepts only B (kick) and S (snare) letters; any other character is
 *  rejected.  Label is generated from the notes themselves (the user's own
 *  typing).  Default accent lands on the downbeat (slot 0). */
export function parseCustomPattern(input: string): KSPattern | null {
  const cleaned = input.trim().toUpperCase();
  if (cleaned.length === 0) return null;
  if (!/^[BS]+$/.test(cleaned)) return null;
  if (!KS_PATTERNS[cleaned.length]) return null; // only lengths we have library bins for
  return {
    label:   cleaned,
    notes:   cleaned,
    accents: [0],
  };
}
