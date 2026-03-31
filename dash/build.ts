/**
 * PostBuild script for Bunny Dash.
 * Builds the custom views (Monaco editor, Solid.js, Tailwind) and copies them
 * into the carrot output directory.
 *
 * Called by electrobun build as a postBuild hook.
 * Receives ELECTROBUN_CARROT_DIR as an env var pointing to the carrot output.
 */

import { execFileSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const sourceDir = process.cwd();
const carrotDir = process.env.ELECTROBUN_CARROT_DIR;

if (!carrotDir) {
  console.error("[dash postBuild] ELECTROBUN_CARROT_DIR not set, skipping custom view builds");
  process.exit(0);
}


async function buildMonacoWorkers(lensOutDir: string) {
  const require = createRequire(import.meta.url);
  const esbuild = require("esbuild");

  await esbuild.build({
    entryPoints: [
      "monaco-editor/esm/vs/editor/editor.worker.js",
      "monaco-editor/esm/vs/language/json/json.worker.js",
      "monaco-editor/esm/vs/language/css/css.worker.js",
      "monaco-editor/esm/vs/language/html/html.worker.js",
      "monaco-editor/esm/vs/language/typescript/ts.worker.js",
    ],
    bundle: true,
    format: "iife",
    outbase: "monaco-editor/esm/",
    outdir: lensOutDir,
  });
}

async function buildLens(lensOutDir: string) {
  const require = createRequire(import.meta.url);
  const esbuild = require("esbuild");
  const MonacoEsbuildPlugin = require("esbuild-monaco-editor-plugin");
  const { solidPlugin } = require("esbuild-plugin-solid");

  const entry = join(sourceDir, "src", "renderers", "lens", "index.tsx");

  await esbuild.build({
    absWorkingDir: sourceDir,
    entryPoints: [entry],
    outfile: join(lensOutDir, "index.js"),
    bundle: true,
    plugins: [
      MonacoEsbuildPlugin({
        destDir: lensOutDir,
        pathPrefix: "/",
        minify: false,
        languages: ["typescript", "javascript", "html", "css", "json", "markdown"],
      }),
      solidPlugin(),
    ],
    jsxFactory: "Solid.createElement",
    jsxFragment: "Solid.Fragment",
    platform: "browser",
    format: "esm",
    external: [
      "vscode",
      "typescript",
      "vs",
      "window-wrapper",
      ...builtinModules.flatMap((m) => [m, `node:${m}`]),
    ],
    loader: {
      ".tts": "file",
      ".ttf": "file",
      ".node": "file",
    },
  });

  await buildMonacoWorkers(lensOutDir);
}

async function buildBunny(bunnyOutDir: string) {
  const require = createRequire(import.meta.url);
  const esbuild = require("esbuild");

  await esbuild.build({
    absWorkingDir: sourceDir,
    entryPoints: [join(sourceDir, "src", "renderers", "bunny", "index.ts")],
    outfile: join(bunnyOutDir, "index.js"),
    bundle: true,
    plugins: [],
    platform: "browser",
    format: "esm",
    loader: { ".png": "file" },
  });
}

function buildTailwind(lensOutDir: string) {
  const tailwindBinary = join(
    sourceDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tailwindcss.cmd" : "tailwindcss",
  );

  if (!existsSync(tailwindBinary)) {
    throw new Error(`Missing tailwindcss binary. Run 'bun install' in dash.`);
  }

  execFileSync(tailwindBinary, [
    "--content", join(sourceDir, "src", "renderers", "lens", "**", "*.tsx"),
    "-c", join(sourceDir, "src", "renderers", "tailwind.config.js"),
    "-i", join(sourceDir, "src", "renderers", "lens", "index.css"),
    "-o", join(lensOutDir, "tailwind.css"),
  ], { cwd: sourceDir, stdio: "pipe" });
}

function prepareHtmlAndAssets() {
  const lensOutDir = join(carrotDir, "lens");
  const bunnyOutDir = join(carrotDir, "bunny");
  const assetsOutDir = join(carrotDir, "assets");

  mkdirSync(lensOutDir, { recursive: true });
  mkdirSync(bunnyOutDir, { recursive: true });
  mkdirSync(assetsOutDir, { recursive: true });

  cpSync(join(sourceDir, "src", "renderers", "lens", "index.html"), join(lensOutDir, "index.html"));
  cpSync(join(sourceDir, "src", "renderers", "lens", "styles"), join(lensOutDir, "styles"), { recursive: true });
  cpSync(join(sourceDir, "src", "renderers", "bunny", "index.html"), join(bunnyOutDir, "index.html"));
  cpSync(join(sourceDir, "src", "renderers", "bunny", "index.css"), join(bunnyOutDir, "index.css"));
  cpSync(join(sourceDir, "src", "assets"), assetsOutDir, { recursive: true });
  cpSync(join(sourceDir, "src", "assets", "bunny.png"), join(bunnyOutDir, "assets", "bunny.png"), { force: true });
  cpSync(
    join(sourceDir, "node_modules", "@xterm", "xterm", "css", "xterm.css"),
    join(lensOutDir, "xterm.css"),
    { force: true },
  );
  cpSync(
    join(sourceDir, "src", "assets", "custom.editor.worker.js"),
    join(lensOutDir, "custom.editor.worker.js"),
    { force: true },
  );

  // Patch lens HTML to include dash window CSS
  const lensHtmlPath = join(lensOutDir, "index.html");
  let lensHtml = readFileSync(lensHtmlPath, "utf8");
  const cssHref = "views://lens/bunny-dash-window.css";
  if (!lensHtml.includes(cssHref)) {
    lensHtml = lensHtml.replace(
      '<link rel="stylesheet" href="views://lens/index.css" />',
      '<link rel="stylesheet" href="views://lens/index.css" />\n    <link rel="stylesheet" href="views://lens/bunny-dash-window.css" />',
    );
  }
  writeFileSync(lensHtmlPath, lensHtml);
  writeFileSync(join(lensOutDir, "bunny-dash-window.css"), `html,
body {
  background: #1e1e1e;
  overflow: hidden;
}

body,
#app {
  min-height: 100vh;
  background: #1e1e1e;
}

#app {
  position: relative;
  overflow: hidden;
}

#app > div:first-child {
  min-height: 100vh;
  background: #1e1e1e;
  border-radius: 14px;
  overflow: hidden;
}

#workbench-container {
  background: #1e1e1e;
}`);
}

// Update carrot.json to point view at lens
function updateCarrotManifest() {
  const manifestPath = join(carrotDir, "carrot.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.view = {
      ...manifest.view,
      relativePath: "lens/index.html",
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}

async function main() {
  console.log("[dash postBuild] Building custom views into", carrotDir);

  prepareHtmlAndAssets();

  const lensOutDir = join(carrotDir, "lens");
  const bunnyOutDir = join(carrotDir, "bunny");

  buildTailwind(lensOutDir);
  await buildLens(lensOutDir);
  await buildBunny(bunnyOutDir);

  updateCarrotManifest();

  console.log("[dash postBuild] Done");
}

main().catch((err) => {
  console.error("[dash postBuild] Failed:", err);
  process.exit(1);
});
