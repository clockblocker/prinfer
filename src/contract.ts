import * as z from "zod/v4";
import { PrinferError, TypeScriptInternalError } from "./errors.js";

export const CONTRACT_VERSION = 1 as const;

export const hoverTimingSchema = z.object({
	resolution_ms: z.number().nonnegative(),
});

export const hoverPositionSchema = z.object({
	line: z.number(),
	column: z.number(),
});

export const hoverResultSchema = z.object({
	signature: z.string(),
	returnType: z.string().optional(),
	line: z.number(),
	column: z.number(),
	documentation: z.string().optional(),
	kind: z.string(),
	name: z.string().optional(),
	timing: hoverTimingSchema.optional(),
	/** The queried position, after resolving a text target to a column. */
	position: hoverPositionSchema.optional(),
});

export const completionResultSchema = z.object({
	file: z.string(),
	line: z.number(),
	column: z.number(),
	isGlobalCompletion: z.boolean(),
	isMemberCompletion: z.boolean(),
	isNewIdentifierLocation: z.boolean(),
	prefix: z.string().optional(),
	entries: z.array(
		z.object({
			name: z.string(),
			kind: z.string(),
			sortText: z.string(),
			insertText: z.string().optional(),
			source: z.string().optional(),
		}),
	),
	total: z.number(),
	truncated: z.boolean(),
});

export const diagnosticCategorySchema = z.enum([
	"error",
	"warning",
	"suggestion",
	"message",
]);

export const fileDiagnosticSchema = z.object({
	line: z.number(),
	column: z.number(),
	endLine: z.number(),
	endColumn: z.number(),
	code: z.number(),
	category: diagnosticCategorySchema,
	message: z.string(),
	source: z.string().optional(),
});

export const diagnosticsResultSchema = z.object({
	file: z.string(),
	diagnostics: z.array(fileDiagnosticSchema),
	errorCount: z.number(),
	warningCount: z.number(),
});

export const annotationFindingSchema = z.object({
	line: z.number(),
	column: z.number(),
	endLine: z.number(),
	endColumn: z.number(),
	name: z.string(),
	target: z.enum(["variable", "parameter", "property", "return"]),
	kind: z.enum(["redundant", "widening"]),
	declared: z.string(),
	inferred: z.string(),
	exported: z.boolean(),
	suggestion: z.string(),
});

export const annotationsResultSchema = z.object({
	file: z.string(),
	findings: z.array(annotationFindingSchema),
	redundantCount: z.number(),
	wideningCount: z.number(),
	checkedCount: z.number(),
});

export const contractErrorCodeSchema = z.enum([
	"INVALID_ARGUMENT",
	"FILE_NOT_FOUND",
	"SYMBOL_NOT_FOUND",
	"TYPESCRIPT_ERROR",
	"INTERNAL_ERROR",
]);

export const contractErrorSchema = z.object({
	code: contractErrorCodeSchema,
	message: z.string(),
	file: z.string().optional(),
	line: z.number().optional(),
	column: z.number().optional(),
	project: z.string().optional(),
	candidates: z.array(z.string()).optional(),
	suggestion: z.string().optional(),
});

export const batchHoverItemSchema = z.object({
	/**
	 * The queried position. Text targets report the resolved column;
	 * name targets report where the symbol was found. A column of 0
	 * means the target could not be resolved to a position.
	 */
	position: hoverPositionSchema,
	file: z.string().optional(),
	name: z.string().optional(),
	text: z.string().optional(),
	occurrence: z.number().optional(),
	result: hoverResultSchema.optional(),
	error: contractErrorSchema.optional(),
});

export const batchHoverResultSchema = z.object({
	items: z.array(batchHoverItemSchema),
	successCount: z.number(),
	errorCount: z.number(),
});

export const hoverSuccessSchema = z.object({
	version: z.literal(CONTRACT_VERSION),
	ok: z.literal(true),
	result: hoverResultSchema,
});

export const batchHoverSuccessSchema = z.object({
	version: z.literal(CONTRACT_VERSION),
	ok: z.literal(true),
	result: batchHoverResultSchema,
});

export const completionSuccessSchema = z.object({
	version: z.literal(CONTRACT_VERSION),
	ok: z.literal(true),
	result: completionResultSchema,
});

