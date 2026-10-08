import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	annotationsSuccess,
	annotationsSuccessSchema,
	contractErrorResponseSchema,
} from "../contract.js";
import { formatAnnotations } from "../core/annotations.js";
import { annotations } from "../index.js";
import type { AnnotationFinding, AnnotationsResult } from "../types.js";

const srcDir = path.join(import.meta.dir, "..");
const STRICT = {
	target: "ES2022",
	module: "ESNext",
	moduleResolution: "bundler",
	strict: true,
	skipLibCheck: true,
	lib: ["ES2022"],
};

let root: string;
let counter = 0;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-annotations-"));
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** Write a one-file project and return its path. */
function project(
	source: string,
	options: Record<string, unknown> = STRICT,
	extra: Record<string, string> = {},
): string {
	const dir = path.join(root, `p${counter++}`);
	fs.mkdirSync(dir);
	fs.writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({ compilerOptions: options, include: ["*.ts"] }),
	);
	for (const [name, text] of Object.entries(extra)) {
		fs.writeFileSync(path.join(dir, name), text);
	}
	const file = path.join(dir, "main.ts");
	fs.writeFileSync(file, source);
	return file;
}

/** Findings keyed `target name`, e.g. `variable a` or `return f`. */
function byKey(result: AnnotationsResult): Map<string, AnnotationFinding> {
	const map = new Map<string, AnnotationFinding>();
	for (const finding of result.findings) {
		const key = `${finding.target} ${finding.name}`;
		expect(map.has(key)).toBe(false);
		map.set(key, finding);
	}
	return map;
}

function kinds(result: AnnotationsResult): Record<string, string> {
	return Object.fromEntries(
		[...byKey(result)].map(([key, finding]) => [key, finding.kind]),
	);
}

describe("annotations: variables", () => {
	let result: AnnotationsResult;

	beforeAll(() => {
		result = annotations(
			project(`
const constWiden: string = "a";
let letSame: string = "a";
let letNumber: number = 1;
const constNumber: number = 1;
var varBool: boolean = true;
const constUnion: "a" | "b" = "a";
let letUnion: "a" | "b" = "a";
let letWider: string | number = 1;
const exprSame: number = 2 * 3;
const objectLiteralKind: { kind: "a" } = { kind: "a" };
const objectSame: { a: number } = { a: 1 };
const objectOptional: { a?: number } = { a: 1 };
const arraySame: number[] = [1, 2];
const arrayReadonly: readonly number[] = [1, 2];
const tuple: [number, string] = [1, "a"];
const emptyArray: string[] = [];
let emptyLet: number[] = [];
const asConst: readonly ["a"] = ["a"] as const;
const setContextual: Set<string> = new Set();
const setExplicit: Set<string> = new Set<string>();
const mapContextual: Map<string, number> = new Map();
const mapped: number[] = [1, 2].map((n) => n * 2);
type Handler = (e: { x: number }) => void;
const callback: Handler = (e) => console.log(e.x);
const callbackTyped: (n: number) => number = (n: number) => n + 1;
const unionCallback: Handler | string = (e) => console.log(e.x);
const anyDeclared: any = 1;
const unknownDeclared: unknown = 1;
const fromAny: string = JSON.parse("1");
type Cfg = { mode: "dark" | "light" };
const satisfied: Cfg = { mode: "dark" } satisfies Cfg;
enum Color { Red, Green }
let enumLet: Color = Color.Red;
const enumConst: Color = Color.Red;
const readonlyWrapper: Readonly<{ a: number }> = { a: 1 };
const literalFn: () => "a" = () => "a";
const nullable: string | null = null;
let undefinedLet: number | undefined = undefined;
const { destructured }: { destructured: number } = { destructured: 1 };
const recursive: (n: number) => number = (n) => (n ? n * recursive(n - 1) : 1);
const generic: <T>(x: T) => T = <T,>(x: T) => x;
const symbolWide: symbol = Symbol();
namespace A { export interface T { a: number } }
namespace B { export interface T { a: number } }
declare const fromB: B.T;
const sameShapeOtherName: A.T = fromB;
for (let loopIndex: number = 0; loopIndex < 1; loopIndex++) {}
function narrowed(v: string | undefined) {
	if (v) {
		const narrowedLength: number = v.length;
		return narrowedLength;
	}
	return 0;
}
export const exportedSame: number = 2 * 3;
`),
		);
	});

	test("classifies each declaration", () => {
		expect(kinds(result)).toEqual({
			"variable constWiden": "widening",
			"variable letSame": "redundant",
			"variable letNumber": "redundant",
			"variable constNumber": "widening",
			"variable varBool": "redundant",
			"variable constUnion": "widening",
			"variable letWider": "widening",
			"variable exprSame": "redundant",
			"variable objectSame": "redundant",
			"variable objectOptional": "widening",
			"variable arraySame": "redundant",
			"variable arrayReadonly": "widening",
			"variable asConst": "redundant",
			"variable setExplicit": "redundant",
			"variable mapped": "redundant",
			"variable callbackTyped": "redundant",
			"variable unknownDeclared": "widening",
			"variable satisfied": "widening",
			"variable enumLet": "redundant",
			"variable enumConst": "widening",
			"variable nullable": "widening",
			"variable generic": "redundant",
			"variable symbolWide": "widening",
			"variable narrowedLength": "redundant",
			"variable exportedSame": "redundant",
		});
	});

	test("never reports annotations the initializer depends on", () => {
		const reported = new Set(result.findings.map((f) => f.name));
		for (const name of [
			"letUnion", // widens to string without it
			"objectLiteralKind", // the literal would widen to string
			"tuple", // would infer an array
			"emptyArray", // would infer never[]
			"emptyLet", // would infer an evolving any[]
			"setContextual", // new Set() takes its type argument from it
			"mapContextual",
			"callback", // e would become implicitly any
			"unionCallback",
			"anyDeclared",
			"fromAny",
			"readonlyWrapper", // equivalent, but a different spelling
			"literalFn",
			"undefinedLet",
			"destructured",
			"recursive", // removing it makes the initializer circular
			"sameShapeOtherName",
			"loopIndex",
		]) {
			expect({ name, reported: reported.has(name) }).toEqual({
				name,
				reported: false,
			});
		}
	});

	test("reports the declared and inferred types", () => {
		const map = byKey(result);
		expect(map.get("variable constWiden")).toMatchObject({
			declared: "string",
			inferred: '"a"',
			exported: false,
		});
		expect(map.get("variable enumConst")).toMatchObject({
			declared: "Color",
			inferred: "Color.Red",
		});
		expect(map.get("variable symbolWide")?.inferred).not.toContain(
			"__prinfer",
		);
		expect(map.get("variable exportedSame")?.exported).toBe(true);
	});

	test("points at the removable `: Type` span", () => {
		const finding = byKey(result).get("variable letSame");
		expect(finding).toMatchObject({
			line: 3,
			column: 12,
			endLine: 3,
			endColumn: 20,
		});
	});

	test("sorts findings and counts them", () => {
		const positions = result.findings.map((f) => f.line * 1000 + f.column);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(result.redundantCount).toBe(
			result.findings.filter((f) => f.kind === "redundant").length,
		);
		expect(result.wideningCount).toBe(
			result.findings.filter((f) => f.kind === "widening").length,
		);
		expect(result.checkedCount).toBeGreaterThan(result.findings.length);
	});
});

