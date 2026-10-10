// Types that print readably, and types that don't, for expectType and the
// readability checks.

interface User {
	id: string;
	name: string;
}

declare function omitId<T extends { id: string }>(value: T): Omit<T, "id">;
declare function withExtra<T>(value: T): T & { extra: number };
declare const user: User;

export const withoutId = omitId(user);

export const extended = withExtra(user);

export const plain = { id: "1", name: "Ada" };

export const quoted: "Omit<User>" | "& { x }" | "..." = "...";

export const status: "idle" | "error" | null = null;

type Letter =
	| "alpha"
	| "bravo"
	| "charlie"
	| "delta"
	| "echo"
	| "foxtrot"
	| "golf"
	| "hotel"
	| "india"
	| "juliett"
	| "kilo"
	| "lima"
	| "mike"
	| "november"
	| "oscar"
	| "papa"
	| "quebec"
	| "romeo"
	| "sierra"
	| "tango"
	| "uniform"
	| "victor"
	| "whiskey"
	| "xray"
	| "yankee"
	| "zulu";

export const letters = { first: "alpha" as Letter, nested: { deep: { user } } };

type Tuple<N extends number, T extends unknown[] = []> = T["length"] extends N
	? T
	: Tuple<N, [...T, N]>;

export type Twenty = Tuple<20>;

declare const shout: `${Letter}!`;
export const shouted = shout;

export const wide = {
	alpha: user,
	bravo: user,
	charlie: user,
	delta: user,
	echo: user,
	foxtrot: user,
	golf: user,
	hotel: user,
	india: user,
	juliett: user,
	kilo: user,
	lima: user,
	mike: user,
	november: user,
	oscar: user,
	papa: user,
	quebec: user,
	romeo: user,
	sierra: user,
	tango: user,
};
