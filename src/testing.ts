import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { contractError } from "./contract.js";
import { resolveTextColumn } from "./core/text-target.js";
import { COST_NEEDS_TYPESCRIPT6, PrinferError } from "./errors.js";
import { hover } from "./index.js";
import {
	closeNativeApiSessions,
	nativeApiCompletionNames,
	nativeApiTypeInfo,
	nativeApiTypeInfoByName,
} from "./native-api.js";
import type { HoverCost, HoverOptions, HoverResult } from "./types.js";

/**
 * A source file for the testing helpers. Pass `import.meta.url` for the test
 * file itself, or `new URL("../src/module.ts", import.meta.url)` for another
 * module. Relative path strings resolve against `process.cwd()`.
 */
export type TestingFile = string | URL;

/** Options shared by every `inferredCompletions` selector. */
interface InferredCompletionsOptions {
	/** Optional path to tsconfig.json (default: the nearest one above the file). */
	project?: string;
	/**
	 * `inferredCompletions` always runs on TypeScript 7 and returns every
	 * completion name, with no prefix filter or limit. (The MCP `completions`
	 * tool and `prinfer complete` use TypeScript 6 and return 50 by default.)
	 */
	backend?: "typescript7";
	/**
	 * Throw on selector keys this helper doesn't know, with the closest valid
	 * key (default false: unknown keys are ignored). Tests usually run without
	 * type checking, so this is what catches `includeDocs` for
	 * `include_docs`.
	 */
	strict?: boolean;
}

export interface InferredCompletionsPosition
	extends InferredCompletionsOptions {
	/** Positive, 1-based source line. */
	line: number;
	/** Positive, 1-based cursor column: the cursor sits before this character. */
	column: number;
}

export interface InferredCompletionsTextTarget
	extends InferredCompletionsOptions {
	/** Positive, 1-based source line. */
	line: number;
	/** Exact text on the line that places the cursor. */
	text: string;
	/** 1-based match of `text` on the line (default 1). */
	occurrence?: number;
	/**
	 * Cursor placement relative to the match: `"end"` (default) puts it right
	 * after the text, so `text: "user."` completes members and `text: '"'`
	 * completes inside a string literal; `"start"` puts it before the text.
	 */
	cursor?: "start" | "end";
}

export type InferredCompletionsSelector =
	| InferredCompletionsPosition
	| InferredCompletionsTextTarget;

/** Options shared by every `inferredType` and `inferredTypeInfo` selector. */
export interface InferredTypeOptions
	extends Omit<HoverOptions, "full" | "backend"> {
	/**
	 * Untruncated types, on by default so a change anywhere in a type fails
	 * the snapshot. Pass `false` for editor-style truncation (`{ ...; }`).
	 */
	full?: boolean;
	/**
	 * `prinfer/testing` defaults to `"typescript6"` and returns synchronously.
	 * `"typescript7"` returns a promise. (The MCP server defaults to
	 * TypeScript 7; the CLI and library to TypeScript 6.)
	 */
	backend?: "typescript6" | "typescript7";
	/**
	 * Throw on selector keys this helper doesn't know, with the closest valid
	 * key (default false: unknown keys are ignored). Tests usually run without
	 * type checking, so this is what catches `includeDocs` for
	 * `include_docs`.
	 */
	strict?: boolean;
}

export interface InferredTypeTarget extends InferredTypeOptions {
	/** The declaration name whose inferred type should be captured. */
	name: string;
	/** 1-based line that picks among same-named declarations. */
	line?: number;
}

export interface InferredTypePosition extends InferredTypeOptions {
	/** Positive, 1-based source line. */
	line: number;
	/** Positive, 1-based source column. */
	column: number;
}

export interface InferredTypeTextTarget extends InferredTypeOptions {
	/** Positive, 1-based source line. */
	line: number;
	/** Exact text on the line; the type is read where the match starts. */
	text: string;
	/** 1-based match of `text` on the line (default 1). */
	occurrence?: number;
}

