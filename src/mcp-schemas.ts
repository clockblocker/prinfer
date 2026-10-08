import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
	annotationsResultSchema,
	batchHoverItemSchema,
	batchHoverResultSchema,
	CONTRACT_VERSION,
	completionResultSchema,
	contractErrorSchema,
	diagnosticsResultSchema,
	hoverResultSchema,
} from "./contract.js";

/**
 * Schemas the MCP server advertises in tools/list. Validation still runs
 * through zod; only the emitted JSON Schema is made compact.
 *
 * Output schemas cover error results too: the spec requires structured
 * results to conform to the output schema without exempting `isError`, and
 * the v1 TypeScript SDK client validates structuredContent even on errors.
 * The error branch lists the fields an agent recovers with (code, message,
 * candidates, suggestion); the echoed file, line, column, and project are
 * still sent, as allowed additional properties.
 */

type JsonSchema = Record<string, unknown>;

/**
 * Drop JSON Schema noise that costs context without constraining anything:
 * `$schema` (2020-12 is the MCP default), zod's safe-integer bounds,
 * `exclusiveMinimum: 0` on integers (as `minimum: 1`), `type` next to
 * `const` or a string `enum`, and, in output schemas, `additionalProperties: false` (results
 * may gain fields within contract version 1) and descriptions.
 */
export function compactJsonSchema(
	schema: unknown,
	io: "input" | "output",
): unknown {
	if (Array.isArray(schema)) {
		return schema.map((item) => compactJsonSchema(item, io));
	}
	if (!schema || typeof schema !== "object") return schema;
	const out: JsonSchema = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$schema") continue;
		if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
		if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
		if (io === "output" && key === "description") continue;
		if (
			io === "output" &&
			key === "additionalProperties" &&
			value === false
		)
			continue;
		out[key] =
			key === "properties" && value && typeof value === "object"
				? Object.fromEntries(
						Object.entries(value).map(([name, property]) => [
							name,
							compactJsonSchema(property, io),
						]),
					)
				: compactJsonSchema(value, io);
	}
	if ("const" in out && typeof out.type === "string") delete out.type;
	if (
		out.type === "string" &&
		Array.isArray(out.enum) &&
		out.enum.every((value) => typeof value === "string")
	) {
		delete out.type;
	}
	if (out.type === "integer" && out.exclusiveMinimum === 0) {
		delete out.exclusiveMinimum;
		out.minimum = 1;
	}
	return out;
}

/** Wrap a zod schema so the SDK advertises its compacted JSON Schema. */
export function compact<T extends z.ZodType>(
	schema: T,
): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
	const standard = schema["~standard"];
	const convert = (io: "input" | "output") => () =>
		compactJsonSchema(
			z.toJSONSchema(schema, { target: "draft-2020-12", io }),
			io,
		) as JsonSchema;
	return {
		"~standard": {
			version: standard.version,
			vendor: standard.vendor,
			validate: (value: unknown) => standard.validate(value),
			jsonSchema: { input: convert("input"), output: convert("output") },
		},
	} as StandardSchemaWithJSON<z.input<T>, z.output<T>>;
}

const toolErrorSchema = contractErrorSchema.pick({
	code: true,
	message: true,
	candidates: true,
	suggestion: true,
});

/**
 * One envelope for both outcomes: `{version, ok: true, result}` or
 * `{version, ok: false, error}`. A single object instead of a union keeps
 * the advertised schema small.
 */
function envelope<T extends z.ZodType>(result: T) {
	return compact(
		z.object({
			version: z.literal(CONTRACT_VERSION),
			ok: z.boolean(),
			result: result.optional(),
			error: toolErrorSchema.optional(),
		}),
	);
}

export const hoverOutputSchema = envelope(hoverResultSchema);
export const batchHoverOutputSchema = envelope(
	batchHoverResultSchema.extend({
		items: z.array(
			batchHoverItemSchema.extend({ error: toolErrorSchema.optional() }),
		),
	}),
);
export const completionsOutputSchema = envelope(completionResultSchema);
export const diagnosticsOutputSchema = envelope(diagnosticsResultSchema);
export const annotationsOutputSchema = envelope(annotationsResultSchema);
