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
