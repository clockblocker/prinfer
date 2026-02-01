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
  prinfer setup

Commands:
  setup                Install MCP server and skill for Claude Code

Arguments:
  file.ts:line:column  Path to TypeScript file with 1-based line and column

Options:
  --docs, -d           Include JSDoc/TSDoc documentation
  --project, -p        Path to tsconfig.json (optional)
  --help, -h           Show this help message

Examples:
  prinfer src/utils.ts:75:10
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

### /check-type

Check the inferred type at a specific position in a TypeScript file.

Usage: \`/check-type <file>:<line>:<column>\`

Examples:
- \`/check-type src/utils.ts:75:10\`
- \`/check-type src/utils.ts:42:5\`

<command-name>check-type</command-name>

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

interface CliOptions {
	file: string;
	line: number;
	column: number;
	includeDocs: boolean;
	project?: string;
}

function parsePositionArg(
	arg: string,
): { file: string; line: number; column: number } | null {
	// Match pattern: file.ts:line:column
	const match = arg.match(/^(.+):(\d+):(\d+)$/);
	if (match) {
		return {
			file: match[1],
			line: Number.parseInt(match[2], 10),
			column: Number.parseInt(match[3], 10),
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
			"Error: Position argument must be in format <file>:<line>:<column>\n",
		);
		console.log(HELP);
		process.exit(1);
	}

	const { file, line, column } = parsed;

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

	return { file, line, column, includeDocs, project };
}

function main(): void {
	const options = parseArgs(process.argv);

	if (!options) {
		process.exit(0);
	}

	try {
		const result = hover(options.file, options.line, options.column, {
			include_docs: options.includeDocs,
			project: options.project,
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
