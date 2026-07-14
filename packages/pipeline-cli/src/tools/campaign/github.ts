/**
 * The GitHub boundary for `campaign verify-trace`: the live `Github` capability that gathers a
 * wave-labeled cluster and its approval markers over `gh api` REST, then drives the IO-free
 * `campaign-trace.ts` core. Same service pattern as the `verdict` / `epic-lock` template children
 * (epic #994): a `Context.Service` on `ChildProcessSpawner`, REST only (GraphQL is broken on the
 * kamp-us org), every infra failure a typed error in the `E` channel, untrusted REST JSON
 * Schema-decoded at the boundary into the domain shape the core resolves over.
 *
 * The founder identity is a REQUIRED input, injected by the caller (`command.ts` resolves it from
 * `--founder` or `$CAMPAIGN_FOUNDER_LOGIN`). It is never hardcoded here — a named identity in a
 * committed artifact is exactly what the repo forbids, and the trust anchor stays configurable.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {type ApprovalComment, type TraceVerdict, verifyTrace} from "./campaign-trace.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/campaign/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/campaign/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/campaign/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

/** The gathered facts plus the verdict — returned so the command can print the report and set exit. */
export interface VerifyResult {
	readonly verdict: TraceVerdict;
	readonly waveLabel: string;
	readonly clusterSize: number;
}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/**
 * Run `gh <args>` and return stdout, failing `GhCommandError` on a non-zero exit — the same
 * direct-spawn shape `verdict`/`epic-lock` use so a non-zero exit + stderr lower into a typed
 * error rather than a throw. A spawn/IO `PlatformError` (e.g. `gh` not on PATH) folds in as exit `-1`.
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

const json = Effect.fn("Github.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently defaults —
 * with no env and no resolvable current repo it fails `RepoResolutionError`.
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
		Effect.catchTag("@kampus/campaign/GhCommandError", () => Effect.succeed("")),
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

// REST-only arg builders — never GraphQL.

// `-X GET -f k=v` sends query params (with encoding), so a wave label with special chars is safe.
const clusterArgs = (repo: string, waveLabel: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"GET",
	`repos/${repo}/issues`,
	"-f",
	`labels=${waveLabel}`,
	"-f",
	"state=all",
	"-f",
	"per_page=100",
	"--paginate",
];

const commentsArgs = (repo: string, issue: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues/${issue}/comments?per_page=100`,
];

/** A raw issue as the issues endpoint returns it; `pull_request` present ⇒ it's a PR, filtered out. */
const RawIssue = Schema.Struct({
	number: Schema.Number,
	pull_request: Schema.optionalKey(Schema.Unknown),
});
const decodeIssues = Schema.decodeUnknownEffect(Schema.Array(RawIssue));

/** A raw comment as the issues/comments endpoint returns it; only these fields are read. */
const RawComment = Schema.Struct({
	id: Schema.Number,
	created_at: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.NullOr(Schema.Struct({login: Schema.String})),
});
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(RawComment));

/** The issue numbers carrying the wave label (PRs filtered out — the label binds to issues). */
const clusterIssues = Effect.fn("Github.clusterIssues")(function* (
	repo: string,
	waveLabel: string,
) {
	const args = clusterArgs(repo, waveLabel);
	const raw = yield* decodeIssues(yield* json(args));
	return raw.filter((r) => r.pull_request === undefined).map((r) => r.number);
});

/** Every comment on `issue`, mapped to the core's `ApprovalComment` (carrying the issue number). */
const issueComments = Effect.fn("Github.issueComments")(function* (repo: string, issue: number) {
	const args = commentsArgs(repo, issue);
	const raw = yield* decodeComments(yield* json(args));
	return raw.map(
		(c): ApprovalComment => ({
			id: c.id,
			author: c.user?.login ?? "",
			createdAt: c.created_at,
			body: c.body ?? "",
			issue,
		}),
	);
});

/**
 * Gather the wave-labeled cluster and its comments, then run the pure `verifyTrace`. The founder
 * login is handed in by the caller (never resolved here). Comments from every cluster issue are
 * pooled and handed whole to the core, which owns the marker grammar and the fail-closed decision.
 */
const verify = Effect.fn("Github.verify")(function* (
	repo: string,
	waveLabel: string,
	founderLogin: string,
) {
	const issues = yield* clusterIssues(repo, waveLabel);
	const perIssue = yield* Effect.forEach(issues, (issue) => issueComments(repo, issue), {
		concurrency: "unbounded",
	});
	const comments = perIssue.flat();
	const verdict = verifyTrace({
		waveLabel,
		founderLogin,
		clusterSize: issues.length,
		comments,
	});
	return {verdict, waveLabel, clusterSize: issues.length} satisfies VerifyResult;
});

/**
 * `Github` — the IO shell over `gh api` REST for `campaign verify-trace`. `verify` gathers the
 * wave-labeled cluster + its comments and resolves the founder-approval-trace verdict. Built by
 * `GithubLive`, whose `R` is `ChildProcessSpawner`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly verify: (
			waveLabel: string,
			founderLogin: string,
		) => Effect.Effect<
			VerifyResult,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/campaign/Github") {}

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once at construction
 * and provided into each method body, so the public method carries `R = never`. Repo resolution is
 * deferred to first use (`Effect.cached`, ADR 0062 §1): the layer build is side-effect-free, and
 * `RepoResolutionError` lives in the method's `E` channel, raised only when `verify` actually reads.
 */
export const GithubLive: Layer.Layer<Github, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(Github)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo()));
			return {
				verify: (waveLabel, founderLogin) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(verify(r, waveLabel, founderLogin)))),
			};
		}),
	);
