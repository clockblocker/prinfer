#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
	const skillsDir = path.join(homeDir, ".claude", "skills");
	const skillFile = path.join(skillsDir, "prinfer.md");

	// Check if ~/.claude exists
	const claudeDir = path.join(homeDir, ".claude");
	if (!fs.existsSync(claudeDir)) {
		console.log(
			"~/.claude directory not found. Skipping skill installation.",
		);
		console.log("To manually install, create ~/.claude/skills/prinfer.md");
		return;
	}

	// Create skills directory if it doesn't exist
	if (!fs.existsSync(skillsDir)) {
		fs.mkdirSync(skillsDir, { recursive: true });
	}

	// Check if skill already exists
	if (fs.existsSync(skillFile)) {
		console.log(
			"prinfer skill already installed at ~/.claude/skills/prinfer.md",
		);
		return;
	}

	// Write the skill file
	fs.writeFileSync(skillFile, SKILL_CONTENT);
	console.log("Installed prinfer skill to ~/.claude/skills/prinfer.md");
	console.log("You can now use /check-type to verify TypeScript types!");
}

main();
