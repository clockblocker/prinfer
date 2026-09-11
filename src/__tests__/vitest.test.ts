import { afterAll, describe, expect, test } from "bun:test";
import {
	closeTestingSessions,
	inferredCompletions,
	inferredType,
	inferredTypeInfo,
} from "../testing.js";
import { inferredType as inferredTypeFromVitestAlias } from "../vitest.js";

const genericResult = <const T extends string>(value: T) => ({ value });
// biome-ignore lint/correctness/noUnusedVariables: looked up by name from this source file
const capturedGenericResult = genericResult("preserved-literal");

afterAll(closeTestingSessions);

describe("test-runner snapshot integration", () => {
	test("captures a declaration by name from import.meta.url", () => {
		expect(
			inferredType(import.meta.url, { name: "capturedGenericResult" }),
		).toBe('{ value: "preserved-literal"; }');
	});

	test("exposes complete hover information", () => {
		const result = inferredTypeInfo(import.meta.url, {
			name: "capturedGenericResult",
		});

		expect(result.name).toBe("capturedGenericResult");
		expect(result.kind).toBe("variable");
	});

	test("captures TypeScript 7 completion names", async () => {
		await expect(
			inferredCompletions(
				new URL("./fixtures/completions.ts", import.meta.url),
				{
					line: 3,
					column: 33,
					backend: "typescript7",
				},
			),
		).resolves.toEqual(["coffee", "tea"]);
	});

	test("uses the asynchronous TypeScript 7 backend for inferred types", async () => {
		const result = inferredType(import.meta.url, {
			name: "capturedGenericResult",
			backend: "typescript7",
		});

		expect(result).toBeInstanceOf(Promise);
		await expect(result).resolves.toContain('value: "preserved-literal";');
	});

	test("expands aliases and indexed accesses in full TypeScript 7 output", async () => {
		const fixture = new URL(
			"./fixtures/native-fidelity.ts",
			import.meta.url,
		);
		const relation = await inferredType(fixture, {
			name: "ExpandedRelationClaim",
			full: true,
			backend: "typescript7",
		});
		const reading = await inferredType(fixture, {
			name: "ExpandedIndexedReading",
			full: true,
			backend: "typescript7",
		});

		expect(relation).toContain(
			'relation: "CaseCounterpart" | "NumberCounterpart" | "PersonCounterpart";',
		);
		expect(relation).not.toContain("GrammaticalRelation");
		expect(relation).not.toContain("...");
		expect(relation).not.toContain("\n");
		expect(reading).toContain('ownerKind: "Lemma";');
		expect(reading).not.toContain('NoteData["reading"]');
	});

	test("keeps compact TypeScript 7 output truncated by default", async () => {
		const relation = await inferredType(
			new URL("./fixtures/native-fidelity.ts", import.meta.url),
			{
				name: "ExpandedRelationClaim",
				backend: "typescript7",
			},
		);

		expect(relation).toContain("...");
		expect(relation).not.toContain("\n");
	});

	test("uses the explicit TypeScript 7 project and reports timing", async () => {
		const fixture = new URL(
			"./fixtures/native-fidelity.ts",
			import.meta.url,
		);
		const result = await inferredTypeInfo(fixture, {
			name: "nullable",
			project: new URL("./fixtures/tsconfig.loose.json", import.meta.url)
				.pathname,
			include_timing: true,
			backend: "typescript7",
		});

		expect(result.signature).toBe("any");
		expect(result.timing?.resolution_ms).toBeGreaterThanOrEqual(0);
	});

	test("returns TypeScript 7 symbol metadata by position", async () => {
		const result = await inferredTypeInfo(
			new URL("./fixtures/with-jsdoc.ts", import.meta.url),
			{
				line: 9,
				column: 17,
				include_docs: true,
				backend: "typescript7",
			},
		);

		expect(result.name).toBe("add");
		expect(result.kind).toBe("function");
		expect(result.documentation).toContain("Adds two numbers together");
		expect(result.returnType).toBe("number");
	});

	test("closes TypeScript 7 testing sessions asynchronously", async () => {
		const closing = closeTestingSessions();
		expect(closing).toBeInstanceOf(Promise);
		await closing;
	});

	test("keeps the Vitest entry point as a compatibility alias", () => {
		expect(
			inferredTypeFromVitestAlias(import.meta.url, {
				name: "capturedGenericResult",
			}),
		).toBe(
			inferredType(import.meta.url, { name: "capturedGenericResult" }),
		);
	});
});
