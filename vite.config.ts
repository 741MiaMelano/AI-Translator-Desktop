import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

function copyElectronRuntimeFiles() {
  const outIpc = join("dist-electron", "ipc");
  rmSync(outIpc, { recursive: true, force: true });
  mkdirSync(outIpc, { recursive: true });
  for (const file of ["adapter.mjs", "validate.mjs"]) {
    copyFileSync(join("electron", "ipc", file), join(outIpc, file));
  }
}

function stripUnsupportedElectronRollupOptions(): Plugin {
  return {
    name: "strip-unsupported-electron-rollup-options",
    config(config) {
      const options = config.build?.rollupOptions as
        | { platform?: unknown; output?: { codeSplitting?: unknown } | Array<{ codeSplitting?: unknown }> }
        | undefined;
      if (!options) return;
      delete options.platform;
      const outputs = Array.isArray(options.output) ? options.output : [options.output];
      outputs.forEach((output) => {
        if (output) delete output.codeSplitting;
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            rollupOptions: {
              external: [
                "electron",
                /^node:/,
                /\.mjs$/,
              ],
            },
          },
          plugins: [
            stripUnsupportedElectronRollupOptions(),
            {
              name: "copy-electron-ipc-modules",
              closeBundle() {
                copyElectronRuntimeFiles();
              },
            },
          ],
        },
      },
      preload: {
        input: "electron/preload.ts",
        vite: {
          plugins: [stripUnsupportedElectronRollupOptions()],
        },
      },
    }),
  ],
});
