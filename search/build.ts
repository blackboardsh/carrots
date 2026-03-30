/**
 * PostBuild script for Bunny Search.
 * Copies vendored fd and rg binaries into the carrot output.
 */
import { cpSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

const sourceDir = process.cwd();
const carrotDir = process.env.ELECTROBUN_CARROT_DIR;

if (!carrotDir) {
	console.error("[search postBuild] ELECTROBUN_CARROT_DIR not set, skipping");
	process.exit(0);
}

const fdName = process.platform === "win32" ? "fd.exe" : "fd";
const rgName = process.platform === "win32" ? "rg.exe" : "rg";

for (const name of [fdName, rgName]) {
	const src = join(sourceDir, "vendor", name);
	if (existsSync(src)) {
		const dest = join(carrotDir, name);
		cpSync(src, dest, { force: true });
		if (process.platform !== "win32") chmodSync(dest, "755");
		console.log(`[search postBuild] Copied ${name}`);
	} else {
		console.warn(`[search postBuild] Missing vendor/${name}`);
	}
}

console.log("[search postBuild] Done");
