type Drink = "coffee" | "tea";

export const selected: Drink = "coffee";

type LooseAutocomplete<T extends string> = T | (string & {});
type FlexibleDrink = LooseAutocomplete<Drink>;

export const flexible: FlexibleDrink = "custom";
