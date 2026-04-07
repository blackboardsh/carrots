import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Bunny Dash",
		identifier: "ai.electrobunny.dash",
		version: "0.1.0",
	},
	build: {
		bun: {
			entrypoint: "src/bun/worker.ts",
		},
		carrot: {
			id: "bunny-dash",
			name: "Bunny Dash",
			description: "IDE and code editor for Electrobunny.",
			mode: "window",
			carrotOnly: true,
			permissions: {
				host: { tray: true, notifications: true, storage: true, windows: true },
				bun: { read: true, write: true, run: true, env: true, ffi: true },
				isolation: "shared-worker",
			},
			dependencies: {
				"bunny.pty": "file:../pty",
				"bunny.search": "file:../search",
				"bunny.git": "file:../git",
				"bunny.tsserver": "file:../tsserver",
				"bunny.biome": "file:../biome",
				"bunny.llama": "file:../llama",
			},
			// Views built by build.ts (postBuild). Declared here so they're exposed
			// in the manifest for remote loading via Hop.
			remoteUIs: {
				dash: { name: "Bunny Dash", path: "lens/index.html" },
			},
		},
	},
	scripts: {
		postBuild: "build.ts",
	},
} satisfies ElectrobunConfig;
