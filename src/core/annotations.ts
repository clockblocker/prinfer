import fs from "node:fs";
import path from "node:path";
import type {
	AnnotationFinding,
	AnnotationKind,
	AnnotationsResult,
	AnnotationTarget,
} from "../types.js";
import { loadProgram } from "./program.js";
import { ts } from "./ts-runtime.js";

/**
 * Redundant-annotation check.
 *
 * For each explicit type annotation that has something to infer from (a
 * variable, parameter, or class property initializer, or a function body),
 * prinfer asks TypeScript what the type would be without the annotation, by
 * type-checking a probe: a copy of the initializer or function, minus the
 * annotation, inserted into the same scope of a scratch copy of the file. The
 * probe and the original live in one program, so their types compare with
 * the checker's own assignability.
 *
 * - redundant: the declared and inferred types are identical. Every redundant
 *   finding is then verified by type-checking the file with those
 *   annotations deleted: it must report no new errors and give each
 *   declaration exactly the type it had.
 * - widening: the inferred type is strictly narrower than the declared one.
 *
 * Anything else (the annotation is needed, or removing it changes how the
 * initializer is contextually typed) is not reported.
 */

const PROBE_PREFIX = "__prinfer_probe_";
const PROBE_NAME = new RegExp(`${PROBE_PREFIX}\\d+`, "g");
/** Extra programs spent narrowing down a failed verification. */
const VERIFY_BUDGET = 12;

const DISPLAY_FLAGS =
	ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
	ts.TypeFormatFlags.AllowUniqueESSymbolType;
/** Fully qualified, untruncated text used to compare types. */
const IDENTITY_FLAGS =
	ts.TypeFormatFlags.NoTruncation |
	ts.TypeFormatFlags.UseFullyQualifiedType |
	ts.TypeFormatFlags.AllowUniqueESSymbolType |
	ts.TypeFormatFlags.WriteArrayAsGenericType |
	ts.TypeFormatFlags.UseStructuralFallback;

type FunctionLike =
	| ts.FunctionDeclaration
	| ts.MethodDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction;

type AnnotatedNode =
	| ts.VariableDeclaration
	| ts.ParameterDeclaration
	| ts.PropertyDeclaration
	| FunctionLike;

interface Candidate {
	target: AnnotationTarget;
	node: AnnotatedNode;
	name: string;
	/** The `: Type` span removing the annotation deletes. */
	removeStart: number;
	removeEnd: number;
	/** Original text copied into the probe: [copyStart, copyEnd) minus the cut. */
	copyStart: number;
	copyEnd: number;
	cutStart: number;
	cutEnd: number;
	/** Where the probe is inserted, and its text. */
	insertAt: number;
	probeText: string;
	/** Offset of the copy, and of the probe's name, within probeText. */
	copyOffset: number;
	nameOffset: number;
	/** Declarations whose symbol must not be referenced from the copy. */
	selfDeclarations: ts.Node[];
	/** The declaration that decides whether this annotation is exported API. */
	owner: ts.Node;
}

interface Analysis {
	candidate: Candidate;
	kind: AnnotationKind;
	declared: string;
	inferred: string;
	exported: boolean;
}

/** Find redundant and widening type annotations in one file. */
export function getFileAnnotations(
	file: string,
	project?: string,
): AnnotationsResult {
	const entryFileAbs = path.resolve(process.cwd(), file);
	if (!fs.existsSync(entryFileAbs)) {
		throw new Error(`File not found: ${entryFileAbs}`);
	}

	const program = loadProgram(entryFileAbs, project);
	const sourceFile = program.getSourceFile(entryFileAbs);
	if (!sourceFile) {
		throw new Error(
			`Could not load source file into the program (check tsconfig include/exclude): ${entryFileAbs}`,
		);
	}
	if (sourceFile.isDeclarationFile || /\.[cm]?jsx?$/i.test(entryFileAbs)) {
		return summarize(entryFileAbs, [], 0);
	}

	const checker = program.getTypeChecker();
	const candidates = collectCandidates(sourceFile, checker);
	if (candidates.length === 0) return summarize(entryFileAbs, [], 0);

	const probe = new ProbeProgram(program, sourceFile, candidates);
	const exportedSymbols = moduleExports(probe.checker, probe.sourceFile);
	const isolated = program.getCompilerOptions().isolatedDeclarations;

	const analyses: Analysis[] = [];
	for (const candidate of candidates) {
		const analysis = probe.analyze(candidate, exportedSymbols);
		if (!analysis) continue;
		if (analysis.kind === "redundant" && isolated && analysis.exported) {
			continue;
		}
		analyses.push(analysis);
	}

	const redundant = analyses.filter((a) => a.kind === "redundant");
	const verified = new Set(
		verifyRedundant(program, sourceFile, redundant).map((a) => a.candidate),
	);
	const findings = analyses
		.filter((a) => a.kind === "widening" || verified.has(a.candidate))
		.map((a) => toFinding(a, sourceFile));
	return summarize(entryFileAbs, findings, candidates.length);
}

