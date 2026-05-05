// ── PDF Export via Verovio (MusicXML → engraved SVG → vector PDF) ────────────
//
// Alternative to exportPdf.ts which screenshots the live VexFlow render.
// This path feeds our existing MusicXML output through Verovio (a real
// engraving engine — same family as MuseScore/LilyPond) and pipes Verovio's
// SVG through svg2pdf into a vector PDF.  Drum spacing, beam grouping, and
// percussion glyphs are handled by Verovio rather than VexFlow.
//
// Verovio ships as a ~7 MB WASM module so we lazy-import it on first use;
// it stays out of the initial bundle until the user clicks the button.

import { jsPDF } from "jspdf";
import { svg2pdf } from "svg2pdf.js";

export interface VerovioPdfSection {
  title?: string;
  musicXml: string;
}

export interface VerovioPdfOptions {
  showTitles: boolean;
}

interface ToolkitLike {
  setOptions(opts: Record<string, unknown>): void;
  loadData(data: string): boolean;
  getPageCount(): number;
  renderToSVG(page: number, options?: Record<string, unknown>): string;
}

let toolkitPromise: Promise<ToolkitLike> | null = null;

async function getToolkit(): Promise<ToolkitLike> {
  if (!toolkitPromise) {
    toolkitPromise = (async () => {
      const [{ default: createVerovioModule }, { VerovioToolkit }] = await Promise.all([
        import("verovio/wasm"),
        import("verovio/esm"),
      ]);
      const VerovioModule = await createVerovioModule();
      return new VerovioToolkit(VerovioModule) as unknown as ToolkitLike;
    })();
  }
  return toolkitPromise;
}

export async function exportToPdfViaVerovio(
  sections: VerovioPdfSection[],
  fileName: string,
  options: VerovioPdfOptions,
): Promise<void> {
  if (sections.length === 0) return;

  const toolkit = await getToolkit();

  // A4 landscape, in PDF points (1/72 in).
  const PAGE_W = 842;
  const PAGE_H = 595;
  const MARGIN = 36;

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  let firstPage = true;

  for (const section of sections) {
    // Verovio page units are 1/10 mm.  A4 landscape = 297 × 210 mm.
    // Generous margins inside the engraving so notation breathes; the
    // outer PDF margin is applied separately when we place the SVG.
    toolkit.setOptions({
      inputFrom: "musicxml",
      font: "Leipzig",
      pageWidth: 2970,
      pageHeight: 2100,
      pageMarginLeft: 100,
      pageMarginRight: 100,
      pageMarginTop: 100,
      pageMarginBottom: 100,
      scale: 40,
      adjustPageHeight: true,
      breaks: "auto",
      svgViewBox: true,
    });

    if (!toolkit.loadData(section.musicXml)) {
      console.warn("[Verovio] Failed to load MusicXML for section:", section.title);
      continue;
    }

    const pageCount = toolkit.getPageCount();
    for (let p = 1; p <= pageCount; p++) {
      if (!firstPage) doc.addPage();
      firstPage = false;

      let yCursor = MARGIN;
      if (options.showTitles && section.title && p === 1) {
        doc.setFont("Helvetica", "bold");
        doc.setFontSize(20);
        doc.text(section.title, PAGE_W / 2, yCursor + 16, { align: "center" });
        yCursor += 36;
      }

      const svgString = toolkit.renderToSVG(p);
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(svgString, "image/svg+xml");
      const svg = svgDoc.documentElement as unknown as SVGSVGElement;

      // Verovio's SVG width/height come back in mm (e.g. "297mm").  The
      // viewBox carries the unitless coordinate system svg2pdf actually
      // measures against, so prefer that for fit math.
      let naturalW = 0;
      let naturalH = 0;
      const vb = svg.getAttribute("viewBox");
      if (vb) {
        const parts = vb.trim().split(/\s+/);
        if (parts.length === 4) {
          naturalW = parseFloat(parts[2]);
          naturalH = parseFloat(parts[3]);
        }
      }
      if (!naturalW) naturalW = parseFloat(svg.getAttribute("width") ?? "0") || 800;
      if (!naturalH) naturalH = parseFloat(svg.getAttribute("height") ?? "0") || 600;

      const usableW = PAGE_W - 2 * MARGIN;
      const usableH = PAGE_H - yCursor - MARGIN;
      const scale = Math.min(usableW / naturalW, usableH / naturalH);
      const fitW = naturalW * scale;
      const fitH = naturalH * scale;
      const xCenter = (PAGE_W - fitW) / 2;

      // svg2pdf needs the SVG attached to the live DOM so it can resolve
      // any layout/measurement queries during traversal.
      const stage = document.createElement("div");
      stage.style.position = "absolute";
      stage.style.left = "-99999px";
      stage.style.top = "0";
      stage.appendChild(svg);
      document.body.appendChild(stage);
      try {
        await svg2pdf(svg, doc, {
          x: xCenter,
          y: yCursor,
          width: fitW,
          height: fitH,
        });
      } finally {
        stage.remove();
      }
    }
  }

  doc.save(fileName.endsWith(".pdf") ? fileName : `${fileName}.pdf`);
}
