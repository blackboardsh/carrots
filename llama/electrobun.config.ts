export default {
	app: {
		name: "Bunny Llama",
		identifier: "bunny.llama",
		version: "0.1.0",
	},
	build: {
		bun: {
			entrypoint: "src/bun/worker.ts",
		},
		carrot: {
			id: "bunny.llama",
			name: "Bunny Llama",
			description: "Local LLM inference for Bunny Dash.",
			mode: "background",
			carrotOnly: true,
		},
	},
	permissions: {
		host: {
			storage: true,
		},
		bun: {
			read: true,
			write: true,
			run: true,
		},
		isolation: "shared-worker",
	},
};
