import { useState, useRef, useCallback, useEffect } from "react";
import { audioEngine } from "@/lib/audioEngine";
import { randomChoice } from "@/lib/musicTheory";
import { getIntervalNames } from "@/lib/edoData";
import { getModeDegreeMap } from "@/lib/musicTheory";
import { jiLimitGroupsForEdo } from "@/lib/jiTonalityFamilies";
import { useLS, registerKnownOption, unregisterKnownOptionsForPrefix } from "@/lib/storage";
import { weightedRandomChoice, getOptionStats } from "@/lib/stats";
import type { TabSettingsSnapshot } from "@/App";

// ── LIMIT > FAMILY > MODES tonality picker (mirrors ChordsTab) ───────────
// Same shape as Spatial Audiation's nested picker so the user sees
// tonalities organised the same way across the Tonal Audiation tabs.
// Each family carries the canonical PATTERN_SCALE_FAMILIES key
// (`scaleFamily`) so the quick-fill button can look up the scale's
// step values via getModeDegreeMap(edo, scaleFamily, modeName).

interface IntervalsTonalitySection {
  key: string;
  label: string;
  color: string;
  families: { key: string; label: string; scaleFamily: string; tonalities: string[] }[];
}

const MEANTONE_LIMIT_SECTIONS: IntervalsTonalitySection[] = [
  { key: "lim5", label: "5-LIMIT (MEANTONE)", color: "#6a9aca", families: [
    { key: "major",    label: "MAJOR",          scaleFamily: "Major Family",
      tonalities: ["Ionian","Dorian","Phrygian","Lydian","Mixolydian","Aeolian","Locrian"] },
    { key: "harmonic", label: "HARMONIC MINOR", scaleFamily: "Harmonic Minor Family",
      tonalities: ["Harmonic Minor","Locrian #6","Ionian #5","Dorian #4","Phrygian Dominant","Lydian #2","Ultralocrian"] },
    { key: "melodic",  label: "MELODIC MINOR",  scaleFamily: "Melodic Minor Family",
      tonalities: ["Melodic Minor","Dorian b2","Lydian Augmented","Lydian Dominant","Mixolydian b6","Locrian #2","Altered"] },
    { key: "doubleharmonic", label: "DOUBLE HARMONIC", scaleFamily: "Double Harmonic Family",
      tonalities: ["Double Harmonic Minor","Double Harmonic Major","Lydian #2 #6","Ultraphrygian","Oriental","Ionian #2 #5","Locrian bb3 bb7"] },
  ] },
  { key: "lim7", label: "7-LIMIT (SEPTIMAL)", color: "#7aaa6a", families: [
    { key: "subminor",   label: "SUBMINOR DIATONIC",   scaleFamily: "Subminor Diatonic Family",
      tonalities: ["Subminor Diatonic","Locrian s2 s5 s6","Supermajor Ionian","Dorian s3 bb4 s7","Subminor Phrygian m7","Supermajor Lydian M2 b5","Supermajor Mixolydian ##5 m7"] },
    { key: "supermajor", label: "SUPERMAJOR DIATONIC", scaleFamily: "Supermajor Diatonic Family",
      tonalities: ["Supermajor Diatonic","Dorian S2 ##5 S6","Subminor Phrygian","Lydian S3 b5 S7","Supermajor Mixolydian m7","Subminor Aeolian M2 bb4","Subminor Locrian m7"] },
    { key: "subharmonic",label: "SUBHARMONIC DIATONIC M7", scaleFamily: "Subharmonic Diatonic Family",
      tonalities: ["Subharmonic Diatonic M7","Locrian s2 s5 N6","Supermajor Ionian #5","Dorian s3 ##4 s7","Phrygian s2 N3 s6","Supermajor Lydian #2 b5","Neutral Dorian b4 bb5 bb7"] },
  ] },
  { key: "lim11", label: "11-LIMIT (NEUTRAL)", color: "#9a66c0", families: [
    { key: "neutral", label: "NEUTRAL DIATONIC", scaleFamily: "Neutral Diatonic Family",
      tonalities: ["Neutral Diatonic","Dorian N2 bb5 N6","Neutral Ionian","Ionian N3 ##4 N7","Neutral Dorian m7","Neutral Ionian M2 ##4","Neutral Dorian bb5 m7"] },
  ] },
];

