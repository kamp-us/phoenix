/**
 * The GitHub boundary for `orphan-heal`: the live `Github` capability that reads the open-PR
 * set, each head's CI conclusion, each PR's linked-issue lane state, and the existing
 * heal-item set over `gh api` REST, and files a heal-item issue — feeding the IO-free
 * `orphan-heal.ts` core.
 *
 * Same service pattern as the `intake-dedup` / `verdict` children (epic #994): a
 * `Context.Service` on `ChildProcessSpawner`, REST only (GraphQL is broken on the kamp-us
 * org), every infra failure a typed error in the `E` channel, untrusted REST JSON
 * Schema-decoded at the boundary. All reads are from EXISTING state (open PRs, head
 * check-runs, issue labels, open issues) — the #3650 AC forbids inventing a new lane store.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {
	type CiConclusion,
	extractHealTargets,
	type LaneState,
	parseClosingRefs,
} from "./orphan-heal.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/orphan-heal/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/orphan-heal/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/orphan-heal/RepoResolutionError",
	{message: Schema.String},
) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

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

/** Resolve the target repo (`owner/name`) per ADR 0062 §1: env override → `GITHUB_REPOSITORY` → `gh repo view`. */
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
		Effect.catchTag("@kampus/orphan-heal/GhCommandError", () => Effect.succeed("")),
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

// The failing check-run conclusions that make a head CI-red (GitHub's check-run vocabulary).
const RED_CONCLUSIONS = new Set([
	"failure",
	"timed_out",
	"cancelled",
	"action_required",
	"startup_failure",
]);

/** An open PR row from the pulls endpoint (draft flag + head sha + body carry the gate inputs). */
const RawPr = Schema.Struct({
	number: Schema.Number,
	draft: Schema.optionalKey(Schema.Boolean),
	body: Schema.NullOr(Schema.String),
	head: Schema.Struct({sha: Schema.String}),
});
const decodePrs = Schema.decodeUnknownEffect(Schema.Array(RawPr));

/** A single head check-run (name + conclusion + when it completed — the red-since anchor). */
const CheckRun = Schema.Struct({
	name: Schema.String,
	conclusion: Schema.NullOr(Schema.String),
	completed_at: Schema.NullOr(Schema.String),
});
const CheckRuns = Schema.Struct({check_runs: Schema.Array(CheckRun)});
const decodeCheckRuns = Schema.decodeUnknownEffect(CheckRuns);

/** The legacy combined-status envelope — covers commit statuses that aren't check-runs. */
const CombinedStatus = Schema.Struct({state: Schema.String});
const decodeCombinedStatus = Schema.decodeUnknownEffect(CombinedStatus);

const IssueLabels = Schema.Struct({labels: Schema.Array(Schema.Struct({name: Schema.String}))});
const decodeIssueLabels = Schema.decodeUnknownEffect(IssueLabels);

/** An open issue row (body carries the heal-target marker; a `pull_request` key means it's a PR — dropped). */
const RawIssue = Schema.Struct({
	number: Schema.Number,
	body: Schema.NullOr(Schema.String),
	pull_request: Schema.optionalKey(Schema.Unknown),
});
const decodeIssues = Schema.decodeUnknownEffect(Schema.Array(RawIssue));

const CreatedIssue = Schema.Struct({number: Schema.Number, html_url: Schema.String});
const decodeCreated = Schema.decodeUnknownEffect(CreatedIssue);

/** A resolved open PR: the raw gate inputs the command turns into a `PrSnapshot`. */
export interface OpenPr {
	readonly number: number;
	readonly isDraft: boolean;
	readonly headSha: string;
	readonly body: string;
}

/** The rolled-up head-CI verdict for one PR. */
export interface HeadCi {
	readonly conclusion: CiConclusion;
	readonly redSince?: string | undefined;
	readonly failingCheck?: string | undefined;
}

const listOpenPrs = Effect.fn("Github.listOpenPrs")(function* (repo: string) {
	const args = ["api", "--paginate", `repos/${repo}/pulls?state=open&per_page=100`];
	const rows = yield* decodePrs(yield* json(args));
	return rows.map(
		(r): OpenPr => ({
			number: r.number,
			isDraft: r.draft ?? false,
			headSha: r.head.sha,
			body: r.body ?? "",
		}),
	);
});

const headCi = Effect.fn("Github.headCi")(function* (repo: string, sha: string) {
	const checkArgs = ["api", "--paginate", `repos/${repo}/commits/${sha}/check-runs?per_page=100`];
	const {check_runs} = yield* decodeCheckRuns(yield* json(checkArgs));
	const statusArgs = ["api", `repos/${repo}/commits/${sha}/status`];
	const {state} = yield* decodeCombinedStatus(yield* json(statusArgs));

	const failing = check_runs.filter(
		(c) => c.conclusion !== null && RED_CONCLUSIONS.has(c.conclusion),
	);
	const isRed = failing.length > 0 || state === "failure";
	if (!isRed) {
		// pending ⇒ some check still running or the combined status is pending; else green.
		const anyPending = state === "pending" || check_runs.some((c) => c.conclusion === null);
		const conclusion: CiConclusion =
			check_runs.length === 0 && state === "pending" ? "pending" : anyPending ? "pending" : "green";
		return {conclusion} satisfies HeadCi;
	}

	// red-since: the LATEST failing completion — conservative, so a just-failed head waits the
	// full grace window rather than being flagged the instant CI finishes red.
	const completions = failing
		.map((c) => c.completed_at)
		.filter((t): t is string => typeof t === "string");
	const redSince =
		completions.length > 0
			? completions.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b))
			: undefined;
	return {
		conclusion: "red",
		redSince,
		failingCheck: failing[0]?.name,
	} satisfies HeadCi;
});

