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
const requireLlamaCli = process.env.BUNNY_LLAMA_REQUIRE_CLI === "1";

function skipOptionalLlamaCli(message: string) {
	if (requireLlamaCli) {
		throw new Error(message);
	}
	console.warn(`[llama postBuild] ${message}`);
	console.warn("[llama postBuild] Continuing without bundled llama-cli.");
}

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
	skipOptionalLlamaCli(`Missing llama-cli source at ${llamaCliSourceDir}`);
	process.exit(0);
}

if (!existsSync(join(llamaCliSourceDir, "deps", "llama.cpp", "build"))) {
	skipOptionalLlamaCli(
		`Missing llama.cpp build outputs. Run: cd ${llamaCliSourceDir} && bash setup-llama.sh and build llama.cpp.`,
	);
	process.exit(0);
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
try {
	execFileSync(zigBinary, ["build"], { cwd: llamaCliSourceDir, stdio: "pipe" });
} catch (error) {
	skipOptionalLlamaCli(error instanceof Error ? error.message : String(error));
	process.exit(0);
}

const builtBinary = join(llamaCliSourceDir, "zig-out", "bin", LLAMA_BINARY_NAME);
if (!existsSync(builtBinary)) {
	throw new Error(`Failed to build llama-cli at ${builtBinary}`);
}

cpSync(builtBinary, join(carrotDir, LLAMA_BINARY_NAME), { force: true });
console.log("[llama postBuild] Done");
