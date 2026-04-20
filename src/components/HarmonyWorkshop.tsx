import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { audioEngine } from "@/lib/audioEngine";
import { FOLK_SONG_LIBRARY, FOLK_SONG_GROUPS } from "@/lib/folkSongData";
import {
  Renderer, Stave, StaveNote, StaveNoteStruct, Voice, Formatter, Beam, Barline, Dot, Fraction, StaveTie,
} from "vexflow";
import { getAvailableThirdQualities, getAvailableSeventhQualities, getDegreeMap, getPatternScaleMaps, getModeDegreeMap } from "@/lib/edoData";
import { generateRhythm, melodyPositionStrengths, isTripletStyle, STYLE_INFO, type RhythmStyle, type DensityBias } from "@/lib/rhythmGen";
import {
  type HarmonyCategory,
  type ProgressionMode,
  type Tonality,
  type ProgChord,
  HARMONY_CATEGORIES,
  availableHarmonyCategories,
  generateProgression,
  getDrillChordPalette,
} from "@/lib/melodicPatternData";

// ── Folk song data ──────────────────────────────────────────────────
export interface MelodyBeat {
  degree: number;       // 1-7 scale degree
  duration: number;     // beats (1 = quarter, 0.5 = eighth, 2 = half, etc.)
  accidental?: "b" | "#";
}

export interface SongBar {
  melody: MelodyBeat[];
  chordRoman: string;
}

export interface FolkSong {
  id: string;
  title: string;
  key: string;
  timeSignature: string;
  bars: SongBar[];
}

const FOLK_SONGS: FolkSong[] = [...FOLK_SONG_LIBRARY];

// ── Scale / mode helpers ────────────────────────────────────────────
const SCALE_FAMILIES = ["Major Family", "Harmonic Minor Family", "Melodic Minor Family"] as const;

function getModesForFamily(family: string, edo: number): string[] {
  const maps = getPatternScaleMaps(edo);
  const fam = maps[family];
  return fam ? Object.keys(fam) : [];
}

/** Get pitch classes for the 7 scale degrees in the given mode. */
function getModePcs(edo: number, family: string, mode: string): number[] {
  const modeMap = getModeDegreeMap(edo, family, mode);
  // modeMap is { "1": 0, "2": 5, "b3": 8, ... } — we need sorted values
  return Object.values(modeMap).sort((a, b) => a - b);
}

/** Map 1-based scale degree to pitch class using the active mode. */
function degreeToPcModal(degree: number, modePcs: number[], edo: number = 12): number {
  if (degree === 0) return -1; // rest sentinel
  const idx = (((degree - 1) % 7) + 7) % 7;
  const octaveShift = Math.floor((degree - 1) / 7);
  return (modePcs[idx] ?? 0) + octaveShift * edo;
}

const DEGREE_NAMES = ["1", "2", "3", "4", "5", "6", "7"];
function degreeLabelSimple(b: MelodyBeat): string {
  if (b.degree === 0) return "–"; // rest
  const acc = b.accidental === "b" ? "♭" : b.accidental === "#" ? "♯" : "";
  // Normalize degree to 1-7 range (handles octave offsets: -2 = 5 below, 8 = 1 above)
  const normalized = (((b.degree - 1) % 7) + 7) % 7;
  const name = DEGREE_NAMES[normalized];
  // Show octave marker for notes outside 1-7
  if (b.degree > 7) return acc + name + "'";
  if (b.degree < 1) return acc + name + ",";
  return acc + name;
}

// Ionian (major-scale) pitch classes for 12-EDO — used as the reference
// frame for interpreting stored melody degrees.
const IONIAN_PCS_12 = [0, 2, 4, 5, 7, 9, 11];

/** Adapt a melody note for reharmonization.
 *  Melody degrees are stored relative to IONIAN (the original key).  When the
 *  user changes the target mode, we compute each note's Ionian-relative pc,
 *  then:
 *    - Keep as-is if the pc is in the target mode (diatonic → passing/chord tone)
 *    - Shift by a semitone (b/#) if the pc is not in the target mode, landing
 *      on the nearest mode tone.
 *  This ensures a Major melody switched to Phrygian shows b3, b2, b6, b7
 *  on the altered scale degrees. */
function adaptMelodyNote(
  beat: MelodyBeat,
  chordPcs: number[],
  modePcs: number[],
  edo: number,
  tonicRoot: number,
): MelodyBeat {
  // Interpret the stored degree using Ionian (not the current mode) so mode
  // changes actually alter the melody.
  const ionianPcs = edo === 12 ? IONIAN_PCS_12 : modePcs; // fallback for non-12 EDO
  let ionianPc = degreeToPcModal(beat.degree, ionianPcs, edo);
  // Apply any pre-existing accidental
  if (beat.accidental === "b") ionianPc -= 1;
  else if (beat.accidental === "#") ionianPc += 1;
  const pc = ((ionianPc + tonicRoot) % edo + edo) % edo;

  const modeSet = new Set(modePcs.map(p => ((p % edo) + edo) % edo));
  const chordSet = new Set(chordPcs.map(p => ((p % edo) + edo) % edo));

  // Chord tone or diatonic → keep as-is
  if (chordSet.has(pc) || modeSet.has(pc)) return beat;

  // Chromatic to the target mode — shift minimally to the nearest mode tone.
  for (let shift = 1; shift <= 2; shift++) {
    const flatPc = ((pc - shift) % edo + edo) % edo;
    if (chordSet.has(flatPc) || modeSet.has(flatPc)) {
      return { ...beat, degree: beat.degree, accidental: "b" };
    }
    const sharpPc = (pc + shift) % edo;
    if (chordSet.has(sharpPc) || modeSet.has(sharpPc)) {
      return { ...beat, degree: beat.degree, accidental: "#" };
    }
  }

  return beat;
}

// ── Re-meter: redistribute melody into a new time signature ────────
const TIME_SIGS = ["2/4", "3/4", "4/4", "5/4", "6/8", "7/8"] as const;

function beatsPerBar(timeSig: string): number {
  const [top, bot] = timeSig.split("/").map(Number);
  // normalise to quarter-note beats
  return top * (4 / bot);
}

