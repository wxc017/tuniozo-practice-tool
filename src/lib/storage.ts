import { useState, useCallback } from "react";

// ── Local date helper (avoids UTC date shift from toISOString) ─────────
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Serialisation helpers that preserve Set objects ────────────────────

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) return { __set__: [...value] };
  return value;
}
function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "__set__" in (value as object)) {
    return new Set((value as { __set__: unknown[] }).__set__);
  }
  return value;
}

// ── Practice log integer-dictionary codec ───────────────────────────────
// Shrinks the practice log by replacing repeated mode/label/tag strings with
// integer indices. Produces ~3-5x smaller JSON; also lets large logs fit in
// localStorage (which caps at ~5-10MB per origin).

const PRACTICE_LOG_KEY = "lt_practice_log";

interface EncodedLog {
  v: 2;
  modes: string[];
  labels: string[];
  tags: string[];
  // Per-date entry tuples: [id, timestamp, modeIdx, labelIdx, rating, preview, canRestore, snapshot, tagIdx?]
  entries: Record<string, unknown[][]>;
}

function encodePracticeLog(data: Record<string, unknown[]>): EncodedLog {
  const modes: string[] = [];
  const labels: string[] = [];
  const tags: string[] = [];
  const modeIdx = new Map<string, number>();
  const labelIdx = new Map<string, number>();
  const tagIdx = new Map<string, number>();
  const idx = (arr: string[], map: Map<string, number>, val: string): number => {
    let n = map.get(val);
    if (n === undefined) { n = arr.length; arr.push(val); map.set(val, n); }
    return n;
  };
  const entries: Record<string, unknown[][]> = {};
  for (const [date, list] of Object.entries(data)) {
    if (!Array.isArray(list)) continue;
    entries[date] = list.map((e: any) => {
      const tup: unknown[] = [
        e.id,
        e.timestamp,
        idx(modes, modeIdx, e.mode ?? ""),
        idx(labels, labelIdx, e.label ?? ""),
        e.rating,
        e.preview ?? "",
        e.canRestore ?? false,
        e.snapshot ?? null,
      ];
      if (e.tag) tup.push(idx(tags, tagIdx, e.tag));
      return tup;
    });
  }
  return { v: 2, modes, labels, tags, entries };
}

function decodePracticeLog(enc: EncodedLog): Record<string, unknown[]> {
  const data: Record<string, unknown[]> = {};
  for (const [date, list] of Object.entries(enc.entries)) {
    data[date] = list.map((t: any[]) => {
      const out: any = {
        id: t[0],
        date,
        timestamp: t[1],
        mode: enc.modes[t[2]] ?? "",
        label: enc.labels[t[3]] ?? "",
        rating: t[4],
        preview: t[5],
        canRestore: t[6],
        snapshot: t[7] ?? {},
      };
      if (t.length > 8) out.tag = enc.tags[t[8]];
      return out;
    });
  }
  return data;
}

// Report storage errors loudly so callers / UI can react. Previously these
// were silently swallowed which allowed quota failures and corrupt-read
// wipes to destroy yesterday's practice log without warning.
function reportStorageError(key: string, op: "read" | "write", error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`[storage] ${op} failed for ${key}: ${msg}`, error);
  try {
    window.dispatchEvent(new CustomEvent("lt-storage-error", {
      detail: { key, op, message: msg },
    }));
  } catch { /* jsdom / non-browser */ }
}

/** Detect encoded-v2 vs legacy object and always return decoded data.
 *  On parse failure, quarantines the raw value under a recovery key so the
 *  next write doesn't clobber it. */
function readPracticeLog(raw: string | null): Record<string, unknown[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw, reviver);
    if (parsed && typeof parsed === "object" && (parsed as any).v === 2 && Array.isArray((parsed as any).modes)) {
      return decodePracticeLog(parsed as EncodedLog);
    }
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch (err) {
    // Quarantine: move the corrupt blob aside so the caller can start fresh
    // without overwriting the only copy of the user's data.
    try {
      const backupKey = `${PRACTICE_LOG_KEY}__recovery_${Date.now()}`;
      localStorage.setItem(backupKey, raw);
      localStorage.removeItem(PRACTICE_LOG_KEY);
      // eslint-disable-next-line no-console
      console.error(`[storage] practice log corrupt; quarantined to ${backupKey}`);
    } catch { /* if we can't even quarantine, leave raw in place */ }
    reportStorageError(PRACTICE_LOG_KEY, "read", err);
    return {};
  }
}

/** Store the practice log in encoded form. */
function writePracticeLog(data: Record<string, unknown[]>): void {
  const encoded = encodePracticeLog(data);
  localStorage.setItem(PRACTICE_LOG_KEY, JSON.stringify(encoded));
}

