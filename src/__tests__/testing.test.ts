import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrinferError } from "../errors.js";
import {
	inferredCompletions,
	inferredType,
	inferredTypeInfo,
} from "../testing.js";

// The first lookup per backend loads a compiler program.
setDefaultTimeout(30_000);

const packageRoot = path.resolve(import.meta.dir, "..", "..");
const targets = new URL("./fixtures/testing/targets.ts", import.meta.url);
const targetsPath = path.join(
	import.meta.dir,
	"fixtures",
	"testing",
	"targets.ts",
);

async function rejection(promise: Promise<unknown>): Promise<PrinferError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(PrinferError);
		return error as PrinferError;
	}
	throw new Error("Expected the promise to reject");
}

function thrown(run: () => unknown): PrinferError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(PrinferError);
		return error as PrinferError;
	}
	throw new Error("Expected the call to throw");
}

describe("inferredCompletions backend", () => {
	test("defaults to TypeScript 7", async () => {
		await expect(
			inferredCompletions(targets, { line: 5, column: 29 }),
		).resolves.toEqual(["coffee", "tea"]);
	});

	test("still accepts an explicit typescript7 backend", async () => {
		await expect(
			inferredCompletions(targets, {
				line: 5,
				column: 29,
				backend: "typescript7",
			}),
		).resolves.toEqual(["coffee", "tea"]);
	});

	test("rejects other backends with the fix", async () => {
		const error = await rejection(
			inferredCompletions(targets, {
				line: 5,
				column: 29,
				backend: "typescript6" as "typescript7",
			}),
		);
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain("Omit backend");
	});
});

describe("text targets", () => {
	test("inferredType reads the type where the text starts", async () => {
		expect(inferredType(targets, { line: 4, text: "latte" })).toBe(
			'{ drink: Drink; size: "large"; }',
		);
		await expect(
			inferredType(targets, {
				line: 4,
				text: "latte",
				backend: "typescript7",
			}),
		).resolves.toBe('{ drink: Drink; size: "large"; }');
	});

	test("inferredTypeInfo reports the resolved column", async () => {
		const result = await inferredTypeInfo(targets, {
			line: 3,
			text: "order",
			backend: "typescript7",
		});
		// A call reports its call signature on every backend.
		expect(result).toMatchObject({
			kind: "call",
			signature: '(drink: Drink): { drink: Drink; size: "large"; }',
		});
		expect(
			inferredTypeInfo(targets, { line: 3, text: "order" }).signature,
		).toBe(result.signature);
		expect(result.column).toBe(22);
	});

	test("occurrence picks a later match", () => {
		expect(
			inferredType(targets, { line: 2, text: "drink", occurrence: 2 }),
		).toBe("Drink");
	});

	test("completions put the cursor after the text by default", async () => {
		await expect(
			inferredCompletions(targets, { line: 4, text: "latte." }),
		).resolves.toEqual(["drink", "size"]);
		await expect(
			inferredCompletions(targets, { line: 5, text: '"' }),
		).resolves.toEqual(["coffee", "tea"]);
	});

	test('completions accept cursor: "start"', async () => {
		await expect(
			inferredCompletions(targets, {
				line: 5,
				text: "tea",
				cursor: "start",
			}),
		).resolves.toEqual(["coffee", "tea"]);
	});

	test("text missing from the line quotes the line", () => {
		const error = thrown(() =>
			inferredType(targets, { line: 4, text: "espresso" }),
		);
		expect(error.code).toBe("SYMBOL_NOT_FOUND");
		expect(error.message).toContain(
			'Line 4 reads: "export const size = latte.size;"',
		);
	});
});

describe("other modules", () => {
	test("accepts a URL relative to the test file", () => {
		expect(inferredType(targets, { name: "pick" })).toBe("Drink");
	});

	test("resolves relative path strings against process.cwd()", () => {
		const relative = path.relative(process.cwd(), targetsPath);
		expect(inferredType(relative, { name: "pick" })).toBe("Drink");
	});

	test("a missing relative path suggests import.meta.url", () => {
		const error = thrown(() =>
			inferredType("fixtures/testing/targets.ts", { name: "pick" }),
		);
		expect(error.code).toBe("FILE_NOT_FOUND");
		expect(error.message).toContain(
			`Relative paths resolve against process.cwd() (${process.cwd()})`,
		);
		expect(error.message).toContain(
			'new URL("./fixtures/testing/targets.ts", import.meta.url)',
		);
	});
});

