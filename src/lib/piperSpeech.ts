// ── Piper-WASM TTS wrapper ────────────────────────────────────────────────
//
// High-quality offline TTS via the Piper neural model running entirely in
// the browser.  The runtime files (WASM, worker, ONNX runtime, eSpeak
// voice data) are copied to /piper/ at build time by vite-plugin-static-
// copy; the voice ONNX model is fetched once from HuggingFace on first
// use and re-used for every subsequent call.
//
// We talk to the bundled worker directly rather than going through
// piper-wasm's `api.js`, because the published package has a packaging
// bug — `api.js` statically imports `./expressions.js` which is not
// included in the npm tarball, so any `import "piper-wasm"` throws at
// load.  The worker bundle (`build/worker/piper_worker.js`) is
// self-contained and exactly what `api.js` would have driven for us.
//
// Generated audio is cached per text key so re-clicking the same
// syllable is instant.  Falls back to the existing Web Speech API path
// (solfegeSpeech.ts) on any failure (model fetch error, runtime error,
// browser without WASM/Worker support, etc.) so the user always hears
// something.

import { speakSyllable as fallbackSpeak } from "./solfegeSpeech";

// HuggingFace base for the voice model + config.  en_US-amy-low is a
// small (~30 MB) but pleasant en-US voice; bumping to "medium" doubles
// the size for marginal quality on short syllables.
const PIPER_PUBLIC_BASE = "/piper";
const VOICE_MODEL_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/low/en_US-amy-low.onnx";
const VOICE_CONFIG_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/low/en_US-amy-low.onnx.json";
const ONNX_RUNTIME_URL = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.17.1/";

// Cache: text-key → object URL of the generated WAV.  The user will
// only encounter ~50 unique syllables across both solfege systems so
// this stays tiny in memory.
const audioCache = new Map<string, string>();

// Fetched-blob cache, keyed by URL.  Mirrors the `blobs` dict that
// piper-wasm's api.js maintains across calls so the worker doesn't
// re-download the model on every invocation.
const blobCache: Record<string, Blob> = {};

let worker: Worker | null = null;
let warmed = false;

function piperUrl(file: string): string {
  return `${PIPER_PUBLIC_BASE}/${file}`;
}

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(piperUrl("piper_worker.js"));
  }
  return worker;
}

interface WorkerOutput {
  kind: "output";
  file: Blob;
  phonemes: string[];
  phonemeIds: number[];
  duration: number;
}

interface WorkerStderr { kind: "stderr"; message: string }
interface WorkerFetch { kind: "fetch"; url: string; blob?: Blob; loaded?: number; total?: number }

type WorkerMsg = WorkerOutput | WorkerStderr | WorkerFetch | { kind: string };

function generateWav(text: string): Promise<string | null> {
  return new Promise(resolve => {
    let w: Worker;
    try {
      w = ensureWorker();
    } catch (err) {
      console.warn("[piperSpeech] worker construction failed:", err);
      resolve(null);
      return;
    }

    const onMessage = (event: MessageEvent<WorkerMsg>) => {
      const data = event.data;
      switch (data.kind) {
        case "output": {
          const out = data as WorkerOutput;
          w.removeEventListener("message", onMessage);
          const url = URL.createObjectURL(out.file);
          resolve(url);
          break;
        }
        case "stderr": {
          const err = data as WorkerStderr;
          console.warn("[piperSpeech] worker stderr:", err.message);
          w.removeEventListener("message", onMessage);
          resolve(null);
          break;
        }
        case "fetch": {
          const f = data as WorkerFetch;
          if (f.blob) blobCache[f.url] = f.blob;
          break;
        }
      }
    };
    w.addEventListener("message", onMessage);

    w.postMessage({
      kind: "init",
      input: text,
      speakerId: null,
      blobs: blobCache,
      piperPhonemizeJsUrl:   piperUrl("piper_phonemize.js"),
      piperPhonemizeWasmUrl: piperUrl("piper_phonemize.wasm"),
      piperPhonemizeDataUrl: piperUrl("piper_phonemize.data"),
      modelUrl: VOICE_MODEL_URL,
      modelConfigUrl: VOICE_CONFIG_URL,
      phonemeIds: null,
      onnxruntimeUrl: ONNX_RUNTIME_URL,
    });
  });
}

async function piperGenerateCached(text: string): Promise<string | null> {
  const cached = audioCache.get(text);
  if (cached) return cached;

  try {
    const url = await generateWav(text);
    if (url) {
      audioCache.set(text, url);
      warmed = true;
      return url;
    }
  } catch (err) {
    console.warn("[piperSpeech] generate failed:", err);
  }
  return null;
}

export interface PiperSpeakOptions {
  /** Optional IPA reference; ignored by piper (it phonemizes internally
   *  via eSpeak) but useful as a fallback hint for the Web Speech path
   *  when piper isn't available. */
  ipa?: string;
}

/** Default playback rate for piper output.  The model's natural
 *  pace on isolated single-syllable inputs is rushed (it's trained
 *  on full-sentence prosody); 0.85 gives a clear, deliberate
 *  pronunciation without sounding pitched-down or chopped. */
const PIPER_PLAYBACK_RATE = 0.85;

/** Speak a syllable through piper-wasm.  Falls back to the Web Speech
 *  API if piper hasn't loaded or fails for any reason — the user hears
 *  something either way. */
export async function piperSpeak(text: string, options: PiperSpeakOptions = {}): Promise<void> {
  const url = await piperGenerateCached(text);
  if (!url) {
    fallbackSpeak(text, options.ipa ? { ipa: options.ipa } : undefined);
    return;
  }
  const audio = new Audio(url);
  audio.playbackRate = PIPER_PLAYBACK_RATE;
  // `preservesPitch` keeps the slowed audio from sounding like a tape
  // reel.  Browser support is fairly broad but the property is still
  // typed loosely, hence the cast.
  (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
  audio.play().catch(err => {
    console.warn("[piperSpeech] audio.play() rejected, falling back:", err);
    fallbackSpeak(text, options.ipa ? { ipa: options.ipa } : undefined);
  });
}

/** Whether piper has successfully generated at least one syllable
 *  during the session.  UI can use this to indicate whether the
 *  high-quality engine is active. */
export function piperIsWarm(): boolean {
  return warmed;
}

/** Pre-generate audio for a list of texts so the first user click
 *  doesn't pay the cold-start cost (the worker init + ONNX runtime
 *  fetch + voice model fetch can take ~5–10 s combined the first
 *  time).  Fire-and-forget — the returned promise resolves once
 *  every requested syllable is cached, but callers shouldn't await
 *  it: the UI stays usable while warming proceeds in the
 *  background, and `piperSpeak` will still play immediately for
 *  whichever items have already finished generating. */
export async function piperPrewarm(texts: readonly string[]): Promise<void> {
  for (const t of texts) {
    if (audioCache.has(t)) continue;
    try {
      await piperGenerateCached(t);
    } catch {
      // Swallow — pre-warm is best-effort; piperSpeak will fall
      // back to Web Speech for any text that fails to generate.
    }
  }
}
