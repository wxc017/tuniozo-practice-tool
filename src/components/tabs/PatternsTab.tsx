import { useState, useRef, useCallback, useEffect } from "react";
import { audioEngine } from "@/lib/audioEngine";
import {
  PATTERN_SCALE_FAMILIES, PATTERN_SEQUENCE_FAMILIES,
  buildDynamicPatternLine, getScaleDiatonicSteps, randomChoice,
  FAMILY_TO_STYLES
} from "@/lib/musicTheory";
import { getDegreeMap } from "@/lib/edoData";
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

const LENGTH_OPTIONS = ["Any","3","4","5","6","7","8","10","12"];

const GAP = 580;

export default function PatternsTab({
  tonicPc, lowestOct, highestOct, edo, onHighlight, responseMode, onResult, onPlay, lastPlayed, ensureAudio, onShowOnKeyboard, playVol = 0.65, tabSettingsRef, answerButtons,
}: Props) {
  const frameTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const familyNames = Object.keys(PATTERN_SCALE_FAMILIES);
  const [scaleFam, setScaleFam] = useLS<string>("lt_pat_scaleFam", familyNames[0]);
  const [modeName, setModeName] = useLS<string>("lt_pat_modeName", PATTERN_SCALE_FAMILIES[familyNames[0]][0]);
  const [lengthFilter, setLengthFilter] = useLS<string>("lt_pat_length", "Any");
  const [checked, setChecked] = useLS<Set<string>>("lt_pat_checked",
    new Set(["Scalar Sequences","Interval Chains","Skip Patterns","Cell Sequences","Triad Sequences"])
  );
  const [showTarget, setShowTarget] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState(false);
  const pendingInfo = useRef<{text: string; isTarget: boolean} | null>(null);
  const [hasPendingInfo, setHasPendingInfo] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [contourNotes, setContourNotes] = useState<number[] | null>(null);
  const [contourDegrees, setContourDegrees] = useState<string[] | null>(null);
  const [contourVisible, setContourVisible] = useState(false);

  const handleFamChange = (fam: string) => {
    setScaleFam(fam);
    setModeName(PATTERN_SCALE_FAMILIES[fam][0]);
  };

  useEffect(() => {
    unregisterKnownOptionsForPrefix("pat:");
    const styles: string[] = [];
    Array.from(checked).forEach(fam => styles.push(...(FAMILY_TO_STYLES[fam] ?? [fam])));
    styles.forEach(style => {
      registerKnownOption(`pat:${style}`, `Pattern: ${style}`);
    });
    return () => unregisterKnownOptionsForPrefix("pat:");
  }, [checked]);

  // Publish settings snapshot for history panel
  useEffect(() => {
    if (!tabSettingsRef) return;
    const modeOpts = PATTERN_SCALE_FAMILIES[scaleFam] ?? [];
    const safe = modeOpts.includes(modeName) ? modeName : (modeOpts[0] ?? "");
    tabSettingsRef.current = {
      title: "Patterns",
      groups: [
        { label: "Families", items: Array.from(checked) },
        { label: "Length", items: [lengthFilter] },
        { label: "Scale", items: [`${scaleFam} · ${safe}`] },
      ],
    };
  }, [checked, lengthFilter, scaleFam, modeName, tabSettingsRef]);

  const toggle = (f: string) => setChecked(prev => {
    const n = new Set(prev); if (n.has(f)) n.delete(f); else n.add(f); return n;
  });

  const play = async () => {
    if (isPlaying) return;
    await ensureAudio();
    if (!checked.size) { onResult("Select at least one pattern family."); return; }

    const dyn_len = lengthFilter !== "Any" ? parseInt(lengthFilter) : 4 + Math.floor(Math.random() * 4);
    const allStyles: string[] = [];
    Array.from(checked).forEach(fam => allStyles.push(...(FAMILY_TO_STYLES[fam] ?? [fam])));
    const pickedStyle = allStyles.length
      ? weightedRandomChoice(allStyles, s => `pat:${s}`)
      : randomChoice(["asc","desc","skip2","arch","cell2"]);
    let result: [number[], string] | null = null;
    for (let i = 0; i < 30; i++) {
      result = buildDynamicPatternLine(edo, tonicPc, lowestOct, highestOct, scaleFam, modeName, dyn_len, Array.from(checked), pickedStyle);
      if (result) break;
    }
    if (!result) { onResult("Could not fit pattern into window. Try wider octave range."); return; }

    const [lineAbs, styleUsed] = result;
    const frames = lineAbs.map(n => [n]);
    const scaleSteps = getScaleDiatonicSteps(scaleFam, modeName, edo);
    // Build a reverse map: step → chromatic degree name for non-diatonic notes
    const degMap = getDegreeMap(edo);
    const stepToDeg: Record<number, string> = {};
    for (const [name, step] of Object.entries(degMap)) {
      if (step <= edo && !stepToDeg[step]) stepToDeg[step] = name;
    }
    const degreeLabels = lineAbs.map(n => {
      const pc = ((n - tonicPc) % edo + edo) % edo;
      const idx = scaleSteps.indexOf(pc);
      if (idx >= 0) return String(idx + 1);
      // Chromatic note — find its degree name
      return stepToDeg[pc] ?? `${pc}`;
    });
    const info = degreeLabels.join(" → ");
    const optKey = `pat:${styleUsed}`;
    setShowTarget(null);
    setInfoText("");
    setHasPendingInfo(false);
    setContourNotes(lineAbs);
    setContourDegrees(degreeLabels);
    setContourVisible(false);
    pendingInfo.current = { text: info, isTarget: responseMode !== "Play Audio" };
    setHasPendingInfo(true);
    onResult(`Pattern: ${styleUsed} | ${scaleFam} / ${modeName}`);
    onPlay(optKey, `Pattern: ${styleUsed}`);
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
      {/* Scale selector */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-[#888] block mb-1">Scale Family</label>
          <select value={scaleFam} onChange={e => handleFamChange(e.target.value)}
            className="w-full bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            {familyNames.map(f => <option key={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-[#888] block mb-1">Mode</label>
          <select value={modeName} onChange={e => setModeName(e.target.value)}
            className="w-full bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            {PATTERN_SCALE_FAMILIES[scaleFam].map(m => <option key={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-[#888] block mb-1">Length</label>
          <select value={lengthFilter} onChange={e => setLengthFilter(e.target.value)}
            className="w-full bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            {LENGTH_OPTIONS.map(l => <option key={l}>{l}</option>)}
          </select>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={play} disabled={isPlaying}
          className="bg-[#7173e6] hover:bg-[#5a5cc8] disabled:opacity-50 text-white px-5 py-2 rounded text-sm font-medium transition-colors">
          {isPlaying ? "♪ Playing…" : "▶ Random Pattern"}
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
          label="Pattern"
          color="#e6c871"
        />
      )}

      <div>
        <div className="flex items-center gap-3 mb-2">
          <p className="text-xs text-[#555]">Pattern Families:</p>
          <button onClick={() => setChecked(new Set(PATTERN_SEQUENCE_FAMILIES))} className="text-xs text-[#666] hover:text-[#aaa]">All</button>
          <button onClick={() => setChecked(new Set())} className="text-xs text-[#666] hover:text-[#aaa]">None</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
          {PATTERN_SEQUENCE_FAMILIES.map(f => (
            <label key={f} className={`flex items-center gap-2 px-3 py-2 rounded text-sm cursor-pointer transition-colors ${
              checked.has(f) ? "bg-[#1a1a2a] text-[#9999ee]" : "bg-[#141414] text-[#666] hover:bg-[#1e1e1e]"
            }`}>
              <input type="checkbox" checked={checked.has(f)} onChange={() => toggle(f)} className="accent-[#7173e6]" />
              {f}
              <span className="ml-auto text-[10px] px-1 rounded text-[#7aaa7a] border border-[#3a6a3a]">generative</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
