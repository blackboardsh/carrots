import { existsSync } from "node:fs";
import { resolve } from "node:path";

function resolveEarsSdkBunModule() {
  const override = process.env.BUNNY_EARS_SDK_BUN_MODULE;
  if (override) {
    return resolve(override);
  }

  return resolve(import.meta.dirname, "bunny", "ears", "src", "carrot-runtime", "bun.ts");
}

export function earsCarrotRuntimeAliasPlugin() {
  return {
    name: "ears-carrot-runtime-alias",
    setup(build: { onResolve: (options: { filter: RegExp }, callback: () => { path: string }) => void }) {
      const sdkBunModule = resolveEarsSdkBunModule();
      if (!existsSync(sdkBunModule)) {
        throw new Error(`Missing Bunny Ears carrot runtime SDK: ${sdkBunModule}`);
      }

      build.onResolve({ filter: /^electrobun(?:\/bun)?$/ }, () => ({
        path: sdkBunModule,
      }));
    },
  };
}
