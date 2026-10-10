import * as ts from "typescript";
import { parsePrintedType } from "./union-order.js";

/*
 * Readability checks on printed type text (`typeprobe/testing`'s
 * `readable` option and `typeReadabilityIssues`).
 *
 * A type can be correct and still print in a form a reader has to work
 * out: `Omit<User, "id">` instead of the object it produces, `User & {
 * id: string; }` instead of one object, or text TypeScript cut short. The
 * text is read with the TypeScript scanner and parser, never by matching
 * characters, so a string literal type such as `"Omit<"` or `"..."` is
 * not mistaken for what it spells.
 */

/** The checks `typeReadabilityIssues` runs. */
export type ReadabilityRule =
	| "utility-type"
	| "object-intersection"
	| "truncation";

/** One place where a printed type reads worse than it could. */
export interface ReadabilityIssue {
	rule: ReadabilityRule;
	/** The offending part of the printed type, exactly as printed. */
	text: string;
	/** 0-based offset of `text` in the printed type. */
	offset: number;
	/** What is wrong with it, in one sentence. */
	message: string;
}

/**
 * Which checks run. Every rule is on by default; `{}` and `true` mean the
 * defaults.
 */
export interface ReadabilityRules {
	/**
	 * Type names flagged wherever they appear with type arguments, at any
	 * depth: TypeScript printed the alias instead of the type it produces.
	 * Default `DEFAULT_UTILITY_TYPES`. Add your own aliases with
	 * `[...DEFAULT_UTILITY_TYPES, "DeepPartial"]`; `false` turns the rule
	 * off. A reference over a type parameter of the printed signature
	 * (`Omit<T, "id">` in `<T>(value: T) => Omit<T, "id">`) is not flagged:
	 * nothing can resolve it before `T` is known.
	 */
	utilityTypes?: readonly string[] | false;
	/**
	 * Flag intersections with an object type (`User & { id: string; }`,
	 * a mapped type too). `string & {}`, which keeps literal suggestions,
	 * is not flagged. Default true.
	 */
	objectIntersections?: boolean;
	/**
	 * Flag TypeScript's truncation: `... 3 more ...`, `{ ...; }`, a `...`
	 * placeholder, and text cut at the length limit. `typeprobe/testing`
	 * prints untruncated types unless `full: false`. Default true.
	 */
	truncation?: boolean;
	/**
	 * Fragments that are fine as printed: an issue whose `text` equals one
	 * of these is not reported, e.g. a branded
	 * `string & { readonly __brand: "UserId"; }`.
	 */
	allow?: readonly string[];
}

/** The utility types `utilityTypes` flags by default. */
export const DEFAULT_UTILITY_TYPES: readonly string[] = [
	"Omit",
	"Pick",
	"Partial",
	"Required",
	"Readonly",
	"Exclude",
	"Extract",
	"NonNullable",
	"ReturnType",
	"Parameters",
	"ConstructorParameters",
	"InstanceType",
	"Awaited",
	"ThisParameterType",
	"OmitThisParameter",
];

/**
 * Every readability issue in printed type text, in the order they appear.
 * Accepts each shape a hover signature takes (a type, a call signature, a
 * type alias). The rules run on the text with any truncation markers
 * blanked out; text that still does not parse (cut at the length limit)
 * gets the truncation issues only.
 */
export function typeReadabilityIssues(
	printed: string,
	rules: ReadabilityRules = {},
): ReadabilityIssue[] {
	const {
		utilityTypes = DEFAULT_UTILITY_TYPES,
		objectIntersections = true,
		truncation = true,
		allow = [],
	} = rules;
	const markers = truncationMarkers(printed);
	const issues: ReadabilityIssue[] = truncation ? [...markers] : [];

	let repaired = printed;
	for (const marker of markers) {
		repaired =
			repaired.slice(0, marker.offset) +
			"_".repeat(marker.text.length) +
			repaired.slice(marker.offset + marker.text.length);
	}
	const parsed = parsePrintedType(repaired);
	if (parsed) {
		const { source, shape } = parsed;
		const flagged = new Set(utilityTypes || []);
		const typeParameters = declaredTypeParameters(source);
		const issue = (
			rule: ReadabilityRule,
			node: ts.Node,
			message: (text: string) => string,
		): void => {
			const offset = node.getStart(source) - shape.prefix.length;
			const text = printed.slice(offset, node.end - shape.prefix.length);
			issues.push({ rule, text, offset, message: message(text) });
		};
		// An issue's own subtree is not checked again for the same rule.
		const visit = (
			node: ts.Node,
			underUtility: boolean,
			underObject: boolean,
		): void => {
			let inUtility = underUtility;
			let inObject = underObject;
			if (
				!inUtility &&
				ts.isTypeReferenceNode(node) &&
				ts.isIdentifier(node.typeName) &&
				node.typeArguments?.length &&
				flagged.has(node.typeName.text) &&
				!node.typeArguments.some((argument) =>
					mentions(argument, typeParameters),
				)
			) {
				const name = node.typeName.text;
				issue(
					"utility-type",
					node,
					(text) =>
						`${text} is unresolved: TypeScript printed ${name}<...> instead of the type it produces.`,
				);
				inUtility = true;
			}
			if (
				objectIntersections &&
				!inObject &&
				ts.isIntersectionTypeNode(node) &&
				node.types.some(isObjectType)
			) {
				issue(
					"object-intersection",
					node,
					(text) =>
						`${text} intersects an object type; one object type would read better.`,
				);
				inObject = true;
			}
			ts.forEachChild(node, (child) => visit(child, inUtility, inObject));
		};
		visit(source.statements[0] as ts.Statement, false, false);
	}

	return issues
		.filter((found) => !allow.includes(found.text))
		.sort((left, right) => left.offset - right.offset);
}

