import { fileURLToPath } from "node:url";
import { hover } from "./index.js";
import {
	closeNativeApiSessions,
	nativeApiCompletionNames,
	nativeApiTypeInfo,
	nativeApiTypeInfoByName,
} from "./native-api.js";
import type {
	CompletionOptions,
	HoverByNameOptions,
	HoverOptions,
	HoverResult,
} from "./types.js";

export interface InferredCompletionsPosition extends CompletionOptions {
	/** Positive, 1-based source line. */
	line: number;
	/** Positive, 1-based source column. */
	column: number;
	/** Completion backend. TypeScript 7 is asynchronous through its native compiler API. */
	backend: "typescript7";
}

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

type TypeScript7InferredTypeSelector = InferredTypeSelector & {
	backend: "typescript7";
};

type TypeScript6InferredTypeSelector = InferredTypeSelector & {
	backend?: "typescript6";
};

/**
 * Return the completion names TypeScript offers at a source position.
 *
 * This testing helper is asynchronous because TypeScript 7 completions are
 * served by a shared native compiler session.
 */
export async function inferredCompletions(
	file: string | URL,
	position: InferredCompletionsPosition,
): Promise<string[]> {
	const { line, column, backend, ...options } = position;
	if (backend !== "typescript7") {
		throw new Error('inferredCompletions requires backend: "typescript7".');
	}
	return nativeApiCompletionNames(sourcePath(file), line, column, options);
}

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
	selector: TypeScript7InferredTypeSelector,
): Promise<string>;
export function inferredType(
	file: string | URL,
	selector: TypeScript6InferredTypeSelector,
): string;
export function inferredType(
	file: string | URL,
	selector: InferredTypeSelector,
): string | Promise<string>;
export function inferredType(
	file: string | URL,
	selector: InferredTypeSelector,
): string | Promise<string> {
	const result = inferredTypeInfoImpl(file, selector);
	return result instanceof Promise
		? result.then((info) => info.signature)
		: result.signature;
}

/** Return the complete prinfer hover result when a test needs more than the type. */
export function inferredTypeInfo(
	file: string | URL,
	selector: TypeScript7InferredTypeSelector,
): Promise<HoverResult>;
export function inferredTypeInfo(
	file: string | URL,
	selector: TypeScript6InferredTypeSelector,
): HoverResult;
export function inferredTypeInfo(
	file: string | URL,
	selector: InferredTypeSelector,
): HoverResult | Promise<HoverResult>;
export function inferredTypeInfo(
	file: string | URL,
	selector: InferredTypeSelector,
): HoverResult | Promise<HoverResult> {
	return inferredTypeInfoImpl(file, selector);
}

function inferredTypeInfoImpl(
	file: string | URL,
	selector: InferredTypeSelector,
): HoverResult | Promise<HoverResult> {
	const sourceFile = sourcePath(file);
	if ("name" in selector) {
		const { name, backend, ...options } = selector;
		return backend === "typescript7"
			? nativeApiTypeInfoByName(sourceFile, name, options)
			: hover(sourceFile, name, options);
	}

	const { line, column, backend, ...options } = selector;
	return backend === "typescript7"
		? nativeApiTypeInfo(sourceFile, line, column, options)
		: hover(sourceFile, line, column, options);
}

/** Close the shared TypeScript 7 compiler sessions used by testing helpers. */
export function closeTestingSessions(): Promise<void> {
	return closeNativeApiSessions();
}

function sourcePath(file: string | URL): string {
	if (file instanceof URL) return fileURLToPath(file);
	if (file.startsWith("file:")) return fileURLToPath(file);
	return file;
}
