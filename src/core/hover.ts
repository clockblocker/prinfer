import * as ts from "typescript";
import { TypeScriptInternalError } from "../errors.js";
import type { HoverResult } from "../types.js";
import { getNameNode, isArrowOrFnExpr } from "./node-match.js";

/**
 * Get the symbol kind as a string. Kinds follow the labels an editor hover
 * shows (and the TypeScript 7 backend reports): `const`, `let`, `var`,
 * `parameter`, `property`, `method`, and so on. A variable initialized with
 * a function is `function`.
 */
export function getSymbolKind(node: ts.Node): string {
	if (ts.isFunctionDeclaration(node)) return "function";
	if (ts.isArrowFunction(node)) return "function";
	if (ts.isFunctionExpression(node)) return "function";
	if (ts.isMethodDeclaration(node)) return "method";
	if (ts.isMethodSignature(node)) return "method";
	if (ts.isVariableDeclaration(node)) {
		const init = node.initializer;
		if (
			init &&
			(ts.isArrowFunction(init) || ts.isFunctionExpression(init))
		) {
			return "function";
		}
		return variableKind(node);
	}
	if (ts.isParameter(node)) return "parameter";
	if (ts.isPropertyDeclaration(node)) return "property";
	if (ts.isPropertySignature(node)) return "property";
	if (ts.isPropertyAccessExpression(node)) return "property";
	if (ts.isCallExpression(node)) return "call";
	if (ts.isTypeAliasDeclaration(node)) return "type";
	if (ts.isInterfaceDeclaration(node)) return "interface";
	if (ts.isClassDeclaration(node)) return "class";
	if (ts.isEnumDeclaration(node)) return "enum";
	if (ts.isEnumMember(node)) return "enum member";
	if (ts.isBindingElement(node)) {
		const root = ts.walkUpBindingElementsAndPatterns(node);
		return ts.isParameter(root) ? "parameter" : variableKind(root);
	}
	if (ts.isTypeParameterDeclaration(node)) return "type parameter";
	if (ts.isPropertyAssignment(node)) return "property";
	if (ts.isShorthandPropertyAssignment(node)) return "property";
	if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
		return "accessor";
	if (ts.isModuleDeclaration(node)) return "namespace";
	if (ts.isIdentifier(node)) return "identifier";
	return "unknown";
}

/** `const`, `let`, `using`, `await using`, or `var`, from the declaration list. */
function variableKind(node: ts.VariableDeclaration): string {
	switch (ts.getCombinedNodeFlags(node) & ts.NodeFlags.BlockScoped) {
		case ts.NodeFlags.Const:
			return "const";
		case ts.NodeFlags.Let:
			return "let";
		case ts.NodeFlags.Using:
			return "using";
		case ts.NodeFlags.AwaitUsing:
			return "await using";
		default:
			return "var";
	}
}

/**
 * The kind of a bare identifier or property access, from the declaration of
 * the symbol it refers to: a reference to a parameter is `parameter`, to a
 * const is `const`, `obj.fn` is `method`. Falls back to `fallback` when the
 * symbol has no declaration prinfer can classify.
 */
function referenceKind(
	checker: ts.TypeChecker,
	node: ts.Node,
	fallback: string,
): string {
	const target = ts.isPropertyAccessExpression(node) ? node.name : node;
	let symbol = checker.getSymbolAtLocation(target);
	if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
		try {
			symbol = checker.getAliasedSymbol(symbol);
		} catch {
			// Unresolvable alias: classify the import itself.
		}
	}
	const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
	if (!declaration) return fallback;
	const kind = getSymbolKind(declaration);
	return kind === "unknown" || kind === "identifier" ? fallback : kind;
}

/**
 * Get the name of a node if it has one
 */
export function getNodeName(node: ts.Node): string | undefined {
	if (ts.isFunctionDeclaration(node) && node.name) {
		return node.name.text;
	}
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
		return node.name.text;
	}
	if (
		(ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) &&
		ts.isIdentifier(node.name)
	) {
		return node.name.text;
	}
	if (ts.isPropertyAccessExpression(node)) {
		return node.name.text;
	}
	if (ts.isCallExpression(node)) {
		const expr = node.expression;
		if (ts.isIdentifier(expr)) return expr.text;
		if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
	}
	if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
		return node.name.text;
	}
	if (ts.isIdentifier(node)) {
		return node.text;
	}
	if (
		ts.isTypeAliasDeclaration(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isClassDeclaration(node)
	) {
		return node.name?.text;
	}
	const nameNode = getNameNode(node);
	if (nameNode !== node && ts.isIdentifier(nameNode)) return nameNode.text;
	return undefined;
}

/**
 * Get documentation from a symbol
 */
