import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeNativeSessions, nativeHover } from "../native-lsp.js";
import { closeTestingSessions, inferredTypeInfo } from "../testing.js";
import type { HoverResult } from "../types.js";

// The first lookup per backend loads a compiler program.
setDefaultTimeout(30_000);

// A name in a type position (`Holder` in `let h: Holder<1>`) reads the
// declared type of what it names, as TypeScript 6's getTypeAtLocation
// does. TypeScript 7's checker reports the error type there, which the
// testing API printed as `any`.
const dep = `export interface Dep<T> { d: T }
export type DepAlias<T> = { a: T };
export class DepClass<T> { c!: T }
`;

const source = `import type { Dep, DepAlias, DepClass } from "./dep";
import * as dep from "./dep";
export class Holder<T extends 1 | 2> { value!: T }
export interface Iface<T> { v: T }
export type Alias<T> = { v: T };
export type Pair = "a" | "b";
export namespace ns { export interface T<U> { u: U } export type A = string; }
export enum Color { Red, Green }
export let h: Holder<1>;
export let bare: Holder;
export let i: Iface<string>;
export let al: Alias<number>;
export let pair: Pair;
export let q: ns.T<number>;
export let qa: ns.A;
export let d1: Dep<1>;
export let d2: DepAlias<1>;
export let d3: DepClass<1>;
export let d4: dep.Dep<2>;
export let it: import("./dep").Dep<3>;
export let ko: keyof Holder<1>;
export let ia: Holder<2>["value"];
export let arr: Array<Alias<1>>;
export let e: Color;
export let er: Color.Red;
export const cast = null as unknown as Alias<4>;
export interface Ext extends Iface<1>, dep.Dep<1> {}
export class Impl implements Iface<2> { v!: 2 }
export class Sub extends Holder<1> {}
export function gen<U extends Iface<U>>(u: U): U { return u; }
export class Self<T> { me!: Self<T>; t!: T }
`;

const roots: string[] = [];

function project(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-type-references-")),
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
			files: ["references.ts", "dep.ts"],
		}),
	);
	fs.writeFileSync(path.join(dir, "dep.ts"), dep);
	const file = path.join(dir, "references.ts");
	fs.writeFileSync(file, source);
	return file;
}

afterAll(async () => {
	closeNativeSessions();
	await closeTestingSessions();
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function comparable(result: HoverResult) {
	return {
		signature: result.signature,
		kind: result.kind,
		unionMembers: result.unionMembers,
	};
}

const lines = source.split("\n");

/** The 1-based line that contains `context`. */
function lineOf(context: string): number {
	const index = lines.findIndex((line) => line.includes(context));
	if (index < 0) throw new Error(`No line contains ${context}`);
	return index + 1;
}

// [line context, hovered text, expected subset]
const cases: Array<[string, string, Partial<HoverResult>]> = [
	["h: Holder<1>", "Holder<1>", { signature: "Holder<T>", kind: "class" }],
	["bare: Holder", "Holder", { signature: "Holder<T>", kind: "class" }],
	["i: Iface", "Iface", { signature: "Iface<T>", kind: "interface" }],
	["al: Alias", "Alias", { signature: "Alias<T>", kind: "type" }],
	["pair: Pair", "Pair;", { signature: "Pair", unionMembers: 2 }],
	// A qualified name: the right side names the type, the left a namespace.
	["q: ns.T", "T<number>", { signature: "T<U>", kind: "interface" }],
	["q: ns.T", "ns.", { signature: "any", kind: "namespace" }],
	["qa: ns.A", "A;", { signature: "string", kind: "type" }],
	// Imported types, by name, through a namespace import, and import().
	["d1: Dep", "Dep", { signature: "Dep<T>", kind: "interface" }],
	["d2: DepAlias", "DepAlias", { signature: "DepAlias<T>", kind: "type" }],
	["d3: DepClass", "DepClass", { signature: "DepClass<T>", kind: "class" }],
	["d4: dep.Dep", "Dep<2>", { signature: "Dep<T>", kind: "interface" }],
	["it: import", "Dep<3>", { signature: "Dep<T>", kind: "interface" }],
	// References inside other type nodes and in expressions.
	["ko: keyof", "Holder", { signature: "Holder<T>" }],
	["ia: Holder", "Holder", { signature: "Holder<T>" }],
	["arr: Array", "Array", { signature: "T[]" }],
	["arr: Array", "Alias", { signature: "Alias<T>" }],
	["e: Color", "Color", { signature: "Color", kind: "enum" }],
	["er: Color.Red", "Red", { signature: "Color.Red" }],
	["as unknown as Alias", "Alias", { signature: "Alias<T>" }],
	// Heritage clauses: interface extends and class implements name types;
	// class extends names the base class value.
	["interface Ext", "Iface", { signature: "Iface<T>" }],
	["interface Ext", "Dep<1>", { signature: "Dep<T>" }],
	["class Impl", "Iface", { signature: "Iface<T>" }],
	["class Sub", "Holder", { signature: "typeof Holder" }],
	// Type parameters referenced in their scope.
	["function gen", "Iface<U>", { signature: "Iface<T>" }],
	["function gen", "U): U", { signature: "U", kind: "type parameter" }],
	["me!: Self", "Self<T>;", { signature: "Self<T>", kind: "class" }],
	["me!: Self", "T }", { signature: "T", kind: "type parameter" }],
];

describe("type references read the same type on TypeScript 6 and 7", () => {
	const file = project();
	for (const [context, text, expected] of cases) {
		test(`${context} at ${text}`, async () => {
			const selector = { line: lineOf(context), text };
			const ts6 = comparable(inferredTypeInfo(file, selector));
			expect(ts6).toMatchObject(expected);
			const ts7 = comparable(
				await inferredTypeInfo(file, {
					...selector,
					backend: "typescript7",
				}),
			);
			expect(ts7).toEqual(ts6);
		});
	}
});

test("the language server counts the members of a union named in a type position", async () => {
	const file = project();
	const line = lineOf("pair: Pair");
	const column = (lines[line - 1] as string).indexOf("Pair;") + 1;
	expect((await nativeHover(file, line, column)).unionMembers).toBe(2);
});
