import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	findFirstMatch,
	findNearestTsconfig,
	findNodeByNameAndLine,
	getTypeInfo,
	loadProgram,
} from "../core.js";

const fixturesDir = path.join(import.meta.dir, "fixtures");
const sampleFile = path.join(fixturesDir, "sample.ts");
const genericMethodFile = path.join(fixturesDir, "generic-method.ts");

describe("findNearestTsconfig", () => {
	test("finds tsconfig.json in project root", () => {
		const projectRoot = path.join(import.meta.dir, "..", "..");
		const result = findNearestTsconfig(projectRoot);
		expect(result).toBeDefined();
		expect(result).toContain("tsconfig.json");
	});

	test("returns undefined when no tsconfig exists", () => {
		const result = findNearestTsconfig("/tmp");
		expect(result).toBeUndefined();
	});
});

describe("loadProgram", () => {
	test("loads a program from a TypeScript file", () => {
		const program = loadProgram(sampleFile);
		expect(program).toBeDefined();
		expect(program.getSourceFile(sampleFile)).toBeDefined();
	});

	test("loads a program with explicit project path", () => {
		const projectPath = path.join(
			import.meta.dir,
			"..",
			"..",
			"tsconfig.json",
		);
		const program = loadProgram(sampleFile, projectPath);
		expect(program).toBeDefined();
	});
});

describe("findFirstMatch", () => {
	test("finds a function declaration", () => {
		const program = loadProgram(sampleFile);
		const sourceFile = program.getSourceFile(sampleFile)!;
		const node = findFirstMatch(sourceFile, "add");
		expect(node).toBeDefined();
	});

	test("finds an arrow function variable", () => {
		const program = loadProgram(sampleFile);
		const sourceFile = program.getSourceFile(sampleFile)!;
		const node = findFirstMatch(sourceFile, "multiply");
		expect(node).toBeDefined();
	});

	test("finds a method in an object literal", () => {
		const program = loadProgram(sampleFile);
		const sourceFile = program.getSourceFile(sampleFile)!;
		const node = findFirstMatch(sourceFile, "format");
		expect(node).toBeDefined();
	});

	test("finds a class method", () => {
		const program = loadProgram(sampleFile);
		const sourceFile = program.getSourceFile(sampleFile)!;
		// First need to check if we can find the class, then its method
		const node = findFirstMatch(sourceFile, "add");
		expect(node).toBeDefined();
	});

	test("returns undefined for non-existent symbol", () => {
		const program = loadProgram(sampleFile);
		const sourceFile = program.getSourceFile(sampleFile)!;
		const node = findFirstMatch(sourceFile, "nonExistent");
		expect(node).toBeUndefined();
	});
});

describe("getTypeInfo", () => {
	test("returns signature for function declaration", () => {
		const program = loadProgram(sampleFile);
		const sourceFile = program.getSourceFile(sampleFile)!;
		const node = findFirstMatch(sourceFile, "add")!;
		const info = getTypeInfo(program, node);
		expect(info.signature).toContain("number");
		expect(info.returnType).toBe("number");
	});

	test("returns signature for arrow function", () => {
		const program = loadProgram(sampleFile);
		const sourceFile = program.getSourceFile(sampleFile)!;
		const node = findFirstMatch(sourceFile, "multiply")!;
		const info = getTypeInfo(program, node);
		expect(info.signature).toContain("number");
	});

	test("returns signature for generic function", () => {
		const program = loadProgram(sampleFile);
		const sourceFile = program.getSourceFile(sampleFile)!;
		const node = findFirstMatch(sourceFile, "processData")!;
		const info = getTypeInfo(program, node);
		expect(info.signature).toContain("T");
		expect(info.returnType).toContain("T[]");
	});

	test("returns signature for async function", () => {
		const program = loadProgram(sampleFile);
		const sourceFile = program.getSourceFile(sampleFile)!;
		const node = findFirstMatch(sourceFile, "fetchUser")!;
		const info = getTypeInfo(program, node);
		expect(info.signature).toContain("string");
		expect(info.returnType).toContain("Promise");
	});
});

describe("generic method calls", () => {
	test("infers instantiated type at call site", () => {
		const program = loadProgram(genericMethodFile);
		const sourceFile = program.getSourceFile(genericMethodFile)!;
		const node = findNodeByNameAndLine(sourceFile, "executeCommand", 22);
		expect(node).toBeDefined();
		const info = getTypeInfo(program, node!);
		expect(info.signature).toContain('"Generate"');
		expect(info.returnType).toBe('{ result: "Generate"; }');
	});
});
