import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

/** LSP FileChangeType: 1 created, 2 changed, 3 deleted. */
export type FileChangeType = 1 | 2 | 3;

export interface FileChange {
	file: string;
	type: FileChangeType;
}

export interface WorkspaceScanStats {
	/** Directory entries visited by the last workspace scan */
	entries: number;
	/** True once a scan hit the entry budget; later scans are skipped */
	disabled: boolean;
}

const TRACKED_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/;
/**
 * Every directory entry a workspace scan visits counts against this budget,
 * tracked or not, so a tree full of assets can't make each check slow. A
 * project that exceeds it falls back to the import-closure check plus the
 * language server's own file watcher.
 */
export const MAX_SCAN_ENTRIES = 10_000;
/** Bound on files followed through relative imports from one entry file. */
const MAX_CLOSURE_FILES = 5_000;
/**
 * Directories never scanned (besides dot-directories): dependencies, build
 * output, caches, and other ecosystems' environments.
 */
export const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	"bower_components",
	"jspm_packages",
	"dist",
	"build",
	"out",
	"coverage",
	"target",
	"vendor",
	"venv",
	"__pycache__",
	"Pods",
	"DerivedData",
]);
/**
 * mtime granularity slack when deciding whether a file first seen after the
 * language server started may have changed since it was read.
 */
const FIRST_SIGHT_SLACK_MS = 1_000;

interface FileImports {
	signature: string;
	/** Candidate paths for each relative import, in resolution order */
	candidates: string[][];
}

/**
 * Detects on-disk creates, edits, and deletes of source files so they can be
 * reported to a language server before a request. The server's own watcher
 * sees them too, but only after a delay, so a request right after an edit
 * would otherwise use stale content.
 *
 * Two checks share one set of known file signatures:
 * - {@link checkImports} follows relative imports from an entry file. It
 *   stats only the files that entry can see, so it is cheap enough for every
 *   hover.
 * - {@link scanWorkspace} also walks the tsconfig's include roots, bounded by
 *   {@link MAX_SCAN_ENTRIES}, to catch files reached another way (path
 *   aliases, global declarations).
 *
 * A file seen for the first time is reported as changed when it was modified
 * after `startedAt`, since the server may have read the older content.
 */
export class WorkspaceFiles {
	private readonly known = new Map<string, string>();
	private readonly imports = new Map<string, FileImports>();
	private includeRoots: string[] | undefined;
	private scanDisabled = false;
	private lastScanEntries = 0;

	private readonly maxEntries: number;

	constructor(
		private readonly root: string,
		private readonly startedAt = Date.now(),
		options: { maxEntries?: number } = {},
	) {
		this.maxEntries = options.maxEntries ?? MAX_SCAN_ENTRIES;
	}

	/** Changes among `entry` and the files it reaches by relative imports. */
	checkImports(entry: string): FileChange[] {
		const changes: FileChange[] = [];
		this.walkImports(entry, changes);
		return changes;
	}

	/**
	 * {@link checkImports} plus a bounded scan of the workspace and a
	 * deletion check of every file seen before.
	 */
	scanWorkspace(entry: string): FileChange[] {
		const changes: FileChange[] = [];
		const seen = this.walkImports(entry, changes);
		if (this.scanDisabled) return changes;
		this.walkRoots(seen, changes);
		if (this.scanDisabled) return changes;
		// Files seen before but not this time: deleted, or outside the roots.
		for (const file of [...this.known.keys()]) {
			if (!seen.has(file)) this.observe(file, changes);
		}
		return changes;
	}

	get stats(): WorkspaceScanStats {
		return { entries: this.lastScanEntries, disabled: this.scanDisabled };
	}

	/** Record a file's current state, reporting any change. */
	private observe(
		file: string,
		changes: FileChange[],
		stat = statFile(file),
	): void {
		const before = this.known.get(file);
		if (!stat) {
			if (before !== undefined) {
				this.known.delete(file);
				this.imports.delete(file);
				changes.push({ file, type: 3 });
			}
			return;
		}
		const signature = signatureOf(stat);
		if (before === signature) return;
		this.known.set(file, signature);
		if (before !== undefined) {
			changes.push({ file, type: 2 });
			return;
		}
		const since = this.startedAt - FIRST_SIGHT_SLACK_MS;
		if (stat.mtimeMs >= since) {
			changes.push({ file, type: stat.birthtimeMs >= since ? 1 : 2 });
		}
	}

