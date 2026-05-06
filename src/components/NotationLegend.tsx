import { useState } from "react";

/** Small "Notation" button that opens a modal listing the letter-code
 *  shorthand used in mode / interval names.  Modal styling matches
 *  SettingsModal (centered overlay with backdrop) per direct user
 *  direction (2026-05-05): "it should open up like how the settings
 *  open up as well". */
export default function NotationLegend() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-2 py-1 text-[10px] rounded border bg-[#141414] border-[#2a2a2a] text-[#888] hover:text-white hover:border-[#444] transition-colors">
        Notation
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="bg-[#111] border border-[#2a2a2a] rounded-xl w-full max-w-sm shadow-2xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e1e1e]">
              <h2 className="font-semibold text-sm">Notation</h2>
              <button onClick={() => setOpen(false)} className="text-[#555] hover:text-white text-lg leading-none">✕</button>
            </div>

            {/* Content */}
            <div className="px-5 py-5 overflow-y-auto">
              <ul className="text-[13px] text-[#aaa] space-y-1.5 leading-snug">
                <li><b className="text-white">s</b> = subminor</li>
                <li><b className="text-white">m</b> = minor</li>
                <li><b className="text-white">Clm</b> = classic minor</li>
                <li><b className="text-white">u</b> = supraminor</li>
                <li><b className="text-white">n</b> = neutral</li>
                <li><b className="text-white">Cl</b> = classic major</li>
                <li><b className="text-white">M</b> = major</li>
                <li><b className="text-white">S</b> = supermajor</li>
                <li><b className="text-white">Diatonic</b> = M2 / P4 / P5 backbone</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
