import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { ComponentType } from "react";
import LumatoneKeyboard from "@/components/LumatoneKeyboard";
import PianoKeyboard from "@/components/PianoKeyboard";
import GuitarFretboard from "@/components/GuitarFretboard";
import BassFretboard from "@/components/BassFretboard";
import { computeLayout, LayoutResult, ComputedKey } from "@/lib/lumatoneLayout";
import { audioEngine, AudioEngine, DRONE_INSTRUMENTS, type DroneInstrument } from "@/lib/audioEngine";
import IntervalsTab from "@/components/tabs/IntervalsTab";
import ChordsTab from "@/components/tabs/ChordsTab";
import MelodyTab from "@/components/tabs/MelodyTab";
import JazzTab from "@/components/tabs/JazzTab";
import PatternsTab from "@/components/tabs/PatternsTab";
import DroneTab from "@/components/tabs/DroneTab";
import ModeIdentificationTab from "@/components/tabs/ModeIdentificationTab";
import ScalarTab from "@/components/tabs/ScalarTab";



import PresetBar from "@/components/PresetBar";
import DrumPatterns from "@/components/DrumPatterns";
import ChordChart from "@/components/ChordChart";
import Konnakol from "@/components/Konnakol";
import VocalPercussion from "@/components/VocalPercussion";
import MixedGroups from "@/components/MixedGroups";
import ScoringMode from "@/components/ScoringMode";
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
import { getLayoutFile, pcToNoteNameWithEnharmonic, formatHalfAccidentals } from "@/lib/edoData";
// Side-effect import: registers the 19 curated JI scales (Pythagorean,
// 5-limit, septimal, neutral / Maqam) into edoData's pattern-map cache
// for 41-EDO and 53-EDO so getModeDegreeMap() resolves them.  No exports
// are used directly here — ChordsTab and ModeIdentificationTab consume
// the scales via their dynamic family lists.
import "@/lib/jiScaleData";
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

export type VisualizerType = "lumatone" | "piano" | "guitar" | "bass";
const VIZ_LABELS: Record<VisualizerType, string> = {
  lumatone: "Lumatone",
  piano: "Piano",
  guitar: "Guitar",
  bass: "Bass",
};

type Tab = "intervals"|"chords"|"melody"|"jazz"|"patterns"|"drone"|"modeid";
type ResponseMode = "Play Audio"|"Show Target (Sing It)";

const TAB_LABELS: Record<Tab, string> = {
  intervals: "Intervals", chords: "Chords",
  melody: "Melody", jazz: "Jazz Cells", patterns: "Patterns",
  drone: "Chord Drone", modeid: "Mode ID",
};

const OCT_OPTIONS = [1,2,3,4,5,6,7];
const VALID_TABS: Tab[] = ["intervals","chords","modeid","melody","jazz","patterns","drone"];

// ── Temperament classification ──────────────────────────────────────────
// Tonal Audiation groups the available EDOs by their underlying tuning
// family so the chord/scale infrastructure can specialise per temperament.
//   Meantone     — 12/19/31: syntonic comma vanishes, 5-limit thirds emerge
//                  from stacks of fifths.  Standard Western functional
//                  harmony works without comma adjustments.
//   Pythagorean  — 41: pure-fifth tuning where the syntonic comma survives.
//                  3-limit, 5-limit, 7-limit, 11-limit scales are distinct.
//   Schismatic   — 53: schisma vanishes; close to 5-limit JI but supports
//                  comma-aware Pythagorean / 5-limit / 7-limit / 11-limit
//                  distinctions throughout.
// 17 / 19 / 22 are intentionally not assigned yet — to be revisited.
type Temperament = "meantone" | "pythagorean" | "schismatic";

