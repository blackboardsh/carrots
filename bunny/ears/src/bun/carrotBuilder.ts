import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CarrotManifest } from "../carrot-runtime/types";

type CarrotAuthoringConfig = {
  bunny?: {
    carrot?: {
      dependencies?: Record<string, string>;
    };
  };
};

function getSdkViewModule() {
  const override = process.env.BUNNY_EARS_SDK_VIEW_MODULE;
  if (override) {
    return isAbsolute(override) ? override : resolve(override);
  }

  const appRoot = resolve("../Resources/app");
  return join(appRoot, "views", "carrot-sdk-view", "view.js");
}

function getSdkBunModule() {
  const override = process.env.BUNNY_EARS_SDK_BUN_MODULE;
  if (override) {
    return isAbsolute(override) ? override : resolve(override);
  }

  const appRoot = resolve("../Resources/app");
  return join(appRoot, "carrot-runtime", "bun.ts");
}

function getElectrobunPlatformSuffix() {
  const osName =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform;

  return `${osName}-${process.arch}`;
}

function chooseCurrentPlatformBuildDir(platformDirs: Array<string>) {
  const platformSuffix = getElectrobunPlatformSuffix();
  const matchingDirs = platformDirs
    .filter((dir) => dir.endsWith(`-${platformSuffix}`))
    .sort((a, b) => {
      const aIsDev = a.startsWith("dev-");
      const bIsDev = b.startsWith("dev-");
      if (aIsDev !== bIsDev) {
        return aIsDev ? -1 : 1;
      }
      return a.localeCompare(b);
    });

  if (matchingDirs[0]) {
    return matchingDirs[0];
  }

  if (platformDirs.length === 1) {
    return platformDirs[0];
  }

  throw new Error(
    `No carrot build directory found for ${platformSuffix}. Found: ${platformDirs.join(", ")}`,
  );
}

function resolveLocalElectrobunPackageDir(sourceDir: string) {
  let dir = resolve(sourceDir);

  while (dir !== dirname(dir)) {
    const candidate = join(dir, "electrobun", "package", "package.json");
    if (existsSync(candidate)) {
      return join(dir, "electrobun", "package");
    }
    dir = dirname(dir);
  }

  throw new Error(
    `Unable to find local electrobun/package for carrot build starting from ${sourceDir}`,
  );
}

function getDirectorySymlinkType(): "dir" | "junction" {
  return process.platform === "win32" ? "junction" : "dir";
}

function readInstallStamp(stampPath: string) {
  if (!existsSync(stampPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(stampPath, "utf8")) as {
      packageJsonText?: string;
    };
  } catch {
    return null;
  }
}

function ensureLocalElectrobunLink(sourceDir: string, electrobunPackageDir: string) {
  const nodeModulesDir = join(sourceDir, "node_modules");
  mkdirSync(nodeModulesDir, { recursive: true });

  const targetLink = join(nodeModulesDir, "electrobun");
  rmSync(targetLink, { recursive: true, force: true });
  symlinkSync(electrobunPackageDir, targetLink, getDirectorySymlinkType());
}

function ensureCarrotPackageDependencies(
  sourceDir: string,
  electrobunPackageDir: string,
  execFileSyncNode: typeof import("node:child_process").execFileSync,
) {
  const packageJsonPath = join(sourceDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    ensureLocalElectrobunLink(sourceDir, electrobunPackageDir);
    return;
  }

  const nodeModulesDir = join(sourceDir, "node_modules");
  const stampPath = join(nodeModulesDir, ".bunny-ears-install-stamp.json");
  const packageJsonText = readFileSync(packageJsonPath, "utf8");
  const previousStamp = readInstallStamp(stampPath);
  const needsInstall =
    !existsSync(nodeModulesDir) || previousStamp?.packageJsonText !== packageJsonText;

  if (needsInstall) {
    console.log(`  Installing Bun dependencies in ${sourceDir}...`);
    try {
      const output = execFileSyncNode(process.execPath, ["install"], {
        cwd: sourceDir,
        stdio: "pipe",
        encoding: "utf8",
        env: process.env,
      });
      if (output?.trim()) {
        console.log(`  [bun install] ${output.trim()}`);
      }
    } catch (installError: any) {
      const stderr = installError.stderr?.toString() || "";
      const stdout = installError.stdout?.toString() || "";
      console.error(`  [bun install] FAILED in ${sourceDir}`);
      if (stderr) console.error(`  stderr: ${stderr.slice(0, 800)}`);
      if (stdout) console.error(`  stdout: ${stdout.slice(0, 800)}`);
      throw installError;
    }
  }

  ensureLocalElectrobunLink(sourceDir, electrobunPackageDir);
  writeFileSync(
    stampPath,
    JSON.stringify(
      {
        packageJsonText,
      },
      null,
      2,
    ),
  );
}

