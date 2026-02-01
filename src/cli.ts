#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hover } from "./index.js";

const HELP = `
prinfer - TypeScript type inference inspection tool

Usage:
  prinfer <file.ts>:<line>:<column> [--docs] [--project <tsconfig.json>]
  prinfer <file.ts>:<name> [--docs] [--project <tsconfig.json>]
  prinfer <file.ts>:<name>:<line> [--docs] [--project <tsconfig.json>]
  prinfer setup

Commands:
  setup                Install MCP server and skill for Claude Code

Arguments:
  file.ts:line:column  Path to TypeScript file with 1-based line and column
  file.ts:name         Path to TypeScript file with symbol name
  file.ts:name:line    Path to TypeScript file with symbol name and line hint

Options:
  --docs, -d           Include JSDoc/TSDoc documentation
  --project, -p        Path to tsconfig.json (optional)
  --help, -h           Show this help message

Examples:
  prinfer src/utils.ts:75:10
  prinfer src/utils.ts:createHandler
  prinfer src/utils.ts:createHandler:75
  prinfer src/utils.ts:75:10 --docs
  prinfer src/utils.ts:75:10 --project ./tsconfig.json
  prinfer setup
`.trim();

const MANUAL_SETUP = `
Manual setup instructions:

1. Add MCP server:
   Run: claude mcp add prinfer node /path/to/prinfer-mcp

2. Create skill file at ~/.claude/skills/prefer-infer.md:
   See https://github.com/clockblocker/prinfer for skill content.
`.trim();

function getMcpBinaryPath(): string {
	// Resolve absolute path to prinfer-mcp
	// It's in the same directory as this script (dist/)
	const thisScript = new URL(import.meta.url).pathname;
	return path.join(path.dirname(thisScript), "mcp.js");
}

function installMcpServer(): boolean {
	try {
		const mcpPath = getMcpBinaryPath();

		// Always remove first to ensure correct path (handles upgrades/fixes)
		try {
			execSync("claude mcp remove prinfer", { stdio: "pipe" });
		} catch {
			// Ignore if not exists
		}

		// Add MCP server with absolute path
		execSync(`claude mcp add prinfer node ${mcpPath}`, {
			stdio: "inherit",
		});
		console.log("[ok] Added prinfer MCP server");
		return true;
	} catch (err) {
		console.error(`[error] MCP setup failed: ${(err as Error).message}`);
		return false;
	}
}

const SKILL_CONTENT = `# TypeScript Type Inference (prinfer)

## Coding Guideline

When writing TypeScript code, prefer relying on type inference over explicit type annotations:

- Let TypeScript infer return types for functions when the implementation makes them obvious
- Let TypeScript infer variable types from their initializers
- Only add explicit types when:
  - The inferred type is too wide (e.g., \`string\` instead of a literal type)
  - The type serves as documentation for complex structures
  - You're defining a public API contract

Use the \`prinfer\` MCP tool (\`hover\`) to verify what TypeScript infers before adding explicit types.

## Commands

### /hover

Check the inferred type at a specific position in a TypeScript file.

Usage: \`/hover <file>:<line>:<column>\`

Examples:
- \`/hover src/utils.ts:75:10\`
- \`/hover src/utils.ts:42:5\`

<command-name>hover</command-name>

Use the \`hover\` MCP tool to check the type:
1. Parse the arguments to extract file, line, and column
2. Call \`hover(file, line, column, { include_docs: true })\`
3. Report the inferred signature, return type, and documentation
`;

function runSetup(): void {
	const homeDir = os.homedir();
	const claudeDir = path.join(homeDir, ".claude");

	if (!fs.existsSync(claudeDir)) {
		console.error("Error: ~/.claude directory not found.");
		console.error("Make sure Claude Code is installed first.\n");
		console.error(MANUAL_SETUP);
		process.exit(1);
	}

	// Install MCP server using claude CLI
	const mcpOk = installMcpServer();

	// Install skill
	let skillOk = false;
	const skillsDir = path.join(claudeDir, "skills");
	const skillFile = path.join(skillsDir, "prefer-infer.md");
	try {
		if (!fs.existsSync(skillsDir)) {
			fs.mkdirSync(skillsDir, { recursive: true });
		}

		if (fs.existsSync(skillFile)) {
			console.log("[ok] Skill already installed");
			skillOk = true;
		} else {
			fs.writeFileSync(skillFile, SKILL_CONTENT);
			console.log(
				"[ok] Installed skill to ~/.claude/skills/prefer-infer.md",
			);
			skillOk = true;
		}
	} catch (err) {
		console.error(
			`[error] Failed to install skill: ${(err as Error).message}`,
		);
	}

	if (mcpOk && skillOk) {
		console.log("\nSetup complete! Restart Claude Code to use prinfer.");
	} else {
		console.error("\nSome steps failed. Manual setup:\n");
		console.error(MANUAL_SETUP);
		process.exit(1);
	}
}

interface CliPositionOptions {
	mode: "position";
	file: string;
	line: number;
	column: number;
	includeDocs: boolean;
	project?: string;
}

interface CliNameOptions {
	mode: "name";
	file: string;
	name: string;
	line?: number;
	includeDocs: boolean;
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

	// Check for help flag
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		console.log(HELP);
		return null;
	}

	// Check for setup command
	if (args[0] === "setup") {
		runSetup();
		return null;
	}

	const positionArg = args[0];
	const parsed = parsePositionArg(positionArg);

	if (!parsed) {
		console.error(
			"Error: Argument must be in format <file>:<line>:<column> or <file>:<name> or <file>:<name>:<line>\n",
		);
		console.log(HELP);
		process.exit(1);
	}

	// Check for docs flag
	const includeDocs = args.includes("--docs") || args.includes("-d");

	// Find project option
	let project: string | undefined;
	const projectIdx = args.findIndex((a) => a === "--project" || a === "-p");
	if (projectIdx >= 0) {
		project = args[projectIdx + 1];
		if (!project) {
			console.error("Error: --project requires a path argument.\n");
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
			project,
		};
	}

	return {
		mode: "name",
		file: parsed.file,
		name: parsed.name,
		line: parsed.line,
		includeDocs,
		project,
	};
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
						project: options.project,
					})
				: hover(options.file, options.name, {
						include_docs: options.includeDocs,
						project: options.project,
						line: options.line,
					});

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
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
}

main();
