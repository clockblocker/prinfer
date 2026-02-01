import ts from "typescript";

/**
 * Check if a node is an arrow function or function expression
 */
export function isArrowOrFnExpr(
	n: ts.Node | undefined,
): n is ts.ArrowFunction | ts.FunctionExpression {
	return !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
}

/**
 * Get the text of a property or binding name
 */
export function nodeNameText(
	n: ts.PropertyName | ts.BindingName | undefined,
): string | undefined {
	if (!n) return undefined;
	if (ts.isIdentifier(n)) return n.text;
	if (ts.isStringLiteral(n)) return n.text;
	if (ts.isNumericLiteral(n)) return n.text;
	return undefined; // ignore computed names etc.
}

/**
 * Check if a node is a function-like declaration with the given name
 */
export function isFunctionLikeNamed(node: ts.Node, name: string): boolean {
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
export function isVariableNamed(node: ts.Node, name: string): boolean {
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
export function isNamedNode(node: ts.Node, name: string): boolean {
	return isFunctionLikeNamed(node, name) || isVariableNamed(node, name);
}

/**
 * Check if a node is a call expression with the given name
 */
export function isCallExpressionNamed(node: ts.Node, name: string): boolean {
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