function resolveLocalElectrobunBuildCommand(electrobunPackageDir: string) {
  const binExt = process.platform === "win32" ? ".exe" : "";
  const compiledBinary = join(electrobunPackageDir, "bin", `electrobun${binExt}`);
  if (existsSync(compiledBinary)) {
    return {
      command: compiledBinary,
      args: ["build"],
    };
  }

  return {
    command: process.execPath,
    args: [join(electrobunPackageDir, "bin", "electrobun.cjs"), "build"],
  };
}

type CustomBuildContext = {
  sourceDir: string;
  outDir: string;
  manifest: CarrotManifest;
  sdkViewModule: string;
  sdkBunModule: string;
  defaultBuild: () => Promise<void>;
};

type CustomBuildModule = {
  default?: (context: CustomBuildContext) => Promise<void> | void;
  buildCarrot?: (context: CustomBuildContext) => Promise<void> | void;
};

function readManifest(sourceDir: string) {
  const manifestPath = join(sourceDir, "carrot.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CarrotManifest & {
      permissions?: unknown;
    };
    const { permissions: _legacyPermissions, ...normalized } = manifest;
    return normalized satisfies CarrotManifest;
  }

  // No carrot.json — will be constructed from electrobun.config.ts in buildCarrotSource
  return null;
}

async function readCarrotAuthoringConfig(sourceDir: string) {
  const configPath = join(sourceDir, "electrobun.config.ts");
  if (!existsSync(configPath)) {
    return null;
  }

  const loaded = (await import(
    `${pathToFileURL(configPath).href}?t=${Date.now()}`
  )) as { default?: CarrotAuthoringConfig } & CarrotAuthoringConfig;
  return (loaded.default ?? loaded) as CarrotAuthoringConfig;
}

function mergeCarrotConfig(manifest: CarrotManifest, config: CarrotAuthoringConfig | null) {
  const dependencyEntries = config?.bunny?.carrot?.dependencies;
  if (!dependencyEntries || Object.keys(dependencyEntries).length === 0) {
    return manifest;
  }

  for (const [dependencyId, specifier] of Object.entries(dependencyEntries)) {
    if (typeof specifier !== "string" || specifier.trim().length === 0) {
      throw new Error(
        `Invalid bunny.carrot.dependencies entry for ${dependencyId} in ${manifest.id}: expected non-empty string specifier`,
      );
    }
  }

  return {
    ...manifest,
    dependencies: {
      ...(manifest.dependencies ?? {}),
      ...dependencyEntries,
    },
  } satisfies CarrotManifest;
}

function assertBuildSuccess(
  label: string,
  result: Awaited<ReturnType<typeof Bun.build>>,
) {
  if (result.success) {
    return;
  }

  const details = result.logs
    .map((log) => log.message || log.name || JSON.stringify(log))
    .join("\n");

  throw new Error(`Failed to build ${label}${details ? `\n${details}` : ""}`);
}

function sdkAliasPlugin() {
  return {
    name: "bunny-ears-sdk-alias",
    setup(build: any) {
      build.onResolve({ filter: /^bunny-ears\/view$/ }, () => ({
        path: getSdkViewModule(),
      }));
    },
  };
}

