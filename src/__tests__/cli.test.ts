import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	contractErrorResponseSchema,
	diagnosticsSuccessSchema,
	hoverSuccessSchema,
} from "../contract.js";

const cliPath = path.join(import.meta.dir, "..", "cli.ts");
const fixturesDir = path.join(import.meta.dir, "fixtures");
const sampleFile = path.join(fixturesDir, "sample.ts");
const jsdocFile = path.join(fixturesDir, "with-jsdoc.ts");
const typeAliasFile = path.join(fixturesDir, "type-alias.ts");
const completionsFile = path.join(fixturesDir, "completions.ts");
const diagnosticsDir = path.join(fixturesDir, "diagnostics");
const errorsFile = path.join(diagnosticsDir, "errors.ts");
const cleanFile = path.join(diagnosticsDir, "clean.ts");

interface RunOptions {
	cwd?: string;
	env?: Record<string, string>;
}

async function runCli(
	args: string[],
	options: RunOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn([process.execPath, "run", cliPath, ...args], {
		cwd: options.cwd,
		env: options.env,
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

describe("prinfer check", () => {
	test("prints tsc-style errors and exits 1 when the file has errors", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			"check",
			errorsFile,
		]);
		expect(stdout).toContain(
			`${errorsFile}:3:14 error TS2322: Type 'string' is not assignable to type 'number'.`,
		);
		expect(stdout).toContain("3 errors, 0 warnings.");
		expect(stdout).not.toContain("TS6133");
		expect(stderr).toBe("");
		expect(exitCode).toBe(1);
	});

	test("reports a clean file and exits 0", async () => {
		const { stdout, stderr, exitCode } = await runCli(["check", cleanFile]);
		expect(stdout).toBe("No type errors.\n");
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	});

	test("emits the diagnostics contract with --json", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			"check",
			errorsFile,
			"--json",
		]);
		const response = diagnosticsSuccessSchema.parse(JSON.parse(stdout));
		expect(response.result.file).toBe(errorsFile);
		expect(response.result.errorCount).toBe(3);
		expect(response.result.diagnostics[0]).toMatchObject({
			line: 3,
			column: 14,
			code: 2322,
			category: "error",
		});
		expect(stderr).toBe("");
		expect(exitCode).toBe(1);
	});

	test("includes suggestions with --suggestions", async () => {
		const { stdout } = await runCli([
			"check",
			errorsFile,
			"--suggestions",
			"--json",
		]);
		const response = diagnosticsSuccessSchema.parse(JSON.parse(stdout));
		expect(
			response.result.diagnostics.find((d) => d.code === 6133),
		).toMatchObject({ line: 17, category: "suggestion" });
	});

	test("accepts --project", async () => {
		const { stdout, exitCode } = await runCli([
			"check",
			cleanFile,
			"--project",
			path.join(diagnosticsDir, "tsconfig.json"),
		]);
		expect(stdout).toBe("No type errors.\n");
		expect(exitCode).toBe(0);
	});

	test("emits a JSON contract error for a missing file", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			"check",
			"/nonexistent/file.ts",
			"--json",
		]);
		const response = contractErrorResponseSchema.parse(JSON.parse(stdout));
		expect(response.error.code).toBe("FILE_NOT_FOUND");
		expect(response.error.file).toBe("/nonexistent/file.ts");
		expect(stderr).toBe("");
		expect(exitCode).toBe(1);
	});

	test("rejects a missing file argument", async () => {
		const { stdout, exitCode } = await runCli(["check", "--json"]);
		const response = contractErrorResponseSchema.parse(JSON.parse(stdout));
		expect(response.error.code).toBe("INVALID_ARGUMENT");
		expect(exitCode).toBe(1);
	});

	test("rejects unknown options", async () => {
		const { stderr, exitCode } = await runCli([
			"check",
			cleanFile,
			"--bogus",
		]);
		expect(stderr).toContain("Unknown check option --bogus");
		expect(exitCode).toBe(1);
	});

	test("is listed in --help", async () => {
		const { stdout } = await runCli(["--help"]);
		expect(stdout).toContain("prinfer check <file.ts>");
	});
});

