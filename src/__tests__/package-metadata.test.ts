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

	test("npm package entry launches `prinfer mcp` at the published version", () => {
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

	test("launches `npx -y prinfer@<version> mcp` with no user config", () => {
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

	test("bundled MCP server runs `npx -y prinfer mcp`", () => {
		const mcp = readJson("plugin/.mcp.json");
		expect(mcp.mcpServers.prinfer).toEqual({
			command: "npx",
			args: ["-y", pkg.name, "mcp"],
		});
	});
});
