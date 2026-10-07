import fs from "node:fs";
import path from "node:path";
import type { CompletionResult } from "../types.js";
import { createProgramLanguageService, loadProgram } from "./program.js";

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

	const service = createProgramLanguageService(program);
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
