// Sample TypeScript file for testing type inference

// Simple function declaration
export function add(a: number, b: number): number {
  return a + b;
}

// Arrow function with inferred return type
export const multiply = (x: number, y: number) => x * y;

// Function with complex types
export function processData<T>(items: T[], fn: (item: T) => boolean): T[] {
  return items.filter(fn);
}

// Async function
export async function fetchUser(id: string): Promise<{ name: string; id: string }> {
  return { name: "test", id };
}

// Variable with function type
export const greet: (name: string) => string = (name) => `Hello, ${name}!`;

// Object with methods
export const utils = {
  format(value: number): string {
    return value.toFixed(2);
  },
  parse: (str: string) => parseInt(str, 10),
};

// Class with method
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}

// Interface method signature
export interface Processor {
  process(input: string): string;
}
