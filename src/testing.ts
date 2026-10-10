import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import {
	COMPILER_MODES,
	compilerDirectory,
	compilerMode,
	resolveTypeScript6,
	withCompilerInfo,
} from "./compiler.js";
import { contractError } from "./contract.js";
import {
	type CostTarget,
	measureCombinedCost,
	measureTargetCosts,
} from "./core/hover-cost.js";
import {
	DEFAULT_UTILITY_TYPES,
	type ReadabilityIssue,
	type ReadabilityRule,
	type ReadabilityRules,
	typeReadabilityIssues,
} from "./core/readability.js";
import { resolveTextColumn } from "./core/text-target.js";
import { withTypeScript } from "./core/ts-runtime.js";
import { COST_NEEDS_TYPESCRIPT6, TypeprobeError } from "./errors.js";
import { hover } from "./index.js";
import { callNative, closeNative, DEFAULT_TIMEOUT_MS } from "./native-sync.js";
import type {
	CompilerInfo,
	CompilerMode,
	HoverCost,
	HoverOptions,
	HoverResult,
} from "./types.js";

export { PrinferError, TypeprobeError } from "./errors.js";
export {
	DEFAULT_UTILITY_TYPES,
	type ReadabilityIssue,
	type ReadabilityRule,
	type ReadabilityRules,
	typeReadabilityIssues,
};

/**
 * A source file for the testing helpers. Pass `import.meta.url` for the test
 * file itself, or `new URL("../src/module.ts", import.meta.url)` for another
 * module. Relative path strings resolve against `process.cwd()`.
 */
export type TestingFile = string | URL;

/** Options shared by every `inferredCompletions` selector. */
interface InferredCompletionsOptions {
	/** Optional path to tsconfig.json (default: the nearest one above the file). */
	project?: string;
	/**
	 * `inferredCompletions` always runs on TypeScript 7 and returns every
	 * completion name, with no prefix filter or limit. (The MCP `completions`
	 * tool and `typeprobe complete` use TypeScript 6 and return 50 by default.)
	 */
	backend?: "typescript7";
	/** Which TypeScript 7 compiler to use; see `CompilerMode`. */
	compiler?: CompilerMode;
	/** See `InferredTypeOptions.timeout`. */
	timeout?: number;
	/**
	 * Throw on selector keys this helper doesn't know, with the closest valid
	 * key (default false: unknown keys are ignored). Tests usually run without
	 * type checking, so this is what catches `includeDocs` for
	 * `include_docs`.
	 */
	strict?: boolean;
}

export interface InferredCompletionsPosition
	extends InferredCompletionsOptions {
	/** Positive, 1-based source line. */
	line: number;
	/** Positive, 1-based cursor column: the cursor sits before this character. */
	column: number;
}

export interface InferredCompletionsTextTarget
	extends InferredCompletionsOptions {
	/** Positive, 1-based source line. */
	line: number;
	/** Exact text on the line that places the cursor. */
	text: string;
	/** 1-based match of `text` on the line (default 1). */
	occurrence?: number;
	/**
	 * Cursor placement relative to the match: `"end"` (default) puts it right
	 * after the text, so `text: "user."` completes members and `text: '"'`
	 * completes inside a string literal; `"start"` puts it before the text.
	 */
	cursor?: "start" | "end";
}

export type InferredCompletionsSelector =
	| InferredCompletionsPosition
	| InferredCompletionsTextTarget;

/** Options shared by every `inferredType` and `inferredTypeInfo` selector. */
export interface InferredTypeOptions
	extends Omit<HoverOptions, "full" | "backend"> {
	/**
	 * Untruncated types, on by default so a change anywhere in a type fails
	 * the snapshot. Pass `false` for editor-style truncation (`{ ...; }`).
	 */
	full?: boolean;
	/**
	 * `typeprobe/testing` defaults to `"typescript6"`. Both backends return
	 * synchronously. (The MCP server defaults to TypeScript 7; the CLI and
	 * library to TypeScript 6.)
	 */
	backend?: "typescript6" | "typescript7";
	/**
	 * Milliseconds a TypeScript 7 call may block before it throws (default
	 * 60000, enough for a cold load of a large project). The compiler that
	 * missed it is stopped and the next call starts a new one, so a hung
	 * compiler fails one test instead of the whole run. A test runner's own
	 * timeout cannot interrupt the call. Ignored on TypeScript 6.
	 */
	timeout?: number;
	/**
	 * Throw on selector keys this helper doesn't know, with the closest valid
	 * key (default false: unknown keys are ignored). Tests usually run without
	 * type checking, so this is what catches `includeDocs` for
	 * `include_docs`.
	 */
	strict?: boolean;
}

export interface InferredTypeTarget extends InferredTypeOptions {
	/** The declaration name whose inferred type should be captured. */
	name: string;
	/** 1-based line that picks among same-named declarations. */
	line?: number;
}

export interface InferredTypePosition extends InferredTypeOptions {
	/** Positive, 1-based source line. */
	line: number;
	/** Positive, 1-based source column. */
	column: number;
}

export interface InferredTypeTextTarget extends InferredTypeOptions {
	/** Positive, 1-based source line. */
	line: number;
	/** Exact text on the line; the type is read where the match starts. */
	text: string;
	/** 1-based match of `text` on the line (default 1). */
	occurrence?: number;
}

export type InferredTypeSelector =
	| InferredTypeTarget
	| InferredTypePosition
	| InferredTypeTextTarget;

type TypeScript6InferredTypeSelector = InferredTypeSelector & {
	backend?: "typescript6";
};

/**
 * One target of a batched `inferredTypeCost`: a selector's target keys,
 * without options.
 */
export type InferredTypeCostTarget =
	| { name: string; line?: number }
	| { line: number; column: number }
	| { line: number; text: string; occurrence?: number };

/** Options of a batched `inferredTypeCost`. */
interface InferredTypeCostBatchOptions {
	/** Optional path to tsconfig.json (default: the nearest one above the file). */
	project?: string;
	/** Costs are counted on TypeScript 6 only. */
	backend?: "typescript6";
	/** Which TypeScript 6 compiler counts; see `CompilerMode`. */
	compiler?: CompilerMode;
	/** See `InferredTypeOptions.strict`; also checks each target's keys. */
	strict?: boolean;
}

export interface InferredTypeCostNames extends InferredTypeCostBatchOptions {
	/** Declaration names, each counted like `{ name }`. */
	names: readonly string[];
}

export interface InferredTypeCostTargets extends InferredTypeCostBatchOptions {
	/** Targets of any selector shape, counted in order. */
	targets: readonly InferredTypeCostTarget[];
}

