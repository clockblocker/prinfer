#!/usr/bin/env node
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

1. Add MCP server to ~/.claude/claude_desktop_config.json:

   {
     "mcpServers": {
       "prinfer": {
         "command": "prinfer-mcp"
       }
     }
   }

2. Create skill file at ~/.claude/skills/prefer-infer.md:

   See https://github.com/clockblocker/prinfer for skill content.
`.trim();

interface McpConfig {
	mcpServers?: Record<string, { command: string; args?: string[] }>;
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

	let mcpOk = false;
	let skillOk = false;

	// Install MCP server
	const configFile = path.join(claudeDir, "claude_desktop_config.json");
	try {
		let config: McpConfig = {};
		if (fs.existsSync(configFile)) {
			config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
		}

		if (config.mcpServers?.prinfer) {
			console.log("[ok] MCP server already configured");
			mcpOk = true;
		} else {
			config.mcpServers = config.mcpServers || {};
			config.mcpServers.prinfer = { command: "prinfer-mcp" };
			fs.writeFileSync(
				configFile,
				`${JSON.stringify(config, null, 2)}\n`,
			);
			console.log("[ok] Added MCP server to claude_desktop_config.json");
			mcpOk = true;
		}
	} catch (err) {
		console.error(
			`[error] Failed to configure MCP server: ${(err as Error).message}`,
		);
	}

	// Install skill
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
