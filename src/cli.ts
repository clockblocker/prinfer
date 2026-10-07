#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	type ContractErrorCode,
	completionSuccess,
	contractError,
	diagnosticsSuccess,
	hoverSuccess,
} from "./contract.js";
import { formatDiagnostics } from "./core/index.js";
import { completions, diagnostics, hover } from "./index.js";
import { runSetup } from "./setup.js";

const HELP = `
prinfer - TypeScript type inference inspection tool

Usage:
  prinfer <file.ts>:<name> [--docs] [--timing] [--full] [--json] [--project <tsconfig.json>]
  prinfer <file.ts>:<name>:<line> [--docs] [--timing] [--full] [--json] [--project <tsconfig.json>]
  prinfer <file.ts>:<line>:<column> [--docs] [--timing] [--full] [--json] [--project <tsconfig.json>]
  prinfer complete <file.ts>:<line>:<column> [--json] [--project <tsconfig.json>]
  prinfer check <file.ts> [--suggestions] [--json] [--project <tsconfig.json>]
  prinfer mcp
  prinfer setup <codex|claude|cursor|vscode|gemini> [--scope <scope>] [--npx] [--print]
  prinfer setup agents-md [--file <path>] [--print]

Commands:
  complete             Show TypeScript autocomplete entries at a cursor
  check                Report type errors in one file; exits 1 when it has errors
  mcp                  Start the MCP server on stdio (same as prinfer-mcp)
  setup <client>       Register the MCP server with an agent client
  setup agents-md      Add prinfer usage instructions to AGENTS.md or CLAUDE.md

Arguments:
  file.ts:name         Path to TypeScript file with symbol name
  file.ts:name:line    Path to TypeScript file with symbol name and line hint
  file.ts:line:column  Path to TypeScript file with 1-based line and column

Options:
  --docs, -d           Include JSDoc/TSDoc documentation
  --timing, -t         Include TypeScript 6 resolution timing
  --full, -f           Disable editor-style type truncation
  --suggestions        check: also report suggestions such as unused variables
  --json               Emit the versioned JSON contract on stdout
  --project, -p        Path to tsconfig.json (optional)
  --help, -h           Show this help message (prinfer setup --help for setup options)

Examples:
  prinfer src/utils.ts:createHandler --json
  prinfer src/utils.ts:createHandler:75
  prinfer src/utils.ts:75:10 --docs
  prinfer complete src/utils.ts:75:10
  prinfer check src/utils.ts --json
  prinfer setup claude
  prinfer setup cursor --scope project --print
  prinfer setup agents-md --file CLAUDE.md
  npx -y prinfer mcp
`.trim();

/**
 * Starts the MCP stdio server from the sibling build output (dist/mcp.js) in
 * this process, so `npx -y prinfer mcp` works without a second bin name.
 */
async function startMcpServer(): Promise<void> {
	const script = fs.realpathSync(process.argv[1]);
	const dir = path.dirname(script);
	const entry = [`mcp${path.extname(script)}`, "mcp.js"]
		.map((name) => path.join(dir, name))
		.find((candidate) => fs.existsSync(candidate));
	if (!entry) {
		console.error(`Error: prinfer MCP server not found next to ${script}`);
		process.exit(1);
	}
	await import(pathToFileURL(entry).href);
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

interface CliCompletionOptions {
	mode: "completion";
	file: string;
	line: number;
	column: number;
	json: boolean;
	project?: string;
}

type CliOptions = CliPositionOptions | CliNameOptions | CliCompletionOptions;

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

	const completionMode = args[0] === "complete" || args[0] === "completions";
	const positionArg = completionMode ? args[1] : args[0];
	const parsed = positionArg ? parsePositionArg(positionArg) : null;

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

	if (completionMode) {
		if (parsed.mode !== "position") {
			const message = "complete requires <file>:<line>:<column>";
			if (json) failJson(message, "INVALID_ARGUMENT");
			console.error(`Error: ${message}`);
			process.exit(1);
		}
		return {
			mode: "completion",
			file: parsed.file,
			line: parsed.line,
			column: parsed.column,
			json,
			project,
		};
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

/**
 * Runs `prinfer check <file>` (args exclude "check") and returns an exit code:
 * 0 when the file has no type errors, 1 when it has errors or the check fails.
 */
function runCheck(args: string[]): number {
	const json = args.includes("--json");
	const fail = (message: string): number => {
		if (json) failJson(message, "INVALID_ARGUMENT");
		console.error(`Error: ${message}\n`);
		console.log(HELP);
		return 1;
	};

	let file: string | undefined;
	let project: string | undefined;
	let includeSuggestions = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--json") continue;
		if (arg === "--suggestions") {
			includeSuggestions = true;
		} else if (arg === "--project" || arg === "-p") {
			project = args[++index];
			if (!project) return fail("--project requires a path argument.");
		} else if (arg.startsWith("-")) {
			return fail(`Unknown check option ${arg}.`);
		} else if (file === undefined) {
			file = arg;
		} else {
			return fail(`Unexpected argument "${arg}".`);
		}
	}
	if (!file) return fail("check requires a file: prinfer check <file.ts>");

	try {
		const result = diagnostics(file, {
			project,
			include_suggestions: includeSuggestions,
		});
		console.log(
			json
				? JSON.stringify(diagnosticsSuccess(result))
				: formatDiagnostics(result, file),
		);
		return result.errorCount > 0 ? 1 : 0;
	} catch (error) {
		if (json) {
			console.log(
				JSON.stringify(
					contractError(error, { file: path.resolve(file) }),
				),
			);
			return 1;
		}
		console.error((error as Error).message);
		return 1;
	}
}

function main(): void {
	const command = process.argv[2];
	if (command === "mcp") {
		startMcpServer().catch((error: unknown) => {
			console.error(
				`Error: failed to start the prinfer MCP server: ${(error as Error).message}`,
			);
			process.exit(1);
		});
		return;
	}
	if (command === "setup") {
		process.exit(runSetup(process.argv.slice(3)));
	}
	if (command === "check") {
		const args = process.argv.slice(3);
		if (args.includes("--help") || args.includes("-h")) {
			console.log(HELP);
			process.exit(0);
		}
		process.exit(runCheck(args));
	}

	const options = parseArgs(process.argv);

	if (!options) {
		process.exit(0);
	}

	try {
		if (options.mode === "completion") {
			const result = completions(
				options.file,
				options.line,
				options.column,
				{
					project: options.project,
				},
			);
			if (options.json) {
				console.log(JSON.stringify(completionSuccess(result)));
			} else {
				for (const entry of result.entries) console.log(entry.name);
			}
			return;
		}
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
			console.log(
				"type resolution:",
				`${result.timing.resolution_ms} ms`,
			);
		}
	} catch (error) {
		if (options.json) {
			const context =
				options.mode === "position" || options.mode === "completion"
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
