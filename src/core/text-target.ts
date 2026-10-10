import { TypeprobeError } from "../errors.js";
import { splitLines, stripBom } from "./lines.js";

/** A token addressed by text on a line instead of by column. */
export interface TextTarget {
	/** 1-based line number */
	line: number;
	/** Text to find on the line; whole-identifier matches are preferred */
	text: string;
	/** 1-based match index on the line (default 1) */
	occurrence?: number;
}

const MAX_LINE_PREVIEW = 160;
const MAX_OTHER_LINES = 5;
const IDENTIFIER_CHAR = /[\p{ID_Continue}$\u200C\u200D]/u;

/**
 * Resolve a text target to the 1-based column where the Nth match of `text`
 * on `line` starts. Lines and columns follow TypeScript: CR, LF, CRLF,
 * U+2028, and U+2029 end lines, and a leading BOM is ignored.
 *
 * Matches are counted left to right without overlap. When `text` starts or
 * ends with an identifier character, only matches not glued to another
 * identifier character on that side count, so "user" skips the start of
 * "users". If the line has no such match, plain substring matches are used.
 *
 * @throws TypeprobeError INVALID_ARGUMENT when the line is outside the file,
 * SYMBOL_NOT_FOUND when the text (or that occurrence) is not on the line.
 * Suggestions quote the actual line so callers can correct the request.
 */
export function resolveTextColumn(
	sourceText: string,
	target: TextTarget,
	file = "file",
): number {
	const { line, text } = target;
	const occurrence = target.occurrence ?? 1;
	const lines = splitLines(stripBom(sourceText));
	const lineText = lines[line - 1];
	if (lineText === undefined) {
		throw new TypeprobeError(
			"INVALID_ARGUMENT",
			`Line ${line} is outside ${file}, which has ${lines.length} lines`,
			`Use a line between 1 and ${lines.length}.`,
		);
	}

	const matches = matchColumns(lineText, text);
	const column = matches[occurrence - 1];
	if (column !== undefined) return column;

	const quoted = JSON.stringify(text);
	const message =
		matches.length === 0
			? `Text ${quoted} not found on line ${line} of ${file}`
			: `Occurrence ${occurrence} of ${quoted} not found on line ${line} of ${file}; the line has ${matches.length}`;
	let suggestion = `Line ${line} reads: ${JSON.stringify(preview(lineText))}. Copy text exactly from it`;
	suggestion +=
		matches.length > 0
			? `, or use occurrence 1-${matches.length}.`
			: ", or give a column instead.";
	const otherLines = linesContaining(lines, text, line - 1);
	if (otherLines.length > 0) {
		suggestion += ` ${quoted} appears on line${otherLines.length > 1 ? "s" : ""} ${otherLines.join(", ")}.`;
	}
	throw new TypeprobeError("SYMBOL_NOT_FOUND", message, suggestion);
}

/**
 * 1-based start columns of `text` on the line: whole-identifier matches when
 * there are any, otherwise every substring match.
 */
function matchColumns(lineText: string, text: string): number[] {
	const all = substringColumns(lineText, text);
	const whole = all.filter((column) =>
		isWholeMatch(lineText, text, column - 1),
	);
	return whole.length > 0 ? whole : all;
}

function substringColumns(lineText: string, text: string): number[] {
	const columns: number[] = [];
	if (!text) return columns;
	let index = lineText.indexOf(text);
	while (index >= 0) {
		columns.push(index + 1);
		index = lineText.indexOf(text, index + text.length);
	}
	return columns;
}

/**
 * True unless the match continues an identifier: an identifier character at
 * an edge of `text` must not touch another one just outside the match.
 */
function isWholeMatch(lineText: string, text: string, index: number): boolean {
	const before = charBefore(lineText, index);
	const after = charAt(lineText, index + text.length);
	if (isIdentifierChar(charAt(text, 0)) && isIdentifierChar(before))
		return false;
	if (
		isIdentifierChar(charBefore(text, text.length)) &&
		isIdentifierChar(after)
	)
		return false;
	return true;
}

/** Lines other than `skip` with a match, preferring whole-identifier ones. */
function linesContaining(
	lines: string[],
	text: string,
	skip: number,
): number[] {
	const whole: number[] = [];
	const partial: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (whole.length >= MAX_OTHER_LINES) break;
		if (index === skip) continue;
		const lineText = lines[index] ?? "";
		const columns = substringColumns(lineText, text);
		if (columns.length === 0) continue;
		if (columns.some((column) => isWholeMatch(lineText, text, column - 1)))
			whole.push(index + 1);
		else if (partial.length < MAX_OTHER_LINES) partial.push(index + 1);
	}
	return whole.length > 0 ? whole : partial;
}

function charAt(text: string, index: number): string | undefined {
	const code = text.codePointAt(index);
	return code === undefined ? undefined : String.fromCodePoint(code);
}

function charBefore(text: string, index: number): string | undefined {
	if (index <= 0) return undefined;
	const low = text.charCodeAt(index - 1);
	const surrogatePair = index >= 2 && low >= 0xdc00 && low <= 0xdfff;
	return text.slice(surrogatePair ? index - 2 : index - 1, index);
}

function isIdentifierChar(char: string | undefined): boolean {
	return char !== undefined && IDENTIFIER_CHAR.test(char);
}

function preview(lineText: string): string {
	const trimmed = lineText.trim();
	return trimmed.length > MAX_LINE_PREVIEW
		? `${trimmed.slice(0, MAX_LINE_PREVIEW - 3)}...`
		: trimmed;
}
