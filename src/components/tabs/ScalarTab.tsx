import { useCallback, useMemo, useRef, useState } from "react";
import { audioEngine } from "@/lib/audioEngine";
import { useLS } from "@/lib/storage";
import { formatHalfAccidentals, getModeDegreeMap, getSolfege } from "@/lib/edoData";
import { getTonalityBanks, type TonalityBank } from "@/lib/tonalityBanks";
import { bankToScaleFamMode } from "@/lib/tonalityChordPool";
import { formatRomanNumeral } from "@/lib/formatRoman";

interface Props {
  tonicPc: number;
  lowestPitch: number;
  highestPitch: number;
  edo: number;
  onHighlight: (pcs: number[]) => void;
  ensureAudio: () => Promise<void>;
  playVol?: number;
}

const TONALITY_FAMILIES: { key: string; label: string; color: string; tonalities: string[] }[] = [
  { key: "major",    label: "MAJOR",          color: "#6a9aca",
    tonalities: ["Major","Dorian","Phrygian","Lydian","Mixolydian","Aeolian","Locrian"] },
  { key: "harmonic", label: "HARMONIC MINOR", color: "#c09050",
    tonalities: ["Harmonic Minor","Locrian #6","Ionian #5","Dorian #4","Phrygian Dominant","Lydian #2","Ultralocrian"] },
  { key: "melodic",  label: "MELODIC MINOR",  color: "#c06090",
    tonalities: ["Melodic Minor","Dorian b2","Lydian Augmented","Lydian Dominant","Mixolydian b6","Locrian #2","Altered"] },
  { key: "subminor",   label: "SUBMINOR DIATONIC",   color: "#7aaa6a",
    tonalities: ["Subminor Diatonic","Locrian s2 s5 s6","Supermajor Ionian","Dorian s3 bb4 s7","Subminor Phrygian m7","Supermajor Lydian M2 b5","Supermajor Mixolydian ##5 m7"] },
  { key: "neutral",    label: "NEUTRAL DIATONIC",    color: "#9a66c0",
    tonalities: ["Neutral Diatonic","Dorian N2 bb5 N6","Neutral Ionian","Ionian N3 ##4 N7","Neutral Dorian m7","Neutral Ionian M2 ##4","Neutral Dorian bb5 m7"] },
  { key: "supermajor", label: "SUPERMAJOR DIATONIC", color: "#cc6a8a",
    tonalities: ["Supermajor Diatonic","Dorian S2 ##5 S6","Subminor Phrygian","Lydian S3 b5 S7","Supermajor Mixolydian m7","Subminor Aeolian M2 bb4","Subminor Locrian m7"] },
  { key: "subharmonic",label: "SUBHARMONIC DIATONIC",color: "#4a9ac7",
    tonalities: ["Subharmonic Diatonic","Locrian s2 s5 N6","Supermajor Ionian #5","Dorian s3 ##4 s7","Phrygian s2 N3 s6","Supermajor Lydian #2 b5","Neutral Dorian b4 bb5 bb7"] },
];

