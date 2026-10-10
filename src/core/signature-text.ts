// Printed text is parsed with the bundled TypeScript, never a project's
// (see ts-runtime.ts): the text is the same whichever compiler printed it,
// and the syntax kinds compared here are the bundled package's.
import * as ts from "typescript";

/**
 * Collapse a multi-line type, as an editor hover prints it, onto one line
 * the way TypeScript 6's typeToString writes it:
 * `{\n    id: number;\n}` becomes `{ id: number; }`, and a tuple printed
 * one element per line, `[\n    string,\n    number\n]`, becomes
 * `[string, number]`.
 */
export function singleLine(text: string): string {
	return text
		.replace(/\[\s*\n\s*/g, "[")
		.replace(/\s*\n\s*\]/g, "]")
		.replace(/[^\S\n]*\n\s*/g, " ")
		.trim();
}

/**
 * `Array<T>` and `ReadonlyArray<T>` written the way typeToString writes
 * them, `T[]` and `readonly T[]`, with the parentheses it adds:
 * `Array<string | number>` becomes `(string | number)[]`. The TypeScript 7
 * language server reuses a declaration's annotation, so its hover keeps
 * whichever spelling the source used; the checker backends print `T[]`.
 */
export function arraySyntax(text: string): string {
	if (!/\b(?:Readonly)?Array</.test(text)) return text;
	const tokens = scanTokens(text);
	let result = "";
	let copied = 0;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as Token;
		const readonly = token.text === "ReadonlyArray";
		if (
			(token.text !== "Array" && !readonly) ||
			tokens[index - 1]?.kind === ts.SyntaxKind.DotToken ||
			tokens[index + 1]?.kind !== ts.SyntaxKind.LessThanToken
		) {
			continue;
		}
		const close = singleTypeArgumentEnd(tokens, index + 1);
		if (close === undefined) continue;
		const after = tokens[close + 1]?.kind;
		// `Array<T>(…)` is a method named Array, not the array type.
		if (after === ts.SyntaxKind.OpenParenToken) continue;
		const element = arraySyntax(
			text
				.slice(
					(tokens[index + 2] as Token).start,
					(tokens[close] as Token).start,
				)
				.trim(),
		);
		let array = `${needsParentheses(element) ? `(${element})` : element}[]`;
		if (readonly) {
			array = `readonly ${array}`;
			// `ReadonlyArray<T>[]` is `(readonly T[])[]`.
			if (after === ts.SyntaxKind.OpenBracketToken) array = `(${array})`;
		}
		result += text.slice(copied, token.start) + array;
		copied = (tokens[close] as Token).end;
		index = close;
	}
	return result + text.slice(copied);
}

/** A declared type parameter's name and its `const`, `in`, `out` modifiers. */
export interface TypeParameterModifiers {
	name: string;
	modifiers: readonly string[];
}

/**
 * The heading of a type alias, `type Name<T> = …`, or of a class or
 * interface, `Name<T>`, with the type parameter modifiers the declaration
 * has: `Holder<T extends 1 | 2>` becomes `Holder<const T extends 1 | 2>`.
 * The TypeScript 7 language server leaves `const`, `in`, and `out` out of
 * these hovers (not out of function and method signatures).
 */
export function withTypeParameterModifiers(
	text: string,
	parameters: readonly TypeParameterModifiers[],
): string {
	if (!parameters.some((parameter) => parameter.modifiers.length > 0)) {
		return text;
	}
	const alias = text.startsWith("type ");
	const prefix = alias ? "" : "interface ";
	const declaration = parse(`${prefix}${text}${alias ? ";" : " {}"}`)
		.statements[0];
	if (
		!declaration ||
		!(
			ts.isTypeAliasDeclaration(declaration) ||
			ts.isInterfaceDeclaration(declaration)
		)
	) {
		return text;
	}
	const insertions: Array<[number, string]> = [];
	declaration.typeParameters?.forEach((printed, index) => {
		const declared = parameters[index];
		if (
			!declared?.modifiers.length ||
			printed.modifiers?.length ||
			printed.name.text !== declared.name
		) {
			return;
		}
		insertions.push([
			printed.name.getStart() - prefix.length,
			`${declared.modifiers.join(" ")} `,
		]);
	});
	let result = text;
	for (const [at, modifiers] of insertions.reverse()) {
		result = result.slice(0, at) + modifiers + result.slice(at);
	}
	return result;
}

