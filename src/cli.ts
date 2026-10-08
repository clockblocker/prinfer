#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	type ParsedTarget,
	parseFlags,
	parseTargetArg,
	shellHint,
} from "./cli-args.js";
import {
	annotationsSuccess,
	type CliCommand,
	completionSuccess,
	contractError,
	diagnosticsSuccess,
	hoverSuccess,
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
import { DEFAULT_MAX_CHARS, formatHoverText } from "./hover-format.js";
import { diagnostics, hover } from "./index.js";
import { runSetup } from "./setup.js";
import type { DiagnosticsResult, HoverOptions, HoverResult } from "./types.js";

const HELP = `
prinfer - TypeScript type inference inspection tool

Usage:
  prinfer <file>:<name>[:<line>] [options]
  prinfer <file>:<line>:<text> [options]
  prinfer <file>:<line> --text <text> [--occurrence <n>] [options]
  prinfer <file>:<line>:<column> [options]
  prinfer complete <file>:<line>:<text|column> [--prefix <text>] [--limit <n>] [--json] [--project <tsconfig.json>]
  prinfer check <file> [--suggestions] [--json] [--project <tsconfig.json>] [--backend <typescript6|typescript7>]
  prinfer annotations <file> [--json] [--project <tsconfig.json>]
  prinfer mcp
  prinfer setup <codex|claude|cursor|vscode|gemini> [--scope <scope>] [--npx] [--print]
  prinfer setup agents-md [--file <path>] [--print]

Commands:
  complete             Show TypeScript autocomplete entries at a cursor (top 50 by
                       default). Always TypeScript 6
  check                Report type errors in one file; exits 1 when it has errors
  annotations          List type annotations TypeScript would infer anyway
                       (redundant) or that are wider than the inferred type
                       (widening); exits 0 unless the check itself fails.
                       Always TypeScript 6
  mcp                  Start the MCP server on stdio (same as prinfer-mcp)
  setup <client>       Register the MCP server with an agent client
  setup agents-md      Add prinfer usage instructions to AGENTS.md or CLAUDE.md

Targets (lines and columns are 1-based):
  <file>:<name>           A declaration by name (any JavaScript identifier)
  <file>:<name>:<line>    The same, choosing among repeated names by line. On
                          a line that uses the name (box.value), the type
                          there, narrowed by the surrounding code
  <file>:<line>:<text>    The token where text starts on that line; whole
                          identifiers match first ("user" skips "users").
                          complete puts the cursor right after the text
  <file>:<line>:<column>  A position; an all-digit text reads as a column,
                          so pass such text with --text
  Single-quote targets that contain $ or spaces: 'src/store.ts:$store'

Options:
  --text <text>        Target text on <file>:<line>, instead of a :<text> suffix
  --occurrence <n>     Which match of the text on the line (default 1)
  --docs, -d           Include JSDoc/TSDoc documentation
  --timing, -t         Include type-resolution timing
  --full, -f           Disable TypeScript's type truncation ("... 12 more ...")
  --max-chars <n>      Print at most n characters of type text (default ${DEFAULT_MAX_CHARS};
                       0 for no limit). Applies to text output; --json is never cut
  --suggestions        check: also report suggestions such as unused variables
  --prefix <text>      complete: keep names starting with text (case-insensitive);
                       default: the partial identifier left of the cursor; "" for all
  --limit <n>          complete: at most n entries (default 50)
  --json               Emit the versioned JSON contract on stdout
  --project, -p <path> Path to tsconfig.json (default: the nearest one above the file)
  --backend <name>     typescript6 (default) or typescript7, for type lookups and
                       check; complete and annotations always use typescript6
  --help, -h           Show this help message (prinfer setup --help for setup options)

Examples:
  prinfer src/utils.ts:createHandler --json
  prinfer src/utils.ts:createHandler:75
  prinfer src/utils.ts:75:user --docs
  prinfer src/utils.ts:75 --text user --occurrence 2
  prinfer src/utils.ts:75:10
  prinfer complete src/utils.ts:75:user.
  prinfer complete src/utils.ts:75:10 --prefix use --limit 20
  prinfer check src/utils.ts --json
  prinfer annotations src/utils.ts
  prinfer src/utils.ts:createHandler --backend typescript7
  prinfer setup claude
  prinfer setup cursor --scope project --print
  prinfer setup agents-md --file CLAUDE.md
  npx -y prinfer mcp
`.trim();

/**
 * Starts the MCP stdio server from the sibling build output (dist/mcp.js) in
 * this process, so `npx -y prinfer mcp` works without a second bin name.
 */
async function startMcpServer(): Promise<void> {
	const script = fs.realpathSync(process.argv[1]);
	const dir = path.dirname(script);
	const entry = [`mcp${path.extname(script)}`, "mcp.js"]
		.map((name) => path.join(dir, name))
		.find((candidate) => fs.existsSync(candidate));
	if (!entry) {
		console.error(`Error: prinfer MCP server not found next to ${script}`);
		process.exit(1);
	}
	await import(pathToFileURL(entry).href);
}

type Backend = "typescript6" | "typescript7";

/** A hover target after flags such as --text are applied. */
type HoverTarget =
	| { kind: "position"; line: number; column: number }
	| { kind: "text"; line: number; text: string; occurrence?: number }
	| { kind: "name"; name: string; line?: number };

type TextTarget = Extract<HoverTarget, { kind: "text" }>;

interface CliHoverOptions {
	mode: "hover";
	/** The target argument as received, echoed in errors. */
	arg: string;
	file: string;
	target: HoverTarget;
	includeDocs: boolean;
	includeTiming: boolean;
	full: boolean;
	maxChars: number;
	json: boolean;
	project?: string;
	backend: Backend;
}

interface CliCompletionOptions {
	mode: "completion";
	arg: string;
	file: string;
	target: Exclude<HoverTarget, { kind: "name" }>;
	prefix?: string;
	limit: number;
	json: boolean;
	project?: string;
}

type CliOptions = CliHoverOptions | CliCompletionOptions;

const DEFAULT_COMPLETION_LIMIT = 50;
const HELP_POINTER = "Run prinfer --help for all options.";
const ANNOTATIONS_USAGE =
	"Usage: prinfer annotations <file> [--json] [--project <tsconfig.json>]";
const CHECK_USAGE =
	"Usage: prinfer check <file> [--suggestions] [--json] [--project <tsconfig.json>] [--backend <typescript6|typescript7>]";

const HOVER_KEYS = new Set([
	"docs",
	"timing",
	"full",
	"json",
	"text",
	"occurrence",
	"maxChars",
	"project",
	"backend",
]);
const CHECK_KEYS = new Set(["json", "project", "backend", "suggestions"]);
const ANNOTATIONS_KEYS = new Set(["json", "project"]);
const COMPLETE_KEYS = new Set([
	"json",
	"text",
	"occurrence",
	"project",
	"backend",
	"prefix",
	"limit",
]);

const HOVER_FORMS = [
	"Accepted forms:",
	"  <file>:<name>[:<line>]   src/a.ts:createHandler, src/a.ts:createHandler:75",
	"  <file>:<line>:<text>     src/a.ts:75:user (or src/a.ts:75 --text user)",
	"  <file>:<line>:<column>   src/a.ts:75:10",
];
const HOVER_FORMS_SUGGESTION =
	"Use <file>:<name>, <file>:<name>:<line>, <file>:<line>:<text>, <file>:<line> --text <text>, or <file>:<line>:<column>.";
const COMPLETE_FORMS = [
	"Accepted forms:",
	"  <file>:<line>:<text>     cursor right after the text: src/a.ts:75:user.",
	"  <file>:<line> --text <t> the same, for text that is all digits",
	"  <file>:<line>:<column>   cursor before that column: src/a.ts:75:10",
];
const COMPLETE_FORMS_SUGGESTION =
	"Use <file>:<line>:<text> (cursor after the text), <file>:<line> --text <text>, or <file>:<line>:<column>.";

/**
 * A malformed command line: the JSON contract on stdout with --json,
 * otherwise a short message on stderr (never the whole help). Exits 1.
 */
function usageError(
	message: string,
	options: {
		command: CliCommand;
		json: boolean;
		/** Extra lines for text output, e.g. the accepted forms. */
		details?: string[];
		/** The JSON suggestion that stands in for the details. */
		suggestion?: string;
		hint?: string;
	},
): never {
	const { command, json, details = [], hint } = options;
	if (json) {
		const suggestion = [options.suggestion, hint, HELP_POINTER]
			.filter(Boolean)
			.join(" ");
		console.log(
			JSON.stringify(
				contractError(
					new PrinferError("INVALID_ARGUMENT", message, suggestion),
					{ surface: { interface: "cli", command } },
				),
			),
		);
	} else {
		const lines = [`Error [INVALID_ARGUMENT]: ${message}`, ...details];
		if (hint) lines.push(`Hint: ${hint}`);
		lines.push(HELP_POINTER);
		console.error(lines.join("\n"));
	}
	process.exit(1);
}

function parseInteger(
	value: string | true | undefined,
	name: string,
	min: 0 | 1,
	fail: (message: string) => never,
): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value);
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		!Number.isInteger(number) ||
		number < min
	) {
		fail(
			`${name} requires a ${min === 0 ? "non-negative" : "positive"} integer, got ${typeof value === "string" ? JSON.stringify(value) : "nothing"}.`,
		);
	}
	return number;
}