const packageRoot = path.join(import.meta.dir, "..", "..");
const NPX_SERVER = ["npx", "-y", "prinfer", "mcp"];
const FAKE_CLIENTS = ["codex", "claude", "code", "gemini"];

interface SetupSandbox {
	root: string;
	home: string;
	cwd: string;
	run(
		args: string[],
		extraEnv?: Record<string, string>,
	): ReturnType<typeof runCli>;
	/** Each recorded invocation of a fake executable as [name, ...argv]. */
	calls(): string[][];
	addFake(name: string): void;
	removeFake(name: string): void;
}

/** Temp HOME, cwd, and a PATH holding only fake executables that log argv. */
function createSandbox(): SetupSandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-setup-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const bin = path.join(root, "bin");
	const log = path.join(root, "calls.log");
	for (const dir of [home, cwd, bin]) fs.mkdirSync(dir);

	const addFake = (name: string) => {
		const script = path.join(bin, name);
		fs.writeFileSync(
			script,
			[
				"#!/bin/sh",
				`printf '%s' '${name}' >> "$PRINFER_TEST_LOG"`,
				`for arg in "$@"; do printf '\\t%s' "$arg" >> "$PRINFER_TEST_LOG"; done`,
				`printf '\\n' >> "$PRINFER_TEST_LOG"`,
				`exit "$FAKE_EXIT"`,
				"",
			].join("\n"),
		);
		fs.chmodSync(script, 0o755);
	};
	for (const name of FAKE_CLIENTS) addFake(name);

	return {
		root,
		home,
		cwd,
		run: (args, extraEnv = {}) =>
			runCli(args, {
				cwd,
				env: {
					HOME: home,
					PATH: bin,
					PRINFER_TEST_LOG: log,
					FAKE_EXIT: "0",
					...extraEnv,
				},
			}),
		calls: () =>
			fs.existsSync(log)
				? fs
						.readFileSync(log, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => line.split("\t"))
				: [],
		addFake,
		removeFake: (name) => fs.rmSync(path.join(bin, name)),
	};
}