/** One closing ref's lane reading. `unknown` ⇒ the read could not execute, so it decides nothing. */
type LaneProbe = "triaged" | "laneless" | "unknown";

/**
 * Did this `gh` failure prove the issue is not there (a definite answer), or merely prevent the
 * read (no answer)? Only a 404 proves absence — a nonexistent or other-repo closing ref. A 5xx,
 * an auth/rate-limit rejection, or a transport failure (`exitCode: -1`) all mean the probe never
 * executed, which is `unknown`, never a negative that drives a file (#3701).
 */
const provesAbsent = (error: GhCommandError): boolean => /HTTP 404|not found/i.test(error.stderr);

const issueIsTriaged = Effect.fn("Github.issueIsTriaged")(function* (repo: string, n: number) {
	const args = ["api", `repos/${repo}/issues/${n}`];
	const read = Effect.gen(function* () {
		const {labels} = yield* decodeIssueLabels(yield* json(args));
		return (labels.some((l) => l.name === "status:triaged") ? "triaged" : "laneless") as LaneProbe;
	});
	return yield* read.pipe(
		Effect.catchTag(
			"@kampus/orphan-heal/GhCommandError",
			(error): Effect.Effect<LaneProbe> =>
				Effect.succeed(provesAbsent(error) ? "laneless" : "unknown"),
		),
		// A payload that won't parse/decode is a bad ref, not an outage — laneless, and the sweep
		// carries on rather than aborting on one ref (the #3532 non-aborting behavior).
		Effect.orElseSucceed((): LaneProbe => "laneless"),
	);
});

/**
 * Is the PR in an engine lane? Derived from EXISTING state: it closes at least one
 * `status:triaged` issue (engine-opened-from-a-triaged-issue). A PR that closes no triaged
 * issue — a hand-/conversation-authored ADR/ROADMAP PR — is laneless (the orphan shape, #3532).
 *
 * Tri-state, and the precedence is what keeps it fail-closed: one confirmed triaged ref proves
 * `laned` outright, but concluding `laneless` requires every ref to have actually been read — a
 * single `unknown` among them means the evidence is incomplete, so the whole PR defers (#3701).
 */
const inEngineLane = Effect.fn("Github.inEngineLane")(function* (repo: string, body: string) {
	const refs = parseClosingRefs(body);
	if (refs.length === 0) return "laneless" as LaneState;
	const probes = yield* Effect.all(
		refs.map((n) => issueIsTriaged(repo, n)),
		{concurrency: "unbounded"},
	);
	if (probes.some((p) => p === "triaged")) return "laned" as LaneState;
	return (probes.some((p) => p === "unknown") ? "unknown" : "laneless") as LaneState;
});

const existingHealTargets = Effect.fn("Github.existingHealTargets")(function* (repo: string) {
	const args = ["api", "--paginate", `repos/${repo}/issues?state=open&per_page=100`];
	const rows = yield* decodeIssues(yield* json(args));
	const targets = new Set<number>();
	for (const r of rows) {
		if (r.pull_request !== undefined) continue; // the issues endpoint returns PRs too
		for (const t of extractHealTargets(r.body ?? "")) targets.add(t);
	}
	return targets as ReadonlySet<number>;
});

const createHealItem = Effect.fn("Github.createHealItem")(function* (
	repo: string,
	input: {readonly title: string; readonly body: string; readonly labels: ReadonlyArray<string>},
) {
	const labelArgs = input.labels.flatMap((l) => ["-f", `labels[]=${l}`]);
	const args = [
		"api",
		"-X",
		"POST",
		`repos/${repo}/issues`,
		"-f",
		`title=${input.title}`,
		"-f",
		`body=${input.body}`,
		...labelArgs,
	];
	const created = yield* decodeCreated(yield* json(args));
	return {number: created.number, url: created.html_url};
});

type GhError = RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError;

/**
 * `Github` — the IO shell over `gh api` REST for the orphan-heal reads + the heal-item write.
 * Built by `GithubLive`, whose `R` is `ChildProcessSpawner`; repo resolution is cached and
 * deferred to first use (ADR 0062 §1), so the layer build is side-effect-free.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly repoName: () => Effect.Effect<string, GhError>;
		readonly listOpenPrs: () => Effect.Effect<ReadonlyArray<OpenPr>, GhError>;
		readonly headCi: (sha: string) => Effect.Effect<HeadCi, GhError>;
		readonly inEngineLane: (body: string) => Effect.Effect<LaneState, GhError>;
		readonly existingHealTargets: () => Effect.Effect<ReadonlySet<number>, GhError>;
		readonly createHealItem: (input: {
			readonly title: string;
			readonly body: string;
			readonly labels: ReadonlyArray<string>;
		}) => Effect.Effect<{readonly number: number; readonly url: string}, GhError>;
	}
>()("@kampus/orphan-heal/Github") {}

export const GithubLive: Layer.Layer<Github, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(Github)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo()));
			return {
				repoName: () => repo,
				listOpenPrs: () => repo.pipe(Effect.flatMap((r) => withSpawner(listOpenPrs(r)))),
				headCi: (sha) => repo.pipe(Effect.flatMap((r) => withSpawner(headCi(r, sha)))),
				inEngineLane: (body) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(inEngineLane(r, body)))),
				existingHealTargets: () =>
					repo.pipe(Effect.flatMap((r) => withSpawner(existingHealTargets(r)))),
				createHealItem: (input) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(createHealItem(r, input)))),
			};
		}),
	);