function bunRuntimeAliasPlugin() {
  return {
    name: "bunny-ears-bun-runtime-alias",
    setup(build: any) {
      build.onResolve({ filter: /^electrobun(?:\/bun)?$/ }, () => ({
        path: getSdkBunModule(),
      }));
    },
  };
}

async function runDefaultBuild(sourceDir: string, outDir: string, manifest: CarrotManifest) {
  const webDir = join(sourceDir, "web");
  const viewEntry = join(webDir, "index.ts");
  const viewHtml = join(webDir, "index.html");
  const viewCss = join(webDir, "index.css");
  const webAssets = join(webDir, "assets");
  const workerEntry = existsSync(join(sourceDir, "worker.ts"))
    ? join(sourceDir, "worker.ts")
    : join(sourceDir, "worker.js");
  const viewsOutDir = join(outDir, "views");
  const hasView = existsSync(webDir) && existsSync(viewEntry) && existsSync(viewHtml);

  const sdkBunModule = getSdkBunModule();

  if (!existsSync(sdkBunModule)) {
    throw new Error(`Missing Bunny Ears Bun runtime bundle: ${sdkBunModule}`);
  }

  if (hasView) {
    const sdkViewModule = getSdkViewModule();
    if (!existsSync(sdkViewModule)) {
      throw new Error(`Missing Bunny Ears SDK bundle: ${sdkViewModule}`);
    }
  }

  if (!existsSync(workerEntry)) {
    throw new Error(`Missing worker entry: ${workerEntry}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Build the view if a web/ folder with index.ts + index.html exists
  if (hasView) {
    mkdirSync(viewsOutDir, { recursive: true });

    cpSync(viewHtml, join(viewsOutDir, "index.html"));
    if (existsSync(viewCss)) {
      cpSync(viewCss, join(viewsOutDir, "index.css"));
    }
    if (existsSync(webAssets)) {
      cpSync(webAssets, join(viewsOutDir, "assets"), {
        recursive: true,
        force: true,
      });
    }

    const viewBuild = await Bun.build({
      entrypoints: [viewEntry],
      outdir: viewsOutDir,
      target: "browser",
      plugins: [sdkAliasPlugin()],
    });
    assertBuildSuccess(`${manifest.name} view`, viewBuild);
  }

  const workerBuild = await Bun.build({
    entrypoints: [workerEntry],
    outdir: outDir,
    target: "bun",
    plugins: [bunRuntimeAliasPlugin()],
  });
  assertBuildSuccess(`${manifest.name} worker`, workerBuild);

  const { view: _sourceView, ...manifestWithoutView } = manifest;
  const outputManifest: CarrotManifest = {
    ...manifestWithoutView,
    worker: {
      ...manifest.worker,
      relativePath: "worker.js",
    },
    ...(hasView
      ? {
          view: {
            ...manifest.view,
            relativePath: "views/index.html",
          },
        }
      : {}),
  } as CarrotManifest;

  writeFileSync(
    join(outDir, "carrot.json"),
    JSON.stringify(outputManifest, null, 2),
  );
}

async function runCustomBuild(sourceDir: string, outDir: string, manifest: CarrotManifest) {
  const buildScriptPath = join(sourceDir, "build.ts");
  if (!existsSync(buildScriptPath)) {
    await runDefaultBuild(sourceDir, outDir, manifest);
    return;
  }

  const module = (await import(
    `${pathToFileURL(buildScriptPath).href}?t=${Date.now()}`
  )) as CustomBuildModule;
  const buildCarrot = module.buildCarrot ?? module.default;

  if (typeof buildCarrot !== "function") {
    throw new Error(
      `Custom carrot build script must export default or buildCarrot(): ${buildScriptPath}`,
    );
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  await buildCarrot({
    sourceDir,
    outDir,
    manifest,
    sdkViewModule: getSdkViewModule(),
    sdkBunModule: getSdkBunModule(),
    defaultBuild: () => runDefaultBuild(sourceDir, outDir, manifest),
  });
}

export async function buildCarrotSource(sourceDir: string, outDir: string) {
  const normalizedSourceDir = resolve(sourceDir);
  const { execFileSync: execFileSyncNode } = await import("node:child_process");
  const { readdirSync } = await import("node:fs");

  // Check if this is a new-style carrot (has electrobun.config.ts with build.carrot)
  const hasElectrobunConfig = existsSync(join(normalizedSourceDir, "electrobun.config.ts"));
  const hasCarrotJson = existsSync(join(normalizedSourceDir, "carrot.json"));

  if (hasElectrobunConfig) {
    const electrobunPackageDir = resolveLocalElectrobunPackageDir(normalizedSourceDir);
    ensureCarrotPackageDependencies(
      normalizedSourceDir,
      electrobunPackageDir,
      execFileSyncNode,
    );
    const buildCommand = resolveLocalElectrobunBuildCommand(electrobunPackageDir);

    // New path: run electrobun build and copy the carrot output
    console.log(`  Running electrobun build in ${normalizedSourceDir}...`);
    try {
      const output = execFileSyncNode(buildCommand.command, buildCommand.args, {
        cwd: normalizedSourceDir,
        stdio: "pipe",
        encoding: "utf8",
        env: process.env,
      });
      if (output) console.log(`  [electrobun build] ${output.trim()}`);
    } catch (buildError: any) {
      const stderr = buildError.stderr?.toString() || "";
      const stdout = buildError.stdout?.toString() || "";
      console.error(`  [electrobun build] FAILED in ${normalizedSourceDir}`);
      if (stderr) console.error(`  stderr: ${stderr.slice(0, 500)}`);
      if (stdout) console.error(`  stdout: ${stdout.slice(0, 500)}`);
      throw buildError;
    }

    // Find the carrot output directory — it's at build/{platform}/carrot/{id}/
    const buildRoot = join(normalizedSourceDir, "build");
    if (!existsSync(buildRoot)) {
      throw new Error(`electrobun build did not produce a build/ directory in ${normalizedSourceDir}`);
    }

    // Find the platform directory (e.g., dev-macos-arm64)
    const platformDirs = readdirSync(buildRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    if (platformDirs.length === 0) {
      throw new Error(`No platform build directory found in ${buildRoot}`);
    }

    const platformDir = chooseCurrentPlatformBuildDir(platformDirs);
    const carrotParent = join(buildRoot, platformDir, "carrot");
    if (!existsSync(carrotParent)) {
      throw new Error(`No carrot output found in ${carrotParent}. Is build.carrot configured?`);
    }

    const carrotDirs = readdirSync(carrotParent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    if (carrotDirs.length === 0) {
      throw new Error(`No carrot build found in ${carrotParent}`);
    }

    const carrotBuildDir = join(carrotParent, carrotDirs[0]);

    // Copy the built carrot to the output directory
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    cpSync(carrotBuildDir, outDir, { recursive: true });

    const builtManifestPath = join(outDir, "carrot.json");
    if (!existsSync(builtManifestPath)) {
      throw new Error(`Built carrot is missing carrot.json at ${builtManifestPath}`);
    }

    const builtManifest = JSON.parse(readFileSync(builtManifestPath, "utf8")) as CarrotManifest & {
      permissions?: unknown;
    };
    const { permissions: _legacyPermissions, ...normalized } = builtManifest;
    return normalized satisfies CarrotManifest;
  }

  // Legacy path: carrot.json + old build system
  if (!hasCarrotJson) {
    throw new Error(`Missing carrot.json or electrobun.config.ts in ${normalizedSourceDir}`);
  }

  const manifest = mergeCarrotConfig(
    readManifest(normalizedSourceDir)!,
    await readCarrotAuthoringConfig(normalizedSourceDir),
  );

  await runCustomBuild(normalizedSourceDir, outDir, manifest);

  const builtManifestPath = join(outDir, "carrot.json");
  if (existsSync(builtManifestPath)) {
    const builtManifest = JSON.parse(readFileSync(builtManifestPath, "utf8")) as CarrotManifest & {
      permissions?: unknown;
    };
    const { permissions: _legacyPermissions, ...normalized } = builtManifest;
    return normalized satisfies CarrotManifest;
  }

  return manifest;
}