function summarize(
	file: string,
	findings: AnnotationFinding[],
	checkedCount: number,
): AnnotationsResult {
	findings.sort(
		(left, right) => left.line - right.line || left.column - right.column,
	);
	return {
		file,
		findings,
		redundantCount: findings.filter((f) => f.kind === "redundant").length,
		wideningCount: findings.filter((f) => f.kind === "widening").length,
		checkedCount,
	};
}

/**
 * Render findings as `path:line:col redundant x: declared T, inferred T`
 * lines and a count summary.
 */
export function formatAnnotations(
	result: AnnotationsResult,
	displayPath: string = result.file,
): string {
	const checked = `${result.checkedCount} ${result.checkedCount === 1 ? "annotation" : "annotations"} checked`;
	if (result.findings.length === 0) {
		return `No redundant or widening annotations (${checked}).`;
	}
	const lines = result.findings.map(
		(finding) =>
			`${displayPath}:${finding.line}:${finding.column} ${finding.kind} ${label(finding)}: declared ${finding.declared}, inferred ${finding.inferred}${finding.exported ? " (exported)" : ""}`,
	);
	lines.push(
		`${result.redundantCount} redundant, ${result.wideningCount} widening (${checked}).`,
	);
	if (result.redundantCount > 0) {
		lines.push(
			"redundant: delete the annotation; the type stays the same.",
		);
	}
	if (result.wideningCount > 0) {
		lines.push(
			"widening: the annotation is wider than the inferred type; keep it if the wider type is intended.",
		);
	}
	return lines.join("\n");
}

function label(finding: AnnotationFinding): string {
	switch (finding.target) {
		case "variable":
			return finding.name;
		case "parameter":
			return `parameter ${finding.name}`;
		case "property":
			return `property ${finding.name}`;
		case "return":
			return `return type of ${finding.name}`;
	}
}

function toFinding(
	analysis: Analysis,
	sourceFile: ts.SourceFile,
): AnnotationFinding {
	const { candidate, kind, declared, inferred, exported } = analysis;
	const start = sourceFile.getLineAndCharacterOfPosition(
		candidate.removeStart,
	);
	const end = sourceFile.getLineAndCharacterOfPosition(candidate.removeEnd);
	return {
		line: start.line + 1,
		column: start.character + 1,
		endLine: end.line + 1,
		endColumn: end.character + 1,
		name: candidate.name,
		target: candidate.target,
		kind,
		declared,
		inferred,
		exported,
		suggestion: suggestion(analysis),
	};
}

function suggestion({
	candidate,
	kind,
	declared,
	inferred,
	exported,
}: Analysis): string {
	const what =
		candidate.target === "return"
			? "the return type annotation"
			: `the annotation on ${candidate.name}`;
	if (kind === "redundant") {
		return exported
			? `Remove ${what}; TypeScript infers the same type. It is exported, so keep it only to pin the public API.`
			: `Remove ${what}; TypeScript infers the same type.`;
	}
	return candidate.target === "return"
		? `Without ${what}, ${candidate.name} returns ${inferred}; keep it if callers should see ${declared}.`
		: `Without ${what}, ${candidate.name} is ${inferred}; keep it if ${candidate.name} must accept ${declared}.`;
}

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

function collectCandidates(
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
): Candidate[] {
	const text = sourceFile.text;
	const candidates: Candidate[] = [];
	let counter = 0;
	const probeName = () => `${PROBE_PREFIX}${counter++}`;
	// A probe name that already appears in the file could capture references.
	if (text.includes(PROBE_PREFIX)) return candidates;

	const candidateFor = (node: ts.Node): Candidate | undefined => {
		if (ts.isVariableDeclaration(node)) {
			return variable(node, sourceFile, probeName);
		}
		if (ts.isParameter(node)) {
			return parameter(node, sourceFile, checker, probeName);
		}
		if (ts.isPropertyDeclaration(node)) {
			return property(node, sourceFile, probeName);
		}
		if (
			ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node)
		) {
			return returnType(node, sourceFile, checker, probeName);
		}
		return undefined;
	};
	const visit = (node: ts.Node): void => {
		const candidate = candidateFor(node);
		if (candidate) candidates.push(candidate);
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(sourceFile, visit);
	return candidates;
}

function variable(
	node: ts.VariableDeclaration,
	sf: ts.SourceFile,
	nextName: () => string,
): Candidate | undefined {
	const { type, initializer } = node;
	if (!type || !initializer || !ts.isIdentifier(node.name)) return;
	if (node.exclamationToken) return;
	const list = node.parent;
	const statement = list.parent;
	if (!ts.isVariableStatement(statement) || !isInBlockLike(statement)) {
		return;
	}
	if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return;
	const keyword = declarationKeyword(list.flags);
	if (!keyword) return;
	const colon = childToken(node, ts.SyntaxKind.ColonToken, sf);
	if (!colon) return;

	const name = nextName();
	const prefix = `\n;${keyword} ${name} = `;
	return {
		target: "variable",
		node,
		name: node.name.text,
		removeStart: colon.getStart(sf),
		removeEnd: type.end,
		...copyOf(initializer.getStart(sf), initializer.end),
		insertAt: statement.pos,
		probeText: `${prefix}${sliceCopy(sf.text, initializer.getStart(sf), initializer.end)};\n`,
		copyOffset: prefix.length,
		nameOffset: prefix.length - name.length - 3,
		selfDeclarations: [node],
		owner: node,
	};
}

