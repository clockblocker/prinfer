import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hover } from "../index.js";
import {
	closeNativeApiSessions,
	nativeApiTypeInfoByName,
} from "../native-api.js";
import { closeNativeSessions, nativeHoverByName } from "../native-lsp.js";
import type { HoverResult } from "../types.js";

// Optional parameters and properties print the way `tsc` writes them in
// declaration emit and quick info, on every backend: `?` alone marks them
// optional, and `| undefined` appears only where the source wrote it (or
// where it is not implied, as in an instantiated generic or a mapped type).
const source = `export function plain(digits?: number): string {
	return String(digits);
}
export function explicit(digits?: number | undefined): string {
	return String(digits);
}
export function defaulted(x = 1): number {
	return x;
}
export function mixed(a: string, b?: string, c = "x"): string {
	return a + b + c;
}
export const arrow = (digits?: number) => digits;
export const called = plain(2);
export interface Opts {
	digits?: number;
	declared?: number | undefined;
	method?(n?: number): void;
}
export type Shape = { width?: number; label?: string | undefined };
export type Mapped = Partial<{ width: number }>;
export class Box {
	content?: string;
	resize(scale?: number): void {}
}
export function withCallback(cb?: (x?: number) => void): void {}
export function withOptions(options?: { verbose?: boolean; depth?: number | undefined }): void {}
export function overloaded(x: string, y?: number): void;
export function overloaded(x: number): void;
export function overloaded(x: unknown, y?: number) {}
export declare function generic<T>(x: T, y?: T): void;
export const instantiated = generic(1);
export function inArray(rows: { z?: string | number }[]): void {}
export function inGenericArray(rows: Array<{ z?: string }>): void {}
export function inReadonlyArray(rows: readonly { z?: string }[], more: ReadonlyArray<{ z?: number }>): void {}
export function inTuple(pair: [{ z?: string }, number], rest: [number, ...{ z?: string }[]]): void {}
export function nestedInArray(rows: { items: { z?: string }[] }[]): void {}
export type Rows = { z?: string | number }[];
export function rowsOf(): { z?: string }[] { return []; }
export function inTypeArguments(p: Promise<{ z?: string }>, m: Map<string, { z?: number }>, r: Record<string, { z?: boolean }>): void {}
export function inMembers(both: { z?: string } & { w: number }, either: { z?: string } | { w?: number }): void {}
export function inSignatures(index: { [key: string]: { z?: string } }, make: new (n?: number) => { z?: string }): void {}
export function declaredInArray(rows: { z?: string | undefined }[]): void {}
export const rowsVariable: Array<{ z?: string }> = [];
export type ElementsOf<T> = { z?: T }[];
export declare function genericRows<T>(rows: { z?: T }[]): void;
export const genericRowsCall = genericRows([{ z: 1 }]);
`;

const roots: string[] = [];

/** The source in a fresh project, with exactOptionalPropertyTypes on or off. */
function project(exact: boolean): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-optional-")),
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
				exactOptionalPropertyTypes: exact,
			},
			files: ["optional.ts"],
		}),
	);
	const file = path.join(dir, "optional.ts");
	fs.writeFileSync(file, source);
	return file;
}