/** The selector of `inferredTypeIssues`: `inferredType`'s, and `rules`. */
export type InferredTypeIssuesSelector = InferredTypeSelector & {
	/** Which readability checks run (default: all of them). */
	rules?: ReadabilityRules;
};

/** The checks of `expectType`; at least one is required. */
export interface TypeExpectations {
	/** The exact type text `inferredType` returns for the same selector. */
	printed?: string;
	/** Budget for the TypeScript 6 instantiation count (`inferredTypeCost`). */
	maxInstantiations?: number;
	/** Budget for the TypeScript 6 type count (`inferredTypeCost`). */
	maxTypes?: number;
	/**
	 * Fail on readability issues in the printed type (see
	 * `typeReadabilityIssues`): `true` for the default rules, or the
	 * rules to use.
	 */
	readable?: boolean | ReadabilityRules;
}

/** The option `expectType` takes beyond `inferredType`'s. */
export interface ExpectTypeOptions {
	/**
	 * Which TypeScript 6 counts the budgets; see `CompilerMode`. Defaults
	 * to `compiler`, so set it to print on one compiler and count on
	 * another: `backend: "typescript7"` and `costCompiler: "project"` print
	 * on the bundled TypeScript 7 and count on the project's TypeScript 6.
	 */
	costCompiler?: CompilerMode;
}

export type ExpectTypeSelector = InferredTypeSelector &
	TypeExpectations &
	ExpectTypeOptions;

/**
 * What `expectType` checked, when every check passed. Its non-enumerable
 * `compiler` names the compiler that printed the type.
 */
export interface ExpectedType {
	/** The printed type. */
	printed: string;
	/**
	 * The TypeScript 6 cost, when a budget was given; its non-enumerable
	 * `compiler` names the compiler that counted.
	 */
	cost?: HoverCost;
}

/**
 * The selector of `expectTypes`: the types, a budget for all of them
 * together, and options set once for every type.
 */
export interface ExpectTypesSelector extends ExpectTypeOptions {
	/**
	 * One `expectType` selector per type, each with its own checks and
	 * budgets. `project`, `compiler`, and `costCompiler` go on the group.
	 */
	types: readonly ExpectTypeSelector[];
	/** Budget for the instantiations of all the types together. */
	maxInstantiations?: number;
	/** Budget for the types created for all the types together. */
	maxTypes?: number;
	/** See `InferredTypeOptions`; applies to every type. */
	project?: string;
	/** See `InferredTypeOptions`; applies to every type. */
	compiler?: CompilerMode;
	/** Default for every type, which a type's own value overrides. */
	backend?: "typescript6" | "typescript7";
	/** Default for every type, which a type's own value overrides. */
	full?: boolean;
	/** Default for every type, which a type's own value overrides. */
	sort_unions?: boolean;
	/** Default for every type, which a type's own value overrides. */
	readable?: boolean | ReadabilityRules;
	/** Default for every type, which a type's own value overrides. */
	timeout?: number;
	/** See `InferredTypeOptions.strict`; also checks every type's keys. */
	strict?: boolean;
}

/** What `expectTypes` checked, when every check passed. */
export interface ExpectedTypes {
	/**
	 * What each type's checks returned, in order. With a group budget,
	 * every one has its own `cost`, counted alone.
	 */
	types: ExpectedType[];
	/** The cost of all the types together, when the group has a budget. */
	cost?: HoverCost;
}

/** One failed `expectType` or `expectTypes` check. */
export interface TypeExpectationFailure {
	check: keyof TypeExpectations;
	/**
	 * In `expectTypes`, the failed type's index in `types`; absent for the
	 * group budget.
	 */
	index?: number;
	message: string;
}

/**
 * Thrown by `expectType` and `expectTypes`, listing every check that
 * failed. When exactly one printed text differs, `actual` and `expected`
 * hold it, so Vitest and Jest show their diff as well.
 */
export class TypeExpectationError extends Error {
	readonly failures: TypeExpectationFailure[];
	readonly actual?: string;
	readonly expected?: string;
	readonly showDiff?: boolean;

	constructor(
		message: string,
		failures: TypeExpectationFailure[],
		text?: { actual: string; expected: string },
	) {
		super(message);
		this.name = "TypeExpectationError";
		this.failures = failures;
		if (text) {
			this.actual = text.actual;
			this.expected = text.expected;
			this.showDiff = true;
		}
	}
}

type Target =
	| { kind: "name"; name: string; line?: number }
	| { kind: "position"; line: number; column: number };

interface Request {
	helper: string;
	input: TestingFile;
	file: string;
	backend: "typescript6" | "typescript7";
	/** Milliseconds a TypeScript 7 call may block. */
	timeout: number;
}

/**
 * Return every completion name TypeScript 7 offers at a cursor, sorted the
 * way the compiler returns them, with no prefix filter or limit, so a
 * snapshot catches any added or removed entry.
 *
 * @example
 * ```ts
 * expect(
 *   inferredCompletions(import.meta.url, { line: 12, text: 'drink("' }),
 * ).toMatchInlineSnapshot();
 * ```
 *
 * Synchronous: the call blocks until TypeScript 7 answers (see `timeout`).
 */
export function inferredCompletions(
	file: TestingFile,
	selector: InferredCompletionsSelector,
): string[];
export function inferredCompletions(
	file: TestingFile,
	selector: InferredCompletionsSelector,
	...extra: unknown[]
): string[] {
	const request = createRequest("inferredCompletions", file, selector, extra);
	if (request.backend !== "typescript7") {
		throw testingError(
			"INVALID_ARGUMENT",
			`inferredCompletions only supports backend "typescript7", got ${JSON.stringify(selector.backend)}.`,
			"Omit backend; inferredCompletions always uses TypeScript 7.",
		);
	}
	try {
		const target = resolveTarget(request, selector, "end");
		if (target.kind === "name") {
			throw invalidSelector(request.helper);
		}
		return callNative(
			"completionNames",
			[
				request.file,
				target.line,
				target.column,
				{
					project: projectPath(selector.project),
					compiler: compilerMode(selector.compiler),
				},
			],
			request.timeout,
		);
	} catch (error) {
		throw explain(error, request, selector);
	}
}

/**
 * The printed type of a target, for a snapshot matcher. Untruncated unless
 * `full: false`. Synchronous on both backends: TypeScript 6 by default, or
 * TypeScript 7 with `backend: "typescript7"`, which blocks until the
 * compiler answers (see `timeout`).
 *
 * Options go in the selector, e.g. `{ name: "result", backend: "typescript7" }`;
 * a third argument throws. Unknown keys are ignored unless `strict: true`.
 *
 * @example
 * ```ts
 * expect(
 *   inferredType(import.meta.url, { name: "result" }),
 * ).toMatchInlineSnapshot(`"Result<string>"`);
 * ```
 */
