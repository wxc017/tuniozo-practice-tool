import { useState, useRef, useCallback, useEffect } from "react";
import { audioEngine } from "@/lib/audioEngine";
import {
  JAZZ_CELL_BANK_31, JAZZ_FAMILIES, JAZZ_FAMILY_DESCRIPTIONS,
  generateJazzCell,
  jazzPhraseToStepsEdo, randomChoice, fitLineIntoWindow, strictWindowBounds,
  PATTERN_SCALE_FAMILIES
} from "@/lib/musicTheory";
import { useLS, registerKnownOption, unregisterKnownOptionsForPrefix } from "@/lib/storage";
import { weightedRandomChoice } from "@/lib/stats";
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
  tabSettingsRef?: React.MutableRefObject<TabSettingsSnapshot | null>;
  answerButtons?: React.ReactNode;
}

const LENGTH_OPTIONS = ["Any","3","4","5","6","7","8","9"];
const SCALE_FAM_NAMES = Object.keys(PATTERN_SCALE_FAMILIES);
const GAP = 550;

export default function JazzTab({
  tonicPc, lowestOct, highestOct, edo, onHighlight, responseMode, onResult, onPlay, lastPlayed, ensureAudio, playVol = 0.65, tabSettingsRef, answerButtons,
}: Props) {
  const frameTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [checked, setChecked] = useLS<Set<string>>("lt_jazz_checked",
    new Set(["Chord Tone Arpeggios","Enclosures","Bebop Fragments","Guide-Tone Lines"])
  );
  const [lengthFilter, setLengthFilter] = useLS<string>("lt_jazz_length", "Any");
  const [scaleFam, setScaleFam] = useLS<string>("lt_jazz_scaleFam", "Major Family");
  const [modeName, setModeName] = useLS<string>("lt_jazz_mode", "Ionian");
  const [showTarget, setShowTarget] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState(false);
  const pendingInfo = useRef<{text: string; isTarget: boolean} | null>(null);
  const [hasPendingInfo, setHasPendingInfo] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [contourNotes, setContourNotes] = useState<number[] | null>(null);
  const [contourDegrees, setContourDegrees] = useState<string[] | null>(null);
  const [contourVisible, setContourVisible] = useState(false);

  const modeOptions = PATTERN_SCALE_FAMILIES[scaleFam] ?? [];
  const safeMode = modeOptions.includes(modeName) ? modeName : (modeOptions[0] ?? "Ionian");

  useEffect(() => {
    unregisterKnownOptionsForPrefix("jazz:");
    JAZZ_FAMILIES.filter(f => checked.has(f)).forEach(f => {
      registerKnownOption(`jazz:${f}`, `Jazz: ${f}`);
    });
    return () => unregisterKnownOptionsForPrefix("jazz:");
  }, [checked]);

  // Publish settings snapshot for history panel
  useEffect(() => {
    if (!tabSettingsRef) return;
    tabSettingsRef.current = {
      title: "Jazz Cells",
      groups: [
        { label: "Families", items: JAZZ_FAMILIES.filter(f => checked.has(f)) },
        { label: "Length", items: [lengthFilter] },
        { label: "Scale", items: [`${scaleFam} · ${safeMode}`] },
      ],
    };
  }, [checked, lengthFilter, scaleFam, safeMode, tabSettingsRef]);

  const toggle = (f: string) => setChecked(prev => {
    const n = new Set(prev); if (n.has(f)) n.delete(f); else n.add(f); return n;
  });

  const play = async () => {
    if (isPlaying) return;
    await ensureAudio();
    const families = JAZZ_FAMILIES.filter(f => checked.has(f));
    if (!families.length) { onResult("Select at least one jazz family."); return; }

    const family = weightedRandomChoice(families, f => `jazz:${f}`);
    const len = lengthFilter !== "Any" ? parseInt(lengthFilter) : 3 + Math.floor(Math.random() * 5);
    const phrase = generateJazzCell(family, len);
    const [low, high] = strictWindowBounds(tonicPc, edo, lowestOct, highestOct);
    const base = tonicPc + (lowestOct + Math.floor((highestOct - lowestOct) / 2) - 4) * edo;
    const rawSteps = jazzPhraseToStepsEdo(phrase.degrees, base - tonicPc, scaleFam, safeMode, edo);
    const absNotes = fitLineIntoWindow(rawSteps.map(s => tonicPc + s), edo, low, high);

    if (!absNotes.length) { onResult("Could not fit cell into register window."); return; }

    const frames = absNotes.map(n => [n]);
    const info = phrase.degrees.join(" → ");
    const optKey = `jazz:${family}`;
    setShowTarget(null);
    setInfoText("");
    setHasPendingInfo(false);
    setContourNotes(absNotes);
    setContourDegrees(phrase.degrees);
    setContourVisible(false);
    pendingInfo.current = { text: info, isTarget: responseMode !== "Play Audio" };
    setHasPendingInfo(true);
    onResult(`Jazz: ${family}`);
    onPlay(optKey, `Jazz: ${family}`);
    lastPlayed.current = { frames, info };
    setHasPlayed(true);

    setIsPlaying(true);
    audioEngine.playSequence(frames, edo, GAP, 0.8);
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
    audioEngine.playSequence(lp.frames, edo, GAP, 0.8);
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
          <label className="text-xs text-[#888] block mb-1">Scale Family</label>
          <select value={scaleFam} onChange={e => { setScaleFam(e.target.value); setModeName(PATTERN_SCALE_FAMILIES[e.target.value]?.[0] ?? "Ionian"); }}
            className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            {SCALE_FAM_NAMES.map(f => <option key={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-[#888] block mb-1">Mode</label>
          <select value={safeMode} onChange={e => setModeName(e.target.value)}
            className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            {modeOptions.map(m => <option key={m}>{m}</option>)}
          </select>
        </div>
        <div className="text-xs text-[#555]">
          {JAZZ_FAMILIES.filter(f => checked.has(f)).length} families selected
        </div>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={play} disabled={isPlaying}
          className="bg-[#7173e6] hover:bg-[#5a5cc8] disabled:opacity-50 text-white px-5 py-2 rounded text-sm font-medium transition-colors">
          {isPlaying ? "♪ Playing…" : "▶ Random Jazz Cell"}
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

      {contourVisible && contourNotes && contourDegrees && (
        <PitchContour
          notes={contourNotes}
          degrees={contourDegrees}
          activeIdx={contourReplay.activeIdx}
          label="Jazz Cell"
          color="#7173e6"
        />
      )}

      <div>
        <p className="text-xs text-[#555] mb-2">Jazz Cell Families:</p>
        <div className="grid grid-cols-1 gap-1">
          {JAZZ_FAMILIES.map(f => (
            <label key={f} className={`flex items-start gap-2 px-3 py-2 rounded text-sm cursor-pointer transition-colors ${
              checked.has(f) ? "bg-[#1a1a2a] text-[#9999ee]" : "bg-[#141414] text-[#666] hover:bg-[#1e1e1e]"
            }`}>
              <input type="checkbox" checked={checked.has(f)} onChange={() => toggle(f)} className="accent-[#7173e6] mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {f}
                  <span className="text-[10px] px-1 rounded text-[#7aaa7a] border border-[#3a6a3a]">generative</span>
                </div>
                <p className="text-[10px] text-[#555] mt-0.5 leading-snug">{JAZZ_FAMILY_DESCRIPTIONS[f]}</p>
              </div>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
