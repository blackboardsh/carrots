/**
 * Build foundation carrot artifacts and optionally upload to R2.
 *
 * Usage:
 *   bun scripts/build-carrot-artifacts.ts              # build only
 *   bun scripts/build-carrot-artifacts.ts --upload staging  # build + upload to staging
 *   bun scripts/build-carrot-artifacts.ts --upload prod     # build + upload to prod
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const carrotsRoot = resolve(import.meta.dirname);
const earsRoot = resolve(carrotsRoot, "..", "electrobun", "bunny", "ears");
const foundationCarrotNames = ["pty", "git", "search", "tsserver", "biome", "llama"];
const outputRoot = join(carrotsRoot, "artifacts");

function findSdkPaths() {
  const earsBuild = join(earsRoot, "build");
  const sdkBun = execSync(`find "${earsBuild}" -name "bun.ts" -path "*/carrot-runtime/*" 2>/dev/null | head -1`, { encoding: "utf8" }).trim();
  const sdkView = execSync(`find "${earsBuild}" -name "view.js" -path "*/carrot-sdk-view/*" 2>/dev/null | head -1`, { encoding: "utf8" }).trim();
  if (!sdkBun || !sdkView) throw new Error("Could not find SDK paths. Build bunny/ears first.");
  return { sdkBun, sdkView };
}

async function buildCarrot(sourceDir: string, outDir: string, sdkBun: string, sdkView: string) {
  if (!existsSync(join(sourceDir, "node_modules"))) {
    console.log(`  Installing deps for ${basename(sourceDir)}...`);
    execSync("bun install", { cwd: sourceDir, stdio: "pipe" });
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const buildScript = `
    const { buildCarrotSource } = await import('${earsRoot}/src/bun/carrotBuilder.ts');
    await buildCarrotSource('${sourceDir}', '${outDir}');
  `;
  execSync(`BUNNY_EARS_SDK_BUN_MODULE="${sdkBun}" BUNNY_EARS_SDK_VIEW_MODULE="${sdkView}" bun -e "${buildScript}"`, {
    cwd: sourceDir,
    stdio: "inherit",
  });
}

function compressCarrot(builtDir: string, outputPath: string) {
  execSync(`tar -C "${builtDir}" -cf - . | zstd -o "${outputPath}"`, { stdio: "pipe" });
}

async function main() {
  const uploadTarget = process.argv.includes("--upload")
    ? process.argv[process.argv.indexOf("--upload") + 1]
    : null;

  console.log("Building carrot artifacts...");
  const { sdkBun, sdkView } = findSdkPaths();

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  const carrotDirs = foundationCarrotNames
    .filter((name) => existsSync(join(carrotsRoot, name, "carrot.json")))
    .map((name) => ({
      name,
      sourceDir: join(carrotsRoot, name),
      manifest: JSON.parse(readFileSync(join(carrotsRoot, name, "carrot.json"), "utf8")),
    }));

  console.log(`Found ${carrotDirs.length} carrots to build.\n`);

  type BuiltCarrot = { id: string; name: string; version: string; description: string; mode: string; localPath: string; r2Key: string; size: number };
  const built: BuiltCarrot[] = [];

  for (const carrot of carrotDirs) {
    const buildDir = join(outputRoot, "build", carrot.manifest.id);
    const artifactName = `${carrot.manifest.id}-${carrot.manifest.version}.tar.zst`;
    // Local output: carrot-artifacts/{id}/{artifact}
    const carrotOutDir = join(outputRoot, carrot.manifest.id);
    mkdirSync(carrotOutDir, { recursive: true });
    const artifactPath = join(carrotOutDir, artifactName);
    // R2 key: bunny/carrots/{shortName}/{artifact}
    const shortName = carrot.manifest.id.replace("bunny.", "");
    const r2Key = `bunny/carrots/${shortName}/${artifactName}`;

    console.log(`Building ${carrot.manifest.id}...`);
    try {
      await buildCarrot(carrot.sourceDir, buildDir, sdkBun, sdkView);
      console.log(`  Compressing...`);
      compressCarrot(buildDir, artifactPath);

      const size = Bun.file(artifactPath).size;
      console.log(`  Done: ${(size / 1024).toFixed(0)} KB → ${r2Key}`);

      built.push({
        id: carrot.manifest.id,
        name: carrot.manifest.name,
        version: carrot.manifest.version,
        description: carrot.manifest.description || "",
        mode: carrot.manifest.mode || "background",
        localPath: artifactPath,
        r2Key,
        size,
      });
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Clean up build dirs
  rmSync(join(outputRoot, "build"), { recursive: true, force: true });

  console.log(`\nBuilt ${built.length}/${carrotDirs.length} carrots.`);

  if (uploadTarget) {
    const bucket = uploadTarget === "prod" ? "bunny-cloud-prod" : "bunny-cloud-staging";
    console.log(`\nUploading to R2 bucket: ${bucket}`);

    for (const entry of built) {
      console.log(`  ${entry.r2Key}...`);
      execSync(
        `bunx wrangler r2 object put "${bucket}/${entry.r2Key}" --file "${entry.localPath}" --content-type "application/zstd"`,
        { stdio: "pipe" },
      );
    }
    console.log("Upload complete.");

    // Register carrots with the API
    const apiBase = uploadTarget === "prod"
      ? "https://api.electrobunny.ai"
      : "https://staging-api.electrobunny.ai";

    const apiToken = process.env.BUNNY_CLOUD_API_TOKEN;
    if (apiToken) {
      console.log(`\nRegistering carrots with API at ${apiBase}...`);
      for (const entry of built) {
        try {
          const resp = await fetch(`${apiBase}/v1/carrots/publish`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiToken}`,
            },
            body: JSON.stringify({
              id: entry.id,
              name: entry.name,
              description: entry.description,
              version: entry.version,
              mode: entry.mode,
              r2_key: entry.r2Key,
              artifact_size: entry.size,
              is_foundation: true,
            }),
          });
          if (resp.ok) {
            console.log(`  Registered ${entry.id}`);
          } else {
            console.error(`  Failed to register ${entry.id}: ${resp.status} ${await resp.text()}`);
          }
        } catch (err) {
          console.error(`  Failed to register ${entry.id}: ${err}`);
        }
      }
    } else {
      console.log("\nSkipping API registration (set BUNNY_CLOUD_API_TOKEN to enable).");
    }
  }
}

main().catch((err) => { console.error("Build failed:", err); process.exit(1); });
