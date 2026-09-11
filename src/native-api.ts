import fs from "node:fs";
import path from "node:path";
import type { Node, SourceFile } from "@typescript/native/unstable/ast";
import {
	isArrowFunction,
	isCallExpression,
	isClassDeclaration,
	isFunctionDeclaration,
	isFunctionExpression,
	isIdentifier,
	isInterfaceDeclaration,
	isMethodDeclaration,
	isMethodSignatureDeclaration,
	isParameterDeclaration,
	isPropertyAssignment,
	isPropertyDeclaration,
	isPropertySignatureDeclaration,
	isTypeAliasDeclaration,
	isVariableDeclaration,
} from "@typescript/native/unstable/ast/is";
import {
	API,
	NodeBuilderFlags,
	type Project,
	SignatureKind,
	type Snapshot,
	type Type,
} from "@typescript/native/unstable/async";
import type { CompletionOptions, HoverOptions, HoverResult } from "./types.js";

const sessions = new Map<string, NativeApiSession>();

class NativeApiSession {
	private readonly api: API;
	private readonly projectFile: string | undefined;
	private snapshot: Snapshot | undefined;
	private readonly documents = new Map<string, string>();
	private tail: Promise<void> = Promise.resolve();

	constructor(root: string, projectFile?: string) {
		this.api = new API({ cwd: root });
		this.projectFile = projectFile;
	}

