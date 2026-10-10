import fs from "node:fs";
import path from "node:path";
import { contractError } from "./contract.js";
import { getFileAnnotations } from "./core/annotations.js";
import {
	assertCursorPosition,
	findNearestTsconfig,
	findNodeAtPosition,
	getCompletions,
	getFileDiagnostics,
	getHoverInfo,
	loadProgram,
	lookupName,
	sortResultUnions,
} from "./core/index.js";
import type {
	AnnotationFinding,
	AnnotationKind,
	AnnotationsOptions,
	AnnotationsResult,
	AnnotationTarget,
	BatchHoverItem,
	BatchHoverResult,
	CompletionEntry,
	CompletionOptions,
	CompletionResult,
	DiagnosticCategory,
	DiagnosticsOptions,
	DiagnosticsResult,
	FileDiagnostic,
	HoverAlternative,
	HoverByNameOptions,
	HoverOptions,
	HoverPosition,
	HoverResult,
	HoverTiming,
} from "./types.js";

export {
	type AnnotationsSuccess,
	annotationFindingSchema,
	annotationsResultSchema,
	annotationsSuccess,
	annotationsSuccessSchema,
	type BatchHoverSuccess,
	batchHoverItemSchema,
	batchHoverResultSchema,
	batchHoverSuccess,
	batchHoverSuccessSchema,
	CONTRACT_VERSION,
	type ContractErrorCode,
	type ContractErrorResponse,
	contractError,
	contractErrorCodeSchema,
	contractErrorResponseSchema,
	contractErrorSchema,
	type DiagnosticsSuccess,
	declarationLocationSchema,
	diagnosticCategorySchema,
	diagnosticsResultSchema,
	diagnosticsSuccess,
	diagnosticsSuccessSchema,
	fileDiagnosticSchema,
	type HoverSuccess,
	hoverResultSchema,
	hoverSuccess,
	hoverSuccessSchema,
	hoverTimingSchema,
} from "./contract.js";
// Re-export core utilities
export {
	clearProgramCache,
	findFirstMatch,
	findNearestTsconfig,
	findNodeAtPosition,
	findNodeByNameAndLine,
	getCompletions,
	getDocumentation,
	getHoverInfo,
	getLineNumber,
	getTypeInfo,
	type InferredTypeResult,
	invalidateProgramCache,
	loadProgram,
} from "./core/index.js";
// Re-export types
export type {
	AnnotationFinding,
	AnnotationKind,
	AnnotationsOptions,
	AnnotationsResult,
	AnnotationTarget,
	BatchHoverItem,
	BatchHoverResult,
	CompletionEntry,
	CompletionOptions,
	CompletionResult,
	DiagnosticCategory,
	DiagnosticsOptions,
	DiagnosticsResult,
	FileDiagnostic,
	HoverAlternative,
	HoverByNameOptions,
	HoverOptions,
	HoverPosition,
	HoverResult,
	HoverTiming,
};

/**
 * Get the completion entries TypeScript offers at a 1-based cursor position,
 * ranked by TypeScript's sortText with keywords after other entries of the
 * same rank. `prefix` filters names case-insensitively; `limit` truncates
 * (`total` and `truncated` report what was cut).
 */
export function completions(
	file: string,
	line: number,
	column: number,
	options?: CompletionOptions,
): CompletionResult {
	return getCompletions(file, line, column, options?.project, {
		prefix: options?.prefix,
		limit: options?.limit,
	});
}

/**
 * Check one file for TypeScript errors without type-checking the whole project.
 * Returns syntactic and semantic diagnostics for that file (errors and warnings;
 * set include_suggestions for suggestion diagnostics such as unused variables).
 *
 * @example
 * ```ts
 * import { diagnostics } from "prinfer";
 *
 * const result = diagnostics("./src/utils.ts");
 * for (const d of result.diagnostics) {
 *   console.log(`${d.line}:${d.column} TS${d.code}: ${d.message}`);
 * }
 * ```
 */
export function diagnostics(
	file: string,
	options?: DiagnosticsOptions,
): DiagnosticsResult {
	return getFileDiagnostics(
		file,
		options?.project,
		options?.include_suggestions ?? false,
	);
}

/**
 * Find explicit type annotations that TypeScript would infer anyway
 * (`redundant`: removing one keeps exactly the same type) or that are wider
 * than the inferred type (`widening`). Covers variable, parameter, and class
 * property annotations with an initializer, and return types of functions,
 * class methods, and arrow/function expressions that are not contextually
 * typed. Runs on the TypeScript 6 checker.
 *
 * @example
 * ```ts
 * import { annotations } from "prinfer";
 *
 * for (const f of annotations("./src/utils.ts").findings) {
 *   console.log(`${f.line}:${f.column} ${f.kind} ${f.name}: ${f.declared} -> ${f.inferred}`);
 * }
 * ```
 */
export function annotations(
	file: string,
	options?: AnnotationsOptions,
): AnnotationsResult {
	return getFileAnnotations(file, options?.project);
}

/**
 * Get type information at a specific position in a TypeScript file
 *
 * @param file - Path to the TypeScript file
 * @param line - 1-based line number
 * @param column - 1-based column number
 * @param options - Optional hover options (project path, include_docs)
 * @returns The hover information at the position
 * @throws Error if file not found or no symbol at position
 *
 * @example
 * ```ts
 * import { hover } from "prinfer";
 *
 * const result = hover("./src/utils.ts", 75, 10);
 * console.log(result.signature);
 * // => "(x: number) => string"
 *
 * // With documentation
 * const result2 = hover("./src/utils.ts", 75, 10, { include_docs: true });
 * console.log(result2.documentation);
 * // => "Formats a number as a string"
 * ```
 */