function readJson(file: string): unknown {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("prinfer setup", () => {
	let sandbox: SetupSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		fs.rmSync(sandbox.root, { recursive: true, force: true });
	});

	test("lists supported clients when no client is given", async () => {
		const { stdout, exitCode } = await sandbox.run(["setup"]);
		for (const client of [
			"codex",
			"claude",
			"cursor",
			"vscode",
			"gemini",
			"agents-md",
		]) {
			expect(stdout).toContain(client);
		}
		expect(exitCode).toBe(0);
	});

	test("rejects unknown clients with the supported list", async () => {
		const { stderr, exitCode } = await sandbox.run(["setup", "emacs"]);
		expect(stderr).toContain('Unknown setup client "emacs"');
		expect(stderr).toContain(
			"codex, claude, cursor, gemini, vscode, agents-md",
		);
		expect(exitCode).toBe(1);
	});

	test("prints the npx server command when prinfer-mcp is not on PATH", async () => {
		const { stdout, stderr, exitCode } = await sandbox.run([
			"setup",
			"codex",
			"--print",
		]);
		expect(stdout.trim()).toBe(
			"codex mcp add prinfer -- npx -y prinfer mcp",
		);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(sandbox.calls()).toEqual([]);
	});

	test("prefers prinfer-mcp on PATH over an absolute install path", async () => {
		sandbox.addFake("prinfer-mcp");
		const { stdout, exitCode } = await sandbox.run([
			"setup",
			"codex",
			"--print",
		]);
		expect(stdout.trim()).toBe("codex mcp add prinfer -- prinfer-mcp");
		expect(exitCode).toBe(0);
	});

	test("ignores prinfer-mcp from npx or a project's node_modules/.bin", async () => {
		const npxBin = path.join(
			sandbox.root,
			"_npx",
			"abc123",
			"node_modules",
			".bin",
		);
		fs.mkdirSync(npxBin, { recursive: true });
		const fake = path.join(npxBin, "prinfer-mcp");
		fs.writeFileSync(fake, "#!/bin/sh\n");
		fs.chmodSync(fake, 0o755);
		const { stdout, exitCode } = await sandbox.run(
			["setup", "codex", "--print"],
			{
				PATH: `${npxBin}${path.delimiter}${path.join(sandbox.root, "bin")}`,
			},
		);
		expect(stdout.trim()).toBe(
			"codex mcp add prinfer -- npx -y prinfer mcp",
		);
		expect(exitCode).toBe(0);
	});

	test("--npx forces the npx server command", async () => {
		sandbox.addFake("prinfer-mcp");
		const { stdout, exitCode } = await sandbox.run([
			"setup",
			"codex",
			"--npx",
			"--print",
		]);
		expect(stdout.trim()).toBe(
			"codex mcp add prinfer -- npx -y prinfer mcp",
		);
		expect(exitCode).toBe(0);
	});

	test("replaces the Codex server registration", async () => {
		sandbox.addFake("prinfer-mcp");
		const { stdout, exitCode } = await sandbox.run(["setup", "codex"]);
		expect(sandbox.calls()).toEqual([
			["codex", "mcp", "remove", "prinfer"],
			["codex", "mcp", "add", "prinfer", "--", "prinfer-mcp"],
		]);
		expect(stdout).toContain("Restart Codex");
		expect(exitCode).toBe(0);
	});

	test("rejects --scope for Codex", async () => {
		const { stderr, exitCode } = await sandbox.run([
			"setup",
			"codex",
			"--scope",
			"project",
		]);
		expect(stderr).toContain("Codex does not support --scope");
		expect(exitCode).toBe(1);
		expect(sandbox.calls()).toEqual([]);
	});

	test("registers Claude Code at user scope by default", async () => {
		const { stdout, exitCode } = await sandbox.run(["setup", "claude"]);
		expect(sandbox.calls()).toEqual([
			["claude", "mcp", "remove", "--scope", "user", "prinfer"],
			[
				"claude",
				"mcp",
				"add",
				"--scope",
				"user",
				"prinfer",
				"--",
				...NPX_SERVER,
			],
		]);
		expect(stdout).toContain("Restart Claude Code");
		expect(exitCode).toBe(0);
	});

	test("registers Claude Code at the requested scope", async () => {
		const { exitCode } = await sandbox.run([
			"setup",
			"claude",
			"--scope",
			"project",
		]);
		expect(sandbox.calls()[1]).toEqual([
			"claude",
			"mcp",
			"add",
			"--scope",
			"project",
			"prinfer",
			"--",
			...NPX_SERVER,
		]);
		expect(exitCode).toBe(0);
	});

	test("rejects unknown scopes", async () => {
		const { stderr, exitCode } = await sandbox.run([
			"setup",
			"claude",
			"--scope",
			"global",
		]);
		expect(stderr).toContain('Unknown scope "global"');
		expect(exitCode).toBe(1);
	});

	test("explains how to finish when the client CLI is missing", async () => {
		sandbox.removeFake("claude");
		const { stderr, exitCode } = await sandbox.run(["setup", "claude"]);
		expect(stderr).toContain("'claude' was not found on PATH");
		expect(stderr).toContain(
			"claude mcp add --scope user prinfer -- npx -y prinfer mcp",
		);
		expect(exitCode).toBe(1);
	});

	test("reports a failing client CLI", async () => {
		const { stderr, exitCode } = await sandbox.run(["setup", "codex"], {
			FAKE_EXIT: "3",
		});
		expect(stderr).toContain("Codex setup failed");
		expect(stderr).toContain("Run manually");
		expect(exitCode).toBe(1);
	});

	test("merges into Cursor's user config without clobbering servers", async () => {
		const file = path.join(sandbox.home, ".cursor", "mcp.json");
		fs.mkdirSync(path.dirname(file));
		fs.writeFileSync(
			file,
			'{\n\t"mcpServers": {\n\t\t"other": { "command": "other-mcp" }\n\t},\n\t"extra": true\n}\n',
		);

		const { stdout, exitCode } = await sandbox.run(["setup", "cursor"]);
		expect(readJson(file)).toEqual({
			mcpServers: {
				other: { command: "other-mcp" },
				prinfer: {
					type: "stdio",
					command: "npx",
					args: ["-y", "prinfer", "mcp"],
				},
			},
			extra: true,
		});
		const written = fs.readFileSync(file, "utf8");
		expect(written).toContain('\n\t"mcpServers"');
		expect(written.endsWith("}\n")).toBe(true);
		expect(stdout).toContain("Restart Cursor");
		expect(exitCode).toBe(0);

		await sandbox.run(["setup", "cursor"]);
		expect(fs.readFileSync(file, "utf8")).toBe(written);
	});

	test("creates Cursor's project config", async () => {
		sandbox.addFake("prinfer-mcp");
		const { exitCode } = await sandbox.run([
			"setup",
			"cursor",
			"--scope",
			"project",
		]);
		expect(readJson(path.join(sandbox.cwd, ".cursor", "mcp.json"))).toEqual(
			{
				mcpServers: {
					prinfer: {
						type: "stdio",
						command: "prinfer-mcp",
						args: [],
					},
				},
			},
		);
		expect(fs.existsSync(path.join(sandbox.home, ".cursor"))).toBe(false);
		expect(exitCode).toBe(0);
	});

	test("leaves unparseable JSON config untouched", async () => {
		const file = path.join(sandbox.home, ".cursor", "mcp.json");
		fs.mkdirSync(path.dirname(file));
		const original = '{\n  // comment\n  "mcpServers": {}\n}\n';
		fs.writeFileSync(file, original);

		const { stderr, exitCode } = await sandbox.run(["setup", "cursor"]);
		expect(stderr).toContain("is not valid JSON");
		expect(stderr).toContain('"prinfer"');
		expect(fs.readFileSync(file, "utf8")).toBe(original);
		expect(exitCode).toBe(1);
	});

	test("prints a JSON config change without writing it", async () => {
		const { stdout, exitCode } = await sandbox.run([
			"setup",
			"gemini",
			"--print",
		]);
		const file = path.join(sandbox.home, ".gemini", "settings.json");
		expect(stdout).toContain(`Would update ${file}:`);
		expect(JSON.parse(stdout.slice(stdout.indexOf("{")))).toEqual({
			mcpServers: {
				prinfer: { command: "npx", args: ["-y", "prinfer", "mcp"] },
			},
		});
		expect(fs.existsSync(file)).toBe(false);
		expect(exitCode).toBe(0);
	});

	test("merges into Gemini CLI settings", async () => {
		const file = path.join(sandbox.home, ".gemini", "settings.json");
		fs.mkdirSync(path.dirname(file));
		fs.writeFileSync(file, JSON.stringify({ theme: "Default" }, null, 4));

		const { stdout, exitCode } = await sandbox.run(["setup", "gemini"]);
		expect(readJson(file)).toEqual({
			theme: "Default",
			mcpServers: {
				prinfer: { command: "npx", args: ["-y", "prinfer", "mcp"] },
			},
		});
		expect(fs.readFileSync(file, "utf8")).toContain('\n    "theme"');
		expect(stdout).toContain("Restart Gemini CLI");
		expect(exitCode).toBe(0);
		expect(sandbox.calls()).toEqual([]);
	});

	test("writes Gemini CLI project settings", async () => {
		const { exitCode } = await sandbox.run([
			"setup",
			"gemini",
			"--scope",
			"project",
		]);
		expect(
			readJson(path.join(sandbox.cwd, ".gemini", "settings.json")),
		).toEqual({
			mcpServers: {
				prinfer: { command: "npx", args: ["-y", "prinfer", "mcp"] },
			},
		});
		expect(exitCode).toBe(0);
	});

	test("registers VS Code at user scope with code --add-mcp", async () => {
		const { stdout, exitCode } = await sandbox.run(["setup", "vscode"]);
		const calls = sandbox.calls();
		expect(calls).toHaveLength(1);
		expect(calls[0].slice(0, 2)).toEqual(["code", "--add-mcp"]);
		expect(JSON.parse(calls[0][2])).toEqual({
			name: "prinfer",
			type: "stdio",
			command: "npx",
			args: ["-y", "prinfer", "mcp"],
		});
		expect(stdout).toContain("Reload VS Code");
		expect(exitCode).toBe(0);
	});

	test("merges into VS Code's workspace mcp.json", async () => {
		const file = path.join(sandbox.cwd, ".vscode", "mcp.json");
		fs.mkdirSync(path.dirname(file));
		fs.writeFileSync(
			file,
			JSON.stringify({ inputs: [], servers: { other: { url: "x" } } }),
		);

		const { exitCode } = await sandbox.run([
			"setup",
			"vscode",
			"--scope",
			"project",
		]);
		expect(readJson(file)).toEqual({
			inputs: [],
			servers: {
				other: { url: "x" },
				prinfer: {
					type: "stdio",
					command: "npx",
					args: ["-y", "prinfer", "mcp"],
				},
			},
		});
		expect(exitCode).toBe(0);
		expect(sandbox.calls()).toEqual([]);
	});
});

