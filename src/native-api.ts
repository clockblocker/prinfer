import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
	CallExpression,
	Node,
	SourceFile,
	TypeParameterDeclaration,
} from "@typescript/native/unstable/ast";
import type {
	Checker,
	Diagnostic as NativeDiagnostic,
	Project,
	Signature,
	Snapshot,
	Symbol as TsSymbol,
	Type,
	UnionType,
} from "@typescript/native/unstable/async";
import {
	compilerDirectory,
	compilerMode,
	resolveTypeScript7,
	withCompilerInfo,
} from "./compiler.js";
import { getNodeName, getSymbolKind } from "./core/hover.js";
import { lineStarts, positionAt, stripBom } from "./core/lines.js";
import { lookupName } from "./core/name-lookup.js";
import { findNodeAtPosition as findSyntaxNode } from "./core/node-find.js";
import { getNameNode } from "./core/node-match.js";
import {
	canonicalOptionalsAsync,
	type OptionalFacts,
	type OptionalStep,
	singleLine,
} from "./core/signature-text.js";
import { ts } from "./core/ts-runtime.js";
import { sortResultUnions } from "./core/union-order.js";
import { PrinferError } from "./errors.js";
import {
	API,
	activeNativeCompiler,
	isClassDeclaration,
	isExpressionWithTypeArguments,
	isFunctionDeclaration,
	isHeritageClause,
	isIdentifier,
	isImportTypeNode,
	isInterfaceDeclaration,
	isMethodDeclaration,
	isMethodSignatureDeclaration,
	isParameterDeclaration,
	isPropertyAccessExpression,
	isPropertyAssignment,
	isPropertyDeclaration,
	isPropertySignatureDeclaration,
	isQualifiedName,
	isTypeAliasDeclaration,
	isTypeNode,
	isTypeQueryNode,
	isVariableDeclaration,
	DiagnosticCategory as NativeDiagnosticCategory,
	NodeBuilderFlags,
	NodeFlags,
	onNativeCompilerSwitch,
	SignatureKind,
	SymbolFlags,
	SyntaxKind,
	TypeFlags,
	withNativeCompiler,
} from "./native-runtime.js";
import type {
	CompletionOptions,
	DiagnosticCategory as DiagnosticCategoryName,
	FileDiagnostic,
	HoverOptions,
	HoverResult,
} from "./types.js";

const sessions = new Map<string, NativeApiSession>();

/**
 * Where the compiler child process of a TypeScript 7 API instance stands.
 * `not-spawned`: the client has the expected shape but no request has
 * started the process yet. `missing`: the client no longer has the shape
 * prinfer reads, so the process cannot be found.
 */
export type CompilerProcessLookup =
	| { status: "found"; child: ChildProcess }
	| { status: "not-spawned" }
	| { status: "missing"; reason: string };

/**
 * Find the compiler child process inside a TypeScript 7 API instance.
 *
 * `@typescript/native` 7.0 has no public handle to the process: `API` and
 * its `Client` expose no accessor, no `ref`/`unref` and no option to spawn
 * it detached, and `API.close()` is the only lifecycle call. The client
 * keeps the process in the private `API.client.process` field, assigned
 * when the first request spawns it. The canary test in
 * src/__tests__/native-api-process.test.ts fails when that field moves.
 */
export function locateCompilerProcess(api: API): CompilerProcessLookup {
	const client: unknown = Reflect.get(api, "client");
	if (typeof client !== "object" || client === null) {
		return { status: "missing", reason: "API.client is gone" };
	}
	if (!("process" in client)) {
		return { status: "missing", reason: "API.client.process is gone" };
	}
	const child = client.process;
	if (child === undefined) return { status: "not-spawned" };
	if (
		typeof child !== "object" ||
		child === null ||
		typeof (child as ChildProcess).ref !== "function" ||
		typeof (child as ChildProcess).unref !== "function"
	) {
		return {
			status: "missing",
			reason: "API.client.process is not a child process",
		};
	}
	return { status: "found", child: child as ChildProcess };
}

/** Indirection so a test can simulate a release without the private field. */
export const compilerProcessLocator = { locate: locateCompilerProcess };

/**
 * How long a session may sit idle before the fallback closes it. Short, so
 * a test process exits soon after its last call; a later call restarts the
 * compiler.
 */
export const IDLE_CLOSE_MS = 1_000;

let warnedFallback = false;

/** The active TypeScript 7 package, for messages: `typescript 7.0.2`. */
function compilerName(): string {
	const info = activeNativeCompiler()?.info;
	return info ? `${info.name} ${info.version}` : "@typescript/native";
}

function warnFallback(reason: string): void {
	if (warnedFallback) return;
	warnedFallback = true;
	process.stderr.write(
		[
			`prinfer: cannot find the TypeScript 7 compiler process in ${compilerName()} (${reason}), so idle sessions cannot be unref'd.`,
			`prinfer now closes a session after ${IDLE_CLOSE_MS}ms idle so the process can still exit; the next call restarts the compiler.`,
			'Fix: call `await closeTestingSessions()` from "prinfer/testing" in afterAll to shut sessions down yourself, and report this at https://github.com/clockblocker/prinfer/issues.',
			"",
		].join("\n"),
	);
}

/**
 * How long closing or killing a session waits for its compiler to exit.
 * Below the abort timeout in native-sync.ts, so a killed compiler is reaped
 * before the worker answers.
 */
const EXIT_WAIT_MS = 750;

/**
 * Resolve once the process has exited, or after `ms`. Its exit event comes
 * after the runtime reaped it. The testing worker thread that spawned it is
 * terminated right after teardown, and a process that exits after that is
 * never reaped: it stays a zombie until the test process ends.
 */
function waitForExit(child: ChildProcess, ms: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			child.off("exit", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		child.once("exit", done);
	});
}

/** Ref or unref the compiler process and the pipes prinfer talks over. */
function setChildReferenced(child: ChildProcess, active: boolean): void {
	const method = active ? "ref" : "unref";
	child[method]();
	for (const stream of [child.stdin, child.stdout]) {
		(stream as { ref?(): void; unref?(): void } | null)?.[method]?.();
	}
}

