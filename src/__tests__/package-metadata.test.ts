import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
