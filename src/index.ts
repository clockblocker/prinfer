import fs from "node:fs";
import path from "node:path";
import {
	findNodeAtPosition,
	findNodeByNameAndLine,
	getHoverInfo,
	loadProgram,
} from "./core/index.js";
import type {
	BatchHoverItem,
	BatchHoverResult,
	HoverByNameOptions,
	HoverOptions,
	HoverPosition,
	HoverResult,
} from "./types.js";

// Re-export types
export type {
	BatchHoverItem,
	BatchHoverResult,
	HoverByNameOptions,
	HoverOptions,
	HoverPosition,
	HoverResult,
};

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
	type InferredTypeResult,
	loadProgram,
} from "./core/index.js";

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

function hoverByNameImpl(
	file: string,
	name: string,
	options?: HoverByNameOptions,
): HoverResult {
	const { project, include_docs = false, line } = options ?? {};

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
		const lineInfo = line ? ` at line ${line}` : "";
		throw new Error(
			`No symbol named "${name}"${lineInfo} found in ${file}`,
		);
	}

	return getHoverInfo(program, node, sourceFile, include_docs);
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

	const items: BatchHoverItem[] = [];

	for (const pos of positions) {
		try {
			const node = findNodeAtPosition(sourceFile, pos.line, pos.column);
			if (!node) {
				items.push({
					position: pos,
					error: `No symbol at ${pos.line}:${pos.column}`,
				});
				continue;
			}
			const result = getHoverInfo(
				program,
				node,
				sourceFile,
				include_docs,
			);
			items.push({ position: pos, result });
		} catch (err) {
			items.push({ position: pos, error: (err as Error).message });
		}
	}

	return {
		items,
		successCount: items.filter((i) => i.result).length,
		errorCount: items.filter((i) => i.error).length,
	};
}
