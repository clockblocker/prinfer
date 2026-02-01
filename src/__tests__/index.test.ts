import { describe, expect, test } from "bun:test";
import path from "node:path";
import { inferType, inferTypeFromOptions } from "../index.js";

const fixturesDir = path.join(import.meta.dir, "fixtures");
const sampleFile = path.join(fixturesDir, "sample.ts");

describe("inferType", () => {
	test("infers type for a function declaration", () => {
		const result = inferType(sampleFile, "add");
		expect(result.signature).toBe("(a: number, b: number): number");
		expect(result.returnType).toBe("number");
	});

	test("infers type for an arrow function", () => {
		const result = inferType(sampleFile, "multiply");
		expect(result.signature).toContain("number");
	});

	test("infers type for a generic function", () => {
		const result = inferType(sampleFile, "processData");
		expect(result.signature).toContain("T");
	});

	test("infers type for an async function", () => {
		const result = inferType(sampleFile, "fetchUser");
		expect(result.returnType).toContain("Promise");
	});

	test("infers type for object method", () => {
		const result = inferType(sampleFile, "format");
		expect(result.signature).toContain("string");
	});

	test("throws error for missing file", () => {
		expect(() => {
			inferType("/nonexistent/file.ts", "foo");
		}).toThrow("File not found");
	});

	test("throws error for missing symbol", () => {
		expect(() => {
			inferType(sampleFile, "nonExistent");
		}).toThrow('No symbol named "nonExistent"');
	});
});

describe("inferTypeFromOptions", () => {
	test("works with options object", () => {
		const result = inferTypeFromOptions({
			file: sampleFile,
			name: "add",
		});
		expect(result.signature).toBe("(a: number, b: number): number");
	});

	test("accepts optional project path", () => {
		const projectPath = path.join(
			import.meta.dir,
			"..",
			"..",
			"tsconfig.json",
		);
		const result = inferTypeFromOptions({
			file: sampleFile,
			name: "add",
			project: projectPath,
		});
		expect(result.signature).toBeDefined();
	});
});

describe("line-based search", () => {
	test("finds symbol at specific line", () => {
		const result = inferType(sampleFile, "multiply", { line: 9 });
		expect(result.signature).toContain("number");
		expect(result.line).toBe(9);
	});

	test("includes line number in result", () => {
		const result = inferType(sampleFile, "add");
		expect(result.line).toBe(4);
	});

	test("finds object variable by name and line", () => {
		const result = inferType(sampleFile, "utils", { line: 27 });
		expect(result.signature).toContain("format");
		expect(result.line).toBe(27);
	});

	test("throws error when line does not match", () => {
		expect(() => {
			inferType(sampleFile, "add", { line: 1 });
		}).toThrow("at line 1");
	});
});