export const diagnosticsSuccessSchema = z.object({
	version: z.literal(CONTRACT_VERSION),
	ok: z.literal(true),
	result: diagnosticsResultSchema,
});

export const annotationsSuccessSchema = z.object({
	version: z.literal(CONTRACT_VERSION),
	ok: z.literal(true),
	result: annotationsResultSchema,
});

export const contractErrorResponseSchema = z.object({
	version: z.literal(CONTRACT_VERSION),
	ok: z.literal(false),
	error: contractErrorSchema,
});

export type ContractErrorCode = z.infer<typeof contractErrorCodeSchema>;
export type ContractErrorResponse = z.infer<typeof contractErrorResponseSchema>;
export type HoverSuccess = z.infer<typeof hoverSuccessSchema>;
export type BatchHoverSuccess = z.infer<typeof batchHoverSuccessSchema>;
export type CompletionSuccess = z.infer<typeof completionSuccessSchema>;
export type DiagnosticsSuccess = z.infer<typeof diagnosticsSuccessSchema>;
export type AnnotationsSuccess = z.infer<typeof annotationsSuccessSchema>;

export function hoverSuccess(result: unknown): HoverSuccess {
	return hoverSuccessSchema.parse({
		version: CONTRACT_VERSION,
		ok: true,
		result,
	});
}

export function batchHoverSuccess(result: unknown): BatchHoverSuccess {
	return batchHoverSuccessSchema.parse({
		version: CONTRACT_VERSION,
		ok: true,
		result,
	});
}

export function completionSuccess(result: unknown): CompletionSuccess {
	return completionSuccessSchema.parse({
		version: CONTRACT_VERSION,
		ok: true,
		result,
	});
}

export function diagnosticsSuccess(result: unknown): DiagnosticsSuccess {
	return diagnosticsSuccessSchema.parse({
		version: CONTRACT_VERSION,
		ok: true,
		result,
	});
}

export function annotationsSuccess(result: unknown): AnnotationsSuccess {
	return annotationsSuccessSchema.parse({
		version: CONTRACT_VERSION,
		ok: true,
		result,
	});
}

/** MCP tools that report contract errors. */
export type McpTool =
	| "hover_by_name"
	| "hover"
	| "batch_hover"
	| "completions"
	| "diagnostics"
	| "annotations";

/** CLI modes that report contract errors. */
export type CliCommand =
	| "name"
	| "position"
	| "complete"
	| "check"
	| "annotations";

/**
 * Where an error is reported, so the default recovery suggestion names
 * arguments and commands the caller can actually use there. Defaults to MCP.
 */
export type ErrorSurface =
	| { interface: "mcp"; tool?: McpTool }
	| { interface: "cli"; command?: CliCommand };

export interface ContractErrorContext {
	code?: ContractErrorCode;
	file?: string;
	line?: number;
	column?: number;
	project?: string;
	candidates?: string[];
	suggestion?: string;
	surface?: ErrorSurface;
}

export function contractError(
	error: unknown,
	context: ContractErrorContext = {},
): ContractErrorResponse {
	const source = error instanceof Error ? error : new Error(String(error));
	const internal =
		source instanceof TypeScriptInternalError ? source : undefined;
	const prinfer = source instanceof PrinferError ? source : undefined;
	const code = context.code ?? classifyError(source);

	return contractErrorResponseSchema.parse({
		version: CONTRACT_VERSION,
		ok: false,
		error: {
			code,
			message: source.message,
			file: context.file ?? internal?.file,
			line: context.line ?? internal?.line,
			column: context.column ?? internal?.column,
			project: context.project,
			candidates: context.candidates,
			suggestion:
				context.suggestion ??
				prinfer?.suggestion ??
				suggestionFor(code, context.surface),
		},
	});
}

/** The default recovery suggestion for an error code on a given surface. */
export function suggestionFor(
	code: ContractErrorCode,
	surface: ErrorSurface = { interface: "mcp" },
): string {
	return surface.interface === "cli"
		? cliSuggestion(code, surface.command)
		: mcpSuggestion(code, surface.tool);
}

