import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { ComponentType } from "react";
import LumatoneKeyboard from "@/components/LumatoneKeyboard";
import PianoKeyboard from "@/components/PianoKeyboard";
import GuitarFretboard from "@/components/GuitarFretboard";
import BassFretboard from "@/components/BassFretboard";
import { computeLayout, LayoutResult, ComputedKey } from "@/lib/lumatoneLayout";
import { audioEngine } from "@/lib/audioEngine";
import IntervalsTab from "@/components/tabs/IntervalsTab";
import ChordsTab from "@/components/tabs/ChordsTab";
import MelodyTab from "@/components/tabs/MelodyTab";
import JazzTab from "@/components/tabs/JazzTab";
import PatternsTab from "@/components/tabs/PatternsTab";
import DroneTab from "@/components/tabs/DroneTab";
import ModeIdentificationTab from "@/components/tabs/ModeIdentificationTab";



import PresetBar from "@/components/PresetBar";
import DrumPatterns from "@/components/DrumPatterns";
import ChordChart from "@/components/ChordChart";
import Konnakol from "@/components/Konnakol";
import VocalPercussion from "@/components/VocalPercussion";
import MixedGroups from "@/components/MixedGroups";
import NoteEntryMode from "@/components/NoteEntryMode";
import PhraseDecomposition from "@/components/PhraseDecomposition";
// Academic mode components — gitignored, only present in local dev
const academicModules = import.meta.glob([
  "./components/ReadingWorkflo*.tsx",
  "./components/NoteWritin*.tsx",
  "./components/SimpleDo*.tsx",
]);
import LatticeView from "@/components/LatticeView";
import IntervalBrowser from "@/components/IntervalBrowser";
import MicrowaveMode from "@/components/MicrowaveMode";
import TemperamentExplorer from "@/components/TemperamentExplorer";
import MathLab from "@/components/MathLab";
import MelodicPatterns from "@/components/MelodicPatterns";
import HarmonyWorkshop from "@/components/HarmonyWorkshop";
import DrillResponse from "@/components/DrillResponse";
import UncommonMetersMode from "@/components/UncommonMetersMode";
import MetronomeStrip from "@/components/MetronomeStrip";
import CountdownTimer from "@/components/CountdownTimer";
import PracticeLogModal from "@/components/PracticeLogModal";
import type { AccentImportMode } from "@/components/PracticeLogModal";
import SettingsModal from "@/components/SettingsModal";
import { useMetronome } from "@/hooks/useMetronome";
import { useLS, lsSet, getKnownOptions, localToday } from "@/lib/storage";
import { initFolderSync, getStatus as getFolderSyncStatus, reconnectFolder, type SyncState } from "@/lib/folderSync";
import { recordAnswer, getDayTotals, accuracy, setImportBias, getImportBias, clearImportBias, removeSlotAnswers } from "@/lib/stats";
import { getSavedToken, downloadSync, uploadSync, clearToken } from "@/lib/googleDrive";
import { buildSyncPayload, restoreFromSyncPayload } from "@/lib/syncData";
import { getEDOIntervals, getLayoutFile, pcToNoteNameWithEnharmonic, formatHalfAccidentals } from "@/lib/edoData";
import {
  PracticeLogEntry,
  PracticeRating,
  addPracticeEntry,
  captureEarTrainerSnapshot,
  captureEarTrainerSettingsSnapshot,
  restoreEarTrainerSnapshot,
  writePendingRestore,
} from "@/lib/practiceLog";

const EDO_OPTIONS = [12, 17, 19, 31, 41, 53];

type VisualizerType = "lumatone" | "piano" | "guitar" | "bass";
const VIZ_LABELS: Record<VisualizerType, string> = {
  lumatone: "Lumatone",
  piano: "Piano",
  guitar: "Guitar",
  bass: "Bass",
};

type Tab = "intervals"|"chords"|"melody"|"jazz"|"patterns"|"drone"|"modeid";
type ResponseMode = "Play Audio"|"Show Target (Sing It)";
type DroneMode = "Single"|"Root+5th"|"Tanpura";

const TAB_LABELS: Record<Tab, string> = {
  intervals: "Intervals", chords: "Chords",
  melody: "Melody", jazz: "Jazz Cells", patterns: "Patterns",
  drone: "Chord Drone", modeid: "Mode ID",
};

const OCT_OPTIONS = [1,2,3,4,5,6,7];
const VALID_TABS: Tab[] = ["intervals","chords","melody","jazz","patterns","drone","modeid"];

// ── Settings snapshot types (shared with tabs) ──────────────────────
export interface SettingsGroup {
  label: string;
  items: string[];
}
export interface TabSettingsSnapshot {
  title: string;           // e.g., "Chord Progression (Functional Harmony)"
  groups: SettingsGroup[];  // collapsible subsections of settings
}

interface SlotHistoryEntry {
  id: number;
  /** All selected options when slot started: key → label */
  options: Record<string, string>;
  /** Structured settings snapshot from the active tab */
  settings: TabSettingsSnapshot | null;
  stats: Array<{ key: string; label: string; c: number; w: number }>;
  open: boolean;
  openSections: Set<string>;
  rating: PracticeRating;
  logged: boolean;
}


