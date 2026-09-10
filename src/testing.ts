import { fileURLToPath } from "node:url";
import { hover } from "./index.js";
import type { HoverByNameOptions, HoverOptions, HoverResult } from "./types.js";

export interface InferredTypeTarget extends HoverByNameOptions {
	/** The declaration name whose inferred type should be captured. */
	name: string;
}

export interface InferredTypePosition extends HoverOptions {
	/** Positive, 1-based source line. */
	line: number;
	/** Positive, 1-based source column. */
	column: number;
}

export type InferredTypeSelector = InferredTypeTarget | InferredTypePosition;

/**
 * Inspect a source expression for use with a test runner's ordinary snapshot
 * matcher. `import.meta.url` is accepted directly so tests stay relocatable.
 *
 * @example
 * ```ts
 * expect(
 *   inferredType(import.meta.url, { name: "result" }),
 * ).toMatchInlineSnapshot(`"Result<string>"`);
 * ```
 */
export function inferredType(
	file: string | URL,
	selector: InferredTypeSelector,
): string {
	return inferredTypeInfo(file, selector).signature;
}

/** Return the complete prinfer hover result when a test needs more than the type. */
export function inferredTypeInfo(
	file: string | URL,
	selector: InferredTypeSelector,
): HoverResult {
	const sourceFile = sourcePath(file);
	if ("name" in selector) {
		const { name, ...options } = selector;
		return hover(sourceFile, name, options);
	}

	const { line, column, ...options } = selector;
	return hover(sourceFile, line, column, options);
}

function sourcePath(file: string | URL): string {
	if (file instanceof URL) return fileURLToPath(file);
	if (file.startsWith("file:")) return fileURLToPath(file);
	return file;
}
