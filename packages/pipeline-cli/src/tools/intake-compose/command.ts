/**
 * The `intake-compose` tool — `pipeline-cli intake-compose sub-issue`.
 *
 * The one composer for the format-2 sub-issue body of the intake-formats prose
 * contract (`gh-issue-intake-formats.md` §2), so the skills that file a sub-issue
 * cite this verb instead of re-deriving the format by hand (#3254 / epic #3258):
 *
 *   pipeline-cli intake-compose sub-issue [--spec <file>]   # spec JSON via file or stdin
 *
 * Reads a structured spec JSON (stories / tdd / containment / whatToBuild /
 * acceptanceCriteria) from `--spec` or stdin, decodes it at this trust boundary
 * with Schema (per `.patterns/effect-schema-validation.md`), enforces the format-2
 * invariants (the ≥1-acceptance-criterion hard floor), and emits the composed body
 * to **stdout only**.
 *
 * Stdout-only is the leak-safe handoff (AC3): the caller captures the body by value
 * — `BODY="$(pipeline-cli intake-compose sub-issue --spec s.json)"` then
 * `gh api … -f body="$BODY"` — so there is no scratchpad file to `@`-reference and
 * the `gh api -f body=@<path>` machine-local-path leak (contract §"Posting a comment
 * body"; #2002 / #754 / PR #1567) is structurally unreachable. There is deliberately
 * no `--out <file>` flag — a file output would reopen exactly that `@file` path.
 *
 *   exit 0 — a well-formed body emitted to stdout
 *   exit 2 — the spec is unreadable, not valid JSON, or violates a format-2 invariant
 *
 * The exit mapping is caught inside this handler (not at the shared bin's run
 * boundary, which provides only NodeServices and no per-tool catch), mirroring
 * `adoption-lint` / `changelog-derive`.
 */
import {readFileSync} from "node:fs";
import {Console, Effect} from "effect";
import * as Schema from "effect/Schema";
import {Command, Flag} from "effect/unstable/cli";
import {composeSubIssueBody, type SubIssueSpec, validateSubIssueSpec} from "./compose.ts";

const SPEC_ERROR_EXIT_CODE = 2;

class SpecError extends Schema.TaggedErrorClass<SpecError>()("SpecError", {
	message: Schema.String,
}) {}

/** The untrusted spec JSON, decoded at this boundary into the total `SubIssueSpec`. */
const SpecSchema = Schema.Struct({
	stories: Schema.String,
	tdd: Schema.Literals(["yes", "no"]),
	containment: Schema.optional(Schema.String),
	whatToBuild: Schema.String,
	acceptanceCriteria: Schema.Array(Schema.String),
});

const decodeSpec = Schema.decodeUnknownEffect(SpecSchema);

const specFlag = Flag.string("spec").pipe(
	Flag.optional,
	Flag.withDescription("path to the spec JSON; defaults to reading the spec from stdin"),
);

/** Read the raw spec text from `--spec <file>` or stdin (fd 0), any IO failure typed. */
const readSpec = (
	spec: {readonly _tag: "Some"; readonly value: string} | {readonly _tag: "None"},
) =>
	Effect.try({
		try: () => readFileSync(spec._tag === "Some" ? spec.value : 0, "utf8"),
		catch: (cause) =>
			new SpecError({
				message: `cannot read spec from ${spec._tag === "Some" ? spec.value : "stdin"}: ${String(cause)}`,
			}),
	});

const loadSpec = (
	specFlagValue: {readonly _tag: "Some"; readonly value: string} | {readonly _tag: "None"},
): Effect.Effect<SubIssueSpec, SpecError> =>
	readSpec(specFlagValue).pipe(
		Effect.flatMap((raw) =>
			Effect.try({
				try: () => JSON.parse(raw) as unknown,
				catch: (cause) => new SpecError({message: `spec is not valid JSON: ${String(cause)}`}),
			}),
		),
		Effect.flatMap((json) =>
			decodeSpec(json).pipe(
				Effect.mapError(
					(cause) =>
						new SpecError({message: `spec does not match the format-2 shape: ${String(cause)}`}),
				),
			),
		),
		Effect.map(
			(decoded): SubIssueSpec => ({
				stories: decoded.stories,
				tdd: decoded.tdd,
				...(decoded.containment !== undefined ? {containment: decoded.containment} : {}),
				whatToBuild: decoded.whatToBuild,
				acceptanceCriteria: decoded.acceptanceCriteria,
			}),
		),
	);

const onSpecError = (e: SpecError) =>
	Console.error(`intake-compose: ${e.message}`).pipe(
		Effect.flatMap(() => Effect.sync(() => process.exit(SPEC_ERROR_EXIT_CODE))),
	);

const subIssue = Command.make(
	"sub-issue",
	{spec: specFlag},
	Effect.fn(function* ({spec}) {
		const run = Effect.gen(function* () {
			const parsed = yield* loadSpec(spec);
			const violations = validateSubIssueSpec(parsed);
			if (violations.length > 0) {
				return yield* Effect.fail(
					new SpecError({
						message: `spec violates the format-2 contract:\n${violations.map((v) => `  - ${v}`).join("\n")}`,
					}),
				);
			}
			// The body goes to STDOUT by value — the leak-safe handoff (AC3). No `--out` file.
			yield* Console.log(composeSubIssueBody(parsed));
		});
		yield* run.pipe(Effect.catchTag("SpecError", onSpecError));
	}),
).pipe(
	Command.withDescription(
		"Compose a format-2 sub-issue body from a spec JSON and emit it to stdout (the leak-safe by-value handoff)",
	),
);

export const intakeComposeCommand = Command.make("intake-compose").pipe(
	Command.withSubcommands([subIssue]),
	Command.withDescription(
		"Compose an intake body per the gh-issue-intake-formats.md prose contract — one composer, not N re-derivations (#3254 / epic #3258)",
	),
);