class NativeApiSession {
	private readonly api: API;
	private readonly key: string;
	private readonly projectFile: string | undefined;
	private snapshot: Snapshot | undefined;
	private readonly documents = new Map<string, string>();
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;
	/** A request has reached the compiler, so its process has been spawned. */
	private spawned = false;
	/** The process cannot be unref'd, so idle sessions are closed instead. */
	private fallback = false;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** The compiler process, once watched for exit. */
	private child: ChildProcess | undefined;
	/** Set once the compiler process has exited; the session is unusable. */
	private exitError: PrinferError | undefined;
	/** Rejects when the compiler process exits, failing in-flight requests. */
	private readonly exited: Promise<never>;
	private rejectExited: (error: PrinferError) => void = () => undefined;

	constructor(key: string, root: string, projectFile?: string) {
		this.api = new API({ cwd: root });
		this.key = key;
		this.projectFile = projectFile;
		this.exited = new Promise<never>((_, reject) => {
			this.rejectExited = reject;
		});
		this.exited.catch(() => undefined);
		const lookup = compilerProcessLocator.locate(this.api);
		if (lookup.status === "missing") this.useFallback(lookup.reason);
	}

	/** The compiler process has exited, so no request can succeed. */
	get dead(): boolean {
		const child = this.child;
		// Bun can destroy stdin before the exit event arrives; a request
		// written then fails with an unhandled rejection in vscode-jsonrpc.
		if (!this.exitError && child && (child.stdin?.destroyed ?? false)) {
			this.handleExit(child.exitCode, child.signalCode);
		}
		return this.exitError !== undefined;
	}

	run<T>(
		file: string,
		operation: (project: Project, sourceFile: SourceFile) => Promise<T>,
	): Promise<T> {
		this.pending += 1;
		this.cancelIdleClose();
		this.setReferenced(true);
		this.watchExit();
		// A request to an exited process never settles, so race the exit.
		const result = this.tail.then(() =>
			this.dead
				? Promise.reject(this.exitError)
				: Promise.race([this.runNow(file, operation), this.exited]),
		);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		void this.tail.then(() => {
			this.pending -= 1;
			if (this.pending === 0) this.idle();
		});
		return result;
	}

	async close(): Promise<void> {
		this.cancelIdleClose();
		await this.tail;
		const snapshot = this.snapshot;
		this.snapshot = undefined;
		this.documents.clear();
		// The connection to an exited process is closed: nothing to release.
		if (this.dead) {
			// Bun can close stdin before the process is reaped.
			if (this.child) await waitForExit(this.child, EXIT_WAIT_MS);
			return;
		}
		// Disposing the snapshot is a request to the idle, unref'd process.
		// On Node nothing else may hold the event loop while it is answered
		// (`await closeTestingSessions()` at top level), so the loop drains
		// and the await never settles: hold the process for the teardown.
		// `api.close()` clears the client's process field, so look it up now.
		const lookup = this.fallback
			? undefined
			: compilerProcessLocator.locate(this.api);
		const child = lookup?.status === "found" ? lookup.child : undefined;
		if (child) setChildReferenced(child, true);
		try {
			try {
				// A process that got SIGTERM may exit without answering.
				await Promise.race([
					(async () => {
						await snapshot?.dispose();
						await this.api.close();
					})(),
					this.exited,
				]);
			} catch {
				// It answers with errors until it exits; stop it.
				this.child?.kill();
			}
			// Its stdin is closed and it exits on its own: wait for that, so
			// it is reaped before the testing worker thread is terminated.
			const exiting = child ?? this.child;
			if (exiting) await waitForExit(exiting, EXIT_WAIT_MS);
		} finally {
			if (child) setChildReferenced(child, false);
		}
	}

	/**
	 * Stop routing calls here after a compiler failure. The process is
	 * killed rather than closed: requests to a process that is exiting can
	 * fail with unhandled rejections inside vscode-jsonrpc. A compiler that
	 * stopped answering gets SIGKILL: a stopped or wedged process may never
	 * act on SIGTERM. Settles once the process has exited (and so has been
	 * reaped), or after EXIT_WAIT_MS.
	 */
	retire(signal?: NodeJS.Signals): Promise<void> {
		if (sessions.get(this.key) === this) sessions.delete(this.key);
		const lookup = compilerProcessLocator.locate(this.api);
		const child =
			this.child ??
			(lookup.status === "found" ? lookup.child : undefined);
		if (!child) return this.close().catch(() => undefined);
		child.kill(signal);
		return waitForExit(child, EXIT_WAIT_MS);
	}

	/**
	 * Watch the compiler process so its exit retires the session: `bun test`
	 * kills every live child process when a test times out, and a crash
	 * ends it too. The first request spawns the process a few ticks after
	 * it starts, so poll until it appears.
	 */
	private watchExit(): void {
		if (this.child || this.fallback) return;
		const lookup = compilerProcessLocator.locate(this.api);
		if (lookup.status === "not-spawned") {
			if (this.pending === 0) return;
			const timer = setTimeout(() => this.watchExit(), 10);
			timer.unref?.();
			return;
		}
		if (lookup.status !== "found") return;
		const { child } = lookup;
		this.child = child;
		if (child.exitCode !== null || child.signalCode !== null) {
			this.handleExit(child.exitCode, child.signalCode);
		} else {
			child.once("exit", (code, signal) => this.handleExit(code, signal));
		}
	}

	private handleExit(
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		if (this.exitError) return;
		const how = signal ?? (code === null ? "input closed" : `code ${code}`);
		this.exitError = new PrinferError(
			"TYPESCRIPT_ERROR",
			`The TypeScript 7 compiler process exited (${how}).`,
			"bun test kills child processes when a test times out; the next call restarts the compiler. Raise the test timeout if a cold TypeScript 7 project load exceeds it.",
		);
		if (sessions.get(this.key) === this) sessions.delete(this.key);
		this.rejectExited(this.exitError);
	}

	/**
	 * Hold the event loop open only while a request is in flight, so a test
	 * process exits without teardown. The idle compiler process sees its
	 * stdin close when the parent exits and shuts down on its own.
	 */
	private setReferenced(active: boolean): void {
		if (this.fallback) return;
		const lookup = compilerProcessLocator.locate(this.api);
		if (lookup.status !== "found") return;
		setChildReferenced(lookup.child, active);
	}

