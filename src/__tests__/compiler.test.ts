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
	expectType,
	expectTypes,
	inferredTypeCost,
	inferredTypeInfo,
	TypeExpectationError,
} from "../testing.js";
import type { CompilerInfo } from "../types.js";

// TypeScript 7 cases start compiler processes, some twice.
setDefaultTimeout(60_000);

/*
 * Project-mode fixtures: directories whose node_modules hold stand-ins for
 * a project's own compilers. Each stand-in re-exports typeprobe's own
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
 * typeprobe's `@typescript/native`; without, it is shaped like the dev builds
 * before 7.0.0-dev.20260515.1, which exported only package.json. `name` is
 * the install directory and `manifestName` its package.json name: an alias
 * such as `@typescript/native` (npm:typescript@7) differs.
 */
function nativePreviewPackage(
	version: string,
	api: boolean,
	name = "@typescript/native-preview",
	manifestName = name,
): Record<string, string> {
	const real = (file: string) =>
		JSON.stringify(pathToFileURL(path.join(realNative, file)).href);
	const manifest = {
		name: manifestName,
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
	const dir = name;
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
let ts7Api: string;
let nativeAlias: string;
let nativeTie: string;
let nativeNested: string;
let oldAlias: string;
let hoisted: string;
let hoistedDeclared: string;
let hoistedWorkspace: string;

beforeAll(() => {
	root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "typeprobe-compiler-")),
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
	ts7Api = project(
		"ts7-api",
		nativePreviewPackage("7.0.2", true, "typescript"),
	);
	oldPreview = project("old-preview", {
		...typeScriptPackage("6.0.1"),
		...nativePreviewPackage("7.0.0-dev.20260421.2", false),
	});
	const alias = (version: string) =>
		nativePreviewPackage(version, true, "@typescript/native", "typescript");
	nativeAlias = project("native-alias", {
		...typeScriptPackage("6.0.1"),
		...alias("7.0.5"),
	});
	// typescript 7 and @typescript/native side by side: typescript wins.
	nativeTie = project("native-tie", {
		...nativePreviewPackage("7.0.2", true, "typescript"),
		...alias("7.0.5"),
	});
	// A typescript 7 in the parent, @typescript/native in the project.
	writeFiles(path.join(root, "native-nested"), {
		"node_modules/typescript/package.json": JSON.stringify({
			name: "typescript",
			version: "7.0.2",
			exports: { "./package.json": "./package.json" },
		}),
	});
	nativeNested = project("native-nested/app", alias("7.0.5"));
	oldAlias = project("old-alias", alias("7.0.0-dev.20260421.2"));
	// typeprobe's own typescript and @typescript/native, hoisted into the
	// project's node_modules, as npm and bun install them.
	const hoist = (dir: string, manifest: object) => {
		const file = project(dir, {});
		const base = path.dirname(file);
		writeFiles(base, { "package.json": JSON.stringify(manifest) });
		const modules = path.join(base, "node_modules");
		fs.mkdirSync(path.join(modules, "@typescript"), { recursive: true });
		fs.symlinkSync(realTypeScript, path.join(modules, "typescript"));
		fs.symlinkSync(realNative, path.join(modules, "@typescript", "native"));
		return file;
	};
	hoisted = hoist("hoisted", { name: "app", dependencies: { zod: "^4" } });
	hoistedDeclared = hoist("hoisted-declared", {
		name: "app",
		devDependencies: {
			"@typescript/native": "npm:typescript@^7.0.2",
			typescript: "^6.0.3",
		},
	});
	// A workspace package whose root declares both compilers.
	hoist("hoisted-workspace", {
		name: "root",
		workspaces: ["packages/*"],
		devDependencies: {
			"@typescript/native": "npm:typescript@^7.0.2",
			typescript: "^6.0.3",
		},
	});
	hoistedWorkspace = project("hoisted-workspace/packages/app", {});
	writeFiles(path.dirname(hoistedWorkspace), {
		"package.json": JSON.stringify({ name: "app" }),
	});
});

afterAll(async () => {
	closeNativeSessions();
	await closeTestingSessions();
	fs.rmSync(root, { recursive: true, force: true });
});

