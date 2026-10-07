/**
 * Line and column handling shared by both backends.
 *
 * prinfer reports lines the way the TypeScript compiler counts them: CRLF,
 * LF, lone CR, U+2028, and U+2029 each end a line, and a leading UTF-8 BOM is
 * not part of the text (TypeScript strips it when reading files). The language
 * server protocol only breaks lines on CRLF, LF, and CR, so the TypeScript 7
 * backend converts positions with {@link toLspPosition} and
 * {@link fromLspPosition}.
 */

import { PrinferError } from "../errors.js";

/** A 0-based line and UTF-16 character offset, as in LSP and TypeScript. */
export interface LineCharacter {
	line: number;
	character: number;
}

const BOM = "\uFEFF";
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** Remove a leading UTF-8 byte-order mark, as TypeScript does on read. */
export function stripBom(text: string): string {
	return text.startsWith(BOM) ? text.slice(1) : text;
}

/** Split text into lines with TypeScript's line-break rules. */
export function splitLines(text: string): string[] {
	return text.split(LINE_BREAK);
}

/**
 * Start offsets of each line. TypeScript rules by default; with `lsp`, only
 * CRLF, LF, and CR break lines.
 */
export function lineStarts(text: string, lsp = false): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 13) {
			if (text.charCodeAt(index + 1) === 10) index++;
			starts.push(index + 1);
		} else if (
			code === 10 ||
			(!lsp && (code === 0x2028 || code === 0x2029))
		) {
			starts.push(index + 1);
		}
	}
	return starts;
}

function hasSeparatorOnlyBreaks(text: string): boolean {
	return text.includes("\u2028") || text.includes("\u2029");
}

function offsetAt(starts: number[], position: LineCharacter): number {
	const start = starts[position.line] ?? starts[starts.length - 1] ?? 0;
	return start + position.character;
}

function positionAt(starts: number[], offset: number): LineCharacter {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if ((starts[middle] ?? 0) <= offset) low = middle;
		else high = middle - 1;
	}
	return { line: low, character: offset - (starts[low] ?? 0) };
}

/** Convert a TypeScript-rules position in `text` to an LSP position. */
export function toLspPosition(
	text: string,
	position: LineCharacter,
): LineCharacter {
	if (!hasSeparatorOnlyBreaks(text)) return position;
	return positionAt(
		lineStarts(text, true),
		offsetAt(lineStarts(text), position),
	);
}

/** Convert an LSP position in `text` to a TypeScript-rules position. */
export function fromLspPosition(
	text: string,
	position: LineCharacter,
): LineCharacter {
	if (!hasSeparatorOnlyBreaks(text)) return position;
	return positionAt(
		lineStarts(text),
		offsetAt(lineStarts(text, true), position),
	);
}

/**
 * Throw INVALID_ARGUMENT unless the 1-based `line` and `column` address a
 * cursor position in `text` (BOM already stripped): a line of the file, and
 * a column on that line or just past its last character. The error gives the
 * valid range so callers can correct the request.
 */
export function assertCursorPosition(
	text: string,
	line: number,
	column: number,
	file: string,
): void {
	const lines = splitLines(text);
	if (!Number.isInteger(line) || line < 1 || line > lines.length) {
		throw new PrinferError(
			"INVALID_ARGUMENT",
			`Line ${line} is outside ${file}, which has ${lines.length} line${lines.length === 1 ? "" : "s"}`,
			`Use a line between 1 and ${lines.length}.`,
		);
	}
	const length = (lines[line - 1] ?? "").length;
	if (!Number.isInteger(column) || column < 1 || column > length + 1) {
		throw new PrinferError(
			"INVALID_ARGUMENT",
			`Column ${column} is outside line ${line} of ${file}`,
			`Line ${line} has ${length} character${length === 1 ? "" : "s"}; use a column between 1 and ${length + 1}.`,
		);
	}
}
