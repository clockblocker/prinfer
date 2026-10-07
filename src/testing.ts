import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { contractError } from "./contract.js";
import { resolveTextColumn } from "./core/text-target.js";
import { PrinferError } from "./errors.js";
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

/**
 * A source file for the testing helpers. Pass `import.meta.url` for the test
 * file itself, or `new URL("../src/module.ts", import.meta.url)` for another
 * module. Relative path strings resolve against `process.cwd()`.
 */
export type TestingFile = string | URL;

interface CompletionsBackend {
	/** TypeScript 7 is the only completions backend and the default. */
	backend?: "typescript7";
}

export interface InferredCompletionsPosition
	extends CompletionOptions,
		CompletionsBackend {
	/** Positive, 1-based source line. */
	line: number;
	/** Positive, 1-based cursor column: the cursor sits before this character. */
	column: number;
}

export interface InferredCompletionsTextTarget
	extends CompletionOptions,
		CompletionsBackend {
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

export interface InferredTypeTextTarget extends HoverOptions {
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
 * Return the completion names TypeScript 7 offers at a cursor, sorted the way
 * the compiler returns them.
 *
 * @example
 * ```ts
 * await expect(
 *   inferredCompletions(import.meta.url, { line: 12, text: 'drink("' }),
 * ).resolves.toMatchInlineSnapshot();
 * ```
 */
export async function inferredCompletions(
	file: TestingFile,
	selector: InferredCompletionsSelector,
): Promise<string[]> {
	const request = createRequest("inferredCompletions", file, selector);
	if (request.backend !== "typescript7") {
		throw testingError(
			"INVALID_ARGUMENT",
			`inferredCompletions only supports backend "typescript7", got ${JSON.stringify(selector.backend)}.`,
			"Omit backend; completions always use TypeScript 7.",
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
 * Without a backend the result is synchronous (TypeScript 6); with
 * `backend: "typescript7"` it is a promise.
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
): string | Promise<string> {
	const result = inferredTypeInfoImpl("inferredType", file, selector);
	return result instanceof Promise
		? result.then((info) => info.signature)
		: result.signature;
}

/** Return the complete prinfer hover result when a test needs more than the type. */
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
): HoverResult | Promise<HoverResult> {
	return inferredTypeInfoImpl("inferredTypeInfo", file, selector);
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
): HoverResult | Promise<HoverResult> {
	const request = createRequest(helper, file, selector);
	if (request.backend === "typescript7") {
		return (async () => {
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

function createRequest(
	helper: string,
	input: TestingFile,
	selector: { backend?: string } | undefined,
): Request {
	if (typeof selector !== "object" || selector === null) {
		throw invalidSelector(helper);
	}
	const backend =
		selector.backend ??
		(helper === "inferredCompletions" ? "typescript7" : "typescript6");
	if (backend !== "typescript6" && backend !== "typescript7") {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} got unknown backend ${JSON.stringify(backend)}.`,
			'Use backend: "typescript7", or omit it for the synchronous TypeScript 6 default.',
		);
	}
	return { helper, input, file: sourcePath(input), backend };
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

function hoverOptions(selector: InferredTypeSelector): HoverOptions {
	const { project, include_docs, include_timing, full } = selector;
	return { project, include_docs, include_timing, full };
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