	/**
	 * Release the event loop once no request is in flight: unref the
	 * process or, when it cannot be found, close the session after
	 * IDLE_CLOSE_MS. `beforeExit` would not work as the fallback: it only
	 * fires once the loop is empty, and the referenced process keeps it busy.
	 */
	private idle(): void {
		if (!this.fallback) {
			const lookup = compilerProcessLocator.locate(this.api);
			if (lookup.status === "found") {
				this.setReferenced(false);
				return;
			}
			// No request reached the compiler, so nothing holds the loop.
			if (lookup.status === "not-spawned" && !this.spawned) return;
			this.useFallback(
				lookup.status === "missing"
					? lookup.reason
					: "API.client.process stays empty after a request",
			);
		}
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.pending > 0) return;
			if (sessions.get(this.key) === this) sessions.delete(this.key);
			void this.close().catch(() => undefined);
		}, IDLE_CLOSE_MS);
		// The timer alone must not keep the process alive.
		this.idleTimer.unref?.();
	}

	private useFallback(reason: string): void {
		this.fallback = true;
		warnFallback(reason);
	}

	private cancelIdleClose(): void {
		if (this.idleTimer === undefined) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private async runNow<T>(
		file: string,
		operation: (project: Project, sourceFile: SourceFile) => Promise<T>,
	): Promise<T> {
		const text = fs.readFileSync(file, "utf8");
		const previousText = this.documents.get(file);
		if (!this.snapshot || previousText !== text) {
			const previousSnapshot = this.snapshot;
			this.spawned = true;
			this.snapshot = await this.api.updateSnapshot(
				previousText === undefined
					? {
							openFiles: [file],
							...(!previousSnapshot && this.projectFile
								? { openProjects: [this.projectFile] }
								: {}),
						}
					: { fileChanges: { changed: [file] } },
			);
			this.documents.set(file, text);
			await previousSnapshot?.dispose();
		}

		const snapshot = this.snapshot;
		const project = this.projectFile
			? snapshot.getProject(this.projectFile)
			: await snapshot.getDefaultProjectForFile(file);
		if (!project) {
			throw new PrinferError(
				"TYPESCRIPT_ERROR",
				`Could not load source file into a TypeScript 7 project: ${file}`,
				"Check that the nearest tsconfig.json includes the file, or pass project.",
			);
		}
		const sourceFile = await project.program.getSourceFile(file);
		if (!sourceFile) {
			throw new PrinferError(
				"TYPESCRIPT_ERROR",
				`Could not load source file into the TypeScript 7 program: ${file}`,
				this.projectFile
					? `Check that ${this.projectFile} includes the file.`
					: "Check that the nearest tsconfig.json includes the file, or pass project.",
			);
		}
		return operation(project, sourceFile);
	}
}

// Sessions hold objects of the compiler that created them.
onNativeCompilerSwitch(() => closeNativeApiSessions());

/**
 * Run a call on the TypeScript 7 compiler its options select (see
 * `CompilerMode`), loading it on first use, and mark the result with it.
 */
async function onCompiler<T extends object>(
	file: string,
	options: Pick<HoverOptions, "project" | "compiler"> | undefined,
	run: () => Promise<T>,
): Promise<T> {
	const compiler = await resolveTypeScript7(
		compilerMode(options?.compiler),
		compilerDirectory(file, options?.project),
	);
	return withCompilerInfo(
		await withNativeCompiler(compiler, run),
		compiler.info,
	);
}

export async function nativeApiCompletionNames(
	file: string,
	line: number,
	column: number,
	options?: CompletionOptions,
): Promise<string[]> {
	const entryFileAbs = resolveFile(file);
	const text = fs.readFileSync(entryFileAbs, "utf8");
	const position = sourcePosition(entryFileAbs, text, line, column);
	return onCompiler(entryFileAbs, options, () =>
		runInSession(entryFileAbs, options?.project, async ({ checker }) => {
			const completions = await checker.getCompletionsAtPosition(
				entryFileAbs,
				position,
			);
			return completions?.entries.map((entry) => entry.name) ?? [];
		}),
	);
}

export async function nativeApiTypeInfo(
	file: string,
	line: number,
	column: number,
	options?: HoverOptions,
): Promise<HoverResult> {
	const entryFileAbs = resolveFile(file);
	return onCompiler(entryFileAbs, options, () =>
		typeInfoInSession(entryFileAbs, line, column, options),
	);
}

function typeInfoInSession(
	entryFileAbs: string,
	line: number,
	column: number,
	options?: HoverOptions,
): Promise<HoverResult> {
	const text = fs.readFileSync(entryFileAbs, "utf8");
	const position = sourcePosition(entryFileAbs, text, line, column);
	return runInSession(entryFileAbs, options?.project, (project, sourceFile) =>
		nativeTypeInfoAt(
			project,
			sourceFile,
			{ file: entryFileAbs, text, line, column, position },
			options,
		),
	);
}

/** A validated cursor in a file a TypeScript 7 project has loaded. */
export interface NativeCursor {
	file: string;
	/** The file's text as the project sees it */
	text: string;
	/** 1-based line */
	line: number;
	/** 1-based column */
	column: number;
	/** UTF-16 offset of line and column in `text` */
	position: number;
}

/**
 * Type information at a cursor, read from a loaded TypeScript 7 project with
 * the same rules as the TypeScript 6 backend. Shared by the testing helpers
 * and by language-server requests for an explicit project.
 */
export async function nativeTypeInfoAt(
	project: Project,
	sourceFile: SourceFile,
	cursor: NativeCursor,
	options?: HoverOptions,
): Promise<HoverResult> {
	const { file, text, line, column, position } = cursor;
	const type = await hoveredType(project, sourceFile, file, position);
	if (!type) {
		throw new PrinferError(
			"SYMBOL_NOT_FOUND",
			`No symbol found at ${file}:${line}:${column}`,
		);
	}
	const result = await typeInfo(
		project,
		type,
		{ file, sourceFile, syntax: parseSyntax(file, text), position },
		{ ...options, line, column },
	);
	if (options?.sort_unions) sortResultUnions(result);
	return result;
}

