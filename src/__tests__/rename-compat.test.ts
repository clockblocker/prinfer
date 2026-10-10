// What keeps code written against prinfer (before the 4.0 rename) working.
import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import { readEnv } from "../env.js";
import * as main from "../index.js";
import * as testing from "../testing.js";
import { ensureFreshBuild, packageRoot } from "./helpers/build.js";

describe("PrinferError", () => {
	test("is TypeprobeError, exported from . and ./testing", () => {
		expect(main.PrinferError).toBe(main.TypeprobeError);
		expect(testing.PrinferError).toBe(main.TypeprobeError);
		expect(testing.TypeprobeError).toBe(main.TypeprobeError);
	});

	test("matches errors typeprobe throws", () => {
		let error: unknown;
		try {
			testing.inferredType("does-not-exist.ts", { name: "x" });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(main.TypeprobeError);
		expect(error).toBeInstanceOf(main.PrinferError);
		expect((error as main.PrinferError).code).toBe("FILE_NOT_FOUND");
		expect(new Error("plain")).not.toBeInstanceOf(main.TypeprobeError);
	});

	test("matches across the built entry points, ESM and CommonJS", async () => {
		ensureFreshBuild();
		// Each entry bundles its own copy of the class.
		const dist = path.join(packageRoot, "dist");
		const load = createRequire(import.meta.url);
		const mains: (typeof main)[] = [
			await import(path.join(dist, "index.js")),
			load(path.join(dist, "index.cjs")),
		];
		const testings: (typeof testing)[] = [
			await import(path.join(dist, "testing.js")),
			load(path.join(dist, "testing.cjs")),
		];
		const errors = [
			...mains.map((entry) =>
				thrown(() => entry.hover(SAMPLE, "noSuchName")),
			),
			...testings.map((entry) =>
				thrown(() => entry.inferredType("missing.ts", { name: "x" })),
			),
		];
		for (const error of errors) {
			for (const entry of [...mains, ...testings]) {
				expect(error).toBeInstanceOf(entry.TypeprobeError);
				expect(error).toBeInstanceOf(entry.PrinferError);
			}
		}
	});
});

const SAMPLE = path.join(import.meta.dir, "fixtures", "sample.ts");

function thrown(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected a throw");
}

const NAMES = ["TYPEPROBE_BACKEND", "PRINFER_BACKEND"];
const saved = Object.fromEntries(
	NAMES.map((name) => [name, process.env[name]]),
);

afterEach(() => {
	for (const name of NAMES) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
});

describe("environment variables", () => {
	test("read TYPEPROBE_*, then the deprecated PRINFER_*", () => {
		for (const name of NAMES) delete process.env[name];
		expect(readEnv("BACKEND")).toBeUndefined();

		process.env.PRINFER_BACKEND = "typescript6";
		expect(readEnv("BACKEND")).toEqual({
			value: "typescript6",
			variable: "PRINFER_BACKEND",
		});

		process.env.TYPEPROBE_BACKEND = "typescript7";
		expect(readEnv("BACKEND")).toEqual({
			value: "typescript7",
			variable: "TYPEPROBE_BACKEND",
		});
	});

	test("treat an empty value as unset", () => {
		process.env.TYPEPROBE_BACKEND = "";
		process.env.PRINFER_BACKEND = "typescript6";
		expect(readEnv("BACKEND")?.variable).toBe("PRINFER_BACKEND");
	});
});
