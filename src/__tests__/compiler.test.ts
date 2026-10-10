import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	spyOn,
	test,
} from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { COMPILER_ENV, compilerMode } from "../compiler.js";
import { hoverSuccessSchema } from "../contract.js";
import { formatHoverText } from "../hover-format.js";
import { diagnostics, hover } from "../index.js";
import { closeNativeSessions, nativeHover } from "../native-lsp.js";
import {
	closeTestingSessions,
	inferredTypeCost,
	inferredTypeInfo,
} from "../testing.js";
import type { CompilerInfo } from "../types.js";

// TypeScript 7 cases start compiler processes, some twice.
setDefaultTimeout(60_000);

/*
 * Project-mode fixtures: directories whose node_modules hold stand-ins for
 * a project's own compilers. Each stand-in re-exports prinfer's own
 * dependency under another version, so the tests run offline and still
 * prove which package was resolved, loaded, and reported.
 */

const require = createRequire(import.meta.url);
const realTypeScript = path.dirname(require.resolve("typescript/package.json"));
const realNative = path.dirname(
	require.resolve("@typescript/native/package.json"),
);
const SOURCE = 'export const user = { name: "x", age: 1 };\n';
const TSCONFIG = JSON.stringify({
	compilerOptions: { strict: true, module: "ESNext", target: "ES2022" },
	include: ["*.ts"],
});

let root: string;

function writeFiles(dir: string, files: Record<string, string>): void {
	for (const [name, text] of Object.entries(files)) {
		const file = path.join(dir, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	}
}

/** A project directory with a tsconfig.json, a.ts, and these packages. */
function project(name: string, packages: Record<string, string>): string {
	const dir = path.join(root, name);
	writeFiles(dir, {
		"tsconfig.json": TSCONFIG,
		"a.ts": SOURCE,
		...Object.fromEntries(
			Object.entries(packages).map(([file, text]) => [
				path.join("node_modules", file),
				text,
			]),
		),
	});
	return path.join(dir, "a.ts");
}

/** `typescript` at `version`, counting the programs it creates. */
function typeScriptPackage(version: string): Record<string, string> {
	return {
		"typescript/package.json": JSON.stringify({
			name: "typescript",
			version,
			main: "index.js",
		}),
		"typescript/index.js": [
			`const real = require(${JSON.stringify(realTypeScript)});`,
			"module.exports = {",
			"\t...real,",
			`\tversion: ${JSON.stringify(version)},`,
			"\tcreateProgram(...args) {",
			"\t\tglobalThis.__fixturePrograms = (globalThis.__fixturePrograms ?? 0) + 1;",
			"\t\treturn real.createProgram(...args);",
			"\t},",
			"};",
			"",
		].join("\n"),
	};
}

/**
 * `@typescript/native-preview` at `version`. With `api`, it exports the
 * API client and has a bin that starts the language server, both from
 * prinfer's `@typescript/native`; without, it is shaped like the dev builds
 * before 7.0.0-dev.20260515.1, which exported only package.json.
 */
function nativePreviewPackage(
	version: string,
	api: boolean,
): Record<string, string> {
	const real = (file: string) =>
		JSON.stringify(pathToFileURL(path.join(realNative, file)).href);
	const manifest = {
		name: "@typescript/native-preview",
		version,
		type: "module",
		bin: { tsgo: "./bin/tsgo.js" },
		exports: api
			? {
					"./package.json": "./package.json",
					"./unstable/async": "./async.js",
					"./unstable/ast": "./ast.js",
					"./unstable/ast/is": "./is.js",
				}
			: { "./package.json": "./package.json" },
	};
	const dir = "@typescript/native-preview";
	return {
		[`${dir}/package.json`]: JSON.stringify(manifest),
		[`${dir}/bin/tsgo.js`]: `import ${real("lib/tsc.js")};\n`,
		...(api
			? {
					[`${dir}/async.js`]: `export * from ${real("dist/api/async/api.js")};\n`,
					[`${dir}/ast.js`]: `export * from ${real("dist/ast/index.js")};\n`,
					[`${dir}/is.js`]: `export * from ${real("dist/ast/is.js")};\n`,
				}
			: {}),
	};
}

let ts59: string;
let ts49: string;
let ts7Only: string;
let preview: string;
let oldPreview: string;

beforeAll(() => {
	root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-compiler-")),
	);
	ts59 = project("ts59", typeScriptPackage("5.9.9"));
	ts49 = project("ts49", typeScriptPackage("4.9.5"));
	ts7Only = project("ts7", {
		"typescript/package.json": JSON.stringify({
			name: "typescript",
			version: "7.0.2",
			exports: { "./package.json": "./package.json" },
		}),
	});
	preview = project("preview", {
		...typeScriptPackage("6.0.1"),
		...nativePreviewPackage("7.0.0-dev.20260707.2", true),
	});
	oldPreview = project("old-preview", {
		...typeScriptPackage("6.0.1"),
		...nativePreviewPackage("7.0.0-dev.20260421.2", false),
	});
});