/**
 * One file's diagnostics from a loaded TypeScript 7 project: the syntactic,
 * semantic and (when the project emits declarations) declaration
 * diagnostics the language server reports, plus suggestions on request.
 * `text` is the file as the project sees it, for line and column numbers.
 */
export async function nativeFileDiagnostics(
	project: Project,
	file: string,
	text: string,
	includeSuggestions: boolean,
): Promise<FileDiagnostic[]> {
	const { program, compilerOptions } = project;
	const groups = await Promise.all([
		program.getSyntacticDiagnostics(file),
		program.getSemanticDiagnostics(file),
		includeSuggestions ? program.getSuggestionDiagnostics(file) : [],
		compilerOptions.declaration || compilerOptions.composite
			? program.getDeclarationDiagnostics(file)
			: [],
	]);
	const starts = lineStarts(text);
	return groups.flat().map((diagnostic) => {
		const start = positionAt(starts, diagnostic.pos);
		const end = positionAt(starts, diagnostic.end);
		return {
			line: start.line + 1,
			column: start.character + 1,
			endLine: end.line + 1,
			endColumn: end.character + 1,
			code: diagnostic.code,
			category: diagnosticCategory(diagnostic.category),
			message: flattenMessage(diagnostic),
			source: "ts",
		};
	});
}

/** A message and its chain, nested as ts.flattenDiagnosticMessageText does. */
function flattenMessage(diagnostic: NativeDiagnostic, depth = 0): string {
	const indent = depth > 0 ? `\n${"  ".repeat(depth)}` : "";
	return `${indent}${diagnostic.text}${(diagnostic.messageChain ?? [])
		.map((next) => flattenMessage(next, depth + 1))
		.join("")}`;
}

function diagnosticCategory(
	category: NativeDiagnosticCategory,
): DiagnosticCategoryName {
	switch (category) {
		case NativeDiagnosticCategory.Error:
			return "error";
		case NativeDiagnosticCategory.Warning:
			return "warning";
		case NativeDiagnosticCategory.Suggestion:
			return "suggestion";
		default:
			return "message";
	}
}

/**
 * Type information for a symbol by name. The symbol is chosen exactly as
 * the other backends choose it (see findNodeByNameAndLine), then read at its
 * name token.
 */
export async function nativeApiTypeInfoByName(
	file: string,
	name: string,
	options?: HoverOptions & { line?: number },
): Promise<HoverResult> {
	const entryFileAbs = resolveFile(file);
	const syntax = parseSyntax(
		entryFileAbs,
		fs.readFileSync(entryFileAbs, "utf8"),
	);
	const { node, alternatives } = lookupName(
		syntax,
		name,
		options?.line,
		entryFileAbs,
	);
	const { line, character } = syntax.getLineAndCharacterOfPosition(
		getNameNode(node).getStart(syntax),
	);
	return onCompiler(entryFileAbs, options, async () => {
		const result = await typeInfoInSession(
			entryFileAbs,
			line + 1,
			character + 1,
			options,
		);
		if (alternatives) result.alternatives = alternatives;
		return result;
	});
}

export async function closeNativeApiSessions(): Promise<void> {
	const active = [...sessions.values()];
	sessions.clear();
	await Promise.all(active.map((session) => session.close()));
}

/**
 * Kill every compiler process without waiting on its requests, for a
 * compiler that stopped answering. The next call starts a new session.
 * Settles once the killed processes have exited, so they are reaped before
 * the testing worker thread is terminated.
 */
export async function killNativeApiSessions(): Promise<void> {
	const active = [...sessions.values()];
	sessions.clear();
	await Promise.all(active.map((session) => session.retire("SIGKILL")));
}

/**
 * A signature printed the way TypeScript 6's signatureToString prints it,
 * on one line: `<T>(value: T): T`.
 */
export async function nativeSignatureText(
	project: Project,
	signature: Signature,
	flags: number,
): Promise<string> {
	const declaration = await project.checker.signatureToSignatureDeclaration(
		signature,
		SyntaxKind.CallSignature,
		undefined,
		flags,
	);
	if (!declaration) return "";
	const printed = await project.emitter.printNode(declaration);
	return canonicalOptionalsAsync(
		singleLine(printed).replace(/;$/, ""),
		"signature",
		(path) => nativeOptionalFacts(project.checker, { signature }, path),
	);
}

/** typeToString, in canonical form (see core/signature-text.ts). */
export async function nativeTypeText(
	project: Project,
	type: Type,
	flags: number,
): Promise<string> {
	return canonicalOptionalsAsync(
		await project.checker.typeToString(type, undefined, flags),
		"type",
		(path) => nativeOptionalFacts(project.checker, { type }, path),
	);
}

type Walked = { signature: Signature } | { type: Type } | { symbol: TsSymbol };

/**
 * Follow a path from a printed signature or type to an optional slot; the
 * TypeScript 7 counterpart of optionalFacts in core/hover.ts.
 */
