/**
 * The `Tracker` service — the shared Effect capability over the crew's issue tracker
 * surface (claims, triage, verdicts, graduation) with **domain-shaped** signatures.
 *
 * This is the walking skeleton of Wave 1 (epic #3258): a `Context.Service` `Tracker`
 * tag plus its sole implementation `GithubTrackerLive`. It seeds one verb end to end —
 * `claim` (the ADR-0115 agent-distinguishable claim) and a generic `readBack` — and
 * *declares* the not-yet-built verbs (`applyTriage` / `postVerdict` / `graduate`) so the
 * interface shape is complete before it locks; sibling Phase-3 children implement them.
 *
 * Two design rules bind every signature here and are the point of the skeleton:
 *
 *  - **Design against two backends, build one (ADR 0190).** `GithubTrackerLive` is the
 *    only implementation now, but the interface must stay implementable over the two
 *    downstream #3256 targets *without a reshape*: **Asana** (no sub-issues, no
 *    GitHub-style label strings) and **local-markdown** (no ACL trust root). So no
 *    signature carries a sub-issue id, a label string, or an ACL/REST idiom — those are
 *    implementation details `GithubTrackerLive` hides. A `TargetId` is a bare domain
 *    entity reference; a judgment carries the domain decision; a result carries a domain
 *    owner (not a raw comment id). The GitHub ACL trust root (ADR 0055) lives entirely
 *    inside the live impl, never in the interface — local-markdown has none.
 *  - **Typed failures, never a throw (`.patterns/effect-errors.md`).** Every infra fault
 *    is in the `E` channel — a non-zero `gh` exit is `GhCommandError`, malformed output
 *    `GhParseError`, an unresolvable repo `RepoResolutionError`; untrusted REST JSON is
 *    Schema-decoded at the boundary (`.patterns/effect-schema-validation.md`).
 *
 * The IO shell (`runGh` / `resolveRepo` / `authorizedAuthors`) mirrors the same idiom the
 * `epic-lock` and `verdict` tools each carry (`epic-lock/github.ts`, `verdict/github.ts`);
 * consolidating those consumers onto this one shared service is the same-commit-adoption
 * follow-up (#3262 AC 5). The pure claim-resolution decision is reused from the existing
 * IO-free, ADR-0040-tested core (`../epic-lock/claim-resolution.ts`) rather than
 * re-derived — the single source of "who owns this claim" (gh-issue-intake-formats.md §7).
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {type ClaimComment, type ClaimWinner, resolveWinner} from "../epic-lock/claim-resolution.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/tracker/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/tracker/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/tracker/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

/**
 * A declared-but-not-yet-built verb was called. The skeleton ships `claim` + `readBack`
 * live; `applyTriage` / `postVerdict` / `graduate` fail-closed with this typed error
 * until a sibling Phase-3 child implements them — never a silent no-op or a throw.
 */
export class TrackerNotImplementedError extends Schema.TaggedErrorClass<TrackerNotImplementedError>()(
	"@kampus/tracker/TrackerNotImplementedError",
	{
		verb: Schema.String,
	},
) {}

/**
 * A tracker entity reference — the domain id of the thing a verb acts on. Kept an opaque
 * domain number so no backend's addressing leaks into a signature (ADR 0190): GitHub reads
 * it as an issue number; an Asana/local-markdown adapter maps its own id at the boundary.
 */
export type TargetId = number;

/** The resolved owner of a claim, domain-shaped: the winning session + when it claimed. */
export interface ClaimOwner {
	readonly session: string;
	readonly claimedAt: string;
}

/** The agent-distinguishable claim decision (ADR 0115): who is claiming (the session id). */
export interface ClaimJudgment {
	readonly session: string;
}

/** The `claim` verdict — we own it, a pre-existing owner holds it, or we lost a co-race. */
export type ClaimResult =
	| {readonly _tag: "claimed"; readonly session: string}
	| {readonly _tag: "held-by-other"; readonly owner: ClaimOwner}
	| {readonly _tag: "lost"; readonly owner: ClaimOwner | null};

/** The generic `readBack` verdict — the resolved owner, or that the target is unclaimed. */
export type ReadBackResult =
	| {readonly _tag: "owned"; readonly owner: ClaimOwner}
	| {readonly _tag: "unclaimed"};

// The declared (not-yet-built) verbs' domain judgments. Their exact shapes are owned by the
// sibling Phase-3 children that implement them; declared here only so the interface is
// complete before it locks (ADR 0190). Each stays domain-shaped — no label string, no
// sub-issue id, no REST field — so a later Asana/local-markdown adapter needs no reshape.

