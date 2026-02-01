// Test fixture for JSDoc documentation extraction

/**
 * Adds two numbers together.
 * @param a - The first number
 * @param b - The second number
 * @returns The sum of a and b
 */
export function add(a: number, b: number): number {
	return a + b;
}

/**
 * Formats a value as a currency string.
 *
 * This function takes a numeric value and returns it formatted
 * as a US dollar amount with two decimal places.
 *
 * @param value - The numeric value to format
 * @returns A formatted currency string like "$1,234.56"
 * @example
 * ```ts
 * formatCurrency(1234.5) // => "$1,234.50"
 * ```
 */
export function formatCurrency(value: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
	}).format(value);
}

/** A simple greeting message */
export const greeting = "Hello, World!";

/**
 * User configuration options.
 */
export interface UserConfig {
	/** The user's display name */
	name: string;
	/** Optional email address */
	email?: string;
}

/**
 * Calculator class for basic arithmetic.
 */
export class Calculator {
	/**
	 * Multiplies two numbers.
	 * @param x - First operand
	 * @param y - Second operand
	 */
	multiply(x: number, y: number): number {
		return x * y;
	}
}

// Function without JSDoc
export function noDocumentation(x: string): string {
	return x.toUpperCase();
}
