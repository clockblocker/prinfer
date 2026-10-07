import fs from "node:fs";
import path from "node:path";

/**
 * Parsing of the CLI's `<file>:<target>` argument, kept free of side effects
 * so it can be unit tested.
 */

/** A target as written on the command line, before any flag is applied. */
export type ParsedTarget =
	| { kind: "position"; file: string; line: number; column: number }
	| { kind: "text"; file: string; line: number; text: string }
	| { kind: "line"; file: string; line: number }
	| { kind: "name"; file: string; name: string; line?: number };

/** A JavaScript identifier: Unicode ID_Start/ID_Continue, `$`, and `_`. */
const IDENTIFIER = "[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200C\\u200D]*";

/** `.ts:`, `.tsx:`, `.mjs:`, ...: a source file name followed by more target. */
const SOURCE_EXTENSION_COLON = /\.[cm]?[jt]sx?:/i;
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/i;

type Shape = (arg: string) => ParsedTarget | undefined;

/**
 * The accepted shapes, in precedence order. The segments after the file
 * decide the form:
 *
 * 1. `<file>:<digits>:<digits>`       line and column
 * 2. `<file>:<identifier>:<digits>`   name with a line hint
 * 3. `<file>:<digits>:<anything>`     line and text (text may hold colons)
 * 4. `<file>:<identifier>`            name
 * 5. `<file>:<digits>`                line only; needs --text
 *
 * Identifiers never start with a digit, so 1 and 2 cannot collide, and
 * all-digit text is always a column (1 before 3).
 */
const SHAPES: Shape[] = [
	(arg) => {
		const match = /^(.+):(\d+):(\d+)$/.exec(arg);
		return match
			? {
					kind: "position",
					file: match[1] as string,
					line: Number(match[2]),
					column: Number(match[3]),
				}
			: undefined;
	},
	(arg) => {
		const match = new RegExp(`^(.+):(${IDENTIFIER}):(\\d+)$`, "u").exec(
			arg,
		);
		return match
			? {
					kind: "name",
					file: match[1] as string,
					name: match[2] as string,
					line: Number(match[3]),
				}
			: undefined;
	},
	(arg) => {
		// Lazy file: the text is everything after the first `:<line>:`.
		const match = /^(.+?):(\d+):(.+)$/s.exec(arg);
		return match
			? {
					kind: "text",
					file: match[1] as string,
					line: Number(match[2]),
					text: match[3] as string,
				}
			: undefined;
	},
	(arg) => {
		const match = new RegExp(`^(.+):(${IDENTIFIER})$`, "u").exec(arg);
		return match
			? {
					kind: "name",
					file: match[1] as string,
					name: match[2] as string,
				}
			: undefined;
	},
	(arg) => {
		const match = /^(.+):(\d+)$/.exec(arg);
		return match
			? { kind: "line", file: match[1] as string, line: Number(match[2]) }
			: undefined;
	},
];

/**
 * Parse `<file>:<target>`. A shape whose file part still holds a source
 * file name followed by a colon (`a.ts:foo` from `a.ts:foo:bar`) is skipped
 * unless that path exists, so a malformed target is reported as such rather
 * than as a missing file. Returns null when no shape fits.
 */
export function parseTargetArg(
	arg: string,
	cwd: string = process.cwd(),
): ParsedTarget | null {
	for (const shape of SHAPES) {
		const parsed = shape(arg);
		if (parsed && plausibleFile(parsed.file, cwd)) return parsed;
	}
	return null;
}

function plausibleFile(file: string, cwd: string): boolean {
	return (
		!SOURCE_EXTENSION_COLON.test(file) ||
		fs.existsSync(path.resolve(cwd, file))
	);
}

/**
 * A hint for arguments the shell probably rewrote before prinfer saw them:
 * an expanded or leftover `$` (`src/store.ts:$store` unquoted loses
 * `$store`), or a zsh modifier applied to a variable (`$F:root` becomes
 * `${F:r}oot`, a path without its extension).
 */
export function shellHint(arg: string): string | undefined {
	if (arg.includes("$") || /:$|::/.test(arg)) {
		return "If the target has a $ (as in $name identifiers), single-quote the whole argument so the shell keeps it: 'src/store.ts:$store'.";
	}
	if (!SOURCE_EXTENSION.test(arg) && !SOURCE_EXTENSION_COLON.test(arg)) {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
		return 'If you built it from a shell variable: zsh reads $F:r, :t, :h, ... as modifiers ("$F:root" becomes "${F:r}oot"). Write "${F}:root" or single-quote the argument.';
	}
	return undefined;
}
