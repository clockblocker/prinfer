// Printed text is parsed with the bundled TypeScript, never a project's
// (see ts-runtime.ts): the text is the same whichever compiler printed it,
// and the syntax kinds compared here are the bundled package's.
import * as ts from "typescript";
import type { HoverResult } from "../types.js";

/*
 * Union members in a deterministic order (the `sort_unions` option).
 *
 * TypeScript 6 prints a union's members in the order their types were
 * created, TypeScript 7 in an order of its own, so `"a" | "b"` on one
 * backend can be `"b" | "a"` on the other. Sorting the printed members
 * makes the text the same on both.
 *
 * The printed text is parsed with the TypeScript parser and every union in
 * it is sorted, at any depth: in object properties, parameters, return
 * types, type arguments, type parameter constraints, and inside other
 * unions' members (which are sorted by their already sorted text). Text
 * that does not parse, such as a type TypeScript truncated with `...`, is
 * returned as printed.
 */

/**
 * The union members of `result`'s signature, returnType, and overloads in
 * sorted order (see sortUnionMembers). `display`, the editor's hover text,
 * is left as the editor shows it.
 */
export function sortResultUnions(result: HoverResult): HoverResult {
	result.signature = sortUnionMembers(result.signature);
	if (result.returnType !== undefined) {
		result.returnType = sortUnionMembers(result.returnType);
	}
	if (result.overloads) {
		result.overloads = result.overloads.map(sortUnionMembers);
	}
	return result;
}

/**
 * Sort the members of every union in printed type text: `null` and then
 * `undefined` last, every other member by its text, compared by UTF-16
 * code unit (independent of locale). Accepts each shape a
 * HoverResult.signature takes: a type, a call signature `<T>(x: T): T`, a
 * type alias `type A<T> = ...`, and a declaration name with type
 * parameters `Box<T extends string>`.
 */
export function sortUnionMembers(text: string): string {
	if (!text.includes("|")) return text;
	const parsed = parsePrintedType(text);
	return parsed ? sortedText(parsed.source, parsed.shape) : text;
}

/**
 * Printed type text parsed as one statement, in the first shape it fits
 * without errors (see sortUnionMembers); undefined when none fits. The
 * text sits in `source` at `shape.prefix.length`.
 */
export function parsePrintedType(
	text: string,
): { source: ts.SourceFile; shape: Shape } | undefined {
	for (const shape of SHAPES) {
		const source = parseShape(text, shape);
		if (source) return { source, shape };
	}
	return undefined;
}

/** A statement that holds printed text between a prefix and a suffix. */
export interface Shape {
	prefix: string;
	suffix: string;
	kind: ts.SyntaxKind;
}

const SHAPES: readonly Shape[] = [
	{
		prefix: "type T = ",
		suffix: ";",
		kind: ts.SyntaxKind.TypeAliasDeclaration,
	},
	{
		prefix: "declare function f",
		suffix: ";",
		kind: ts.SyntaxKind.FunctionDeclaration,
	},
	{ prefix: "", suffix: ";", kind: ts.SyntaxKind.TypeAliasDeclaration },
	// A class accepts every type parameter modifier (in, out, const).
	{
		prefix: "declare class ",
		suffix: " {}",
		kind: ts.SyntaxKind.ClassDeclaration,
	},
];

/** `text` parsed in `shape`, when it is one statement without errors. */
function parseShape(text: string, shape: Shape): ts.SourceFile | undefined {
	const source = ts.createSourceFile(
		"printed.ts",
		`${shape.prefix}${text}${shape.suffix}`,
		ts.ScriptTarget.Latest,
		true,
	);
	const { parseDiagnostics } = source as unknown as {
		parseDiagnostics?: readonly unknown[];
	};
	if (parseDiagnostics?.length) return undefined;
	const [statement, ...rest] = source.statements;
	return statement?.kind === shape.kind && rest.length === 0
		? source
		: undefined;
}

/** The printed text, parsed in `shape`, with every union in it sorted. */
function sortedText(source: ts.SourceFile, shape: Shape): string {
	const statement = source.statements[0] as ts.Statement;
	const { text } = source;
	const sorted =
		text.slice(0, statement.getStart(source)) +
		renderNode(statement, source) +
		text.slice(statement.end);
	return sorted.slice(
		shape.prefix.length,
		sorted.length - shape.suffix.length,
	);
}

/**
 * The text of `node` with every union in it sorted, members by their own
 * sorted text. Everything else (punctuation, keywords, spaces) is copied,
 * so only the order of members changes.
 */
function renderNode(node: ts.Node, source: ts.SourceFile): string {
	if (ts.isUnionTypeNode(node)) {
		return node.types
			.map((member) => renderNode(member, source))
			.sort(compareMembers)
			.join(" | ");
	}
	const text = source.text;
	let out = "";
	let position = node.getStart(source);
	ts.forEachChild(node, (child) => {
		const start = child.getStart(source);
		out += text.slice(position, start) + renderNode(child, source);
		position = child.end;
	});
	return out + text.slice(position, node.end);
}

/** `null` and `undefined` last, in that order, as tsc prints them. */
function nullishRank(member: string): number {
	if (member === "null") return 1;
	if (member === "undefined") return 2;
	return 0;
}

function compareMembers(left: string, right: string): number {
	const rank = nullishRank(left) - nullishRank(right);
	if (rank !== 0) return rank;
	return left < right ? -1 : left > right ? 1 : 0;
}