async function nativeOptionalFacts(
	checker: Checker,
	root: Walked,
	path: readonly OptionalStep[],
): Promise<OptionalFacts | undefined> {
	let current = root;
	for (const step of path) {
		if ("param" in step || "returns" in step) {
			if (!("signature" in current)) return undefined;
			if ("returns" in step) {
				const type = await checker.getReturnTypeOfSignature(
					current.signature,
				);
				if (!type) return undefined;
				current = { type };
				continue;
			}
			const symbol = (await current.signature.getParameters())[
				step.param
			];
			if (!symbol) return undefined;
			current = { symbol };
			continue;
		}
		if ("signature" in current) return undefined;
		const own =
			"symbol" in current
				? await checker.getTypeOfSymbol(current.symbol)
				: current.type;
		const type = own ? await checker.getNonNullableType(own) : undefined;
		if (!type) return undefined;
		if ("property" in step) {
			const symbol = await checker.getPropertyOfType(type, step.property);
			if (!symbol) return undefined;
			current = { symbol };
		} else if ("signature" in step || "construct" in step) {
			const [kind, index] =
				"signature" in step
					? [SignatureKind.Call, step.signature]
					: [SignatureKind.Construct, step.construct];
			const signature = (await checker.getSignaturesOfType(type, kind))[
				index
			];
			if (!signature) return undefined;
			current = { signature };
		} else {
			const next = await nativeInnerType(checker, type, step);
			if (!next) return undefined;
			current = { type: next };
		}
	}
	if (!("symbol" in current)) return undefined;
	const declaration = await current.symbol.valueDeclaration?.resolve();
	const annotation = !declaration
		? undefined
		: isParameterDeclaration(declaration)
			? declaration.questionToken && declaration.type
			: (isPropertySignatureDeclaration(declaration) ||
						isPropertyDeclaration(declaration)) &&
					declaration.postfixToken?.kind === SyntaxKind.QuestionToken
				? declaration.type
				: undefined;
	if (!annotation) {
		return {
			declaredOptional: false,
			annotationIncludesUndefined: false,
			addsOnlyUndefined: false,
		};
	}
	const members = async (type: Type | undefined) =>
		!type
			? []
			: type.flags & TypeFlags.Union
				? await (type as UnionType).getTypes()
				: [type];
	const [annotated, own] = await Promise.all([
		checker.getTypeFromTypeNode(annotation).then(members),
		checker.getTypeOfSymbol(current.symbol).then(members),
	]);
	const added = own.filter((member) => !(member.flags & TypeFlags.Undefined));
	const annotatedIds = new Set(annotated.map((member) => member.id));
	return {
		declaredOptional: annotated.length > 0,
		annotationIncludesUndefined: annotated.some(
			(member) =>
				member.flags &
				(TypeFlags.Undefined | TypeFlags.Any | TypeFlags.Unknown),
		),
		addsOnlyUndefined:
			added.length === annotated.length &&
			added.every((member) => annotatedIds.has(member.id)),
	};
}

/**
 * The type an index, element, type argument, or member step leads to; the
 * TypeScript 7 counterpart of innerType in core/hover.ts.
 */
async function nativeInnerType(
	checker: Checker,
	type: Type,
	step: OptionalStep,
): Promise<Type | undefined> {
	if ("index" in step) {
		return (await checker.getIndexInfosOfType(type))[step.index]?.valueType;
	}
	if ("member" in step) {
		if (!(type.flags & (TypeFlags.Union | TypeFlags.Intersection))) {
			return undefined;
		}
		const types = (await (type as UnionType).getTypes()) ?? [];
		const booleans = types.filter(
			(member) => member.flags & TypeFlags.BooleanLiteral,
		);
		// Printed members: `true | false` once, as `boolean`.
		const members =
			type.flags & TypeFlags.Union && booleans.length >= 2
				? types.filter((member) => member !== booleans[1])
				: types;
		return members.length === step.members
			? members[step.member]
			: undefined;
	}
	const alias =
		"typeArgument" in step ? await type.getAliasSymbol() : undefined;
	const typeArguments =
		alias && "of" in step && alias.name === step.of
			? await type.getAliasTypeArguments()
			: type.isTypeReference()
				? await checker.getTypeArguments(type)
				: [];
	if ("element" in step) return typeArguments[step.element];
	if ("typeArgument" in step) return typeArguments[step.typeArgument];
	return undefined;
}

/**
 * The type at a position as quick info reports it: an optional property
 * has the type quick info shows (with exactOptionalPropertyTypes,
 * `digits?: number` is a number when present), anything else its type at
 * the position.
 */
export async function hoveredType(
	project: Project,
	sourceFile: SourceFile,
	file: string,
	position: number,
): Promise<Type | undefined> {
	const { checker } = project;
	const [type, symbol] = await Promise.all([
		checker.getTypeAtPosition(file, position),
		checker.getSymbolAtPosition(file, position),
	]);
	const token = tokenAtPosition(sourceFile, position);
	// TypeScript 7 has no type at a name in a type position (`Holder` in
	// `let h: Holder<1>`) and reports the error type, `any`. TypeScript 6
	// shows the declared type of the name's symbol, `Holder<T>`.
	if (symbol && token && isTypeReferenceName(token)) {
		return checker.getDeclaredTypeOfSymbol(symbol);
	}
	if (
		!symbol ||
		!(symbol.flags & SymbolFlags.Property) ||
		!(symbol.flags & SymbolFlags.Optional)
	) {
		return type;
	}
	return token ? checker.getTypeOfSymbolAtLocation(symbol, token) : type;
}

/**
 * Whether `name` names a type in a type position: the rule of TypeScript
 * 6's isPartOfTypeNode for an identifier, under which getTypeAtLocation
 * gives the declared type of the name's symbol. The right side of a
 * qualified name (`ns.T`) or of a property access in a heritage clause
 * (`implements ns.I`) counts; its left side, a namespace, does not.
 */
function isTypeReferenceName(name: Node): boolean {
	if (!isIdentifier(name)) return false;
	let node: Node = name;
	const { parent } = node;
	if (
		(isQualifiedName(parent) && parent.right === node) ||
		(isPropertyAccessExpression(parent) && parent.name === node)
	) {
		node = parent;
	}
	const container = node.parent;
	if (!container || isTypeQueryNode(container)) return false;
	if (isImportTypeNode(container)) return !container.isTypeOf;
	// `interface A extends B<1>` and `class A implements B<1>` name types;
	// `class A extends B<1>` names a value, the base class. (TypeScript 7
	// counts ExpressionWithTypeArguments as a type node; TypeScript 6 does
	// not, so it is decided first.)
	if (isExpressionWithTypeArguments(container)) {
		const clause = container.parent;
		return (
			isHeritageClause(clause) &&
			!(
				clause.token === SyntaxKind.ExtendsKeyword &&
				isClassLike(clause.parent)
			)
		);
	}
	return isTypeNode(container);
}

function isClassLike(node: Node | undefined): boolean {
	return (
		node !== undefined &&
		(node.kind === SyntaxKind.ClassDeclaration ||
			node.kind === SyntaxKind.ClassExpression)
	);
}

/**
 * Members of a union type as TypeScript displays them; the TypeScript 7
 * counterpart of countUnionMembers in core/hover.ts.
 */
