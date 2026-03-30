import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Bunny Biome",
		identifier: "bunny.biome",
		version: "0.1.0",
	},
	build: {
		bun: {
			entrypoint: "src/bun/worker.ts",
		},
		carrot: {
			id: "bunny.biome",
			name: "Bunny Biome",
			description:
				"Code formatting and linting via Biome for Bunny Dash.",
			mode: "background",
			carrotOnly: true,
			permissions: {
				host: { storage: true },
				bun: { read: true, write: true, run: true },
				isolation: "shared-worker",
			},
		},
	},
	scripts: {
		postBuild: "build.ts",
	},
} satisfies ElectrobunConfig;
