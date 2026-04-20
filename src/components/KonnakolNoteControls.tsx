import { useState, useRef, useEffect } from "react";
import {
  canSplitNote, type KonnakolGroup, type SubdivisionN,
  SUBDIVISION_PERMUTATIONS, type Permutation,
} from "@/lib/konnakolData";
import { renderPermutation, ROW_H, ROW_STAVE_Y } from "./KonnakolBasicPanel";

interface Props {
  groups: KonnakolGroup[];
  previewW: number;
  notePositions?: number[];
  onTie: (gi: number, ni: number) => void;
  onToggle32: (gi: number, ni: number) => void;
  onToggleRest: (gi: number, ni: number) => void;
  onSubdivReplace?: (gi: number, perm: Permutation) => void;
}

/** Format a permutation's composition as a compact label, e.g. "2+1" or "1+1+1" */
function permLabel(perm: Permutation): string {
  const notes = perm[0]?.notes ?? [];
  const slots: number[] = [];
  for (const n of notes) {
    if (n.tie) continue;
    const base = n.dur === "h" ? 8 : n.dur === "q" ? 4 : n.dur === "8" ? 2 : n.dur === "16" ? 1 : 1;
    const mult = n.dots ? 1.5 : 1;
    slots.push(Math.round(base * mult));
  }
  return slots.join("+");
}

const SB_CARD_W = 160;
const SB_CARD_H = 70;

/** Small notation preview for a single permutation in the SB popover */
function PermPreviewBtn({
  perm, subdivision, onClick,
}: {
  perm: Permutation;
  subdivision: SubdivisionN;
  onClick: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      renderPermutation(el, perm, SB_CARD_W, SB_CARD_H, 16, 6, subdivision, false);
    } catch (err) {
      console.warn("PermPreviewBtn render error:", err);
    }
  }, [perm, subdivision]);

  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "2px 6px", borderRadius: 5, cursor: "pointer",
        border: "1px solid #333", background: "#0a0a0a",
        transition: "all 60ms", width: "100%",
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.background = "#e8a0ff15";
        (e.currentTarget as HTMLElement).style.borderColor = "#e8a0ff50";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = "#0a0a0a";
        (e.currentTarget as HTMLElement).style.borderColor = "#333";
      }}
    >
      <span style={{ fontSize: 8, color: "#e8a0ff", fontWeight: 700, fontFamily: "monospace", minWidth: 30, textAlign: "right", flexShrink: 0 }}>
        {permLabel(perm)}
      </span>
      <div ref={ref} style={{ width: SB_CARD_W, height: SB_CARD_H, flexShrink: 0, overflow: "hidden" }} />
    </button>
  );
}

/**
 * Duration-weighted per-note controls (tie / 32nd / rest) that align with
 * KonnakolNotation's VexFlow-rendered notes.
 *
 * When notePositions (VexFlow X coords) are provided, buttons are placed at
 * the exact note positions. Otherwise falls back to proportional weight layout.
 *
 * If onSubdivReplace is provided, adds an "SB" button per group that opens a
 * popover showing all subdivision permutations for that group's size.
 */
