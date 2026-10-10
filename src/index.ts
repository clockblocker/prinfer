import fs from "node:fs";
import path from "node:path";
import { runTypeScript6, withCompilerInfo } from "./compiler.js";
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
	measureHoverCost,
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
	CompilerInfo,
	CompilerMode,
	CompletionEntry,
	CompletionOptions,
	CompletionResult,
	DiagnosticCategory,
	DiagnosticsOptions,
	DiagnosticsResult,
	FileDiagnostic,
	HoverAlternative,
	HoverByNameOptions,
	HoverCost,
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
	compilerInfoSchema,
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
	hoverCostSchema,
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
	CompilerInfo,
	CompilerMode,
	CompletionEntry,
	CompletionOptions,
	CompletionResult,
	DiagnosticCategory,
	DiagnosticsOptions,
	DiagnosticsResult,
	FileDiagnostic,
	HoverAlternative,
	HoverByNameOptions,
	HoverCost,
	HoverOptions,
	HoverPosition,
	HoverResult,
	HoverTiming,
};

/**
 * The completions TypeScript 6 offers at a 1-based cursor (before the
 * character at `column`), in TypeScript's ranking with keywords after
 * other entries of the same rank. Every entry unless `prefix` (a
 * case-insensitive name prefix) or `limit` narrows them; `total` and
 * `truncated` report what `limit` cut.
 */
export function completions(
	file: string,
	line: number,
	column: number,
	options?: CompletionOptions,
): CompletionResult {
	return runTypeScript6(file, options, () =>
		getCompletions(file, line, column, options?.project, {
			prefix: options?.prefix,
			limit: options?.limit,
		}),
	);
}

/**
 * Syntactic and semantic diagnostics for one file, on TypeScript 6, without
 * checking the whole project. Errors and warnings by default;
 * `include_suggestions` adds suggestions such as unused variables.
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
	return runTypeScript6(file, options, () =>
		getFileDiagnostics(
			file,
			options?.project,
			options?.include_suggestions ?? false,
		),
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
	return runTypeScript6(file, options, () =>
		getFileAnnotations(file, options?.project),
	);
}

/**
 * The type at a 1-based position, as an editor hover shows it, on
 * TypeScript 6. Throws when the file or a symbol at the position is missing.
 *
 * @example
 * ```ts
 * import { hover } from "prinfer";
 *
 * hover("./src/utils.ts", 75, 10).signature;
 * // => "(x: number): string"
 * hover("./src/utils.ts", 75, 10, { include_docs: true }).documentation;
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
 * The type of a named symbol, on TypeScript 6. `line` picks among
 * same-named declarations; `alternatives` lists the ones not picked.
 * Throws when the file or the name is missing.
 *
 * @example
 * ```ts
 * import { hover } from "prinfer";
 *
 * hover("./src/utils.ts", "createHandler").signature;
 * // => "(config: Config): Handler"
 * hover("./src/utils.ts", "createHandler", { line: 75 });
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
		const byName = columnOrOptions as HoverByNameOptions | undefined;
		return runTypeScript6(file, byName, (compiler) =>
			hoverByNameImpl(file, lineOrName, compiler, byName),
		);
	}
	return runTypeScript6(file, options, (compiler) =>
		hoverByPositionImpl(
			file,
			lineOrName,
			columnOrOptions as number,
			compiler,
			options,
		),
	);
}

function hoverByPositionImpl(
	file: string,
	line: number,
	column: number,
	compiler: CompilerInfo,
	options?: HoverOptions,
): HoverResult {
	const {
		project,
		include_docs = false,
		include_cost = false,
		full = false,
		sort_unions = false,
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

	assertCursorPosition(sourceFile.text, line, column, entryFileAbs);
	const node = findNodeAtPosition(sourceFile, line, column);
	if (!node) {
		throw new Error(`No symbol found at ${entryFileAbs}:${line}:${column}`);
	}

	const result = getHoverInfo(program, node, sourceFile, include_docs, full);
	if (sort_unions) sortResultUnions(result);
	if (include_cost) {
		result.cost = withCompilerInfo(
			measureHoverCost(program, node, sourceFile),
			compiler,
		);
	}
	return result;
}

function hoverByNameImpl(
	file: string,
	name: string,
	compiler: CompilerInfo,
	options?: HoverByNameOptions,
): HoverResult {
	const {
		project,
		include_docs = false,
		include_cost = false,
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

	const result = getHoverInfo(program, node, sourceFile, include_docs, full);
	if (sort_unions) sortResultUnions(result);
	if (include_cost) {
		result.cost = withCompilerInfo(
			measureHoverCost(program, node, sourceFile),
			compiler,
		);
	}
	if (alternatives) result.alternatives = alternatives;
	return result;
}

/**
 * Hover several 1-based positions of one file, loading its program once.
 * A bad position fails its own item; only a file that can't be loaded
 * throws.
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
	return runTypeScript6(file, options, (compiler) =>
		batchHoverImpl(file, positions, compiler, options),
	);
}

function batchHoverImpl(
	file: string,
	positions: HoverPosition[],
	compiler: CompilerInfo,
	options?: HoverOptions,
): BatchHoverResult {
	const {
		project,
		include_docs = false,
		include_cost = false,
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
			const result = getHoverInfo(
				program,
				node,
				sourceFile,
				include_docs,
				full,
			);
			if (sort_unions) sortResultUnions(result);
			if (include_cost) {
				result.cost = withCompilerInfo(
					measureHoverCost(program, node, sourceFile),
					compiler,
				);
			}
			items.push({
				position: pos,
				result: withCompilerInfo(result, compiler),
			});
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