export function getDocumentation(
	checker: ts.TypeChecker,
	symbol: ts.Symbol | undefined,
): string | undefined {
	if (!symbol) return undefined;

	const docs = symbol.getDocumentationComment(checker);
	if (docs.length === 0) return undefined;

	return ts.displayPartsToString(docs);
}

/**
 * Get hover information at a specific position
 */
export function getHoverInfo(
	program: ts.Program,
	node: ts.Node,
	sourceFile: ts.SourceFile,
	includeDocs: boolean,
	full = false,
): HoverResult {
	const checker = program.getTypeChecker();
	const sf = sourceFile;
	const { line, character } = sf.getLineAndCharacterOfPosition(
		node.getStart(sf),
	);

	try {
		return getHoverInfoImpl(checker, node, sourceFile, includeDocs, full);
	} catch (error) {
		if (error instanceof Error) {
			throw new TypeScriptInternalError({
				file: sourceFile.fileName,
				line: line + 1,
				column: character + 1,
				operation: "getting type information",
				cause: error,
			});
		}
		throw error;
	}
}

function getHoverInfoImpl(
	checker: ts.TypeChecker,
	node: ts.Node,
	sourceFile: ts.SourceFile,
	includeDocs: boolean,
	full: boolean,
): HoverResult {
	const sf = sourceFile;
	const { line, character } = sf.getLineAndCharacterOfPosition(
		getNameNode(node).getStart(sf),
	);
	const flags = full
		? ts.TypeFormatFlags.NoTruncation
		: ts.TypeFormatFlags.None;

	let kind = getSymbolKind(node);
	if (kind === "identifier" || ts.isPropertyAccessExpression(node)) {
		kind = referenceKind(checker, node, kind);
	}
	const name = getNodeName(node);

	// Get symbol for documentation
	let symbol: ts.Symbol | undefined;
	if (ts.isCallExpression(node)) {
		// For calls, get symbol from the expression
		const expr = node.expression;
		if (ts.isPropertyAccessExpression(expr)) {
			symbol = checker.getSymbolAtLocation(expr.name);
		} else {
			symbol = checker.getSymbolAtLocation(expr);
		}
	} else {
		const nodeWithName = node as unknown as { name?: ts.Node };
		if (nodeWithName.name) {
			symbol = checker.getSymbolAtLocation(nodeWithName.name);
		} else {
			symbol = checker.getSymbolAtLocation(node);
		}
	}

	const documentation = includeDocs
		? getDocumentation(checker, symbol)
		: undefined;

	// Match TypeScript's hover for an alias declaration while disabling the
	// truncation that makes editor hovers unsuitable for type inspection.
	if (ts.isTypeAliasDeclaration(node)) {
		const type = checker.getTypeAtLocation(node.name);
		const expanded = checker.typeToString(
			type,
			undefined,
			flags | ts.TypeFormatFlags.InTypeAlias,
		);
		return {
			signature: `type ${node.name.text} = ${expanded}`,
			line: line + 1,
			column: character + 1,
			documentation,
			kind,
			name,
		};
	}

	// Handle call expressions - get instantiated signature
	if (ts.isCallExpression(node)) {
		const sig = checker.getResolvedSignature(node);
		if (sig) {
			const signature = checker.signatureToString(sig, undefined, flags);
			const ret = checker.getReturnTypeOfSignature(sig);
			const returnType = checker.typeToString(ret, undefined, flags);
			return {
				signature,
				returnType,
				line: line + 1,
				column: character + 1,
				documentation,
				kind,
				name,
			};
		}
		// Fallback: get type of the call result
		const t = checker.getTypeAtLocation(node);
		return {
			signature: checker.typeToString(t, undefined, flags),
			line: line + 1,
			column: character + 1,
			documentation,
			kind,
			name,
		};
	}

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
		sig = checker.getSignatureFromDeclaration(node) ?? undefined;
	}

	if (sig) {
		const signature = checker.signatureToString(sig, undefined, flags);
		const ret = checker.getReturnTypeOfSignature(sig);
		const returnType = checker.typeToString(ret, undefined, flags);
		return {
			signature,
			returnType,
			line: line + 1,
			column: character + 1,
			documentation,
			kind,
			name,
		};
	}

	// Fallback: type at the node location
	const nodeWithName = node as unknown as { name?: ts.Node };
	let targetNode: ts.Node = node;
	if (nodeWithName.name && ts.isIdentifier(nodeWithName.name)) {
		targetNode = nodeWithName.name;
	}

	const t = checker.getTypeAtLocation(targetNode);
	return {
		signature: checker.typeToString(t, undefined, flags),
		line: line + 1,
		column: character + 1,
		documentation,
		kind,
		name,
	};
}
