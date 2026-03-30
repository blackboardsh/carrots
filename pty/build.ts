/**
 * PostBuild script for Bunny PTY.
 * Compiles the Zig PTY binary and copies it into the carrot output.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const sourceDir = process.cwd();
const carrotDir = process.env.ELECTROBUN_CARROT_DIR;

if (!carrotDir) {
	console.error("[pty postBuild] ELECTROBUN_CARROT_DIR not set, skipping");
	process.exit(0);
}

const PTY_BINARY_NAME = process.platform === "win32" ? "pty.exe" : "pty";
const zigName = process.platform === "win32" ? "zig.exe" : "zig";

const zigCandidates = [
	process.env.ZIG_BINARY,
	join(sourceDir, "node_modules", "electrobun", "vendors", "zig", zigName),
	join(sourceDir, "..", "node_modules", "electrobun", "vendors", "zig", zigName),
	join(sourceDir, "..", "..", "electrobun", "package", "vendors", "zig", zigName),
].filter(Boolean) as string[];

const zigBinary = zigCandidates.find((p) => existsSync(p));
if (!zigBinary) {
	throw new Error(`Missing Zig binary. Searched:\n${zigCandidates.join("\n")}`);
}

console.log("[pty postBuild] Building PTY binary with Zig...");
execFileSync(zigBinary, ["build"], { cwd: sourceDir, stdio: "pipe" });

const builtBinary = join(sourceDir, "zig-out", "bin", PTY_BINARY_NAME);
if (!existsSync(builtBinary)) {
	throw new Error(`Failed to build PTY binary at ${builtBinary}`);
}

cpSync(builtBinary, join(carrotDir, PTY_BINARY_NAME), { force: true });
console.log("[pty postBuild] Done");
