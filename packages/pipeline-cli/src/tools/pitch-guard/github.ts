/**
 * The GitHub boundary for `pitch-guard`: the live `PitchCandidates` capability that reads the
 * open `status:triaged` set, each candidate's parent + body, its comments, and the `write+` ACL
 * of every comment author — so the pure core can judge founder approval. Same service pattern as
 * `homing-guard`'s `TriagedIssues` (epic #994): a `Context.Service` on `ChildProcessSpawner`,
 * REST only (GraphQL is broken on the kamp-us org), every infra failure a typed error in the `E`
 * channel, untrusted REST JSON Schema-decoded at the boundary.
 *
 * The ACL resolution lives here rather than in the core so the core stays IO-free: a comment
 * crosses the seam already carrying `authorized`, resolved fail-closed (ADR 0055) — an
 * unreadable permission is NOT authorized.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {type Candidate, LANE_ENTERING_TYPES, TRIAGED_LABEL} from "./pitch-guard.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/pitch-guard/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/pitch-guard/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/pitch-guard/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

export type PitchGuardError =
	| RepoResolutionError
	| GhCommandError
	| GhParseError
	| Schema.SchemaError;

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const runGh = Effect.fn("PitchCandidates.runGh")(
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

const json = Effect.fn("PitchCandidates.json")(function* (args: ReadonlyArray<string>) {
	const raw = yield* runGh(args);
	return yield* Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new GhParseError({args, message: cause instanceof Error ? cause.message : String(cause)}),
	});
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently defaults.
 */
const resolveRepo = Effect.fn("PitchCandidates.resolveRepo")(function* () {
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
		Effect.catchTag("@kampus/pitch-guard/GhCommandError", () => Effect.succeed("")),
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

// `--slurp` because bare `--paginate` concatenates one JSON array per page — unparseable as a
// whole once the triaged set passes 100 (#3762). `--slurp` wraps the pages in an array instead.
const triagedArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"GET",
	`repos/${repo}/issues`,
	"-f",
	"state=open",
	"-f",
	`labels=${TRIAGED_LABEL}`,
	"-f",
	"per_page=100",
	"--paginate",
	"--slurp",
];

/**
 * A raw issue; `pull_request` present ⇒ a PR, filtered out.
 *
 * Sub-issue-ness is read from **`parent_issue_url`** — the field the single-issue REST payload
 * actually carries. `parent` is accepted alongside it because the sub-issues API has shipped both
 * shapes; reading only `parent` resolves every sub-issue as parentless, which would silently pull
 * every epic child into scope and demand a pitch it inherits.
 */
const RawIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
	labels: Schema.Array(Schema.Struct({name: Schema.String})),
	pull_request: Schema.optionalKey(Schema.Unknown),
	parent: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
	parent_issue_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
type RawIssue = typeof RawIssue.Type;

const hasParent = (raw: RawIssue): boolean =>
	(raw.parent !== undefined && raw.parent !== null) ||
	(raw.parent_issue_url !== undefined && raw.parent_issue_url !== null);

const RawComment = Schema.Struct({
	body: Schema.NullOr(Schema.String),
	user: Schema.NullOr(Schema.Struct({login: Schema.String})),
});

const decodePages = Schema.decodeUnknownEffect(Schema.Array(Schema.Array(RawIssue)));
const decodeIssue = Schema.decodeUnknownEffect(RawIssue);
const decodeCommentPages = Schema.decodeUnknownEffect(Schema.Array(Schema.Array(RawComment)));

/**
 * The cheap pre-filter: label-only. It cannot see `hasParent` (the list endpoint omits it), so a
 * sub-issue survives here and is excluded by the core's `isLaneEntering` after the per-issue read
 * below resolves its parent.
 */
const looksLaneEntering = (raw: RawIssue): boolean =>
	raw.pull_request === undefined &&
	raw.labels.some((l) => l.name === TRIAGED_LABEL) &&
	raw.labels.some((l) => LANE_ENTERING_TYPES.includes(l.name));

const commentArgs = (repo: string, issue: number): ReadonlyArray<string> => [
	"api",
	"-X",
	"GET",
	`repos/${repo}/issues/${issue}/comments`,
	"-f",
	"per_page=100",
	"--paginate",
	"--slurp",
];

const permissionArgs = (repo: string, login: string): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/collaborators/${login}/permission`,
	"--jq",
	".permission",
];

const WRITE_PLUS: ReadonlyArray<string> = ["admin", "maintain", "write"];

/**
 * Resolve one login against the ADR 0055 trust root. Fail-closed by construction: a non-zero
 * `gh` exit (not a collaborator, a rate limit, a lost token) resolves NOT authorized rather than
 * erroring the run — a forged or unverifiable approval must never count.
 */
const isWritePlus = Effect.fn("PitchCandidates.isWritePlus")(function* (
	repo: string,
	login: string,
) {
	const permission = yield* runGh(permissionArgs(repo, login)).pipe(
		Effect.map((out) => out.trim()),
		Effect.catchTag("@kampus/pitch-guard/GhCommandError", () => Effect.succeed("")),
	);
	return WRITE_PLUS.includes(permission);
});

const hydrate = Effect.fn("PitchCandidates.hydrate")(function* (repo: string, raw: RawIssue) {
	const pages = yield* decodeCommentPages(yield* json(commentArgs(repo, raw.number)));
	const rawComments = pages.flat();
	const logins = [...new Set(rawComments.map((c) => c.user?.login).filter((l) => l !== undefined))];
	const permissions = yield* Effect.forEach(
		logins,
		(login) => isWritePlus(repo, login).pipe(Effect.map((ok) => [login, ok] as const)),
		{concurrency: 4},
	);
	const authorized = new Map(permissions);
	const candidate: Candidate = {
		number: raw.number,
		title: raw.title,
		labels: raw.labels.map((l) => l.name),
		hasParent: hasParent(raw),
		body: raw.body ?? "",
		comments: rawComments.map((c) => ({
			author: c.user?.login ?? "",
			authorized: authorized.get(c.user?.login ?? "") ?? false,
			body: c.body ?? "",
		})),
	};
	return candidate;
});

const oneIssueArgs = (repo: string, issue: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${issue}`,
];

