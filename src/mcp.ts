#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
	batchHoverSuccess,
	batchHoverSuccessSchema,
	contractError,
	contractErrorResponseSchema,
	hoverSuccess,
	hoverSuccessSchema,
} from "./contract.js";
import { findNearestTsconfig } from "./core/index.js";
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
  hover(file, line, column, include_docs?, include_timing?, project?)
  hover_by_name(file, name, line?, include_docs?, include_timing?, project?)
  batch_hover(file, positions, include_docs?, include_timing?, project?)

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
	if (result.timing) {
		text += `\nType resolution: ${result.timing.resolution_ms} ms`;
	}
	return text;
}

function formatBatchHoverResult(result: BatchHoverResult): string {
	let text = `Batch hover results: ${result.successCount} succeeded, ${result.errorCount} failed\n`;
	for (const item of result.items) {
		text += `\n--- ${item.position.line}:${item.position.column} ---\n`;
		if (item.error) {
			text += `Error [${item.error.code}]: ${item.error.message}\n`;
			if (item.error.suggestion)
				text += `Suggestion: ${item.error.suggestion}\n`;
		} else if (item.result) {
			text += `${formatHoverResult(item.result)}\n`;
		}
	}
	return text;
}
function errorResult(
	error: unknown,
	context: {
		file?: string;
		line?: number;
		column?: number;
		project?: string;
		candidates?: string[];
	} = {},
) {
	const response = contractError(error, context);
	return {
		content: [{ type: "text" as const, text: formatError(error) }],
		structuredContent: response,
		isError: true,
	};
}

function errorContext(
	file: string,
	project?: string,
	position: { line?: number; column?: number } = {},
	name?: string,
) {
	const resolvedFile = path.resolve(process.cwd(), file);
	const resolvedProject = project
		? path.resolve(process.cwd(), project)
		: findNearestTsconfig(path.dirname(resolvedFile));
	return {
		file: resolvedFile,
		project: resolvedProject,
		...position,
		candidates: nearbyCandidates(resolvedFile, position.line, name),
	};
}

function nearbyCandidates(
	file: string,
	line?: number,
	name?: string,
): string[] | undefined {
	if (!fs.existsSync(file)) return undefined;
	const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
	const text = line
		? lines.slice(Math.max(0, line - 3), line + 2).join("\n")
		: lines.join("\n");
	const identifiers = [...new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? [])];
	const ranked = name
		? identifiers.sort(
				(left, right) =>
					nameDistance(left, name) - nameDistance(right, name),
			)
		: identifiers;
	const candidates = ranked
		.filter((candidate) => candidate !== name)
		.slice(0, 5);
	return candidates.length ? candidates : undefined;
}

function nameDistance(left: string, right: string): number {
	const a = left.toLowerCase();
	const b = right.toLowerCase();
	const row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0] ?? 0;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const current = row[j] ?? 0;
			row[j] = Math.min(
				(row[j] ?? 0) + 1,
				(row[j - 1] ?? 0) + 1,
				previous + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			previous = current;
		}
	}
	return row[b.length] ?? Number.MAX_SAFE_INTEGER;
}

const toolOutputSchema = z.union([
	hoverSuccessSchema,
	contractErrorResponseSchema,
]);

const batchToolOutputSchema = z.union([
	batchHoverSuccessSchema,
	contractErrorResponseSchema,
]);

const positiveInteger = z.number().int().positive();
const MAX_BATCH_POSITIONS = 100;

const backendSchema = z
	.enum(["typescript6", "typescript7"])
	.optional()
	.describe(
		"Inference backend; TypeScript 7 uses the experimental native LSP",
	);

