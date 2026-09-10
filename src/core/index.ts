// Re-export all public functions from core modules

export { getDocumentation, getHoverInfo } from "./hover.js";
export {
	findFirstMatch,
	findNodeAtPosition,
	findNodeByNameAndLine,
} from "./node-find.js";
export { getLineNumber } from "./node-match.js";
export {
	clearProgramCache,
	findNearestTsconfig,
	invalidateProgramCache,
	loadProgram,
} from "./program.js";
export { getTypeInfo, type InferredTypeResult } from "./type-info.js";
