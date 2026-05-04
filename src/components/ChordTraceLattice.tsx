// ── Chord-Trace Lattice (focused 2D JI lattice for Show Answer) ──────────
//
// Plots a chord progression's full chord-tone walk on the (3-axis × 5-axis)
// JI lattice.  As playback advances, the active chord's tones light up;
// solid edges connect the tones inside one chord, and dotted edges
// connect each drifted tone to where the same chord-tone would have
// landed without comma compensation — making the comma offset visible
// as the gap between dotted twin and lit cell.
//
// Distinct from LatticeView (the standalone Harmonic-Lattice 3D tool):
// this is a focused 2D viewer with no controls, no view-mode picker,
// no drone configuration — just the lattice and the trace, sized to
// fill whatever container the parent gives it.

import React from "react";
import {
  tracePath, voicingFor, latticeAdd, canonicalChordRoot, stripChordLabel,
  type LatticePos,
} from "@/lib/jiLattice";

interface Props {
  /** Chord labels in playback order. */
  progression: string[];
  /** VOICING_CATALOG quality keys (e.g. "major", "minor", "dom7") in
   *  the same order as `progression`.  The lattice plots each chord's
   *  full voicing using the matching catalog entry; chords with no
   *  catalog entry fall back to a major triad so something still
   *  renders. */
  qualities: string[];
  /** Index of the currently sounding chord, driven by playback timer.
   *  -1 disables the active highlight. */
  currentIdx: number;
  /** Active EDO.  The lattice tempers each cell down to its EDO step
   *  so the visualization actually matches what the user hears: in
   *  meantone EDOs (12 / 19 / 31) the syntonic comma vanishes and two
   *  lattice cells separated by (4, -1) collapse to the same step,
   *  giving the user a visual signature of "this comma is tempered
   *  out here".  In 41 / 53 the syntonic comma survives so distinct
   *  cells stay distinct. */
  edo: number;
  /** Accent colour for active-chord highlight + path arrows. */
  accent?: string;
}

