import path from "node:path";
import fs from "node:fs";
import type { Options, InferredTypeResult } from "./types.js";
import { loadProgram, findFirstMatch, getTypeInfo } from "./core.js";

// Re-export types
export type { Options, InferredTypeResult };

// Re-export core utilities
export { loadProgram, findFirstMatch, getTypeInfo, findNearestTsconfig } from "./core.js";

/**
 * Infer the type of a function or variable in a TypeScript file
 *
 * @param file - Path to the TypeScript file
 * @param name - Name of the function/variable to inspect
 * @param project - Optional path to tsconfig.json
 * @returns The inferred type information
 * @throws Error if file not found or symbol not found
 *
 * @example
 * ```ts
 * import { inferType } from "prinfer";
 *
 * const result = inferType("./src/utils.ts", "myFunction");
 * console.log(result.signature);
 * // => "(x: number, y: string) => boolean"
 * console.log(result.returnType);
 * // => "boolean"
 * ```
 */
export function inferType(
  file: string,
  name: string,
  project?: string
): InferredTypeResult {
  const entryFileAbs = path.resolve(process.cwd(), file);

  if (!fs.existsSync(entryFileAbs)) {
    throw new Error(`File not found: ${entryFileAbs}`);
  }

  const program = loadProgram(entryFileAbs, project);
  const sourceFile = program.getSourceFile(entryFileAbs);

  if (!sourceFile) {
    throw new Error(
      `Could not load source file into the program (check tsconfig include/exclude): ${entryFileAbs}`
    );
  }

  const node = findFirstMatch(sourceFile, name);
  if (!node) {
    throw new Error(
      `No function-like symbol named "${name}" found in ${entryFileAbs}`
    );
  }

  return getTypeInfo(program, node);
}

/**
 * Infer the type using an options object
 *
 * @param options - Options for type inference
 * @returns The inferred type information
 */
export function inferTypeFromOptions(options: Options): InferredTypeResult {
  return inferType(options.file, options.name, options.project);
}
