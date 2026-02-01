import { describe, expect, test } from "bun:test";
import path from "node:path";

const cliPath = path.join(import.meta.dir, "..", "cli.ts");
const fixturesDir = path.join(import.meta.dir, "fixtures");
const sampleFile = path.join(fixturesDir, "sample.ts");

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

	test("infers type for a valid file and symbol", async () => {
		const { stdout, exitCode } = await runCli([sampleFile, "add"]);
		expect(stdout).toContain("number");
		expect(exitCode).toBe(0);
	});

	test("shows error for missing file", async () => {
		const { stderr, exitCode } = await runCli([
			"/nonexistent/file.ts",
			"foo",
		]);
		expect(stderr).toContain("File not found");
		expect(exitCode).toBe(1);
	});

	test("shows error for missing symbol", async () => {
		const { stderr, exitCode } = await runCli([sampleFile, "nonExistent"]);
		expect(stderr).toContain('No symbol named "nonExistent"');
		expect(exitCode).toBe(1);
	});

	test("shows error when only file is provided", async () => {
		const { stderr, exitCode } = await runCli([sampleFile]);
		expect(stderr).toContain("required");
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
			sampleFile,
			"add",
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
			sampleFile,
			"add",
			"-p",
			projectPath,
		]);
		expect(stdout).toContain("number");
		expect(exitCode).toBe(0);
	});

	test("accepts file:line syntax", async () => {
		const { stdout, exitCode } = await runCli([
			`${sampleFile}:9`,
			"multiply",
		]);
		expect(stdout).toContain("number");
		expect(exitCode).toBe(0);
	});

	test("shows error when line does not match", async () => {
		const { stderr, exitCode } = await runCli([`${sampleFile}:1`, "add"]);
		expect(stderr).toContain("at line 1");
		expect(exitCode).toBe(1);
	});

	test("help shows line syntax", async () => {
		const { stdout } = await runCli(["--help"]);
		expect(stdout).toContain(":line");
	});
});