function tonalitySectionsForIntervals(edo: number): IntervalsTonalitySection[] {
  if (edo === 41 || edo === 53) {
    // JI tabs use the JI_LIMIT_GROUPS structure with the registered
    // "JI Family" so getModeDegreeMap resolves each scale.
    return jiLimitGroupsForEdo(edo).map(g => ({
      key: `limit-${g.limit}`,
      label: g.label,
      color: g.color,
      families: g.families.map(f => ({
        key: f.key, label: f.label, scaleFamily: "JI Family",
        tonalities: f.tonalities,
      })),
    }));
  }
  return MEANTONE_LIMIT_SECTIONS;
}

const PLAY_STYLES = ["Sequential","Dyad (2 at once)","Trichord (3 at once)","Random (2–3 at once)"];
const DEFAULT_GAP_SEC = 0.65;
const MIN_GAP_SEC = 0.1;
const MAX_GAP_SEC = 3.0;
const GAP_STEP_SEC = 0.05;

interface Props {
  tonicPc: number;
  lowestPitch: number;
  highestPitch: number;
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

export default function IntervalsTab({
  tonicPc, lowestPitch, highestPitch, edo, onHighlight, responseMode, onResult, onPlay, lastPlayed, ensureAudio, onShowOnKeyboard, playVol = 0.65, tabSettingsRef, answerButtons
}: Props) {
  const frameTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [checked, setChecked] = useLS<Set<number>>("lt_ivl_checked", new Set([3,5,8,10,13,15,18,21,23,26,28]));
  const [numNotes, setNumNotes] = useLS<number>("lt_ivl_numNotes", 2);
  const [playStyle, setPlayStyle] = useLS<string>("lt_ivl_playStyle", "Sequential");
  const [gapSec, setGapSec] = useLS<number>("lt_ivl_gapSec", DEFAULT_GAP_SEC);
  const clampGap = (v: number) => {
    if (!isFinite(v)) return DEFAULT_GAP_SEC;
    const snapped = Math.round(v / GAP_STEP_SEC) * GAP_STEP_SEC;
    return Math.max(MIN_GAP_SEC, Math.min(MAX_GAP_SEC, Number(snapped.toFixed(2))));
  };
  const gapMs = Math.round(gapSec * 1000);
  const [showTarget, setShowTarget] = useState<string | null>(null);
  const [infoText, setInfoText] = useState("");
  const pendingInfo = useRef<{text: string; isTarget: boolean} | null>(null);
  const [hasPendingInfo, setHasPendingInfo] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);

  // Recency tracker: maps interval step → sequential play counter when last picked
  const playCounter = useRef(0);
  const lastPickedAt = useRef<Map<number, number>>(new Map());

  const toggle = (i: number) => setChecked(prev => {
    const n = new Set(prev);
    if (n.has(i)) n.delete(i); else n.add(i);
    return n;
  });

  const ivNames = getIntervalNames(edo);

  const selectAll = () => setChecked(new Set(ivNames.map((_,i) => i)));
  const clearAll = () => setChecked(new Set());

  useEffect(() => {
    unregisterKnownOptionsForPrefix("ivl:");
    Array.from(checked).forEach(step => {
      registerKnownOption(`ivl:${step}`, `Interval: ${ivNames[step]}`);
    });
    return () => unregisterKnownOptionsForPrefix("ivl:");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, edo]);

  // Publish settings snapshot for history panel
  useEffect(() => {
    if (!tabSettingsRef) return;
    tabSettingsRef.current = {
      title: "Intervals",
      groups: [
        { label: "# Notes", items: [String(numNotes)] },
        { label: "Play Style", items: [playStyle] },
        { label: "Note Duration", items: [`${gapSec.toFixed(2)} s`] },
        { label: "Intervals", items: Array.from(checked).sort((a, b) => a - b).map(i => ivNames[i]).filter(Boolean) },
      ],
    };
  }, [checked, numNotes, playStyle, gapSec, edo, tabSettingsRef, ivNames]);

