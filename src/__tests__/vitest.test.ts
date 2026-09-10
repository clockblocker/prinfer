import { describe, expect, test } from "bun:test";
import { inferredType, inferredTypeInfo } from "../testing.js";
import { inferredType as inferredTypeFromVitestAlias } from "../vitest.js";

const genericResult = <const T extends string>(value: T) => ({ value });
// biome-ignore lint/correctness/noUnusedVariables: looked up by name from this source file
const capturedGenericResult = genericResult("preserved-literal");

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
