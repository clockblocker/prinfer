import * as ts from "typescript";
import { TypeScriptInternalError } from "../errors.js";
import type { HoverResult } from "../types.js";
import { getNameNode } from "./node-match.js";
import {
	canonicalOptionals,
	type OptionalFacts,
	type OptionalStep,
} from "./signature-text.js";

/**
 * Get the symbol kind as a string. Kinds follow the labels an editor hover
 * shows (and the TypeScript 7 backend reports): `const`, `let`, `var`,
 * `parameter`, `property`, `method`, and so on. A variable initialized with
 * a function keeps its declaration keyword (`const`), as in the editor; a
 * hover on the callee of a call is `call`. See HoverResult for the list.
 */
export function getSymbolKind(node: ts.Node): string {
	if (ts.isFunctionDeclaration(node)) return "function";
	if (ts.isArrowFunction(node)) return "function";
	if (ts.isFunctionExpression(node)) return "function";
	if (ts.isMethodDeclaration(node)) return "method";
	if (ts.isMethodSignature(node)) return "method";
	if (ts.isConstructorDeclaration(node)) return "constructor";
	if (ts.isVariableDeclaration(node)) return variableKind(node);
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
	const base = {
		line: line + 1,
		column: character + 1,
		documentation,
		kind,
		name,
	};
	const signatureText = (signature: ts.Signature, extra = 0) =>
		signatureString(checker, signature, flags | extra);
	const typeText = (type: ts.Type, extra = 0) =>
		typeString(checker, type, flags | extra);

	// Match TypeScript's hover for an alias declaration, with its type
	// parameters, while disabling the truncation that makes editor hovers
	// unsuitable for type inspection.
	if (ts.isTypeAliasDeclaration(node)) {
		const type = checker.getTypeAtLocation(node.name);
		const expanded = typeText(type, ts.TypeFormatFlags.InTypeAlias);
		return withExtras(
			{
				signature: `type ${node.name.text}${typeParameterList(checker, node, flags)} = ${expanded}`,
				...base,
			},
			{ unionMembers: countUnionMembers(checker, type) },
		);
	}

	// Interfaces and classes: the name with its type parameters, including
	// constraints and defaults, which the type's own text leaves out.
	if (
		(ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) &&
		node.name &&
		node.typeParameters?.length
	) {
		return {
			signature: `${node.name.text}${typeParameterList(checker, node, flags)}`,
			...base,
		};
	}

	// Call expressions: the instantiated signature, with type arguments, as
	// the editor shows it; overloads are the callee's declared signatures.
	if (ts.isCallExpression(node)) {
		const sig = checker.getResolvedSignature(node);
		const callee = checker.getTypeAtLocation(node.expression);
		const overloads = overloadTexts(checker, callee, flags);
		if (sig) {
			const ret = checker.getReturnTypeOfSignature(sig);
			return withExtras(
				{
					signature: signatureText(
						sig,
						ts.TypeFormatFlags.WriteTypeArgumentsOfSignature,
					),
					returnType: typeText(ret),
					...base,
				},
				{ overloads },
			);
		}
		// Fallback: get type of the call result
		const t = checker.getTypeAtLocation(node);
		return withExtras(
			{ signature: typeText(t), ...base },
			{ overloads, unionMembers: countUnionMembers(checker, t) },
		);
	}

	// Function and method declarations: their call signature. A variable or
	// property initialized with a function is shown by its type, below.
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isMethodSignature(node)
	) {
		const sig = checker.getSignatureFromDeclaration(node);
		if (sig) {
			const ret = checker.getReturnTypeOfSignature(sig);
			const ownType = symbol
				? checker.getTypeOfSymbolAtLocation(symbol, node)
				: undefined;
			return withExtras(
				{
					signature: signatureText(sig),
					returnType: typeText(ret),
					...base,
				},
				{
					overloads: ownType
						? overloadTexts(checker, ownType, flags)
						: undefined,
				},
			);
		}
	}

	// Fallback: type at the node location
	const nodeWithName = node as unknown as { name?: ts.Node };
	let targetNode: ts.Node = node;
	if (nodeWithName.name && ts.isIdentifier(nodeWithName.name)) {
		targetNode = nodeWithName.name;
	}

	// An optional property shows the type quick info shows: with
	// exactOptionalPropertyTypes, `digits?: number` is a number when present.
	const t =
		symbol && isOptionalProperty(node)
			? checker.getTypeOfSymbolAtLocation(symbol, targetNode)
			: checker.getTypeAtLocation(targetNode);
	const callSignatures = t.getCallSignatures();
	// A function-typed value reports what its single call signature returns.
	const single =
		callSignatures.length === 1 && t.getProperties().length === 0
			? callSignatures[0]
			: undefined;
	return withExtras(
		{
			signature: typeText(t),
			...(single
				? {
						returnType: typeText(
							checker.getReturnTypeOfSignature(single),
						),
					}
				: {}),
			...base,
		},
		{
			overloads: overloadTexts(checker, t, flags),
			unionMembers: countUnionMembers(checker, t),
		},
	);
}

function withExtras(
	result: HoverResult,
	extras: { overloads?: string[]; unionMembers?: number },
): HoverResult {
	if (extras.overloads) result.overloads = extras.overloads;
	if (extras.unionMembers !== undefined)
		result.unionMembers = extras.unionMembers;
	return result;
}

/** Every call signature of `type`, when there is more than one. */
function overloadTexts(
	checker: ts.TypeChecker,
	type: ts.Type,
	flags: ts.TypeFormatFlags,
): string[] | undefined {
	const signatures = type.getCallSignatures();
	if (signatures.length < 2) return undefined;
	return signatures.map((signature) =>
		signatureString(checker, signature, flags),
	);
}

