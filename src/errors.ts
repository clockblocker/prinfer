import fs from "node:fs";
import path from "node:path";

/**
 * Error class for wrapping TypeScript internal errors with context
 */
export class TypeScriptInternalError extends Error {
	readonly file: string;
	readonly line?: number;
	readonly column?: number;
	readonly operation: string;

	constructor(opts: {
		file: string;
		line?: number;
		column?: number;
		operation: string;
		cause: Error;
	}) {
		const pos = opts.line
			? `${opts.file}:${opts.line}:${opts.column ?? 1}`
			: opts.file;
		const suggestions = getSuggestions(opts.cause);
		super(
			`TypeScript error while ${opts.operation} at ${pos}: ${opts.cause.message}${suggestions}`,
		);
		this.name = "TypeScriptInternalError";
		this.file = opts.file;
		this.line = opts.line;
		this.column = opts.column;
		this.operation = opts.operation;
		this.cause = opts.cause;
	}
}

function getSuggestions(error: Error): string {
	const msg = error.message.toLowerCase();
	if (msg.includes("debug failure")) {
		return "\n\nPossible fixes:\n  - Try a different position\n  - Check for syntax errors\n  - Ensure tsconfig includes this file";
	}
	return "";
}

/**
 * Error with a stable contract code and a request-specific recovery
 * suggestion, so callers can self-correct without parsing the message.
 */
export class PrinferError extends Error {
	readonly code:
		| "INVALID_ARGUMENT"
		| "FILE_NOT_FOUND"
		| "SYMBOL_NOT_FOUND"
		| "TYPESCRIPT_ERROR"
		| "INTERNAL_ERROR";
	readonly suggestion?: string;

	constructor(
		code: PrinferError["code"],
		message: string,
		suggestion?: string,
	) {
		super(message);
		this.name = "PrinferError";
		this.code = code;
		this.suggestion = suggestion;
	}
}

/**
 * Why a type cost needs the TypeScript 6 backend. TypeScript 7.0 counts
 * instantiations (`tsc --extendedDiagnostics`), but neither its API nor its
 * language server reports a count, and that compiler total covers a whole
 * program and changes with `--checkers`.
 */
export const COST_NEEDS_TYPESCRIPT6 =
	"Type costs are counted by the TypeScript 6 checker; TypeScript 7 reports no instantiation counts.";

/**
 * Resolve a source path against cwd and throw a FILE_NOT_FOUND error when it
 * does not exist or is not a regular file (a directory would otherwise fail
 * deep inside TypeScript with an unhelpful message).
 */
export function assertSourceFile(file: string): string {
	const resolved = path.resolve(process.cwd(), file);
	let stats: fs.Stats;
	try {
		stats = fs.statSync(resolved);
	} catch {
		throw new PrinferError("FILE_NOT_FOUND", `File not found: ${resolved}`);
	}
	if (!stats.isFile()) {
		throw new PrinferError(
			"FILE_NOT_FOUND",
			`Not a file: ${resolved} is a ${stats.isDirectory() ? "directory" : "special file"}`,
			"Pass the path of a TypeScript or JavaScript source file, not a directory.",
		);
	}
	return resolved;
}
