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

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw, reviver) as T;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value, replacer));
  } catch { /* quota or serialisation – silently drop */ }
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
    if (isExportKey(key)) data[key] = localStorage.getItem(key)!;
  }
  const json = JSON.stringify({ version: 1, exported: new Date().toISOString(), data }, null, 2);
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

export function exportMusicData(): void {
  const data: Record<string, string> = {};
  for (const key of MUSIC_DATA_KEYS) {
    const val = localStorage.getItem(key);
    if (val) data[key] = val;
  }
  const json = JSON.stringify({ version: 1, type: "music-data", exported: new Date().toISOString(), data }, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lumatone_music_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importMusicData(json: string): { ok: boolean; error?: string } {
  try {
    const parsed = JSON.parse(json);
    if (!parsed?.data || typeof parsed.data !== "object") {
      return { ok: false, error: "Invalid music data file format." };
    }
    const entries = Object.entries(parsed.data) as [string, string][];
    const validEntries = entries.filter(([k]) => MUSIC_DATA_KEYS.has(k) || isExportKey(k));
    if (!validEntries.length) return { ok: false, error: "No music data found in file." };
    for (const [k, v] of validEntries) {
      if (k === "lt_practice_log") {
        // Merge practice log: import new entries without duplicating existing ones
        mergePracticeLog(v);
      } else {
        localStorage.setItem(k, v);
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not parse file." };
  }
}

/** Merge imported practice log entries into existing log, deduplicating by entry id. */
function mergePracticeLog(importedRaw: string): void {
  type LogEntry = { id: string; [key: string]: unknown };
  type LogData = Record<string, LogEntry[]>;
  let imported: LogData;
  try { imported = JSON.parse(importedRaw); } catch { return; }
  if (!imported || typeof imported !== "object") return;

  const existingRaw = localStorage.getItem("lt_practice_log");
  const existing: LogData = existingRaw ? JSON.parse(existingRaw) : {};

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

  localStorage.setItem("lt_practice_log", JSON.stringify(existing, replacer));
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
  const { getFileBlob } = await import(/* @vite-ignore */ "./fileStorage");
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
      const { storeFileBlob } = await import(/* @vite-ignore */ "./fileStorage");
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
  try {
    const parsed = JSON.parse(json);
    if (!parsed?.data || typeof parsed.data !== "object") {
      return { ok: false, error: "Invalid backup file format." };
    }
    const entries = Object.entries(parsed.data) as [string, string][];
    const validEntries = entries.filter(([k]) => isExportKey(k));
    if (!validEntries.length) return { ok: false, error: "No data found in file." };
    for (const [k, v] of validEntries) {
      if (k === "lt_practice_log") {
        mergePracticeLog(v);
      } else {
        localStorage.setItem(k, v);
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not parse file." };
  }
}
