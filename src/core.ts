import path from "node:path";
import ts from "typescript";
import type { InferredTypeResult } from "./types.js";

/**
 * Find the nearest tsconfig.json from a starting directory
 */
export function findNearestTsconfig(startDir: string): string | undefined {
	return (
		ts.findConfigFile(startDir, ts.sys.fileExists, "tsconfig.json") ??
		undefined
	);
}

/**
 * Load a TypeScript program from an entry file
 */
export function loadProgram(
	entryFileAbs: string,
	project?: string,
): ts.Program {
	const fileDir = path.dirname(entryFileAbs);
	const tsconfigPath = project
		? path.resolve(process.cwd(), project)
		: findNearestTsconfig(fileDir);

	if (!tsconfigPath) {
		// Fallback: single-file program
		return ts.createProgram([entryFileAbs], {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			strict: true,
			allowJs: true,
			checkJs: false,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			skipLibCheck: true,
		});
	}

	const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (cfg.error) {
		throw new Error(
			ts.flattenDiagnosticMessageText(cfg.error.messageText, "\n"),
		);
	}

	const parsed = ts.parseJsonConfigFileContent(
		cfg.config,
		ts.sys,
		path.dirname(tsconfigPath),
	);
	return ts.createProgram({
		rootNames: parsed.fileNames,
		options: parsed.options,
	});
}

function isArrowOrFnExpr(
	n: ts.Node | undefined,
): n is ts.ArrowFunction | ts.FunctionExpression {
	return !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
}

function nodeNameText(
	n: ts.PropertyName | ts.BindingName | undefined,
): string | undefined {
	if (!n) return undefined;
	if (ts.isIdentifier(n)) return n.text;
	if (ts.isStringLiteral(n)) return n.text;
	if (ts.isNumericLiteral(n)) return n.text;
	return undefined; // ignore computed names etc.
}

function isFunctionLikeNamed(node: ts.Node, name: string): boolean {
	// function foo() {}
	if (ts.isFunctionDeclaration(node) && node.name?.text === name) return true;

	// const foo = () => {} / function() {}
	if (
		ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) &&
		node.name.text === name
	) {
		return isArrowOrFnExpr(node.initializer);
	}

	// class C { foo() {} } / interface signatures
	if (
		(ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) &&
		nodeNameText(node.name) === name
	) {
		return true;
	}

	// object literal { foo() {} } via MethodDeclaration inside object literal is also MethodDeclaration
	// property assignment: { foo: () => {} }
	if (ts.isPropertyAssignment(node) && nodeNameText(node.name) === name) {
		return isArrowOrFnExpr(node.initializer);
	}

	return false;
}

/**
 * Check if a node is any variable declaration with the given name
 */
function isVariableNamed(node: ts.Node, name: string): boolean {
	if (
		ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) &&
		node.name.text === name
	) {
		return true;
	}
	return false;
}

/**
 * Check if a node matches the given name (function-like or variable)
 */
function isNamedNode(node: ts.Node, name: string): boolean {
	return isFunctionLikeNamed(node, name) || isVariableNamed(node, name);
}

/**
 * Get the 1-based line number for a node
 */
export function getLineNumber(
	sourceFile: ts.SourceFile,
	node: ts.Node,
): number {
	const { line } = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile),
	);
	return line + 1;
}

/**
 * Find the first function-like node with the given name in a source file
 */
export function findFirstMatch(
	sourceFile: ts.SourceFile,
	name: string,
): ts.Node | undefined {
	let found: ts.Node | undefined;

	const visit = (node: ts.Node) => {
		if (found) return;
		if (isFunctionLikeNamed(node, name)) {
			found = node;
			return;
		}
		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return found;
}

/**
 * Find a node by name and optionally by line number
 */
export function findNodeByNameAndLine(
	sourceFile: ts.SourceFile,
	name: string,
	line?: number,
): ts.Node | undefined {
	let found: ts.Node | undefined;

	const visit = (node: ts.Node) => {
		if (found) return;
		if (isNamedNode(node, name)) {
			if (line !== undefined) {
				const nodeLine = getLineNumber(sourceFile, node);
				if (nodeLine === line) {
					found = node;
					return;
				}
			} else {
				found = node;
				return;
			}
		}
		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return found;
}

/**
 * Get type information for a node
 */
export function getTypeInfo(
	program: ts.Program,
	node: ts.Node,
	sourceFile?: ts.SourceFile,
): InferredTypeResult {
	const checker = program.getTypeChecker();
	const sf = sourceFile ?? node.getSourceFile();
	const line = getLineNumber(sf, node);

	let sig: ts.Signature | undefined;

	// Prefer getting the signature from a declaration/expression directly
	if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
		sig = checker.getSignatureFromDeclaration(node) ?? undefined;
	} else if (ts.isVariableDeclaration(node)) {
		const init = node.initializer;
		if (isArrowOrFnExpr(init))
			sig = checker.getSignatureFromDeclaration(init) ?? undefined;
	} else if (ts.isPropertyAssignment(node)) {
		const init = node.initializer;
		if (isArrowOrFnExpr(init))
			sig = checker.getSignatureFromDeclaration(init) ?? undefined;
	} else if (ts.isMethodSignature(node)) {
		// interfaces/types
		sig = checker.getSignatureFromDeclaration(node) ?? undefined;
	}

	const flags = ts.TypeFormatFlags.NoTruncation;

	if (sig) {
		const signature = checker.signatureToString(sig, undefined, flags);
		const ret = checker.getReturnTypeOfSignature(sig);
		const returnType = checker.typeToString(ret, undefined, flags);
		return { signature, returnType, line };
	}

	// Fallback: type at the name location
	const nodeWithName = node as unknown as { name?: ts.Node };
	let nameNode: ts.Node = node;
	if (nodeWithName.name && ts.isIdentifier(nodeWithName.name)) {
		nameNode = nodeWithName.name;
	}

	const t = checker.getTypeAtLocation(nameNode);
	return { signature: checker.typeToString(t, undefined, flags), line };
}
