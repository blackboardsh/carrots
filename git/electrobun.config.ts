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
							type: "carrot-slate-ui",
							name: "Git",
							icon: "",
							config: {
								carrotId: "bunny.git",
								slateUIId: "git-slate",
							},
						},
					},
				],
			},
			slateUIs: {
				"git-slate": { name: "Git", path: "slate-ui/git-slate/index.js" },
			},
			remoteUIs: {
				"git-slate": { name: "Git", path: "remote-ui/git-slate/index.html" },
				"git-settings": { name: "Git Settings", path: "remote-ui/git-settings/index.html" },
			},
		},
	},
	scripts: {
		postBuild: "build.ts",
	},
} satisfies ElectrobunConfig;