export async function countNativeUnionMembers(
	checker: Checker,
	type: Type,
): Promise<number | undefined> {
	if (!(type.flags & TypeFlags.Union) || type.flags & TypeFlags.Boolean)
		return undefined;
	const members = await (type as UnionType).getTypes();
	let count = members.length;
	const booleans = members.filter(
		(member) => member.flags & TypeFlags.BooleanLiteral,
	);
	if (booleans.length >= 2) count -= 1;
	const enumLiterals = members.filter(
		(member) => member.flags & TypeFlags.EnumLiteral,
	);
	if (enumLiterals.length < 2) return count > 1 ? count : undefined;
	const byEnum = new Map<number, { symbol: TsSymbol; present: number }>();
	for (const member of enumLiterals) {
		const parent = await (await member.getSymbol())?.getParent();
		if (!parent) continue;
		const entry = byEnum.get(parent.id) ?? { symbol: parent, present: 0 };
		entry.present += 1;
		byEnum.set(parent.id, entry);
	}
	for (const { symbol, present } of byEnum.values()) {
		const enumType = await checker.getDeclaredTypeOfSymbol(symbol);
		const total =
			enumType.flags & TypeFlags.Union
				? (await (enumType as UnionType).getTypes()).length
				: 1;
		if (present > 1 && present === total) count -= present - 1;
	}
	return count > 1 ? count : undefined;
}

interface Location {
	file: string;
	/** The TypeScript 7 source file */
	sourceFile: SourceFile;
	/** The same file parsed by TypeScript 6, for the shared syntax rules */
	syntax: ts.SourceFile;
	/** UTF-16 offset of the hovered position */
	position: number;
}

/**
 * Build a hover result with the same rules as the TypeScript 6 backend
 * (core/hover.ts): the node and kind come from the shared syntax lookup,
 * the types from the TypeScript 7 checker. See HoverResult.signature.
 */
async function typeInfo(
	project: Project,
	type: Type,
	location: Location,
	options: HoverOptions & { line: number; column: number },
): Promise<HoverResult> {
	const { checker } = project;
	const flags = options.full
		? NodeBuilderFlags.NoTruncation
		: NodeBuilderFlags.None;
	const typeText = (shown: Type, extra = 0) =>
		nativeTypeText(project, shown, flags | extra);
	const syntaxNode = findSyntaxNodeAt(location.syntax, options);
	const node = findNodeAtPosition(location.sourceFile, location.position);
	let kind = syntaxNode ? getSymbolKind(syntaxNode) : "symbol";
	if (
		syntaxNode &&
		(kind === "identifier" || ts.isPropertyAccessExpression(syntaxNode))
	) {
		kind = await referenceKind(project, location, kind);
	}
	if (kind === "unknown") kind = "symbol";
	const name =
		(syntaxNode ? getNodeName(syntaxNode) : undefined) ??
		(node ? nodeNameText(node) : undefined);
	const result: HoverResult = {
		signature: "",
		line: options.line,
		column: options.column,
		kind,
		name,
	};

	if (options.include_docs) {
		const symbol = await checker.getSymbolAtPosition(
			location.file,
			location.position,
		);
		if (symbol) {
			const documentation =
				await checker.getDocumentationCommentOfSymbol(symbol);
			if (documentation) result.documentation = documentation;
		}
	}

	if (syntaxNode && ts.isTypeAliasDeclaration(syntaxNode) && node) {
		const parameters = await typeParameterList(
			project,
			syntaxNode,
			node,
			flags,
		);
		result.signature = `type ${syntaxNode.name.text}${parameters} = ${await typeText(type, NodeBuilderFlags.InTypeAlias)}`;
		return withUnion(result, await countNativeUnionMembers(checker, type));
	}

	if (
		syntaxNode &&
		(ts.isInterfaceDeclaration(syntaxNode) ||
			ts.isClassDeclaration(syntaxNode)) &&
		syntaxNode.name &&
		syntaxNode.typeParameters?.length &&
		node
	) {
		result.signature = `${syntaxNode.name.text}${await typeParameterList(project, syntaxNode, node, flags)}`;
		return result;
	}

	if (syntaxNode && ts.isCallExpression(syntaxNode)) {
		const call = enclosingCall(node);
		const signature = call
			? await checker.getResolvedSignature(call)
			: undefined;
		const callee = await calleeType(project, location);
		const overloads = callee
			? await overloadTexts(project, callee, flags)
			: undefined;
		if (overloads) result.overloads = overloads;
		if (signature) {
			result.signature = await nativeSignatureText(
				project,
				signature,
				flags | NodeBuilderFlags.WriteTypeArgumentsOfSignature,
			);
			const returnType =
				await checker.getReturnTypeOfSignature(signature);
			if (returnType) result.returnType = await typeText(returnType);
			return result;
		}
	}

	if (
		syntaxNode &&
		(ts.isFunctionDeclaration(syntaxNode) ||
			ts.isMethodDeclaration(syntaxNode) ||
			ts.isMethodSignature(syntaxNode)) &&
		node
	) {
		const signature = await checker.getSignatureFromDeclaration(node);
		if (signature) {
			result.signature = await nativeSignatureText(
				project,
				signature,
				flags,
			);
			const returnType =
				await checker.getReturnTypeOfSignature(signature);
			if (returnType) result.returnType = await typeText(returnType);
			const overloads = await overloadTexts(project, type, flags);
			if (overloads) result.overloads = overloads;
			return result;
		}
	}

	result.signature = await typeText(type);
	const signatures = await checker.getSignaturesOfType(
		type,
		SignatureKind.Call,
	);
	const single = signatures.length === 1 ? signatures[0] : undefined;
	if (single && (await checker.getPropertiesOfType(type)).length === 0) {
		const returnType = await checker.getReturnTypeOfSignature(single);
		if (returnType) result.returnType = await typeText(returnType);
	}
	const overloads = await overloadTexts(project, type, flags);
	if (overloads) result.overloads = overloads;
	return withUnion(result, await countNativeUnionMembers(checker, type));
}

function withUnion(
	result: HoverResult,
	unionMembers: number | undefined,
): HoverResult {
	if (unionMembers !== undefined) result.unionMembers = unionMembers;
	return result;
}