  /** Pick an interval step, biased towards ones not played recently.
   *  `exclude` optionally avoids picking the same step twice in a row. */
  const pickStep = (pool: number[], opts: Record<string, { correct: number; wrong: number }>, exclude?: number): number => {
    const now = playCounter.current;
    // Candidates: prefer not repeating the previous note's step
    let candidates = pool.length > 1 && exclude !== undefined
      ? pool.filter(s => s !== exclude)
      : pool;
    if (candidates.length === 0) candidates = pool;

    // Weight: recency-based to cycle through all intervals evenly
    const weights = candidates.map(s => {
      const lastAt = lastPickedAt.current.get(s);
      const age = lastAt === undefined ? candidates.length + 3 : now - lastAt;
      return Math.min(age, candidates.length + 3);
    });

    const sum = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * sum;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  };

  const buildNotes = (): {notes: {note: number; label: string}[]; steps: number[]; root: number} => {
    // Drop checked indices that aren't valid for the current EDO's interval
    // name list — otherwise stale picks show up as "Root" in the answer.
    const pool = Array.from(checked).filter(i => i >= 0 && i < ivNames.length);
    if (!pool.length) return {notes: [], steps: [], root: 0};
    const low = lowestPitch;
    const high = highestPitch + 1;
    let r = Math.floor((lowestPitch + highestPitch) / 2);
    while (r < low) r += edo;
    while (r >= high) r -= edo;

    playCounter.current++;
    const opts = getOptionStats();
    // Non-sequential styles fix the sonority size (no root involved — all
    // notes are drawn from the selection pool):
    //   Dyad     → 2 notes
    //   Trichord → 3 notes
    //   Random   → 3 notes (frame splitter spreads into 2-/3-note sub-sonorities)
    //  Sequential keeps the user-picked numNotes.
    const styleForced =
      playStyle === "Dyad (2 at once)"     ? 2 :
      playStyle === "Trichord (3 at once)" ? 3 :
      playStyle === "Random (2–3 at once)" ? 3 :
      null;
    const count = Math.min(styleForced ?? numNotes, 6);
    const notes: {note: number; label: string}[] = [];
    const steps: number[] = [];
    for (let i = 0; i < count; i++) {
      const prev = i > 0 ? steps[i - 1] : undefined;
      const step = pickStep(pool, opts, prev);
      steps.push(step);
      lastPickedAt.current.set(step, playCounter.current);
      let n = r + step;
      // Wrap strictly into [low, high) so notes stay inside the exercise range.
      while (n >= high) n -= edo;
      while (n < low) n += edo;
      notes.push({note: n, label: ivNames[step] ?? `Step ${step}`});
    }
    return {notes, steps, root: r};
  };

  const buildFrames = (notes: {note: number; label: string}[], _root: number): number[][] => {
    if (!notes.length) return [];
    const style = playStyle;
    if (style === "Sequential") {
      // One note per frame — notes from the selection pool only, no root.
      return notes.map(x => [x.note]);
    }
    if (style === "Dyad (2 at once)") {
      // Two notes from the pool stacked in one frame.
      return [[...new Set(notes.map(x => x.note))]];
    }
    if (style === "Trichord (3 at once)") {
      // Three notes from the pool stacked in one frame.
      return [[...new Set(notes.map(x => x.note))]];
    }
    if (style === "Random (2–3 at once)") {
      const frames: number[][] = [];
      let i = 0;
      while (i < notes.length) {
        const take = Math.random() < 0.5 ? 2 : 3;
        const frame = [...new Set(notes.slice(i, i + take).map(x => x.note))];
        if (frame.length) frames.push(frame);
        i += take;
      }
      return frames;
    }
    return notes.map(x => [x.note]);
  };

