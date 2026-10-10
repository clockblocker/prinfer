import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ts from "typescript";
import { contractError } from "../contract.js";
import {
	alternativeDeclarations,
	formatCompletions,
	MAX_ALTERNATIVES,
} from "../core/index.js";
import { completions, hover } from "../index.js";
import {
	closeNativeApiSessions,
	nativeApiTypeInfoByName,
} from "../native-api.js";
import { closeNativeSessions, nativeHoverByName } from "../native-lsp.js";
import { closeTestingSessions, inferredTypeInfo } from "../testing.js";
import type { HoverResult } from "../types.js";

const fixture = path.join(import.meta.dir, "fixtures", "hover-parity.ts");
const objectKeys = path.join(import.meta.dir, "fixtures", "object-keys.ts");

afterAll(async () => {
	closeNativeSessions();
	await closeNativeApiSessions();
	await closeTestingSessions();
});

type Lookup = (
	name: string,
	options?: { line?: number; full?: boolean },
) => Promise<HoverResult>;

const backends: Array<[string, Lookup]> = [
	["typescript6", async (name, options) => hover(fixture, name, options)],
	[
		"typescript7 (language server)",
		(name, options) => nativeHoverByName(fixture, name, options),
	],
	[
		"typescript7 (testing API)",
		(name, options) => nativeApiTypeInfoByName(fixture, name, options),
	],
];

/**
 * Every backend, plus the testing API through the synchronous
 * prinfer/testing worker. That helper wraps lookup errors with its own
 * suggestions, so the error-shape tests below use `backends`.
 */
const lookups: Array<[string, Lookup]> = [
	...backends,
	[
		"typescript7 (prinfer/testing)",
		async (name, options) =>
			inferredTypeInfo(fixture, {
				name,
				line: options?.line,
				full: options?.full ?? false,
				backend: "typescript7",
			}),
	],
];

/** The fields every backend must agree on. */
function comparable(result: HoverResult) {
	return {
		signature: result.signature,
		returnType: result.returnType,
		kind: result.kind,
		name: result.name,
		line: result.line,
		column: result.column,
		overloads: result.overloads,
		unionMembers: result.unionMembers,
		alternatives: result.alternatives,
	};
}

// [name, line?, expected subset]
const cases: Array<[string, number | undefined, Partial<HoverResult>]> = [
	[
		"ParsedUnit",
		undefined,
		{
			signature:
				"type ParsedUnit<R extends UnitRoute = UnitRoute> = R extends unknown ? { route: R; value: number; } : never",
			kind: "type",
		},
	],
	[
		"Keyed",
		undefined,
		{ signature: 'Keyed<K extends string = "id">', kind: "interface" },
	],
	[
		"Store",
		undefined,
		{ signature: "Store<T extends object = object>", kind: "class" },
	],
	["size", undefined, { signature: "number", kind: "accessor" }],
	["Red", undefined, { signature: "Color.Red", kind: "enum member" }],
	[
		"parseUnit",
		undefined,
		{
			signature: "(input: string): number",
			kind: "function",
			returnType: "number",
			overloads: [
				"(input: string): number",
				"(input: number, radix: number): string",
			],
		},
	],
	[
		"parseUnit",
		32,
		{
			signature: "(input: string): number",
			kind: "call",
			overloads: [
				"(input: string): number",
				"(input: number, radix: number): string",
			],
		},
	],
	[
		"required",
		38,
		{
			signature: "<string>(value: string | undefined): string",
			kind: "call",
		},
	],
	[
		"toLabel",
		undefined,
		{
			signature: "(input: number) => string",
			kind: "const",
			returnType: "string",
		},
	],
	["toLabel", 41, { signature: "(input: number): string", kind: "call" }],
	["flag", undefined, { signature: "boolean", unionMembers: undefined }],
	["maybeFlag", undefined, { unionMembers: 2 }],
	["color", undefined, { signature: "Color | undefined", unionMembers: 2 }],
	["route", undefined, { signature: "UnitRoute | null", unionMembers: 3 }],
	[
		"map",
		undefined,
		{
			signature:
				"<number>(callbackfn: (value: number, index: number, array: number[]) => number, thisArg?: any): number[]",
			kind: "call",
		},
	],
	[
		"key",
		undefined,
		{
			line: 11,
			kind: "property",
			alternatives: [
				{ line: 50, column: 2, kind: "property" },
				{ line: 51, column: 12, kind: "property" },
				{ line: 53, column: 23, kind: "parameter" },
			],
		},
	],
	// Type parameter modifiers: `const`, `in`, `out`.
	[
		"Holder",
		undefined,
		{ signature: "Holder<const T extends 1 | 2>", kind: "class" },
	],
	["hold", undefined, { signature: "<const U>(item: U): U", kind: "method" }],
	[
		"holdAll",
		undefined,
		{
			signature: "<const T extends readonly unknown[]>(items: T): T",
			kind: "function",
		},
	],
	[
		"Sink",
		undefined,
		{ signature: "type Sink<in T> = (item: T) => void", kind: "type" },
	],
	[
		"Source",
		undefined,
		{ signature: "type Source<out T> = () => T", kind: "type" },
	],
	["Cell", undefined, { signature: "Cell<in out T>", kind: "interface" }],
	[
		"Channel",
		undefined,
		{ signature: "Channel<in out K, const V>", kind: "class" },
	],
];