// Data-change notification is handled by folderSync's localStorage.setItem
// interceptor — any write to an export key (lt_* or an entry in
// EXTRA_EXPORT_KEYS) fires `lt-data-changed` automatically, so lsSet itself
// doesn't need to dispatch. That keeps modules that call localStorage.setItem
// directly (e.g. DrumPatterns' lt_interplay_*) in sync too.

export function lsGet<T>(key: string, fallback: T): T {
  if (key === PRACTICE_LOG_KEY) {
    const raw = localStorage.getItem(key);
    return (raw === null ? fallback : readPracticeLog(raw)) as T;
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw, reviver) as T;
  } catch (err) {
    reportStorageError(key, "read", err);
    return fallback;
  }
}

export function lsSet(key: string, value: unknown): void {
  if (key === PRACTICE_LOG_KEY) {
    try {
      writePracticeLog(value as Record<string, unknown[]>);
    } catch (err) {
      reportStorageError(key, "write", err);
    }
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(value, replacer));
  } catch (err) {
    reportStorageError(key, "write", err);
  }
}

/** Replacer/reviver are also used by practiceLog for strict saves */
export { replacer as jsonReplacer };

// ── Drop-in replacement for useState that persists to localStorage ────

export function useLS<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setRaw] = useState<T>(() => lsGet(key, initial));

  const setState = useCallback(
    (val: React.SetStateAction<T>) => {
      setRaw(prev => {
        const next = typeof val === "function" ? (val as (p: T) => T)(prev) : val;
        lsSet(key, next);
        return next;
      });
    },
    [key]
  );

  return [state, setState];
}

// ── Preset save/load (snapshots all lt_ keys except lt_presets/stats) ─

const PRESET_KEY = "lt_presets";
const EXCLUDED = new Set([PRESET_KEY, "lt_stats", "lt_option_stats"]);

export function getPresets(): Record<string, Record<string, string>> {
  return lsGet(PRESET_KEY, {});
}

export function savePreset(name: string): void {
  const presets = getPresets();
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (key.startsWith("lt_") && !EXCLUDED.has(key)) {
      snapshot[key] = localStorage.getItem(key)!;
    }
  }
  presets[name] = snapshot;
  lsSet(PRESET_KEY, presets);
}

export function loadPreset(name: string): boolean {
  const presets = getPresets();
  const snapshot = presets[name];
  if (!snapshot) return false;
  // Clear all existing lt_ keys (except presets/stats)
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith("lt_") && !EXCLUDED.has(k)) toRemove.push(k);
  }
  toRemove.forEach(k => localStorage.removeItem(k));
  // Write snapshot
  Object.entries(snapshot).forEach(([k, v]) => localStorage.setItem(k, v));
  return true;
}

export function deletePreset(name: string): void {
  const presets = getPresets();
  delete presets[name];
  lsSet(PRESET_KEY, presets);
}

// ── Known options registry (in-memory, rebuilt each render from current state) ──
// Never persisted — always reflects exactly what is checked right now.
// Clean up the old persisted key if it exists from a previous version.
localStorage.removeItem("lt_known_options");

const _knownOptions = new Map<string, string>();

export function registerKnownOption(key: string, label: string): void {
  _knownOptions.set(key, label);
}

export function unregisterKnownOptionsForPrefix(prefix: string): void {
  for (const key of Array.from(_knownOptions.keys())) {
    if (key.startsWith(prefix)) _knownOptions.delete(key);
  }
}

export function getKnownOptions(): Record<string, string> {
  return Object.fromEntries(_knownOptions);
}

// ── Extra keys (non-lt_ prefix) that should be included in export/import ──
const EXTRA_EXPORT_KEYS = new Set(["konnakol_custom_presets"]);

export function isExportKey(key: string): boolean {
  return key.startsWith("lt_") || EXTRA_EXPORT_KEYS.has(key);
}

// ── Export / Import all lt_ data + extra keys ─────────────────────────

export function exportData(): void {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (!isExportKey(key)) continue;
    let val = localStorage.getItem(key)!;
    if (key === PRACTICE_LOG_KEY) {
      // Always emit the compact integer-encoded form in the export file
      val = JSON.stringify(encodePracticeLog(readPracticeLog(val)));
    }
    data[key] = val;
  }
  const json = JSON.stringify({ version: 1, exported: new Date().toISOString(), data });
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lumatone_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Music data export/import (transcriptions, chord charts, practice log, etc.) ──

const MUSIC_DATA_KEYS = new Set([
  "lt_note_entry_projects",
  "lt_chord_charts",
  "lt_practice_log",
  "lt_drum_log",
  "lt_accent_log",
]);

// ── gzip helpers (browser-native CompressionStream) ─────────────────────

