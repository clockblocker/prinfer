import fs from "node:fs";
import path from "node:path";
import { ts, typeScriptId } from "./ts-runtime.js";

interface ProgramCacheEntry {
	program: ts.Program;
	files: Map<string, FileStamp>;
	directories: Map<string, string>;
	/**
	 * The TypeScript instance and compiler options: programs with the same
	 * share files (see sharingHost).
	 */
	sharing: string;
}

/**
 * What a cached program read from a file: its stat signature, and while
 * the file is recently changed, the text itself (see RACY_WINDOW_MS).
 */
interface FileStamp {
	signature: string;
	/** When the file last changed (the later of mtime and ctime). */
	changedMs: number;
	/** The text the program read, kept while the signature can't vouch. */
	text?: string;
}

/**
 * How long after a change a file's stat signature is not trusted alone.
 * Timestamps are coarse: Linux takes them from a clock tick (1-10 ms) on
 * kernels without multigrain timestamps, HFS+ to the second, FAT to two
 * seconds. A fixture rewritten within one tick with the same size keeps
 * its mtime, ctime, size, and inode, so a stamp recorded that recently is
 * checked against the text read until the window has passed, as git does
 * for racily clean files. Only recently changed files pay for the read.
 */
const RACY_WINDOW_MS = 3_000;

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

	const configText = ts.sys.readFile(tsconfigPath);
	const cfg =
		configText === undefined
			? ts.readConfigFile(tsconfigPath, ts.sys.readFile)
			: ts.parseConfigFileTextToJson(tsconfigPath, configText);
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
	cacheProgram(cacheKey, program, rootNames, path.dirname(tsconfigPath), {
		path: tsconfigPath,
		text: configText,
	});
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
		let stat: FileStat | undefined;
		for (const donor of donors) {
			const stamp = donor.files.get(fileName);
			if (stamp === undefined) continue;
			if (stat === undefined) stat = statOf(fileName);
			if (!stampIsFresh(fileName, stamp, stat)) continue;
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
	tsconfig?: { path: string; text: string | undefined },
): void {
	const files = new Map<string, FileStamp>();
	for (const sourceFile of program.getSourceFiles()) {
		const stamp = fileStamp(sourceFile.fileName, sourceFile.text);
		if (stamp) files.set(sourceFile.fileName, stamp);
	}
	if (tsconfig) {
		const stamp = fileStamp(tsconfig.path, tsconfig.text);
		if (stamp) files.set(tsconfig.path, stamp);
	}

	const directories = new Map<string, string>();
	for (const directory of collectProjectDirectories(rootNames, projectDir)) {
		const stat = statOf(directory);
		if (stat) directories.set(directory, stat.signature);
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
	for (const [filePath, stamp] of entry.files) {
		if (!stampIsFresh(filePath, stamp)) return false;
	}
	for (const [directory, signature] of entry.directories) {
		if (statOf(directory)?.signature !== signature) return false;
	}
	return true;
}

/** A stamp of `text`, read from `filePath`, unless the file is gone. */
function fileStamp(
	filePath: string,
	text: string | undefined,
): FileStamp | undefined {
	const stat = statOf(filePath);
	if (!stat || text === undefined) return undefined;
	const stamp: FileStamp = {
		signature: stat.signature,
		changedMs: stat.changedMs,
	};
	if (Date.now() - stat.changedMs < RACY_WINDOW_MS) stamp.text = text;
	return stamp;
}

/**
 * Whether the file still holds what the stamp recorded: the same stat
 * signature and, while the change is recent, the same text. A text that
 * still matches once the window has passed is trusted from then on: a
 * later write would carry a later timestamp.
 */
function stampIsFresh(
	filePath: string,
	stamp: FileStamp,
	stat: FileStat = statOf(filePath),
): boolean {
	if (stat?.signature !== stamp.signature) return false;
	if (stamp.text === undefined) return true;
	if (ts.sys.readFile(filePath) !== stamp.text) return false;
	if (Date.now() - stamp.changedMs >= RACY_WINDOW_MS) stamp.text = undefined;
	return true;
}

/** A file's stat signature; null when it is gone. */
type FileStat = { signature: string; changedMs: number } | null;

function statOf(filePath: string): FileStat {
	try {
		const stat = fs.statSync(filePath);
		return {
			signature: `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`,
			changedMs: Math.max(stat.mtimeMs, stat.ctimeMs),
		};
	} catch {
		return null;
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
