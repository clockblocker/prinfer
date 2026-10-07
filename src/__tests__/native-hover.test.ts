import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveTextColumn } from "../core/index.js";
import { hover } from "../index.js";
import {
	closeNativeSessions,
	nativeHover,
	nativeHoverByName,
	parseHoverMarkdown,
} from "../native-lsp.js";

const kindsFile = path.join(import.meta.dir, "fixtures", "hover-kinds.ts");
const kindsText = fs.readFileSync(kindsFile, "utf8");

afterAll(closeNativeSessions);

function block(signature: string, docs = ""): string {
	return `\`\`\`typescript\n${signature}\n\`\`\`\n${docs}`;
}

describe("parseHoverMarkdown (TypeScript 7 hover output)", () => {
	// Signatures below are verbatim TypeScript 7.0 hover output.
	const cases: Array<
		[string, { kind: string; name?: string; returnType?: string }]
	> = [
		[
			"function add(a: number, b: number): number",
			{ kind: "function", name: "add", returnType: "number" },
		],
		[
			"(method) Array<string>.map<number>(callbackfn: (value: string, index: number, array: string[]) => number, thisArg?: any): number[]",
			{ kind: "method", name: "map", returnType: "number[]" },
		],
		[
			"(method) Array<{ id: number; name: string; }>.map<{\n    id: number;\n    label: string;\n}>(callbackfn: (value: {\n    id: number;\n    name: string;\n}, index: number, array: {\n    id: number;\n    name: string;\n}[]) => {\n    id: number;\n    label: string;\n}, thisArg?: any): {\n    id: number;\n    label: string;\n}[]",
			{
				kind: "method",
				name: "map",
				returnType: "{\n    id: number;\n    label: string;\n}[]",
			},
		],
		[
			"(method) Promise<number>.then<number, never>(onfulfilled?: ((value: number) => number | PromiseLike<number>) | null | undefined, onrejected?: ((reason: any) => PromiseLike<never>) | null | undefined): Promise<number>",
			{ kind: "method", name: "then", returnType: "Promise<number>" },
		],
		[
			"(method) Box<T>.make<U>(v: U): Box<U>",
			{ kind: "method", name: "make", returnType: "Box<U>" },
		],
		[
			'function generic<User, "id">(obj: User, key: "id"): number',
			{ kind: "function", name: "generic", returnType: "number" },
		],
		[
			"(alias) function helper<1>(x: 1): 1",
			{ kind: "function", name: "helper", returnType: "1" },
		],
		[
			"constructor K(x: number): K",
			{ kind: "constructor", name: "K", returnType: "K" },
		],
		["(parameter) a: number", { kind: "parameter", name: "a" }],
		[
			"(parameter) person: {\n    id: number;\n    name: string;\n}",
			{ kind: "parameter", name: "person" },
		],
		["(property) Box<T>.value: T", { kind: "property", name: "value" }],
		["(property) type: string", { kind: "property", name: "type" }],
		["(accessor) K.size: number", { kind: "accessor", name: "size" }],
		["const names: string[]", { kind: "const", name: "names" }],
		["(alias) const value: 1", { kind: "const", name: "value" }],
		["let mutable: number", { kind: "let", name: "mutable" }],
		[
			"const arrow: <T>(x: T) => Promise<T[]>",
			{ kind: "const", name: "arrow", returnType: "Promise<T[]>" },
		],
		[
			"const cb: (fn: (x: number) => string) => ((y: string) => number)",
			{
				kind: "const",
				name: "cb",
				returnType: "((y: string) => number)",
			},
		],
		[
			"const maybe: ((x: number) => string) | undefined",
			{ kind: "const", name: "maybe" },
		],
		[
			"type Pair<T> = {\n    left: T;\n    right: T;\n}",
			{ kind: "type", name: "Pair" },
		],
		["interface User", { kind: "interface", name: "User" }],
		["class Box<T>", { kind: "class", name: "Box" }],
		["enum Color", { kind: "enum", name: "Color" }],
		["(enum member) Color.Red = 0", { kind: "enum member", name: "Red" }],
		["namespace NS", { kind: "namespace", name: "NS" }],
		[
			"function over(x: string): string (+1 overload)",
			{ kind: "function", name: "over", returnType: "string" },
		],
	];

	for (const [signature, expected] of cases) {
		test(signature.split("\n", 1)[0] ?? signature, () => {
			const parsed = parseHoverMarkdown(block(signature));
			expect(parsed.signature).toBe(signature);
			expect(parsed.documentation).toBeUndefined();
			expect({
				kind: parsed.kind,
				name: parsed.name,
				returnType: parsed.returnType,
			}).toEqual({
				kind: expected.kind,
				name: expected.name,
				returnType: expected.returnType,
			});
		});
	}

	test("keeps documentation after the code block", () => {
		const parsed = parseHoverMarkdown(
			block(
				"(method) Array<string>.map<number>(callbackfn: (value: string) => number): number[]",
				"Calls a defined callback function.\n\n*@param* `callbackfn` — A function.",
			),
		);
		expect(parsed.returnType).toBe("number[]");
		expect(parsed.documentation).toBe(
			"Calls a defined callback function.\n\n*@param* `callbackfn` — A function.",
		);
	});
});