	private walkImports(entry: string, changes: FileChange[]): Set<string> {
		const seen = new Set<string>();
		const stats = new Map<string, fs.Stats | undefined>();
		const statOnce = (file: string) => {
			if (!stats.has(file)) stats.set(file, statFile(file));
			return stats.get(file);
		};
		const pending = [entry];
		while (pending.length > 0 && seen.size < MAX_CLOSURE_FILES) {
			const file = pending.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);
			const stat = statOnce(file);
			this.observe(file, changes, stat);
			if (!stat) continue;
			for (const candidates of this.importsOf(file, signatureOf(stat))) {
				// The first existing candidate is the import's target. A
				// known file that disappeared is followed so its deletion
				// is reported.
				const target = candidates.find(
					(candidate) =>
						seen.has(candidate) ||
						statOnce(candidate) !== undefined ||
						this.known.has(candidate),
				);
				if (target && !seen.has(target)) pending.push(target);
			}
		}
		return seen;
	}

	private importsOf(file: string, signature: string): string[][] {
		const cached = this.imports.get(file);
		if (cached?.signature === signature) return cached.candidates;
		let candidates: string[][] = [];
		if (/\.[cm]?[jt]sx?$/.test(file)) {
			try {
				candidates = relativeImports(
					file,
					fs.readFileSync(file, "utf8"),
				);
			} catch {
				candidates = [];
			}
		}
		this.imports.set(file, { signature, candidates });
		return candidates;
	}

	private walkRoots(seen: Set<string>, changes: FileChange[]): void {
		this.includeRoots ??= includeRoots(this.root);
		let entries = 0;
		const pending = [...this.includeRoots];
		while (pending.length > 0 && !this.scanDisabled) {
			const current = pending.pop()!;
			let directory: fs.Dir;
			try {
				directory = fs.opendirSync(current);
			} catch {
				// A root may name a single file.
				if (TRACKED_EXTENSION.test(current) && !seen.has(current)) {
					seen.add(current);
					this.observe(current, changes);
				}
				continue;
			}
			try {
				for (
					let dirent = directory.readSync();
					dirent !== null;
					dirent = directory.readSync()
				) {
					if (++entries > this.maxEntries) {
						this.scanDisabled = true;
						break;
					}
					const entryPath = path.join(current, dirent.name);
					if (dirent.isDirectory()) {
						if (
							!dirent.name.startsWith(".") &&
							!SKIPPED_DIRECTORIES.has(dirent.name)
						)
							pending.push(entryPath);
						continue;
					}
					if (
						!dirent.isFile() ||
						!TRACKED_EXTENSION.test(dirent.name) ||
						seen.has(entryPath)
					)
						continue;
					seen.add(entryPath);
					this.observe(entryPath, changes);
				}
			} finally {
				directory.closeSync();
			}
		}
		this.lastScanEntries = entries;
	}
}

/**
 * Directories (or files) a tsconfig's `include` and `files` can match: the
 * static prefix of each include pattern, plus the roots of referenced
 * projects (solution-style configs). Without `include` or `files`, or when
 * they are inherited through `extends`, the whole config directory.
 */
export function includeRoots(root: string): string[] {
	const roots = configRoots(path.join(root, "tsconfig.json"), new Set());
	// Drop roots nested inside another root.
	const sorted = [...new Set(roots)].sort();
	return sorted.filter(
		(candidate, index) =>
			!sorted
				.slice(0, index)
				.some((parent) => candidate.startsWith(`${parent}${path.sep}`)),
	);
}

function configRoots(configPath: string, visited: Set<string>): string[] {
	if (visited.has(configPath)) return [];
	visited.add(configPath);
	const directory = path.dirname(configPath);
	const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
	const include: unknown = config?.include;
	const files: unknown = config?.files;
	const references: unknown = config?.references;
	const roots: string[] = [];
	for (const reference of Array.isArray(references) ? references : []) {
		const target = (reference as { path?: unknown } | null)?.path;
		if (typeof target !== "string") continue;
		const resolved = path.resolve(directory, target);
		roots.push(
			...configRoots(
				resolved.endsWith(".json")
					? resolved
					: path.join(resolved, "tsconfig.json"),
				visited,
			),
		);
	}
	if (!Array.isArray(include) && !Array.isArray(files)) {
		return [directory, ...roots];
	}
	for (const pattern of Array.isArray(include) ? include : []) {
		if (typeof pattern !== "string") continue;
		const segments = pattern.split(/[\\/]/);
		const wildcard = segments.findIndex((segment) => /[*?]/.test(segment));
		const prefix = wildcard < 0 ? segments : segments.slice(0, wildcard);
		roots.push(path.resolve(directory, ...prefix));
	}
	for (const file of Array.isArray(files) ? files : []) {
		if (typeof file === "string") roots.push(path.resolve(directory, file));
	}
	return roots;
}

/**
 * Candidate files for each relative import, reference, and re-export in a
 * source file, in the order TypeScript would try them. Bare specifiers
 * (packages, path aliases) are left to the workspace scan.
 */
export function relativeImports(file: string, text: string): string[][] {
	const info = ts.preProcessFile(text, true, true);
	const directory = path.dirname(file);
	const result: string[][] = [];
	for (const { fileName } of info.importedFiles) {
		if (!/^\.\.?(?:[\\/]|$)/.test(fileName)) continue;
		result.push(moduleCandidates(path.resolve(directory, fileName)));
	}
	for (const { fileName } of info.referencedFiles) {
		result.push([path.resolve(directory, fileName)]);
	}
	return result;
}

function moduleCandidates(base: string): string[] {
	const extension = /\.[cm]?jsx?$/.exec(base)?.[0];
	if (extension) {
		const stem = base.slice(0, -extension.length);
		switch (extension) {
			case ".mjs":
				return [`${stem}.mts`, `${stem}.d.mts`, base];
			case ".cjs":
				return [`${stem}.cts`, `${stem}.d.cts`, base];
			case ".jsx":
				return [`${stem}.tsx`, base];
			default:
				return [`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, base];
		}
	}
	if (/\.(?:[cm]?tsx?|json)$/.test(base)) return [base];
	return [
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.d.ts`,
		`${base}.js`,
		`${base}.jsx`,
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
		path.join(base, "index.d.ts"),
		path.join(base, "index.js"),
	];
}

function statFile(file: string): fs.Stats | undefined {
	try {
		const stat = fs.statSync(file, { throwIfNoEntry: false });
		return stat?.isFile() ? stat : undefined;
	} catch {
		return undefined;
	}
}

function signatureOf(stat: fs.Stats): string {
	return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
}
