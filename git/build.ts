import { builtinModules, createRequire } from "node:module";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const sourceDir = process.cwd();
const carrotDir = process.env.ELECTROBUN_CARROT_DIR;

if (!carrotDir) {
  console.error("[git postBuild] ELECTROBUN_CARROT_DIR not set, skipping");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const MonacoEsbuildPlugin = require("esbuild-monaco-editor-plugin");
const { solidPlugin } = require("esbuild-plugin-solid");

const vendorSrc = join(sourceDir, "vendor");

function makeExecutable(dir: string) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isFile()) {
      try {
        chmodSync(fullPath, 0o755);
      } catch {}
    } else if (stat.isDirectory()) {
      makeExecutable(fullPath);
    }
  }
}

async function buildMonacoWorkers(outDir: string) {
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
    outdir: outDir,
  });
}

async function buildRemoteUI(entryRelativePath: string, outDir: string, htmlRelativePath: string, needsMonaco = false) {
  mkdirSync(outDir, { recursive: true });
  cpSync(join(sourceDir, htmlRelativePath), join(outDir, "index.html"), { force: true });

  await esbuild.build({
    absWorkingDir: sourceDir,
    entryPoints: [join(sourceDir, entryRelativePath)],
    outfile: join(outDir, "index.js"),
    bundle: true,
    plugins: [
      ...(needsMonaco
        ? [
            MonacoEsbuildPlugin({
              destDir: outDir,
              pathPrefix: "./",
              minify: false,
              languages: ["typescript", "javascript", "html", "css", "json", "markdown"],
            }),
          ]
        : []),
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
      ...builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
    ],
    loader: {
      ".css": "css",
      ".node": "file",
      ".svg": "file",
      ".ttf": "file",
      ".woff": "file",
      ".woff2": "file",
    },
  });

  if (needsMonaco) {
    await buildMonacoWorkers(outDir);
  }
}

async function buildSlateUI(entryRelativePath: string, outDir: string, needsMonaco = false) {
  mkdirSync(outDir, { recursive: true });

  await esbuild.build({
    absWorkingDir: sourceDir,
    entryPoints: [join(sourceDir, entryRelativePath)],
    outfile: join(outDir, "index.js"),
    bundle: true,
    plugins: [
      ...(needsMonaco
        ? [
            MonacoEsbuildPlugin({
              destDir: outDir,
              pathPrefix: "./",
              minify: false,
              languages: ["typescript", "javascript", "html", "css", "json", "markdown"],
            }),
          ]
        : []),
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
      ...builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
    ],
    loader: {
      ".css": "css",
      ".node": "file",
      ".svg": "file",
      ".ttf": "file",
      ".woff": "file",
      ".woff2": "file",
    },
  });

  if (needsMonaco) {
    await buildMonacoWorkers(outDir);
  }

  const cssPath = join(outDir, "index.css");
  if (!existsSync(cssPath)) {
    writeFileSync(cssPath, "", "utf8");
  }
}

async function main() {
  if (!existsSync(vendorSrc)) {
    throw new Error(`Missing vendor directory at ${vendorSrc}`);
  }

  const vendorDest = join(carrotDir, "vendor");
  console.log("[git postBuild] Copying vendor binaries...");
  cpSync(vendorSrc, vendorDest, { recursive: true });
  makeExecutable(vendorDest);

  console.log("[git postBuild] Building remote UIs...");
  await buildRemoteUI(
    "src/renderers/git-slate/index.tsx",
    join(carrotDir, "remote-ui", "git-slate"),
    "src/renderers/git-slate/index.html",
    true,
  );
  await buildSlateUI(
    "src/renderers/git-slate/slate.tsx",
    join(carrotDir, "slate-ui", "git-slate"),
    true,
  );
  await buildRemoteUI(
    "src/renderers/git-settings/index.tsx",
    join(carrotDir, "remote-ui", "git-settings"),
    "src/renderers/git-settings/index.html",
    false,
  );

  console.log("[git postBuild] Done");
}

main().catch((error) => {
  console.error("[git postBuild] Failed:", error);
  process.exit(1);
});
