import { describe, expect, test } from "bun:test";
import path from "node:path";
import { batchHover, completions, hover } from "../index.js";

const fixturesDir = path.join(import.meta.dir, "fixtures");
const sampleFile = path.join(fixturesDir, "sample.ts");
const jsdocFile = path.join(fixturesDir, "with-jsdoc.ts");
const genericMethodFile = path.join(fixturesDir, "generic-method.ts");
const completionsFile = path.join(fixturesDir, "completions.ts");

describe("completions", () => {
	test("rejects positions outside the file with the valid range", () => {
		for (const [line, column, range] of [
			[999, 1, "Use a line between 1 and"],
			[1, 999, "use a column between 1 and"],
		] as const) {
			try {
				completions(completionsFile, line, column);
				throw new Error("expected completions to throw");
			} catch (error) {
				expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
				expect((error as { suggestion?: string }).suggestion).toContain(
					range,
				);
			}
		}
	});

	test("returns string-literal values at the cursor", () => {
		const result = completions(completionsFile, 3, 33);
		expect(result.entries.map((entry) => entry.name)).toEqual([
			"coffee",
			"tea",
		]);
	});

	test("filters by a case-insensitive prefix and reports the total", () => {
		const result = completions(completionsFile, 3, 33, { prefix: "COF" });
		expect(result.entries.map((entry) => entry.name)).toEqual(["coffee"]);
		expect(result).toMatchObject({
			prefix: "COF",
			total: 1,
			truncated: false,
		});
	});

	test("truncates to limit and ranks keywords after other globals", () => {
		const all = completions(completionsFile, 2, 1);
		expect(all.truncated).toBe(false);
		expect(all.total).toBe(all.entries.length);
		expect(all.total).toBeGreaterThan(100);

		const limited = completions(completionsFile, 2, 1, { limit: 5 });
		expect(limited.entries).toHaveLength(5);
		expect(limited).toMatchObject({ total: all.total, truncated: true });
		expect(limited.entries).toEqual(all.entries.slice(0, 5));
		// Locals rank first.
		expect(limited.entries[0]?.sortText).toBe("11");

		const sortTexts = all.entries.map((entry) => entry.sortText);
		expect(sortTexts).toEqual([...sortTexts].sort());
		const globals = all.entries.filter((entry) => entry.sortText === "15");
		const firstKeyword = globals.findIndex(
			(entry) => entry.kind === "keyword",
		);
		expect(firstKeyword).toBeGreaterThan(0);
		expect(
			globals
				.slice(firstKeyword)
				.every((entry) => entry.kind === "keyword"),
		).toBe(true);
	});

	test("preserves suggestions from a loose-autocomplete union", () => {
		const result = completions(completionsFile, 8, 41);
		expect(result.entries.map((entry) => entry.name)).toEqual([
			"coffee",
			"tea",
		]);
	});
});

describe("hover", () => {
	test("rejects lines and columns outside the file with the valid range", () => {
		for (const [line, column, message, suggestion] of [
			[1000, 1, "Line 1000 is outside", "Use a line between 1 and 45."],
			[
				4,
				90,
				"Column 90 is outside line 4",
				"Line 4 has 51 characters; use a column between 1 and 52.",
			],
		] as const) {
			expect(() => hover(sampleFile, line, column)).toThrow(message);
			try {
				hover(sampleFile, line, column);
			} catch (error) {
				expect(error).toMatchObject({
					code: "INVALID_ARGUMENT",
					suggestion,
				});
			}
		}
	});

	test("reports editor kinds for references, not identifier", () => {
		const kindsFile = path.join(fixturesDir, "hover-kinds.ts");
		for (const [line, column, kind] of [
			[13, 44, "parameter"], // name.length: the callback parameter
			[13, 49, "property"], // .length
			[34, 6, "parameter"], // person.id
			[38, 26, "const"], // user
			[38, 31, "property"], // .name
			[12, 14, "const"], // const names declaration
			[2, 9, "parameter"], // a + b
		] as const) {
			expect({
				line,
				column,
				kind: hover(kindsFile, line, column).kind,
			}).toEqual({ line, column, kind });
		}
	});

	test("gets type at function declaration", () => {
		// "add" function starts at line 4, column 17 is on the function name
		const result = hover(sampleFile, 4, 17);
		expect(result.signature).toContain("number");
		expect(result.returnType).toBe("number");
		expect(result.kind).toBe("function");
		expect(result.name).toBe("add");
	});

	test("gets type at arrow function variable", () => {
		// "multiply" at line 9, column 14 is on variable name
		const result = hover(sampleFile, 9, 14);
		expect(result.signature).toBe("(x: number, y: number) => number");
		expect(result.returnType).toBe("number");
		// The editor's label: the declaration keyword, not "function".
		expect(result.kind).toBe("const");
		expect(result.name).toBe("multiply");
	});

	test("gets type at generic function", () => {
		// "processData" at line 12
		const result = hover(sampleFile, 12, 17);
		expect(result.signature).toContain("T");
		expect(result.kind).toBe("function");
	});

	test("gets type at async function", () => {
		// "fetchUser" at line 17, column 24 on function name
		const result = hover(sampleFile, 17, 24);
		expect(result.returnType).toBeDefined();
		expect(result.returnType).toContain("Promise");
		expect(result.kind).toBe("function");
	});

	test("returns line and column in result", () => {
		const result = hover(sampleFile, 4, 17);
		expect(result.line).toBe(4);
		expect(result.column).toBeGreaterThan(0);
	});

	test("throws error for invalid file", () => {
		expect(() => {
			hover("/nonexistent/file.ts", 1, 1);
		}).toThrow("File not found");
	});

	test("throws error for invalid position", () => {
		expect(() => {
			hover(sampleFile, 1000, 1);
		}).toThrow();
	});

	test("omits cost unless requested; the deprecated include_timing does nothing", () => {
		expect(hover(sampleFile, 4, 17).cost).toBeUndefined();
		const result = hover(sampleFile, 4, 17, { include_timing: true });
		expect(result.cost).toBeUndefined();
		expect(result.timing).toBeUndefined();
	});
});

