/**
 * typeprobe's environment variables, named `TYPEPROBE_<NAME>`. The package
 * was called prinfer before 4.0, so each one still falls back to its
 * deprecated `PRINFER_<NAME>` spelling when the new one is unset.
 */
export type EnvName = "BACKEND" | "COMPILER";

/** The variable name a setting is documented and written under. */
export function envName(name: EnvName): string {
	return `TYPEPROBE_${name}`;
}

/** The deprecated prinfer-era name, read only when the new one is unset. */
export function legacyEnvName(name: EnvName): string {
	return `PRINFER_${name}`;
}

/**
 * The value of `TYPEPROBE_<name>`, else of the deprecated `PRINFER_<name>`,
 * with the variable it came from (for error messages). Empty counts as
 * unset.
 */
export function readEnv(
	name: EnvName,
): { value: string; variable: string } | undefined {
	for (const variable of [envName(name), legacyEnvName(name)]) {
		const value = process.env[variable];
		if (value) return { value, variable };
	}
	return undefined;
}
