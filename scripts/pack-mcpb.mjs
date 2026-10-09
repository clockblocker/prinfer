#!/usr/bin/env node
// Packs prinfer.mcpb for Smithery: mcpb/manifest.json plus the tools the
// built server lists, each with its inputSchema. Smithery rejects a stdio
// bundle without tools, and rejects tools without an inputSchema, while
// `mcpb pack` rejects inputSchema as an unknown key. So the checked-in
// manifest stays spec-valid and this script zips the extended copy itself.
// Needs `bun run build` first (reads dist/mcp.js) and `zip` on PATH.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "prinfer.mcpb");

function listTools() {
	const server = spawn(process.execPath, [join(root, "dist/mcp.js")], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	const send = (message) =>
		server.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
		);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			server.kill();
			reject(new Error("dist/mcp.js did not answer tools/list in 30s"));
		}, 30_000);
		server.on("error", reject);
		createInterface({ input: server.stdout }).on("line", (line) => {
			const message = JSON.parse(line);
			if (message.id === 1) {
				send({ method: "notifications/initialized" });
				send({ id: 2, method: "tools/list" });
			} else if (message.id === 2) {
				clearTimeout(timer);
				server.stdin.end();
				if (message.error) reject(new Error(message.error.message));
				else resolve(message.result.tools);
			}
		});
		send({
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "pack-mcpb", version: "1.0.0" },
			},
		});
	});
}

const tools = await listTools();
if (tools.length === 0) throw new Error("dist/mcp.js listed no tools");

const manifest = JSON.parse(
	readFileSync(join(root, "mcpb/manifest.json"), "utf8"),
);
manifest.tools = tools.map(({ name, description, inputSchema }) => ({
	name,
	description,
	inputSchema,
}));

const staging = mkdtempSync(join(tmpdir(), "prinfer-mcpb-"));
try {
	writeFileSync(
		join(staging, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	rmSync(output, { force: true });
	execFileSync("zip", ["-qX", output, "manifest.json"], { cwd: staging });
} finally {
	rmSync(staging, { recursive: true, force: true });
}
console.log(`${output}: ${manifest.version}, ${tools.length} tools`);