interface Token {
	kind: ts.SyntaxKind;
	text: string;
	start: number;
	end: number;
}

/** The tokens of printed type text, template literal types included. */
function scanTokens(text: string): Token[] {
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		true,
		ts.LanguageVariant.Standard,
		text,
	);
	const tokens: Token[] = [];
	// Open braces, and `${` of template literal types, still unclosed.
	const braces: boolean[] = [];
	for (
		let kind = scanner.scan();
		kind !== ts.SyntaxKind.EndOfFileToken;
		kind = scanner.scan()
	) {
		if (kind === ts.SyntaxKind.CloseBraceToken && braces.at(-1)) {
			kind = scanner.reScanTemplateToken(false);
			if (kind === ts.SyntaxKind.TemplateTail) braces.pop();
		} else if (kind === ts.SyntaxKind.CloseBraceToken) {
			braces.pop();
		} else if (kind === ts.SyntaxKind.OpenBraceToken) {
			braces.push(false);
		} else if (kind === ts.SyntaxKind.TemplateHead) {
			braces.push(true);
		}
		tokens.push({
			kind,
			text: scanner.getTokenText(),
			start: scanner.getTokenStart(),
			end: scanner.getTokenEnd(),
		});
	}
	return tokens;
}

/**
 * The index of the `>` closing the `<` at `open`, when the brackets hold
 * a single type argument; undefined when unbalanced or there are several.
 */
function singleTypeArgumentEnd(
	tokens: readonly Token[],
	open: number,
): number | undefined {
	let depth = 0;
	for (let index = open; index < tokens.length; index++) {
		switch ((tokens[index] as Token).kind) {
			case ts.SyntaxKind.LessThanToken:
			case ts.SyntaxKind.OpenParenToken:
			case ts.SyntaxKind.OpenBracketToken:
			case ts.SyntaxKind.OpenBraceToken:
			case ts.SyntaxKind.TemplateHead:
				depth++;
				break;
			case ts.SyntaxKind.GreaterThanToken:
			case ts.SyntaxKind.CloseParenToken:
			case ts.SyntaxKind.CloseBracketToken:
			case ts.SyntaxKind.CloseBraceToken:
			case ts.SyntaxKind.TemplateTail:
				depth--;
				if (depth === 0) {
					const kind = (tokens[index] as Token).kind;
					return kind === ts.SyntaxKind.GreaterThanToken &&
						index > open + 1
						? index
						: undefined;
				}
				break;
			case ts.SyntaxKind.CommaToken:
				if (depth === 1) return undefined;
		}
	}
	return undefined;
}

/** Whether `T[]` needs `(T)[]` for this element type, as printers add. */
function needsParentheses(element: string): boolean {
	const alias = parse(`type T = ${element};`).statements[0];
	if (!alias || !ts.isTypeAliasDeclaration(alias)) return false;
	switch (alias.type.kind) {
		case ts.SyntaxKind.UnionType:
		case ts.SyntaxKind.IntersectionType:
		case ts.SyntaxKind.FunctionType:
		case ts.SyntaxKind.ConstructorType:
		case ts.SyntaxKind.ConditionalType:
		case ts.SyntaxKind.TypeOperator:
		case ts.SyntaxKind.TypeQuery:
		case ts.SyntaxKind.InferType:
			return true;
		default:
			return false;
	}
}

/*
 * Optional parameters and properties in canonical signatures.
 *
 * `tsc` writes `function f(digits?: number)` back as `digits?: number` in
 * declaration emit and quick info (and so the TypeScript 7 language
 * server), because it reuses the annotation. The checker's typeToString and
 * signatureToString, used by the TypeScript 6 and TypeScript 7 API
 * backends, print the parameter's type instead, with the `| undefined` the
 * `?` implies: `digits?: number | undefined`.
 *
 * The canonical form is tsc's: an optional parameter or property drops the
 * `| undefined` that its `?` added, and keeps one its annotation wrote
 * (`digits?: number | undefined` stays). The `| undefined` stays too where
 * the type is not the annotation's, as in an instantiated generic
 * (`y?: number | undefined` for `y?: T`) or a mapped type (`Partial<T>`).
 *
 * The printed text cannot tell an implied `| undefined` from a written one,
 * so each backend answers that from its checker (OptionalFacts) for the
 * slots that optionalSlots finds, and dropImpliedUndefined edits the text.
 */

