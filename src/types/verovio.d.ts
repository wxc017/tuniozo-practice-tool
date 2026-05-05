// Minimal type surface for the verovio (WASM) package.  Verovio ships no
// .d.ts of its own; we only need the few methods the PDF exporter calls.

declare module "verovio/wasm" {
  const createVerovioModule: (config?: Record<string, unknown>) => Promise<unknown>;
  export default createVerovioModule;
}

declare module "verovio/esm" {
  export class VerovioToolkit {
    constructor(module: unknown);
    setOptions(opts: Record<string, unknown>): void;
    loadData(data: string): boolean;
    getPageCount(): number;
    renderToSVG(page: number, options?: Record<string, unknown>): string;
    destroy(): void;
  }
}
