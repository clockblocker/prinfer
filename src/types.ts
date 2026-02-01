/**
 * Options for type inference
 */
export interface Options {
	/** Path to the TypeScript file */
	file: string;
	/** Name of the function/variable to inspect */
	name: string;
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
}