describe("backends agree on the canonical hover result", () => {
	for (const [name, line, expected] of cases) {
		test(`${name}${line ? `:${line}` : ""}`, async () => {
			const results = await Promise.all(
				lookups.map(([, lookup]) => lookup(name, { line })),
			);
			const [first, ...rest] = results.map(comparable);
			expect(first).toMatchObject(expected);
			for (const other of rest) expect(other).toEqual(first as never);
			for (const result of results)
				expect(result.signature).not.toContain("\n");
		}, 30_000);
	}

	test("the language server keeps the editor's text in display", async () => {
		const result = await nativeHoverByName(fixture, "ParsedUnit");
		expect(result.display).toBe(
			"type ParsedUnit<R extends UnitRoute = UnitRoute> = R extends unknown ? {\n    route: R;\n    value: number;\n} : never",
		);
	});
});

describe("full turns off truncation on every backend", () => {
	for (const [backend, lookup] of lookups) {
		test(backend, async () => {
			const truncated = await lookup("Codes");
			expect(truncated.signature).toMatch(/\.\.\. \d+ more \.\.\./);
			expect(truncated.unionMembers).toBe(1000);
			const full = await lookup("Codes", { full: true });
			expect(full.signature).not.toContain("more");
			expect(full.signature.split(" | ")).toHaveLength(1000);
			expect(full.unionMembers).toBe(1000);
		}, 30_000);
	}

	test("full and truncated language-server hovers can overlap", async () => {
		const [full, truncated, fullAgain] = await Promise.all([
			nativeHoverByName(fixture, "Codes", { full: true }),
			nativeHoverByName(fixture, "Codes"),
			nativeHoverByName(fixture, "Codes", { full: true }),
		]);
		expect(full.signature).not.toContain("more");
		expect(fullAgain.signature).toBe(full.signature);
		expect(truncated.signature).toContain("more");
	}, 30_000);

	test("full agrees across backends", async () => {
		const signatures = await Promise.all(
			lookups.map(([, lookup]) =>
				lookup("Codes", { full: true }).then((r) => r.signature),
			),
		);
		expect(new Set(signatures).size).toBe(1);
	}, 30_000);
});