describe("annotations: classes, parameters, and return types", () => {
	let result: AnnotationsResult;

	beforeAll(() => {
		result = annotations(
			project(`
export class Widget {
	count: number = 1;
	readonly label: string = "x";
	static enabled: boolean = false;
	maybe?: number = 1;
	private items: number[] = [];
	derived: number = this.count + 1;
	total(): number { return this.count; }
	either(): string | number { return 1; }
	log(level: number = 1): void { console.log(level); }
	handler = (): void => { console.log(this.count); };
	get value(): number { return 1; }
}
abstract class Shape {
	abstract area(): number;
}
function plain(): number { return 1; }
function optional(): string | undefined { return "a"; }
function factorial(n: number): number { return n <= 1 ? 1 : n * factorial(n - 1); }
async function later(): Promise<number> { return 1; }
function defaults(x: number = 1, y: string | number = "a"): void { console.log(x, y); }
export function exported(): number { return 1; }
const arrow = (x: number): number => x * 2;
const expression = function (): string { return "s"; };
[1, 2].map((x): number => x * 2);
function returnsCallback(): (x: number) => number { return (x) => x; }
function identity<T>(x: T): T { return x; }
function isString(x: unknown): x is string { return typeof x === "string"; }
function overloaded(x: string): string;
function overloaded(x: number): number;
function overloaded(x: unknown): unknown { return x; }
function mutualA(n: number): number { return n ? mutualB(n - 1) : 0; }
function mutualB(n: number) { return mutualA(n); }
function* generator(): Generator<number> { yield 1; }
function guard(v: string | undefined) {
	return v && ((): number => v.length);
}
const methods = {
	inObject(): number { return 1; },
	arrowInObject: (): number => 1,
};
const handlers: { on: (n: number) => void } = { on: (n: number = 1): void => {} };
export default function (): number { return 1; }
`),
		);
	});

	test("classifies each annotation", () => {
		expect(kinds(result)).toEqual({
			"property count": "redundant",
			"property label": "widening",
			"property enabled": "redundant",
			"property maybe": "redundant",
			"property derived": "redundant",
			"return total": "redundant",
			"return either": "widening",
			"parameter level": "redundant",
			"return log": "redundant",
			"return handler": "redundant",
			"return plain": "redundant",
			"return optional": "widening",
			"return later": "redundant",
			"parameter x": "redundant",
			"parameter y": "widening",
			"return defaults": "redundant",
			"return exported": "redundant",
			"return arrow": "redundant",
			"return expression": "redundant",
			"return identity": "redundant",
			"return arrowInObject": "redundant",
			"return default": "redundant",
			// The default makes on's parameter optional: (n?: number) => void.
			"variable handlers": "widening",
		});
	});

	test("reports return types as return types", () => {
		const map = byKey(result);
		expect(map.get("return either")).toMatchObject({
			declared: "string | number",
			inferred: "number",
		});
		expect(map.get("return later")).toMatchObject({
			declared: "Promise<number>",
			inferred: "Promise<number>",
		});
	});

	test("marks public API of exported declarations", () => {
		const map = byKey(result);
		expect(map.get("property count")?.exported).toBe(true);
		expect(map.get("return exported")?.exported).toBe(true);
		expect(map.get("return default")?.exported).toBe(true);
		expect(map.get("return plain")?.exported).toBe(false);
		expect(map.get("return exported")?.suggestion).toContain("exported");
	});

	test("skips recursion, contextual typing, predicates, and overloads", () => {
		const names = new Set(result.findings.map((f) => f.name));
		for (const name of [
			"items", // [] would infer never[]
			"value", // accessors are not checked
			"area",
			"factorial",
			"returnsCallback",
			"isString",
			"overloaded",
			"mutualA", // removing it makes mutualA and mutualB circular
			"generator",
			"guard",
			"anonymous function",
			"inObject",
			"n",
			"on",
		]) {
			expect({ name, reported: names.has(name) }).toEqual({
				name,
				reported: false,
			});
		}
	});
});

