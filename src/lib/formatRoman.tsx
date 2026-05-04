import React from "react";
import { formatHalfAccidentals } from "./edoData";

const SUPER_CHARS = new Set(["°", "ø", "+"]);
const SPLIT_RE = /([°ø+])/;

/**
 * Renders a roman numeral label with chord-type symbols (°, ø, +) as superscript.
 * Handles compound labels like "iiø/V", "vii°/X", "V/vi", "bIII+", "#iv°".
 * Also applies half-accidental glyph formatting so "##" / "bb" render as
 * the proper half-sharp (𝄲) / half-flat (𝄳) Unicode characters.
 *
 * Xen tonality chord labels carry a space-delimited quality suffix
 * (e.g. "iii s3", "I s3 N7").  Anything after the first space is rendered
 * inside a single <sup> so the full suffix appears as superscript.
 */
export function formatRomanNumeral(label: string): React.ReactNode {
  label = formatHalfAccidentals(label);

  const spaceIdx = label.indexOf(" ");
  let head = label;
  let suffixSup: React.ReactNode = null;
  if (spaceIdx >= 0) {
    head = label.slice(0, spaceIdx);
    const suffix = label.slice(spaceIdx + 1);
    suffixSup = (
      <sup style={{ fontSize: "0.7em", verticalAlign: "super", lineHeight: 0 }}>{suffix}</sup>
    );
  }

  let body: React.ReactNode;
  if (!SPLIT_RE.test(head)) {
    body = head;
  } else {
    const parts = head.split("/");
    const result: React.ReactNode[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) result.push("/");
      result.push(formatSingleRoman(parts[i], i));
    }
    body = <>{result}</>;
  }

  if (suffixSup === null) return body;
  return <>{body}{suffixSup}</>;
}

/**
 * Variant that prepends a short family abbreviation as superscript so
 * 41/53-EDO chord labels carry their JI limit family inline (e.g.
 * "ᵀʳⁱI" for a Tridecimal Major tonic, "ᴴᵉᵖM7" for a Heptadecimal M7).
 * Without the prefix, "I" from a Tridecimal scale and "I" from a
 * Heptadecimal scale render identically — the user has no way to
 * tell them apart in the chord pool.  Pass `null` to skip the prefix
 * (12-EDO and other non-JI contexts).
 */
export function formatRomanNumeralWithFamily(label: string, familyPrefix: string | null): React.ReactNode {
  const body = formatRomanNumeral(label);
  if (!familyPrefix) return body;
  return (
    <>
      <sup style={{ fontSize: "0.6em", verticalAlign: "super", lineHeight: 0, marginRight: 1, opacity: 0.85 }}>{familyPrefix}</sup>
      {body}
    </>
  );
}

function formatSingleRoman(part: string, key: number): React.ReactNode {
  const segments = part.split(SPLIT_RE);
  if (segments.length === 1) return part;

  return (
    <span key={key}>
      {segments.map((seg, i) =>
        SUPER_CHARS.has(seg)
          ? <sup key={i} style={{ fontSize: "0.7em", verticalAlign: "super", lineHeight: 0 }}>{seg}</sup>
          : seg
      )}
    </span>
  );
}
