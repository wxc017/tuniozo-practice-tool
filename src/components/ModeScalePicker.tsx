import { PATTERN_SCALE_FAMILIES } from "@/lib/musicTheory";

interface Props {
  scaleFam: string;
  modeName: string;
  onChange: (scaleFam: string, modeName: string) => void;
}

const FAMILY_GROUPS: { key: string; label: string; color: string }[] = [
  { key: "Major Family",            label: "MAJOR",            color: "#6a9aca" },
  { key: "Harmonic Minor Family",   label: "HARMONIC MINOR",   color: "#c09050" },
  { key: "Melodic Minor Family",    label: "MELODIC MINOR",    color: "#c06090" },
  // Septimal / neutral diatonic families (31-EDO).  The 7 modes per family
  // are mechanical rotations of the parent — they aren't Greek-mode shapes
  // with a sub/neu/sup prefix, so we label them numerically.
  { key: "Subminor Diatonic Family",   label: "SUBMINOR DIATONIC",   color: "#7aaa6a" },
  { key: "Neutral Diatonic Family",    label: "NEUTRAL DIATONIC",    color: "#9a66c0" },
  { key: "Supermajor Diatonic Family", label: "SUPERMAJOR DIATONIC", color: "#cc6a8a" },
  { key: "Subharmonic Diatonic Family", label: "SUBHARMONIC DIATONIC M7",color: "#4a9ac7" },
];

export default function ModeScalePicker({ scaleFam, modeName, onChange }: Props) {
  return (
    <div className="bg-[#0e0e0e] border border-[#1a1a1a] rounded p-2 space-y-2">
      <p className="text-xs text-[#888] font-medium">MODE</p>
      {FAMILY_GROUPS.map(group => {
        const modes = PATTERN_SCALE_FAMILIES[group.key] ?? [];
        return (
          <div key={group.key}>
            <p className="text-[9px] mb-1 font-medium tracking-wider"
               style={{ color: group.color }}>{group.label}</p>
            <div className="flex flex-wrap gap-1">
              {modes.map(mode => {
                const active = scaleFam === group.key && modeName === mode;
                return (
                  <button key={mode} onClick={() => onChange(group.key, mode)}
                    className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                      active ? "text-white" : "bg-[#111] border-[#2a2a2a] text-[#666] hover:text-[#aaa]"
                    }`}
                    style={active ? { backgroundColor: group.color + "30", borderColor: group.color, color: group.color } : {}}>
                    {mode}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
