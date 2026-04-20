import { useRef, useState, useEffect } from "react";
import { exportData, importData, exportMusicData, importMusicData, getMusicDataSummary, exportAcademicData, importAcademicData, getAcademicDataSummary } from "@/lib/storage";
import { isGoogleDriveAvailable, requestAccessToken, uploadSync, downloadSync, getSyncInfo, getSavedToken, clearToken } from "@/lib/googleDrive";
import { buildSyncPayload, restoreFromSyncPayload } from "@/lib/syncData";

interface Props {
  onClose: () => void;
  onDataImported: () => void;
  betaPlayRotation: boolean;
  onBetaPlayRotationChange: (v: boolean) => void;
  betaIntervalChain: boolean;
  onBetaIntervalChainChange: (v: boolean) => void;
  betaComma: boolean;
  onBetaCommaChange: (v: boolean) => void;
  betaTransform: boolean;
  onBetaTransformChange: (v: boolean) => void;
  betaMathLab: boolean;
  onBetaMathLabChange: (v: boolean) => void;
  academicMode: boolean;
  academicAvailable?: boolean;
  onAcademicModeChange: (v: boolean) => void;
}

export default function SettingsModal({ onClose, onDataImported, betaPlayRotation, onBetaPlayRotationChange, betaIntervalChain, onBetaIntervalChainChange, betaComma, onBetaCommaChange, betaTransform, onBetaTransformChange, betaMathLab, onBetaMathLabChange, academicMode, academicAvailable = false, onAcademicModeChange }: Props) {
  const importRef = useRef<HTMLInputElement>(null);
  const musicImportRef = useRef<HTMLInputElement>(null);
  const academicImportRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState("");
  const [musicSummary] = useState(() => getMusicDataSummary());
  const [academicSummary] = useState(() => getAcademicDataSummary());

  // Google Drive sync state
  const [gdriveToken, setGdriveToken] = useState<string | null>(() => getSavedToken());
  const [gdriveStatus, setGdriveStatus] = useState<"idle" | "busy">("idle");
  const [gdriveSyncTime, setGdriveSyncTime] = useState<string | null>(null);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(""), 2500);
  };

  // Fetch last sync time on mount if logged in
  useEffect(() => {
    if (!gdriveToken) return;
    getSyncInfo(gdriveToken).then(info => {
      setGdriveSyncTime(info?.modifiedTime ?? null);
    }).catch(err => {
      if (err instanceof Error && err.message.includes("401")) {
        setGdriveToken(null); clearToken();
      }
    });
  }, [gdriveToken]);

  const handleGoogleSignIn = async () => {
    try {
      setGdriveStatus("busy");
      flash("Signing in…");
      const token = await requestAccessToken();
      setGdriveToken(token);
      // Sync immediately after sign-in
      try {
        const data = await downloadSync(token);
        if (data) {
          restoreFromSyncPayload(data);
          onDataImported();
          flash("Signed in and synced!");
        } else {
          // No file yet — upload current data
          await uploadSync(token, buildSyncPayload());
          flash("Signed in — data saved to Drive");
        }
        const info = await getSyncInfo(token);
        setGdriveSyncTime(info?.modifiedTime ?? null);
      } catch { flash("Signed in"); }
    } catch (err) {
      flash(`Sign-in failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setGdriveStatus("idle");
    }
  };

  const handleGdriveSave = async () => {
    if (!gdriveToken) return;
    try {
      setGdriveStatus("busy");
      flash("Saving to Google Drive…");
      const payload = buildSyncPayload();
      await uploadSync(gdriveToken, payload);
      const info = await getSyncInfo(gdriveToken);
      setGdriveSyncTime(info?.modifiedTime ?? null);
      flash("Saved to Google Drive!");
    } catch (err) {
      if (err instanceof Error && err.message.includes("401")) {
        setGdriveToken(null); clearToken();
        flash("Session expired — sign in again");
      } else {
        flash(`Save failed: ${err instanceof Error ? err.message : "unknown"}`);
      }
    } finally {
      setGdriveStatus("idle");
    }
  };

  const handleGdriveSignOut = () => {
    setGdriveToken(null);
    clearToken();
    setGdriveSyncTime(null);
    flash("Signed out of Google Drive");
  };

  const handleExport = () => {
    exportData();
    flash("Exported!");
  };

  const handleMusicExport = () => {
    exportMusicData();
    flash("Music data exported!");
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const result = importData(text);
      if (result.ok) {
        onDataImported();
        flash("Imported! Reloading…");
        setTimeout(() => window.location.reload(), 800);
      } else {
        flash(result.error ?? "Import failed");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleMusicImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const result = importMusicData(text);
      if (result.ok) {
        onDataImported();
        flash("Music data imported! Reloading…");
        setTimeout(() => window.location.reload(), 800);
      } else {
        flash(result.error ?? "Import failed");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleAcademicExport = async () => {
    flash("Exporting academic data…");
    await exportAcademicData();
    flash("Academic data exported!");
  };

  const handleAcademicImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target?.result as string;
      flash("Importing academic data…");
      const result = await importAcademicData(text);
      if (result.ok) {
        onDataImported();
        flash("Academic data imported! Reloading…");
        setTimeout(() => window.location.reload(), 800);
      } else {
        flash(result.error ?? "Import failed");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#111] border border-[#2a2a2a] rounded-xl w-full max-w-md shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e1e1e]">
          <h2 className="font-semibold text-sm">Settings</h2>
          <button onClick={onClose} className="text-[#555] hover:text-white text-lg leading-none">✕</button>
        </div>

        {/* Content */}
        <div className="px-5 py-5 space-y-6 overflow-y-auto">

          {/* Mode section (only if academic components are present locally) */}
          {academicAvailable && (
            <div>
              <h3 className="text-xs font-semibold text-[#8b5cf6] uppercase tracking-widest mb-3">Mode</h3>
              <div className="space-y-2">
                <label className="flex items-center gap-3 px-3 py-2.5 bg-[#1a1a1a] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={academicMode}
                    onChange={e => onAcademicModeChange(e.target.checked)}
                    className="accent-[#8b5cf6] w-4 h-4 cursor-pointer"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-[#ccc]">Academic Toggle</div>
                    <div className="text-xs text-[#555]">Hide music modes and show academic tools (Reading Workflow)</div>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Google Drive Sync section */}
          {isGoogleDriveAvailable() && (
            <div>
              <h3 className="text-xs font-semibold text-[#4285f4] uppercase tracking-widest mb-3">Google Drive Sync</h3>
              <div className="space-y-2">
                {!gdriveToken ? (
                  <button
                    onClick={handleGoogleSignIn}
                    disabled={gdriveStatus === "busy"}
                    className="w-full flex items-center gap-3 px-3 py-2.5 bg-[#1a1a1a] border border-[#2a2a2a] hover:border-[#4285f4] rounded-lg text-sm text-[#ccc] hover:text-white transition-colors text-left disabled:opacity-50"
                  >
                    <span className="text-base">G</span>
                    <div>
                      <div className="font-medium">Sign in with Google</div>
                      <div className="text-xs text-[#555]">Sync all data across devices via Google Drive</div>
                    </div>
                  </button>
                ) : (
                  <>
                    <div className="px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg">
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-[#666]">
                          {gdriveStatus === "busy" ? (
                            <span className="text-[#4285f4]">Syncing…</span>
                          ) : gdriveSyncTime ? (
                            <>Last synced: <span className="text-[#ccc]">{new Date(gdriveSyncTime).toLocaleString()}</span></>
                          ) : (
                            <span className="text-[#555]">No sync file on Drive yet</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={handleGdriveSave}
                      disabled={gdriveStatus === "busy"}
                      className="w-full flex items-center gap-3 px-3 py-2.5 bg-[#1a1a1a] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg text-sm text-[#ccc] hover:text-white transition-colors text-left disabled:opacity-50"
                    >
                      <span className="text-base">↑</span>
                      <div>
                        <div className="font-medium">Save to Drive</div>
                        <div className="text-xs text-[#555]">Upload current data to Google Drive</div>
                      </div>
                    </button>
                    <button
                      onClick={handleGdriveSignOut}
                      className="w-full px-3 py-1.5 text-xs text-[#555] hover:text-[#999] transition-colors text-left"
                    >
                      Sign out
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Music Data section */}
          <div>
            <h3 className="text-xs font-semibold text-[#e87010] uppercase tracking-widest mb-3">Music Data</h3>
            <div className="space-y-2">
              <div className="px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg">
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-[#666]">
                  {musicSummary.transcriptions > 0 && <><span>Transcriptions</span><span className="text-[#ccc] text-right">{musicSummary.transcriptions}</span></>}
                  {musicSummary.chordCharts > 0 && <><span>Chord Charts</span><span className="text-[#ccc] text-right">{musicSummary.chordCharts}</span></>}
                  {musicSummary.practiceEntries > 0 && <><span>Practice Log</span><span className="text-[#ccc] text-right">{musicSummary.practiceEntries} days</span></>}
                  {musicSummary.drumExercises > 0 && <><span>Drum Exercises</span><span className="text-[#ccc] text-right">{musicSummary.drumExercises}</span></>}
                  {musicSummary.accentExercises > 0 && <><span>Accent Exercises</span><span className="text-[#ccc] text-right">{musicSummary.accentExercises}</span></>}
                  {musicSummary.transcriptions + musicSummary.chordCharts + musicSummary.practiceEntries + musicSummary.drumExercises + musicSummary.accentExercises === 0 && (
                    <span className="col-span-2 text-[#444]">No music data saved yet</span>
                  )}
                </div>
              </div>
              <button
                onClick={handleMusicExport}
                className="w-full flex items-center gap-3 px-3 py-2.5 bg-[#1a1a1a] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg text-sm text-[#ccc] hover:text-white transition-colors text-left"
              >
                <span className="text-base">↓</span>
                <div>
                  <div className="font-medium">Export Music Data</div>
                  <div className="text-xs text-[#555]">Transcriptions, chord charts, practice log, exercises</div>
                </div>
              </button>
              <button
                onClick={() => musicImportRef.current?.click()}
                className="w-full flex items-center gap-3 px-3 py-2.5 bg-[#1a1a1a] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg text-sm text-[#ccc] hover:text-white transition-colors text-left"
              >
                <span className="text-base">↑</span>
                <div>
                  <div className="font-medium">Import Music Data</div>
                  <div className="text-xs text-[#555]">Restore transcriptions, charts, and logs from backup</div>
                </div>
              </button>
              <input ref={musicImportRef} type="file" accept=".json" onChange={handleMusicImportFile} className="hidden" />
            </div>
          </div>

          {/* Academic Data section — only if academic components are present locally */}
          {academicAvailable && (<div>
            <h3 className="text-xs font-semibold text-[#8b5cf6] uppercase tracking-widest mb-3">Academic Data</h3>
            <div className="space-y-2">
              <div className="px-3 py-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg">
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-[#666]">
                  {academicSummary.files > 0 && <><span>Reading Files</span><span className="text-[#ccc] text-right">{academicSummary.files}</span></>}
                  {academicSummary.extracts > 0 && <><span>Text Extracts</span><span className="text-[#ccc] text-right">{academicSummary.extracts}</span></>}
                  {academicSummary.notes > 0 && <><span>Notes</span><span className="text-[#ccc] text-right">{academicSummary.notes}</span></>}
                  {academicSummary.questions > 0 && <><span>Questions</span><span className="text-[#ccc] text-right">{academicSummary.questions}</span></>}
                  {academicSummary.bookmarks > 0 && <><span>Bookmarks</span><span className="text-[#ccc] text-right">{academicSummary.bookmarks}</span></>}
                  {academicSummary.files === 0 && (
                    <span className="col-span-2 text-[#444]">No reading files saved yet</span>
                  )}
                </div>
              </div>
              <button
                onClick={handleAcademicExport}
                className="w-full flex items-center gap-3 px-3 py-2.5 bg-[#1a1a1a] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg text-sm text-[#ccc] hover:text-white transition-colors text-left"
              >
                <span className="text-base">↓</span>
                <div>
                  <div className="font-medium">Export Academic Data</div>
                  <div className="text-xs text-[#555]">Reading files, extracts, notes, questions, and PDFs</div>
                </div>
              </button>
              <button
                onClick={() => academicImportRef.current?.click()}
                className="w-full flex items-center gap-3 px-3 py-2.5 bg-[#1a1a1a] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg text-sm text-[#ccc] hover:text-white transition-colors text-left"
              >
                <span className="text-base">↑</span>
                <div>
                  <div className="font-medium">Import Academic Data</div>
                  <div className="text-xs text-[#555]">Restore reading files and PDFs from backup</div>
                </div>
              </button>
              <input ref={academicImportRef} type="file" accept=".json" onChange={handleAcademicImportFile} className="hidden" />
            </div>
          </div>)}

          {/* Data section */}
          <div>
            <h3 className="text-xs font-semibold text-[#888] uppercase tracking-widest mb-3">All Data</h3>
            <div className="space-y-2">
              <button
                onClick={handleExport}
                className="w-full flex items-center gap-3 px-3 py-2.5 bg-[#1a1a1a] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg text-sm text-[#ccc] hover:text-white transition-colors text-left"
              >
                <span className="text-base">↓</span>
                <div>
                  <div className="font-medium">Export Everything</div>
                  <div className="text-xs text-[#555]">All settings, stats, presets, and music data as JSON</div>
                </div>
              </button>
              <button
                onClick={() => importRef.current?.click()}
                className="w-full flex items-center gap-3 px-3 py-2.5 bg-[#1a1a1a] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg text-sm text-[#ccc] hover:text-white transition-colors text-left"
              >
                <span className="text-base">↑</span>
                <div>
                  <div className="font-medium">Import Everything</div>
                  <div className="text-xs text-[#555]">Restore from a full backup JSON file</div>
                </div>
              </button>
              <input ref={importRef} type="file" accept=".json" onChange={handleImportFile} className="hidden" />
            </div>
            {msg && <p className="text-xs text-[#7173e6] mt-2">{msg}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
