import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { typeReadabilityIssues } from "../core/readability.js";
import {
	optionalSlots,
	withTypeParameterModifiers,
} from "../core/signature-text.js";
import { type TypeScript, withTypeScript } from "../core/ts-runtime.js";
import { sortUnionMembers } from "../core/union-order.js";
import { hover } from "../index.js";
import { closeNativeSessions, nativeHoverByName } from "../native-lsp.js";
import { closeTestingSessions, inferredType } from "../testing.js";

// The first lookup per backend loads a compiler program.
setDefaultTimeout(30_000);

describe("sortUnionMembers", () => {
	test("parses with the bundled TypeScript whichever compiler is active", () => {
		// A project's TypeScript 5.0 numbers syntax kinds differently and
		// has no scanner.getTokenStart: printed text must not reach it.
		const project = new Proxy({} as TypeScript, {
			get(_, key) {
				throw new Error(`read the active TypeScript's ${String(key)}`);
			},
		});
		withTypeScript(project, () => {
			expect(sortUnionMembers('"b" | "a" | null')).toBe(
				'"a" | "b" | null',
			);
			expect(
				typeReadabilityIssues('Omit<User, "id">').map(
					(issue) => issue.rule,
				),
			).toEqual(["utility-type"]);
			expect(
				optionalSlots("<T>(a?: T | undefined) => void", "signature"),
			).toHaveLength(1);
			expect(
				withTypeParameterModifiers("type Box<T> = { value: T; }", [
					{ name: "T", modifiers: ["const"] },
				]),
			).toBe("type Box<const T> = { value: T; }");
		});
	});

	test("sorts members by text, null and undefined last", () => {
		expect(
			sortUnionMembers('undefined | string | null | "b" | 2 | -1 | A'),
		).toBe('"b" | -1 | 2 | A | string | null | undefined');
	});

	test("keeps a | inside string literals and template literal types", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: type text, not a template
		expect(sortUnionMembers('"z|a" | "a|z" | `b|${string}`')).toBe(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: type text, not a template
			'"a|z" | "z|a" | `b|${string}`',
		);
	});

	test("sorts unions nested in objects, arrays, functions and generics", () => {
		expect(
			sortUnionMembers(
				'{ b: "y" | "x"; f: (v: 2 | 1) => "s" | true; }[] | Map<"q" | "p", (B | A)[]>',
			),
		).toBe(
			'Map<"p" | "q", (A | B)[]> | { b: "x" | "y"; f: (v: 1 | 2) => "s" | true; }[]',
		);
		// A member is ordered by its own sorted text.
		expect(sortUnionMembers("{ k: 2 | 1; } | { k: 1 | 3; }")).toBe(
			"{ k: 1 | 2; } | { k: 1 | 3; }",
		);
	});

	test("keeps the parentheses of function and intersection members", () => {
		expect(
			sortUnionMembers("string | ((x: 2 | 1) => void) | ({ a: 1; } & B)"),
		).toBe("((x: 1 | 2) => void) | ({ a: 1; } & B) | string");
	});

	test("accepts every signature shape", () => {
		expect(
			sortUnionMembers(
				'<T extends "b" | "a">(x: T | number, y?: 2 | 1): T',
			),
		).toBe('<T extends "a" | "b">(x: T | number, y?: 1 | 2): T');
		expect(
			sortUnionMembers(
				'type Pick<T extends "b" | "a" = "b"> = T extends "b" ? 2 | 1 : null | 0',
			),
		).toBe(
			'type Pick<T extends "a" | "b" = "b"> = T extends "b" ? 1 | 2 : 0 | null',
		);
		expect(
			sortUnionMembers(
				'Box<const T extends "b" | "a", in out U = 2 | 1>',
			),
		).toBe('Box<const T extends "a" | "b", in out U = 1 | 2>');
	});

	test("returns text it cannot parse, and text without unions, as printed", () => {
		const truncated = '"b" | "a" | ... 12 more ... | "c"';
		expect(sortUnionMembers(truncated)).toBe(truncated);
		expect(sortUnionMembers("{ b: 2 | 1; ...; }")).toBe(
			"{ b: 2 | 1; ...; }",
		);
		expect(sortUnionMembers("(a: string) => void")).toBe(
			"(a: string) => void",
		);
	});

	test("is idempotent", () => {
		const sorted = sortUnionMembers(
			'{ a?: number | string | undefined; b: ("y" | "x")[]; } | null',
		);
		expect(sortUnionMembers(sorted)).toBe(sorted);
	});
});