/** The CLI defaults to TypeScript 6; --backend typescript7 opts in. */
function parseBackend(
	value: string | true | undefined,
	fail: (message: string) => never,
): Backend {
	if (value === undefined) return "typescript6";
	if (value === "typescript6" || value === "typescript7") return value;
	return fail(
		typeof value === "string" && value !== ""
			? `Unknown backend "${value}". Use typescript6 or typescript7.`
			: "--backend requires typescript6 or typescript7.",
	);
}

/**
 * Combine the positional target with --text and --occurrence. Reports a
 * target that is incomplete, or that sets the column or text twice.
 */
function applyTextFlags(
	arg: string,
	parsed: ParsedTarget,
	text: string | undefined,
	occurrence: number | undefined,
	fail: (message: string, details?: string[]) => never,
): HoverTarget {
	const quoted = JSON.stringify(arg);
	let target: HoverTarget;
	if (text !== undefined) {
		if (text === "") fail("--text requires non-empty text.");
		if (parsed.kind === "name") {
			fail(`--text needs <file>:<line>, but ${quoted} names a symbol.`);
		}
		if (parsed.kind !== "line") {
			fail(
				`${quoted} already has a ${parsed.kind === "text" ? "text" : "column"} after the line; pass it or --text, not both.`,
			);
		}
		target = { kind: "text", line: parsed.line, text };
	} else if (parsed.kind === "line") {
		const prefix = `${parsed.file}:${parsed.line}`;
		return fail(`${quoted} has a line but no column or text after it.`, [
			`Add one: ${prefix}:<text>, ${prefix} --text <text>, or ${prefix}:<column>.`,
		]);
	} else {
		const { file: _file, ...rest } = parsed;
		target = rest;
	}
	if (occurrence !== undefined) {
		if (target.kind !== "text") {
			return fail(
				"--occurrence applies only to text targets (<file>:<line>:<text>).",
			);
		}
		target.occurrence = occurrence;
	}
	return target;
}