export default function ScalarTab({
  tonicPc, lowestPitch, highestPitch, edo, onHighlight, ensureAudio, playVol = 0.55,
}: Props) {
  const [selected, setSelected] = useLS<string>("lt_scalar_tonality", "Major");
  const [activeFamilyColor, setActiveFamilyColor] = useState<string>("#6a9aca");
  const frameTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // All tonality banks for the current EDO.  showSevenths = true so the
  // chord pool exposes 7th-quality suffixes (Scalar Exploration is a
  // reference view; we want to see everything).
  const tonalityBanks = useMemo(() => getTonalityBanks(edo, true), [edo]);
  const banksByName = useMemo(() => {
    const m: Record<string, TonalityBank> = {};
    for (const b of tonalityBanks) m[b.name] = b;
    return m;
  }, [tonalityBanks]);

  // The currently-selected tonality's scale, solfège, and chord pool.
  const view = useMemo(() => {
    const bank = banksByName[selected];
    if (!bank) return null;
    const [fam, mode] = bankToScaleFamMode(selected);
    const degMap = getModeDegreeMap(edo, fam, mode);
    const entries = Object.entries(degMap).sort((a, b) => a[1] - b[1]);
    const solfege = getSolfege(edo);
    const scale = entries.map(([degree, step]) => ({
      degree,
      step,
      solfege: solfege ? solfege[step] : String(step),
    }));
    return { bank, scale };
  }, [banksByName, selected, edo]);

  const baseTonic = lowestPitch + (((tonicPc - lowestPitch) % edo) + edo) % edo;

  // Helper: clear any pending highlight scheduling and stop audio.
  const stop = useCallback(() => {
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    audioEngine.silencePlay();
    onHighlight([]);
  }, [onHighlight]);

  // Sequence playback: ascending scale 1-2-3-4-5-6-7-1', then a 5-second
  // hold on the full scale so the shape stays lit on the visualizer.
  const playSequence = useCallback(async () => {
    if (!view) return;
    await ensureAudio();
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    const stepsAsc = view.scale.map(s => s.step);
    const allSteps = [...stepsAsc, stepsAsc[0] + edo];
    const frames = allSteps.map(s => [baseTonic + s]);
    const noteDur = 0.55;
    const gapMs = 500;
    const HOLD_MS = 5000;
    audioEngine.playMultiVoice(
      [{ frames, noteDuration: noteDur, gain: playVol * 1.6 }],
      edo, gapMs, frames.length
    );
    for (let i = 0; i < frames.length; i++) {
      const id = setTimeout(() => onHighlight(frames[i]), i * gapMs);
      frameTimers.current.push(id);
    }
    const allNotes = allSteps.map(s => baseTonic + s);
    const holdStart = frames.length * gapMs;
    const holdId = setTimeout(() => onHighlight(allNotes), holdStart);
    frameTimers.current.push(holdId);
    const clearId = setTimeout(() => onHighlight([]), holdStart + HOLD_MS);
    frameTimers.current.push(clearId);
  }, [view, baseTonic, edo, ensureAudio, playVol, onHighlight]);

  // Static highlight: light up the entire scale at once on the keyboard,
  // for as long as the user wants to study the shape (cleared on next
  // action).
  const highlightAll = useCallback(() => {
    if (!view) return;
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    const allSteps = [...view.scale.map(s => s.step), view.scale[0].step + edo];
    onHighlight(allSteps.map(s => baseTonic + s));
  }, [view, baseTonic, edo, onHighlight]);

  // Play a single chord (its pitches simultaneously) and highlight.
  const playChord = useCallback(async (steps: number[]) => {
    if (!steps || steps.length === 0) return;
    await ensureAudio();
    frameTimers.current.forEach(id => clearTimeout(id));
    frameTimers.current = [];
    const pitches = steps.map(s => baseTonic + s);
    audioEngine.playMultiVoice(
      [{ frames: [pitches], noteDuration: 1.4, gain: playVol * 1.6 }],
      edo, 0, 1
    );
    onHighlight(pitches);
    const clearId = setTimeout(() => onHighlight([]), 1500);
    frameTimers.current.push(clearId);
  }, [baseTonic, edo, ensureAudio, playVol, onHighlight]);

  return (
    <div className="space-y-4">
      {/* ── Info panel for the selected tonality (renders right below
          the sticky visualizer at the top of the tab). ── */}
      {view && (
        <div className="bg-[#0e0e0e] border rounded p-4 space-y-3"
             style={{ borderColor: activeFamilyColor + "40" }}>
          <div className="flex items-center gap-3 flex-wrap">
            <h3 className="text-base font-semibold"
                style={{ color: activeFamilyColor }}>
              {formatHalfAccidentals(selected)}
            </h3>
            <button onClick={playSequence}
              className="text-[11px] px-3 py-1 rounded border border-[#2a2a2a] bg-[#141414] text-[#aaa] hover:text-white hover:border-[#444]">
              ▶ Play Scale
            </button>
            <button onClick={highlightAll}
              className="text-[11px] px-3 py-1 rounded border border-[#2a2a2a] bg-[#141414] text-[#aaa] hover:text-white hover:border-[#444]">
              ⬚ Highlight Scale
            </button>
            <button onClick={stop}
              className="text-[11px] px-3 py-1 rounded border border-[#2a2a2a] bg-[#141414] text-[#666] hover:text-[#aaa]">
              Clear
            </button>
          </div>

          {/* Solfège + degree row */}
          <div className="flex flex-wrap gap-2">
            {view.scale.map(s => (
              <div key={s.step}
                   className="flex flex-col items-center px-3 py-2 rounded border"
                   style={{ borderColor: activeFamilyColor + "30",
                            background: activeFamilyColor + "10" }}>
                <span className="text-base font-bold"
                      style={{ color: activeFamilyColor }}>
                  {s.solfege}
                </span>
                <span className="text-[10px] text-[#888] mt-0.5">
                  {formatHalfAccidentals(s.degree)}
                </span>
                <span className="text-[9px] text-[#555]">
                  step {s.step}
                </span>
              </div>
            ))}
          </div>

          {/* Chord pool — Primary + Diatonic */}
          {view.bank.levels
            .filter(l => l.name === "Primary" || l.name === "Diatonic")
            .map(level => (
              <div key={level.name}
                   className="rounded p-2 border border-[#1a1a1a] bg-[#0a0a0a]">
                <p className="text-[10px] mb-1.5 font-semibold tracking-wider"
                   style={{ color: activeFamilyColor }}>
                  {level.name.toUpperCase()}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {level.chords.map((entry, i) => (
                    <button key={`${entry.label}-${i}`}
                      onClick={() => entry.steps && playChord(entry.steps)}
                      title={entry.steps
                        ? `${entry.label} — ${entry.steps.join(", ")}`
                        : entry.label}
                      className="px-3 py-1.5 text-sm font-semibold rounded border border-[#2a2a2a] bg-[#141414] text-[#bbb] hover:text-white hover:border-[#444] transition-colors">
                      {formatRomanNumeral(entry.label)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* ── Tonality picker (large buttons, single-select) ────────── */}
      <div className="bg-[#0e0e0e] border border-[#1a1a1a] rounded p-3 space-y-3">
        {TONALITY_FAMILIES.map(group => {
          const available = group.tonalities.filter(t => banksByName[t]);
          if (available.length === 0) return null;
          return (
            <div key={group.key}>
              <p className="text-[10px] mb-1.5 font-semibold tracking-wider"
                 style={{ color: group.color }}>{group.label}</p>
              <div className="flex flex-wrap gap-1.5">
                {available.map(t => {
                  const on = selected === t;
                  return (
                    <button key={t}
                      onClick={() => { setSelected(t); setActiveFamilyColor(group.color); }}
                      className={`px-3 py-2 text-sm font-semibold rounded border transition-colors ${
                        on ? "" : "bg-[#111] border-[#2a2a2a] text-[#888] hover:text-[#ccc] hover:border-[#444]"
                      }`}
                      style={on
                        ? { backgroundColor: group.color + "30", borderColor: group.color, color: group.color }
                        : undefined}>
                      {formatHalfAccidentals(t)}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
