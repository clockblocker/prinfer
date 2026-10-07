import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { summarizeDiagnostics } from "./core/diagnostics.js";
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

interface LspHover {
	contents:
		| string
		| { kind: string; value: string }
		| Array<string | { language?: string; value: string }>;
	range?: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

interface LspRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
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
	text: string;
	version: number;
	signature?: string;
}

const require = createRequire(resolveFromScript());
const nativePackage = require.resolve("@typescript/native/package.json");
const nativeTsc = path.join(path.dirname(nativePackage), "bin", "tsc");
const sessions = new Map<string, NativeLspClient>();
// Bound the per-diagnostics workspace scan (~12 µs per file). Larger projects
// fall back to the language server's own file watcher, which lags edits to
// unopened files by ~100 ms.
const MAX_TRACKED_FILES = 5000;
const TRACKED_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/;

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
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private stderr = "";
	private supportsPullDiagnostics = false;
	private workspaceFiles: Map<string, string> | undefined;
	private readonly root: string;
	readonly ready: Promise<void>;

	constructor(root: string) {
		this.root = root;
		this.child = spawn(process.execPath, [nativeTsc, "--lsp", "--stdio"], {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Baseline for syncWorkspaceFiles; taken while the server boots.
		this.workspaceFiles = scanWorkspaceFiles(root);
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
			capabilities: {},
			workspaceFolders: null,
		}).then((result) => {
			this.supportsPullDiagnostics = Boolean(
				(result as { capabilities?: { diagnosticProvider?: unknown } })
					?.capabilities?.diagnosticProvider,
			);
			this.notify("initialized", {});
		});
	}

	async hover(
		file: string,
		position: HoverPosition,
	): Promise<{ result: LspHover | null; resolutionMs: number }> {
		await this.ready;
		const uri = pathToFileURL(file).href;
		this.openOrUpdate(uri, file);
		const resolutionStarted = performance.now();
		const result = (await this.request("textDocument/hover", {
			textDocument: { uri },
			position: {
				line: position.line - 1,
				character: position.column - 1,
			},
		})) as LspHover | null;
		return {
			result,
			resolutionMs: roundMs(performance.now() - resolutionStarted),
		};
	}

	async diagnostics(file: string): Promise<LspDiagnostic[]> {
		await this.ready;
		if (!this.supportsPullDiagnostics) {
			throw new Error(
				"TypeScript 7 language server does not support pull diagnostics",
			);
		}
		const uri = pathToFileURL(file).href;
		this.syncWorkspaceFiles();
		this.openOrUpdate(uri, file);
		const report = (await this.request("textDocument/diagnostic", {
			textDocument: { uri },
		})) as LspDocumentDiagnosticReport | null;
		// No previousResultId is sent, so the server must answer with a full
		// report; treat anything else as an empty result.
		return report?.kind === "full" ? (report.items ?? []) : [];
	}

	close(): void {
		this.child.kill();
	}

	/**
	 * Open the requested file and push on-disk edits for every document this
	 * client already opened. Open documents shadow the disk in the language
	 * server, so a stale dependency would otherwise produce stale results.
	 */
	private openOrUpdate(uri: string, file: string): void {
		for (const [openUri, document] of this.documents) {
			if (openUri !== uri) this.refresh(openUri, document);
		}
		const current = this.documents.get(uri);
		if (!current) {
			const signature = statSignature(file);
			const text = fs.readFileSync(file, "utf8");
			this.documents.set(uri, { file, text, version: 1, signature });
			this.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: languageId(file),
					version: 1,
					text,
				},
			});
			return;
		}
		this.refresh(uri, current, true);
	}

	/**
	 * Report on-disk creates, edits, and deletes since the previous scan. The
	 * server's built-in watcher sees them too, but only after a delay, so a
	 * check right after an edit to an imported file would otherwise be stale.
	 */
	private syncWorkspaceFiles(): void {
		const previous = this.workspaceFiles;
		// Over MAX_TRACKED_FILES: leave change detection to the server.
		if (!previous) return;
		const current = scanWorkspaceFiles(this.root);
		this.workspaceFiles = current;
		if (!current) return;
		const changes: Array<{ uri: string; type: 1 | 2 | 3 }> = [];
		for (const [file, signature] of current) {
			const before = previous.get(file);
			if (before === signature) continue;
			changes.push({
				uri: pathToFileURL(file).href,
				type: before === undefined ? 1 : 2,
			});
		}
		for (const file of previous.keys()) {
			if (!current.has(file))
				changes.push({ uri: pathToFileURL(file).href, type: 3 });
		}
		if (changes.length > 0)
			this.notify("workspace/didChangeWatchedFiles", { changes });
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
		const text = fs.readFileSync(document.file, "utf8");
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
	const root = resolveRoot(entryFileAbs, options?.project);
	const client = getNativeClient(root);
	const { result: hover, resolutionMs } = await client.hover(entryFileAbs, {
		line,
		column,
	});
	if (!hover)
		throw new Error(`No symbol found at ${entryFileAbs}:${line}:${column}`);
	const result = toHoverResult(
		hover,
		line,
		column,
		options?.include_docs ?? false,
	);
	if (options?.include_timing) {
		result.timing = { resolution_ms: resolutionMs };
	}
	return result;
}