/** Musical re-metering: use the rhythm engine to place the same degrees into
 *  bars of the new meter. Generates a "straight" rhythm in the target meter,
 *  uses metric strengths to pair important degrees with strong beats, and
 *  allows repeats to fill extra slots without changing the phrase contour. */
function remeterBars(bars: SongBar[], newTimeSig: string, origTimeSig: string): SongBar[] {
  const newBeats = beatsPerBar(newTimeSig);
  const oldBeats = beatsPerBar(origTimeSig);
  if (newBeats === oldBeats) return bars;

  const [newTop, newBot] = newTimeSig.split("/").map(Number);
  const beatSize = 4; // 16th grid for re-metering

  // Flatten all degrees in order (the phrase)
  const phrase: MelodyBeat[] = [];
  for (const bar of bars) {
    for (const b of bar.melody) phrase.push(b);
  }

  // Generate straight rhythm for each new bar, distribute phrase degrees
  const result: SongBar[] = [];
  let phraseIdx = 0;

  // How many new bars do we need? Total original duration scaled
  const totalOrigBeats = bars.reduce((s, bar) => s + bar.melody.reduce((ss, b) => ss + b.duration, 0), 0);
  const numNewBars = Math.max(1, Math.ceil(totalOrigBeats / newBeats));
  if (phrase.length === 0) return [{ melody: [{ degree: 1, duration: newBeats }], chordRoman: "I" }];

  // Distribute degrees evenly across new bars
  const degreesPerBar = Math.max(1, Math.round(phrase.length / numNewBars));

  for (let bi = 0; bi < numNewBars; bi++) {
    // Slice of the phrase for this bar
    const barDegrees = phrase.slice(phraseIdx, phraseIdx + degreesPerBar);
    if (barDegrees.length === 0) break;
    phraseIdx += barDegrees.length;

    // Generate rhythm to place these degrees
    const rhythm = generateRhythm(newTop, beatSize, "straight", barDegrees.length, bi * 7919, newBot);
    const hits = rhythm.melodyHits;
    const strengths = melodyPositionStrengths(newTop, beatSize, "straight", hits, newBot);

    const barMelody: MelodyBeat[] = [];
    const degCount = barDegrees.length;

    for (let hi = 0; hi < hits.length; hi++) {
      const slot = hits[hi];
      const nextSlot = hi + 1 < hits.length ? hits[hi + 1] : rhythm.totalSlots;
      const dur = (nextSlot - slot) / beatSize;

      if (hi < degCount) {
        // Place original degree
        barMelody.push({ degree: barDegrees[hi].degree, duration: dur, accidental: barDegrees[hi].accidental });
      } else {
        // Extra slot: repeat previous degree (rhythmic fill, not a new pitch)
        const prev = barMelody[barMelody.length - 1];
        barMelody.push({ degree: prev.degree, duration: dur, accidental: prev.accidental });
      }
    }

    // Pick chord: use the chord of the original bar this phrase segment came from
    const origBarIdx = Math.min(Math.floor((phraseIdx - 1) / (phrase.length / bars.length)), bars.length - 1);
    result.push({ melody: barMelody, chordRoman: bars[Math.max(0, origBarIdx)].chordRoman });
  }

  // If there are leftover degrees, append one more bar
  if (phraseIdx < phrase.length) {
    const leftover = phrase.slice(phraseIdx);
    const rhythm = generateRhythm(newTop, beatSize, "straight", leftover.length, numNewBars * 7919, newBot);
    const hits = rhythm.melodyHits;
    const barMelody: MelodyBeat[] = [];
    for (let hi = 0; hi < hits.length && hi < leftover.length; hi++) {
      const nextSlot = hi + 1 < hits.length ? hits[hi + 1] : rhythm.totalSlots;
      const dur = (nextSlot - hits[hi]) / beatSize;
      barMelody.push({ degree: leftover[hi].degree, duration: dur, accidental: leftover[hi].accidental });
    }
    result.push({ melody: barMelody, chordRoman: bars[bars.length - 1].chordRoman });
  }

  return result;
}

/** Rerhythm (in-place): keep each bar's phrase (degree order) intact, apply
 *  a new rhythmic feel. Uses metric strengths to place important phrase notes
 *  (first, last) on strong beats. Extra rhythm slots get repeats of the
 *  nearest phrase degree — the contour never changes. */
function rerhythmBarsInPlace(
  bars: SongBar[],
  style: RhythmStyle,
  timeSig: string,
  seed?: number,
  densityBias: DensityBias = "auto",
): SongBar[] {
  const [top, bot] = timeSig.split("/").map(Number);
  const beatSize = isTripletStyle(style) ? 3 : 4;

  return bars.map((bar, bi) => {
    const barSeed = seed ? seed + bi : undefined;
    const rhythm = generateRhythm(top, beatSize, style, bar.melody.length, barSeed, bot, densityBias);
    const hits = rhythm.melodyHits;
    const strengths = melodyPositionStrengths(top, beatSize, style, hits, bot);

    const degCount = bar.melody.length;
    const hitCount = hits.length;
    const barMelody: MelodyBeat[] = [];

    if (hitCount <= degCount) {
      // Fewer or equal slots than degrees: place degrees in order, skip weakest
      // Pick the hitCount strongest phrase positions to keep
      const indices = Array.from({ length: degCount }, (_, i) => i);
      // Always keep first and last; fill between with evenly spaced
      const kept: number[] = [];
      for (let i = 0; i < hitCount; i++) {
        kept.push(Math.round(i * (degCount - 1) / Math.max(1, hitCount - 1)));
      }
      // Deduplicate while preserving order
      const seen = new Set<number>();
      const unique: number[] = [];
      for (const k of kept) { if (!seen.has(k)) { seen.add(k); unique.push(k); } }
      // Fill any remaining with unused indices in order
      let fill = 0;
      while (unique.length < hitCount && fill < degCount) {
        if (!seen.has(fill)) { seen.add(fill); unique.push(fill); }
        fill++;
      }
      unique.sort((a, b) => a - b);

      for (let hi = 0; hi < hitCount; hi++) {
        const slot = hits[hi];
        const nextSlot = hi + 1 < hitCount ? hits[hi + 1] : rhythm.totalSlots;
        const dur = (nextSlot - slot) / beatSize;
        const src = bar.melody[unique[hi] ?? hi % degCount];
        barMelody.push({ degree: src.degree, duration: dur, accidental: src.accidental });
      }
    } else {
      // More rhythm slots than degrees: distribute degrees across strong beats,
      // fill weaker slots with repeats of the nearest phrase note
      //
      // Assign each degree to its ideal rhythmic position, then fill gaps with repeats
      const assignments = new Map<number, number>(); // hit index -> degree index
      for (let di = 0; di < degCount; di++) {
        // Map degree position proportionally into rhythm hits
        const idealHit = Math.round(di * (hitCount - 1) / Math.max(1, degCount - 1));
        assignments.set(idealHit, di);
      }

      // Walk hits in order, tracking which degree we're on
      let curDegIdx = 0;
      for (let hi = 0; hi < hitCount; hi++) {
        const slot = hits[hi];
        const nextSlot = hi + 1 < hitCount ? hits[hi + 1] : rhythm.totalSlots;
        const dur = (nextSlot - slot) / beatSize;

        if (assignments.has(hi)) {
          curDegIdx = assignments.get(hi)!;
        }
        const src = bar.melody[curDegIdx];
        barMelody.push({ degree: src.degree, duration: dur, accidental: src.accidental });
      }
    }

    return { melody: barMelody, chordRoman: bar.chordRoman };
  });
}

