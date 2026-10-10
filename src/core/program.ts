import fs from "node:fs";
import path from "node:path";
import { ts, typeScriptId } from "./ts-runtime.js";

interface ProgramCacheEntry {
	program: ts.Program;
	files: Map<string, string>;
	directories: Map<string, string>;
	/**
	 * The TypeScript instance and compiler options: programs with the same
	 * share files (see sharingHost).
	 */
	sharing: string;
}

const programCache = new Map<string, ProgramCacheEntry>();
const MAX_CACHED_PROGRAMS = 8;

/**
 * Find the nearest tsconfig.json from a starting directory
 */
export function findNearestTsconfig(startDir: string): string | undefined {
	return (
		ts.findConfigFile(startDir, ts.sys.fileExists, "tsconfig.json") ??
		undefined
	);
}

/**
 * Load a TypeScript program from an entry file
 */
export function loadProgram(
	entryFileAbs: string,
	project?: string,
): ts.Program {
	const fileDir = path.dirname(entryFileAbs);
	const tsconfigPath = project
		? path.resolve(process.cwd(), project)
		: findNearestTsconfig(fileDir);

	// The inspected file may intentionally be excluded from the project's
	// production tsconfig (test files commonly are). Keep the entry in the cache
	// identity because each program below explicitly adds it as a root. A
	// program belongs to the TypeScript instance that created it.
	const cacheKey = `${typeScriptId()}\0${programKey(entryFileAbs, tsconfigPath)}`;
	const cached = programCache.get(cacheKey);
	if (cached && cacheEntryIsFresh(cached)) {
		programCache.delete(cacheKey);
		programCache.set(cacheKey, cached);
		return cached.program;
	}

	if (!tsconfigPath) {
		const options: ts.CompilerOptions = {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			strict: true,
			allowJs: true,
			checkJs: false,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			skipLibCheck: true,
		};
		const program = ts.createProgram({
			rootNames: [entryFileAbs],
			oldProgram: cached?.program,
			options,
			host: sharingHost(options),
		});
		cacheProgram(cacheKey, program, [entryFileAbs], fileDir);
		return program;
	}

	const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (cfg.error) {
		throw new Error(
			ts.flattenDiagnosticMessageText(cfg.error.messageText, "\n"),
		);
	}

	const parsed = ts.parseJsonConfigFileContent(
		cfg.config,
		ts.sys,
		path.dirname(tsconfigPath),
	);
	const rootNames = parsed.fileNames.includes(entryFileAbs)
		? parsed.fileNames
		: [...parsed.fileNames, entryFileAbs];
	const program = ts.createProgram({
		rootNames,
		options: parsed.options,
		oldProgram: cached?.program,
		host: sharingHost(parsed.options),
	});
	cacheProgram(
		cacheKey,
		program,
		rootNames,
		path.dirname(tsconfigPath),
		tsconfigPath,
	);
	return program;
}

/**
 * Create a language service over a loaded program's root files and options.
 * Callers must dispose the service.
 */
export function createProgramLanguageService(
	program: ts.Program,
): ts.LanguageService {
	const versions = new Map(
		program.getSourceFiles().map((source) => [source.fileName, "0"]),
	);
	const host: ts.LanguageServiceHost = {
		getCompilationSettings: () => program.getCompilerOptions(),
		getScriptFileNames: () => [...program.getRootFileNames()],
		getScriptVersion: (fileName) => versions.get(fileName) ?? "0",
		getScriptSnapshot: (fileName) => {
			const text = ts.sys.readFile(fileName);
			return text === undefined
				? undefined
				: ts.ScriptSnapshot.fromString(text);
		},
		getCurrentDirectory: () => process.cwd(),
		getDefaultLibFileName: ts.getDefaultLibFilePath,
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		realpath: ts.sys.realpath,
	};
	return ts.createLanguageService(host);
}

/** Remove every cached TypeScript program. */
export function clearProgramCache(): void {
	programCache.clear();
}