function parameter(
	node: ts.ParameterDeclaration,
	sf: ts.SourceFile,
	checker: ts.TypeChecker,
	nextName: () => string,
): Candidate | undefined {
	const { type, initializer } = node;
	if (!type || !initializer || !ts.isIdentifier(node.name)) return;
	const fn = node.parent;
	const body = (fn as ts.FunctionLikeDeclaration).body;
	if (!body || !ts.isBlock(body)) return;
	if (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) {
		// Without the annotation a contextually typed parameter (a callback,
		// or an IIFE's argument) would take its type from the context.
		if (checker.getContextualType(fn) !== undefined) return;
		if (isImmediatelyInvoked(fn)) return;
	} else if (ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn)) {
		if (!ts.isClassLike(fn.parent)) return;
	} else if (!ts.isFunctionDeclaration(fn)) {
		return;
	}
	const colon = childToken(node, ts.SyntaxKind.ColonToken, sf);
	if (!colon) return;

	const name = nextName();
	const prefix = `\n;let ${name} = `;
	return {
		target: "parameter",
		node,
		name: node.name.text,
		removeStart: colon.getStart(sf),
		removeEnd: type.end,
		...copyOf(initializer.getStart(sf), initializer.end),
		insertAt: body.statements.pos,
		probeText: `${prefix}${sliceCopy(sf.text, initializer.getStart(sf), initializer.end)};\n`,
		copyOffset: prefix.length,
		nameOffset: prefix.length - name.length - 3,
		selfDeclarations: [node],
		owner: fn,
	};
}

function property(
	node: ts.PropertyDeclaration,
	sf: ts.SourceFile,
	nextName: () => string,
): Candidate | undefined {
	const { type, initializer } = node;
	if (!type || !initializer || !ts.isClassLike(node.parent)) return;
	if (
		hasModifier(node, ts.SyntaxKind.DeclareKeyword) ||
		hasModifier(node, ts.SyntaxKind.AbstractKeyword)
	) {
		return;
	}
	const colon = childToken(node, ts.SyntaxKind.ColonToken, sf);
	if (!colon) return;

	const name = nextName();
	const modifiers = [
		"private",
		hasModifier(node, ts.SyntaxKind.StaticKeyword) ? "static" : "",
		hasModifier(node, ts.SyntaxKind.ReadonlyKeyword) ? "readonly" : "",
		hasModifier(node, ts.SyntaxKind.AccessorKeyword) ? "accessor" : "",
	]
		.filter(Boolean)
		.join(" ");
	const head = `\n;${modifiers} ${name}`;
	const prefix = `${head}${node.questionToken ? "?" : ""} = `;
	return {
		target: "property",
		node,
		name: node.name.getText(sf),
		removeStart: colon.getStart(sf),
		removeEnd: type.end,
		...copyOf(initializer.getStart(sf), initializer.end),
		insertAt: node.pos,
		probeText: `${prefix}${sliceCopy(sf.text, initializer.getStart(sf), initializer.end)};\n`,
		copyOffset: prefix.length,
		nameOffset: head.length - name.length,
		selfDeclarations: [node],
		owner: node,
	};
}

function returnType(
	node: FunctionLike,
	sf: ts.SourceFile,
	checker: ts.TypeChecker,
	nextName: () => string,
): Candidate | undefined {
	const { type, body } = node;
	if (!type || !body || ts.isTypePredicateNode(type)) return;
	const text = sf.text;
	const closeParen = childToken(node, ts.SyntaxKind.CloseParenToken, sf);
	const colon = childToken(node, ts.SyntaxKind.ColonToken, sf);
	if (!closeParen || !colon) return;

	const isAsync = hasModifier(node, ts.SyntaxKind.AsyncKeyword);
	const star = "asteriskToken" in node && node.asteriskToken ? "*" : "";
	const cut = { cutStart: closeParen.end, cutEnd: type.end };
	const name = nextName();

	if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
		if (ts.isFunctionDeclaration(node) && !isInBlockLike(node)) return;
		if (ts.isMethodDeclaration(node) && !ts.isClassLike(node.parent)) {
			return;
		}
		if (isOverloaded(node, checker)) return;
		const sigStart = node.typeParameters
			? node.typeParameters.pos - 1
			: node.parameters.pos - 1;
		if (text[sigStart] !== "<" && text[sigStart] !== "(") return;
		const head = ts.isFunctionDeclaration(node)
			? `\n;${isAsync ? "async " : ""}function${star} ${name}`
			: `\n;private ${hasModifier(node, ts.SyntaxKind.StaticKeyword) ? "static " : ""}${isAsync ? "async " : ""}${star}${name}`;
		const range = copyOf(sigStart, node.end, cut);
		return {
			target: "return",
			node,
			name: node.name ? node.name.getText(sf) : "default",
			removeStart: colon.getStart(sf),
			removeEnd: type.end,
			...range,
			insertAt: node.pos,
			probeText: `${head}${sliceCopy(text, sigStart, node.end, cut)}\n`,
			copyOffset: head.length,
			nameOffset: head.length - name.length,
			selfDeclarations: [node],
			owner: node,
		};
	}

	// Function and arrow expressions: a contextual type would feed the
	// return expressions, so only uncontextualized ones are checked.
	if (checker.getContextualType(node) !== undefined) return;
	const placement = expressionPlacement(node);
	if (!placement) return;
	const container = containerDeclaration(node);
	const self: ts.Node[] = [node];
	if (container) self.push(container);
	const start = node.getStart(sf);
	const head =
		placement.kind === "statement"
			? `\n;const ${name} = `
			: `\n;private ${placement.isStatic ? "static " : ""}${name} = `;
	return {
		target: "return",
		node,
		name: functionName(node, container, sf),
		removeStart: colon.getStart(sf),
		removeEnd: type.end,
		...copyOf(start, node.end, cut),
		insertAt: placement.insertAt,
		probeText: `${head}${sliceCopy(text, start, node.end, cut)};\n`,
		copyOffset: head.length,
		nameOffset: head.length - name.length - 3,
		selfDeclarations: self,
		owner: container ?? placement.owner,
	};
}

