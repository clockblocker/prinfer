import * as z from "zod/v4";
import { TypeScriptInternalError } from "./errors.js";

export const CONTRACT_VERSION = 1 as const;

export const hoverResultSchema = z.object({
	signature: z.string(),
	returnType: z.string().optional(),
	line: z.number(),
	column: z.number(),
	documentation: z.string().optional(),
	kind: z.string(),
	name: z.string().optional(),
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
			position: z.object({
				line: z.number(),
				column: z.number(),
			}),
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

export const contractErrorResponseSchema = z.object({
	version: z.literal(CONTRACT_VERSION),
	ok: z.literal(false),
	error: contractErrorSchema,
});

export type ContractErrorCode = z.infer<typeof contractErrorCodeSchema>;
export type ContractErrorResponse = z.infer<
	typeof contractErrorResponseSchema
>;
export type HoverSuccess = z.infer<typeof hoverSuccessSchema>;
export type BatchHoverSuccess = z.infer<typeof batchHoverSuccessSchema>;

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

interface ContractErrorContext {
	code?: ContractErrorCode;
	file?: string;
	line?: number;
	column?: number;
	project?: string;
	candidates?: string[];
}

export function contractError(
	error: unknown,
	context: ContractErrorContext = {},
): ContractErrorResponse {
	const source = error instanceof Error ? error : new Error(String(error));
	const internal =
		source instanceof TypeScriptInternalError ? source : undefined;
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
			suggestion: suggestionFor(code),
		},
	});
}

function suggestionFor(code: ContractErrorCode): string {
	switch (code) {
		case "INVALID_ARGUMENT":
			return "Use positive, 1-based integer line and column values and no more than 100 batch positions.";
		case "FILE_NOT_FOUND":
			return "Check the resolved file path and the MCP server working directory.";
		case "SYMBOL_NOT_FOUND":
			return "Try hover_by_name when you know the symbol name, or move the position onto the symbol token.";
		case "TYPESCRIPT_ERROR":
			return "Check the selected tsconfig and source syntax, or retry with backend typescript6.";
		case "INTERNAL_ERROR":
			return "Verify the file and project paths, then retry with backend typescript6 if the problem persists.";
	}
}

function classifyError(error: Error): ContractErrorCode {
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
