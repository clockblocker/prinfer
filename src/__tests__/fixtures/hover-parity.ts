// Hovered on every backend; results must agree (see hover-parity.test.ts).
type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type Codes = `${Digit}${Digit}${Digit}`;

export type UnitRoute = "metric" | "imperial";
export type ParsedUnit<R extends UnitRoute = UnitRoute> = R extends unknown
	? { route: R; value: number }
	: never;

export interface Keyed<K extends string = "id"> {
	key: K;
}

export class Store<T extends object = object> {
	items: T[] = [];
	get size(): number {
		return this.items.length;
	}
}

export enum Color {
	Red = 0,
	Green = 1,
	Blue = 2,
}

export function parseUnit(input: string): number;
export function parseUnit(input: number, radix: number): string;
export function parseUnit(input: string | number, radix?: number) {
	return typeof input === "string" ? input.length : input.toString(radix);
}
export const parsed = parseUnit("km");

export function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("missing");
	return value;
}
export const kept = required<string>("x");

export const toLabel = (input: number) => `#${input}`;
export const label = toLabel(1);

export const flag: boolean = true;
export const maybeFlag: boolean | undefined = undefined;
export const color: Color | undefined = Color.Red;
export const route: UnitRoute | null = null;
export const doubled = [1, 2].map((n) => n * 2);

export const lookups = {
	key: "first",
	nested: { key: "second" },
};
export function keyOf(key: string): string {
	return key;
}