describe("annotations: compiler options and files", () => {
	test("without noImplicitAny, still skips callbacks that lose their context", () => {
		const result = annotations(
			project(
				`type Handler = (e: { x: number }) => void;
const h1: Handler | string = (e) => e.x;
const h2: (e: string) => number = (e) => 1;
let s: string = null;
const cb: { f: (n: number) => void } = { f: (n) => n };
const arr: string[] = [];
let v: number = 1;
`,
				{ target: "ES2022", module: "ESNext", strict: false },
			),
		);
		expect(kinds(result)).toEqual({ "variable v": "redundant" });
	});

	test("with isolatedDeclarations, keeps exported annotations", () => {
		const result = annotations(
			project(
				`export const a: number = 1 + 1;
const b: number = 1 + 1;
export function f(): number { return 1; }
export class K { p: number = 2 + 1; private q: number = 2 + 1; }
`,
				{ ...STRICT, declaration: true, isolatedDeclarations: true },
			),
		);
		expect(kinds(result)).toEqual({
			"variable b": "redundant",
			"property q": "redundant",
		});
	});

	test("compares types imported from other files", () => {
		const result = annotations(
			project(
				`import { makeOther, type Other } from "./other";
const same: Other = makeOther();
let mutable: Other = makeOther();
const literal: Other = { value: 1 };
`,
				STRICT,
				{
					"other.ts":
						"export interface Other { value: number }\nexport function makeOther(): Other { return { value: 1 }; }\n",
				},
			),
		);
		expect(kinds(result)).toEqual({
			"variable same": "redundant",
			"variable mutable": "redundant",
		});
	});

	test("checks script files and nested scopes", () => {
		const result = annotations(
			project(`let globalCount: number = 1;
function readCount(): number { return globalCount; }
namespace Inner { export const nested: string = "a" + "b"; }
`),
		);
		expect(kinds(result)).toEqual({
			"variable globalCount": "redundant",
			"return readCount": "redundant",
			"variable nested": "redundant",
		});
	});

	test("returns nothing for files without annotations or JavaScript", () => {
		const empty = annotations(project("export const a = 1;\n"));
		expect(empty).toMatchObject({
			findings: [],
			redundantCount: 0,
			wideningCount: 0,
			checkedCount: 0,
		});
		expect(formatAnnotations(empty)).toBe(
			"No redundant or widening annotations (0 annotations checked).",
		);
	});

	test("throws for a missing file", () => {
		expect(() => annotations(path.join(root, "missing.ts"))).toThrow(
			"File not found",
		);
	});

	test("does not change what diagnostics see", () => {
		const file = project("let x: number = 1;\nexport { x };\n");
		const before = annotations(file);
		expect(annotations(file)).toEqual(before);
		expect(fs.readFileSync(file, "utf8")).toBe(
			"let x: number = 1;\nexport { x };\n",
		);
		expect(before.findings[0]?.exported).toBe(true);
	});
});

