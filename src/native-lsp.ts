import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { summarizeDiagnostics } from "./core/diagnostics.js";
import {
	assertCursorPosition,
	fromLspPosition,
	type LineCharacter,
	stripBom,
	toLspPosition,
} from "./core/lines.js";
import { findNodeByNameAndLine } from "./core/node-find.js";
import { getNameNode } from "./core/node-match.js";
import {
	type FileChange,
	WorkspaceFiles,
	type WorkspaceScanStats,
} from "./core/workspace-files.js";
import { PrinferError } from "./errors.js";
import type {
	DiagnosticCategory,
	DiagnosticsOptions,
	DiagnosticsResult,
	FileDiagnostic,
	HoverOptions,
	HoverPosition,
	HoverResult,
} from "./types.js";

interface LspResponse {
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

interface LspRange {
	start: LineCharacter;
	end: LineCharacter;
}

interface LspHover {
	contents:
		| string
		| { kind: string; value: string }
		| Array<string | { language?: string; value: string }>;
	range?: LspRange;
}

interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	code?: number | string;
	source?: string;
	message: string;
}

interface LspDocumentDiagnosticReport {
	kind: "full" | "unchanged";
	items?: LspDiagnostic[];
}

interface OpenDocument {
	file: string;
	/** Text as sent to the server: the file without its BOM */
	text: string;
	version: number;
	signature?: string;
}

const require = createRequire(resolveFromScript());
const nativePackage = require.resolve("@typescript/native/package.json");
const nativeTsc = path.join(path.dirname(nativePackage), "bin", "tsc");
const sessions = new Map<string, NativeLspClient>();

/**
 * Global installs run bins through symlinks such as <prefix>/bin/prinfer-mcp,
 * where no node_modules is reachable; resolve from the real script location.
 */
function resolveFromScript(): string {
	const script = process.argv[1];
	if (!script) return path.join(process.cwd(), "package.json");
	try {
		return fs.realpathSync(script);
	} catch {
		return path.resolve(script);
	}
}

class NativeLspClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private readonly documents = new Map<string, OpenDocument>();
	private readonly workspace: WorkspaceFiles;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private stderr = "";
	private supportsPullDiagnostics = false;
	readonly ready: Promise<void>;

	constructor(root: string) {
		// Files edited after this moment may be stale in the server.
		this.workspace = new WorkspaceFiles(root, Date.now());
		this.child = spawn(process.execPath, [nativeTsc, "--lsp", "--stdio"], {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000);
		});
		this.child.once("error", (error) => this.rejectAll(error));
		this.child.once("exit", (code, signal) => {
			this.rejectAll(
				new Error(
					`TypeScript 7 language server exited (${signal ?? code})${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
				),
			);
			if (sessions.get(root) === this) sessions.delete(root);
		});

		this.ready = this.request("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(root).href,
			capabilities: {
				textDocument: {
					hover: { contentFormat: ["markdown", "plaintext"] },
				},
			},
			workspaceFolders: null,
		}).then((result) => {
			this.supportsPullDiagnostics = Boolean(
				(result as { capabilities?: { diagnosticProvider?: unknown } })
					?.capabilities?.diagnosticProvider,
			);
			this.notify("initialized", {});
		});
	}

	/**
	 * Hover at a 1-based position (TypeScript line rules). Edits to files the
	 * hovered file imports are reported first, so the result is current.
	 */
	async hover(
		file: string,
		position: HoverPosition,
		project?: string,
	): Promise<{
		result: LspHover | null;
		text: string;
		resolutionMs: number;
	}> {
		await this.ready;
		const uri = pathToFileURL(file).href;
		this.reportChanges(this.workspace.checkImports(file));
		const document = this.openOrUpdate(uri, file);
		assertCursorPosition(
			document.text,
			position.line,
			position.column,
			file,
		);
		if (project) await this.assertProject(uri, file, project);
		const resolutionStarted = performance.now();
		const result = (await this.request("textDocument/hover", {
			textDocument: { uri },
			position: toLspPosition(document.text, {
				line: position.line - 1,
				character: position.column - 1,
			}),
		})) as LspHover | null;
		return {
			result,
			text: document.text,
			resolutionMs: roundMs(performance.now() - resolutionStarted),
		};
	}

	async diagnostics(
		file: string,
		project?: string,
	): Promise<{ items: LspDiagnostic[]; text: string }> {
		await this.ready;
		if (!this.supportsPullDiagnostics) {
			throw new Error(
				"TypeScript 7 language server does not support pull diagnostics",
			);
		}
		const uri = pathToFileURL(file).href;
		this.reportChanges(this.workspace.scanWorkspace(file));
		const document = this.openOrUpdate(uri, file);
		if (project) await this.assertProject(uri, file, project);
		const report = (await this.request("textDocument/diagnostic", {
			textDocument: { uri },
		})) as LspDocumentDiagnosticReport | null;
		// No previousResultId is sent, so the server must answer with a full
		// report; treat anything else as an empty result.
		return {
			items: report?.kind === "full" ? (report.items ?? []) : [],
			text: document.text,
		};
	}

	get workspaceStats(): WorkspaceScanStats {
		return this.workspace.stats;
	}

	close(): void {
		this.child.kill();
	}

	/**
	 * The TypeScript 7 language server picks each file's tsconfig itself (the
	 * nearest tsconfig.json, or a project that one references) and has no
	 * option to override it. Fail rather than answer from another config.
	 */
	private async assertProject(
		uri: string,
		file: string,
		project: string,
	): Promise<void> {
		const info = (await this.request("custom/projectInfo", {
			textDocument: { uri },
		})) as { configFilePath?: string } | null;
		const actual = info?.configFilePath || undefined;
		if (actual && samePath(actual, project)) return;
		throw new PrinferError(
			"INVALID_ARGUMENT",
			`The TypeScript 7 backend can't use project ${project} for ${file}: its language server loads ${actual ?? "no tsconfig (an inferred project)"} for that file`,
			`TypeScript 7 always uses the tsconfig.json nearest the file, or a project that tsconfig references. Use the typescript6 backend for ${path.basename(project)}, or omit project.`,
		);
	}

	private reportChanges(changes: FileChange[]): void {
		if (changes.length === 0) return;
		this.notify("workspace/didChangeWatchedFiles", {
			changes: changes.map(({ file, type }) => ({
				uri: pathToFileURL(file).href,
				type,
			})),
		});
	}

	/**
	 * Open the requested file and push on-disk edits for every document this
	 * client already opened. Open documents shadow the disk in the language
	 * server, so a stale dependency would otherwise produce stale results.
	 */
	private openOrUpdate(uri: string, file: string): OpenDocument {
		for (const [openUri, document] of this.documents) {
			if (openUri !== uri) this.refresh(openUri, document);
		}
		const current = this.documents.get(uri);
		if (current) {
			this.refresh(uri, current, true);
			if (this.documents.has(uri)) return current;
		}
		const signature = statSignature(file);
		const text = readSourceText(file);
		const document = { file, text, version: 1, signature };
		this.documents.set(uri, document);
		this.notify("textDocument/didOpen", {
			textDocument: {
				uri,
				languageId: languageId(file),
				version: 1,
				text,
			},
		});
		return document;
	}

	private refresh(uri: string, document: OpenDocument, force = false): void {
		const signature = statSignature(document.file);
		if (!signature) {
			this.documents.delete(uri);
			this.notify("textDocument/didClose", { textDocument: { uri } });
			return;
		}
		if (!force && signature === document.signature) return;
		document.signature = signature;
		const text = readSourceText(document.file);
		if (document.text === text) return;
		document.text = text;
		document.version += 1;
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: document.version },
			contentChanges: [{ text }],
		});
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	private notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	private send(message: unknown): void {
		const json = JSON.stringify(message);
		this.child.stdin.write(
			`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`,
		);
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = /content-length:\s*(\d+)/i.exec(header);
			if (!match) throw new Error(`Invalid LSP header: ${header}`);
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) return;
			const body = this.buffer
				.subarray(bodyStart, bodyStart + length)
				.toString();
			this.buffer = this.buffer.subarray(bodyStart + length);
			this.onMessage(JSON.parse(body) as LspResponse);
		}
	}

	private onMessage(message: LspResponse): void {
		if (message.id === undefined) return;
		if (message.method) {
			const result =
				message.method === "workspace/configuration" &&
				Array.isArray(
					(message.params as { items?: unknown[] } | undefined)
						?.items,
				)
					? (message.params as { items: unknown[] }).items.map(
							() => null,
						)
					: null;
			this.send({ jsonrpc: "2.0", id: message.id, result });
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(
				new Error(`TypeScript LSP: ${message.error.message}`),
			);
		} else {
			pending.resolve(message.result);
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

export async function nativeHover(
	file: string,
	line: number,
	column: number,
	options?: HoverOptions,
): Promise<HoverResult> {
	const entryFileAbs = path.resolve(process.cwd(), file);
	if (!fs.existsSync(entryFileAbs))
		throw new Error(`File not found: ${entryFileAbs}`);
	const { root, config } = resolveProject(entryFileAbs, options?.project);
	const client = getNativeClient(root);
	const {
		result: hover,
		text,
		resolutionMs,
	} = await client.hover(entryFileAbs, { line, column }, config);
	if (!hover)
		throw new Error(`No symbol found at ${entryFileAbs}:${line}:${column}`);
	const result = toHoverResult(
		hover,
		text,
		line,
		column,
		options?.include_docs ?? false,
	);
	if (options?.include_timing) {
		result.timing = { resolution_ms: resolutionMs };
	}
	return result;
}

/**
 * Hover a symbol by name. The symbol is chosen exactly as the TypeScript 6
 * backend chooses it (declarations first, never inside comments or
 * strings), by parsing the file with TypeScript 6, then hovered with
 * TypeScript 7 at its name token.
 */
export async function nativeHoverByName(
	file: string,
	name: string,
	options?: HoverOptions & { line?: number },
): Promise<HoverResult> {
	const entryFileAbs = path.resolve(process.cwd(), file);
	if (!fs.existsSync(entryFileAbs))
		throw new Error(`File not found: ${entryFileAbs}`);
	const sourceFile = parseSource(entryFileAbs);
	const node = findNodeByNameAndLine(sourceFile, name, options?.line);
	if (!node) {
		const lineInfo = options?.line ? ` at line ${options.line}` : "";
		throw new Error(
			`No symbol named "${name}"${lineInfo} found in ${file}`,
		);
	}
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		getNameNode(node).getStart(sourceFile),
	);
	return nativeHover(file, line + 1, character + 1, options);
}

/**
 * Check one file for TypeScript errors with the warm TypeScript 7 language
 * server for its project. On-disk edits are synced before checking.
 */
export async function nativeDiagnostics(
	file: string,
	options?: DiagnosticsOptions,
): Promise<DiagnosticsResult> {
	const entryFileAbs = path.resolve(process.cwd(), file);
	if (!fs.existsSync(entryFileAbs))
		throw new Error(`File not found: ${entryFileAbs}`);
	const { root, config } = resolveProject(entryFileAbs, options?.project);
	const client = getNativeClient(root);
	const { items, text } = await client.diagnostics(entryFileAbs, config);
	return summarizeDiagnostics(
		entryFileAbs,
		items.map((item) => toFileDiagnostic(item, text)),
		options?.include_suggestions ?? false,
	);
}

/**
 * Workspace-scan statistics of the session that serves `file`, if one is
 * running. Hover-only sessions never scan (entries stays 0).
 *
 * @internal Exported for tests.
 */
export function nativeWorkspaceStats(
	file: string,
	project?: string,
): WorkspaceScanStats | undefined {
	const entryFileAbs = path.resolve(process.cwd(), file);
	return sessions.get(resolveProject(entryFileAbs, project).root)
		?.workspaceStats;
}

export function closeNativeSessions(): void {
	for (const client of sessions.values()) client.close();
	sessions.clear();
	parsedSources.clear();
}

function getNativeClient(root: string): NativeLspClient {
	let client = sessions.get(root);
	if (!client) {
		client = new NativeLspClient(root);
		sessions.set(root, client);
	}
	return client;
}

/**
 * Sessions are keyed by directory: the language server chooses each file's
 * tsconfig itself. An explicit project is checked against that choice.
 */
function resolveProject(
	file: string,
	project?: string,
): { root: string; config?: string } {
	if (!project) return { root: findConfigRoot(path.dirname(file)) };
	const resolved = path.resolve(process.cwd(), project);
	let config = resolved;
	try {
		if (fs.statSync(resolved).isDirectory())
			config = path.join(resolved, "tsconfig.json");
	} catch {
		throw new PrinferError(
			"FILE_NOT_FOUND",
			`Project not found: ${resolved}`,
			"Pass the path of an existing tsconfig.json, or omit project.",
		);
	}
	return { root: path.dirname(config), config };
}

function findConfigRoot(start: string): string {
	let current = start;
	while (true) {
		if (fs.existsSync(path.join(current, "tsconfig.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

function samePath(left: string, right: string): boolean {
	return realPath(left) === realPath(right);
}

function realPath(file: string): string {
	try {
		return fs.realpathSync.native(file);
	} catch {
		return path.resolve(file);
	}
}

/** File text as TypeScript sees it: without a leading BOM. */
function readSourceText(file: string): string {
	return stripBom(fs.readFileSync(file, "utf8"));
}

const MAX_PARSED_SOURCES = 16;
const parsedSources = new Map<
	string,
	{ signature?: string; sourceFile: ts.SourceFile }
>();

/** Parse a file with TypeScript 6 for name lookup, cached by stat. */
function parseSource(file: string): ts.SourceFile {
	const signature = statSignature(file);
	const cached = parsedSources.get(file);
	if (cached && cached.signature === signature) return cached.sourceFile;
	const sourceFile = ts.createSourceFile(
		file,
		readSourceText(file),
		ts.ScriptTarget.Latest,
		true,
	);
	parsedSources.delete(file);
	parsedSources.set(file, { signature, sourceFile });
	if (parsedSources.size > MAX_PARSED_SOURCES) {
		const oldest = parsedSources.keys().next().value;
		if (oldest) parsedSources.delete(oldest);
	}
	return sourceFile;
}

function statSignature(file: string): string | undefined {
	try {
		const stat = fs.statSync(file);
		return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
	} catch {
		return undefined;
	}
}

function toFileDiagnostic(
	diagnostic: LspDiagnostic,
	text: string,
): FileDiagnostic {
	const code =
		typeof diagnostic.code === "number"
			? diagnostic.code
			: Number.parseInt(String(diagnostic.code ?? "0"), 10) || 0;
	const start = fromLspPosition(text, diagnostic.range.start);
	const end = fromLspPosition(text, diagnostic.range.end);
	return {
		line: start.line + 1,
		column: start.character + 1,
		endLine: end.line + 1,
		endColumn: end.character + 1,
		code,
		category: severityCategory(diagnostic.severity),
		message: diagnostic.message,
		source: diagnostic.source ?? "ts",
	};
}

// LSP DiagnosticSeverity: 1 Error, 2 Warning, 3 Information, 4 Hint.
function severityCategory(severity: number | undefined): DiagnosticCategory {
	switch (severity) {
		case 2:
			return "warning";
		case 3:
			return "message";
		case 4:
			return "suggestion";
		default:
			return "error";
	}
}

function languageId(file: string): string {
	if (file.endsWith(".tsx")) return "typescriptreact";
	if (file.endsWith(".jsx")) return "javascriptreact";
	if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs"))
		return "javascript";
	return "typescript";
}

function toHoverResult(
	hover: LspHover,
	text: string,
	line: number,
	column: number,
	includeDocs: boolean,
): HoverResult {
	const parsed = parseHoverMarkdown(hoverContents(hover.contents));
	const start = hover.range
		? fromLspPosition(text, hover.range.start)
		: undefined;
	return {
		signature: parsed.signature,
		returnType: parsed.returnType,
		line: start ? start.line + 1 : line,
		column: start ? start.character + 1 : column,
		documentation:
			includeDocs && parsed.documentation
				? parsed.documentation
				: undefined,
		kind: parsed.kind,
		name: parsed.name,
	};
}

function hoverContents(contents: LspHover["contents"]): string {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) {
		return contents
			.map((part) =>
				typeof part === "string"
					? part
					: part.language
						? `\`\`\`${part.language}\n${part.value}\n\`\`\``
						: part.value,
			)
			.join("\n\n");
	}
	return contents.value;
}

export interface ParsedHover {
	signature: string;
	documentation?: string;
	kind: string;
	name?: string;
	returnType?: string;
}

const CODE_BLOCK =
	/```(?:typescript|tsx|javascript|jsx|ts|js)?[^\S\n]*\n([\s\S]*?)\n?```/;
const DECLARATION_KEYWORD =
	/^(?:(?:declare|export|default|abstract|async|readonly|static)\s+)*(function|class|interface|type|const|let|var|enum|namespace|module|constructor|import)\b\s*/;
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*/u;
const OVERLOADS = /\s*\(\+\d+ overloads?\)$/;

/**
 * Split TypeScript 7 hover markdown into signature and documentation, and
 * read the symbol's kind, name, and return type from the signature. The
 * signature may span lines (expanded object types) and contain nested
 * parentheses and generics, so it is scanned with bracket matching.
 *
 * @internal Exported for tests.
 */
export function parseHoverMarkdown(markdown: string): ParsedHover {
	const codeMatch = CODE_BLOCK.exec(markdown);
	const signature = (codeMatch?.[1] ?? markdown).trim();
	const documentation = codeMatch
		? markdown.slice(codeMatch.index + codeMatch[0].length).trim() ||
			undefined
		: undefined;
	return { signature, documentation, ...describeSignature(signature) };
}

function describeSignature(signature: string): {
	kind: string;
	name?: string;
	returnType?: string;
} {
	let rest = signature;
	let kind: string | undefined;
	const label = /^\(([^()]+)\)\s+/.exec(rest);
	if (label) {
		rest = rest.slice(label[0].length);
		// "(alias) const value: 1": the kind is the aliased declaration's.
		if (label[1] !== "alias") kind = label[1];
		else rest = rest.split(/\n(?=import\s)/, 1)[0] ?? rest;
	}
	// A labelled member such as "(property) type: string" has no keyword.
	const keyword = kind ? undefined : DECLARATION_KEYWORD.exec(rest);
	if (keyword) {
		kind = keyword[1];
		rest = rest.slice(keyword[0].length);
	}
	kind ??= signature.split(/\s/, 1)[0]?.replace(/[():]/g, "") || "symbol";

	const { name, end } = readQualifiedName(rest);
	if (end === 0) return { kind };
	if (kind === "type" || kind === "interface" || kind === "class")
		return { kind, name };

	let index = skipSpaces(rest, end);
	if (rest[index] === "?") index++;
	if (rest[index] === "(") {
		// Call signature: name(params): ReturnType
		const close = matchBracket(rest, index);
		if (close < 0) return { kind, name };
		const after = skipSpaces(rest, close + 1);
		return {
			kind,
			name,
			returnType:
				rest[after] === ":"
					? cleanType(rest.slice(after + 1))
					: undefined,
		};
	}
	if (rest[index] !== ":") return { kind, name };
	// Value with a type: a function type's return type is reported.
	return {
		kind,
		name,
		returnType: functionReturnType(rest.slice(index + 1)),
	};
}

/**
 * Read `Array<string>.map<number>` or `Box<T>.value`: identifiers joined by
 * dots, each with optional type arguments. The name is the last identifier.
 */
function readQualifiedName(text: string): { name?: string; end: number } {
	let index = 0;
	let name: string | undefined;
	while (index < text.length) {
		const quote = text[index];
		if (quote === '"' || quote === "'") {
			const close = skipString(text, index);
			name = text.slice(index + 1, close - 1);
			index = close;
		} else {
			const identifier = IDENTIFIER.exec(text.slice(index))?.[0];
			if (!identifier) break;
			name = identifier;
			index += identifier.length;
		}
		if (text[index] === "<") {
			const close = matchBracket(text, index);
			if (close < 0) break;
			index = close + 1;
		}
		if (text[index] !== ".") break;
		index++;
	}
	return { name, end: name === undefined ? 0 : index };
}

/** The return type when `type` is a function type `<T>(…) => R`. */
function functionReturnType(type: string): string | undefined {
	let index = skipSpaces(type, 0);
	if (type[index] === "<") {
		const close = matchBracket(type, index);
		if (close < 0) return undefined;
		index = skipSpaces(type, close + 1);
	}
	if (type[index] !== "(") return undefined;
	const close = matchBracket(type, index);
	if (close < 0) return undefined;
	const arrow = skipSpaces(type, close + 1);
	if (type.slice(arrow, arrow + 2) !== "=>") return undefined;
	return cleanType(type.slice(arrow + 2));
}

function cleanType(type: string): string | undefined {
	return type.trim().replace(OVERLOADS, "") || undefined;
}

function skipSpaces(text: string, index: number): number {
	let current = index;
	while (current < text.length && /\s/.test(text[current] ?? "")) current++;
	return current;
}

/** Index just past the string literal starting at `index`. */
function skipString(text: string, index: number): number {
	const quote = text[index];
	let current = index + 1;
	while (current < text.length && text[current] !== quote) {
		current += text[current] === "\\" ? 2 : 1;
	}
	return current + 1;
}

const CLOSING: Record<string, string> = {
	"(": ")",
	"[": "]",
	"{": "}",
	"<": ">",
};

/**
 * Index of the bracket closing the one at `open`, skipping nested brackets,
 * string literals, and the `>` of `=>`. -1 when unbalanced.
 */
function matchBracket(text: string, open: number): number {
	const stack: string[] = [];
	for (let index = open; index < text.length; index++) {
		const char = text[index] ?? "";
		if (char === '"' || char === "'" || char === "`") {
			index = skipString(text, index) - 1;
			continue;
		}
		const closing = CLOSING[char];
		if (closing) {
			stack.push(closing);
			continue;
		}
		if (char === ">" && text[index - 1] === "=") continue;
		if (char === ")" || char === "]" || char === "}" || char === ">") {
			if (stack.pop() !== char) return -1;
			if (stack.length === 0) return index;
		}
	}
	return -1;
}

function roundMs(value: number): number {
	return Math.round(value * 1000) / 1000;
}
