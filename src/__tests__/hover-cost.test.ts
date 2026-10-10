import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkerFactory } from "../core/hover-cost.js";
import { PrinferError } from "../errors.js";
import {
	batchHover,
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

	test("is the same with sort_unions, which reorders the printed type", () => {
		const plain = hover(costFile, "choice", {
			full: true,
			include_cost: true,
		});
		const sorted = hover(costFile, "choice", {
			full: true,
			include_cost: true,
			sort_unions: true,
		});
		expect(plain.signature).toBe('readonly ["zeta" | "alpha" | null]');
		expect(sorted.signature).toBe('readonly ["alpha" | "zeta" | null]');
		expect(plain.cost?.instantiations).toBeGreaterThan(0);
		expect(sorted.cost).toEqual(plain.cost as HoverCost);
		expect(
			inferredTypeCost(costFile, { name: "choice", sort_unions: true }),
		).toEqual(plain.cost as HoverCost);
		const [batched] = batchHover(
			costFile,
			[{ line: plain.line, column: plain.column }],
			{ include_cost: true, sort_unions: true },
		).items;
		expect(batched?.result?.cost).toEqual(plain.cost as HoverCost);
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

	test("counts the same with a new program per count", () => {
		clearProgramCache();
		const withFactory = costs(names);
		const { createTypeChecker } = checkerFactory;
		checkerFactory.createTypeChecker = undefined;
		try {
			clearProgramCache();
			expect(costs(names)).toEqual(withFactory);
		} finally {
			checkerFactory.createTypeChecker = createTypeChecker;
		}
		expect(typeof createTypeChecker).toBe("function");
	});

	test("is kept with the program, as a copy", () => {
		const first = hover(costFile, "piped", { include_cost: true })
			.cost as HoverCost;
		first.instantiations = -1;
		expect(
			hover(costFile, "piped", { include_cost: true }).cost
				?.instantiations,
		).toBeGreaterThan(0);
	});
});

describe("programs of one project", () => {
	test("share parsed files but not their checker", () => {
		clearProgramCache();
		const sample = path.join(import.meta.dir, "fixtures", "sample.ts");
		const first = loadProgram(costFile);
		const second = loadProgram(sample);
		expect(second).not.toBe(first);
		const lib = first
			.getSourceFiles()
			.find((file) => file.fileName.includes("lib.es5"));
		expect(lib).toBeDefined();
		expect(second.getSourceFile(lib?.fileName as string)).toBe(
			lib as never,
		);
		expect(second.getSourceFile(costFile)).toBe(
			first.getSourceFile(costFile) as never,
		);
		expect(second.getTypeChecker()).not.toBe(first.getTypeChecker());
	});

	test("count the same whichever program parsed the files", () => {
		clearProgramCache();
		const alone = costs(names);
		clearProgramCache();
		// Another entry of the project parses the files and checks the
		// targets first; the cost file's program then reuses those files.
		const sample = path.join(import.meta.dir, "fixtures", "sample.ts");
		const program = loadProgram(sample);
		const sourceFile = program.getSourceFile(costFile);
		if (!sourceFile) throw new Error("fixture not loaded");
		program.getTypeChecker();
		for (const name of names) {
			const node = findNodeByNameAndLine(sourceFile, name);
			if (!node) throw new Error(`no ${name}`);
			getHoverInfo(program, node, sourceFile, false, true);
		}
		expect(loadProgram(costFile).getSourceFile(costFile)).toBe(sourceFile);
		expect(costs(names)).toEqual(alone);
	});

	test("read a changed file again", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-share-"));
		try {
			fs.writeFileSync(
				path.join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { strict: true, types: [] },
				}),
			);
			const a = path.join(dir, "a.ts");
			const b = path.join(dir, "b.ts");
			fs.writeFileSync(a, 'export const a = "a";\n');
			fs.writeFileSync(b, "export const b = 1;\n");
			expect(hover(a, "a").signature).toBe('"a"');
			fs.writeFileSync(b, 'export const b = ["changed"];\n');
			expect(hover(b, "b").signature).toBe("string[]");
			expect(hover(a, "a").signature).toBe('"a"');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
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

	test("counts a batch of names exactly like single calls", () => {
		clearProgramCache();
		const single = Object.fromEntries(
			names.map((name) => [name, inferredTypeCost(costFile, { name })]),
		);
		clearProgramCache();
		const batched = inferredTypeCost(costFile, {
			names: [...names].reverse(),
		});
		expect(batched).toEqual(single);
		expect(Object.keys(batched)).toEqual([...names].reverse());
		expect(inferredTypeCost(costFile, { names: [] })).toEqual({});
	});

	test("counts targets of every shape, in order", () => {
		const piped = inferredTypeCost(costFile, { name: "piped" });
		const { line, column } = hover(costFile, "flags");
		expect(
			inferredTypeCost(costFile, {
				targets: [
					{ line: 29, text: "piped" },
					{ name: "light" },
					{ line, column },
					{ name: "piped", line: 29 },
				],
			}),
		).toEqual([
			piped,
			inferredTypeCost(costFile, { name: "light" }),
			inferredTypeCost(costFile, { name: "flags" }),
			piped,
		]);
	});

	test("rejects a batch mixed with a target, and explains failed targets", () => {
		const message = (run: () => unknown): string => {
			try {
				run();
			} catch (error) {
				expect(error).toBeInstanceOf(PrinferError);
				return (error as Error).message;
			}
			throw new Error("did not throw");
		};
		expect(
			message(() =>
				inferredTypeCost(costFile, {
					names: ["piped"],
					name: "piped",
				} as never),
			),
		).toContain(
			"needs exactly one of a target, names, or targets, got name and names",
		);
		expect(
			message(() =>
				inferredTypeCost(costFile, { names: ["piped", 3] } as never),
			),
		).toContain("needs names as strings, got 3");
		expect(
			message(() =>
				inferredTypeCost(costFile, { names: ["piped", "pipd"] }),
			),
		).toContain('closest to "pipd": pipe, piped');
		expect(
			message(() =>
				inferredTypeCost(costFile, {
					targets: [{ name: "piped" }, { line: 29, text: "nope" }],
				}),
			),
		).toContain('"nope"');
		expect(
			message(() =>
				inferredTypeCost(costFile, {
					targets: [{ name: "piped", project: "x" }],
					strict: true,
				} as never),
			),
		).toContain('unknown target key "project"');
		expect(
			message(() =>
				inferredTypeCost(costFile, {
					names: ["piped"],
					backend: "typescript7",
				} as never),
			),
		).toContain("TypeScript 7 reports no instantiation counts");
	});

	test("refuses TypeScript 7, which reports no counts", () => {
		expect(() =>
			inferredTypeCost(costFile, {
				name: "piped",
				backend: "typescript7",
			} as unknown as Parameters<typeof inferredTypeCost>[1]),
		).toThrow(/TypeScript 7 reports no instantiation counts/);

		let error: unknown;
		try {
			inferredTypeInfo(costFile, {
				name: "piped",
				backend: "typescript7",
				include_cost: true,
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(PrinferError);
		expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
		expect((error as Error).message).toContain("Omit backend");
	});
});