/** Voice-leading helper: parse a roman-numeral chord symbol into the diatonic
 *  scale-degree set (root / 3rd / 5th). Used so reshuffle can prefer placing
 *  chord-tone degrees on metrically strong slots — the classical rule of
 *  "consonance on the beat, passing tones off the beat". */
function chordToneDegrees(roman: string): Set<number> {
  const m = roman.match(/^[b#♭♯]?(I{1,3}|IV|V|VI{0,2}|VII|i{1,3}|iv|v|vi{0,2}|vii)/);
  const map: Record<string, number> = { I:1, II:2, III:3, IV:4, V:5, VI:6, VII:7 };
  const root = m ? (map[m[1].toUpperCase()] ?? 1) : 1;
  const third  = ((root - 1 + 2) % 7) + 1;
  const fifth  = ((root - 1 + 4) % 7) + 1;
  return new Set([root, third, fifth]);
}

/** Reshuffle: keep the full phrase order but allow degrees to land across
 *  different bar boundaries. Rhythm engine decides how many notes per bar;
 *  extra slots become repeats of the current degree. Phrase contour is
 *  preserved — degrees always appear in their original order.
 *
 *  Voice-leading: within a small lookahead window (+2 degrees), prefer the
 *  candidate that is a chord tone of this bar's chord when filling strong
 *  slots. Skipped degrees stay in the queue for later bars. */
function reshuffleBars(
  bars: SongBar[],
  style: RhythmStyle,
  timeSig: string,
  seed?: number,
  densityBias: DensityBias = "auto",
): SongBar[] {
  const [top, bot] = timeSig.split("/").map(Number);
  const beatSize = isTripletStyle(style) ? 3 : 4;

  // The full phrase: all degrees in order
  const phrase: MelodyBeat[] = [];
  for (const bar of bars) {
    for (const b of bar.melody) phrase.push(b);
  }

  const result: SongBar[] = [];
  // Queue of phrase indices still waiting to be placed. Voice-leading picks
  // from the front of this queue with a small lookahead window.
  const queue: number[] = Array.from({ length: phrase.length }, (_, i) => i);
  const LOOKAHEAD = 2;

  for (let bi = 0; bi < bars.length; bi++) {
    const barSeed = seed ? seed + bi : undefined;
    const hintCount = Math.max(2, bars[bi].melody.length);
    const rhythm = generateRhythm(top, beatSize, style, hintCount, barSeed, bot, densityBias);
    const hits = rhythm.melodyHits;
    const strengths = melodyPositionStrengths(top, beatSize, style, hits, bot);
    const tones = chordToneDegrees(bars[bi].chordRoman);

    const barMelody: MelodyBeat[] = [];
    const STRENGTH_THRESHOLD = 0.4;
    let newDegreeSlots = 0;
    for (const s of strengths) {
      if (s >= STRENGTH_THRESHOLD) newDegreeSlots++;
    }
    const degreesToPlace = Math.min(Math.max(1, newDegreeSlots), queue.length);

    const strongHits: number[] = [];
    const weakHits: number[] = [];
    for (let hi = 0; hi < hits.length; hi++) {
      if (strengths[hi] >= STRENGTH_THRESHOLD && strongHits.length < degreesToPlace) {
        strongHits.push(hi);
      } else {
        weakHits.push(hi);
      }
    }
    while (strongHits.length < degreesToPlace && weakHits.length > 0) {
      strongHits.push(weakHits.shift()!);
    }
    strongHits.sort((a, b) => a - b);

    // Voice-leading pick: for each strong slot, inspect the front of the queue
    // plus LOOKAHEAD items beyond, pick the chord-tone match if one exists.
    // Skipped (non-chord-tone) degrees stay in the queue and get used later,
    // so phrase contour is preserved up to a small local reorder.
    const picked: number[] = [];
    for (let k = 0; k < degreesToPlace; k++) {
      const window = Math.min(LOOKAHEAD + 1, queue.length);
      let bestIdx = 0;
      for (let w = 0; w < window; w++) {
        if (tones.has(phrase[queue[w]].degree)) { bestIdx = w; break; }
      }
      picked.push(queue.splice(bestIdx, 1)[0]);
    }
    picked.sort((a, b) => a - b);

    const hitToDeg = new Map<number, number>();
    for (let i = 0; i < strongHits.length; i++) {
      hitToDeg.set(strongHits[i], picked[i]);
    }

    let curDeg = picked[0] ?? 0;
    for (let hi = 0; hi < hits.length; hi++) {
      const slot = hits[hi];
      const nextSlot = hi + 1 < hits.length ? hits[hi + 1] : rhythm.totalSlots;
      const dur = (nextSlot - slot) / beatSize;

      if (hitToDeg.has(hi)) {
        curDeg = hitToDeg.get(hi)!;
      }
      const src = phrase[curDeg % phrase.length];
      barMelody.push({ degree: src.degree, duration: dur, accidental: src.accidental });
    }

    result.push({ melody: barMelody, chordRoman: bars[bi].chordRoman });
  }

  return result;
}

// ── Beat-clarity splitter ────────────────────────────────────────────
// Classical notation rule: a note that crosses a beat must either start and
// end on beat boundaries with a standard duration (1=quarter, 2=half,
// 3=dotted-half, 4=whole), or be split at every beat boundary into tied
// pieces so the downbeat stays visible. Syncopated cases (start off-beat,
// dotted values crossing beats) all get split.
interface TiedPiece {
  beat: MelodyBeat;
  tiedFromPrev: boolean;
  origIdx: number;      // source index in the unsplit melody
  isFirstPiece: boolean; // for degree label: only label the head of a tied run
}
function splitAtBeats(melody: MelodyBeat[]): TiedPiece[] {
  const EPS = 1e-6;
  const out: TiedPiece[] = [];
  let pos = 0;
  for (let mi = 0; mi < melody.length; mi++) {
    const b = melody[mi];
    let remaining = b.duration;
    let tied = false;
    let first = true;
    while (remaining > EPS) {
      const onBeat = Math.abs(pos - Math.round(pos)) < EPS;
      const endPos = pos + remaining;
      const endOnBeat = Math.abs(endPos - Math.round(endPos)) < EPS;
      const isStdDur = remaining === 1 || remaining === 2 || remaining === 3 || remaining === 4;
      if (onBeat && endOnBeat && isStdDur) {
        out.push({ beat: { ...b, duration: remaining }, tiedFromPrev: tied, origIdx: mi, isFirstPiece: first });
        pos += remaining;
        remaining = 0;
        tied = true;
        first = false;
        continue;
      }
      const nextBeat = onBeat ? pos + 1 : Math.ceil(pos - EPS);
      const toNext = nextBeat - pos;
      const piece = Math.min(remaining, toNext);
      out.push({ beat: { ...b, duration: piece }, tiedFromPrev: tied, origIdx: mi, isFirstPiece: first });
      pos += piece;
      remaining -= piece;
      tied = true;
      first = false;
    }
  }
  return out;
}

// ── VexFlow duration conversion ─────────────────────────────────────
function durationToVf(dur: number): string {
  if (dur >= 6) return "wd";
  if (dur >= 4) return "w";
  if (dur >= 3) return "hd";
  if (dur >= 2) return "h";
  if (dur >= 1.5) return "qd";
  if (dur >= 1) return "q";
  if (dur >= 0.75) return "8d";
  if (dur >= 0.5) return "8";
  if (dur >= 0.375) return "16d";
  if (dur >= 0.25) return "16";
  return "32";
}

function applyWhite(el: HTMLElement) {
  const svg = el.querySelector("svg");
  if (svg) (svg as SVGSVGElement).style.filter = "invert(1)";
}

// ── Snare line row: renders up to BARS_PER_LINE bars on one stave ────
const BARS_PER_LINE = 4;
const MIN_BAR_WIDTH = 200;    // floor — below this, notes get cramped
const TIME_SIG_W = 36;        // extra space for time sig on first bar of first line
const LINE_HEIGHT = 130;      // height per line
const STAVE_Y = 48;           // vertical offset within each line (room for chord + degrees)

function SnareLineLine({
  bars,
  adaptedBars,
  chordLabels,
  chordColors,
  timeSig,
  showTimeSig,
  lineIndex,
  barWidth,
}: {
  bars: SongBar[];
  adaptedBars?: MelodyBeat[][];
  chordLabels: string[];
  chordColors: string[];
  timeSig: string;
  showTimeSig: boolean;
  lineIndex: number;
  barWidth: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sigTop] = timeSig.split("/").map(Number);

  const totalWidth = bars.length * barWidth + (showTimeSig ? TIME_SIG_W : 0) + 16;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = "";

    try {
      const renderer = new Renderer(el, Renderer.Backends.SVG);
      renderer.resize(totalWidth, LINE_HEIGHT);
      const ctx = renderer.getContext();
      ctx.setFont("Arial", 11);

      // Draw one Stave per bar, equal width, chained left-to-right
      let cursorX = 8;
      const staves: Stave[] = [];

      for (let bi = 0; bi < bars.length; bi++) {
        const isFirst = bi === 0 && showTimeSig;
        const w = barWidth + (isFirst ? TIME_SIG_W : 0);
        const stave = new Stave(cursorX, STAVE_Y, w);
        stave.setConfigForLines([
          { visible: false }, { visible: false },
          { visible: true },
          { visible: false }, { visible: false },
        ]);

        if (isFirst) {
          stave.setBegBarType(Barline.type.NONE);
          stave.addTimeSignature(timeSig);
        } else {
          stave.setBegBarType(Barline.type.SINGLE);
        }

        if (bi === bars.length - 1) {
          stave.setEndBarType(Barline.type.END);
        } else {
          stave.setEndBarType(Barline.type.NONE);
        }

        stave.setContext(ctx).draw();
        staves.push(stave);
        cursorX += w;
      }

      // Build notes + voice per bar
      for (let bi = 0; bi < bars.length; bi++) {
        const melody = adaptedBars?.[bi] ?? bars[bi].melody;
        const origMelody = bars[bi].melody;
        const stave = staves[bi];

        const pieces = splitAtBeats(melody);
        const notes: StaveNote[] = [];
        const ties: StaveTie[] = [];
        for (let pi = 0; pi < pieces.length; pi++) {
          const { beat, tiedFromPrev } = pieces[pi];
          const vfDur = durationToVf(beat.duration);
          const baseDur = vfDur.replace("d", "");
          const isRest = beat.degree === 0;
          const sn = new StaveNote({
            keys: [isRest ? "b/4" : "b/4"],
            duration: isRest ? baseDur + "r" : baseDur,
            stemDirection: 1,
          } as StaveNoteStruct);
          if (vfDur.includes("d")) Dot.buildAndAttach([sn], { all: true });
          notes.push(sn);
          if (tiedFromPrev && !isRest && notes.length >= 2) {
            const prev = notes[notes.length - 2];
            ties.push(new StaveTie({ firstNote: prev, lastNote: sn, firstIndexes: [0], lastIndexes: [0] }));
          }
        }

        if (notes.length === 0) continue;

        const barBeats = Math.max(sigTop, Math.round(melody.reduce((s, m) => s + m.duration, 0)));
        const voice = new Voice({ numBeats: barBeats, beatValue: 4 });
        (voice as unknown as { setMode(m: number): void }).setMode(2);
        voice.addTickables(notes);

        // Beam by quarter-note groups so beams break at every beat
        // (default behaviour beams everything consecutive, which produces
        //  ugly cross-beat beams when durations are mixed).
        const beams: Beam[] = [];
        try {
          beams.push(...Beam.generateBeams(notes, {
            groups: [new Fraction(1, 4)],
            maintainStemDirections: true,
            flatBeams: true,
            beamRests: false,
          }));
        } catch { /* */ }

        const fmtW = barWidth - 24;
        new Formatter().joinVoices([voice]).format([voice], fmtW);
        voice.draw(ctx, stave);
        beams.forEach(b => b.setContext(ctx).draw());
        ties.forEach(t => t.setContext(ctx).draw());

        // ── Degree labels: only above the head of each tied run ──
        for (let pi = 0; pi < notes.length; pi++) {
          const piece = pieces[pi];
          if (!piece.isFirstPiece) continue;
          const note = notes[pi];
          const beat = piece.beat;
          const origBeat = origMelody[piece.origIdx];
          const label = degreeLabelSimple(beat);
          const bb = note.getBoundingBox();
          if (!bb) continue;
          const x = bb.getX() + bb.getW() / 2;

          ctx.save();
          const changed = adaptedBars && origBeat && beat.degree !== origBeat.degree;
          ctx.setFont("monospace", 13, "bold");
          ctx.fillText(label, x - 5, STAVE_Y - 6);
          ctx.restore();

          if (changed) {
            ctx.save();
            ctx.setFont("monospace", 9);
            ctx.fillText(`(${degreeLabelSimple(origBeat)})`, x - 7, STAVE_Y + 12);
            ctx.restore();
          }
        }

      }

      applyWhite(el);
    } catch (err) {
      console.warn("SnareLineLine render error:", err);
    }
  }, [bars, adaptedBars, chordLabels, chordColors, timeSig, showTimeSig, totalWidth, barWidth]);

  return (
    <div className="overflow-x-auto">
      {/* Chord labels as HTML row — centered over each bar */}
      <div className="flex" style={{ width: totalWidth, paddingLeft: showTimeSig ? TIME_SIG_W + 8 : 8 }}>
        {bars.map((_, bi) => (
          <div key={bi} className="text-center font-bold text-sm" style={{ width: barWidth, color: chordColors[bi] }}>
            {chordLabels[bi]}
          </div>
        ))}
      </div>
      <div
        ref={containerRef}
        style={{ width: totalWidth, height: LINE_HEIGHT, overflow: "visible", display: "block", marginTop: -8 }}
      />
    </div>
  );
}

