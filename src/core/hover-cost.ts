import fs from "node:fs";
import path from "node:path";
import type { HoverCost } from "../types.js";
import { getCheckerHoverInfo } from "./hover.js";
import { assertCursorPosition } from "./lines.js";
import { lookupName } from "./name-lookup.js";
import { findNodeAtPosition } from "./node-find.js";
import { loadProgram } from "./program.js";
import { type TypeScript, ts } from "./ts-runtime.js";

/**
 * Count the checker work behind a hover; see `HoverCost`. The work is
 * repeated by a new checker over the loaded program, which starts empty,
 * so no earlier lookup has done any of it. The files are not read, parsed,
 * or bound again. What is counted is resolving the node's type and writing
 * its untruncated text: the same work whatever the display options of the
 * hover it accompanies.
 *
 * A count depends only on the program and the node, so it is kept for as
 * long as the program is: asking again, from any surface, returns it
 * without checking anything. A changed file loads a new program, and so
 * counts again.
 */
export function measureHoverCost(
	program: ts.Program,
	node: ts.Node,
	sourceFile: ts.SourceFile,
): HoverCost {
	let counted = costCache.get(program);
	if (!counted) {
		counted = new WeakMap();
		costCache.set(program, counted);
	}
	const known = counted.get(node);
	if (known) return { ...known };

	const checker = freshChecker(program, sourceFile);
	// Creating the checker merges every file's globals; that setup costs
	// the same for any lookup and is left out.
	const instantiations = checker.getInstantiationCount();
	const types = checker.getTypeCount();
	getCheckerHoverInfo(checker, node, sourceFile, false, true);
	const cost = {
		instantiations: checker.getInstantiationCount() - instantiations,
		types: checker.getTypeCount() - types,
	};
	counted.set(node, cost);
	return { ...cost };
}

/** What `measureTargetCosts` counts: a declaration by name, or a position. */
export type CostTarget =
	| { name: string; line?: number }
	| { line: number; column: number };

/**
 * The cost of each target in one file, in order, without the hover text:
 * the program is loaded once and the shared checker is never asked, so a
 * cold target is checked only by the fresh checker that counts it. Throws
 * on the first target that does not resolve, with `index` set to it.
 */
export function measureTargetCosts(
	file: string,
	targets: readonly CostTarget[],
	project?: string,
): HoverCost[] {
	const { program, sourceFile, nodes } = resolveCostTargets(
		file,
		targets,
		project,
	);
	return nodes.map((node, index) =>
		atTarget(index, () => measureHoverCost(program, node, sourceFile)),
	);
}

/**
 * The cost of resolving every target with one fresh checker: work the
 * targets share (a type they all reach, a generic instantiated the same
 * way) is counted once, as a whole-file check would count it. Like a
 * single count, it is the same on every run, in any order of the targets,
 * whatever was looked up before. Throws like `measureTargetCosts`.
 */
export function measureCombinedCost(
	file: string,
	targets: readonly CostTarget[],
	project?: string,
): HoverCost {
	const { program, sourceFile, nodes } = resolveCostTargets(
		file,
		targets,
		project,
	);
	// A checker's count can depend on the order it meets types in (by a
	// type, rarely), so the targets are resolved in source order, whatever
	// order they were given in.
	const ordered = nodes
		.map((node, index) => ({ node, index }))
		.filter(({ node }, at) => nodes.indexOf(node) === at)
		.sort(
			(left, right) =>
				left.node.pos - right.node.pos ||
				left.node.end - right.node.end ||
				left.node.kind - right.node.kind,
		);
	const checker = freshChecker(program, sourceFile);
	const instantiations = checker.getInstantiationCount();
	const types = checker.getTypeCount();
	for (const { node, index } of ordered) {
		atTarget(index, () =>
			getCheckerHoverInfo(checker, node, sourceFile, false, true),
		);
	}
	return {
		instantiations: checker.getInstantiationCount() - instantiations,
		types: checker.getTypeCount() - types,
	};
}

