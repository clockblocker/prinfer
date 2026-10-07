import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contractError } from "../contract.js";
import { diagnostics, hover } from "../index.js";
import {
	closeNativeSessions,
	nativeDiagnostics,
	nativeHover,
	nativeHoverByName,
} from "../native-lsp.js";

const fixture = path.join(import.meta.dir, "fixtures", "sample.ts");
const jsdocFixture = path.join(import.meta.dir, "fixtures", "with-jsdoc.ts");

afterAll(closeNativeSessions);

describe("TypeScript 7 native LSP", () => {
	test("returns native hover information by position", async () => {
		const result = await nativeHover(fixture, 4, 17);
		expect(result.signature).toBe(
			"function add(a: number, b: number): number",
		);
		expect(result.returnType).toBe("number");
		expect(result.name).toBe("add");
		expect(result.kind).toBe("function");
	});

	test("reuses the session for name-based hover", async () => {
		const result = await nativeHoverByName(fixture, "multiply", {
			include_timing: true,
		});
		expect(result.signature).toContain("(x: number, y: number) => number");
		expect(result.name).toBe("multiply");
		expect(result.timing?.resolution_ms).toBeGreaterThanOrEqual(0);
		expect(Object.keys(result.timing ?? {})).toEqual(["resolution_ms"]);
	});

	test("keeps documentation out of the signature", async () => {
		const plain = await nativeHoverByName(jsdocFixture, "add");
		expect(plain.signature).toBe(
			"function add(a: number, b: number): number",
		);
		expect(plain.returnType).toBe("number");
		expect(plain.documentation).toBeUndefined();

		const documented = await nativeHoverByName(jsdocFixture, "add", {
			include_docs: true,
		});
		expect(documented.signature).toBe(plain.signature);
		expect(documented.documentation).toContain(
			"Adds two numbers together.",
		);
	});
});

describe("TypeScript 7 project selection", () => {
	const compilerOptions = { strict: true, types: [] };
	function setup(files: Record<string, unknown>): string {
		const dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-project-")),
		);
		fs.mkdirSync(path.join(dir, "src"));
		fs.writeFileSync(
			path.join(dir, "src", "main.ts"),
			"export const value = 1;\n",
		);
		for (const [name, config] of Object.entries(files)) {
			fs.writeFileSync(path.join(dir, name), JSON.stringify(config));
		}
		return dir;
	}

	async function failure(run: () => Promise<unknown>) {
		return run().then(
			() => {
				throw new Error("expected a failure");
			},
			(error: unknown) => contractError(error).error,
		);
	}

	test("rejects a tsconfig the language server would not use", async () => {
		const dir = setup({
			"tsconfig.json": { compilerOptions, include: ["src"] },
			"tsconfig.build.json": {
				compilerOptions: { ...compilerOptions, strict: false },
				include: ["src"],
			},
		});
		const main = path.join(dir, "src", "main.ts");
		const project = path.join(dir, "tsconfig.build.json");
		for (const run of [
			() => nativeHover(main, 1, 14, { project }),
			() => nativeHoverByName(main, "value", { project }),
			() => nativeDiagnostics(main, { project }),
		]) {
			const error = await failure(run);
			expect(error.code).toBe("INVALID_ARGUMENT");
			expect(error.message).toContain(path.join(dir, "tsconfig.json"));
			expect(error.suggestion).toContain('backend "typescript6"');
		}
		// The TypeScript 6 backend honors the same project.
		expect(hover(main, 1, 14, { project }).name).toBe("value");
		expect(diagnostics(main, { project }).errorCount).toBe(0);
	}, 30_000);

	test("accepts the tsconfig it picks, by file or directory", async () => {
		const dir = setup({ "tsconfig.json": { compilerOptions } });
		const main = path.join(dir, "src", "main.ts");
		for (const project of [path.join(dir, "tsconfig.json"), dir]) {
			const result = await nativeHover(main, 1, 14, { project });
			expect(result.name).toBe("value");
		}
	}, 30_000);

	test("accepts a project referenced by a solution tsconfig", async () => {
		const dir = setup({
			"tsconfig.json": {
				files: [],
				references: [{ path: "./tsconfig.build.json" }],
			},
			"tsconfig.build.json": {
				compilerOptions: { ...compilerOptions, composite: true },
				include: ["src"],
			},
		});
		const main = path.join(dir, "src", "main.ts");
		const project = path.join(dir, "tsconfig.build.json");
		expect((await nativeHover(main, 1, 14, { project })).name).toBe(
			"value",
		);
		expect((await nativeDiagnostics(main, { project })).errorCount).toBe(0);
	}, 30_000);

	test("reports a missing project as FILE_NOT_FOUND", async () => {
		const dir = setup({ "tsconfig.json": { compilerOptions } });
		const error = await failure(() =>
			nativeHover(path.join(dir, "src", "main.ts"), 1, 14, {
				project: path.join(dir, "missing.json"),
			}),
		);
		expect(error.code).toBe("FILE_NOT_FOUND");
	});
});