/** A step from a printed signature or type to a parameter or property in it. */
export type OptionalStep =
	/** The nth parameter of a signature, not counting `this` */
	| { param: number }
	/** The return type of a signature */
	| { returns: true }
	/** A property of a type, without its null and undefined */
	| { property: string }
	/** The nth call signature of a type, without its null and undefined */
	| { signature: number }
	/** The nth construct signature of a type, without its null and undefined */
	| { construct: number }
	/** The value type of the nth index signature of a type */
	| { index: number }
	/** The element type of an array (0) or the nth element of a tuple */
	| { element: number }
	/**
	 * The nth type argument of `Name<...>`: the type alias's when the type
	 * is an instance of an alias called `of`, else the class's or interface's
	 */
	| { typeArgument: number; of: string }
	/**
	 * The nth of `members` printed members of a union or intersection, not
	 * counting null and undefined, with `true | false` printed as `boolean`
	 */
	| { member: number; members: number };

/** An optional parameter or property printed with `| undefined`. */
export interface OptionalSlot {
	/** From the printed signature or type to the parameter or property */
	path: OptionalStep[];
	/** Text ranges [start, end) to delete to drop the `| undefined` */
	edits: Array<[number, number]>;
}

/** What the checker says about the parameter or property at a slot. */
export interface OptionalFacts {
	/** Its declaration has `?` and a type annotation. */
	declaredOptional: boolean;
	/** The annotation includes undefined (or is any or unknown). */
	annotationIncludesUndefined: boolean;
	/** Its type is the annotation's type plus undefined, and nothing else. */
	addsOnlyUndefined: boolean;
}

/** Text a backend printed: a call signature `<T>(x: T): T`, or a type. */
export type PrintedShape = "signature" | "type";

/** Whether the `| undefined` at a slot is the one its `?` implies. */
export function impliedUndefined(facts: OptionalFacts | undefined): boolean {
	return (
		facts?.declaredOptional === true &&
		!facts.annotationIncludesUndefined &&
		facts.addsOnlyUndefined
	);
}

/**
 * The optional parameters and properties in printed text whose type ends
 * in `| undefined`, with the path to each. Looks wherever an object type
 * literal or a function type can be printed: parameters and return types,
 * properties, call, construct, and index signatures, arrays and tuples,
 * type arguments, and union and intersection members. Other types
 * (conditional, mapped, indexed access) are left alone.
 */
export function optionalSlots(
	text: string,
	shape: PrintedShape,
): OptionalSlot[] {
	if (!text.includes("?") || !text.includes("undefined")) return [];
	const slots: OptionalSlot[] = [];
	if (shape === "type") {
		const prefix = "type T = ";
		const source = parse(`${prefix}${text};`);
		const alias = source.statements[0];
		if (alias && ts.isTypeAliasDeclaration(alias)) {
			slotsOfType(alias.type, [], {
				source,
				offset: prefix.length,
				slots,
			});
		}
		return slots;
	}
	const start = typeArgumentsEnd(text);
	if (start === undefined) return [];
	const prefix = "declare function f";
	const source = parse(`${prefix}${text.slice(start)};`);
	const declaration = source.statements[0];
	if (declaration && ts.isFunctionDeclaration(declaration)) {
		slotsOfSignature(declaration, [], {
			source,
			offset: prefix.length - start,
			slots,
		});
	}
	return slots;
}

/** Drop the `| undefined` at each slot whose facts say it is implied. */
export function dropImpliedUndefined(
	text: string,
	slots: readonly OptionalSlot[],
	facts: ReadonlyArray<OptionalFacts | undefined>,
): string {
	const edits = slots
		.flatMap((slot, index) =>
			impliedUndefined(facts[index]) ? slot.edits : [],
		)
		.sort((left, right) => right[0] - left[0]);
	let result = text;
	for (const [start, end] of edits) {
		result = result.slice(0, start) + result.slice(end);
	}
	return result;
}