	run<T>(
		file: string,
		operation: (project: Project, sourceFile: SourceFile) => Promise<T>,
	): Promise<T> {
		const result = this.tail.then(() => this.runNow(file, operation));
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async close(): Promise<void> {
		await this.tail;
		await this.snapshot?.dispose();
		this.snapshot = undefined;
		this.documents.clear();
		await this.api.close();
	}

	private async runNow<T>(
		file: string,
		operation: (project: Project, sourceFile: SourceFile) => Promise<T>,
	): Promise<T> {
		const text = fs.readFileSync(file, "utf8");
		const previousText = this.documents.get(file);
		if (!this.snapshot || previousText !== text) {
			const previousSnapshot = this.snapshot;
			this.snapshot = await this.api.updateSnapshot(
				previousText === undefined
					? {
							openFiles: [file],
							...(!previousSnapshot && this.projectFile
								? { openProjects: [this.projectFile] }
								: {}),
						}
					: { fileChanges: { changed: [file] } },
			);
			this.documents.set(file, text);
			await previousSnapshot?.dispose();
		}

		const snapshot = this.snapshot;
		const project = this.projectFile
			? snapshot.getProject(this.projectFile)
			: await snapshot.getDefaultProjectForFile(file);
		if (!project) {
			throw new Error(
				`Could not load source file into a TypeScript 7 project: ${file}`,
			);
		}
		const sourceFile = await project.program.getSourceFile(file);
		if (!sourceFile) {
			throw new Error(
				`Could not load source file into the TypeScript 7 program: ${file}`,
			);
		}
		return operation(project, sourceFile);
	}
}

export async function nativeApiCompletionNames(
	file: string,
	line: number,
	column: number,
	options?: CompletionOptions,
): Promise<string[]> {
	const entryFileAbs = resolveFile(file);
	const text = fs.readFileSync(entryFileAbs, "utf8");
	const position = sourcePosition(entryFileAbs, text, line, column);
	return getSession(entryFileAbs, options?.project).run(
		entryFileAbs,
		async ({ checker }) => {
			const completions = await checker.getCompletionsAtPosition(
				entryFileAbs,
				position,
			);
			return completions?.entries.map((entry) => entry.name) ?? [];
		},
	);
}

export async function nativeApiTypeInfo(
	file: string,
	line: number,
	column: number,
	options?: HoverOptions,
): Promise<HoverResult> {
	const entryFileAbs = resolveFile(file);
	const text = fs.readFileSync(entryFileAbs, "utf8");
	const position = sourcePosition(entryFileAbs, text, line, column);
	return getSession(entryFileAbs, options?.project).run(
		entryFileAbs,
		async (project, sourceFile) => {
			const resolutionStarted = performance.now();
			const type = await project.checker.getTypeAtPosition(
				entryFileAbs,
				position,
			);
			if (!type) {
				throw new Error(
					`No symbol found at ${entryFileAbs}:${line}:${column}`,
				);
			}
			const node = findNodeAtPosition(sourceFile, position);
			const result = await typeInfo(project, type, node, {
				...options,
				line,
				column,
			});
			if (options?.include_timing) {
				result.timing = {
					resolution_ms: roundMs(
						performance.now() - resolutionStarted,
					),
				};
			}
			return result;
		},
	);
}

export async function nativeApiTypeInfoByName(
	file: string,
	name: string,
	options?: HoverOptions & { line?: number },
): Promise<HoverResult> {
	const entryFileAbs = resolveFile(file);
	return getSession(entryFileAbs, options?.project).run(
		entryFileAbs,
		async (project, sourceFile) => {
			const node = findNamedNode(sourceFile, name, options?.line);
			if (!node) {
				const lineInfo = options?.line
					? ` at line ${options.line}`
					: "";
				throw new Error(
					`No symbol named "${name}"${lineInfo} found in ${entryFileAbs}`,
				);
			}
			const location = nodeName(node) ?? node;
			const resolutionStarted = performance.now();
			const type = await project.checker.getTypeAtLocation(location);
			if (!type) {
				throw new Error(
					`No type found for "${name}" in ${entryFileAbs}`,
				);
			}
			const start = node.getStart(sourceFile);
			const position = sourceFile.getLineAndCharacterOfPosition(start);
			const result = await typeInfo(project, type, node, {
				...options,
				line: position.line + 1,
				column: position.character + 1,
			});
			if (options?.include_timing) {
				result.timing = {
					resolution_ms: roundMs(
						performance.now() - resolutionStarted,
					),
				};
			}
			return result;
		},
	);
}

export async function closeNativeApiSessions(): Promise<void> {
	const active = [...sessions.values()];
	sessions.clear();
	await Promise.all(active.map((session) => session.close()));
}

async function typeInfo(
	project: Project,
	type: Type,
	node: Node | undefined,
	options: HoverOptions & { line: number; column: number },
): Promise<HoverResult> {
	const flags =
		(options.full ? NodeBuilderFlags.NoTruncation : NodeBuilderFlags.None) |
		(node && isTypeAliasDeclaration(node)
			? NodeBuilderFlags.InTypeAlias
			: NodeBuilderFlags.None);
	const displayedType = await project.checker.typeToString(
		type,
		undefined,
		flags,
	);
	const name = node ? nodeNameText(node) : undefined;
	const signature =
		node && isTypeAliasDeclaration(node) && name
			? `type ${name} = ${displayedType}`
			: displayedType;
	const result: HoverResult = {
		signature,
		line: options.line,
		column: options.column,
		kind: node ? nodeKind(node) : "symbol",
		name,
	};

	if (options.include_docs && node) {
		const symbol = await project.checker.getSymbolAtLocation(
			nodeName(node) ?? node,
		);
		if (symbol) {
			const documentation =
				await project.checker.getDocumentationCommentOfSymbol(symbol);
			if (documentation) result.documentation = documentation;
		}
	}

	if (result.kind === "function" || result.kind === "method") {
		const signatures = await project.checker.getSignaturesOfType(
			type,
			SignatureKind.Call,
		);
		const first = signatures[0];
		if (first) {
			const returnType =
				await project.checker.getReturnTypeOfSignature(first);
			if (returnType) {
				result.returnType = await project.checker.typeToString(
					returnType,
					undefined,
					flags,
				);
			}
		}
	}

	return result;
}

function getSession(file: string, project?: string): NativeApiSession {
	const resolved = resolveProject(file, project);
	let session = sessions.get(resolved.key);
	if (!session) {
		session = new NativeApiSession(resolved.root, resolved.projectFile);
		sessions.set(resolved.key, session);
	}
	return session;
}

function resolveFile(file: string): string {
	const resolved = path.resolve(process.cwd(), file);
	if (!fs.existsSync(resolved))
		throw new Error(`File not found: ${resolved}`);
	return resolved;
}

function resolveProject(
	file: string,
	project?: string,
): { key: string; root: string; projectFile?: string } {
	if (!project) {
		const root = findConfigRoot(path.dirname(file));
		return { key: root, root };
	}
	const resolved = path.resolve(process.cwd(), project);
	const projectFile = fs.statSync(resolved).isDirectory()
		? path.join(resolved, "tsconfig.json")
		: resolved;
	if (!fs.existsSync(projectFile)) {
		throw new Error(`TypeScript project not found: ${projectFile}`);
	}
	return {
		key: projectFile,
		root: path.dirname(projectFile),
		projectFile,
	};
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

function sourcePosition(
	file: string,
	text: string,
	line: number,
	column: number,
): number {
	if (
		!Number.isInteger(line) ||
		!Number.isInteger(column) ||
		line < 1 ||
		column < 1
	) {
		throw new Error("Line and column must be positive integers.");
	}
	let lineStart = 0;
	for (let current = 1; current < line; current += 1) {
		const newline = text.indexOf("\n", lineStart);
		if (newline < 0)
			throw new Error(`No cursor position at ${file}:${line}:${column}`);
		lineStart = newline + 1;
	}
	const newline = text.indexOf("\n", lineStart);
	const rawLineEnd = newline < 0 ? text.length : newline;
	const lineEnd = text[rawLineEnd - 1] === "\r" ? rawLineEnd - 1 : rawLineEnd;
	const position = lineStart + column - 1;
	if (position > lineEnd) {
		throw new Error(`No cursor position at ${file}:${line}:${column}`);
	}
	return position;
}

function findNamedNode(
	sourceFile: SourceFile,
	name: string,
	line?: number,
): Node | undefined {
	let found: Node | undefined;
	const visit = (node: Node): void => {
		if (found) return;
		if (isSupportedDeclaration(node) && nodeNameText(node) === name) {
			const position = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile),
			);
			if (line === undefined || position.line + 1 === line) {
				found = node;
				return;
			}
		}
		node.forEachChild(visit);
	};
	visit(sourceFile);
	return found;
}

