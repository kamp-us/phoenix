/**
 * The `gh api` REST boundary for `leak-guard scan-pr`: fetch a PR's landed comments — both the
 * issue conversation (where `review-*` verdict markers live) AND the inline review comments — so the
 * pure `scanPrComments` core can re-check them for machine-local path leaks. REST only (GraphQL is
 * broken on the kamp-us org); untrusted REST JSON is Schema-decoded at the boundary into the domain
 * `PrComment` the core scans. See issue #3019.
 *
 * Same service shape as `verdict`'s `Github` (a `Context.Service` on `ChildProcessSpawner`, repo
 * resolved once per ADR 0062 §1, every infra fault a typed error) — a deliberately separate, minimal
 * boundary: this tool only READS the two comment endpoints, it never posts.
 */
import {Context, Effect, Layer, Schedule, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {PrComment} from "./scan-pr.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/leak-guard/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/leak-guard/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/leak-guard/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

/**
 * The scan could not READ the PR's comments — GitHub was transiently unavailable (5xx / a
 * transport reset) and stayed so past the bounded retry budget. The THIRD outcome the scan
 * needs (#3710): distinct from a clean pass, a real leak finding (`LeakFound`), AND a terminal
 * `GhCommandError` (auth/not-found). At the ship-it Step 3.7 gate this fails SAFE — a leak gate
 * must never PASS what it could not verify — but legibly ("could not verify, retry"), never as
 * an opaque stack trace posing as a finding.
 */
export class UpstreamUnavailableError extends Schema.TaggedErrorClass<UpstreamUnavailableError>()(
	"@kampus/leak-guard/UpstreamUnavailableError",
	{
		pr: Schema.Number,
		attempts: Schema.Number,
		lastExitCode: Schema.Number,
		detail: Schema.String,
	},
) {}

// A transient upstream status worth retrying: the 5xx gateway/overload family plus 429
// (rate limit). Anything else — 401/403/404/422 — is a REAL terminal answer and stays
// fatal-fast, so a genuine auth/not-found error is never masked as a blip (issue #3710
// scope guard; the same 429+5xx set orphan-sweep's `RETRYABLE_STATUSES` retries).
const TRANSIENT_HTTP_STATUS_RE = /\bHTTP\s+(429|5\d\d)\b/i;
// Network/transport faults `gh` surfaces without an HTTP status — the read never reached
// GitHub, so it proved nothing and is retryable like a 5xx. `exitCode === -1` is our own
// PlatformError mapping (spawn/transport failure), a transient by construction.
const TRANSIENT_TRANSPORT_RE =
	/\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND|connection reset|connection refused|timed?\s*out|TLS handshake|i\/o timeout|network is unreachable|temporary failure|EOF occurred)\b/i;

/**
 * Is this `gh` failure a TRANSIENT transport/availability blip (retry) rather than a terminal
 * answer (fail fast)? Pure and total over the captured error, so the discrimination is the
 * unit-tested contract. Mirrors `orphan-heal`'s `provesAbsent` inverse: only a positive
 * transient signal (5xx/429, a transport reset, or our `-1` PlatformError code) is retried;
 * every other exit — a 4xx, a decode/logic error — is terminal and passes through unchanged.
 */
