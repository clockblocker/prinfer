import fs from "node:fs";
import path from "node:path";
import {
	findNodeAtPosition,
	findNodeByNameAndLine,
	getHoverInfo,
	getTypeInfo,
	loadProgram,
} from "./core/index.js";
import type {
	HoverOptions,
	HoverResult,
	InferredTypeResult,
	Options,
} from "./types.js";

// Re-export types
export type { HoverOptions, HoverResult, InferredTypeResult, Options };

// Re-export core utilities
export {
	findFirstMatch,
	findNearestTsconfig,
	findNodeAtPosition,
	findNodeByNameAndLine,
	getDocumentation,
	getHoverInfo,
	getLineNumber,
	getTypeInfo,
	loadProgram,
} from "./core/index.js";

/**
 * Infer the type of a function or variable in a TypeScript file
 *
 * @param file - Path to the TypeScript file
 * @param name - Name of the function/variable to inspect
 * @param options - Optional: project path (string) or options object with line and project
 * @returns The inferred type information
 * @throws Error if file not found or symbol not found
 *
 * @example
 * ```ts
 * import { inferType } from "prinfer";
 *
 * // By name only
 * const result = inferType("./src/utils.ts", "myFunction");
 * console.log(result.signature);
 * // => "(x: number, y: string) => boolean"
 *
 * // By name and line number
 * const result2 = inferType("./src/utils.ts", "commandResult", { line: 75 });
 * console.log(result2.signature);
 * // => "Result<VaultAction[], CommandError>"
 * ```
 */
export function inferType(
	file: string,
	name: string,
	options?: string | { line?: number; project?: string },
): InferredTypeResult {
	// Normalize options for backward compatibility
	const opts =
		typeof options === "string" ? { project: options } : (options ?? {});
	const { line, project } = opts;

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

	const node = findNodeByNameAndLine(sourceFile, name, line);
	if (!node) {
		const lineInfo = line !== undefined ? ` at line ${line}` : "";
		throw new Error(
			`No symbol named "${name}"${lineInfo} found in ${entryFileAbs}`,
		);
	}

	return getTypeInfo(program, node, sourceFile);
}

/**
 * Infer the type using an options object
 *
 * @param options - Options for type inference
 * @returns The inferred type information
 */
export function inferTypeFromOptions(options: Options): InferredTypeResult {
	return inferType(options.file, options.name, {
		line: options.line,
		project: options.project,
	});
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
): HoverResult {
	const { project, include_docs = false } = options ?? {};

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

	const node = findNodeAtPosition(sourceFile, line, column);
	if (!node) {
		throw new Error(`No symbol found at ${entryFileAbs}:${line}:${column}`);
	}

	return getHoverInfo(program, node, sourceFile, include_docs);
}
