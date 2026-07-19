/**
 * The GitHub boundary for `epic-lock`: the live `Github` capability that acquires
 * and releases the ADR-0059 `status:planning` epic-lock over `gh api` REST, driving
 * the IO-free `claim-resolution.ts` core at the checkpoint.
 *
 * This is the **template child**'s `github.ts` service pattern the epic #994 Phase-2
 * families copy: a `Context.Service` (`.patterns/effect-context-service.md`) on
 * `ChildProcessSpawner` (`effect/unstable/process`), REST only (GraphQL is broken on
 * the kamp-us org), with every infra failure a typed error in the `E` channel, never
 * a throw (`.patterns/effect-errors.md`): a non-zero `gh` exit is `GhCommandError`,
 * malformed `gh` output is `GhParseError`, an unresolvable target repo is
 * `RepoResolutionError`. Schema decodes untrusted REST JSON at the boundary
 * (`.patterns/effect-schema-validation.md`) into the domain `ClaimComment` the core
 * resolves over.
 *
 * The lock is **two layers** (ADR 0115 / gh-issue-intake-formats.md §7): the coarse
 * `status:planning` label (the "is this epic being planned at all?" gate) plus the
 * agent-distinguishable claim comment that resolves the post-`/labels` TOCTOU under
 * the shared login. `acquire`/`release` return a domain verdict (not a raw void), so
 * every fail-closed back-off — a held label, a 422 missing label, a failed claim
 * post, a lost co-acquire — is an observable outcome the command prints, never an
 * exception. See ADR 0059 (the epic-plan lock) and ADR 0115 (the claim marker).
 */
import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcessSpawner} from "effect/unstable/process";
// The `gh api` REST IO seam (runGh / resolveRepo / authorizedAuthors / RawComment) is the SINGLE
// SOURCE shared with the `Tracker` service and `verdict` — no longer re-copied here (#3262 AC 5).
// The error types are re-exported below so callers/tests keep importing them from this module.
import {
	authorizedAuthors,
	decodeComments,
	deleteCommentArgs,
	type GhCommandError,
	type GhParseError,
	json,
	listCommentsArgs,
	postCommentArgs,
	type RawComment,
	type RepoResolutionError,
	resolveRepo,
	runGh,
} from "../tracker/gh-io.ts";
import {type ClaimComment, ownClaimCommentIds, resolveWinner} from "./claim-resolution.ts";

// Re-export the shared IO seam's typed failures so callers/tests keep importing them from this
// module — the single-source classes now live in `../tracker/gh-io.ts` (#3262 AC 5).
export {GhCommandError, GhParseError, RepoResolutionError} from "../tracker/gh-io.ts";

/** The canonical epic-plan lock label (ADR 0059). */
export const LOCK_LABEL = "status:planning";

/** The `acquire` verdict — exactly one holder, or one of four fail-closed back-offs. */
export type AcquireResult =
	| {readonly _tag: "acquired"}
	| {readonly _tag: "held-by-other"}
	| {readonly _tag: "label-missing"; readonly stderr: string}
	| {readonly _tag: "claim-post-failed"; readonly stderr: string}
	| {readonly _tag: "lost"; readonly winner: string};

/** The `release` verdict — how many of our claim comments were retracted, and whether the label was present. */
export type ReleaseResult = {
	readonly _tag: "released";
	readonly retracted: number;
	readonly labelRemoved: boolean;
};

// The epic-lock label envelope (the ADR-0059 `status:planning` read/add/remove) is the arg-builder
// set unique to this lock; the generic comment IO (list/post/delete) is the shared
// `../tracker/gh-io.ts` seam, so only these three label builders live here — never GraphQL.

const issueArgs = (repo: string, epic: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${epic}`,
	"--jq",
	"[.labels[].name]",
];

const addLabelArgs = (repo: string, epic: number): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues/${epic}/labels`,
	"-f",
	`labels[]=${LOCK_LABEL}`,
];

const removeLabelArgs = (repo: string, epic: number): ReadonlyArray<string> => [
	"api",
	"-X",
	"DELETE",
	`repos/${repo}/issues/${epic}/labels/${LOCK_LABEL}`,
];

/** The issue-label array `[.labels[].name]` returns. */
const decodeLabels = Schema.decodeUnknownEffect(Schema.Array(Schema.String));

const toClaimComment = (raw: (typeof RawComment)["Type"]): ClaimComment => ({
	id: raw.id,
	author: raw.user?.login ?? "",
	createdAt: raw.created_at,
	body: raw.body ?? "",
});

/** A clean 404 — the only `gh` failure that means "already gone / not found". */
const is404 = (stderr: string): boolean => /404|not found/i.test(stderr);

const labelHeld = Effect.fn("Github.labelHeld")(function* (repo: string, epic: number) {
	const args = issueArgs(repo, epic);
	const labels = yield* decodeLabels(yield* json(args));
	return labels.includes(LOCK_LABEL);
});

const listClaimComments = Effect.fn("Github.listClaimComments")(function* (
	repo: string,
	epic: number,
) {
	const args = listCommentsArgs(repo, epic);
	const raw = yield* decodeComments(yield* json(args));
	return raw.map(toClaimComment);
});

const resolveAuthorizedWinner = Effect.fn("Github.resolveAuthorizedWinner")(function* (
	repo: string,
	comments: ReadonlyArray<ClaimComment>,
) {
	const authors = [...new Set(comments.map((c) => c.author).filter((a) => a.length > 0))];
	const authorized = yield* authorizedAuthors(repo, authors);
	return resolveWinner(comments, authorized);
});

