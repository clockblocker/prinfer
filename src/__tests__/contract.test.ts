import { describe, expect, test } from "bun:test";
import {
	batchHoverSuccess,
	batchHoverSuccessSchema,
	contractError,
	contractErrorResponseSchema,
	hoverSuccess,
	hoverSuccessSchema,
} from "../contract.js";

describe("contract v1", () => {
	test("validates hover success responses", () => {
		const response = hoverSuccess({
			signature: "(value: string): number",
			returnType: "number",
			line: 4,
			column: 1,
			kind: "function",
			name: "length",
		});

		expect(hoverSuccessSchema.parse(response)).toEqual(response);
	});

	test("validates batch success responses", () => {
		const response = batchHoverSuccess({
			items: [
				{
					position: { line: 4, column: 1 },
					error: {
						code: "SYMBOL_NOT_FOUND",
						message: "No symbol found at file.ts:4:1",
						file: "/project/file.ts",
						line: 4,
						column: 1,
						suggestion:
							"Try hover_by_name when you know the symbol name, or move the position onto the symbol token.",
					},
				},
			],
			successCount: 0,
			errorCount: 1,
		});

		expect(batchHoverSuccessSchema.parse(response)).toEqual(response);
	});

	test("classifies public errors", () => {
		const response = contractError(
			new Error("No symbol found at file.ts:1:1"),
			{
				file: "/project/file.ts",
				line: 1,
				column: 1,
			},
		);

		expect(contractErrorResponseSchema.parse(response)).toEqual(response);
		expect(response.error.code).toBe("SYMBOL_NOT_FOUND");
		expect(response.error.suggestion).toContain("hover_by_name");
	});
});
