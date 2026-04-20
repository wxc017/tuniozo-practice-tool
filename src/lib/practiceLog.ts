import { lsGet, lsSet, localToday } from "./storage";

// ── Types ──────────────────────────────────────────────────────────────────

export type PracticeRating = 0 | 1 | 2 | 3 | 4 | 5;

export interface PracticeLogEntry {
  id: string;
  date: string;            // YYYY-MM-DD
  timestamp: number;       // ms since epoch
  mode: string;            // e.g. "ear-trainer", "drum-ostinato", "accent-study", "konnakol", "chord-chart", "note-entry"
  label: string;           // Human-readable e.g. "Spatial Audiation · Intervals"
  rating: PracticeRating;
  preview: string;         // Human-readable summary
  snapshot: Record<string, unknown>;  // Mode-specific restore data
  canRestore: boolean;
  tag?: string;            // Optional category tag e.g. "isolation", "context"
}

export type PracticeLogData = Record<string, PracticeLogEntry[]>;  // date → entries, newest first

// ── Storage ────────────────────────────────────────────────────────────────

export const LOG_KEY = "lt_practice_log";

export function getPracticeLog(): PracticeLogData {
  return lsGet<PracticeLogData>(LOG_KEY, {});
}

export function addPracticeEntry(
  partial: Omit<PracticeLogEntry, "id" | "date" | "timestamp">
): PracticeLogEntry {
  const log = getPracticeLog();
  const date = localToday();
  const entry: PracticeLogEntry = {
    ...partial,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    date,
    timestamp: Date.now(),
  };
  if (!log[date]) log[date] = [];
  log[date] = [entry, ...log[date]];
  lsSet(LOG_KEY, log);
  return entry;
}

export function deletePracticeEntry(date: string, id: string): PracticeLogEntry | undefined {
  const log = getPracticeLog();
  if (!log[date]) return undefined;
  const removed = log[date].find(e => e.id === id);
  log[date] = log[date].filter(e => e.id !== id);
  if (log[date].length === 0) delete log[date];
  lsSet(LOG_KEY, log);
  return removed;
}

export function restorePracticeEntry(entry: PracticeLogEntry): void {
  const log = getPracticeLog();
  if (!log[entry.date]) log[entry.date] = [];
  // Re-insert at original position (sorted newest-first by timestamp)
  log[entry.date].push(entry);
  log[entry.date].sort((a, b) => b.timestamp - a.timestamp);
  lsSet(LOG_KEY, log);
}

export function movePracticeEntry(fromDate: string, id: string, toDate: string): boolean {
  if (fromDate === toDate) return false;
  const log = getPracticeLog();
  if (!log[fromDate]) return false;
  const entry = log[fromDate].find(e => e.id === id);
  if (!entry) return false;
  // Remove from source date
  log[fromDate] = log[fromDate].filter(e => e.id !== id);
  if (log[fromDate].length === 0) delete log[fromDate];
  // Update entry date and add to target
  entry.date = toDate;
  if (!log[toDate]) log[toDate] = [];
  log[toDate].push(entry);
  log[toDate].sort((a, b) => b.timestamp - a.timestamp);
  lsSet(LOG_KEY, log);
  return true;
}

export function updatePracticeEntry(
  date: string,
  id: string,
  updates: Partial<Pick<PracticeLogEntry, "rating" | "preview" | "snapshot" | "tag">>
): void {
  const log = getPracticeLog();
  if (!log[date]) return;
  log[date] = log[date].map(e => e.id === id ? { ...e, ...updates } : e);
  lsSet(LOG_KEY, log);
}

export function getDatesWithEntries(): Set<string> {
  return new Set(Object.keys(getPracticeLog()));
}

export function getEntriesForDate(date: string): PracticeLogEntry[] {
  return getPracticeLog()[date] ?? [];
}

// ── Ear Trainer snapshot helpers ──────────────────────────────────────────

const SNAPSHOT_EXCLUDED = new Set([
  "lt_presets",
  "lt_stats",
  "lt_option_stats",
  LOG_KEY,
]);

// Lightweight settings-only snapshot (no stats/log/presets/large data)
// Only captures keys needed to restore ear-trainer tab configuration
const SETTINGS_PREFIXES = [
  "lt_app_", "lt_ivl_", "lt_crd_", "lt_mel_", "lt_jazz_",
  "lt_pat_", "lt_drn_", "lt_beta_", "lt_academic_",
];

export function captureEarTrainerSettingsSnapshot(): Record<string, string> {
  const snap: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (SETTINGS_PREFIXES.some(p => k.startsWith(p)) && !SNAPSHOT_EXCLUDED.has(k)) {
      snap[k] = localStorage.getItem(k)!;
    }
  }
  return snap;
}

export function captureEarTrainerSnapshot(): Record<string, string> {
  const snap: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith("lt_") && !SNAPSHOT_EXCLUDED.has(k)) {
      snap[k] = localStorage.getItem(k)!;
    }
  }
  return snap;
}

export function restoreEarTrainerSnapshot(snap: Record<string, string>): void {
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith("lt_") && !SNAPSHOT_EXCLUDED.has(k)) toRemove.push(k);
  }
  toRemove.forEach(k => localStorage.removeItem(k));
  Object.entries(snap).forEach(([k, v]) => {
    if (k.startsWith("lt_")) localStorage.setItem(k, v);
  });
}

// ── Pending restore communication (for non-ear-trainer modes) ─────────────
// Used to pass restore data from PracticeLogModal → target mode component
// The target component reads and clears this on mount.

export function writePendingRestore(modeKey: string, data: unknown): void {
  try {
    localStorage.setItem(`lt_restore_${modeKey}`, JSON.stringify(data));
  } catch { /* ignore */ }
}

