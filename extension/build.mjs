import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

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
}
