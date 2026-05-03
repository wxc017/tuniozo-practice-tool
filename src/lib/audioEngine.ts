// ── Audio Engine ─────────────────────────────────────────────────────
// All note values are ABSOLUTE: C4 = 4*EDO (e.g. 124 for 31-EDO)

const C4_FREQ = 261.63;

// Drone harmonic amplitudes — fundamental-dominant with natural rolloff,
// like a mellow bowed string or organ pipe. Each harmonic ~55% of the previous.
// h=1..10: 1.00, 0.55, 0.30, 0.16, 0.09, 0.05, 0.03, 0.015, 0.008, 0.004
const TAMBURA_REAL = new Float32Array([
  0, 1.00, 0.55, 0.30, 0.16, 0.09, 0.05, 0.030, 0.015, 0.008, 0.004
]);
const TAMBURA_IMAG = new Float32Array(TAMBURA_REAL.length); // all zeros = cosine phases

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private sampleBuffer: AudioBuffer | null = null;
  private droneNodes: OscillatorNode[] = [];
  private droneNoteGains: GainNode[] = [];
  private droneGainNode: GainNode | null = null;
  private intervalDrones: Map<string, { osc: OscillatorNode; gain: GainNode }> = new Map();
  private intervalDroneMaster: GainNode | null = null;
  private playGainNode: GainNode | null = null;
  private playLimiter: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;

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

    try {
      const base = import.meta.env.BASE_URL ?? "/";
      const resp = await fetch(`${base}C4.wav`);
      const arr = await resp.arrayBuffer();
      this.sampleBuffer = await this.ctx.decodeAudioData(arr);
    } catch (e) {
      console.warn("C4.wav not loaded, using synth fallback", e);
    }
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
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
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
      // Periodic wave with the tambura harmonic spectrum — adds
      // partials so chord notes ring richer than a plain triangle.
      const osc = ctx.createOscillator();
      const wave = ctx.createPeriodicWave(TAMBURA_REAL, TAMBURA_IMAG, { disableNormalization: false });
      osc.setPeriodicWave(wave);
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

  // Tambura-style sustained drone using PeriodicWave (harmonic synthesis).
  // One oscillator per note, each using the tambura harmonic spectrum.
  // This matches Python's synth_drone_buffer() harmonic series.
  startDrone(notes: number[], edo: number, gain = 0.08, perNoteGains?: number[]) {
    this.fadeDrone(150); // brief fade to avoid click
    const ctx = this.getCtx();

    this.droneGainNode = ctx.createGain();
    this.droneGainNode.gain.value = gain;
    this.droneGainNode.connect(this.masterGain ?? ctx.destination);

    const wave = ctx.createPeriodicWave(TAMBURA_REAL, TAMBURA_IMAG, { disableNormalization: false });

    for (let i = 0; i < notes.length; i++) {
      const noteGain = ctx.createGain();
      noteGain.gain.value = perNoteGains?.[i] ?? 1.0;
      noteGain.connect(this.droneGainNode);

      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = this.absToFreq(notes[i], edo);
      osc.connect(noteGain);
      osc.start();
      this.droneNodes.push(osc);
      this.droneNoteGains.push(noteGain);
    }
  }

  stopDrone() {
    for (const osc of this.droneNodes) {
      try { osc.stop(); } catch {}
      try { osc.disconnect(); } catch {}
    }
    this.droneNodes = [];
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

  startRatioDrone(ratios: number[], gain = 0.08, baseFreq?: number, perNoteGains?: number[]) {
    this.stopDrone();
    const ctx = this.getCtx();

    this.droneGainNode = ctx.createGain();
    this.droneGainNode.gain.value = gain;
    this.droneGainNode.connect(this.masterGain ?? ctx.destination);

    const freq = baseFreq ?? C4_FREQ;

    for (let i = 0; i < ratios.length; i++) {
      const noteGain = ctx.createGain();
      noteGain.gain.value = perNoteGains?.[i] ?? 1.0;
      noteGain.connect(this.droneGainNode);

      const baseF = freq * ratios[i];
      for (let h = 1; h <= 10; h++) {
        const amp = TAMBURA_REAL[h] ?? (1 / h);
        const hGain = ctx.createGain();
        hGain.gain.value = amp;
        hGain.connect(noteGain);
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = baseF * h;
        osc.connect(hGain);
        osc.start();
        this.droneNodes.push(osc);
      }
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

    const wave = ctx.createPeriodicWave(TAMBURA_REAL, TAMBURA_IMAG, { disableNormalization: false });
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.value = freq;
    osc.connect(noteGain);
    osc.start();
    this.intervalDrones.set(key, { osc, gain: noteGain, _extraOscs: [] } as any);
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
