// ── Floating side-panel wrapper ──────────────────────────────────────────
//
// Anchors a panel of arbitrary content to the top-right or bottom-right
// of the viewport, capped at 25 % of the page width so the main column
// stays readable.  Used by Tonal Audiation Pythagorean / Schismatic to
// surface the JI chord-analysis table (top-right) and the lattice viewer
// (bottom-right) without consuming the in-flow chord-pool real-estate.
//
// Pure presentation; the contained component drives all the state.  A
// collapse toggle in the header lets the user shrink the panel to its
// title bar when the picker below is competing for attention.

import React, { useState } from "react";

interface Props {
  /** Vertical anchor — top-right or bottom-right of the viewport. */
  position: "top-right" | "bottom-right";
  /** Header text shown in the title bar.  Always visible (collapsed or not). */
  title: string;
  /** Coloured accent for the title bar border / header text.  Default indigo. */
  accent?: string;
  /** Persisted-collapse-state key (localStorage) so the user's collapse
   *  preference survives reload.  Optional; defaults to per-mount state. */
  storageKey?: string;
  /** Pixel offset from the top edge — ignored for bottom-right panels.
   *  Lets callers stack multiple top-anchored panels. */
  topOffset?: number;
  /** Pixel offset from the bottom edge — ignored for top-right panels. */
  bottomOffset?: number;
  children: React.ReactNode;
}

export default function FloatingPanel({
  position,
  title,
  accent = "#5b5be6",
  storageKey,
  topOffset = 16,
  bottomOffset = 16,
  children,
}: Props) {
  // localStorage-backed collapse state when storageKey is provided.
  const [collapsed, setCollapsedRaw] = useState<boolean>(() => {
    if (typeof window === "undefined" || !storageKey) return false;
    try {
      return window.localStorage.getItem(storageKey) === "1";
    } catch { return false; }
  });
  const setCollapsed = (v: boolean) => {
    setCollapsedRaw(v);
    if (storageKey && typeof window !== "undefined") {
      try { window.localStorage.setItem(storageKey, v ? "1" : "0"); } catch { /* ignore */ }
    }
  };

  const positional: React.CSSProperties = position === "top-right"
    ? { top: topOffset, right: 16 }
    : { bottom: bottomOffset, right: 16 };

  return (
    <div
      style={{
        position: "fixed",
        zIndex: 30,
        maxWidth: "25vw",
        minWidth: 260,
        maxHeight: "45vh",
        display: "flex",
        flexDirection: "column",
        background: "#0a0a0a",
        border: `1px solid ${accent}`,
        borderRadius: 8,
        boxShadow: "0 4px 24px rgba(0, 0, 0, 0.5)",
        overflow: "hidden",
        ...positional,
      }}
    >
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          background: accent + "18",
          borderBottom: collapsed ? "none" : `1px solid ${accent}33`,
          cursor: "pointer",
          userSelect: "none",
        }}
        title={collapsed ? "Expand" : "Collapse"}
      >
        <span style={{ color: accent, fontSize: 9, fontWeight: 700, letterSpacing: 1 }}>
          {collapsed ? "▸" : "▾"}
        </span>
        <span style={{ flex: 1, color: accent, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>
          {title}
        </span>
      </div>
      {!collapsed && (
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: 10,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
