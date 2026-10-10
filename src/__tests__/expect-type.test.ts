import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createRequire } from "node:module";
import * as ts from "typescript";
import { PrinferError } from "../errors.js";
import {
	closeTestingSessions,
	type ExpectTypeSelector,
	type ExpectTypesSelector,
	expectType,
	expectTypes,
	inferredType,
	inferredTypeCost,
	inferredTypeIssues,
	TypeExpectationError,
} from "../testing.js";

// The first lookup per backend loads a compiler program.
setDefaultTimeout(30_000);

afterAll(() => closeTestingSessions());

const types = new URL("./fixtures/expect-type/types.ts", import.meta.url);
const native = createRequire(import.meta.url)(
	"@typescript/native/package.json",
) as { version: string };

/** The error `expectType` throws, or a failure when it doesn't. */
function failure(selector: ExpectTypeSelector): TypeExpectationError {
	try {
		expectType(types, selector);
	} catch (error) {
		expect(error).toBeInstanceOf(TypeExpectationError);
		return error as TypeExpectationError;
	}
	throw new Error("expectType did not throw");
}

describe("expectType", () => {
	test("passes and returns what it checked", () => {
		const cost = inferredTypeCost(types, { name: "Twenty" });
		expect(
			expectType(types, {
				name: "plain",
				printed: "{ id: string; name: string; }",
				readable: true,
			}),
		).toEqual({ printed: "{ id: string; name: string; }" });
		expect(
			expectType(types, {
				name: "Twenty",
				maxInstantiations: cost.instantiations,
				maxTypes: cost.types,
			}),
		).toEqual({ printed: inferredType(types, { name: "Twenty" }), cost });
	});

	test("shows expected and actual text with the first difference", () => {
		const error = failure({
			name: "plain",
			printed: "{ id: number; name: string; }",
		});
		expect(error.message).toBe(
			[
				`expectType failed 1 check for "plain" at src/__tests__/fixtures/expect-type/types.ts:17:14:`,
				"- printed: the type differs at character 7.",
				"    expected: { id: number; name: string; }",
				"    actual:   { id: string; name: string; }",
				"                    ^",
			].join("\n"),
		);
		expect(error).toMatchObject({
			name: "TypeExpectationError",
			actual: "{ id: string; name: string; }",
			expected: "{ id: number; name: string; }",
			showDiff: true,
		});
		expect(error.failures.map((entry) => entry.check)).toEqual(["printed"]);
	});

	test("lists every failed check at once", () => {
		const { instantiations, types: count } = inferredTypeCost(types, {
			name: "withoutId",
		});
		const error = failure({
			name: "withoutId",
			printed: "{ name: string; }",
			maxInstantiations: 10,
			maxTypes: count,
			readable: true,
		});
		expect(error.failures.map((entry) => entry.check)).toEqual([
			"printed",
			"maxInstantiations",
			"readable",
		]);
		expect(error.message).toContain("expectType failed 3 checks");
		expect(error.message).toContain(
			`- maxInstantiations: ${instantiations} instantiations, over the budget of 10 by ${instantiations - 10} (counted and printed on typescript ${ts.version}, bundled).`,
		);
		expect(error.message).toContain(
			'- readable: 1 readability issue:\n    utility-type: Omit<User, "id"> is unresolved',
		);
		expect(error).toMatchObject({
			actual: 'Omit<User, "id">',
			expected: "{ name: string; }",
		});
	});

	test("readability alone names the type and every issue", () => {
		const error = failure({ name: "extended", readable: true });
		expect(error.message).toContain(
			"- readable: 1 readability issue in User & { extra: number; }:",
		);
		expect(error.actual).toBeUndefined();
		expect(error.showDiff).toBeUndefined();
		// Rules turn checks off, or allow a fragment as printed.
		expect(
			expectType(types, {
				name: "extended",
				readable: { objectIntersections: false },
			}).printed,
		).toBe("User & { extra: number; }");
		expectType(types, {
			name: "extended",
			readable: { allow: ["User & { extra: number; }"] },
		});
		expectType(types, {
			name: "withoutId",
			readable: false,
			printed: 'Omit<User, "id">',
		});
	});

	test("respects sort_unions and full", () => {
		expectType(types, {
			name: "status",
			printed: '"error" | "idle" | null',
			sort_unions: true,
		});
		const error = failure({ name: "wide", full: false, readable: true });
		expect(error.message).toContain(
			"truncation: ... 9 more ... stands for 9",
		);
	});

	test("takes the text from TypeScript 7 and the cost from TypeScript 6", () => {
		const cost = inferredTypeCost(types, { name: "withoutId" });
		expect(
			expectType(types, {
				name: "status",
				backend: "typescript7",
				printed: '"error" | "idle" | null',
				maxInstantiations: 0,
			}),
		).toEqual({
			printed: '"error" | "idle" | null',
			cost: inferredTypeCost(types, { name: "status" }),
		});
		const error = failure({
			name: "withoutId",
			backend: "typescript7",
			maxInstantiations: 1,
		});
		expect(error.message).toContain(
			`${cost.instantiations} instantiations, over the budget of 1 by ${cost.instantiations - 1} (counted on typescript ${ts.version}, bundled; printed on typescript ${native.version}, bundled).`,
		);
	});

	test("rejects calls that check nothing or pass bad options", () => {
		const invalid = (run: () => unknown, pattern: RegExp) => {
			let error: unknown;
			try {
				run();
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(PrinferError);
			expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
			expect((error as Error).message).toMatch(pattern);
		};
		invalid(
			() => expectType(types, { name: "plain" }),
			/got nothing to check/,
		);
		invalid(
			() => expectType(types, { name: "plain", maxInstantiations: -1 }),
			/maxInstantiations as a non-negative number/,
		);
		invalid(
			() =>
				expectType(types, {
					name: "plain",
					readable: { utilityType: ["Omit"] } as never,
				}),
			/invalid readable/,
		);
		invalid(
			() =>
				expectType(types, {
					name: "plain",
					printed: "x",
					maxInstantiation: 5,
					strict: true,
				} as ExpectTypeSelector),
			/unknown selector key "maxInstantiation"\.\nDid you mean maxInstantiations\?/,
		);
		invalid(
			() =>
				(expectType as (...args: unknown[]) => unknown)(
					types,
					{ name: "plain" },
					{ printed: "x" },
				),
			/takes two arguments/,
		);
	});

	test("rethrows lookup failures with their suggestion", () => {
		expect(() =>
			expectType(types, { name: "plian", printed: "x" }),
		).toThrow(/closest to "plian": plain/);
	});

	test("takes costCompiler, which inferredTypeCost rejects for compiler", () => {
		expect(
			expectType(types, {
				name: "plain",
				costCompiler: "bundled",
				maxTypes: 1_000,
				strict: true,
			}).cost,
		).toEqual(inferredTypeCost(types, { name: "plain" }));
		expect(() =>
			expectType(types, {
				name: "plain",
				maxTypes: 1_000,
				costCompiler: "local" as never,
			}),
		).toThrow(/expectType got unknown costCompiler "local"\./);
		for (const selector of [
			{ name: "plain", costCompiler: "project" },
			{ names: ["plain"], costCompiler: "project", strict: true },
		]) {
			expect(() => inferredTypeCost(types, selector as never)).toThrow(
				"inferredTypeCost only counts, so it takes compiler, not costCompiler.\nRename costCompiler to compiler",
			);
		}
	});
});

/** The error `expectTypes` throws, or a failure when it doesn't. */
function groupFailure(selector: ExpectTypesSelector): TypeExpectationError {
	try {
		expectTypes(types, selector);
	} catch (error) {
		expect(error).toBeInstanceOf(TypeExpectationError);
		return error as TypeExpectationError;
	}
	throw new Error("expectTypes did not throw");
}

describe("expectTypes", () => {
	const names = ["withoutId", "extended"];

	test("counts the group's shared work once, and each type alone", () => {
		const alone = inferredTypeCost(types, { names });
		const checked = expectTypes(types, {
			types: [
				{ name: "withoutId", printed: 'Omit<User, "id">' },
				{ name: "extended", maxTypes: 1_000 },
			],
			maxInstantiations: 1_000,
			maxTypes: 1_000,
			strict: true,
		});
		expect(checked).toEqual({
			types: [
				{ printed: 'Omit<User, "id">', cost: alone.withoutId },
				{
					printed: inferredType(types, { name: "extended" }),
					cost: alone.extended,
				},
			],
			cost: checked.cost,
		});
		// Both types resolve User; together it is counted once.
		const sum =
			(alone.withoutId?.types ?? 0) + (alone.extended?.types ?? 0);
		expect(checked.cost?.types).toBeLessThan(sum);
		expect(checked.cost?.compiler).toEqual({
			name: "typescript",
			version: ts.version,
			source: "bundled",
		});
		// Without a group budget, only the types' own checks run.
		expect(
			expectTypes(types, {
				types: [
					{ name: "plain", printed: "{ id: string; name: string; }" },
				],
			}),
		).toEqual({ types: [{ printed: "{ id: string; name: string; }" }] });
	});

	test("counts a group the same in any order of its types", () => {
		const group = (file: URL, rows: string[]) =>
			expectTypes(file, {
				types: rows.map((name) => ({ name })),
				maxTypes: 100_000,
			}).cost;
		// Resolved in this order, a checker creates one type fewer.
		const order = new URL(
			"./fixtures/expect-type/order.ts",
			import.meta.url,
		);
		expect(group(order, ["count", "ByText"])).toEqual(
			group(order, ["ByText", "count"]),
		);
		const rows = ["Twenty", "withoutId", "letters", "extended", "wide"];
		const total = group(types, rows);
		expect(group(types, [...rows].reverse())).toEqual(total);
		expect(group(types, [...rows.slice(2), ...rows.slice(0, 2)])).toEqual(
			total,
		);
	});

	test("lists every failed type and the group budget, with each type's count", () => {
		const alone = inferredTypeCost(types, {
			names: ["plain", "withoutId", "extended"],
		});
		const together = expectTypes(types, {
			types: [
				{ name: "plain" },
				{ name: "withoutId" },
				{ name: "extended" },
			],
			maxTypes: 1_000,
		}).cost?.types as number;
		const error = groupFailure({
			types: [
				{ name: "plain", printed: "{ id: number; name: string; }" },
				{ name: "withoutId" },
				{ name: "extended", maxTypes: 1 },
			],
			maxTypes: 1,
		});
		const own = (name: string) => alone[name]?.types as number;
		const file = "src/__tests__/fixtures/expect-type/types.ts";
		const counted = `counted and printed on typescript ${ts.version}, bundled`;
		expect(error.message).toBe(
			[
				`expectTypes failed 3 checks in ${file}, for 2 of 3 types and the group budget:`,
				`- types[0], "plain" at ${file}:17:14:`,
				"  - printed: the type differs at character 7.",
				"      expected: { id: number; name: string; }",
				"      actual:   { id: string; name: string; }",
				"                      ^",
				`- types[2], "extended" at ${file}:15:14:`,
				`  - maxTypes: ${own("extended")} types, over the budget of 1 by ${own("extended") - 1} (${counted}).`,
				`- group maxTypes: ${together} types for the 3 types together, over the budget of 1 by ${together - 1} (${counted}).`,
				`  Each alone (${own("plain") + own("withoutId") + own("extended")} in all, with the work they share in each):`,
				`    types[0], "plain": ${own("plain")}`,
				`    types[1], "withoutId": ${own("withoutId")}`,
				`    types[2], "extended": ${own("extended")}`,
			].join("\n"),
		);
		expect(
			error.failures.map(({ check, index }) => ({ check, index })),
		).toEqual([
			{ check: "printed", index: 0 },
			{ check: "maxTypes", index: 2 },
			{ check: "maxTypes", index: undefined },
		]);
		expect(error).toMatchObject({
			actual: "{ id: string; name: string; }",
			expected: "{ id: number; name: string; }",
		});
		// Two differing texts leave the diff to the message.
		const both = groupFailure({
			types: [
				{ name: "plain", printed: "x" },
				{ name: "status", printed: "y" },
			],
		});
		expect(both.actual).toBeUndefined();
		expect(both.message).toStartWith(
			`expectTypes failed 2 checks in ${file}, for 2 of 2 types:`,
		);
	});

	test("applies the group's options to every type", () => {
		const status = '"error" | "idle" | null';
		expectTypes(types, {
			types: [{ name: "status", printed: status }],
			sort_unions: true,
			backend: "typescript7",
		});
		const error = groupFailure({
			types: [
				{ name: "withoutId" },
				{ name: "withoutId", readable: false, maxTypes: 1_000 },
			],
			readable: true,
		});
		expect(
			error.failures.map(({ check, index }) => [check, index]),
		).toEqual([["readable", 0]]);
		expect(
			expectTypes(types, {
				types: [{ name: "withoutId" }],
				backend: "typescript7",
				maxInstantiations: 1_000,
			}).cost,
		).toEqual(
			expectTypes(types, {
				types: [{ name: "withoutId" }],
				maxInstantiations: 1_000,
			}).cost,
		);
	});

	test("rejects bad groups and types", () => {
		const invalid = (selector: unknown, pattern: RegExp) => {
			let error: unknown;
			try {
				expectTypes(types, selector as ExpectTypesSelector);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(PrinferError);
			expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
			expect((error as Error).message).toMatch(pattern);
		};
		invalid({ types: [] }, /needs types as a non-empty array/);
		invalid(
			{ types: [{ name: "plain" }] },
			/^expectTypes types\[0\] got nothing to check\./,
		);
		for (const key of ["project", "compiler", "costCompiler"]) {
			invalid(
				{ types: [{ name: "plain", printed: "x", [key]: "bundled" }] },
				new RegExp(
					`^expectTypes types\\[0\\] sets ${key}, which expectTypes takes once, for every type\\.`,
				),
			);
		}
		invalid(
			{ types: [{ name: "plain" }], maxInstantiation: 5, strict: true },
			/^expectTypes got unknown selector key "maxInstantiation"\.\nDid you mean maxInstantiations\?/,
		);
		invalid(
			{
				types: [{ name: "plain", prinetd: "x" }],
				maxTypes: 5,
				strict: true,
			},
			/^expectTypes types\[0\] got unknown selector key "prinetd"\.\nDid you mean printed\?/,
		);
		invalid(
			{ types: [{ name: "plain" }], maxTypes: -1 },
			/maxTypes as a non-negative number/,
		);
		expect(() =>
			(expectTypes as (...args: unknown[]) => unknown)(
				types,
				{ types: [{ name: "plain" }] },
				{ maxTypes: 5 },
			),
		).toThrow(/takes two arguments/);
	});
});

describe("inferredTypeIssues", () => {
	test("checks the printed type on either backend", () => {
		expect(inferredTypeIssues(types, { name: "plain" })).toEqual([]);
		for (const backend of ["typescript6", "typescript7"] as const) {
			expect(
				inferredTypeIssues(types, { name: "withoutId", backend }),
			).toEqual([
				{
					rule: "utility-type",
					text: 'Omit<User, "id">',
					offset: 0,
					message:
						'Omit<User, "id"> is unresolved: TypeScript printed Omit<...> instead of the type it produces.',
				},
			]);
			expect(
				inferredTypeIssues(types, { name: "quoted", backend }),
			).toEqual([]);
		}
		expect(
			inferredTypeIssues(types, {
				name: "withoutId",
				rules: { utilityTypes: false },
			}),
		).toEqual([]);
		expect(
			inferredTypeIssues(types, { name: "shouted", full: false }).map(
				(issue) => issue.text,
			),
		).toEqual(["... 9 more ..."]);
	});
});