export function hover(
	file: string,
	line: number,
	column: number,
	options?: HoverOptions,
): HoverResult;

/**
 * Get type information by symbol name in a TypeScript file
 *
 * @param file - Path to the TypeScript file
 * @param name - Name of the symbol to look up
 * @param options - Optional hover options (project path, include_docs, line to narrow search)
 * @returns The hover information for the symbol
 * @throws Error if file not found or symbol not found
 *
 * @example
 * ```ts
 * import { hover } from "prinfer";
 *
 * const result = hover("./src/utils.ts", "createHandler");
 * console.log(result.signature);
 * // => "(config: Config) => Handler"
 *
 * // Narrow search to a specific line
 * const result2 = hover("./src/utils.ts", "createHandler", { line: 75 });
 * ```
 */
export function hover(
	file: string,
	name: string,
	options?: HoverByNameOptions,
): HoverResult;

export function hover(
	file: string,
	lineOrName: number | string,
	columnOrOptions?: number | HoverByNameOptions,
	options?: HoverOptions,
): HoverResult {
	if (typeof lineOrName === "string") {
		return hoverByNameImpl(
			file,
			lineOrName,
			columnOrOptions as HoverByNameOptions | undefined,
		);
	}
	return hoverByPositionImpl(
		file,
		lineOrName,
		columnOrOptions as number,
		options,
	);
}

function hoverByPositionImpl(
	file: string,
	line: number,
	column: number,
	options?: HoverOptions,
): HoverResult {
	const {
		project,
		include_docs = false,
		full = false,
		sort_unions = false,
	} = options ?? {};
	const includeTiming = options?.include_timing ?? false;

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
	const node = findNodeAtPosition(sourceFile, line, column);
	if (!node) {
		throw new Error(`No symbol found at ${entryFileAbs}:${line}:${column}`);
	}

	const typeResolutionStarted = performance.now();
	const result = getHoverInfo(program, node, sourceFile, include_docs, full);
	if (sort_unions) sortResultUnions(result);
	const typeResolutionMs = performance.now() - typeResolutionStarted;
	if (includeTiming) {
		result.timing = { resolution_ms: roundMs(typeResolutionMs) };
	}
	return result;
}

function hoverByNameImpl(
	file: string,
	name: string,
	options?: HoverByNameOptions,
): HoverResult {
	const {
		project,
		include_docs = false,
		include_timing = false,
		full = false,
		sort_unions = false,
		line,
	} = options ?? {};

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

	// Creating the checker binds the program, which sets the parent pointers
	// the declaration kinds of alternatives and declaredAt are read from.
	program.getTypeChecker();
	const { node, alternatives } = lookupName(sourceFile, name, line, file);

	const typeResolutionStarted = performance.now();
	const result = getHoverInfo(program, node, sourceFile, include_docs, full);
	if (sort_unions) sortResultUnions(result);
	const typeResolutionMs = performance.now() - typeResolutionStarted;
	if (include_timing) {
		result.timing = { resolution_ms: roundMs(typeResolutionMs) };
	}
	if (alternatives) result.alternatives = alternatives;
	return result;
}

/**
 * Get type information at multiple positions efficiently (loads program once)
 *
 * @param file - Path to the TypeScript file
 * @param positions - Array of positions to look up (each with line and column)
 * @param options - Optional hover options (project path, include_docs)
 * @returns Batch result with items array, success count, and error count
 *
 * @example
 * ```ts
 * import { batchHover } from "prinfer";
 *
 * const result = batchHover("./src/utils.ts", [
 *   { line: 75, column: 10 },
 *   { line: 100, column: 5 },
 * ]);
 * console.log(result.successCount); // => 2
 * result.items.forEach(item => {
 *   if (item.result) {
 *     console.log(item.result.signature);
 *   }
 * });
 * ```
 */
export function batchHover(
	file: string,
	positions: HoverPosition[],
	options?: HoverOptions,
): BatchHoverResult {
	const {
		project,
		include_docs = false,
		include_timing = false,
		full = false,
		sort_unions = false,
	} = options ?? {};

	const entryFileAbs = path.resolve(process.cwd(), file);
	const resolvedProject = project
		? path.resolve(process.cwd(), project)
		: findNearestTsconfig(path.dirname(entryFileAbs));

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

	const items: BatchHoverItem[] = [];

	for (const pos of positions) {
		try {
			assertCursorPosition(
				sourceFile.text,
				pos.line,
				pos.column,
				entryFileAbs,
			);
			const node = findNodeAtPosition(sourceFile, pos.line, pos.column);
			if (!node) {
				items.push({
					position: pos,
					error: contractError(
						new Error(
							`No symbol found at ${entryFileAbs}:${pos.line}:${pos.column}`,
						),
						{
							file: entryFileAbs,
							line: pos.line,
							column: pos.column,
							project: resolvedProject,
						},
					).error,
				});
				continue;
			}
			const typeResolutionStarted = performance.now();
			const result = getHoverInfo(
				program,
				node,
				sourceFile,
				include_docs,
				full,
			);
			if (sort_unions) sortResultUnions(result);
			const typeResolutionMs = performance.now() - typeResolutionStarted;
			if (include_timing) {
				result.timing = {
					resolution_ms: roundMs(typeResolutionMs),
				};
			}
			items.push({ position: pos, result });
		} catch (err) {
			items.push({
				position: pos,
				error: contractError(err, {
					file: entryFileAbs,
					line: pos.line,
					column: pos.column,
					project: resolvedProject,
				}).error,
			});
		}
	}

	return {
		items,
		successCount: items.filter((i) => i.result).length,
		errorCount: items.filter((i) => i.error).length,
	};
}

function roundMs(value: number): number {
	return Math.round(value * 1000) / 1000;
}
