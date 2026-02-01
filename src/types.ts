/**
 * Options for type inference
 */
export interface Options {
	/** Path to the TypeScript file */
	file: string;
	/** Name of the function/variable to inspect */
	name: string;
	/** Optional line number to narrow search */
	line?: number;
	/** Optional path to tsconfig.json */
	project?: string;
}

/**
 * Result of type inference
 */
export interface InferredTypeResult {
	/** The inferred type signature */
	signature: string;
	/** The return type (for functions) */
	returnType?: string;
	/** The line number where the symbol was found */
	line?: number;
}

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