afterAll(async () => {
	closeNativeSessions();
	await closeNativeApiSessions();
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

type Lookup = (
	file: string,
	name: string,
	options?: { line?: number },
) => Promise<HoverResult>;

const backends: Array<[string, Lookup]> = [
	["typescript6", async (file, name, options) => hover(file, name, options)],
	["typescript7 (language server)", nativeHoverByName],
	["typescript7 (testing API)", nativeApiTypeInfoByName],
];

function comparable(result: HoverResult) {
	return {
		signature: result.signature,
		returnType: result.returnType,
		kind: result.kind,
		overloads: result.overloads,
		unionMembers: result.unionMembers,
	};
}

// [name, line?, expected subset in both modes]
const shared: Array<[string, number | undefined, Partial<HoverResult>]> = [
	["plain", undefined, { signature: "(digits?: number): string" }],
	[
		"explicit",
		undefined,
		{ signature: "(digits?: number | undefined): string" },
	],
	["defaulted", undefined, { signature: "(x?: number): number" }],
	[
		"mixed",
		undefined,
		{ signature: "(a: string, b?: string, c?: string): string" },
	],
	[
		"arrow",
		undefined,
		{
			signature: "(digits?: number) => number | undefined",
			returnType: "number | undefined",
		},
	],
	["plain", 14, { signature: "(digits?: number): string", kind: "call" }],
	["method", undefined, { signature: "(n?: number): void" }],
	["resize", undefined, { signature: "(scale?: number): void" }],
	[
		"Shape",
		undefined,
		{
			signature:
				"type Shape = { width?: number; label?: string | undefined; }",
		},
	],
	[
		"withCallback",
		undefined,
		{ signature: "(cb?: (x?: number) => void): void" },
	],
	[
		"cb",
		undefined,
		{
			signature: "((x?: number) => void) | undefined",
			kind: "parameter",
		},
	],
	[
		"withOptions",
		undefined,
		{
			signature:
				"(options?: { verbose?: boolean; depth?: number | undefined; }): void",
		},
	],
	[
		"overloaded",
		undefined,
		{
			signature: "(x: string, y?: number): void",
			overloads: ["(x: string, y?: number): void", "(x: number): void"],
		},
	],
	[
		"generic",
		32,
		{
			signature: "<number>(x: number, y?: number | undefined): void",
			kind: "call",
		},
	],
	["declared", undefined, { signature: "number | undefined" }],
	// Object types inside arrays, tuples, type arguments, unions,
	// intersections, and index and construct signatures.
	[
		"inArray",
		undefined,
		{ signature: "(rows: { z?: string | number; }[]): void" },
	],
	[
		"inGenericArray",
		undefined,
		{ signature: "(rows: { z?: string; }[]): void" },
	],
	[
		"inReadonlyArray",
		undefined,
		{
			signature:
				"(rows: readonly { z?: string; }[], more: readonly { z?: number; }[]): void",
		},
	],
	[
		"inTuple",
		undefined,
		{
			signature:
				"(pair: [{ z?: string; }, number], rest: [number, ...{ z?: string; }[]]): void",
		},
	],
	[
		"nestedInArray",
		undefined,
		{ signature: "(rows: { items: { z?: string; }[]; }[]): void" },
	],
	[
		"Rows",
		undefined,
		{ signature: "type Rows = { z?: string | number; }[]" },
	],
	[
		"rowsOf",
		undefined,
		{ signature: "(): { z?: string; }[]", returnType: "{ z?: string; }[]" },
	],
	[
		"inTypeArguments",
		undefined,
		{
			signature:
				"(p: Promise<{ z?: string; }>, m: Map<string, { z?: number; }>, r: Record<string, { z?: boolean; }>): void",
		},
	],
	[
		"inMembers",
		undefined,
		{
			signature:
				"(both: { z?: string; } & { w: number; }, either: { z?: string; } | { w?: number; }): void",
		},
	],
	[
		"inSignatures",
		undefined,
		{
			signature:
				"(index: { [key: string]: { z?: string; }; }, make: new (n?: number) => { z?: string; }): void",
		},
	],
	[
		"declaredInArray",
		undefined,
		{ signature: "(rows: { z?: string | undefined; }[]): void" },
	],
	["rowsVariable", undefined, { signature: "{ z?: string; }[]" }],
	[
		"ElementsOf",
		undefined,
		{ signature: "type ElementsOf<T> = { z?: T; }[]" },
	],
];

// With exactOptionalPropertyTypes, `?` no longer implies `| undefined`:
// Partial<T> adds only the `?`, and hovering a property declared
// `digits?: number` shows `number`, as tsc reports it.
const byMode: Record<
	"loose" | "exact",
	Array<[string, number | undefined, Partial<HoverResult>]>
> = {
	loose: [
		[
			"Mapped",
			undefined,
			{ signature: "type Mapped = { width?: number | undefined; }" },
		],
		[
			"digits",
			16,
			{
				signature: "number | undefined",
				kind: "property",
				unionMembers: 2,
			},
		],
		[
			"content",
			undefined,
			{
				signature: "string | undefined",
				kind: "property",
				unionMembers: 2,
			},
		],
		[
			"genericRows",
			47,
			{
				signature:
					"<number>(rows: { z?: number | undefined; }[]): void",
				kind: "call",
			},
		],
	],
	exact: [
		[
			"Mapped",
			undefined,
			{ signature: "type Mapped = { width?: number; }" },
		],
		["digits", 16, { signature: "number", kind: "property" }],
		["content", undefined, { signature: "string", kind: "property" }],
		[
			"genericRows",
			47,
			{
				signature: "<number>(rows: { z?: number; }[]): void",
				kind: "call",
			},
		],
	],
};

for (const mode of ["loose", "exact"] as const) {
	describe(`optional parameters and properties agree (exactOptionalPropertyTypes ${mode === "exact" ? "on" : "off"})`, () => {
		const file = project(mode === "exact");
		for (const [name, line, expected] of [...shared, ...byMode[mode]]) {
			test(`${name}${line ? `:${line}` : ""}`, async () => {
				const results = await Promise.all(
					backends.map(([, lookup]) => lookup(file, name, { line })),
				);
				const [first, ...rest] = results.map(comparable);
				expect(first).toMatchObject(expected);
				for (const other of rest) expect(other).toEqual(first as never);
			}, 30_000);
		}
	});
}
