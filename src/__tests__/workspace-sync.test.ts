import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	includeRoots,
	relativeImports,
	WorkspaceFiles,
} from "../core/workspace-files.js";
import { hover } from "../index.js";
import {
	closeNativeSessions,
	nativeDiagnostics,
	nativeHover,
	nativeWorkspaceStats,
} from "../native-lsp.js";

afterAll(closeNativeSessions);

function tempDir(files: Record<string, string>): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "typeprobe-sync-")),
	);
	for (const [name, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), text);
	}
	return dir;
}

const tsconfig = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		compilerOptions: {
			strict: true,
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "bundler",
			types: [],
		},
		...extra,
	});

/** Bump mtime explicitly so same-millisecond rewrites still differ. */
function touch(file: string, text: string, offsetMs = 0): void {
	fs.writeFileSync(file, text);
	const time = new Date(Date.now() + offsetMs);
	fs.utimesSync(file, time, time);
}

describe("WorkspaceFiles", () => {
	test("follows relative imports, including created and deleted targets", () => {
		const dir = tempDir({
			"main.ts": 'import { a } from "./a";\nimport "./missing.js";\n',
			"a.ts": 'export { b as a } from "./nested/b";\n',
			"nested/b.ts": "export const b = 1;\n",
			"unrelated.ts": "export const u = 1;\n",
		});
		const files = new WorkspaceFiles(dir, 0);
		const main = path.join(dir, "main.ts");
		files.checkImports(main);

		touch(path.join(dir, "nested/b.ts"), "export const b = 2;\n", 5000);
		touch(path.join(dir, "unrelated.ts"), "export const u = 2;\n", 5000);
		expect(files.checkImports(main)).toEqual([
			{ file: path.join(dir, "nested/b.ts"), type: 2 },
		]);

		// "./missing.js" resolves to missing.ts once it exists.
		fs.writeFileSync(path.join(dir, "missing.ts"), "export {};\n");
		expect(files.checkImports(main)).toContainEqual({
			file: path.join(dir, "missing.ts"),
			type: expect.any(Number),
		});

		fs.rmSync(path.join(dir, "nested/b.ts"));
		expect(files.checkImports(main)).toEqual([
			{ file: path.join(dir, "nested/b.ts"), type: 3 },
		]);
		expect(files.checkImports(main)).toEqual([]);
	});

	test("reports files first seen after the session started", () => {
		const dir = tempDir({ "main.ts": "export const m = 1;\n" });
		const main = path.join(dir, "main.ts");
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(main, old, old);
		const files = new WorkspaceFiles(dir, Date.now());
		expect(files.checkImports(main)).toEqual([]);

		const late = path.join(dir, "late.ts");
		fs.writeFileSync(late, "export const l = 1;\n");
		fs.writeFileSync(main, 'import "./late";\n');
		const changes = files.checkImports(main);
		expect(changes.map((change) => change.file).sort()).toEqual(
			[late, main].sort(),
		);
	});

	test("skips dependency, build, and dot directories", () => {
		const dir = tempDir({
			"tsconfig.json": tsconfig(),
			"src/main.ts": "export const m = 1;\n",
			"src/other.ts": "export const o = 1;\n",
			"dist/out.ts": "export const d = 1;\n",
			"coverage/c.ts": "export const c = 1;\n",
			"venv/v.ts": "export const v = 1;\n",
			".cache/x.ts": "export const x = 1;\n",
		});
		const files = new WorkspaceFiles(dir, 0);
		const main = path.join(dir, "src/main.ts");
		files.scanWorkspace(main);
		for (const name of [
			"src/other.ts",
			"dist/out.ts",
			"coverage/c.ts",
			"venv/v.ts",
			".cache/x.ts",
		]) {
			touch(path.join(dir, name), "export const changed = 2;\n", 5000);
		}
		expect(files.scanWorkspace(main)).toEqual([
			{ file: path.join(dir, "src/other.ts"), type: 2 },
		]);
	});

	test("scans only the tsconfig include roots", () => {
		const dir = tempDir({
			"tsconfig.json": tsconfig({ include: ["src/**/*.ts", "types"] }),
			"src/main.ts": "export const m = 1;\n",
			"types/global.d.ts": "declare const g: number;\n",
			"scripts/tool.ts": "export const t = 1;\n",
		});
		expect(includeRoots(dir)).toEqual([
			path.join(dir, "src"),
			path.join(dir, "types"),
		]);
		const files = new WorkspaceFiles(dir, 0);
		const main = path.join(dir, "src/main.ts");
		files.scanWorkspace(main);
		touch(
			path.join(dir, "types/global.d.ts"),
			"declare const g: 1;\n",
			5000,
		);
		touch(path.join(dir, "scripts/tool.ts"), "export const t = 2;\n", 5000);
		expect(files.scanWorkspace(main)).toEqual([
			{ file: path.join(dir, "types/global.d.ts"), type: 2 },
		]);
	});

	test("takes include roots from referenced projects", () => {
		const dir = tempDir({
			"tsconfig.json": JSON.stringify({
				files: [],
				references: [
					{ path: "./tsconfig.app.json" },
					{ path: "./packages/lib" },
				],
			}),
			"tsconfig.app.json": tsconfig({ include: ["app"] }),
			"packages/lib/tsconfig.json": tsconfig({ include: ["src/**/*"] }),
		});
		expect(includeRoots(dir)).toEqual([
			path.join(dir, "app"),
			path.join(dir, "packages/lib/src"),
		]);
		expect(includeRoots(path.join(dir, "missing"))).toEqual([
			path.join(dir, "missing"),
		]);
	});

	test("counts every entry against the budget and stops scanning", () => {
		const assets: Record<string, string> = {};
		for (let index = 0; index < 60; index++) {
			assets[`assets/image${index}.png`] = "";
		}
		const dir = tempDir({
			"tsconfig.json": tsconfig(),
			"main.ts": 'import "./dep";\n',
			"dep.ts": "export const d = 1;\n",
			...assets,
		});
		const files = new WorkspaceFiles(dir, 0, { maxEntries: 50 });
		const main = path.join(dir, "main.ts");
		files.scanWorkspace(main);
		expect(files.stats).toEqual({ entries: 51, disabled: true });
		// Imports are still checked once the scan is disabled.
		touch(path.join(dir, "dep.ts"), "export const d = 2;\n", 5000);
		expect(files.scanWorkspace(main)).toEqual([
			{ file: path.join(dir, "dep.ts"), type: 2 },
		]);
	});

	test("reads relative imports, re-exports, and references", () => {
		const file = "/project/src/main.ts";
		const candidates = relativeImports(
			file,
			[
				'/// <reference path="./types.d.ts" />',
				'import { a } from "./a.js";',
				'export * from "../shared";',
				'import pkg from "package";',
				'const lazy = import("./lazy.mjs");',
				'// import { c } from "./commented";',
			].join("\n"),
		);
		expect(candidates.map((list) => list[0])).toEqual([
			"/project/src/a.ts",
			"/project/shared.ts",
			"/project/src/lazy.mts",
			"/project/src/types.d.ts",
		]);
	});
});