export default function KonnakolNoteControls({ groups, previewW, notePositions, onTie, onToggle32, onToggleRest, onSubdivReplace }: Props) {
  const [sbOpen, setSbOpen] = useState<number | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click
  useEffect(() => {
    if (sbOpen === null) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setSbOpen(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [sbOpen]);

  // Build flat list with duration weight per note
  const entries: { gi: number; ni: number; weight: number }[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    for (let ni = 0; ni < groups[gi].notes.length; ni++) {
      const dur = groups[gi].notes[ni].duration;
      entries.push({ gi, ni, weight: dur === "32" ? 1 : 2 });
    }
  }
  if (entries.length === 0) return null;

  // Compute absolute positions
  const positions: { gi: number; ni: number; left: number; w: number }[] = [];

  if (notePositions && notePositions.length === entries.length) {
    for (let i = 0; i < entries.length; i++) {
      const x = notePositions[i];
      const prevX = i > 0 ? notePositions[i - 1] : x - 20;
      const nextX = i < entries.length - 1 ? notePositions[i + 1] : Math.min(x + 30, previewW - 5);
      const left = Math.max(0, (prevX + x) / 2);
      const right = Math.min(previewW, (x + nextX) / 2);
      positions.push({ gi: entries[i].gi, ni: entries[i].ni, left, w: Math.max(right - left, 14) });
    }
  } else {
    const PAD = 40;
    const usableW = previewW - PAD * 2;
    const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
    let x = PAD;
    for (const entry of entries) {
      const w = totalWeight > 0 ? (entry.weight / totalWeight) * usableW : usableW / entries.length;
      positions.push({ gi: entry.gi, ni: entry.ni, left: x, w });
      x += w;
    }
  }

  // Build group start positions for SB buttons
  const groupStarts: { gi: number; left: number; right: number; size: number }[] = [];
  if (onSubdivReplace) {
    let noteIdx = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const noteCount = groups[gi].notes.length;
      if (noteIdx < positions.length) {
        const startLeft = positions[noteIdx].left;
        const endIdx = Math.min(noteIdx + noteCount - 1, positions.length - 1);
        const endRight = positions[endIdx].left + positions[endIdx].w;
        groupStarts.push({ gi, left: startLeft, right: endRight, size: groups[gi].subdivision });
      }
      noteIdx += noteCount;
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* Per-note controls: tie / 32nd / rest */}
      <div style={{ position: "relative", width: previewW, height: 58 }}>
        {positions.map((np, idx) => {
          const n = groups[np.gi].notes[np.ni];
          const isFirst = np.gi === 0 && np.ni === 0;
          const hasTie = n.noteType === "tie" || !!n.isTieStart;
          const isRest = n.noteType === "rest";
          const showTie = np.ni === 0 && !isFirst;
          const btnW = Math.max(Math.min(np.w - 4, 54), 14);
          const btnH = 16;
          const btnStyle = {
            width: btnW, maxWidth: "100%", height: btnH,
            borderRadius: 3, fontSize: 7, fontWeight: 700 as const,
            display: "block", margin: "0 auto",
          };
          return (
            <div key={idx} style={{
              position: "absolute", left: np.left, width: np.w, top: 0, bottom: 0,
              display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 1,
              padding: "1px 0",
            }}>
              {showTie ? (
                <button onClick={() => onTie(np.gi, np.ni)} title="Tie"
                  style={{ ...btnStyle, cursor: "pointer",
                    border: `1px solid ${hasTie ? "#c8aa50" : "#c8aa5030"}`,
                    background: hasTie ? "#c8aa5020" : "#c8aa5008",
                    color: hasTie ? "#c8aa50" : "#c8aa5040" }}>tie</button>
              ) : <div style={{ height: btnH }} />}
              {(() => {
                const isSplit = n.duration === "32";
                const canToggle = isSplit || canSplitNote(n);
                return (
                  <button onClick={() => canToggle && onToggle32(np.gi, np.ni)} title={isSplit ? "Merge" : "Split"}
                    style={{ ...btnStyle, cursor: canToggle ? "pointer" : "default",
                      border: `1px solid ${isSplit ? "#9999ee" : canToggle ? "#9999ee60" : "#9999ee30"}`,
                      background: isSplit ? "#9999ee30" : canToggle ? "#9999ee08" : "#9999ee05",
                      color: isSplit ? "#9999ee" : canToggle ? "#9999ee70" : "#9999ee40" }}>32nd</button>
                );
              })()}
              <button onClick={() => !isFirst && onToggleRest(np.gi, np.ni)} title="Rest"
                style={{ ...btnStyle, cursor: isFirst ? "default" : "pointer",
                  border: `1px solid ${isRest ? "#e06060" : "#e0606030"}`,
                  background: isRest ? "#e0606020" : "#e0606008",
                  color: isRest ? "#e06060" : "#e0606040",
                  opacity: isFirst ? 0.25 : 1 }}>rest</button>
            </div>
          );
        })}
      </div>

      {/* SB (subdivision replace) buttons — one per group */}
      {onSubdivReplace && groupStarts.length > 0 && (
        <div style={{ position: "relative", width: previewW, height: 22 }}>
          {groupStarts.map(({ gi, left, right, size }) => {
            const validSizes: SubdivisionN[] = [3, 4, 5, 6, 7, 8];
            if (!validSizes.includes(size as SubdivisionN)) return null;
            const perms = SUBDIVISION_PERMUTATIONS[size as SubdivisionN];
            if (!perms || perms.length <= 1) return null;
            const centerX = (left + right) / 2;
            const isOpen = sbOpen === gi;
            return (
              <div key={gi} style={{ position: "absolute", left: centerX - 12, width: 24 }}>
                <button
                  onClick={() => setSbOpen(isOpen ? null : gi)}
                  title={`Replace subdivision for group ${gi + 1} (${size} pulses)`}
                  style={{
                    width: 24, height: 18, borderRadius: 3, fontSize: 8, fontWeight: 700,
                    fontFamily: "monospace",
                    border: `1.5px solid ${isOpen ? "#e8a0ff" : "#e8a0ff40"}`,
                    background: isOpen ? "#e8a0ff25" : "#e8a0ff08",
                    color: isOpen ? "#e8a0ff" : "#e8a0ff60",
                    cursor: "pointer",
                    transition: "all 80ms",
                  }}>
                  SB
                </button>
                {/* Popover with notation previews — lays out cards in a wrapping
                    grid so every subdivision is visible without scroll. */}
                {isOpen && (
                  <div
                    ref={popoverRef}
                    style={{
                      position: "absolute",
                      top: 22,
                      left: "50%",
                      transform: "translateX(-50%)",
                      zIndex: 100,
                      background: "#1a1a1a",
                      border: "1.5px solid #e8a0ff50",
                      borderRadius: 8,
                      padding: 10,
                      width: Math.min(previewW, (SB_CARD_W + 6) * 4 + 20),
                      boxShadow: "0 4px 20px rgba(0,0,0,0.7)",
                    }}>
                    <div style={{ fontSize: 9, color: "#e8a0ff", fontWeight: 700, marginBottom: 6, letterSpacing: 0.5 }}>
                      SUBDIVISIONS IN {size}
                    </div>
                    <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {perms.map((perm, pi) => (
                        <PermPreviewBtn
                          key={pi}
                          perm={perm}
                          subdivision={size as SubdivisionN}
                          onClick={() => {
                            onSubdivReplace!(gi, perm);
                            setSbOpen(null);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