export function inferredType(
	file: TestingFile,
	selector: InferredTypeSelector,
): string;
export function inferredType(
	file: TestingFile,
	selector: InferredTypeSelector,
	...extra: unknown[]
): string {
	return inferredTypeInfoImpl("inferredType", file, selector, extra)
		.signature;
}

/**
 * The full hover result (name, kind, return type, docs, cost) for the same
 * selector as `inferredType`. Synchronous on both backends.
 */
export function inferredTypeInfo(
	file: TestingFile,
	selector: InferredTypeSelector,
): HoverResult;
export function inferredTypeInfo(
	file: TestingFile,
	selector: InferredTypeSelector,
	...extra: unknown[]
): HoverResult {
	return inferredTypeInfoImpl("inferredTypeInfo", file, selector, extra);
}

/**
 * Count the checker work behind a type, for a test that keeps it within a
 * budget. The counts come from a fresh TypeScript 6 checker (see
 * `HoverCost`), so they are the same on every run, in any test order, and
 * change only when the code, the compiler options, or the TypeScript
 * version does. Synchronous; TypeScript 6 only. Takes the same selector
 * as `inferredType`, `strict` included; a third argument throws.
 *
 * Pass `{ names: [...] }` for a record of costs by name, or
 * `{ targets: [...] }` for an array of costs in order, from one load of the
 * file. Every count still gets a fresh checker, so a batch counts exactly
 * what single calls do. `compiler` picks the TypeScript 6 that counts (see
 * `CompilerMode`); each cost names it in its non-enumerable `compiler`.
 *
 * @example
 * ```ts
 * expect(
 *   inferredTypeCost(import.meta.url, { name: "userSchema" }).instantiations,
 * ).toBeLessThan(2_000);
 * const costs = inferredTypeCost(import.meta.url, { names: ["a", "b"] });
 * expect(costs.a.instantiations).toBeLessThan(500);
 * ```
 */
