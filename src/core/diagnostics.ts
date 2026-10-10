import fs from "node:fs";
import path from "node:path";
import type {
	DiagnosticCategory,
	DiagnosticsResult,
	FileDiagnostic,
} from "../types.js";
import { createProgramLanguageService, loadProgram } from "./program.js";
import { ts } from "./ts-runtime.js";

/** Collect syntactic and semantic diagnostics for one file. */
export function getFileDiagnostics(
	file: string,
	project?: string,
	includeSuggestions = false,
): DiagnosticsResult {
	const entryFileAbs = path.resolve(process.cwd(), file);
	if (!fs.existsSync(entryFileAbs)) {
		throw new Error(`File not found: ${entryFileAbs}`);
	}

	const program = loadProgram(entryFileAbs, project);
	const sourceFile = program.getSourceFile(entryFileAbs);
	if (!sourceFile) {
		throw new Error(
			`Could not load source file into the program (check tsconfig include/exclude): ${entryFileAbs}`,
		);
	}

	const raw: ts.Diagnostic[] = [
		...program.getSyntacticDiagnostics(sourceFile),
		...program.getSemanticDiagnostics(sourceFile),
	];
	if (includeSuggestions) {
		const service = createProgramLanguageService(program);
		try {
			raw.push(...service.getSuggestionDiagnostics(entryFileAbs));
		} finally {
			service.dispose();
		}
	}

	const diagnostics = raw.map((diagnostic) =>
		toFileDiagnostic(diagnostic, sourceFile),
	);
	return summarizeDiagnostics(entryFileAbs, diagnostics, includeSuggestions);
}

/**
 * Filter, sort, and count diagnostics. Without includeSuggestions only errors
 * and warnings are kept.
 */
export function summarizeDiagnostics(
	file: string,
	diagnostics: FileDiagnostic[],
	includeSuggestions: boolean,
): DiagnosticsResult {
	const kept = diagnostics
		.filter(
			(diagnostic) =>
				includeSuggestions ||
				diagnostic.category === "error" ||
				diagnostic.category === "warning",
		)
		.sort(
			(left, right) =>
				left.line - right.line ||
				left.column - right.column ||
				left.code - right.code,
		);
	return {
		file,
		diagnostics: kept,
		errorCount: kept.filter((diagnostic) => diagnostic.category === "error")
			.length,
		warningCount: kept.filter(
			(diagnostic) => diagnostic.category === "warning",
		).length,
	};
}

/**
 * Render diagnostics as compact `path:line:col error TS2322: message` lines,
 * tsc-style, or "No type errors." when nothing was reported. Continuation
 * lines of a message chain keep TypeScript's nesting, with the first level
 * indented two spaces as tsc prints it.
 */
export function formatDiagnostics(
	result: DiagnosticsResult,
	displayPath: string = result.file,
): string {
	if (result.diagnostics.length === 0) return "No type errors.";
	const lines = result.diagnostics.map(
		(diagnostic) =>
			`${displayPath}:${diagnostic.line}:${diagnostic.column} ${diagnostic.category} TS${diagnostic.code}: ${indentContinuation(diagnostic.message)}`,
	);
	lines.push(
		`${plural(result.errorCount, "error")}, ${plural(result.warningCount, "warning")}.`,
	);
	return lines.join("\n");
}

const CONTINUATION_INDENT = 2;

/**
 * Shift continuation lines so the shallowest one is indented exactly
 * CONTINUATION_INDENT spaces, keeping deeper lines' relative nesting.
 */
function indentContinuation(message: string): string {
	const [first = "", ...rest] = message.split(/\r?\n/);
	const continuation = rest.filter((line) => line.trim() !== "");
	if (continuation.length === 0) return first;
	const base = Math.min(
		...continuation.map((line) => line.length - line.trimStart().length),
	);
	const pad = " ".repeat(CONTINUATION_INDENT);
	return [
		first,
		...continuation.map((line) => `${pad}${line.slice(base)}`),
	].join("\n");
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function toFileDiagnostic(
	diagnostic: ts.Diagnostic,
	sourceFile: ts.SourceFile,
): FileDiagnostic {
	const startPos = diagnostic.start ?? 0;
	const endPos = startPos + (diagnostic.length ?? 0);
	const start = sourceFile.getLineAndCharacterOfPosition(startPos);
	const end = sourceFile.getLineAndCharacterOfPosition(endPos);
	return {
		line: start.line + 1,
		column: start.character + 1,
		endLine: end.line + 1,
		endColumn: end.character + 1,
		code: diagnostic.code,
		category: categoryName(diagnostic.category),
		message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
		source: diagnostic.source ?? "ts",
	};
}

function categoryName(category: ts.DiagnosticCategory): DiagnosticCategory {
	switch (category) {
		case ts.DiagnosticCategory.Error:
			return "error";
		case ts.DiagnosticCategory.Warning:
			return "warning";
		case ts.DiagnosticCategory.Suggestion:
			return "suggestion";
		default:
			return "message";
	}
}
