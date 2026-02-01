import ts from "typescript";
import { TypeScriptInternalError } from "../errors.js";
import type { HoverResult } from "../types.js";
import { isArrowOrFnExpr } from "./node-match.js";

/**
 * Get the symbol kind as a string
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
		return "variable";
	}
	if (ts.isParameter(node)) return "parameter";
	if (ts.isPropertyDeclaration(node)) return "property";
	if (ts.isPropertySignature(node)) return "property";
	if (ts.isPropertyAccessExpression(node)) return "property";
	if (ts.isCallExpression(node)) return "call";
	if (ts.isTypeAliasDeclaration(node)) return "type";
	if (ts.isInterfaceDeclaration(node)) return "interface";
	if (ts.isClassDeclaration(node)) return "class";
	if (ts.isIdentifier(node)) return "identifier";
	return "unknown";
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
): HoverResult {
	const checker = program.getTypeChecker();
	const sf = sourceFile;
	const { line, character } = sf.getLineAndCharacterOfPosition(
		node.getStart(sf),
	);

	try {
		return getHoverInfoImpl(checker, node, sourceFile, includeDocs);
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
): HoverResult {
	const sf = sourceFile;
	const { line, character } = sf.getLineAndCharacterOfPosition(
		node.getStart(sf),
	);
	const flags = ts.TypeFormatFlags.NoTruncation;

	const kind = getSymbolKind(node);
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
