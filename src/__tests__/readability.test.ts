import { describe, expect, test } from "bun:test";
import {
	DEFAULT_UTILITY_TYPES,
	type ReadabilityRules,
	typeReadabilityIssues,
} from "../testing.js";

/** Each issue as [rule, text], in order. */
function issues(text: string, rules?: ReadabilityRules): string[][] {
	return typeReadabilityIssues(text, rules).map((issue) => [
		issue.rule,
		issue.text,
	]);
}

describe("typeReadabilityIssues", () => {
	test("flags unresolved utility types at any depth", () => {
		expect(issues('Omit<User, "id">')).toEqual([
			["utility-type", 'Omit<User, "id">'],
		]);
		expect(issues('{ a: Pick<User, "x">; b: Partial<User>[]; }')).toEqual([
			["utility-type", 'Pick<User, "x">'],
			["utility-type", "Partial<User>"],
		]);
		// The outermost one stands for the ones inside it.
		expect(issues('Partial<Omit<User, "a">>')).toEqual([
			["utility-type", 'Partial<Omit<User, "a">>'],
		]);
		expect(
			issues("Record<Role, User[]> | Promise<Map<string, Set<A>>>"),
		).toEqual([]);
	});

	test("does not flag a utility type over a type parameter", () => {
		expect(issues('<T>(value: T): Omit<T, "id">')).toEqual([]);
		expect(
			issues("type A<T> = { [K in keyof T]: Partial<T[K]>; }"),
		).toEqual([]);
		expect(issues('<T>(value: T): Omit<User, "id">')).toEqual([
			["utility-type", 'Omit<User, "id">'],
		]);
	});

	test("flags intersections with an object type", () => {
		expect(issues("User & { id: string; }")).toEqual([
			["object-intersection", "User & { id: string; }"],
		]);
		expect(issues("{ a: 1; } & ({ b: 2; } | C)")).toEqual([
			["object-intersection", "{ a: 1; } & ({ b: 2; } | C)"],
		]);
		expect(issues("A & { [K in keyof B]: B[K]; }")).toEqual([
			["object-intersection", "A & { [K in keyof B]: B[K]; }"],
		]);
		expect(issues('"a" | (string & {})')).toEqual([]);
		expect(issues("A & B")).toEqual([]);
	});

	test("flags each form of truncation", () => {
		expect(issues('"a" | "b" | ... 3 more ... | "z"')).toEqual([
			["truncation", "... 3 more ..."],
		]);
		expect(issues("{ a: string; ... 3 more ...; z: number; }")).toEqual([
			["truncation", "... 3 more ..."],
		]);
		expect(issues("{ a: { ...; }; }")).toEqual([["truncation", "..."]]);
		expect(issues("Promise<...>")).toEqual([["truncation", "..."]]);
		// Cut at the length limit: unparseable, so only the truncation.
		const cut = typeReadabilityIssues('{ a: Omit<User, "id">; b: str...');
		expect(cut).toEqual([
			{
				rule: "truncation",
				text: "...",
				offset: 29,
				message: "TypeScript cut the text short at its length limit.",
			},
		]);
		// The other rules still run on text with markers in it.
		expect(issues('{ a: Omit<User, "id">; ... 2 more ...; }')).toEqual([
			["utility-type", 'Omit<User, "id">'],
			["truncation", "... 2 more ..."],
		]);
	});

	test("does not mistake rest, spread, or literals for issues", () => {
		expect(issues("(...args: string[]) => [...string[], number]")).toEqual(
			[],
		);
		expect(issues("[...infer Head, ...readonly [1]]")).toEqual([]);
		expect(
			issues('"Omit<User>" | "& { x }" | "..." | "... 3 more ..."'),
		).toEqual([]);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: type text, not a template
		expect(issues('`a${string}...${number}b` | `${Pick<A, "b">}`')).toEqual(
			[["utility-type", 'Pick<A, "b">']],
		);
	});

	test("reports offsets into the printed text", () => {
		const text = '{ a: string; b: Omit<User, "id">; }';
		const [issue] = typeReadabilityIssues(text);
		expect(issue?.offset).toBe(16);
		expect(text.slice(issue?.offset)).toStartWith('Omit<User, "id">');
	});

	test("takes rules", () => {
		const text =
			'DeepPartial<User> & { a: 1; } | Omit<User, "id"> | ... 2 more ...';
		expect(issues(text).map(([rule]) => rule)).toEqual([
			"object-intersection",
			"utility-type",
			"truncation",
		]);
		expect(
			issues(text, {
				utilityTypes: [...DEFAULT_UTILITY_TYPES, "DeepPartial"],
			}),
		).toEqual([
			["object-intersection", "DeepPartial<User> & { a: 1; }"],
			["utility-type", "DeepPartial<User>"],
			["utility-type", 'Omit<User, "id">'],
			["truncation", "... 2 more ..."],
		]);
		expect(
			issues(text, {
				utilityTypes: false,
				objectIntersections: false,
				truncation: false,
			}),
		).toEqual([]);
		expect(
			issues(text, { allow: ['Omit<User, "id">', "... 2 more ..."] }),
		).toEqual([["object-intersection", "DeepPartial<User> & { a: 1; }"]]);
	});
});
