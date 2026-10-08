#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { nearbyCandidates } from "./candidates.js";
import {
	annotationsSuccess,
	type BatchHoverSuccess,
	batchHoverSuccess,
	type ContractErrorResponse,
	completionSuccess,
	diagnosticsSuccess,
	hoverSuccess,
	type McpTool,
} from "./contract.js";
import { formatAnnotations, getFileAnnotations } from "./core/annotations.js";
import {
	formatCompletions,
	formatDiagnostics,
	getCompletions,
	resolveTextColumn,
} from "./core/index.js";
import { formatErrorText, reportError } from "./error-report.js";
import { assertSourceFile, PrinferError } from "./errors.js";
import { batchHover, diagnostics, hover } from "./index.js";
import {
	annotationsOutputSchema,
	batchHoverOutputSchema,
	compact,
	completionsOutputSchema,
	diagnosticsOutputSchema,
	hoverOutputSchema,
} from "./mcp-schemas.js";
import {
	closeNativeSessions,
	nativeDiagnostics,
	nativeHover,
	nativeHoverByName,
} from "./native-lsp.js";
import type { HoverOptions, HoverPosition, HoverResult } from "./types.js";

declare const __PRINFER_VERSION__: string | undefined;

/** Package version, injected by tsup at build time. */
const VERSION =
	typeof __PRINFER_VERSION__ === "string" ? __PRINFER_VERSION__ : "0.0.0-dev";

const HELP = `
prinfer-mcp ${VERSION} - MCP server for TypeScript type inference

This is a Model Context Protocol server designed to be launched by an MCP
client over stdio.

Setup:
  Run 'prinfer setup <codex|claude|cursor|vscode|gemini>' to register this
  server with a client. Without a global install: npx -y prinfer mcp

Provided tools:
  hover_by_name(file, name, line?, include_docs?, project?, backend?)
  hover(file, line, text? | column?, occurrence?, include_docs?, project?, backend?)
  batch_hover(positions, file?, include_docs?, project?, backend?)
  completions(file, line, column, prefix?, limit?, project?)
  diagnostics(file, include_suggestions?, project?, backend?)

Environment:
  PRINFER_BACKEND=typescript6   Backend for hover and diagnostics tools (default typescript7)
  PRINFER_INCLUDE_TIMING=1      Add type-resolution timing to every hover result

See also:
  prinfer --help    CLI: type lookups, completions, and prinfer check
`.trim();

type Backend = "typescript6" | "typescript7";
type BatchItem = BatchHoverSuccess["result"]["items"][number];

