// tsconfig.json is strict with the ES2022 lib; tsconfig.custom.json is
// neither, so each project types and checks this file differently.
export const box = { value: null };

export function echo(value) {
	return value;
}

export const numbers = [1, 2, 3];
export const hasTwo = numbers.includes(2);
