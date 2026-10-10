import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceFile } from "@typescript/native/unstable/ast";
import {
	API,
	NodeBuilderFlags,
	type Project,
	SignatureKind,
	type Snapshot,
	SymbolFlags,
	TypeFlags,
} from "@typescript/native/unstable/async";
import * as ts from "typescript";
import { summarizeDiagnostics } from "./core/diagnostics.js";
import {
	assertCursorPosition,
	fromLspPosition,
	type LineCharacter,
	lineStarts,
	stripBom,
	toLspPosition,
} from "./core/lines.js";
import { lookupName } from "./core/name-lookup.js";
import { findNodeAtPosition } from "./core/node-find.js";
import { getNameNode } from "./core/node-match.js";
import { singleLine } from "./core/signature-text.js";
import { sortResultUnions } from "./core/union-order.js";
import {
	type FileChange,
	WorkspaceFiles,
	type WorkspaceScanStats,
} from "./core/workspace-files.js";
import { PrinferError } from "./errors.js";
import {
	countNativeUnionMembers,
	hoveredType,
	nativeFileDiagnostics,
	nativeSignatureText,
	nativeTypeInfoAt,
} from "./native-api.js";
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

/**
 * The language server truncates hover types past `maximumHoverLength`
 * characters (`... 389 more ...`), like an editor. A `full` hover raises the
 * limit beyond any real type for the duration of the request.
 */
const FULL_HOVER_LENGTH = 2 ** 31 - 1;