export async function nativeHoverByName(
	file: string,
	name: string,
	options?: HoverOptions & { line?: number },
): Promise<HoverResult> {
	const entryFileAbs = path.resolve(process.cwd(), file);
	if (!fs.existsSync(entryFileAbs))
		throw new Error(`File not found: ${entryFileAbs}`);
	const lines = fs.readFileSync(entryFileAbs, "utf8").split(/\r?\n/);
	const candidates = options?.line
		? ([[options.line - 1, lines[options.line - 1] ?? ""]] as const)
		: lines.map((text, index) => [index, text] as const);
	const pattern = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}([^\\w$]|$)`);
	for (const [index, text] of candidates) {
		const match = pattern.exec(text);
		if (match) {
			return nativeHover(
				file,
				index + 1,
				match.index + match[1].length + 1,
				options,
			);
		}
	}
	const lineInfo = options?.line ? ` at line ${options.line}` : "";
	throw new Error(`No symbol named "${name}"${lineInfo} found in ${file}`);
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
	const root = resolveRoot(entryFileAbs, options?.project);
	const client = getNativeClient(root);
	const items = await client.diagnostics(entryFileAbs);
	return summarizeDiagnostics(
		entryFileAbs,
		items.map(toFileDiagnostic),
		options?.include_suggestions ?? false,
	);
}

export function closeNativeSessions(): void {
	for (const client of sessions.values()) client.close();
	sessions.clear();
}

function getNativeClient(root: string): NativeLspClient {
	let client = sessions.get(root);
	if (!client) {
		client = new NativeLspClient(root);
		sessions.set(root, client);
	}
	return client;
}

function resolveRoot(file: string, project?: string): string {
	if (!project) return findConfigRoot(path.dirname(file));
	const resolved = path.resolve(process.cwd(), project);
	return path.dirname(
		fs.statSync(resolved).isDirectory()
			? path.join(resolved, "tsconfig.json")
			: resolved,
	);
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

/**
 * Stat signatures for source and JSON files under root, skipping node_modules
 * and dot-directories. Returns undefined when the project is too large.
 */
function scanWorkspaceFiles(root: string): Map<string, string> | undefined {
	const files = new Map<string, string>();
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (
					entry.name !== "node_modules" &&
					!entry.name.startsWith(".")
				)
					pending.push(entryPath);
				continue;
			}
			if (!entry.isFile() || !TRACKED_EXTENSION.test(entry.name))
				continue;
			const signature = statSignature(entryPath);
			if (!signature) continue;
			files.set(entryPath, signature);
			if (files.size > MAX_TRACKED_FILES) return undefined;
		}
	}
	return files;
}

function statSignature(file: string): string | undefined {
	try {
		const stat = fs.statSync(file);
		return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
	} catch {
		return undefined;
	}
}

function toFileDiagnostic(diagnostic: LspDiagnostic): FileDiagnostic {
	const code =
		typeof diagnostic.code === "number"
			? diagnostic.code
			: Number.parseInt(String(diagnostic.code ?? "0"), 10) || 0;
	return {
		line: diagnostic.range.start.line + 1,
		column: diagnostic.range.start.character + 1,
		endLine: diagnostic.range.end.line + 1,
		endColumn: diagnostic.range.end.character + 1,
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
	line: number,
	column: number,
	includeDocs: boolean,
): HoverResult {
	const markdown = hoverContents(hover.contents);
	const codeMatch =
		/```(?:typescript|tsx|javascript|jsx)?\s*\n([\s\S]*?)```/.exec(
			markdown,
		);
	const signature = (codeMatch?.[1] ?? markdown).trim();
	const documentation = codeMatch
		? markdown.slice((codeMatch.index ?? 0) + codeMatch[0].length).trim()
		: undefined;
	const name =
		/\b(?:function|class|interface|type|const|let|var|method|property)\s+([\w$]+)/.exec(
			signature,
		)?.[1];
	const returnType = /\)\s*(?::|=>)\s*([^\n{;]+)/
		.exec(signature)?.[1]
		?.trim();
	return {
		signature,
		returnType,
		line: hover.range ? hover.range.start.line + 1 : line,
		column: hover.range ? hover.range.start.character + 1 : column,
		documentation: includeDocs && documentation ? documentation : undefined,
		kind: signature.split(/\s/, 1)[0]?.replace(/[():]/g, "") || "symbol",
		name,
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function roundMs(value: number): number {
	return Math.round(value * 1000) / 1000;
}
