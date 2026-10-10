import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	bundledTypeScript,
	type TypeScript,
	withTypeScript,
} from "./core/ts-runtime.js";
import { envName, readEnv } from "./env.js";
import { TypeprobeError } from "./errors.js";
import type { NativeCompiler } from "./native-runtime.js";
import type { CompilerInfo, CompilerMode } from "./types.js";

/**
 * Which compilers typeprobe runs: its bundled ones or the project's (see
 * `CompilerMode`). TypeScript 6 is loaded with `require` from the project
 * directory; TypeScript 7 is imported from the package that holds both its
 * API client and its compiler binary, so the two always match.
 */

/**
 * Environment variable that sets the mode when a call doesn't. The
 * deprecated PRINFER_COMPILER is read when it is unset (see env.ts).
 */
export const COMPILER_ENV = envName("COMPILER");

/** Every `CompilerMode`. */
export const COMPILER_MODES: readonly CompilerMode[] = [
	"bundled",
	"project",
	"auto",
];

/**
 * Oldest TypeScript the TypeScript 6 backend loads from a project: 5.0.
 * Every API typeprobe calls exists from 5.0 on (moduleResolution "bundler"
 * is new in it). typeprobe's TypeScript 6 tests pass unchanged on 5.9 and
 * 6.0; 5.0 to 5.8 print some types and messages differently.
 */
const MIN_TYPESCRIPT6_MAJOR = 5;

/** The mode a call runs in: its own option, TYPEPROBE_COMPILER, or bundled. */
export function compilerMode(option?: unknown): CompilerMode {
	const env = option === undefined ? readEnv("COMPILER") : undefined;
	const value = option === undefined ? (env?.value ?? "bundled") : option;
	if (COMPILER_MODES.includes(value as CompilerMode))
		return value as CompilerMode;
	throw new TypeprobeError(
		"INVALID_ARGUMENT",
		`Unknown compiler ${JSON.stringify(value)}${env ? ` in ${env.variable}` : ""}.`,
		'Use "bundled" (typeprobe\'s own TypeScript, the default), "project" (the project\'s), or "auto" (the project\'s when it has a supported one).',
	);
}

/**
 * The directory a project's compilers resolve from: the directory of
 * `project` when given, else of the nearest tsconfig.json above the file,
 * else the file's own.
 */
