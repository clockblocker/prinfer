import { describe, expect, test } from "bun:test";
import path from "node:path";
import { hover } from "../index.js";

const fixturesDir = path.join(import.meta.dir, "fixtures");
const sampleFile = path.join(fixturesDir, "sample.ts");
const jsdocFile = path.join(fixturesDir, "with-jsdoc.ts");
const genericMethodFile = path.join(fixturesDir, "generic-method.ts");

describe("hover", () => {
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
		expect(result.signature).toContain("number");
		expect(result.kind).toBe("function");
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
