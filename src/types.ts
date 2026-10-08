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
	/** Keep only entries whose name starts with this text (case-insensitive) */
	prefix?: string;
	/** Return at most this many entries (default: all); `total` counts every match */
	limit?: number;
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
	/** The case-insensitive name prefix the entries were filtered by, if any */
	prefix?: string;
	/** Entries in rank order, at most `limit` of them */
	entries: CompletionEntry[];
	/** Number of matching entries before truncation to `limit` */
	total: number;
	/** True when `entries` holds fewer than `total` */
	truncated: boolean;
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

export interface DiagnosticsOptions {
	/** Optional path to tsconfig.json */
	project?: string;
	/** Also return suggestion and message diagnostics, such as unused-variable hints */
	include_suggestions?: boolean;
}

export type DiagnosticCategory = "error" | "warning" | "suggestion" | "message";

/** A single TypeScript diagnostic reported for a file */
export interface FileDiagnostic {
	/** 1-based start line */
	line: number;
	/** 1-based start column */
	column: number;
	/** 1-based end line */
	endLine: number;
	/** 1-based end column (exclusive) */
	endColumn: number;
	/** TypeScript diagnostic code, e.g. 2322 for TS2322 */
	code: number;
	category: DiagnosticCategory;
	/** Diagnostic text; message chains are flattened into indented lines */
	message: string;
	/** Diagnostic producer, usually "ts" */
	source?: string;
}

/** Syntactic and semantic diagnostics for one file */
export interface DiagnosticsResult {
	/** Absolute path of the checked file */
	file: string;
	/** Diagnostics sorted by position */
	diagnostics: FileDiagnostic[];
	errorCount: number;
	warningCount: number;
}

export interface AnnotationsOptions {
	/** Optional path to tsconfig.json */
	project?: string;
}

/**
 * redundant: removing the annotation keeps exactly the same type.
 * widening: the annotation is wider than the type TypeScript would infer.
 */
export type AnnotationKind = "redundant" | "widening";

/** What the annotation is on */
export type AnnotationTarget = "variable" | "parameter" | "property" | "return";

/** An explicit type annotation compared with the type TypeScript would infer */
export interface AnnotationFinding {
	/** 1-based start of the `: Type` text that removing the annotation deletes */
	line: number;
	column: number;
	/** 1-based end (exclusive) of that text */
	endLine: number;
	endColumn: number;
	/** The annotated variable, parameter, property, or function */
	name: string;
	target: AnnotationTarget;
	kind: AnnotationKind;
	/** The annotated type (for return, the declared return type) */
	declared: string;
	/** The type TypeScript infers without the annotation */
	inferred: string;
	/** Part of the module's exported API */
	exported: boolean;
	/** One-line advice */
	suggestion: string;
}

/** Redundant and widening type annotations in one file */
export interface AnnotationsResult {
	/** Absolute path of the checked file */
	file: string;
	/** Findings sorted by position */
	findings: AnnotationFinding[];
	redundantCount: number;
	wideningCount: number;
	/** Annotations examined: those with an initializer or body to infer from */
	checkedCount: number;
}