/**
 * Acquire the two-layer lock, fail-closed at every step: defer if the label is
 * already held (Rule 0 — never evict a pre-existing holder); POST the label and
 * back off `label-missing` if it doesn't land (422 or IO); POST our claim comment
 * and back off `claim-post-failed` if it doesn't land (leaving the label for a
 * legitimate co-racer to win on — a human clears a leaked label, a double-plan is
 * unrecoverable); then checkpoint-GET and resolve the earliest authorized claim. We
 * hold the lock only if that winner is ours; otherwise retract our own claim comment
 * and back off `lost` (never delete the shared label — the winner holds it).
 */
const acquire = Effect.fn("Github.acquire")(function* (
	repo: string,
	epic: number,
	sessionId: string,
) {
	if (yield* labelHeld(repo, epic)) {
		return {_tag: "held-by-other"} satisfies AcquireResult;
	}
	// "ok" is the label-landed sentinel; a GhCommandError lowers to the label-missing back-off.
	const labelResult = yield* runGh(addLabelArgs(repo, epic)).pipe(
		Effect.as<AcquireResult | "ok">("ok"),
		Effect.catchTag("@kampus/gh-io/GhCommandError", (error) =>
			Effect.succeed<AcquireResult | "ok">({_tag: "label-missing", stderr: error.stderr}),
		),
	);
	if (labelResult !== "ok") return labelResult;

	const now = new Date().toISOString();
	const claimResult = yield* json(postCommentArgs(repo, epic, `claim: ${sessionId} · ${now}`)).pipe(
		Effect.map((v): number | AcquireResult =>
			typeof v === "number"
				? v
				: {_tag: "claim-post-failed", stderr: "claim POST did not return a comment id"},
		),
		Effect.catchTag("@kampus/gh-io/GhCommandError", (error) =>
			Effect.succeed<number | AcquireResult>({_tag: "claim-post-failed", stderr: error.stderr}),
		),
	);
	if (typeof claimResult !== "number") return claimResult;
	const claimId = claimResult;

	const comments = yield* listClaimComments(repo, epic);
	const winner = yield* resolveAuthorizedWinner(repo, comments);
	if (winner !== null && winner.session === sessionId.toLowerCase()) {
		return {_tag: "acquired"} satisfies AcquireResult;
	}
	// Lost (or no authorized winner resolved): retract only OUR claim; never the shared label.
	yield* runGh(deleteCommentArgs(repo, claimId)).pipe(Effect.ignore);
	return {_tag: "lost", winner: winner?.session ?? "(none)"} satisfies AcquireResult;
});

/**
 * Release a lock we won: retract *our own* claim comment(s) (re-found by session id,
 * since the acquire's comment id lived in a prior process), then DELETE the coarse
 * label. The label DELETE is 404-benign (already released / never landed) but LOUD on
 * any other failure — a silently-swallowed DELETE leaks the lock and wedges the epic,
 * the exact catastrophe ADR 0059 prevents — so a non-404 fault propagates as
 * `GhCommandError`. Comment retraction is likewise loud on a non-404 fault.
 */
const release = Effect.fn("Github.release")(function* (
	repo: string,
	epic: number,
	sessionId: string,
) {
	const comments = yield* listClaimComments(repo, epic);
	const mine = ownClaimCommentIds(comments, sessionId);
	yield* Effect.forEach(
		mine,
		(id) =>
			runGh(deleteCommentArgs(repo, id)).pipe(
				Effect.catchTag("@kampus/gh-io/GhCommandError", (error) =>
					is404(error.stderr) ? Effect.void : Effect.fail(error),
				),
			),
		{concurrency: "unbounded", discard: true},
	);
	const labelRemoved = yield* runGh(removeLabelArgs(repo, epic)).pipe(
		Effect.as(true),
		Effect.catchTag("@kampus/gh-io/GhCommandError", (error) =>
			is404(error.stderr) ? Effect.succeed(false) : Effect.fail(error),
		),
	);
	return {_tag: "released", retracted: mine.length, labelRemoved} satisfies ReleaseResult;
});

/**
 * `Github` — the IO shell over `gh api` REST. `acquire` and `release` are the two
 * verbs the epic-lock exposes; both take the epic number and the acquiring session
 * id. Built by `GithubLive`, whose `R` is `ChildProcessSpawner`: provide the platform
 * spawner (`NodeServices.layer` in production); a test provides a mock spawner via
 * `ChildProcessSpawner.make`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly acquire: (
			epic: number,
			sessionId: string,
		) => Effect.Effect<
			AcquireResult,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
		readonly release: (
			epic: number,
			sessionId: string,
		) => Effect.Effect<
			ReleaseResult,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/epic-lock/Github") {}

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once at
 * construction and provided *into* each method body, so the public methods carry
 * `R = never`. Repo resolution is deferred to first use (`Effect.cached`, ADR 0062
 * §1, #422): the layer build is side-effect-free, and `RepoResolutionError` lives in
 * each method's `E` channel, raised only when a verb actually reads or mutates.
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
				acquire: (epic: number, sessionId: string) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(acquire(r, epic, sessionId)))),
				release: (epic: number, sessionId: string) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(release(r, epic, sessionId)))),
			};
		}),
	);