interface FailureContext {
	file?: string;
	project?: string;
	line?: number;
	column?: number;
	/** The name or text that failed to resolve; ranks candidates. */
	query?: string;
	/** Only suggest names close to query (name lookups). */
	strict?: boolean;
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

function displayPath(file: string): string {
	const relative = path.relative(process.cwd(), file);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
		? relative
		: file;
}

function itemLabel(item: BatchItem): string {
	const file = item.file ? `${displayPath(item.file)}:` : "";
	if (item.name !== undefined) {
		const line = item.position.line ? `:${item.position.line}` : "";
		return `${file}${item.name}${line}`;
	}
	const text =
		item.text !== undefined
			? ` text ${JSON.stringify(item.text)}${item.occurrence && item.occurrence > 1 ? ` #${item.occurrence}` : ""}`
			: "";
	return `${file}${item.position.line}:${item.position.column}${text}`;
}

function formatBatchHoverResult(result: BatchHoverSuccess["result"]): string {
	let text = `Batch hover results: ${result.successCount} succeeded, ${result.errorCount} failed\n`;
	for (const item of result.items) {
		text += `\n--- ${itemLabel(item)} ---\n`;
		if (item.error) {
			text += `${formatErrorText(item.error, { strict: item.name !== undefined })}\n`;
		} else if (item.result) {
			text += `${formatHoverResult(item.result as HoverResult)}\n`;
		}
	}
	return text;
}

/**
 * A failed tool call. The text repeats the candidates and suggestion from
 * structuredContent, because many clients show the model only the text.
 */
function errorResult(
	error: unknown,
	tool: McpTool,
	context: FailureContext = {},
) {
	const response = toolError(error, tool, context);
	return {
		content: [
			{
				type: "text" as const,
				text: formatErrorText(response.error, {
					strict: context.strict,
				}),
			},
		],
		structuredContent: response,
		isError: true,
	};
}

/** The contract error for a failed tool call, with tool-specific advice. */
function toolError(
	error: unknown,
	tool: McpTool,
	context: FailureContext = {},
): ContractErrorResponse {
	return reportError(error, {
		...context,
		surface: { interface: "mcp", tool },
	});
}

function useNative(backend?: Backend): boolean {
	return (
		(backend ?? process.env.PRINFER_BACKEND ?? "typescript7") ===
		"typescript7"
	);
}

/** Timing is a server-wide diagnostic switch rather than a per-call flag. */
function timingEnabled(): boolean {
	const value = process.env.PRINFER_INCLUDE_TIMING?.toLowerCase();
	return value === "1" || value === "true";
}

function readSource(file: string): string {
	return fs.readFileSync(assertSourceFile(file), "utf8");
}

function resolveColumn(
	file: string,
	line: number,
	column: number | undefined,
	text: string | undefined,
	occurrence: number | undefined,
	source?: string,
): number {
	if ((column === undefined) === (text === undefined)) {
		throw new PrinferError(
			"INVALID_ARGUMENT",
			"Pass exactly one of column or text to target a token on the line",
			"Pass text copied from the line (e.g. the identifier), or a 1-based column.",
		);
	}
	if (column !== undefined) return column;
	return resolveTextColumn(
		source ?? readSource(file),
		{ line, text: text as string, occurrence },
		path.resolve(process.cwd(), file),
	);
}

async function hoverAt(
	file: string,
	line: number,
	column: number,
	options: HoverOptions,
	backend?: Backend,
): Promise<HoverResult> {
	return useNative(backend)
		? nativeHover(file, line, column, options)
		: hover(file, line, column, options);
}

async function hoverNamed(
	file: string,
	name: string,
	line: number | undefined,
	options: HoverOptions,
	backend?: Backend,
): Promise<HoverResult> {
	return useNative(backend)
		? nativeHoverByName(file, name, { ...options, line })
		: hover(file, name, { ...options, line });
}

interface RawBatchItem {
	file?: string;
	line?: number;
	column?: number;
	text?: string;
	occurrence?: number;
	name?: string;
}

type BatchTarget =
	| { kind: "position"; line: number; column: number }
	| { kind: "text"; line: number; text: string; occurrence?: number }
	| { kind: "name"; name: string; line?: number };

interface PendingItem {
	index: number;
	file: string;
	target: BatchTarget;
}

function batchTarget(item: RawBatchItem): BatchTarget {
	if (item.name !== undefined) {
		if (item.column !== undefined || item.text !== undefined) {
			throw new PrinferError(
				"INVALID_ARGUMENT",
				"A batch item with name cannot also have column or text",
				"Use {name, line?}, {line, text, occurrence?}, or {line, column}.",
			);
		}
		return { kind: "name", name: item.name, line: item.line };
	}
	if (item.line === undefined) {
		throw new PrinferError(
			"INVALID_ARGUMENT",
			"A batch item needs line (with column or text) or name",
			"Use {name, line?}, {line, text, occurrence?}, or {line, column}.",
		);
	}
	if ((item.column === undefined) === (item.text === undefined)) {
		throw new PrinferError(
			"INVALID_ARGUMENT",
			"A batch item needs exactly one of column or text",
			"Use {line, text, occurrence?} or {line, column}.",
		);
	}
	return item.text !== undefined
		? {
				kind: "text",
				line: item.line,
				text: item.text,
				occurrence: item.occurrence,
			}
		: { kind: "position", line: item.line, column: item.column as number };
}

function echoTarget(
	file: string | undefined,
	item: RawBatchItem,
): Omit<BatchItem, "position" | "result" | "error"> {
	return {
		file,
		name: item.name,
		text: item.text,
		occurrence:
			item.text !== undefined ? (item.occurrence ?? 1) : undefined,
	};
}

/**
 * Hover every item, grouping by file so each program (TypeScript 6) or
 * document (TypeScript 7) is loaded once. Item failures stay per item.
 */
async function runBatchHover(
	rawItems: RawBatchItem[],
	defaults: { file?: string; project?: string; backend?: Backend },
	options: HoverOptions,
): Promise<BatchHoverSuccess["result"]> {
	const items: BatchItem[] = new Array(rawItems.length);
	const groups = new Map<string, PendingItem[]>();
	const { project, backend } = defaults;

	const fail = (
		pending: PendingItem | { index: number; file?: string },
		error: unknown,
		position: HoverPosition,
	) => {
		const raw = rawItems[pending.index] as RawBatchItem;
		items[pending.index] = {
			...echoTarget(pending.file, raw),
			position,
			error: toolError(
				error,
				"batch_hover",
				pending.file
					? {
							file: pending.file,
							project,
							...(position.column
								? position
								: { line: raw.line }),
							query: raw.name ?? raw.text,
							strict: raw.name !== undefined,
						}
					: { line: raw.line, column: raw.column, project },
			).error,
		};
	};

	rawItems.forEach((raw, index) => {
		const fileArg = raw.file ?? defaults.file;
		const fallbackPosition = {
			line: raw.line ?? 0,
			column: raw.column ?? 0,
		};
		if (!fileArg) {
			fail(
				{ index },
				new PrinferError(
					"INVALID_ARGUMENT",
					"No file for this batch item",
					"Set file on the item, or a top-level file shared by all items.",
				),
				fallbackPosition,
			);
			return;
		}
		const file = path.resolve(process.cwd(), fileArg);
		try {
			const target = batchTarget(raw);
			const group = groups.get(file) ?? [];
			group.push({ index, file, target });
			groups.set(file, group);
		} catch (error) {
			fail({ index, file }, error, fallbackPosition);
		}
	});

	const native = useNative(backend);
	for (const [file, group] of groups) {
		let source: string | undefined;
		try {
			source = readSource(file);
		} catch (error) {
			for (const pending of group) {
				fail(pending, error, positionOf(pending.target));
			}
			continue;
		}

		const positioned: Array<{
			pending: PendingItem;
			position: HoverPosition;
		}> = [];
		const named: PendingItem[] = [];
		for (const pending of group) {
			const { target } = pending;
			if (target.kind === "name") {
				named.push(pending);
				continue;
			}
			try {
				const column =
					target.kind === "text"
						? resolveColumn(
								file,
								target.line,
								undefined,
								target.text,
								target.occurrence,
								source,
							)
						: target.column;
				positioned.push({
					pending,
					position: { line: target.line, column },
				});
			} catch (error) {
				fail(pending, error, positionOf(target));
			}
		}

		const succeed = (
			pending: PendingItem,
			position: HoverPosition,
			result: HoverResult,
		) => {
			items[pending.index] = {
				...echoTarget(file, rawItems[pending.index] as RawBatchItem),
				position,
				result,
			};
		};

		const runNamed = async (pending: PendingItem): Promise<void> => {
			const target = pending.target as Extract<
				BatchTarget,
				{ kind: "name" }
			>;
			try {
				const result = await hoverNamed(
					file,
					target.name,
					target.line,
					options,
					backend,
				);
				succeed(
					pending,
					{ line: result.line, column: result.column },
					result,
				);
			} catch (error) {
				fail(pending, error, { line: target.line ?? 0, column: 0 });
			}
		};

		if (native) {
			await Promise.all([
				...positioned.map(async ({ pending, position }) => {
					try {
						succeed(
							pending,
							position,
							await nativeHover(
								file,
								position.line,
								position.column,
								options,
							),
						);
					} catch (error) {
						fail(pending, error, position);
					}
				}),
				...named.map((pending) => runNamed(pending)),
			]);
		} else {
			if (positioned.length > 0) {
				try {
					const batch = batchHover(
						file,
						positioned.map(({ position }) => position),
						options,
					);
					batch.items.forEach((item, i) => {
						const entry = positioned[i];
						if (!entry) return;
						if (item.result) {
							succeed(entry.pending, entry.position, item.result);
						} else {
							items[entry.pending.index] = {
								...echoTarget(
									file,
									rawItems[
										entry.pending.index
									] as RawBatchItem,
								),
								position: entry.position,
								error: {
									...item.error!,
									candidates:
										item.error?.candidates ??
										(item.error?.code === "SYMBOL_NOT_FOUND"
											? nearbyCandidates(file, {
													line: entry.position.line,
													query: rawItems[
														entry.pending.index
													]?.text,
												})
											: undefined),
								},
							};
						}
					});
				} catch (error) {
					for (const { pending, position } of positioned) {
						fail(pending, error, position);
					}
				}
			}
			for (const pending of named) await runNamed(pending);
		}
	}

	return {
		items,
		successCount: items.filter((item) => item.result).length,
		errorCount: items.filter((item) => item.error).length,
	};
}

function positionOf(target: BatchTarget): HoverPosition {
	if (target.kind === "position") {
		return { line: target.line, column: target.column };
	}
	return { line: target.line ?? 0, column: 0 };
}

const positiveInteger = z.int().min(1);
const MAX_BATCH_POSITIONS = 100;
const DEFAULT_COMPLETION_LIMIT = 50;
const MAX_COMPLETION_LIMIT = 500;

const fileSchema = z
	.string()
	.describe("TS/JS file: absolute, or relative to the server's cwd");
const PROJECT_DEFAULT =
	"tsconfig.json path; default: the nearest one above file";
const projectSchema = z
	.string()
	.optional()
	.describe(
		`${PROJECT_DEFAULT}. typescript7 accepts only that tsconfig or a project it references; use typescript6 for any other`,
	);
const includeDocsSchema = z
	.boolean()
	.optional()
	.describe("Also return JSDoc/TSDoc");
const backendSchema = z
	.enum(["typescript6", "typescript7"])
	.optional()
	.describe(
		"Default typescript7; retry with typescript6 if a call fails or a result looks wrong",
	);
const lineSchema = positiveInteger.describe("1-based line");
const textSchema = z
	.string()
	.min(1)
	.describe(
		'Token copied from the line, e.g. "useState"; hovers where it starts. Matches whole identifiers ("user" skips "users"), or any substring if the line has none. Use instead of column',
	);
const occurrenceSchema = positiveInteger
	.optional()
	.describe("Which match of text on the line (default 1)");
const columnSchema = positiveInteger.describe(
	"1-based column; alternative to text",
);
const nameSchema = z
	.string()
	.min(1)
	.describe('Symbol name, e.g. "createHandler"');

const INSTRUCTIONS = `prinfer shows the types TypeScript infers, as an editor hover would. Look a type up instead of guessing it, reading .d.ts files, or writing an annotation to find out.
- hover_by_name: you know the symbol's name. Start here.
- hover: a token without a unique name; pass its line and text copied from that line.
- batch_hover: several lookups, across files, in one call.
- completions: valid values at a cursor, e.g. string-literal union members.
- diagnostics: type errors in one file; run it on each file you edit.
If a call fails or looks wrong on the default TypeScript 7 backend, retry it with backend "typescript6".
Type regression tests: expect(inferredType(import.meta.url, { name })).toMatchInlineSnapshot(), with inferredType from prinfer/testing.`;

function createServer(): McpServer {
	const server = new McpServer(
		{ name: "prinfer", version: VERSION },
		{ instructions: INSTRUCTIONS },
	);

	server.registerTool(
		"hover_by_name",
		{
			description:
				"Show the type TypeScript infers for a named variable, function, call, parameter, property, or type. Use before writing a type annotation, when unsure what a generic or call resolves to, or instead of reading .d.ts files. Declarations win over other uses of the name; pass line to pick among repeats.",
			inputSchema: compact(
				z.object({
					file: fileSchema,
					name: nameSchema,
					line: positiveInteger
						.optional()
						.describe(
							"1-based line of the one you mean, when the name repeats",
						),
					include_docs: includeDocsSchema,
					project: projectSchema,
					backend: backendSchema,
				}),
			),
			outputSchema: hoverOutputSchema,
		},
		async ({ file, name, line, include_docs, project, backend }) => {
			try {
				assertSourceFile(file);
				const result = await hoverNamed(
					file,
					name,
					line,
					{ include_docs, include_timing: timingEnabled(), project },
					backend,
				);
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
				return errorResult(error, "hover_by_name", {
					file,
					project,
					line,
					query: name,
					strict: true,
				});
			}
		},
	);

	server.registerTool(
		"hover",
		{
			description:
				"Show the type TypeScript infers at a token on a line, like an editor hover; generic calls show their instantiated types. Use when hover_by_name can't name the token: callback parameters, expressions, repeated names. Target it with text copied from the line (or a column).",
			inputSchema: compact(
				z.object({
					file: fileSchema,
					line: lineSchema,
					text: textSchema.optional(),
					occurrence: occurrenceSchema,
					column: columnSchema.optional(),
					include_docs: includeDocsSchema,
					project: projectSchema,
					backend: backendSchema,
				}),
			),
			outputSchema: hoverOutputSchema,
		},
		async ({
			file,
			line,
			text,
			occurrence,
			column,
			include_docs,
			project,
			backend,
		}) => {
			let resolvedColumn = column;
			try {
				assertSourceFile(file);
				resolvedColumn = resolveColumn(
					file,
					line,
					column,
					text,
					occurrence,
				);
				const result = await hoverAt(
					file,
					line,
					resolvedColumn,
					{ include_docs, include_timing: timingEnabled(), project },
					backend,
				);
				let output = formatHoverResult(result);
				if (text !== undefined) {
					output += `\nTarget: ${JSON.stringify(text)} at ${line}:${resolvedColumn}`;
				}
				return {
					content: [{ type: "text" as const, text: output }],
					structuredContent: hoverSuccess({
						...result,
						position: { line, column: resolvedColumn },
					}),
				};
			} catch (error) {
				return errorResult(error, "hover", {
					file,
					project,
					line,
					column: resolvedColumn,
					query: text,
				});
			}
		},
	);

	server.registerTool(
		"batch_hover",
		{
			description: `Run up to ${MAX_BATCH_POSITIONS} hovers in one call, e.g. to check several inferred types after an edit. Each item is {name, line?}, {line, text, occurrence?}, or {line, column}, in its own file or the shared file. Failures are reported per item.`,
			inputSchema: compact(
				z.object({
					file: fileSchema
						.optional()
						.describe(
							"Default file for items without their own file",
						),
					positions: z
						.array(
							z.object({
								file: z
									.string()
									.optional()
									.describe(
										"This item's file, overriding the shared file",
									),
								name: nameSchema.optional(),
								line: positiveInteger
									.optional()
									.describe(
										"1-based line; required unless name is given",
									),
								text: textSchema.optional(),
								occurrence: occurrenceSchema,
								column: columnSchema.optional(),
							}),
						)
						.min(1)
						.max(MAX_BATCH_POSITIONS)
						.describe(`1-${MAX_BATCH_POSITIONS} lookups`),
					include_docs: includeDocsSchema,
					project: projectSchema,
					backend: backendSchema,
				}),
			),
			outputSchema: batchHoverOutputSchema,
		},
		async ({ file, positions, include_docs, project, backend }) => {
			try {
				const result = await runBatchHover(
					positions,
					{ file, project, backend },
					{ include_docs, include_timing: timingEnabled(), project },
				);
				return {
					content: [
						{ type: "text", text: formatBatchHoverResult(result) },
					],
					structuredContent: batchHoverSuccess(result),
				};
			} catch (error) {
				return errorResult(error, "batch_hover", { file, project });
			}
		},
	);

	server.registerTool(
		"completions",
		{
			description: `List the completions TypeScript offers at a cursor, including string-literal union members. Use to find valid values for an argument, property key, or import before writing it. Returns the best ${DEFAULT_COMPLETION_LIMIT} by default; pass prefix to narrow.`,
			inputSchema: compact(
				z.object({
					file: fileSchema,
					line: lineSchema,
					column: positiveInteger.describe(
						"1-based cursor column; the cursor sits before this character, e.g. just inside an opening quote",
					),
					prefix: z
						.string()
						.optional()
						.describe(
							'Keep names starting with this (case-insensitive). Default: the partial identifier or string text left of the cursor; "" lists all',
						),
					limit: positiveInteger
						.max(MAX_COMPLETION_LIMIT)
						.optional()
						.describe(
							`Max entries (default ${DEFAULT_COMPLETION_LIMIT}); locals and members rank first`,
						),
					project: z.string().optional().describe(PROJECT_DEFAULT),
				}),
			),
			outputSchema: completionsOutputSchema,
		},
		async ({ file, line, column, prefix, limit, project }) => {
			try {
				assertSourceFile(file);
				const result = getCompletions(file, line, column, project, {
					prefix,
					autoPrefix: true,
					limit: limit ?? DEFAULT_COMPLETION_LIMIT,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: formatCompletions(result),
						},
					],
					structuredContent: completionSuccess(result),
				};
			} catch (error) {
				return errorResult(error, "completions", {
					file,
					project,
					line,
					column,
				});
			}
		},
	);

