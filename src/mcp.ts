#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
	batchHoverSuccess,
	batchHoverSuccessSchema,
	hoverSuccess,
	hoverSuccessSchema,
} from "./contract.js";
import { batchHover, hover } from "./index.js";
import { nativeHover, nativeHoverByName } from "./native-lsp.js";
import type {
	BatchHoverResult,
	HoverOptions,
	HoverPosition,
	HoverResult,
} from "./types.js";

const HELP = `
prinfer-mcp - MCP server for TypeScript type inference

This is a Model Context Protocol server designed to be launched by an MCP
client over stdio.

Setup:
  Run 'prinfer setup codex' to configure Codex automatically.

Provided tools:
  hover(file, line, column, include_docs?, project?)
  hoverByName(file, name, line?, include_docs?, project?)
  batch_hover(file, positions, include_docs?, project?)

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

function formatHoverResult(result: HoverResult): string {
	let text = `Type: ${result.signature}`;
	if (result.returnType) text += `\nReturns: ${result.returnType}`;
	if (result.name) text += `\nName: ${result.name}`;
	text += `\nKind: ${result.kind}`;
	text += `\nPosition: ${result.line}:${result.column}`;
	if (result.documentation) {
		text += `\nDocumentation: ${result.documentation}`;
	}
	return text;
}

function formatBatchHoverResult(result: BatchHoverResult): string {
	let text = `Batch hover results: ${result.successCount} succeeded, ${result.errorCount} failed\n`;
	for (const item of result.items) {
		text += `\n--- ${item.position.line}:${item.position.column} ---\n`;
		if (item.error) {
			text += `Error: ${item.error}\n`;
		} else if (item.result) {
			text += `${formatHoverResult(item.result)}\n`;
		}
	}
	return text;
}

function errorResult(error: unknown) {
	return {
		content: [{ type: "text" as const, text: formatError(error) }],
		isError: true,
	};
}

const backendSchema = z
	.enum(["typescript6", "typescript7"])
	.optional()
	.describe("Inference backend; TypeScript 7 uses the experimental native LSP");

function useNative(backend?: "typescript6" | "typescript7"): boolean {
	return (backend ?? process.env.PRINFER_BACKEND ?? "typescript7") === "typescript7";
}

async function nativeBatchHover(
	file: string,
	positions: HoverPosition[],
	options: HoverOptions,
): Promise<BatchHoverResult> {
	const items = await Promise.all(
		positions.map(async (position) => {
			try {
				return {
					position,
					result: await nativeHover(
						file,
						position.line,
						position.column,
						options,
					),
				};
			} catch (error) {
				return { position, error: (error as Error).message };
			}
		}),
	);
	return {
		items,
		successCount: items.filter((item) => item.result).length,
		errorCount: items.filter((item) => item.error).length,
	};
}

function createServer(): McpServer {
	const server = new McpServer(
		{ name: "prinfer", version: "1.0.0" },
		{
			instructions:
				"Use prinfer to inspect TypeScript's inferred types before adding explicit annotations. Prefer hover for a known position, hoverByName for a known symbol, and batch_hover for multiple positions in one file.",
		},
	);

	server.registerTool(
		"hover",
		{
			description:
				"Get TypeScript type information at a specific position in a file.",
			inputSchema: z.object({
				file: z.string().describe("Path to the TypeScript file"),
				line: z.number().describe("1-based line number"),
				column: z.number().describe("1-based column number"),
				include_docs: z
					.boolean()
					.optional()
					.describe("Include JSDoc/TSDoc documentation"),
				project: z
					.string()
					.optional()
					.describe("Optional path to tsconfig.json"),
				backend: backendSchema,
			}),
			outputSchema: hoverSuccessSchema,
		},
		async ({ file, line, column, include_docs, project, backend }) => {
			try {
				const result = useNative(backend)
					? await nativeHover(file, line, column, { include_docs, project })
					: hover(file, line, column, { include_docs, project });
				return {
					content: [{ type: "text", text: formatHoverResult(result) }],
					structuredContent: hoverSuccess(result),
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"hoverByName",
		{
			description:
				"Get TypeScript type info by symbol name (avoids needing line:column).",
			inputSchema: z.object({
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
				backend: backendSchema,
			}),
			outputSchema: hoverSuccessSchema,
		},
		async ({ file, name, line, include_docs, project, backend }) => {
			try {
				const result = useNative(backend)
					? await nativeHoverByName(file, name, { include_docs, line, project })
					: hover(file, name, { include_docs, line, project });
				return {
					content: [{ type: "text", text: formatHoverResult(result) }],
					structuredContent: hoverSuccess(result),
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"batch_hover",
		{
			description:
				"Get type info at multiple positions efficiently (loads program once).",
			inputSchema: z.object({
				file: z.string().describe("Path to the TypeScript file"),
				positions: z
					.array(
						z.object({
							line: z.number().describe("1-based line number"),
							column: z
								.number()
								.describe("1-based column number"),
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
				backend: backendSchema,
			}),
			outputSchema: batchHoverSuccessSchema,
		},
		async ({ file, positions, include_docs, project, backend }) => {
			try {
				const result = useNative(backend)
					? await nativeBatchHover(file, positions, { include_docs, project })
					: batchHover(file, positions, { include_docs, project });
				return {
					content: [
						{ type: "text", text: formatBatchHoverResult(result) },
					],
					structuredContent: batchHoverSuccess(result),
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	return server;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(HELP);
} else {
	serveStdio(createServer);
}
