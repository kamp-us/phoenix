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
	// Pure decode cannot probe GitHub, so cross-epic refs are left unresolved here;
	// the IO boundary (`loadEpicLedger`) resolves and overrides this set.
	externalRefs: [],
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
	"@kampus/epic-ledger/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/epic-ledger/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/epic-ledger/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

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

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently
 * defaults to a repo: with no env and no resolvable current repo it fails
 * `RepoResolutionError`, so a foreign install can't accidentally operate on phoenix.
 */
const resolveRepo = Effect.fn("Github.resolveRepo")(function* () {
	const fromEnv = process.env.CLAUDE_PIPELINE_REPO ?? process.env.GITHUB_REPOSITORY;
	if (fromEnv && REPO_RE.test(fromEnv.trim())) {
		return fromEnv.trim();
	}
	const viewed = yield* runGh([
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"-q",
		".nameWithOwner",
	]).pipe(
		Effect.map((out) => out.trim()),
		Effect.catchTag("@kampus/epic-ledger/GhCommandError", () => Effect.succeed("")),
	);
	if (REPO_RE.test(viewed)) {
		return viewed;
	}
	return yield* new RepoResolutionError({
		message:
			"could not resolve a target repo: set CLAUDE_PIPELINE_REPO (or GITHUB_REPOSITORY), " +
			"or run inside a git repo whose origin `gh repo view` can read",
	});
});

const issueArgs = (repo: string, number: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${number}`,
];

const subIssuesArgs = (repo: string, number: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${number}/sub_issues?per_page=100`,
];

const PLANNED_LABEL = "status:planned";
const TRIAGED_LABEL = "status:triaged";
const NEEDS_INFO_LABEL = "status:needs-info";

const addLabelArgs = (repo: string, number: number, label: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues/${number}/labels`,
	"-f",
	`labels[]=${label}`,
];

const removeLabelArgs = (repo: string, number: number, label: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"DELETE",
	`repos/${repo}/issues/${number}/labels/${label}`,
];

const commentArgs = (repo: string, number: number, body: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues/${number}/comments`,
	"-f",
	`body=${body}`,
];

/** A sub-issue ref as the `sub_issues` endpoint returns it; only `number` is read. */
const SubIssueRef = Schema.Struct({number: Schema.Number});
const decodeSubIssueRefs = Schema.decodeUnknownEffect(Schema.Array(SubIssueRef));

/**
 * `Github` — the IO shell over `gh api` REST. `epicLedger` is the read half (an
 * epic number → a decoded `EpicLedger`); the three mutation methods are what the
 * `review-plan` gate action and the re-plan loop write through: a label flip on a
 * child, a verdict/diagnostic comment on an issue, and parking an epic at
 * `status:needs-info`. Built by `GithubLive`, whose `R` is `ChildProcessSpawner`:
 * provide the platform spawner (`NodeServices.layer` in production) to satisfy it;
 * a test provides a mock spawner via `ChildProcessSpawner.make`.
 *
 * Every mutation is scoped to exactly what the gate may touch (ADR 0047): a
 * child's `status:planned → status:triaged` flip, a verdict comment, and the
 * epic's `status:planned`-or-clean → `status:needs-info` park. It never edits a
 * brief, a topology, or a sub-issue link — those are unreachable through this
 * surface by construction.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly epicLedger: (
			epicNumber: number,
		) => Effect.Effect<EpicLedger, GhCommandError | GhParseError | Schema.SchemaError>;
		/** Flip a child's `status:planned` label to `status:triaged` (the gate's one mutation). */
		readonly flipChildToTriaged: (childNumber: number) => Effect.Effect<void, GhCommandError>;
		/** Post a comment (a verdict, or a park diagnostic) on an issue. */
		readonly postComment: (
			issueNumber: number,
			body: string,
		) => Effect.Effect<void, GhCommandError>;
		/** Park an epic: drop `status:planned`, add `status:needs-info`. */
		readonly parkNeedsInfo: (epicNumber: number) => Effect.Effect<void, GhCommandError>;
	}
>()("@kampus/epic-ledger/Github") {}

