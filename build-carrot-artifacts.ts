/**
 * Build first-party carrot artifacts from the source tree and optionally upload
 * them to R2.
 *
 * Usage:
 *   bun build-carrot-artifacts.ts
 *   bun build-carrot-artifacts.ts --upload staging
 *   bun build-carrot-artifacts.ts --upload prod
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const carrotsRoot = resolve(import.meta.dirname);
const earsRoot = resolve(carrotsRoot, "bunny", "ears");
const carrotBuilderPath = join(earsRoot, "src", "bun", "carrotBuilder.ts");
const sdkBunModule = join(earsRoot, "src", "carrot-runtime", "bun.ts");
const sdkViewModule = join(earsRoot, "src", "carrot-runtime", "view.ts");
const carrotNames = ["pty", "fs", "git", "search", "tsserver", "biome", "llama"] as const;
const outputRoot = join(carrotsRoot, "artifacts");

type BuiltCarrot = {
  id: string;
  name: string;
  version: string;
  description: string;
  mode: string;
  localPath: string;
  r2Key: string;
  size: number;
};

function ensureSourceTree() {
  if (!existsSync(carrotBuilderPath)) {
    throw new Error(`Missing Bunny Ears carrotBuilder at ${carrotBuilderPath}`);
  }
  if (!existsSync(sdkBunModule) || !existsSync(sdkViewModule)) {
    throw new Error("Missing Bunny Ears carrot runtime source files.");
  }
}

function ensureDependencies(sourceDir: string) {
  if (!existsSync(join(sourceDir, "node_modules"))) {
    console.log(`  Installing deps for ${basename(sourceDir)}...`);
    execSync("bun install", { cwd: sourceDir, stdio: "inherit" });
  }
}

async function buildCarrot(sourceDir: string, outDir: string) {
  ensureDependencies(sourceDir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const buildScript = `
    const { buildCarrotSource } = await import(${JSON.stringify(carrotBuilderPath)});
    await buildCarrotSource(${JSON.stringify(sourceDir)}, ${JSON.stringify(outDir)});
  `;

  execSync(
    `BUNNY_EARS_SDK_BUN_MODULE=${JSON.stringify(sdkBunModule)} BUNNY_EARS_SDK_VIEW_MODULE=${JSON.stringify(sdkViewModule)} bun -e ${JSON.stringify(buildScript)}`,
    {
      cwd: sourceDir,
      stdio: "inherit",
    },
  );
}

function compressCarrot(builtDir: string, outputPath: string) {
  execSync(`tar -C "${builtDir}" -cf - . | zstd -o "${outputPath}"`, {
    stdio: "pipe",
  });
}

async function main() {
  const uploadTarget = process.argv.includes("--upload")
    ? process.argv[process.argv.indexOf("--upload") + 1]
    : null;

  ensureSourceTree();
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  const built: BuiltCarrot[] = [];

  for (const carrotName of carrotNames) {
    const sourceDir = join(carrotsRoot, carrotName);
    const buildDir = join(outputRoot, "build", carrotName);

    console.log(`Building ${carrotName}...`);
    try {
      await buildCarrot(sourceDir, buildDir);
      const manifest = JSON.parse(
        readFileSync(join(buildDir, "carrot.json"), "utf8"),
      ) as {
        id: string;
        name: string;
        version: string;
        description?: string;
        mode?: string;
      };

      const artifactName = `${manifest.id}-${manifest.version}.tar.zst`;
      const shortName = manifest.id.replace("bunny.", "");
      const carrotOutDir = join(outputRoot, manifest.id);
      const artifactPath = join(carrotOutDir, artifactName);
      const r2Key = `bunny/carrots/${shortName}/${artifactName}`;

      mkdirSync(carrotOutDir, { recursive: true });
      compressCarrot(buildDir, artifactPath);

      const size = Bun.file(artifactPath).size;
      console.log(`  Done: ${(size / 1024).toFixed(0)} KB → ${r2Key}`);

      built.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description || "",
        mode: manifest.mode || "background",
        localPath: artifactPath,
        r2Key,
        size,
      });
    } catch (error) {
      console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  rmSync(join(outputRoot, "build"), { recursive: true, force: true });

  console.log(`\nBuilt ${built.length}/${carrotNames.length} carrots.`);

  if (!uploadTarget) {
    return;
  }

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

  const apiBase = uploadTarget === "prod"
    ? "https://api.electrobunny.ai"
    : "https://staging-api.electrobunny.ai";

  const apiToken = process.env.BUNNY_CLOUD_API_TOKEN;
  if (!apiToken) {
    console.log("\nSkipping API registration (set BUNNY_CLOUD_API_TOKEN to enable).");
    return;
  }

  console.log(`\nRegistering carrots with API at ${apiBase}...`);
  for (const entry of built) {
    try {
      const response = await fetch(`${apiBase}/v1/carrots/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
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
      if (response.ok) {
        console.log(`  Registered ${entry.id}`);
      } else {
        console.error(`  Failed to register ${entry.id}: ${response.status} ${await response.text()}`);
      }
    } catch (error) {
      console.error(`  Failed to register ${entry.id}: ${error}`);
    }
  }
}

main().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