afterAll(async () => {
	closeNativeSessions();
	await closeTestingSessions();
	fs.rmSync(root, { recursive: true, force: true });
});

const previousEnv = process.env[COMPILER_ENV];
afterEach(() => {
	if (previousEnv === undefined) delete process.env[COMPILER_ENV];
	else process.env[COMPILER_ENV] = previousEnv;
});

function programs(): number {
	return (
		(globalThis as { __fixturePrograms?: number }).__fixturePrograms ?? 0
	);
}

function thrown(run: () => unknown): Error & {
	code?: string;
	suggestion?: string;
} {
	try {
		run();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected a throw");
}

const bundled6: CompilerInfo = {
	name: "typescript",
	version: ts.version,
	source: "bundled",
};

describe("compiler mode", () => {
	test("defaults to bundled, then PRINFER_COMPILER, then the option", () => {
		delete process.env[COMPILER_ENV];
		expect(compilerMode()).toBe("bundled");
		process.env[COMPILER_ENV] = "auto";
		expect(compilerMode()).toBe("auto");
		expect(compilerMode("project")).toBe("project");
	});

	test("rejects an unknown mode, naming where it came from", () => {
		process.env[COMPILER_ENV] = "local";
		expect(thrown(() => compilerMode()).message).toBe(
			'Unknown compiler "local" in PRINFER_COMPILER.',
		);
		const error = thrown(() =>
			hover(ts59, "user", { compiler: "local" as never }),
		);
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.suggestion).toContain('"project"');
	});
});

describe("TypeScript 6 in project mode", () => {
	test("bundled mode never loads the project's typescript", () => {
		const before = programs();
		const result = hover(ts59, "user");
		expect(result.compiler).toEqual(bundled6);
		expect(programs()).toBe(before);
	});

	test("runs and reports the project's typescript", () => {
		const before = programs();
		const result = hover(ts59, "user", { compiler: "project" });
		expect(result.signature).toBe("{ name: string; age: number; }");
		expect(result.compiler).toEqual({
			name: "typescript",
			version: "5.9.9",
			source: "project",
		});
		expect(programs()).toBe(before + 1);
		// Not enumerable: equality and snapshots ignore the compiler.
		expect(Object.keys(result)).not.toContain("compiler");
		expect(result).toEqual(hover(ts59, "user"));
		// The contract output carries it.
		expect(
			hoverSuccessSchema.parse({ version: 1, ok: true, result }),
		).toMatchObject({ result: { compiler: { version: "5.9.9" } } });
	});

	test("PRINFER_COMPILER selects it when the call doesn't", () => {
		process.env[COMPILER_ENV] = "project";
		expect(diagnostics(ts59).compiler?.version).toBe("5.9.9");
		expect(hover(ts59, "user", { compiler: "bundled" }).compiler).toEqual(
			bundled6,
		);
	});

	test("counts costs on it and says so", () => {
		const cost = inferredTypeCost(ts59, {
			name: "user",
			compiler: "project",
		});
		expect(cost.compiler?.version).toBe("5.9.9");
		expect(Object.keys(cost)).toEqual(["instantiations", "types"]);
		const result = hover(ts59, "user", {
			compiler: "project",
			include_cost: true,
		});
		expect(formatHoverText(result, { surface: "cli" })).toContain(
			"types (typescript 5.9.9, project)",
		);
	});

	test("keeps a program per compiler", () => {
		const before = programs();
		hover(ts59, "user", { compiler: "project" });
		hover(ts59, "user");
		hover(ts59, "user", { compiler: "project" });
		// The project's program was cached by the earlier tests.
		expect(programs()).toBe(before);
	});

	test("project mode rejects a typescript older than 5.0", () => {
		const error = thrown(() =>
			hover(ts49, "user", { compiler: "project" }),
		);
		expect(error.code).toBe("TYPESCRIPT_ERROR");
		expect(error.message).toContain(
			`typescript 4.9.5 at ${path.join(root, "ts49", "node_modules", "typescript")} is older than`,
		);
		expect(error.suggestion).toContain(`bundled TypeScript ${ts.version}`);
	});

	test("auto mode falls back to bundled with one warning", () => {
		const write = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			expect(hover(ts49, "user", { compiler: "auto" }).compiler).toEqual(
				bundled6,
			);
			hover(ts49, "user", { compiler: "auto" });
			const warnings = write.mock.calls.filter(([text]) =>
				String(text).includes("typescript 4.9.5"),
			);
			expect(warnings).toHaveLength(1);
			expect(String(warnings[0]?.[0])).toContain(
				`Using prinfer's bundled TypeScript ${ts.version} instead (compiler "auto").`,
			);
		} finally {
			write.mockRestore();
		}
		expect(
			hover(ts59, "user", { compiler: "auto" }).compiler?.version,
		).toBe("5.9.9");
	});

	test("a project on TypeScript 7 is pointed at the typescript7 backend", () => {
		const error = thrown(() =>
			hover(ts7Only, "user", { compiler: "project" }),
		);
		expect(error.message).toContain(
			"is TypeScript 7, which has no JavaScript compiler API",
		);
		expect(error.suggestion).toContain('backend "typescript7"');
	});
});