describe("prinfer setup agents-md", () => {
	let sandbox: SetupSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		fs.rmSync(sandbox.root, { recursive: true, force: true });
	});

	const START = "<!-- prinfer:start -->";
	const END = "<!-- prinfer:end -->";
	const block = (text: string) =>
		text.slice(text.indexOf(START), text.indexOf(END) + END.length);

	test("creates AGENTS.md with the prinfer block", async () => {
		const { stdout, exitCode } = await sandbox.run(["setup", "agents-md"]);
		const text = fs.readFileSync(
			path.join(sandbox.cwd, "AGENTS.md"),
			"utf8",
		);
		expect(text.startsWith(`${START}\n`)).toBe(true);
		expect(text.endsWith(`${END}\n`)).toBe(true);
		for (const hint of [
			"hover_by_name",
			"hover(file, line, text)",
			"completions",
			"diagnostics",
			"npx prinfer",
		]) {
			expect(text).toContain(hint);
		}
		expect(stdout).toContain("Added the prinfer block");
		expect(exitCode).toBe(0);
	});

	test("appends to an existing file and is idempotent", async () => {
		const file = path.join(sandbox.cwd, "CLAUDE.md");
		fs.writeFileSync(file, "# Project\n\nUse bun.");

		await sandbox.run(["setup", "agents-md", "--file", "CLAUDE.md"]);
		const once = fs.readFileSync(file, "utf8");
		expect(once.startsWith(`# Project\n\nUse bun.\n\n${START}`)).toBe(true);

		const { stdout, exitCode } = await sandbox.run([
			"setup",
			"agents-md",
			"--file",
			"CLAUDE.md",
		]);
		expect(fs.readFileSync(file, "utf8")).toBe(once);
		expect(stdout).toContain("already has the current prinfer block");
		expect(exitCode).toBe(0);
		expect(fs.existsSync(path.join(sandbox.cwd, "AGENTS.md"))).toBe(false);
	});

	test("replaces an outdated block in place", async () => {
		const file = path.join(sandbox.cwd, "AGENTS.md");
		fs.writeFileSync(
			file,
			`# Rules\n${START}\nold advice\n${END}\n## After\n`,
		);
		const { stdout: printed } = await sandbox.run([
			"setup",
			"agents-md",
			"--print",
		]);

		const { stdout, exitCode } = await sandbox.run(["setup", "agents-md"]);
		const text = fs.readFileSync(file, "utf8");
		expect(text).not.toContain("old advice");
		expect(text.startsWith(`# Rules\n${START}`)).toBe(true);
		expect(text.endsWith(`${END}\n## After\n`)).toBe(true);
		expect(block(text)).toBe(block(printed));
		expect(stdout).toContain("Updated the prinfer block");
		expect(exitCode).toBe(0);
	});

	test("prints the block without writing", async () => {
		const { stdout, exitCode } = await sandbox.run([
			"setup",
			"agents-md",
			"--print",
		]);
		expect(stdout).toContain(START);
		expect(stdout).toContain(END);
		expect(fs.existsSync(path.join(sandbox.cwd, "AGENTS.md"))).toBe(false);
		expect(exitCode).toBe(0);
	});

	test("refuses to edit a file with an unmatched marker", async () => {
		const file = path.join(sandbox.cwd, "AGENTS.md");
		const original = `${START}\nhalf a block\n`;
		fs.writeFileSync(file, original);
		const { stderr, exitCode } = await sandbox.run(["setup", "agents-md"]);
		expect(stderr).toContain("unmatched");
		expect(fs.readFileSync(file, "utf8")).toBe(original);
		expect(exitCode).toBe(1);
	});
});