async function gzipText(text: string): Promise<Uint8Array> {
  const blob = new Blob([text]);
  const cs = new CompressionStream("gzip");
  const stream = blob.stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes: Uint8Array): Promise<string> {
  const blob = new Blob([bytes]);
  const ds = new DecompressionStream("gzip");
  const stream = blob.stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(buf);
}

// Gzip magic bytes: 1f 8b
function looksGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function exportMusicData(): Promise<void> {
  const data: Record<string, string> = {};
  for (const key of MUSIC_DATA_KEYS) {
    let val = localStorage.getItem(key);
    if (!val) continue;
    if (key === PRACTICE_LOG_KEY) {
      val = JSON.stringify(encodePracticeLog(readPracticeLog(val)));
    }
    data[key] = val;
  }
  const json = JSON.stringify({ version: 1, type: "music-data", exported: new Date().toISOString(), data });
  const gz = await gzipText(json);
  const blob = new Blob([gz], { type: "application/gzip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lumatone_music_${new Date().toISOString().slice(0, 10)}.json.gz`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Accepts gzipped bytes (ArrayBuffer) or raw JSON text. */
export async function importMusicData(input: ArrayBuffer | string): Promise<{ ok: boolean; error?: string }> {
  let json: string;
  try {
    if (typeof input === "string") {
      json = input.replace(/^\uFEFF/, "").trim();
    } else {
      const bytes = new Uint8Array(input);
      if (looksGzipped(bytes)) {
        json = (await gunzipBytes(bytes)).replace(/^\uFEFF/, "").trim();
      } else {
        json = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trim();
      }
    }
    if (!json) return { ok: false, error: "File is empty." };
  } catch (e) {
    return { ok: false, error: `Could not read file: ${(e as Error).message.slice(0, 80)}` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `Could not parse JSON: ${(e as Error).message.slice(0, 80)}` };
  }
  if (!parsed?.data || typeof parsed.data !== "object") {
    return { ok: false, error: "Invalid saved data file format." };
  }
  const entries = Object.entries(parsed.data) as [string, string][];
  const validEntries = entries.filter(([k]) => MUSIC_DATA_KEYS.has(k) || isExportKey(k));
  if (!validEntries.length) return { ok: false, error: "No saved data found in file." };
  const skipped: string[] = [];
  for (const [k, v] of validEntries) {
    try {
      if (k === "lt_practice_log") {
        if (!mergePracticeLog(v)) skipped.push(k);
      } else {
        localStorage.setItem(k, v);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "QuotaExceededError") skipped.push(k);
      else throw e;
    }
  }
  if (skipped.length) {
    return { ok: false, error: `Browser storage quota exceeded. Skipped: ${skipped.join(", ")}.` };
  }
  return { ok: true };
}

/** Merge imported practice log entries into existing log, deduplicating by entry id.
 *  Returns true on success, false on quota failure. */
function mergePracticeLog(importedRaw: string): boolean {
  type LogEntry = { id: string; [key: string]: unknown };
  type LogData = Record<string, LogEntry[]>;
  let imported: LogData;
  try {
    const parsed = JSON.parse(importedRaw);
    // Accept either legacy object or encoded v2 form
    if (parsed && typeof parsed === "object" && (parsed as any).v === 2 && Array.isArray((parsed as any).modes)) {
      imported = decodePracticeLog(parsed as EncodedLog) as LogData;
    } else {
      imported = parsed as LogData;
    }
  } catch { return false; }
  if (!imported || typeof imported !== "object") return false;

  const existingRaw = localStorage.getItem("lt_practice_log");
  const existing: LogData = readPracticeLog(existingRaw) as LogData;

  // Collect all existing entry ids for dedup
  const existingIds = new Set<string>();
  for (const dateEntries of Object.values(existing)) {
    for (const e of dateEntries) existingIds.add(e.id);
  }

  // Merge imported entries that don't already exist
  for (const [date, entries] of Object.entries(imported)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry.id || existingIds.has(entry.id)) continue;
      if (!existing[date]) existing[date] = [];
      existing[date].push(entry);
      existingIds.add(entry.id);
    }
  }

  // Sort each date's entries newest-first by timestamp
  for (const date of Object.keys(existing)) {
    existing[date].sort((a, b) => ((b as { timestamp?: number }).timestamp ?? 0) - ((a as { timestamp?: number }).timestamp ?? 0));
  }

  try {
    writePracticeLog(existing);
    return true;
  } catch (e) {
    if (e instanceof Error && e.name === "QuotaExceededError") return false;
    throw e;
  }
}

export function getMusicDataSummary(): { transcriptions: number; chordCharts: number; practiceEntries: number; drumExercises: number; accentExercises: number } {
  const count = (key: string): number => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.length;
      if (typeof parsed === "object") return Object.keys(parsed).length;
      return 0;
    } catch { return 0; }
  };
  return {
    transcriptions: count("lt_note_entry_projects"),
    chordCharts: count("lt_chord_charts"),
    practiceEntries: count("lt_practice_log"),
    drumExercises: count("lt_drum_log"),
    accentExercises: count("lt_accent_log"),
  };
}

