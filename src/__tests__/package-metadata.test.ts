import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureFreshBuild } from "./helpers/build.js";

const root = join(import.meta.dir, "..", "..");

function readJson(relativePath: string) {
	return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

const pkg = readJson("package.json");
const server = readJson("server.json");
const plugin = readJson("plugin/.claude-plugin/plugin.json");
const marketplace = readJson(".claude-plugin/marketplace.json");

describe("MCP Registry manifest", () => {
	test("server.json matches package.json", () => {
		expect(server.name).toBe(pkg.mcpName);
		expect(server.version).toBe(pkg.version);
	});

	test("npm package entry launches `typeprobe mcp` at the published version", () => {
		const npmPackage = server.packages.find(
			(entry: { registryType: string }) => entry.registryType === "npm",
		);
		expect(npmPackage).toMatchObject({
			identifier: pkg.name,
			version: pkg.version,
			transport: { type: "stdio" },
			packageArguments: [{ type: "positional", value: "mcp" }],
		});
	});

	test("description fits the registry limit", () => {
		expect(server.description.length).toBeLessThanOrEqual(100);
	});
});

describe("MCPB manifest (Smithery)", () => {
	const manifest = readJson("mcpb/manifest.json");

	test("matches package.json", () => {
		expect(manifest.name).toBe(pkg.name);
		expect(manifest.version).toBe(pkg.version);
		expect(manifest.compatibility.runtimes.node).toBe(pkg.engines.node);
	});

	test("launches `npx -y typeprobe@<version> mcp` with no user config", () => {
		expect(manifest.server).toMatchObject({
			type: "node",
			mcp_config: {
				command: "npx",
				args: ["-y", `${pkg.name}@${pkg.version}`, "mcp"],
			},
		});
		expect(manifest.user_config).toBeUndefined();
	});
});

describe("published build", () => {
	const dist = join(root, "dist");

	test("ships no sourcemaps", () => {
		ensureFreshBuild();
		expect(
			readdirSync(dist).filter((name) => name.endsWith(".map")),
		).toEqual([]);
	});

	test("loads @typescript/native only on a TypeScript 7 call", () => {
		ensureFreshBuild();
		for (const name of readdirSync(dist)) {
			if (!/\.c?js$/.test(name)) continue;
			const code = readFileSync(join(dist, name), "utf8");
			// A static import or require would load it with the module; the
			// lazy import() in src/compiler.ts is the only reference allowed.
			expect(code).not.toMatch(/^import [^(]*["']@typescript\/native/m);
			expect(code).not.toMatch(/require\(["']@typescript\/native/);
		}
	});
});

describe("Claude Code plugin", () => {
	test("plugin version matches package.json", () => {
		expect(plugin.version).toBe(pkg.version);
	});

	test("marketplace entry points at the plugin", () => {
		const entry = marketplace.plugins.find(
			(candidate: { name: string }) => candidate.name === plugin.name,
		);
		expect(entry).toBeDefined();
		expect(
			existsSync(
				join(root, entry.source, ".claude-plugin", "plugin.json"),
			),
		).toBe(true);
	});

	test("bundled MCP server runs `npx -y typeprobe mcp`", () => {
		const mcp = readJson("plugin/.mcp.json");
		expect(mcp.mcpServers.typeprobe).toEqual({
			command: "npx",
			args: ["-y", pkg.name, "mcp"],
		});
	});
});

describe("prinfer shim (shim/prinfer)", () => {
	const shim = readJson("shim/prinfer/package.json");

	test("depends on typeprobe and re-exports every subpath", () => {
		expect(shim.name).toBe("prinfer");
		// The final prinfer release; typeprobe 4.0.0 is the first with the name.
		expect(shim.dependencies).toEqual({ typeprobe: "^4.0.0" });
		expect(Object.keys(shim.exports).sort()).toEqual(
			Object.keys(pkg.exports).sort(),
		);
		for (const [subpath, conditions] of Object.entries(shim.exports)) {
			const target =
				subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
			for (const files of Object.values(
				conditions as Record<string, Record<string, string>>,
			)) {
				for (const file of Object.values(files)) {
					const code = readFileSync(
						join(root, "shim/prinfer", file),
						"utf8",
					);
					expect(code).toContain(`"${target}"`);
				}
			}
		}
	});

	test("provides the prinfer bins, which typeprobe no longer has", () => {
		expect(Object.keys(shim.bin).sort()).toEqual([
			"prinfer",
			"prinfer-mcp",
		]);
		expect(Object.keys(pkg.bin).sort()).toEqual([
			"typeprobe",
			"typeprobe-mcp",
		]);
		for (const file of Object.values(shim.bin) as string[]) {
			expect(existsSync(join(root, "shim/prinfer", file))).toBe(true);
		}
	});
});