describe("explicit project", () => {
	// tsconfig.json is strict with the ES2022 lib; tsconfig.custom.json is
	// neither, and nothing references it.
	const main = new URL("./fixtures/custom-project/main.ts", import.meta.url);
	const project = path.join(
		import.meta.dir,
		"fixtures",
		"custom-project",
		"tsconfig.custom.json",
	);

	test("inferredType reads the given tsconfig on both backends", async () => {
		const box = { name: "box" } as const;
		expect(inferredType(main, box)).toBe("{ value: null; }");
		expect(
			await inferredType(main, { ...box, backend: "typescript7" }),
		).toBe("{ value: null; }");
		expect(inferredType(main, { ...box, project })).toBe("{ value: any; }");
		expect(
			await inferredType(main, {
				...box,
				project,
				backend: "typescript7",
			}),
		).toBe("{ value: any; }");
	});

	test("inferredCompletions uses the given tsconfig's lib", async () => {
		const members = { line: 10, text: "numbers." };
		expect(await inferredCompletions(main, members)).toContain("includes");
		const custom = await inferredCompletions(main, { ...members, project });
		expect(custom).toContain("indexOf");
		expect(custom).not.toContain("includes");
	});
});

describe("setup errors", () => {
	test("an unknown name lists the closest declarations", async () => {
		const sync = thrown(() => inferredType(targets, { name: "lattes" }));
		expect(sync.code).toBe("SYMBOL_NOT_FOUND");
		expect(sync.message).toContain(
			'Declarations in targets.ts closest to "lattes": latte,',
		);

		const native = await rejection(
			inferredType(targets, { name: "lattes", backend: "typescript7" }),
		);
		expect(native.code).toBe("SYMBOL_NOT_FOUND");
		expect(native.message).toContain('closest to "lattes": latte,');
	});

	test("a wrong line hint points at the declaration line", () => {
		const error = thrown(() =>
			inferredType(targets, { name: "latte", line: 5 }),
		);
		expect(error.message).toContain(
			'"latte" is declared on line 3; pass one of those as the line, or omit the line.',
		);
	});

	test("an unknown backend names the valid ones", () => {
		const error = thrown(() =>
			inferredType(targets, {
				name: "latte",
				backend: "ts7" as "typescript7",
			}),
		);
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain('Use backend: "typescript7"');
	});

	test("a selector with column and text lists the valid shapes", () => {
		const error = thrown(() =>
			inferredType(targets, {
				line: 4,
				text: "latte",
				column: 21,
			} as unknown as { name: string }),
		);
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain("{ line, text, occurrence? }");
	});

	test("a cursor past the line end gives the last valid column", async () => {
		const error = await rejection(
			inferredCompletions(targets, { line: 4, column: 99 }),
		);
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain("the last cursor column is 32");
	});

	test("TypeScript 7 helpers reject instead of throwing", async () => {
		const pending = inferredType(targets, {
			line: 0,
			column: 1,
			backend: "typescript7",
		});
		expect(pending).toBeInstanceOf(Promise);
		const error = await rejection(pending);
		expect(error.message).toContain("line as a positive 1-based integer");
	});
});