function parseArgs(argv: string[]): CliOptions | null {
	const args = argv.slice(2);
	const json = args.includes("--json");

	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		console.log(HELP);
		return null;
	}

	const completionMode = args[0] === "complete" || args[0] === "completions";
	const command: CliCommand = completionMode ? "complete" : "position";
	const forms = completionMode ? COMPLETE_FORMS : HOVER_FORMS;
	const fail = (message: string, details?: string[]): never =>
		usageError(message, { command, json, details });
	const { positionals, values } = parseFlags(
		completionMode ? args.slice(1) : args,
		completionMode ? COMPLETE_KEYS : HOVER_KEYS,
		completionMode ? "complete" : "type lookups",
		fail,
	);

	const arg = positionals[0];
	if (arg === undefined) {
		return fail(
			completionMode
				? "complete requires a cursor target."
				: "Missing the <file>:<target> argument.",
			forms,
		);
	}
	if (positionals.length > 1) {
		fail(
			`Unexpected argument ${JSON.stringify(positionals[1])}; pass one target, and quote text that contains spaces.`,
		);
	}

	const parsed = parseTargetArg(arg);
	if (!parsed) {
		return usageError(`Can't parse target ${JSON.stringify(arg)}.`, {
			command,
			json,
			details: forms,
			suggestion: completionMode
				? COMPLETE_FORMS_SUGGESTION
				: HOVER_FORMS_SUGGESTION,
			hint: shellHint(arg),
		});
	}

	const text = values.get("text");
	const target = applyTextFlags(
		arg,
		parsed,
		typeof text === "string" ? text : undefined,
		parseInteger(values.get("occurrence"), "--occurrence", 1, fail),
		fail,
	);
	const backend = parseBackend(values.get("backend"), fail);
	const projectValue = values.get("project");
	const project = typeof projectValue === "string" ? projectValue : undefined;

	if (completionMode) {
		if (target.kind === "name") {
			return fail(
				`complete needs a cursor, but ${JSON.stringify(arg)} names a symbol.`,
				forms,
			);
		}
		if (backend === "typescript7") {
			fail("complete supports only the typescript6 backend.");
		}
		const prefix = values.get("prefix");
		return {
			mode: "completion",
			arg,
			file: parsed.file,
			target,
			prefix: typeof prefix === "string" ? prefix : undefined,
			limit:
				parseInteger(values.get("limit"), "--limit", 1, fail) ??
				DEFAULT_COMPLETION_LIMIT,
			json,
			project,
		};
	}

	return {
		mode: "hover",
		arg,
		file: parsed.file,
		target,
		includeDocs: values.has("docs"),
		includeTiming: values.has("timing"),
		full: values.has("full"),
		maxChars:
			parseInteger(values.get("maxChars"), "--max-chars", 0, fail) ??
			DEFAULT_MAX_CHARS,
		json,
		project,
		backend,
	};
}