/**
 * Printed text in canonical form, asking `facts` about each optional slot.
 * See dropImpliedUndefined.
 */
export function canonicalOptionals(
	text: string,
	shape: PrintedShape,
	facts: (path: OptionalStep[]) => OptionalFacts | undefined,
): string {
	const slots = optionalSlots(text, shape);
	if (slots.length === 0) return text;
	return dropImpliedUndefined(
		text,
		slots,
		slots.map((slot) => {
			try {
				return facts(slot.path);
			} catch {
				return undefined;
			}
		}),
	);
}

/** canonicalOptionals for a checker that answers asynchronously. */
export async function canonicalOptionalsAsync(
	text: string,
	shape: PrintedShape,
	facts: (path: OptionalStep[]) => Promise<OptionalFacts | undefined>,
): Promise<string> {
	const slots = optionalSlots(text, shape);
	if (slots.length === 0) return text;
	const answers = await Promise.all(
		slots.map((slot) => facts(slot.path).catch(() => undefined)),
	);
	return dropImpliedUndefined(text, slots, answers);
}

interface SlotContext {
	source: ts.SourceFile;
	/** Subtracted from a parsed position to get a position in the text */
	offset: number;
	slots: OptionalSlot[];
}

function parse(text: string): ts.SourceFile {
	return ts.createSourceFile(
		"printed.ts",
		text,
		ts.ScriptTarget.Latest,
		true,
	);
}

/** Where the parameter list starts, after `<number>` type arguments. */
function typeArgumentsEnd(text: string): number | undefined {
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		true,
		ts.LanguageVariant.Standard,
		text,
	);
	let token = scanner.scan();
	if (token === ts.SyntaxKind.OpenParenToken) return scanner.getTokenStart();
	if (token !== ts.SyntaxKind.LessThanToken) return undefined;
	let depth = 1;
	while (depth > 0) {
		token = scanner.scan();
		if (token === ts.SyntaxKind.EndOfFileToken) return undefined;
		if (token === ts.SyntaxKind.LessThanToken) depth++;
		else if (token === ts.SyntaxKind.GreaterThanToken) depth--;
	}
	return scanner.getTokenEnd();
}

function slotsOfSignature(
	node: ts.SignatureDeclarationBase,
	path: OptionalStep[],
	context: SlotContext,
): void {
	let index = 0;
	for (const parameter of node.parameters) {
		if (ts.isIdentifier(parameter.name) && parameter.name.text === "this")
			continue;
		const at: OptionalStep[] = [...path, { param: index++ }];
		addSlot(parameter, at, context);
		if (parameter.type) slotsOfType(parameter.type, at, context);
	}
	if (node.type)
		slotsOfType(node.type, [...path, { returns: true }], context);
}

