/**
 * PostBuild script for Bunny Biome.
 * Copies the @biomejs/biome package into the carrot output.
 */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const sourceDir = process.cwd();
const carrotDir = process.env.ELECTROBUN_CARROT_DIR;

if (!carrotDir) {
	console.error("[biome postBuild] ELECTROBUN_CARROT_DIR not set, skipping");
	process.exit(0);
}

const biomePkg = join(sourceDir, "node_modules", "@biomejs", "biome");
if (!existsSync(biomePkg)) {
	throw new Error(`Missing @biomejs/biome at ${biomePkg}. Run bun install.`);
}

console.log("[biome postBuild] Copying @biomejs/biome...");
cpSync(biomePkg, join(carrotDir, "@biomejs", "biome"), { recursive: true });

// Also copy the platform-specific binary package
const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
const arch = process.arch;
const platformPkg = join(sourceDir, "node_modules", `@biomejs/cli-${platform}-${arch}`);
if (existsSync(platformPkg)) {
	cpSync(platformPkg, join(carrotDir, `@biomejs/cli-${platform}-${arch}`), { recursive: true });
}

console.log("[biome postBuild] Done");
