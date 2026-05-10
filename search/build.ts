/**
 * PostBuild script for Bunny Search.
 * Copies vendored fd and rg binaries into the carrot output.
 */
import { cpSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

const sourceDir = process.cwd();
const carrotDir = process.env.ELECTROBUN_CARROT_DIR;

if (!carrotDir) {
	console.error("[search postBuild] ELECTROBUN_CARROT_DIR not set, skipping");
	process.exit(0);
}

// Determine platform and architecture
const getPlatformArch = () => {
	const platform = process.platform;
	const arch = process.arch;

	// Map Node.js platform/arch to our directory structure
	if (platform === "darwin") {
		return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	} else if (platform === "linux") {
		return arch === "arm64" || arch === "aarch64" ? "linux-arm64" : "linux-x64";
	} else if (platform === "win32") {
		return arch === "x64" ? "win-x64" : "win-ia32";
	}

	// Fallback to generic
	return platform;
};

const fdName = process.platform === "win32" ? "fd.exe" : "fd";
const rgName = process.platform === "win32" ? "rg.exe" : "rg";
const platformArch = getPlatformArch();

for (const name of [fdName, rgName]) {
	const dest = join(carrotDir, name);
	rmSync(dest, { force: true });

	// Try platform-specific path first
	let src = join(sourceDir, "vendor", platformArch, name);
	if (!existsSync(src)) {
		// Fall back to generic path
		src = join(sourceDir, "vendor", name);
	}

	if (existsSync(src)) {
		cpSync(src, dest, { force: true });
		if (process.platform !== "win32") chmodSync(dest, "755");
		console.log(`[search postBuild] Copied ${name} from ${src}`);
	} else {
		console.warn(`[search postBuild] Missing ${name} for platform ${platformArch}`);
	}
}

console.log("[search postBuild] Done");