const LEGACY_COMPILER_ENV = "PRINFER_COMPILER";
const previousEnv = process.env[COMPILER_ENV];
const previousLegacyEnv = process.env[LEGACY_COMPILER_ENV];
afterEach(() => {
	if (previousEnv === undefined) delete process.env[COMPILER_ENV];
	else process.env[COMPILER_ENV] = previousEnv;
	if (previousLegacyEnv === undefined)
		delete process.env[LEGACY_COMPILER_ENV];
	else process.env[LEGACY_COMPILER_ENV] = previousLegacyEnv;
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
	test("defaults to bundled, then TYPEPROBE_COMPILER, then the option", () => {
		delete process.env[COMPILER_ENV];
		expect(compilerMode()).toBe("bundled");
		process.env[COMPILER_ENV] = "auto";
		expect(compilerMode()).toBe("auto");
		expect(compilerMode("project")).toBe("project");
	});

	test("falls back to the deprecated PRINFER_COMPILER", () => {
		delete process.env[COMPILER_ENV];
		process.env[LEGACY_COMPILER_ENV] = "auto";
		expect(compilerMode()).toBe("auto");
		process.env[COMPILER_ENV] = "project";
		expect(compilerMode()).toBe("project");
		delete process.env[COMPILER_ENV];
		process.env[LEGACY_COMPILER_ENV] = "local";
		expect(thrown(() => compilerMode()).message).toBe(
			'Unknown compiler "local" in PRINFER_COMPILER.',
		);
	});

	test("rejects an unknown mode, naming where it came from", () => {
		process.env[COMPILER_ENV] = "local";
		expect(thrown(() => compilerMode()).message).toBe(
			'Unknown compiler "local" in TYPEPROBE_COMPILER.',
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

	test("TYPEPROBE_COMPILER selects it when the call doesn't", () => {
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

	test("counts batched costs and expectType budgets on it", () => {
		const project59: CompilerInfo = {
			name: "typescript",
			version: "5.9.9",
			source: "project",
		};
		const single = inferredTypeCost(ts59, {
			name: "user",
			compiler: "project",
		});
		const byName = inferredTypeCost(ts59, {
			names: ["user"],
			compiler: "project",
			strict: true,
		});
		const inOrder = inferredTypeCost(ts59, {
			targets: [{ name: "user" }, { line: 1, text: "user" }],
			compiler: "project",
			strict: true,
		});
		for (const cost of [single, byName.user, ...inOrder]) {
			expect(cost?.compiler).toEqual(project59);
			expect(cost).toEqual(single);
		}
		expect(
			inferredTypeCost(ts59, { names: ["user"] }).user?.compiler,
		).toEqual(bundled6);

		const checked = expectType(ts59, {
			name: "user",
			compiler: "project",
			printed: "{ name: string; age: number; }",
			maxTypes: 1_000,
			strict: true,
		});
		expect(checked.cost?.compiler).toEqual(project59);
		let error: unknown;
		try {
			expectType(ts59, {
				name: "user",
				compiler: "project",
				maxTypes: 0,
			});
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(TypeExpectationError);
		expect((error as Error).message).toContain(
			"(counted and printed on typescript 5.9.9, project).",
		);
	});

	test("costCompiler counts on another compiler than the one that prints", () => {
		const checked = expectType(ts59, {
			name: "user",
			costCompiler: "project",
			printed: "{ name: string; age: number; }",
			maxTypes: 1_000,
			strict: true,
		});
		expect(checked.cost?.compiler?.version).toBe("5.9.9");
		expect((checked as { compiler?: CompilerInfo }).compiler).toEqual(
			bundled6,
		);
		const error = thrown(() =>
			expectType(ts59, {
				name: "user",
				costCompiler: "project",
				maxTypes: 0,
			}),
		);
		expect(error.message).toContain(
			`(counted on typescript 5.9.9, project; printed on typescript ${ts.version}, bundled).`,
		);
		// The other way round, and in a group.
		const group = expectTypes(ts59, {
			types: [
				{ name: "user", printed: "{ name: string; age: number; }" },
			],
			compiler: "project",
			costCompiler: "bundled",
			maxTypes: 1_000,
			strict: true,
		});
		expect(group.cost?.compiler).toEqual(bundled6);
		expect(
			(group.types[0] as { compiler?: CompilerInfo }).compiler?.version,
		).toBe("5.9.9");
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
				`Using typeprobe's bundled TypeScript ${ts.version} instead (compiler "auto").`,
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

	test("expectType counts a TypeScript 7 target on the project's TypeScript 6", () => {
		const checked = expectType(preview, {
			name: "user",
			backend: "typescript7",
			compiler: "project",
			printed: "{ name: string; age: number; }",
			maxInstantiations: 1_000,
		});
		expect(checked.cost?.compiler).toEqual({
			name: "typescript",
			version: "6.0.1",
			source: "project",
		});
		// Without a TypeScript 6 of its own, the bundled one counts.
		const write = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			const counted = expectType(ts7Api, {
				name: "user",
				backend: "typescript7",
				compiler: "project",
				maxInstantiations: 1_000,
			});
			expect(counted.cost?.compiler).toEqual(bundled6);
			expect(
				inferredTypeInfo(ts7Api, {
					name: "user",
					backend: "typescript7",
					compiler: "project",
				}).compiler,
			).toEqual({
				name: "typescript",
				version: "7.0.2",
				source: "project",
			});
		} finally {
			write.mockRestore();
		}
	});

	test("costCompiler prints on the bundled TypeScript 7 and counts on the project's TypeScript 6", () => {
		const project601: CompilerInfo = {
			name: "typescript",
			version: "6.0.1",
			source: "project",
		};
		const checked = expectType(preview, {
			name: "user",
			backend: "typescript7",
			costCompiler: "project",
			printed: "{ name: string; age: number; }",
			maxInstantiations: 1_000,
		});
		expect(checked.cost?.compiler).toEqual(project601);
		expect((checked as { compiler?: CompilerInfo }).compiler).toMatchObject(
			{ name: "typescript", source: "bundled" },
		);
		const error = thrown(() =>
			expectType(preview, {
				name: "user",
				backend: "typescript7",
				costCompiler: "project",
				maxTypes: 0,
			}),
		);
		expect(error.message).toMatch(
			/\(counted on typescript 6\.0\.1, project; printed on typescript 7\.\d+\.\d+, bundled\)\.$/,
		);
		// An explicit costCompiler "project" needs the project's TypeScript 6.
		expect(
			thrown(() =>
				expectType(ts7Api, {
					name: "user",
					backend: "typescript7",
					costCompiler: "project",
					maxTypes: 1_000,
				}),
			).message,
		).toContain("is TypeScript 7, which has no JavaScript compiler API");
		expect(
			expectTypes(preview, {
				types: [{ name: "user" }],
				backend: "typescript7",
				costCompiler: "project",
				maxTypes: 1_000,
			}).cost?.compiler,
		).toEqual(project601);
	});

	test("finds @typescript/native, the nearest install first", () => {
		const typeInfo = (file: string) =>
			inferredTypeInfo(file, {
				name: "user",
				backend: "typescript7",
				compiler: "project",
			}).compiler;
		const alias: CompilerInfo = {
			name: "@typescript/native",
			version: "7.0.5",
			source: "project",
		};
		expect(typeInfo(nativeAlias)).toEqual(alias);
		// The parent's typescript 7, which has no API client, is farther.
		expect(typeInfo(nativeNested)).toEqual(alias);
		// In one node_modules, typescript comes first.
		expect(typeInfo(nativeTie)).toEqual({
			name: "typescript",
			version: "7.0.2",
			source: "project",
		});
		const error = thrown(() => typeInfo(oldAlias));
		expect(error.message).toContain(
			"@typescript/native 7.0.0-dev.20260421.2 at",
		);
		expect(error.message).toContain(
			"predates the TypeScript 7 API typeprobe uses",
		);
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
			"its compiler predates the API protocol typeprobe speaks (7.0.0-dev.20260624.1 or later)",
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

describe("typeprobe's own compilers hoisted into a project", () => {
	const typeInfo = (file: string, compiler: "project" | "auto") =>
		inferredTypeInfo(file, {
			name: "user",
			backend: "typescript7",
			compiler,
		}).compiler;
	const nativeVersion = (
		require("@typescript/native/package.json") as { version: string }
	).version;

	test("are not the project's unless it declares them", () => {
		const native = thrown(() => typeInfo(hoisted, "project"));
		expect(native.code).toBe("TYPESCRIPT_ERROR");
		expect(native.message).toContain(
			`; the @typescript/native ${nativeVersion} at ${fs.realpathSync(realNative)} is typeprobe's own dependency, which the project doesn't declare.`,
		);
		expect(native.suggestion).toContain(
			"Add typescript@7, @typescript/native, or @typescript/native-preview to the project's devDependencies",
		);
		const typeScript6 = thrown(() =>
			hover(hoisted, "user", { compiler: "project" }),
		);
		expect(typeScript6.message).toContain(
			`; the typescript ${ts.version} at ${fs.realpathSync(realTypeScript)} is typeprobe's own dependency`,
		);
		expect(typeScript6.suggestion).toContain(
			"Add typescript (5.0 to 6.x) to the project's devDependencies",
		);
		// auto mode falls back to the same compilers, without a warning.
		const write = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			expect(typeInfo(hoisted, "auto")?.source).toBe("bundled");
			expect(
				hover(hoisted, "user", { compiler: "auto" }).compiler,
			).toEqual(bundled6);
			expect(write).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
		}
	});

	test("run as the bundled compilers when the project or its workspace root declares them", () => {
		for (const file of [hoistedDeclared, hoistedWorkspace]) {
			expect(typeInfo(file, "project")).toMatchObject({
				name: "typescript",
				source: "bundled",
			});
			expect(
				hover(file, "user", { compiler: "project" }).compiler,
			).toEqual(bundled6);
		}
	});
});