export type InferredTypeSelector =
	| InferredTypeTarget
	| InferredTypePosition
	| InferredTypeTextTarget;

type TypeScript7InferredTypeSelector = InferredTypeSelector & {
	backend: "typescript7";
};

type TypeScript6InferredTypeSelector = InferredTypeSelector & {
	backend?: "typescript6";
};

type Target =
	| { kind: "name"; name: string; line?: number }
	| { kind: "position"; line: number; column: number };

interface Request {
	helper: string;
	input: TestingFile;
	file: string;
	backend: "typescript6" | "typescript7";
}

/**
 * Return every completion name TypeScript 7 offers at a cursor, sorted the
 * way the compiler returns them, with no prefix filter or limit, so a
 * snapshot catches any added or removed entry.
 *
 * @example
 * ```ts
 * await expect(
 *   inferredCompletions(import.meta.url, { line: 12, text: 'drink("' }),
 * ).resolves.toMatchInlineSnapshot();
 * ```
 *
 * The result is always a promise: await it, or use `.resolves`. Snapshotting
 * the promise itself fails in Vitest and Jest with a message saying so.
 */
export function inferredCompletions(
	file: TestingFile,
	selector: InferredCompletionsSelector,
): Promise<string[]>;
export function inferredCompletions(
	file: TestingFile,
	selector: InferredCompletionsSelector,
	...extra: unknown[]
): Promise<string[]> {
	return InferredTypePromise.wrap(
		"inferredCompletions",
		inferredCompletionsImpl(file, selector, extra),
	);
}

async function inferredCompletionsImpl(
	file: TestingFile,
	selector: InferredCompletionsSelector,
	extra: unknown[],
): Promise<string[]> {
	const request = createRequest("inferredCompletions", file, selector, extra);
	if (request.backend !== "typescript7") {
		throw testingError(
			"INVALID_ARGUMENT",
			`inferredCompletions only supports backend "typescript7", got ${JSON.stringify(selector.backend)}.`,
			"Omit backend; inferredCompletions always uses TypeScript 7.",
		);
	}
	try {
		const target = resolveTarget(request, selector, "end");
		if (target.kind === "name") {
			throw invalidSelector(request.helper);
		}
		return await nativeApiCompletionNames(
			request.file,
			target.line,
			target.column,
			{ project: selector.project },
		);
	} catch (error) {
		throw explain(error, request, selector);
	}
}

/**
 * Inspect a source expression for use with a test runner's ordinary snapshot
 * matcher. `import.meta.url` is accepted directly so tests stay relocatable.
 * Types are untruncated unless `full: false`. Without a backend the result
 * is synchronous (TypeScript 6); with `backend: "typescript7"` it is a
 * promise: await it, or use `.resolves`. Snapshotting that promise itself
 * fails in Vitest and Jest with a message saying so; Bun prints it as
 * `Promise {}`, so check that a TypeScript 7 call is awaited.
 *
 * Every option goes in the selector, e.g.
 * `{ name: "result", backend: "typescript7" }`; a third argument throws.
 * Unknown selector keys are ignored unless `strict: true`.
 *
 * @example
 * ```ts
 * expect(
 *   inferredType(import.meta.url, { name: "result" }),
 * ).toMatchInlineSnapshot(`"Result<string>"`);
 * ```
 */
export function inferredType(
	file: TestingFile,
	selector: TypeScript7InferredTypeSelector,
): Promise<string>;
export function inferredType(
	file: TestingFile,
	selector: TypeScript6InferredTypeSelector,
): string;
export function inferredType(
	file: TestingFile,
	selector: InferredTypeSelector,
): string | Promise<string>;
export function inferredType(
	file: TestingFile,
	selector: InferredTypeSelector,
	...extra: unknown[]
): string | Promise<string> {
	const helper = "inferredType";
	const result = inferredTypeInfoImpl(helper, file, selector, extra);
	return result instanceof Promise
		? InferredTypePromise.wrap(
				helper,
				result.then((info) => info.signature),
			)
		: result.signature;
}

