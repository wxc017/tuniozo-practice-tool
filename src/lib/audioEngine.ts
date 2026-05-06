// ── Audio Engine ─────────────────────────────────────────────────────
// All note values are ABSOLUTE: C4 = 4*EDO (e.g. 124 for 31-EDO)

const C4_FREQ = 261.63;

// Drone harmonic amplitudes.
//
// CELLO_REAL is a cello-bowing spectrum (per direct user direction
// 2026-05-05): wider partial spread than the tambura, with the 2nd
// through 6th harmonics carrying significant energy — that's where
// the "warm, reedy" cello body sits.  The 7th + 9th harmonics are
// noticeably present too (cello has a faintly buzzy edge).  Above
// h12 things drop off into "air" but stay non-zero.
//
// Reference shape (normalized):  h1:1.00  h2:0.85  h3:0.70  h4:0.62
//   h5:0.50  h6:0.40  h7:0.30  h8:0.22  h9:0.18  h10:0.14  h11:0.10
//   h12:0.07  h13:0.05  h14:0.035  h15:0.025  h16:0.018  h17+ trace.
//
// TAMBURA_REAL is kept as the legacy export (still used by the
// per-note gain ramp in startRatioDrone), but the drone synth itself
// now selects CELLO_REAL.
const CELLO_REAL = new Float32Array([
  0,
  1.00,    0.85,    0.70,    0.62,    0.50,    0.40,    0.30,    0.22,    0.18,    0.14,
  0.10,    0.07,    0.05,    0.035,   0.025,   0.018,   0.012,   0.008,   0.005,   0.003,
]);
const CELLO_IMAG = new Float32Array(CELLO_REAL.length); // cosine phases — even harmonic content stays in-phase

const TAMBURA_REAL = new Float32Array([
  0,
  1.00,    0.55,    0.30,    0.16,    0.09,    0.05,    0.030,   0.015,   0.008,   0.004,
  0.0022,  0.0012,  0.00067, 0.00037, 0.00020, 0.00011, 0.00006, 0.000034,0.000019,0.00001,
]);
const TAMBURA_IMAG = new Float32Array(TAMBURA_REAL.length); // all zeros = cosine phases

// Sampled drone instruments — per direct user direction (2026-05-05),
// the synthesized PeriodicWave drone sounded "alien", so the drone now
// streams real instrument samples and pitch-shifts via playbackRate.
//
// Sources, picked per-instrument for highest fidelity:
//   • Philharmonia Orchestra (skratchdot/philharmonia-samples mirror,
//     CC-BY-SA, jsDelivr) — pro-recorded chromatic strings.  Used for
//     cello and double bass: dense maps (~1-semitone resolution),
//     arco-normal forte articulation, ~13-20 KB MP3 per note.  Pitch
//     shift between samples stays ≤ 1 semitone so the loop region
//     doesn't warp audibly.
//   • tonejs-instruments (nbrosowsky/tonejs-instruments, MIT,
//     GitHub Pages) — 4-per-octave MP3s for violin and church organ.
//     Far better than MusyngKite's 3-points-total density.
//   • MusyngKite SoundFont (gleitz/midi-js-soundfonts, GitHub Pages) —
//     used as the legacy fallback for ensemble/choir/voice/pad
//     instruments where no comparable free real-recording exists.
//
// Each instrument loads lazily on first selection.  The drone synth
// falls back to the PeriodicWave path if a drone fires before the
// samples finish loading.

const PHILHARMONIA_BASE = "https://cdn.jsdelivr.net/gh/skratchdot/philharmonia-samples@gh-pages/audio/";
const TONEJS_BASE       = "https://nbrosowsky.github.io/tonejs-instruments/samples/";
const MUSYNGKITE_BASE   = "https://gleitz.github.io/midi-js-soundfonts/MusyngKite/";
// Direct-from-Freesound CC0 single-recording sources for instruments
// that have no chromatic free mirror.  Each is a real human-played /
// human-sung recording — far higher fidelity than the synthesized
// MusyngKite SoundFont they replace.  All four URLs were curl-tested
// (200 OK, audio/mpeg, Access-Control-Allow-Origin: *) at integration
// time.  Single sample point per instrument; the crossfade looper
// (spawnSampleLoop) handles the wider runtime pitch-shift gracefully
// because tanpura/sitar/bagpipe/choir textures survive ±6-semitone
// shifts well — the user explicitly requested this trade-off
// (2026-05-05): "they can stay in one octave as well as drones
// aren't all over the place for octaves".
const FREESOUND_TANPURA_URL = "https://cdn.freesound.org/previews/416/416605_2112203-hq.mp3";
const FREESOUND_BAGPIPE_URL = "https://cdn.freesound.org/previews/622/622929_931745-hq.mp3";
const FREESOUND_CHOIR_URL   = "https://cdn.freesound.org/previews/763/763910_11744683-hq.mp3";
// Real cello drone — Freesound 77764, xserra's `cello-G2-up-bow.wav`.
// CC-BY 4.0, 12.0 s, real bowed open G string at G2 (MIDI 43) with
// ZERO cents pitch drift and strong harmonic content (H3 only -1 dB
// below H1 — perfect for tuning practice).  Replaces the Philharmonia
// non-vibrato C2_phrase which only had a single low-octave sample;
// G2 puts most user tonics within ±6 semitones of the source.
const FREESOUND_CELLO_URL   = "https://cdn.freesound.org/previews/77/77764_43-hq.mp3";
// Real human voice — Freesound 110423, Mafon2's "FEMALE VOCAL UNISONO
// E 02".  CC-BY 4.0, 6.16 s, perfectly steady E4 (MIDI 64) with
// audible partials (H2 essentially equal to H1, H3 -10 dB).
// Replaces Freesound 555984 (CC0 but H2 was -30 dB below H1, so the
// user couldn't hear partials — direct feedback 2026-05-05: "voice
// sample isnt high quality enough can't hear partials well").
const FREESOUND_VOICE_URL   = "https://cdn.freesound.org/previews/110/110423_14771-hq.mp3";

