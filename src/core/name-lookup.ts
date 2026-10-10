import { TypeprobeError } from "../errors.js";
import type { HoverAlternative } from "../types.js";
import { getSymbolKind } from "./hover.js";
import { findNodeByNameAndLine } from "./node-find.js";
import {
	getNameNode,
	isNamedNode,
	isOtherDeclarationNamed,
} from "./node-match.js";
import { ts } from "./ts-runtime.js";

/** At most this many alternatives are reported for an ambiguous name. */
export const MAX_ALTERNATIVES = 10;
/** At most this many declarations or lines are listed for a missed line. */
const MAX_LISTED = 20;

/**
 * A failed name lookup. When the name is declared in the file but not on
 * the requested line, `declaredAt` lists where it is, and the suggestion
 * names those lines.
 */
export class NameNotFoundError extends TypeprobeError {
	readonly declaredAt?: HoverAlternative[];

	constructor(
		message: string,
		suggestion: string | undefined,
		declaredAt: HoverAlternative[] | undefined,
	) {
		super("SYMBOL_NOT_FOUND", message, suggestion);
		this.name = "NameNotFoundError";
		if (declaredAt?.length) this.declaredAt = declaredAt;
	}
}

/**
 * Every declaration of `name` in the file, in document order: the
 * declarations `findNodeByNameAndLine` can pick (functions, variables, type
 * aliases, parameters, classes, interfaces, enums, members, bindings).
 */
export function findDeclarationsByName(
	sourceFile: ts.SourceFile,
	name: string,
): ts.Node[] {
	const found: ts.Node[] = [];
	const visit = (node: ts.Node): void => {
		if (isNamedNode(node, name) || isOtherDeclarationNamed(node, name)) {
			found.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

/** Where a declaration's name token is (1-based) and what kind it is. */
export function declarationLocation(
	sourceFile: ts.SourceFile,
	node: ts.Node,
): HoverAlternative {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		getNameNode(node).getStart(sourceFile),
	);
	const kind = getSymbolKind(node);
	return {
		line: line + 1,
		column: character + 1,
		...(kind === "unknown" || kind === "identifier" ? {} : { kind }),
	};
}

/**
 * Declarations of the same name as `picked` that the lookup did not pick,
 * so callers can tell that a name lookup was ambiguous. Overload and merged
 * declarations of the picked symbol (same scope, same declaration kind) are
 * left out: they are one symbol, whose signatures `overloads` lists.
 */
export function alternativeDeclarations(
	sourceFile: ts.SourceFile,
	name: string,
	picked: ts.Node,
): HoverAlternative[] | undefined {
	const pickedName = getNameNode(picked);
	const alternatives = findDeclarationsByName(sourceFile, name)
		.filter(
			(node) =>
				node !== picked &&
				getNameNode(node) !== pickedName &&
				!sameSymbolDeclaration(node, picked),
		)
		.slice(0, MAX_ALTERNATIVES)
		.map((node) => declarationLocation(sourceFile, node));
	return alternatives.length ? alternatives : undefined;
}

function sameSymbolDeclaration(left: ts.Node, right: ts.Node): boolean {
	return (
		left.parent === right.parent &&
		mergeableKind(left) !== undefined &&
		mergeableKind(left) === mergeableKind(right)
	);
}

/** Declarations TypeScript merges into one symbol when they share a scope. */
function mergeableKind(node: ts.Node): string | undefined {
	if (ts.isFunctionDeclaration(node)) return "function";
	if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
		return "method";
	if (ts.isInterfaceDeclaration(node)) return "interface";
	if (ts.isModuleDeclaration(node)) return "namespace";
	if (ts.isEnumDeclaration(node)) return "enum";
	return undefined;
}

export interface NameLookup {
	node: ts.Node;
	/** Other declarations of the name; only for lookups without a line. */
	alternatives?: HoverAlternative[];
}

/**
 * Find a symbol by name as every backend does (see findNodeByNameAndLine),
 * or throw a SYMBOL_NOT_FOUND error that says where the name is declared
 * when a line hint missed. `displayFile` is the path quoted in the message.
 */
export function lookupName(
	sourceFile: ts.SourceFile,
	name: string,
	line: number | undefined,
	displayFile: string,
): NameLookup {
	const node = findNodeByNameAndLine(sourceFile, name, line);
	if (!node) throw nameNotFoundError(sourceFile, name, line, displayFile);
	const alternatives =
		line === undefined
			? alternativeDeclarations(sourceFile, name, node)
			: undefined;
	return alternatives ? { node, alternatives } : { node };
}

/**
 * The error for a name that matches nothing (on `line`, when given). If
 * the name is declared, or at least used, elsewhere in the file, the
 * suggestion lists those lines and `declaredAt` the declarations.
 */
export function nameNotFoundError(
	sourceFile: ts.SourceFile,
	name: string,
	line: number | undefined,
	displayFile: string,
): NameNotFoundError {
	const lineInfo = line !== undefined ? ` at line ${line}` : "";
	const message = `No symbol named "${name}"${lineInfo} found in ${displayFile}`;
	if (line === undefined) {
		return new NameNotFoundError(message, undefined, undefined);
	}
	const declaredAt = findDeclarationsByName(sourceFile, name).map((node) =>
		declarationLocation(sourceFile, node),
	);
	if (declaredAt.length > 0) {
		return new NameNotFoundError(
			message,
			`"${name}" is declared on ${lineList(declaredAt.map((at) => at.line))}; pass one of those as the line, or omit the line.`,
			declaredAt.slice(0, MAX_LISTED),
		);
	}
	const usedOn = identifierLines(sourceFile, name);
	return new NameNotFoundError(
		message,
		usedOn.length > 0
			? `"${name}" is not declared in this file but appears on ${lineList(usedOn)}; pass one of those as the line, or omit the line.`
			: undefined,
		undefined,
	);
}

function lineList(lines: number[]): string {
	const unique = [...new Set(lines)];
	const shown = unique.slice(0, MAX_LISTED);
	const more = unique.length - shown.length;
	return `${shown.length === 1 ? "line" : "lines"} ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function identifierLines(sourceFile: ts.SourceFile, name: string): number[] {
	const lines: number[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === name) {
			lines.push(
				sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile),
				).line + 1,
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return lines;
}