/** Every call signature of `type`, when there is more than one. */
async function overloadTexts(
	project: Project,
	type: Type,
	flags: number,
): Promise<string[] | undefined> {
	const signatures = await project.checker.getSignaturesOfType(
		type,
		SignatureKind.Call,
	);
	if (signatures.length < 2) return undefined;
	return Promise.all(
		signatures.map((signature) =>
			nativeSignatureText(project, signature, flags),
		),
	);
}

/** The callee's declared type at a call's name, for its overloads. */
async function calleeType(
	project: Project,
	location: Location,
): Promise<Type | undefined> {
	const symbol = await project.checker.getSymbolAtPosition(
		location.file,
		location.position,
	);
	return symbol ? project.checker.getTypeOfSymbol(symbol) : undefined;
}

/**
 * `<R extends UnitRoute = UnitRoute>`: type parameters with modifiers (from
 * the source), constraints and defaults (printed by the checker).
 */
async function typeParameterList(
	project: Project,
	syntax: ts.DeclarationWithTypeParameterChildren,
	node: Node,
	flags: number,
): Promise<string> {
	const parameters = syntax.typeParameters;
	if (!parameters?.length) return "";
	const nativeParameters =
		(
			node as Node & {
				typeParameters?: readonly TypeParameterDeclaration[];
			}
		).typeParameters ?? [];
	const typeNodeText = async (typeNode: Node | undefined) => {
		if (!typeNode) return undefined;
		const type = await project.checker.getTypeFromTypeNode(
			typeNode as Parameters<Checker["getTypeFromTypeNode"]>[0],
		);
		return type ? nativeTypeText(project, type, flags) : undefined;
	};
	const parts = await Promise.all(
		parameters.map(async (parameter, index) => {
			const native = nativeParameters[index];
			const modifiers =
				parameter.modifiers?.map((modifier) => modifier.getText()) ??
				[];
			let part = [...modifiers, parameter.name.text].join(" ");
			const constraint = parameter.constraint
				? ((await typeNodeText(native?.constraint)) ??
					singleLine(parameter.constraint.getText()))
				: undefined;
			if (constraint) part += ` extends ${constraint}`;
			const fallback = parameter.default
				? singleLine(parameter.default.getText())
				: undefined;
			const defaultType = parameter.default
				? ((await typeNodeText(native?.defaultType)) ?? fallback)
				: undefined;
			if (defaultType) part += ` = ${defaultType}`;
			return part;
		}),
	);
	return `<${parts.join(", ")}>`;
}

/**
 * The kind of a reference, from its symbol's declaration, as
 * referenceKind in core/hover.ts does with the TypeScript 6 checker.
 */
async function referenceKind(
	project: Project,
	location: Location,
	fallback: string,
): Promise<string> {
	try {
		let symbol = await project.checker.getSymbolAtPosition(
			location.file,
			location.position,
		);
		if (symbol && symbol.flags & SymbolFlags.Alias) {
			symbol = await project.checker.getAliasedSymbol(symbol);
		}
		const handle = symbol?.valueDeclaration ?? symbol?.declarations[0];
		const declaration = handle ? await handle.resolve() : undefined;
		const kind = declaration ? declarationKind(declaration) : undefined;
		return kind ?? fallback;
	} catch {
		return fallback;
	}
}

/** The kind vocabulary of getSymbolKind, for a TypeScript 7 declaration. */
function declarationKind(node: Node): string | undefined {
	switch (node.kind) {
		case SyntaxKind.FunctionDeclaration:
		case SyntaxKind.FunctionExpression:
		case SyntaxKind.ArrowFunction:
			return "function";
		case SyntaxKind.MethodDeclaration:
		case SyntaxKind.MethodSignature:
			return "method";
		case SyntaxKind.Constructor:
			return "constructor";
		case SyntaxKind.VariableDeclaration:
			return variableKind(node);
		case SyntaxKind.Parameter:
			return "parameter";
		case SyntaxKind.PropertyDeclaration:
		case SyntaxKind.PropertySignature:
		case SyntaxKind.PropertyAssignment:
		case SyntaxKind.ShorthandPropertyAssignment:
			return "property";
		case SyntaxKind.TypeAliasDeclaration:
			return "type";
		case SyntaxKind.InterfaceDeclaration:
			return "interface";
		case SyntaxKind.ClassDeclaration:
		case SyntaxKind.ClassExpression:
			return "class";
		case SyntaxKind.EnumDeclaration:
			return "enum";
		case SyntaxKind.EnumMember:
			return "enum member";
		case SyntaxKind.GetAccessor:
		case SyntaxKind.SetAccessor:
			return "accessor";
		case SyntaxKind.ModuleDeclaration:
			return "namespace";
		case SyntaxKind.TypeParameter:
			return "type parameter";
		case SyntaxKind.BindingElement: {
			let root: Node = node;
			while (
				root.kind === SyntaxKind.BindingElement ||
				root.kind === SyntaxKind.ObjectBindingPattern ||
				root.kind === SyntaxKind.ArrayBindingPattern
			) {
				root = root.parent;
			}
			return root.kind === SyntaxKind.Parameter
				? "parameter"
				: root.kind === SyntaxKind.VariableDeclaration
					? variableKind(root)
					: undefined;
		}
		default:
			return undefined;
	}
}

/** `const`, `let`, `using`, `await using`, or `var`, from the declaration list. */
function variableKind(declaration: Node): string {
	const list = declaration.parent;
	const flags =
		list && list.kind === SyntaxKind.VariableDeclarationList
			? list.flags & 7
			: 0;
	switch (flags) {
		case NodeFlags.Const:
			return "const";
		case NodeFlags.Let:
			return "let";
		case NodeFlags.Using:
			return "using";
		case NodeFlags.AwaitUsing:
			return "await using";
		default:
			return "var";
	}
}

/** The call expression whose callee contains `node`, if any. */
function enclosingCall(node: Node | undefined): CallExpression | undefined {
	for (let current = node; current; current = current.parent) {
		if (current.kind === SyntaxKind.CallExpression)
			return current as CallExpression;
		if (current.parent === current) return undefined;
	}
	return undefined;
}