/**
 * Report a failed command: the JSON contract on stdout with --json,
 * otherwise the message, candidates, and suggestion on stderr. A path the
 * shell may have mangled gets a quoting hint.
 */
function reportCliError(
	error: unknown,
	command: CliCommand,
	context: {
		/** The argument as received, checked for shell mangling. */
		arg?: string;
		file: string;
		line?: number;
		column?: number;
		/** A name lookup's name: candidates are spelling fixes. */
		name?: string;
		/** A text target's text: ranks nearby candidates. */
		query?: string;
		project?: string;
	},
	json: boolean,
): void {
	const strict = context.name !== undefined;
	const response = reportError(error, {
		file: context.file,
		project: context.project,
		line: context.line,
		column: context.column,
		query: context.name ?? context.query,
		strict,
		surface: { interface: "cli", command },
	});
	const hint =
		response.error.code === "FILE_NOT_FOUND"
			? shellHint(context.arg ?? context.file)
			: undefined;
	if (hint) {
		response.error.suggestion = [response.error.suggestion, hint]
			.filter(Boolean)
			.join(" ");
	}
	if (json) console.log(JSON.stringify(response));
	else console.error(formatErrorText(response.error, { strict }));
}

/** The 1-based column where a text target's match starts. */
function textColumn(file: string, target: TextTarget): number {
	const resolved = assertSourceFile(file);
	return resolveTextColumn(
		fs.readFileSync(resolved, "utf8"),
		target,
		resolved,
	);
}

