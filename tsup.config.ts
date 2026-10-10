import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    mcp: "src/mcp.ts",
    testing: "src/testing.ts",
    vitest: "src/vitest.ts",
    // Worker thread behind the synchronous TypeScript 7 testing helpers;
    // src/native-sync.ts starts native-worker-boot from next to the bundle
    // that imports it, and the boot module imports native-worker.
    "native-worker-boot": "src/native-worker-boot.ts",
    "native-worker": "src/native-worker.ts",
  },
  format: ["esm", "cjs"],
  // Declaration bundling still runs through the TS 6 compatibility API.
  // tsup's generated declaration config uses baseUrl internally.
  dts: {
    compilerOptions: {
      ignoreDeprecations: "6.0",
    },
  },
  define: {
    __PRINFER_VERSION__: JSON.stringify(version),
  },
  // CJS builds get import.meta.url, which src/native-sync.ts uses to find
  // the worker entry.
  shims: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  external: ["@typescript/native", "typescript"],
  onSuccess: async () => {
    // Add shebang to CLI and MCP outputs
    const fs = await import("fs");
    for (const file of ["./dist/cli.js", "./dist/mcp.js"]) {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, "utf-8");
        if (!content.startsWith("#!/usr/bin/env node")) {
          fs.writeFileSync(file, `#!/usr/bin/env node\n${content}`);
        }
      }
    }
  },
});