/**
 * Return the complete prinfer hover result when a test needs more than the
 * type. Takes the same selector as `inferredType`, and like it returns a
 * promise with `backend: "typescript7"`.
 */
export function inferredTypeInfo(
	file: TestingFile,
	selector: TypeScript7InferredTypeSelector,
): Promise<HoverResult>;
export function inferredTypeInfo(
	file: TestingFile,
	selector: TypeScript6InferredTypeSelector,
): HoverResult;
export function inferredTypeInfo(
	file: TestingFile,
	selector: InferredTypeSelector,
): HoverResult | Promise<HoverResult>;
export function inferredTypeInfo(
	file: TestingFile,
	selector: InferredTypeSelector,
	...extra: unknown[]
): HoverResult | Promise<HoverResult> {
	const helper = "inferredTypeInfo";
	const result = inferredTypeInfoImpl(helper, file, selector, extra);
	return result instanceof Promise
		? InferredTypePromise.wrap(helper, result)
		: result;
}

/**
 * Count the checker work behind a type, for a test that keeps it within a
 * budget. The counts come from a fresh TypeScript 6 checker (see
 * `HoverCost`), so they are the same on every run, in any test order, and
 * change only when the code, the compiler options, or the TypeScript
 * version does. Synchronous; TypeScript 6 only.
 *
 * @example
 * ```ts
 * expect(
 *   inferredTypeCost(import.meta.url, { name: "userSchema" }).instantiations,
 * ).toBeLessThan(2_000);
 * ```
 */
export function inferredTypeCost(
	file: TestingFile,
	selector: TypeScript6InferredTypeSelector,
): HoverCost {
	const request = createRequest("inferredTypeCost", file, selector, []);
	if (request.backend === "typescript7") {
		throw costNeedsTypeScript6(request.helper);
	}
	const result = inferredTypeInfoImpl(
		"inferredTypeCost",
		file,
		{
			...selector,
			include_cost: true,
		},
		[],
	) as HoverResult;
	return result.cost as HoverCost;
}

/**
 * Close the shared TypeScript 7 compiler sessions used by the testing helpers.
 * Optional: idle sessions do not keep the process alive. Call it to release
 * the compiler processes early, e.g. from `afterAll`.
 */
export function closeTestingSessions(): Promise<void> {
	return closeNativeApiSessions();
}

function inferredTypeInfoImpl(
	helper: string,
	file: TestingFile,
	selector: InferredTypeSelector,
	extra: unknown[],
): HoverResult | Promise<HoverResult> {
	const request = createRequest(helper, file, selector, extra);
	if (request.backend === "typescript7") {
		return (async () => {
			if (selector.include_cost) throw costNeedsTypeScript6(helper);
			try {
				const target = resolveTarget(request, selector, "start");
				const options = hoverOptions(selector);
				return target.kind === "name"
					? await nativeApiTypeInfoByName(request.file, target.name, {
							...options,
							line: target.line,
						})
					: await nativeApiTypeInfo(
							request.file,
							target.line,
							target.column,
							options,
						);
			} catch (error) {
				throw explain(error, request, selector);
			}
		})();
	}

	try {
		const target = resolveTarget(request, selector, "start");
		const options = hoverOptions(selector);
		return target.kind === "name"
			? hover(request.file, target.name, {
					...options,
					line: target.line,
				})
			: hover(request.file, target.line, target.column, options);
	} catch (error) {
		throw explain(error, request, selector);
	}
}

const COMPLETIONS_SELECTOR_KEYS = [
	"line",
	"column",
	"text",
	"occurrence",
	"cursor",
	"project",
	"backend",
	"strict",
];

/** `cursor` stays accepted: it has always worked with `text` at runtime. */
const TYPE_SELECTOR_KEYS = [
	"name",
	"line",
	"column",
	"text",
	"occurrence",
	"cursor",
	"project",
	"full",
	"include_docs",
	"include_timing",
	"backend",
	"strict",
];

