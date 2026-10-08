import { describe, expect, test } from "bun:test";
import path from "node:path";
import { parseFlags, parseTargetArg, shellHint } from "../cli-args.js";

const fixturesDir = path.join(import.meta.dir, "fixtures");

describe("parseTargetArg", () => {
	test.each([
		[
			"a.ts:12:34",
			{ kind: "position", file: "a.ts", line: 12, column: 34 },
		],
		["a.ts:foo:12", { kind: "name", file: "a.ts", name: "foo", line: 12 }],
		["a.ts:foo", { kind: "name", file: "a.ts", name: "foo" }],
		["a.ts:$store", { kind: "name", file: "a.ts", name: "$store" }],
		["a.ts:12:foo", { kind: "text", file: "a.ts", line: 12, text: "foo" }],
		[
			"a.ts:12:user.name",
			{ kind: "text", file: "a.ts", line: 12, text: "user.name" },
		],
		// Text keeps everything after the first :<line>:, colons included.
		[
			"a.ts:12:a: string",
			{ kind: "text", file: "a.ts", line: 12, text: "a: string" },
		],
		[
			"a.ts:12:34:56",
			{ kind: "text", file: "a.ts", line: 12, text: "34:56" },
		],
		[
			"a.ts:12:foo:3",
			{ kind: "text", file: "a.ts", line: 12, text: "foo:3" },
		],
		["a.ts:12", { kind: "line", file: "a.ts", line: 12 }],
		[
			"C:\\repo\\a.ts:12:foo",
			{ kind: "text", file: "C:\\repo\\a.ts", line: 12, text: "foo" },
		],
		[
			"/repo/my:dir/a.ts:foo",
			{ kind: "name", file: "/repo/my:dir/a.ts", name: "foo" },
		],
	] as const)("%s", (arg, expected) => {
		expect(parseTargetArg(arg, fixturesDir)).toEqual(expected as never);
	});

	test("rejects shapes that leave a source file name in the path", () => {
		// a.ts:foo:bar would otherwise read as the name "bar" in "a.ts:foo".
		for (const arg of ["a.ts:foo:bar", "a.tsx:x:y", "a.mjs:x:y"]) {
			expect(parseTargetArg(arg, fixturesDir)).toBeNull();
		}
	});

	test("rejects arguments without a target", () => {
		for (const arg of ["a.ts", "a.ts:", "a.ts:12:", "a.ts::12", ":12"]) {
			expect(parseTargetArg(arg, fixturesDir)).toBeNull();
		}
	});
});

describe("shellHint", () => {
	test("suggests single quotes when a $ was likely expanded or kept", () => {
		for (const arg of ["src/store.ts:", "src/store.ts::3", "a.ts:$x:y"]) {
			expect(shellHint(arg)).toContain("single-quote");
		}
	});

	test("explains zsh modifiers when the path lost its extension", () => {
		// "$F:root" in zsh is "${F:r}oot": the extension is gone.
		expect(shellHint("/repo/src/contextoot")).toContain("zsh");
		expect(shellHint("/repo/src/context:12:3")).toContain("zsh");
	});

	test("stays quiet for ordinary source paths", () => {
		expect(shellHint("src/a.ts")).toBeUndefined();
		expect(shellHint("src/a.ts:foo:bar")).toBeUndefined();
	});
});

describe("parseFlags", () => {
	const fail = (message: string): never => {
		throw new Error(message);
	};
	const parse = (args: string[]) =>
		parseFlags(args, new Set(["json", "project"]), "annotations", fail);

	test("accepts --opt value and --opt=value", () => {
		for (const args of [
			["a.ts", "--project", "tsconfig.json"],
			["a.ts", "--project=tsconfig.json"],
			["-p", "tsconfig.json", "a.ts"],
		]) {
			const { positionals, values } = parse(args);
			expect(positionals).toEqual(["a.ts"]);
			expect(values.get("project")).toBe("tsconfig.json");
		}
	});

	test("rejects unknown options and options of other commands", () => {
		expect(() => parse(["a.ts", "--bogus"])).toThrow(
			"Unknown option --bogus.",
		);
		expect(() => parse(["a.ts", "--docs"])).toThrow(
			"--docs is not an option of annotations.",
		);
		expect(() => parse(["a.ts", "--json=1"])).toThrow(
			"--json takes no value.",
		);
		expect(() => parse(["a.ts", "--project"])).toThrow(
			"--project requires a path argument.",
		);
	});
});
