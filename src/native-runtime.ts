import type * as Ast from "@typescript/native/unstable/ast";
import type * as Is from "@typescript/native/unstable/ast/is";
import type * as Async from "@typescript/native/unstable/async";
import type { CompilerInfo } from "./types.js";

/**
 * The TypeScript 7 compiler API that native-api.ts and native-lsp.ts run
 * against: typeprobe's `@typescript/native`, or a project's `typescript` 7,
 * `@typescript/native`, or `@typescript/native-preview`, loaded on first
 * use (see compiler.ts).
 * The modules come from one package, so the API client always speaks its
 * own compiler's protocol, and enum values match what that compiler sends.
 */
export interface NativeCompiler {
	info: CompilerInfo;
	/** The package directory; identifies the compiler. */
	packageDir: string;
	/** The package's bin script, run with `--lsp --stdio` (native-lsp.ts). */
	lspBin: string;
	ast: typeof Ast;
	is: typeof Is;
	async: typeof Async;
}

/*
 * The active compiler's values, bound by withNativeCompiler. The two
 * modules import these names instead of `@typescript/native`, so their
 * code reads the same and the package is only loaded when a TypeScript 7
 * call needs it. Types still come from the bundled package's declarations.
 */
export let API: typeof Async.API;
export type API<FromLSP extends boolean = false> = Async.API<FromLSP>;
export let DiagnosticCategory: typeof Async.DiagnosticCategory;
export type DiagnosticCategory = Async.DiagnosticCategory;
export let NodeBuilderFlags: typeof Async.NodeBuilderFlags;
export let SignatureKind: typeof Async.SignatureKind;
export let SymbolFlags: typeof Async.SymbolFlags;
export let TypeFlags: typeof Async.TypeFlags;
export let NodeFlags: typeof Ast.NodeFlags;
export let SyntaxKind: typeof Ast.SyntaxKind;
export type SyntaxKind = Ast.SyntaxKind;
export let isClassDeclaration: typeof Is.isClassDeclaration;
export let isExpressionWithTypeArguments: typeof Is.isExpressionWithTypeArguments;
export let isFunctionDeclaration: typeof Is.isFunctionDeclaration;
export let isHeritageClause: typeof Is.isHeritageClause;
export let isIdentifier: typeof Is.isIdentifier;
export let isImportTypeNode: typeof Is.isImportTypeNode;
export let isInterfaceDeclaration: typeof Is.isInterfaceDeclaration;
export let isMethodDeclaration: typeof Is.isMethodDeclaration;
export let isMethodSignatureDeclaration: typeof Is.isMethodSignatureDeclaration;
export let isParameterDeclaration: typeof Is.isParameterDeclaration;
export let isPropertyAccessExpression: typeof Is.isPropertyAccessExpression;
export let isPropertyAssignment: typeof Is.isPropertyAssignment;
export let isPropertyDeclaration: typeof Is.isPropertyDeclaration;
export let isPropertySignatureDeclaration: typeof Is.isPropertySignatureDeclaration;
export let isQualifiedName: typeof Is.isQualifiedName;
export let isTypeAliasDeclaration: typeof Is.isTypeAliasDeclaration;
export let isTypeNode: typeof Is.isTypeNode;
export let isTypeQueryNode: typeof Is.isTypeQueryNode;
export let isVariableDeclaration: typeof Is.isVariableDeclaration;

function bind(compiler: NativeCompiler): void {
	const { ast, is } = compiler;
	const api = compiler.async;
	API = api.API;
	DiagnosticCategory = api.DiagnosticCategory;
	NodeBuilderFlags = api.NodeBuilderFlags;
	SignatureKind = api.SignatureKind;
	SymbolFlags = api.SymbolFlags;
	TypeFlags = api.TypeFlags;
	NodeFlags = ast.NodeFlags;
	SyntaxKind = ast.SyntaxKind;
	isClassDeclaration = is.isClassDeclaration;
	isExpressionWithTypeArguments = is.isExpressionWithTypeArguments;
	isFunctionDeclaration = is.isFunctionDeclaration;
	isHeritageClause = is.isHeritageClause;
	isIdentifier = is.isIdentifier;
	isImportTypeNode = is.isImportTypeNode;
	isInterfaceDeclaration = is.isInterfaceDeclaration;
	isMethodDeclaration = is.isMethodDeclaration;
	isMethodSignatureDeclaration = is.isMethodSignatureDeclaration;
	isParameterDeclaration = is.isParameterDeclaration;
	isPropertyAccessExpression = is.isPropertyAccessExpression;
	isPropertyAssignment = is.isPropertyAssignment;
	isPropertyDeclaration = is.isPropertyDeclaration;
	isPropertySignatureDeclaration = is.isPropertySignatureDeclaration;
	isQualifiedName = is.isQualifiedName;
	isTypeAliasDeclaration = is.isTypeAliasDeclaration;
	isTypeNode = is.isTypeNode;
	isTypeQueryNode = is.isTypeQueryNode;
	isVariableDeclaration = is.isVariableDeclaration;
}

let active: NativeCompiler | undefined;
/** Calls running on the active compiler. */
let running = 0;
/** Wakes a switch waiting for the running calls to finish. */
let drained: Array<() => void> = [];
/** Calls waiting in `queue`; while any wait, new calls queue behind them. */
let queued = 0;
/** Admits waiting calls in order, switching compilers between them. */
let queue: Promise<void> = Promise.resolve();
const switchHooks: Array<() => Promise<void> | void> = [];

/** The compiler TypeScript 7 calls run on, if one has been used. */
export function activeNativeCompiler(): NativeCompiler | undefined {
	return active;
}

/**
 * Register cleanup for a switch to another compiler: the sessions of the
 * previous one are closed, because their objects belong to its API.
 */
export function onNativeCompilerSwitch(hook: () => Promise<void> | void): void {
	switchHooks.push(hook);
}

/**
 * Run a TypeScript 7 call on `compiler`. Calls on the active compiler run
 * concurrently. A call on another one waits until they finish, closes
 * their sessions, and switches: one process uses one TypeScript 7 compiler
 * at a time, so a mix (projects with different compilers in one MCP
 * server or test run) works, but restarts the compiler at each switch.
 */
export async function withNativeCompiler<T>(
	compiler: NativeCompiler,
	run: () => Promise<T>,
): Promise<T> {
	if (active === compiler && queued === 0) {
		running += 1;
	} else {
		queued += 1;
		const admitted = queue.then(() => admit(compiler));
		queue = admitted.catch(() => undefined);
		try {
			await admitted;
		} finally {
			queued -= 1;
		}
	}
	try {
		return await run();
	} finally {
		running -= 1;
		if (running === 0) {
			const waiting = drained;
			drained = [];
			for (const wake of waiting) wake();
		}
	}
}

/** Switch to `compiler` if needed, then count the caller as running. */
async function admit(compiler: NativeCompiler): Promise<void> {
	if (active !== compiler) {
		while (running > 0) {
			await new Promise<void>((resolve) => drained.push(resolve));
		}
		const previous = active;
		active = undefined;
		if (previous) {
			await Promise.all(
				switchHooks.map(async (hook) => {
					try {
						await hook();
					} catch {
						// A session that fails to close is abandoned.
					}
				}),
			);
		}
		bind(compiler);
		active = compiler;
	}
	running += 1;
}