/** A selector example that shows options sitting next to the target. */
function selectorExample(helper: string): string {
	return helper === "inferredCompletions"
		? `${helper}(file, { line: 3, text: "user.", project: "./tsconfig.json" })`
		: `${helper}(file, { name: "result", backend: "typescript7" })`;
}

function createRequest(
	helper: string,
	input: TestingFile,
	selector: { backend?: string; strict?: boolean } | undefined,
	extra: unknown[],
): Request {
	if (extra.length > 0) {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} takes two arguments (file, selector), got ${extra.length + 2}.`,
			`Move options into the selector object: ${selectorExample(helper)}.`,
		);
	}
	if (typeof selector !== "object" || selector === null) {
		throw invalidSelector(helper);
	}
	if (selector.strict === true) assertKnownKeys(helper, selector);
	const backend =
		selector.backend ??
		(helper === "inferredCompletions" ? "typescript7" : "typescript6");
	if (backend !== "typescript6" && backend !== "typescript7") {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} got unknown backend ${JSON.stringify(backend)}.`,
			helper === "inferredCompletions"
				? "Omit backend; inferredCompletions always uses TypeScript 7."
				: 'Use backend: "typescript7", or omit it for the synchronous TypeScript 6 default.',
		);
	}
	return { helper, input, file: sourcePath(input), backend };
}

/** With `strict: true`, a misspelled option throws instead of being ignored. */
function assertKnownKeys(helper: string, selector: object): void {
	const known =
		helper === "inferredCompletions"
			? COMPLETIONS_SELECTOR_KEYS
			: TYPE_SELECTOR_KEYS;
	const unknown = Object.keys(selector).find((key) => !known.includes(key));
	if (unknown === undefined) return;
	const closest = [...known].sort(
		(left, right) =>
			editDistance(left, unknown) - editDistance(right, unknown),
	)[0];
	const guess =
		closest && editDistance(closest, unknown) <= 3
			? `Did you mean ${closest}? `
			: "";
	throw testingError(
		"INVALID_ARGUMENT",
		`${helper} got unknown selector key ${JSON.stringify(unknown)}.`,
		`${guess}Selector keys: ${known.join(", ")}.`,
	);
}

function resolveTarget(
	request: Request,
	selector: object,
	cursor: "start" | "end",
): Target {
	const {
		name,
		line,
		column,
		text,
		occurrence,
		cursor: cursorOption,
	} = selector as {
		name?: unknown;
		line?: unknown;
		column?: unknown;
		text?: unknown;
		occurrence?: unknown;
		cursor?: unknown;
	};

	if (name !== undefined) {
		if (
			typeof name !== "string" ||
			column !== undefined ||
			text !== undefined
		) {
			throw invalidSelector(request.helper);
		}
		if (line !== undefined) assertPositive(request.helper, "line", line);
		return { kind: "name", name, line: line as number | undefined };
	}

	assertPositive(request.helper, "line", line);
	if ((column === undefined) === (text === undefined)) {
		throw invalidSelector(request.helper);
	}
	if (column !== undefined) {
		if (cursorOption !== undefined) throw invalidSelector(request.helper);
		assertPositive(request.helper, "column", column);
		return {
			kind: "position",
			line: line as number,
			column: column as number,
		};
	}
	if (typeof text !== "string" || text.length === 0) {
		throw testingError(
			"INVALID_ARGUMENT",
			`${request.helper} needs a non-empty text string.`,
			"Copy the token exactly from the source line.",
		);
	}
	if (occurrence !== undefined) {
		assertPositive(request.helper, "occurrence", occurrence);
	}
	const place = cursorOption ?? cursor;
	if (place !== "start" && place !== "end") {
		throw testingError(
			"INVALID_ARGUMENT",
			`${request.helper} got cursor ${JSON.stringify(place)}.`,
			'Use cursor: "end" (after the text, the default) or "start".',
		);
	}
	const start = resolveTextColumn(
		readSource(request.file),
		{
			line: line as number,
			text,
			occurrence: occurrence as number | undefined,
		},
		request.file,
	);
	return {
		kind: "position",
		line: line as number,
		column: place === "end" ? start + text.length : start,
	};
}