/**
 * Where a function expression's probe goes: before the statement or class
 * property that contains it, so it sees the same bindings and flow position.
 * Undefined when it sits somewhere a copy could not reproduce: a parameter
 * default, a decorator, a heritage clause, or a compound statement such as
 * an if condition or a loop header.
 */
function expressionPlacement(node: ts.Node):
	| { kind: "statement"; insertAt: number; owner: ts.Node }
	| {
			kind: "property";
			insertAt: number;
			isStatic: boolean;
			owner: ts.Node;
	  }
	| undefined {
	let current: ts.Node = node;
	while (current.parent) {
		const parent: ts.Node = current.parent;
		if (
			ts.isParameter(parent) ||
			ts.isDecorator(parent) ||
			ts.isHeritageClause(parent) ||
			ts.isComputedPropertyName(parent) ||
			ts.isTypeNode(parent) ||
			ts.isEnumMember(parent)
		) {
			return;
		}
		if (ts.isPropertyDeclaration(parent) && ts.isClassLike(parent.parent)) {
			return {
				kind: "property",
				insertAt: parent.pos,
				isStatic: hasModifier(parent, ts.SyntaxKind.StaticKeyword),
				owner: parent,
			};
		}
		if (isBlockLike(parent)) {
			return isSimpleStatement(current)
				? { kind: "statement", insertAt: current.pos, owner: current }
				: undefined;
		}
		current = parent;
	}
	return;
}

/** Statements that evaluate their expressions at their own flow position. */
function isSimpleStatement(node: ts.Node): boolean {
	return (
		ts.isVariableStatement(node) ||
		ts.isExpressionStatement(node) ||
		ts.isExportAssignment(node) ||
		ts.isReturnStatement(node) ||
		ts.isThrowStatement(node)
	);
}

function isBlockLike(node: ts.Node): boolean {
	return (
		ts.isSourceFile(node) ||
		ts.isBlock(node) ||
		ts.isModuleBlock(node) ||
		ts.isCaseClause(node) ||
		ts.isDefaultClause(node)
	);
}

function isInBlockLike(node: ts.Node): boolean {
	return node.parent !== undefined && isBlockLike(node.parent);
}

/** The variable or property a function expression initializes, if any. */
function containerDeclaration(node: ts.Node): ts.Node | undefined {
	let current = node;
	while (ts.isParenthesizedExpression(current.parent)) {
		current = current.parent;
	}
	const parent = current.parent;
	if (
		(ts.isVariableDeclaration(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isPropertyAssignment(parent)) &&
		parent.initializer === current
	) {
		return parent;
	}
	return undefined;
}

function functionName(
	node: ts.FunctionExpression | ts.ArrowFunction,
	container: ts.Node | undefined,
	sf: ts.SourceFile,
): string {
	if (ts.isFunctionExpression(node) && node.name) return node.name.text;
	const name = container && (container as ts.NamedDeclaration).name;
	return name ? name.getText(sf) : "anonymous function";
}

function isImmediatelyInvoked(node: ts.Node): boolean {
	let current = node;
	while (ts.isParenthesizedExpression(current.parent)) {
		current = current.parent;
	}
	return (
		ts.isCallExpression(current.parent) &&
		current.parent.expression === current
	);
}

function isOverloaded(
	node: ts.FunctionDeclaration | ts.MethodDeclaration,
	checker: ts.TypeChecker,
): boolean {
	if (!node.name) return false;
	const symbol = checker.getSymbolAtLocation(node.name);
	const declarations = symbol?.declarations ?? [];
	return (
		declarations.filter(
			(d) => ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d),
		).length > 1
	);
}

