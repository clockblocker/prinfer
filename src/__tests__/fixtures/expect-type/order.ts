// Two declarations whose cost together depends on the order a checker
// meets them in: TypeScript 6.0.3 creates one type more resolving ByText
// before count than count before ByText. expectTypes counts a group in
// source order, so the order of its types doesn't change the total.

interface Options {
	full?: boolean;
}
interface ByName extends Options {}
export interface ByText extends Options {
	line: number;
}
type Selector = ByName | ByText;
interface Extra {
	strict?: boolean;
}
type RowSelector = Selector & Extra;
type Cost = { types: number };
type Mode = "a" | "b";
declare const selector: { types: unknown[]; project?: string };
declare const defaults: object;
declare const grouped: boolean;
export function expectAll(): Cost | undefined {
	const { types, project } = selector;
	if (!Array.isArray(types) || types.length === 0) {
		return undefined;
	}
	const rows = types.map((row: unknown) => {
		return { ...defaults, ...(row as object) } as RowSelector;
	});
	if (grouped) {
		return count({ project }, rows);
	}
	return undefined;
}
function count(
	options: { project?: string; compiler?: Mode },
	items: readonly object[],
): Cost {
	return { types: items.length + (options.project ? 1 : 0) };
}
