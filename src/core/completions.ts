import fs from "node:fs";
import path from "node:path";
import type { CompletionEntry, CompletionResult } from "../types.js";
import { assertCursorPosition } from "./lines.js";
import { findSmallestNodeAtPosition } from "./node-find.js";
import { createProgramLanguageService, loadProgram } from "./program.js";
import { ts } from "./ts-runtime.js";

export interface CompletionRefinement {
	/**
	 * Keep only entries whose name starts with this text (case-insensitive).
	 * An empty string turns filtering off.
	 */
	prefix?: string;
	/**
	 * When no prefix is given, filter by the partial identifier (or string
	 * literal text) left of the cursor, the way an editor does. TypeScript
	 * itself returns every entry regardless of what was typed.
	 */
	autoPrefix?: boolean;
	/** Return at most this many entries; `total` still counts all matches. */
	limit?: number;
}

/**
 * Return the completion entries TypeScript would offer at a 1-based cursor
 * position, ranked (TypeScript's sortText, keywords after other entries of
 * the same rank), optionally filtered by prefix and truncated to a limit.
 */
export function getCompletions(
	file: string,
	line: number,
	column: number,
	project?: string,
	refinement: CompletionRefinement = {},
): CompletionResult {
	const entryFileAbs = path.resolve(process.cwd(), file);
	if (!fs.existsSync(entryFileAbs)) {
		throw new Error(`File not found: ${entryFileAbs}`);
	}

	const program = loadProgram(entryFileAbs, project);
	const sourceFile = program.getSourceFile(entryFileAbs);
	if (!sourceFile) {
		throw new Error(
			`Could not load source file into the program (check tsconfig include/exclude): ${entryFileAbs}`,
		);
	}
	assertCursorPosition(sourceFile.text, line, column, entryFileAbs);
	const position = sourceFile.getPositionOfLineAndCharacter(
		line - 1,
		column - 1,
	);

	const service = createProgramLanguageService(program);
	try {
		const info = service.getCompletionsAtPosition(entryFileAbs, position, {
			includeCompletionsForModuleExports: true,
			includeCompletionsWithInsertText: true,
		});
		if (info && isOpenObjectKey(sourceFile, position, info)) {
			return {
				file: entryFileAbs,
				line,
				column,
				isGlobalCompletion: info.isGlobalCompletion,
				isMemberCompletion: info.isMemberCompletion,
				isNewIdentifierLocation: info.isNewIdentifierLocation,
				entries: [],
				total: 0,
				truncated: false,
				note: OPEN_OBJECT_KEY_NOTE,
			};
		}
		const prefix =
			refinement.prefix ??
			(refinement.autoPrefix
				? typedPrefix(sourceFile.text, position, info)
				: undefined);
		const ranked = rankCompletions(
			(info?.entries ?? []).map(toEntry),
			prefix,
		);
		const limit = refinement.limit;
		const entries =
			limit !== undefined && ranked.length > limit
				? ranked.slice(0, limit)
				: ranked;
		return {
			file: entryFileAbs,
			line,
			column,
			isGlobalCompletion: info?.isGlobalCompletion ?? false,
			isMemberCompletion: info?.isMemberCompletion ?? false,
			isNewIdentifierLocation: info?.isNewIdentifierLocation ?? false,
			...(prefix ? { prefix } : {}),
			entries,
			total: ranked.length,
			truncated: entries.length < ranked.length,
		};
	} finally {
		service.dispose();
	}
}

export const OPEN_OBJECT_KEY_NOTE =
	"Any key is accepted here; TypeScript knows no specific keys for this object literal.";

const IDENTIFIER_PART = /[\p{ID_Continue}$\u200C\u200D]/u;

/**
 * The cursor is on a key of an object literal whose contextual type names
 * no keys (a `Record<string, T>`, an index signature, or no contextual type
 * at all). TypeScript then offers every global, because a shorthand
 * property `{ name }` could reference one; prinfer reports no entries and a
 * note instead of thousands of unrelated names.
 */
function isOpenObjectKey(
	sourceFile: ts.SourceFile,
	position: number,
	info: ts.CompletionInfo,
): boolean {
	if (!info.isNewIdentifierLocation || info.isMemberCompletion) return false;
	const text = sourceFile.text;
	let start = position;
	while (start > 0 && IDENTIFIER_PART.test(text[start - 1] ?? "")) start--;
	let before = start - 1;
	while (before >= 0 && /\s/.test(text[before] ?? "")) before--;
	const punctuation = text[before];
	if (punctuation !== "{" && punctuation !== ",") return false;
	const container = findSmallestNodeAtPosition(sourceFile, before);
	return container !== undefined && ts.isObjectLiteralExpression(container);
}

function toEntry(entry: ts.CompletionEntry): CompletionEntry {
	return {
		name: entry.name,
		kind: entry.kind,
		sortText: entry.sortText,
		...(entry.insertText === undefined
			? {}
			: { insertText: entry.insertText }),
		...(entry.source === undefined ? {} : { source: entry.source }),
	};
}

/**
 * The text already typed for the completion: from the start of the span
 * TypeScript would replace (an identifier or string-literal contents) to the
 * cursor.
 */
function typedPrefix(
	text: string,
	position: number,
	info: ts.CompletionInfo | undefined,
): string | undefined {
	const span = info?.optionalReplacementSpan;
	if (!span || span.start > position) return undefined;
	return text.slice(span.start, position) || undefined;
}

/**
 * Filter by a case-insensitive name prefix and order by TypeScript's
 * sortText (locals and members before globals, auto-imports last), with
 * keywords after other entries of the same rank. Ties keep TypeScript's
 * order.
 */
export function rankCompletions(
	entries: CompletionEntry[],
	prefix?: string,
): CompletionEntry[] {
	const lower = prefix?.toLowerCase();
	return entries
		.map((entry, index) => ({ entry, index }))
		.filter(
			({ entry }) => !lower || entry.name.toLowerCase().startsWith(lower),
		)
		.sort(
			(left, right) =>
				compareText(left.entry.sortText, right.entry.sortText) ||
				Number(left.entry.kind === "keyword") -
					Number(right.entry.kind === "keyword") ||
				left.index - right.index,
		)
		.map(({ entry }) => entry);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Completion names, one per line, then a line saying how many entries the
 * limit cut and how to narrow. `options` names the prefix and limit
 * arguments on the calling surface (MCP arguments or CLI flags).
 */
export function formatCompletions(
	result: CompletionResult,
	options: { prefix: string; limit: string } = {
		prefix: "prefix",
		limit: "limit",
	},
): string {
	const filter = result.prefix
		? ` matching prefix ${JSON.stringify(result.prefix)}`
		: "";
	if (result.entries.length === 0) {
		if (result.note) return `No completion entries. ${result.note}`;
		return result.prefix
			? `No completion entries${filter}. Pass ${options.prefix} "" to list every entry.`
			: "No completion entries.";
	}
	let text = result.entries.map((entry) => entry.name).join("\n");
	if (result.truncated) {
		const more = result.total - result.entries.length;
		text += `\n… ${more} more${filter}; pass ${result.prefix ? `a longer ${options.prefix}` : options.prefix} to narrow, or raise ${options.limit}`;
	}
	return text;
}
