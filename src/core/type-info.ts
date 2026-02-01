import ts from "typescript";
import { TypeScriptInternalError } from "../errors.js";
import type { InferredTypeResult } from "../types.js";
import { getLineNumber, isArrowOrFnExpr } from "./node-match.js";

/**
 * Get type information for a node
 */
export function getTypeInfo(
	program: ts.Program,
	node: ts.Node,
	sourceFile?: ts.SourceFile,
): InferredTypeResult {
	// Call getTypeChecker() first to ensure parent references are set up
	// (this makes node.getSourceFile() work)
	const checker = program.getTypeChecker();
	const sf = sourceFile ?? node.getSourceFile();

	try {
		return getTypeInfoImpl(checker, node, sf);
	} catch (error) {
		if (error instanceof Error) {
			let line: number | undefined;
			try {
				if (sf) line = getLineNumber(sf, node);
			} catch {
				// Ignore if we can't get line number
			}
			throw new TypeScriptInternalError({
				file: sf?.fileName ?? "unknown",
				line,
				operation: "getting type information",
				cause: error,
			});
		}
		throw error;
	}
}

function getTypeInfoImpl(
	checker: ts.TypeChecker,
	node: ts.Node,
	sourceFile: ts.SourceFile,
): InferredTypeResult {
	const sf = sourceFile;
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
