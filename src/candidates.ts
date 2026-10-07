import fs from "node:fs";
import * as ts from "typescript";

const MAX_CANDIDATES = 5;
/** Don't parse huge files just to decorate an error. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Lines on each side of the requested line searched for nearby names. */
const WINDOW = 2;

export interface CandidateQuery {
	/** 1-based line to look around. */
	line?: number;
	/** The name or text that failed to resolve; candidates are ranked by it. */
	query?: string;
	/**
	 * Keep only names close to query (a misspelling or a containing name).
	 * Without strict, query only orders the identifiers near line.
	 */
	strict?: boolean;
}

interface Identifier {
	name: string;
	/** 1-based line of the first occurrence. */
	line: number;
	/** Every 1-based line the name appears on. */
	lines: Set<number>;
}

/**
 * Identifier names a caller may have meant, for SYMBOL_NOT_FOUND errors.
 * Only real identifiers count: keywords and words in comments, strings, and
 * JSX text are skipped. Never throws; returns undefined when nothing fits or
 * the file cannot be read.
 */
export function nearbyCandidates(
	file: string,
	{ line, query, strict = false }: CandidateQuery = {},
): string[] | undefined {
	try {
		const stats = fs.statSync(file);
		if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return undefined;
		const identifiers = collectIdentifiers(
			file,
			fs.readFileSync(file, "utf8"),
		);
		const near = (identifier: Identifier) =>
			line === undefined ||
			[...identifier.lines].some(
				(found) => Math.abs(found - line) <= WINDOW,
			);
		let pool = identifiers.filter(near);
		if (query !== undefined && strict) {
			const close = (list: Identifier[]) =>
				list.filter((identifier) => isClose(identifier.name, query));
			pool = close(pool);
			// The name may be misspelled on a different line than the hint.
			if (pool.length === 0 && line !== undefined) {
				pool = close(identifiers);
			}
		}
		const candidates = rank(pool, line, query)
			.map((identifier) => identifier.name)
			.filter((name) => name !== query)
			.slice(0, MAX_CANDIDATES);
		return candidates.length ? candidates : undefined;
	} catch {
		return undefined;
	}
}

function collectIdentifiers(file: string, text: string): Identifier[] {
	const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
	const byName = new Map<string, Identifier>();
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
			const name = node.text;
			const line =
				sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile),
				).line + 1;
			const existing = byName.get(name);
			if (existing) {
				existing.lines.add(line);
			} else {
				byName.set(name, { name, line, lines: new Set([line]) });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return [...byName.values()];
}

function rank(
	identifiers: Identifier[],
	line: number | undefined,
	query: string | undefined,
): Identifier[] {
	const lineDistance = (identifier: Identifier) =>
		line === undefined
			? 0
			: Math.min(
					...[...identifier.lines].map((found) =>
						Math.abs(found - line),
					),
				);
	return [...identifiers].sort(
		(left, right) =>
			(query === undefined
				? 0
				: nameDistance(left.name, query) -
					nameDistance(right.name, query)) ||
			lineDistance(left) - lineDistance(right) ||
			left.line - right.line,
	);
}

/** A likely misspelling of query, or a name containing it (or vice versa). */
function isClose(name: string, query: string): boolean {
	const a = name.toLowerCase();
	const b = query.toLowerCase();
	if (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))) {
		return true;
	}
	return nameDistance(a, b) <= Math.max(1, Math.ceil(b.length / 3));
}

/** Case-insensitive Levenshtein distance. */
export function nameDistance(left: string, right: string): number {
	const a = left.toLowerCase();
	const b = right.toLowerCase();
	const row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0] ?? 0;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const current = row[j] ?? 0;
			row[j] = Math.min(
				(row[j] ?? 0) + 1,
				(row[j - 1] ?? 0) + 1,
				previous + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			previous = current;
		}
	}
	return row[b.length] ?? Number.MAX_SAFE_INTEGER;
}