/** The program and the node of each target; see `measureTargetCosts`. */
function resolveCostTargets(
	file: string,
	targets: readonly CostTarget[],
	project: string | undefined,
): { program: ts.Program; sourceFile: ts.SourceFile; nodes: ts.Node[] } {
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
	// Creating the checker binds the program, which sets the parent pointers
	// name lookups read. It checks nothing until asked, and it is not asked.
	program.getTypeChecker();

	const nodes = targets.map((target, index) =>
		atTarget(index, () => {
			if ("name" in target) {
				return lookupName(sourceFile, target.name, target.line, file)
					.node;
			}
			assertCursorPosition(
				sourceFile.text,
				target.line,
				target.column,
				entryFileAbs,
			);
			const node = findNodeAtPosition(
				sourceFile,
				target.line,
				target.column,
			);
			if (!node) {
				throw new Error(
					`No symbol found at ${entryFileAbs}:${target.line}:${target.column}`,
				);
			}
			return node;
		}),
	);
	return { program, sourceFile, nodes };
}

/** Run `run` for the target at `index`, setting `index` on what it throws. */
function atTarget<T>(index: number, run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof Error) {
			(error as Error & { index?: number }).index = index;
		}
		throw error;
	}
}

const costCache = new WeakMap<ts.Program, WeakMap<ts.Node, HoverCost>>();

/** A checker's own counters, which `ts.Program` exposes for its checker. */
type CountingChecker = ts.TypeChecker &
	Pick<ts.Program, "getInstantiationCount" | "getTypeCount">;

type CreateTypeChecker = (host: ts.Program) => CountingChecker;

const factories = new WeakMap<TypeScript, CreateTypeChecker | null>();

/**
 * TypeScript's checker factory: internal, but exported at runtime by every
 * supported version (5.0 to 6.x). It is taken from the instance that made
 * the program: another version's checker misreads its files. Without it,
 * each count creates a new program over the same files instead, which
 * takes a few milliseconds longer and counts the same. Tests replace `of`
 * to compare the two.
 */
export const checkerFactory = {
	of(instance: TypeScript): CreateTypeChecker | undefined {
		let factory = factories.get(instance);
		if (factory === undefined) {
			const exported = instance as unknown as {
				createTypeChecker?: unknown;
				default?: { createTypeChecker?: unknown };
			};
			const found =
				exported.createTypeChecker ??
				exported.default?.createTypeChecker;
			factory =
				typeof found === "function"
					? (found as CreateTypeChecker)
					: null;
			factories.set(instance, factory);
		}
		return factory ?? undefined;
	},
};

/** A new, empty checker over `program`'s files and options. */
function freshChecker(
	program: ts.Program,
	sourceFile: ts.SourceFile,
): CountingChecker {
	// The active instance made `program`: callers run under runTypeScript6.
	const createTypeChecker = checkerFactory.of(ts);
	if (createTypeChecker) return createTypeChecker(program);
	const fresh = programWithFreshChecker(program);
	if (fresh.getSourceFile(sourceFile.fileName) !== sourceFile) {
		throw new Error(
			`Could not reuse ${sourceFile.fileName} in a new program to count type instantiations`,
		);
	}
	return fresh.getTypeChecker() as CountingChecker;
}

/** The same program with a checker of its own, sharing its source files. */
function programWithFreshChecker(program: ts.Program): ts.Program {
	const options = program.getCompilerOptions();
	const host = ts.createCompilerHost(options);
	const readSourceFile = host.getSourceFile;
	host.getSourceFile = (fileName, ...rest) =>
		program.getSourceFile(fileName) ?? readSourceFile(fileName, ...rest);
	return ts.createProgram({
		rootNames: program.getRootFileNames(),
		options,
		host,
		oldProgram: program,
		projectReferences: program.getProjectReferences(),
	});
}