/**
 * `<R extends UnitRoute = UnitRoute>`: a declaration's type parameters with
 * their modifiers, constraints, and defaults, or "" when it has none.
 */
function typeParameterList(
	checker: ts.TypeChecker,
	declaration: ts.DeclarationWithTypeParameterChildren,
	flags: ts.TypeFormatFlags,
): string {
	const parameters = declaration.typeParameters;
	if (!parameters?.length) return "";
	const text = parameters.map((parameter) => {
		const modifiers =
			parameter.modifiers?.map((modifier) => modifier.getText()) ?? [];
		let part = [...modifiers, parameter.name.text].join(" ");
		if (parameter.constraint) {
			part += ` extends ${typeString(checker, checker.getTypeFromTypeNode(parameter.constraint), flags)}`;
		}
		if (parameter.default) {
			part += ` = ${typeString(checker, checker.getTypeFromTypeNode(parameter.default), flags)}`;
		}
		return part;
	});
	return `<${text.join(", ")}>`;
}

function isOptionalProperty(node: ts.Node): boolean {
	return (
		(ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
		node.questionToken !== undefined
	);
}

/** signatureToString, in canonical form (see core/signature-text.ts). */
function signatureString(
	checker: ts.TypeChecker,
	signature: ts.Signature,
	flags: ts.TypeFormatFlags,
): string {
	return canonicalOptionals(
		checker.signatureToString(signature, undefined, flags),
		"signature",
		(path) => optionalFacts(checker, { signature }, path),
	);
}

/** typeToString, in canonical form (see core/signature-text.ts). */
function typeString(
	checker: ts.TypeChecker,
	type: ts.Type,
	flags: ts.TypeFormatFlags,
): string {
	return canonicalOptionals(
		checker.typeToString(type, undefined, flags),
		"type",
		(path) => optionalFacts(checker, { type }, path),
	);
}

type Walked =
	| { signature: ts.Signature }
	| { type: ts.Type }
	| { symbol: ts.Symbol };

/** Follow a path from a printed signature or type to an optional slot. */
function optionalFacts(
	checker: ts.TypeChecker,
	root: Walked,
	path: readonly OptionalStep[],
): OptionalFacts | undefined {
	let current = root;
	for (const step of path) {
		if ("param" in step || "returns" in step) {
			if (!("signature" in current)) return undefined;
			if ("returns" in step) {
				current = {
					type: checker.getReturnTypeOfSignature(current.signature),
				};
				continue;
			}
			const symbol = current.signature.getParameters()[step.param];
			if (!symbol) return undefined;
			current = { symbol };
			continue;
		}
		if ("signature" in current) return undefined;
		const type = checker.getNonNullableType(
			"symbol" in current
				? checker.getTypeOfSymbol(current.symbol)
				: current.type,
		);
		if ("property" in step) {
			const symbol = checker.getPropertyOfType(type, step.property);
			if (!symbol) return undefined;
			current = { symbol };
		} else {
			const signature = type.getCallSignatures()[step.signature];
			if (!signature) return undefined;
			current = { signature };
		}
	}
	if (!("symbol" in current)) return undefined;
	const declaration = current.symbol.valueDeclaration;
	if (
		!declaration ||
		!(
			ts.isParameter(declaration) ||
			ts.isPropertySignature(declaration) ||
			ts.isPropertyDeclaration(declaration)
		) ||
		!declaration.questionToken ||
		!declaration.type
	) {
		return {
			declaredOptional: false,
			annotationIncludesUndefined: false,
			addsOnlyUndefined: false,
		};
	}
	const members = (type: ts.Type) => (type.isUnion() ? type.types : [type]);
	const annotated = members(checker.getTypeFromTypeNode(declaration.type));
	const added = members(checker.getTypeOfSymbol(current.symbol)).filter(
		(member) => !(member.flags & ts.TypeFlags.Undefined),
	);
	return {
		declaredOptional: true,
		annotationIncludesUndefined: annotated.some(
			(member) =>
				member.flags &
				(ts.TypeFlags.Undefined |
					ts.TypeFlags.Any |
					ts.TypeFlags.Unknown),
		),
		addsOnlyUndefined:
			added.length === annotated.length &&
			added.every((member) => annotated.includes(member)),
	};
}

/**
 * Members of a union type as TypeScript displays them: `true | false`
 * counts once (as `boolean`), and a complete set of an enum's members
 * counts once (as the enum). A union that displays as one member, such as
 * `boolean` or an enum type, is not reported.
 */
export function countUnionMembers(
	checker: ts.TypeChecker,
	type: ts.Type,
): number | undefined {
	if (!type.isUnion() || type.flags & ts.TypeFlags.Boolean) return undefined;
	let count = type.types.length;
	const booleans = type.types.filter(
		(member) => member.flags & ts.TypeFlags.BooleanLiteral,
	);
	if (booleans.length >= 2) count -= 1;
	const enumMembers = new Map<ts.Symbol, number>();
	for (const member of type.types) {
		if (!(member.flags & ts.TypeFlags.EnumLiteral)) continue;
		const parent = (member.symbol as { parent?: ts.Symbol } | undefined)
			?.parent;
		if (parent) enumMembers.set(parent, (enumMembers.get(parent) ?? 0) + 1);
	}
	for (const [enumSymbol, present] of enumMembers) {
		const enumType = checker.getDeclaredTypeOfSymbol(enumSymbol);
		const total = enumType.isUnion() ? enumType.types.length : 1;
		if (present > 1 && present === total) count -= present - 1;
	}
	return count > 1 ? count : undefined;
}
