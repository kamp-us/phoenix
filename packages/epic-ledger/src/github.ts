/**
 * The GitHub trust boundary: decode untrusted `gh api` JSON into a domain
 * `EpicLedger`. Per `.patterns/effect-schema-validation.md`, Schema lives at the
 * trust boundary — here, where genuinely untyped REST responses enter — and not
 * past it: everything downstream (`validateLedger`, `isPickable`,
 * `ledgerSignature`) is total over the decoded `EpicLedger`.
 *
 * The raw GitHub shapes are decoded leniently (only the fields the floor needs,
 * extra fields ignored) into `GithubEpicInput`, then *transformed* into the
 * domain ledger: the epic body's `## Dependencies` markdown is lowered to a
 * `DependencyGraph`, and each sub-issue body's acceptance-criteria checklist is
 * counted. Markdown parsing happens here, at decode time, so the domain model
 * never carries raw markdown and the validator never parses.
 */
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import type {EpicLedger} from "./Ledger.ts";
import {countAcceptanceCriteria, parseDependencyGraph} from "./markdown.ts";

/** A GitHub label as REST returns it (`{name, ...}`); only `name` is read. */
const GithubLabel = Schema.Struct({
	name: Schema.String,
});

/** A null/absent issue body normalizes to the empty string before parsing. */
const GithubBody = Schema.optionalKey(Schema.NullOr(Schema.String));

/** The raw GitHub issue fields the ledger needs, lenient on everything else. */
const GithubIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	body: GithubBody,
	labels: Schema.Array(GithubLabel),
});

/** The untrusted input: the epic issue plus its linked sub-issues' JSON. */
export const GithubEpicInput = Schema.Struct({
	epic: GithubIssue,
	children: Schema.Array(GithubIssue),
});
export type GithubEpicInput = (typeof GithubEpicInput)["Type"];

const decodeInput = Schema.decodeUnknownEffect(GithubEpicInput);

const bodyOf = (body: string | null | undefined): string => body ?? "";

const labelNames = (labels: ReadonlyArray<{readonly name: string}>): ReadonlyArray<string> =>
	labels.map((l) => l.name);

const toLedger = (input: GithubEpicInput): EpicLedger => ({
	epic: {
		number: input.epic.number,
		title: input.epic.title,
		labels: labelNames(input.epic.labels),
		dependencies: parseDependencyGraph(bodyOf(input.epic.body)),
	},
	children: input.children.map((child) => ({
		number: child.number,
		title: child.title,
		labels: labelNames(child.labels),
		acceptanceCriteriaCount: countAcceptanceCriteria(bodyOf(child.body)),
	})),
});

/**
 * Decode untrusted GitHub JSON into an `EpicLedger`, parsing the epic's
 * `## Dependencies` topology and each child's acceptance-criteria count at the
 * boundary. Fails with Schema's `SchemaError` if the JSON is structurally
 * malformed (missing `number`/`title`/`labels`); succeeds with a ledger ready
 * for `validateLedger` otherwise.
 */
export const decodeEpicLedger = (input: unknown): Effect.Effect<EpicLedger, Schema.SchemaError> =>
	Effect.map(decodeInput(input), toLedger);