/** TypeScript 7 lookups go through the native language server, loaded lazily. */
async function runHover(
	options: CliHoverOptions,
	target: Exclude<HoverTarget, TextTarget>,
): Promise<HoverResult> {
	assertSourceFile(options.file);
	const hoverOptions: HoverOptions = {
		include_docs: options.includeDocs,
		include_timing: options.includeTiming,
		full: options.full,
		project: options.project,
	};
	if (options.backend === "typescript7") {
		const native = await import("./native-lsp.js");
		try {
			return target.kind === "position"
				? await native.nativeHover(
						options.file,
						target.line,
						target.column,
						hoverOptions,
					)
				: await native.nativeHoverByName(options.file, target.name, {
						...hoverOptions,
						line: target.line,
					});
		} finally {
			native.closeNativeSessions();
		}
	}
	return target.kind === "position"
		? hover(options.file, target.line, target.column, hoverOptions)
		: hover(options.file, target.name, {
				...hoverOptions,
				line: target.line,
			});
}

async function runDiagnostics(
	file: string,
	options: { project?: string; include_suggestions: boolean },
	backend: Backend,
): Promise<DiagnosticsResult> {
	assertSourceFile(file);
	if (backend === "typescript7") {
		const native = await import("./native-lsp.js");
		try {
			return await native.nativeDiagnostics(file, options);
		} finally {
			native.closeNativeSessions();
		}
	}
	return diagnostics(file, options);
}

/**
 * Runs `prinfer check <file>` (args exclude "check") and returns an exit code:
 * 0 when the file has no type errors, 1 when it has errors or the check fails.
 */
async function runCheck(args: string[]): Promise<number> {
	const json = args.includes("--json");
	const fail = (message: string): never =>
		usageError(message, {
			command: "check",
			json,
			details: [CHECK_USAGE],
			suggestion: CHECK_USAGE,
		});

	const { positionals, values } = parseFlags(args, CHECK_KEYS, "check", fail);
	if (positionals.length > 1) {
		fail(
			`Unexpected argument ${JSON.stringify(positionals[1])}; check takes one file.`,
		);
	}
	const file = positionals[0];
	const projectValue = values.get("project");
	const project = typeof projectValue === "string" ? projectValue : undefined;
	const backend = parseBackend(values.get("backend"), fail);
	const includeSuggestions = values.has("suggestions");
	if (!file) return fail("check requires a file: prinfer check <file.ts>");

	try {
		const result = await runDiagnostics(
			file,
			{ project, include_suggestions: includeSuggestions },
			backend,
		);
		console.log(
			json
				? JSON.stringify(diagnosticsSuccess(result))
				: formatDiagnostics(result, file),
		);
		return result.errorCount > 0 ? 1 : 0;
	} catch (error) {
		reportCliError(error, "check", { file, project }, json);
		return 1;
	}
}

function runCompletion(options: CliCompletionOptions): void {
	const { target } = options;
	let column = target.kind === "position" ? target.column : undefined;
	try {
		assertSourceFile(options.file);
		// A text target puts the cursor right after the match, like
		// prinfer/testing's default cursor: "end".
		if (target.kind === "text") {
			column = textColumn(options.file, target) + target.text.length;
		}
		const result = getCompletions(
			options.file,
			target.line,
			column as number,
			options.project,
			{ prefix: options.prefix, autoPrefix: true, limit: options.limit },
		);
		console.log(
			options.json
				? JSON.stringify(completionSuccess(result))
				: formatCompletions(result, {
						prefix: "--prefix",
						limit: "--limit",
					}),
		);
	} catch (error) {
		reportCliError(
			error,
			"complete",
			{
				arg: options.arg,
				file: options.file,
				line: target.line,
				column,
				query: target.kind === "text" ? target.text : undefined,
				project: options.project,
			},
			options.json,
		);
		process.exit(1);
	}
}

