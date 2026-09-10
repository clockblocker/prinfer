import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import {
	closeNativeSessions,
	nativeHover,
	nativeHoverByName,
} from "../native-lsp.js";

const fixture = path.join(import.meta.dir, "fixtures", "sample.ts");

afterAll(closeNativeSessions);

describe("TypeScript 7 native LSP", () => {
	test("returns native hover information by position", async () => {
		const result = await nativeHover(fixture, 4, 17);
		expect(result.signature).toBe(
			"function add(a: number, b: number): number",
		);
		expect(result.returnType).toBe("number");
		expect(result.name).toBe("add");
		expect(result.kind).toBe("function");
	});

	test("reuses the session for name-based hover", async () => {
		const result = await nativeHoverByName(fixture, "multiply");
		expect(result.signature).toContain("(x: number, y: number) => number");
		expect(result.name).toBe("multiply");
	});
});
