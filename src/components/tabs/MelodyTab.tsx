import { useState, useRef, useCallback, useEffect } from "react";
import { audioEngine } from "@/lib/audioEngine";
import {
  MELODY_BANK_31, MELODY_FAMILIES,
  randomChoice, fitLineIntoWindow, strictWindowBounds,
  PATTERN_SCALE_FAMILIES, getModeDegreeMap
} from "@/lib/musicTheory";
import { getDegreeMap } from "@/lib/edoData";
import { useLS, registerKnownOption, unregisterKnownOptionsForPrefix } from "@/lib/storage";
import { weightedRandomChoice, recordAnswer } from "@/lib/stats";
import PitchContour, { useContourReplay } from "@/components/PitchContour";
import type { TabSettingsSnapshot } from "@/App";

interface Props {
  tonicPc: number;
  lowestOct: number;
  highestOct: number;
  edo: number;
  onHighlight: (pcs: number[]) => void;
  responseMode: string;
  onResult: (text: string) => void;
  onPlay: (optionKey: string, label: string) => void;
  lastPlayed: React.MutableRefObject<{frames: number[][]; info: string} | null>;
  ensureAudio: () => Promise<void>;
  onShowOnKeyboard?: () => void;
  playVol?: number;
  onAnswer?: (optionKey: string, label: string, correct: boolean) => void;
  tabSettingsRef?: React.MutableRefObject<TabSettingsSnapshot | null>;
  answerButtons?: React.ReactNode;
}

const LENGTH_OPTIONS = ["Any","3","4","5","6","7","8","10","12"];
const GAP = 600;

const GENERATIVE_FAMILIES = new Set([
  "Cadences","Pentatonic Hooks","Neighbor-Tone Cells","Triadic Shapes"
]);

const SCALE_FAM_NAMES = Object.keys(PATTERN_SCALE_FAMILIES);

function resolveDegrees(
  phrase: { degrees: string[]; scale?: string },
  rootStep: number,
  scaleFam: string,
  modeName: string,
  isGenerative: boolean,
  edo: number
): number[] {
  const chromatic = getDegreeMap(edo);
  const degMap = isGenerative
    ? { ...chromatic, ...getModeDegreeMap(edo, scaleFam, modeName) }
    : chromatic;
  // Voice-leading: place each note at the octave-equivalent closest to the
  // previous note. This correctly handles both cadential resolutions
  // (7→1 goes UP a half-step) and neighbor-tone returns (b7→1 goes DOWN a
  // half-step) because the closest candidate is always the musically intended one.
  const out: number[] = [rootStep + (degMap[phrase.degrees[0]] ?? 0)];
  for (let i = 1; i < phrase.degrees.length; i++) {
    const pc = degMap[phrase.degrees[i]] ?? 0;
    let best = rootStep + pc;
    let bestDist = Math.abs(best - out[i - 1]);
    for (let k = -4; k <= 4; k++) {
      const c = rootStep + pc + k * edo;
      const dist = Math.abs(c - out[i - 1]);
      if (dist < bestDist) { bestDist = dist; best = c; }
    }
    out.push(best);
  }
  return out;
}