  const play = async () => {
    await ensureAudio();
    if (!checked.size) return;
    const {notes, steps, root} = buildNotes();
    if (!notes.length) return;
    const frames = buildFrames(notes, root);
    const desc = notes.map(x => x.label).join(" → ");
    const sortedSteps = [...steps].sort((a, b) => a - b);
    const optKey = steps.length === 1
      ? `ivl:${steps[0]}`
      : steps.length > 1
        ? `ivl:${sortedSteps.join('+')}`
        : `ivl:root`;
    const stepLabel = steps.length
      ? steps.map(s => ivNames[s]).join(' + ')
      : 'Root only';
    setShowTarget(null);
    setInfoText("");
    setHasPendingInfo(false);
    pendingInfo.current = { text: `Intervals: ${desc}`, isTarget: responseMode !== "Play Audio" };
    setHasPendingInfo(true);
    onResult(`Intervals: ${desc}`);
    onPlay(optKey, `Interval: ${stepLabel}`);
    lastPlayed.current = { frames, info: desc };
    setHasPlayed(true);
    audioEngine.playSequence(frames, edo, gapMs, 0.9);
  };

  const highlightFrames = useCallback((frames: number[][]) => {
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    frames.forEach((frame, i) => {
      const id = setTimeout(() => {
        onHighlight(frame);
      }, i * gapMs);
      frameTimers.current.push(id);
    });
  }, [edo, onHighlight, gapMs]);

  const replay = () => {
    const lp = lastPlayed.current;
    if (!lp) return;
    audioEngine.playSequence(lp.frames, edo, gapMs, 0.9);
  };

  const answerVisible = !!(showTarget || infoText);

