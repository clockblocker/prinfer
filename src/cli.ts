#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
	type ContractErrorCode,
	contractError,
	hoverSuccess,
} from "./contract.js";
import { hover } from "./index.js";

const HELP = `
prinfer - TypeScript type inference inspection tool

Usage:
  prinfer <file.ts>:<line>:<column> [--docs] [--timing] [--full] [--json] [--project <tsconfig.json>]
  prinfer <file.ts>:<name> [--docs] [--timing] [--full] [--json] [--project <tsconfig.json>]
  prinfer <file.ts>:<name>:<line> [--docs] [--timing] [--full] [--json] [--project <tsconfig.json>]
  prinfer setup codex [--print]

Commands:
  setup codex          Configure the prinfer MCP server for Codex

Arguments:
  file.ts:line:column  Path to TypeScript file with 1-based line and column
  file.ts:name         Path to TypeScript file with symbol name
  file.ts:name:line    Path to TypeScript file with symbol name and line hint

Options:
  --docs, -d           Include JSDoc/TSDoc documentation
  --timing, -t         Include TypeScript 6 resolution timing
  --full, -f           Disable editor-style type truncation
  --json               Emit the versioned JSON contract on stdout
  --print              Print setup commands without changing configuration
  --project, -p        Path to tsconfig.json (optional)
  --help, -h           Show this help message

Examples:
  prinfer src/utils.ts:75:10
  prinfer src/utils.ts:createHandler
  prinfer src/utils.ts:createHandler:75
  prinfer src/utils.ts:75:10 --docs
  prinfer src/utils.ts:75:10 --project ./tsconfig.json
  prinfer setup codex
  prinfer setup codex --print
`.trim();

function getMcpBinaryPath(): string {
	const thisScript = path.resolve(process.argv[1]);
	return path.join(path.dirname(thisScript), "mcp.js");
}

function runSetup(args: string[]): void {
	const client = args[1];
	if (client !== "codex") {
		console.error("Error: setup requires a supported client: codex");
		process.exit(1);
	}

	const command = [
		"codex",
		"mcp",
		"add",
		"prinfer",
		"--",
		"node",
		getMcpBinaryPath(),
	];
	if (args.includes("--print")) {
		console.log(command.map(quoteShellArgument).join(" "));
		return;
	}

	try {
		execFileSync("codex", ["mcp", "remove", "prinfer"], {
			stdio: "ignore",
		});
	} catch {
		// The server was not previously configured.
	}

	try {
		execFileSync("codex", command.slice(1), { stdio: "inherit" });
		console.log("[ok] Configured prinfer for Codex");
		console.log("Restart Codex to load the MCP server.");
	} catch (error) {
		console.error(
			`[error] Codex setup failed: ${(error as Error).message}`,
		);
		console.error(
			`Run manually: ${command.map(quoteShellArgument).join(" ")}`,
		);
		process.exit(1);
	}
}

