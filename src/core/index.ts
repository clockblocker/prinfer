// Re-export all public functions from core modules

export {
	type CompletionRefinement,
	formatCompletions,
	getCompletions,
	rankCompletions,
} from "./completions.js";
export {
	formatDiagnostics,
	getFileDiagnostics,
	summarizeDiagnostics,
} from "./diagnostics.js";
export {
	countUnionMembers,
	getDocumentation,
	getHoverInfo,
	getSymbolKind,
} from "./hover.js";
export {
	assertCursorPosition,
	fromLspPosition,
	type LineCharacter,
	lineStarts,
	splitLines,
	stripBom,
	toLspPosition,
} from "./lines.js";
export {
	alternativeDeclarations,
	declarationLocation,
	findDeclarationsByName,
	lookupName,
	MAX_ALTERNATIVES,
	type NameLookup,
	NameNotFoundError,
	nameNotFoundError,
} from "./name-lookup.js";
export {
	findFirstMatch,
	findNodeAtPosition,
	findNodeByNameAndLine,
} from "./node-find.js";
export { getLineNumber } from "./node-match.js";
export {
	clearProgramCache,
	createProgramLanguageService,
	findNearestTsconfig,
	invalidateProgramCache,
	loadProgram,
} from "./program.js";
export { singleLine } from "./signature-text.js";
export { resolveTextColumn, type TextTarget } from "./text-target.js";
export { getTypeInfo, type InferredTypeResult } from "./type-info.js";