function declarationKeyword(flags: ts.NodeFlags): string | undefined {
	const scoped =
		flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using);
	if (scoped === 0) return "var";
	if (scoped === ts.NodeFlags.Let) return "let";
	if (scoped === ts.NodeFlags.Const) return "const";
	return undefined; // using / await using
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ??
			false)
	);
}

function childToken(
	node: ts.Node,
	kind: ts.SyntaxKind,
	sf: ts.SourceFile,
): ts.Node | undefined {
	return node.getChildren(sf).find((child) => child.kind === kind);
}

function copyOf(
	copyStart: number,
	copyEnd: number,
	cut?: { cutStart: number; cutEnd: number },
) {
	return {
		copyStart,
		copyEnd,
		cutStart: cut?.cutStart ?? copyEnd,
		cutEnd: cut?.cutEnd ?? copyEnd,
	};
}

function sliceCopy(
	text: string,
	start: number,
	end: number,
	cut?: { cutStart: number; cutEnd: number },
): string {
	return cut
		? text.slice(start, cut.cutStart) + text.slice(cut.cutEnd, end)
		: text.slice(start, end);
}

/** Offset within the copy of an original position, if it was copied. */
function copyOffsetOf(candidate: Candidate, pos: number): number | undefined {
	const { copyStart, copyEnd, cutStart, cutEnd } = candidate;
	if (pos >= copyStart && pos < cutStart) return pos - copyStart;
	if (pos >= cutEnd && pos < copyEnd)
		return cutStart - copyStart + pos - cutEnd;
	return undefined;
}

// ---------------------------------------------------------------------------
// Scratch programs
// ---------------------------------------------------------------------------

/**
 * A program over the same files as `program`, with the target file's text
 * replaced. Every other source file is reused, so only the target is
 * re-checked.
 */
function scratchProgram(
	program: ts.Program,
	sourceFile: ts.SourceFile,
	text: string,
): { program: ts.Program; sourceFile: ts.SourceFile } {
	const options = program.getCompilerOptions();
	const host = ts.createCompilerHost(options, true);
	const target = path.resolve(sourceFile.fileName);
	const isTarget = (fileName: string) => path.resolve(fileName) === target;
	let scratch: ts.SourceFile | undefined;
	host.getSourceFile = (fileName, languageVersionOrOptions) => {
		if (isTarget(fileName)) {
			scratch ??= ts.createSourceFile(
				fileName,
				text,
				languageVersionOrOptions,
				true,
			);
			return scratch;
		}
		return (
			program.getSourceFile(fileName) ??
			ts.createSourceFile(
				fileName,
				ts.sys.readFile(fileName) ?? "",
				languageVersionOrOptions,
				true,
			)
		);
	};
	const readFile = host.readFile.bind(host);
	host.readFile = (fileName) =>
		isTarget(fileName) ? text : readFile(fileName);
	const next = ts.createProgram({
		rootNames: program.getRootFileNames(),
		options,
		host,
		oldProgram: program,
		projectReferences: program.getProjectReferences(),
	});
	const nextSource = next.getSourceFile(sourceFile.fileName);
	if (!nextSource) {
		throw new Error(`Could not re-check ${sourceFile.fileName}`);
	}
	return { program: next, sourceFile: nextSource };
}

