import { describe, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { PrinferError } from "../errors.js";
import {
	clearProgramCache,
	findNodeByNameAndLine,
	getHoverInfo,
	hover,
	loadProgram,
} from "../index.js";
import { inferredTypeCost, inferredTypeInfo } from "../testing.js";
import type { HoverCost } from "../types.js";

// The first lookup loads a compiler program.
setDefaultTimeout(30_000);

const costFile = path.join(import.meta.dir, "fixtures", "type-cost.ts");
const names = ["Ten", "PartialConfig", "piped", "flags", "light"];

function costs(order: string[]): Record<string, HoverCost | undefined> {
	return Object.fromEntries(
		order.map((name) => [
			name,
			hover(costFile, name, { include_cost: true }).cost,
		]),
	);
}

describe("include_cost", () => {
	test("counts the same on every repeat", () => {
		const first = hover(costFile, "piped", { include_cost: true }).cost;
		expect(first?.instantiations).toBeGreaterThan(0);
		expect(first?.types).toBeGreaterThan(0);
		for (let i = 0; i < 3; i++) {
			expect(
				hover(costFile, "piped", { include_cost: true }).cost,
			).toEqual(first);
		}
	});

	test("does not depend on what was looked up before", () => {
		clearProgramCache();
		const forward = costs(names);
		clearProgramCache();
		// Warm the shared checker first: the counts must not reuse its work.
		for (const name of names) hover(costFile, name, { full: true });
		const reverse = costs([...names].reverse());
		expect(reverse).toEqual(forward);
	});

	test("is the same for every display option", () => {
		const base = hover(costFile, "piped", { include_cost: true }).cost;
		for (const options of [
			{ full: true },
			{ full: false },
			{ include_docs: true },
		]) {
			expect(
				hover(costFile, "piped", { ...options, include_cost: true })
					.cost,
			).toEqual(base);
		}
		const { line, column } = hover(costFile, "piped");
		expect(
			hover(costFile, line, column, { include_cost: true }).cost,
		).toEqual(base);
	});

	test("orders types by the work they take", () => {
		const all = costs(names);
		expect(all.light?.instantiations).toBe(0);
		expect(all.piped?.instantiations).toBeGreaterThan(
			all.flags?.instantiations ?? Number.POSITIVE_INFINITY,
		);
	});

	// Why the counts come from a fresh checker: the shared one reuses work,
	// so its counter depends on what was looked up before.
	test("differs from the shared checker's order-dependent counter", () => {
		clearProgramCache();
		const program = loadProgram(costFile);
		const sourceFile = program.getSourceFile(costFile);
		if (!sourceFile) throw new Error("fixture not loaded");
		const sharedCount = (name: string): number => {
			const node = findNodeByNameAndLine(sourceFile, name);
			if (!node) throw new Error(`no ${name}`);
			const before = program.getInstantiationCount();
			getHoverInfo(program, node, sourceFile, false, true);
			return program.getInstantiationCount() - before;
		};
		const cold = sharedCount("piped");
		expect(cold).toBeGreaterThan(0);
		expect(sharedCount("piped")).toBe(0);
		// The cost is the cold count, every time.
		expect(
			hover(costFile, "piped", { include_cost: true }).cost
				?.instantiations,
		).toBe(cold);
	});
});

describe("inferredTypeCost", () => {
	test("returns the hover's cost, for budget assertions", () => {
		const cost = inferredTypeCost(costFile, { name: "piped" });
		expect(cost).toEqual(
			hover(costFile, "piped", { include_cost: true }).cost as HoverCost,
		);
		expect(cost.instantiations).toBeLessThan(10_000);
		expect(inferredTypeCost(costFile, { line: 29, text: "piped" })).toEqual(
			cost,
		);
		expect(
			inferredTypeInfo(costFile, { name: "piped" }).cost,
		).toBeUndefined();
	});

	test("refuses TypeScript 7, which reports no counts", async () => {
		expect(() =>
			inferredTypeCost(costFile, {
				name: "piped",
				backend: "typescript7",
			} as unknown as Parameters<typeof inferredTypeCost>[1]),
		).toThrow(/TypeScript 7 reports no instantiation counts/);

		const error = await inferredTypeInfo(costFile, {
			name: "piped",
			backend: "typescript7",
			include_cost: true,
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PrinferError);
		expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
		expect((error as Error).message).toContain("Omit backend");
	});
});
