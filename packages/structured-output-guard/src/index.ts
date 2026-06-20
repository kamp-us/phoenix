/**
 * `@kampus/structured-output-guard` — the StructuredOutput conformance slice (issue
 * #742, epic #737). A pure core (`validate`/`decide`/`renderSchemaSection`) decides
 * accept-vs-retry-vs-fail against a 2-retry cap and emits a rich missing+present field
 * diff; `bin.ts` wires it to the harness as two CLI verbs (`prompt` to template the
 * schema into a spawn prompt, `decide` to run the retry decision on a validation path).
 */
export {
	conforms,
	DEFAULT_RETRY_CAP,
	type Decision,
	decide,
	type FieldDiff,
	type OutputSchema,
	renderFailureMessage,
	renderSchemaSection,
	validate,
} from "./structured-output-guard.ts";