describe("a line hint that misses lists where the name is declared", () => {
	for (const [backend, lookup] of backends) {
		test(backend, async () => {
			const error = await lookup("key", { line: 58 }).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			const contract = contractError(error).error;
			expect(contract).toMatchObject({
				code: "SYMBOL_NOT_FOUND",
				suggestion:
					'"key" is declared on lines 11, 50, 51, 53; pass one of those as the line, or omit the line.',
				declaredAt: [
					{ line: 11, column: 2, kind: "property" },
					{ line: 50, column: 2, kind: "property" },
					{ line: 51, column: 12, kind: "property" },
					{ line: 53, column: 23, kind: "parameter" },
				],
			});
		}, 30_000);
	}

	test("a name used but not declared lists the lines it appears on", () => {
		const error = (() => {
			try {
				hover(fixture, "Error", { line: 3 });
			} catch (caught) {
				return caught;
			}
		})();
		expect(contractError(error).error.suggestion).toBe(
			'"Error" is not declared in this file but appears on line 35; pass one of those as the line, or omit the line.',
		);
	});

	test("a name that is nowhere keeps the default suggestion", () => {
		const error = (() => {
			try {
				hover(fixture, "nowhere", { line: 3 });
			} catch (caught) {
				return caught;
			}
		})();
		expect(contractError(error).error.declaredAt).toBeUndefined();
	});
});

test("alternatives and declaredAt read variable kinds on a fresh program", () => {
	// The first lookup in a new program runs before the checker binds it.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-kinds-"));
	const file = path.join(dir, "kinds.ts");
	fs.writeFileSync(
		file,
		"export function a() { const item = 1; return item; }\nexport function b() { let item = 2; return item; }\n",
	);
	expect(hover(file, "item").alternatives).toEqual([
		{ line: 2, column: 27, kind: "let" },
	]);

	const fresh = path.join(dir, "fresh.ts");
	fs.copyFileSync(file, fresh);
	let declaredAt: unknown;
	try {
		hover(fresh, "item", { line: 9 });
	} catch (error) {
		declaredAt = contractError(error).error.declaredAt;
	}
	expect(declaredAt).toEqual([
		{ line: 1, column: 29, kind: "const" },
		{ line: 2, column: 27, kind: "let" },
	]);
});

test("alternatives are capped and skip overloads of the picked symbol", () => {
	const source = ts.createSourceFile(
		"many.ts",
		[
			"function key(a: string): void;",
			"function key(a: number): void;",
			"function key(a: unknown) {}",
			...Array.from(
				{ length: 12 },
				(_, index) => `const o${index} = { key: ${index} };`,
			),
		].join("\n"),
		ts.ScriptTarget.Latest,
		true,
	);
	const picked = source.statements[0] as ts.Node;
	const alternatives = alternativeDeclarations(source, "key", picked);
	expect(alternatives).toHaveLength(MAX_ALTERNATIVES);
	expect(alternatives?.[0]).toEqual({
		line: 4,
		column: 14,
		kind: "property",
	});
});

describe("completions on an open object literal key", () => {
	const note =
		"Any key is accepted here; TypeScript knows no specific keys for this object literal.";

	for (const [label, line, column] of [
		["a Record<string, T> key", 4, 2],
		["a partly typed key", 4, 4],
		["a Record argument", 9, 12],
		["an untyped literal", 15, 24],
	] as const) {
		test(`${label} returns a note instead of globals`, () => {
			const result = completions(objectKeys, line, column);
			expect(result).toMatchObject({ entries: [], total: 0, note });
			expect(formatCompletions(result)).toBe(
				`No completion entries. ${note}`,
			);
		});
	}

	test("known keys are still listed", () => {
		const result = completions(objectKeys, 11, 2);
		expect(result.note).toBeUndefined();
		// TypeScript leaves out keys the literal already has, except this one.
		expect(result.entries.map((entry) => entry.name)).toEqual(["metric"]);
	});

	test("values are still completed", () => {
		const result = completions(objectKeys, 15, 32);
		expect(result.note).toBeUndefined();
		expect(result.entries.map((entry) => entry.name)).toContain("scale");
	});
});