function mcpSuggestion(code: ContractErrorCode, tool?: McpTool): string {
	const retry =
		tool === "completions" || tool === "annotations"
			? ""
			: ', or retry with backend "typescript6"';
	switch (code) {
		case "INVALID_ARGUMENT":
			switch (tool) {
				case "hover_by_name":
					return "Pass a non-empty symbol name and, optionally, a positive 1-based line.";
				case "hover":
					return "Pass a positive 1-based line and exactly one of text (copied from that line) or column.";
				case "batch_hover":
					return "Make each item {name, line?}, {line, text, occurrence?}, or {line, column} with 1-based numbers, and send at most 100 items.";
				case "completions":
					return "Pass a positive 1-based line and column for the cursor, and a limit between 1 and 500.";
				case "diagnostics":
				case "annotations":
					return "Pass the path of one TypeScript or JavaScript file.";
				default:
					return "Use positive 1-based line and column values, and exactly one of column or text.";
			}
		case "FILE_NOT_FOUND":
			return `Check the path. Relative paths resolve against the MCP server's working directory (${process.cwd()}); pass an absolute path to be sure.`;
		case "SYMBOL_NOT_FOUND":
			switch (tool) {
				case "hover_by_name":
					return "Check the spelling against candidates, pass line to pick the match on a known line, or call hover with that line and text copied from it.";
				case "batch_hover":
					return "Check name items against candidates, or target the token with {line, text} copied from the line.";
				default:
					return "Point at an identifier: pass text copied from the line rather than counting columns, or call hover_by_name with the symbol name.";
			}
		case "TYPESCRIPT_ERROR":
			return `Check the selected tsconfig (project) and the source syntax${retry}.`;
		case "INTERNAL_ERROR":
			return `Verify the file and project paths${retry ? `${retry} if the problem persists` : ""}.`;
	}
}

function cliSuggestion(code: ContractErrorCode, command?: CliCommand): string {
	const retry =
		command === "complete" || command === "annotations"
			? ""
			: ", or retry with the other --backend (typescript6 or typescript7)";
	switch (code) {
		case "INVALID_ARGUMENT":
			switch (command) {
				case "check":
					return "Usage: prinfer check <file.ts> [--suggestions] [--json] [--project <tsconfig.json>] [--backend <typescript6|typescript7>].";
				case "annotations":
					return "Usage: prinfer annotations <file.ts> [--json] [--project <tsconfig.json>].";
				case "complete":
					return "Usage: prinfer complete <file.ts>:<line>:<text|column> [--prefix <text>] [--limit <n>] with a 1-based line; text puts the cursor right after it.";
				default:
					return "Use <file>:<name>, <file>:<name>:<line>, <file>:<line>:<text>, or <file>:<line>:<column> with 1-based numbers; run prinfer --help for options.";
			}
		case "FILE_NOT_FOUND":
			return `Check the path. Relative paths resolve against the current directory (${process.cwd()}).`;
		case "SYMBOL_NOT_FOUND":
			switch (command) {
				case "name":
					return "Check the spelling against candidates, add a line hint (<file>:<name>:<line>), or target the token with <file>:<line>:<text>.";
				default:
					return "Point at an identifier with <file>:<line>:<text> (text copied from the line) instead of counting columns, or look the symbol up by name with <file>:<name>.";
			}
		case "TYPESCRIPT_ERROR":
			return `Check the selected tsconfig (--project) and the source syntax${retry}.`;
		case "INTERNAL_ERROR":
			return `Verify the file and --project paths${retry ? `${retry} if the problem persists` : ""}.`;
	}
}

function classifyError(error: Error): ContractErrorCode {
	if (error instanceof PrinferError) return error.code;
	if (error instanceof TypeScriptInternalError) return "TYPESCRIPT_ERROR";
	if (
		error.message.startsWith("TypeScript LSP:") ||
		error.message.startsWith("TypeScript 7 language server")
	) {
		return "TYPESCRIPT_ERROR";
	}
	if (error.message.startsWith("File not found:")) return "FILE_NOT_FOUND";
	if (
		error.message.startsWith("No symbol found") ||
		error.message.startsWith("No symbol named")
	) {
		return "SYMBOL_NOT_FOUND";
	}
	return "INTERNAL_ERROR";
}
