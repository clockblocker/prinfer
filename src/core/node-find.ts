import ts from "typescript";
import {
	getLineNumber,
	isCallExpressionNamed,
	isFunctionLikeNamed,
	isNamedNode,
} from "./node-match.js";

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

	const matchesLine = (node: ts.Node): boolean => {
		if (line === undefined) return true;
		return getLineNumber(sourceFile, node) === line;
	};

	const visit = (node: ts.Node) => {
		if (found) return;

		// Check declarations (existing logic)
		if (isNamedNode(node, name) && matchesLine(node)) {
			found = node;
			return;
		}

		// Check call expressions (new)
		if (isCallExpressionNamed(node, name) && matchesLine(node)) {
			found = node;
			return;
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return found;
}

/**
 * Find the most specific node containing a position by walking the AST
 */
export function findSmallestNodeAtPosition(
	sourceFile: ts.SourceFile,
	position: number,
): ts.Node | undefined {
	let result: ts.Node | undefined;

	function visit(node: ts.Node): void {
		const start = node.getStart(sourceFile);
		const end = node.getEnd();

		// Position must be within this node's range
		if (position < start || position >= end) {
			return;
		}

		// This node contains the position - check if it's more specific than current result
		if (
			!result ||
			node.getWidth(sourceFile) <= result.getWidth(sourceFile)
		) {
			result = node;
		}

		// Continue to check children for more specific nodes
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return result;
}

/**
 * Walk up from a token to find the most useful node for hover info
 */
export function findHoverableAncestor(
	sourceFile: ts.SourceFile,
	position: number,
): ts.Node | undefined {
	const smallestNode = findSmallestNodeAtPosition(sourceFile, position);
	if (!smallestNode) return undefined;

	// Walk up the tree to find the most useful hoverable node
	let bestMatch: ts.Node | undefined = smallestNode;

	// Visit ancestors
	function visit(n: ts.Node): boolean {
		const start = n.getStart(sourceFile);
		const end = n.getEnd();

		if (position < start || position >= end) {
			return false;
		}

		// Check if this is a call expression with our node as the callee
		if (ts.isCallExpression(n)) {
			const expr = n.expression;
			// Check if position is on the function name part
			if (ts.isIdentifier(expr)) {
				if (
					position >= expr.getStart(sourceFile) &&
					position < expr.getEnd()
				) {
					bestMatch = n;
				}
			} else if (ts.isPropertyAccessExpression(expr)) {
				if (
					position >= expr.name.getStart(sourceFile) &&
					position < expr.name.getEnd()
				) {
					bestMatch = n;
				}
			}
		}

		// If this is a declaration and the position is on its name, use this declaration
		if (ts.isFunctionDeclaration(n) && n.name) {
			if (
				position >= n.name.getStart(sourceFile) &&
				position < n.name.getEnd()
			) {
				bestMatch = n;
			}
		}
		if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
			if (
				position >= n.name.getStart(sourceFile) &&
				position < n.name.getEnd()
			) {
				bestMatch = n;
			}
		}
		if (
			(ts.isMethodDeclaration(n) || ts.isMethodSignature(n)) &&
			ts.isIdentifier(n.name)
		) {
			if (
				position >= n.name.getStart(sourceFile) &&
				position < n.name.getEnd()
			) {
				bestMatch = n;
			}
		}
		if (ts.isClassDeclaration(n) && n.name) {
			if (
				position >= n.name.getStart(sourceFile) &&
				position < n.name.getEnd()
			) {
				bestMatch = n;
			}
		}
		if (ts.isInterfaceDeclaration(n) && n.name) {
			if (
				position >= n.name.getStart(sourceFile) &&
				position < n.name.getEnd()
			) {
				bestMatch = n;
			}
		}

		ts.forEachChild(n, visit);
		return true;
	}

	visit(sourceFile);
	return bestMatch;
}

/**
 * Find the node at a specific position (1-based line and column)
 */
export function findNodeAtPosition(
	sourceFile: ts.SourceFile,
	line: number,
	column: number,
): ts.Node | undefined {
	// Validate line/column bounds
	const lineCount = sourceFile.getLineStarts().length;
	if (line < 1 || line > lineCount) {
		return undefined;
	}

	const lineStart = sourceFile.getLineStarts()[line - 1];
	const lineEnd =
		line < lineCount
			? sourceFile.getLineStarts()[line]
			: sourceFile.getEnd();
	const lineLength = lineEnd - lineStart;

	if (column < 1 || column > lineLength + 1) {
		return undefined;
	}

	// Convert 1-based line/column to 0-based position
	const position = sourceFile.getPositionOfLineAndCharacter(
		line - 1,
		column - 1,
	);

	return findHoverableAncestor(sourceFile, position);
}
