/**
 * The GitHub boundary: decode untrusted `gh api` JSON into a domain `EpicLedger`
 * (`decodeEpicLedger`), plus the live `Github` capability that *reads* one by
 * shelling `gh api` REST.
 *
 * Per `.patterns/effect-schema-validation.md`, Schema lives at the trust
 * boundary — here, where genuinely untyped REST responses enter — and not past
 * it: everything downstream (`validateLedger`, `isPickable`, `ledgerSignature`)
 * is total over the decoded `EpicLedger`. The raw GitHub shapes are decoded
 * leniently (only the fields the floor needs, extra fields ignored) into
 * `GithubEpicInput`, then *transformed* into the domain ledger: the epic body's
 * `## Dependencies` topology and `### User stories` list are parsed, and each
 * sub-issue body's acceptance-criteria checklist and `**Stories:**` refs are
 * parsed too. Markdown parsing happens here, at decode time, so the domain model
 * never carries raw markdown and the validator never parses.
 *
 * The `Github` service is the IO shell over that boundary: a `Context.Service`
 * (`.patterns/effect-context-service.md`) on `ChildProcessSpawner`
 * (`effect/unstable/process`) — REST only, never GraphQL, which is broken on the
 * kamp-us org. Every infra failure is a typed error in the `E` channel, never a
 * throw (`.patterns/effect-errors.md`): a non-zero `gh` exit is `GhCommandError`,
 * malformed `gh` output is `GhParseError`, a structurally-invalid REST shape is
 * Schema's `SchemaError`.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {EpicLedger} from "./Ledger.ts";
import {
	countAcceptanceCriteria,
	parseChildStories,
	parseDependencyGraph,
	parseEpicStories,
} from "./markdown.ts";

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
		stories: parseEpicStories(bodyOf(input.epic.body)),
	},
	children: input.children.map((child) => ({
		number: child.number,
		title: child.title,
		labels: labelNames(child.labels),
		acceptanceCriteriaCount: countAcceptanceCriteria(bodyOf(child.body)),
		stories: parseChildStories(bodyOf(child.body)),
	})),
});

/**
 * Decode untrusted GitHub JSON into an `EpicLedger`, parsing the epic's
 * `## Dependencies` topology + `### User stories`, and each child's
 * acceptance-criteria count + `**Stories:**` refs, at the boundary. Fails with
 * Schema's `SchemaError` if the JSON is structurally malformed (missing
 * `number`/`title`/`labels`); succeeds with a ledger ready for `validateLedger`
 * otherwise.
 */
export const decodeEpicLedger = (input: unknown): Effect.Effect<EpicLedger, Schema.SchemaError> =>
	Effect.map(decodeInput(input), toLedger);

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@phoenix/epic-ledger/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@phoenix/epic-ledger/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

const REPO = "kamp-us/phoenix";

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/**
 * Run `gh <args>` and return stdout, failing `GhCommandError` on a non-zero
 * exit. `ChildProcessSpawner.string` only surfaces spawn/IO faults, not the
 * process's own exit code — so the handle is spawned directly to read `exitCode`
 * + `stderr` and lower a non-zero exit into a typed error, rather than returning
 * partial stdout as if the call had succeeded. A spawn/IO `PlatformError` (e.g.
 * `gh` not on PATH) is the other failure of running the command, so it folds into
 * the same typed `GhCommandError` (exit code `-1`); the `E` channel carries only
 * this package's typed errors, never a raw platform fault.
 */
const runGh = Effect.fn("Github.runGh")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("gh", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		if (exitCode !== 0) {
			return yield* new GhCommandError({args, exitCode, stderr});
		}
		return stdout;
	},
	Effect.scoped,
	(effect, args) =>
		Effect.catchTag(
			effect,
			"PlatformError",
			(cause) => new GhCommandError({args, exitCode: -1, stderr: cause.message}),
		),
);

const parseJson = (
	args: ReadonlyArray<string>,
	raw: string,
): Effect.Effect<unknown, GhParseError> =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new GhParseError({args, message: cause instanceof Error ? cause.message : String(cause)}),
	});

const issueArgs = (number: number): ReadonlyArray<string> => [
	"api",
	`repos/${REPO}/issues/${number}`,
];

const subIssuesArgs = (number: number): ReadonlyArray<string> => [
	"api",
	`repos/${REPO}/issues/${number}/sub_issues?per_page=100`,
];

/** A sub-issue ref as the `sub_issues` endpoint returns it; only `number` is read. */
const SubIssueRef = Schema.Struct({number: Schema.Number});
const decodeSubIssueRefs = Schema.decodeUnknownEffect(Schema.Array(SubIssueRef));

/**
 * `Github` — the IO shell that turns an epic number into a decoded `EpicLedger`.
 * Built by `GithubLive`, whose `R` is `ChildProcessSpawner`: provide the platform
 * spawner layer (`NodeServices.layer` in production) to satisfy it; a test
 * provides a mock spawner via `ChildProcessSpawner.make`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly epicLedger: (
			epicNumber: number,
		) => Effect.Effect<EpicLedger, GhCommandError | GhParseError | Schema.SchemaError>;
	}
>()("@phoenix/epic-ledger/Github") {}

const json = Effect.fn("Github.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

const loadEpicLedger = Effect.fn("Github.epicLedger")(function* (epicNumber: number) {
	const epic = yield* json(issueArgs(epicNumber));
	const refs = yield* decodeSubIssueRefs(yield* json(subIssuesArgs(epicNumber)));
	const children = yield* Effect.forEach(refs, (ref) => json(issueArgs(ref.number)), {
		concurrency: "unbounded",
	});
	return yield* decodeEpicLedger({epic, children});
});

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once
 * at construction and provided *into* each method body, so the service's public
 * methods carry `R = never` — the spawner is the layer's requirement, not a
 * caller's. Provide the platform spawner (`NodeServices.layer`) to satisfy it.
 */
export const GithubLive: Layer.Layer<Github, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(Github)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			return {
				epicLedger: (epicNumber: number) =>
					loadEpicLedger(epicNumber).pipe(
						Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
					),
			};
		}),
	);
