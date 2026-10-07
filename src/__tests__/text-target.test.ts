import { describe, expect, test } from "bun:test";
import { contractError } from "../contract.js";
import { resolveTextColumn } from "../core/index.js";
import { PrinferError } from "../errors.js";

const source = [
	"const total = sum(items);",
	"  const doubled = items.map((item) => item * 2);",
	"export const items = [1, 2];",
].join("\n");

function thrown(fn: () => unknown): PrinferError {
	try {
		fn();
	} catch (error) {
		if (error instanceof PrinferError) return error;
		throw error;
	}
	throw new Error("expected a PrinferError");
}

describe("resolveTextColumn", () => {
	test("returns the 1-based start column of the first match", () => {
		expect(resolveTextColumn(source, { line: 1, text: "sum" })).toBe(15);
	});

	test("counts occurrences left to right", () => {
		expect(
			resolveTextColumn(source, { line: 2, text: "item", occurrence: 2 }),
		).toBe(30);
		expect(
			resolveTextColumn(source, { line: 2, text: "item", occurrence: 3 }),
		).toBe(39);
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
			'Line 1 reads: "const total = sum(items);". Copy text exactly from it, or pass column instead. "doubled" appears on line 2.',
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
