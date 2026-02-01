#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { inferType } from "./index.js";

const HELP = `
prinfer-mcp - MCP server for TypeScript type inference

This is an MCP (Model Context Protocol) server. It's designed to be run
by Claude Code, not directly from the command line.

Setup:
  Run 'prinfer setup' to configure Claude Code automatically.

Manual setup:
  Add to ~/.claude/settings.json:

  {
    "mcpServers": {
      "prinfer": {
        "command": "prinfer-mcp"
      }
    }
  }

Provided tools:
  infer_type(file, name, line?, project?)
    Infer the TypeScript type of a function or variable.

See also:
  prinfer --help    CLI for direct type inspection
`.trim();

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(HELP);
	process.exit(0);
}

const server = new McpServer({
	name: "prinfer",
	version: "0.2.1",
});

server.tool(
	"infer_type",
	"Infer the TypeScript type of a function or variable in a file. Returns the type signature and optionally the return type for functions.",
	{
		file: z.string().describe("Path to the TypeScript file"),
		name: z
			.string()
			.describe("Name of the function or variable to inspect"),
		line: z
			.number()
			.optional()
			.describe("Optional line number to narrow search (1-based)"),
		project: z
			.string()
			.optional()
			.describe("Optional path to tsconfig.json"),
	},
	async ({ file, name, line, project }) => {
		try {
			const result = inferType(file, name, { line, project });
			let text = `Type: ${result.signature}`;
			if (result.returnType) {
				text += `\nReturns: ${result.returnType}`;
			}
			if (result.line) {
				text += `\nLine: ${result.line}`;
			}
			return { content: [{ type: "text", text }] };
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `Error: ${(error as Error).message}`,
					},
				],
				isError: true,
			};
		}
	},
);

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch(console.error);