// TypeScript 6 and TypeScript 7 print these unions' members in different
// orders; with sort_unions every backend prints the same text.
const source = `export type Status = "idle" | "loading" | "a|b" | "error";
export function wide(x: string | number | boolean | null | undefined | bigint | symbol) {
	return x;
}
export const obj = {
	a: Math.random() > 0.5 ? "x" : 1,
	f: (v: "q" | "p" | 3) => (v === 3 ? true : "s"),
};
export const list = [1, "a", null, { k: "v" as "v" | "u" }];
export declare const tpl: \`a\${string}\` | \`b\${number}\` | "c";
export declare const optional: { z?: string | number; a: 1 | 2 | 3 };
export declare const numbers: -1 | 1 | 0 | 10 | 2 | 1n;
export declare const members: ({ a: 1 } & { b: 2 }) | { c: 3 };
export class B { x = 1 }
export class A { y = 2 }
export declare const classes: B | A | string[];
export enum Color { Red, Green }
export declare const mixed: Color | boolean | "x";
export declare function generic<T extends "b" | "a">(x: T | number): T | null;
export declare function over(x: "b" | "a"): 1 | 0;
export declare function over(x: number | string): boolean | null;
export type Fns = ((a: "y" | "x") => "r" | "q") | { m(x: 2 | 1): void };
`;

const roots: string[] = [];

function project(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "typeprobe-unions-")),
	);
	roots.push(dir);
	fs.writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "bundler",
				strict: true,
				types: [],
			},
			files: ["unions.ts"],
		}),
	);
	const file = path.join(dir, "unions.ts");
	fs.writeFileSync(file, source);
	return file;
}

afterAll(async () => {
	closeNativeSessions();
	await closeTestingSessions();
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("sort_unions across backends", () => {
	const file = project();
	const sorted = { sort_unions: true } as const;
	const expected: Record<string, string> = {
		Status: 'type Status = "a|b" | "error" | "idle" | "loading"',
		wide: "(x: bigint | boolean | number | string | symbol | null | undefined): bigint | boolean | number | string | symbol | null | undefined",
		obj: '{ a: number | string; f: (v: "p" | "q" | 3) => "s" | true; }',
		list: '(number | string | { k: "u" | "v"; } | null)[]',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: type text, not a template
		tpl: '"c" | `a${string}` | `b${number}`',
		optional: "{ z?: number | string; a: 1 | 2 | 3; }",
		numbers: "-1 | 0 | 1 | 10 | 1n | 2",
		members: "({ a: 1; } & { b: 2; }) | { c: 3; }",
		classes: "A | B | string[]",
		mixed: '"x" | Color | boolean',
		generic: '<T extends "a" | "b">(x: T | number): T | null',
		over: '(x: "a" | "b"): 0 | 1',
		Fns: 'type Fns = ((a: "x" | "y") => "q" | "r") | { m(x: 1 | 2): void; }',
	};

	for (const [name, text] of Object.entries(expected)) {
		test(`${name} prints the same on TypeScript 6 and 7`, async () => {
			expect(inferredType(file, { name, ...sorted })).toBe(text);
			expect(
				inferredType(file, {
					name,
					backend: "typescript7",
					...sorted,
				}),
			).toBe(text);
			// The language server backend of the CLI and MCP server.
			const lsp = await nativeHoverByName(file, name, {
				full: true,
				...sorted,
			});
			expect(lsp.signature).toBe(text);
		});
	}

	test("sorts returnType and overloads too", async () => {
		const overloads = [
			'(x: "a" | "b"): 0 | 1',
			"(x: number | string): boolean | null",
		];
		const ts6 = hover(file, "over", sorted);
		expect(ts6.returnType).toBe("0 | 1");
		expect(ts6.overloads).toEqual(overloads);
		const lsp = await nativeHoverByName(file, "over", sorted);
		expect(lsp.returnType).toBe("0 | 1");
		expect(lsp.overloads).toEqual(overloads);
	});

	test("is off by default: members print in TypeScript's order", () => {
		expect(inferredType(file, { name: "Status" })).toBe(
			'type Status = "idle" | "loading" | "a|b" | "error"',
		);
	});
});