describe("prinfer mcp", () => {
	const distCli = path.join(packageRoot, "dist", "cli.js");
	let binDir: string;

	beforeEach(() => {
		if (
			!fs.existsSync(distCli) ||
			!fs.existsSync(path.join(packageRoot, "dist", "mcp.js"))
		) {
			const build = Bun.spawnSync(["bun", "run", "build"], {
				cwd: packageRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(build.exitCode).toBe(0);
		}
		// npm installs bins as symlinks; the server must resolve beside the target.
		binDir = fs.mkdtempSync(path.join(os.tmpdir(), "prinfer-bin-"));
		fs.symlinkSync(distCli, path.join(binDir, "prinfer"));
	});

	afterEach(() => {
		fs.rmSync(binDir, { recursive: true, force: true });
	});

	test("shows the MCP server help", async () => {
		const proc = Bun.spawn(
			["node", path.join(binDir, "prinfer"), "mcp", "--help"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(proc.stdout).text();
		expect(stdout).toMatch(/^prinfer-mcp \S+ - MCP server/);
		expect(stdout).toContain("prinfer setup");
		expect(await proc.exited).toBe(0);
	});

	test("keeps the prinfer-mcp bin working through a symlink", async () => {
		const bin = path.join(binDir, "prinfer-mcp");
		fs.symlinkSync(path.join(packageRoot, "dist", "mcp.js"), bin);
		const proc = Bun.spawn(["node", bin, "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await new Response(proc.stdout).text()).toMatch(
			/^prinfer-mcp \S+ - MCP server/,
		);
		expect(await new Response(proc.stderr).text()).toBe("");
		expect(await proc.exited).toBe(0);
	});

	test("speaks MCP over stdio with nothing else on stdout", async () => {
		const proc = Bun.spawn(["node", path.join(binDir, "prinfer"), "mcp"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		const lines: string[] = [];
		let buffer = "";
		const pump = async (): Promise<boolean> => {
			const { value, done } = await reader.read();
			if (done) return false;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			lines.push(...parts);
			return true;
		};
		const response = async (id: number) => {
			for (;;) {
				const line = lines.find((entry) => {
					try {
						return JSON.parse(entry).id === id;
					} catch {
						return false;
					}
				});
				if (line) return JSON.parse(line);
				if (!(await pump())) {
					throw new Error(`stdout closed before response ${id}`);
				}
			}
		};
		const send = (message: object) => {
			proc.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
			);
			proc.stdin.flush();
		};

		send({
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "prinfer-test", version: "0.0.0" },
			},
		});
		const initialized = await response(1);
		expect(initialized.result.serverInfo.name).toBe("prinfer");

		send({ method: "notifications/initialized" });
		send({ id: 2, method: "tools/list" });
		const tools = await response(2);
		expect(
			tools.result.tools.map((tool: { name: string }) => tool.name),
		).toContain("hover_by_name");

		proc.stdin.end();
		while (await pump()) {
			// Drain stdout until the server exits.
		}
		expect(await proc.exited).toBe(0);
		expect(buffer).toBe("");
		for (const line of lines) {
			expect(JSON.parse(line).jsonrpc).toBe("2.0");
		}
	}, 15_000);
});