function quoteShellArgument(argument: string): string {
	if (/^[a-zA-Z0-9_./:@-]+$/.test(argument)) return argument;
	return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

interface CliPositionOptions {
	mode: "position";
	file: string;
	line: number;
	column: number;
	includeDocs: boolean;
	includeTiming: boolean;
	full: boolean;
	json: boolean;
	project?: string;
}

interface CliNameOptions {
	mode: "name";
	file: string;
	name: string;
	line?: number;
	includeDocs: boolean;
	includeTiming: boolean;
	full: boolean;
	json: boolean;
	project?: string;
}

type CliOptions = CliPositionOptions | CliNameOptions;

type ParsedArg =
	| { mode: "position"; file: string; line: number; column: number }
	| { mode: "name"; file: string; name: string; line?: number };

function parsePositionArg(arg: string): ParsedArg | null {
	// Match pattern: file.ts:line:column (position-based)
	const posMatch = arg.match(/^(.+):(\d+):(\d+)$/);
	if (posMatch) {
		return {
			mode: "position",
			file: posMatch[1],
			line: Number.parseInt(posMatch[2], 10),
			column: Number.parseInt(posMatch[3], 10),
		};
	}

	// Match pattern: file.ts:name:line (name with line hint)
	// Name must start with a letter or underscore and not be all digits
	const nameLineMatch = arg.match(/^(.+):([a-zA-Z_][a-zA-Z0-9_]*):(\d+)$/);
	if (nameLineMatch) {
		return {
			mode: "name",
			file: nameLineMatch[1],
			name: nameLineMatch[2],
			line: Number.parseInt(nameLineMatch[3], 10),
		};
	}

	// Match pattern: file.ts:name (name-based)
	const nameMatch = arg.match(/^(.+):([a-zA-Z_][a-zA-Z0-9_]*)$/);
	if (nameMatch) {
		return {
			mode: "name",
			file: nameMatch[1],
			name: nameMatch[2],
		};
	}

	return null;
}

function parseArgs(argv: string[]): CliOptions | null {
	const args = argv.slice(2);
	const json = args.includes("--json");

	// Check for help flag
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		console.log(HELP);
		return null;
	}

	// Check for setup command
	if (args[0] === "setup") {
		runSetup(args);
		return null;
	}

	const positionArg = args[0];
	const parsed = parsePositionArg(positionArg);

	if (!parsed) {
		const message =
			"Argument must be in format <file>:<line>:<column> or <file>:<name> or <file>:<name>:<line>";
		if (json) failJson(message, "INVALID_ARGUMENT");
		console.error(`Error: ${message}\n`);
		console.log(HELP);
		process.exit(1);
	}

	// Check for docs flag
	const includeDocs = args.includes("--docs") || args.includes("-d");
	const includeTiming = args.includes("--timing") || args.includes("-t");
	const full = args.includes("--full") || args.includes("-f");

	// Find project option
	let project: string | undefined;
	const projectIdx = args.findIndex((a) => a === "--project" || a === "-p");
	if (projectIdx >= 0) {
		project = args[projectIdx + 1];
		if (!project) {
			const message = "--project requires a path argument.";
			if (json) failJson(message, "INVALID_ARGUMENT");
			console.error(`Error: ${message}\n`);
			console.log(HELP);
			process.exit(1);
		}
	}

	if (parsed.mode === "position") {
		return {
			mode: "position",
			file: parsed.file,
			line: parsed.line,
			column: parsed.column,
			includeDocs,
			includeTiming,
			full,
			json,
			project,
		};
	}

	return {
		mode: "name",
		file: parsed.file,
		name: parsed.name,
		line: parsed.line,
		includeDocs,
		includeTiming,
		full,
		json,
		project,
	};
}

function failJson(
	message: string,
	code: ContractErrorCode,
	context: { file?: string; line?: number; column?: number } = {},
): never {
	console.log(
		JSON.stringify(contractError(new Error(message), { code, ...context })),
	);
	process.exit(1);
}

function main(): void {
	const options = parseArgs(process.argv);

	if (!options) {
		process.exit(0);
	}

	try {
		const result =
			options.mode === "position"
				? hover(options.file, options.line, options.column, {
						include_docs: options.includeDocs,
						include_timing: options.includeTiming,
						full: options.full,
						project: options.project,
					})
				: hover(options.file, options.name, {
						include_docs: options.includeDocs,
						include_timing: options.includeTiming,
						full: options.full,
						project: options.project,
						line: options.line,
					});

		if (options.json) {
			console.log(JSON.stringify(hoverSuccess(result)));
			return;
		}

		console.log(result.signature);
		if (result.returnType) {
			console.log("returns:", result.returnType);
		}
		if (result.name) {
			console.log("name:", result.name);
		}
		console.log("kind:", result.kind);
		if (result.documentation) {
			console.log("docs:", result.documentation);
		}
		if (result.timing) {
			console.log("type resolution:", `${result.timing.resolution_ms} ms`);
		}
	} catch (error) {
		if (options.json) {
			const context =
				options.mode === "position"
					? {
							file: path.resolve(options.file),
							line: options.line,
							column: options.column,
						}
					: { file: path.resolve(options.file), line: options.line };
			console.log(JSON.stringify(contractError(error, context)));
			process.exit(1);
		}
		console.error((error as Error).message);
		process.exit(1);
	}
}

main();