export function inferredTypeCost(
	file: TestingFile,
	selector: InferredTypeCostNames,
): Record<string, HoverCost>;
export function inferredTypeCost(
	file: TestingFile,
	selector: InferredTypeCostTargets,
): HoverCost[];
export function inferredTypeCost(
	file: TestingFile,
	selector: TypeScript6InferredTypeSelector,
): HoverCost;
export function inferredTypeCost(
	file: TestingFile,
	selector:
		| TypeScript6InferredTypeSelector
		| InferredTypeCostNames
		| InferredTypeCostTargets,
	...extra: unknown[]
): HoverCost | HoverCost[] | Record<string, HoverCost> {
	const helper = "inferredTypeCost";
	if (
		typeof selector === "object" &&
		selector &&
		"costCompiler" in selector
	) {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} only counts, so it takes compiler, not costCompiler.`,
			"Rename costCompiler to compiler: it picks the TypeScript 6 that counts.",
		);
	}
	const request = createRequest(helper, file, selector, extra);
	if (request.backend === "typescript7") {
		throw costNeedsTypeScript6(helper);
	}
	const { names, targets, strict } = selector as {
		names?: unknown;
		targets?: unknown;
		strict?: boolean;
	};
	const on = selector as { project?: string; compiler?: CompilerMode };
	if (names === undefined && targets === undefined) {
		return countCosts(request, on, false, [selector])[0] as HoverCost;
	}
	const single = ["name", "line", "column", "text", "occurrence"].filter(
		(key) => key in selector,
	);
	const list = names ?? targets;
	if (
		(names !== undefined && targets !== undefined) ||
		single.length > 0 ||
		!Array.isArray(list)
	) {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} needs exactly one of a target, names, or targets${single.length > 0 ? `, got ${[...single, names === undefined ? "targets" : "names"].join(" and ")}` : ""}.`,
			'Pass { names: ["a", "b"] } for costs by name, or { targets: [{ name: "a" }, { line: 3, text: "b" }] } for costs in order.',
		);
	}
	if (names === undefined) {
		return countCosts(request, on, strict === true, list);
	}
	const invalid = list.find((name) => typeof name !== "string");
	if (invalid !== undefined) {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} needs names as strings, got ${JSON.stringify(invalid)}.`,
			"Pass declaration names, or use targets for other selector shapes.",
		);
	}
	const costs = countCosts(
		request,
		on,
		false,
		list.map((name: string) => ({ name })),
	);
	return Object.fromEntries(
		list.map((name: string, index) => [name, costs[index] as HoverCost]),
	);
}

/**
 * Every readability issue in the printed type of a target: what
 * `typeReadabilityIssues` finds in `inferredType`'s text for the same
 * selector (on either backend; `sort_unions` and `full` apply). An empty
 * array means the type reads as it should.
 *
 * @example
 * ```ts
 * expect(inferredTypeIssues(import.meta.url, { name: "user" })).toEqual([]);
 * ```
 */
export function inferredTypeIssues(
	file: TestingFile,
	selector: InferredTypeIssuesSelector,
): ReadabilityIssue[];
export function inferredTypeIssues(
	file: TestingFile,
	selector: InferredTypeIssuesSelector,
	...extra: unknown[]
): ReadabilityIssue[] {
	const helper = "inferredTypeIssues";
	createRequest(helper, file, selector, extra);
	const { rules, ...rest } = selector;
	const checked = readabilityRules(helper, "rules", rules ?? true);
	const { signature } = inferredTypeInfoImpl(helper, file, rest, []);
	return typeReadabilityIssues(signature, checked);
}

/**
 * Assert a target's printed type, cost budget and readability in one
 * call. Throws a `TypeExpectationError` that lists every failed check,
 * with the expected and actual text, the count and its budget, and each
 * readability issue; returns what it checked when all of them pass. It
 * only throws, so it works in any test runner.
 *
 * The text comes from the selector's backend and `compiler`, exactly as
 * `inferredType` returns it (`sort_unions` and `full` apply). Costs are
 * always counted on TypeScript 6, also with `backend: "typescript7"`:
 * TypeScript 7 reports no counts. `costCompiler` picks the TypeScript 6
 * that counts, and defaults to `compiler`; with `backend: "typescript7"`,
 * a `compiler: "project"` counts on the project's TypeScript 6 when it has
 * one and on the bundled one otherwise. A failed budget names the
 * compilers that counted and printed. Synchronous on both backends; a
 * third argument throws.
 *
 * @example
 * ```ts
 * expectType(import.meta.url, {
 *   name: "user",
 *   printed: "{ id: string; name: string; }",
 *   maxInstantiations: 500,
 *   readable: true,
 * });
 * ```
 */
export function expectType(
	file: TestingFile,
	selector: ExpectTypeSelector,
): ExpectedType;
export function expectType(
	file: TestingFile,
	selector: ExpectTypeSelector,
	...extra: unknown[]
): ExpectedType {
	const checked = checkType("expectType", file, selector, extra, false);
	const { failures } = checked;
	if (failures.length > 0) {
		const header = `expectType failed ${plural(failures.length, "check")} for ${describeTarget(selector)} at ${checked.where}:`;
		throw expectationError([header, ...bullets(failures)], failures, [
			checked,
		]);
	}
	return expectedType(checked, checked.cost);
}

/**
 * Assert several targets of one file, each like `expectType`, and a
 * budget for all of them together, in one call that throws one
 * `TypeExpectationError` listing every failed check.
 *
 * The group's `maxInstantiations` and `maxTypes` count one fresh
 * TypeScript 6 checker resolving every type in turn, so work the types
 * share (a schema they all reach, a generic instantiated the same way) is
 * counted once, as a check of the whole file counts it. That total is the
 * same in any order of `types`. Each type's own budgets still count it
 * alone, and a failed group budget lists every type's count alone, which
 * add up to more than the total. Options set on the group apply to every
 * type; `project`, `compiler`, and `costCompiler` can only be set there,
 * since the total is counted on one program. Synchronous; a third
 * argument throws.
 *
 * @example
 * ```ts
 * expectTypes(import.meta.url, {
 *   types: [
 *     { name: "userSchema", maxInstantiations: 3_000 },
 *     { name: "User", printed: "{ id: string; name: string; }" },
 *   ],
 *   maxInstantiations: 5_000,
 * });
 * ```
 */
export function expectTypes(
	file: TestingFile,
	selector: ExpectTypesSelector,
): ExpectedTypes;
export function expectTypes(
	file: TestingFile,
	selector: ExpectTypesSelector,
	...extra: unknown[]
): ExpectedTypes {
	const helper = "expectTypes";
	const request = createRequest(helper, file, selector, extra);
	const { types, maxInstantiations, maxTypes, project, compiler, strict } =
		selector;
	if (!Array.isArray(types) || types.length === 0) {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} needs types as a non-empty array of expectType selectors, got ${JSON.stringify(types)}.`,
			'Pass { types: [{ name: "a", printed: "string" }, { name: "b" }], maxInstantiations: 5_000 }.',
		);
	}
	assertBudget(helper, "maxInstantiations", maxInstantiations);
	assertBudget(helper, "maxTypes", maxTypes);
	assertCompilerMode(helper, "costCompiler", selector.costCompiler);
	const grouped = maxInstantiations !== undefined || maxTypes !== undefined;
	const defaults = Object.fromEntries(
		Object.entries(selector).filter(([key]) =>
			ROW_DEFAULT_KEYS.includes(key),
		),
	);
	const rows = types.map((row: unknown, index) => {
		const label = `${helper} types[${index}]`;
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw testingError(
				"INVALID_ARGUMENT",
				`${label} needs an expectType selector object, got ${JSON.stringify(row)}.`,
				SELECTOR_SHAPES,
			);
		}
		const fixed = GROUP_ONLY_KEYS.find((key) => key in row);
		if (fixed) {
			throw testingError(
				"INVALID_ARGUMENT",
				`${label} sets ${fixed}, which ${helper} takes once, for every type.`,
				`Move ${fixed} next to types: the group budget counts every type on one program.`,
			);
		}
		return { ...defaults, ...row } as ExpectTypeSelector;
	});
	// One TypeScript 6 counts every type, so the default for a TypeScript 7
	// type applies to all of them (see expectType).
	const costCompiler =
		selector.costCompiler ??
		(compilerMode(compiler) === "project" &&
		rows.some((row) => (row.backend ?? request.backend) === "typescript7")
			? "auto"
			: undefined);
	const shared = Object.fromEntries(
		Object.entries({ project, compiler, costCompiler, strict }).filter(
			([, value]) => value !== undefined,
		),
	);
	const checked = rows.map((row, index) =>
		checkType(
			`${helper} types[${index}]`,
			file,
			{ ...row, ...shared },
			[],
			grouped,
		),
	);

	const failures: TypeExpectationFailure[] = [];
	const lines: string[] = [];
	checked.forEach((type, index) => {
		if (type.failures.length === 0) return;
		const row = rows[index] as ExpectTypeSelector;
		lines.push(
			`- types[${index}], ${describeTarget(row)} at ${type.where}:`,
		);
		for (const failure of type.failures) {
			failures.push({ ...failure, index });
		}
		lines.push(
			...bullets(type.failures)
				.join("\n")
				.split("\n")
				.map((line) => `  ${line}`),
		);
	});
	const typeFailures = failures.length;

	let cost: HoverCost | undefined;
	let alone: HoverCost[] | undefined;
	if (grouped) {
		const on = { project, compiler: costCompiler ?? compiler };
		alone = countCosts(request, on, false, rows);
		cost = countCombinedCost(request, on, rows);
		const note = compilersNote(
			cost,
			checked.map((type) => type.result),
		);
		for (const [check, budget, unit] of [
			["maxInstantiations", maxInstantiations, "instantiations"],
			["maxTypes", maxTypes, "types"],
		] as const) {
			const count = cost[unit];
			if (budget === undefined || count <= budget) continue;
			const each = alone.map((own) => own[unit]);
			const message = [
				`${count} ${unit} for the ${types.length} types together, over the budget of ${budget} by ${count - budget} (${note}).`,
				`Each alone (${each.reduce((sum, value) => sum + value, 0)} in all, with the work they share in each):`,
				...rows.map(
					(row, index) =>
						`  types[${index}], ${describeTarget(row)}: ${each[index]}`,
				),
			].join("\n");
			failures.push({ check, message });
			lines.push(`- group ${check}: ${message.replaceAll("\n", "\n  ")}`);
		}
	}

	if (failures.length > 0) {
		const typesFailed = new Set(
			failures.flatMap((failure) =>
				failure.index === undefined ? [] : [failure.index],
			),
		).size;
		const parts = [
			typesFailed > 0
				? `${typesFailed} of ${plural(types.length, "type")}`
				: undefined,
			failures.length > typeFailures ? "the group budget" : undefined,
		].filter((part) => part !== undefined);
		const where =
			path.relative(process.cwd(), request.file) || request.file;
		const header = `expectTypes failed ${plural(failures.length, "check")} in ${where}, for ${parts.join(" and ")}:`;
		throw expectationError([header, ...lines], failures, checked);
	}
	return cost
		? {
				types: checked.map((type, index) =>
					expectedType(type, alone?.[index]),
				),
				cost,
			}
		: { types: checked.map((type) => expectedType(type, type.cost)) };
}

/** One `expectType`'s lookups and checks, before anything is thrown. */
interface CheckedType {
	result: HoverResult;
	where: string;
	cost?: HoverCost;
	failures: TypeExpectationFailure[];
	/** The text, when `printed` failed. */
	text?: { actual: string; expected: string };
}