function findNodeAtPosition(
	sourceFile: SourceFile,
	position: number,
): Node | undefined {
	let found: Node | undefined;
	const visit = (node: Node): void => {
		if (position < node.getStart(sourceFile) || position >= node.getEnd())
			return;
		found = node;
		node.forEachChild(visit);
	};
	visit(sourceFile);

	for (
		let current = found;
		current && current !== sourceFile;
		current = current.parent
	) {
		if (!isSupportedDeclaration(current)) continue;
		const name = nodeName(current);
		if (
			name &&
			position >= name.getStart(sourceFile) &&
			position < name.getEnd()
		) {
			return current;
		}
	}
	return found;
}

function isSupportedDeclaration(node: Node): boolean {
	return (
		isVariableDeclaration(node) ||
		isFunctionDeclaration(node) ||
		isMethodDeclaration(node) ||
		isMethodSignatureDeclaration(node) ||
		isPropertyDeclaration(node) ||
		isPropertySignatureDeclaration(node) ||
		isPropertyAssignment(node) ||
		isParameterDeclaration(node) ||
		isTypeAliasDeclaration(node) ||
		isInterfaceDeclaration(node) ||
		isClassDeclaration(node)
	);
}

function nodeName(node: Node): Node | undefined {
	return (node as Node & { name?: Node }).name;
}

function nodeNameText(node: Node): string | undefined {
	if (isIdentifier(node)) return node.text;
	const name = nodeName(node);
	return name && isIdentifier(name) ? name.text : undefined;
}

function nodeKind(node: Node): string {
	if (isIdentifier(node) && node.parent !== node)
		return nodeKind(node.parent);
	if (isTypeAliasDeclaration(node)) return "type";
	if (isInterfaceDeclaration(node)) return "interface";
	if (isClassDeclaration(node)) return "class";
	if (isMethodDeclaration(node) || isMethodSignatureDeclaration(node))
		return "method";
	if (isPropertyDeclaration(node) || isPropertySignatureDeclaration(node))
		return "property";
	if (isParameterDeclaration(node)) return "parameter";
	if (isCallExpression(node)) return "call";
	if (isFunctionDeclaration(node)) return "function";
	if (isVariableDeclaration(node)) {
		return node.initializer &&
			(isArrowFunction(node.initializer) ||
				isFunctionExpression(node.initializer))
			? "function"
			: "variable";
	}
	return "symbol";
}

function roundMs(value: number): number {
	return Math.round(value * 100) / 100;
}
