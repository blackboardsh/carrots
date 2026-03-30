/**
 * PostBuild script for Bunny TS Server.
 * Copies the bundled TypeScript package into the carrot output.
 */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const sourceDir = process.cwd();
const carrotDir = process.env.ELECTROBUN_CARROT_DIR;

if (!carrotDir) {
	console.error("[tsserver postBuild] ELECTROBUN_CARROT_DIR not set, skipping");
	process.exit(0);
}

const tsLib = join(sourceDir, "node_modules", "typescript", "lib");
if (!existsSync(tsLib)) {
	throw new Error(`Missing typescript/lib at ${tsLib}. Run bun install.`);
}

console.log("[tsserver postBuild] Copying TypeScript lib...");
cpSync(tsLib, join(carrotDir, "typescript", "lib"), { recursive: true });
console.log("[tsserver postBuild] Done");
