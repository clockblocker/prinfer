import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	batchHoverSuccessSchema,
	contractErrorResponseSchema,
	hoverSuccessSchema,
} from "../contract.js";

// Drives the built server over stdio, exactly as an MCP client would.
const packageRoot = path.join(import.meta.dir, "..", "..");
const serverPath = path.join(packageRoot, "dist", "mcp.js");
const fixturesDir = path.join(import.meta.dir, "fixtures");
const sampleFile = path.join(fixturesDir, "sample.ts");
const genericMethodFile = path.join(fixturesDir, "generic-method.ts");
const packageVersion = (
	JSON.parse(
		fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
	) as { version: string }
).version;

interface JsonRpcResponse {
	id: number;
	result?: Record<string, unknown>;
	error?: { message: string };
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	structuredContent: Record<string, unknown>;
	isError?: boolean;
}

class StdioMcpClient {
	private readonly child: ChildProcess;
	private readonly pending = new Map<
		number,
		(response: JsonRpcResponse) => void
	>();
	private buffer = "";
	private nextId = 1;
	serverInfo: Record<string, unknown> = {};
	instructions = "";

	constructor(env: Record<string, string> = {}) {
		this.child = spawn("node", [serverPath], {
			cwd: fixturesDir,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString();
			let newline = this.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.buffer.slice(0, newline).trim();
				this.buffer = this.buffer.slice(newline + 1);
				if (line) {
					const message = JSON.parse(line) as JsonRpcResponse;
					this.pending.get(message.id)?.(message);
					this.pending.delete(message.id);
				}
				newline = this.buffer.indexOf("\n");
			}
		});
	}

	async initialize(): Promise<void> {
		const result = await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "prinfer-test", version: "0.0.0" },
		});
		this.serverInfo = result.serverInfo as Record<string, unknown>;
		this.instructions = result.instructions as string;
		this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	}

	async listTools(): Promise<
		Array<{
			name: string;
			description: string;
			inputSchema: {
				properties: Record<string, unknown>;
				required?: string[];
			};
		}>
	> {
		const result = await this.request("tools/list", {});
		return result.tools as never;
	}

	async call(
		name: string,
		args: Record<string, unknown>,
	): Promise<ToolResult> {
		return (await this.request("tools/call", {
			name,
			arguments: args,
		})) as unknown as ToolResult;
	}

	close(): void {
		this.child.kill();
	}

	private async request(
		method: string,
		params: unknown,
	): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		const response = await new Promise<JsonRpcResponse>((resolve) => {
			this.pending.set(id, resolve);
			this.send({ jsonrpc: "2.0", id, method, params });
		});
		if (response.error) throw new Error(response.error.message);
		return response.result ?? {};
	}

	private send(message: unknown): void {
		this.child.stdin?.write(`${JSON.stringify(message)}\n`);
	}
}

function newestSourceMtime(dir: string): number {
	let newest = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__") {
				newest = Math.max(newest, newestSourceMtime(full));
			}
		} else if (entry.name.endsWith(".ts")) {
			newest = Math.max(newest, fs.statSync(full).mtimeMs);
		}
	}
	return newest;
}

let client: StdioMcpClient;