describe("TypeScript 7 hover kinds (live)", () => {
	const at = (line: number, text: string) =>
		nativeHover(
			kindsFile,
			line,
			resolveTextColumn(kindsText, { line, text }),
		);

	test("function", async () => {
		expect(await at(1, "add")).toMatchObject({
			signature: "function add(a: number, b: number): number",
			kind: "function",
			name: "add",
			returnType: "number",
		});
	});

	test("overloaded function, at a declaration and at a call", async () => {
		expect(await at(5, "pick")).toMatchObject({
			kind: "function",
			name: "pick",
			returnType: "string",
		});
		expect(await at(10, "pick")).toMatchObject({
			signature: "function pick(value: number): number",
			name: "pick",
			returnType: "number",
		});
	});

	test("method", async () => {
		expect(await at(27, "get")).toMatchObject({
			signature: "(method) Box<T>.get(): T",
			kind: "method",
			name: "get",
			returnType: "T",
		});
	});

	test("generic method with a one-line signature", async () => {
		expect(await at(13, "map")).toMatchObject({
			kind: "method",
			name: "map",
			returnType: "number[]",
		});
	});

	test("generic method with a multi-line signature", async () => {
		const result = await at(33, "map");
		expect(result.signature).toContain("\n");
		expect(result).toMatchObject({
			kind: "method",
			name: "map",
			returnType: "{\n    id: number;\n    label: string;\n}[]",
		});
	});

	test("parameter", async () => {
		const result = await at(33, "person");
		expect(result).toMatchObject({ kind: "parameter", name: "person" });
		expect(result.returnType).toBeUndefined();
	});

	test("property", async () => {
		expect(await at(38, "name")).toMatchObject({
			signature: "(property) User.name: string",
			kind: "property",
			name: "name",
		});
	});

	test("const, including one holding a curried function", async () => {
		expect(await at(12, "names")).toMatchObject({
			signature: "const names: string[]",
			kind: "const",
			name: "names",
		});
		expect(await at(41, "scale")).toMatchObject({
			kind: "const",
			name: "scale",
			returnType: "(value: number) => number",
		});
	});

	test("type alias, interface, and class", async () => {
		expect(await at(15, "Pair")).toMatchObject({
			kind: "type",
			name: "Pair",
		});
		expect(await at(17, "User")).toMatchObject({
			signature: "interface User",
			kind: "interface",
			name: "User",
		});
		expect(await at(22, "Box")).toMatchObject({
			signature: "class Box<T>",
			kind: "class",
			name: "Box",
		});
	});
});

describe("hover_by_name backend parity", () => {
	const backends = [
		[
			"typescript6",
			async (name: string, line?: number) =>
				hover(kindsFile, name, { line }),
		],
		[
			"typescript7",
			(name: string, line?: number) =>
				nativeHoverByName(kindsFile, name, { line }),
		],
	] as const;

	// [name, line?, expected line, expected column]
	const lookups: Array<[string, number | undefined, number, number]> = [
		// Exported declarations report the name token, not `export`.
		["add", undefined, 1, 17],
		["Box", undefined, 22, 14],
		["User", undefined, 17, 18],
		// Parameters, including ones only named in a callback.
		["person", undefined, 33, 35],
		["factor", undefined, 41, 23],
		["name", 13, 13, 35],
		// The comment and string on lines 39-40 never match.
		["labels", undefined, 33, 14],
	];

	describe.each(backends)("%s", (_backend, lookup) => {
		for (const [name, line, expectedLine, expectedColumn] of lookups) {
			test(`${name}${line ? ` on line ${line}` : ""}`, async () => {
				const result = await lookup(name, line);
				expect({ line: result.line, column: result.column }).toEqual({
					line: expectedLine,
					column: expectedColumn,
				});
				expect(result.name).toBe(name);
			}, 30_000);
		}

		test("finds parameters by name", async () => {
			expect((await lookup("factor")).kind).toBe("parameter");
		}, 30_000);

		test("ignores names that only appear in comments or strings", async () => {
			const fixture = path.join(
				import.meta.dir,
				"fixtures",
				"comment-only.ts",
			);
			const error = await Promise.resolve()
				.then(() =>
					_backend === "typescript6"
						? hover(fixture, "ghost")
						: nativeHoverByName(fixture, "ghost"),
				)
				.then(
					() => undefined,
					(caught: unknown) => caught,
				);
			expect(String(error)).toContain('No symbol named "ghost"');

			const spook =
				_backend === "typescript6"
					? hover(fixture, "spook")
					: await nativeHoverByName(fixture, "spook");
			expect({ line: spook.line, column: spook.column }).toEqual({
				line: 8,
				column: 14,
			});
		}, 30_000);
	});
});