export default function MelodyTab({
  tonicPc, lowestOct, highestOct, edo, onHighlight, responseMode, onResult, onPlay, lastPlayed, ensureAudio, playVol = 0.65, onAnswer, tabSettingsRef, answerButtons,
}: Props) {
  const frameTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [checked, setChecked] = useLS<Set<string>>("lt_mel_checked",
    new Set(["Cadences","Pentatonic Hooks","Neighbor-Tone Cells","Triadic Shapes","Folk / Pop Phrases"])
  );
  const [lengthFilter, setLengthFilter] = useLS<string>("lt_mel_length", "Any");
  const [scaleFam, setScaleFam] = useLS<string>("lt_mel_scaleFam", "Major Family");
  const [modeName, setModeName] = useLS<string>("lt_mel_mode", "Ionian");
  const [showTarget, setShowTarget] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState(false);
  const pendingInfo = useRef<{text: string; isTarget: boolean} | null>(null);
  const [hasPendingInfo, setHasPendingInfo] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [contourNotes, setContourNotes] = useState<number[] | null>(null);
  const [contourDegrees, setContourDegrees] = useState<string[] | null>(null);
  const [contourVisible, setContourVisible] = useState(false);

  // Quiz modes
  const [melodyMode, setMelodyMode] = useLS<string>("lt_mel_mode_type", "listen");
  const [quizAnswer, setQuizAnswer] = useState<string | null>(null);
  const quizCorrect = useRef<string>("");
  const lastDegrees = useRef<string[]>([]);

  const modeOptions = PATTERN_SCALE_FAMILIES[scaleFam] ?? [];
  const safeMode = modeOptions.includes(modeName) ? modeName : (modeOptions[0] ?? "Ionian");

  useEffect(() => {
    unregisterKnownOptionsForPrefix("mel:");
    MELODY_FAMILIES.filter(f => checked.has(f)).forEach(f => {
      registerKnownOption(`mel:${f}`, `Melody: ${f}`);
    });
    return () => unregisterKnownOptionsForPrefix("mel:");
  }, [checked]);

  // Publish settings snapshot for history panel
  useEffect(() => {
    if (!tabSettingsRef) return;
    tabSettingsRef.current = {
      title: "Melody",
      groups: [
        { label: "Families", items: MELODY_FAMILIES.filter(f => checked.has(f)) },
        { label: "Length", items: [lengthFilter] },
        { label: "Scale", items: [`${scaleFam} · ${safeMode}`] },
        { label: "Mode", items: [melodyMode] },
      ],
    };
  }, [checked, lengthFilter, scaleFam, safeMode, melodyMode, tabSettingsRef]);

  const toggle = (f: string) => setChecked(prev => {
    const n = new Set(prev); if (n.has(f)) n.delete(f); else n.add(f); return n;
  });

  const play = async () => {
    if (isPlaying) return;
    await ensureAudio();
    const families = MELODY_FAMILIES.filter(f => checked.has(f));
    if (!families.length) { onResult("Select at least one melody family."); return; }

    const family = weightedRandomChoice(families, f => `mel:${f}`);
    let pool = MELODY_BANK_31.filter(m => m.family === family);
    if (lengthFilter !== "Any") {
      const len = parseInt(lengthFilter);
      pool = pool.filter(m => m.degrees.length === len);
    }
    if (!pool.length) { onResult("No phrases match the length filter."); return; }

    const phrase = randomChoice(pool);
    const isGen = GENERATIVE_FAMILIES.has(family);
    const [low, high] = strictWindowBounds(tonicPc, edo, lowestOct, highestOct);
    const base = tonicPc + (lowestOct + Math.floor((highestOct - lowestOct + 1) / 2) - 4) * edo;
    const rawSteps = resolveDegrees(phrase, base - tonicPc, scaleFam, safeMode, isGen, edo);
    const absNotes = fitLineIntoWindow(rawSteps.map(s => tonicPc + s), edo, low, high);

    if (!absNotes.length) { onResult("Could not fit melody into register window."); return; }

    const frames = absNotes.map(n => [n]);
    const info = phrase.degrees.join(" → ");
    const optKey = `mel:${family}`;
    setShowTarget(null);
    setInfoText("");
    setHasPendingInfo(false);
    setContourNotes(absNotes);
    setContourDegrees(phrase.degrees);
    setContourVisible(false);
    pendingInfo.current = { text: info, isTarget: responseMode !== "Play Audio" };
    setHasPendingInfo(true);
    onResult(`Melody: ${family}`);
    onPlay(optKey, `Melody: ${family}`);
    lastPlayed.current = { frames, info };
    setHasPlayed(true);
    setQuizAnswer(null);
    lastDegrees.current = phrase.degrees;

    // Set quiz correct answer
    if (melodyMode === "shape") {
      const diffs = absNotes.slice(1).map((n, i) => n - absNotes[i]);
      const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const allSame = diffs.every(d => Math.abs(d) <= 1);
      if (allSame) quizCorrect.current = "Stays";
      else if (avgDiff > 0.5) quizCorrect.current = "Ascending";
      else if (avgDiff < -0.5) quizCorrect.current = "Descending";
      else {
        // Check for arch or valley
        const mid = Math.floor(diffs.length / 2);
        const firstHalf = diffs.slice(0, mid).reduce((a, b) => a + b, 0);
        const secondHalf = diffs.slice(mid).reduce((a, b) => a + b, 0);
        if (firstHalf > 0 && secondHalf < 0) quizCorrect.current = "Arch";
        else if (firstHalf < 0 && secondHalf > 0) quizCorrect.current = "Valley";
        else quizCorrect.current = avgDiff >= 0 ? "Ascending" : "Descending";
      }
      onResult("What is the shape of this melody?");
    } else if (melodyMode === "degree") {
      quizCorrect.current = phrase.degrees[0];
      onResult("Which scale degree does this melody start on?");
    }

    setIsPlaying(true);
    audioEngine.playSequence(frames, edo, GAP, 0.85);
    setTimeout(() => setIsPlaying(false), frames.length * GAP + 500);
  };

  const highlightFrames = useCallback((frames: number[][]) => {
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    frames.forEach((frame, i) => {
      const id = setTimeout(() => {
        onHighlight(frame);
      }, i * GAP);
      frameTimers.current.push(id);
    });
  }, [edo, onHighlight]);

  const contourReplay = useContourReplay(
    contourVisible && contourNotes ? contourNotes.map(n => [n]) : null,
    GAP,
  );

  const replay = () => {
    const lp = lastPlayed.current;
    if (!lp) return;
    setIsPlaying(true);
    if (contourVisible) contourReplay.startReplay();
    audioEngine.playSequence(lp.frames, edo, GAP, 0.85);
    setTimeout(() => setIsPlaying(false), lp.frames.length * GAP + 500);
  };

  const handleShowInfo = () => {
    const p = pendingInfo.current;
    if (!p) return;
    if (p.isTarget) setShowTarget(p.text);
    else setInfoText(p.text);
    setContourVisible(true);
    if (lastPlayed.current) highlightFrames(lastPlayed.current.frames);
  };

  const handleQuizAnswer = (ans: string) => {
    if (quizAnswer !== null) return;
    setQuizAnswer(ans);
    const correct = ans === quizCorrect.current;
    recordAnswer(`mel:${melodyMode}`, `Melody ${melodyMode}: ${ans}`, correct);
    onAnswer?.(`mel:${melodyMode}`, `Melody ${melodyMode}: ${ans}`, correct);
    onResult(correct ? `Correct! ${quizCorrect.current}` : `Incorrect — answer was ${quizCorrect.current}`);
  };

  const SHAPE_OPTIONS = ["Ascending", "Descending", "Arch", "Valley", "Stays"];
  const DEGREE_OPTIONS = ["1", "2", "3", "4", "5", "6", "7"];
  const quizAnswered = quizAnswer !== null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="text-xs text-[#888] block mb-1">Length Filter</label>
          <select value={lengthFilter} onChange={e => setLengthFilter(e.target.value)}
            className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            {LENGTH_OPTIONS.map(l => <option key={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-[#888] block mb-1">Scale Family <span className="text-[#555]">(generative)</span></label>
          <select value={scaleFam} onChange={e => { setScaleFam(e.target.value); setModeName(PATTERN_SCALE_FAMILIES[e.target.value]?.[0] ?? "Ionian"); }}
            className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            {SCALE_FAM_NAMES.map(f => <option key={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-[#888] block mb-1">Mode <span className="text-[#555]">(generative)</span></label>
          <select value={safeMode} onChange={e => setModeName(e.target.value)}
            className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            {modeOptions.map(m => <option key={m}>{m}</option>)}
          </select>
        </div>
        <div className="text-xs text-[#555]">
          {Array.from(checked).filter(f => MELODY_FAMILIES.includes(f)).length} families selected
        </div>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={play} disabled={isPlaying}
          className="bg-[#7173e6] hover:bg-[#5a5cc8] disabled:opacity-50 text-white px-5 py-2 rounded text-sm font-medium transition-colors">
          {isPlaying ? "♪ Playing…" : "▶ Random Melody"}
        </button>
        {hasPlayed && (
          <button onClick={replay} disabled={isPlaying}
            className="bg-[#1e1e1e] hover:bg-[#2a2a2a] disabled:opacity-50 border border-[#333] text-[#aaa] px-4 py-2 rounded text-sm transition-colors">
            Replay
          </button>
        )}
        {hasPendingInfo && !showTarget && !infoText && (
          <button onClick={handleShowInfo}
            className="bg-[#1e1e1e] hover:bg-[#2a2a2a] border border-[#444] text-[#9999ee] px-4 py-2 rounded text-sm transition-colors">
            Show Answer
          </button>
        )}
        {answerButtons}
      </div>

      {showTarget && (
        <div className="bg-[#1a2a1a] border border-[#3a5a3a] rounded p-3 text-sm text-[#8fc88f] font-mono whitespace-pre">{showTarget}</div>
      )}
      {infoText && !showTarget && (
        <div className="bg-[#141414] border border-[#2a2a2a] rounded p-3 text-xs text-[#888] font-mono whitespace-pre">{infoText}</div>
      )}

      <div>
        <p className="text-xs text-[#555] mb-2">Melody Families:</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
          {MELODY_FAMILIES.map(f => {
            const isGen = GENERATIVE_FAMILIES.has(f);
            return (
              <label key={f} className={`flex items-center gap-2 px-3 py-2 rounded text-sm cursor-pointer transition-colors ${
                checked.has(f) ? "bg-[#1a1a2a] text-[#9999ee]" : "bg-[#141414] text-[#666] hover:bg-[#1e1e1e]"
              }`}>
                <input type="checkbox" checked={checked.has(f)} onChange={() => toggle(f)} className="accent-[#7173e6]" />
                {f}
                <span className="ml-auto">
                  <span className={`text-[10px] px-1 rounded ${isGen ? "text-[#7aaa7a] border border-[#3a6a3a]" : "text-[#8888cc] border border-[#33336a]"}`}>
                    {isGen ? "generative" : "fixed bank"}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