function slotsOfType(
	node: ts.TypeNode,
	path: OptionalStep[],
	context: SlotContext,
): void {
	if (ts.isParenthesizedTypeNode(node)) {
		slotsOfType(node.type, path, context);
	} else if (
		ts.isTypeOperatorNode(node) &&
		node.operator === ts.SyntaxKind.ReadonlyKeyword
	) {
		slotsOfType(node.type, path, context);
	} else if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
		const members = ts.isUnionTypeNode(node)
			? node.types.filter((member) => !isNullish(member))
			: node.types;
		if (members.length === 1) {
			slotsOfType(members[0] as ts.TypeNode, path, context);
			return;
		}
		members.forEach((member, index) => {
			slotsOfType(
				member,
				[...path, { member: index, members: members.length }],
				context,
			);
		});
	} else if (ts.isArrayTypeNode(node)) {
		slotsOfType(node.elementType, [...path, { element: 0 }], context);
	} else if (ts.isTupleTypeNode(node)) {
		node.elements.forEach((element, index) => {
			slotsOfType(
				tupleElementType(element),
				[...path, { element: index }],
				context,
			);
		});
	} else if (ts.isTypeReferenceNode(node)) {
		const of = ts.isIdentifier(node.typeName)
			? node.typeName.text
			: node.typeName.right.text;
		node.typeArguments?.forEach((argument, index) => {
			slotsOfType(
				argument,
				[...path, { typeArgument: index, of }],
				context,
			);
		});
	} else if (ts.isFunctionTypeNode(node)) {
		slotsOfSignature(node, [...path, { signature: 0 }], context);
	} else if (ts.isConstructorTypeNode(node)) {
		slotsOfSignature(node, [...path, { construct: 0 }], context);
	} else if (ts.isTypeLiteralNode(node)) {
		const methods = new Map<string, number>();
		let calls = 0;
		let constructs = 0;
		let indexes = 0;
		for (const member of node.members) {
			if (ts.isCallSignatureDeclaration(member)) {
				slotsOfSignature(
					member,
					[...path, { signature: calls++ }],
					context,
				);
				continue;
			}
			if (ts.isConstructSignatureDeclaration(member)) {
				slotsOfSignature(
					member,
					[...path, { construct: constructs++ }],
					context,
				);
				continue;
			}
			if (ts.isIndexSignatureDeclaration(member)) {
				slotsOfType(
					member.type,
					[...path, { index: indexes++ }],
					context,
				);
				continue;
			}
			const name = member.name ? propertyName(member.name) : undefined;
			if (name === undefined) continue;
			if (ts.isPropertySignature(member)) {
				const at: OptionalStep[] = [...path, { property: name }];
				addSlot(member, at, context);
				if (member.type) slotsOfType(member.type, at, context);
			} else if (ts.isMethodSignature(member)) {
				const overload = methods.get(name) ?? 0;
				methods.set(name, overload + 1);
				slotsOfSignature(
					member,
					[...path, { property: name }, { signature: overload }],
					context,
				);
			}
		}
	}
}

/** Record an optional parameter or property whose type has `| undefined`. */
function addSlot(
	node: ts.ParameterDeclaration | ts.PropertySignature,
	path: OptionalStep[],
	{ source, offset, slots }: SlotContext,
): void {
	if (!node.questionToken || !node.type || !ts.isUnionTypeNode(node.type))
		return;
	const members = node.type.types;
	const index = members.findIndex(
		(member) => member.kind === ts.SyntaxKind.UndefinedKeyword,
	);
	if (index < 0) return;
	const at = (position: number) => position - offset;
	const undefinedMember = members[index] as ts.TypeNode;
	const edits: Array<[number, number]> =
		index > 0
			? [
					[
						at((members[index - 1] as ts.TypeNode).end),
						at(undefinedMember.end),
					],
				]
			: [
					[
						at(undefinedMember.getStart(source)),
						at((members[1] as ts.TypeNode).getStart(source)),
					],
				];
	// `((x?: number) => void) | undefined` loses the parentheses too.
	const rest = members.length === 2 ? members[1 - index] : undefined;
	if (rest && ts.isParenthesizedTypeNode(rest)) {
		const start = at(rest.getStart(source));
		edits.push([start, start + 1], [at(rest.end) - 1, at(rest.end)]);
	}
	slots.push({ path, edits });
}

/**
 * The type of a tuple element: `X` for `X`, `name: X`, and `X?`, and the
 * element type `X` of a rest element `...X[]`, which is the tuple's type
 * argument.
 */
function tupleElementType(node: ts.TypeNode): ts.TypeNode {
	let rest = false;
	let type = node;
	if (ts.isNamedTupleMember(type)) {
		rest = type.dotDotDotToken !== undefined;
		type = type.type;
	} else if (ts.isRestTypeNode(type)) {
		rest = true;
		type = type.type;
	}
	if (ts.isOptionalTypeNode(type)) type = type.type;
	return rest && ts.isArrayTypeNode(type) ? type.elementType : type;
}

function isNullish(node: ts.TypeNode): boolean {
	return (
		node.kind === ts.SyntaxKind.UndefinedKeyword ||
		(ts.isLiteralTypeNode(node) &&
			node.literal.kind === ts.SyntaxKind.NullKeyword)
	);
}

function propertyName(name: ts.PropertyName): string | undefined {
	if (
		ts.isIdentifier(name) ||
		ts.isStringLiteral(name) ||
		ts.isNumericLiteral(name)
	) {
		return name.text;
	}
	return undefined;
}