describe.each([
	["typescript6", async (file: string) => hover(file, 2, 14)],
	["typescript7", (file: string) => nativeHover(file, 2, 14)],
] as const)("hover freshness (%s)", (_name, hoverTotal) => {
	let dir: string;
	beforeEach(() => {
		dir = tempDir({
			"tsconfig.json": tsconfig(),
			"dep.ts": "export const value: number = 1;\n",
			"main.ts":
				'import { value } from "./dep";\nexport const total = value;\n',
		});
	});

	test("sees edits to an unopened imported file immediately", async () => {
		const main = path.join(dir, "main.ts");
		const dep = path.join(dir, "dep.ts");
		expect((await hoverTotal(main)).signature).toContain("number");
		// TypeScript 6 rebuilds its program after each edit, so keep this short.
		for (const [type, literal] of [
			["string", '"x"'],
			["boolean", "true"],
		]) {
			fs.writeFileSync(
				dep,
				`export const value: ${type} = ${literal};\n`,
			);
			expect((await hoverTotal(main)).signature).toContain(type);
		}
	}, 30_000);
});

describe("TypeScript 7 workspace scan", () => {
	test("hover-only sessions never scan the workspace", async () => {
		const dir = tempDir({
			"tsconfig.json": tsconfig(),
			"main.ts": "export const total = 1;\n",
			"other.ts": "export const other = 1;\n",
		});
		const main = path.join(dir, "main.ts");
		await nativeHover(main, 1, 14);
		expect(nativeWorkspaceStats(main)?.entries).toBe(0);
		await nativeDiagnostics(main);
		expect(nativeWorkspaceStats(main)?.entries).toBeGreaterThan(0);
	});

	test("an edit made before the first diagnostics call is seen", async () => {
		const dir = tempDir({
			"tsconfig.json": tsconfig(),
			"dep.ts": "export const value: number = 1;\n",
			"main.ts":
				'import { value } from "./dep";\nexport const total: number = value;\n',
		});
		const main = path.join(dir, "main.ts");
		// The server loads dep.ts for this hover; no baseline scan runs.
		expect((await nativeHover(main, 2, 14)).signature).toContain("number");
		fs.writeFileSync(
			path.join(dir, "dep.ts"),
			'export const value: string = "x";\n',
		);
		expect((await nativeDiagnostics(main)).diagnostics[0]?.code).toBe(2322);
	});
});
