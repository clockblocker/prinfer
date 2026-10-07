import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	contractError,
	diagnosticsSuccess,
	diagnosticsSuccessSchema,
} from "../contract.js";
import { formatDiagnostics } from "../core/index.js";
import { diagnostics } from "../index.js";
import { closeNativeSessions, nativeDiagnostics } from "../native-lsp.js";
import type { DiagnosticsResult } from "../types.js";

const fixturesDir = path.join(import.meta.dir, "fixtures", "diagnostics");
const errorsFile = path.join(fixturesDir, "errors.ts");
const cleanFile = path.join(fixturesDir, "clean.ts");
const mcpEntry = path.join(import.meta.dir, "..", "mcp.ts");

const expectedErrors = [
	{ line: 3, column: 14, endLine: 3, endColumn: 19, code: 2322 },
	{ line: 6, column: 2, endLine: 6, endColumn: 8, code: 2322 },
	{ line: 9, column: 14, endLine: 9, endColumn: 21, code: 2322 },
];

const chainedMessage = [
	"Type '(event: { id: string; }) => void' is not assignable to type '(event: { id: number; }) => void'.",
	"  Types of parameters 'event' and 'event' are incompatible.",
	"    Type '{ id: number; }' is not assignable to type '{ id: string; }'.",
	"      Types of property 'id' are incompatible.",
	"        Type 'number' is not assignable to type 'string'.",
].join("\n");

afterAll(closeNativeSessions);

function positions(result: DiagnosticsResult) {
	return result.diagnostics.map(
		({ line, column, endLine, endColumn, code }) => ({
			line,
			column,
			endLine,
			endColumn,
			code,
		}),
	);
}

function tempProject(files: Record<string, string>): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-diagnostics-")),
	);
	fs.writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "bundler",
				types: [],
			},
		}),
	);
	for (const [name, text] of Object.entries(files)) {
		fs.writeFileSync(path.join(dir, name), text);
	}
	return dir;
}

const backends = [
	[
		"typescript6",
		async (file: string, options = {}) => diagnostics(file, options),
	],
	["typescript7", nativeDiagnostics],
] as const;

describe.each(backends)("diagnostics (%s)", (_name, check) => {
	test("reports errors with 1-based ranges and flattened chains", async () => {
		const result = await check(errorsFile);
		expect(result.file).toBe(errorsFile);
		expect(positions(result)).toEqual(expectedErrors);
		expect(result.errorCount).toBe(3);
		expect(result.warningCount).toBe(0);
		expect(result.diagnostics[0]).toMatchObject({
			category: "error",
			message: "Type 'string' is not assignable to type 'number'.",
			source: "ts",
		});
		expect(result.diagnostics[2]?.message).toBe(chainedMessage);
	});

	test("returns no diagnostics for a clean file", async () => {
		const result = await check(cleanFile);
		expect(result).toEqual({
			file: cleanFile,
			diagnostics: [],
			errorCount: 0,
			warningCount: 0,
		});
	});

	test("includes suggestions only when requested", async () => {
		const result = await check(errorsFile, { include_suggestions: true });
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				line: 17,
				column: 8,
				code: 6133,
				category: "suggestion",
			}),
		);
		expect(result.errorCount).toBe(3);
	});

	test("rejects a missing file with a FILE_NOT_FOUND contract error", async () => {
		const missing = path.join(fixturesDir, "missing.ts");
		const error = await Promise.resolve()
			.then(() => check(missing))
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);
		expect(String(error)).toContain(`File not found: ${missing}`);
		expect(contractError(error).error.code).toBe("FILE_NOT_FOUND");
	});
});

describe.each(backends)("diagnostics freshness (%s)", (_name, check) => {
	let dir: string;
	beforeEach(() => {
		dir = tempProject({
			"dep.ts": "export const value: number = 1;\n",
			"main.ts":
				'import { value } from "./dep";\nexport const total: number = value;\n',
		});
	});

	test("picks up edits to the checked file", async () => {
		const main = path.join(dir, "main.ts");
		expect((await check(main)).errorCount).toBe(0);
		fs.writeFileSync(main, "export const total: number = ;\n");
		const broken = await check(main);
		expect(positions(broken)).toEqual([
			{ line: 1, column: 30, endLine: 1, endColumn: 31, code: 1109 },
		]);
		fs.writeFileSync(main, "export const total = 2;\n");
		expect((await check(main)).errorCount).toBe(0);
	});

	test("picks up edits to an imported file immediately", async () => {
		const main = path.join(dir, "main.ts");
		const dep = path.join(dir, "dep.ts");
		expect((await check(main)).errorCount).toBe(0);
		// Check the dependency too, so the native client holds it open.
		expect((await check(dep)).errorCount).toBe(0);
		fs.writeFileSync(dep, 'export const value: string = "one";\n');
		expect(positions(await check(main))).toEqual([
			{ line: 2, column: 14, endLine: 2, endColumn: 19, code: 2322 },
		]);
	});

	test("picks up newly created and unopened imported files", async () => {
		const main = path.join(dir, "main.ts");
		expect((await check(main)).errorCount).toBe(0);
		fs.writeFileSync(
			main,
			'import { extra } from "./extra";\nexport const total: number = extra;\n',
		);
		expect((await check(main)).diagnostics[0]?.code).toBe(2307);
		fs.writeFileSync(
			path.join(dir, "extra.ts"),
			"export const extra = 1;\n",
		);
		expect((await check(main)).errorCount).toBe(0);
		fs.writeFileSync(
			path.join(dir, "extra.ts"),
			'export const extra = "x";\n',
		);
		expect((await check(main)).diagnostics[0]?.code).toBe(2322);
	});
});

