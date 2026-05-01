// Standalone entry: mounts LatticeView only.  Built into a single HTML
// file via vite.config.lattice.ts (which uses vite-plugin-singlefile).
import { createRoot } from "react-dom/client";
import LatticeView from "./components/LatticeView";
import "./index.css";

createRoot(document.getElementById("root")!).render(<LatticeView />);
