import { describe, expect, test } from "bun:test";
import path from "node:path";

const cliPath = path.join(import.meta.dir, "..", "cli.ts");
const fixturesDir = path.join(import.meta.dir, "fixtures");
const sampleFile = path.join(fixturesDir, "sample.ts");
const jsdocFile = path.join(fixturesDir, "with-jsdoc.ts");

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

	test("gets type at file:line:column", async () => {
		// "add" function at line 4, column 17
		const { stdout, exitCode } = await runCli([`${sampleFile}:4:17`]);
		expect(stdout).toContain("number");
		expect(stdout).toContain("kind:");
		expect(exitCode).toBe(0);
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