/** Index nodes by start position and kind. */
function indexNodes(sf: ts.SourceFile): Map<string, ts.Node> {
	const index = new Map<string, ts.Node>();
	const visit = (node: ts.Node): void => {
		const key = `${node.getStart(sf)}:${node.kind}`;
		if (!index.has(key)) index.set(key, node);
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(sf, visit);
	return index;
}

interface Insertion {
	candidate: Candidate;
	/** Start of the inserted text in the probe file. */
	base: number;
}

class ProbeProgram {
	readonly checker: ts.TypeChecker;
	readonly sourceFile: ts.SourceFile;
	private readonly insertions: Insertion[] = [];
	private readonly byCandidate = new Map<Candidate, Insertion>();
	private readonly index: Map<string, ts.Node>;

	constructor(
		program: ts.Program,
		private readonly original: ts.SourceFile,
		candidates: Candidate[],
	) {
		const ordered = candidates
			.map((candidate, order) => ({ candidate, order }))
			.sort(
				(left, right) =>
					left.candidate.insertAt - right.candidate.insertAt ||
					left.order - right.order,
			);
		const text = original.text;
		let out = "";
		let last = 0;
		for (const { candidate } of ordered) {
			out += text.slice(last, candidate.insertAt);
			last = candidate.insertAt;
			const insertion = { candidate, base: out.length };
			this.insertions.push(insertion);
			this.byCandidate.set(candidate, insertion);
			out += candidate.probeText;
		}
		out += text.slice(last);

		const scratch = scratchProgram(program, original, out);
		this.checker = scratch.program.getTypeChecker();
		this.sourceFile = scratch.sourceFile;
		this.index = indexNodes(this.sourceFile);
	}

	/** Probe-file position of an original position. */
	private toProbe(pos: number): number {
		let shift = 0;
		for (const { candidate } of this.insertions) {
			if (candidate.insertAt <= pos) shift += candidate.probeText.length;
			else break;
		}
		return pos + shift;
	}

	/** Original position of a probe-file position, or the insertion holding it. */
	private fromProbe(
		pos: number,
	): { original: number } | { insertion: Insertion; offset: number } {
		let shift = 0;
		for (const insertion of this.insertions) {
			const length = insertion.candidate.probeText.length;
			if (pos < insertion.base) break;
			if (pos < insertion.base + length) {
				return { insertion, offset: pos - insertion.base };
			}
			shift += length;
		}
		return { original: pos - shift };
	}

	private find(pos: number, kind: ts.SyntaxKind): ts.Node | undefined {
		return this.index.get(`${pos}:${kind}`);
	}

	analyze(
		candidate: Candidate,
		exportedSymbols: Set<ts.Symbol>,
	): Analysis | undefined {
		const checker = this.checker;
		const original = this.find(
			this.toProbe(candidate.node.getStart(this.original)),
			candidate.node.kind,
		) as AnnotatedNode | undefined;
		const insertion = this.byCandidate.get(candidate);
		if (!original || !insertion) return;
		const probeName = this.find(
			insertion.base + candidate.nameOffset,
			ts.SyntaxKind.Identifier,
		);
		if (!probeName?.parent) return;
		const probeDeclaration = probeName.parent;
		if (
			!this.copiesMatch(candidate, original, insertion, probeDeclaration)
		) {
			return;
		}

		let declaredType: ts.Type;
		let inferredType: ts.Type;
		let declaredShown: ts.Type;
		let inferredShown: ts.Type;
		if (candidate.target === "return") {
			const probeFunction =
				ts.isVariableDeclaration(probeDeclaration) ||
				ts.isPropertyDeclaration(probeDeclaration)
					? probeDeclaration.initializer
					: probeDeclaration;
			if (!probeFunction || !ts.isFunctionLike(probeFunction)) return;
			declaredType = checker.getTypeAtLocation(original);
			inferredType = checker.getTypeAtLocation(probeFunction);
			const declaredSignature = checker.getSignatureFromDeclaration(
				original as ts.SignatureDeclaration,
			);
			const inferredSignature = checker.getSignatureFromDeclaration(
				probeFunction as ts.SignatureDeclaration,
			);
			if (!declaredSignature || !inferredSignature) return;
			declaredShown = checker.getReturnTypeOfSignature(declaredSignature);
			inferredShown = checker.getReturnTypeOfSignature(inferredSignature);
		} else {
			const declaredSymbol = symbolOf(
				checker,
				(original as ts.NamedDeclaration).name,
			);
			const inferredSymbol = checker.getSymbolAtLocation(probeName);
			if (!declaredSymbol || !inferredSymbol) return;
			declaredType = checker.getTypeOfSymbol(declaredSymbol);
			inferredType = checker.getTypeOfSymbol(inferredSymbol);
			declaredShown = declaredType;
			inferredShown = inferredType;
		}

		const kind = classify(checker, declaredType, inferredType, [
			declaredShown,
			inferredShown,
		]);
		if (!kind) return;
		return {
			candidate,
			kind,
			declared: checker.typeToString(
				declaredShown,
				undefined,
				DISPLAY_FLAGS,
			),
			// Without the annotation the probe's name would be the declaration's.
			inferred: checker
				.typeToString(inferredShown, undefined, DISPLAY_FLAGS)
				.replace(PROBE_NAME, candidate.name),
			exported: isExported(
				checker,
				this.find(
					this.toProbe(candidate.owner.getStart(this.original)),
					candidate.owner.kind,
				),
				exportedSymbols,
			),
		};
	}

	/**
	 * The copy must mean the same as the original: every identifier resolves
	 * to the same declaration (or to its own copy of a local one) and has the
	 * same type. A difference means the annotation contextually types the
	 * initializer, narrowing differs, or the copy references itself.
	 */
	private copiesMatch(
		candidate: Candidate,
		original: ts.Node,
		insertion: Insertion,
		probeDeclaration: ts.Node,
	): boolean {
		const checker = this.checker;
		const copyBase = insertion.base + candidate.copyOffset;
		const copyLength =
			candidate.cutStart -
			candidate.copyStart +
			candidate.copyEnd -
			candidate.cutEnd;

		const originals = identifiers(original, this.sourceFile, (pos) => {
			const at = this.fromProbe(pos);
			return (
				"original" in at &&
				copyOffsetOf(candidate, at.original) !== undefined
			);
		});
		const copies = identifiers(
			probeDeclaration,
			this.sourceFile,
			(pos) => pos >= copyBase && pos < copyBase + copyLength,
		);
		if (originals.length !== copies.length) return false;

		const self = new Set(
			candidate.selfDeclarations
				.map((declaration) =>
					this.find(
						this.toProbe(declaration.getStart(this.original)),
						declaration.kind,
					),
				)
				.filter((node): node is ts.Node => node !== undefined),
		);

		for (let i = 0; i < originals.length; i++) {
			const left = originals[i] as ts.Identifier | ts.PrivateIdentifier;
			const right = copies[i] as ts.Identifier | ts.PrivateIdentifier;
			if (left.text !== right.text) return false;
			const leftSymbol = symbolOf(checker, left);
			const rightSymbol = symbolOf(checker, right);
			if (leftSymbol?.declarations?.some((d) => self.has(d))) {
				const isOwnName = leftSymbol.declarations.some(
					(d) => (d as ts.NamedDeclaration).name === left,
				);
				if (!isOwnName) return false;
			}
			if (
				!this.sameSymbol(candidate, leftSymbol, rightSymbol, copyBase)
			) {
				return false;
			}
			const leftType = checker.getTypeAtLocation(left);
			const rightType = checker.getTypeAtLocation(right);
			if (
				leftType !== rightType &&
				checker.typeToString(leftType, undefined, IDENTITY_FLAGS) !==
					checker.typeToString(rightType, undefined, IDENTITY_FLAGS)
			) {
				return false;
			}
		}
		return true;
	}

	private sameSymbol(
		candidate: Candidate,
		left: ts.Symbol | undefined,
		right: ts.Symbol | undefined,
		copyBase: number,
	): boolean {
		if (left === right) return true;
		if (!left || !right) return false;
		const leftDeclaration = left.declarations?.[0];
		const rightDeclaration = right.declarations?.[0];
		if (!leftDeclaration || !rightDeclaration) return false;
		if (leftDeclaration === rightDeclaration) return true;
		if (
			leftDeclaration.getSourceFile() !== this.sourceFile ||
			rightDeclaration.getSourceFile() !== this.sourceFile ||
			leftDeclaration.kind !== rightDeclaration.kind
		) {
			return false;
		}
		// A declaration inside the copied text must map to its own copy.
		const at = this.fromProbe(leftDeclaration.getStart(this.sourceFile));
		if (!("original" in at)) return false;
		const offset = copyOffsetOf(candidate, at.original);
		return (
			offset !== undefined &&
			copyBase + offset === rightDeclaration.getStart(this.sourceFile)
		);
	}
}

/** Identifiers under node, in source order, whose start passes keep. */
function identifiers(
	node: ts.Node,
	sf: ts.SourceFile,
	keep: (pos: number) => boolean,
): ts.Node[] {
	const found: ts.Node[] = [];
	const visit = (child: ts.Node): void => {
		if (ts.isIdentifier(child) || ts.isPrivateIdentifier(child)) {
			if (keep(child.getStart(sf))) found.push(child);
			return;
		}
		ts.forEachChild(child, visit);
	};
	visit(node);
	return found;
}

function symbolOf(
	checker: ts.TypeChecker,
	node: ts.Node | undefined,
): ts.Symbol | undefined {
	if (!node) return undefined;
	if (
		node.parent &&
		ts.isShorthandPropertyAssignment(node.parent) &&
		node.parent.name === node
	) {
		return checker.getShorthandAssignmentValueSymbol(node.parent);
	}
	return checker.getSymbolAtLocation(node);
}

/**
 * redundant when the types are identical; widening when the inferred type is
 * strictly narrower; otherwise undefined (the annotation is needed). `any`
 * on either side is never reported: it opts out of checking, so removing or
 * keeping it is a judgment call this check cannot make.
 */
function classify(
	checker: ts.TypeChecker,
	declared: ts.Type,
	inferred: ts.Type,
	shown: ts.Type[],
): AnnotationKind | undefined {
	if (
		declared.flags & ts.TypeFlags.Any ||
		inferred.flags & ts.TypeFlags.Any
	) {
		return;
	}
	const declaredText = checker.typeToString(
		declared,
		undefined,
		IDENTITY_FLAGS,
	);
	const inferredText = checker.typeToString(
		inferred,
		undefined,
		IDENTITY_FLAGS,
	);
	// any or never that the annotation lacks comes from an initializer with
	// nothing to infer from, e.g. an untyped callback parameter or `[]`.
	for (const word of ["any", "never"]) {
		if (mentions(inferredText, word) && !mentions(declaredText, word)) {
			return;
		}
	}
	if (shown.some((type) => type.flags & ts.TypeFlags.Any)) return;

	const forward = checker.isTypeAssignableTo(inferred, declared);
	const backward = checker.isTypeAssignableTo(declared, inferred);
	if (
		declared === inferred ||
		(forward && backward && declaredText === inferredText)
	) {
		return "redundant";
	}
	if (forward && !backward) return "widening";
	return undefined;
}

function mentions(text: string, word: string): boolean {
	return new RegExp(`\\b${word}\\b`).test(text);
}

/** Symbols the module exports, resolved through aliases. */
function moduleExports(
	checker: ts.TypeChecker,
	sf: ts.SourceFile,
): Set<ts.Symbol> {
	const exported = new Set<ts.Symbol>();
	const moduleSymbol = checker.getSymbolAtLocation(sf);
	if (!moduleSymbol) return exported;
	for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
		exported.add(symbol);
		if (symbol.flags & ts.SymbolFlags.Alias) {
			exported.add(checker.getAliasedSymbol(symbol));
		}
	}
	return exported;
}