/** Truncation markers, found by token so string literals don't count. */
function truncationMarkers(text: string): ReadabilityIssue[] {
	const tokens = scanTokens(text);
	const markers: ReadabilityIssue[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as Token;
		if (token.kind !== ts.SyntaxKind.DotDotDotToken) continue;
		const next = tokens[index + 1];
		const more = tokens[index + 2];
		const close = tokens[index + 3];
		if (
			next?.kind === ts.SyntaxKind.NumericLiteral &&
			more?.kind === ts.SyntaxKind.Identifier &&
			more.text === "more" &&
			close?.kind === ts.SyntaxKind.DotDotDotToken
		) {
			const marked = text.slice(token.start, close.end);
			markers.push({
				rule: "truncation",
				text: marked,
				offset: token.start,
				message: `${marked} stands for ${next.text} members TypeScript left out.`,
			});
			index += 3;
			continue;
		}
		if (next && startsTypeOrName(next.kind)) continue;
		markers.push({
			rule: "truncation",
			text: "...",
			offset: token.start,
			message:
				next === undefined
					? "TypeScript cut the text short at its length limit."
					: "... stands for a part of the type TypeScript left out.",
		});
	}
	return markers;
}

interface Token {
	kind: ts.SyntaxKind;
	start: number;
	end: number;
	text: string;
}

/** The tokens of `text`, with template literal types scanned whole. */
function scanTokens(text: string): Token[] {
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		true,
		ts.LanguageVariant.Standard,
		text,
	);
	const tokens: Token[] = [];
	// Brace depth at each open `${`, so its `}` resumes the template.
	const templates: number[] = [];
	let depth = 0;
	for (;;) {
		let kind = scanner.scan();
		if (kind === ts.SyntaxKind.EndOfFileToken) break;
		if (kind === ts.SyntaxKind.OpenBraceToken) depth++;
		if (kind === ts.SyntaxKind.CloseBraceToken) {
			if (templates.at(-1) === depth) {
				kind = scanner.reScanTemplateToken(false);
				if (kind === ts.SyntaxKind.TemplateTail) templates.pop();
			} else {
				depth--;
			}
		}
		if (kind === ts.SyntaxKind.TemplateHead) templates.push(depth);
		tokens.push({
			kind,
			start: scanner.getTokenStart(),
			end: scanner.getTokenEnd(),
			text: scanner.getTokenText(),
		});
	}
	return tokens;
}

/** A token after `...` that makes it a rest or spread, not a placeholder. */
function startsTypeOrName(kind: ts.SyntaxKind): boolean {
	return (
		kind === ts.SyntaxKind.Identifier ||
		(kind >= ts.SyntaxKind.FirstKeyword &&
			kind <= ts.SyntaxKind.LastKeyword) ||
		kind === ts.SyntaxKind.OpenBracketToken ||
		kind === ts.SyntaxKind.OpenParenToken ||
		kind === ts.SyntaxKind.OpenBraceToken ||
		kind === ts.SyntaxKind.LessThanToken ||
		kind === ts.SyntaxKind.StringLiteral ||
		kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
		kind === ts.SyntaxKind.TemplateHead
	);
}

/** Type parameter names declared anywhere in the printed text. */
function declaredTypeParameters(source: ts.SourceFile): Set<string> {
	const names = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isTypeParameterDeclaration(node)) names.add(node.name.text);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return names;
}

/** Whether `node` refers to one of `names`, or to `this`. */
function mentions(node: ts.Node, names: Set<string>): boolean {
	if (node.kind === ts.SyntaxKind.ThisType) return true;
	if (
		ts.isTypeReferenceNode(node) &&
		ts.isIdentifier(node.typeName) &&
		names.has(node.typeName.text)
	) {
		return true;
	}
	return ts.forEachChild(node, (child) => mentions(child, names)) ?? false;
}

/** An object type literal with members, or a mapped type. */
function isObjectType(node: ts.TypeNode): boolean {
	let inner = node;
	while (ts.isParenthesizedTypeNode(inner)) inner = inner.type;
	return (
		(ts.isTypeLiteralNode(inner) && inner.members.length > 0) ||
		ts.isMappedTypeNode(inner)
	);
}
