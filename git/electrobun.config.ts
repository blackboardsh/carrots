import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Bunny Git",
		identifier: "bunny.git",
		version: "0.1.0",
	},
	build: {
		bun: {
			entrypoint: "src/bun/worker.ts",
		},
		carrot: {
			id: "bunny.git",
			name: "Bunny Git",
			description: "Git operations for Bunny Dash.",
			mode: "background",
			carrotOnly: true,
			permissions: {
				host: { storage: true },
				bun: { read: true, write: true, run: true },
				isolation: "shared-worker",
			},
			contributions: {
				fileActivators: [
					{
						baseName: ".git",
						nodeType: "dir",
						slate: {
							type: "git",
							name: "Git",
							icon: "",
							config: {},
						},
					},
				],
			},
		},
	},
	scripts: {
		postBuild: "build.ts",
	},
} satisfies ElectrobunConfig;
