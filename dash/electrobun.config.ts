import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Bunny Dash",
    identifier: "ai.electrobunny.dash",
    version: "0.1.0",
  },
  bunny: {
    carrot: {
      dependencies: {
        "bunny.pty": "file:../pty",
        "bunny.search": "file:../search",
        "bunny.git": "file:../git",
        "bunny.tsserver": "file:../tsserver",
        "bunny.biome": "file:../biome",
        "bunny.llama": "file:../llama",
      },
    },
  },
} satisfies ElectrobunConfig;
