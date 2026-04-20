import { useState, useCallback, useRef } from "react";
import KonnakolBasicPanel from "./KonnakolBasicPanel";
import type { KonnakolExportData, KonnakolLogData } from "./KonnakolBasicPanel";
import KonnakolCyclesPanel from "./KonnakolCyclesPanel";
import type { CyclesExportData } from "./KonnakolCyclesPanel";
import ExportDialog from "./ExportDialog";
import type { ExportSection } from "./ExportDialog";
import PracticeLogSaveBar from "./PracticeLogSaveBar";
import { generateKonnakolXML } from "@/lib/konnakolMusicXml";
import type { KonnakolGroup } from "@/lib/konnakolData";

type SubMode = "basic" | "cycles";

const SUB_MODE_LABELS: Record<SubMode, string> = {
  basic:  "Subdivisions",
  cycles: "Cycles",
};

export default function Konnakol() {
  const [subMode, setSubMode] = useState<SubMode>("basic");
  const [showExport, setShowExport] = useState(false);

  // Export data from sub-panels
  const [basicData, setBasicData] = useState<{ groups: KonnakolGroup[]; getElement: () => HTMLElement | null }>({ groups: [], getElement: () => null });
  const [cyclesData, setCyclesData] = useState<{ groups: KonnakolGroup[]; getElement: () => HTMLElement | null }>({ groups: [], getElement: () => null });

  const handleBasicExport = useCallback((data: KonnakolExportData) => setBasicData(data), []);
  const handleCyclesExport = useCallback((data: CyclesExportData) => setCyclesData(data), []);

  // Log data from sub-panels
  const basicLogRef = useRef<{ subdivisions: KonnakolLogData | null }>({ subdivisions: null });
  const cyclesLogRef = useRef<KonnakolLogData | null>(null);
  const [logSource, setLogSource] = useState("konnakol-basic");

  const handleBasicLog = useCallback((key: "subdivisions" | "mixed", data: KonnakolLogData | null) => {
    if (key === "subdivisions") basicLogRef.current.subdivisions = data;
  }, []);
  const handleCyclesLog = useCallback((data: KonnakolLogData | null) => {
    cyclesLogRef.current = data;
  }, []);

  const exportSections: ExportSection[] = [
    {
      id: "basic",
      label: "Subdivisions",
      defaultTitle: "Solkattu — Subdivisions",
      getElement: () => basicData.getElement(),
      generateMusicXml: () => generateKonnakolXML("Solkattu — Subdivisions", basicData.groups),
    },
    {
      id: "cycles",
      label: "Cycles",
      defaultTitle: "Solkattu — Cycles",
      getElement: () => cyclesData.getElement(),
      generateMusicXml: () => generateKonnakolXML("Solkattu — Cycles", cyclesData.groups),
    },
  ];

  return (
    <div style={{ maxWidth: 1152, margin: "0 auto", padding: "16px 0", width: "100%" }}>
      {/* Sub-mode tabs + export */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, alignItems: "center" }}>
        {(["basic", "cycles"] as SubMode[]).map(m => (
          <button key={m}
            onClick={() => setSubMode(m)}
            style={{
              padding: "6px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600,
              border: `1.5px solid ${subMode === m ? "#9999ee" : "#222"}`,
              background: subMode === m ? "#9999ee22" : "#111",
              color: subMode === m ? "#9999ee" : "#555",
              cursor: "pointer", transition: "all 80ms",
            }}>
            {SUB_MODE_LABELS[m]}
          </button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <button
            onClick={() => setShowExport(true)}
            style={{
              padding: "5px 12px", borderRadius: 5, fontSize: 11, fontWeight: 700,
              border: "1px solid #3a3a7a", background: "#1e1e3a", color: "#9a9cf8",
              cursor: "pointer", letterSpacing: 0.5,
            }}
          >↓ Export</button>
          <PracticeLogSaveBar
            mode={logSource}
            label="Solkattu"
            sourceOptions={[
              { value: "konnakol-basic", label: "Subdivisions" },
              { value: "konnakol-cycles", label: "Cycles" },
            ]}
            onSourceChange={setLogSource}
            getSnapshot={() => {
              if (logSource === "konnakol-basic" && basicLogRef.current.subdivisions) {
                return basicLogRef.current.subdivisions.getSnapshot();
              }
              if (logSource === "konnakol-cycles" && cyclesLogRef.current) {
                return cyclesLogRef.current.getSnapshot();
              }
              return { preview: "No pattern generated yet", snapshot: {}, canRestore: false };
            }}
          />
        </div>
      </div>

      {/* Panel content */}
      <div style={{
        background: "#0e0e0e", border: "1px solid #1a1a1a", borderRadius: 10,
        padding: "20px 20px",
      }}>
        {subMode === "basic"  && <KonnakolBasicPanel onExportData={handleBasicExport} onLogData={handleBasicLog} />}
        {subMode === "cycles" && <KonnakolCyclesPanel onExportData={handleCyclesExport} onLogData={handleCyclesLog} />}
      </div>

      <ExportDialog
        open={showExport}
        onClose={() => setShowExport(false)}
        fileName="konnakol"
        sections={exportSections}
      />
    </div>
  );
}
