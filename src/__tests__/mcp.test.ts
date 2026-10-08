import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";
import { nearbyCandidates } from "../candidates.js";
import {
	batchHoverSuccessSchema,
	contractError,
	contractErrorResponseSchema,
	hoverSuccessSchema,
	suggestionFor,
} from "../contract.js";
import { ensureFreshBuild, packageRoot } from "./helpers/build.js";

// Server round trips spawn TypeScript; leave room for a loaded machine.
setDefaultTimeout(30_000);

// Drives the built server over stdio, exactly as an MCP client would.
const serverPath = path.join(packageRoot, "dist", "mcp.js");
const fixturesDir = path.join(import.meta.dir, "fixtures");
const sampleFile = path.join(fixturesDir, "sample.ts");
const genericMethodFile = path.join(fixturesDir, "generic-method.ts");
const diagnosticsDir = path.join(fixturesDir, "diagnostics");
const completionsFile = path.join(fixturesDir, "completions.ts");
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
			outputSchema?: Record<string, unknown>;
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

	/** Disconnect like a client would: close stdin and wait for the exit code. */
	disconnect(): Promise<number | null> {
		const exited = new Promise<number | null>((resolve) =>
			this.child.once("exit", (code) => resolve(code)),
		);
		this.child.stdin?.end();
		return exited;
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

let client: StdioMcpClient;

beforeAll(async () => {
	ensureFreshBuild();
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

	test("exits once the client disconnects, even with a warm TypeScript 7 session", async () => {
		const transient = new StdioMcpClient();
		await transient.initialize();
		const result = await transient.call("hover_by_name", {
			file: sampleFile,
			name: "add",
			backend: "typescript7",
		});
		expect(result.isError).toBeFalsy();
		const timeout = new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), 10_000),
		);
		const outcome = await Promise.race([transient.disconnect(), timeout]);
		if (outcome === "timeout") transient.close();
		expect(outcome).toBe(0);
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

	for (const backend of ["typescript6", "typescript7"] as const) {
		test(`batch_hover keeps valid items when one file is a directory (${backend})`, async () => {
			const response = await client.call("batch_hover", {
				file: sampleFile,
				backend,
				positions: [
					{ name: "add" },
					{ file: diagnosticsDir, line: 1, column: 1 },
					{ file: diagnosticsDir, name: "add" },
				],
			});
			expect(response.isError).toBeUndefined();
			const { result } = batchHoverSuccessSchema.parse(
				response.structuredContent,
			);
			expect(result.successCount).toBe(1);
			expect(result.items[0]?.result?.signature).toContain(
				"(a: number, b: number)",
			);
			for (const item of result.items.slice(1)) {
				expect(item.error?.code).toBe("FILE_NOT_FOUND");
				expect(item.error?.message).toContain("is a directory");
			}
		});
	}

	test("single-file tools report a directory as FILE_NOT_FOUND", async () => {
		for (const [tool, args] of [
			["hover", { file: diagnosticsDir, line: 1, column: 1 }],
			["hover", { file: diagnosticsDir, line: 1, text: "x" }],
			["hover_by_name", { file: diagnosticsDir, name: "add" }],
			["completions", { file: diagnosticsDir, line: 1, column: 1 }],
			["diagnostics", { file: diagnosticsDir }],
		] as const) {
			const response = await client.call(tool, args);
			expect(response.isError).toBe(true);
			const { error } = contractErrorResponseSchema.parse(
				response.structuredContent,
			);
			expect(error.code).toBe("FILE_NOT_FOUND");
			expect(error.file).toBe(diagnosticsDir);
		}
	});

	test("hover_by_name suggests close names and tool-specific next steps", async () => {
		for (const backend of ["typescript6", "typescript7"] as const) {
			const response = await client.call("hover_by_name", {
				file: sampleFile,
				name: "formt",
				backend,
			});
			const { error } = contractErrorResponseSchema.parse(
				response.structuredContent,
			);
			expect(error.code).toBe("SYMBOL_NOT_FOUND");
			expect(error.candidates).toEqual(["format"]);
			expect(error.suggestion).not.toContain("hover_by_name");
			expect(error.suggestion).toContain("candidates");
			expect(error.suggestion).toContain("line");
			expect(error.suggestion).toContain("hover with");
		}
	});

	test("hover misses suggest text targeting or hover_by_name", async () => {
		const response = await client.call("hover", {
			file: sampleFile,
			line: 1,
			column: 5,
			backend: "typescript6",
		});
		const { error } = contractErrorResponseSchema.parse(
			response.structuredContent,
		);
		expect(error.code).toBe("SYMBOL_NOT_FOUND");
		expect(error.suggestion).toContain("text copied from the line");
		expect(error.suggestion).toContain("hover_by_name");
	});

	for (const backend of ["typescript6", "typescript7"] as const) {
		test(`hover rejects positions outside the file with the valid range (${backend})`, async () => {
			for (const [args, suggestion] of [
				[{ line: 1000, column: 1 }, "Use a line between 1 and 45."],
				[
					{ line: 4, column: 90 },
					"Line 4 has 51 characters; use a column between 1 and 52.",
				],
			] as const) {
				const response = await client.call("hover", {
					file: sampleFile,
					...args,
					backend,
				});
				expect(response.isError).toBe(true);
				const { error } = contractErrorResponseSchema.parse(
					response.structuredContent,
				);
				expect(error).toMatchObject({
					code: "INVALID_ARGUMENT",
					suggestion,
				});
				expect(response.content[0]?.text).toContain(
					`Suggestion: ${suggestion}`,
				);
			}
		});
	}

	test("error text repeats candidates and the suggestion", async () => {
		const response = await client.call("hover_by_name", {
			file: sampleFile,
			name: "formt",
			backend: "typescript6",
		});
		const lines = response.content[0]?.text.split("\n") ?? [];
		expect(lines[0]).toStartWith(
			'Error [SYMBOL_NOT_FOUND]: No symbol named "formt"',
		);
		expect(lines[1]).toBe("Did you mean: format?");
		expect(lines[2]).toStartWith("Suggestion: Check the spelling");
		expect(lines).toHaveLength(3);

		const batch = await client.call("batch_hover", {
			file: sampleFile,
			positions: [{ name: "formt" }, { line: 3, column: 5 }],
			backend: "typescript6",
		});
		const text = batch.content[0]?.text ?? "";
		expect(text).toContain("Did you mean: format?");
		expect(text).toContain("Nearby identifiers:");
	});

	test("completions returns the top entries and says how many were cut", async () => {
		const response = await client.call("completions", {
			file: completionsFile,
			line: 2,
			column: 1,
		});
		expect(response.isError).toBeUndefined();
		const { result } = z
			.object({
				result: z.object({
					entries: z.array(z.object({ name: z.string() })),
					total: z.number(),
					truncated: z.boolean(),
				}),
			})
			.parse(response.structuredContent);
		expect(result.entries).toHaveLength(50);
		expect(result.truncated).toBe(true);
		expect(result.total).toBeGreaterThan(50);
		const lines = response.content[0]?.text.split("\n") ?? [];
		expect(lines).toHaveLength(51);
		expect(lines[50]).toBe(
			`… ${result.total - 50} more; pass prefix to narrow, or raise limit`,
		);

		const limited = await client.call("completions", {
			file: completionsFile,
			line: 2,
			column: 1,
			limit: 3,
		});
		expect(limited.content[0]?.text.split("\n")).toHaveLength(4);
	});

	test("completions filters by prefix, given or typed left of the cursor", async () => {
		const names = async (args: Record<string, unknown>) =>
			(
				await client.call("completions", {
					file: completionsFile,
					...args,
				})
			).content[0]?.text.split("\n");
		expect(await names({ line: 3, column: 33, prefix: "TE" })).toEqual([
			"tea",
		]);
		// Typed "t" inside the string, and "sel" of an identifier.
		expect(await names({ line: 10, column: 33 })).toEqual(["tea"]);
		expect((await names({ line: 11, column: 25 }))?.[0]).toBe("selected");
		// An empty prefix turns the typed-text filter off.
		expect(await names({ line: 10, column: 33, prefix: "" })).toEqual([
			"coffee",
			"tea",
		]);
		expect(await names({ line: 3, column: 33, prefix: "zz" })).toEqual([
			'No completion entries matching prefix "zz". Pass prefix "" to list every entry.',
		]);
	});

	test("advertises compact schemas that accept both outcomes", async () => {
		const tools = await client.listTools();
		const listed = JSON.stringify(tools);
		for (const noise of [
			String(Number.MAX_SAFE_INTEGER),
			"exclusiveMinimum",
			"$schema",
			"additionalProperties",
		]) {
			expect(listed).not.toContain(noise);
		}
		// tools/list was ~15K characters before the schemas were compacted;
		// the hover fields display, overloads, unionMembers, and
		// alternatives added ~300.
		expect(listed.length).toBeLessThan(13_000);

		const outputSchema = (name: string) => {
			const tool = tools.find((candidate) => candidate.name === name);
			return z.fromJSONSchema(tool?.outputSchema as never);
		};
		const outcomes = [
			["hover_by_name", { file: sampleFile, name: "add" }],
			["hover_by_name", { file: sampleFile, name: "formt" }],
			["hover", { file: sampleFile, line: 1000, column: 1 }],
			[
				"batch_hover",
				{
					file: sampleFile,
					positions: [{ name: "add" }, { name: "formt" }],
				},
			],
			["batch_hover", { positions: [{ line: 1, column: 1 }] }],
			["completions", { file: completionsFile, line: 3, column: 33 }],
			["completions", { file: "missing.ts", line: 1, column: 1 }],
			["diagnostics", { file: sampleFile, backend: "typescript6" }],
			["diagnostics", { file: "missing.ts" }],
		] as const;
		for (const [name, args] of outcomes) {
			const response = await client.call(name, args);
			const parsed = outputSchema(name).safeParse(
				response.structuredContent,
			);
			expect({ name, args, success: parsed.success }).toEqual({
				name,
				args,
				success: true,
			});
		}
	});

	test("file errors name the server's working directory", async () => {
		const response = await client.call("diagnostics", {
			file: "missing.ts",
		});
		const { error } = contractErrorResponseSchema.parse(
			response.structuredContent,
		);
		expect(error.code).toBe("FILE_NOT_FOUND");
		expect(error.suggestion).toContain(
			`MCP server's working directory (${fixturesDir})`,
		);
	});
});