describe("annotations: output", () => {
	const sample = () =>
		annotations(
			project(`let same: number = 1;
const wide: string = "a";
function f(): number { return 1; }
`),
		);

	test("formats one compact line per finding and a summary", () => {
		const result = sample();
		expect(formatAnnotations(result, "src/a.ts")).toBe(
			[
				"src/a.ts:1:9 redundant same: declared number, inferred number",
				'src/a.ts:2:11 widening wide: declared string, inferred "a"',
				"src/a.ts:3:13 redundant return type of f: declared number, inferred number",
				"2 redundant, 1 widening (3 annotations checked).",
				"redundant: delete the annotation; the type stays the same.",
				"widening: the annotation is wider than the inferred type; keep it if the wider type is intended.",
			].join("\n"),
		);
	});

	test("matches the versioned contract", () => {
		const result = sample();
		const parsed = annotationsSuccessSchema.parse(
			annotationsSuccess(result),
		);
		expect(parsed.result.findings[0]).toEqual({
			line: 1,
			column: 9,
			endLine: 1,
			endColumn: 17,
			name: "same",
			target: "variable",
			kind: "redundant",
			declared: "number",
			inferred: "number",
			exported: false,
			suggestion:
				"Remove the annotation on same; TypeScript infers the same type.",
		});
		expect(parsed.result.findings[1]?.suggestion).toBe(
			'Without the annotation on wide, wide is "a"; keep it if wide must accept string.',
		);
	});
});

async function runCli(args: string[]) {
	const proc = Bun.spawn(
		[process.execPath, "run", path.join(srcDir, "cli.ts"), ...args],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { stdout, stderr, exitCode: await proc.exited };
}

describe("prinfer annotations", () => {
	test("prints findings and exits 0", async () => {
		const file = project("let same: number = 1;\n");
		const { stdout, exitCode } = await runCli(["annotations", file]);
		expect(stdout).toContain(
			`${file}:1:9 redundant same: declared number, inferred number`,
		);
		expect(exitCode).toBe(0);
	});

	test("emits the JSON contract", async () => {
		const file = project("const wide: string = 'a';\n");
		const { stdout, exitCode } = await runCli([
			"annotations",
			file,
			"--json",
			"--project",
			path.join(path.dirname(file), "tsconfig.json"),
		]);
		const parsed = annotationsSuccessSchema.parse(JSON.parse(stdout));
		expect(parsed.result.wideningCount).toBe(1);
		expect(exitCode).toBe(0);
	});

	test("exits 1 when the check fails", async () => {
		const missing = await runCli([
			"annotations",
			path.join(root, "missing.ts"),
			"--json",
		]);
		const { error } = contractErrorResponseSchema.parse(
			JSON.parse(missing.stdout),
		);
		expect(error.code).toBe("FILE_NOT_FOUND");
		expect(missing.exitCode).toBe(1);

		const usage = await runCli(["annotations", "--bogus"]);
		expect(usage.stderr).toContain("Unknown annotations option --bogus");
		expect(usage.exitCode).toBe(1);
	});
});

describe("annotations MCP tool", () => {
	test("returns text and structured content", async () => {
		const file = project("let same: number = 1;\n");
		const child = spawn(process.execPath, [path.join(srcDir, "mcp.ts")], {
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
					if (message.id !== undefined) {
						responses.get(message.id)?.(message);
					}
				}
				newline = buffer.indexOf("\n");
			}
		});
		let nextId = 1;
		const request = (method: string, params: unknown) => {
			const id = nextId++;
			return new Promise<{
				result: {
					tools?: Array<{ name: string; description: string }>;
					content?: Array<{ text: string }>;
					structuredContent?: unknown;
					isError?: boolean;
				};
			}>((resolve) => {
				responses.set(id, resolve as (message: unknown) => void);
				child.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				);
			});
		};
		try {
			await request("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test", version: "0" },
			});
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
			);
			const listed = await request("tools/list", {});
			const tool = listed.result.tools?.find(
				(candidate) => candidate.name === "annotations",
			);
			expect(tool?.description).toContain("redundant");

			const ok = await request("tools/call", {
				name: "annotations",
				arguments: { file },
			});
			expect(ok.result.content?.[0]?.text).toContain(
				`${file}:1:9 redundant same: declared number, inferred number`,
			);
			const parsed = annotationsSuccessSchema.parse(
				ok.result.structuredContent,
			);
			expect(parsed.result.redundantCount).toBe(1);

			const failed = await request("tools/call", {
				name: "annotations",
				arguments: { file: path.join(root, "missing.ts") },
			});
			expect(failed.result.isError).toBe(true);
			const { error } = contractErrorResponseSchema.parse(
				failed.result.structuredContent,
			);
			expect(error.code).toBe("FILE_NOT_FOUND");
		} finally {
			child.kill();
		}
	}, 30_000);
});