const json = Effect.fn("Github.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

/** A `gh` 404 — the only `gh` failure that means "this issue does not exist". */
const is404 = (stderr: string): boolean => /404|not found/i.test(stderr);

/**
 * Does issue `#n` resolve to a real issue in the repo? A clean 404 → `false`; any
 * other `gh` fault propagates rather than silently demoting a real dependency to a
 * dangling one. Open or closed both count as resolved — a `requires:` on a closed
 * (done) issue is the normal satisfied-dependency case.
 */
const issueExists = Effect.fn("Github.issueExists")(function* (repo: string, n: number) {
	return yield* runGh(issueArgs(repo, n)).pipe(
		Effect.as(true),
		Effect.catchTag("@kampus/epic-ledger/GhCommandError", (error) =>
			is404(error.stderr) ? Effect.succeed(false) : Effect.fail(error),
		),
	);
});

/**
 * Resolve the ledger's cross-epic gating edges: every `## Dependencies` ref that
 * is not a linked child of this epic is probed; the ones that resolve to a real
 * issue are the legitimate cross-epic dependencies the floor must not flag as
 * `DANGLING_DEP` (a ref that 404s is left out, so it still dangles). A
 * self-contained ledger has no candidates and so makes no extra `gh` calls.
 */
const resolveExternalRefs = Effect.fn("Github.resolveExternalRefs")(function* (
	repo: string,
	ledger: EpicLedger,
) {
	const childNumbers = new Set(ledger.children.map((c) => c.number));
	const candidates = ledger.epic.dependencies.nodes.filter(
		(n) => n !== ledger.epic.number && !childNumbers.has(n),
	);
	const probed = yield* Effect.forEach(
		candidates,
		(n) => Effect.map(issueExists(repo, n), (exists) => ({n, exists})),
		{concurrency: "unbounded"},
	);
	return probed.filter((r) => r.exists).map((r) => r.n);
});

const loadEpicLedger = Effect.fn("Github.epicLedger")(function* (repo: string, epicNumber: number) {
	const epic = yield* json(issueArgs(repo, epicNumber));
	const refs = yield* decodeSubIssueRefs(yield* json(subIssuesArgs(repo, epicNumber)));
	const children = yield* Effect.forEach(refs, (ref) => json(issueArgs(repo, ref.number)), {
		concurrency: "unbounded",
	});
	const ledger = yield* decodeEpicLedger({epic, children});
	return {...ledger, externalRefs: yield* resolveExternalRefs(repo, ledger)};
});

const flipChildToTriaged = Effect.fn("Github.flipChildToTriaged")(function* (
	repo: string,
	childNumber: number,
) {
	yield* runGh(addLabelArgs(repo, childNumber, TRIAGED_LABEL));
	yield* runGh(removeLabelArgs(repo, childNumber, PLANNED_LABEL));
});

const postComment = Effect.fn("Github.postComment")(function* (
	repo: string,
	issueNumber: number,
	body: string,
) {
	yield* runGh(commentArgs(repo, issueNumber, body));
});

const parkNeedsInfo = Effect.fn("Github.parkNeedsInfo")(function* (
	repo: string,
	epicNumber: number,
) {
	yield* runGh(addLabelArgs(repo, epicNumber, NEEDS_INFO_LABEL));
	yield* runGh(removeLabelArgs(repo, epicNumber, PLANNED_LABEL));
});

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once
 * at construction and provided *into* each method body, so the service's public
 * methods carry `R = never` — the spawner is the layer's requirement, not a
 * caller's. Provide the platform spawner (`NodeServices.layer`) to satisfy it.
 *
 * The target repo is resolved **once at layer build** (ADR 0062 §1:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` → `gh repo view`) and captured in the
 * closure for every method, so the gate operates on whatever repo it is run in — never
 * a silent phoenix default (#408).
 */
export const GithubLive: Layer.Layer<
	Github,
	RepoResolutionError,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(Github)(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		const repo = yield* withSpawner(resolveRepo());
		return {
			epicLedger: (epicNumber: number) => withSpawner(loadEpicLedger(repo, epicNumber)),
			flipChildToTriaged: (childNumber: number) =>
				withSpawner(flipChildToTriaged(repo, childNumber)),
			postComment: (issueNumber: number, body: string) =>
				withSpawner(postComment(repo, issueNumber, body)),
			parkNeedsInfo: (epicNumber: number) => withSpawner(parkNeedsInfo(repo, epicNumber)),
		};
	}),
);