/** Wraps bars into lines of BARS_PER_LINE, renders each as a SnareLineLine. */
function SnareLineStave({
  bars,
  adaptedBars,
  chordLabels,
  chordColors,
  timeSig,
}: {
  bars: SongBar[];
  adaptedBars?: MelodyBeat[][];
  chordLabels: string[];
  chordColors: string[];
  timeSig: string;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [availWidth, setAvailWidth] = useState(900);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const measure = () => setAvailWidth(el.clientWidth || 900);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute a per-bar width that fills the container with BARS_PER_LINE bars per line.
  const barWidth = Math.max(
    MIN_BAR_WIDTH,
    Math.floor((availWidth - TIME_SIG_W - 16) / BARS_PER_LINE),
  );

  const lines: number[][] = [];
  for (let i = 0; i < bars.length; i += BARS_PER_LINE) {
    const lineIndices: number[] = [];
    for (let j = i; j < Math.min(i + BARS_PER_LINE, bars.length); j++) lineIndices.push(j);
    lines.push(lineIndices);
  }

  return (
    <div ref={outerRef} className="space-y-1 w-full">
      {lines.map((lineIndices, li) => (
        <SnareLineLine
          key={li}
          bars={lineIndices.map(i => bars[i])}
          adaptedBars={adaptedBars ? lineIndices.map(i => adaptedBars[i]) : undefined}
          chordLabels={lineIndices.map(i => chordLabels[i])}
          chordColors={lineIndices.map(i => chordColors[i])}
          timeSig={timeSig}
          showTimeSig={li === 0}
          lineIndex={li}
          barWidth={barWidth}
        />
      ))}
    </div>
  );
}

// ── Colors ──────────────────────────────────────────────────────────
const HARMONY_GROUP_COLORS: Record<string, string> = {
  Diatonic: "#5a8a5a", Chromatic: "#c06090", Extended: "#c8aa50",
};

const SUPPORTED_EDOS = [12, 31, 41] as const;
type SupportedEdo = (typeof SUPPORTED_EDOS)[number];

interface ReharmonizationResult {
  chords: ProgChord[];
  adaptedMelody: MelodyBeat[][];
}

export default function HarmonyWorkshop() {
  const [edo, setEdo] = useState<SupportedEdo>(12);
  const [tonicRoot, setTonicRoot] = useState(0);
  const [tonality, setTonality] = useState<Tonality>("major");
  const [progMode, setProgMode] = useState<ProgressionMode>("functional");
  const [adaptMelody, setAdaptMelody] = useState(true);

  // ── Mode selection ──────────────────────────────────────────────
  const [scaleFamily, setScaleFamily] = useState<string>("Major Family");
  const [modeName, setModeName] = useState<string>("Ionian");

  const modeOptions = useMemo(() => getModesForFamily(scaleFamily, edo), [scaleFamily, edo]);
  // Reset mode when family changes
  const prevFamily = useRef(scaleFamily);
  if (prevFamily.current !== scaleFamily) {
    prevFamily.current = scaleFamily;
    const opts = getModesForFamily(scaleFamily, edo);
    if (!opts.includes(modeName)) setModeName(opts[0] ?? "Ionian");
  }

  const modePcs = useMemo(() => getModePcs(edo, scaleFamily, modeName), [edo, scaleFamily, modeName]);

  // ── Harmony category selection ──────────────────────────────────
  const [harmonyCats, setHarmonyCats] = useState<Set<HarmonyCategory>>(new Set(["functional"]));
  const toggleHarmony = (c: HarmonyCategory) =>
    setHarmonyCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) { if (next.size > 1) next.delete(c); }
      else next.add(c);
      return next;
    });

  const availableThirdQualities = useMemo(() => getAvailableThirdQualities(edo), [edo]);
  const [checkedThirdQualities, setCheckedThirdQualities] = useState<Set<string>>(new Set(["min3", "maj3"]));
  const toggleThirdQuality = (q: string) =>
    setCheckedThirdQualities((prev) => { const n = new Set(prev); if (n.has(q)) n.delete(q); else n.add(q); return n; });

  const availableSeventhQualities = useMemo(() => getAvailableSeventhQualities(edo), [edo]);
  const [checkedSeventhQualities, setCheckedSeventhQualities] = useState<Set<string>>(new Set(["min7", "maj7"]));
  const toggleSeventhQuality = (q: string) =>
    setCheckedSeventhQualities((prev) => { const n = new Set(prev); if (n.has(q)) n.delete(q); else n.add(q); return n; });

  // Filter out Xenharmonic — covered by 3rd/7th filters
  const availableCats = useMemo(() => {
    const all = availableHarmonyCategories(edo);
    // Remove xen categories
    for (const c of all) { if (c.startsWith("xen_")) all.delete(c); }
    return all;
  }, [edo]);

  // ── Song selection ──────────────────────────────────────────────
  const [selectedSongId, setSelectedSongId] = useState(FOLK_SONGS[0].id);
  const rawSong = FOLK_SONGS.find((s) => s.id === selectedSongId) ?? FOLK_SONGS[0];

  // ── Time signature override ────────────────────────────────────
  const [targetTimeSig, setTargetTimeSig] = useState<string>("");
  const effectiveTimeSig = targetTimeSig || rawSong.timeSignature;

  // ── Rhythm style override ──────────────────────────────────────
  const [rhythmStyle, setRhythmStyle] = useState<RhythmStyle | "">("");
  const [rhythmApplied, setRhythmApplied] = useState(false);
  const [crossBars, setCrossBars] = useState(false);
  const [densityBias, setDensityBias] = useState<DensityBias>("auto");
  const [rhythmSeed, setRhythmSeed] = useState(0); // bump to regenerate

  const song: FolkSong = useMemo(() => {
    let s = rawSong;
    if (targetTimeSig && targetTimeSig !== rawSong.timeSignature) {
      s = { ...s, timeSignature: targetTimeSig, bars: remeterBars(s.bars, targetTimeSig, rawSong.timeSignature) };
    }
    if (rhythmStyle && rhythmApplied) {
      const fn = crossBars ? reshuffleBars : rerhythmBarsInPlace;
      s = { ...s, bars: fn(s.bars, rhythmStyle, s.timeSignature, rhythmSeed || undefined, densityBias) };
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSong, targetTimeSig, rhythmStyle, rhythmApplied, crossBars, densityBias, rhythmSeed]);

  // ── Reharmonization state ───────────────────────────────────────
  const [result, setResult] = useState<ReharmonizationResult | null>(null);
  const [history, setHistory] = useState<ReharmonizationResult[]>([]);

  const chordPalette = useMemo(() => getDrillChordPalette(edo), [edo]);

  // Reset on EDO change
  const prevEdo = useRef(edo);
  if (prevEdo.current !== edo) {
    prevEdo.current = edo;
    setCheckedThirdQualities(new Set(["min3", "maj3"]));
    setCheckedSeventhQualities(new Set(["min7", "maj7"]));
    setResult(null);
    setHistory([]);
  }

  // Derive tonality from mode for generateProgression
  const effectiveTonality = useMemo((): Tonality => {
    // Modes with minor 3rd → minor; modes with major 3rd → major
    if (modePcs.length < 3) return tonality;
    const dm = getDegreeMap(edo);
    const third = modePcs[2]; // 3rd scale degree
    const m3 = dm["b3"];
    return third <= m3 ? "minor" : "major";
  }, [modePcs, edo, tonality]);

  // ── Reharmonize ─────────────────────────────────────────────────
  const handleReharmonize = useCallback(() => {
    const barCount = song.bars.length;
    const chords = generateProgression(
      edo, barCount, harmonyCats, progMode, 3,
      effectiveTonality, tonicRoot,
      checkedSeventhQualities, checkedThirdQualities, false,
    );

    const adaptedMelody = song.bars.map((bar, i) => {
      const chord = chords[i];
      if (!chord || !adaptMelody) return bar.melody;
      return bar.melody.map((beat) =>
        adaptMelodyNote(beat, chord.chordPcs, modePcs, edo, tonicRoot)
      );
    });

    const r: ReharmonizationResult = { chords, adaptedMelody };
    setResult(r);
    setHistory((prev) => [...prev, r]);
  }, [edo, song, harmonyCats, progMode, effectiveTonality, tonicRoot, checkedSeventhQualities, checkedThirdQualities, adaptMelody, modePcs]);

  // ── Playback ────────────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false);
  const playEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPlayback = useCallback(() => {
    if (playEndTimer.current) { clearTimeout(playEndTimer.current); playEndTimer.current = null; }
    audioEngine.silencePlay();
    setIsPlaying(false);
  }, []);

  const playResult = useCallback(
    (r: ReharmonizationResult) => {
      stopPlayback();
      audioEngine.init(edo);
      setIsPlaying(true);

      const gapMs = 700;
      const chordOct = 3;  // chords in a comfortable mid range
      const melOct = 4;    // melody one octave above chords
      const barCount = r.chords.length;

      // Build chord frames — one frame per bar, each containing absolute pitches
      const chordFrames: number[][] = r.chords.map((chord) =>
        chord.chordPcs.map((pc) => chordOct * edo + ((pc + tonicRoot) % edo))
      );

      // Build melody frames — subdivide each bar's melody beats evenly within the bar slot
      const melodyFrames: number[][] = r.adaptedMelody.flatMap((barBeats) => {
        if (!barBeats || barBeats.length === 0) return [[]];
        return barBeats.map((beat) => {
          if (beat.degree === 0) return []; // rest = empty frame
          const pc = degreeToPcModal(beat.degree, modePcs, edo);
          return [melOct * edo + ((pc + tonicRoot) % edo)];
        });
      });

      const voiceList: { frames: number[][]; noteDuration: number; gain: number }[] = [
        { frames: chordFrames, noteDuration: 0.6, gain: 0.5 },
        { frames: melodyFrames, noteDuration: 0.45, gain: 0.4 },
      ];

      audioEngine.playMultiVoice(voiceList, edo, gapMs, barCount);

      // Clear playing state after full duration
      const totalMs = barCount * gapMs + 200;
      playEndTimer.current = setTimeout(() => setIsPlaying(false), totalMs);
    },
    [edo, tonicRoot, modePcs, stopPlayback]
  );

  const timeSig = song.timeSignature;

  return (
    <div className="max-w-[1600px] mx-auto space-y-3">
      <h2 className="text-sm font-semibold text-[#ccc]">Harmony Workshop</h2>

      {/* ── Settings ── */}
      <div className="bg-[#111] border border-[#222] rounded-lg px-3 py-2 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-[#666] uppercase tracking-wider">EDO</label>
            <select value={edo} onChange={(e) => setEdo(Number(e.target.value) as SupportedEdo)}
              className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
              {SUPPORTED_EDOS.map((e) => <option key={e} value={e}>{e}-EDO</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-[#666] uppercase tracking-wider">Tonic</label>
            <input type="number" min={0} max={edo - 1} value={tonicRoot}
              onChange={(e) => setTonicRoot(Math.max(0, Math.min(edo - 1, Number(e.target.value))))}
              className="w-12 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white text-center focus:outline-none" />
          </div>
          <div className="w-px h-4 bg-[#2a2a2a]" />
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-[#666] uppercase tracking-wider">Scale</label>
            <select value={scaleFamily} onChange={(e) => setScaleFamily(e.target.value)}
              className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
              {SCALE_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-[#666] uppercase tracking-wider">Mode</label>
            <select value={modeName} onChange={(e) => setModeName(e.target.value)}
              className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
              {modeOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="w-px h-4 bg-[#2a2a2a]" />
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-[#666] uppercase tracking-wider">Adapt Melody</label>
            <button onClick={() => setAdaptMelody(!adaptMelody)}
              className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                adaptMelody ? "bg-[#1a2a1a] border-[#3a6a3a] text-[#6abf6a]" : "bg-[#111] border-[#2a2a2a] text-[#666]"
              }`}>
              {adaptMelody ? "On" : "Off"}
            </button>
          </div>
        </div>

        {/* Harmony categories — no Xen row */}
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] text-[#666] uppercase tracking-wider">Harmony</span>
          {HARMONY_CATEGORIES.filter((c) => availableCats.has(c.id)).map((c) => {
            const on = harmonyCats.has(c.id);
            const color = HARMONY_GROUP_COLORS[c.group] ?? "#999";
            return (
              <button key={c.id} onClick={() => toggleHarmony(c.id)} title={`${c.desc} [${c.group}]`}
                className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                  on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: color + "30", borderColor: color, color } : {}}>
                {c.label.replace("{edo}", String(edo))}
              </button>
            );
          })}
        </div>

        {/* 3rds + 7ths + Logic */}
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] text-[#666] uppercase tracking-wider">3rds</span>
          {availableThirdQualities.map((q) => {
            const on = checkedThirdQualities.has(q.id);
            return (
              <button key={q.id} onClick={() => toggleThirdQuality(q.id)} title={q.desc}
                className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                  on ? "text-white bg-[#1a2a1a] border-[#3a6a3a] text-[#7aaa6a]" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}>
                {q.label}
              </button>
            );
          })}
          {availableSeventhQualities.length > 0 && (<>
            <div className="border-l border-[#2a2a2a] h-4 mx-0.5" />
            <span className="text-[10px] text-[#666] uppercase tracking-wider">7ths</span>
            {availableSeventhQualities.map((q) => {
              const on = checkedSeventhQualities.has(q.id);
              return (
                <button key={q.id} onClick={() => toggleSeventhQuality(q.id)} title={q.desc}
                  className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                    on ? "text-white bg-[#1a1a2a] border-[#4a4a8a] text-[#b07acc]" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                  }`}>
                  {q.label}
                </button>
              );
            })}
          </>)}
          <div className="border-l border-[#2a2a2a] h-4 mx-0.5" />
          <span className="text-[10px] text-[#666] uppercase tracking-wider">Logic</span>
          {([
            { value: "functional" as ProgressionMode, label: "Functional", color: "#6a9aca" },
            { value: "random" as ProgressionMode, label: "Random", color: "#999" },
          ] as const).map((m) => (
            <button key={m.value} onClick={() => setProgMode(m.value)}
              className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                progMode === m.value ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
              }`}
              style={progMode === m.value ? { backgroundColor: m.color + "30", borderColor: m.color, color: m.color } : {}}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Song selector ── */}
      <div className="bg-[#111] border border-[#222] rounded-lg px-3 py-1.5 flex items-center gap-3">
        <label className="text-[10px] text-[#666] uppercase tracking-wider">Song</label>
        <select value={selectedSongId}
          onChange={(e) => { setSelectedSongId(e.target.value); setTargetTimeSig(""); setRhythmStyle(""); setRhythmApplied(false); setResult(null); setHistory([]); }}
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none" style={{ maxWidth: 280 }}>
          {FOLK_SONG_GROUPS.map((g) => {
            const ids = new Set(FOLK_SONG_LIBRARY.filter((_, i) => {
              // Match songs to groups using FOLK_SONG_GROUPS metadata
              let idx = 0;
              for (const g2 of FOLK_SONG_GROUPS) {
                if (g2 === g) return i >= idx && i < idx + g2.count;
                idx += g2.count;
              }
              return false;
            }).map(s => s.id));
            const groupSongs = FOLK_SONGS.filter(s => ids.has(s.id));
            if (groupSongs.length === 0) return null;
            return (
              <optgroup key={g.label} label={g.label}>
                {groupSongs.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
              </optgroup>
            );
          })}
        </select>
        <div className="w-px h-4 bg-[#2a2a2a]" />
        <label className="text-[10px] text-[#666] uppercase tracking-wider">Meter</label>
        <select value={targetTimeSig}
          onChange={(e) => { setTargetTimeSig(e.target.value); setResult(null); setHistory([]); }}
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
          <option value="">Original ({rawSong.timeSignature})</option>
          {TIME_SIGS.filter(ts => ts !== rawSong.timeSignature).map(ts => (
            <option key={ts} value={ts}>{ts}</option>
          ))}
        </select>
        <div className="w-px h-4 bg-[#2a2a2a]" />
        <label className="text-[10px] text-[#666] uppercase tracking-wider">Rhythm</label>
        <select value={rhythmStyle}
          onChange={(e) => { setRhythmStyle(e.target.value as RhythmStyle | ""); if (!e.target.value) { setRhythmApplied(false); } setResult(null); setHistory([]); }}
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
          <option value="">Original</option>
          {STYLE_INFO.map(s => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        {rhythmStyle && (<>
          <button onClick={() => { setRhythmApplied(true); setRhythmSeed(Date.now()); setResult(null); setHistory([]); }}
            className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
              rhythmApplied ? "bg-[#1a2a1a] border-[#3a6a3a] text-[#6abf6a]" : "bg-[#1a1a1a] border-[#2a2a2a] text-[#888] hover:text-white"
            }`}
            title="Generate a new rhythm for this style">
            Apply
          </button>
          <label className="flex items-center gap-1 text-[10px] text-[#888] cursor-pointer" title="Let degrees cross bar lines when generating">
            <input type="checkbox" checked={crossBars}
              onChange={(e) => { setCrossBars(e.target.checked); setResult(null); setHistory([]); }}
              className="accent-[#4a4a8a]" />
            cross bars
          </label>
          <div className="flex items-center gap-0.5">
            <button onClick={() => { setDensityBias(densityBias === "spacious" ? "auto" : "spacious"); setResult(null); setHistory([]); }}
              className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                densityBias === "spacious" ? "bg-[#1a2a2a] border-[#3a6a6a] text-[#6abfbf]" : "bg-[#1a1a1a] border-[#2a2a2a] text-[#888] hover:text-white"
              }`}
              title="Sparser hits — more rests, same underlying pattern">
              Spacious
            </button>
            <button onClick={() => { setDensityBias(densityBias === "busy" ? "auto" : "busy"); setResult(null); setHistory([]); }}
              className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                densityBias === "busy" ? "bg-[#2a2a1a] border-[#6a6a3a] text-[#bfbf6a]" : "bg-[#1a1a1a] border-[#2a2a2a] text-[#888] hover:text-white"
              }`}
              title="Busier hits — fewer rests, same underlying pattern">
              Busy
            </button>
          </div>
        </>)}
        <div className="w-px h-4 bg-[#2a2a2a]" />
        <span className="text-[10px] text-[#555]">{song.key}</span>
        <span className="text-[10px] text-[#444] italic">
          {modeName} ({scaleFamily.replace(" Family", "")})
        </span>
      </div>

      {/* ── Action row: Reharmonize / Original / Play / Stop ── */}
      <div className="flex items-center gap-2">
        <button onClick={handleReharmonize}
          className="px-3 py-1.5 bg-[#7173e6] hover:bg-[#8183f6] text-white text-xs font-medium rounded transition-colors">
          Reharmonize
        </button>
        {result && (
          <button onClick={() => setResult(null)}
            className="px-2 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] text-[#aaa] hover:text-white text-xs rounded transition-colors"
            title="Revert to the original chords/melody">
            Original
          </button>
        )}
        {result && (
          <button onClick={() => playResult(result)} disabled={isPlaying}
            className="px-2 py-1.5 bg-[#1a1a1a] border border-[#2a2a2a] text-[#aaa] hover:text-white text-xs rounded transition-colors disabled:opacity-50">
            {isPlaying ? "Playing..." : "Play"}
          </button>
        )}
        {isPlaying && (
          <button onClick={stopPlayback}
            className="px-2 py-1.5 bg-[#2a1a1a] border border-[#5a2a2a] text-[#cc6666] hover:text-[#ff7777] text-xs rounded transition-colors">
            Stop
          </button>
        )}
      </div>

      {/* ── Single view: reharmonized when result is set, else original ── */}
      <div className={`bg-[#111] border rounded-lg px-3 py-2 ${result ? "border-[#1a3a1a]" : "border-[#222]"}`}>
        <span className={`text-[10px] uppercase tracking-wider ${result ? "text-[#5a8a5a]" : "text-[#666]"}`}>
          {result ? "Reharmonized" : "Original"}
        </span>
        <SnareLineStave
          key={result ? `reharm-${selectedSongId}-${history.length}` : `orig-${selectedSongId}`}
          bars={song.bars}
          adaptedBars={result ? result.adaptedMelody : undefined}
          chordLabels={result ? result.chords.map(c => c.roman) : song.bars.map(b => b.chordRoman)}
          chordColors={
            result
              ? result.chords.map((c, i) => (c.roman !== song.bars[i]?.chordRoman ? "#6adf6a" : "#7173e6"))
              : song.bars.map(() => "#7173e6")
          }
          timeSig={timeSig}
        />
      </div>

      {/* ── History ── */}
      {history.length > 1 && (
        <div className="bg-[#111] border border-[#222] rounded-lg px-3 py-1.5 space-y-1">
          <span className="text-[10px] text-[#666] uppercase tracking-wider">
            History ({history.length})
          </span>
          <div className="space-y-0.5 max-h-32 overflow-y-auto">
            {history.map((r, hi) => (
              <div key={hi}
                className="flex items-center gap-2 text-[11px] cursor-pointer hover:bg-[#1a1a1a] rounded px-2 py-0.5 transition-colors"
                onClick={() => setResult(r)}>
                <span className="text-[#555] w-5">#{hi + 1}</span>
                <span className="text-[#aaa]">{r.chords.map((c) => c.roman).join(" → ")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Chord palette ── */}
      <details className="bg-[#111] border border-[#222] rounded-lg px-3 py-1.5">
        <summary className="text-[10px] text-[#666] uppercase tracking-wider cursor-pointer select-none">
          Chord Palette ({chordPalette.length} chords in {edo}-EDO)
        </summary>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {chordPalette.map((c, i) => (
            <span key={i} className="px-1.5 py-0.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded text-[9px] text-[#888]">
              {c.roman}
            </span>
          ))}
        </div>
      </details>
    </div>
  );
}
