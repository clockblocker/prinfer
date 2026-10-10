// Types with different costs for the include_cost tests.

type Tuple<N extends number, T extends unknown[] = []> = T["length"] extends N
	? T
	: Tuple<N, [...T, N]>;

export type Ten = Tuple<10>;

type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

interface Config {
	server: { host: string; port: number; tls: { cert: string; key: string } };
	db: { url: string; pool: { min: number; max: number } };
}

export type PartialConfig = DeepPartial<Config>;

function pipe<A, B, C, D>(
	a: A,
	f: (a: A) => B,
	g: (b: B) => C,
	h: (c: C) => D,
): D {
	return h(g(f(a)));
}

export const piped = pipe(
	1,
	(n) => [n],
	(xs) => ({ xs }),
	(o) => new Map([[o.xs, o]]),
);

export const flags = pipe(
	"a",
	(s) => s.length,
	(n) => n > 0,
	(b) => [b] as const,
);

export const light = 1;