export const isTransientGh = (error: GhCommandError): boolean => {
	if (error.exitCode === -1) return true;
	const stderr = error.stderr ?? "";
	return TRANSIENT_HTTP_STATUS_RE.test(stderr) || TRANSIENT_TRANSPORT_RE.test(stderr);
};

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const runGh = Effect.fn("LeakGuardGithub.runGh")(
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

const json = Effect.fn("LeakGuardGithub.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/** Resolve the target repo (`owner/name`) per ADR 0062 §1: env override → CI env → `gh repo view`. */
const resolveRepo = Effect.fn("LeakGuardGithub.resolveRepo")(function* () {
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
		Effect.catchTag("@kampus/leak-guard/GhCommandError", () => Effect.succeed("")),
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

// REST-only arg builders — never GraphQL. Issue comments carry the `review-*` verdict markers; the
// inline review comments are the diff-anchored surface — both are public, both get scanned.
const issueCommentsArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues/${pr}/comments?per_page=100`,
];

const reviewCommentsArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/pulls/${pr}/comments?per_page=100`,
];

/** A raw comment as either comments endpoint returns it; only these two fields are read. */
const RawComment = Schema.Struct({
	id: Schema.Number,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(RawComment));

const fetchComments = Effect.fn("LeakGuardGithub.fetchComments")(function* (
	args: ReadonlyArray<string>,
	kind: PrComment["kind"],
) {
	const raw = yield* decodeComments(yield* json(args));
	return raw.map((c): PrComment => ({id: c.id, kind, body: c.body ?? ""}));
});

/**
 * `PrComments` — the IO shell over `gh api` REST that fetches a PR's issue + inline-review comments
 * for `scanPrComments` to re-check. Built by `PrCommentsLive`, whose `R` is `ChildProcessSpawner`.
 */
export class PrComments extends Context.Service<
	PrComments,
	{
		readonly fetch: (
			pr: number,
		) => Effect.Effect<
			ReadonlyArray<PrComment>,
			| RepoResolutionError
			| GhCommandError
			| GhParseError
			| Schema.SchemaError
			| UpstreamUnavailableError
		>;
	}
>()("@kampus/leak-guard/PrComments") {}

// Bounded exponential backoff for the comment read: ~0.5s, 1, 2, 4s across up to 4 retries
// (5 attempts total, ~7.5s worst case) — enough to ride out a transient GH 5xx blip without
// holding the ship-it gate open through a sustained outage. Grounded in effect-smol `LLMS.md`
// §"Working with Schedules" (`Schedule.both(exponential, recurs(N))` = capped backoff), the
// same idiom as `apps/web/worker/features/fate-live/cold-start-retry.ts` and
// `packages/orphan-sweep/src/cloudflare.ts`.
const MAX_RETRIES = 4;
const RETRY_ATTEMPTS = MAX_RETRIES + 1;
const DEFAULT_RETRY_SCHEDULE = Schedule.both(
	Schedule.exponential("500 millis"),
	Schedule.recurs(MAX_RETRIES),
);

type FetchError = GhCommandError | GhParseError | Schema.SchemaError;

/** A `gh` read that failed transient — the only class the retry re-drives / the unknown seam converts. */
const isTransientFetchError = (error: FetchError): error is GhCommandError =>
	error._tag === "@kampus/leak-guard/GhCommandError" && isTransientGh(error);

/** First non-empty stderr line, trimmed — a legible reason for the unknown outcome, never a dump. */
const firstLine = (text: string): string => (text.split("\n")[0] ?? "").trim().slice(0, 200);

/**
 * The `PrComments` layer, parameterized by its retry schedule so a unit test can inject a
 * zero-delay budget (the production default is {@link DEFAULT_RETRY_SCHEDULE}). `ChildProcessSpawner`
 * is captured once at construction and provided into each method, so the public method carries
 * `R = never`. Repo resolution is deferred to first use (`Effect.cached`, ADR 0062 §1) — the layer
 * build is side-effect-free.
 */
export const makePrCommentsLive = (
	retrySchedule: Schedule.Schedule<unknown, unknown> = DEFAULT_RETRY_SCHEDULE,
): Layer.Layer<PrComments, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.effect(PrComments)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo()));
			return {
				fetch: (pr) =>
					repo.pipe(
						Effect.flatMap((r) =>
							withSpawner(
								Effect.gen(function* () {
									const issue = yield* fetchComments(issueCommentsArgs(r, pr), "issue");
									const review = yield* fetchComments(reviewCommentsArgs(r, pr), "review");
									return [...issue, ...review];
								}),
							).pipe(
								// Ride out a transient 5xx / transport blip with bounded backoff. A 4xx (auth /
								// not-found) or a decode error is NOT transient, so `while` is false and it fails
								// fast — a real terminal error is never masked as a retry.
								Effect.retry({schedule: retrySchedule, while: isTransientFetchError}),
								// A read STILL transient past the budget is the third outcome: map it to the typed
								// UpstreamUnavailableError so the gate blocks legibly (fail-safe), never on a raw
								// GhCommandError stack trace conflated with a leak finding (#3710).
								Effect.catchIf(isTransientFetchError, (error) =>
									Effect.fail(
										new UpstreamUnavailableError({
											pr,
											attempts: RETRY_ATTEMPTS,
											lastExitCode: error.exitCode,
											detail: firstLine(error.stderr),
										}),
									),
								),
							),
						),
					),
			};
		}),
	);

/** The production `PrComments` layer — the bounded-backoff retry over the real GH boundary. */
export const PrCommentsLive: Layer.Layer<
	PrComments,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = makePrCommentsLive();