const MAX_PARSED = 16;
const parsed = new Map<string, { text: string; sourceFile: ts.SourceFile }>();

/** The file parsed by TypeScript 6 for the shared syntax rules, cached. */
function parseSyntax(file: string, text: string): ts.SourceFile {
	const cached = parsed.get(file);
	if (cached && cached.text === text) return cached.sourceFile;
	const sourceFile = ts.createSourceFile(
		file,
		stripBom(text),
		ts.ScriptTarget.Latest,
		true,
	);
	parsed.delete(file);
	parsed.set(file, { text, sourceFile });
	if (parsed.size > MAX_PARSED) {
		const oldest = parsed.keys().next().value;
		if (oldest) parsed.delete(oldest);
	}
	return sourceFile;
}

/** The TypeScript 6 node the other backends would hover at a position. */
function findSyntaxNodeAt(
	syntax: ts.SourceFile,
	position: { line: number; column: number },
): ts.Node | undefined {
	try {
		return findSyntaxNode(syntax, position.line, position.column);
	} catch {
		return undefined;
	}
}

/**
 * Run an operation in the file's session. When the compiler fails under it
 * (the process exited, or a request failed outside prinfer's own checks,
 * as when a process that got SIGTERM answers before it exits), retire the
 * session and retry once in a fresh one.
 */
async function runInSession<T>(
	file: string,
	project: string | undefined,
	operation: (project: Project, sourceFile: SourceFile) => Promise<T>,
): Promise<T> {
	const session = getSession(file, project);
	try {
		return await session.run(file, operation);
	} catch (error) {
		if (error instanceof PrinferError && !session.dead) throw error;
		void session.retire();
		return getSession(file, project).run(file, operation);
	}
}

function getSession(file: string, project?: string): NativeApiSession {
	const resolved = resolveProject(file, project);
	let session = sessions.get(resolved.key);
	if (!session) {
		session = new NativeApiSession(
			resolved.key,
			resolved.root,
			resolved.projectFile,
		);
		sessions.set(resolved.key, session);
	}
	return session;
}

function resolveFile(file: string): string {
	const resolved = path.resolve(process.cwd(), file);
	if (!fs.existsSync(resolved))
		throw new PrinferError("FILE_NOT_FOUND", `File not found: ${resolved}`);
	return resolved;
}

function resolveProject(
	file: string,
	project?: string,
): { key: string; root: string; projectFile?: string } {
	if (!project) {
		const root = findConfigRoot(path.dirname(file));
		return { key: root, root };
	}
	const resolved = path.resolve(process.cwd(), project);
	const projectFile = fs.statSync(resolved).isDirectory()
		? path.join(resolved, "tsconfig.json")
		: resolved;
	if (!fs.existsSync(projectFile)) {
		throw new PrinferError(
			"FILE_NOT_FOUND",
			`TypeScript project not found: ${projectFile}`,
			"Pass project as a tsconfig.json path or its directory.",
		);
	}
	return {
		key: projectFile,
		root: path.dirname(projectFile),
		projectFile,
	};
}

function findConfigRoot(start: string): string {
	let current = start;
	while (true) {
		if (fs.existsSync(path.join(current, "tsconfig.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

function sourcePosition(
	file: string,
	text: string,
	line: number,
	column: number,
): number {
	if (
		!Number.isInteger(line) ||
		!Number.isInteger(column) ||
		line < 1 ||
		column < 1
	) {
		throw new PrinferError(
			"INVALID_ARGUMENT",
			"Line and column must be positive integers.",
		);
	}
	let lineStart = 0;
	for (let current = 1; current < line; current += 1) {
		const newline = text.indexOf("\n", lineStart);
		if (newline < 0)
			throw new PrinferError(
				"INVALID_ARGUMENT",
				`No cursor position at ${file}:${line}:${column}`,
				`The file has ${current} lines.`,
			);
		lineStart = newline + 1;
	}
	const newline = text.indexOf("\n", lineStart);
	const rawLineEnd = newline < 0 ? text.length : newline;
	const lineEnd = text[rawLineEnd - 1] === "\r" ? rawLineEnd - 1 : rawLineEnd;
	const position = lineStart + column - 1;
	if (position > lineEnd) {
		throw new PrinferError(
			"INVALID_ARGUMENT",
			`No cursor position at ${file}:${line}:${column}`,
			`Line ${line} has ${lineEnd - lineStart} characters, so the last cursor column is ${lineEnd - lineStart + 1}.`,
		);
	}
	return position;
}

/** The innermost node at a position. */
function tokenAtPosition(
	sourceFile: SourceFile,
	position: number,
): Node | undefined {
	let found: Node | undefined;
	const visit = (node: Node): void => {
		if (position < node.getStart(sourceFile) || position >= node.getEnd())
			return;
		found = node;
		node.forEachChild(visit);
	};
	visit(sourceFile);
	return found;
}

/** The declaration whose name is at a position, or the innermost node. */
function findNodeAtPosition(
	sourceFile: SourceFile,
	position: number,
): Node | undefined {
	const found = tokenAtPosition(sourceFile, position);
	for (
		let current = found;
		current && current !== sourceFile;
		current = current.parent
	) {
		if (!isSupportedDeclaration(current)) continue;
		const name = nodeName(current);
		if (
			name &&
			position >= name.getStart(sourceFile) &&
			position < name.getEnd()
		) {
			return current;
		}
	}
	return found;
}

function isSupportedDeclaration(node: Node): boolean {
	return (
		isVariableDeclaration(node) ||
		isFunctionDeclaration(node) ||
		isMethodDeclaration(node) ||
		isMethodSignatureDeclaration(node) ||
		isPropertyDeclaration(node) ||
		isPropertySignatureDeclaration(node) ||
		isPropertyAssignment(node) ||
		isParameterDeclaration(node) ||
		isTypeAliasDeclaration(node) ||
		isInterfaceDeclaration(node) ||
		isClassDeclaration(node)
	);
}

function nodeName(node: Node): Node | undefined {
	return (node as Node & { name?: Node }).name;
}

function nodeNameText(node: Node): string | undefined {
	if (isIdentifier(node)) return node.text;
	const name = nodeName(node);
	return name && isIdentifier(name) ? name.text : undefined;
}
