import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrinferError } from "../errors.js";
import {
	closeTestingSessions,
	type ExpectTypeSelector,
	expectType,
	inferredType,
	inferredTypeCost,
	inferredTypeIssues,
	TypeExpectationError,
} from "../testing.js";

// The first lookup per backend loads a compiler program.
setDefaultTimeout(30_000);

afterAll(() => closeTestingSessions());

const types = new URL("./fixtures/expect-type/types.ts", import.meta.url);

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
			`- maxInstantiations: ${instantiations} instantiations, over the budget of 10 by ${instantiations - 10} (counted on TypeScript 6).`,
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
			`${cost.instantiations} instantiations, over the budget of 1 by ${cost.instantiations - 1} (counted on TypeScript 6; the printed type is TypeScript 7's).`,
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
