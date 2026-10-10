import * as bundled from "typescript";

/** The TypeScript compiler API, as typed by the bundled `typescript`. */
export type TypeScript = typeof bundled;

/**
 * The TypeScript 6 compiler API every module in src/core runs against: the
 * bundled `typescript` package, or a project's own copy while
 * `withTypeScript` runs. Core modules import this instead of `typescript`
 * so the same code can print and count with either. The types stay those
 * of the bundled package: they describe any supported version's public API.
 */
// biome-ignore lint/style/useConst: withTypeScript reassigns it.
export let ts: TypeScript = bundled;

/**
 * Types core modules name as `ts.X`; a value binding has no namespace, so
 * each one is listed here. Add a type when a core module needs another.
 */
export declare namespace ts {
	export type ArrowFunction = bundled.ArrowFunction;
	export type BindingName = bundled.BindingName;
	export type CompletionEntry = bundled.CompletionEntry;
	export type CompletionInfo = bundled.CompletionInfo;
	export type DeclarationWithTypeParameterChildren =
		bundled.DeclarationWithTypeParameterChildren;
	export type Diagnostic = bundled.Diagnostic;
	export type DiagnosticCategory = bundled.DiagnosticCategory;
	export type FunctionDeclaration = bundled.FunctionDeclaration;
	export type FunctionExpression = bundled.FunctionExpression;
	export type FunctionLikeDeclaration = bundled.FunctionLikeDeclaration;
	export type Identifier = bundled.Identifier;
	export type LanguageService = bundled.LanguageService;
	export type LanguageServiceHost = bundled.LanguageServiceHost;
	export type MethodDeclaration = bundled.MethodDeclaration;
	export type NamedDeclaration = bundled.NamedDeclaration;
	export type Node = bundled.Node;
	export type NodeFlags = bundled.NodeFlags;
	export type ObjectType = bundled.ObjectType;
	export type ParameterDeclaration = bundled.ParameterDeclaration;
	export type PrivateIdentifier = bundled.PrivateIdentifier;
	export type Program = bundled.Program;
	export type PropertyDeclaration = bundled.PropertyDeclaration;
	export type PropertyName = bundled.PropertyName;
	export type PropertySignature = bundled.PropertySignature;
	export type Signature = bundled.Signature;
	export type SignatureDeclaration = bundled.SignatureDeclaration;
	export type SignatureDeclarationBase = bundled.SignatureDeclarationBase;
	export type SourceFile = bundled.SourceFile;
	export type Statement = bundled.Statement;
	export type Symbol = bundled.Symbol;
	export type SyntaxKind = bundled.SyntaxKind;
	export type Type = bundled.Type;
	export type TypeChecker = bundled.TypeChecker;
	export type TypeFormatFlags = bundled.TypeFormatFlags;
	export type TypeNode = bundled.TypeNode;
	export type TypeReference = bundled.TypeReference;
	export type VariableDeclaration = bundled.VariableDeclaration;
}

/** The `typescript` package prinfer depends on. */
export const bundledTypeScript: TypeScript = bundled;

const instanceIds = new WeakMap<TypeScript, number>([[bundled, 0]]);
let nextInstanceId = 1;

/**
 * A number that tells the active instance apart from other loaded ones
 * (the bundled one is 0), for caches of values only it can use.
 */
export function typeScriptId(): number {
	let id = instanceIds.get(ts);
	if (id === undefined) {
		id = nextInstanceId++;
		instanceIds.set(ts, id);
	}
	return id;
}

/**
 * Run `run` with core modules on `instance`. Everything TypeScript 6 does
 * is synchronous, so nothing else can observe the swap: no other call runs
 * until this one returns. Values that outlive the call, such as cached
 * programs, belong to the instance that created them (see program.ts).
 */
export function withTypeScript<T>(instance: TypeScript, run: () => T): T {
	if (instance === ts) return run();
	const previous = ts;
	ts = instance;
	try {
		return run();
	} finally {
		ts = previous;
	}
}
