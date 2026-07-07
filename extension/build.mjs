import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { zipDir } from "../scripts/zip-dir.mjs";

// The dashboard's Configuración page serves this for download, so every extension
// build refreshes it — the zip is never stale relative to the shipped code.
const ZIP_OUT = "../web/public/minutix-extension.zip";

const entries = {
  background: "src/background.ts",
  offscreen: "src/offscreen.ts",
  content: "src/content.ts",
  popup: "src/popup.ts",
  permission: "src/permission.ts",
};

const opts = {
  entryPoints: entries,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  define: { global: "globalThis" },
  outdir: "dist",
  sourcemap: true,
  logLevel: "info",
};

mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
} else {
  await build(opts);
  const { files } = zipDir("dist", ZIP_OUT, { exclude: /\.map$/ });
  console.log(`packaged ${files} files -> ${ZIP_OUT}`);
}
