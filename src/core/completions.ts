import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import type { CompletionResult } from "../types.js";
import { loadProgram } from "./program.js";

/** Return the completion entries TypeScript would offer at a 1-based cursor position. */
export function getCompletions(
	file: string,
	line: number,
	column: number,
	project?: string,
): CompletionResult {
	const entryFileAbs = path.resolve(process.cwd(), file);
	if (!fs.existsSync(entryFileAbs)) {
		throw new Error(`File not found: ${entryFileAbs}`);
	}
	if (
		!Number.isInteger(line) ||
		!Number.isInteger(column) ||
		line < 1 ||
		column < 1
	) {
		throw new Error(
			"Completion line and column must be positive integers.",
		);
	}

	const program = loadProgram(entryFileAbs, project);
	const sourceFile = program.getSourceFile(entryFileAbs);
	if (!sourceFile) {
		throw new Error(
			`Could not load source file into the program (check tsconfig include/exclude): ${entryFileAbs}`,
		);
	}
	const lineStart = sourceFile.getPositionOfLineAndCharacter(line - 1, 0);
	const lineEnd = sourceFile.getLineEndOfPosition(lineStart);
	const position = lineStart + column - 1;
	if (position > lineEnd) {
		throw new Error(
			`No cursor position at ${entryFileAbs}:${line}:${column}`,
		);
	}

	const versions = new Map(
		program.getSourceFiles().map((source) => [source.fileName, "0"]),
	);
	const host: ts.LanguageServiceHost = {
		getCompilationSettings: () => program.getCompilerOptions(),
		getScriptFileNames: () => [...program.getRootFileNames()],
		getScriptVersion: (fileName) => versions.get(fileName) ?? "0",
		getScriptSnapshot: (fileName) => {
			const text = ts.sys.readFile(fileName);
			return text === undefined
				? undefined
				: ts.ScriptSnapshot.fromString(text);
		},
		getCurrentDirectory: () => process.cwd(),
		getDefaultLibFileName: ts.getDefaultLibFilePath,
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		realpath: ts.sys.realpath,
	};
	const service = ts.createLanguageService(host);
	try {
		const info = service.getCompletionsAtPosition(entryFileAbs, position, {
			includeCompletionsForModuleExports: true,
			includeCompletionsWithInsertText: true,
		});
		return {
			file: entryFileAbs,
			line,
			column,
			isGlobalCompletion: info?.isGlobalCompletion ?? false,
			isMemberCompletion: info?.isMemberCompletion ?? false,
			isNewIdentifierLocation: info?.isNewIdentifierLocation ?? false,
			entries: (info?.entries ?? []).map((entry) => ({
				name: entry.name,
				kind: entry.kind,
				sortText: entry.sortText,
				...(entry.insertText === undefined
					? {}
					: { insertText: entry.insertText }),
				...(entry.source === undefined ? {} : { source: entry.source }),
			})),
		};
	} finally {
		service.dispose();
	}
}
