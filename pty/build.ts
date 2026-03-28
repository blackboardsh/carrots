import { execFileSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const PTY_BINARY_NAME = process.platform === "win32" ? "pty.exe" : "pty";

type BuildContext = {
  sourceDir: string;
  outDir: string;
  manifest: any;
  defaultBuild: () => Promise<void>;
};

function buildPtyBinary(sourceDir: string, outDir: string) {
  const zigName = process.platform === "win32" ? "zig.exe" : "zig";
  // Check env var, then sibling electrobun repo, then old relative path
  const zigCandidates = [
    process.env.ZIG_BINARY,
    join(sourceDir, "..", "..", "electrobun", "package", "vendors", "zig", zigName),
  ].filter(Boolean) as string[];

  const zigBinary = zigCandidates.find((p) => existsSync(p));
  if (!zigBinary) {
    throw new Error(`Missing Zig binary. Searched:\n${zigCandidates.join("\n")}`);
  }

  execFileSync(zigBinary, ["build"], {
    cwd: sourceDir,
    stdio: "pipe",
  });

  const builtPtyBinary = join(
    sourceDir,
    "zig-out",
    "bin",
    PTY_BINARY_NAME,
  );

  if (!existsSync(builtPtyBinary)) {
    throw new Error(`Failed to build PTY binary at ${builtPtyBinary}`);
  }

  cpSync(
    builtPtyBinary,
    join(resolve(outDir), PTY_BINARY_NAME),
    { force: true },
  );
}

export async function buildCarrot({ sourceDir, outDir, defaultBuild }: BuildContext) {
  await defaultBuild();
  buildPtyBinary(sourceDir, outDir);
}

export default buildCarrot;