const listCandidates = Effect.fn("PitchCandidates.list")(function* (repo: string) {
	const pages = yield* decodePages(yield* json(triagedArgs(repo)));
	const shortlist = pages.flat().filter(looksLaneEntering);
	// Re-read each shortlisted issue singly: the list endpoint omits `parent`, and a sub-issue
	// inherits its epic's pitch, so the parent fact decides scope.
	const full = yield* Effect.forEach(
		shortlist,
		(raw) => Effect.flatMap(json(oneIssueArgs(repo, raw.number)), decodeIssue),
		{concurrency: 2},
	);
	return yield* Effect.forEach(full, (raw) => hydrate(repo, raw), {concurrency: 2});
});

const getCandidate = Effect.fn("PitchCandidates.get")(function* (repo: string, issue: number) {
	const raw = yield* decodeIssue(yield* json(oneIssueArgs(repo, issue)));
	if (raw.pull_request !== undefined) return [];
	return [yield* hydrate(repo, raw)];
});

/**
 * `PitchCandidates` — the IO shell over `gh api` REST. `list` reads the whole open
 * `status:triaged` lane-entering shortlist; `get` reads one issue (the core decides scope, so an
 * out-of-scope issue simply judges as out-of-scope).
 */
export class PitchCandidates extends Context.Service<
	PitchCandidates,
	{
		readonly list: () => Effect.Effect<ReadonlyArray<Candidate>, PitchGuardError>;
		readonly get: (issue: number) => Effect.Effect<ReadonlyArray<Candidate>, PitchGuardError>;
	}
>()("@kampus/pitch-guard/PitchCandidates") {}

/**
 * The live layer. The `ChildProcessSpawner` dependency is captured once at construction and
 * provided into each method body, so the public methods carry `R = never`. Repo resolution is
 * deferred to first use (`Effect.cached`, ADR 0062 §1).
 */
export const PitchCandidatesLive: Layer.Layer<
	PitchCandidates,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(PitchCandidates)(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		const repo = yield* Effect.cached(withSpawner(resolveRepo()));
		return {
			list: () => repo.pipe(Effect.flatMap((r) => withSpawner(listCandidates(r)))),
			get: (issue: number) => repo.pipe(Effect.flatMap((r) => withSpawner(getCandidate(r, issue)))),
		};
	}),
);