/** What the TypeScript 7 checker adds to a hover; see HoverResult. */
export interface HoverExtras {
	overloads?: string[];
	unionMembers?: number;
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
	/** Whether the server currently has the full hover length configured. */
	private fullHovers = false;
	/** Hovers in flight under the current hover-length setting. */
	private activeHovers = 0;
	private idleWaiters: Array<() => void> = [];
	/** API session sharing this server's projects, opened on first use. */
	private api: Promise<API<true>> | undefined;
	/** API requests run one at a time, each on a fresh snapshot. */
	private apiTail: Promise<unknown> = Promise.resolve();
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
		full = false,
	): Promise<{
		result: LspHover | null;
		text: string;
		extras: HoverExtras;
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
		await this.acquireHoverLength(full);
		try {
			const result = (await this.request("textDocument/hover", {
				textDocument: { uri },
				position: toLspPosition(document.text, {
					line: position.line - 1,
					character: position.column - 1,
				}),
			})) as LspHover | null;
			const extras = result
				? await this.hoverExtras(
						file,
						offsetOf(document.text, position),
						full,
					)
				: {};
			return { result, text: document.text, extras };
		} finally {
			this.releaseHoverLength();
		}
	}

	/**
	 * Configure the hover length a request needs. The setting is
	 * server-wide, so it only changes while no hover is in flight.
	 */
	private async acquireHoverLength(full: boolean): Promise<void> {
		while (this.fullHovers !== full && this.activeHovers > 0) {
			await new Promise<void>((resolve) =>
				this.idleWaiters.push(resolve),
			);
		}
		if (this.fullHovers !== full) {
			this.fullHovers = full;
			this.notify("workspace/didChangeConfiguration", {
				settings: { typescript: this.preferences() },
			});
		}
		this.activeHovers += 1;
	}

	private releaseHoverLength(): void {
		this.activeHovers -= 1;
		if (this.activeHovers > 0) return;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/** The `typescript` settings section prinfer runs the server with. */
	private preferences(): Record<string, unknown> {
		return this.fullHovers ? { maximumHoverLength: FULL_HOVER_LENGTH } : {};
	}

	/**
	 * Overloads and union size from the checker, through an API session on
	 * this language server (no second compiler process). Best effort: if the
	 * API is unavailable, the hover is returned without them.
	 */
	private hoverExtras(
		file: string,
		offset: number,
		full: boolean,
	): Promise<HoverExtras> {
		const run = this.apiTail.then(() =>
			this.hoverExtrasNow(file, offset, full),
		);
		this.apiTail = run.catch(() => undefined);
		return run;
	}

	private async hoverExtrasNow(
		file: string,
		offset: number,
		full: boolean,
	): Promise<HoverExtras> {
		let snapshot: Snapshot | undefined;
		try {
			this.api ??= this.openApi();
			snapshot = await (await this.api).updateSnapshot({});
			const project = await snapshot.getDefaultProjectForFile(file);
			if (!project) return {};
			const { checker } = project;
			const flags = full
				? NodeBuilderFlags.NoTruncation
				: NodeBuilderFlags.None;
			const sourceFile = await project.program.getSourceFile(file);
			const [type, symbol] = await Promise.all([
				sourceFile
					? hoveredType(project, sourceFile, file, offset)
					: checker.getTypeAtPosition(file, offset),
				checker.getSymbolAtPosition(file, offset),
			]);
			const extras: HoverExtras = {};
			// A method shows its signature, not a union with undefined.
			const unionMembers =
				type && !(symbol && symbol.flags & SymbolFlags.Method)
					? await countNativeUnionMembers(checker, type)
					: undefined;
			if (unionMembers !== undefined) extras.unionMembers = unionMembers;
			const symbolType = symbol
				? await checker.getTypeOfSymbol(symbol)
				: undefined;
			if (symbolType && symbolType.flags & TypeFlags.Object) {
				const signatures = await checker.getSignaturesOfType(
					symbolType,
					SignatureKind.Call,
				);
				if (signatures.length > 1) {
					extras.overloads = await Promise.all(
						signatures.map((signature) =>
							nativeSignatureText(project, signature, flags),
						),
					);
				}
			}
			return extras;
		} catch {
			return {};
		} finally {
			await snapshot?.dispose().catch(() => undefined);
		}
	}

	private async openApi(): Promise<API<true>> {
		const session = (await this.request(
			"custom/initializeAPISession",
			{},
		)) as { pipe?: string } | null;
		if (!session?.pipe) throw new Error("No API session pipe");
		return API.fromLSPConnection({ pipe: session.pipe });
	}

	/**
	 * Hover in an explicit project. When the language server itself loads
	 * `project` for the file, this returns undefined and the caller hovers
	 * through the language server as usual. Any other tsconfig is opened
	 * through the API session in this server, which shares its open
	 * documents, and read from the checker the way the testing helpers do.
	 */
	async projectHover(
		file: string,
		position: HoverPosition,
		project: string,
		options?: HoverOptions,
	): Promise<HoverResult | undefined> {
		await this.ready;
		const uri = pathToFileURL(file).href;
		this.reportChanges(this.workspace.checkImports(file));
		const { text } = this.openOrUpdate(uri, file);
		assertCursorPosition(text, position.line, position.column, file);
		if (await this.picksProject(uri, project)) return undefined;
		const cursor = {
			file,
			text,
			...position,
			position: offsetOf(text, position),
		};
		return this.inProject(file, project, (loaded, sourceFile) =>
			nativeTypeInfoAt(loaded, sourceFile, cursor, options),
		);
	}

	/**
	 * Diagnostics for one file, from the language server, or from the
	 * project API for a tsconfig it would not pick (see projectHover).
	 */
	async diagnostics(
		file: string,
		project: string | undefined,
		includeSuggestions: boolean,
	): Promise<FileDiagnostic[]> {
		await this.ready;
		const uri = pathToFileURL(file).href;
		this.reportChanges(this.workspace.scanWorkspace(file));
		const { text } = this.openOrUpdate(uri, file);
		if (project && !(await this.picksProject(uri, project))) {
			return this.inProject(file, project, (loaded) =>
				nativeFileDiagnostics(loaded, file, text, includeSuggestions),
			);
		}
		if (!this.supportsPullDiagnostics) {
			throw new Error(
				"TypeScript 7 language server does not support pull diagnostics",
			);
		}
		const report = (await this.request("textDocument/diagnostic", {
			textDocument: { uri },
		})) as LspDocumentDiagnosticReport | null;
		// No previousResultId is sent, so the server must answer with a full
		// report; treat anything else as an empty result.
		const items = report?.kind === "full" ? (report.items ?? []) : [];
		return items.map((item) => toFileDiagnostic(item, text));
	}

	get workspaceStats(): WorkspaceScanStats {
		return this.workspace.stats;
	}

	close(): void {
		const api = this.api;
		this.api = undefined;
		void api?.then(
			(session) => session.close().catch(() => undefined),
			() => undefined,
		);
		this.child.kill();
	}

	/**
	 * Whether the language server loads `project` for the file itself: the
	 * nearest tsconfig.json, or a project that one references. It has no
	 * option to load another one for its own requests.
	 *
	 * The request also orders the document changes sent before it ahead of
	 * any API snapshot taken after it.
	 */
	private async picksProject(uri: string, project: string): Promise<boolean> {
		const info = (await this.request("custom/projectInfo", {
			textDocument: { uri },
		})) as { configFilePath?: string } | null;
		const actual = info?.configFilePath || undefined;
		return actual !== undefined && samePath(actual, project);
	}

	/**
	 * Run an operation on `project` loaded through this server's API session
	 * (`openProjects` keeps it loaded, next to the language server's own
	 * projects, until the session closes). The file must be part of the
	 * project's program: unlike the TypeScript 6 backend, TypeScript 7 can't
	 * add a file to a tsconfig that doesn't include it.
	 */
	private inProject<T>(
		file: string,
		project: string,
		operation: (loaded: Project, sourceFile: SourceFile) => Promise<T>,
	): Promise<T> {
		const run = this.apiTail.then(() =>
			this.inProjectNow(file, project, operation),
		);
		this.apiTail = run.catch(() => undefined);
		return run;
	}

	private async inProjectNow<T>(
		file: string,
		project: string,
		operation: (loaded: Project, sourceFile: SourceFile) => Promise<T>,
	): Promise<T> {
		let snapshot: Snapshot;
		try {
			this.api ??= this.openApi();
			const api = await this.api.catch((error: unknown) => {
				// Let the next request try to open a session again.
				this.api = undefined;
				throw error;
			});
			snapshot = await api.updateSnapshot({ openProjects: [project] });
		} catch (error) {
			throw new PrinferError(
				"TYPESCRIPT_ERROR",
				`TypeScript 7 could not open project ${project}: ${error instanceof Error ? error.message : String(error)}`,
				"Check that the tsconfig is valid, or use the typescript6 backend.",
			);
		}
		try {
			const loaded = snapshot.getProject(project);
			if (!loaded) {
				throw new PrinferError(
					"TYPESCRIPT_ERROR",
					`TypeScript 7 could not load project ${project}`,
					"Check that the tsconfig is valid, or use the typescript6 backend.",
				);
			}
			const sourceFile = await loaded.program.getSourceFile(file);
			if (!sourceFile) {
				throw new PrinferError(
					"INVALID_ARGUMENT",
					`The TypeScript 7 backend can't use project ${project} for ${file}: the project doesn't include that file`,
					`Add the file to ${path.basename(project)}'s include or files, use the typescript6 backend (which adds the file to the project), or omit project.`,
				);
			}
			return await operation(loaded, sourceFile);
		} finally {
			await snapshot.dispose().catch(() => undefined);
		}
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
			const items = (
				message.params as { items?: Array<{ section?: string }> }
			)?.items;
			const result =
				message.method === "workspace/configuration" &&
				Array.isArray(items)
					? items.map((item) =>
							item?.section === "typescript"
								? this.preferences()
								: null,
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
	if (config) {
		const inProject = await client.projectHover(
			entryFileAbs,
			{ line, column },
			config,
			options,
		);
		if (inProject) return inProject;
	}
	const {
		result: hover,
		text,
		extras,
	} = await client.hover(
		entryFileAbs,
		{ line, column },
		options?.full ?? false,
	);
	if (!hover)
		throw new Error(`No symbol found at ${entryFileAbs}:${line}:${column}`);
	const result = toHoverResult(
		hover,
		text,
		line,
		column,
		options?.include_docs ?? false,
	);
	// The hover text can't tell a callee from its declaration; the syntax
	// can. Calls are reported as `call` with a call signature, as on
	// TypeScript 6.
	if (isCallee(entryFileAbs, line, column)) {
		result.kind = "call";
		result.signature = arrowToCallSignature(result.signature);
	}
	if (extras.overloads) result.overloads = extras.overloads;
	if (extras.unionMembers !== undefined)
		result.unionMembers = extras.unionMembers;
	if (options?.sort_unions) sortResultUnions(result);
	return result;
}

/** Whether the position is on the callee name of a call expression. */
function isCallee(file: string, line: number, column: number): boolean {
	try {
		const node = findNodeAtPosition(parseSource(file), line, column);
		return node !== undefined && ts.isCallExpression(node);
	} catch {
		return false;
	}
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
	const { node, alternatives } = lookupName(
		sourceFile,
		name,
		options?.line,
		file,
	);
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		getNameNode(node).getStart(sourceFile),
	);
	const result = await nativeHover(file, line + 1, character + 1, options);
	if (alternatives) result.alternatives = alternatives;
	return result;
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
	const includeSuggestions = options?.include_suggestions ?? false;
	const client = getNativeClient(root);
	return summarizeDiagnostics(
		entryFileAbs,
		await client.diagnostics(entryFileAbs, config, includeSuggestions),
		includeSuggestions,
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
 * tsconfig itself. An explicit project it would not choose is opened next to
 * its own projects, in the session for the project's directory.
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
		...(parsed.display !== parsed.signature
			? { display: parsed.display }
			: {}),
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
	/** Canonical type text: see HoverResult.signature */
	signature: string;
	/** The hover's code block as the editor shows it */
	display: string;
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
 * Hover labels TypeScript 7 uses where prinfer's kind vocabulary (shared
 * with the TypeScript 6 backend) has another name.
 */
const KIND_ALIASES = new Map([
	["local function", "function"],
	["local var", "var"],
	["local class", "class"],
	["getter", "accessor"],
	["setter", "accessor"],
	["module", "namespace"],
]);

/**
 * Split TypeScript 7 hover markdown into signature and documentation, and
 * read the symbol's kind, name, and return type from the signature. The
 * signature may span lines (expanded object types) and contain nested
 * parentheses and generics, so it is scanned with bracket matching.
 *
 * `display` is the hover text as shown; `signature` is its canonical form
 * (type text only, one line; see HoverResult.signature).
 *
 * @internal Exported for tests.
 */
export function parseHoverMarkdown(markdown: string): ParsedHover {
	const codeMatch = CODE_BLOCK.exec(markdown);
	const display = (codeMatch?.[1] ?? markdown).trim();
	const documentation = codeMatch
		? markdown.slice(codeMatch.index + codeMatch[0].length).trim() ||
			undefined
		: undefined;
	const described = describeSignature(display);
	return {
		display,
		documentation,
		...described,
		kind: KIND_ALIASES.get(described.kind) ?? described.kind,
		signature: singleLine(described.signature),
		...(described.returnType
			? { returnType: singleLine(described.returnType) }
			: {}),
	};
}

function describeSignature(display: string): {
	signature: string;
	kind: string;
	name?: string;
	returnType?: string;
} {
	let rest = display.replace(OVERLOADS, "");
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
	kind ??= display.split(/\s/, 1)[0]?.replace(/[():]/g, "") || "symbol";

	const { name, end, argumentsStart } = readQualifiedName(rest);
	if (end === 0) return { signature: rest, kind };
	switch (kind) {
		case "type":
			return { signature: `type ${rest}`, kind, name };
		case "interface":
		case "class":
		case "enum":
			// The name with its type parameters, as TypeScript 6 prints it.
			return { signature: rest, kind, name };
		case "namespace":
		case "module":
			return { signature: `typeof ${rest.slice(0, end)}`, kind, name };
		case "type parameter":
			return { signature: name ?? rest, kind, name };
		case "enum member":
			// "Color.Red = 0": TypeScript 6 prints the member type, Color.Red.
			return { signature: rest.slice(0, end), kind, name };
	}

	let index = skipSpaces(rest, end);
	if (rest[index] === "?") index++;
	if (rest[index] === "(") {
		// Call signature: name<T>(params): ReturnType
		const signature = rest.slice(argumentsStart ?? index).trim();
		const close = matchBracket(rest, index);
		if (close < 0) return { signature, kind, name };
		const after = skipSpaces(rest, close + 1);
		return {
			signature,
			kind,
			name,
			returnType:
				rest[after] === ":"
					? cleanType(rest.slice(after + 1))
					: undefined,
		};
	}
	if (rest[index] !== ":") return { signature: rest, kind, name };
	// Value with a type: a function type's return type is reported.
	const type = rest.slice(index + 1).trim();
	return {
		signature: type,
		kind,
		name,
		returnType: functionReturnType(type),
	};
}

/**
 * `(x: number) => R` as a call signature, `(x: number): R`; other types are
 * returned unchanged. A hover on a call of a function-typed variable shows
 * the variable's type, while calls report their signature.
 */
export function arrowToCallSignature(type: string): string {
	let index = skipSpaces(type, 0);
	if (type[index] === "<") {
		const close = matchBracket(type, index);
		if (close < 0) return type;
		index = skipSpaces(type, close + 1);
	}
	if (type[index] !== "(") return type;
	const close = matchBracket(type, index);
	if (close < 0) return type;
	const arrow = skipSpaces(type, close + 1);
	if (type.slice(arrow, arrow + 2) !== "=>") return type;
	return `${type.slice(0, close + 1)}: ${type.slice(arrow + 2).trim()}`;
}

/**
 * Read `Array<string>.map<number>` or `Box<T>.value`: identifiers joined by
 * dots, each with optional type arguments. The name is the last identifier.
 */
function readQualifiedName(text: string): {
	name?: string;
	end: number;
	/** Where the last name's type arguments start, if it has any */
	argumentsStart?: number;
} {
	let index = 0;
	let name: string | undefined;
	let argumentsStart: number | undefined;
	while (index < text.length) {
		argumentsStart = undefined;
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
			argumentsStart = index;
			index = close + 1;
		}
		if (text[index] !== ".") break;
		index++;
	}
	return {
		name,
		end: name === undefined ? 0 : index,
		...(argumentsStart !== undefined ? { argumentsStart } : {}),
	};
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

/** UTF-16 offset of a 1-based TypeScript-rules position in `text`. */
function offsetOf(text: string, position: HoverPosition): number {
	return (lineStarts(text)[position.line - 1] ?? 0) + position.column - 1;
}
