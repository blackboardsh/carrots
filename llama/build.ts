/**
 * PostBuild script for Bunny Llama.
 * Compiles the llama-cli Zig binary and copies it into the carrot output.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const sourceDir = process.cwd();
const carrotDir = process.env.ELECTROBUN_CARROT_DIR;

if (!carrotDir) {
	console.error("[llama postBuild] ELECTROBUN_CARROT_DIR not set, skipping");
	process.exit(0);
}

const LLAMA_BINARY_NAME = process.platform === "win32" ? "llama-cli.exe" : "llama-cli";

// Check for override binary
const overrideBin = process.env.BUNNY_LLAMA_CLI_BIN;
if (overrideBin && existsSync(overrideBin)) {
	cpSync(resolve(overrideBin), join(carrotDir, LLAMA_BINARY_NAME), { force: true });
	console.log("[llama postBuild] Using override binary");
	process.exit(0);
}

// Build from source
const llamaCliSourceDir = join(sourceDir, "llama-cli");
if (!existsSync(join(llamaCliSourceDir, "build.zig"))) {
	console.error(`[llama postBuild] Missing llama-cli source at ${llamaCliSourceDir}`);
	console.error("Run: cd llama/llama-cli && bash setup-llama.sh");
	process.exit(1);
}

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

console.log("[llama postBuild] Building llama-cli with Zig...");
execFileSync(zigBinary, ["build"], { cwd: llamaCliSourceDir, stdio: "pipe" });

const builtBinary = join(llamaCliSourceDir, "zig-out", "bin", LLAMA_BINARY_NAME);
if (!existsSync(builtBinary)) {
	throw new Error(`Failed to build llama-cli at ${builtBinary}`);
}

cpSync(builtBinary, join(carrotDir, LLAMA_BINARY_NAME), { force: true });
console.log("[llama postBuild] Done");
