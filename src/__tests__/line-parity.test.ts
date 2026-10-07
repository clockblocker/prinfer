import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	fromLspPosition,
	lineStarts,
	resolveTextColumn,
	splitLines,
	toLspPosition,
} from "../core/index.js";
import { diagnostics, hover } from "../index.js";
import {
	closeNativeSessions,
	nativeDiagnostics,
	nativeHover,
	nativeHoverByName,
} from "../native-lsp.js";

afterAll(closeNativeSessions);

const BOM = "\uFEFF";
const LS = "\u2028";
const PS = "\u2029";

// TypeScript's lines: 1 bom, 2 cr, 3 ls, 4 ps, 5 crlf, 6 lf.
const source = [
	`${BOM}export const bom: number = "x";\r`,
	`export const cr: number = "x";${LS}`,
	`export const ls: number = "x";${PS}`,
	'export const ps: number = "x";\r\n',
	'export const crlf: number = "x";\n',
	'export const lf: number = "x";\n',
].join("");

function project(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-lines-")),
	);
	fs.writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { strict: true, types: [] } }),
	);
	fs.writeFileSync(path.join(dir, "breaks.ts"), source);
	return dir;
}

const file = path.join(project(), "breaks.ts");
const names = ["bom", "cr", "ls", "ps", "crlf", "lf"];
const expectedErrors = names.map((name, index) => ({
	line: index + 1,
	column: 14,
	endColumn: 14 + name.length,
}));

describe("line helpers", () => {
	test("split and count lines like TypeScript", () => {
		expect(splitLines("a\rb\u2028c\u2029d\r\ne\nf")).toEqual([
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
		]);
		expect(lineStarts("a\r\nb\u2028c")).toEqual([0, 3, 5]);
		expect(lineStarts("a\r\nb\u2028c", true)).toEqual([0, 3]);
	});

	test("convert between TypeScript and LSP positions", () => {
		const text = "a\u2028bc\nd";
		expect(toLspPosition(text, { line: 1, character: 1 })).toEqual({
			line: 0,
			character: 3,
		});
		expect(fromLspPosition(text, { line: 0, character: 3 })).toEqual({
			line: 1,
			character: 1,
		});
		expect(toLspPosition(text, { line: 2, character: 0 })).toEqual({
			line: 1,
			character: 0,
		});
	});
});

describe.each([
	["typescript6", async (target: string) => diagnostics(target)],
	["typescript7", (target: string) => nativeDiagnostics(target)],
] as const)("line and column parity (%s)", (backend, check) => {
	test("diagnostics count CR, U+2028, and U+2029 as line breaks and ignore the BOM", async () => {
		const result = await check(file);
		expect(
			result.diagnostics.map(({ line, column, endColumn }) => ({
				line,
				column,
				endColumn,
			})),
		).toEqual(expectedErrors);
	}, 30_000);

	test("hover by text resolves to the same token on every line", async () => {
		for (const [index, name] of names.entries()) {
			const line = index + 1;
			const column = resolveTextColumn(source, { line, text: name });
			expect(column).toBe(14);
			const result =
				backend === "typescript6"
					? hover(file, line, column)
					: await nativeHover(file, line, column);
			expect({
				name: result.name,
				line: result.line,
				column: result.column,
			}).toEqual({ name, line, column: 14 });
		}
	}, 30_000);

	test("hover by name reports TypeScript lines", async () => {
		const result =
			backend === "typescript6"
				? hover(file, "ps")
				: await nativeHoverByName(file, "ps");
		expect({ line: result.line, column: result.column }).toEqual({
			line: 4,
			column: 14,
		});
	}, 30_000);
});
