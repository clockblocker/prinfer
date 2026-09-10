import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    mcp: "src/mcp.ts",
    postinstall: "src/postinstall.ts",
  },
  format: ["esm", "cjs"],
  // Declaration bundling still runs through the TS 6 compatibility API.
  // tsup's generated declaration config uses baseUrl internally.
  dts: {
    compilerOptions: {
      ignoreDeprecations: "6.0",
    },
  },
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["@typescript/typescript6"],
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