  const handleShowInfo = () => {
    // Toggle: if answer is already visible, hide it
    if (answerVisible) {
      setShowTarget(null);
      setInfoText("");
      return;
    }
    const p = pendingInfo.current;
    if (!p) return;
    if (p.isTarget) setShowTarget(p.text);
    else setInfoText(p.text);
    if (lastPlayed.current) highlightFrames(lastPlayed.current.frames);
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="text-xs text-[#888] block mb-1"># Notes</label>
          {(() => {
            // Only Sequential honors the user's # Notes pick — the other
            // styles imply a fixed sonority size (Dyad = 2, Trichord = 3,
            // Random = 2 stacked with random frame splits).  Grey the
            // buttons out in those cases so the picker isn't misleading.
            const disabled = playStyle !== "Sequential";
            return (
              <div className="flex gap-1" title={disabled ? `${playStyle} uses a fixed sonority size` : undefined}>
                {[1,2,3,4,5,6].map(n => (
                  <button key={n}
                    onClick={() => { if (!disabled) setNumNotes(n); }}
                    disabled={disabled}
                    className={`w-8 h-8 rounded text-xs font-medium transition-colors ${
                      disabled
                        ? "bg-[#141414] text-[#444] border border-[#222] cursor-not-allowed"
                        : numNotes === n
                          ? "bg-[#7173e6] text-white"
                          : "bg-[#1e1e1e] text-[#888] hover:bg-[#2a2a2a] border border-[#333]"
                    }`}>
                    {n}
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
        <div>
          <label className="text-xs text-[#888] block mb-1">Play Style</label>
          <select value={playStyle} onChange={e => setPlayStyle(e.target.value)}
            className="bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none">
            {PLAY_STYLES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-[#888] block mb-1">Note Duration</label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={MIN_GAP_SEC}
              max={MAX_GAP_SEC}
              step={GAP_STEP_SEC}
              value={gapSec}
              onChange={e => setGapSec(clampGap(Number(e.target.value)))}
              className="w-32 accent-[#7173e6]"
              title={`${gapSec.toFixed(2)} s per note (applies on next play)`}
            />
            <input
              type="number"
              min={MIN_GAP_SEC}
              max={MAX_GAP_SEC}
              step={GAP_STEP_SEC}
              value={gapSec.toFixed(2)}
              onChange={e => setGapSec(clampGap(Number(e.target.value)))}
              className="w-16 bg-[#1e1e1e] border border-[#333] rounded px-2 py-1.5 text-sm text-white focus:outline-none text-center"
            />
            <span className="text-xs text-[#555]">s</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={play}
          className="bg-[#7173e6] hover:bg-[#5a5cc8] text-white px-5 py-2 rounded text-sm font-medium transition-colors">
          ▶ Play
        </button>
        {hasPlayed && (
          <button onClick={replay}
            className="bg-[#1e1e1e] hover:bg-[#2a2a2a] border border-[#333] text-[#aaa] px-4 py-2 rounded text-sm transition-colors">
            Replay
          </button>
        )}
        {hasPendingInfo && (
          <button onClick={handleShowInfo}
            className={`hover:bg-[#2a2a2a] border px-4 py-2 rounded text-sm transition-colors ${answerVisible ? "bg-[#1a1a2e] border-[#7173e6] text-[#9999ee]" : "bg-[#1e1e1e] border-[#444] text-[#9999ee]"}`}>
            {answerVisible ? "Hide Answer" : "Show Answer"}
          </button>
        )}
        {answerButtons}
        <button onClick={selectAll} className="text-xs text-[#666] hover:text-[#aaa] px-2 py-1">All</button>
        <button onClick={clearAll} className="text-xs text-[#666] hover:text-[#aaa] px-2 py-1">None</button>
      </div>

      {showTarget && (
        <div className="bg-[#1a2a1a] border border-[#3a5a3a] rounded p-3 text-sm text-[#8fc88f] font-mono whitespace-pre">{showTarget}</div>
      )}
      {infoText && !showTarget && (
        <div className="bg-[#141414] border border-[#2a2a2a] rounded p-3 text-xs text-[#888] font-mono whitespace-pre">{infoText}</div>
      )}

      {/* Tonality quick-fill picker — same LIMIT > FAMILY > MODES
          structure as Spatial Audiation (ChordsTab) so the two tabs
          present tonalities the same way.  Click any scale to auto-
          check every interval that appears in it.  The unison (step 0)
          is excluded since unison-vs-other quizzes are degenerate. */}
      <div className="bg-[#0e0e0e] border border-[#1a1a1a] rounded p-2 space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-xs text-[#888] font-medium">QUICK FILL FROM TONALITY</p>
          <button onClick={() => setChecked(new Set())}
            className="text-[9px] text-[#555] hover:text-[#aaa] border border-[#222] rounded px-2 py-0.5 ml-auto">Clear</button>
        </div>
        {tonalitySectionsForIntervals(edo).map(section => (
          <div key={section.key} className="space-y-1.5">
            <p className="text-[10px] font-bold tracking-widest border-b border-[#1a1a1a] pb-0.5"
               style={{ color: section.color }}>{section.label}</p>
            {section.families.map(family => (
              <div key={family.key} className="ml-2">
                <p className="text-[9px] mb-1 font-medium tracking-wider text-[#666]">
                  {family.label}
                </p>
                <div className="flex flex-wrap gap-1">
                  {family.tonalities.map(t => {
                    const map = getModeDegreeMap(edo, family.scaleFamily, t);
                    const steps = Object.values(map).filter(s => s > 0);
                    if (steps.length === 0) return null;
                    return (
                      <button key={t}
                        onClick={() => setChecked(new Set(steps))}
                        title={`Auto-check ${t} (${steps.length} intervals)`}
                        className="px-2 py-1 text-[10px] rounded border border-[#2a2a2a] bg-[#111] text-[#666] hover:text-[#aaa] transition-colors"
                        style={{ borderLeftWidth: 3, borderLeftColor: section.color }}>
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Interval selection — toggle buttons matching the Mode ID /
          Chords-tab picker style. */}
      <div>
        <p className="text-xs text-[#555] mb-2">Select intervals to include:</p>
        <div className="flex flex-wrap gap-1 max-h-64 overflow-y-auto pr-1">
          {ivNames.map((name, i) => {
            const on = checked.has(i);
            const accent = "#9999ee";
            return (
              <button key={i} onClick={() => toggle(i)}
                className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                  on ? "" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                }`}
                style={on ? { backgroundColor: accent + "30", borderColor: accent, color: accent } : undefined}>
                <span className="opacity-60 mr-1">{i}</span>{name}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
