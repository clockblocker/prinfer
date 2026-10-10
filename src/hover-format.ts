import type { HoverResult } from "./types.js";

/**
 * Text rendering of hover results for the CLI and the MCP server. Only the
 * text is shaped here: JSON and structured content keep the full result.
 */

/** Default cap on the characters of type text printed per hover. */
export const DEFAULT_MAX_CHARS = 4000;

/** Overloads listed in full without `full`; more are only counted. */
const MAX_LISTED_OVERLOADS = 3;

/** Another declaration of the same name that the lookup did not pick. */
export interface HoverAlternative {
	line: number;
	column: number;
	kind?: string;
}

/**
 * Optional fields the hover core may report. Read defensively: backends
 * that do not compute them leave them out.
 */
export interface HoverExtras {
	/** Other declarations with the same name, not picked by the lookup */
	alternatives?: HoverAlternative[];
	/** The symbol's other overload signatures */
	overloads?: string[];
	/** Member count when the type is a union */
	unionMembers?: number;
}

export type HoverTextSurface = "cli" | "mcp";

export interface HoverTextOptions {
	surface: HoverTextSurface;
	/** Characters of type text to print; 0 prints everything. */
	maxChars?: number;
	/** TypeScript's own truncation is off, so list every overload. */
	full?: boolean;
	/** The text target the column was resolved from, echoed for checking. */
	target?: { text: string; line: number; column: number };
}

interface Labels {
	type: string;
	returns: string;
	name: string;
	kind: string;
	position?: string;
	docs: string;
	cost: string;
	overloads: string;
	target: string;
}

const LABELS: Record<HoverTextSurface, Labels> = {
	cli: {
		type: "",
		returns: "returns: ",
		name: "name: ",
		kind: "kind: ",
		docs: "docs: ",
		cost: "cost: ",
		overloads: "overloads:",
		target: "target: ",
	},
	mcp: {
		type: "Type: ",
		returns: "Returns: ",
		name: "Name: ",
		kind: "Kind: ",
		position: "Position: ",
		docs: "Documentation: ",
		cost: "Cost: ",
		overloads: "Overloads:",
		target: "Target: ",
	},
};

const HINTS: Record<
	HoverTextSurface,
	{ more: string; overloads: string; line: (line: number) => string }
> = {
	cli: {
		more: "Pass --max-chars N to see more (0 for no limit).",
		overloads: "--full lists them",
		line: (line) =>
			`pass a line hint to choose, e.g. <file>:<name>:${line}`,
	},
	mcp: {
		more: "Pass max_chars: N to see more (0 for no limit).",
		overloads: "full: true lists them",
		line: () => "pass line to choose",
	},
};

/** Render a hover result as the text an agent reads. */
export function formatHoverText(
	result: HoverResult,
	options: HoverTextOptions,
): string {
	const labels = LABELS[options.surface];
	const hints = HINTS[options.surface];
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const extras = result as HoverResult & HoverExtras;
	const lines: string[] = [];

	const signature = capText(result.signature, maxChars);
	const overloads = otherOverloads(result.signature, extras.overloads);
	let typeLine = `${labels.type}${signature.text}`;
	const listOverloads =
		overloads.length > 0 &&
		(options.full || overloads.length <= MAX_LISTED_OVERLOADS);
	if (overloads.length > 0 && !OVERLOAD_SUFFIX.test(result.signature)) {
		const count = `+${overloads.length} overload${overloads.length > 1 ? "s" : ""}`;
		typeLine += listOverloads
			? ` (${count})`
			: ` (${count}; ${hints.overloads})`;
	}
	lines.push(typeLine);
	if (signature.truncated) {
		const members =
			extras.unionMembers ??
			countUnionMembers(result.signature, result.kind);
		lines.push(truncationTrailer(signature.total, members, hints.more));
	}
	if (listOverloads) {
		lines.push(labels.overloads);
		for (const overload of overloads) {
			const capped = capText(overload, maxChars);
			lines.push(
				indent(capped.text) +
					(capped.truncated
						? ` … (${formatCount(capped.total)} chars total)`
						: ""),
			);
		}
	}
	if (result.returnType) {
		const capped = capText(result.returnType, maxChars);
		lines.push(
			`${labels.returns}${capped.text}` +
				(capped.truncated
					? `\n… truncated: ${formatCount(capped.total)} chars total.`
					: ""),
		);
	}
	if (result.name) lines.push(`${labels.name}${result.name}`);
	lines.push(`${labels.kind}${result.kind}`);
	if (labels.position) {
		lines.push(`${labels.position}${result.line}:${result.column}`);
	}
	const ambiguity = ambiguityNote(result, extras.alternatives, hints.line);
	if (ambiguity) lines.push(ambiguity);
	if (result.documentation)
		lines.push(`${labels.docs}${result.documentation}`);
	if (result.cost) {
		lines.push(
			`${labels.cost}${formatCount(result.cost.instantiations)} instantiations, ${formatCount(result.cost.types)} types`,
		);
	}
	if (options.target) {
		const { text, line, column } = options.target;
		lines.push(
			`${labels.target}${JSON.stringify(text)} at ${line}:${column}`,
		);
	}
	return lines.join("\n");
}

