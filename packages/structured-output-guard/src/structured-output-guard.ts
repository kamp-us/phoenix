/**
 * `@kampus/structured-output-guard` core — the pure, IO-free decision that makes a
 * subagent's final `StructuredOutput` call conform first-try and self-correct in one
 * retry on a miss (issue #742, epic #737). Kills the mined ~55 schema-mismatch
 * subagent tool-errors with no model-behavior change.
 *
 * Three coordinated pure functions, no IO:
 *   - `validate(payload, schema)`     → the full field diff (missing / present / extra),
 *                                        not a terse first-missing-field type error.
 *   - `decide(payload, schema, n, …)` → accept (validates) | retry (budget remains,
 *                                        carries the rich message) | fail (budget gone).
 *   - `renderSchemaSection(schema, example)` → the spawn-prompt block that embeds the
 *                                        exact JSONSchema + a filled example up front, so
 *                                        the agent conforms first-try instead of guessing.
 *
 * The non-obvious design choice: the retry message lists EVERY missing AND EVERY present
 * field plus the worked example (AC: "names every field that is missing AND every field
 * that is present"). A terse type error gives the retry only the first failing field, so
 * it converges slowly; the full diff + example lets it converge in one retry — which is
 * what makes the 2-retry cap enough rather than a hard fail. The cap default is 2 (AC:
 * "retries up to 2 times then fails"); `retryCount` is the number of retries ALREADY
 * spent, so `decide` fails when `retryCount >= cap`.
 */

/** A flat required-field schema: the field names a conforming `StructuredOutput` must carry. */
export interface OutputSchema {
	/** Field names that MUST be present on a conforming payload. */
	readonly required: ReadonlyArray<string>;
	/** Field names that MAY be present (not required, not flagged as extra). */
	readonly optional?: ReadonlyArray<string>;
}

/** The full field diff of a payload against a schema — the rich picture a retry corrects against. */
export interface FieldDiff {
	/** Required schema fields absent from the payload (the reason a miss fails). */
	readonly missing: ReadonlyArray<string>;
	/** Required schema fields the payload DOES carry (so the retry keeps them). */
	readonly present: ReadonlyArray<string>;
	/** Payload keys not in `required` ∪ `optional` — surfaced, never fatal. */
	readonly extra: ReadonlyArray<string>;
}

export const DEFAULT_RETRY_CAP = 2;

/** Treat only `undefined`/`null`/`missing-key` as absent; `false`/`0`/`""` are present. */
const isPresent = (payload: Record<string, unknown>, field: string): boolean =>
	field in payload && payload[field] !== undefined && payload[field] !== null;

/** The full field diff — missing + present + extra — of `payload` against `schema`. Pure, total. */
export const validate = (payload: Record<string, unknown>, schema: OutputSchema): FieldDiff => {
	const required = schema.required;
	const known = new Set<string>([...required, ...(schema.optional ?? [])]);
	const missing = required.filter((f) => !isPresent(payload, f));
	const present = required.filter((f) => isPresent(payload, f));
	const extra = Object.keys(payload).filter((k) => !known.has(k));
	return {missing, present, extra};
};

/** A payload conforms when no required field is missing. Extra/optional keys never fail it. */
export const conforms = (diff: FieldDiff): boolean => diff.missing.length === 0;

export type Decision =
	| {readonly kind: "accept"; readonly diff: FieldDiff}
	| {
			readonly kind: "retry";
			readonly diff: FieldDiff;
			readonly message: string;
			readonly retryNumber: number;
			readonly cap: number;
	  }
	| {
			readonly kind: "fail";
			readonly diff: FieldDiff;
			readonly message: string;
			readonly cap: number;
	  };

/**
 * The rich failure message: every missing field, every present field, the surfaced
 * extras, and the worked example — so the retry has the full shape, not the first
 * type error. Mirrors `renderSchemaSection` so the retry reads the same template.
 */
export const renderFailureMessage = (
	diff: FieldDiff,
	schema: OutputSchema,
	example?: Record<string, unknown>,
): string => {
	const lines: string[] = [
		"StructuredOutput call did not match the required schema.",
		`  missing (required, absent): ${diff.missing.length ? diff.missing.join(", ") : "(none)"}`,
		`  present (required, ok):     ${diff.present.length ? diff.present.join(", ") : "(none)"}`,
	];
	if (diff.extra.length > 0) {
		lines.push(`  extra (ignored, not in schema): ${diff.extra.join(", ")}`);
	}
	lines.push(`  required fields: ${schema.required.join(", ") || "(none)"}`);
	if (schema.optional && schema.optional.length > 0) {
		lines.push(`  optional fields: ${schema.optional.join(", ")}`);
	}
	lines.push(
		"Re-call StructuredOutput with EVERY missing field added (keep the present ones). Conforming example:",
		JSON.stringify(example ?? exampleFromSchema(schema), null, 2),
	);
	return lines.join("\n");
};

/**
 * The retry decision (issue #742). `retryCount` = retries already spent (0 on the first
 * call). On a conforming payload → `accept`. On a miss with budget left
 * (`retryCount < cap`) → `retry` carrying the rich message. On a miss with the budget
 * exhausted (`retryCount >= cap`) → `fail`. Pure, total, no IO.
 */
export const decide = (
	payload: Record<string, unknown>,
	schema: OutputSchema,
	retryCount: number,
	options?: {readonly cap?: number; readonly example?: Record<string, unknown>},
): Decision => {
	const cap = options?.cap ?? DEFAULT_RETRY_CAP;
	const diff = validate(payload, schema);
	if (conforms(diff)) return {kind: "accept", diff};
	const message = renderFailureMessage(diff, schema, options?.example);
	if (retryCount >= cap) return {kind: "fail", diff, message, cap};
	return {kind: "retry", diff, message, retryNumber: retryCount + 1, cap};
};

/** A placeholder example derived from a schema when the caller supplies none. */
const exampleFromSchema = (schema: OutputSchema): Record<string, unknown> => {
	const ex: Record<string, unknown> = {};
	for (const f of schema.required) ex[f] = `<${f}>`;
	return ex;
};

/**
 * The spawn-prompt block injected up front for any subagent that must finish with a
 * `StructuredOutput` call: the exact required/optional field list + a filled example.
 * Embedding the shape (not leaving the agent to guess) is the first-try-conformance half
 * of the fix; the retry core is the self-correct half.
 */
export const renderSchemaSection = (
	schema: OutputSchema,
	example?: Record<string, unknown>,
): string =>
	[
		"## Final output — call StructuredOutput with EXACTLY this shape",
		"",
		`Required fields (all must be present): ${schema.required.join(", ") || "(none)"}`,
		...(schema.optional && schema.optional.length > 0
			? [`Optional fields: ${schema.optional.join(", ")}`]
			: []),
		"",
		"Conforming example:",
		"```json",
		JSON.stringify(example ?? exampleFromSchema(schema), null, 2),
		"```",
		"",
		`On a validation miss you get the full missing+present field diff and may retry up to ${DEFAULT_RETRY_CAP} times; conform on the first call to spend no retries.`,
	].join("\n");
