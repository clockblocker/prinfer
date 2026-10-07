import { describe, expect, test } from "bun:test";
import {
	capText,
	countUnionMembers,
	DEFAULT_MAX_CHARS,
	formatHoverText,
} from "../hover-format.js";
import type { HoverResult } from "../types.js";

const union = (count: number) =>
	Array.from({ length: count }, (_, i) => `"member_${i}"`).join(" | ");

describe("countUnionMembers", () => {
	test.each([
		['"a" | "b" | "c"', 3],
		['type X = "a" | "b"', 2],
		['type X =\n    | "a"\n    | "b"', 2],
		['const x: "a" | { b: "c" | "d" }', 2],
		['(parameter) user: "a" | "b"', 2],
		['"a|b" | "c"', 2],
		['"a" | ... 389 more ... | "z"', 391],
		[union(391), 391],
	] as const)("%s", (signature, expected) => {
		expect(countUnionMembers(signature)).toBe(expected);
	});

	test.each([
		"string",
		"{ a: string | number; }",
		"(a: string): A | B",
		"const f: (a: string) => A | B",
		"Array<A | B>",
	])("not a union: %s", (signature) => {
		expect(countUnionMembers(signature)).toBeUndefined();
	});

	test("skips function kinds", () => {
		expect(countUnionMembers("function f(): A | B", "function")).toBe(
			undefined,
		);
	});
});

describe("capText", () => {
	test("leaves short text alone and 0 disables the cap", () => {
		expect(capText("abc", 10)).toEqual({
			text: "abc",
			truncated: false,
			total: 3,
		});
		expect(capText("x".repeat(50), 0).truncated).toBe(false);
	});

	test("cuts at a space near the limit", () => {
		const capped = capText(union(1000), 100);
		expect(capped.truncated).toBe(true);
		expect(capped.text.length).toBeLessThanOrEqual(100);
		expect(capped.text.length).toBeGreaterThan(85);
		expect(capped.total).toBe(union(1000).length);
	});

	test("never splits a surrogate pair", () => {
		const capped = capText(`${"a".repeat(9)}😀😀`, 10);
		expect(capped.text).toBe("a".repeat(9));
	});
});

const base: HoverResult = {
	signature: "number",
	line: 3,
	column: 7,
	kind: "const",
	name: "x",
};

describe("formatHoverText", () => {
	test("renders the CLI and MCP layouts", () => {
		expect(formatHoverText(base, { surface: "cli" })).toBe(
			"number\nname: x\nkind: const",
		);
		expect(formatHoverText(base, { surface: "mcp" })).toBe(
			"Type: number\nName: x\nKind: const\nPosition: 3:7",
		);
	});

	test("caps long types with a trailer that counts union members", () => {
		const signature = `type Big = ${union(391)}`;
		const result = { ...base, signature, kind: "type" };
		const cli = formatHoverText(result, { surface: "cli" });
		const [type, trailer] = cli.split("\n");
		expect(type?.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
		expect(trailer).toBe(
			`… truncated: ${signature.length.toLocaleString("en-US")} chars total, union of 391 members. Pass --max-chars N to see more (0 for no limit).`,
		);
		expect(formatHoverText(result, { surface: "mcp" })).toContain(
			"union of 391 members. Pass max_chars: N to see more (0 for no limit).",
		);
		expect(
			formatHoverText(result, { surface: "cli", maxChars: 0 }),
		).not.toContain("truncated");
	});

	test("prefers the core's union member count", () => {
		const result = {
			...base,
			signature: union(500),
			unionMembers: 1234,
		} as HoverResult;
		expect(formatHoverText(result, { surface: "mcp" })).toContain(
			"union of 1,234 members",
		);
	});

	test("lists up to three overloads, and counts more unless full", () => {
		const fn = {
			...base,
			signature: "function f(a: string): void",
			kind: "function",
		};
		const two = { ...fn, overloads: ["function f(a: number): void"] };
		expect(formatHoverText(two as HoverResult, { surface: "mcp" })).toBe(
			[
				"Type: function f(a: string): void (+1 overload)",
				"Overloads:",
				"  function f(a: number): void",
				"Name: x",
				"Kind: function",
				"Position: 3:7",
			].join("\n"),
		);

		const many = {
			...fn,
			overloads: [
				"function f(a: string): void",
				"function f(a: 1): void",
				"function f(a: 2): void",
				"function f(a: 3): void",
				"function f(a: 4): void",
			],
		} as HoverResult;
		const cli = formatHoverText(many, { surface: "cli" });
		// The displayed signature is not counted again.
		expect(cli.split("\n")[0]).toBe(
			"function f(a: string): void (+4 overloads; --full lists them)",
		);
		expect(cli).not.toContain("overloads:");
		const full = formatHoverText(many, { surface: "cli", full: true });
		expect(full).toContain(
			"(+4 overloads)\noverloads:\n  function f(a: 1): void",
		);
	});

	test("names the other declarations a name lookup could have meant", () => {
		const result = {
			...base,
			line: 57,
			alternatives: [
				{ line: 59, column: 3, kind: "parameter" },
				{ line: 63, column: 9 },
			],
		} as HoverResult;
		expect(formatHoverText(result, { surface: "mcp" })).toContain(
			"\nMatched line 57 of 3 declarations (also 59, 63); pass line to choose.",
		);
		expect(formatHoverText(result, { surface: "cli" })).toContain(
			"\nMatched line 57 of 3 declarations (also 59, 63); pass a line hint to choose, e.g. <file>:<name>:59.",
		);
	});

	test("ignores malformed optional fields", () => {
		const result = {
			...base,
			alternatives: "nope",
			overloads: [42],
		} as unknown as HoverResult;
		expect(formatHoverText(result, { surface: "cli" })).toBe(
			"number\nname: x\nkind: const",
		);
	});
});
