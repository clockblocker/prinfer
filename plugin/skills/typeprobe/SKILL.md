---
name: typeprobe
description: TypeScript inferred types, completions and type errors from the real compiler. Use when writing, refactoring or debugging TypeScript and you are about to add a type annotation, are unsure what a variable, generic or call infers, need the valid values at a cursor, want to check a file for type errors after editing, are cleaning up redundant annotations, or are writing type tests that lock what an API infers.
---

# typeprobe

Look the type up instead of guessing it. When the inferred type is what you would have annotated, leave the annotation out.

## Pick the tool

| You want | Call |
| :- | :- |
| Type of a named symbol | `hover_by_name(file, name)`; add `line` when the name repeats |
| Type of a token without a unique name (callback parameter, expression, call) | `hover(file, line, text)`; add `occurrence` for the nth match on the line |
| Several types, any files | one `batch_hover` call |
| Valid values at a cursor (union members, keys, methods) | `completions(file, line, column)` |
| Type errors after an edit | `diagnostics(file)` |
| Annotations TypeScript would infer anyway | `annotations(file)`: `redundant` ones can go; `widening` ones are often a deliberate contract |

An edit is done when `diagnostics` reports no errors for every file you changed.

`project` (a `tsconfig.json` path) defaults to the nearest one above the file. On the default `typescript7` backend that tsconfig must include the file; if it doesn't, also pass `backend: "typescript6"`.

## Positions

- Lines and columns are 1-based. For `hover` and `batch_hover`, pass `text` exactly as it appears on the line (`useQuery`, `config`) instead of counting columns.
- `hover_by_name` with a `line` where the name is used, not declared (`name: "value", line: 185` on `if (box.value) ...`), gives the narrowed type at that spot.
- `completions` needs a column; the cursor sits before that character. For a string-literal union, put it just inside the opening quote. It returns the top 50 (`limit` up to 500), filtered by the text typed left of the cursor; `prefix` filters by other text, `prefix: ""` lists everything.

## Reading results

- Type text is cut at 4000 characters with a trailer giving the full length. Pass `max_chars` (`0` for no cap); `full: true` also turns off TypeScript's own `{ ...; }` truncation. Structured content is never cut.
- `Matched line 8 of 3 declarations (also 12, 20)` means the name is ambiguous; pass `line` to pick another.
- Errors say what to do next: retry with the `Did you mean:` and `Suggestion:` lines.
- If a call fails or a type looks wrong on TypeScript 7, retry that call with `backend: "typescript6"`. `completions` and `annotations` always run on TypeScript 6.

## Type tests

When inferred types must not drift (public API inference, a refactor that should keep types, a request for type tests), snapshot them with `typeprobe/testing` (dev dependency `typeprobe`):

```ts
import { expect, test } from "vitest"; // or "bun:test"
import { inferredType } from "typeprobe/testing";

test("groupBy keys by the callback's return type", () => {
  expect(inferredType(import.meta.url, { name: "byRole" })).toMatchInlineSnapshot();
});
```

- Leave the matcher empty; the runner writes the type. After an intended change, rerun with `vitest -u` or `bun test --update-snapshots`.
- Targets: `{ name }`, `{ line, text }`, `{ line, column }`. Options go in the same object; there is no third argument. Add `strict: true` to catch misspelled keys.
- Another module: `new URL("../src/users.ts", import.meta.url)` as the file.
- For a value you don't have, put `declare const input: User[]` and the expression in a separate fixture file and point the helper at it. A `declare const` in the test file itself throws a `ReferenceError` at runtime.
- Snapshots hold the whole type, untruncated. Add `sort_unions: true` if the snapshot must hold on both TypeScript 6 (default) and TypeScript 7 (`backend: "typescript7"`).
- `inferredCompletions(file, { line, text })` pins every completion name. `expectType(file, { name, printed, maxInstantiations, readable: true })` checks text, cost budget and readability in one call; `expectTypes(file, { types: [...], maxInstantiations })` checks several and budgets them together.

## Without MCP

Run the CLI. It defaults to TypeScript 6 (`--backend typescript7` for lookups and `check`) and with `--json` prints `{ ok, result | error }`:

```bash
npx typeprobe src/file.ts:symbolName --json
npx typeprobe src/file.ts:symbolName:75 --json      # line hint
npx typeprobe src/file.ts:75:user --json            # text copied from line 75
npx typeprobe complete src/file.ts:80:user. --json  # cursor after the text; --prefix, --limit
npx typeprobe check src/file.ts --json              # exits 1 when there are type errors
npx typeprobe annotations src/file.ts --json
```

Single-quote any argument containing `$` (`'src/store.ts:$store'`): the shell expands `$store`, and zsh rewrites `"$F:root"` as `${F:r}oot`.
