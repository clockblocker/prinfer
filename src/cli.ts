#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferType } from "./index.js";

const HELP = `
prinfer - TypeScript type inference inspection tool

Usage:
  prinfer <file.ts>[:<line>] <name> [--project <tsconfig.json>]
  prinfer setup

Commands:
  setup                Install MCP server and skill for Claude Code

Arguments:
  file.ts              Path to the TypeScript file
  :line                Optional line number to narrow search (e.g., file.ts:75)
  name                 Name of the function/variable to inspect

Options:
  --project, -p        Path to tsconfig.json (optional)
  --help, -h           Show this help message

Examples:
  prinfer src/utils.ts myFunction
  prinfer src/utils.ts:75 commandResult
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

Use the \`prinfer\` MCP tool (\`infer_type\`) to verify what TypeScript infers before adding explicit types.

## Commands

### /check-type

Check the inferred type of a TypeScript symbol.

Usage: \`/check-type <file>:<line> <name>\` or \`/check-type <file> <name>\`

Examples:
- \`/check-type src/utils.ts:75 commandResult\`
- \`/check-type src/utils.ts myFunction\`

<command-name>check-type</command-name>

Use the \`infer_type\` MCP tool to check the type:
1. Parse the arguments to extract file, optional line number, and symbol name
2. Call \`infer_type(file, name, line?)\`
3. Report the inferred signature and return type
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
	name: string;
	line?: number;
	project?: string;
}

function parseFileArg(arg: string): { file: string; line?: number } {
	// Match pattern: file.ts:123 or just file.ts
	const match = arg.match(/^(.+):(\d+)$/);
	if (match) {
		return { file: match[1], line: Number.parseInt(match[2], 10) };
	}
	return { file: arg };
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

	const fileArg = args[0];
	const name = args[1];

	if (!fileArg || !name) {
		console.error(
			"Error: Both <file> and <name> arguments are required.\n",
		);
		console.log(HELP);
		process.exit(1);
	}

	const { file, line } = parseFileArg(fileArg);

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

	return { file, name, line, project };
}

function main(): void {
	const options = parseArgs(process.argv);

	if (!options) {
		process.exit(0);
	}

	try {
		const result = inferType(options.file, options.name, {
			line: options.line,
			project: options.project,
		});

		console.log(result.signature);
		if (result.returnType) {
			console.log("returns:", result.returnType);
		}
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
}

main();