/** 5-limit ratio + cents at lattice position (a, b), octave-reduced. */
function latticeRatioAt(a: number, b: number): { ratio: string; cents: number } {
  let num = 1, den = 1;
  if (a > 0) num *= 3 ** a; else if (a < 0) den *= 3 ** -a;
  if (b > 0) num *= 5 ** b; else if (b < 0) den *= 5 ** -b;
  while (num >= den * 2) den *= 2;
  while (num < den) num *= 2;
  while (num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
  const cents = Math.log2(num / den) * 1200;
  return { ratio: `${num}/${den}`, cents };
}

/** EDO step (mod edo) at lattice position (a, b).  Two cells whose JI
 *  cents map to the same rounded step are "the same note" in this EDO
 *  — visualizing them with the same step number is the visual
 *  signature of a tempered comma. */
function edoStepAt(a: number, b: number, edo: number): number {
  const { cents } = latticeRatioAt(a, b);
  const norm = ((cents % 1200) + 1200) % 1200;
  return ((Math.round(norm / 1200 * edo) % edo) + edo) % edo;
}

/** HSL fill for a given EDO step.  Cells sharing a step get the same
 *  hue, so the equivalence classes the EDO induces are immediately
 *  visible — in 12-EDO many cells collapse onto the same hue (showing
 *  the comma vanishings), in 41/53-EDO each cell is its own hue
 *  (showing how those systems preserve more distinctions). */
function fillForStep(step: number, edo: number, opts: { active?: boolean; touched?: boolean }): string {
  const hue = (step / edo) * 360;
  if (opts.active) return `hsl(${hue}deg, 55%, 36%)`;
  if (opts.touched) return `hsl(${hue}deg, 32%, 18%)`;
  return `hsl(${hue}deg, 18%, 9%)`;
}

function strokeForStep(step: number, edo: number, opts: { active?: boolean; touched?: boolean; isOrigin?: boolean }): string {
  const hue = (step / edo) * 360;
  if (opts.active) return `hsl(${hue}deg, 70%, 60%)`;
  if (opts.touched) return `hsl(${hue}deg, 45%, 38%)`;
  if (opts.isOrigin) return "#3a3a5a";
  return "#1a1a1a";
}

const A_AXIS = 0, B_AXIS = 1;

function getA(pos: LatticePos): number { return pos[A_AXIS] ?? 0; }
function getB(pos: LatticePos): number { return pos[B_AXIS] ?? 0; }

interface ChordPlot {
  /** Walked (drifted) tone positions for this chord, in voicing order. */
  walkedTones: LatticePos[];
  /** Canonical (non-drifted) tone positions for this chord. */
  canonicalTones: LatticePos[];
}

export default function ChordTraceLattice({
  progression, qualities, currentIdx, edo, accent = "#5cca8a",
}: Props) {
  if (progression.length === 0) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#555", fontSize: 11 }}>
        No progression to trace yet — play a loop first.
      </div>
    );
  }

  // 1. Walk the progression on the lattice to get drifted chord-root
  //    positions, then expand each root into its full voicing.
  const walkedRoots = tracePath(progression);
  const chordPlots: ChordPlot[] = progression.map((label, i) => {
    const q = qualities[i] ?? "major";
    const voicing = voicingFor(q) ?? voicingFor("major")!;
    const walkedRoot = walkedRoots[i];
    const canonicalRoot = canonicalChordRoot(label);
    return {
      walkedTones: voicing.voices.map(vp => latticeAdd(walkedRoot, vp)),
      canonicalTones: voicing.voices.map(vp => latticeAdd(canonicalRoot, vp)),
    };
  });

  // 2. Bounding box must cover both walked AND canonical positions so
  //    the dotted comma-edges fit inside the rendered grid.  ±1 padding
  //    keeps every plotted cell off the visible edge.
  const allPositions: LatticePos[] = [];
  for (const cp of chordPlots) {
    allPositions.push(...cp.walkedTones, ...cp.canonicalTones);
  }
  const aValues = allPositions.map(getA);
  const bValues = allPositions.map(getB);
  const minA = Math.min(0, ...aValues) - 1;
  const maxA = Math.max(0, ...aValues) + 1;
  const minB = Math.min(0, ...bValues) - 1;
  const maxB = Math.max(0, ...bValues) + 1;
  const cols = maxA - minA + 1;
  const rows = maxB - minB + 1;

  // Cell sizing — generous so chord labels fit comfortably.  SVG uses
  // viewBox + width/height=100% so it scales to the container.
  const cellW = 96;
  const cellH = 64;
  const padding = 32;
  const width = cols * cellW + padding * 2;
  const height = rows * cellH + padding * 2;

  const xOf = (a: number) => padding + (a - minA) * cellW + cellW / 2;
  // Y inverted: +5-axis (major third up) appears HIGHER on screen,
  // matching standard Tonnetz convention.
  const yOf = (b: number) => padding + (maxB - b) * cellH + cellH / 2;

  // 3. Index every walked-cell across the whole progression so the
  //    background grid can colour any cell that gets touched.
  const touchedCells = new Map<string, { firstChordIdx: number; isActive: boolean }>();
  chordPlots.forEach((cp, ci) => {
    for (const t of cp.walkedTones) {
      const key = `${getA(t)},${getB(t)}`;
      const existing = touchedCells.get(key);
      const isActive = ci === currentIdx;
      if (!existing) {
        touchedCells.set(key, { firstChordIdx: ci, isActive });
      } else if (isActive) {
        existing.isActive = true;
      }
    }
  });

  // Active chord's tone set (for the prominent live highlight).
  const activeWalked = currentIdx >= 0 && currentIdx < chordPlots.length
    ? chordPlots[currentIdx].walkedTones
    : [];
  const activeCanonical = currentIdx >= 0 && currentIdx < chordPlots.length
    ? chordPlots[currentIdx].canonicalTones
    : [];

  // Tempering summary: count distinct EDO steps in the visible window
  // vs total cells.  High collapse ratio = the EDO tempers a lot of
  // commas in this region (12-EDO swallows 81/80 + 531441/524288 etc.,
  // so cells that differ by those vectors land on the same step).
  // Low collapse = the EDO preserves most JI distinctions (41/53 stay
  // mostly bijective in small lattice windows).
  const totalCells = rows * cols;
  const distinctSteps = new Set<number>();
  for (let aa = minA; aa <= maxA; aa++) {
    for (let bb = minB; bb <= maxB; bb++) {
      distinctSteps.add(edoStepAt(aa, bb, edo));
    }
  }
  const collapseRatio = totalCells > 0 ? distinctSteps.size / totalCells : 1;
  const temperingNote = collapseRatio < 0.5
    ? `Heavy tempering — many lattice cells collapse onto the same pitch class (commas vanish).`
    : collapseRatio < 0.85
      ? `Moderate tempering — some commas collapse, others survive.`
      : `Distinctions preserved — most lattice cells map to different pitch classes.`;

  return (
    <div className="flex flex-col gap-2 h-full" style={{ minHeight: 0 }}>
      <div className="flex items-baseline gap-3 flex-wrap text-[10px]">
        <span className="font-mono font-bold" style={{ color: accent }}>
          {edo}-EDO LATTICE
        </span>
        <span className="text-[#999]">
          {distinctSteps.size}/{totalCells} distinct pitches in view
        </span>
        <span className="text-[#666] italic">{temperingNote}</span>
        <span className="text-[#888] ml-auto">
          <span className="font-mono" style={{ color: "#e0c860" }}>┄┄</span>
          {" "}preserved comma{" · "}
          <span className="font-mono" style={{ color: "#5cd0e0" }}>≡</span>
          {" "}vanishing comma
        </span>
      </div>
      <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      style={{ background: "#0a0a0a", display: "block" }}
    >
      <defs>
        <marker id="ctl-arrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={accent} />
        </marker>
        <marker id="ctl-arrow-active" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#fff" />
        </marker>
      </defs>

      {/* Background grid — every (a, b) cell in the bounding box gets a
          tinted background by its EDO step so cells the EDO tempers
          together share a hue.  The cell's primary label is its EDO
          step (e.g. "0\\41"); the JI ratio is shown smaller below for
          reference.  Origin cells and trace-touched cells get brighter
          treatment. */}
      {Array.from({ length: rows }, (_, ri) => {
        const b = maxB - ri;
        return Array.from({ length: cols }, (_, ci) => {
          const a = minA + ci;
          const key = `${a},${b}`;
          const touched = touchedCells.get(key);
          const isOrigin = a === 0 && b === 0;
          const x = xOf(a);
          const y = yOf(b);
          const { ratio } = latticeRatioAt(a, b);
          const step = edoStepAt(a, b, edo);
          const fill = fillForStep(step, edo, { active: !!touched?.isActive, touched: !!touched });
          const stroke = strokeForStep(step, edo, { active: !!touched?.isActive, touched: !!touched, isOrigin });
          return (
            <g key={key}>
              <rect x={x - cellW / 2 + 3} y={y - cellH / 2 + 3}
                width={cellW - 6} height={cellH - 6}
                rx={6} fill={fill} stroke={stroke} strokeWidth={1} />
              {/* Primary label: EDO step.  Larger + brighter so the user
                  reads the tempered pitch first, ratio second. */}
              <text x={x} y={y - 6} textAnchor="middle"
                fill={touched ? "#ffffff" : "#444"}
                fontSize={13} fontWeight={700} fontFamily="monospace">
                {step}\{edo}
              </text>
              {/* Secondary label: JI ratio. */}
              <text x={x} y={y + 10} textAnchor="middle"
                fill={touched ? "#aaaaaa" : "#2a2a2a"}
                fontSize={10} fontFamily="monospace">
                {ratio}
              </text>
            </g>
          );
        });
      })}

      {/* Path arrows connecting each chord-root step.  Sequential walk
          highlights the comma pump as a closed-or-open loop on the
          lattice.  The segment leading INTO the active chord is drawn
          in white so the user sees where the live cursor just moved
          from. */}
      {walkedRoots.slice(0, -1).map((from, i) => {
        const to = walkedRoots[i + 1];
        const x1 = xOf(getA(from));
        const y1 = yOf(getB(from));
        const x2 = xOf(getA(to));
        const y2 = yOf(getB(to));
        if (x1 === x2 && y1 === y2) return null;
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        const back = 28;
        const ux = dx / len, uy = dy / len;
        const sx = x1 + ux * back, sy = y1 + uy * back;
        const ex = x2 - ux * back, ey = y2 - uy * back;
        const isActive = currentIdx === i + 1;
        return (
          <line key={`arc-${i}`}
            x1={sx} y1={sy} x2={ex} y2={ey}
            stroke={isActive ? "#ffffff" : accent}
            strokeWidth={isActive ? 2.6 : 1.6}
            strokeOpacity={isActive ? 1 : 0.65}
            markerEnd={isActive ? "url(#ctl-arrow-active)" : "url(#ctl-arrow)"} />
        );
      })}

      {/* Comma-compensation edges — DOTTED lines from each canonical
          chord-tone position to its walked counterpart.  Only drawn
          for the active chord (otherwise the picture gets cluttered).
          When the EDO TEMPERS the comma (canonical and walked map to
          the same EDO step), the edge is drawn cyan with an "≡"
          symbol — the visual signature of "this comma vanishes here,
          you can't actually hear the drift in this tuning system".
          When the EDO preserves the comma, edge is gold + length
          encodes magnitude. */}
      {activeWalked.map((walked, voiceIdx) => {
        const canonical = activeCanonical[voiceIdx];
        if (!canonical) return null;
        const wa = getA(walked), wb = getB(walked);
        const ca = getA(canonical), cb = getB(canonical);
        if (wa === ca && wb === cb) return null;
        const walkedStep = edoStepAt(wa, wb, edo);
        const canonicalStep = edoStepAt(ca, cb, edo);
        const commaVanishes = walkedStep === canonicalStep;
        const edgeColor = commaVanishes ? "#5cd0e0" : "#e0c860";
        const x1 = xOf(ca), y1 = yOf(cb);
        const x2 = xOf(wa), y2 = yOf(wb);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        return (
          <g key={`comma-${voiceIdx}`}>
            <line x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={edgeColor}
              strokeWidth={1.5}
              strokeDasharray="3 4"
              strokeOpacity={0.85} />
            <circle cx={x1} cy={y1} r={cellW / 2 - 5}
              fill="none" stroke={edgeColor} strokeWidth={1}
              strokeDasharray="2 3" strokeOpacity={0.55} />
            {commaVanishes && (
              <g>
                <rect
                  x={mx - 8} y={my - 7}
                  width={16} height={14}
                  rx={3}
                  fill="#0a1820"
                  stroke={edgeColor}
                  strokeWidth={1} />
                <text x={mx} y={my + 3} textAnchor="middle"
                  fontSize={10} fontWeight={700}
                  fill={edgeColor} fontFamily="monospace">
                  ≡
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Active chord's walked tones — bold ring + pulse-coloured fill
          on each lattice cell the chord lands on.  Drawn after the
          background grid so they sit on top. */}
      {activeWalked.map((tone, i) => {
        const x = xOf(getA(tone));
        const y = yOf(getB(tone));
        return (
          <rect key={`active-${i}`}
            x={x - cellW / 2 + 3} y={y - cellH / 2 + 3}
            width={cellW - 6} height={cellH - 6}
            rx={6}
            fill="none"
            stroke="#ffffff"
            strokeWidth={2.5}
            style={{ filter: `drop-shadow(0 0 6px ${accent})` }} />
        );
      })}

      {/* Chord-label badges placed on each walked tone, showing the
          Roman numeral for orientation.  Only the ROOT of each chord
          gets a numeral badge to avoid label spam (3rd / 5th / 7th
          can be inferred from their lattice cell). */}
      {chordPlots.map((cp, i) => {
        const root = cp.walkedTones[0];
        const x = xOf(getA(root));
        const y = yOf(getB(root));
        const isActive = i === currentIdx;
        const label = stripChordLabel(progression[i]);
        return (
          <g key={`badge-${i}`}>
            <rect
              x={x - 18}
              y={y + 8}
              width={36}
              height={14}
              rx={3}
              fill={isActive ? "#ffffff" : "#0a0a0a"}
              stroke={isActive ? accent : "#555"}
              strokeWidth={1}
            />
            <text
              x={x}
              y={y + 18}
              textAnchor="middle"
              fontSize={10}
              fontWeight={700}
              fontFamily="monospace"
              fill={isActive ? "#000" : "#ccc"}
            >
              [{i + 1}] {label}
            </text>
          </g>
        );
      })}

      {/* Axis labels along the edges. */}
      <text x={width / 2} y={16} textAnchor="middle" fill="#666" fontSize={10} fontFamily="monospace">
        3-axis (perfect fifth, 3:2) →
      </text>
      <text x={14} y={height / 2} textAnchor="middle" fill="#666" fontSize={10} fontFamily="monospace"
        transform={`rotate(-90 14 ${height / 2})`}>
        5-axis (major third, 5:4) →
      </text>
      </svg>
    </div>
  );
}
