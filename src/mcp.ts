#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { batchHover, hover } from "./index.js";

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

  hoverByName(file, name, line?, include_docs?, project?)
    Get TypeScript type information by symbol name.

  batch_hover(file, positions, include_docs?, project?)
    Get type info at multiple positions efficiently.

See also:
  prinfer --help    CLI for direct type inspection
`.trim();

function formatError(error: unknown): string {
	const err = error as Error;
	let text = `Error: ${err.message}`;
	if (err.cause instanceof Error) {
		text += `\n\nOriginal: ${err.cause.message}`;
	}
	return text;
}

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
				content: [{ type: "text", text: formatError(error) }],
				isError: true,
			};
		}
	},
);

server.tool(
	"hoverByName",
	"Get TypeScript type info by symbol name (avoids needing line:column)",
	{
		file: z.string().describe("Path to the TypeScript file"),
		name: z.string().describe("Symbol name to look up"),
		line: z
			.number()
			.optional()
			.describe("Optional line number to narrow search"),
		include_docs: z
			.boolean()
			.optional()
			.describe("Include JSDoc/TSDoc documentation"),
		project: z
			.string()
			.optional()
			.describe("Optional path to tsconfig.json"),
	},
	async ({ file, name, line, include_docs, project }) => {
		try {
			const result = hover(file, name, { include_docs, project, line });
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
				content: [{ type: "text", text: formatError(error) }],
				isError: true,
			};
		}
	},
);

server.tool(
	"batch_hover",
	"Get type info at multiple positions efficiently (loads program once)",
	{
		file: z.string().describe("Path to the TypeScript file"),
		positions: z
			.array(
				z.object({
					line: z.number().describe("1-based line number"),
					column: z.number().describe("1-based column number"),
				}),
			)
			.describe("Array of positions to look up"),
		include_docs: z
			.boolean()
			.optional()
			.describe("Include JSDoc/TSDoc documentation"),
		project: z
			.string()
			.optional()
			.describe("Optional path to tsconfig.json"),
	},
	async ({ file, positions, include_docs, project }) => {
		try {
			const result = batchHover(file, positions, {
				include_docs,
				project,
			});
			let text = `Batch hover results: ${result.successCount} succeeded, ${result.errorCount} failed\n`;

			for (const item of result.items) {
				text += `\n--- ${item.position.line}:${item.position.column} ---\n`;
				if (item.error) {
					text += `Error: ${item.error}\n`;
				} else if (item.result) {
					text += `Type: ${item.result.signature}\n`;
					if (item.result.returnType) {
						text += `Returns: ${item.result.returnType}\n`;
					}
					if (item.result.name) {
						text += `Name: ${item.result.name}\n`;
					}
					text += `Kind: ${item.result.kind}\n`;
					if (item.result.documentation) {
						text += `Documentation: ${item.result.documentation}\n`;
					}
				}
			}

			return { content: [{ type: "text", text }] };
		} catch (error) {
			return {
				content: [{ type: "text", text: formatError(error) }],
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
