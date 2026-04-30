// ── Scoring (Quick Transcription) — unified entry point ─────────────
//
// Single project list for both Harmonic and Drum scores.  The
// instrument is chosen *per-score* at creation time, stored on the
// project, and used to route into the right editor when opened.
//
// There is intentionally no top-level instrument toggle — the user
// asked for "when i create a score and i select instrument it should
// be harmonic or drum".

import { useState, useMemo } from "react";
import {
  NoteEntryProject, Instrument, ScoreSetup,
  loadProjects, saveProject, deleteProject, newProject,
} from "@/lib/noteEntryData";
import NoteEntryMode from "./NoteEntryMode";
import DrumNotationMode from "./DrumNotationMode";

const DEFAULT_SETUP: ScoreSetup = {
  clef: "treble",
  keySignature: 0,
  defaultTimeSig: { num: 4, den: 4 },
  barCount: 8,
};

function instrumentOf(p: NoteEntryProject): Instrument {
  return p.instrument === "drum" ? "drum" : "harmonic";
}

export default function ScoringMode() {
  const [projects, setProjects] = useState<NoteEntryProject[]>(loadProjects);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newInstrument, setNewInstrument] = useState<Instrument>("harmonic");

  const activeProject = useMemo(
    () => projects.find(p => p.id === activeId) ?? null,
    [projects, activeId],
  );

  const refreshProjects = () => setProjects(loadProjects());

  function handleCreate() {
    const title = newTitle.trim() || "Untitled";
    const project = newProject(title, DEFAULT_SETUP);
    project.instrument = newInstrument;
    saveProject(project);
    setProjects(loadProjects());
    setActiveId(project.id);
    setShowNewDialog(false);
    setNewTitle("");
    setNewInstrument("harmonic");
  }

  function handleDelete(id: string) {
    deleteProject(id);
    setProjects(loadProjects());
    if (activeId === id) setActiveId(null);
  }

  // ── Editor view (controlled by ScoringMode) ──
  if (activeProject) {
    const inst = instrumentOf(activeProject);
    if (inst === "drum") {
      return (
        <DrumNotationMode
          controlledActiveId={activeProject.id}
          onBack={() => { setActiveId(null); refreshProjects(); }}
        />
      );
    }
    return (
      <NoteEntryMode
        controlledActiveId={activeProject.id}
        onBack={() => { setActiveId(null); refreshProjects(); }}
      />
    );
  }

  // ── Project list view ──
  return (
    <div className="px-4 py-6 max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-semibold text-white">Scoring</h2>
        <button
          onClick={() => { setShowNewDialog(true); setNewTitle(""); setNewInstrument("harmonic"); }}
          className="px-3 py-1.5 bg-[#7173e6] hover:bg-[#5a5cc7] text-white text-sm rounded font-medium transition-colors"
        >
          New score
        </button>
      </div>

      {projects.length === 0 ? (
        <p className="text-xs text-[#666]">No scores yet — create one above.</p>
      ) : (
        <ul className="divide-y divide-[#1a1a1a]">
          {projects
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(p => {
              const inst = instrumentOf(p);
              return (
                <li key={p.id} className="py-2">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setActiveId(p.id)}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setActiveId(p.id); }}
                    className="group flex items-center gap-3 cursor-pointer rounded-lg border border-[#1f1f1f] bg-[#111] hover:bg-[#161616] hover:border-[#333] transition-colors px-4 py-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white truncate">{p.title || "Untitled"}</div>
                      <div className="text-[10px] text-[#666] mt-0.5">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded mr-2 border ${
                            inst === "drum"
                              ? "border-[#5a4424] bg-[#1f1810] text-[#ddaa66]"
                              : "border-[#3a3a6a] bg-[#16162a] text-[#9999ee]"
                          }`}
                        >
                          {inst === "drum" ? "Drum" : "Harmonic"}
                        </span>
                        {p.setup.barCount} bars · {p.setup.defaultTimeSig.num}/{p.setup.defaultTimeSig.den}
                        {inst === "harmonic" ? ` · ${p.setup.clef} clef` : ""}
                        {" · "}
                        {new Date(p.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        setActiveId(p.id);
                      }}
                      className="px-3 py-1 text-xs rounded border border-[#7173e6] bg-[#7173e618] text-[#9999ee] hover:bg-[#7173e630] transition-colors"
                    >
                      Open
                    </button>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        if (!confirm(`Delete "${p.title || "Untitled"}"?`)) return;
                        handleDelete(p.id);
                      }}
                      className="text-[10px] text-[#555] hover:text-[#cc5555] px-2 py-1"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
        </ul>
      )}

      {showNewDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowNewDialog(false)}
        >
          <div
            className="bg-[#111] border border-[#2a2a2a] rounded-xl p-6 w-96 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-white font-semibold text-base">New Score</h3>

            <label className="block">
              <div className="text-[10px] text-[#666] uppercase tracking-wider mb-1">Title</div>
              <input
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                placeholder="Score title…"
                autoFocus
                className="w-full bg-[#1a1a1a] border border-[#333] rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-[#7173e6]"
                onKeyDown={e => {
                  if (e.key === "Escape") setShowNewDialog(false);
                  if (e.key === "Enter") handleCreate();
                }}
              />
            </label>

            <div>
              <div className="text-[10px] text-[#666] uppercase tracking-wider mb-2">Instrument</div>
              <div className="flex gap-2">
                {(["harmonic", "drum"] as Instrument[]).map(i => (
                  <button
                    key={i}
                    onClick={() => setNewInstrument(i)}
                    className={`flex-1 px-3 py-2 rounded border text-sm transition-colors ${
                      newInstrument === i
                        ? "bg-[#7173e618] border-[#7173e6] text-[#9999ee]"
                        : "bg-[#1a1a1a] border-[#2a2a2a] text-[#888] hover:text-[#ccc] hover:border-[#3a3a3a]"
                    }`}
                  >
                    {i === "harmonic" ? "Harmonic" : "Drum"}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-[#555] mt-2">
                {newInstrument === "harmonic"
                  ? "Pitched melody / chord transcription with treble or bass clef."
                  : "Drum-set notation with selectable noteheads (drum / X / circle-X / diamond) and synthesized playback."}
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={handleCreate}
                className="flex-1 bg-[#7173e6] hover:bg-[#5a5cc7] text-white text-sm rounded py-2 font-medium transition-colors"
              >
                Create
              </button>
              <button
                onClick={() => setShowNewDialog(false)}
                className="flex-1 bg-[#1a1a1a] border border-[#333] text-[#888] text-sm rounded py-2 transition-colors hover:text-white"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
