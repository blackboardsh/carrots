import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Dash",
		identifier: "ai.electrobunny.dash",
		version: "0.0.2",
	},
	runtime: {
		exitOnLastWindowClosed: false,
	},
	build: {
		wgpuVersion: "0.2.3",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			mainview: {
				entrypoint: "src/mainview/index.ts",
			},
			"carrot-sdk-view": {
				entrypoint: "src/carrot-runtime/view.ts",
			},
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
			"src/carrot-runtime/bun.ts": "carrot-runtime/bun.ts",
			"assets/Dash-tray.png": "views/assets/Dash-tray.png",
		},
		mac: {
			codesign: true,
			notarize: true,
			createDmg: true,
			bundleCEF: false,
			bundleWGPU: true,
			icons: "assets/Dash.iconset",
		},
		linux: {
			bundleCEF: false,
			bundleWGPU: true,
			icon: "assets/Dash.png",
		},
		win: {
			bundleCEF: false,
			bundleWGPU: true,
			icon: "assets/Dash.png",
		},
	},
	release: {
		baseUrl: "https://ears.electrobunny.ai/",
	},
} satisfies ElectrobunConfig;