export function compilerDirectory(file: string, project?: string): string {
	if (project) {
		const resolved = path.resolve(process.cwd(), project);
		try {
			if (fs.statSync(resolved).isDirectory()) return resolved;
		} catch {
			// A missing project fails later, with the lookup's own error.
		}
		return path.dirname(resolved);
	}
	const start = path.dirname(path.resolve(process.cwd(), file));
	let current = start;
	while (true) {
		if (fs.existsSync(path.join(current, "tsconfig.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

/** Set a result's non-enumerable `compiler` (see `CompilerInfo`). */
export function withCompilerInfo<T extends object>(
	result: T,
	info: CompilerInfo,
): T {
	Object.defineProperty(result, "compiler", {
		value: info,
		enumerable: false,
		configurable: true,
		writable: true,
	});
	return result;
}

/** A result's compiler, as the CLI and MCP structured output report it. */
export function compilerOf(result: unknown): CompilerInfo | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	return (result as { compiler?: CompilerInfo }).compiler;
}

interface FoundPackage {
	name: string;
	version: string;
	/** Real path of the package directory. */
	dir: string;
	json: PackageJson;
}

interface PackageJson {
	name?: string;
	version?: string;
	bin?: string | Record<string, string>;
	exports?: unknown;
}

const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

/**
 * Whether the project around `dir` declares `name`: in its nearest
 * package.json, or in any package.json up to its workspace root (one with
 * `workspaces`, or next to a pnpm-workspace.yaml).
 */
function declaresPackage(dir: string, name: string): boolean {
	const manifests: Array<Record<string, unknown>> = [];
	let workspaceRoot = false;
	let current = dir;
	while (true) {
		const file = path.join(current, "package.json");
		if (fs.existsSync(file)) {
			try {
				const json = JSON.parse(fs.readFileSync(file, "utf8"));
				if (typeof json === "object" && json !== null) {
					manifests.push(json);
					if (
						"workspaces" in json ||
						fs.existsSync(path.join(current, "pnpm-workspace.yaml"))
					) {
						workspaceRoot = true;
						break;
					}
				}
			} catch {
				// An unreadable package.json declares nothing.
			}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return (workspaceRoot ? manifests : manifests.slice(0, 1)).some((json) =>
		DEPENDENCY_FIELDS.some((field) => {
			const deps = json[field];
			return typeof deps === "object" && deps !== null && name in deps;
		}),
	);
}

/**
 * typeprobe depends on `typescript` 6 and `@typescript/native` (typescript
 * 7), so a package manager that hoists them puts typeprobe's own copies in
 * the project's node_modules, where an import finds them. Such a copy is
 * the project's compiler only if the project declares the package.
 */
function isTypeprobeOwn(
	found: FoundPackage,
	bundledDir: string | null | undefined,
	dir: string,
): boolean {
	return found.dir === bundledDir && !declaresPackage(dir, found.name);
}

/** Why a package that was found isn't used, for "found no package" errors. */
function ownCopyNote(own: FoundPackage | undefined): string {
	return own
		? `; the ${own.name} ${own.version} at ${own.dir} is typeprobe's own dependency, which the project doesn't declare`
		: "";
}

/** Find a package the way `require` from `fromDir` would. */
function findPackage(fromDir: string, name: string): FoundPackage | undefined {
	let manifest: string;
	try {
		manifest = createRequire(path.join(fromDir, "noop.js")).resolve(
			`${name}/package.json`,
		);
	} catch {
		return undefined;
	}
	try {
		const json = JSON.parse(
			fs.readFileSync(manifest, "utf8"),
		) as PackageJson;
		return {
			name,
			version: json.version ?? "unknown",
			dir: realPath(path.dirname(manifest)),
			json,
		};
	} catch {
		return undefined;
	}
}

function realPath(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		return file;
	}
}

/** The major version; NaN when it doesn't parse. */
function majorVersion(version: string): number {
	return Number(version.split(".")[0]);
}

/** Warn once per message: auto mode falls back without failing the call. */
const warned = new Set<string>();

function warnFallback(message: string): void {
	if (warned.has(message)) return;
	warned.add(message);
	process.stderr.write(`typeprobe: ${message}\n`);
}

// ---------------------------------------------------------------- TypeScript 6

export interface TypeScript6Compiler {
	ts: TypeScript;
	info: CompilerInfo;
}

let bundledTypeScript6: TypeScript6Compiler | undefined;

/** typeprobe's own `typescript`. */
function bundled6(): TypeScript6Compiler {
	bundledTypeScript6 ??= {
		ts: bundledTypeScript,
		info: {
			name: "typescript",
			version: bundledTypeScript.version,
			source: "bundled",
		},
	};
	return bundledTypeScript6;
}

/** Real path of the bundled `typescript` package, to spot a project using it. */
let bundledTypeScriptDir: string | null | undefined;

function bundledTypeScript6Dir(): string | null {
	if (bundledTypeScriptDir !== undefined) return bundledTypeScriptDir;
	try {
		const manifest = createRequire(import.meta.url).resolve(
			"typescript/package.json",
		);
		bundledTypeScriptDir = realPath(path.dirname(manifest));
	} catch {
		bundledTypeScriptDir = null;
	}
	return bundledTypeScriptDir;
}

const projectTypeScript6 = new Map<string, TypeScript6Compiler>();
const typeScript6ByDirectory = new Map<string, TypeScript6Compiler>();

/**
 * The TypeScript 6 compiler for a lookup in `dir`. Throws in project mode
 * when the project has no supported `typescript`.
 */
export function resolveTypeScript6(
	mode: CompilerMode,
	dir: string,
): TypeScript6Compiler {
	if (mode === "bundled") return bundled6();
	const key = `${mode}\0${dir}`;
	const cached = typeScript6ByDirectory.get(key);
	if (cached) return cached;
	const compiler = findTypeScript6(mode, dir);
	typeScript6ByDirectory.set(key, compiler);
	return compiler;
}

function findTypeScript6(
	mode: "project" | "auto",
	dir: string,
): TypeScript6Compiler {
	const resolved = findPackage(dir, "typescript");
	const own =
		resolved && isTypeprobeOwn(resolved, bundledTypeScript6Dir(), dir)
			? resolved
			: undefined;
	const found = own ? undefined : resolved;
	if (!found) {
		if (mode === "auto") return bundled6();
		throw new TypeprobeError(
			"TYPESCRIPT_ERROR",
			`compiler "project" found no typescript package from ${dir}${ownCopyNote(own)}.`,
			`${own ? "Add typescript (5.0 to 6.x) to the project's devDependencies" : "Install typescript (5.0 to 6.x) in the project"}, or omit compiler for typeprobe's bundled TypeScript ${bundledTypeScript.version}.`,
		);
	}
	const unsupported = unsupportedTypeScript6(found);
	if (unsupported) {
		if (mode === "auto") {
			warnFallback(
				`${unsupported} Using typeprobe's bundled TypeScript ${bundledTypeScript.version} instead (compiler "auto").`,
			);
			return bundled6();
		}
		throw new TypeprobeError(
			"TYPESCRIPT_ERROR",
			`compiler "project": ${unsupported}`,
			found.version.startsWith("7")
				? `Use backend "typescript7" to run the project's TypeScript 7, or omit compiler for typeprobe's bundled TypeScript ${bundledTypeScript.version}.`
				: `Upgrade the project's typescript to 5.0 or later, or omit compiler for typeprobe's bundled TypeScript ${bundledTypeScript.version}.`,
		);
	}
	// The project declares the very copy typeprobe uses: the same compiler.
	if (found.dir === bundledTypeScript6Dir()) return bundled6();
	let compiler = projectTypeScript6.get(found.dir);
	if (!compiler) {
		compiler = {
			ts: loadTypeScript6(found),
			info: {
				name: "typescript",
				version: found.version,
				source: "project",
			},
		};
		projectTypeScript6.set(found.dir, compiler);
	}
	return compiler;
}

function unsupportedTypeScript6(found: FoundPackage): string | undefined {
	const major = majorVersion(found.version);
	const where = `typescript ${found.version} at ${found.dir}`;
	if (major >= 7) {
		return `${where} is TypeScript 7, which has no JavaScript compiler API for the TypeScript 6 backend.`;
	}
	// NaN (an unparsable version) fails this too.
	if (!(major >= MIN_TYPESCRIPT6_MAJOR)) {
		return `${where} is older than the TypeScript 6 backend supports (5.0 or later).`;
	}
	return undefined;
}

function loadTypeScript6(found: FoundPackage): TypeScript {
	let loaded: TypeScript;
	try {
		loaded = createRequire(path.join(found.dir, "package.json"))(
			found.dir,
		) as TypeScript;
	} catch (error) {
		throw new TypeprobeError(
			"TYPESCRIPT_ERROR",
			`compiler "project" could not load typescript ${found.version} from ${found.dir}: ${error instanceof Error ? error.message : String(error)}`,
			"Reinstall the project's dependencies, or omit compiler for typeprobe's bundled TypeScript.",
		);
	}
	if (typeof loaded?.createProgram !== "function") {
		throw new TypeprobeError(
			"TYPESCRIPT_ERROR",
			`compiler "project": typescript ${found.version} at ${found.dir} has no compiler API (createProgram).`,
			"Omit compiler for typeprobe's bundled TypeScript.",
		);
	}
	return loaded;
}

/**
 * Run TypeScript 6 work for a file on the compiler its mode selects, and
 * mark the result with it. `run` must be synchronous (see withTypeScript).
 */
export function runTypeScript6<T extends object>(
	file: string,
	options: { project?: string; compiler?: CompilerMode } | undefined,
	run: (info: CompilerInfo) => T,
): T {
	const compiler = resolveTypeScript6(
		compilerMode(options?.compiler),
		compilerDirectory(file, options?.project),
	);
	return withCompilerInfo(
		withTypeScript(compiler.ts, () => run(compiler.info)),
		compiler.info,
	);
}

// ---------------------------------------------------------------- TypeScript 7

/**
 * Packages that hold a TypeScript 7 compiler. The nearest install wins;
 * this order breaks a tie. `@typescript/native` is the name typeprobe itself
 * installs `typescript` 7 under.
 */
const TYPESCRIPT7_PACKAGES = [
	"typescript",
	"@typescript/native",
	"@typescript/native-preview",
];

let bundledNative: Promise<NativeCompiler> | undefined;
const projectNative = new Map<string, Promise<NativeCompiler>>();
const nativeByDirectory = new Map<string, Promise<NativeCompiler>>();

/**
 * The TypeScript 7 compiler for a lookup in `dir`, loaded on first use.
 * Rejects in project mode when the project has no usable one.
 */
export function resolveTypeScript7(
	mode: CompilerMode,
	dir: string,
): Promise<NativeCompiler> {
	if (mode === "bundled") return bundled7();
	const key = `${mode}\0${dir}`;
	let compiler = nativeByDirectory.get(key);
	if (!compiler) {
		compiler = findTypeScript7(mode, dir);
		nativeByDirectory.set(key, compiler);
		// A failed load is retried by the next call.
		compiler.catch(() => nativeByDirectory.delete(key));
	}
	return compiler;
}

function bundled7(): Promise<NativeCompiler> {
	if (!bundledNative) {
		const loading = loadBundled7();
		bundledNative = loading;
		// A failed load is retried by the next call.
		loading.catch(() => {
			if (bundledNative === loading) bundledNative = undefined;
		});
	}
	return bundledNative;
}

async function loadBundled7(): Promise<NativeCompiler> {
	try {
		const [async, ast, is] = await Promise.all([
			import("@typescript/native/unstable/async"),
			import("@typescript/native/unstable/ast"),
			import("@typescript/native/unstable/ast/is"),
		]);
		const found = bundledNativePackage();
		return {
			info: {
				name: "typescript",
				version: found?.version ?? "unknown",
				source: "bundled",
			},
			packageDir: found?.dir ?? "@typescript/native",
			lspBin: found
				? (binScript(found) ?? path.join(found.dir, "bin", "tsc"))
				: "",
			ast,
			is,
			async,
		};
	} catch (error) {
		throw new TypeprobeError(
			"TYPESCRIPT_ERROR",
			`typeprobe could not load its TypeScript 7 compiler API (@typescript/native): ${error instanceof Error ? error.message : String(error)}`,
			"Check that @typescript/native is installed next to typeprobe (it is a dependency) and supports this platform; reinstalling dependencies usually fixes a partial install. Use backend typescript6 meanwhile.",
		);
	}
}

/**
 * typeprobe's own `@typescript/native` (an alias of typescript 7). Global
 * installs run bins through symlinks such as <prefix>/bin/typeprobe-mcp,
 * where no node_modules is reachable, so the real script location is tried
 * first, then this module's.
 */
function bundledNativePackage(): FoundPackage | undefined {
	const script = process.argv[1];
	const starts = [
		script ? path.dirname(realPath(path.resolve(script))) : undefined,
		path.dirname(fileURLToPath(import.meta.url)),
	];
	for (const start of starts) {
		if (!start) continue;
		const found = findPackage(start, "@typescript/native");
		if (found) return found;
	}
	return undefined;
}

/** How deep the node_modules directory holding a package is. */
function installDepth(found: FoundPackage): number {
	const marker = `${path.sep}node_modules${path.sep}`;
	return found.dir.lastIndexOf(marker);
}

/** The package's single bin script, which runs its compiler binary. */
function binScript(found: FoundPackage): string | undefined {
	const { bin } = found.json;
	const relative =
		typeof bin === "string" ? bin : bin ? Object.values(bin)[0] : undefined;
	return relative ? path.join(found.dir, relative) : undefined;
}

/**
 * The first `@typescript/native-preview` build typeprobe works with. Earlier
 * builds ship no API client (`./unstable/async` arrived in
 * 7.0.0-dev.20260515.1), or one whose `updateSnapshot({ openFiles })`
 * opens no project for the file, through 7.0.0-dev.20260623.1. Neither
 * typeprobe's own client nor theirs can then look a type up.
 */
const MIN_NATIVE_PREVIEW_DATE = 20260624;
const MIN_NATIVE_PREVIEW_VERSION = "7.0.0-dev.20260624.1";

function unsupportedTypeScript7(found: FoundPackage): string | undefined {
	const where = `${found.name} ${found.version} at ${found.dir}`;
	const { exports } = found.json;
	const hasClient =
		typeof exports === "object" &&
		exports !== null &&
		"./unstable/async" in exports;
	// Dev builds are native-preview's, under any name it is aliased to.
	const date = /^7\.0\.0-dev\.(\d{8})/.exec(found.version)?.[1];
	if (date !== undefined && Number(date) < MIN_NATIVE_PREVIEW_DATE) {
		return hasClient
			? `${where} predates the TypeScript 7 API typeprobe uses: its API server opens no project for a file (fixed in ${MIN_NATIVE_PREVIEW_VERSION}).`
			: `${where} ships no TypeScript 7 API client (no "./unstable/async" export), and its compiler predates the API protocol typeprobe speaks (${MIN_NATIVE_PREVIEW_VERSION} or later).`;
	}
	if (!hasClient) {
		return `${where} ships no TypeScript 7 API client (no "./unstable/async" export).`;
	}
	return undefined;
}

async function findTypeScript7(
	mode: "project" | "auto",
	dir: string,
): Promise<NativeCompiler> {
	// The nearest install wins, as an import would: a project's own
	// @typescript/native-preview over a typescript 7 in a parent directory.
	// The sort is stable, so TYPESCRIPT7_PACKAGES' order breaks a tie.
	const bundledDir = bundledNativePackage()?.dir;
	const candidates = TYPESCRIPT7_PACKAGES.map((name) =>
		findPackage(dir, name),
	).filter(
		(candidate) =>
			candidate !== undefined && majorVersion(candidate.version) >= 7,
	) as FoundPackage[];
	const own = candidates.find((candidate) =>
		isTypeprobeOwn(candidate, bundledDir, dir),
	);
	const found = candidates
		.filter((candidate) => candidate !== own)
		.sort((left, right) => installDepth(right) - installDepth(left))[0];
	if (!found) {
		if (mode === "auto") return bundled7();
		throw new TypeprobeError(
			"TYPESCRIPT_ERROR",
			`compiler "project" found no TypeScript 7 package (typescript 7, @typescript/native, or @typescript/native-preview) from ${dir}${ownCopyNote(own)}.`,
			`${own ? "Add typescript@7, @typescript/native, or @typescript/native-preview to the project's devDependencies" : "Install typescript@7, @typescript/native, or @typescript/native-preview in the project"}, or omit compiler for typeprobe's bundled TypeScript 7.`,
		);
	}
	const problem = unsupportedTypeScript7(found);
	if (problem) {
		const bundledVersion = bundledNativePackage()?.version ?? "7";
		if (mode === "auto") {
			warnFallback(
				`${problem} Using typeprobe's bundled TypeScript ${bundledVersion} instead (compiler "auto").`,
			);
			return bundled7();
		}
		throw new TypeprobeError(
			"TYPESCRIPT_ERROR",
			`compiler "project": ${problem}`,
			`Upgrade ${found.name} (typescript or @typescript/native 7.0 or later, or @typescript/native-preview ${MIN_NATIVE_PREVIEW_VERSION} or later), or omit compiler for typeprobe's bundled TypeScript ${bundledVersion}.`,
		);
	}
	// The project declares the very copy typeprobe uses: the same compiler.
	if (found.dir === bundledDir) return bundled7();
	let compiler = projectNative.get(found.dir);
	if (!compiler) {
		compiler = loadProject7(found);
		projectNative.set(found.dir, compiler);
		compiler.catch(() => projectNative.delete(found.dir));
	}
	return compiler;
}

async function loadProject7(found: FoundPackage): Promise<NativeCompiler> {
	const require = createRequire(path.join(found.dir, "package.json"));
	const load = (subpath: string) =>
		import(pathToFileURL(require.resolve(`${found.name}/${subpath}`)).href);
	try {
		const [async, ast, is] = await Promise.all([
			load("unstable/async"),
			load("unstable/ast"),
			load("unstable/ast/is"),
		]);
		const lspBin = binScript(found);
		if (!lspBin) throw new Error("its package.json has no bin");
		return {
			info: {
				name: found.name,
				version: found.version,
				source: "project",
			},
			packageDir: found.dir,
			lspBin,
			ast,
			is,
			async,
		};
	} catch (error) {
		throw new TypeprobeError(
			"TYPESCRIPT_ERROR",
			`compiler "project" could not load ${found.name} ${found.version} from ${found.dir}: ${error instanceof Error ? error.message : String(error)}`,
			"Reinstall the project's dependencies, or omit compiler for typeprobe's bundled TypeScript 7.",
		);
	}
}