export default function App() {
  const metronome = useMetronome();

  const [layout, setLayout] = useState<LayoutResult | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [highlighted, setHighlighted] = useState<Set<number>>(new Set());
  const [statusText, setStatusText] = useState<string>("");
  const [showPracticeLog, setShowPracticeLog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // tabKey increments when a preset is loaded → forces all tabs to re-mount
  const [tabKey, setTabKey] = useState(0);
  const [drumTabKey, setDrumTabKey] = useState(0);
  const [drumRestoreTrigger, setDrumRestoreTrigger] = useState(0);
  const tabContentRef = useRef<HTMLDivElement>(null);
  // Accumulate accent line/phrase imports while practice log modal is open
  const accentImportQueue = useRef<{ measures: unknown[]; grid: string; importMode: string }[]>([]);
  const [accentQueueCount, setAccentQueueCount] = useState(0);

  // ── Persisted global settings ──────────────────────────────────────
  const [activeTab, setActiveTab] = useLS<Tab>("lt_app_tab", "intervals");
  // Sanitise on first render in case a removed tab is still in localStorage
  useEffect(() => {
    if (!VALID_TABS.includes(activeTab)) setActiveTab("intervals");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for cross-component navigation requests
  useEffect(() => {
    function handleNav(e: Event) {
      const target = (e as CustomEvent).detail as string;
      if (target) { stopAllAudio(); setSection(target); }
    }
    window.addEventListener("app-navigate", handleNav);
    return () => window.removeEventListener("app-navigate", handleNav);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [edo, setEdo] = useLS<number>("lt_app_edo", 31);
  const [vizType, setVizType] = useLS<VisualizerType>("lt_app_vizType", "lumatone");
  const [tonicPc, setTonicPc] = useLS<number>("lt_app_tonic", 0);
  const [lowestOct, setLowestOct] = useLS<number>("lt_app_lowestOct", 3);
  const [highestOct, setHighestOct] = useLS<number>("lt_app_highestOct", 5);
  const [responseMode, setResponseMode] = useLS<ResponseMode>("lt_app_responseMode", "Play Audio");
  // droneTonal removed — drone now uses tonicPc directly
  const [droneOct, setDroneOct] = useLS<number>("lt_app_droneOct", 4);
  const [droneMode, setDroneMode] = useLS<DroneMode>("lt_app_droneMode", "Single");
  const [droneVol, setDroneVol] = useLS<number>("lt_app_droneVol", 0.08);
  const [droneIsOn, setDroneIsOn] = useState(false);
  const [section, setSection] = useLS<string>("lt_app_section", "ear-trainer");
  const [dronePulse, setDronePulse] = useLS<boolean>("lt_app_dronePulse", false);
  const [dronePulseDur, setDronePulseDur] = useLS<number>("lt_app_dronePulseDur", 4);
  const [playVol, setPlayVol] = useLS<number>("lt_app_playVol", 1.0);
  const [betaPlayRotation, setBetaPlayRotation] = useLS<boolean>("lt_beta_play_rotation", false);
  const [betaIntervalChain, setBetaIntervalChain] = useLS<boolean>("lt_beta_interval_chain", false);
  const [betaComma, setBetaComma] = useLS<boolean>("lt_beta_comma", false);
  const [betaMathLab, setBetaMathLab] = useLS<boolean>("lt_beta_math_lab", false);
  const [betaTransform, setBetaTransform] = useLS<boolean>("lt_beta_transform", false);
  const [academicMode, setAcademicMode] = useLS<boolean>("lt_academic_mode", false);
  // Dynamically load academic components (only present in local dev)
  const [academicComps, setAcademicComps] = useState<{
    ReadingWorkflow?: ComponentType;
    NoteWriting?: ComponentType;
    SimpleDoc?: ComponentType;
  }>({});
  useEffect(() => {
    const entries = Object.entries(academicModules);
    Promise.all(entries.map(([path, loader]) =>
      loader().then((m: any) => [path, m.default] as const).catch(() => [path, null] as const)
    )).then(results => {
      const next: { ReadingWorkflow?: ComponentType; NoteWriting?: ComponentType; SimpleDoc?: ComponentType } = {};
      for (const [path, comp] of results) {
        if (!comp) continue;
        if (path.includes("ReadingWorkflow")) next.ReadingWorkflow = comp;
        else if (path.includes("NoteWriting")) next.NoteWriting = comp;
        else if (path.includes("SimpleDoc")) next.SimpleDoc = comp;
      }
      setAcademicComps(next);
    });
  }, []);
  const academicAvailable = Boolean(academicComps.ReadingWorkflow || academicComps.NoteWriting || academicComps.SimpleDoc);
  // If academic mode was enabled but no components are present, flip it off
  useEffect(() => { if (academicMode && !academicAvailable) setAcademicMode(false); }, [academicMode, academicAvailable, setAcademicMode]);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulsePhase = useRef<"on" | "off">("on");

  // ── Local folder sync ──────────────────────────────────────────────
  const [folderSyncState, setFolderSyncState] = useState<SyncState>("disconnected");
  const [folderSyncName, setFolderSyncName] = useState<string | undefined>(undefined);
  const [folderReconnecting, setFolderReconnecting] = useState(false);
  const [folderPromptOpen, setFolderPromptOpen] = useState(false);
  const folderPromptShownOnce = useRef(false);
  useEffect(() => {
    initFolderSync();
    const refresh = () => {
      void getFolderSyncStatus().then(s => {
        setFolderSyncState(s.state);
        setFolderSyncName(s.folderName);
        // Auto-open the prompt once per session when a stored folder needs re-permission.
        if (s.state === "needs-permission" && !folderPromptShownOnce.current) {
          folderPromptShownOnce.current = true;
          setFolderPromptOpen(true);
        }
      });
    };
    refresh();
    window.addEventListener("lt-folder-sync-status", refresh);
    return () => window.removeEventListener("lt-folder-sync-status", refresh);
  }, []);
  const handleFolderReconnect = async () => {
    setFolderReconnecting(true);
    const res = await reconnectFolder({ loadFromFolder: true });
    setFolderReconnecting(false);
    if (res.ok) {
      setFolderPromptOpen(false);
      setTabKey(k => k + 1); // re-mount tabs so UI picks up restored data
    }
  };

  // ── Google Drive auto-sync ─────────────────────────────────────────
  const gdriveInitDone = useRef(false);
  useEffect(() => {
    if (gdriveInitDone.current) return;
    gdriveInitDone.current = true;
    const token = getSavedToken();
    if (!token) return;
    // Download from Drive on page load
    (async () => {
      try {
        const data = await downloadSync(token);
        if (data) restoreFromSyncPayload(data);
      } catch (err) {
        if (err instanceof Error && err.message.includes("401")) clearToken();
      }
    })();
    // Upload to Drive when tab becomes hidden (user switches tab or closes)
    const handleVisChange = () => {
      if (document.visibilityState !== "hidden") return;
      const t = getSavedToken();
      if (!t) return;
      const payload = buildSyncPayload();
      uploadSync(t, payload).catch(() => {});
    };
    document.addEventListener("visibilitychange", handleVisChange);
    return () => document.removeEventListener("visibilitychange", handleVisChange);
  }, []);

  // ── Keyboard highlight ─────────────────────────────────────────────
  const lastHighlightPcs = useRef<number[]>([]);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Stats: pending answer context ─────────────────────────────────
  const pendingAnswer = useRef<{ optionKey: string; label: string } | null>(null);
  const [awaitingAnswer, setAwaitingAnswer] = useState(false);
  const [todayC, setTodayC] = useState(0);
  const [todayW, setTodayW] = useState(0);

  // Session-scoped tally (resets on page load)
  const [sessionC, setSessionC] = useState(0);
  const [sessionW, setSessionW] = useState(0);

  // Slot-scoped tally (resets when active options change)
  const [slotC, setSlotC] = useState(0);
  const [slotW, setSlotW] = useState(0);
  const slotOptionsHash = useRef<string>("");

  // Per-option session stats
  const optionSessionStats = useRef<Map<string, { c: number; w: number; label: string }>>(new Map());
  const [sessionStatsVersion, setSessionStatsVersion] = useState(0);
  const [lastOptionKey, setLastOptionKey] = useState<string | null>(null);
  const [showSessionHistory, setShowSessionHistory] = useState(false);

  // ── Tab settings ref: each tab writes its current settings snapshot ──
  const tabSettingsRef = useRef<TabSettingsSnapshot | null>(null);

  // ── Slot history: archives stats when settings change ─────────────
  const [slotHistory, setSlotHistory] = useState<SlotHistoryEntry[]>([]);
  const slotIdCounter = useRef(0);
  const currentSlotStats = useRef<Map<string, { c: number; w: number; label: string }>>(new Map());
  // Snapshot of all selected options when the current slot started
  const currentSlotOptions = useRef<Record<string, string>>({});
  const currentSlotSettings = useRef<TabSettingsSnapshot | null>(null);
  const [activeSlotRating, setActiveSlotRating] = useState<PracticeRating>(0);
  const activeSlotRatingRef = useRef<PracticeRating>(0);
  useEffect(() => { activeSlotRatingRef.current = activeSlotRating; }, [activeSlotRating]);
  const [activeSlotOpenSections, setActiveSlotOpenSections] = useState<Set<string>>(new Set(["__stats__"]));
  const [activeSlotLogged, setActiveSlotLogged] = useState(false);
  const [logFlash, setLogFlash] = useState("");

  // Archive the current slot into history (called on tab change + settings change)
  const archiveCurrentSlot = useCallback(() => {
    if (currentSlotStats.current.size === 0) return;
    const entries = Array.from(currentSlotStats.current.entries())
      .map(([key, v]) => ({ key, label: v.label, c: v.c, w: v.w }));
    const settings = currentSlotSettings.current
      ? { ...currentSlotSettings.current, groups: [...currentSlotSettings.current.groups] }
      : null;
    setSlotHistory(prev => [...prev, {
      id: slotIdCounter.current++,
      options: { ...currentSlotOptions.current },
      settings,
      stats: entries,
      open: false,
      openSections: new Set<string>(),
      rating: activeSlotRatingRef.current,
      logged: false,
    }]);
    currentSlotStats.current = new Map();
    currentSlotSettings.current = null;
    currentSlotOptions.current = {};
    slotOptionsHash.current = "";
    setActiveSlotRating(0);
    activeSlotRatingRef.current = 0;
    setActiveSlotOpenSections(new Set(["__stats__"]));
    setActiveSlotLogged(false);
    setSlotC(0);
    setSlotW(0);
  }, []);

  // Archive when switching tabs so each tab's history stays independent
  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    if (prevTabRef.current !== activeTab) {
      archiveCurrentSlot();
      prevTabRef.current = activeTab;
    }
  }, [activeTab, archiveCurrentSlot]);

  const refreshTodayTotals = () => {
    const { correct, wrong } = getDayTotals(localToday());
    setTodayC(correct);
    setTodayW(wrong);
  };
  useEffect(() => { refreshTodayTotals(); }, []);

  const lastPlayed = useRef<{frames: number[][]; info: string} | null>(null);

  useEffect(() => {
    setLayout(null);
    fetch(getLayoutFile(edo))
      .then(r => r.json())
      .then(data => setLayout(computeLayout(data)))
      .catch(err => console.error("Failed to load layout:", err));
  }, [edo]);

  // Pitch bounds from the loaded layout JSON
  const layoutPitchRange = useMemo(() => {
    if (!layout || !layout.keys.length) return null;
    const pitches = layout.keys.map(k => k.pitch);
    return { min: Math.min(...pitches), max: Math.max(...pitches) };
  }, [layout]);

  const ensureAudio = useCallback(async () => {
    if (!audioReady || !audioEngine.isReady()) {
      await audioEngine.init(edo);
      audioEngine.setPlayGain(playVol);
      setAudioReady(true);
    } else {
      audioEngine.resume();
    }
  }, [audioReady, playVol, edo]);

  useEffect(() => {
    if (audioReady) {
      audioEngine.setPlayGain(playVol);
    }
  }, [playVol, audioReady]);

  // ── Drone helpers ──────────────────────────────────────────────────
  const buildDroneNotes = (tonal: number, oct: number, mode: DroneMode): { notes: number[]; gains?: number[] } => {
    const abs = tonal + (oct - 4) * edo;
    const P5 = getEDOIntervals(edo).P5;
    if (mode === "Root+5th") return { notes: [abs, abs + P5] };
    // Tanpura: lower Sa, Sa, Pa, upper Sa — balanced like a real tanpura
    if (mode === "Tanpura")  return { notes: [abs - edo, abs, abs + P5, abs + edo], gains: [0.5, 1.0, 0.7, 0.8] };
    return { notes: [abs] };
  };

  const startHeaderDrone = async () => {
    await ensureAudio();
    const { notes, gains } = buildDroneNotes(tonicPc, droneOct, droneMode);
    audioEngine.startDrone(notes, edo, droneVol, gains);
    setDroneIsOn(true);
  };

  const stopHeaderDrone = () => {
    if (pulseTimer.current) { clearTimeout(pulseTimer.current); pulseTimer.current = null; }
    audioEngine.stopDrone();
    setDroneIsOn(false);
  };

  // ── Global stop: kill ALL audio (drone, scheduled notes, metronome) ──
  const stopAllAudio = useCallback(() => {
    if (pulseTimer.current) { clearTimeout(pulseTimer.current); pulseTimer.current = null; }
    if (highlightTimer.current) { clearTimeout(highlightTimer.current); highlightTimer.current = null; }
    audioEngine.stopAll();
    metronome.stop();
    setDroneIsOn(false);
    setAudioReady(false);
    setHighlighted(new Set());
    setStatusText("");
  }, [metronome]);

  // ── Pulse timer effect ─────────────────────────────────────────────
  useEffect(() => {
    if (!dronePulse || !droneIsOn) {
      if (pulseTimer.current) { clearTimeout(pulseTimer.current); pulseTimer.current = null; }
      return;
    }
    const scheduleNext = (phase: "on" | "off") => {
      pulseTimer.current = setTimeout(() => {
        if (phase === "on") {
          audioEngine.stopDrone();
          pulsePhase.current = "off";
          scheduleNext("off");
        } else {
          const dn = buildDroneNotes(tonicPc, droneOct, droneMode);
          audioEngine.startDrone(dn.notes, edo, droneVol, dn.gains);
          pulsePhase.current = "on";
          scheduleNext("on");
        }
      }, dronePulseDur * 1000);
    };
    pulsePhase.current = "on";
    scheduleNext("on");
    return () => { if (pulseTimer.current) { clearTimeout(pulseTimer.current); pulseTimer.current = null; } };
  }, [dronePulse, droneIsOn, dronePulseDur, tonicPc, droneOct, droneMode, droneVol, edo]);

  const handleDroneVolChange = (v: number) => {
    setDroneVol(v);
    if (droneIsOn) audioEngine.setDroneGain(v);
  };

  // ── Keyboard highlight ─────────────────────────────────────────────
  const handleHighlight = useCallback((pcs: number[]) => {
    lastHighlightPcs.current = pcs;
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlighted(new Set(pcs));
    // In Show Target mode keep the highlight on permanently; in Play Audio auto-clear after 3s
    if (responseMode !== "Show Target (Sing It)") {
      highlightTimer.current = setTimeout(() => setHighlighted(new Set()), 3000);
    }
  }, [responseMode]);

  const handleShowOnKeyboard = useCallback(() => {
    const pcs = lastHighlightPcs.current;
    if (!pcs.length) return;
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlighted(new Set(pcs));
    // Button always keeps it on until the next question clears it
  }, []);

  // ── Result callback: tab calls this after playing a question ───────
  const handleResult = useCallback((text: string) => {
    setStatusText(text);
  }, []);

  // Called by each tab with its option key + label whenever it plays
  const handlePlay = useCallback((optionKey: string, label: string) => {
    pendingAnswer.current = { optionKey, label };
    setAwaitingAnswer(true);
    setLastOptionKey(optionKey);
    // Check if active options OR settings changed → archive current slot & reset
    const known = Object.keys(getKnownOptions()).sort().join("|");
    const settingsHash = tabSettingsRef.current
      ? tabSettingsRef.current.groups.map(g => `${g.label}:${g.items.join(",")}`).join("|")
      : "";
    const combinedHash = `${known}||${settingsHash}`;
    if (slotOptionsHash.current && combinedHash !== slotOptionsHash.current) {
      archiveCurrentSlot();
    }
    slotOptionsHash.current = combinedHash;
    // Snapshot all selected options and settings when slot starts/changes
    currentSlotOptions.current = getKnownOptions();
    currentSlotSettings.current = tabSettingsRef.current ? { ...tabSettingsRef.current, groups: [...tabSettingsRef.current.groups] } : null;
    // Clear any pinned keyboard highlight so the new question starts fresh
    if (responseMode === "Play Audio") {
      setHighlighted(new Set());
    }
  }, [responseMode, archiveCurrentSlot]);

  // Shared answer tracking — updates session, slot, per-option, and current-slot counters
  const trackAnswer = useCallback((optionKey: string, label: string, correct: boolean) => {
    if (correct) { setSessionC(c => c + 1); setSlotC(c => c + 1); }
    else { setSessionW(w => w + 1); setSlotW(w => w + 1); }
    setLastOptionKey(optionKey);
    const prev = optionSessionStats.current.get(optionKey) ?? { c: 0, w: 0, label };
    if (correct) prev.c++; else prev.w++;
    optionSessionStats.current.set(optionKey, prev);
    // Also track in current slot stats
    const slotPrev = currentSlotStats.current.get(optionKey) ?? { c: 0, w: 0, label };
    if (correct) slotPrev.c++; else slotPrev.w++;
    currentSlotStats.current.set(optionKey, slotPrev);
    setSessionStatsVersion(v => v + 1);
    refreshTodayTotals();
  }, []);

  const handleAnswer = (correct: boolean) => {
    if (!pendingAnswer.current) return;
    const { optionKey, label } = pendingAnswer.current;
    recordAnswer(optionKey, label, correct);
    pendingAnswer.current = null;
    setAwaitingAnswer(false);
    trackAnswer(optionKey, label, correct);
  };

  // ── Key click ──────────────────────────────────────────────────────
  const handleKeyClick = useCallback(async (key: ComputedKey) => {
    await ensureAudio();
    audioEngine.playNote(key.pitch, edo, 1.0, 0.8);
    setHighlighted(new Set([key.pitch]));
    setTimeout(() => setHighlighted(new Set()), 1500);
  }, [ensureAudio, edo]);

  // ── Answer buttons injected into each tab next to its Show Answer ─
  const answerButtons = (responseMode === "Play Audio" && awaitingAnswer) ? (
    <div className="flex items-center gap-2 flex-shrink-0">
      <span className="text-xs text-[#555]">Got it?</span>
      <button onClick={() => handleAnswer(true)}
        className="px-3 py-1 bg-[#1a3a1a] border border-[#3a6a3a] text-[#5cca5c] hover:bg-[#1e4a1e] rounded text-sm font-bold transition-colors">
        ✓
      </button>
      <button onClick={() => handleAnswer(false)}
        className="px-3 py-1 bg-[#3a1a1a] border border-[#6a3a3a] text-[#e06060] hover:bg-[#4a1e1e] rounded text-sm font-bold transition-colors">
        ✗
      </button>
    </div>
  ) : null;

  // ── Shared props for every tab ─────────────────────────────────────
  const sharedTabProps = {
    tonicPc, lowestOct, highestOct, edo: edo,
    onHighlight: handleHighlight, responseMode,
    onResult: handleResult,
    onPlay: handlePlay,
    onAnswer: trackAnswer,
    onShowOnKeyboard: handleShowOnKeyboard,
    lastPlayed, ensureAudio, playVol,
    tabSettingsRef,
    layoutPitchRange: layoutPitchRange ?? undefined,
    answerButtons,
  };

  const tabs = (["intervals","chords","melody","jazz","patterns","drone","modeid"] as Tab[]);

  const sessionAcc = (sessionC + sessionW) ? `${Math.round(100 * sessionC / (sessionC + sessionW))}%` : "";
  const slotAcc = (slotC + slotW) ? `${Math.round(100 * slotC / (slotC + slotW))}%` : "";
  const lastOpt = lastOptionKey ? optionSessionStats.current.get(lastOptionKey) : null;
  const lastOptAcc = lastOpt && (lastOpt.c + lastOpt.w) ? `${Math.round(100 * lastOpt.c / (lastOpt.c + lastOpt.w))}%` : "";

  return (
    <div className={`bg-[#0d0d0d] text-white flex flex-col ${(section === "reading-workflow" || section === "temperament-explorer" || section === "math-lab") ? "h-screen overflow-hidden" : "min-h-screen overflow-y-auto"}`}>
      {/* ── Header ── */}
      <div className="border-b border-[#1e1e1e] px-4 pt-4 pb-3 flex-shrink-0">
        <div className="space-y-3">

          {/* Row 1: Title + Section selector + Export/Import + EDO */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3">
              <select
                value={section}
                onChange={e => { stopAllAudio(); setSection(e.target.value); }}
                className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none"
              >
                {academicMode ? (<>
                  <option value="reading-workflow">Reading Workflow</option>
                  <option value="note-writing">Note Writing</option>
                  <option value="simple-doc">Document</option>
                </>) : (<>
                  <optgroup label="Useful">
                    <option value="ear-trainer">Spatial Audiation</option>
                    <option value="drum-patterns">Drum Patterns</option>
                    <option value="vocal-percussion">Vocal Percussion</option>
                    <option value="mixed-groups">Mixed Groups</option>
                    <option value="melodic-patterns">Melodic Patterns</option>
                    <option value="harmony-workshop">Harmony Workshop</option>
                  </optgroup>
                  <optgroup label="Experimental">
                    <option value="chord-chart">Chord Chart</option>
                    <option value="drill-response">Drill & Response</option>
                    <option value="uncommon-meters">Uncommon Meters</option>
                    <option value="konnakol">Solkattu</option>
                    <option value="note-entry">Quick Transcriptions</option>
                    <option value="phrase-decomposition">Phrase Decomposition</option>
                    <option value="lattice">Harmonic Lattice</option>
                    <option value="interval-browser">Interval Browser</option>
                    <option value="microwave">Microwave</option>
                    <option value="temperament-explorer">Temperament Explorer</option>
                    {betaMathLab && <option value="math-lab">Math Lab</option>}
                  </optgroup>
                </>)}
              </select>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              {!academicMode && <button onClick={stopAllAudio}
                className="px-2 py-1 bg-[#1a1a1a] border border-[#2a2a2a] text-[#888] hover:bg-[#2a1a1a] hover:border-[#5a2a2a] hover:text-[#cc6666] active:bg-[#3a1a1a] active:text-[#ff7777] rounded text-xs font-medium transition-colors"
                title="Stop all audio">
                ■ Stop Audio
              </button>}
              {!academicMode && <button onClick={() => setShowPracticeLog(true)}
                className="px-2 py-1 bg-[#0e1a0e] border border-[#2a4a2a] text-[#5a8a5a] hover:text-[#7aaa7a] rounded text-xs transition-colors">
                Practice Log
              </button>}
              {folderSyncState === "needs-permission" && (
                <button
                  onClick={handleFolderReconnect}
                  disabled={folderReconnecting}
                  className="px-2 py-1 bg-[#2a1a0a] border border-[#5a3a1a] text-[#d89a4a] hover:text-[#ffcf88] hover:border-[#7a5a2a] rounded text-xs transition-colors disabled:opacity-50"
                  title="Reconnect to your sync folder (browser requires a click after reload)"
                >
                  {folderReconnecting ? "Reconnecting…" : "Reconnect folder"}
                </button>
              )}
              <button onClick={() => setShowSettings(true)}
                className="p-1.5 bg-[#1a1a1a] border border-[#2a2a2a] text-[#666] hover:text-[#aaa] rounded transition-colors"
                title="Settings">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
          </div>

          {/* Metronome + Timer strip — hidden in academic mode and in
              Mixed Groups (which has its own per-pulse metronome). */}
          {!academicMode && section !== "mixed-groups" && <div className="flex flex-wrap items-center gap-3">
            <MetronomeStrip
              bpm={metronome.bpm}
              setBpm={metronome.setBpm}
              running={metronome.running}
              beat={metronome.beat}
              start={metronome.start}
              stop={metronome.stop}
            />
            <div className="w-px h-4 bg-[#2a2a2a]" />
            <CountdownTimer />
          </div>}

          {section === "ear-trainer" && (<>
          {/* Row 2: Ear-trainer controls */}
          <div className="bg-[#111] border border-[#222] rounded-lg px-3 py-2 flex flex-col gap-2">
            {/* Top row: Tonic (shared) · Exercise range · Response mode · Play vol · ♪ Tonic */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-[#666]">Tonic</label>
                <select value={tonicPc}
                  onChange={e => setTonicPc(Number(e.target.value))}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
                  {Array.from({ length: edo }, (_, i) => (
                    <option key={i} value={i}>{formatHalfAccidentals(pcToNoteNameWithEnharmonic(i, edo))}</option>
                  ))}
                </select>
              </div>
              <div className="w-px h-4 bg-[#2a2a2a]" />
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-[#666]">Exercise Range</label>
                <select value={lowestOct} onChange={e => setLowestOct(Number(e.target.value))}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
                  {OCT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                <span className="text-xs text-[#555]">–</span>
                <select value={highestOct} onChange={e => setHighestOct(Number(e.target.value))}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
                  {OCT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div className="w-px h-4 bg-[#2a2a2a]" />
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-[#666]">Response</label>
                <select value={responseMode} onChange={e => setResponseMode(e.target.value as ResponseMode)}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
                  <option>Play Audio</option>
                  <option>Show Target (Sing It)</option>
                </select>
              </div>
              <div className="w-px h-4 bg-[#2a2a2a]" />
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-[#666]">Play Vol</label>
                <input type="range" min={0} max={1.5} step={0.01} value={playVol}
                  onChange={e => setPlayVol(Number(e.target.value))}
                  className="w-20 accent-[#7173e6]" />
                <span className="text-xs text-[#555] w-8">{Math.round(playVol * 100)}%</span>
              </div>
              <button onClick={async () => {
                await ensureAudio();
                const midOct = Math.floor((lowestOct + highestOct) / 2);
                const tonicNote = tonicPc + (midOct - 4) * edo;
                audioEngine.playNote(tonicNote, edo, 1.0, 0.8);
                handleHighlight([tonicNote]);
              }}
                className="px-3 py-1 rounded text-xs font-medium transition-colors border bg-[#1a1a1a] border-[#333] text-[#888] hover:text-white hover:border-[#555]"
                title="Play and highlight tonic note">
                ♪ Tonic
              </button>
            </div>
            {/* Bottom row: Drone — uses shared tonic, own octave */}
            <div className="flex flex-wrap items-center gap-3 border-t border-[#1e1e1e] pt-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-[#888] tracking-widest uppercase">Drone</span>
                {droneIsOn && <span className="w-2 h-2 rounded-full bg-[#7173e6] animate-pulse inline-block" />}
              </div>
              <button onClick={startHeaderDrone}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors border ${droneIsOn ? "bg-[#7173e6] border-[#7173e6] text-white" : "bg-[#1a1a1a] border-[#333] text-[#888] hover:text-white hover:border-[#555]"}`}>
                ON
              </button>
              <button onClick={stopHeaderDrone}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors border ${!droneIsOn ? "bg-[#3a1a1a] border-[#5a2a2a] text-[#cc6666]" : "bg-[#1a1a1a] border-[#333] text-[#888] hover:text-white hover:border-[#555]"}`}>
                OFF
              </button>
              <div className="w-px h-4 bg-[#2a2a2a]" />
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-[#666]">Drone Oct</label>
                <select value={droneOct} onChange={e => setDroneOct(Number(e.target.value))}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
                  {OCT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-[#666]">Type</label>
                <select value={droneMode} onChange={e => setDroneMode(e.target.value as DroneMode)}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
                  <option>Single</option><option>Root+5th</option><option>Tanpura</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-[#666]">Drone Vol</label>
                <input type="range" min={0} max={0.3} step={0.005} value={droneVol}
                  onChange={e => handleDroneVolChange(Number(e.target.value))}
                  className="w-20 accent-[#7173e6]" />
                <span className="text-xs text-[#555] w-7">{Math.round(droneVol * 100 / 0.3)}%</span>
              </div>
              <div className="w-px h-4 bg-[#2a2a2a]" />
              <button
                onClick={() => setDronePulse(!dronePulse)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors border ${
                  dronePulse
                    ? "bg-[#7173e6] border-[#7173e6] text-white"
                    : "bg-[#1a1a1a] border-[#333] text-[#888] hover:text-white hover:border-[#555]"
                }`}>
                Pulse
              </button>
              {dronePulse && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number" min={1} max={60} value={dronePulseDur}
                    onChange={e => setDronePulseDur(Math.max(1, Math.min(60, Number(e.target.value))))}
                    className="w-12 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none text-center" />
                  <span className="text-xs text-[#555]">sec</span>
                </div>
              )}
            </div>
          </div>

          {/* Keyboard intentionally rendered OUTSIDE the header (after it,
               as a direct child of root) so its `sticky top-0` works across
               the full scroll range instead of detaching at the header's
               bottom edge. See the sticky wrapper after the header block. */}

          {/* EDO selector row */}
          <div className="flex items-center gap-3 min-h-6">
            <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
              {/* Import bias indicator */}
              {getImportBias() && (
                <>
                  <div className="w-px h-4 bg-[#2a2a2a]" />
                  <button
                    onClick={() => { clearImportBias(); setSessionStatsVersion(v => v + 1); }}
                    className="text-[10px] text-[#e0a040] hover:text-[#ffcc66] border border-[#e0a04033] bg-[#1a1508] rounded px-1.5 py-0.5"
                    title="Import bias active — click to clear"
                  >
                    BIAS ✕
                  </button>
                </>
              )}
              <div className="w-px h-4 bg-[#2a2a2a]" />
              <label className="text-xs text-[#666]">EDO</label>
              <select value={edo} onChange={e => setEdo(Number(e.target.value))}
                className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
                {EDO_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              {edo === 12 && (
                <>
                  <div className="w-px h-4 bg-[#2a2a2a]" />
                  <select value={vizType} onChange={e => setVizType(e.target.value as VisualizerType)}
                    className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
                    {(Object.keys(VIZ_LABELS) as VisualizerType[]).map(v => (
                      <option key={v} value={v}>{VIZ_LABELS[v]}</option>
                    ))}
                  </select>
                </>
              )}
            </div>
          </div>
          </>)}
        </div>
      </div>

      {/* Sticky keyboard — sits as a direct child of the scrolling root
          (not nested in the header) so its `sticky top-0` containing block
          spans the full scroll range. Only shown in spatial audiation. */}
      {section === "ear-trainer" && (
        <div className="sticky top-0 z-30 bg-[#0d0d0d] border-b border-[#1e1e1e] px-4 pt-2 pb-2 flex-shrink-0">
          {edo === 12 && vizType === "piano" ? (
            <PianoKeyboard highlightedPitches={highlighted}
              onKeyClick={async (k) => { await ensureAudio(); handleKeyClick(k as ComputedKey); }} />
          ) : edo === 12 && vizType === "guitar" ? (
            <GuitarFretboard highlightedPitches={highlighted}
              onKeyClick={async (k) => { await ensureAudio(); handleKeyClick(k as ComputedKey); }} />
          ) : edo === 12 && vizType === "bass" ? (
            <BassFretboard highlightedPitches={highlighted}
              onKeyClick={async (k) => { await ensureAudio(); handleKeyClick(k as ComputedKey); }} />
          ) : layout ? (
            <LumatoneKeyboard layout={layout} highlightedPitches={highlighted}
              onKeyClick={async (k) => { await ensureAudio(); handleKeyClick(k); }} />
          ) : (
            <div className="bg-[#111] rounded-xl border border-[#222] h-36 flex items-center justify-center text-[#444] text-xs">
              Loading keyboard…
            </div>
          )}
        </div>
      )}

      {/* ── Drill & Response ── */}
      {section === "drill-response" && (
        <div className="flex-1 overflow-y-auto px-4">
          <DrillResponse />
        </div>
      )}

      {/* ── Uncommon Meters ── */}
      {section === "uncommon-meters" && (
        <div className="flex-1 overflow-y-auto px-4">
          <UncommonMetersMode />
        </div>
      )}

      {/* ── Drum Patterns ── */}
      {section === "drum-patterns" && (
        <div className="flex-1 overflow-y-auto px-4">
          <DrumPatterns
            key={drumTabKey}
            metronomeBpm={metronome.bpm}
            metronomeRunning={metronome.running}
            startMetronome={metronome.start}
            betaPlayRotation={betaPlayRotation}
            betaTransform={betaTransform}
            restoreTrigger={drumRestoreTrigger}
          />
        </div>
      )}

      {/* ── Chord Chart ── */}
      {section === "chord-chart" && (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-sm font-semibold text-[#888] uppercase tracking-widest mb-4">Chord Chart</h2>
            <ChordChart />
          </div>
        </div>
      )}

      {/* ── Konnakol ── */}
      {section === "konnakol" && (
        <div className="px-4 pb-8">
          <Konnakol />
        </div>
      )}

      {/* ── Vocal Percussion ── */}
      {section === "vocal-percussion" && (
        <div className="px-4 pb-8">
          <VocalPercussion />
        </div>
      )}

      {/* ── Mixed Groups ── */}
      {section === "mixed-groups" && (
        <div className="px-4 pb-8">
          <MixedGroups />
        </div>
      )}

      {/* ── Note Entry ── */}
      {section === "note-entry" && (
        <div className="flex-1 flex flex-col overflow-hidden px-4">
          <NoteEntryMode />
        </div>
      )}

      {/* ── Phrase Decomposition ── */}
      {section === "phrase-decomposition" && (
        <div className="flex-1 overflow-y-auto px-4">
          <PhraseDecomposition />
        </div>
      )}

      {/* ── 11-Limit Lattice ── */}
      {section === "lattice" && (
        <div className="flex-1 flex flex-col overflow-hidden px-4">
          <LatticeView />
        </div>
      )}

      {/* ── Interval Browser ── */}
      {section === "interval-browser" && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <IntervalBrowser />
        </div>
      )}

      {/* ── Microwave Mode ── */}
      {section === "microwave" && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <MicrowaveMode edo={edo} />
        </div>
      )}

      {/* ── Temperament Explorer ── */}
      {section === "temperament-explorer" && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <TemperamentExplorer />
        </div>
      )}

      {/* ── Math Lab ── */}
      {section === "math-lab" && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <MathLab />
        </div>
      )}

      {/* ── Melodic Patterns ── */}
      {section === "melodic-patterns" && (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <MelodicPatterns />
        </div>
      )}

      {/* ── Harmony Workshop ── */}
      {section === "harmony-workshop" && (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <HarmonyWorkshop />
        </div>
      )}

      {/* ── Reading Workflow (Academic) ── */}
      {section === "reading-workflow" && academicComps.ReadingWorkflow && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <academicComps.ReadingWorkflow />
        </div>
      )}

      {/* ── Note Writing (Academic) ── */}
      {section === "note-writing" && academicComps.NoteWriting && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <academicComps.NoteWriting />
        </div>
      )}

      {/* ── Simple Doc (Academic) ── */}
      {section === "simple-doc" && academicComps.SimpleDoc && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <academicComps.SimpleDoc />
        </div>
      )}

      {/* ── Ear Trainer Tabs ── */}
      {section === "ear-trainer" && (
      <div className="px-4 pt-3 flex-1 flex flex-col min-h-0 overflow-y-auto">
      <div className="max-w-6xl mx-auto w-full flex-1 flex flex-col">
        <div className="flex gap-1 flex-wrap items-center mb-4">
          <PresetBar onPresetLoaded={() => setTabKey(k => k + 1)} />
          <div className="w-px h-4 bg-[#2a2a2a]" />
          {tabs.map(t => (
            <button key={t} onClick={() => { stopAllAudio(); setActiveTab(t); }}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                activeTab === t ? "bg-[#7173e6] text-white"
                  : "bg-[#161616] text-[#666] hover:text-[#aaa] hover:bg-[#1e1e1e] border border-[#2a2a2a]"
              }`}>
              {TAB_LABELS[t]}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            {(slotHistory.length > 0 || currentSlotStats.current.size > 0) && (
              <button
                onClick={() => setShowSessionHistory(p => !p)}
                className={`px-2 py-1 rounded text-[10px] font-medium border transition-colors ${
                  showSessionHistory
                    ? "border-[#7173e6] bg-[#7173e622] text-[#9999ee]"
                    : "border-[#2a2a2a] bg-[#111] text-[#555] hover:text-[#888]"
                }`}
              >
                {showSessionHistory ? "✕ History" : `History (${slotHistory.length + (currentSlotStats.current.size > 0 ? 1 : 0)})`}
              </button>
            )}
            {logFlash && (
              <span className={`text-[10px] font-medium ${logFlash === "Logged!" ? "text-[#7aaa7a]" : "text-[#e06060]"}`}>
                {logFlash}
              </span>
            )}
          </div>
        </div>

        {/* Session history panel — settings-grouped collapsible slots */}
        {showSessionHistory && (() => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          sessionStatsVersion; // subscribe to updates

          const SLOT_STAR_COLORS = ["", "#e06060", "#e0a040", "#c8aa50", "#7aaa7a", "#7173e6"];

          // Build current active slot entry (not yet archived)
          const activeSlotEntries = Array.from(currentSlotStats.current.entries())
            .map(([key, v]) => ({ key, label: v.label, c: v.c, w: v.w }));

          // Track slot numbering per title
          const titleCounts: Record<string, number> = {};
          const getSlotNumber = (title: string) => {
            titleCounts[title] = (titleCounts[title] ?? 0) + 1;
            return titleCounts[title];
          };

          // Render a collapsible settings subsection
          const renderSettingsGroup = (group: SettingsGroup, isOpen: boolean, toggle: () => void) => (
            <div key={group.label} className="border-l-2 border-[#222] ml-1">
              <div className="flex items-center gap-1.5 px-2 py-0.5 cursor-pointer select-none hover:bg-[#ffffff04]"
                onClick={toggle}>
                <span className="text-[8px] text-[#444]">{isOpen ? "▾" : "▸"}</span>
                <span className="text-[9px] text-[#666] uppercase tracking-wider font-bold">{group.label}</span>
                <span className="text-[9px] text-[#444]">({group.items.length})</span>
              </div>
              {isOpen && (
                <div className="pl-4 pr-2 pb-1 flex flex-wrap gap-x-2 gap-y-0.5">
                  {group.items.map((item, i) => (
                    <span key={i} className="text-[10px] text-[#888]">{item}</span>
                  ))}
                </div>
              )}
            </div>
          );

          // Render stats section
          const renderStats = (
            stats: Array<{ key: string; label: string; c: number; w: number }>,
            isOpen: boolean,
            toggle: () => void,
          ) => {
            const wrong = stats.filter(v => v.w > 0);
            const right = stats.filter(v => v.w === 0 && v.c > 0);
            const totalC = stats.reduce((s, v) => s + v.c, 0);
            const totalW = stats.reduce((s, v) => s + v.w, 0);
            return (
              <div className="border-l-2 border-[#333] ml-1">
                <div className="flex items-center gap-1.5 px-2 py-0.5 cursor-pointer select-none hover:bg-[#ffffff04]"
                  onClick={toggle}>
                  <span className="text-[8px] text-[#444]">{isOpen ? "▾" : "▸"}</span>
                  <span className="text-[9px] text-[#888] uppercase tracking-wider font-bold">Results</span>
                  <span className="text-[9px] text-[#5a8a5a]">{totalC}✓</span>
                  <span className="text-[9px] text-[#aa5555]">{totalW}✗</span>
                </div>
                {isOpen && (
                  <div className="pl-3 pr-2 pb-1 flex flex-col gap-0.5">
                    {wrong.map(({ key, label, c, w }) => {
                      const t = c + w;
                      const p = t ? Math.round(100 * c / t) : 0;
                      return (
                        <div key={key} className="flex items-center gap-2 px-2 py-0.5 rounded text-xs bg-[#1a1111] border border-[#2a1a1a]">
                          <span className="flex-1 text-[#aa8888] truncate">{label.replace(/^.*?:\s*/, "")}</span>
                          <span className="text-[#5a8a5a] tabular-nums text-[10px]">{c}✓</span>
                          <span className="text-[#cc5555] tabular-nums text-[10px]">{w}✗</span>
                          <span className="text-[#886666] tabular-nums w-8 text-right text-[10px]">{p}%</span>
                          <div className="w-12 h-1 bg-[#1a1a1a] rounded-full overflow-hidden">
                            <div className="h-full bg-[#aa5555] rounded-full" style={{ width: `${100 - p}%` }} />
                          </div>
                        </div>
                      );
                    })}
                    {right.map(({ key, label, c }) => (
                      <div key={key} className="flex items-center gap-2 px-2 py-0.5 rounded text-xs border border-transparent">
                        <span className="flex-1 text-[#667766] truncate">{label.replace(/^.*?:\s*/, "")}</span>
                        <span className="text-[#4a7a4a] tabular-nums text-[10px]">{c}✓</span>
                        <span className="text-[#444] tabular-nums text-[10px]">0✗</span>
                        <span className="text-[#556655] tabular-nums w-8 text-right text-[10px]">100%</span>
                        <div className="w-12 h-1 bg-[#1a1a1a] rounded-full overflow-hidden">
                          <div className="h-full bg-[#4a7a4a] rounded-full" style={{ width: "100%" }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          };

          // Render a single slot block
          const renderSlot = (
            settings: TabSettingsSnapshot | null,
            slotNumber: number,
            stats: Array<{ key: string; label: string; c: number; w: number }>,
            open: boolean,
            openSections: Set<string>,
            rating: PracticeRating,
            logged: boolean,
            slotIdx: number,
            isActive: boolean,
            toggleOpen: () => void,
            toggleSection: (section: string) => void,
            setRating: (r: PracticeRating) => void,
            onLog: () => void,
            onDelete?: () => void,
          ) => {
            const totalC = stats.reduce((s, v) => s + v.c, 0);
            const totalW = stats.reduce((s, v) => s + v.w, 0);
            const total = totalC + totalW;
            const pct = total ? Math.round(100 * totalC / total) : 0;
            const title = settings?.title ?? "Session";

            return (
              <div key={slotIdx} className={`border rounded-lg overflow-hidden ${
                isActive ? "border-[#7173e644] bg-[#111]" : "border-[#1e1e1e] bg-[#0e0e0e]"
              }`}>
                {/* Header row */}
                <div className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
                  onClick={toggleOpen}>
                  <span className="text-[9px] text-[#444]">{open ? "▼" : "▶"}</span>
                  <span className="flex-1 text-[11px] text-[#999] font-medium">
                    {title} #{slotNumber}
                  </span>
                  {total > 0 && <>
                    <span className="text-[10px] tabular-nums text-[#5a8a5a]">{totalC}✓</span>
                    <span className="text-[10px] tabular-nums text-[#aa5555]">{totalW}✗</span>
                    <span className="text-[10px] tabular-nums text-[#666] w-8 text-right">{pct}%</span>
                    <div className="w-12 h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                      <div className="h-full bg-[#5a8a5a] rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </>}
                  {/* Inline star rating + LOG */}
                  <div className="flex items-center gap-1 ml-1" onClick={e => e.stopPropagation()}>
                    {[1, 2, 3, 4, 5].map(n => (
                      <button key={n}
                        onClick={() => setRating(rating === n ? 0 : n as PracticeRating)}
                        title={["", "Hard", "Tough", "OK", "Good", "Easy"][n]}
                        className="text-[12px] leading-none bg-transparent border-none cursor-pointer px-0"
                        style={{ color: n <= rating ? (SLOT_STAR_COLORS[rating] || "#333") : "#2a2a2a", transition: "color 80ms" }}>
                        ★
                      </button>
                    ))}
                    <button
                      onClick={onLog}
                      disabled={logged}
                      className={`ml-1 px-2 py-0.5 rounded text-[9px] font-semibold border transition-colors ${
                        logged
                          ? "border-[#1a3a1a] bg-[#0a1a0a] text-[#3a6a3a] cursor-default"
                          : "border-[#2a5a2a] bg-[#0e1a0e] text-[#5a9a5a] cursor-pointer hover:bg-[#1a2a1a] hover:text-[#7aaa7a]"
                      }`}
                    >
                      {logged ? "✓" : "+ LOG"}
                    </button>
                    {onDelete && (
                      <button
                        onClick={onDelete}
                        title="Delete this slot and undo its stats"
                        className="ml-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold border border-[#3a1a1a] bg-[#1a0e0e] text-[#aa5555] cursor-pointer hover:bg-[#2a1a1a] hover:text-[#cc6666] transition-colors"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
                {/* Collapsible body — settings subsections + stats */}
                {open && (
                  <div className="px-2 pb-2 flex flex-col gap-0.5">
                    {settings?.groups.map(group =>
                      renderSettingsGroup(
                        group,
                        openSections.has(group.label),
                        () => toggleSection(group.label),
                      )
                    )}
                    {stats.length > 0 && renderStats(
                      stats,
                      openSections.has("__stats__"),
                      () => toggleSection("__stats__"),
                    )}
                  </div>
                )}
              </div>
            );
          };

          // Helper: log a slot to practice log
          const logSlot = (
            settings: TabSettingsSnapshot | null,
            stats: Array<{ key: string; label: string; c: number; w: number }>,
            rating: PracticeRating,
          ): boolean => {
            try {
              const totalC = stats.reduce((s, v) => s + v.c, 0);
              const totalW = stats.reduce((s, v) => s + v.w, 0);
              const title = settings?.title ?? "Session";

              // Build preview matching the history section layout
              const previewLines: string[] = [];
              previewLines.push(`${title}  —  ${accuracy(totalC, totalW)} (${totalC}✓ ${totalW}✗)`);

              // Settings groups
              if (settings?.groups) {
                for (const g of settings.groups) {
                  previewLines.push(`${g.label}: ${g.items.join(", ")}`);
                }
              }

              // Results
              if (stats.length > 0) {
                previewLines.push("");
                const wrong = stats.filter(v => v.w > 0);
                const right = stats.filter(v => v.w === 0 && v.c > 0);
                if (wrong.length > 0) {
                  previewLines.push("MISSED:");
                  for (const v of wrong) {
                    const t = v.c + v.w;
                    const p = t ? Math.round(100 * v.c / t) : 0;
                    previewLines.push(`  ${v.label.replace(/^.*?:\s*/, "")}  ${v.c}✓ ${v.w}✗  ${p}%`);
                  }
                }
                if (right.length > 0) {
                  previewLines.push("CORRECT:");
                  for (const v of right) {
                    previewLines.push(`  ${v.label.replace(/^.*?:\s*/, "")}  ${v.c}✓  100%`);
                  }
                }
              }

              const preview = previewLines.join("\n");
              const biasKeys: Record<string, { c: number; w: number }> = {};
              for (const v of stats) {
                if (v.w > 0) biasKeys[v.key] = { c: v.c, w: v.w };
              }
              const settingsSnap = captureEarTrainerSettingsSnapshot();
              addPracticeEntry({
                mode: "ear-trainer",
                label: `Spatial Audiation · ${title}`,
                rating,
                preview,
                snapshot: { ...settingsSnap, biasKeys, settingsSnapshot: settings } as unknown as Record<string, unknown>,
                canRestore: true,
              });
              setLogFlash("Logged!");
              setTimeout(() => setLogFlash(""), 2000);
              return true;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              setLogFlash(`Error: ${msg}`);
              setTimeout(() => setLogFlash(""), 5000);
              return false;
            }
          };

          const totalSlots = slotHistory.length + (activeSlotEntries.length > 0 ? 1 : 0);

          return totalSlots > 0 ? (
            <div className="flex flex-col gap-2 mb-3 max-h-[50vh] overflow-y-auto">
              {/* Archived slots */}
              {slotHistory.map((slot, idx) => {
                const num = getSlotNumber(slot.settings?.title ?? "Session");
                return renderSlot(
                  slot.settings, num, slot.stats, slot.open, slot.openSections ?? new Set(),
                  slot.rating, slot.logged,
                  slot.id, false,
                  () => setSlotHistory(prev => prev.map((s, i) => i === idx ? { ...s, open: !s.open } : s)),
                  (sec) => setSlotHistory(prev => prev.map((s, i) => {
                    if (i !== idx) return s;
                    const next = new Set(s.openSections ?? new Set<string>());
                    if (next.has(sec)) next.delete(sec); else next.add(sec);
                    return { ...s, openSections: next };
                  })),
                  (r) => setSlotHistory(prev => prev.map((s, i) => i === idx ? { ...s, rating: r } : s)),
                  () => {
                    if (logSlot(slot.settings, slot.stats, slot.rating)) {
                      setSlotHistory(prev => prev.map((s, i) => i === idx ? { ...s, logged: true } : s));
                    }
                  },
                  () => {
                    removeSlotAnswers(localToday(), slot.stats);
                    setSlotHistory(prev => prev.filter((_, i) => i !== idx));
                    refreshTodayTotals();
                  },
                );
              })}
              {/* Current active slot */}
              {activeSlotEntries.length > 0 && (() => {
                const activeSettings = currentSlotSettings.current;
                const num = getSlotNumber(activeSettings?.title ?? "Session");
                return renderSlot(
                  activeSettings, num, activeSlotEntries, true, activeSlotOpenSections,
                  activeSlotRating, activeSlotLogged,
                  -1, true,
                  () => {},
                  (sec) => setActiveSlotOpenSections(prev => {
                    const next = new Set(prev);
                    if (next.has(sec)) next.delete(sec); else next.add(sec);
                    return next;
                  }),
                  (r) => setActiveSlotRating(r),
                  () => {
                    if (logSlot(activeSettings, activeSlotEntries, activeSlotRating)) {
                      setActiveSlotLogged(true);
                    }
                  },
                  () => {
                    removeSlotAnswers(localToday(), activeSlotEntries);
                    currentSlotStats.current = new Map();
                    setActiveSlotRating(0);
                    activeSlotRatingRef.current = 0;
                    setActiveSlotLogged(false);
                    setSessionStatsVersion(v => v + 1);
                    refreshTodayTotals();
                  },
                );
              })()}
            </div>
          ) : null;
        })()}

        <div ref={tabContentRef} className="flex-1 pb-8">
          {activeTab === "intervals" && (
            <div className="bg-[#111] rounded-xl border border-[#1e1e1e] p-5">
              <h2 className="font-semibold mb-4">Intervals</h2>
              <IntervalsTab key={tabKey} {...sharedTabProps} />
            </div>
          )}

          {activeTab === "chords" && (
            <div className="bg-[#111] rounded-xl border border-[#1e1e1e] p-5">
              <h2 className="font-semibold mb-4">Chord Progressions</h2>
              <ChordsTab key={tabKey} {...sharedTabProps} />
            </div>
          )}

          {activeTab === "melody" && (
            <div className="bg-[#111] rounded-xl border border-[#1e1e1e] p-5">
              <h2 className="font-semibold mb-4">Melody Recognition</h2>
              <MelodyTab key={tabKey} {...sharedTabProps} />
            </div>
          )}

          {activeTab === "jazz" && (
            <div className="bg-[#111] rounded-xl border border-[#1e1e1e] p-5">
              <h2 className="font-semibold mb-4">Jazz Cells</h2>
              <JazzTab key={tabKey} {...sharedTabProps} />
            </div>
          )}

          {activeTab === "patterns" && (
            <div className="bg-[#111] rounded-xl border border-[#1e1e1e] p-5">
              <h2 className="font-semibold mb-4">Pattern Sequences</h2>
              <PatternsTab key={tabKey} {...sharedTabProps} />
            </div>
          )}

          {activeTab === "drone" && (
            <div className="bg-[#111] rounded-xl border border-[#1e1e1e] p-5">
              <h2 className="font-semibold mb-4">Chord Drone</h2>
              <DroneTab key={tabKey} tonicPc={tonicPc} lowestOct={lowestOct} highestOct={highestOct}
                edo={edo} onHighlight={handleHighlight} onResult={handleResult}
                onPlay={handlePlay} onAnswer={trackAnswer} lastPlayed={lastPlayed} ensureAudio={ensureAudio}
                onDroneStateChange={(active) => { if (!active) setDroneIsOn(false); }} />
            </div>
          )}

          {activeTab === "modeid" && (
            <div className="bg-[#111] rounded-xl border border-[#1e1e1e] p-5">
              <h2 className="font-semibold mb-4">Mode Identification</h2>
              <ModeIdentificationTab key={tabKey} {...sharedTabProps} />
            </div>
          )}



        </div>
      </div>
      </div>
      )}


      {folderPromptOpen && folderSyncState === "needs-permission" && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setFolderPromptOpen(false); }}
        >
          <div className="bg-[#111] border border-[#2a4a2a] rounded-xl w-full max-w-md shadow-2xl">
            <div className="px-5 py-4 border-b border-[#1e1e1e]">
              <h2 className="font-semibold text-sm text-[#7aaa7a]">Reconnect your sync folder</h2>
            </div>
            <div className="px-5 py-5 space-y-4">
              <p className="text-sm text-[#ccc]">
                Your practice log lives in{" "}
                <span className="text-[#ffcf88] font-medium">{folderSyncName ?? "a local folder"}</span>.
                Browsers require a single click per session to regrant access.
              </p>
              <p className="text-xs text-[#777]">
                Click <span className="text-[#7aaa7a]">Reconnect</span> to load the latest data and enable auto-save for this session.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleFolderReconnect}
                  disabled={folderReconnecting}
                  className="flex-1 px-4 py-2.5 bg-[#1a2a1a] border border-[#5a8a5a] hover:border-[#7aaa7a] rounded-lg text-sm text-[#cce0cc] hover:text-white transition-colors disabled:opacity-50"
                >
                  {folderReconnecting ? "Reconnecting…" : "Reconnect"}
                </button>
                <button
                  onClick={() => setFolderPromptOpen(false)}
                  className="px-4 py-2.5 bg-[#1a1a1a] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-lg text-sm text-[#888] hover:text-[#ccc] transition-colors"
                >
                  Later
                </button>
              </div>
              <p className="text-[10px] text-[#555] pt-1">
                Changes made without reconnecting won't save to the folder until you reconnect. You can also manage this under Settings → Local Folder Sync.
              </p>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onDataImported={() => setTabKey(k => k + 1)}
          betaPlayRotation={betaPlayRotation}
          onBetaPlayRotationChange={setBetaPlayRotation}
          betaIntervalChain={betaIntervalChain}
          onBetaIntervalChainChange={setBetaIntervalChain}
          betaComma={betaComma}
          onBetaCommaChange={setBetaComma}
          betaTransform={betaTransform}
          onBetaTransformChange={setBetaTransform}
          betaMathLab={betaMathLab}
          onBetaMathLabChange={(v) => {
            setBetaMathLab(v);
            if (!v && section === "math-lab") setSection("ear-trainer");
          }}
          academicMode={academicMode}
          academicAvailable={academicAvailable}
          onAcademicModeChange={(v) => {
            setAcademicMode(v);
            setSection(v ? "reading-workflow" : "ear-trainer");
          }}
        />
      )}

      {showPracticeLog && (
        <PracticeLogModal
          accentQueueCount={accentQueueCount}
          onClose={() => {
            // Flush any accumulated accent line/phrase imports
            const queue = accentImportQueue.current;
            if (queue.length > 0) {
              // Combine all queued measures into one restore payload
              const allMeasures: unknown[] = [];
              let grid = queue[0].grid;
              for (let i = 0; i < queue.length; i++) {
                const q = queue[i];
                const incoming = [...(q.measures ?? [])];
                if (q.importMode === "line" && incoming.length > 0 && allMeasures.length > 0) {
                  incoming[0] = { ...(incoming[0] as Record<string, unknown>), lineBreak: true };
                }
                allMeasures.push(...incoming);
                grid = q.grid;
              }
              // Write as a single "phrase" so DrumPatterns appends all at once
              // (line breaks are already embedded in the measure data)
              writePendingRestore("accent", { measures: allMeasures, grid, importMode: "phrase" });
              accentImportQueue.current = [];
              setAccentQueueCount(0);
              setSection("drum-patterns");
              setDrumRestoreTrigger(k => k + 1);
            }
            setShowPracticeLog(false);
          }}
          onLoadEntry={(entry: PracticeLogEntry, importMode?: AccentImportMode) => {
            if (entry.mode === "ear-trainer") {
              const snap = entry.snapshot as Record<string, unknown>;
              // Apply import bias if snapshot contains biasKeys
              const biasKeys = snap.biasKeys as Record<string, { c: number; w: number }> | undefined;
              setImportBias(biasKeys ?? null);
              restoreEarTrainerSnapshot(snap as Record<string, string>);
              setSection("ear-trainer");
              setTabKey(k => k + 1);
            } else if (entry.mode === "drum-ostinato") {
              writePendingRestore("drum", entry.snapshot);
              setSection("drum-patterns");
              setDrumRestoreTrigger(k => k + 1);
            } else if (entry.mode === "accent-study") {
              if (importMode === "line" || importMode === "phrase") {
                // Accumulate — modal stays open for more picks
                const snap = entry.snapshot as Record<string, unknown>;
                accentImportQueue.current.push({
                  measures: (snap.measures ?? []) as unknown[],
                  grid: (snap.grid as string) ?? "16th",
                  importMode,
                });
                setAccentQueueCount(accentImportQueue.current.length);
              } else {
                // "replace" — immediate, closes modal
                accentImportQueue.current = [];
                setAccentQueueCount(0);
                writePendingRestore("accent", { ...entry.snapshot as Record<string, unknown>, importMode: importMode ?? "replace" });
                setSection("drum-patterns");
                setDrumRestoreTrigger(k => k + 1);
              }
            } else if (entry.mode === "konnakol-basic") {
              writePendingRestore("konnakol_basic", entry.snapshot);
              setSection("konnakol");
            } else if (entry.mode === "konnakol-cycles") {
              writePendingRestore("konnakol_cycles", entry.snapshot);
              setSection("konnakol");
            } else if (entry.mode === "konnakol-mixed") {
              writePendingRestore("konnakol_mixed", entry.snapshot);
              setSection("konnakol");
            }
            // chord-chart and note-entry: just navigate, no data restore
            else if (entry.mode === "chord-chart") {
              setSection("chord-chart");
            } else if (entry.mode === "note-entry") {
              setSection("note-entry");
            } else if (entry.mode === "phrase-decomposition") {
              writePendingRestore("phrase_decomposition", entry.snapshot);
              setSection("phrase-decomposition");
            }
          }}
        />
      )}
    </div>
  );
}
