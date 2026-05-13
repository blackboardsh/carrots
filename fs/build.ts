/**
 * PostBuild script for Bunny FS.
 * Copies vendored fd and rg binaries into the carrot output.
 */
import { chmodSync, cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const sourceDir = process.cwd();
const carrotDir = process.env.ELECTROBUN_CARROT_DIR;

if (!carrotDir) {
	console.error("[fs postBuild] ELECTROBUN_CARROT_DIR not set, skipping");
	process.exit(0);
}

const getPlatformArch = () => {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === "darwin") {
		return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	}
	if (platform === "linux") {
		return arch === "arm64" || arch === "aarch64" ? "linux-arm64" : "linux-x64";
	}
	if (platform === "win32") {
		return arch === "x64" ? "win-x64" : "win-ia32";
	}

	return platform;
};

const platformArch = getPlatformArch();
const fdName = process.platform === "win32" ? "fd.exe" : "fd";
const rgName = process.platform === "win32" ? "rg.exe" : "rg";
const searchVendorDir = join(sourceDir, "..", "search", "vendor");

for (const name of [fdName, rgName]) {
	const dest = join(carrotDir, name);
	rmSync(dest, { force: true });

	let src = join(sourceDir, "vendor", platformArch, name);
	if (!existsSync(src)) {
		src = join(sourceDir, "vendor", name);
	}
	if (!existsSync(src)) {
		src = join(searchVendorDir, platformArch, name);
	}
	if (!existsSync(src)) {
		src = join(searchVendorDir, name);
	}

	if (existsSync(src)) {
		cpSync(src, dest, { force: true });
		if (process.platform !== "win32") {
			chmodSync(dest, "755");
		}
		console.log(`[fs postBuild] Copied ${name} from ${src}`);
	} else {
		console.warn(`[fs postBuild] Missing ${name} for platform ${platformArch}`);
	}
}

console.log("[fs postBuild] Done");