	server.registerTool(
		"diagnostics",
		{
			description:
				"Check one TypeScript file for type errors, instead of running tsc on the whole project. Call it on each file you edit; the edit is done when none of them reports an error.",
			inputSchema: compact(
				z.object({
					file: fileSchema,
					project: projectSchema,
					include_suggestions: z
						.boolean()
						.optional()
						.describe(
							"Also report suggestions such as unused variables",
						),
					backend: backendSchema,
				}),
			),
			outputSchema: diagnosticsOutputSchema,
		},
		async ({ file, project, include_suggestions, backend }) => {
			try {
				assertSourceFile(file);
				const options = { project, include_suggestions };
				const result = useNative(backend)
					? await nativeDiagnostics(file, options)
					: diagnostics(file, options);
				return {
					content: [
						{
							type: "text" as const,
							text: formatDiagnostics(result, file),
						},
					],
					structuredContent: diagnosticsSuccess(result),
				};
			} catch (error) {
				return errorResult(error, "diagnostics", { file, project });
			}
		},
	);

	server.registerTool(
		"annotations",
		{
			description:
				"List type annotations in one file that TypeScript would infer anyway. Use when reviewing or cleaning up TypeScript, before adding annotations, or when asked to cut redundant types. redundant: deleting it keeps the exact type. widening: the annotation is wider than the inferred type, often an intended API contract.",
			inputSchema: compact(
				z.object({
					file: fileSchema,
					project: z.string().optional().describe(PROJECT_DEFAULT),
				}),
			),
			outputSchema: annotationsOutputSchema,
		},
		async ({ file, project }) => {
			try {
				assertSourceFile(file);
				const result = getFileAnnotations(file, project);
				return {
					content: [
						{
							type: "text" as const,
							text: formatAnnotations(result, file),
						},
					],
					structuredContent: annotationsSuccess(result),
				};
			} catch (error) {
				return errorResult(error, "annotations", { file, project });
			}
		},
	);

	return server;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(HELP);
} else {
	serveStdio(createServer);
	// The warm TypeScript 7 language servers keep the event loop alive, so
	// exit explicitly once the client disconnects instead of lingering.
	const shutdown = () => {
		closeNativeSessions();
		process.exit(0);
	};
	process.stdin.once("end", shutdown);
	process.stdin.once("close", shutdown);
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}