/**
 * Run `expectType`'s checks for `selector`, collecting what failed. In a
 * group (`grouped`), a type may check nothing of its own.
 */
function checkType(
	helper: string,
	file: TestingFile,
	selector: ExpectTypeSelector,
	extra: unknown[],
	grouped: boolean,
): CheckedType {
	const request = createRequest(helper, file, selector, extra);
	const {
		printed,
		maxInstantiations,
		maxTypes,
		readable,
		costCompiler,
		...rest
	} = selector;
	if (printed !== undefined && typeof printed !== "string") {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} needs printed as a string, got ${JSON.stringify(printed)}.`,
			'Pass the type text inferredType returns, e.g. printed: "{ id: string; }".',
		);
	}
	assertBudget(helper, "maxInstantiations", maxInstantiations);
	assertBudget(helper, "maxTypes", maxTypes);
	assertCompilerMode(helper, "costCompiler", costCompiler);
	const rules =
		readable === undefined || readable === false
			? undefined
			: readabilityRules(helper, "readable", readable);
	const budgeted = maxInstantiations !== undefined || maxTypes !== undefined;
	if (!grouped && printed === undefined && !budgeted && rules === undefined) {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} got nothing to check.`,
			"Pass at least one of printed, maxInstantiations, maxTypes, or readable: true.",
		);
	}

	const result = inferredTypeInfoImpl(helper, file, rest, []);
	const actual = result.signature;
	// TypeScript 7 counts nothing, so its project compiler can't either:
	// the project's TypeScript 6 counts when it has one, else the bundled.
	const counting =
		costCompiler ??
		(request.backend === "typescript7" &&
		compilerMode(rest.compiler) === "project"
			? "auto"
			: rest.compiler);
	const cost = budgeted
		? (countCosts(
				request,
				{ project: rest.project, compiler: counting },
				false,
				[rest],
			)[0] as HoverCost)
		: undefined;

	const failures: TypeExpectationFailure[] = [];
	if (printed !== undefined && actual !== printed) {
		failures.push({ check: "printed", message: textDiff(printed, actual) });
	}
	for (const [check, budget, count, unit] of [
		[
			"maxInstantiations",
			maxInstantiations,
			cost?.instantiations,
			"instantiations",
		],
		["maxTypes", maxTypes, cost?.types, "types"],
	] as const) {
		if (budget !== undefined && count !== undefined && count > budget) {
			failures.push({
				check,
				message: `${count} ${unit}, over the budget of ${budget} by ${count - budget} (${compilersNote(cost, [result])}).`,
			});
		}
	}
	if (rules !== undefined) {
		const issues = typeReadabilityIssues(actual, rules);
		if (issues.length > 0) {
			failures.push({
				check: "readable",
				message: [
					`${plural(issues.length, "readability issue")}${printed === undefined || actual === printed ? ` in ${actual}` : ""}:`,
					...issues.map(
						(issue) => `  ${issue.rule}: ${issue.message}`,
					),
				].join("\n"),
			});
		}
	}
	const where = `${path.relative(process.cwd(), request.file) || request.file}:${result.line}:${result.column}`;
	const text =
		printed !== undefined && actual !== printed
			? { actual, expected: printed }
			: undefined;
	return { result, where, cost, failures, text };
}

/** What a passing `expectType` returns, naming the compiler that printed. */
function expectedType(
	checked: CheckedType,
	cost: HoverCost | undefined,
): ExpectedType {
	const printed = checked.result.signature;
	const expected: ExpectedType = cost ? { printed, cost } : { printed };
	const printer = (checked.result as { compiler?: CompilerInfo }).compiler;
	return printer ? withCompilerInfo(expected, printer) : expected;
}

/** The error for `failures`; a test runner diffs the text when one differs. */
function expectationError(
	lines: string[],
	failures: TypeExpectationFailure[],
	checked: readonly CheckedType[],
): TypeExpectationError {
	const texts = checked.flatMap((type) => (type.text ? [type.text] : []));
	return new TypeExpectationError(
		lines.join("\n"),
		failures,
		texts.length === 1 ? texts[0] : undefined,
	);
}

