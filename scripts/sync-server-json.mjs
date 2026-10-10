#!/usr/bin/env node
// Copies the package.json version into the MCP Registry manifest (server.json),
// the Claude Code plugin manifest and the MCPB manifest used for Smithery.
// Runs after `changeset version`.
// Edits only the version strings so the files keep their Biome formatting.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

const versionKey = /("version"\s*:\s*)"[^"]*"/g;
// The pinned `npx -y typeprobe@<version> mcp` argument in mcpb/manifest.json.
const pinnedPackage = new RegExp(`"${pkg.name}@[^"]*"`, "g");

function sync(relativePath, check) {
	const file = join(root, relativePath);
	const updated = readFileSync(file, "utf8")
		.replace(versionKey, (_, key) => `${key}${JSON.stringify(version)}`)
		.replace(pinnedPackage, JSON.stringify(`${pkg.name}@${version}`));
	const parsed = JSON.parse(updated);
	if (!check(parsed)) {
		throw new Error(`${relativePath}: version sync did not apply cleanly`);
	}
	writeFileSync(file, updated);
	console.log(`${relativePath} -> ${version}`);
}

sync(
	"server.json",
	(server) =>
		server.name === pkg.mcpName &&
		server.version === version &&
		server.packages.every(
			(entry) =>
				entry.identifier !== pkg.name || entry.version === version,
		),
);
sync(
	"plugin/.claude-plugin/plugin.json",
	(plugin) => plugin.version === version,
);
sync(
	"mcpb/manifest.json",
	(manifest) =>
		manifest.version === version &&
		manifest.server.mcp_config.args.includes(`${pkg.name}@${version}`),
);
