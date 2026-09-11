/**
 * Options for hover lookup
 */
export interface HoverOptions {
	/** Optional path to tsconfig.json */
	project?: string;
	/** Include JSDoc/TSDoc documentation */
	include_docs?: boolean;
	/** Include the hovered symbol's type-resolution timing */
	include_timing?: boolean;
	/** Disable editor-style type truncation */
	full?: boolean;
	/** Experimental inference backend. Defaults to PRINFER_BACKEND or typescript7. */
	backend?: "typescript6" | "typescript7";
}

export interface HoverTiming {
	/** Time spent resolving the hovered symbol's type */
	resolution_ms: number;
}

/**
 * Result of hover lookup at a position
 */
export interface HoverResult {
	/** The type signature */
	signature: string;
	/** The return type (for functions) */
	returnType?: string;
	/** 1-based line number */
	line: number;
	/** 1-based column number */
	column: number;
	/** JSDoc/TSDoc documentation if requested */
	documentation?: string;
	/** Symbol kind (function, variable, method, etc.) */
	kind: string;
	/** Symbol name if available */
	name?: string;
	/** Present when include_timing is true */
	timing?: HoverTiming;
}

/**
 * Options for hover lookup by name
 */
export interface HoverByNameOptions extends HoverOptions {
	/** Optional line number to narrow search */
	line?: number;
}

export interface CompletionOptions {
	/** Optional path to tsconfig.json */
	project?: string;
}

export interface CompletionEntry {
	name: string;
	kind: string;
	sortText: string;
	insertText?: string;
	source?: string;
}

export interface CompletionResult {
	file: string;
	line: number;
	column: number;
	isGlobalCompletion: boolean;
	isMemberCompletion: boolean;
	isNewIdentifierLocation: boolean;
	entries: CompletionEntry[];
}

/**
 * Position for batch hover lookup
 */
export interface HoverPosition {
	/** 1-based line number */
	line: number;
	/** 1-based column number */
	column: number;
}

/**
 * Single item result in a batch hover operation
 */
export interface BatchHoverItem {
	/** The position that was queried */
	position: HoverPosition;
	/** The hover result if successful */
	result?: HoverResult;
	/** Structured error if the lookup failed */
	error?: {
		code:
			| "INVALID_ARGUMENT"
			| "FILE_NOT_FOUND"
			| "SYMBOL_NOT_FOUND"
			| "TYPESCRIPT_ERROR"
			| "INTERNAL_ERROR";
		message: string;
		file?: string;
		line?: number;
		column?: number;
		project?: string;
		candidates?: string[];
		suggestion?: string;
	};
}

/**
 * Result of a batch hover operation
 */
export interface BatchHoverResult {
	/** Array of results for each position */
	items: BatchHoverItem[];
	/** Number of successful lookups */
	successCount: number;
	/** Number of failed lookups */
	errorCount: number;
}
