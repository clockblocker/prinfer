import fs from "node:fs";
import path from "node:path";
import { findNodeByNameAndLine, getTypeInfo, loadProgram } from "./core.js";
import type { InferredTypeResult, Options } from "./types.js";

// Re-export types
export type { Options, InferredTypeResult };

// Re-export core utilities
export {
	findFirstMatch,
	findNearestTsconfig,
	findNodeByNameAndLine,
	getLineNumber,
	getTypeInfo,
	loadProgram,
} from "./core.js";

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