/** Triage classification: the domain type + priority a triage decision assigns. */
export interface TriageJudgment {
	readonly type: string;
	readonly priority: string;
}

/** A gate verdict: which gate, whether it passed, and the head ref it is bound to. */
export interface VerdictJudgment {
	readonly gate: string;
	readonly passed: boolean;
	readonly headRef: string;
}

/** A lifecycle graduation: the stage the target moves to. */
export interface GraduateJudgment {
	readonly stage: string;
}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/**
 * Run `gh <args>` and return stdout, failing `GhCommandError` on a non-zero exit — the
 * same direct-spawn shape `epic-lock`/`verdict` use so an exit code + stderr lower into a
 * typed error rather than a throw. A spawn/IO `PlatformError` (e.g. `gh` off PATH) folds
 * into the same typed error as exit `-1`.
 */
const runGh = Effect.fn("Tracker.runGh")(
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

const json = Effect.fn("Tracker.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently
 * defaults: with no env and no resolvable current repo it fails `RepoResolutionError`, so
 * a foreign install can't accidentally operate on phoenix.
 */
const resolveRepo = Effect.fn("Tracker.resolveRepo")(function* () {
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
		Effect.catchTag("@kampus/tracker/GhCommandError", () => Effect.succeed("")),
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

// REST-only arg builders — never GraphQL (broken on the kamp-us org).

const listCommentsArgs = (repo: string, target: TargetId): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues/${target}/comments?per_page=100`,
];

const postClaimArgs = (repo: string, target: TargetId, body: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues/${target}/comments`,
	"-f",
	`body=${body}`,
	"--jq",
	".id",
];

const deleteCommentArgs = (repo: string, id: number): ReadonlyArray<string> => [
	"api",
	"-X",
	"DELETE",
	`repos/${repo}/issues/comments/${id}`,
];

const permissionArgs = (repo: string, login: string): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/collaborators/${login}/permission`,
	"--jq",
	".permission",
];

/** A raw comment as the issues/comments endpoint returns it; only these fields are read. */
const RawComment = Schema.Struct({
	id: Schema.Number,
	created_at: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.NullOr(Schema.Struct({login: Schema.String})),
});
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(RawComment));

const toClaimComment = (raw: (typeof RawComment)["Type"]): ClaimComment => ({
	id: raw.id,
	author: raw.user?.login ?? "",
	createdAt: raw.created_at,
	body: raw.body ?? "",
});

const toOwner = (winner: ClaimWinner): ClaimOwner => ({
	session: winner.session,
	claimedAt: winner.createdAt,
});

const listClaimComments = Effect.fn("Tracker.listClaimComments")(function* (
	repo: string,
	target: TargetId,
) {
	const args = listCommentsArgs(repo, target);
	const raw = yield* decodeComments(yield* json(args));
	return raw.map(toClaimComment);
});

/**
 * The write+ collaborator subset of `logins` — the ADR 0055 trust root, applied *inside*
 * the live impl so it never leaks into the `Tracker` interface (local-markdown has no ACL).
 * A non-`admin|maintain|write` permission, or any `gh` fault on the probe (a
 * non-collaborator commonly 404s), drops the login — a forged claim never enters the set
 * the pure core resolves over.
 */
const authorizedAuthors = Effect.fn("Tracker.authorizedAuthors")(function* (
	repo: string,
	logins: ReadonlyArray<string>,
) {
	const results = yield* Effect.forEach(
		logins,
		(login) =>
			runGh(permissionArgs(repo, login)).pipe(
				Effect.map((out) => ({login, permission: out.trim()})),
				Effect.catchTag("@kampus/tracker/GhCommandError", () =>
					Effect.succeed({login, permission: "none"}),
				),
			),
		{concurrency: "unbounded"},
	);
	return results
		.filter(
			(r) => r.permission === "admin" || r.permission === "maintain" || r.permission === "write",
		)
		.map((r) => r.login);
});

const resolveAuthorizedWinner = Effect.fn("Tracker.resolveAuthorizedWinner")(function* (
	repo: string,
	comments: ReadonlyArray<ClaimComment>,
) {
	const authors = [...new Set(comments.map((c) => c.author).filter((a) => a.length > 0))];
	const authorized = yield* authorizedAuthors(repo, authors);
	return resolveWinner(comments, authorized);
});

/**
 * Claim `target` under `session` (ADR 0115). Rule-0 defer first: if an authorized claim
 * from a *different* session already owns it, back off `held-by-other` without posting
 * (a fresh arrival never evicts a pre-existing owner); if that owner is already us, return
 * `claimed` idempotently rather than double-posting. Otherwise POST our claim comment and
 * checkpoint-GET: we hold it only if the earliest authorized claim is ours, else retract
 * our own claim and back off `lost` (never delete another agent's claim).
 */
const claim = Effect.fn("Tracker.claim")(function* (
	repo: string,
	target: TargetId,
	session: string,
) {
	const mine = session.toLowerCase();
	const before = yield* resolveAuthorizedWinner(repo, yield* listClaimComments(repo, target));
	if (before !== null) {
		return before.session === mine
			? ({_tag: "claimed", session} satisfies ClaimResult)
			: ({_tag: "held-by-other", owner: toOwner(before)} satisfies ClaimResult);
	}
	const now = new Date().toISOString();
	const posted = yield* json(postClaimArgs(repo, target, `claim: ${session} · ${now}`));
	const claimId = typeof posted === "number" ? posted : null;
	const winner = yield* resolveAuthorizedWinner(repo, yield* listClaimComments(repo, target));
	if (winner !== null && winner.session === mine) {
		return {_tag: "claimed", session} satisfies ClaimResult;
	}
	if (claimId !== null) {
		yield* runGh(deleteCommentArgs(repo, claimId)).pipe(Effect.ignore);
	}
	return {_tag: "lost", owner: winner !== null ? toOwner(winner) : null} satisfies ClaimResult;
});

/** Read back the current claim ownership of `target` — the verify leg of `claim`. */
const readBack = Effect.fn("Tracker.readBack")(function* (repo: string, target: TargetId) {
	const winner = yield* resolveAuthorizedWinner(repo, yield* listClaimComments(repo, target));
	return winner !== null
		? ({_tag: "owned", owner: toOwner(winner)} satisfies ReadBackResult)
		: ({_tag: "unclaimed"} satisfies ReadBackResult);
});

type TrackerErrors = RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError;

/**
 * `Tracker` — the shared crew tracker capability. `claim` and `readBack` are live; the
 * three declared verbs fail `TrackerNotImplementedError` until a sibling child builds them
 * (their success types are `never` by design — a not-yet-built verb produces no value).
 * Built by `GithubTrackerLive`, whose `R` is `ChildProcessSpawner`.
 */
export class Tracker extends Context.Service<
	Tracker,
	{
		readonly claim: (
			target: TargetId,
			judgment: ClaimJudgment,
		) => Effect.Effect<ClaimResult, TrackerErrors>;
		readonly readBack: (target: TargetId) => Effect.Effect<ReadBackResult, TrackerErrors>;
		readonly applyTriage: (
			target: TargetId,
			judgment: TriageJudgment,
		) => Effect.Effect<never, TrackerNotImplementedError>;
		readonly postVerdict: (
			target: TargetId,
			judgment: VerdictJudgment,
		) => Effect.Effect<never, TrackerNotImplementedError>;
		readonly graduate: (
			target: TargetId,
			judgment: GraduateJudgment,
		) => Effect.Effect<never, TrackerNotImplementedError>;
	}
>()("@kampus/tracker/Tracker") {}

const notImplemented = (verb: string): Effect.Effect<never, TrackerNotImplementedError> =>
	new TrackerNotImplementedError({verb});

/**
 * The live `Tracker` layer over `gh api` REST. The `ChildProcessSpawner` dependency is
 * captured once at construction and provided into each method body, so the public methods
 * carry `R = never`. Repo resolution is deferred to first use (`Effect.cached`, ADR 0062
 * §1): the layer build is side-effect-free, and `RepoResolutionError` lives in each verb's
 * `E` channel, raised only when a verb actually reads or mutates.
 */
export const GithubTrackerLive: Layer.Layer<
	Tracker,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(Tracker)(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		const repo = yield* Effect.cached(withSpawner(resolveRepo()));
		return {
			claim: (target, judgment) =>
				repo.pipe(Effect.flatMap((r) => withSpawner(claim(r, target, judgment.session)))),
			readBack: (target) => repo.pipe(Effect.flatMap((r) => withSpawner(readBack(r, target)))),
			applyTriage: () => notImplemented("applyTriage"),
			postVerdict: () => notImplemented("postVerdict"),
			graduate: () => notImplemented("graduate"),
		};
	}),
);