/** Curated drone instrument list — canonical drones from the world
 *  music traditions per direct user direction (2026-05-05): cello +
 *  tanpura-class + harmonium / sruti-box + bagpipe + voice + organ.
 *  Skipped violin / pad / strings ensemble — those aren't drone
 *  instruments in the traditional sense.  Source dispatch
 *  (Philharmonia / tonejs / MusyngKite) lives in INSTRUMENT_SOURCES. */
export const DRONE_INSTRUMENTS = [
  { id: "tanpura",            label: "Tanpura" },
  { id: "harmonium",          label: "Harmonium" },
  { id: "cello",              label: "Cello" },
  { id: "bagpipe",            label: "Bagpipe" },
  { id: "voice_oohs",         label: "Voice" },
  { id: "choir_aahs",         label: "Choir" },
  { id: "church_organ",       label: "Church Organ" },
] as const;

export type DroneInstrument = typeof DRONE_INSTRUMENTS[number]["id"];

interface InstrumentSample { midi: number; buffer: AudioBuffer }

/** Build a synthesized hall reverb impulse response — stereo, with
 *  decorrelated noise channels so the reverb sounds wide rather than
 *  centered.  Exponential decay with `decay` controlling how fast the
 *  tail dies out (higher = longer tail).  Used by the reverb send in
 *  init() / getCtx(); 2 seconds at decay=2.5 gives a roomy, vocal-pad-
 *  friendly hall without competing with the dry signal. */
function makeHallImpulse(ctx: AudioContext, durationSec: number, decay: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * durationSec);
  const buffer = ctx.createBuffer(2, length, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // Decorrelated white noise with exponential decay.  Subtle
      // pre-emphasis on early reflections (first ~40 ms) gives the
      // tail a sense of room size without explicit early-reflection
      // taps.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return buffer;
}

// Note-label parsing.  Both Philharmonia and tonejs-instruments use the
// same convention — sharps as `s` suffix (e.g. "Cs3", "Fs4") and a
// trailing octave number where C4 = MIDI 60.  MusyngKite uses the same
// for its 3-point set (C2/C4/C5), so a single parser handles all sources.
const NOTE_SEMITONE_OFFSET: Record<string, number> = {
  C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11,
};
function noteLabelToMidi(label: string): number {
  const m = label.match(/^([A-G]s?)(-?\d)$/);
  if (!m) throw new Error(`audioEngine: bad note label "${label}"`);
  return (Number(m[2]) + 1) * 12 + NOTE_SEMITONE_OFFSET[m[1]];
}

/** Per-instrument source config: which CDN, what URL pattern, which
 *  notes to fetch.  Sample-note picks aim for ≤ 3-semitone gaps so any
 *  drone target lands within a small pitch-shift of an actual recorded
 *  pitch (close enough that the loop region doesn't audibly chipmunk).
 *
 *  trimGain (default 1.0) is a per-instrument loudness-normalisation
 *  multiplier applied at sample-spawn time.  Different recordings have
 *  wildly different recorded peaks — the Freesound tanpura is much
 *  quieter than Philharmonia cello — so we bake a static boost into
 *  the source config rather than asking the user to ride the slider
 *  on every instrument switch. */
interface SourceConfig {
  url: (note: string) => string;
  notes: readonly string[];
  trimGain?: number;
}