describe("CLI --compiler", () => {
	const cli = path.join(import.meta.dir, "..", "cli.ts");
	const run = (args: string[]) => {
		const result = Bun.spawnSync([process.execPath, "run", cli, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
			exitCode: result.exitCode,
		};
	};

	test("reports the compiler in --json output", () => {
		const { stdout, exitCode } = run([
			`${ts59}:user`,
			"--compiler",
			"project",
			"--json",
		]);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout).result.compiler).toEqual({
			name: "typescript",
			version: "5.9.9",
			source: "project",
		});
		const check = run(["check", ts59, "--compiler=project", "--json"]);
		expect(JSON.parse(check.stdout).result.compiler.version).toBe("5.9.9");
	});

	test("rejects an unknown mode", () => {
		const { stderr, exitCode } = run([
			`${ts59}:user`,
			"--compiler",
			"local",
		]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain(
			'Unknown compiler "local". Use bundled, project, or auto.',
		);
	});
});

describe("TypeScript 7 in project mode", () => {
	const previewInfo: CompilerInfo = {
		name: "@typescript/native-preview",
		version: "7.0.0-dev.20260707.2",
		source: "project",
	};

	test("the testing helpers run the project's compiler and API client", () => {
		const projectResult = inferredTypeInfo(preview, {
			name: "user",
			backend: "typescript7",
			compiler: "project",
		});
		expect(projectResult.compiler).toEqual(previewInfo);
		const bundledResult = inferredTypeInfo(preview, {
			name: "user",
			backend: "typescript7",
		});
		expect(bundledResult.compiler).toMatchObject({
			name: "typescript",
			source: "bundled",
		});
		expect(projectResult).toEqual(bundledResult);
		expect(Object.keys(projectResult)).not.toContain("compiler");
	});

	test("the language server backend runs the project's bin", async () => {
		const result = await nativeHover(preview, 1, 14, {
			compiler: "project",
		});
		expect(result.signature).toBe("{ name: string; age: number; }");
		expect(result.compiler).toEqual(previewInfo);
		// Switching back closes the project's sessions and starts bundled ones.
		const bundled = await nativeHover(preview, 1, 14);
		expect(bundled.compiler?.source).toBe("bundled");
	});

	test("rejects a native-preview build without a compatible API, naming versions", () => {
		const error = thrown(() =>
			inferredTypeInfo(oldPreview, {
				name: "user",
				backend: "typescript7",
				compiler: "project",
			}),
		);
		expect(error.code).toBe("TYPESCRIPT_ERROR");
		expect(error.message).toContain(
			"@typescript/native-preview 7.0.0-dev.20260421.2 at",
		);
		expect(error.message).toContain(
			"its compiler predates the API protocol prinfer speaks (7.0.0-dev.20260624.1 or later)",
		);
		// The TypeScript 6 side of the same project still works.
		expect(
			hover(oldPreview, "user", { compiler: "project" }).compiler
				?.version,
		).toBe("6.0.1");
	});

	test("auto mode falls back to the bundled TypeScript 7", () => {
		const result = inferredTypeInfo(oldPreview, {
			name: "user",
			backend: "typescript7",
			compiler: "auto",
		});
		expect(result.compiler).toMatchObject({
			name: "typescript",
			source: "bundled",
		});
	});
});
