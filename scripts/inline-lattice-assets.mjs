// Post-build step for the standalone Harmonic Lattice HTML.
// Reads the bundled HTML and base64-inlines C4.wav (audio sample) and
// HEJI2.otf (microtonal accidental font) so the file works fully
// standalone — no separate asset files needed.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "..", "dist", "lattice");
const htmlPath = resolve(distDir, "index.lattice.html");

const toDataURL = (path, mime) => {
  const buf = readFileSync(path);
  return `data:${mime};base64,${buf.toString("base64")}`;
};

const wav = toDataURL(resolve(distDir, "C4.wav"), "audio/wav");
const heji = toDataURL(resolve(distDir, "HEJI2.otf"), "font/otf");

let html = readFileSync(htmlPath, "utf8");

// audioEngine fetches "./C4.wav" → swap with data URL.  Only one match expected.
const beforeWav = html.length;
html = html.replace(/\.\/C4\.wav/g, wav);
const afterWav = html.length;

// CSS @font-face uses url("/HEJI2.otf") → swap with data URL.
const beforeFont = html.length;
html = html.replace(/\/HEJI2\.otf/g, heji);
const afterFont = html.length;

writeFileSync(htmlPath, html);

const fmt = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`Inlined C4.wav    (+${fmt(afterWav - beforeWav)})`);
console.log(`Inlined HEJI2.otf (+${fmt(afterFont - beforeFont)})`);
console.log(`Final HTML size:  ${fmt(html.length)}`);
