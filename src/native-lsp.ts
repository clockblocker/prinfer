import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HoverOptions, HoverPosition, HoverResult } from "./types.js";

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

interface OpenDocument {
	text: string;
	version: number;
}

const require = createRequire(
	process.argv[1]
		? path.resolve(process.argv[1])
		: path.join(process.cwd(), "package.json"),
);
const nativePackage = require.resolve("@typescript/native/package.json");
const nativeTsc = path.join(path.dirname(nativePackage), "bin", "tsc");
const sessions = new Map<string, NativeLspClient>();

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
	readonly ready: Promise<void>;

	constructor(root: string) {
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
			capabilities: {},
			workspaceFolders: null,
		}).then(() => {
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

	close(): void {
		this.child.kill();
	}

	private openOrUpdate(uri: string, file: string): void {
		const text = fs.readFileSync(file, "utf8");
		const current = this.documents.get(uri);
		if (!current) {
			this.documents.set(uri, { text, version: 1 });
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
		if (current.text === text) return;
		current.text = text;
		current.version += 1;
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: current.version },
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