export function readPendingRestore<T>(modeKey: string): T | null {
  try {
    const raw = localStorage.getItem(`lt_restore_${modeKey}`);
    if (!raw) return null;
    localStorage.removeItem(`lt_restore_${modeKey}`);
    return JSON.parse(raw) as T;
  } catch { return null; }
}

export function hasPendingRestore(modeKey: string): boolean {
  return localStorage.getItem(`lt_restore_${modeKey}`) !== null;
}

// ── Quickmarks (bookmarked ostinato snapshots for fast switching) ────────

export interface Quickmark {
  id: string;
  label: string;
  measures: unknown[];
  grid: string;
  permOriginalCount: number | null;
  timestamp: number;
}

const QM_KEY = "lt_drum_quickmarks";

export function getQuickmarks(): Quickmark[] {
  return lsGet<Quickmark[]>(QM_KEY, []);
}

export function setQuickmarks(qms: Quickmark[]): void {
  lsSet(QM_KEY, qms);
}

export function addQuickmarkFromSnapshot(
  snapshot: Record<string, unknown>,
  label?: string,
): Quickmark | null {
  const measures = snapshot.measures as unknown[] | undefined;
  const grid = (snapshot.grid as string) ?? "16th";
  if (!measures || measures.length === 0) return null;
  const qm: Quickmark = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label: label ?? `${measures.length}m · ${grid}`,
    measures: JSON.parse(JSON.stringify(measures)),
    grid,
    permOriginalCount: (snapshot.permOriginalCount as number | null) ?? null,
    timestamp: Date.now(),
  };
  const all = [qm, ...getQuickmarks()];
  setQuickmarks(all);
  window.dispatchEvent(new Event("quickmarks-changed"));
  return qm;
}

// ── Accent-study interpretation migration ─────────────────────────────────
// Existing accent-study entries may have accentInterpretation / tapInterpretation
// on their snapshot measures but the label/preview doesn't reflect it.
// This one-time migration stamps the variant info into label + preview.

const MIGRATION_KEY = "lt_accent_interp_migrated_v4";

const ACCENT_INTERP_NAMES: Record<string, string> = {
  "accent-flam": "Accent: Flams",
  "accent-double": "Accent: Doubles",
  "accent-buzz": "Accent: Buzz",
};
const TAP_INTERP_NAMES: Record<string, string> = {
  "tap-buzz": "Tap: Buzz",
  "tap-flam": "Tap: Flams",
  "tap-double": "Tap: Doubles",
};

const ACCENT_NAME_TO_FIELD: Record<string, string> = {
  "Accent: Flams": "accent-flam",
  "Accent: Doubles": "accent-double",
  "Accent: Buzz": "accent-buzz",
};
const TAP_NAME_TO_FIELD: Record<string, string> = {
  "Tap: Flams": "tap-flam",
  "Tap: Doubles": "tap-double",
  "Tap: Buzz": "tap-buzz",
};

export function migrateAccentInterpretations(): void {
  if (localStorage.getItem(MIGRATION_KEY)) return;
  const log = getPracticeLog();
  let changed = false;
  for (const date of Object.keys(log)) {
    for (const entry of log[date]) {
      if (entry.mode !== "accent-study") continue;
      const snap = entry.snapshot as { measures?: Record<string, unknown>[]; variant?: string };
      if (!snap.measures || snap.measures.length === 0) continue;

      // Determine the variant — either from snapshot.variant, label, or from the measures
      let variantStr = snap.variant as string | undefined;
      if (!variantStr) {
        // Try to extract from label (e.g. "Accent Study · Tap: Flams")
        const afterDot = entry.label.split(" · ").slice(1).join(" · ");
        if (afterDot && (afterDot.includes("Accent:") || afterDot.includes("Tap:"))) {
          variantStr = afterDot;
        }
      }
      if (!variantStr) {
        // Derive from measures' existing interpretation
        const m0 = snap.measures[0] as { accentInterpretation?: string; tapInterpretation?: string };
        const parts: string[] = [];
        if (m0.accentInterpretation && ACCENT_INTERP_NAMES[m0.accentInterpretation]) {
          parts.push(ACCENT_INTERP_NAMES[m0.accentInterpretation]);
        }
        if (m0.tapInterpretation && TAP_INTERP_NAMES[m0.tapInterpretation]) {
          parts.push(TAP_INTERP_NAMES[m0.tapInterpretation]);
        }
        if (parts.length === 0) parts.push("Accent: Normal");
        variantStr = parts.join(" + ");
      }

      // Parse variant string to determine target interpretations
      let targetAccent: string | undefined;
      let targetTap: string | undefined;
      for (const [name, field] of Object.entries(ACCENT_NAME_TO_FIELD)) {
        if (variantStr.includes(name)) { targetAccent = field; break; }
      }
      for (const [name, field] of Object.entries(TAP_NAME_TO_FIELD)) {
        if (variantStr.includes(name)) { targetTap = field; break; }
      }

      // Stamp interpretations onto every measure in the snapshot
      for (const m of snap.measures) {
        (m as Record<string, unknown>).accentInterpretation = targetAccent;
        (m as Record<string, unknown>).tapInterpretation = targetTap;
      }

      // Update label and preview
      if (!entry.label.includes("Accent:") && !entry.label.includes("Tap:")) {
        entry.label = `Accent Study · ${variantStr}`;
        entry.preview = `${variantStr} · ${entry.preview}`;
      }
      snap.variant = variantStr;
      changed = true;
    }
  }
  if (changed) lsSet(LOG_KEY, log);
  localStorage.setItem(MIGRATION_KEY, "1");
}

// Run migration on module load (idempotent, skips if already done)
migrateAccentInterpretations();