describe("batchHover", () => {
	test("returns structured, actionable errors per failed position", () => {
		const result = batchHover(sampleFile, [
			{ line: 4, column: 17 },
			{ line: 1, column: 5 },
			{ line: 1000, column: 1 },
		]);

		expect(result.successCount).toBe(1);
		expect(result.errorCount).toBe(2);
		expect(result.items[1]?.error).toMatchObject({
			code: "SYMBOL_NOT_FOUND",
			file: sampleFile,
			line: 1,
			column: 5,
			project: path.join(import.meta.dir, "..", "..", "tsconfig.json"),
		});
		expect(result.items[1]?.error?.suggestion).toContain("hover_by_name");
		expect(result.items[2]?.error).toMatchObject({
			code: "INVALID_ARGUMENT",
			line: 1000,
			suggestion: "Use a line between 1 and 45.",
		});
	});

	test("reports each item's cost as a single hover would", () => {
		const positions = [
			{ line: 4, column: 17 },
			{ line: 9, column: 14 },
		];
		const result = batchHover(sampleFile, positions, {
			include_cost: true,
		});

		expect(result.items.map((item) => item.result?.cost)).toEqual(
			positions.map(
				(position) =>
					hover(sampleFile, position.line, position.column, {
						include_cost: true,
					}).cost,
			),
		);
		expect("cost" in result).toBe(false);
	});
});

describe("hover with documentation", () => {
	test("extracts JSDoc from function", () => {
		// "add" function at line 9 (after JSDoc), column 17 on function name
		const result = hover(jsdocFile, 9, 17, { include_docs: true });
		expect(result.documentation).toBeDefined();
		expect(result.documentation).toContain("Adds two numbers together");
	});

	test("extracts multi-line JSDoc", () => {
		// "formatCurrency" at line 26 (actual function declaration line)
		const result = hover(jsdocFile, 26, 17, { include_docs: true });
		expect(result.documentation).toBeDefined();
		expect(result.documentation).toContain(
			"Formats a value as a currency string",
		);
	});

	test("returns undefined documentation when not requested", () => {
		const result = hover(jsdocFile, 9, 17);
		expect(result.documentation).toBeUndefined();
	});

	test("returns undefined documentation for symbols without JSDoc", () => {
		// "noDocumentation" at line 61 (actual function line)
		const result = hover(jsdocFile, 61, 17, { include_docs: true });
		expect(result.documentation).toBeUndefined();
	});

	test("extracts JSDoc from variable", () => {
		// "greeting" at line 34
		const result = hover(jsdocFile, 34, 14, { include_docs: true });
		expect(result.documentation).toBeDefined();
		expect(result.documentation).toContain("simple greeting message");
	});

	test("extracts JSDoc from class method", () => {
		// "multiply" method at line 55
		const result = hover(jsdocFile, 55, 2, { include_docs: true });
		expect(result.documentation).toBeDefined();
		expect(result.documentation).toContain("Multiplies two numbers");
	});
});

describe("hover on generic method calls", () => {
	test("gets instantiated type at call site", () => {
		// executeCommand call at line 22, column 15 is on "executeCommand"
		const result = hover(genericMethodFile, 22, 15);
		expect(result.signature).toContain('"Generate"');
		expect(result.returnType).toBe('{ result: "Generate"; }');
		expect(result.kind).toBe("call");
		expect(result.name).toBe("executeCommand");
	});
});

describe("hover on different node types", () => {
	test("gets type of class", () => {
		// Calculator class at line 35
		const result = hover(sampleFile, 35, 14);
		expect(result.kind).toBe("class");
		expect(result.name).toBe("Calculator");
	});

	test("gets type of interface", () => {
		// Processor interface at line 42
		const result = hover(sampleFile, 42, 18);
		expect(result.kind).toBe("interface");
		expect(result.name).toBe("Processor");
	});

	test("gets type of method signature in interface", () => {
		// process method at line 43
		const result = hover(sampleFile, 43, 2);
		expect(result.kind).toBe("method");
		expect(result.name).toBe("process");
	});
});
