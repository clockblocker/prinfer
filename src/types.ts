/**
 * Which compilers prinfer prints and counts with.
 * - `"bundled"` (default): the TypeScript 6 and TypeScript 7 packages
 *   prinfer depends on, the same on every machine.
 * - `"project"`: the project's own: `typescript` 5.0 to 6.x for the
 *   TypeScript 6 backend; `typescript` 7 or `@typescript/native-preview`
 *   for the TypeScript 7 backend. They are resolved the way Node resolves
 *   an import from the directory of the file's tsconfig.json (or of
 *   `project`). Throws when the project has none, or an unsupported one.
 * - `"auto"`: the project's when it has a supported one, otherwise the
 *   bundled one (with a warning on stderr when the project's is
 *   unsupported).
 *
 * When omitted: the `PRINFER_COMPILER` environment variable, then
 * `"bundled"`. A result's `compiler` says which one ran.
 */
export type CompilerMode = "bundled" | "project" | "auto";

/**
 * The compiler that produced a result. Results carry it as a
 * non-enumerable `compiler` property: read it directly; snapshots,
 * equality checks, and JSON.stringify leave it out, so they don't change
 * when only the compiler does. The CLI's --json output and the MCP tools'
 * structured output report it next to the result.
 */
export interface CompilerInfo {
	/** Package name: `typescript` or `@typescript/native-preview` */
	name: string;
	/** Package version, e.g. `6.0.3` */
	version: string;
	/** `bundled`: prinfer's own dependency; `project`: the project's */
	source: "bundled" | "project";
}

/** Options for `hover()` and `batchHover()`. */
export interface HoverOptions {
	/** tsconfig.json path (default: the nearest one above the file) */
	project?: string;
	/** Include JSDoc/TSDoc documentation */
	include_docs?: boolean;
	/** Count the checker work behind the hovered type; see `HoverCost` */
	include_cost?: boolean;
	/**
	 * @deprecated No effect since 3.2: wall-clock timing varied too much
	 * between identical runs to compare. Use `include_cost`.
	 */
	include_timing?: boolean;
	/** Disable TypeScript's own type truncation (`{ ...; }`). Default false */
	full?: boolean;
	/**
	 * Print union members in a fixed order, the same on TypeScript 6 and
	 * TypeScript 7, which order them differently. Default false.
	 *
	 * Every union in `signature`, `returnType`, and `overloads` is sorted, at
	 * any depth: members by their printed text (UTF-16 code units, so
	 * numbers compare as text: `1 | 10 | 2`), then `null`, then `undefined`.
	 * `display` keeps the editor's text, and a type TypeScript truncated
	 * (without `full`) is left as printed.
	 */
	sort_unions?: boolean;
	/**
	 * Ignored by the library's `hover()` and `batchHover()`, which always use
	 * TypeScript 6. (The MCP hover tools default to `PRINFER_BACKEND` or
	 * typescript7; the CLI and `prinfer/testing` default to typescript6.)
	 */
	backend?: "typescript6" | "typescript7";
	/** Which compilers to use; see `CompilerMode`. */
	compiler?: CompilerMode;
}

/**
 * The checker work behind a hovered type, counted on TypeScript 6 by a
 * fresh checker over the same program while it resolves the type and
 * expands it into its untruncated text. A warm checker would reuse earlier
 * lookups, so counting from a fresh one makes the numbers the same on every
 * run, in any process, whatever was looked up before. Display options
 * (`full`, `include_docs`, `sort_unions`) do not change them. Only the files, the compiler
 * options, and the TypeScript version do.
 */
export interface HoverCost {
	/** Type instantiations, the count `tsc --extendedDiagnostics` reports */
	instantiations: number;
	/** Types created */
	types: number;
	/** The TypeScript 6 compiler that counted; non-enumerable, see `CompilerInfo` */
	readonly compiler?: CompilerInfo;
}

/** @deprecated Not reported since 3.2; see `HoverCost`. */
export interface HoverTiming {
	/** Time spent resolving the hovered symbol's type */
	resolution_ms: number;
}

/** Another declaration of a looked-up name, one that was not picked. */
export interface HoverAlternative {
	/** 1-based line of the declaration's name */
	line: number;
	/** 1-based column of the declaration's name */
	column: number;
	/** Declaration kind, in the same vocabulary as `HoverResult.kind` */
	kind?: string;
}

