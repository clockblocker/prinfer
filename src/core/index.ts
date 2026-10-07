// Re-export all public functions from core modules

export { getCompletions } from "./completions.js";
export {
	formatDiagnostics,
	getFileDiagnostics,
	summarizeDiagnostics,
} from "./diagnostics.js";
export { getDocumentation, getHoverInfo } from "./hover.js";
export {
	fromLspPosition,
	type LineCharacter,
	lineStarts,
	splitLines,
	stripBom,
	toLspPosition,
} from "./lines.js";
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
export { resolveTextColumn, type TextTarget } from "./text-target.js";
export { getTypeInfo, type InferredTypeResult } from "./type-info.js";
