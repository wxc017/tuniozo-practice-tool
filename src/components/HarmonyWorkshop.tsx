import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { FOLK_SONG_LIBRARY, FOLK_SONG_GROUPS } from "@/lib/folkSongData";
import {
  Renderer, Stave, StaveNote, StaveNoteStruct, Voice, Formatter, Beam, Barline, Dot, Fraction, StaveTie,
} from "vexflow";
import { getBaseChords, getDegreeMap, getPatternScaleMaps, getModeDegreeMap, pcToNoteNameWithEnharmonic, formatHalfAccidentals } from "@/lib/edoData";
import { generateRhythm, melodyPositionStrengths, isTripletStyle, STYLE_INFO, type RhythmStyle, type DensityBias } from "@/lib/rhythmGen";
import {
  type ProgressionMode,
  type Tonality,
  type ProgChord,
  getDrillChordPalette,
} from "@/lib/melodicPatternData";
import {
  getTonalityBanks, APPROACH_KINDS, APPROACH_LABELS,
  type ApproachKind, type ChordEntry, type TonalityBank,
} from "@/lib/tonalityBanks";
import {
  TONALITY_FAMILIES,
  generatePoolProgression, getAllPoolChords,
  applicableXenKinds, XEN_LABEL, XEN_COLOR,
  type XenKind, type PoolProgChord,
} from "@/lib/tonalityChordPool";

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
 *    - For a non-diatonic (borrowed / secondary / tritone) chord, shift any
 *      mode-tone that sits a half-step from a chord tone down/up onto that
 *      chord tone (labeled b/# so the reader sees the fit).
 *    - Keep as-is if the pc is in the chord or in the target mode
 *    - Shift by a semitone (b/#) if the pc is chromatic to the mode, landing
 *      on the nearest mode/chord tone.
 *  This ensures a Major melody switched to Phrygian shows b3, b2, b6, b7 on
 *  the altered scale degrees, and a reharm with a bII chord over a "2" in
 *  the melody shows "b2" (the melody adjusted to fit the chord). */
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
  const chordIsDiatonic = chordPcs.every(p => modeSet.has(((p % edo) + edo) % edo));

  // Already a chord tone → perfect fit, nothing to do.
  if (chordSet.has(pc)) return beat;

  // Non-functional chord + mode-tone melody → try a half-step nudge onto a
  // chord tone.  This is what makes a bII chord over a "2" become "b2".
  if (!chordIsDiatonic && modeSet.has(pc)) {
    const flatPc = ((pc - 1) % edo + edo) % edo;
    const sharpPc = (pc + 1) % edo;
    const flatFits = chordSet.has(flatPc);
    const sharpFits = chordSet.has(sharpPc);
    if (flatFits && !sharpFits) return { ...beat, accidental: "b" };
    if (sharpFits && !flatFits) return { ...beat, accidental: "#" };
    if (flatFits) return { ...beat, accidental: "b" }; // both sides fit → prefer flat
    // Neither direction reaches a chord tone — leave as a mode-tone tension.
    return beat;
  }

  // Mode tone under a diatonic chord → keep (passing/chord tension).
  if (modeSet.has(pc)) return beat;

  // Chromatic to the target mode — shift minimally to the nearest mode/chord tone.
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

/** Metric partition of a bar at the eighth-note level.  Used for beam
 *  grouping and to identify where chord changes can land metrically. */
function metricPartitionEighths(timeSig: string): number[] {
  const [top, bot] = timeSig.split("/").map(Number);
  if (bot === 8) {
    switch (top) {
      case 3:  return [3];
      case 5:  return [2, 3];
      case 6:  return [3, 3];
      case 7:  return [2, 2, 3];
      case 9:  return [3, 3, 3];
      case 12: return [3, 3, 3, 3];
      default: return Array.from({ length: top }, () => 1);
    }
  }
  // Simple meters (bottom = 4): each beat = 2 eighths.
  return Array.from({ length: top }, () => 2);
}

/** Candidate positions (in quarter-note beats from bar start) where a
 *  mid-bar chord change can land musically — i.e. the start of each
 *  metric pulse group except the bar downbeat (which always has the
 *  main chord). */
function candidateMidBarPulses(timeSig: string): number[] {
  const partition = metricPartitionEighths(timeSig);
  const positions: number[] = [];
  let cumEighths = 0;
  for (let i = 0; i < partition.length - 1; i++) {
    cumEighths += partition[i];
    positions.push(cumEighths / 2); // eighths → quarters
  }
  return positions;
}

/** Short human label for a pulse position.  For simple meters, a beat
 *  number ("b2", "b3").  For NI / compound, the eighth-note position
 *  ("♪3", "♪5"). */
function pulseLabel(posQuarters: number, timeSig: string): string {
  const [, bot] = timeSig.split("/").map(Number);
  if (bot === 4) return `b${Math.round(posQuarters) + 1}`;
  return `♪${Math.round(posQuarters * 2) + 1}`;
}

// ── Musical re-metering pipeline ─────────────────────────────────────
//
// Three-stage dispatcher.  Each stage is a discrete musical strategy
// drawn from the meter / phrase-rhythm literature; the dispatcher picks
// the most musical strategy that applies and falls back to the next.
//
// Theory:
//
//   ROTHSTEIN, *Phrase Rhythm in Tonal Music* (Schirmer, 1989), ch. 2.
//     A phrase is "directed motion from one tonal entity to another" —
//     a unit of musical meaning, not a bar count.  Re-metering must
//     respect phrase boundaries; *phrase expansion / contraction* are
//     the legitimate ways to fit a phrase into a different bar count
//     without breaking its identity.  Tonal music has a strong
//     preference for "square" hypermeter (1-, 2-, 4-bar units), so
//     phrase lengths in the new meter should snap to those when close.
//
//   LERDAHL & JACKENDOFF, *A Generative Theory of Tonal Music* (MIT,
//     1983).  Grouping Preference Rules (GPRs) drive phrase detection:
//     long notes (GPR 2b: long IOI) and cadential degrees mark phrase
//     boundaries.  Time-Span Reduction picks essential anchor notes
//     (phrase ends, downbeat chord tones) from decorative passing
//     notes.  Implemented in `melodyPositionStrengths` / used here for
//     phrase boundary detection.
//
//   LONDON, *Hearing in Time* (Oxford 2012), ch. 4.  Compound meters
//     (6/8, 9/8) have a hierarchically distinct pulse — a dotted-
//     quarter compound beat is not a re-grouping of quarter pulses.
//     Crossing simple↔compound therefore needs a pulse-mapping stage
//     rather than pure re-barring.  Already cited in `londonWellFormed`.
//
//   COOPER & MEYER, *The Rhythmic Structure of Music* (Chicago, 1960).
//     Accent hierarchy at multiple architectonic levels — rhythmic
//     groupings nest inside metric ones inside hypermetric ones.
//
//   GOULD, *Behind Bars* (Faber, 2011), chs. 2 & 6.  Notation rules for
//     ties across barlines and beam grouping — applied downstream by
//     `splitAtBeats` and `beamGroupsFor`.

interface FlatNote { beat: MelodyBeat; chord: string; origBarIdx: number; }

function flattenWithChords(bars: SongBar[]): FlatNote[] {
  const out: FlatNote[] = [];
  for (let bi = 0; bi < bars.length; bi++) {
    for (const b of bars[bi].melody) {
      if (b.duration > 1e-6) out.push({ beat: b, chord: bars[bi].chordRoman, origBarIdx: bi });
    }
  }
  return out;
}

function isCompoundMeter(sig: string): boolean {
  const [t, b] = sig.split("/").map(Number);
  return b === 8 && (t === 6 || t === 9 || t === 12);
}

function isSimpleQuarterMeter(sig: string): boolean {
  const [, b] = sig.split("/").map(Number);
  return b === 4;
}

/** Pour a flat note stream into bars of `barLen` quarter-beats.  Notes
 *  that overflow a bar split at the line; downstream `splitAtBeats`
 *  draws the join as a tie when needed.  The first note of each new
 *  bar carries that bar's chord (the chord of whichever original bar
 *  supplied that note). */
function rebarStream(flat: FlatNote[], barLen: number): SongBar[] {
  const EPS = 1e-6;
  if (flat.length === 0) return [];
  const result: SongBar[] = [];
  let curMelody: MelodyBeat[] = [];
  let curChord = flat[0].chord;
  let rem = barLen;
  for (const { beat, chord } of flat) {
    if (curMelody.length === 0) curChord = chord;
    let dur = beat.duration;
    while (dur > EPS) {
      const fit = Math.min(dur, rem);
      curMelody.push({ degree: beat.degree, duration: fit, accidental: beat.accidental });
      rem -= fit;
      dur -= fit;
      if (rem <= EPS) {
        result.push({ melody: curMelody, chordRoman: curChord });
        curMelody = [];
        rem = barLen;
        curChord = chord;
      }
    }
  }
  if (curMelody.length > 0) {
    if (rem > EPS) curMelody.push({ degree: 0, duration: rem });
    result.push({ melody: curMelody, chordRoman: curChord });
  }
  return result;
}

/** Stage 1 — same-pulse re-bar.  When source and target share the same
 *  pulse unit (both quarter-based simple meters, or both eighth-based
 *  meters), re-metering is a pure notation operation: keep every note's
 *  duration, redraw the bar lines.  The listener hears the same surface
 *  rhythm in a different metric grouping (Gould, ch. 6 — the "mixed
 *  metres" idea).  Returns null if the pair isn't same-pulse. */
function tryStage1Rebar(flat: FlatNote[], fromSig: string, toSig: string): SongBar[] | null {
  const [, fromBot] = fromSig.split("/").map(Number);
  const [, toBot] = toSig.split("/").map(Number);
  if (fromBot !== toBot) return null;
  return rebarStream(flat, beatsPerBar(toSig));
}

/** Stage 2 — pulse-swap mapping for simple↔compound conversions.
 *
 *  Maps each pulse of the source meter to one pulse of the target meter
 *  by scaling note durations by the ratio of bar lengths.  The bar
 *  count is preserved AND the perceived pulse count per bar is
 *  preserved — which is the defining feature of the meter to a
 *  listener (London, ch. 4).
 *
 *  Example: 2/4 → 6/8.  2 quarter pulses ↔ 2 dotted-quarter pulses
 *  (= 2 compound beats).  Each quarter note (1.0 unit) scales to a
 *  dotted-quarter (1.5 units), giving a "lilting" compound feel
 *  without changing the phrase length in bars.
 *
 *  Returns null when the meter pair isn't a simple↔compound conversion
 *  with matching pulse counts. */
function tryStage2PulseMap(flat: FlatNote[], fromSig: string, toSig: string): SongBar[] | null {
  const fromQ = isSimpleQuarterMeter(fromSig);
  const fromC = isCompoundMeter(fromSig);
  const toQ = isSimpleQuarterMeter(toSig);
  const toC = isCompoundMeter(toSig);

  let srcPulses: number, dstPulses: number;
  if (fromQ && toC) {
    srcPulses = Number(fromSig.split("/")[0]);
    dstPulses = Number(toSig.split("/")[0]) / 3;
  } else if (fromC && toQ) {
    srcPulses = Number(fromSig.split("/")[0]) / 3;
    dstPulses = Number(toSig.split("/")[0]);
  } else {
    return null;
  }
  if (srcPulses !== dstPulses) return null;

  const scale = beatsPerBar(toSig) / beatsPerBar(fromSig);
  const scaled = flat.map(f => ({
    ...f,
    beat: { ...f.beat, duration: f.beat.duration * scale },
  }));
  return rebarStream(scaled, beatsPerBar(toSig));
}

/** Phrase boundary detector — Lerdahl/Jackendoff GPR.  A boundary is
 *  taken at the END of a note that is either:
 *    - significantly longer than the local average (GPR 2b: long IOI), or
 *    - a cadential scale degree (1 or 5) appearing late in a bar.
 *  A new phrase only opens after at least two source bars of music has
 *  accumulated, so short songs aren't fragmented into 1-bar phrases. */
function detectPhrases(flat: FlatNote[], fromSig: string): FlatNote[][] {
  if (flat.length <= 4) return [flat];
  const barLen = beatsPerBar(fromSig);
  const minPhraseLen = barLen * 2 - 1e-6;

  const durs = flat.map(f => f.beat.duration);
  const avg = durs.reduce((a, b) => a + b, 0) / Math.max(1, durs.length);
  const longThreshold = Math.max(avg * 1.6, barLen * 0.5);

  const phrases: FlatNote[][] = [];
  let cur: FlatNote[] = [];
  let curDur = 0;

  for (let i = 0; i < flat.length; i++) {
    const f = flat[i];
    cur.push(f);
    curDur += f.beat.duration;

    const isLast = i === flat.length - 1;
    if (isLast) { phrases.push(cur); break; }

    const isLong = f.beat.duration >= longThreshold;
    const isCadenceDeg = f.beat.degree === 1 || f.beat.degree === 5;
    const enoughMaterial = curDur >= minPhraseLen;

    if (enoughMaterial && (isLong || isCadenceDeg)) {
      phrases.push(cur);
      cur = [];
      curDur = 0;
    }
  }

  // Merge a tiny final phrase into its predecessor so the song doesn't
  // end on an awkward 1-bar tag (Rothstein: hypermetric closure).
  if (phrases.length >= 2) {
    const last = phrases[phrases.length - 1];
    const lastDur = last.reduce((s, f) => s + f.beat.duration, 0);
    if (lastDur < barLen * 0.75) {
      phrases[phrases.length - 2].push(...last);
      phrases.pop();
    }
  }

  return phrases;
}

/** Stage 3 — phrase-aware scaling for incompatible meter pairs.
 *
 *  For each detected phrase:
 *    1. Compute the natural target-bar count = (phrase total / new bar
 *       length).
 *    2. Snap to the nearest hypermetric-friendly count (1, 2, 4, 8)
 *       when the natural count is reasonably close (Rothstein: tonal
 *       phrases prefer square groupings; out-of-square lengths are
 *       heard as expansion or contraction of an underlying square).
 *    3. Scale every note in the phrase by (target total / source
 *       total) so the phrase fills exactly the chosen bar count.  This
 *       is the GTTM time-span-reduction-lite step: relative durations
 *       (the rhythmic shape) are preserved, only the absolute scale
 *       changes.
 *    4. Quantize note offsets to a 16th-note grid in the target meter
 *       so the rendered notation uses clean values; rounding error
 *       absorbs into the phrase-final note.
 *    5. Pour the result into target bars; `splitAtBeats` adds ties
 *       across bar lines per Gould ch. 2.
 *
 *  Notes are never re-ordered, so phrase contour is preserved exactly.
 *  Phrases are independently rescaled, so the song's overall length in
 *  bars adapts naturally to the new meter. */
function stage3PhraseAware(flat: FlatNote[], fromSig: string, toSig: string): SongBar[] {
  const toBarLen = beatsPerBar(toSig);
  const phrases = detectPhrases(flat, fromSig);
  const out: SongBar[] = [];

  for (const phrase of phrases) {
    if (phrase.length === 0) continue;
    const totalSrc = phrase.reduce((s, f) => s + f.beat.duration, 0);
    if (totalSrc < 1e-6) continue;

    const naturalBars = totalSrc / toBarLen;
    let targetBars = Math.max(1, Math.round(naturalBars));
    // Snap toward the nearest "square" count when within a reasonable window
    for (const candidate of [1, 2, 4, 8]) {
      const distCand = Math.abs(naturalBars - candidate);
      const distCur = Math.abs(naturalBars - targetBars);
      if (distCand < distCur * 0.85) targetBars = candidate;
    }
    targetBars = Math.max(1, targetBars);
    const targetTotal = targetBars * toBarLen;
    const scale = targetTotal / totalSrc;

    // Scale + quantize via cumulative-position snapping (so total length
    // is exact and durations come out as differences of grid points).
    const grid = 0.25;
    const scaled: FlatNote[] = [];
    let cumulSrc = 0;
    let prevQuant = 0;
    for (let i = 0; i < phrase.length; i++) {
      const f = phrase[i];
      cumulSrc += f.beat.duration;
      const cumulTgt = cumulSrc * scale;
      const isLast = i === phrase.length - 1;
      const snapped = isLast
        ? targetTotal
        : Math.max(prevQuant + grid, Math.round(cumulTgt / grid) * grid);
      const dur = snapped - prevQuant;
      if (dur > 1e-6) {
        scaled.push({ ...f, beat: { ...f.beat, duration: dur } });
      }
      prevQuant = snapped;
    }

    out.push(...rebarStream(scaled, toBarLen));
  }

  return out;
}

/** Musical re-metering dispatcher.
 *
 *  Stage 1 (same-pulse re-bar) → Stage 2 (simple↔compound pulse swap)
 *  → Stage 3 (phrase-aware scaling).  Each stage returns null if it
 *  doesn't apply, except Stage 3, which always returns a result.
 *
 *  This replaces an earlier all-in-one implementation that regenerated
 *  rhythms via the straight-style engine — that path would freeze the
 *  browser on 6/8 and 7/8 because the grouping enumerator would try to
 *  list ~8M compositions for 24-slot bars.  No stage here calls back
 *  into the rhythm engine for grouping enumeration. */
function remeterBars(bars: SongBar[], newTimeSig: string, origTimeSig: string): SongBar[] {
  if (newTimeSig === origTimeSig) return bars;
  if (bars.length === 0) return [];

  const newBeats = beatsPerBar(newTimeSig);
  const flat = flattenWithChords(bars);
  if (flat.length === 0) {
    return [{ melody: [{ degree: 1, duration: newBeats }], chordRoman: bars[0].chordRoman }];
  }

  const stage1 = tryStage1Rebar(flat, origTimeSig, newTimeSig);
  if (stage1) return stage1;

  const stage2 = tryStage2PulseMap(flat, origTimeSig, newTimeSig);
  if (stage2) return stage2;

  return stage3PhraseAware(flat, origTimeSig, newTimeSig);
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

// ── Beam grouping ──────────────────────────────────────────────────
// VexFlow beam-group pattern for a given time signature.  In NI /
// compound meters (bottom = 8) beams follow the 2-and-3 pulse partition
// — 7/8 → 2+2+3, 6/8 → 3+3 — which is what readers rely on to identify
// the meter at a glance (Read, Music Notation, ch. 6).  In simple
// meters (bottom = 4) beams run per quarter-note beat.
function beamGroupsFor(timeSig: string): Fraction[] {
  const [, bot] = timeSig.split("/").map(Number);
  if (bot === 4) return [new Fraction(1, 4)];
  const partition = metricPartitionEighths(timeSig);
  return partition.map(g => new Fraction(g, 8));
}

// Chord label renderer: splits on the "^" marker so everything after it
// renders as a <sup> superscript. generateProgression emits "^Qua" on
// quartal chords so "iii^Qua" shows as "iii" with a small "Qua" suffix.
function renderChordRoman(label: string) {
  const caret = label.indexOf("^");
  if (caret < 0) return label;
  const base = label.slice(0, caret);
  const sup = label.slice(caret + 1);
  return (
    <>
      {base}
      <sup style={{ fontSize: "0.65em", fontWeight: 700, marginLeft: 1 }}>{sup}</sup>
    </>
  );
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
  chordLabelsPerBar,
  chordColorsPerBar,
  chordPositionsPerBar,
  timeSig,
  showTimeSig,
  lineIndex,
  barWidth,
}: {
  bars: SongBar[];
  adaptedBars?: MelodyBeat[][];
  /** 1 or 2 chord labels per bar. */
  chordLabelsPerBar: string[][];
  chordColorsPerBar: string[][];
  /** Position of each chord label in quarter-beats from bar start.
   *  Parallel to chordLabelsPerBar.  The first slot is conventionally 0
   *  (bar downbeat); the second can be any pulse boundary of the meter. */
  chordPositionsPerBar: number[][];
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

        // MelodyBeat.duration is in quarter-note units, so the voice's
        // numBeats/beatValue=4 must also be expressed in quarter-notes.
        // `beatsPerBar("6/8") = 3` (not 6) — using the raw numerator here
        // would double the allotted voice capacity for compound meters.
        const barQuarters = beatsPerBar(timeSig);
        const melodySum = melody.reduce((s, m) => s + m.duration, 0);
        const barBeats = Math.max(barQuarters, Math.ceil(melodySum - 1e-6));
        const voice = new Voice({ numBeats: barBeats, beatValue: 4 });
        (voice as unknown as { setMode(m: number): void }).setMode(2);
        voice.addTickables(notes);

        // Beam by metric groups so beams never span a beat boundary.
        // For NI meters (7/8, 5/8, …) this uses the 2/3-pulse partition
        // that identifies the meter — e.g. 7/8 beams as 2+2+3, not
        // 2+2+2+1, so a reader sees the grouping at a glance.
        const beams: Beam[] = [];
        try {
          beams.push(...Beam.generateBeams(notes, {
            groups: beamGroupsFor(timeSig),
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
  }, [bars, adaptedBars, chordLabelsPerBar, chordColorsPerBar, timeSig, showTimeSig, totalWidth, barWidth]);

  const barQuarters = beatsPerBar(timeSig);
  return (
    <div className="overflow-x-auto">
      {/* Chord labels as HTML row.  Each label's left% is derived from
          its quarter-beat position in the bar: downbeat → 0%, mid-bar
          chord → (pos / barQuarters) × 100 so the label sits over the
          metric pulse the reharmonizer chose. */}
      <div className="flex" style={{ width: totalWidth, paddingLeft: showTimeSig ? TIME_SIG_W + 8 : 8 }}>
        {bars.map((_, bi) => {
          const labels = chordLabelsPerBar[bi] ?? [];
          const colors = chordColorsPerBar[bi] ?? [];
          const positions = chordPositionsPerBar[bi] ?? [];
          return (
            <div key={bi} className="relative" style={{ width: barWidth, height: 20 }}>
              {labels.map((lbl, li) => {
                const pos = positions[li] ?? (li === 0 ? 0 : barQuarters / 2);
                const leftPct = barQuarters > 0 ? (pos / barQuarters) * 100 : 0;
                return (
                  <div
                    key={li}
                    className="absolute font-bold text-sm"
                    style={{
                      left: `${leftPct}%`,
                      color: colors[li] ?? "#7173e6",
                      paddingLeft: 4,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {renderChordRoman(lbl)}
                  </div>
                );
              })}
            </div>
          );
        })}
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
  chordLabelsPerBar,
  chordColorsPerBar,
  chordPositionsPerBar,
  timeSig,
}: {
  bars: SongBar[];
  adaptedBars?: MelodyBeat[][];
  chordLabelsPerBar: string[][];
  chordColorsPerBar: string[][];
  chordPositionsPerBar: number[][];
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
          chordLabelsPerBar={lineIndices.map(i => chordLabelsPerBar[i] ?? [])}
          chordColorsPerBar={lineIndices.map(i => chordColorsPerBar[i] ?? [])}
          chordPositionsPerBar={lineIndices.map(i => chordPositionsPerBar[i] ?? [])}
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

const SUPPORTED_EDOS = [12, 31, 41] as const;
type SupportedEdo = (typeof SUPPORTED_EDOS)[number];

interface ReharmonizationResult {
  /** Flat chord stream — each bar consumes slotsPerBar[i] entries. Bars
   *  with a mid-bar split use 2 entries (bar downbeat + chosen pulse);
   *  other bars use 1 (aligned to the downbeat). */
  chords: ProgChord[];
  slotsPerBar: (1 | 2)[];
  /** Position of each chord in quarter-beats from bar start.  Parallel
   *  to `chords`.  For the first slot of every bar this is 0; for a
   *  mid-bar slot it is the metric-pulse position chosen for that bar. */
  chordPositions: number[];
  adaptedMelody: MelodyBeat[][];
}

export default function HarmonyWorkshop() {
  const [edo, setEdo] = useState<SupportedEdo>(12);
  const [tonicRoot, setTonicRoot] = useState(0);
  const [tonality, setTonality] = useState<Tonality>("major");
  const [progMode, setProgMode] = useState<ProgressionMode>("functional");
  const [adaptMelody, setAdaptMelody] = useState(true);
  // Positions (in quarter-beats from bar start) where the reharmonizer
  // is allowed to drop a second chord.  Must be a subset of the meter's
  // candidate pulse boundaries — for 7/8 that's {1, 2}, for 4/4 {1, 2, 3}
  // (= beats 2, 3, 4), etc.  Empty = mid-bar chords off.
  const [midBarPulses, setMidBarPulses] = useState<Set<number>>(new Set());

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

  // ── Tonality + chord-pool selection (mirrors MelodicPatterns) ──
  const [tonalitySet, setTonalitySet] = useState<Set<string>>(new Set(["Major"]));
  const [checkedByTonality, setCheckedByTonality] = useState<Record<string, string[]>>(
    { Major: ["I", "IV", "V", "ii", "iii", "vi", "vii°"] });
  const [approachesByTonality, setApproachesByTonality] = useState<Record<string, Record<string, ApproachKind[]>>>({});
  const [xenByTonality, setXenByTonality] = useState<Record<string, Record<string, XenKind[]>>>({});
  const tonalityBanks = useMemo<TonalityBank[]>(() => getTonalityBanks(edo), [edo]);

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
    try {
      let s = rawSong;
      if (targetTimeSig && targetTimeSig !== rawSong.timeSignature) {
        s = { ...s, timeSignature: targetTimeSig, bars: remeterBars(s.bars, targetTimeSig, rawSong.timeSignature) };
      }
      if (rhythmStyle && rhythmApplied) {
        const fn = crossBars ? reshuffleBars : rerhythmBarsInPlace;
        s = { ...s, bars: fn(s.bars, rhythmStyle, s.timeSignature, rhythmSeed || undefined, densityBias) };
      }
      return s;
    } catch (err) {
      console.warn("HarmonyWorkshop song transform error — falling back to raw song:", err);
      return rawSong;
    }
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
    setResult(null);
    setHistory([]);
  }

  // Prune mid-bar pulses when the meter changes: a pulse at ♪5 from 7/8
  // isn't meaningful in 4/4, so drop anything not in the new meter's
  // candidate set.
  const prevTimeSig = useRef(song.timeSignature);
  if (prevTimeSig.current !== song.timeSignature) {
    prevTimeSig.current = song.timeSignature;
    const valid = new Set(candidateMidBarPulses(song.timeSignature));
    setMidBarPulses(prev => {
      let changed = false;
      const next = new Set<number>();
      for (const p of prev) {
        if (valid.has(p)) next.add(p);
        else changed = true;
      }
      return changed ? next : prev;
    });
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
  const pickRoundTonality = useCallback((): string | null => {
    const arr = Array.from(tonalitySet);
    if (arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }, [tonalitySet]);

  const handleReharmonize = useCallback(() => {
    const barCount = song.bars.length;
    void effectiveTonality;
    const t = pickRoundTonality();
    if (!t) return;

    // Main progression: one chord per bar (Markov walk on the pool).
    const mainChords: ProgChord[] = generatePoolProgression(
      edo, barCount, t,
      checkedByTonality[t] ?? [],
      approachesByTonality[t] ?? {},
      xenByTonality[t] ?? {},
      tonicRoot, progMode,
    );
    if (mainChords.length === 0) return;

    // Candidate pulse positions where a mid-bar chord is metrically
    // valid in this meter, intersected with what the user has enabled.
    const allCandidates = candidateMidBarPulses(song.timeSignature);
    const enabledPulses = allCandidates.filter(p => midBarPulses.has(p));

    // Returns the number of sustained melody notes that fall at or after
    // `fromQuarters` in the bar — a mid-bar chord floats under no one if
    // the melody doesn't hit the region it covers.
    const notesFrom = (bar: SongBar, fromQuarters: number): number => {
      let pos = 0;
      let count = 0;
      for (const b of bar.melody) {
        if (pos >= fromQuarters - 1e-6 && b.degree !== 0) count++;
        pos += b.duration;
      }
      return count;
    };

    // Secondary-dominant builder: V7 of the *next* bar's chord, pulling
    // into the downbeat. Falls through to any pool chord that shares a
    // common tone with the next chord (smooth voice-leading).
    const chordPool: PoolProgChord[] = getAllPoolChords(
      edo, t,
      checkedByTonality[t] ?? [],
      approachesByTonality[t] ?? {},
      xenByTonality[t] ?? {},
      tonicRoot,
    );
    const dm = getDegreeMap(edo);
    const P5 = dm["5"] ?? 7;
    const buildMidBarChord = (nextChord: ProgChord | undefined): ProgChord | null => {
      if (!nextChord) return null;
      const secDomRoot = ((nextChord.root - P5) % edo + edo) % edo;
      const secDom = chordPool.find(c => c.root === secDomRoot && c.chordTypeId === "dom7");
      if (secDom) return secDom;
      const nextPcs = new Set(nextChord.chordPcs);
      const candidates = chordPool.filter(c =>
        c.chordPcs.some(p => nextPcs.has(p)) && c.roman !== nextChord.roman,
      );
      if (candidates.length === 0) return null;
      return candidates[Math.floor(Math.random() * candidates.length)];
    };

    // Assemble flat chord stream + per-bar slot count + per-chord
    // positions.  A bar qualifies for a mid-bar chord when:
    //   - the user has enabled at least one pulse position,
    //   - the melody has ≥ 1 note at or after that pulse (so the chord
    //     actually covers something),
    //   - the next bar's chord is different (mid-bar is for motion, not
    //     repeats), and
    //   - a random ~60 % roll passes, so the feature stays stylistic.
    const chords: ProgChord[] = [];
    const slotsPerBar: (1 | 2)[] = [];
    const chordPositions: number[] = [];
    for (let i = 0; i < barCount; i++) {
      chords.push(mainChords[i]);
      chordPositions.push(0);

      let placed = false;
      if (
        enabledPulses.length > 0 &&
        i + 1 < barCount &&
        mainChords[i + 1] &&
        mainChords[i + 1].roman !== mainChords[i].roman &&
        Math.random() < 0.6
      ) {
        // Of the enabled pulses, keep only those the melody actually
        // reaches in this bar, then pick one at random.
        const viable = enabledPulses.filter(p => notesFrom(song.bars[i], p) >= 1);
        if (viable.length > 0) {
          const pulse = viable[Math.floor(Math.random() * viable.length)];
          const mid = buildMidBarChord(mainChords[i + 1]);
          if (mid) {
            chords.push(mid);
            chordPositions.push(pulse);
            slotsPerBar.push(2);
            placed = true;
          }
        }
      }
      if (!placed) slotsPerBar.push(1);
    }

    // Melody adaptation: walk each bar, applying chord A before the
    // split pulse and chord B at/after it.
    const adaptedMelody = song.bars.map((bar, i) => {
      if (!adaptMelody) return bar.melody;
      const flatIdx = slotsPerBar.slice(0, i).reduce((s, n) => s + n, 0);
      const chordA = chords[flatIdx];
      const chordB = slotsPerBar[i] === 2 ? chords[flatIdx + 1] : chordA;
      const splitPos = slotsPerBar[i] === 2 ? chordPositions[flatIdx + 1] : Infinity;
      if (!chordA) return bar.melody;
      let beatPos = 0;
      return bar.melody.map((beat) => {
        const activeChord = beatPos >= splitPos - 1e-6 ? chordB : chordA;
        beatPos += beat.duration;
        return adaptMelodyNote(beat, activeChord?.chordPcs ?? chordA.chordPcs, modePcs, edo, tonicRoot);
      });
    });

    const r: ReharmonizationResult = { chords, slotsPerBar, chordPositions, adaptedMelody };
    setResult(r);
    setHistory((prev) => {
      // Cap history to avoid unbounded memory growth across long sessions.
      // 50 entries is more than enough to browse recent reharmonizations.
      const next = [...prev, r];
      return next.length > 50 ? next.slice(next.length - 50) : next;
    });
  }, [edo, song, tonalitySet, checkedByTonality, approachesByTonality, xenByTonality, progMode, effectiveTonality, tonicRoot, adaptMelody, modePcs, midBarPulses, pickRoundTonality]);

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
            <select value={tonicRoot} onChange={(e) => setTonicRoot(Number(e.target.value))}
              className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
              {Array.from({ length: edo }, (_, i) => (
                <option key={i} value={i}>{formatHalfAccidentals(pcToNoteNameWithEnharmonic(i, edo))}</option>
              ))}
            </select>
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

        {/* Logic toggle (Markov vs Random) */}
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] text-[#666] uppercase tracking-wider">Logic</span>
          {([
            { value: "functional" as ProgressionMode, label: "Markov", color: "#6a9aca" },
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

      {/* Tonality multi-select + per-tonality chord pool (mirrors MelodicPatterns) */}
      <HWTonalityChordPicker
        edo={edo}
        tonalityBanks={tonalityBanks}
        tonalitySet={tonalitySet} setTonalitySet={setTonalitySet}
        checkedByTonality={checkedByTonality} setCheckedByTonality={setCheckedByTonality}
        approachesByTonality={approachesByTonality} setApproachesByTonality={setApproachesByTonality}
        xenByTonality={xenByTonality} setXenByTonality={setXenByTonality}
      />

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

      {/* ── Action row: Reharmonize / Original / Chords-per-bar ── */}
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
        <div className="ml-2 flex items-center gap-2">
          <span className="text-[10px] text-[#666] uppercase tracking-wider">
            Mid-bar pulses
          </span>
          {(() => {
            // One circle per pulse in the bar, grouped by the meter's 2/3
            // partition with a gap between groups so the structure reads.
            // Group-start circles are the metric pulses where a chord can
            // land: the downbeat is always the main chord (filled, locked),
            // later group-starts toggle between "chord can land here" (filled
            // indigo) and "no mid-bar chord here" (outlined).  Non-start
            // pulses are small dots that visualise the meter's shape only.
            const partition = metricPartitionEighths(song.timeSignature);
            // Eighth-note position of each group's start (cumulative).
            const groupStartEighth: number[] = [];
            let cum = 0;
            for (const g of partition) { groupStartEighth.push(cum); cum += g; }
            return (
              <div className="flex items-center gap-2">
                {partition.map((groupSize, gi) => (
                  <div key={gi} className="flex items-center gap-1">
                    {Array.from({ length: groupSize }, (_, pi) => {
                      const isStart = pi === 0;
                      if (!isStart) {
                        return (
                          <div
                            key={pi}
                            className="w-1 h-1 rounded-full bg-[#333]"
                            title="Within-group pulse"
                          />
                        );
                      }
                      const isDownbeat = gi === 0;
                      // Position in quarter-beats = eighth-index / 2.
                      const posQuarters = groupStartEighth[gi] / 2;
                      const on = isDownbeat || midBarPulses.has(posQuarters);
                      const label = pulseLabel(posQuarters, song.timeSignature);
                      return (
                        <button
                          key={pi}
                          type="button"
                          disabled={isDownbeat}
                          onClick={() =>
                            setMidBarPulses((prev) => {
                              const next = new Set(prev);
                              if (next.has(posQuarters)) next.delete(posQuarters);
                              else next.add(posQuarters);
                              return next;
                            })
                          }
                          className={`w-3 h-3 rounded-full border-2 transition-colors ${
                            on
                              ? "bg-[#7173e6] border-[#7173e6]"
                              : "bg-transparent border-[#555] hover:border-[#888]"
                          } ${isDownbeat ? "cursor-default opacity-80" : "cursor-pointer"}`}
                          title={
                            isDownbeat
                              ? `Bar downbeat (${label}) — main chord always lands here`
                              : `${label} — ${on ? "click to remove mid-bar chord here" : "click to allow a mid-bar chord here"}`
                          }
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
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
          chordLabelsPerBar={
            result
              ? (() => {
                  const labels: string[][] = [];
                  let flatIdx = 0;
                  for (let bi = 0; bi < song.bars.length; bi++) {
                    const slots = result.slotsPerBar[bi] ?? 1;
                    const row: string[] = [];
                    for (let s = 0; s < slots; s++) {
                      const c = result.chords[flatIdx + s];
                      if (c?.roman) row.push(c.roman);
                    }
                    labels.push(row);
                    flatIdx += slots;
                  }
                  return labels;
                })()
              : song.bars.map(b => [b.chordRoman])
          }
          chordColorsPerBar={
            result
              ? (() => {
                  const colors: string[][] = [];
                  let flatIdx = 0;
                  for (let bi = 0; bi < song.bars.length; bi++) {
                    const slots = result.slotsPerBar[bi] ?? 1;
                    const bar = song.bars[bi];
                    const row: string[] = [];
                    for (let s = 0; s < slots; s++) {
                      const c = result.chords[flatIdx + s];
                      if (!c?.roman) continue;
                      // Main chord: green if changed from original; indigo if same.
                      // Mid-bar chord: always green (it's inherently new).
                      if (s === 0) row.push(c.roman !== bar.chordRoman ? "#6adf6a" : "#7173e6");
                      else row.push("#6adf6a");
                    }
                    colors.push(row);
                    flatIdx += slots;
                  }
                  return colors;
                })()
              : song.bars.map(() => ["#7173e6"])
          }
          chordPositionsPerBar={
            result
              ? (() => {
                  const positions: number[][] = [];
                  let flatIdx = 0;
                  for (let bi = 0; bi < song.bars.length; bi++) {
                    const slots = result.slotsPerBar[bi] ?? 1;
                    const row: number[] = [];
                    for (let s = 0; s < slots; s++) {
                      row.push(result.chordPositions[flatIdx + s] ?? 0);
                    }
                    positions.push(row);
                    flatIdx += slots;
                  }
                  return positions;
                })()
              : song.bars.map(() => [0])
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

// ── Tonality + chord-pool picker (mirrors MelodicPatterns) ──────────
function HWTonalityChordPicker({
  edo, tonalityBanks,
  tonalitySet, setTonalitySet,
  checkedByTonality, setCheckedByTonality,
  approachesByTonality, setApproachesByTonality,
  xenByTonality, setXenByTonality,
}: {
  edo: number;
  tonalityBanks: TonalityBank[];
  tonalitySet: Set<string>;
  setTonalitySet: (next: Set<string>) => void;
  checkedByTonality: Record<string, string[]>;
  setCheckedByTonality: (next: Record<string, string[]>) => void;
  approachesByTonality: Record<string, Record<string, ApproachKind[]>>;
  setApproachesByTonality: (next: Record<string, Record<string, ApproachKind[]>>) => void;
  xenByTonality: Record<string, Record<string, XenKind[]>>;
  setXenByTonality: (next: Record<string, Record<string, XenKind[]>>) => void;
}) {
  const banksByName = useMemo(() => {
    const m: Record<string, TonalityBank> = {};
    for (const b of tonalityBanks) m[b.name] = b;
    return m;
  }, [tonalityBanks]);

  const toggleTonality = (name: string) => {
    const next = new Set(tonalitySet);
    if (next.has(name)) next.delete(name); else next.add(name);
    setTonalitySet(next);
    if (next.has(name) && !checkedByTonality[name]) {
      const bank = banksByName[name];
      if (bank) {
        const primary = bank.levels.find(l => l.name === "Primary");
        if (primary) {
          setCheckedByTonality({ ...checkedByTonality, [name]: primary.chords.map(c => c.label) });
        }
      }
    }
  };

  const toggleChord = (tonality: string, label: string) => {
    const list = checkedByTonality[tonality] ?? [];
    const has = list.includes(label);
    const nextList = has ? list.filter(l => l !== label) : [...list, label];
    setCheckedByTonality({ ...checkedByTonality, [tonality]: nextList });
  };

  const setLevelChecked = (tonality: string, levelChords: ChordEntry[], select: boolean) => {
    const list = new Set(checkedByTonality[tonality] ?? []);
    for (const c of levelChords) {
      if (select) list.add(c.label); else list.delete(c.label);
    }
    setCheckedByTonality({ ...checkedByTonality, [tonality]: Array.from(list) });
  };

  const toggleApproach = (tonality: string, target: string, kind: ApproachKind) => {
    const tApp = approachesByTonality[tonality] ?? {};
    const list = tApp[target] ?? [];
    const has = list.includes(kind);
    const nextList = has ? list.filter(k => k !== kind) : [...list, kind];
    const nextT = { ...tApp, [target]: nextList };
    if (nextList.length === 0) delete nextT[target];
    setApproachesByTonality({ ...approachesByTonality, [tonality]: nextT });
  };

  const toggleXen = (tonality: string, target: string, kind: XenKind) => {
    const tXen = xenByTonality[tonality] ?? {};
    const list = tXen[target] ?? [];
    const has = list.includes(kind);
    const nextList = has ? list.filter(k => k !== kind) : [...list, kind];
    const nextT = { ...tXen, [target]: nextList };
    if (nextList.length === 0) delete nextT[target];
    setXenByTonality({ ...xenByTonality, [tonality]: nextT });
  };

  return (
    <div className="space-y-3">
      <div className="bg-[#0e0e0e] border border-[#1a1a1a] rounded p-2 space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-xs text-[#888] font-medium">TONALITIES</p>
          <button onClick={() => setTonalitySet(new Set(tonalityBanks.map(b => b.name)))}
            className="text-[9px] text-[#555] hover:text-[#9999ee] border border-[#222] rounded px-2 py-0.5">All</button>
          {TONALITY_FAMILIES.map(g => (
            <button key={g.key} onClick={() => {
              const next = new Set(tonalitySet);
              for (const t of g.tonalities) if (banksByName[t]) next.add(t);
              setTonalitySet(next);
            }}
              className="text-[9px] text-[#555] hover:text-[#aaa] border border-[#222] rounded px-2 py-0.5">
              +{g.label}
            </button>
          ))}
          <button onClick={() => setTonalitySet(new Set())}
            className="text-[9px] text-[#555] hover:text-[#aaa] border border-[#222] rounded px-2 py-0.5 ml-auto">Clear</button>
        </div>
        {TONALITY_FAMILIES.map(group => {
          const available = group.tonalities.filter(t => banksByName[t]);
          if (!available.length) return null;
          return (
            <div key={group.key}>
              <p className="text-[9px] mb-1 font-medium tracking-wider"
                 style={{ color: group.color }}>{group.label}</p>
              <div className="flex flex-wrap gap-1">
                {available.map(t => {
                  const on = tonalitySet.has(t);
                  return (
                    <button key={t} onClick={() => toggleTonality(t)}
                      className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                        on ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                      }`}
                      style={on ? { backgroundColor: group.color + "30", borderColor: group.color, color: group.color } : {}}>
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {Array.from(tonalitySet).map(tonality => {
        const bank = banksByName[tonality];
        if (!bank) return null;
        const family = TONALITY_FAMILIES.find(f => f.tonalities.includes(tonality));
        const accent = family?.color ?? "#7173e6";
        return (
          <HWChordSelectionPanel
            key={tonality}
            tonality={tonality}
            accent={accent}
            bank={bank}
            checkedSet={new Set(checkedByTonality[tonality] ?? [])}
            toggleChord={(label) => toggleChord(tonality, label)}
            setLevel={(chs, sel) => setLevelChecked(tonality, chs, sel)}
            approachMap={approachesByTonality[tonality] ?? {}}
            toggleApproach={(target, kind) => toggleApproach(tonality, target, kind)}
            xenMap={xenByTonality[tonality] ?? {}}
            toggleXen={(target, kind) => toggleXen(tonality, target, kind)}
            edo={edo}
          />
        );
      })}
      {tonalitySet.size === 0 && (
        <div className="text-xs text-[#666] italic px-3 py-2 border border-[#222] rounded">
          Pick at least one tonality above to choose chords.
        </div>
      )}
    </div>
  );
}

function HWChordSelectionPanel({
  tonality, accent, bank, checkedSet,
  toggleChord, setLevel, approachMap, toggleApproach,
  xenMap, toggleXen,
  edo,
}: {
  tonality: string;
  accent: string;
  bank: TonalityBank;
  checkedSet: Set<string>;
  toggleChord: (label: string) => void;
  setLevel: (chords: ChordEntry[], select: boolean) => void;
  approachMap: Record<string, ApproachKind[]>;
  toggleApproach: (target: string, kind: ApproachKind) => void;
  xenMap: Record<string, XenKind[]>;
  toggleXen: (target: string, kind: XenKind) => void;
  edo: number;
}) {
  const baseMap = useMemo<Record<string, number[]>>(
    () => Object.fromEntries(getBaseChords(edo)), [edo]);
  const VISIBLE_LEVELS = new Set(["Primary", "Diatonic", "Modal Interchange"]);
  const APPROACH_COLORS: Record<ApproachKind, string> = {
    secdom: "#c77a4a", secdim: "#a86bb8", iiV: "#4a9ac7", TT: "#c7a14a",
  };
  const visibleLevels = bank.levels.filter(l => VISIBLE_LEVELS.has(l.name));
  return (
    <div className="border rounded overflow-hidden" style={{ borderColor: accent + "40" }}>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#0a0a0a]">
        <span className="text-[11px] font-semibold tracking-wide" style={{ color: accent }}>{tonality.toUpperCase()}</span>
      </div>
      <div className="space-y-2 p-2">
        {visibleLevels.map(level => {
          const allChecked = level.chords.every(c => checkedSet.has(c.label));
          const someChecked = level.chords.some(c => checkedSet.has(c.label));
          return (
            <div key={level.name} className="border border-[#1a1a1a] rounded overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[#0e0e0e]">
                <span className="text-xs text-[#888] font-medium flex-1">{level.name}</span>
                <span className="text-[10px] text-[#444]">{level.chords.filter(c => checkedSet.has(c.label)).length}/{level.chords.length}</span>
                <button onClick={() => setLevel(level.chords, !allChecked)}
                  className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                    allChecked ? "" : someChecked ? "border-[#444] text-[#888]" : "border-[#222] text-[#555]"
                  }`}
                  style={allChecked ? { borderColor: accent, color: accent } : undefined}>
                  {allChecked ? "Clear" : "All"}
                </button>
              </div>
              <div className="grid gap-1 p-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4">
                {level.chords.map(entry => {
                  const isChecked = checkedSet.has(entry.label);
                  const enabledApproaches = new Set(approachMap[entry.label] ?? []);
                  const TONIC_LABELS = new Set(["I", "i", "I°", "i°", "I+", "i+"]);
                  const isTonic = TONIC_LABELS.has(entry.label) || (entry.steps != null && entry.steps[0] === 0);
                  const showApproaches = !isTonic && level.name !== "Modal Interchange";
                  return (
                    <div key={entry.label}
                      className="rounded overflow-hidden border transition-colors flex flex-col"
                      style={isChecked
                        ? { background: accent + "30", borderColor: accent }
                        : { background: "#141414", borderColor: "#1a1a1a" }}>
                      <button onClick={() => toggleChord(entry.label)}
                        className={`w-full text-left px-2 py-1 text-xs transition-colors ${
                          isChecked ? "" : "text-[#666] hover:text-[#888]"
                        }`}
                        style={isChecked ? { color: accent } : undefined}>
                        {entry.label}
                      </button>
                      {showApproaches && (
                        <div className="flex gap-0.5 px-1 py-1">
                          {APPROACH_KINDS.map(k => {
                            const on = enabledApproaches.has(k);
                            const color = APPROACH_COLORS[k];
                            return (
                              <button key={k}
                                disabled={!isChecked}
                                onClick={() => toggleApproach(entry.label, k)}
                                title={isChecked ? `${APPROACH_LABELS[k]}${entry.label}` : `Enable ${entry.label} first`}
                                className={`flex-1 text-[8px] leading-none py-0.5 rounded border transition-colors ${
                                  !isChecked ? "opacity-40 cursor-not-allowed bg-[#0e0e0e] text-[#444] border-[#222]"
                                  : on ? "text-black font-semibold"
                                  : "bg-[#1a1a1a] text-[#888] border-[#333] hover:text-[#ddd] hover:border-[#555]"
                                }`}
                                style={isChecked && on ? { background: color, borderColor: color } : undefined}>
                                {APPROACH_LABELS[k]}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {(() => {
                        const xenSteps = entry.steps ?? baseMap[entry.label] ?? null;
                        const xenAvail = xenSteps ? applicableXenKinds(xenSteps, edo) : [];
                        if (xenAvail.length === 0) return null;
                        const enabledXen = new Set(xenMap[entry.label] ?? []);
                        return (
                          <div className="flex gap-0.5 px-1 py-1 mt-auto">
                            {xenAvail.map(k => {
                              const on = enabledXen.has(k);
                              const color = XEN_COLOR[k];
                              return (
                                <button key={k}
                                  disabled={!isChecked}
                                  onClick={() => toggleXen(entry.label, k)}
                                  title={isChecked
                                    ? `${entry.label} with ${k === "neu" ? "neutral" : k === "sub" ? "subminor" : k === "sup" ? "supermajor" : k === "qrt" ? "quartal" : "quintal"} variant`
                                    : `Enable ${entry.label} first`}
                                  className={`flex-1 text-[9px] leading-none py-0.5 rounded border transition-colors ${
                                    !isChecked ? "opacity-40 cursor-not-allowed bg-[#0e0e0e] text-[#444] border-[#222]"
                                    : on ? "text-black font-semibold"
                                    : "bg-[#141414] text-[#888] border-[#333] hover:text-[#ddd] hover:border-[#555]"
                                  }`}
                                  style={isChecked && on ? { background: color, borderColor: color } : undefined}>
                                  {XEN_LABEL[k]}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
