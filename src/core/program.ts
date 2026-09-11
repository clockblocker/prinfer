import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

interface ProgramCacheEntry {
	program: ts.Program;
	files: Map<string, string>;
	directories: Map<string, string>;
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
	// identity because each program below explicitly adds it as a root.
	const cacheKey = tsconfigPath
		? `${tsconfigPath}\0${entryFileAbs}`
		: entryFileAbs;
	const cached = programCache.get(cacheKey);
	if (cached && cacheEntryIsFresh(cached)) {
		programCache.delete(cacheKey);
		programCache.set(cacheKey, cached);
		return cached.program;
	}

	if (!tsconfigPath) {
		const program = ts.createProgram({
			rootNames: [entryFileAbs],
			oldProgram: cached?.program,
			options: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.ESNext,
				strict: true,
				allowJs: true,
				checkJs: false,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				skipLibCheck: true,
			},
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
	programCache.delete(
		tsconfigPath ? `${tsconfigPath}\0${entryFileAbs}` : entryFileAbs,
	);
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

	programCache.set(cacheKey, { program, files, directories });
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
