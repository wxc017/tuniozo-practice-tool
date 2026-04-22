// File System Access API sync: user picks a local folder once, the app
// persists a FileSystemDirectoryHandle in IndexedDB, and auto-writes a
// JSON snapshot of all music data on every change.
//
// Browser constraint: after every page reload the handle is still stored,
// but the permission must be re-requested via a user gesture. We expose
// this as a two-step flow (connect-once → reconnect-each-session).

import { buildSyncPayload, restoreFromSyncPayload } from "./syncData";

const DB_NAME = "lt_folder_sync";
const STORE = "handles";
const HANDLE_KEY = "dir";
const DATA_FILENAME = "lumatone_practice_data.json";

// ── IndexedDB handle store ───────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Public API ────────────────────────────────────────────────────────

export type SyncState = "unsupported" | "disconnected" | "needs-permission" | "connected";

export interface SyncStatus {
  state: SyncState;
  folderName?: string;
  lastSaved?: number;
  lastError?: string;
}

export function isSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

// Narrow types for File System Access API (TS lib.dom lacks these by default)
interface FSDirHandle {
  name: string;
  kind: "directory";
  queryPermission(desc: { mode: "readwrite" | "read" }): Promise<PermissionState>;
  requestPermission(desc: { mode: "readwrite" | "read" }): Promise<PermissionState>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FSFileHandle>;
}
interface FSFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<FSWritable>;
}
interface FSWritable {
  write(data: string | BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
}

let cachedHandle: FSDirHandle | null = null;
let lastSavedAt: number | null = null;
let lastErrorMsg: string | null = null;
let connected = false;

async function getHandle(): Promise<FSDirHandle | null> {
  if (cachedHandle) return cachedHandle;
  try {
    cachedHandle = await idbGet<FSDirHandle>(HANDLE_KEY);
    return cachedHandle;
  } catch { return null; }
}

export async function getStatus(): Promise<SyncStatus> {
  if (!isSupported()) return { state: "unsupported" };
  const handle = await getHandle();
  if (!handle) return { state: "disconnected" };
  const perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm === "granted") {
    return {
      state: "connected",
      folderName: handle.name,
      lastSaved: lastSavedAt ?? undefined,
      lastError: lastErrorMsg ?? undefined,
    };
  }
  return {
    state: "needs-permission",
    folderName: handle.name,
    lastError: lastErrorMsg ?? undefined,
  };
}

/** Prompt the user to pick a folder; first write seeds it with current data. */
export async function connectFolder(): Promise<{ ok: boolean; error?: string }> {
  if (!isSupported()) return { ok: false, error: "Folder sync not supported in this browser (needs Chrome/Edge)." };
  try {
    const handle = await (window as any).showDirectoryPicker({
      mode: "readwrite",
      id: "lumatone-sync",
    }) as FSDirHandle;
    await idbPut(HANDLE_KEY, handle);
    cachedHandle = handle;
    connected = true;

    // If a data file already exists in the chosen folder, load it FIRST
    // (the user is pointing at an existing backup). Otherwise seed it.
    const existing = await tryRead(handle);
    if (existing) {
      const res = restoreFromSyncPayload(existing);
      if (!res.ok) {
        lastErrorMsg = `Found file but failed to load: ${res.error}`;
      }
    } else {
      const res = await tryWrite(handle, buildSyncPayload());
      if (!res.ok) return res;
    }
    lastErrorMsg = null;
    emitStatus();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort/i.test(msg)) return { ok: false, error: "Cancelled" };
    return { ok: false, error: msg };
  }
}

/** After a page reload, re-request permission (user gesture required) and
 *  optionally load the folder's copy into localStorage. */
export async function reconnectFolder(opts: { loadFromFolder: boolean } = { loadFromFolder: true }): Promise<{ ok: boolean; error?: string }> {
  const handle = await getHandle();
  if (!handle) return { ok: false, error: "No folder connected — pick one first." };
  try {
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      return { ok: false, error: "Permission denied." };
    }
    connected = true;
    lastErrorMsg = null;
    if (opts.loadFromFolder) {
      const payload = await tryRead(handle);
      if (payload) {
        const res = restoreFromSyncPayload(payload);
        if (!res.ok) lastErrorMsg = `Load failed: ${res.error}`;
      }
    }
    emitStatus();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastErrorMsg = msg;
    emitStatus();
    return { ok: false, error: msg };
  }
}

export async function disconnectFolder(): Promise<void> {
  await idbDelete(HANDLE_KEY);
  cachedHandle = null;
  connected = false;
  lastSavedAt = null;
  lastErrorMsg = null;
  emitStatus();
}

/** Immediate write; bypasses debounce. */
export async function saveNow(): Promise<{ ok: boolean; error?: string }> {
  const handle = await getHandle();
  if (!handle) return { ok: false, error: "No folder connected." };
  const perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm !== "granted") return { ok: false, error: "Permission lapsed — reconnect folder." };
  return tryWrite(handle, buildSyncPayload());
}

async function tryWrite(handle: FSDirHandle, payload: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const file = await handle.getFileHandle(DATA_FILENAME, { create: true });
    const w = await file.createWritable();
    await w.write(payload);
    await w.close();
    lastSavedAt = Date.now();
    lastErrorMsg = null;
    emitStatus();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastErrorMsg = msg;
    emitStatus();
    return { ok: false, error: msg };
  }
}

async function tryRead(handle: FSDirHandle): Promise<string | null> {
  try {
    const file = await handle.getFileHandle(DATA_FILENAME, { create: false });
    const blob = await file.getFile();
    return await blob.text();
  } catch { return null; }
}

function emitStatus(): void {
  try {
    window.dispatchEvent(new CustomEvent("lt-folder-sync-status"));
  } catch { /* jsdom */ }
}

// ── Auto-save on data changes ─────────────────────────────────────────

let saveTimer: number | null = null;
const DEBOUNCE_MS = 1500;

function scheduleSave(): void {
  if (!connected) return;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    saveTimer = null;
    const handle = await getHandle();
    if (!handle) return;
    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      connected = false;
      lastErrorMsg = "Permission lapsed";
      emitStatus();
      return;
    }
    await tryWrite(handle, buildSyncPayload());
  }, DEBOUNCE_MS);
}

export function initFolderSync(): void {
  if (typeof window === "undefined") return;
  // Flush any pending write before unload so the last-moment entry isn't lost.
  window.addEventListener("beforeunload", () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      // Best-effort synchronous-ish save; writable streams are async so this
      // may not complete before unload, but scheduleSave debounce is short
      // enough that most writes land before the user navigates away.
      void saveNow();
    }
  });
  window.addEventListener("lt-data-changed", scheduleSave);
  // Initial status probe — sets `connected` flag if permission is still granted
  // from a prior session (rare, but possible for installed PWAs).
  void (async () => {
    const handle = await getHandle();
    if (!handle) return;
    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm === "granted") {
      connected = true;
      emitStatus();
    } else {
      emitStatus(); // notify listeners that handle exists but needs permission
    }
  })();
}
