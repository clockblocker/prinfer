// Intentional type errors for diagnostics tests. Excluded from the root
// tsconfig.json; positions below are asserted by diagnostics.test.ts.
export const count: number = "three";

export function label(value: number): string {
	return value;
}

export const handler: (event: { id: number }) => void = (event: {
	id: string;
}) => {
	event.id.toUpperCase();
};

export function helper(): number {
	// biome-ignore lint/correctness/noUnusedVariables: asserted as a TS6133 suggestion
	const unused = 1;
	return 2;
}
