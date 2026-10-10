import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contractError } from "../contract.js";
import { NameNotFoundError } from "../core/name-lookup.js";
import { PrinferError } from "../errors.js";
import { nativeWorkerLocator } from "../native-sync.js";
import {
	closeTestingSessions,
	type InferredCompletionsSelector,
	inferredCompletions,
	inferredType,
	inferredTypeCost,
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
	test("defaults to TypeScript 7", () => {
		expect(inferredCompletions(targets, { line: 5, column: 29 })).toEqual([
			"coffee",
			"tea",
		]);
	});

	test("still accepts an explicit typescript7 backend", () => {
		expect(
			inferredCompletions(targets, {
				line: 5,
				column: 29,
				backend: "typescript7",
			}),
		).toEqual(["coffee", "tea"]);
	});

	test("rejects other backends with the fix", () => {
		const error = thrown(() =>
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
	test("inferredType reads the type where the text starts", () => {
		expect(inferredType(targets, { line: 4, text: "latte" })).toBe(
			'{ drink: Drink; size: "large"; }',
		);
		expect(
			inferredType(targets, {
				line: 4,
				text: "latte",
				backend: "typescript7",
			}),
		).toBe('{ drink: Drink; size: "large"; }');
	});

	test("inferredTypeInfo reports the resolved column", () => {
		const result = inferredTypeInfo(targets, {
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

	test("completions put the cursor after the text by default", () => {
		expect(
			inferredCompletions(targets, { line: 4, text: "latte." }),
		).toEqual(["drink", "size"]);
		expect(inferredCompletions(targets, { line: 5, text: '"' })).toEqual([
			"coffee",
			"tea",
		]);
	});

	test('completions accept cursor: "start"', () => {
		expect(
			inferredCompletions(targets, {
				line: 5,
				text: "tea",
				cursor: "start",
			}),
		).toEqual(["coffee", "tea"]);
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

	test("inferredType reads the given tsconfig on both backends", () => {
		const box = { name: "box" } as const;
		expect(inferredType(main, box)).toBe("{ value: null; }");
		expect(inferredType(main, { ...box, backend: "typescript7" })).toBe(
			"{ value: null; }",
		);
		expect(inferredType(main, { ...box, project })).toBe("{ value: any; }");
		expect(
			inferredType(main, {
				...box,
				project,
				backend: "typescript7",
			}),
		).toBe("{ value: any; }");
	});

	test("inferredCompletions uses the given tsconfig's lib", () => {
		const members = { line: 10, text: "numbers." };
		expect(inferredCompletions(main, members)).toContain("includes");
		const custom = inferredCompletions(main, { ...members, project });
		expect(custom).toContain("indexOf");
		expect(custom).not.toContain("includes");
	});
});

describe("setup errors", () => {
	test("an unknown name lists the closest declarations", () => {
		const sync = thrown(() => inferredType(targets, { name: "lattes" }));
		expect(sync.code).toBe("SYMBOL_NOT_FOUND");
		expect(sync.message).toContain(
			'Declarations in targets.ts closest to "lattes": latte,',
		);

		const native = thrown(() =>
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

	test("a cursor past the line end gives the last valid column", () => {
		const error = thrown(() =>
			inferredCompletions(targets, { line: 4, column: 99 }),
		);
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain("the last cursor column is 32");
	});

	test("TypeScript 7 helpers throw synchronously", () => {
		const error = thrown(() =>
			inferredType(targets, {
				line: 0,
				column: 1,
				backend: "typescript7",
			}),
		);
		expect(error.message).toContain("line as a positive 1-based integer");
	});
});

describe("misplaced options", () => {
	// Untyped test files can pass options as a third argument, which would
	// otherwise be ignored without a word.
	const options = { backend: "typescript7" };

	test("a third argument to inferredType throws with the fix", () => {
		const call = inferredType as (...args: unknown[]) => unknown;
		const error = thrown(() => call(targets, { name: "pick" }, options));
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain(
			"inferredType takes two arguments (file, selector), got 3.",
		);
		expect(error.message).toContain(
			'Move options into the selector object: inferredType(file, { name: "result", backend: "typescript7" }).',
		);
	});

	test("a third argument to inferredTypeInfo throws", () => {
		const call = inferredTypeInfo as (...args: unknown[]) => unknown;
		const error = thrown(() => call(targets, { name: "pick" }, options));
		expect(error.message).toContain("inferredTypeInfo takes two arguments");
	});

	test("a third argument to inferredCompletions throws", () => {
		const call = inferredCompletions as (...args: unknown[]) => unknown;
		const error = thrown(() =>
			call(targets, { line: 4, text: "latte." }, { project: "x" }),
		);
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain(
			"inferredCompletions takes two arguments",
		);
		expect(error.message).toContain('text: "user.", project:');
	});

	test("unknown selector keys are ignored by default", () => {
		expect(
			inferredType(targets, {
				name: "pick",
				includeDocs: true,
			} as { name: string }),
		).toBe("Drink");
		expect(
			inferredCompletions(targets, {
				line: 4,
				text: "latte.",
				full: true,
			} as InferredCompletionsSelector),
		).toEqual(["drink", "size"]);
	});

	test("strict: true throws on an unknown key with the closest one", () => {
		const error = thrown(() =>
			inferredType(targets, {
				name: "pick",
				includeDocs: true,
				strict: true,
			} as { name: string }),
		);
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain(
			'inferredType got unknown selector key "includeDocs".',
		);
		expect(error.message).toContain("Did you mean include_docs?");
	});

	test("strict: true accepts every documented key, strict included", () => {
		expect(
			inferredType(targets, {
				name: "pick",
				full: true,
				include_docs: false,
				strict: true,
			}),
		).toBe("Drink");
		expect(
			inferredCompletions(targets, {
				line: 4,
				text: "latte.",
				cursor: "end",
				strict: true,
			}),
		).toEqual(["drink", "size"]);
	});

	test("strict inferredCompletions lists only its own keys", () => {
		const error = thrown(() =>
			inferredCompletions(targets, {
				line: 4,
				text: "latte.",
				full: true,
				strict: true,
			} as InferredCompletionsSelector),
		);
		expect(error.message).toContain('unknown selector key "full"');
		expect(error.message).toContain(
			"Selector keys: line, column, text, occurrence, cursor, project, backend, timeout, strict.",
		);
	});

	test("strict: true accepts sort_unions and include_cost", () => {
		expect(
			inferredType(targets, {
				name: "pick",
				sort_unions: true,
				strict: true,
			}),
		).toBe("Drink");
		expect(
			inferredTypeInfo(targets, {
				name: "pick",
				include_cost: true,
				strict: true,
			}).cost,
		).toEqual(inferredTypeCost(targets, { name: "pick" }));
	});

	test("strict: true suggests sort_unions for sortUnions", () => {
		const error = thrown(() =>
			inferredType(targets, {
				name: "pick",
				sortUnions: true,
				strict: true,
			} as { name: string }),
		);
		expect(error.message).toContain(
			'inferredType got unknown selector key "sortUnions".',
		);
		expect(error.message).toContain("Did you mean sort_unions?");
	});

	test("inferredTypeCost takes strict and the same selector options", () => {
		const cost = inferredTypeCost(targets, { name: "pick" });
		expect(
			inferredTypeCost(targets, {
				name: "pick",
				full: false,
				include_docs: true,
				include_cost: true,
				sort_unions: true,
				strict: true,
			}),
		).toEqual(cost);
		const error = thrown(() =>
			inferredTypeCost(targets, {
				name: "pick",
				sortUnions: true,
				strict: true,
			} as { name: string }),
		);
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain(
			'inferredTypeCost got unknown selector key "sortUnions".',
		);
		expect(error.message).toContain("Did you mean sort_unions?");
	});

	test("a third argument to inferredTypeCost throws", () => {
		const call = inferredTypeCost as (...args: unknown[]) => unknown;
		const error = thrown(() => call(targets, { name: "pick" }, {}));
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain(
			"inferredTypeCost takes two arguments (file, selector), got 3.",
		);
		expect(error.message).toContain(
			'inferredTypeCost(file, { name: "result", project: "./tsconfig.json" })',
		);
	});

	test("a third argument throws even without strict", () => {
		const call = inferredType as (...args: unknown[]) => unknown;
		const error = thrown(() =>
			call(targets, { name: "pick", strict: false }, { strict: true }),
		);
		expect(error.message).toContain("inferredType takes two arguments");
	});
});

describe("TypeScript 7 results are plain values", () => {
	const pick = { name: "pick", backend: "typescript7" } as const;

	test("every helper returns its value synchronously", () => {
		const type = inferredType(targets, pick);
		expect(type).toBe("Drink");
		// A snapshot of the call records the type, not "Promise {}".
		expect(JSON.stringify(type)).toBe('"Drink"');
		expect(inferredTypeInfo(targets, pick).signature).toBe("Drink");
		expect(
			inferredCompletions(targets, { line: 4, text: "latte." }),
		).toEqual(["drink", "size"]);
	});

	test("an await left over from the promise API still works", async () => {
		expect(await inferredType(targets, pick)).toBe("Drink");
		expect(
			await inferredCompletions(targets, { line: 5, column: 29 }),
		).toEqual(["coffee", "tea"]);
	});

	test("errors cross from the worker as TypeScript 6 throws them", () => {
		const selector = { name: "latte", line: 5 };
		const [ts6, ts7] = [
			thrown(() => inferredType(targets, selector)),
			thrown(() => inferredType(targets, { ...pick, ...selector })),
		];
		for (const error of [ts6, ts7]) {
			expect(error.code).toBe("SYMBOL_NOT_FOUND");
			expect(error.suggestion).toBe(
				'"latte" is declared on line 3; pass one of those as the line, or omit the line.',
			);
			// The lookup's own error, with its declarations, is the cause.
			const cause = error.cause as NameNotFoundError;
			expect(cause).toBeInstanceOf(NameNotFoundError);
			expect(cause.name).toBe("NameNotFoundError");
			expect(contractError(cause).error.declaredAt).toEqual([
				{ line: 3, column: 14, kind: "const" },
			]);
		}
		expect(ts7.message).toBe(ts6.message);
		// The worker's stack, so a failure points at the code that threw.
		expect((ts7.cause as Error).stack).toContain("name-lookup");
	});

	test("a compiler that misses the timeout fails one call, not the next", () => {
		// A fresh worker takes far longer than 1ms to load its compiler.
		void closeTestingSessions();
		const error = thrown(() =>
			inferredType(targets, { ...pick, timeout: 1 }),
		);
		expect(error.code).toBe("TYPESCRIPT_ERROR");
		expect(error.message).toContain(
			"TypeScript 7 did not answer within 1ms; prinfer stopped its compiler, and the next call starts a new one.",
		);
		expect(error.message).toContain("raise the limit with timeout (in ms)");
		expect(inferredType(targets, pick)).toBe("Drink");
	});

	test("a hung compiler is killed at the timeout and replaced", async () => {
		const children = () => {
			const found = Bun.spawnSync(["pgrep", "-P", String(process.pid)]);
			return found.stdout
				.toString()
				.split("\n")
				.filter(Boolean)
				.map(Number);
		};
		await closeTestingSessions();
		const before = new Set(children());
		expect(inferredType(targets, pick)).toBe("Drink");
		const compilers = children().filter((pid) => !before.has(pid));
		expect(compilers).toHaveLength(1);
		const [compiler] = compilers as [number];
		// A stopped process never answers, and never acts on SIGTERM.
		process.kill(compiler, "SIGSTOP");
		try {
			const started = Date.now();
			const error = thrown(() =>
				inferredType(targets, {
					...pick,
					name: "latte",
					timeout: 1_500,
				}),
			);
			expect(error.message).toContain("did not answer within 1500ms");
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(inferredType(targets, pick)).toBe("Drink");
			// The stopped compiler was killed, not left behind.
			await Bun.sleep(100);
			expect(children()).not.toContain(compiler);
		} finally {
			try {
				process.kill(compiler, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	});

	test("a worker that can't load @typescript/native fails at once, not at the timeout", async () => {
		// The worker module imports @typescript/native; a broken install
		// makes that import throw and the thread die at startup.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-worker-"));
		const entry = path.join(dir, "native-worker.ts");
		fs.writeFileSync(
			entry,
			'import "@typescript/native/prinfer-simulated-missing";\nexport {};\n',
		);
		await closeTestingSessions();
		const { locate } = nativeWorkerLocator;
		nativeWorkerLocator.locate = () => ({ ...locate(), entry });
		try {
			// Every call starts a new worker, and each one fails fast.
			for (let attempt = 0; attempt < 2; attempt++) {
				const started = Date.now();
				const error = thrown(() =>
					inferredType(targets, { ...pick, timeout: 30_000 }),
				);
				expect(Date.now() - started).toBeLessThan(5_000);
				expect(error.code).toBe("TYPESCRIPT_ERROR");
				expect(error.message).toContain(
					"prinfer could not start its TypeScript 7 worker: loading the TypeScript 7 compiler API failed (",
				);
				// The loader's own reason, in the message and as the cause.
				expect(error.message).toContain("@typescript/native");
				expect(error.suggestion).toContain(
					"Check that @typescript/native is installed",
				);
				expect((error.cause as Error).message).toContain(
					"@typescript/native",
				);
			}
		} finally {
			nativeWorkerLocator.locate = locate;
			fs.rmSync(dir, { recursive: true, force: true });
		}
		expect(inferredType(targets, pick)).toBe("Drink");
	});

	test("timeout must be a positive number of milliseconds", () => {
		for (const timeout of [0, -1, Number.NaN, "5000"]) {
			const error = thrown(() =>
				inferredType(targets, {
					...pick,
					timeout: timeout as number,
				}),
			);
			expect(error.code).toBe("INVALID_ARGUMENT");
			expect(error.message).toContain(
				"inferredType needs timeout as a positive number of milliseconds",
			);
		}
		expect(
			inferredCompletions(targets, {
				line: 4,
				text: "latte.",
				timeout: 30_000,
				strict: true,
			}),
		).toEqual(["drink", "size"]);
		expect(
			inferredType(targets, { ...pick, timeout: 30_000, strict: true }),
		).toBe("Drink");
	});
});

describe("teardown", () => {
	const calls = [
		'console.log(inferredType(file, { name: "pick", backend: "typescript7" }));',
		'console.log(inferredCompletions(file, { line: 4, text: "latte." }).join(","));',
	];
	const script = (
		entry: string,
		setup: string[] = [],
		body = calls,
		load = `import { closeTestingSessions, inferredCompletions, inferredType } from ${JSON.stringify(entry)};`,
	) =>
		[
			load,
			`const file = ${JSON.stringify(targetsPath)};`,
			...setup,
			...body,
		].join("\n");

	/** Run a script that must exit on its own, promptly; return its stderr. */
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
				`The process did not exit within 20s of its last TypeScript 7 call: the worker thread or an idle compiler session kept it alive. Check NativeWorker in src/native-sync.ts and NativeApiSession in src/native-api.ts.\nstderr:\n${stderr}`,
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

	/** The built package, rebuilt when a source it bundles is newer. */
	function builtEntry(name: string): string {
		const dist = path.join(packageRoot, "dist", name);
		const sources = [
			"testing",
			"native-api",
			"native-sync",
			"native-worker",
			"native-worker-boot",
		].map((source) => path.join(packageRoot, "src", `${source}.ts`));
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
		return dist;
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

	test("without the compiler process handle, async sessions still let Bun exit and warn once", async () => {
		// The CLI-independent async sessions in native-api.ts, which the
		// testing worker runs: patching the locator here can't reach the
		// worker thread, so this calls them directly.
		const nativeApi = JSON.stringify(
			path.join(packageRoot, "src", "native-api.ts"),
		);
		const load = `import { compilerProcessLocator, nativeApiCompletionNames, nativeApiTypeInfoByName } from ${nativeApi};`;
		const setup = [
			'compilerProcessLocator.locate = () => ({ status: "missing", reason: "simulated by the test" });',
		];
		const project = path.join(path.dirname(targetsPath), "tsconfig.json");
		const pick = (options = "") =>
			`console.log((await nativeApiTypeInfoByName(file, "pick"${options})).signature);`;
		// Two sessions (default project and explicit project), then a call
		// after the fallback has closed the idle session, which restarts it.
		const body = [
			pick(),
			'console.log((await nativeApiCompletionNames(file, 4, 27)).join(","));',
			pick(`, { project: ${JSON.stringify(project)} }`),
			"await new Promise((resolve) => setTimeout(resolve, 1500));",
			pick(),
		];
		const file = writeScript("script.ts", script("", setup, body, load));
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
		const stderr = await exitsWithoutTeardown([
			"node",
			writeScript("script.mjs", script(builtEntry("testing.js"))),
		]);
		expect(stderr).not.toContain("prinfer:");
	}, 60_000);

	test("the CommonJS build finds its worker and exits too", async () => {
		const load = `const { inferredCompletions, inferredType } = require(${JSON.stringify(builtEntry("testing.cjs"))});`;
		const stderr = await exitsWithoutTeardown([
			"node",
			writeScript("script.cjs", script("", [], calls, load)),
		]);
		expect(stderr).not.toContain("prinfer:");
	}, 60_000);

	test("the built worker fails fast on Node when @typescript/native can't load", async () => {
		// A copy of the build whose worker module can't import the
		// compiler API, under the package so typescript still resolves.
		const built = path.dirname(builtEntry("testing.js"));
		const dir = fs.mkdtempSync(
			path.join(packageRoot, "node_modules", ".prinfer-broken-worker-"),
		);
		try {
			for (const name of ["testing.js", "native-worker-boot.js"]) {
				fs.copyFileSync(path.join(built, name), path.join(dir, name));
			}
			fs.writeFileSync(
				path.join(dir, "native-worker.js"),
				'import "@typescript/native/prinfer-simulated-missing";\n',
			);
			const body = [
				"const started = Date.now();",
				'try { inferredType(file, { name: "pick", backend: "typescript7" }); } catch (error) { console.log(error.code, Date.now() - started < 5000, error.message.includes("could not start its TypeScript 7 worker")); }',
				"await closeTestingSessions();",
			];
			await exitsWithoutTeardown(
				[
					"node",
					writeScript(
						"broken.mjs",
						script(path.join(dir, "testing.js"), [], body),
					),
				],
				"TYPESCRIPT_ERROR true true\n",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("a top-level await closeTestingSessions() settles on Node and Bun", async () => {
		// On Node, nothing may hold the event loop while closing waits for the
		// worker and its compilers: if the loop drains, Node exits with code 13
		// (unsettled top-level await) instead of settling the promise.
		const body = [
			...calls,
			"await closeTestingSessions();",
			'console.log("closed");',
			// A call after teardown starts a new worker; close it again.
			calls[0] as string,
			"await closeTestingSessions();",
			'console.log("closed");',
		];
		const expected = "Drink\ndrink,size\nclosed\nDrink\nclosed\n";
		const nodeStderr = await exitsWithoutTeardown(
			[
				"node",
				writeScript(
					"script.mjs",
					script(builtEntry("testing.js"), [], body),
				),
			],
			expected,
		);
		expect(nodeStderr).not.toContain("unsettled top-level await");
		await exitsWithoutTeardown(
			[
				process.execPath,
				writeScript(
					"script.ts",
					script(
						path.join(packageRoot, "src", "testing.ts"),
						[],
						body,
					),
				),
			],
			expected,
		);
	}, 60_000);

	test("killing the compiler, idle or mid-call, does not break later calls", async () => {
		// The compiler can exit under a run: bun test kills the child
		// processes it can see when a test times out, and a crash or an OOM
		// kill ends it too. A call in flight when it exits retries once with
		// a fresh compiler; later calls restart it.
		const project = path.join(path.dirname(targetsPath), "tsconfig.json");
		const killer = writeScript(
			"kill-compilers.ts",
			[
				'import { execFileSync } from "node:child_process";',
				"// Usage: kill-compilers.ts <parent pid> <wait for a new one: 0|1>",
				"const [parent, waitForNew] = process.argv.slice(2);",
				"const children = () => {",
				'	try { return execFileSync("pgrep", ["-P", String(parent)], { encoding: "utf8" }).split("\\n").map(Number).filter((pid) => pid && pid !== process.pid); }',
				"	catch { return []; }",
				"};",
				"const known = new Set(waitForNew === '1' ? children() : []);",
				'console.log("ready");',
				"const deadline = Date.now() + 10_000;",
				"for (;;) {",
				"	const found = children().filter((pid) => !known.has(pid));",
				"	// A pid can be gone by the time it is killed.",
				"	if (found.length > 0) { for (const pid of found) { try { process.kill(pid, 'SIGTERM'); } catch {} } break; }",
				"	if (Date.now() > deadline) process.exit(1);",
				"	await new Promise((resolve) => setTimeout(resolve, 2));",
				"}",
			].join("\n"),
		);
		const call = (extra = "") =>
			`expect(inferredType(file, { name: "pick", backend: "typescript7"${extra} })).toBe("Drink");`;
		const withProject = `, project: ${JSON.stringify(project)}`;
		const kill = (waitForNew: 0 | 1) =>
			`Bun.spawn([process.execPath, ${JSON.stringify(killer)}, String(process.pid), "${waitForNew}"], { stdout: "pipe", stderr: "inherit" })`;
		const source = [
			'import { afterAll, expect, test } from "bun:test";',
			`import { closeTestingSessions, inferredType } from ${JSON.stringify(path.join(packageRoot, "src", "testing.ts"))};`,
			`const file = ${JSON.stringify(targetsPath)};`,
			"afterAll(() => closeTestingSessions());",
			`test("warm", () => { ${call()} });`,
			'test("runner timeout", async () => { await new Promise((resolve) => setTimeout(resolve, 1000)); }, 50);',
			`test("after a runner timeout", () => { ${call()} }, 10_000);`,
			`test("idle kill", async () => { expect(await ${kill(0)}.exited).toBe(0); });`,
			`test("after an idle kill", () => { ${call()} }, 10_000);`,
			// The killer waits for the compiler this call spawns, so the
			// kill lands while the call is loading the project.
			`test("mid-call kill", async () => { const killing = ${kill(1)}; await killing.stdout.getReader().read(); ${call(withProject)} expect(await killing.exited).toBe(0); }, 10_000);`,
			`test("after a mid-call kill", () => { ${call(withProject)} }, 10_000);`,
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
		expect(output).toContain("(fail) runner timeout");
		expect(output).toContain(" 6 pass");
		expect(output).toContain(" 1 fail");
		expect(exitCode).toBe(1);
	}, 40_000);
});
