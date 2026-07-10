import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { zipDir } from "../scripts/zip-dir.mjs";

// The dashboard's Configuración page serves this for download, so every extension
// build refreshes it — the zip is never stale relative to the shipped code.
const ZIP_OUT = "../web/public/minutix-extension.zip";

const entries = {
  background: "src/background.ts",
  content: "src/content.ts",
  popup: "src/popup.tsx",
};

const opts = {
  entryPoints: entries,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  jsx: "automatic",
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  outdir: "dist",
  sourcemap: true,
  logLevel: "info",
};

// Tailwind v4 compiles the popup stylesheet from its own tokens (mirrors the web
// dashboard). Runs after cpSync so its output isn't clobbered by public/.
function buildCss(watch) {
  const args = [
    "@tailwindcss/cli",
    "-i",
    "src/styles/globals.css",
    "-o",
    "dist/popup.css",
    "--minify",
  ];
  if (watch) {
    execFileSync("npx", [...args, "--watch"], { stdio: "inherit" });
  } else {
    execFileSync("npx", args, { stdio: "inherit" });
  }
}

mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  buildCss(true); // blocks, watching CSS
} else {
  await build(opts);
  buildCss(false);
  const { files } = zipDir("dist", ZIP_OUT, { exclude: /\.map$/ });
  console.log(`packaged ${files} files -> ${ZIP_OUT}`);
}