/** Snapshots default to untruncated types, so a change anywhere in a type fails. */
function hoverOptions(selector: InferredTypeSelector): HoverOptions {
	const {
		project,
		include_docs,
		include_cost,
		full = true,
		sort_unions,
	} = selector;
	return { project, include_docs, include_cost, full, sort_unions };
}

function assertPositive(helper: string, field: string, value: unknown): void {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return;
	}
	throw testingError(
		"INVALID_ARGUMENT",
		`${helper} needs ${field} as a positive 1-based integer, got ${JSON.stringify(value)}.`,
		SELECTOR_SHAPES,
	);
}

const SELECTOR_SHAPES =
	"Pass { name }, { line, text, occurrence? }, or { line, column }; lines and columns are 1-based.";

function invalidSelector(helper: string): PrinferError {
	const shapes =
		helper === "inferredCompletions"
			? 'Pass { line, text, occurrence?, cursor? } or { line, column }; text places the cursor after the match unless cursor: "start".'
			: SELECTOR_SHAPES;
	return testingError(
		"INVALID_ARGUMENT",
		`${helper} needs exactly one target.`,
		shapes,
	);
}

function costNeedsTypeScript6(helper: string): PrinferError {
	return testingError(
		"INVALID_ARGUMENT",
		`${helper} cannot count type costs on backend "typescript7". ${COST_NEEDS_TYPESCRIPT6}`,
		"Omit backend to count on TypeScript 6.",
	);
}

/** Test runners print only the message, so it carries the suggestion too. */
function testingError(
	code: PrinferError["code"],
	message: string,
	suggestion: string,
	cause?: Error,
): PrinferError {
	const error = new PrinferError(
		code,
		`${message}\n${suggestion}`,
		suggestion,
	);
	if (cause) error.cause = cause;
	return error;
}

/**
 * The promise a TypeScript 7 helper returns. Behaves like any promise; it
 * only changes how a forgotten `await` shows up. Vitest's and Jest's snapshot
 * serializers call `toJSON`, so `expect(promise).toMatchInlineSnapshot()`
 * fails with the fix instead of writing `Promise {}` into the test file.
 * Bun's serializer prints every promise as `Promise {}` and reads nothing
 * from it, so there the hint only reaches `util.inspect` output.
 */
class InferredTypePromise<T> extends Promise<T> {
	// `then` and friends return plain promises, which serialize normally.
	static override get [Symbol.species](): PromiseConstructor {
		return Promise;
	}

	static wrap<T>(helper: string, promise: Promise<T>): Promise<T> {
		const result = new InferredTypePromise<T>((resolve, reject) => {
			promise.then(resolve, reject);
		});
		result.#helper = helper;
		return result;
	}

	#helper = "inferredType";