describe("nearbyCandidates", () => {
	let dir: string;
	let file: string;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-candidates-"));
		file = path.join(dir, "format.ts");
		fs.writeFileSync(
			file,
			[
				"// Formats a value with fixed decimals, one of many helpers",
				'const label = "formt of the value";',
				"export function format(value: number): string {",
				"\treturn value.toFixed(2);",
				"}",
				"for (const item of [1]) format(item);",
				"/** formatter docs */",
				"export const formatter = { label };",
				"",
			].join("\n"),
		);
	});

	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	test("skips keywords and words in comments and strings", () => {
		expect(
			nearbyCandidates(file, { query: "formt", strict: true }),
		).toEqual(["format"]);
		const near = nearbyCandidates(file, { line: 1 }) ?? [];
		for (const word of ["Formats", "fixed", "const", "of", "for"]) {
			expect(near).not.toContain(word);
		}
		expect(near).toContain("label");
	});

	test("ranks by edit distance and drops distant names", () => {
		expect(
			nearbyCandidates(file, { query: "lable", strict: true }),
		).toEqual(["label"]);
		expect(
			nearbyCandidates(file, { query: "zzzzzz", strict: true }),
		).toBeUndefined();
	});

	test("never throws for directories or unreadable paths", () => {
		expect(nearbyCandidates(dir, { query: "format" })).toBeUndefined();
		expect(
			nearbyCandidates(path.join(dir, "missing.ts"), { line: 1 }),
		).toBeUndefined();
	});
});