describe("teardown", () => {
	const calls = [
		'console.log(await inferredType(file, { name: "pick", backend: "typescript7" }));',
		'console.log((await inferredCompletions(file, { line: 4, text: "latte." })).join(","));',
	];
	const script = (entry: string, setup: string[] = [], body = calls) =>
		[
			`import { inferredCompletions, inferredType } from ${JSON.stringify(entry)};`,
			`const file = ${JSON.stringify(targetsPath)};`,
			...setup,
			...body,
		].join("\n");

	/** Run a script that never calls closeTestingSessions; return its stderr. */
	async function exitsWithoutTeardown(
		command: string[],
		stdout = "Drink\ndrink,size\n",
	): Promise<string> {
		const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, 20_000);
		const exitCode = await proc.exited;
		clearTimeout(timer);
		const stderr = await new Response(proc.stderr).text();
		if (timedOut) {
			throw new Error(
				`The process did not exit within 20s of its last TypeScript 7 call: an idle compiler session kept it alive. Check NativeApiSession in src/native-api.ts.\nstderr:\n${stderr}`,
			);
		}
		expect(await new Response(proc.stdout).text()).toBe(stdout);
		expect(exitCode).toBe(0);
		return stderr;
	}

	function writeScript(name: string, source: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-teardown-"));
		const file = path.join(dir, name);
		fs.writeFileSync(file, source);
		return file;
	}

	test("a Bun process exits after TypeScript 7 calls without closeTestingSessions", async () => {
		const file = writeScript(
			"script.ts",
			script(path.join(packageRoot, "src", "testing.ts")),
		);
		const stderr = await exitsWithoutTeardown([process.execPath, file]);
		// The compiler process was found and unref'd, not closed by the fallback.
		expect(stderr).not.toContain("prinfer:");
	}, 30_000);

	test("without the compiler process handle, a Bun process still exits and warns once", async () => {
		const setup = [
			`import { compilerProcessLocator } from ${JSON.stringify(path.join(packageRoot, "src", "native-api.ts"))};`,
			'compilerProcessLocator.locate = () => ({ status: "missing", reason: "simulated by the test" });',
		];
		const project = path.join(path.dirname(targetsPath), "tsconfig.json");
		// Two sessions (default project and explicit project), then a call
		// after the fallback has closed the idle session, which restarts it.
		const body = [
			...calls,
			`console.log(await inferredType(file, { name: "pick", backend: "typescript7", project: ${JSON.stringify(project)} }));`,
			"await new Promise((resolve) => setTimeout(resolve, 1500));",
			'console.log(await inferredType(file, { name: "pick", backend: "typescript7" }));',
		];
		const file = writeScript(
			"script.ts",
			script(path.join(packageRoot, "src", "testing.ts"), setup, body),
		);
		const stderr = await exitsWithoutTeardown(
			[process.execPath, file],
			"Drink\ndrink,size\nDrink\nDrink\n",
		);
		expect(stderr).toContain(
			"prinfer: cannot find the TypeScript 7 compiler process",
		);
		expect(stderr).toContain("simulated by the test");
		expect(stderr).toContain("closeTestingSessions()");
		expect(stderr.split("prinfer: cannot find").length - 1).toBe(1);
	}, 30_000);

	test("a Node process exits after TypeScript 7 calls without closeTestingSessions", async () => {
		const dist = path.join(packageRoot, "dist", "testing.js");
		const sources = [
			path.join(packageRoot, "src", "testing.ts"),
			path.join(packageRoot, "src", "native-api.ts"),
		];
		const stale =
			!fs.existsSync(dist) ||
			sources.some(
				(source) =>
					fs.statSync(source).mtimeMs > fs.statSync(dist).mtimeMs,
			);
		if (stale) {
			const build = Bun.spawnSync(["bun", "run", "build"], {
				cwd: packageRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(build.exitCode).toBe(0);
		}
		const stderr = await exitsWithoutTeardown([
			"node",
			writeScript("script.mjs", script(dist)),
		]);
		expect(stderr).not.toContain("prinfer:");
	}, 60_000);

	test("bun test killing the compiler on a test timeout does not break later calls", async () => {
		// bun test kills every live child process when a test times out,
		// including the shared compiler: SIGTERM, which it answers for a
		// moment before exiting. Later calls must restart it, not hang or
		// fail against the dead session, and teardown must still succeed.
		const project = path.join(path.dirname(targetsPath), "tsconfig.json");
		const call = (extra = "") =>
			`expect(await inferredType(file, { name: "pick", backend: "typescript7"${extra} })).toBe("Drink");`;
		const withProject = `, project: ${JSON.stringify(project)}`;
		const source = [
			'import { afterAll, expect, test } from "bun:test";',
			`import { closeTestingSessions, inferredType } from ${JSON.stringify(path.join(packageRoot, "src", "testing.ts"))};`,
			`const file = ${JSON.stringify(targetsPath)};`,
			"afterAll(() => closeTestingSessions());",
			`test("warm", async () => { ${call()} });`,
			'test("idle timeout", async () => { await new Promise((resolve) => setTimeout(resolve, 1000)); }, 50);',
			`test("after an idle kill", async () => { ${call()} }, 10_000);`,
			`test("in-flight timeout", async () => { ${call(withProject)} }, 1);`,
			`test("after an in-flight kill", async () => { ${call(withProject)} }, 10_000);`,
		].join("\n");
		const proc = Bun.spawn(
			[process.execPath, "test", writeScript("kill.test.ts", source)],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const timer = setTimeout(() => proc.kill(), 30_000);
		const exitCode = await proc.exited;
		clearTimeout(timer);
		const output =
			(await new Response(proc.stdout).text()) +
			(await new Response(proc.stderr).text());
		expect(output).toContain("killed 1 dangling process");
		expect(output).toContain("(fail) idle timeout");
		expect(output).toContain("(fail) in-flight timeout");
		expect(output).toContain(" 3 pass");
		expect(output).toContain(" 2 fail");
		expect(exitCode).toBe(1);
	}, 40_000);
});
