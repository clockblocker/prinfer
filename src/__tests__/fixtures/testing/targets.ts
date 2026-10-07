type Drink = "coffee" | "tea";
const order = (drink: Drink) => ({ drink, size: "large" as const });
export const latte = order("coffee");
export const size = latte.size;
export const pick: Drink = "tea";