// ── Academic data export/import (reading files + IndexedDB blobs) ──────

export async function exportAcademicData(): Promise<void> {
  const meta = localStorage.getItem("lt_reading_files");
  const files: { id: string }[] = meta ? JSON.parse(meta) : [];

  // Read all file blobs from IndexedDB (academic feature — only present locally)
  const fsModules = import.meta.glob("./fileStorag*.ts");
  const loader = fsModules["./fileStorage.ts"];
  if (!loader) return;
  const mod: any = await loader();
  const { getFileBlob } = mod;
  const blobs: Record<string, string> = {};
  for (const f of files) {
    const buf = await getFileBlob(f.id);
    if (buf) {
      // ArrayBuffer → base64
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      blobs[f.id] = btoa(binary);
    }
  }

  const payload = {
    version: 1,
    type: "academic-data",
    exported: new Date().toISOString(),
    readingFiles: meta ?? "[]",
    fileBlobs: blobs,
  };
  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lumatone_academic_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importAcademicData(json: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const parsed = JSON.parse(json);
    if (!parsed?.readingFiles) {
      return { ok: false, error: "Invalid academic data file." };
    }
    // Restore reading files metadata
    localStorage.setItem("lt_reading_files", parsed.readingFiles);

    // Restore file blobs to IndexedDB
    if (parsed.fileBlobs && typeof parsed.fileBlobs === "object") {
      const fsModules = import.meta.glob("./fileStorag*.ts");
      const loader = fsModules["./fileStorage.ts"];
      if (!loader) return { ok: false, error: "Academic feature not available in this build." };
      const mod: any = await loader();
      const { storeFileBlob } = mod;
      for (const [id, b64] of Object.entries(parsed.fileBlobs)) {
        const binary = atob(b64 as string);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await storeFileBlob(id, bytes.buffer);
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not parse academic data file." };
  }
}

export function getAcademicDataSummary(): { files: number; extracts: number; notes: number; questions: number; bookmarks: number } {
  try {
    const raw = localStorage.getItem("lt_reading_files");
    if (!raw) return { files: 0, extracts: 0, notes: 0, questions: 0, bookmarks: 0 };
    const files = JSON.parse(raw) as { textExtracts?: unknown[]; notes?: unknown[]; questions?: unknown[]; bookmarks?: unknown[] }[];
    return {
      files: files.length,
      extracts: files.reduce((s, f) => s + (f.textExtracts?.length ?? 0), 0),
      notes: files.reduce((s, f) => s + (f.notes?.length ?? 0), 0),
      questions: files.reduce((s, f) => s + (f.questions?.length ?? 0), 0),
      bookmarks: files.reduce((s, f) => s + (f.bookmarks?.length ?? 0), 0),
    };
  } catch { return { files: 0, extracts: 0, notes: 0, questions: 0, bookmarks: 0 }; }
}

export function importData(json: string): { ok: boolean; error?: string } {
  let parsed: any;
  try {
    // Strip UTF-8 BOM if present (some editors prepend \ufeff)
    const clean = json.replace(/^\uFEFF/, "").trim();
    if (!clean) return { ok: false, error: "File is empty." };
    parsed = JSON.parse(clean);
  } catch (e) {
    return { ok: false, error: `Could not parse JSON: ${(e as Error).message.slice(0, 80)}` };
  }
  // Route music-data and academic-data files to their importers
  if (parsed?.type === "music-data") {
    return importMusicData(json);
  }
  if (parsed?.type === "academic-data") {
    return { ok: false, error: "This is academic data — use the Import Academic Data button." };
  }
  if (!parsed?.data || typeof parsed.data !== "object") {
    return { ok: false, error: "Not a Music Trainer backup (no 'data' field)." };
  }
  const entries = Object.entries(parsed.data) as [string, string][];
  const validEntries = entries.filter(([k]) => isExportKey(k));
  if (!validEntries.length) return { ok: false, error: "No recognized data keys in file." };
  const skipped: string[] = [];
  for (const [k, v] of validEntries) {
    try {
      if (k === "lt_practice_log") {
        if (!mergePracticeLog(v)) skipped.push(k);
      } else {
        localStorage.setItem(k, v);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "QuotaExceededError") {
        skipped.push(k);
      } else {
        throw e;
      }
    }
  }
  if (skipped.length) {
    const mb = Math.round(new Blob([json]).size / 1024 / 1024 * 10) / 10;
    return { ok: false, error: `Browser storage quota exceeded (file is ~${mb}MB; localStorage limit ~5-10MB). Skipped: ${skipped.join(", ")}. The practice log is likely the culprit.` };
  }
  return { ok: true };
}
