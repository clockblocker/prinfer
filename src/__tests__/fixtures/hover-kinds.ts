export function add(a: number, b: number): number {
	return a + b;
}

export function pick(value: string): string;
export function pick(value: number): number;
export function pick(value: string | number) {
	return value;
}
export const picked = pick(1);

export const names = ["a", "b"];
export const lengths = names.map((name) => name.length);

export type Pair<T> = { left: T; right: T };

export interface User {
	id: number;
	name: string;
}

export class Box<T> {
	value: T;
	constructor(value: T) {
		this.value = value;
	}
	get(): T {
		return this.value;
	}
}

const people = [{ id: 1, name: "a" }];
export const labels = people.map((person) => ({
	id: person.id,
	label: person.name,
}));
export const user: User = { id: 1, name: "x" };
export const userName = user.name;
// A comment that mentions labels and person
export const quoted = "labels and person in a string";
export const scale = (factor: number) => (value: number) => value * factor;
