/**
 * PostBuild script for Bunny Git.
 * Copies the vendored git binaries into the carrot output.
 */
import { cpSync, existsSync, chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const sourceDir = process.cwd();
const carrotDir = process.env.ELECTROBUN_CARROT_DIR;

if (!carrotDir) {
	console.error("[git postBuild] ELECTROBUN_CARROT_DIR not set, skipping");
	process.exit(0);
}

const vendorSrc = join(sourceDir, "vendor");
if (!existsSync(vendorSrc)) {
	throw new Error(`Missing vendor directory at ${vendorSrc}`);
}

const vendorDest = join(carrotDir, "vendor");
console.log("[git postBuild] Copying vendor binaries...");
cpSync(vendorSrc, vendorDest, { recursive: true });

// Ensure binaries are executable
for (const entry of readdirSync(vendorDest)) {
	const fullPath = join(vendorDest, entry);
	if (statSync(fullPath).isFile()) {
		try {
			chmodSync(fullPath, 0o755);
		} catch {}
	}
}

console.log("[git postBuild] Done");
