// Standalone build config: produces ONE HTML file containing the
// Harmonic Lattice viewer with all JS/CSS inlined.  Run with:
//   npx vite build --config vite.config.lattice.ts
// Output: dist/lattice/index.html
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "path";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/lattice"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(import.meta.dirname, "index.lattice.html"),
    },
    // Bigger inline budget — the lattice bundles Three.js + React Three
    // Fiber + the lattice/tonnetz engines, so the bundle is several MB.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
  },
});