/** Remove the cached program that would be used for a file lookup. */
export function invalidateProgramCache(
	entryFileAbs: string,
	project?: string,
): void {
	const tsconfigPath = project
		? path.resolve(process.cwd(), project)
		: findNearestTsconfig(path.dirname(entryFileAbs));
	const key = `\0${programKey(entryFileAbs, tsconfigPath)}`;
	// The programs of every TypeScript instance that loaded the file.
	for (const cacheKey of [...programCache.keys()]) {
		if (cacheKey.endsWith(key)) programCache.delete(cacheKey);
	}
}

function programKey(entryFileAbs: string, tsconfigPath?: string): string {
	return tsconfigPath ? `${tsconfigPath}\0${entryFileAbs}` : entryFileAbs;
}

/**
 * A compiler host that takes unchanged files from the cached programs with
 * the same compiler options, so a program for another entry file of a
 * project does not parse and bind the project and its libraries again. The
 * programs share only source files, which depend on nothing but their text,
 * the options, and the compiler that parsed and bound them; each keeps its
 * own checker. Programs of another TypeScript instance never share: syntax
 * kinds, flags, and binder state differ between versions, so a file one
 * version parsed would be misread by another's checker.
 */
function sharingHost(options: ts.CompilerOptions): ts.CompilerHost {
	const host = ts.createCompilerHost(options);
	const key = sharingKey(options);
	const donors = [...programCache.values()].filter(
		(entry) => entry.sharing === key,
	);
	if (donors.length === 0) return host;
	const readSourceFile = host.getSourceFile;
	host.getSourceFile = (fileName, languageVersion, onError, createNew) => {
		if (createNew) {
			return readSourceFile(
				fileName,
				languageVersion,
				onError,
				createNew,
			);
		}
		let current: string | undefined;
		for (const donor of donors) {
			const signature = donor.files.get(fileName);
			if (signature === undefined) continue;
			current ??= statSignature(fileName) ?? "";
			if (signature !== current) continue;
			const sourceFile = donor.program.getSourceFile(fileName);
			if (sourceFile) return sourceFile;
		}
		return readSourceFile(fileName, languageVersion, onError, createNew);
	};
	return host;
}

/** What programs must have in common to share source files. */
function sharingKey(options: ts.CompilerOptions): string {
	return `${typeScriptId()}\0${JSON.stringify(options)}`;
}

function cacheProgram(
	cacheKey: string,
	program: ts.Program,
	rootNames: string[],
	projectDir: string,
	tsconfigPath?: string,
): void {
	const files = new Map<string, string>();
	for (const sourceFile of program.getSourceFiles()) {
		const signature = statSignature(sourceFile.fileName);
		if (signature) files.set(sourceFile.fileName, signature);
	}
	if (tsconfigPath) {
		const signature = statSignature(tsconfigPath);
		if (signature) files.set(tsconfigPath, signature);
	}

	const directories = new Map<string, string>();
	for (const directory of collectProjectDirectories(rootNames, projectDir)) {
		const signature = statSignature(directory);
		if (signature) directories.set(directory, signature);
	}

	programCache.set(cacheKey, {
		program,
		files,
		directories,
		sharing: sharingKey(program.getCompilerOptions()),
	});
	if (programCache.size > MAX_CACHED_PROGRAMS) {
		const oldestKey = programCache.keys().next().value;
		if (oldestKey) programCache.delete(oldestKey);
	}
}

function cacheEntryIsFresh(entry: ProgramCacheEntry): boolean {
	return (
		signaturesAreFresh(entry.files) && signaturesAreFresh(entry.directories)
	);
}

function signaturesAreFresh(signatures: Map<string, string>): boolean {
	for (const [filePath, signature] of signatures) {
		if (statSignature(filePath) !== signature) return false;
	}
	return true;
}

function statSignature(filePath: string): string | undefined {
	try {
		const stat = fs.statSync(filePath);
		return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
	} catch {
		return undefined;
	}
}

function collectProjectDirectories(
	rootNames: string[],
	projectDir: string,
): Set<string> {
	const directories = new Set<string>([projectDir]);
	for (const rootName of rootNames) {
		let current = path.dirname(rootName);
		while (current.startsWith(projectDir)) {
			directories.add(current);
			if (current === projectDir) break;
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	return directories;
}
