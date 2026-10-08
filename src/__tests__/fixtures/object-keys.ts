type Unit = { name: string };
export const units: Record<string, Unit> = {
	meter: { name: "m" },
	gram: { name: "g" },
};
export function register(map: Record<string, number>) {
	return map;
}
register({ km: 1 });
export const known: { metric: number; imperial: string } = {
	metric: 1,
	imperial: "ft",
};
const scale = 2;
export const loose = { factor: scale };