describe("contract suggestions", () => {
	test("are specific to the MCP tool", () => {
		expect(
			suggestionFor("SYMBOL_NOT_FOUND", {
				interface: "mcp",
				tool: "hover_by_name",
			}),
		).not.toContain("hover_by_name");
		expect(
			suggestionFor("INVALID_ARGUMENT", {
				interface: "mcp",
				tool: "hover",
			}),
		).not.toContain("batch");
		expect(
			suggestionFor("INVALID_ARGUMENT", {
				interface: "mcp",
				tool: "batch_hover",
			}),
		).toContain("100 items");
		expect(
			suggestionFor("TYPESCRIPT_ERROR", {
				interface: "mcp",
				tool: "completions",
			}),
		).not.toContain("backend");
	});

	test("use CLI wording on the CLI", () => {
		for (const code of [
			"INVALID_ARGUMENT",
			"FILE_NOT_FOUND",
			"SYMBOL_NOT_FOUND",
			"TYPESCRIPT_ERROR",
			"INTERNAL_ERROR",
		] as const) {
			for (const command of [
				"name",
				"position",
				"complete",
				"check",
				undefined,
			] as const) {
				const text = suggestionFor(code, { interface: "cli", command });
				expect(text).not.toMatch(/MCP|batch|hover_by_name|backend "/);
			}
		}
	});

	test("default to MCP wording for library callers", () => {
		const response = contractError(
			new Error("No symbol found at a.ts:1:1"),
		);
		expect(response.error.suggestion).toContain("hover_by_name");
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
