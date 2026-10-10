import { describe, expect, test } from "bun:test";
import { contractError } from "../contract.js";
import { resolveTextColumn } from "../core/index.js";
import { TypeprobeError } from "../errors.js";

const source = [
	"const total = sum(items);",
	"  const doubled = items.map((item) => item * 2);",
	"export const items = [1, 2];",
].join("\n");

function thrown(fn: () => unknown): TypeprobeError {
	try {
		fn();
	} catch (error) {
		if (error instanceof TypeprobeError) return error;
		throw error;
	}
	throw new Error("expected a TypeprobeError");
}

describe("resolveTextColumn", () => {
	test("returns the 1-based start column of the first match", () => {
		expect(resolveTextColumn(source, { line: 1, text: "sum" })).toBe(15);
	});

	test("counts whole-identifier occurrences left to right", () => {
		// "items" on the same line is not a match for "item".
		expect(resolveTextColumn(source, { line: 2, text: "item" })).toBe(30);
		expect(
			resolveTextColumn(source, { line: 2, text: "item", occurrence: 2 }),
		).toBe(39);
		const error = thrown(() =>
			resolveTextColumn(source, { line: 2, text: "item", occurrence: 3 }),
		);
		expect(error.message).toContain("the line has 2");
	});

	test("skips the identifier prefix in users.map((user) => ...)", () => {
		const line = "export const names = users.map((user) => user.name);";
		expect(resolveTextColumn(line, { line: 1, text: "user" })).toBe(33);
		expect(
			resolveTextColumn(line, { line: 1, text: "user", occurrence: 2 }),
		).toBe(42);
		expect(resolveTextColumn(line, { line: 1, text: "users" })).toBe(22);
	});

	test("checks identifier boundaries only on identifier edges", () => {
		const line = "const $el = $element; const a1 = a; foo.bar(user.id);";
		expect(resolveTextColumn(line, { line: 1, text: "$el" })).toBe(7);
		expect(resolveTextColumn(line, { line: 1, text: "a" })).toBe(34);
		expect(resolveTextColumn(line, { line: 1, text: "user." })).toBe(45);
		expect(resolveTextColumn(line, { line: 1, text: ".bar(" })).toBe(40);
		const unicode = "const café = cafés[0]; café;";
		expect(
			resolveTextColumn(unicode, {
				line: 1,
				text: "café",
				occurrence: 2,
			}),
		).toBe(24);
	});

	test("falls back to substring matches when no whole match exists", () => {
		expect(resolveTextColumn(source, { line: 3, text: "port" })).toBe(3);
		expect(
			resolveTextColumn(source, { line: 2, text: "ite", occurrence: 3 }),
		).toBe(39);
	});

	test("suggests lines with whole matches before partial ones", () => {
		const text = ["const a = 1;", "const users = [];", "f(user);"].join(
			"\n",
		);
		const error = thrown(() =>
			resolveTextColumn(text, { line: 1, text: "user" }),
		);
		expect(error.suggestion).toEndWith('"user" appears on line 3.');
		const partial = thrown(() =>
			resolveTextColumn(text, { line: 1, text: "sers" }),
		);
		expect(partial.suggestion).toEndWith('"sers" appears on line 2.');
	});

	test("counts lines and columns like TypeScript", () => {
		const text =
			"\uFEFFconst bom = 1;\rconst cr = 2;\u2028const ls = 3;\u2029const ps = 4;\r\nconst crlf = 5;\nconst lf = 6;";
		// The BOM is not a column; CR, U+2028, U+2029, CRLF, and LF end lines.
		expect(resolveTextColumn(text, { line: 1, text: "bom" })).toBe(7);
		expect(resolveTextColumn(text, { line: 2, text: "cr" })).toBe(7);
		expect(resolveTextColumn(text, { line: 3, text: "ls" })).toBe(7);
		expect(resolveTextColumn(text, { line: 4, text: "ps" })).toBe(7);
		expect(resolveTextColumn(text, { line: 5, text: "crlf" })).toBe(7);
		expect(resolveTextColumn(text, { line: 6, text: "lf" })).toBe(7);
		const error = thrown(() =>
			resolveTextColumn(text, { line: 7, text: "x" }),
		);
		expect(error.suggestion).toBe("Use a line between 1 and 6.");
	});

	test("quotes the line and other matching lines when text is missing", () => {
		const error = thrown(() =>
			resolveTextColumn(source, { line: 1, text: "doubled" }, "a.ts"),
		);
		expect(error.code).toBe("SYMBOL_NOT_FOUND");
		expect(error.message).toBe(
			'Text "doubled" not found on line 1 of a.ts',
		);
		expect(error.suggestion).toBe(
			'Line 1 reads: "const total = sum(items);". Copy text exactly from it, or give a column instead. "doubled" appears on line 2.',
		);
		const response = contractError(error);
		expect(response.error.code).toBe("SYMBOL_NOT_FOUND");
		expect(response.error.suggestion).toBe(error.suggestion);
	});

	test("reports how many occurrences the line has", () => {
		const error = thrown(() =>
			resolveTextColumn(source, { line: 1, text: "o", occurrence: 9 }),
		);
		expect(error.message).toContain("the line has 2");
		expect(error.suggestion).toContain("use occurrence 1-2");
	});

	test("rejects lines outside the file", () => {
		const error = thrown(() =>
			resolveTextColumn(source, { line: 4, text: "x" }),
		);
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.suggestion).toBe("Use a line between 1 and 3.");
	});

	test("truncates long lines in suggestions", () => {
		const long = `const value = ${"x".repeat(300)};`;
		const error = thrown(() =>
			resolveTextColumn(long, { line: 1, text: "missing" }),
		);
		expect(error.suggestion?.length).toBeLessThan(250);
		expect(error.suggestion).toContain('..."');
	});
});