function bullets(failures: TypeExpectationFailure[]): string[] {
	return failures.map(
		(failure) =>
			`- ${failure.check}: ${failure.message.replaceAll("\n", "\n  ")}`,
	);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Which compilers counted a cost and printed the types it budgets. */
function compilersNote(
	cost: HoverCost | undefined,
	results: readonly HoverResult[],
): string {
	const name = (info: CompilerInfo | undefined) =>
		info && `${info.name} ${info.version}, ${info.source}`;
	const counted =
		name((cost as { compiler?: CompilerInfo } | undefined)?.compiler) ??
		"TypeScript 6";
	const printers = [
		...new Set(
			results.flatMap((result) => {
				const printer = name(
					(result as { compiler?: CompilerInfo }).compiler,
				);
				return printer ? [printer] : [];
			}),
		),
	];
	if (printers.length === 0) return `counted on ${counted}`;
	if (printers.length === 1 && printers[0] === counted) {
		return `counted and printed on ${counted}`;
	}
	return `counted on ${counted}; printed on ${printers.join(" and ")}`;
}

/**
 * Stop the TypeScript 7 compilers the testing helpers share. Optional: idle
 * sessions don't keep the process alive. If you call it, call it once per
 * run after the last test (under `bun test`, `afterAll` in a `--preload`
 * file), not per test file: the next TypeScript 7 call starts a new
 * compiler and loads the project again. TypeScript 6 programs stay loaded.
 * The compilers are stopped before it returns; the promise settles once
 * their worker thread exits, so awaiting it is optional.
 */
export function closeTestingSessions(): Promise<void> {
	return closeNative();
}

function inferredTypeInfoImpl(
	helper: string,
	file: TestingFile,
	selector: InferredTypeSelector,
	extra: unknown[],
): HoverResult {
	const request = createRequest(helper, file, selector, extra);
	if (request.backend === "typescript7") {
		if (selector.include_cost) throw costNeedsTypeScript6(helper);
		try {
			const target = resolveTarget(request, selector, "start");
			const options = {
				...hoverOptions(selector),
				project: projectPath(selector.project),
				// Resolved here: the worker sees the environment it started with.
				compiler: compilerMode(selector.compiler),
			};
			return target.kind === "name"
				? callNative(
						"typeInfoByName",
						[
							request.file,
							target.name,
							{ ...options, line: target.line },
						],
						request.timeout,
					)
				: callNative(
						"typeInfo",
						[request.file, target.line, target.column, options],
						request.timeout,
					);
		} catch (error) {
			throw explain(error, request, selector);
		}
	}

	try {
		const target = resolveTarget(request, selector, "start");
		const options = hoverOptions(selector);
		return target.kind === "name"
			? hover(request.file, target.name, {
					...options,
					line: target.line,
				})
			: hover(request.file, target.line, target.column, options);
	} catch (error) {
		throw explain(error, request, selector);
	}
}

/**
 * The TypeScript 6 cost of each selector-shaped item, from one load of
 * the file, on the compiler `options.compiler` selects; each cost names
 * it in its non-enumerable `compiler`. With `strict`, an item's keys must
 * be target keys.
 */
function countCosts(
	request: Request,
	options: { project?: string; compiler?: CompilerMode },
	strict: boolean,
	items: readonly unknown[],
): HoverCost[] {
	const targets: CostTarget[] = items.map((item) => {
		if (typeof item !== "object" || item === null) {
			throw testingError(
				"INVALID_ARGUMENT",
				`${request.helper} needs each target as an object, got ${JSON.stringify(item)}.`,
				SELECTOR_SHAPES,
			);
		}
		if (strict) assertKnownKeys(request.helper, item, TARGET_KEYS);
		try {
			const target = resolveTarget(request, item, "start");
			return target.kind === "name"
				? { name: target.name, line: target.line }
				: { line: target.line, column: target.column };
		} catch (error) {
			throw explain(error, request, item);
		}
	});
	const { project } = options;
	try {
		const compiler = resolveTypeScript6(
			compilerMode(options.compiler),
			compilerDirectory(request.file, project),
		);
		return withTypeScript(compiler.ts, () =>
			measureTargetCosts(request.file, targets, project),
		).map((cost) => withCompilerInfo(cost, compiler.info));
	} catch (error) {
		const { index } = error as { index?: number };
		throw explain(
			error,
			request,
			(index !== undefined && items[index]) || {},
		);
	}
}

/**
 * The TypeScript 6 cost of every item together, from one fresh checker
 * (see `measureCombinedCost`), on the compiler `options.compiler` selects.
 */
function countCombinedCost(
	request: Request,
	options: { project?: string; compiler?: CompilerMode },
	items: readonly object[],
): HoverCost {
	const targets: CostTarget[] = items.map((item) => {
		const target = resolveTarget(request, item, "start");
		return target.kind === "name"
			? { name: target.name, line: target.line }
			: { line: target.line, column: target.column };
	});
	const { project } = options;
	const compiler = resolveTypeScript6(
		compilerMode(options.compiler),
		compilerDirectory(request.file, project),
	);
	return withCompilerInfo(
		withTypeScript(compiler.ts, () =>
			measureCombinedCost(request.file, targets, project),
		),
		compiler.info,
	);
}

function assertCompilerMode(
	helper: string,
	field: string,
	value: unknown,
): void {
	if (value === undefined || COMPILER_MODES.includes(value as CompilerMode)) {
		return;
	}
	throw testingError(
		"INVALID_ARGUMENT",
		`${helper} got unknown ${field} ${JSON.stringify(value)}.`,
		'Use "bundled" (typeprobe\'s own TypeScript), "project" (the project\'s), or "auto" (the project\'s when it has a supported one).',
	);
}

function assertBudget(helper: string, field: string, value: unknown): void {
	if (
		value === undefined ||
		(typeof value === "number" && value >= 0 && Number.isFinite(value))
	) {
		return;
	}
	throw testingError(
		"INVALID_ARGUMENT",
		`${helper} needs ${field} as a non-negative number, got ${JSON.stringify(value)}.`,
		`Pass the largest count the test allows, e.g. ${field}: 5_000.`,
	);
}

/** `true` or a rules object, checked; tests run without type checking. */
function readabilityRules(
	helper: string,
	field: string,
	value: unknown,
): ReadabilityRules {
	if (value === true) return {};
	const isStrings = (list: unknown) =>
		Array.isArray(list) && list.every((entry) => typeof entry === "string");
	const rules = value as Record<string, unknown>;
	const valid =
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(rules).every((key) => RULE_KEYS.includes(key)) &&
		(rules.utilityTypes === undefined ||
			rules.utilityTypes === false ||
			isStrings(rules.utilityTypes)) &&
		(rules.allow === undefined || isStrings(rules.allow)) &&
		["objectIntersections", "truncation"].every(
			(key) =>
				rules[key] === undefined || typeof rules[key] === "boolean",
		);
	if (valid) return rules as ReadabilityRules;
	throw testingError(
		"INVALID_ARGUMENT",
		`${helper} got invalid ${field} ${JSON.stringify(value)}.`,
		`Pass ${field === "readable" ? "true, or " : ""}{ utilityTypes?: string[] | false, objectIntersections?: boolean, truncation?: boolean, allow?: string[] }.`,
	);
}

const RULE_KEYS = [
	"utilityTypes",
	"objectIntersections",
	"truncation",
	"allow",
];

/** Expected and actual text, with a caret under the first difference. */
function textDiff(expected: string, actual: string): string {
	let at = 0;
	while (at < expected.length && expected[at] === actual[at]) at++;
	return [
		`the type differs at character ${at + 1}.`,
		`  expected: ${expected}`,
		`  actual:   ${actual}`,
		`            ${" ".repeat(at)}^`,
	].join("\n");
}

function describeTarget(selector: object): string {
	const { name, line, column, text } = selector as {
		name?: string;
		line?: number;
		column?: number;
		text?: string;
	};
	if (name !== undefined) {
		return line === undefined ? `"${name}"` : `"${name}" (line ${line})`;
	}
	return text !== undefined
		? `${JSON.stringify(text)} on line ${line}`
		: `line ${line}, column ${column}`;
}

const COMPLETIONS_SELECTOR_KEYS = [
	"line",
	"column",
	"text",
	"occurrence",
	"cursor",
	"project",
	"compiler",
	"backend",
	"timeout",
	"strict",
];

/** `cursor` stays accepted: it has always worked with `text` at runtime. */
const TYPE_SELECTOR_KEYS = [
	"name",
	"line",
	"column",
	"text",
	"occurrence",
	"cursor",
	"project",
	"compiler",
	"full",
	"include_docs",
	"include_cost",
	"sort_unions",
	"include_timing",
	"backend",
	"timeout",
	"strict",
];

/** The keys each helper takes beyond TYPE_SELECTOR_KEYS. */
const EXTRA_SELECTOR_KEYS: Record<string, string[]> = {
	inferredTypeCost: ["names", "targets"],
	inferredTypeIssues: ["rules"],
	expectType: [
		"printed",
		"maxInstantiations",
		"maxTypes",
		"readable",
		"costCompiler",
	],
};

/** The keys of `expectTypes` (see ExpectTypesSelector). */
const EXPECT_TYPES_KEYS = [
	"types",
	"maxInstantiations",
	"maxTypes",
	"project",
	"compiler",
	"costCompiler",
	"backend",
	"full",
	"sort_unions",
	"readable",
	"timeout",
	"strict",
];

/** `expectTypes` options that only the group takes. */
const GROUP_ONLY_KEYS = ["project", "compiler", "costCompiler"];

/** `expectTypes` options that are defaults for every type. */
const ROW_DEFAULT_KEYS = [
	"backend",
	"full",
	"sort_unions",
	"readable",
	"timeout",
];

/** The keys of one target in a batched inferredTypeCost. */
const TARGET_KEYS = ["name", "line", "column", "text", "occurrence"];

/** The keys of a batched inferredTypeCost (see InferredTypeCostNames). */
const BATCH_SELECTOR_KEYS = [
	"names",
	"targets",
	"project",
	"compiler",
	"backend",
	"strict",
];

/** A selector example that shows options sitting next to the target. */
function selectorExample(helper: string): string {
	if (helper === "inferredCompletions") {
		return `${helper}(file, { line: 3, text: "user.", project: "./tsconfig.json" })`;
	}
	if (helper === "expectType") {
		return `${helper}(file, { name: "result", printed: "string", maxInstantiations: 500 })`;
	}
	if (helper === "expectTypes") {
		return `${helper}(file, { types: [{ name: "a", printed: "string" }, { name: "b" }], maxInstantiations: 5_000 })`;
	}
	// inferredTypeCost has no TypeScript 7 backend to show.
	return helper === "inferredTypeCost"
		? `${helper}(file, { name: "result", project: "./tsconfig.json" })`
		: `${helper}(file, { name: "result", backend: "typescript7" })`;
}

function createRequest(
	helper: string,
	input: TestingFile,
	selector:
		| { backend?: string; strict?: boolean; timeout?: unknown }
		| undefined,
	extra: unknown[],
): Request {
	if (extra.length > 0) {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} takes two arguments (file, selector), got ${extra.length + 2}.`,
			`Move options into the selector object: ${selectorExample(helper)}.`,
		);
	}
	if (typeof selector !== "object" || selector === null) {
		throw invalidSelector(helper);
	}
	if (selector.strict === true) assertKnownKeys(helper, selector);
	const backend =
		selector.backend ??
		(helper === "inferredCompletions" ? "typescript7" : "typescript6");
	if (backend !== "typescript6" && backend !== "typescript7") {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} got unknown backend ${JSON.stringify(backend)}.`,
			helper === "inferredCompletions"
				? "Omit backend; inferredCompletions always uses TypeScript 7."
				: 'Use backend: "typescript7", or omit it for the synchronous TypeScript 6 default.',
		);
	}
	const timeout = selector.timeout ?? DEFAULT_TIMEOUT_MS;
	if (
		typeof timeout !== "number" ||
		!(timeout > 0) ||
		timeout === Number.POSITIVE_INFINITY
	) {
		throw testingError(
			"INVALID_ARGUMENT",
			`${helper} needs timeout as a positive number of milliseconds, got ${JSON.stringify(selector.timeout)}.`,
			`Omit timeout for the default of ${DEFAULT_TIMEOUT_MS}ms, or pass e.g. { timeout: 120_000 }.`,
		);
	}
	return { helper, input, file: sourcePath(input), backend, timeout };
}

