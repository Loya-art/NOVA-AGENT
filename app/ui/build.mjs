// Build script for the TUI bundle. Run:  node build.mjs
// Reproduces the v0.1.0 esbuild setup (ESM + createRequire shim +
// react-devtools stub). Source stays in src/, artifact is bundle.mjs.
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  alias: { "react-devtools-core": path.join(here, "stub-devtools.js") },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
};

await esbuild.build({
  ...common,
  entryPoints: [path.join(here, "src", "tui.mjs")],
  outfile: path.join(here, "bundle.mjs"),
});
console.log("bundle built -> ui/bundle.mjs");

await esbuild.build({
  ...common,
  // test runs from app/ui, so ink/react resolve from app/node_modules at
  // runtime; keeping them external preserves ink's real TTY detection
  external: ["ink", "react", "react-dom", "react-reconciler"],
  // prevent the imported app.jsx from auto-rendering on process.stdin
  define: { "process.env.TUI_NO_AUTORUN": '"1"' },
  entryPoints: [path.join(here, "test-headless.src.mjs")],
  outfile: path.join(here, "test-headless.mjs"),
});
console.log("test built -> ui/test-headless.mjs");

await esbuild.build({
  ...common,
  external: ["ink", "react", "react-dom", "react-reconciler"],
  define: { "process.env.TUI_NO_AUTORUN": '"1"' },
  entryPoints: [path.join(here, "capture-live.src.mjs")],
  outfile: path.join(here, "capture-live.mjs"),
});
console.log("capture built -> ui/capture-live.mjs");