async function runLookup(options: CliHoverOptions): Promise<void> {
	const { target } = options;
	let column = target.kind === "position" ? target.column : undefined;
	try {
		let resolved: Exclude<HoverTarget, TextTarget>;
		if (target.kind === "text") {
			column = textColumn(options.file, target);
			resolved = { kind: "position", line: target.line, column };
		} else {
			resolved = target;
		}
		const result = await runHover(options, resolved);
		// Like the MCP hover tool, a text target reports where it resolved.
		const position =
			target.kind === "text" && column !== undefined
				? { line: target.line, column }
				: undefined;
		if (options.json) {
			console.log(
				JSON.stringify(
					hoverSuccess(position ? { ...result, position } : result),
				),
			);
			return;
		}
		console.log(
			formatHoverText(result, {
				surface: "cli",
				maxChars: options.maxChars,
				full: options.full,
				target:
					target.kind === "text" && position
						? { text: target.text, ...position }
						: undefined,
			}),
		);
	} catch (error) {
		reportCliError(
			error,
			target.kind === "name" ? "name" : "position",
			{
				arg: options.arg,
				file: options.file,
				line: target.line,
				column,
				name: target.kind === "name" ? target.name : undefined,
				query: target.kind === "text" ? target.text : undefined,
				project: options.project,
			},
			options.json,
		);
		process.exit(1);
	}
}

/**
 * Runs `prinfer annotations <file>` (args exclude "annotations") and returns
 * an exit code: 0 whatever it finds, 1 when the check itself fails.
 */
function runAnnotations(args: string[]): number {
	const json = args.includes("--json");
	const fail = (message: string): never =>
		usageError(message, {
			command: "annotations",
			json,
			details: [ANNOTATIONS_USAGE],
			suggestion: ANNOTATIONS_USAGE,
		});

	const { positionals, values } = parseFlags(
		args,
		ANNOTATIONS_KEYS,
		"annotations",
		fail,
	);
	if (positionals.length > 1) {
		fail(
			`Unexpected argument ${JSON.stringify(positionals[1])}; annotations takes one file.`,
		);
	}
	const file = positionals[0];
	const projectValue = values.get("project");
	const project = typeof projectValue === "string" ? projectValue : undefined;
	if (!file) {
		return fail(
			"annotations requires a file: prinfer annotations <file.ts>",
		);
	}

	try {
		assertSourceFile(file);
		const result = getFileAnnotations(file, project);
		console.log(
			json
				? JSON.stringify(annotationsSuccess(result))
				: formatAnnotations(result, file),
		);
		return 0;
	} catch (error) {
		reportCliError(error, "annotations", { file, project }, json);
		return 1;
	}
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (command === "mcp") {
		await startMcpServer().catch((error: unknown) => {
			console.error(
				`Error: failed to start the prinfer MCP server: ${(error as Error).message}`,
			);
			process.exit(1);
		});
		return;
	}
	if (command === "setup") {
		process.exit(runSetup(process.argv.slice(3)));
	}
	if (command === "check") {
		const args = process.argv.slice(3);
		if (args.includes("--help") || args.includes("-h")) {
			console.log(HELP);
			process.exit(0);
		}
		process.exit(await runCheck(args));
	}

	if (command === "annotations") {
		const args = process.argv.slice(3);
		if (args.includes("--help") || args.includes("-h")) {
			console.log(HELP);
			process.exit(0);
		}
		process.exit(runAnnotations(args));
	}

	const options = parseArgs(process.argv);
	if (!options) process.exit(0);
	if (options.mode === "completion") runCompletion(options);
	else await runLookup(options);
}

main();