const INSTRUMENT_SOURCES: Record<DroneInstrument, SourceConfig> = {
  // Freesound CC0 tanpura — single C#3 sample, pitched at runtime.
  // The url builder ignores the note arg (we always fetch the same
  // file); the notes array carries one label so noteLabelToMidi tags
  // the buffer at MIDI 49 (C#3) for the closest-sample picker.
  tanpura: {
    url: () => FREESOUND_TANPURA_URL,
    notes: ["Cs3"],
    // Freesound 416605 was recorded conservatively (peak ~0.25);
    // boost ×4 to bring it up to roughly Philharmonia / tonejs
    // levels.  Limiter on the play path will clip any over-the-top
    // peaks gracefully.
    trimGain: 4.0,
  },
  // Philharmonia: pro-recorded chromatic cello.  `_15_` = 1.5-second
  // sustain (longer than the default 1s) — gives the crossfade looper
  // a steadier middle to anchor on before the release-tail fade.
  // Real cello drone (Freesound 77764, xserra, CC-BY 4.0).  Open G
  // string up-bow, 12 s, zero cents pitch drift, H3 only -1 dB below
  // H1 — exactly the steady tone with audible partials needed for
  // tuning / improv / scales practice.  G2 (MIDI 43) keeps most user
  // tonics within ±6 semitones of the source pitch.
  cello: {
    url: () => FREESOUND_CELLO_URL,
    notes: ["G2"],
    trimGain: 1.3,
  },
  // tonejs-instruments harmonium: nearly-chromatic C2-G4.  The Indian
  // sruti-box / harmonium is a canonical drone — sustained bellows-
  // pumped reeds with constant timbre, ideal for tonic+5th holds.
  harmonium: {
    url: n => `${TONEJS_BASE}harmonium/${n}.mp3`,
    notes: ["C2", "Ds2", "Fs2", "A2", "C3", "Ds3", "Fs3", "A3", "C4", "Ds4", "Fs4", "A4"],
  },
  // tonejs-instruments organ: A/C/Ds/Fs across octaves 1-5 — denser
  // than MusyngKite's 3-point map and warmer than Philharmonia organ
  // (which isn't in the mirror anyway).
  church_organ: {
    url: n => `${TONEJS_BASE}organ/${n}.mp3`,
    notes: ["C2", "Ds2", "Fs2", "A2", "C3", "Ds3", "Fs3", "A3", "C4", "Ds4", "Fs4", "A4", "C5"],
  },
  // Real-instrument single-sample drone sources from Freesound (CC0).
  // Replaces the MusyngKite SoundFont versions per direct user
  // direction (2026-05-05): "high quality samples for all".  Pitch
  // tags below are the recorded fundamentals — the closest-sample
  // picker uses these for the runtime pitch shift.
  bagpipe: {
    // Freesound 622929, 3:00 of sustained Highland-pipe drone at C.
    url: () => FREESOUND_BAGPIPE_URL,
    notes: ["C3"],
    trimGain: 1.5,
  },
  choir_aahs: {
    // Freesound 763910, ~5 s of multi-voice sustained "aah" at F.
    // Crowd-singing rather than a trained choir, but a real recording
    // and the only CC0 multi-voice source we found.
    url: () => FREESOUND_CHOIR_URL,
    notes: ["F3"],
    trimGain: 2.0,
  },
  voice_oohs: {
    // Freesound 110423 (Mafon2, CC-BY 4.0), 6.16 s steady E4 with
    // audible partials.
    url: () => FREESOUND_VOICE_URL,
    notes: ["E4"],
    trimGain: 1.5,
  },
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sampleBuffer: AudioBuffer | null = null;
  private instrumentSamples: Map<string, InstrumentSample[]> = new Map();
  private instrumentLoadPromises: Map<string, Promise<void>> = new Map();
  private currentInstrument: DroneInstrument = "tanpura";
  private droneNodes: OscillatorNode[] = [];
  private droneSamples: AudioBufferSourceNode[] = [];
  // Crossfade looper timers — see spawnSampleLoop().  Tracked here so
  // stopDrone can cancel pending re-fires before they spawn unnecessary
  // BufferSources.
  private droneLoopTimers: ReturnType<typeof setTimeout>[] = [];
  // Generation counter — incremented on every startDrone() and on
  // stopDrone().  Any pending async startDrone that's awaiting sample
  // loading checks this counter after the await; if the generation
  // changed, the start is cancelled.  This is what makes OFF actually
  // stop a drone whose samples are still loading.
  private droneGeneration = 0;
  private droneNoteGains: GainNode[] = [];
  private droneGainNode: GainNode | null = null;
  private intervalDrones: Map<string, { osc: OscillatorNode; gain: GainNode }> = new Map();
  private intervalDroneMaster: GainNode | null = null;
  private playGainNode: GainNode | null = null;
  private playLimiter: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  // Reverb send (parallel wet path).  Dry signal flows playLimiter →
  // masterGain at unity; the wet copy goes through a ConvolverNode
  // with a synthesized hall IR, scaled by reverbWetGain.  Default
  // wet = 0 so reverb is fully bypassed unless a tab opts in
  // (ScalarTab exposes a dry/wet knob — per direct user direction
  // 2026-05-05).
  private reverbConvolver: ConvolverNode | null = null;
  private reverbWetGain: GainNode | null = null;

  async init(edo: number = 31) {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.85;
    this.masterGain.connect(this.ctx.destination);

    // Limiter on play path to prevent clipping from overlapping chords
    this.playLimiter = this.ctx.createDynamicsCompressor();
    this.playLimiter.threshold.value = -3;
    this.playLimiter.knee.value = 10;
    this.playLimiter.ratio.value = 4;
    this.playLimiter.attack.value = 0.01;
    this.playLimiter.release.value = 0.25;
    this.playLimiter.connect(this.masterGain);

    this.playGainNode = this.ctx.createGain();
    this.playGainNode.gain.value = 1.0;
    this.playGainNode.connect(this.playLimiter);

    // Reverb send: synthesize a 2-second hall IR (decorrelated stereo
    // noise with exponential decay) once at init time, then keep the
    // wet-send muted by default so tabs that don't want reverb pay no
    // CPU cost.  setReverbWet(0..1) opens the wet send.
    this.reverbConvolver = this.ctx.createConvolver();
    this.reverbConvolver.normalize = true;
    this.reverbConvolver.buffer = makeHallImpulse(this.ctx, 2.0, 2.5);
    this.reverbWetGain = this.ctx.createGain();
    this.reverbWetGain.gain.value = 0;
    this.playLimiter.connect(this.reverbConvolver);
    this.reverbConvolver.connect(this.reverbWetGain);
    this.reverbWetGain.connect(this.masterGain);

    try {
      const base = import.meta.env.BASE_URL ?? "/";
      const resp = await fetch(`${base}C4.wav`);
      const arr = await resp.arrayBuffer();
      this.sampleBuffer = await this.ctx.decodeAudioData(arr);
    } catch (e) {
      console.warn("C4.wav not loaded, using synth fallback", e);
    }

    // Kick off default-instrument sample loading in the background.  We
    // don't await it here so init() returns promptly; the drone synth
    // will fall back to the PeriodicWave path if a drone fires before
    // the samples finish loading.
    this.loadInstrumentSamples(this.currentInstrument);
  }

  /** Switch the active drone instrument.  Triggers lazy sample loading
   *  for the new instrument; does NOT restart any active drone — the
   *  caller decides whether to fade and restart.  Falls back to the
   *  default ("cello") if a stale localStorage value names an
   *  instrument that's no longer in the catalog. */
  setInstrument(instrument: DroneInstrument) {
    const valid = (instrument in INSTRUMENT_SOURCES) ? instrument : "cello";
    this.currentInstrument = valid;
    if (this.ctx) this.loadInstrumentSamples(valid);
  }

  getInstrument(): DroneInstrument { return this.currentInstrument; }

  /** Type guard for stale localStorage values — components should snap
   *  to the default if their persisted instrument id isn't in the
   *  current catalog. */
  static isValidInstrument(id: string): id is DroneInstrument {
    return id in INSTRUMENT_SOURCES;
  }

  /** Fetch a multi-sampled instrument from its configured source
   *  (Philharmonia / tonejs / MusyngKite — see INSTRUMENT_SOURCES).
   *  Runs once per (AudioContext × instrument); subsequent calls return
   *  the existing promise.  Failures are warned but non-fatal — the
   *  synth falls back to the PeriodicWave drone if no samples loaded. */
  private loadInstrumentSamples(instrument: DroneInstrument): Promise<void> {
    const existing = this.instrumentLoadPromises.get(instrument);
    if (existing) return existing;
    if (!this.ctx) return Promise.resolve();
    const ctx = this.ctx;
    const cfg = INSTRUMENT_SOURCES[instrument];
    const samples: InstrumentSample[] = [];
    this.instrumentSamples.set(instrument, samples);
    const promise = (async () => {
      const loads = cfg.notes.map(async note => {
        try {
          const resp = await fetch(cfg.url(note));
          if (!resp.ok) throw new Error(`fetch failed ${resp.status}`);
          const arr = await resp.arrayBuffer();
          const buf = await ctx.decodeAudioData(arr);
          samples.push({ midi: noteLabelToMidi(note), buffer: buf });
        } catch (e) {
          console.warn(`${instrument} sample ${note} failed to load`, e);
        }
      });
      await Promise.all(loads);
      // Sort by MIDI ascending so pickClosestSample's lookup is simple.
      samples.sort((a, b) => a.midi - b.midi);
    })();
    this.instrumentLoadPromises.set(instrument, promise);
    return promise;
  }

  /** Pick whichever loaded sample of the current instrument is closest
   *  to the target MIDI pitch, plus the playbackRate needed to retune
   *  it.  Returns null when no samples are loaded yet (caller falls
   *  back to synth). */
  private pickClosestSample(targetMidi: number): { buffer: AudioBuffer; rate: number } | null {
    const samples = this.instrumentSamples.get(this.currentInstrument);
    if (!samples || samples.length === 0) return null;
    let best = samples[0];
    let bestDist = Math.abs(targetMidi - best.midi);
    for (const s of samples) {
      const d = Math.abs(targetMidi - s.midi);
      if (d < bestDist) { best = s; bestDist = d; }
    }
    // playbackRate of 2^(semitones/12) shifts the sample to the target.
    const rate = Math.pow(2, (targetMidi - best.midi) / 12);
    return { buffer: best.buffer, rate };
  }

  private hasLoadedSamples(): boolean {
    const samples = this.instrumentSamples.get(this.currentInstrument);
    return !!samples && samples.length > 0;
  }

  /** Convert a frequency in Hz to a fractional MIDI number (A4=440 → 69). */
  private freqToMidi(freq: number): number {
    return 69 + 12 * Math.log2(freq / 440);
  }

  async resume() { await this.ctx?.resume(); }

  private getCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.85;
      this.masterGain.connect(this.ctx.destination);

      this.playLimiter = this.ctx.createDynamicsCompressor();
      this.playLimiter.threshold.value = -3;
      this.playLimiter.knee.value = 10;
      this.playLimiter.ratio.value = 4;
      this.playLimiter.attack.value = 0.01;
      this.playLimiter.release.value = 0.25;
      this.playLimiter.connect(this.masterGain);

      this.playGainNode = this.ctx.createGain();
      this.playGainNode.gain.value = 1.0;
      this.playGainNode.connect(this.playLimiter);

      // Mirror the reverb send graph from init() — this branch fires
      // when getCtx() lazily rebuilds the AudioContext after stopAll().
      this.reverbConvolver = this.ctx.createConvolver();
      this.reverbConvolver.normalize = true;
      this.reverbConvolver.buffer = makeHallImpulse(this.ctx, 2.0, 2.5);
      this.reverbWetGain = this.ctx.createGain();
      this.reverbWetGain.gain.value = 0;
      this.playLimiter.connect(this.reverbConvolver);
      this.reverbConvolver.connect(this.reverbWetGain);
      this.reverbWetGain.connect(this.masterGain);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Set reverb wet level (0 = bypass, 1 = full hall on top of dry).
   *  The dry path stays at unity — this is an additive send, not a
   *  crossfade — so increasing wet adds reverb without quieting the
   *  direct signal.  Smoothed to avoid clicks. */
  setReverbWet(level: number) {
    if (!this.reverbWetGain) return;
    const clamped = Math.max(0, Math.min(1, level));
    this.reverbWetGain.gain.setTargetAtTime(clamped, this.getCtx().currentTime, 0.05);
  }

  getReverbWet(): number {
    return this.reverbWetGain?.gain.value ?? 0;
  }

  // abs = absolute pitch step; pitch 0 = C4 reference (ch4/MIDI0 on Lumatone)
  private absToRate(abs: number, edo: number): number {
    return Math.pow(2, abs / edo);
  }

  private absToFreq(abs: number, edo: number): number {
    return C4_FREQ * this.absToRate(abs, edo);
  }

  // Equal-loudness compensation (Fletcher-Munson approximation).
  // Boost gain ~3 dB (×1.41) per octave below C4 to offset the ear's
  // reduced sensitivity at lower frequencies. Capped at ×4 (≈8 octaves).
  private elBoost(abs: number, edo: number): number {
    if (abs >= 0) return 1;
    const octavesDown = -abs / edo;
    return Math.min(4, Math.pow(1.41, octavesDown));
  }

  private getPlayDest(): AudioNode {
    const ctx = this.getCtx();
    if (this.playGainNode) return this.playGainNode;
    return this.masterGain ?? ctx.destination;
  }

  private scheduleNote(
    abs: number, edo: number,
    startTime: number, duration: number, gain: number,
    // Optional hard cap on when this note must be fully released.  Used
    // by sequence/multi-voice schedulers to prevent chord N from bleeding
    // into chord N+1: pass the next slot's start time and the release
    // gets compressed to fit, even if (duration + naturalRelease) would
    // overrun the slot.  Without this cap, the note rings out naturally
    // past `duration` (single-shot chord behaviour).
    maxEndTime?: number,
  ) {
    const ctx = this.getCtx();
    const adjusted = Math.min(1.0, gain * this.elBoost(abs, edo));
    const g = ctx.createGain();

    const attack = 0.02;
    const naturalRelease = 0.25;
    const sustainEnd = startTime + duration;
    const naturalEnd = sustainEnd + naturalRelease;
    const endTime = maxEndTime !== undefined ? Math.min(naturalEnd, maxEndTime) : naturalEnd;
    // Release fits between sustain end and envelope end; minimum 20ms so
    // we don't get a click.  If the slot is so tight that it eats into
    // the sustain, the sustain shortens but we keep a usable release.
    const releaseLen = Math.max(0.02, endTime - sustainEnd);
    const releaseStart = Math.max(startTime + attack, endTime - releaseLen);

    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(adjusted, startTime + attack);
    g.gain.setValueAtTime(adjusted, releaseStart);
    g.gain.exponentialRampToValueAtTime(0.0001, endTime);
    g.connect(this.getPlayDest());

    const stopAt = endTime + 0.02;
    if (this.sampleBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.sampleBuffer;
      src.playbackRate.value = this.absToRate(abs, edo);
      src.connect(g);
      src.start(startTime);
      src.stop(stopAt);
    } else {
      // Sawtooth oscillator — has a richer overtone series than a
      // plain triangle so close-pitched scales (e.g. quarter-tone
      // neighbours in 31-EDO) sound clearly distinct, but is more
      // reliable than a per-note PeriodicWave.
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = this.absToFreq(abs, edo);
      osc.connect(g);
      osc.start(startTime);
      osc.stop(stopAt);
    }
  }

  playNote(abs: number, edo: number, duration = 1.0, gain = 0.8) {
    const ctx = this.getCtx();
    this.scheduleNote(abs, edo, ctx.currentTime + 0.02, duration, gain);
  }

  playChord(notes: number[], edo: number, duration = 1.2, gain = 0.65) {
    if (!notes.length) return;
    const ctx = this.getCtx();
    const t = ctx.currentTime + 0.02;
    const g = gain / Math.sqrt(notes.length);
    notes.forEach(n => this.scheduleNote(n, edo, t, duration, g));
  }

  // Play a sequence of chords/notes. Each element is an array (monophonic = single-element arrays)
  playSequence(
    frames: number[][], edo: number,
    gapMs = 700, noteDuration = 0.9, gain = 0.7
  ) {
    const ctx = this.getCtx();
    const gap = gapMs / 1000;
    let t = ctx.currentTime + 0.05;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const g = gain / Math.sqrt(Math.max(1, frame.length));
      // Each note must fully die out, with audible silence before the
      // next chord starts.  Cap the audible end to ~70% of the slot so
      // the trailing 30% is true silence — no bleed, no overlap, just
      // chord → fade → silence → next chord.  The last frame has no
      // successor and gets a full natural ring-out.
      const isLast = i === frames.length - 1;
      const maxEnd = isLast ? undefined : t + gap * 0.7;
      frame.forEach(n => this.scheduleNote(n, edo, t, noteDuration, g, maxEnd));
      t += gap;
    }
  }

  // Play multiple independent voice sequences time-aligned to the same chord grid.
  // Each voice has its own frames, note duration, and gain.
  // If a voice has more frames than chordCount, frames are subdivided evenly within each slot.
  playMultiVoice(
    voices: { frames: number[][]; noteDuration: number; gain: number }[],
    edo: number,
    gapMs: number,
    chordCount: number
  ) {
    const ctx = this.getCtx();
    const gap = gapMs / 1000;
    const t0 = ctx.currentTime + 0.05;
    for (const voice of voices) {
      if (!voice.frames.length) continue;
      const subdivs = Math.max(1, Math.ceil(voice.frames.length / chordCount));
      const subGap = gap / subdivs;
      let t = t0;
      for (let i = 0; i < voice.frames.length; i++) {
        const frame = voice.frames[i];
        const g = voice.gain / Math.sqrt(Math.max(1, frame.length));
        // Each note must fully die out before the next slot starts —
        // chord → fade → silence → next chord.  Cap to ~70% of the
        // sub-slot so the trailing 30% is true silence.  Applies to
        // every voice (chord, bass, melody) so bass can't ring across
        // the bar either.  The last note in the loop gets a full
        // natural ring-out (no successor).
        const isLast = i === voice.frames.length - 1;
        const maxEnd = isLast ? undefined : t + subGap * 0.7;
        frame.forEach(n => this.scheduleNote(n, edo, t, voice.noteDuration, g, maxEnd));
        t += subGap;
        // Reset to next chord slot boundary
        if ((i + 1) % subdivs === 0) {
          const slotIdx = Math.floor((i + 1) / subdivs);
          t = t0 + slotIdx * gap;
        }
      }
    }
  }

  // Cello-style sustained drone (per direct user direction 2026-05-05):
  // bowed-string spectrum (CELLO_REAL) with subtle vibrato per voice.
  // One PeriodicWave oscillator per note carries the harmonic spectrum;
  // a slow LFO (~4.5 Hz, ~5 cent depth) modulates each oscillator's
  // detune to give the drone a living, slightly-vibrato feel rather
  // than a static organ-like sustain.  All vibrato LFOs are tracked
  // alongside the main oscillators so stopDrone() can shut them down.
  /** Start the drone with one or more EDO-step pitches.  Async because
   *  it awaits the active instrument's sample load promise — without
   *  that wait, the drone falls back to a PeriodicWave synth on first
   *  play (race: user clicks ON before the lazy fetch completes), and
   *  every instrument sounds like a sine wave.  Per direct user
   *  feedback (2026-05-05): the previous sync version was the root
   *  cause of the cello/sitar/bagpipe/voice "soundwave" complaints. */
  async startDrone(notes: number[], edo: number, gain = 0.4, perNoteGains?: number[]) {
    // Stop any existing drone synchronously.  The previous version
    // used fadeDrone(150) which scheduled a stopDrone() setTimeout 150ms
    // out — that timeout fired AFTER the new drone was spawned and
    // killed it (also bumping droneGeneration).  Result: lattice-node
    // clicks produced silence (per direct user feedback 2026-05-05).
    this.stopDrone();
    const myGen = ++this.droneGeneration;
    const ctx = this.getCtx();

    // Wait up to 5s for the active instrument's samples to be ready.
    // If they don't arrive in time we fall through and use the synth
    // fallback so the drone makes *some* sound rather than silence.
    await this.waitForSamples(5000);

    // If stopDrone() or another startDrone() bumped the generation
    // while we were awaiting, abort — the user pressed OFF or
    // switched instruments before our samples were ready.
    if (myGen !== this.droneGeneration) return;

    this.droneGainNode = ctx.createGain();
    this.droneGainNode.gain.value = gain;
    this.droneGainNode.connect(this.masterGain ?? ctx.destination);

    const useSamples = this.hasLoadedSamples();
    // Always create the PeriodicWave so spawnDroneVoice has a fallback
    // even if pickClosestSample returns null mid-flight.
    const wave = ctx.createPeriodicWave(CELLO_REAL, CELLO_IMAG, { disableNormalization: false });
    const trim = INSTRUMENT_SOURCES[this.currentInstrument]?.trimGain ?? 1.0;

    for (let i = 0; i < notes.length; i++) {
      const noteGain = ctx.createGain();
      noteGain.gain.value = (perNoteGains?.[i] ?? 1.0) * trim;
      noteGain.connect(this.droneGainNode);

      const freq = this.absToFreq(notes[i], edo);
      this.spawnDroneVoice(ctx, freq, noteGain, useSamples, wave);
      this.droneNoteGains.push(noteGain);
    }
  }

  /** Resolve when the current instrument's samples are loaded, or the
   *  given timeout elapses (whichever is first).  Used by startDrone /
   *  startRatioDrone so the first play doesn't race the lazy fetch. */
  private async waitForSamples(timeoutMs: number): Promise<void> {
    const promise = this.instrumentLoadPromises.get(this.currentInstrument);
    if (!promise) return;
    if (this.hasLoadedSamples()) return;
    await Promise.race([
      promise,
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /** Spawn one drone voice — either a crossfade-looped instrument
   *  sample pitched to `targetFreq`, or a PeriodicWave oscillator with
   *  vibrato.  All generated nodes get pushed onto droneNodes /
   *  droneSamples so stopDrone() tears them down cleanly. */
  private spawnDroneVoice(ctx: AudioContext, targetFreq: number, noteGain: GainNode, useSamples: boolean, wave: PeriodicWave | null) {
    if (useSamples) {
      const targetMidi = this.freqToMidi(targetFreq);
      const pick = this.pickClosestSample(targetMidi);
      if (pick) {
        this.spawnSampleLoop(ctx, pick.buffer, pick.rate, noteGain);
        return;
      }
      // pickClosestSample returned null even though useSamples was
      // true — race condition during loading.  Fall through to synth.
    }
    if (wave) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = targetFreq;
      this.attachVibrato(osc, ctx);
      osc.connect(noteGain);
      osc.start();
      this.droneNodes.push(osc);
    }
  }

  /** Sample-based drone playback.
   *
   *  These are practice drones — the user holds them while improvising,
   *  tuning, or running scales.  Sustain reliability matters far more
   *  than transition smoothness, so we use the simplest possible
   *  looper: a single BufferSource with `src.loop = true` plus
   *  `loopStart` / `loopEnd` set to skip the attack and release tails
   *  of the recorded sample.
   *
   *  Why not crossfade two voices: the previous scheduler (setTimeout
   *  chain firing equal-power-faded voices) introduced audible dips
   *  the user reported as "cutting out", and its async scheduling
   *  raced with stopDrone() in ways that made OFF unreliable.  A
   *  single looped source has none of those problems — the only
   *  artifact is the loop-point seam, which on a steady tonic
   *  recording is much less noticeable than the crossfade dropout. */
  private spawnSampleLoop(ctx: AudioContext, buffer: AudioBuffer, rate: number, noteGain: GainNode) {
    const bufDur = buffer.duration;
    // Trim the attack transient (start) and release tail (end).  These
    // numbers err on the side of trimming aggressively — we'd rather
    // lose a bit of sample material than have an audible bow / pluck /
    // breath re-articulation at every loop point.
    const trimAttack = bufDur >= 1.0 ? Math.min(0.4, bufDur * 0.15) : 0.05;
    const trimRelease = bufDur >= 1.0 ? Math.min(0.4, bufDur * 0.1) : 0;
    const loopStart = trimAttack;
    const loopEnd = Math.max(loopStart + 0.3, bufDur - trimRelease);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = loopStart;
    src.loopEnd = loopEnd;
    src.playbackRate.value = rate;
    src.connect(noteGain);
    // Start playback inside the loop region so the user hears steady
    // sustain immediately (not the recorded attack).
    src.start(0, loopStart);
    this.droneSamples.push(src);
  }

  /** Attach a slow ~4.5 Hz LFO to an oscillator's detune param so the
   *  drone gets cello-like vibrato instead of a static sustain.  Each
   *  voice picks an independent LFO phase via a small random rate
   *  jitter so multi-voice drones don't pulsate in lockstep.  The LFO
   *  oscillators are pushed onto droneNodes so stopDrone() tears them
   *  down with the rest of the drone graph. */
  private attachVibrato(target: OscillatorNode, ctx: AudioContext) {
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 4.4 + Math.random() * 0.4; // 4.4–4.8 Hz, slight per-voice spread
    const depth = ctx.createGain();
    depth.gain.value = 5;  // ±5 cents — subtle, classical-sounding
    lfo.connect(depth);
    depth.connect(target.detune);
    lfo.start();
    this.droneNodes.push(lfo);
  }

  stopDrone() {
    // Invalidate any in-flight async startDrone awaiting sample load.
    this.droneGeneration++;
    for (const t of this.droneLoopTimers) clearTimeout(t);
    this.droneLoopTimers = [];
    for (const osc of this.droneNodes) {
      try { osc.stop(); } catch {}
      try { osc.disconnect(); } catch {}
    }
    this.droneNodes = [];
    for (const src of this.droneSamples) {
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
    this.droneSamples = [];
    for (const g of this.droneNoteGains) {
      try { g.disconnect(); } catch {}
    }
    this.droneNoteGains = [];
    if (this.droneGainNode) {
      try { this.droneGainNode.disconnect(); } catch {}
      this.droneGainNode = null;
    }
  }

  /** Fade drone out over `durationMs` then stop and disconnect. */
  fadeDrone(durationMs = 800) {
    if (!this.droneGainNode) { this.stopDrone(); return; }
    const ctx = this.getCtx();
    const dur = durationMs / 1000;
    this.droneGainNode.gain.setTargetAtTime(0, ctx.currentTime, dur / 3);
    setTimeout(() => this.stopDrone(), durationMs);
  }

  setDroneGain(gain: number) {
    if (this.droneGainNode) {
      this.droneGainNode.gain.setTargetAtTime(gain, this.getCtx().currentTime, 0.05);
    }
  }

  setPlayGain(gain: number) {
    if (this.playGainNode) {
      this.playGainNode.gain.setTargetAtTime(gain, this.getCtx().currentTime, 0.05);
    }
  }

  /** Immediately silence all scheduled play notes (chords/sequences) by
   *  disconnecting the play gain node and creating a fresh one. Drones are unaffected. */
  silencePlay() {
    if (!this.playGainNode || !this.playLimiter) return;
    try { this.playGainNode.disconnect(); } catch {}
    const ctx = this.getCtx();
    this.playGainNode = ctx.createGain();
    this.playGainNode.gain.value = 1.0;
    this.playGainNode.connect(this.playLimiter);
  }

  /** Kill ALL sound: drones, scheduled notes, everything. Closes the
   *  AudioContext so every queued oscillator/buffer-source dies instantly.
   *  The sample will be reloaded on next init(). */
  stopAll() {
    this.stopDrone();
    for (const key of this.intervalDrones.keys()) this.stopIntervalDroneByKey(key);
    if (this.ctx) {
      try { this.ctx.close(); } catch {}
      this.ctx = null;
      this.masterGain = null;
      this.playLimiter = null;
      this.playGainNode = null;
      this.sampleBuffer = null;
    }
  }

  isDroneActive() { return this.droneNodes.length > 0; }
  isReady() { return !!this.ctx; }

  // ── Ratio-based API ─────────────────────────────────────────────────
  // All ratios are relative to C4 (1/1 = C4).
  // A ratio of 3/2 plays a just perfect fifth above C4, etc.
  // Ratios below 1 are pitches below C4.

  private elBoostRatio(ratio: number): number {
    if (ratio >= 1) return 1;
    const octavesDown = -Math.log2(ratio);
    return Math.min(4, Math.pow(1.41, octavesDown));
  }

  private scheduleRatioNote(
    ratio: number,
    startTime: number, duration: number, gain: number
  ) {
    const ctx = this.getCtx();
    const adjusted = Math.min(1.0, gain * this.elBoostRatio(ratio));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(adjusted, startTime + 0.02);
    g.gain.setValueAtTime(adjusted, startTime + Math.max(0, duration - 0.1));
    g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration + 0.25);
    g.connect(this.getPlayDest());

    if (this.sampleBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.sampleBuffer;
      src.playbackRate.value = ratio;
      src.connect(g);
      src.start(startTime);
      src.stop(startTime + duration + 0.5);
    } else {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = C4_FREQ * ratio;
      osc.connect(g);
      osc.start(startTime);
      osc.stop(startTime + duration + 0.3);
    }
  }

  playRatioNote(ratio: number, duration = 1.0, gain = 0.8) {
    const ctx = this.getCtx();
    this.scheduleRatioNote(ratio, ctx.currentTime + 0.02, duration, gain);
  }

  playRatioChord(ratios: number[], duration = 1.2, gain = 0.65) {
    if (!ratios.length) return;
    const ctx = this.getCtx();
    const t = ctx.currentTime + 0.02;
    const g = gain / Math.sqrt(ratios.length);
    ratios.forEach(r => this.scheduleRatioNote(r, t, duration, g));
  }

  playRatioSequence(
    frames: number[][], gapMs = 700, noteDuration = 0.9, gain = 0.7
  ) {
    const ctx = this.getCtx();
    const gap = gapMs / 1000;
    let t = ctx.currentTime + 0.05;
    for (const frame of frames) {
      const g = gain / Math.sqrt(Math.max(1, frame.length));
      frame.forEach(r => this.scheduleRatioNote(r, t, noteDuration, g));
      t += gap;
    }
  }

  async startRatioDrone(ratios: number[], gain = 0.4, baseFreq?: number, perNoteGains?: number[]) {
    this.stopDrone();
    const myGen = ++this.droneGeneration;
    const ctx = this.getCtx();

    // Same race-condition fix as startDrone — wait for samples to
    // load before deciding on the synth fallback.
    await this.waitForSamples(5000);
    if (myGen !== this.droneGeneration) return;

    this.droneGainNode = ctx.createGain();
    this.droneGainNode.gain.value = gain;
    this.droneGainNode.connect(this.masterGain ?? ctx.destination);

    const freq = baseFreq ?? C4_FREQ;
    const useSamples = this.hasLoadedSamples();
    // Always create the wave fallback so spawnDroneVoice can fall
    // through if pickClosestSample races.
    const wave = ctx.createPeriodicWave(CELLO_REAL, CELLO_IMAG, { disableNormalization: false });
    const trim = INSTRUMENT_SOURCES[this.currentInstrument]?.trimGain ?? 1.0;

    for (let i = 0; i < ratios.length; i++) {
      const noteGain = ctx.createGain();
      noteGain.gain.value = (perNoteGains?.[i] ?? 1.0) * trim;
      noteGain.connect(this.droneGainNode);

      this.spawnDroneVoice(ctx, freq * ratios[i], noteGain, useSamples, wave);
      this.droneNoteGains.push(noteGain);
    }
  }

  setDroneNoteGain(index: number, gain: number) {
    if (index >= 0 && index < this.droneNoteGains.length) {
      this.droneNoteGains[index].gain.setTargetAtTime(gain, this.getCtx().currentTime, 0.05);
    }
  }

  getDroneNoteCount() { return this.droneNoteGains.length; }

  // ── Separate interval drones (independent of main drone, multiple simultaneous) ──
  private ensureIntervalDroneMaster() {
    const ctx = this.getCtx();
    if (!this.intervalDroneMaster || this.intervalDroneMaster.context !== ctx) {
      // Limiter to prevent clipping when multiple drones stack
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 3;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.1;
      limiter.connect(this.masterGain ?? ctx.destination);
      this.intervalDroneMaster = ctx.createGain();
      this.intervalDroneMaster.gain.value = 0.15;
      this.intervalDroneMaster.connect(limiter);
    }
    return this.intervalDroneMaster;
  }

  startIntervalDrone(key: string, freq: number, gain = 1.0) {
    this.stopIntervalDroneByKey(key);
    const ctx = this.getCtx();
    const master = this.ensureIntervalDroneMaster();
    const noteGain = ctx.createGain();
    noteGain.gain.value = gain;
    noteGain.connect(master);

    // Cello spectrum + vibrato (matches startDrone / startRatioDrone).
    const wave = ctx.createPeriodicWave(CELLO_REAL, CELLO_IMAG, { disableNormalization: false });
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.value = freq;
    osc.connect(noteGain);
    osc.start();
    // Vibrato LFO — tracked in _extraOscs so stopIntervalDroneByKey
    // tears it down with the main oscillator.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 4.4 + Math.random() * 0.4;
    const depth = ctx.createGain();
    depth.gain.value = 5;
    lfo.connect(depth);
    depth.connect(osc.detune);
    lfo.start();
    this.intervalDrones.set(key, { osc, gain: noteGain, _extraOscs: [lfo] } as any);
  }

  stopIntervalDroneByKey(key: string) {
    const entry = this.intervalDrones.get(key) as any;
    if (entry) {
      try { entry.osc.stop(); entry.osc.disconnect(); } catch {}
      if (entry._extraOscs) {
        for (const o of entry._extraOscs) { try { o.stop(); o.disconnect(); } catch {} }
      }
      try { entry.gain.disconnect(); } catch {}
      this.intervalDrones.delete(key);
    }
  }

  stopAllIntervalDrones() {
    for (const [, e] of this.intervalDrones) {
      const entry = e as any;
      try { entry.osc.stop(); entry.osc.disconnect(); } catch {}
      if (entry._extraOscs) {
        for (const o of entry._extraOscs) { try { o.stop(); o.disconnect(); } catch {} }
      }
      try { entry.gain.disconnect(); } catch {}
    }
    this.intervalDrones.clear();
  }

  isIntervalDronePlaying(key: string) { return this.intervalDrones.has(key); }
}

export const audioEngine = new AudioEngine();
