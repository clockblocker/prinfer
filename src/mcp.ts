#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { hover } from "./index.js";

const HELP = `
prinfer-mcp - MCP server for TypeScript type inference

This is an MCP (Model Context Protocol) server. It's designed to be run
by Claude Code, not directly from the command line.

Setup:
  Run 'prinfer setup' to configure Claude Code automatically.

Manual setup:
  Run: claude mcp add prinfer node /path/to/prinfer-mcp

Provided tools:
  hover(file, line, column, include_docs?, project?)
    Get TypeScript type information at a specific position.

See also:
  prinfer --help    CLI for direct type inspection
`.trim();

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(HELP);
	process.exit(0);
}

const server = new McpServer({
	name: "prinfer",
	version: "0.3.0",
});

server.tool(
	"hover",
	"Get TypeScript type information at a specific position in a file. Returns the type signature, return type, documentation, and symbol kind.",
	{
		file: z.string().describe("Path to the TypeScript file"),
		line: z.number().describe("1-based line number"),
		column: z.number().describe("1-based column (character position)"),
		include_docs: z
			.boolean()
			.optional()
			.describe("Include JSDoc/TSDoc documentation"),
		project: z
			.string()
			.optional()
			.describe("Optional path to tsconfig.json"),
	},
	async ({ file, line, column, include_docs, project }) => {
		try {
			const result = hover(file, line, column, { include_docs, project });
			let text = `Type: ${result.signature}`;
			if (result.returnType) {
				text += `\nReturns: ${result.returnType}`;
			}
			if (result.name) {
				text += `\nName: ${result.name}`;
			}
			text += `\nKind: ${result.kind}`;
			text += `\nPosition: ${result.line}:${result.column}`;
			if (result.documentation) {
				text += `\nDocumentation: ${result.documentation}`;
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
