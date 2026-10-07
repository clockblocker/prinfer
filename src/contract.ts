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
	entries: z.array(
		z.object({
			name: z.string(),
			kind: z.string(),
			sortText: z.string(),
			insertText: z.string().optional(),
			source: z.string().optional(),
		}),
	),
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

export const batchHoverResultSchema = z.object({
	items: z.array(
		z.object({
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
		}),
	),
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

interface ContractErrorContext {
	code?: ContractErrorCode;
	file?: string;
	line?: number;
	column?: number;
	project?: string;
	candidates?: string[];
	suggestion?: string;
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
				suggestionFor(code),
		},
	});
}

function suggestionFor(code: ContractErrorCode): string {
	switch (code) {
		case "INVALID_ARGUMENT":
			return "Use positive 1-based line and column values, give exactly one of column or text, and send at most 100 batch items.";
		case "FILE_NOT_FOUND":
			return "Check the resolved file path and the MCP server working directory.";
		case "SYMBOL_NOT_FOUND":
			return "Try hover_by_name with the symbol name, or hover with text copied from the line instead of a column.";
		case "TYPESCRIPT_ERROR":
			return "Check the selected tsconfig and source syntax, or retry with backend typescript6.";
		case "INTERNAL_ERROR":
			return "Verify the file and project paths, then retry with backend typescript6 if the problem persists.";
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
