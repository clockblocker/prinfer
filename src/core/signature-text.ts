/**
 * Collapse a multi-line type, as an editor hover prints it, onto one line
 * the way TypeScript 6's typeToString writes it:
 * `{\n    id: number;\n}` becomes `{ id: number; }`.
 */
export function singleLine(text: string): string {
	return text.replace(/[^\S\n]*\n\s*/g, " ").trim();
}
