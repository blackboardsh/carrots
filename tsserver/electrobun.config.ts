import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Bunny TS Server",
		identifier: "bunny.tsserver",
		version: "0.1.0",
	},
	build: {
		bun: {
			entrypoint: "src/bun/worker.ts",
		},
		carrot: {
			id: "bunny.tsserver",
			name: "Bunny TS Server",
			description: "TypeScript language server for Bunny Dash.",
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
