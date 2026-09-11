import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	contractErrorResponseSchema,
	hoverSuccessSchema,
} from "../contract.js";

const cliPath = path.join(import.meta.dir, "..", "cli.ts");
const fixturesDir = path.join(import.meta.dir, "fixtures");
const sampleFile = path.join(fixturesDir, "sample.ts");
const jsdocFile = path.join(fixturesDir, "with-jsdoc.ts");
const typeAliasFile = path.join(fixturesDir, "type-alias.ts");
const completionsFile = path.join(fixturesDir, "completions.ts");

async function runCli(
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("CLI", () => {
	test("prints autocomplete entries at a cursor", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			"complete",
			`${completionsFile}:3:33`,
		]);
		expect(stdout).toBe("coffee\ntea\n");
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	});

	test("inspects a type with Bun 1.3.14's hoisted TypeScript 7 layout", async () => {
		const packageRoot = path.join(import.meta.dir, "..", "..");
		const consumerDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "prinfer-typescript-7-"),
		);

		try {
			const build = Bun.spawnSync(["bun", "run", "build"], {
				cwd: packageRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(build.exitCode).toBe(0);

			const pack = Bun.spawnSync(
				[
					"bun",
					"pm",
					"pack",
					"--ignore-scripts",
					"--filename",
					path.join(consumerDir, "prinfer.tgz"),
				],
				{
					cwd: packageRoot,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(pack.exitCode).toBe(0);

			await Bun.write(
				path.join(consumerDir, "package.json"),
				JSON.stringify({
					private: true,
					dependencies: {
						prinfer: "./prinfer.tgz",
						typescript: "^7.0.2",
					},
				}),
			);
			const targetFile = path.join(
				consumerDir,
				"note-public-interface.ts",
			);
			await Bun.write(
				targetFile,
				'type ReadingRenderContext<L, E, P> = { language: L; entity: E; partOfSpeech: P };\ntype test = ReadingRenderContext<"de", "Lexeme", "VERB">;\n',
			);

			const install = Bun.spawnSync(
				["bun", "install", "--ignore-scripts"],
				{
					cwd: consumerDir,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(install.exitCode).toBe(0);

			// Bun 1.3.14 produced this hoisted layout with the former wrapper dependency:
			// @typescript/old contained the @typescript/typescript6 wrapper itself.
			const typescriptScope = path.join(
				consumerDir,
				"node_modules",
				"@typescript",
			);
			const compatibilityWrapper = path.join(
				typescriptScope,
				"typescript6",
			);
			if (fs.existsSync(compatibilityWrapper)) {
				fs.rmSync(path.join(typescriptScope, "old"), {
					recursive: true,
					force: true,
				});
				fs.cpSync(
					compatibilityWrapper,
					path.join(typescriptScope, "old"),
					{
						recursive: true,
					},
				);
			}

			const result = Bun.spawnSync(
				["bunx", "prinfer", `${targetFile}:test`],
				{
					cwd: consumerDir,
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			expect(result.stderr.toString()).toBe("");
			expect(result.stdout.toString()).toContain(
				'type test = { language: "de"; entity: "Lexeme"; partOfSpeech: "VERB"; }',
			);
			expect(result.exitCode).toBe(0);
		} finally {
			fs.rmSync(consumerDir, { recursive: true, force: true });
		}
	}, 15_000);

	test("shows help with --help flag", async () => {
		const { stdout, exitCode } = await runCli(["--help"]);
		expect(stdout).toContain("prinfer");
		expect(stdout).toContain("Usage:");
		expect(exitCode).toBe(0);
	});

	test("shows help with -h flag", async () => {
		const { stdout, exitCode } = await runCli(["-h"]);
		expect(stdout).toContain("prinfer");
		expect(exitCode).toBe(0);
	});

	test("shows help when no arguments provided", async () => {
		const { stdout, exitCode } = await runCli([]);
		expect(stdout).toContain("Usage:");
		expect(exitCode).toBe(0);
	});

	test("prints Codex setup without changing configuration", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			"setup",
			"codex",
			"--print",
		]);
		expect(stdout).toContain("codex mcp add prinfer -- node");
		expect(stdout).toContain("mcp.js");
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	});

	test("rejects unsupported setup clients", async () => {
		const { stderr, exitCode } = await runCli(["setup", "claude"]);
		expect(stderr).toContain("supported client: codex");
		expect(exitCode).toBe(1);
	});

	test("gets type at file:line:column", async () => {
		// "add" function at line 4, column 17
		const { stdout, exitCode } = await runCli([`${sampleFile}:4:17`]);
		expect(stdout).toContain("number");
		expect(stdout).toContain("kind:");
		expect(exitCode).toBe(0);
	});

	test("gets an unexported type alias by name", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			`${typeAliasFile}:test`,
		]);

		expect(stdout).toContain('type test = { readonly language: "de";');
		expect(stdout).toContain("more ...");
		expect(stdout).not.toContain("field10");
		expect(stdout).toContain("name: test");
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	});

	test("prints an untruncated type alias with --full", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			`${typeAliasFile}:test`,
			"--full",
		]);

		expect(stdout).not.toContain("more ...");
		expect(stdout).toContain('readonly finalField: "de";');
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	});

	test("emits contract v1 JSON for a successful lookup", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			`${sampleFile}:4:17`,
			"--json",
		]);
		const response = hoverSuccessSchema.parse(JSON.parse(stdout));

		expect(response.version).toBe(1);
		expect(response.ok).toBe(true);
		expect(response.result.name).toBe("add");
		expect(response.result.returnType).toBe("number");
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	});

	test("includes structured timing when requested", async () => {
		const { stdout, exitCode } = await runCli([
			`${sampleFile}:4:17`,
			"--timing",
			"--json",
		]);
		const response = hoverSuccessSchema.parse(JSON.parse(stdout));

		expect(response.result.timing?.resolution_ms).toBeGreaterThanOrEqual(0);
		expect(exitCode).toBe(0);
	});

	test("emits contract v1 JSON errors on stdout", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			"/nonexistent/file.ts:1:1",
			"--json",
		]);
		const response = contractErrorResponseSchema.parse(JSON.parse(stdout));

		expect(response.version).toBe(1);
		expect(response.ok).toBe(false);
		expect(response.error.code).toBe("FILE_NOT_FOUND");
		expect(response.error.file).toBe("/nonexistent/file.ts");
		expect(stderr).toBe("");
		expect(exitCode).toBe(1);
	});

	test("emits a stable JSON error for invalid arguments", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			sampleFile,
			"--json",
		]);
		const response = contractErrorResponseSchema.parse(JSON.parse(stdout));

		expect(response.error.code).toBe("INVALID_ARGUMENT");
		expect(stderr).toBe("");
		expect(exitCode).toBe(1);
	});

	test("shows error for missing file", async () => {
		const { stderr, exitCode } = await runCli(["/nonexistent/file.ts:1:1"]);
		expect(stderr).toContain("File not found");
		expect(exitCode).toBe(1);
	});

	test("shows error for invalid position format", async () => {
		const { stderr, exitCode } = await runCli([sampleFile]);
		expect(stderr).toContain("format");
		expect(exitCode).toBe(1);
	});

	test("shows error for invalid position with only file:line", async () => {
		const { stderr, exitCode } = await runCli([`${sampleFile}:4`]);
		expect(stderr).toContain("format");
		expect(exitCode).toBe(1);
	});

	test("accepts --project option", async () => {
		const projectPath = path.join(
			import.meta.dir,
			"..",
			"..",
			"tsconfig.json",
		);
		const { stdout, exitCode } = await runCli([
			`${sampleFile}:4:17`,
			"--project",
			projectPath,
		]);
		expect(stdout).toContain("number");
		expect(exitCode).toBe(0);
	});

	test("accepts -p option", async () => {
		const projectPath = path.join(
			import.meta.dir,
			"..",
			"..",
			"tsconfig.json",
		);
		const { stdout, exitCode } = await runCli([
			`${sampleFile}:4:17`,
			"-p",
			projectPath,
		]);
		expect(stdout).toContain("number");
		expect(exitCode).toBe(0);
	});

	test("accepts --docs flag", async () => {
		// "add" function with JSDoc at line 9, column 17
		const { stdout, exitCode } = await runCli([
			`${jsdocFile}:9:17`,
			"--docs",
		]);
		expect(stdout).toContain("docs:");
		expect(stdout).toContain("Adds two numbers");
		expect(exitCode).toBe(0);
	});

	test("accepts -d flag", async () => {
		const { stdout, exitCode } = await runCli([`${jsdocFile}:9:17`, "-d"]);
		expect(stdout).toContain("docs:");
		expect(exitCode).toBe(0);
	});

	test("shows error for invalid position", async () => {
		const { stderr, exitCode } = await runCli([`${sampleFile}:1000:1`]);
		expect(stderr).toContain("No symbol found");
		expect(exitCode).toBe(1);
	});

	test("help shows file:line:column syntax", async () => {
		const { stdout } = await runCli(["--help"]);
		expect(stdout).toContain(":line:");
		expect(stdout).toContain(":column");
	});
});