/**
 * Whether the declaration is part of the module's public API: an exported
 * variable, function, or class, or a non-private member or parameter of one.
 */
function isExported(
	checker: ts.TypeChecker,
	node: ts.Node | undefined,
	exportedSymbols: Set<ts.Symbol>,
): boolean {
	let current = node;
	while (current) {
		if (
			ts.isVariableDeclaration(current) ||
			ts.isFunctionDeclaration(current) ||
			ts.isClassDeclaration(current)
		) {
			const symbol = current.name
				? checker.getSymbolAtLocation(current.name)
				: undefined;
			const statement = ts.isVariableDeclaration(current)
				? current.parent.parent
				: current;
			return (
				(symbol !== undefined && exportedSymbols.has(symbol)) ||
				hasModifier(statement, ts.SyntaxKind.ExportKeyword)
			);
		}
		if (
			(ts.isPropertyDeclaration(current) ||
				ts.isMethodDeclaration(current) ||
				ts.isConstructorDeclaration(current)) &&
			ts.isClassLike(current.parent)
		) {
			if (
				hasModifier(current, ts.SyntaxKind.PrivateKeyword) ||
				(current.name !== undefined &&
					ts.isPrivateIdentifier(current.name))
			) {
				return false;
			}
			current = current.parent;
			continue;
		}
		if (ts.isClassExpression(current) || ts.isSourceFile(current)) {
			return false;
		}
		if (ts.isBlock(current)) return false;
		current = current.parent;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Keep the redundant findings whose annotations can actually be deleted:
 * re-check the file with them removed, require no new diagnostics and the
 * same type for each declaration. A failing group is split and retried
 * within VERIFY_BUDGET programs; whatever is still unproven is dropped.
 */
function verifyRedundant(
	program: ts.Program,
	sourceFile: ts.SourceFile,
	analyses: Analysis[],
): Analysis[] {
	if (analyses.length === 0) return [];
	const checker = program.getTypeChecker();
	const baseline = diagnosticKeys(program, sourceFile);
	const expected = new Map(
		analyses.map((analysis) => [
			analysis,
			identityOf(checker, analysis.candidate.node),
		]),
	);
	let budget = VERIFY_BUDGET;
	const accepted: Analysis[] = [];

	const verify = (group: Analysis[]): boolean => {
		const cuts = group
			.map(
				(a) =>
					[a.candidate.removeStart, a.candidate.removeEnd] as const,
			)
			.sort((left, right) => left[0] - right[0]);
		let text = "";
		let last = 0;
		for (const [start, end] of cuts) {
			text += sourceFile.text.slice(last, start);
			last = end;
		}
		text += sourceFile.text.slice(last);
		const scratch = scratchProgram(program, sourceFile, text);
		const keys = diagnosticKeys(scratch.program, scratch.sourceFile);
		for (const [key, count] of keys) {
			if (count > (baseline.get(key) ?? 0)) return false;
		}
		const index = indexNodes(scratch.sourceFile);
		const scratchChecker = scratch.program.getTypeChecker();
		const shift = (pos: number) => {
			let removed = 0;
			for (const [start, end] of cuts) {
				if (end <= pos) removed += end - start;
			}
			return pos - removed;
		};
		return group.every((analysis) => {
			const node = analysis.candidate.node;
			const moved = index.get(
				`${shift(node.getStart(sourceFile))}:${node.kind}`,
			);
			return (
				moved !== undefined &&
				identityOf(scratchChecker, moved) === expected.get(analysis)
			);
		});
	};

	const run = (group: Analysis[]): void => {
		if (verify(group)) {
			accepted.push(...group);
			return;
		}
		if (group.length === 1) return;
		const middle = Math.ceil(group.length / 2);
		for (const half of [group.slice(0, middle), group.slice(middle)]) {
			if (budget <= 0) return;
			budget--;
			run(half);
		}
	};
	run(analyses);
	return accepted;
}

/** The fully qualified type of a declaration, as text comparable across programs. */
function identityOf(
	checker: ts.TypeChecker,
	node: ts.Node,
): string | undefined {
	let type: ts.Type | undefined;
	if (ts.isFunctionLike(node)) {
		type = checker.getTypeAtLocation(node);
	} else {
		const symbol = symbolOf(checker, (node as ts.NamedDeclaration).name);
		type = symbol ? checker.getTypeOfSymbol(symbol) : undefined;
	}
	return type && checker.typeToString(type, undefined, IDENTITY_FLAGS);
}

function diagnosticKeys(
	program: ts.Program,
	sourceFile: ts.SourceFile,
): Map<string, number> {
	const keys = new Map<string, number>();
	for (const diagnostic of [
		...program.getSyntacticDiagnostics(sourceFile),
		...program.getSemanticDiagnostics(sourceFile),
	]) {
		const key = `${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
		keys.set(key, (keys.get(key) ?? 0) + 1);
	}
	return keys;
}