beforeAll(async () => {
	const stale =
		!fs.existsSync(serverPath) ||
		fs.statSync(serverPath).mtimeMs <
			newestSourceMtime(path.join(packageRoot, "src"));
	if (stale) {
		const build = Bun.spawnSync(["bun", "run", "build"], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(build.exitCode).toBe(0);
	}
	client = new StdioMcpClient();
	await client.initialize();
}, 60_000);

afterAll(() => client?.close());

describe("MCP server over stdio", () => {
	test("reports the package version and tool guidance", () => {
		expect(client.serverInfo).toMatchObject({
			name: "prinfer",
			version: packageVersion,
		});
		for (const tool of [
			"hover_by_name",
			"hover",
			"batch_hover",
			"completions",
			"diagnostics",
			"typescript6",
		]) {
			expect(client.instructions).toContain(tool);
		}
	});

	test("lists hover_by_name first, without the deprecated alias or include_timing", async () => {
		const tools = await client.listTools();
		const names = tools.map((tool) => tool.name);
		expect(names[0]).toBe("hover_by_name");
		expect(names).toEqual(
			expect.arrayContaining(["hover", "batch_hover", "completions"]),
		);
		expect(names).not.toContain("hoverByName");
		for (const tool of tools) {
			expect(tool.description.length).toBeGreaterThan(0);
			expect(Object.keys(tool.inputSchema.properties)).not.toContain(
				"include_timing",
			);
		}
		const hover = tools.find((tool) => tool.name === "hover");
		expect(hover?.inputSchema.required).toEqual(["file", "line"]);
		const batch = tools.find((tool) => tool.name === "batch_hover");
		expect(batch?.inputSchema.required).toEqual(["positions"]);
	});

	for (const backend of ["typescript6", "typescript7"] as const) {
		test(`hover targets a token by text (${backend})`, async () => {
			const response = await client.call("hover", {
				file: "sample.ts",
				line: 36,
				text: "add",
				backend,
			});
			expect(response.isError).toBeUndefined();
			const parsed = hoverSuccessSchema.parse(response.structuredContent);
			expect(parsed.result.signature).toContain(
				"(a: number, b: number): number",
			);
			expect(parsed.result.position).toEqual({ line: 36, column: 2 });
			expect(parsed.result.timing).toBeUndefined();
			expect(response.content[0]?.text).toContain(
				'Target: "add" at 36:2',
			);
		});

		test(`hover prefers whole-identifier text matches (${backend})`, async () => {
			const response = await client.call("hover", {
				file: sampleFile,
				line: 4,
				text: "b",
				backend,
			});
			const parsed = hoverSuccessSchema.parse(response.structuredContent);
			// "export function add(a: number, b: number)": the "b" inside
			// "number" is skipped, so the first match is the parameter.
			expect(parsed.result.position).toEqual({ line: 4, column: 32 });
			expect(parsed.result.signature).toMatch(/number$/);
		});
	}

	test("hover reports missing text with the actual line content", async () => {
		const response = await client.call("hover", {
			file: sampleFile,
			line: 36,
			text: "subtract",
			backend: "typescript6",
		});
		expect(response.isError).toBe(true);
		const parsed = contractErrorResponseSchema.parse(
			response.structuredContent,
		);
		expect(parsed.error.code).toBe("SYMBOL_NOT_FOUND");
		expect(parsed.error.suggestion).toContain(
			'Line 36 reads: "add(a: number, b: number): number {"',
		);
		expect(response.content[0]?.text).toContain("Suggestion: Line 36");
	});

	test("hover requires exactly one of column and text", async () => {
		for (const args of [
			{ file: sampleFile, line: 4 },
			{ file: sampleFile, line: 4, column: 17, text: "add" },
		]) {
			const response = await client.call("hover", args);
			expect(response.isError).toBe(true);
			expect(
				contractErrorResponseSchema.parse(response.structuredContent)
					.error.code,
			).toBe("INVALID_ARGUMENT");
		}
	});

	test("hover still accepts a column", async () => {
		const response = await client.call("hover", {
			file: sampleFile,
			line: 4,
			column: 17,
			backend: "typescript6",
		});
		const parsed = hoverSuccessSchema.parse(response.structuredContent);
		expect(parsed.result.name).toBe("add");
		expect(parsed.result.position).toEqual({ line: 4, column: 17 });
	});

	test("hover_by_name returns the named symbol", async () => {
		const response = await client.call("hover_by_name", {
			file: "sample.ts",
			name: "multiply",
		});
		const parsed = hoverSuccessSchema.parse(response.structuredContent);
		expect(parsed.result.signature).toContain(
			"(x: number, y: number) => number",
		);
	});

	test("the deprecated hoverByName alias is gone", async () => {
		await expect(
			client.call("hoverByName", { file: sampleFile, name: "multiply" }),
		).rejects.toThrow("hoverByName");
	});

	for (const backend of ["typescript6", "typescript7"] as const) {
		test(`batch_hover mixes files and target kinds (${backend})`, async () => {
			const response = await client.call("batch_hover", {
				file: "sample.ts",
				backend,
				positions: [
					{ line: 4, column: 17 },
					{ line: 36, text: "add" },
					{ name: "multiply" },
					{ file: genericMethodFile, name: "nope" },
					{ line: 36, text: "missing" },
					{ line: 4 },
					{ file: "does-not-exist.ts", line: 1, column: 1 },
				],
			});
			expect(response.isError).toBeUndefined();
			const { result } = batchHoverSuccessSchema.parse(
				response.structuredContent,
			);
			expect(result.successCount).toBe(3);
			expect(result.errorCount).toBe(4);
			const [position, text, name, missingName, missingText, bad, gone] =
				result.items;

			expect(position?.file).toBe(sampleFile);
			expect(position?.result?.name).toBe("add");
			expect(text?.position).toEqual({ line: 36, column: 2 });
			expect(text?.text).toBe("add");
			expect(text?.occurrence).toBe(1);
			expect(text?.result?.signature).toContain("(a: number, b: number)");
			expect(name?.name).toBe("multiply");
			expect(name?.position.line).toBe(9);
			expect(name?.result?.signature).toContain("x: number, y: number");

			expect(missingName?.file).toBe(genericMethodFile);
			expect(missingName?.error?.code).toBe("SYMBOL_NOT_FOUND");
			expect(missingName?.position).toEqual({ line: 0, column: 0 });
			expect(missingText?.error?.code).toBe("SYMBOL_NOT_FOUND");
			expect(missingText?.error?.suggestion).toContain("Line 36 reads");
			expect(bad?.error?.code).toBe("INVALID_ARGUMENT");
			expect(gone?.error?.code).toBe("FILE_NOT_FOUND");
			expect(gone?.file).toBe(
				path.join(fixturesDir, "does-not-exist.ts"),
			);
		});
	}

	test("batch_hover reports items without any file per item", async () => {
		const response = await client.call("batch_hover", {
			positions: [
				{ line: 4, column: 17 },
				{ file: sampleFile, line: 4, column: 17 },
			],
		});
		const { result } = batchHoverSuccessSchema.parse(
			response.structuredContent,
		);
		expect(result.items[0]?.error?.code).toBe("INVALID_ARGUMENT");
		expect(result.items[1]?.result?.name).toBe("add");
	});

	test("batch_hover keeps the 100-item cap", async () => {
		const response = await client.call("batch_hover", {
			file: sampleFile,
			positions: Array.from({ length: 101 }, () => ({
				line: 4,
				column: 17,
			})),
		});
		expect(response.isError).toBe(true);
	});
});

describe("MCP server with PRINFER_INCLUDE_TIMING=1", () => {
	let timed: StdioMcpClient;

	beforeAll(async () => {
		timed = new StdioMcpClient({ PRINFER_INCLUDE_TIMING: "1" });
		await timed.initialize();
	});

	afterAll(() => timed?.close());

	test("adds timing to every hover tool", async () => {
		const hover = hoverSuccessSchema.parse(
			(
				await timed.call("hover", {
					file: sampleFile,
					line: 4,
					text: "add",
					backend: "typescript6",
				})
			).structuredContent,
		);
		expect(hover.result.timing?.resolution_ms).toBeGreaterThanOrEqual(0);

		const byName = hoverSuccessSchema.parse(
			(
				await timed.call("hover_by_name", {
					file: sampleFile,
					name: "multiply",
				})
			).structuredContent,
		);
		expect(byName.result.timing?.resolution_ms).toBeGreaterThanOrEqual(0);

		const batch = batchHoverSuccessSchema.parse(
			(
				await timed.call("batch_hover", {
					file: sampleFile,
					backend: "typescript6",
					positions: [{ line: 4, text: "add" }, { name: "multiply" }],
				})
			).structuredContent,
		);
		for (const item of batch.result.items) {
			expect(item.result?.timing?.resolution_ms).toBeGreaterThanOrEqual(
				0,
			);
		}
	});
});