describe("diagnostics contract and formatting", () => {
	test("validates diagnostics success responses", () => {
		const response = diagnosticsSuccess(diagnostics(errorsFile));
		expect(diagnosticsSuccessSchema.parse(response)).toEqual(response);
		expect(response).toMatchObject({ version: 1, ok: true });
	});

	test("rejects unknown categories", () => {
		expect(() =>
			diagnosticsSuccess({
				file: "/tmp/a.ts",
				diagnostics: [
					{
						line: 1,
						column: 1,
						endLine: 1,
						endColumn: 2,
						code: 2322,
						category: "fatal",
						message: "nope",
					},
				],
				errorCount: 1,
				warningCount: 0,
			}),
		).toThrow();
	});

	test("formats tsc-style lines with indented message chains", () => {
		const text = formatDiagnostics(diagnostics(errorsFile), "errors.ts");
		expect(text.split("\n").slice(0, 3)).toEqual([
			"errors.ts:3:14 error TS2322: Type 'string' is not assignable to type 'number'.",
			"errors.ts:6:2 error TS2322: Type 'number' is not assignable to type 'string'.",
			"errors.ts:9:14 error TS2322: Type '(event: { id: string; }) => void' is not assignable to type '(event: { id: number; }) => void'.",
		]);
		// tsc's own layout: the chain is nested two spaces per level.
		expect(text.split("\n").slice(3, 7)).toEqual([
			"  Types of parameters 'event' and 'event' are incompatible.",
			"    Type '{ id: number; }' is not assignable to type '{ id: string; }'.",
			"      Types of property 'id' are incompatible.",
			"        Type 'number' is not assignable to type 'string'.",
		]);
		expect(text.endsWith("3 errors, 0 warnings.")).toBe(true);
		expect(formatDiagnostics(diagnostics(cleanFile))).toBe(
			"No type errors.",
		);
	});

	test("formats message chains identically on both backends", async () => {
		const ts6 = formatDiagnostics(diagnostics(errorsFile), "errors.ts");
		const ts7 = formatDiagnostics(
			await nativeDiagnostics(errorsFile),
			"errors.ts",
		);
		expect(ts7).toBe(ts6);
	});

	test("normalizes continuation indentation to two spaces", () => {
		const result = (message: string): DiagnosticsResult => ({
			file: "/tmp/a.ts",
			diagnostics: [
				{
					line: 1,
					column: 1,
					endLine: 1,
					endColumn: 2,
					code: 2322,
					category: "error",
					message,
				},
			],
			errorCount: 1,
			warningCount: 0,
		});
		const expected = [
			"a.ts:1:1 error TS2322: Head.",
			"  Level one.",
			"    Level two.",
			"1 error, 0 warnings.",
		].join("\n");
		for (const message of [
			"Head.\n  Level one.\n    Level two.",
			"Head.\n      Level one.\n        Level two.",
			"Head.\nLevel one.\n  Level two.",
			"Head.\r\n  Level one.\r\n\n    Level two.",
		]) {
			expect(formatDiagnostics(result(message), "a.ts")).toBe(expected);
		}
	});
});

describe("diagnostics MCP tool", () => {
	test("returns text and structured content over stdio", async () => {
		const child = spawn(process.execPath, [mcpEntry], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const responses = new Map<number, (message: unknown) => void>();
		let buffer = "";
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) {
					const message = JSON.parse(line) as { id?: number };
					if (message.id !== undefined)
						responses.get(message.id)?.(message);
				}
				newline = buffer.indexOf("\n");
			}
		});
		let nextId = 1;
		const request = (method: string, params: unknown) =>
			new Promise<{
				result: {
					tools?: Array<{ name: string; description: string }>;
					content?: Array<{ text: string }>;
					structuredContent?: unknown;
					isError?: boolean;
				};
			}>((resolve) => {
				const id = nextId++;
				responses.set(id, resolve as (message: unknown) => void);
				child.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				);
			});

		try {
			await request("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "prinfer-test", version: "0.0.0" },
			});
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
			);
			const tools = await request("tools/list", {});
			expect(
				tools.result.tools?.find((tool) => tool.name === "diagnostics")
					?.description,
			).toContain("type errors");

			const call = (args: Record<string, unknown>) =>
				request("tools/call", { name: "diagnostics", arguments: args });

			for (const backend of ["typescript6", "typescript7"]) {
				const errors = await call({ file: errorsFile, backend });
				expect(errors.result.isError).toBeFalsy();
				expect(errors.result.content?.[0]?.text).toStartWith(
					`${errorsFile}:3:14 error TS2322: `,
				);
				expect(
					diagnosticsSuccessSchema.parse(
						errors.result.structuredContent,
					).result.errorCount,
				).toBe(3);

				const clean = await call({ file: cleanFile, backend });
				expect(clean.result.content?.[0]?.text).toBe("No type errors.");
			}

			const missing = await call({
				file: path.join(fixturesDir, "missing.ts"),
			});
			expect(missing.result.isError).toBe(true);
			expect(missing.result.structuredContent).toMatchObject({
				ok: false,
				error: { code: "FILE_NOT_FOUND" },
			});
		} finally {
			child.kill();
		}
	}, 30_000);
});