	toJSON(): never {
		throw testingError(
			"INVALID_ARGUMENT",
			`${this.#helper} returned a promise that was not awaited, so the snapshot would record "Promise {}" instead of its value.`,
			unawaitedSuggestion(this.#helper),
		);
	}

	[Symbol.for("nodejs.util.inspect.custom")](): string {
		return `Promise { prinfer: ${unawaitedSuggestion(this.#helper)} }`;
	}
}

function unawaitedSuggestion(helper: string): string {
	const result =
		helper === "inferredCompletions"
			? helper
			: `${helper} with backend "typescript7"`;
	return `${result} returns a promise: write expect(await ${helper}(...)) or await expect(${helper}(...)).resolves.`;
}

/** Rewrite a lookup failure so the test output says what to change. */
function explain(error: unknown, request: Request, selector: object): Error {
	if (!(error instanceof Error)) return new Error(String(error));
	const existing =
		error instanceof PrinferError ? error.suggestion : undefined;
	if (existing && error.message.endsWith(existing)) return error;
	const { code } = contractError(error).error;
	let suggestion: string | undefined;

	if (
		code === "FILE_NOT_FOUND" &&
		error.message.startsWith("File not found")
	) {
		suggestion = fileSuggestion(request.input);
	} else if (code === "SYMBOL_NOT_FOUND") {
		const { name, line } = selector as { name?: string; line?: number };
		suggestion =
			existing ??
			(name !== undefined
				? nameSuggestion(request, name, line)
				: lineSuggestion(request.file, line));
	} else if (code === "TYPESCRIPT_ERROR" || code === "INTERNAL_ERROR") {
		suggestion =
			existing ??
			(request.backend === "typescript7"
				? "Check the tsconfig.json that includes the file, or omit backend to retry with TypeScript 6."
				: undefined);
	} else {
		suggestion = existing;
	}

	return suggestion
		? testingError(code, error.message, suggestion, error)
		: error;
}

function fileSuggestion(input: TestingFile): string {
	const isRelative =
		typeof input === "string" &&
		!input.startsWith("file:") &&
		!path.isAbsolute(input);
	if (isRelative) {
		return `Relative paths resolve against process.cwd() (${process.cwd()}), not the test file. To resolve against the test file, pass new URL(${JSON.stringify(input.startsWith(".") ? input : `./${input}`)}, import.meta.url).`;
	}
	return 'Check the path. new URL("./module.ts", import.meta.url) resolves against the test file.';
}

function nameSuggestion(
	request: Request,
	name: string,
	line: number | undefined,
): string {
	const declarations = declaredNames(request.file);
	const sameName = declarations
		.filter((declaration) => declaration.name === name)
		.map((declaration) => declaration.line);
	if (line !== undefined && sameName.length > 0) {
		return `"${name}" is declared on line ${[...new Set(sameName)].join(", ")}; fix line or omit it.`;
	}
	const names = [...new Set(declarations.map((entry) => entry.name))]
		.filter((candidate) => candidate !== name)
		.sort(
			(left, right) =>
				editDistance(left, name) - editDistance(right, name),
		)
		.slice(0, 5);
	const target =
		"or target the expression with { line, text } copied from its line.";
	return names.length > 0
		? `Declarations in ${path.basename(request.file)} closest to "${name}": ${names.join(", ")}. Pass one as name, ${target}`
		: `No declarations found in ${path.basename(request.file)}; ${target}`;
}

function lineSuggestion(file: string, line: number | undefined): string {
	const source = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const text = line ? source.split(/\r?\n/)[line - 1]?.trim() : undefined;
	const reads = text ? `Line ${line} reads: ${JSON.stringify(text)}. ` : "";
	return `${reads}Target a token with { line, text } copied from the line, or a declaration with { name }.`;
}

function declaredNames(file: string): { name: string; line: number }[] {
	if (!fs.existsSync(file)) return [];
	const sourceFile = ts.createSourceFile(
		file,
		fs.readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const names: { name: string; line: number }[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) ||
			ts.isFunctionDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isInterfaceDeclaration(node) ||
			ts.isTypeAliasDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isPropertyAssignment(node)
		) {
			const declarationName = node.name;
			if (declarationName && ts.isIdentifier(declarationName)) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					declarationName.getStart(sourceFile),
				);
				names.push({ name: declarationName.text, line: line + 1 });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return names;
}

function editDistance(left: string, right: string): number {
	const a = left.toLowerCase();
	const b = right.toLowerCase();
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

function readSource(file: string): string {
	if (!fs.existsSync(file)) {
		throw new PrinferError("FILE_NOT_FOUND", `File not found: ${file}`);
	}
	return fs.readFileSync(file, "utf8");
}

/** URLs and `file:` strings are converted; other strings resolve against process.cwd(). */
function sourcePath(file: TestingFile): string {
	if (file instanceof URL) return fileURLToPath(file);
	if (file.startsWith("file:")) return fileURLToPath(file);
	return path.resolve(process.cwd(), file);
}
