import { useMemo } from "react";

interface Props {
  highlightedPitches: Set<number>;
  onKeyClick?: (key: { pitch: number; section: number; color_hex: string; x: number; y: number; midi_note: number; channel: number; local_key_index: number }) => void;
  pitchMin?: number;
  pitchMax?: number;
  frets?: number;
}

/*
 * Standard 4-string bass tuning (EADG), open-string pitches relative to
 * pitch 0 (C4). G2=-17, D2=-22, A1=-27, E1=-32.
 * High to low (top to bottom) — thinnest string (G) at the top, thickest
 * (low E) at the bottom, matching standard fretboard diagrams.
 */
const OPEN_STRINGS = [-17, -22, -27, -32];

export default function BassFretboard({
  highlightedPitches,
  onKeyClick,
  pitchMin = -36,
  pitchMax = 8,
  frets = 22,
}: Props) {
  const { dots, strings, fretLines, fretMarkers, viewW, viewH } = useMemo(() => {
    const PAD_L = 40;   // space for nut
    const PAD_R = 12;
    const PAD_T = 16;
    const PAD_B = 16;
    const FRET_W = 40;  // slightly wider than guitar — fewer strings, so each fret gets more room
    const STRING_GAP = 26;

    const numStrings = OPEN_STRINGS.length;
    const totalFrets = frets;
    const w = PAD_L + totalFrets * FRET_W + PAD_R;
    const h = PAD_T + (numStrings - 1) * STRING_GAP + PAD_B;

    /* Fret marker dots (standard positions) */
    const markerFrets = [3, 5, 7, 9, 12, 15, 17, 19, 21];
    const doubleDotFrets = new Set([12]);
    const markers: { x: number; y: number }[] = [];
    for (const f of markerFrets) {
      if (f > totalFrets) continue;
      const cx = PAD_L + (f - 0.5) * FRET_W;
      if (doubleDotFrets.has(f)) {
        // Bass only has 4 strings — put the double-dot markers between the
        // outer pairs (string 1 and string 3) rather than splitting 2/4.
        markers.push({ x: cx, y: PAD_T + 0.5 * STRING_GAP });
        markers.push({ x: cx, y: PAD_T + 2.5 * STRING_GAP });
      } else {
        markers.push({ x: cx, y: PAD_T + ((numStrings - 1) / 2) * STRING_GAP });
      }
    }

    /* String lines */
    const sLines = OPEN_STRINGS.map((_, i) => {
      const y = PAD_T + i * STRING_GAP;
      return { x1: PAD_L - 4, x2: w - PAD_R, y };
    });

    /* Fret lines */
    const fLines: { x: number; y1: number; y2: number; isNut: boolean }[] = [];
    for (let f = 0; f <= totalFrets; f++) {
      const x = PAD_L + f * FRET_W;
      fLines.push({ x, y1: PAD_T - 2, y2: PAD_T + (numStrings - 1) * STRING_GAP + 2, isNut: f === 0 });
    }

    /* Dot positions (one per string × fret that's in pitch range) */
    const allDots: { pitch: number; cx: number; cy: number; stringIdx: number; fret: number }[] = [];
    for (let si = 0; si < numStrings; si++) {
      for (let f = 0; f <= totalFrets; f++) {
        const pitch = OPEN_STRINGS[si] + f;
        if (pitch < pitchMin || pitch > pitchMax) continue;
        const cx = f === 0 ? PAD_L - 14 : PAD_L + (f - 0.5) * FRET_W;
        const cy = PAD_T + si * STRING_GAP;
        allDots.push({ pitch, cx, cy, stringIdx: si, fret: f });
      }
    }

    return { dots: allDots, strings: sLines, fretLines: fLines, fretMarkers: markers, viewW: w, viewH: h };
  }, [pitchMin, pitchMax, frets]);

  const makeClickable = (d: { pitch: number; cx: number; cy: number }) => ({
    pitch: d.pitch,
    section: 1,
    color_hex: "#e8e8e8",
    x: d.cx,
    y: d.cy,
    midi_note: d.pitch + 60,
    channel: 1,
    local_key_index: 0,
  });

  const DOT_R = 9;

  return (
    <div className="w-full overflow-hidden bg-[#111111] rounded-xl border border-[#333]">
      <svg
        width="100%"
        viewBox={`0 0 ${viewW} ${viewH}`}
        style={{ maxHeight: 220, display: "block" }}
        preserveAspectRatio="xMidYMid meet"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Fretboard background */}
        <rect x={fretLines[0]?.x ?? 0} y={(strings[0]?.y ?? 0) - 6}
          width={(fretLines[fretLines.length - 1]?.x ?? 0) - (fretLines[0]?.x ?? 0)}
          height={(strings[strings.length - 1]?.y ?? 0) - (strings[0]?.y ?? 0) + 12}
          fill="#1a1500" rx={2} />

        {/* Fret markers (inlays) */}
        {fretMarkers.map((m, i) => (
          <circle key={`m${i}`} cx={m.x} cy={m.y} r={4} fill="#2a2a2a" />
        ))}

        {/* Fret lines */}
        {fretLines.map((f, i) => (
          <line key={`f${i}`} x1={f.x} y1={f.y1} x2={f.x} y2={f.y2}
            stroke={f.isNut ? "#888" : "#444"} strokeWidth={f.isNut ? 3 : 1} />
        ))}

        {/* Strings — bass strings are thicker than guitar; widen accordingly. */}
        {strings.map((s, i) => (
          <line key={`s${i}`} x1={s.x1} y1={s.y} x2={s.x2} y2={s.y}
            stroke="#888" strokeWidth={1.5 + i * 0.5} />
        ))}

        {/* Highlighted note dots */}
        {dots.map((d, i) => {
          if (!highlightedPitches.has(d.pitch)) return null;
          return (
            <circle
              key={`d${i}`}
              cx={d.cx} cy={d.cy} r={DOT_R}
              fill="#7cb8ff"
              stroke="#fff"
              strokeWidth={1.5}
              style={{ cursor: onKeyClick ? "pointer" : "default", transition: "fill 0.18s" }}
              onClick={() => onKeyClick?.(makeClickable(d))}
            />
          );
        })}

        {/* Invisible click targets for non-highlighted positions */}
        {dots.map((d, i) => {
          if (highlightedPitches.has(d.pitch)) return null;
          return (
            <circle
              key={`t${i}`}
              cx={d.cx} cy={d.cy} r={DOT_R}
              fill="transparent"
              stroke="none"
              style={{ cursor: onKeyClick ? "pointer" : "default" }}
              onClick={() => onKeyClick?.(makeClickable(d))}
            />
          );
        })}
      </svg>
    </div>
  );
}
