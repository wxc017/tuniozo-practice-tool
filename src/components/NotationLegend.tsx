import { useState, useEffect, useRef } from "react";

/** Small "Notation" button + click-to-show legend listing the
 *  letter-code shorthand used in mode / interval names.  Per direct
 *  user direction (2026-05-05): "just have it say n = neutral S =
 *  supermajor s = subminor M = major Cm = Classic Minor etc.  keep it
 *  simple". */
export default function NotationLegend() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen(o => !o)}
        className={`px-2 py-1 text-[10px] rounded border transition-colors ${
          open
            ? "bg-[#7173e6] border-[#7173e6] text-white"
            : "bg-[#141414] border-[#2a2a2a] text-[#888] hover:text-white hover:border-[#444]"
        }`}>
        Notation
      </button>
      {open && (
        <div className="absolute left-0 mt-1 w-[280px] bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg shadow-2xl z-50 p-3">
          <ul className="text-[12px] text-[#aaa] space-y-1 leading-snug">
            <li><b className="text-white">s</b> = subminor</li>
            <li><b className="text-white">m</b> = minor</li>
            <li><b className="text-white">Cm</b> = classic minor</li>
            <li><b className="text-white">u</b> = supraminor</li>
            <li><b className="text-white">n / N</b> = neutral</li>
            <li><b className="text-white">C</b> = classic major</li>
            <li><b className="text-white">M</b> = major</li>
            <li><b className="text-white">S</b> = supermajor</li>
            <li><b className="text-white">Diatonic</b> = M2 / P4 / P5 backbone</li>
          </ul>
        </div>
      )}
    </div>
  );
}
