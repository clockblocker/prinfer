import path from "node:path";
import { nearbyCandidates } from "./candidates.js";
import {
	type ContractErrorResponse,
	contractError,
	type ErrorSurface,
} from "./contract.js";
import { findNearestTsconfig } from "./core/index.js";

type ContractErrorBody = ContractErrorResponse["error"];

export interface ErrorReportContext {
	/** The requested file, absolute or relative to cwd. */
	file?: string;
	/** The requested project; defaults to the tsconfig nearest the file. */
	project?: string;
	line?: number;
	column?: number;
	/** The name or text that failed to resolve; ranks candidates. */
	query?: string;
	/** Only suggest names close to query (name lookups). */
	strict?: boolean;
	surface: ErrorSurface;
}

/**
 * The contract error for a failed MCP tool call or CLI command, with
 * surface-specific advice, the project, and, for SYMBOL_NOT_FOUND, nearby
 * names. Never throws: it runs on error paths, where the file may be
 * missing, a directory, or unreadable.
 */
export function reportError(
	error: unknown,
	context: ErrorReportContext,
): ContractErrorResponse {
	const file = context.file
		? path.resolve(process.cwd(), context.file)
		: undefined;
	const response = contractError(error, {
		file,
		line: context.line,
		column: context.column,
		project: projectFor(file, context.project),
		surface: context.surface,
	});
	if (
		file &&
		response.error.code === "SYMBOL_NOT_FOUND" &&
		!response.error.candidates
	) {
		const candidates = nearbyCandidates(file, {
			line: context.line || undefined,
			query: context.query,
			strict: context.strict,
		});
		if (candidates) response.error.candidates = candidates;
	}
	return response;
}

/** The explicit project, or the tsconfig.json nearest the file. */
export function projectFor(
	file: string | undefined,
	project: string | undefined,
): string | undefined {
	if (project) return path.resolve(process.cwd(), project);
	if (!file) return undefined;
	try {
		return findNearestTsconfig(path.dirname(file));
	} catch {
		return undefined;
	}
}

/**
 * Error text for readers that only see text (most MCP clients show the model
 * only text content; CLI stderr): the message, then candidates and the
 * recovery suggestion when present. Candidates of a name lookup (`strict`)
 * are offered as spelling fixes, others as the identifiers near the line.
 */
export function formatErrorText(
	error: ContractErrorBody,
	options: { strict?: boolean } = {},
): string {
	let text = `Error [${error.code}]: ${error.message}`;
	if (error.candidates?.length) {
		text += options.strict
			? `\nDid you mean: ${error.candidates.join(", ")}?`
			: `\nNearby identifiers: ${error.candidates.join(", ")}`;
	}
	if (error.suggestion) text += `\nSuggestion: ${error.suggestion}`;
	return text;
}