/** With `strict: true`, a misspelled option throws instead of being ignored. */
function assertKnownKeys(
	helper: string,
	selector: object,
	keys?: string[],
): void {
	const known = keys ?? selectorKeys(helper, selector);
	const unknown = Object.keys(selector).find((key) => !known.includes(key));
	if (unknown === undefined) return;
	const closest = [...known].sort(
		(left, right) =>
			editDistance(left, unknown) - editDistance(right, unknown),
	)[0];
	const guess =
		closest && editDistance(closest, unknown) <= 3
			? `Did you mean ${closest}? `
			: "";
	throw testingError(
		"INVALID_ARGUMENT",
		`${helper} got unknown ${keys ? "target" : "selector"} key ${JSON.stringify(unknown)}.`,
		`${guess}${keys ? "Target" : "Selector"} keys: ${known.join(", ")}.`,
	);
}

/** The keys a helper's selector takes, by its shape. */
function selectorKeys(helper: string, selector: object): string[] {
	if (helper === "inferredCompletions") return COMPLETIONS_SELECTOR_KEYS;
	if (helper === "expectTypes") return EXPECT_TYPES_KEYS;
	// A type of expectTypes ("expectTypes types[0]") takes expectType's keys.
	if (helper.startsWith("expectTypes ")) {
		return [
			...TYPE_SELECTOR_KEYS,
			...(EXTRA_SELECTOR_KEYS.expectType ?? []),
		];
	}
	// A batch takes only its own options. Mixed with a target, it is left
	// to inferredTypeCost's own, clearer error.
	if (
		helper === "inferredTypeCost" &&
		("names" in selector || "targets" in selector) &&
		!TARGET_KEYS.some((key) => key in selector)
	) {
		return BATCH_SELECTOR_KEYS;
	}
	return [...TYPE_SELECTOR_KEYS, ...(EXTRA_SELECTOR_KEYS[helper] ?? [])];
}

function resolveTarget(
	request: Request,
	selector: object,
	cursor: "start" | "end",
): Target {
	const {
		name,
		line,
		column,
		text,
		occurrence,
		cursor: cursorOption,
	} = selector as {
		name?: unknown;
		line?: unknown;
		column?: unknown;
		text?: unknown;
		occurrence?: unknown;
		cursor?: unknown;
	};

	if (name !== undefined) {
		if (
			typeof name !== "string" ||
			column !== undefined ||
			text !== undefined
		) {
			throw invalidSelector(request.helper);
		}
		if (line !== undefined) assertPositive(request.helper, "line", line);
		return { kind: "name", name, line: line as number | undefined };
	}

	assertPositive(request.helper, "line", line);
	if ((column === undefined) === (text === undefined)) {
		throw invalidSelector(request.helper);
	}
	if (column !== undefined) {
		if (cursorOption !== undefined) throw invalidSelector(request.helper);
		assertPositive(request.helper, "column", column);
		return {
			kind: "position",
			line: line as number,
			column: column as number,
		};
	}
	if (typeof text !== "string" || text.length === 0) {
		throw testingError(
			"INVALID_ARGUMENT",
			`${request.helper} needs a non-empty text string.`,
			"Copy the token exactly from the source line.",
		);
	}
	if (occurrence !== undefined) {
		assertPositive(request.helper, "occurrence", occurrence);
	}
	const place = cursorOption ?? cursor;
	if (place !== "start" && place !== "end") {
		throw testingError(
			"INVALID_ARGUMENT",
			`${request.helper} got cursor ${JSON.stringify(place)}.`,
			'Use cursor: "end" (after the text, the default) or "start".',
		);
	}
	const start = resolveTextColumn(
		readSource(request.file),
		{
			line: line as number,
			text,
			occurrence: occurrence as number | undefined,
		},
		request.file,
	);
	return {
		kind: "position",
		line: line as number,
		column: place === "end" ? start + text.length : start,
	};
}