/**
 * Result of hover lookup at a position.
 *
 * `signature` means the same thing on every backend: the type text only,
 * on one line with whitespace collapsed (`{ id: number; name: string; }`),
 * without the declaration keyword, kind label, or symbol name an editor
 * hover starts with.
 * - functions, methods, and calls: the call signature, `<T>(value: T): T`
 *   (a call shows the instantiated signature, with type arguments when the
 *   callee is generic);
 * - variables, parameters, properties: the type, `string[]` or
 *   `(x: number) => string` for a function-typed variable;
 * - type aliases: `type Name<T extends C = D> = Expanded`, keeping the
 *   name and type parameters because the alias is the subject;
 * - interfaces and classes: the name with its type parameters,
 *   `Box<T extends string = "a">`.
 *
 * Optional parameters and properties read as `tsc` writes them in
 * declaration emit and quick info: `digits?: number`, without the
 * `| undefined` the `?` implies. A `| undefined` the source wrote stays
 * (`digits?: number | undefined`), as does one the annotation does not
 * account for (`y?: number | undefined` for `y?: T` called with a number,
 * the properties of `Partial<T>` without exactOptionalPropertyTypes).
 *
 * `kind` uses the labels of an editor hover: `function`, `method`, `const`,
 * `let`, `var`, `using`, `await using`, `parameter`, `property`, `accessor`,
 * `type`, `interface`, `class`, `enum`, `enum member`, `namespace`,
 * `type parameter`, `constructor`, plus `call` for a hover on a callee of a
 * call expression. A variable initialized with a function keeps its
 * declaration keyword (`const`).
 */
export interface HoverResult {
	/** The type text; see the interface documentation for its exact shape */
	signature: string;
	/**
	 * The hover text as an editor shows it (`const names: string[]`, object
	 * types over several lines), when it differs from `signature`. Only the
	 * TypeScript 7 language server backend reports it.
	 */
	display?: string;
	/** The return type (for functions) */
	returnType?: string;
	/** 1-based line number */
	line: number;
	/** 1-based column number */
	column: number;
	/** JSDoc/TSDoc documentation if requested */
	documentation?: string;
	/** Editor hover label (`function`, `const`, `parameter`, `call`, ...); see above */
	kind: string;
	/** Symbol name if available */
	name?: string;
	/** Present when include_cost is true */
	cost?: HoverCost;
	/** @deprecated Not reported since 3.2; use `include_cost` and `cost`. */
	timing?: HoverTiming;
	/**
	 * Every call signature, in declaration order, when the hovered function,
	 * method, or callee has more than one (overloads). Each entry has the
	 * shape of a function `signature`.
	 */
	overloads?: string[];
	/**
	 * Number of members when the hovered type is a union, counted as
	 * TypeScript displays them: `true | false` count once as `boolean`, and
	 * all members of an enum count once as the enum. Omitted when that leaves
	 * fewer than two members (`boolean`, an enum type).
	 */
	unionMembers?: number;
	/**
	 * Name lookups only: other declarations of the same name that were not
	 * picked (at most 10), so a caller can tell the lookup was ambiguous and
	 * pass `line` to choose. Overload and merged declarations of the picked
	 * symbol are not listed.
	 */
	alternatives?: HoverAlternative[];
	/** The compiler that produced the result; non-enumerable, see `CompilerInfo` */
	readonly compiler?: CompilerInfo;
}

/** Options for `hover()` by name. */
export interface HoverByNameOptions extends HoverOptions {
	/** 1-based line that picks among same-named declarations */
	line?: number;
}

export interface CompletionOptions {
	/** tsconfig.json path (default: the nearest one above the file) */
	project?: string;
	/**
	 * Keep only entries whose name starts with this text (case-insensitive).
	 * Library default: no filter. (The MCP `completions` tool and
	 * `prinfer complete` default to the text typed left of the cursor.)
	 */
	prefix?: string;
	/**
	 * Return at most this many entries; `total` counts every match. Library
	 * default: all. (The MCP tool and `prinfer complete` default to 50.)
	 */
	limit?: number;
	/** Which compiler to use; see `CompilerMode`. */
	compiler?: CompilerMode;
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
	/**
	 * Why `entries` is empty although TypeScript would list globals: the
	 * cursor is on an object literal key where any key is accepted (such as a
	 * `Record<string, T>`), so there are no specific keys to offer.
	 */
	note?: string;
	/** The compiler that produced the result; non-enumerable, see `CompilerInfo` */
	readonly compiler?: CompilerInfo;
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
		/** Where the looked-up name is declared, when a line hint missed */
		declaredAt?: HoverAlternative[];
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
	/** The compiler that produced the results; non-enumerable, see `CompilerInfo` */
	readonly compiler?: CompilerInfo;
}

export interface DiagnosticsOptions {
	/** tsconfig.json path (default: the nearest one above the file) */
	project?: string;
	/** Also return suggestion and message diagnostics, such as unused-variable hints */
	include_suggestions?: boolean;
	/** Which compilers to use; see `CompilerMode`. */
	compiler?: CompilerMode;
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
	/** The compiler that produced the result; non-enumerable, see `CompilerInfo` */
	readonly compiler?: CompilerInfo;
}

export interface AnnotationsOptions {
	/** tsconfig.json path (default: the nearest one above the file) */
	project?: string;
	/** Which compiler to use; see `CompilerMode`. */
	compiler?: CompilerMode;
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
	/** The compiler that produced the result; non-enumerable, see `CompilerInfo` */
	readonly compiler?: CompilerInfo;
}
