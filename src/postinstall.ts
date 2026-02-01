#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function main() {
	const homeDir = os.homedir();
	const claudeDir = path.join(homeDir, ".claude");

	if (!fs.existsSync(claudeDir)) {
		console.log(
			"~/.claude not found. Run 'prinfer setup' after installing Claude Code.",
		);
		return;
	}

	let success = true;

	// Install MCP server
	const configFile = path.join(claudeDir, "settings.json");
	try {
		let config: McpConfig = {};
		if (fs.existsSync(configFile)) {
			config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
		}

		if (!config.mcpServers?.prinfer) {
			config.mcpServers = config.mcpServers || {};
			config.mcpServers.prinfer = { command: "prinfer-mcp" };
			fs.writeFileSync(
				configFile,
				`${JSON.stringify(config, null, 2)}\n`,
			);
			console.log("[ok] Added MCP server to settings.json");
		}
	} catch (err) {
		console.error(`[error] MCP setup failed: ${(err as Error).message}`);
		success = false;
	}

	// Install skill
	const skillsDir = path.join(claudeDir, "skills");
	const skillFile = path.join(skillsDir, "prefer-infer.md");
	try {
		if (!fs.existsSync(skillsDir)) {
			fs.mkdirSync(skillsDir, { recursive: true });
		}

		if (!fs.existsSync(skillFile)) {
			fs.writeFileSync(skillFile, SKILL_CONTENT);
			console.log(
				"[ok] Installed skill to ~/.claude/skills/prefer-infer.md",
			);
		}
	} catch (err) {
		console.error(`[error] Skill setup failed: ${(err as Error).message}`);
		success = false;
	}

	if (!success) {
		console.error("\nSome steps failed. Run 'prinfer setup' for details.");
	}
}

main();
