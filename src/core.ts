import path from "node:path";
import ts from "typescript";
import type { HoverResult, InferredTypeResult } from "./types.js";

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
 * Check if a node is a call expression with the given name
 */
function isCallExpressionNamed(node: ts.Node, name: string): boolean {
	if (!ts.isCallExpression(node)) return false;
	const expr = node.expression;

	// Direct call: foo()
	if (ts.isIdentifier(expr) && expr.text === name) return true;

	// Property access: this.foo() or obj.foo()
	if (ts.isPropertyAccessExpression(expr) && expr.name.text === name)
		return true;

	return false;
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
	const flags = ts.TypeFormatFlags.NoTruncation;

	// Handle call expressions - get instantiated signature
	if (ts.isCallExpression(node)) {
		const sig = checker.getResolvedSignature(node);
		if (sig) {
			const signature = checker.signatureToString(sig, undefined, flags);
			const ret = checker.getReturnTypeOfSignature(sig);
			const returnType = checker.typeToString(ret, undefined, flags);
			return { signature, returnType, line };
		}
		// Fallback: get type of the call result
		const t = checker.getTypeAtLocation(node);
		return { signature: checker.typeToString(t, undefined, flags), line };
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
		// interfaces/types
		sig = checker.getSignatureFromDeclaration(node) ?? undefined;
	}

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

/**
 * Find the most specific node containing a position by walking the AST
 */
function findSmallestNodeAtPosition(
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
function findHoverableAncestor(
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

/**
 * Get the symbol kind as a string
 */
function getSymbolKind(node: ts.Node): string {
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
function getNodeName(node: ts.Node): string | undefined {
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