const TEMPERAMENTS: Temperament[] = ["meantone", "pythagorean", "schismatic"];
const TEMPERAMENT_LABELS: Record<Temperament, string> = {
  meantone:    "Meantone",
  pythagorean: "Pythagorean",
  schismatic:  "Schismatic",
};
const TEMPERAMENT_EDOS: Record<Temperament, number[]> = {
  meantone:    [12, 19, 31],   // 19-EDO is textbook 1/3-comma meantone
  pythagorean: [41],
  schismatic:  [53],
};
// Pythagorean and Schismatic temperaments expose only the three tabs whose
// content has a comma-aware story today.  Melody/Jazz/Patterns/Drone stay
// hidden in those temperaments until the chord-progression infrastructure
// is rebuilt around tuning lineages.
const TEMPERAMENT_TABS: Record<Temperament, Tab[]> = {
  meantone:    ["intervals", "chords", "modeid", "melody", "jazz", "patterns", "drone"],
  pythagorean: ["intervals", "modeid", "chords"],
  schismatic:  ["intervals", "modeid", "chords"],
};
function temperamentForEdo(edo: number): Temperament {
  if (TEMPERAMENT_EDOS.pythagorean.includes(edo)) return "pythagorean";
  if (TEMPERAMENT_EDOS.schismatic.includes(edo))  return "schismatic";
  return "meantone";  // 12, 19, 31, and any unassigned EDO defaults here
}

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
  const [melodicRestoreTrigger, setMelodicRestoreTrigger] = useState(0);
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
  // When the temperament changes (typically because the user switched EDO
  // and crossed a temperament boundary), snap activeTab to the first tab
  // the new temperament exposes — Pythagorean/Schismatic don't include
  // melody/jazz/patterns/drone, so leaving activeTab on one of those
  // would render nothing.

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
  // Listen for cross-component EDO change requests (used by ScalarTab's
  // inline family-grouped EDO selector since it doesn't have direct
  // access to setEdo).
  useEffect(() => {
    function handleSetEdo(e: Event) {
      const n = (e as CustomEvent).detail as number;
      if (typeof n === "number" && Number.isFinite(n)) {
        stopAllAudio();
        setEdo(n);
      }
    }
    window.addEventListener("app-set-edo", handleSetEdo);
    return () => window.removeEventListener("app-set-edo", handleSetEdo);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [edo, setEdo] = useLS<number>("lt_app_edo", 31);

  // Temperament state for the Tonal Audiation section.  Driven from the
  // active EDO so the two stay in sync without an explicit selector
  // round-trip — switching to 41-EDO via the EDO dropdown auto-flips
  // the temperament tab to Pythagorean, and clicking the Pythagorean
  // tab snaps the EDO to its first available value (41).
  const temperament: Temperament = temperamentForEdo(edo);
  // Per-temperament tab list — drives both the tab buttons and the
  // activeTab guard further down.  If the user lands on a tab that the
  // current temperament doesn't expose (e.g. switching from Meantone's
  // Melody tab to Pythagorean, which has no Melody), fall back to the
  // first tab in the temperament's list.
  const temperamentTabs: Tab[] = TEMPERAMENT_TABS[temperament];
  // Snap activeTab to a valid tab for the current temperament whenever the
  // user crosses a boundary (e.g. 31-EDO Melody → 41-EDO, where Melody
  // doesn't exist).  Without this the tab content would render nothing.
  useEffect(() => {
    if (!temperamentTabs.includes(activeTab)) setActiveTab(temperamentTabs[0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [temperament]);
  const [vizType, setVizType] = useLS<VisualizerType>("lt_app_vizType", "lumatone");
  const [tonicPc, setTonicPc] = useLS<number>("lt_app_tonic", 0);
  // Exercise range — absolute pitch bounds (both inclusive). Set by clicking
  // two visualizer keys via the "Range" button. Defaults span 3 octaves
  // around the tonic (tonicPc - edo to tonicPc + 2*edo - 1).
  const [lowestPitch, setLowestPitch] = useLS<number>("lt_app_lowestPitch", -12);
  const [highestPitch, setHighestPitch] = useLS<number>("lt_app_highestPitch", 23);
  // Range-pick mode: when > 0, the next visualizer click sets either the
  // low (1) or high (2) bound of the exercise range. 0 = inactive.
  const [rangePickStep, setRangePickStep] = useState<0 | 1 | 2>(0);
  const [responseMode, setResponseMode] = useLS<ResponseMode>("lt_app_responseMode", "Play Audio");
  // droneTonal removed — drone now uses tonicPc directly
  const [droneOct, setDroneOct] = useLS<number>("lt_app_droneOct", 4);
  const [droneInstrument, setDroneInstrument] = useLS<DroneInstrument>("lt_app_droneInstrument", "tanpura");
  // Snap stale localStorage values (e.g. "violin", "pad_2_warm" from
  // an older catalog) to the default — otherwise the dropdown shows
  // an empty selection and audioEngine.setInstrument silently falls
  // back to tanpura without telling the UI.
  useEffect(() => {
    if (!AudioEngine.isValidInstrument(droneInstrument)) setDroneInstrument("tanpura");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [droneVol, setDroneVol] = useLS<number>("lt_app_droneVol", 0.08);
  const [droneIsOn, setDroneIsOn] = useState(false);
  const [section, setSection] = useLS<string>("lt_app_section", "ear-trainer");
  // When user enters Scalar Explorations from a non-Meantone EDO (41 / 53
  // etc.), snap EDO down to 31 so the meantone-only chord-pool / lattice
  // infrastructure stays valid.  Reverts to the previous EDO is up to the
  // user — they can always re-pick once they leave Scalar Explorations.
  useEffect(() => {
    // Scalar Explorations now supports the full Tonal-Audiation EDO
    // set (12 / 19 / 31 meantone, 41 pythagorean, 53 schismatic) —
    // pattern-map registration extended to all of them.  Only snap
    // when the user is on an EDO outside that supported set.
    const SCALAR_SUPPORTED_EDOS = new Set([12, 19, 31, 41, 53]);
    if (section === "scalar-exploration" && !SCALAR_SUPPORTED_EDOS.has(edo)) {
      setEdo(31);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);
  const [dronePulse, setDronePulse] = useLS<boolean>("lt_app_dronePulse", false);
  const [dronePulseDur, setDronePulseDur] = useLS<number>("lt_app_dronePulseDur", 4);
  const [playVol, setPlayVol] = useLS<number>("lt_app_playVol", 1.0);
  // Beta features are gated behind `import.meta.env.DEV` so they only
  // appear when running locally via `npm run dev` (or any vite dev
  // server).  Production builds — i.e. anything served from a pushed
  // commit — force every beta flag to false, hiding the experimental
  // modes from the section picker even if their localStorage entry
  // is set.  This keeps work-in-progress UI confined to the developer's
  // machine without having to physically remove it from the repo.
  const BETA_AVAILABLE = import.meta.env.DEV;
  const [betaPlayRotation_raw, setBetaPlayRotation] = useLS<boolean>("lt_beta_play_rotation", false);
  const [betaIntervalChain_raw, setBetaIntervalChain] = useLS<boolean>("lt_beta_interval_chain", false);
  const [betaComma_raw, setBetaComma] = useLS<boolean>("lt_beta_comma", false);
  const [betaMathLab_raw, setBetaMathLab] = useLS<boolean>("lt_beta_math_lab", false);
  const [betaTransform_raw, setBetaTransform] = useLS<boolean>("lt_beta_transform", false);
  const [betaMode_raw, setBetaMode] = useLS<boolean>("lt_beta_mode", false);
  const betaPlayRotation   = BETA_AVAILABLE && betaPlayRotation_raw;
  const betaIntervalChain  = BETA_AVAILABLE && betaIntervalChain_raw;
  const betaComma          = BETA_AVAILABLE && betaComma_raw;
  const betaMathLab        = BETA_AVAILABLE && betaMathLab_raw;
  const betaTransform      = BETA_AVAILABLE && betaTransform_raw;
  // Master "Beta" gate: when off, hides experimental modes from the
  // section picker.  Always false in production (see BETA_AVAILABLE).
  const betaMode           = BETA_AVAILABLE && betaMode_raw;
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
    // Fires when the folder's snapshot was auto-loaded at startup (permission
    // was still granted from a prior session). Remount tabs so their state
    // re-hydrates from the freshly-restored localStorage.
    const onLoaded = () => setTabKey(k => k + 1);
    refresh();
    window.addEventListener("lt-folder-sync-status", refresh);
    window.addEventListener("lt-folder-sync-loaded", onLoaded);
    return () => {
      window.removeEventListener("lt-folder-sync-status", refresh);
      window.removeEventListener("lt-folder-sync-loaded", onLoaded);
    };
  }, []);
  const handleFolderReconnect = async () => {
    setFolderReconnecting(true);
    const res = await reconnectFolder({ loadFromFolder: true });
    setFolderReconnecting(false);
    if (res.ok) {
      setFolderPromptOpen(false);
      // Tab remount is handled by the `lt-folder-sync-loaded` listener below.
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
  // Sampled-instrument drones always sound a single tonic.  The previous
  // Single / Root+5th / Tanpura mode set is gone — per direct user
  // direction (2026-05-05): with real instrument samples we want a clean
  // bowed/sung tonic, not a synthesized chord stack.
  const buildDroneNotes = (tonal: number, oct: number): { notes: number[]; gains?: number[] } => {
    const abs = tonal + (oct - 4) * edo;
    return { notes: [abs] };
  };

  const startHeaderDrone = async () => {
    await ensureAudio();
    audioEngine.setInstrument(droneInstrument);
    const { notes, gains } = buildDroneNotes(tonicPc, droneOct);
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
          const dn = buildDroneNotes(tonicPc, droneOct);
          audioEngine.startDrone(dn.notes, edo, droneVol, dn.gains);
          pulsePhase.current = "on";
          scheduleNext("on");
        }
      }, dronePulseDur * 1000);
    };
    pulsePhase.current = "on";
    scheduleNext("on");
    return () => { if (pulseTimer.current) { clearTimeout(pulseTimer.current); pulseTimer.current = null; } };
  }, [dronePulse, droneIsOn, dronePulseDur, tonicPc, droneOct, droneInstrument, droneVol, edo]);

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
    // Range-pick mode: the clicked pitch becomes the bound exactly — no
    // octave snapping. Step 1 sets the low bound, step 2 sets the high
    // bound (swapping if the user clicked them in reverse order so that
    // lowestPitch <= highestPitch always holds).
    if (rangePickStep > 0) {
      const pitch = key.pitch;
      if (rangePickStep === 1) {
        setLowestPitch(pitch);
        setRangePickStep(2);
      } else {
        if (pitch < lowestPitch) {
          setHighestPitch(lowestPitch);
          setLowestPitch(pitch);
        } else {
          setHighestPitch(pitch);
        }
        setRangePickStep(0);
      }
    }
  }, [ensureAudio, edo, rangePickStep, lowestPitch, setLowestPitch, setHighestPitch]);

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
    tonicPc, lowestPitch, highestPitch, edo: edo,
    onHighlight: handleHighlight, responseMode,
    onResult: handleResult,
    onPlay: handlePlay,
    onAnswer: trackAnswer,
    onShowOnKeyboard: handleShowOnKeyboard,
    lastPlayed, ensureAudio, playVol,
    tabSettingsRef,
    layoutPitchRange: layoutPitchRange ?? undefined,
    answerButtons,
    // Live highlighted-pitches set so a tab can mirror the main keyboard
    // in a mini-visualizer overlay when the user scrolls past the
    // sticky keyboard at the top.  ChordsTab uses this in its
    // Show-Answer floating panel.
    highlightedPitches: highlighted,
    // Main-visualizer state forwarded so a tab can render the same
    // visualizer it already shows at the top — used by ChordsTab to
    // mount a bottom-right floating mirror of the main keyboard while
    // Show Answer is open and the sticky main keyboard is scrolled
    // out of view.
    vizType,
    layout,
    onKeyClick: (key: ComputedKey) => { void ensureAudio().then(() => handleKeyClick(key)); },
    betaMode,
  };

  const tabs = (["intervals","chords","modeid","melody","jazz","patterns","drone"] as Tab[]);

  const sessionAcc = (sessionC + sessionW) ? `${Math.round(100 * sessionC / (sessionC + sessionW))}%` : "";
  const slotAcc = (slotC + slotW) ? `${Math.round(100 * slotC / (slotC + slotW))}%` : "";
  const lastOpt = lastOptionKey ? optionSessionStats.current.get(lastOptionKey) : null;
  const lastOptAcc = lastOpt && (lastOpt.c + lastOpt.w) ? `${Math.round(100 * lastOpt.c / (lastOpt.c + lastOpt.w))}%` : "";

  return (
    <div className={`bg-[#0d0d0d] text-white flex flex-col ${(section === "reading-workflow" || section === "temperament-explorer" || section === "math-lab") ? "h-screen overflow-hidden" : "h-screen overflow-y-auto"}`}>
      {/* ── Header ── */}
      <div className="border-b border-[#1e1e1e] px-4 pt-4 pb-3 flex-shrink-0">
        <div className="space-y-3">

          {/* Row 1: Title + Section selector + Export/Import + EDO */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              {academicMode ? (
                <select
                  value={section}
                  onChange={e => { stopAllAudio(); setSection(e.target.value); }}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none"
                >
                  <option value="reading-workflow">Reading Workflow</option>
                  <option value="note-writing">Note Writing</option>
                  <option value="simple-doc">Document</option>
                </select>
              ) : (() => {
                const SECTION_BUTTONS: { id: string; label: string; beta?: boolean }[] = [
                  // Always-visible
                  { id: "ear-trainer",          label: "Tonal Audiation" },
                  { id: "scalar-exploration",   label: "Scalar Explorations" },
                  { id: "lattice",              label: "Harmonic Lattice" },
                  { id: "drum-patterns",        label: "Drum Patterns" },
                  { id: "melodic-patterns",     label: "Melodic Patterns" },
                  { id: "chord-chart",          label: "Chord Chart" },
                  { id: "temperament-explorer", label: "Temperament Explorer" },
                  { id: "note-entry",           label: "Scoring" },
                  // Beta-gated
                  { id: "harmony-workshop",     label: "Harmony Workshop",     beta: true },
                  { id: "vocal-percussion",     label: "Vocal Percussion",     beta: true },
                  { id: "mixed-groups",         label: "Mixed Groups",         beta: true },
                  { id: "drill-response",       label: "Drill & Response",     beta: true },
                  { id: "uncommon-meters",      label: "Uncommon Meters",      beta: true },
                  { id: "konnakol",             label: "Solkattu",             beta: true },
                  { id: "phrase-decomposition", label: "Phrase Decomposition", beta: true },
                  { id: "interval-browser",     label: "Interval Browser",     beta: true },
                  { id: "microwave",            label: "Microwave",            beta: true },
                ];
                const visible = SECTION_BUTTONS.filter(b => !b.beta || betaMode);
                if (betaMathLab) visible.push({ id: "math-lab", label: "Math Lab", beta: true });
                return visible.map(b => {
                  const active = section === b.id;
                  return (
                    <button
                      key={b.id}
                      onClick={() => {
                        if (active) return;
                        stopAllAudio();
                        // Scalar Explorations only supports 12 / 31 EDO
                        // (xen pattern maps registered for those).
                        // Snap if the user was on something else.
                        if (b.id === "scalar-exploration" && ![12, 19, 31, 41, 53].includes(edo)) {
                          setEdo(31);
                        }
                        setSection(b.id);
                      }}
                      className={`px-2 py-1 text-xs rounded border transition-colors ${
                        active
                          ? "bg-[#7173e618] border-[#7173e6] text-[#9999ee]"
                          : b.beta
                            ? "bg-[#1a1410] border-[#2a2418] text-[#988868] hover:text-[#cab48a] hover:border-[#3a3424]"
                            : "bg-[#1a1a1a] border-[#2a2a2a] text-[#888] hover:text-[#ccc] hover:border-[#3a3a3a]"
                      }`}
                      title={b.beta ? `${b.label} (Beta)` : b.label}
                    >
                      {b.label}
                    </button>
                  );
                });
              })()}
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

          {/* Drone strip — visible in every non-academic section per
              direct user direction (2026-05-05): "the drone should be
              for all modes".  Always sounds a single tonic through the
              chosen sampled instrument; tonic comes from the global
              tonicPc state which persists across sections. */}
          {!academicMode && (
            <div className="bg-[#111] border border-[#222] rounded-lg px-3 py-2 flex flex-wrap items-center gap-3">
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
                <label className="text-xs text-[#666]">Instrument</label>
                <select value={droneInstrument}
                  onChange={async e => {
                    const inst = e.target.value as DroneInstrument;
                    setDroneInstrument(inst);
                    audioEngine.setInstrument(inst);
                    if (droneIsOn) {
                      const { notes, gains } = buildDroneNotes(tonicPc, droneOct);
                      audioEngine.startDrone(notes, edo, droneVol, gains);
                    }
                  }}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
                  {DRONE_INSTRUMENTS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
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
          )}

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
                <label className="text-xs text-[#666]">Range</label>
                <button onClick={() => setRangePickStep(s => s === 0 ? 1 : 0)}
                  title={rangePickStep === 0
                    ? "Click to pick low + high notes on the visualizer"
                    : "Click again to cancel"}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors border ${
                    rangePickStep > 0
                      ? "bg-[#7173e6] border-[#7173e6] text-white animate-pulse"
                      : "bg-[#1a1a1a] border-[#2a2a2a] text-white hover:border-[#555]"
                  }`}>
                  {rangePickStep === 1 ? "Click low note…"
                    : rangePickStep === 2 ? "Click high note…"
                    : (() => {
                        const loPc = ((lowestPitch % edo) + edo) % edo;
                        const hiPc = ((highestPitch % edo) + edo) % edo;
                        const loName = formatHalfAccidentals(pcToNoteNameWithEnharmonic(loPc, edo) ?? "");
                        const hiName = formatHalfAccidentals(pcToNoteNameWithEnharmonic(hiPc, edo) ?? "");
                        const loOct = 4 + Math.floor((lowestPitch - tonicPc) / edo);
                        const hiOct = 4 + Math.floor((highestPitch - tonicPc) / edo);
                        return `${loName}${loOct}–${hiName}${hiOct}`;
                      })()}
                </button>
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
                // Pick the tonic-aligned pitch nearest the midpoint of the
                // current pitch range.
                const mid = Math.floor((lowestPitch + highestPitch) / 2);
                const tonicNote = mid - (((mid - tonicPc) % edo + edo) % edo);
                audioEngine.playNote(tonicNote, edo, 1.0, 0.8);
                handleHighlight([tonicNote]);
              }}
                className="px-3 py-1 rounded text-xs font-medium transition-colors border bg-[#1a1a1a] border-[#333] text-[#888] hover:text-white hover:border-[#555]"
                title="Play and highlight tonic note">
                ♪ Tonic
              </button>
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
              {/* In Tonal Audiation, the EDO + Visualizer dropdowns
                  are rendered below the temperament/tab row instead
                  of up here so they sit next to the temperament
                  context they belong to. */}
              {section !== "ear-trainer" && <>
              <div className="w-px h-4 bg-[#2a2a2a]" />
              <label className="text-xs text-[#666]">EDO</label>
              {section === "scalar-exploration" ? (
                /* Family-grouped EDO buttons — mirrors Temperament
                   Explorer's style.  All five Tonal-Audiation EDOs
                   are supported here now (Meantone 12 / 19 / 31,
                   Pythagorean 41, Schismatic 53). */
                <div className="flex items-center gap-2 flex-wrap">
                  {([
                    { fam: "MEANTONE",    color: "#cfe6ff", edos: [12, 19, 31] },
                    { fam: "PYTHAGOREAN", color: "#e6cfa0", edos: [41]         },
                    { fam: "SCHISMATIC",  color: "#cfe6cf", edos: [53]         },
                  ] as const).map(group => (
                    <div key={group.fam} className="flex items-center gap-1.5">
                      <span
                        className="text-[9px] font-semibold tracking-wider px-1 border-l border-[#2a2a2a]"
                        style={{ color: group.color }}
                      >
                        {group.fam}
                      </span>
                      {group.edos.map(n => {
                        const active = edo === n;
                        return (
                          <button key={n} onClick={() => setEdo(n)}
                            title={`${n}-EDO (${group.fam.toLowerCase()} family)`}
                            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
                              active
                                ? "bg-[#7173e6] text-white border-[#7173e6]"
                                : "bg-[#1a1a1a] text-[#aaa] border-[#2a2a2a] hover:text-white hover:border-[#3a3a5a]"
                            }`}>
                            {n}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ) : (
                <select value={edo} onChange={e => setEdo(Number(e.target.value))}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
                  {/* Tonal Audiation filters by active temperament tab.
                      Other sections see the full EDO list. */}
                  {(section === "ear-trainer" ? TEMPERAMENT_EDOS[temperament] : EDO_OPTIONS)
                    .map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              )}
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
              </>}
            </div>
          </div>
          </>)}
        </div>
      </div>

      {/* Sticky keyboard — sits as a direct child of the scrolling root
          (not nested in the header) so its `sticky top-0` containing block
          spans the full scroll range. Only shown in tonal audiation.
          z-50 is well above any in-content overlay (LatticeView's controls
          live at z-20–30, comp arcs / chord overlays even lower) so the
          visualizer always paints over scrolled-past content rather than
          getting visually overlapped by floating panels below it. */}
      {/* Ear-Trainer keeps the visualizer as a direct child of root so
          it sticks to the top of the viewport for the full scroll
          range.  Scalar Explorations renders the same visualizer
          inside its own wrapper below so the sticky element's
          containing block ends with the last chord — once the user
          scrolls past that, the visualizer scrolls away (per direct
          user direction 2026-05-05: "the visualizer should disappear
          after i pass by the last chords"). */}
      {section === "ear-trainer" && (
        <div id="main-visualizer" className="sticky top-0 z-50 bg-[#0d0d0d] border-b border-[#1e1e1e] px-4 pt-2 pb-2 flex-shrink-0" style={{ position: "sticky", top: 0 }}>
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

      {/* ── Scalar Exploration ── */}
      {/* The visualizer + content live in the same wrapper here so
          that the visualizer's sticky containing block ends with the
          scalar content.  Once the user scrolls past the last chord,
          the visualizer is released and scrolls away with the rest of
          the page. */}
      {section === "scalar-exploration" && (
        <div className="flex-1 flex flex-col">
          <div id="main-visualizer" className="sticky top-0 z-50 bg-[#0d0d0d] border-b border-[#1e1e1e] px-4 pt-2 pb-2 flex-shrink-0" style={{ position: "sticky", top: 0 }}>
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
          <div className="px-4 pt-3">
            <div className="max-w-6xl mx-auto w-full">
              <ScalarTab tonicPc={tonicPc} lowestPitch={lowestPitch} highestPitch={highestPitch}
                edo={edo} onHighlight={handleHighlight}
                ensureAudio={ensureAudio} playVol={playVol} />
            </div>
          </div>
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

      {/* ── Scoring (Quick Transcriptions: Harmonic + Drum) ── */}
      {section === "note-entry" && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <ScoringMode />
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
        <div className="flex-1 flex flex-col overflow-y-auto px-4">
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
          <MelodicPatterns restoreTrigger={melodicRestoreTrigger} />
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
      {/* No inner overflow-y-auto: scrolling lives on the root <div>
          (line 728), so the sticky main visualizer (line 1070) anchors
          to the same scroll context the user actually scrolls.  A
          nested overflow container here would defeat the sticky — the
          root would never scroll, the inner would, and `top-0` would
          have nothing to anchor against. */}
      {section === "ear-trainer" && (
      <div className="px-4 pt-3 flex-1 flex flex-col">
      <div className="max-w-6xl mx-auto w-full flex-1 flex flex-col">
        {/* Temperament selector — splits Tonal Audiation into Meantone
            (12/31), Pythagorean (41), and Schismatic (53) families.  Each
            temperament filters the EDO selector and the game-mode tabs
            below.  Clicking a temperament snaps EDO to its first
            available value if the current EDO doesn't belong. */}
        <div className="flex gap-1 flex-wrap items-center mb-3">
          <span className="text-[10px] text-[#555] font-semibold tracking-wider mr-2">TEMPERAMENT</span>
          {TEMPERAMENTS.map(t => (
            <button key={t}
              onClick={() => {
                const allowed = TEMPERAMENT_EDOS[t];
                if (!allowed.includes(edo)) {
                  stopAllAudio();
                  setEdo(allowed[0]);
                }
              }}
              className={`px-3 py-1 rounded text-[11px] font-medium transition-colors ${
                temperament === t
                  ? "bg-[#3a3a8a] text-white border border-[#5b5be6]"
                  : "bg-[#0e0e0e] text-[#666] hover:text-[#aaa] hover:bg-[#181818] border border-[#222]"
              }`}>
              {TEMPERAMENT_LABELS[t]}
            </button>
          ))}
        </div>
        {/* EDO + Visualizer row — moved out of the global header into
            the Tonal Audiation body so it sits next to the
            temperament context that gates which EDOs are available. */}
        <div className="flex gap-2 flex-wrap items-center mb-3">
          <span className="text-[10px] text-[#555] font-semibold tracking-wider mr-1">EDO</span>
          <select value={edo} onChange={e => setEdo(Number(e.target.value))}
            className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
            {TEMPERAMENT_EDOS[temperament].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          {edo === 12 && (
            <>
              <div className="w-px h-4 bg-[#2a2a2a]" />
              <span className="text-[10px] text-[#555] font-semibold tracking-wider mr-1">VISUALIZER</span>
              <select value={vizType} onChange={e => setVizType(e.target.value as VisualizerType)}
                className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white focus:outline-none">
                {(Object.keys(VIZ_LABELS) as VisualizerType[]).map(v => (
                  <option key={v} value={v}>{VIZ_LABELS[v]}</option>
                ))}
              </select>
            </>
          )}
        </div>
        <div className="flex gap-1 flex-wrap items-center mb-4">
          <PresetBar onPresetLoaded={() => setTabKey(k => k + 1)} />
          <div className="w-px h-4 bg-[#2a2a2a]" />
          {temperamentTabs.map(t => (
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
                label: `Tonal Audiation · ${title}`,
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
          {/* Tab content.  Pythagorean (41) and Schismatic (53) only expose
              Intervals / Chord Progressions / Mode Identification — the other
              tabs are filtered out by temperamentTabs above and never become
              activeTab in those temperaments.  The three exposed tabs handle
              41/53 internally now: ChordsTab and ModeIdentificationTab swap
              their family/limit lists per EDO; IntervalsTab is naturally
              EDO-agnostic (interval index → cents). */}
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
              <DroneTab key={tabKey} tonicPc={tonicPc} lowestPitch={lowestPitch} highestPitch={highestPitch}
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
          betaMode={betaMode}
          onBetaModeChange={(v) => {
            setBetaMode(v);
            if (!v) {
              const BETA_SECTIONS = new Set([
                "harmony-workshop",
                "vocal-percussion","mixed-groups","drill-response","uncommon-meters",
                "konnakol","phrase-decomposition","interval-browser",
                "microwave",
              ]);
              if (BETA_SECTIONS.has(section)) setSection("ear-trainer");
            }
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
            } else if (entry.mode === "melodic-patterns") {
              writePendingRestore("melodic", entry.snapshot);
              setSection("melodic-patterns");
              setMelodicRestoreTrigger(k => k + 1);
            }
          }}
        />
      )}
    </div>
  );
}
