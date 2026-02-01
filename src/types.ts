/**
 * Options for hover lookup
 */
export interface HoverOptions {
	/** Optional path to tsconfig.json */
	project?: string;
	/** Include JSDoc/TSDoc documentation */
	include_docs?: boolean;
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
}

/**
 * Options for hover lookup by name
 */
export interface HoverByNameOptions extends HoverOptions {
	/** Optional line number to narrow search */
	line?: number;
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
	/** Error message if failed */
	error?: string;
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