/** Snapshots default to untruncated types, so a change anywhere in a type fails. */
function hoverOptions(selector: InferredTypeSelector): HoverOptions {
	const {
		project,
		include_docs,
		include_cost,
		full = true,
		sort_unions,
		compiler,
	} = selector;
	return { project, include_docs, include_cost, full, sort_unions, compiler };
}

function assertPositive(helper: string, field: string, value: unknown): void {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return;
	}
	throw testingError(
		"INVALID_ARGUMENT",
		`${helper} needs ${field} as a positive 1-based integer, got ${JSON.stringify(value)}.`,
		SELECTOR_SHAPES,
	);
}

const SELECTOR_SHAPES =
	"Pass { name }, { line, text, occurrence? }, or { line, column }; lines and columns are 1-based.";

function invalidSelector(helper: string): TypeprobeError {
	const shapes =
		helper === "inferredCompletions"
			? 'Pass { line, text, occurrence?, cursor? } or { line, column }; text places the cursor after the match unless cursor: "start".'
			: SELECTOR_SHAPES;
	return testingError(
		"INVALID_ARGUMENT",
		`${helper} needs exactly one target.`,
		shapes,
	);
}

function costNeedsTypeScript6(helper: string): TypeprobeError {
	return testingError(
		"INVALID_ARGUMENT",
		`${helper} cannot count type costs on backend "typescript7". ${COST_NEEDS_TYPESCRIPT6}`,
		"Omit backend to count on TypeScript 6.",
	);
}

/** Test runners print only the message, so it carries the suggestion too. */
function testingError(
	code: TypeprobeError["code"],
	message: string,
	suggestion: string,
	cause?: Error,
): TypeprobeError {
	const error = new TypeprobeError(
		code,
		`${message}\n${suggestion}`,
		suggestion,
	);
	if (cause) error.cause = cause;
	return error;
}

/** Rewrite a lookup failure so the test output says what to change. */
function explain(error: unknown, request: Request, selector: object): Error {
	if (!(error instanceof Error)) return new Error(String(error));
	const existing =
		error instanceof TypeprobeError ? error.suggestion : undefined;
	if (existing && error.message.endsWith(existing)) return error;
	const { code } = contractError(error).error;
	let suggestion: string | undefined;

	if (
		code === "FILE_NOT_FOUND" &&
		error.message.startsWith("File not found")
	) {
		suggestion = fileSuggestion(request.input);
	} else if (code === "SYMBOL_NOT_FOUND") {
		const { name, line } = selector as { name?: string; line?: number };
		suggestion =
			existing ??
			(name !== undefined
				? nameSuggestion(request, name, line)
				: lineSuggestion(request.file, line));
	} else if (code === "TYPESCRIPT_ERROR" || code === "INTERNAL_ERROR") {
		suggestion =
			existing ??
			(request.backend === "typescript7"
				? "Check the tsconfig.json that includes the file, or omit backend to retry with TypeScript 6."
				: undefined);
	} else {
		suggestion = existing;
	}

	return suggestion
		? testingError(code, error.message, suggestion, error)
		: error;
}

function fileSuggestion(input: TestingFile): string {
	const isRelative =
		typeof input === "string" &&
		!input.startsWith("file:") &&
		!path.isAbsolute(input);
	if (isRelative) {
		return `Relative paths resolve against process.cwd() (${process.cwd()}), not the test file. To resolve against the test file, pass new URL(${JSON.stringify(input.startsWith(".") ? input : `./${input}`)}, import.meta.url).`;
	}
	return 'Check the path. new URL("./module.ts", import.meta.url) resolves against the test file.';
}

function nameSuggestion(
	request: Request,
	name: string,
	line: number | undefined,
): string {
	const declarations = declaredNames(request.file);
	const sameName = declarations
		.filter((declaration) => declaration.name === name)
		.map((declaration) => declaration.line);
	if (line !== undefined && sameName.length > 0) {
		return `"${name}" is declared on line ${[...new Set(sameName)].join(", ")}; fix line or omit it.`;
	}
	const names = [...new Set(declarations.map((entry) => entry.name))]
		.filter((candidate) => candidate !== name)
		.sort(
			(left, right) =>
				editDistance(left, name) - editDistance(right, name),
		)
		.slice(0, 5);
	const target =
		"or target the expression with { line, text } copied from its line.";
	return names.length > 0
		? `Declarations in ${path.basename(request.file)} closest to "${name}": ${names.join(", ")}. Pass one as name, ${target}`
		: `No declarations found in ${path.basename(request.file)}; ${target}`;
}

function lineSuggestion(file: string, line: number | undefined): string {
	const source = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const text = line ? source.split(/\r?\n/)[line - 1]?.trim() : undefined;
	const reads = text ? `Line ${line} reads: ${JSON.stringify(text)}. ` : "";
	return `${reads}Target a token with { line, text } copied from the line, or a declaration with { name }.`;
}

function declaredNames(file: string): { name: string; line: number }[] {
	if (!fs.existsSync(file)) return [];
	const sourceFile = ts.createSourceFile(
		file,
		fs.readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const names: { name: string; line: number }[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) ||
			ts.isFunctionDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isInterfaceDeclaration(node) ||
			ts.isTypeAliasDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isPropertyAssignment(node)
		) {
			const declarationName = node.name;
			if (declarationName && ts.isIdentifier(declarationName)) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					declarationName.getStart(sourceFile),
				);
				names.push({ name: declarationName.text, line: line + 1 });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return names;
}

function editDistance(left: string, right: string): number {
	const a = left.toLowerCase();
	const b = right.toLowerCase();
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

function readSource(file: string): string {
	if (!fs.existsSync(file)) {
		throw new TypeprobeError("FILE_NOT_FOUND", `File not found: ${file}`);
	}
	return fs.readFileSync(file, "utf8");
}

/** Resolved here, against the caller's cwd, before it reaches the worker. */
function projectPath(project: string | undefined): string | undefined {
	return project === undefined
		? undefined
		: path.resolve(process.cwd(), project);
}

/** URLs and `file:` strings are converted; other strings resolve against process.cwd(). */
function sourcePath(file: TestingFile): string {
	if (file instanceof URL) return fileURLToPath(file);
	if (file.startsWith("file:")) return fileURLToPath(file);
	return path.resolve(process.cwd(), file);
}
