import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["typescript"],
  onSuccess: async () => {
    // Add shebang to CLI output
    const fs = await import("fs");
    const cliPath = "./dist/cli.js";
    if (fs.existsSync(cliPath)) {
      const content = fs.readFileSync(cliPath, "utf-8");
      if (!content.startsWith("#!/usr/bin/env bun")) {
        fs.writeFileSync(cliPath, `#!/usr/bin/env bun\n${content}`);
      }
    }
  },
});