const OVERLOAD_SUFFIX = /\(\+\d+ overloads?\)\s*$/;

/** Overloads other than the displayed signature. */
function otherOverloads(signature: string, overloads: unknown): string[] {
	if (!Array.isArray(overloads)) return [];
	return overloads.filter(
		(overload): overload is string =>
			typeof overload === "string" &&
			overload.trim() !== signature.trim(),
	);
}

/**
 * `Matched line 57 of 3 declarations (also 59, 63); pass a line hint to
 * choose.` when the name lookup had other candidates.
 */
function ambiguityNote(
	result: HoverResult,
	alternatives: unknown,
	lineHint: (line: number) => string,
): string | undefined {
	if (!Array.isArray(alternatives)) return undefined;
	const lines = alternatives
		.map((alternative) => (alternative as Partial<HoverAlternative>)?.line)
		.filter((line): line is number => typeof line === "number");
	if (lines.length === 0) return undefined;
	return `Matched line ${result.line} of ${lines.length + 1} declarations (also ${lines.join(", ")}); ${lineHint(lines[0] as number)}.`;
}

function truncationTrailer(
	total: number,
	members: number | undefined,
	more: string,
): string {
	const union = members ? `, union of ${formatCount(members)} members` : "";
	return `… truncated: ${formatCount(total)} chars total${union}. ${more}`;
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function formatCount(count: number): string {
	return count.toLocaleString("en-US");
}

/**
 * Cut text to at most `maxChars` characters (0 or less: no cap), preferring
 * a line break or space near the limit and never splitting a surrogate pair.
 */
export function capText(
	text: string,
	maxChars: number,
): { text: string; truncated: boolean; total: number } {
	const total = text.length;
	if (maxChars <= 0 || total <= maxChars) {
		return { text, truncated: false, total };
	}
	let cut = maxChars;
	const window = text.slice(Math.floor(maxChars * 0.9), maxChars);
	const breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
	if (breakAt > 0) cut = Math.floor(maxChars * 0.9) + breakAt;
	const code = text.charCodeAt(cut - 1);
	if (code >= 0xd800 && code <= 0xdbff) cut--;
	return { text: text.slice(0, cut).trimEnd(), truncated: true, total };
}

const FUNCTION_KINDS = new Set([
	"function",
	"method",
	"constructor",
	"call",
	"construct",
	"local function",
]);
const ELIDED_MEMBERS = /^\.\.\. (\d+) more \.\.\.$/;

/**
 * Count the members of a union type from its display text: the `|` at the
 * top level, outside brackets and string literals. Returns undefined for
 * non-unions and for function signatures, whose `|` belong to a parameter
 * or the return type. TypeScript's `... 12 more ...` counts as 12.
 */
export function countUnionMembers(
	signature: string,
	kind?: string,
): number | undefined {
	if (kind && FUNCTION_KINDS.has(kind)) return undefined;
	const segments: string[] = [];
	let depth = 0;
	let start = 0;
	let lastClose = -1;
	for (let index = 0; index < signature.length; index++) {
		const char = signature[index] as string;
		if (char === '"' || char === "'" || char === "`") {
			index = skipString(signature, index);
			continue;
		}
		if (char === "=" && signature[index + 1] === ">") {
			if (depth === 0) return undefined;
			index++;
			continue;
		}
		if (char === "(" || char === "[" || char === "{" || char === "<") {
			depth++;
		} else if (
			char === ")" ||
			char === "]" ||
			char === "}" ||
			char === ">"
		) {
			depth = Math.max(0, depth - 1);
			if (depth === 0 && char === ")") lastClose = index;
		} else if (depth === 0) {
			// "(a: string): A | B" is a function signature, not a union.
			if (
				char === ":" &&
				lastClose >= 0 &&
				signature.slice(lastClose + 1, index).trim() === "" &&
				segments.length === 0
			) {
				return undefined;
			}
			if (char === "|" && signature[index + 1] !== "|") {
				segments.push(signature.slice(start, index));
				start = index + 1;
			}
		}
	}
	segments.push(signature.slice(start));
	// A leading "|" (after "=", ":", or at the start) separates nothing.
	const members = segments.filter(
		(segment, index) =>
			index === segments.length - 1 ||
			!/(^|[=:])\s*$/.test(segment.trimEnd() || "="),
	);
	if (members.length < 2) return undefined;
	let count = 0;
	for (const member of members) {
		const elided = ELIDED_MEMBERS.exec(member.trim());
		count += elided ? Number(elided[1]) : 1;
	}
	return count;
}

function skipString(text: string, start: number): number {
	const quote = text[start];
	for (let index = start + 1; index < text.length; index++) {
		if (text[index] === "\\") index++;
		else if (text[index] === quote) return index;
	}
	return text.length;
}