function useNative(backend?: "typescript6" | "typescript7"): boolean {
	return (
		(backend ?? process.env.PRINFER_BACKEND ?? "typescript7") ===
		"typescript7"
	);
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
				return {
					position,
					error: contractError(
						error,
						errorContext(file, options.project, position),
					).error,
				};
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
				"Use prinfer to inspect TypeScript's inferred types before adding explicit annotations. Prefer hover for a known position, hover_by_name for a known symbol, and batch_hover for multiple positions in one file. TypeScript 7 is the default backend; retry with backend typescript6 if the experimental backend fails.",
		},
	);

	server.registerTool(
		"hover",
		{
			description:
				"Get TypeScript type information at a specific position in a file.",
			inputSchema: z.object({
				file: z.string().describe("Path to the TypeScript file"),
				line: positiveInteger.describe("1-based line number"),
				column: positiveInteger.describe("1-based column number"),
				include_docs: z
					.boolean()
					.optional()
					.describe("Include JSDoc/TSDoc documentation"),
				include_timing: z
					.boolean()
					.optional()
					.describe(
						"Include the hovered symbol's type-resolution time",
					),
				project: z
					.string()
					.optional()
					.describe("Optional path to tsconfig.json"),
				backend: backendSchema,
			}),
			outputSchema: toolOutputSchema,
		},
		async ({
			file,
			line,
			column,
			include_docs,
			include_timing,
			project,
			backend,
		}) => {
			try {
				const result = useNative(backend)
					? await nativeHover(file, line, column, {
							include_docs,
							include_timing,
							project,
						})
					: hover(file, line, column, {
							include_docs,
							include_timing,
							project,
						});
				return {
					content: [
						{
							type: "text" as const,
							text: formatHoverResult(result),
						},
					],
					structuredContent: hoverSuccess(result),
				};
			} catch (error) {
				return errorResult(
					error,
					errorContext(file, project, { line, column }),
				);
			}
		},
	);

	const hoverByNameInputSchema = z.object({
		file: z.string().describe("Path to the TypeScript file"),
		name: z.string().describe("Symbol name to look up"),
		line: positiveInteger
			.optional()
			.describe("Optional line number to narrow search"),
		include_docs: z
			.boolean()
			.optional()
			.describe("Include JSDoc/TSDoc documentation"),
		include_timing: z
			.boolean()
			.optional()
			.describe("Include the hovered symbol's type-resolution time"),
		project: z
			.string()
			.optional()
			.describe("Optional path to tsconfig.json"),
		backend: backendSchema,
	});
	const hoverByNameHandler = async ({
		file,
		name,
		line,
		include_docs,
		include_timing,
		project,
		backend,
	}: {
		file: string;
		name: string;
		line?: number;
		include_docs?: boolean;
		include_timing?: boolean;
		project?: string;
		backend?: "typescript6" | "typescript7";
	}) => {
		try {
			const result = useNative(backend)
				? await nativeHoverByName(file, name, {
						include_docs,
						include_timing,
						line,
						project,
					})
				: hover(file, name, {
						include_docs,
						include_timing,
						line,
						project,
					});
			return {
				content: [
					{ type: "text" as const, text: formatHoverResult(result) },
				],
				structuredContent: hoverSuccess(result),
			};
		} catch (error) {
			return errorResult(
				error,
				errorContext(file, project, { line }, name),
			);
		}
	};

	server.registerTool(
		"hover_by_name",
		{
			description:
				"Get TypeScript type info by symbol name (avoids needing line:column).",
			inputSchema: hoverByNameInputSchema.shape,
			outputSchema: toolOutputSchema,
		},
		hoverByNameHandler,
	);

	server.registerTool(
		"hoverByName",
		{
			description:
				"Deprecated alias for hover_by_name. Use hover_by_name for new integrations.",
			inputSchema: hoverByNameInputSchema.shape,
			outputSchema: toolOutputSchema,
		},
		hoverByNameHandler,
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
							line: positiveInteger.describe(
								"1-based line number",
							),
							column: z
								.number()
								.int()
								.positive()
								.describe("1-based column number"),
						}),
					)
					.min(1)
					.max(MAX_BATCH_POSITIONS)
					.describe(`1-${MAX_BATCH_POSITIONS} positions to look up`),
				include_docs: z
					.boolean()
					.optional()
					.describe("Include JSDoc/TSDoc documentation"),
				include_timing: z
					.boolean()
					.optional()
					.describe(
						"Include type-resolution time on each successful item",
					),
				project: z
					.string()
					.optional()
					.describe("Optional path to tsconfig.json"),
				backend: backendSchema,
			}),
			outputSchema: batchToolOutputSchema,
		},
		async ({
			file,
			positions,
			include_docs,
			include_timing,
			project,
			backend,
		}) => {
			try {
				const result = useNative(backend)
					? await nativeBatchHover(file, positions, {
							include_docs,
							include_timing,
							project,
						})
					: batchHover(file, positions, {
							include_docs,
							include_timing,
							project,
						});
				return {
					content: [
						{ type: "text", text: formatBatchHoverResult(result) },
					],
					structuredContent: batchHoverSuccess(result),
				};
			} catch (error) {
				return errorResult(error, errorContext(file, project));
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
