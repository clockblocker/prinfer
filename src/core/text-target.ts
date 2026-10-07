import { PrinferError } from "../errors.js";

/** A token addressed by text on a line instead of by column. */
export interface TextTarget {
	/** 1-based line number */
	line: number;
	/** Exact substring to find on the line */
	text: string;
	/** 1-based match index on the line (default 1) */
	occurrence?: number;
}

const MAX_LINE_PREVIEW = 160;
const MAX_OTHER_LINES = 5;

/**
 * Resolve a text target to the 1-based column where the Nth match of `text`
 * on `line` starts. Matches are counted left to right without overlap.
 *
 * @throws PrinferError INVALID_ARGUMENT when the line is outside the file,
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
	const lines = sourceText.split(/\r?\n/);
	const lineText = lines[line - 1];
	if (lineText === undefined) {
		throw new PrinferError(
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
			: ", or pass column instead.";
	const otherLines: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (otherLines.length >= MAX_OTHER_LINES) break;
		if (index !== line - 1 && lines[index]?.includes(text)) {
			otherLines.push(index + 1);
		}
	}
	if (otherLines.length > 0) {
		suggestion += ` ${quoted} appears on line${otherLines.length > 1 ? "s" : ""} ${otherLines.join(", ")}.`;
	}
	throw new PrinferError("SYMBOL_NOT_FOUND", message, suggestion);
}

function matchColumns(lineText: string, text: string): number[] {
	const columns: number[] = [];
	if (!text) return columns;
	let index = lineText.indexOf(text);
	while (index >= 0) {
		columns.push(index + 1);
		index = lineText.indexOf(text, index + text.length);
	}
	return columns;
}

function preview(lineText: string): string {
	const trimmed = lineText.trim();
	return trimmed.length > MAX_LINE_PREVIEW
		? `${trimmed.slice(0, MAX_LINE_PREVIEW - 3)}...`
		: trimmed;
}
