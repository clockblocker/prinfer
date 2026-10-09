import * as ts from "typescript";

/**
 * Collapse a multi-line type, as an editor hover prints it, onto one line
 * the way TypeScript 6's typeToString writes it:
 * `{\n    id: number;\n}` becomes `{ id: number; }`.
 */
export function singleLine(text: string): string {
	return text.replace(/[^\S\n]*\n\s*/g, " ").trim();
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
	| { signature: number };

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
 * in `| undefined`, with the path to each. Looks into parameters, return
 * types, object type literals, function types, and a union with one member
 * besides null and undefined; other types are left alone.
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
	} else if (ts.isUnionTypeNode(node)) {
		const members = node.types.filter((member) => !isNullish(member));
		if (members.length === 1)
			slotsOfType(members[0] as ts.TypeNode, path, context);
	} else if (ts.isFunctionTypeNode(node)) {
		slotsOfSignature(node, [...path, { signature: 0 }], context);
	} else if (ts.isTypeLiteralNode(node)) {
		const methods = new Map<string, number>();
		let calls = 0;
		for (const member of node.members) {
			if (ts.isCallSignatureDeclaration(member)) {
				slotsOfSignature(
					member,
					[...path, { signature: calls++ }],
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
