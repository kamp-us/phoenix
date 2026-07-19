/**
 * The `Tracker` service — the shared Effect capability over the crew's issue tracker
 * surface (claims, triage, verdicts, graduation) with **domain-shaped** signatures.
 *
 * Grown from the Wave-1 walking skeleton (epic #3258): a `Context.Service` `Tracker`
 * tag plus its sole implementation `GithubTrackerLive`. `claim` (the ADR-0115
 * agent-distinguishable claim), a generic `readBack`, `applyTriage` (the label-transition
 * envelope, #3263), and `postVerdict` (the ADR-0058 verdict/comment-post + read-back
 * envelope, #3265) are live; only `graduate` is still *declared* — its interface shape is
 * fixed so the tag locks before its remaining sibling Phase-3 child implements it.
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
// The ADR-0058 verdict-marker grammar + emission guard is the SINGLE SOURCE — reused, never
// re-derived, exactly as the claim decision reuses `epic-lock/claim-resolution.ts`. `postVerdict`
// composes and self-verifies its comment through this pure core so the tool OWNS the decision the
// adoption-lint (#3254) forbids the corpus from hand-copying.
import {
	emissionDefect,
	GATE_KEYWORD,
	GATES,
	namespaceRe,
	type VerdictGate,
} from "../verdict/verdict-match.ts";

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
 * A declared-but-not-yet-built verb was called. `claim` / `readBack` / `applyTriage` /
 * `postVerdict` are live; only `graduate` fails-closed with this typed error until its sibling
 * Phase-3 child implements it — never a silent no-op or a throw.
 */
export class TrackerNotImplementedError extends Schema.TaggedErrorClass<TrackerNotImplementedError>()(
	"@kampus/tracker/TrackerNotImplementedError",
	{
		verb: Schema.String,
	},
) {}

/**
 * A malformed verb judgment the caller must fix — e.g. `postVerdict` handed an unknown gate, or a
 * composed verdict body that trips `emissionDefect` (a polarity with no bindable `@ <sha>`, a
 * non-40-hex head, a machine-local path). A caller error, not an infra fault: it is raised before
 * any write reaches the tracker.
 */
export class TrackerInputError extends Schema.TaggedErrorClass<TrackerInputError>()(
	"@kampus/tracker/TrackerInputError",
	{
		message: Schema.String,
	},
) {}

/**
 * A verb's post-write self-verify failed: after `postVerdict` upserted the comment it re-fetched it
 * and the landed body is not a clean, in-namespace, leak-free marker. The read-back folded INTO the
 * write so a bypassed/hand-rolled body can't report a false success (ADR 0058 read-back, #3019).
 */
export class TrackerVerifyError extends Schema.TaggedErrorClass<TrackerVerifyError>()(
	"@kampus/tracker/TrackerVerifyError",
	{
		message: Schema.String,
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

/**
 * Triage classification (judgment-as-parameter, #3252): the domain type + priority a
 * triage decision assigns, and the lifecycle stage it moves the entity to (`status`,
 * default `triaged`). Domain vocabulary only — `type`/`priority`/`status` are the crew's
 * own terms; `GithubTrackerLive` maps them to `type:` / `status:` label strings at the
 * boundary, so no GitHub label string leaks into the signature (ADR 0190).
 */
export interface TriageJudgment {
	readonly type: string;
	readonly priority: string;
	readonly status?: string;
}

/**
 * The `applyTriage` verdict — the entity now carries the classification, with `status`
 * read back from the entity (so the caller sees the stage that actually landed, not just
 * the one requested). A domain owner, never a raw REST label payload.
 */
export type TriageResult = {
	readonly _tag: "triaged";
	readonly type: string;
	readonly priority: string;
	readonly status: string;
};

/**
 * A gate verdict (judgment-as-parameter, #3252): which `gate` it decides, whether it `passed`,
 * the `headRef` the verdict binds to (ADR 0058), and the verdict `body` prose. Domain vocabulary
 * only — `gate` is the crew's own gate name (`code`/`doc`/`skill`/`design`); the caller never
 * hand-composes the `review-<gate>:` marker or its `@ <sha>` binding (the divergent-copy class
 * #3254 names), so no GitHub marker string leaks into the signature. `GithubTrackerLive` composes
 * the marker from this judgment at the boundary.
 */
export interface VerdictJudgment {
	readonly gate: string;
	readonly passed: boolean;
	readonly headRef: string;
	readonly body: string;
}

/**
 * The `postVerdict` verdict: the landed verdict read back from the entity — whether it was a fresh
 * comment (`posted`) or an upsert of our own prior marker in the namespace (`patched`), and the
 * gate/passed/headRef it now carries. A domain result, never a raw REST comment id (ADR 0190).
 */
export type VerdictResult = {
	readonly _tag: "posted" | "patched";
	readonly gate: string;
	readonly passed: boolean;
	readonly headRef: string;
};

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

// A generic comment POST — the claim marker and the verdict marker are both a body POST that
// returns the new comment id; single-sourced so the two consumers can't drift.
const postCommentArgs = (repo: string, target: TargetId, body: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues/${target}/comments`,
	"-f",
	`body=${body}`,
	"--jq",
	".id",
];

const patchCommentArgs = (repo: string, id: number, body: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"PATCH",
	`repos/${repo}/issues/comments/${id}`,
	"-f",
	`body=${body}`,
	"--jq",
	".id",
];

// The read-back GET for `postVerdict`'s self-verify (#3019): re-fetch the single comment we just
// upserted and return its LANDED body, so the marker/leak-clean shape is re-checked as it landed.
const getCommentBodyArgs = (repo: string, id: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/comments/${id}`,
	"--jq",
	".body",
];

const whoAmIArgs: ReadonlyArray<string> = ["api", "user", "--jq", ".login"];

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

const addLabelsArgs = (
	repo: string,
	target: TargetId,
	labels: ReadonlyArray<string>,
): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues/${target}/labels`,
	...labels.flatMap((label) => ["-f", `labels[]=${label}`]),
];

// The bare label name is passed unencoded: gh encodes the path segment itself, so
// pre-encoding the `:` would double-encode it (%253A) into a spurious 404.
const removeLabelArgs = (repo: string, target: TargetId, label: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"DELETE",
	`repos/${repo}/issues/${target}/labels/${label}`,
];

const listLabelsArgs = (repo: string, target: TargetId): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues/${target}/labels?per_page=100`,
];

/** A raw comment as the issues/comments endpoint returns it; only these fields are read. */
const RawComment = Schema.Struct({
	id: Schema.Number,
	created_at: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.NullOr(Schema.Struct({login: Schema.String})),
});
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(RawComment));

/** A raw label as the issues/labels endpoint returns it; only the name is read. */
const RawLabel = Schema.Struct({name: Schema.String});
const decodeLabels = Schema.decodeUnknownEffect(Schema.Array(RawLabel));

const LABEL_STATUS_PREFIX = "status:";
const QUEUE_STATUS = "needs-triage";

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
	const posted = yield* json(postCommentArgs(repo, target, `claim: ${session} · ${now}`));
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

/**
 * Apply a triage classification to `target` (ADR 0190) — the label-transition envelope
 * the triage skill hand-rolled, now one verb with the judgment as a parameter. Adds the
 * `type:` / priority / `status:<stage>` labels, then removes the `status:needs-triage`
 * queue label so the entity leaves the queue. The removal is idempotent: a `gh` 404 (the
 * entity never carried the queue label — a pre-bootstrap issue) is not a failure of the
 * transition, since the triaged end-state is reached either way. Reads the labels back and
 * Schema-decodes them at the boundary, reporting the `status` stage that actually landed.
 */
const applyTriage = Effect.fn("Tracker.applyTriage")(function* (
	repo: string,
	target: TargetId,
	judgment: TriageJudgment,
) {
	const status = judgment.status ?? "triaged";
	const add = [`type:${judgment.type}`, judgment.priority, `${LABEL_STATUS_PREFIX}${status}`];
	yield* runGh(addLabelsArgs(repo, target, add));
	yield* runGh(removeLabelArgs(repo, target, `${LABEL_STATUS_PREFIX}${QUEUE_STATUS}`)).pipe(
		Effect.catchTag("@kampus/tracker/GhCommandError", () => Effect.succeed("")),
	);
	const labels = yield* decodeLabels(yield* json(listLabelsArgs(repo, target)));
	const landedStatus = labels
		.map((label) => label.name)
		.filter((name) => name.startsWith(LABEL_STATUS_PREFIX))
		.map((name) => name.slice(LABEL_STATUS_PREFIX.length))
		.find((stage) => stage !== QUEUE_STATUS);
	return {
		_tag: "triaged",
		type: judgment.type,
		priority: judgment.priority,
		status: landedStatus ?? status,
	} satisfies TriageResult;
});

/** Map a domain gate name to the ADR-0058 `VerdictGate`, or `null` if it is not a known gate. */
const asGate = (gate: string): VerdictGate | null => {
	const g = gate.trim().toLowerCase();
	return (GATES as ReadonlyArray<string>).includes(g) ? (g as VerdictGate) : null;
};

/**
 * Compose the verdict comment body from the domain judgment: the ADR-0058 SHA-bound marker on line
 * one (`review-<gate>: <PASS|FAIL> @ <headRef>`) followed by the verdict prose. The caller supplies
 * only the domain decision (gate/passed/headRef) + prose — never the marker string — so the marker
 * grammar lives in exactly one place (`verdict-match.ts`).
 */
const composeVerdictBody = (
	gate: VerdictGate,
	passed: boolean,
	headRef: string,
	prose: string,
): string => `${GATE_KEYWORD[gate]}: ${passed ? "PASS" : "FAIL"} @ ${headRef}\n\n${prose}`;

/**
 * The post-write self-verify (#3019): re-fetch the comment `postVerdict` just upserted and assert
 * its LANDED body passes the SAME `emissionDefect` gate the composed input passed — a marker on line
 * one, a bindable `@ <sha>`, and no machine-local path anywhere. Folds the read-back INTO the write
 * so a caller can't leave a `@path`/non-marker/leaking comment on a public PR while reporting
 * success. Fail-closed: a failed re-fetch, or any landed defect, raises `TrackerVerifyError`.
 */
const verifyLanded = Effect.fn("Tracker.verifyLanded")(function* (
	repo: string,
	id: number,
	gate: VerdictGate,
) {
	const landed = yield* runGh(getCommentBodyArgs(repo, id)).pipe(
		Effect.catchTag(
			"@kampus/tracker/GhCommandError",
			(cause) =>
				new TrackerVerifyError({
					message: `could not re-fetch the just-posted verdict comment #${id} to self-verify it (${cause.stderr.trim() || `exit ${cause.exitCode}`}) — refusing to report success on an unverifiable post (#3019)`,
				}),
		),
	);
	const defect = emissionDefect(landed, gate);
	if (defect !== null) {
		return yield* new TrackerVerifyError({
			message: `the landed verdict comment #${id} failed self-verify: ${defect} — a bypassed/hand-rolled body reached GitHub; the post is rejected rather than reported as success (#3019)`,
		});
	}
});

/**
 * Upsert `target`'s `gate` verdict and read it back (ADR 0058 rule 2, ADR 0190) — the
 * verdict/comment-post + read-back envelope the review/ship/heal skills hand-rolled, now one
 * domain-shaped verb. Compose the SHA-bound marker + prose from the judgment, refuse fail-closed on
 * any `emissionDefect` (wrong namespace, unbindable/non-40-hex `@ <sha>`, a machine-local path) as a
 * `TrackerInputError` before any write, then scan our OWN prior marker in the namespace (newest by
 * `(createdAt, id)`) and PATCH it if present else POST a fresh one — exactly one verdict comment per
 * (entity, gate), and the own-authored scope means two reviewers never stomp each other's records.
 * Finally `verifyLanded` re-fetches the upserted comment and re-runs the emission gate on its landed
 * body. The untrusted comment list is Schema-decoded at the boundary (`listClaimComments`).
 */
const postVerdict = Effect.fn("Tracker.postVerdict")(function* (
	repo: string,
	target: TargetId,
	judgment: VerdictJudgment,
) {
	const gate = asGate(judgment.gate);
	if (gate === null) {
		return yield* new TrackerInputError({
			message: `unknown gate '${judgment.gate}' — expected one of ${GATES.join(" | ")}`,
		});
	}
	const headRef = judgment.headRef.trim();
	const body = composeVerdictBody(
		gate,
		judgment.passed,
		headRef,
		judgment.body.replace(/\s+$/, ""),
	);
	const defect = emissionDefect(body, gate);
	if (defect !== null) {
		return yield* new TrackerInputError({message: `refusing to post: ${defect}`});
	}
	const me = (yield* runGh(whoAmIArgs)).trim();
	const re = namespaceRe(gate);
	const mine = (yield* listClaimComments(repo, target))
		.filter((c) => c.author === me && re.test(c.body))
		.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));
	const priorId = mine[mine.length - 1]?.id;
	const upsert = yield* Effect.gen(function* () {
		if (priorId !== undefined) {
			const decoded = yield* json(patchCommentArgs(repo, priorId, body));
			return {
				_tag: "patched" as const,
				id: typeof decoded === "number" ? decoded : priorId,
			};
		}
		const decoded = yield* json(postCommentArgs(repo, target, body));
		if (typeof decoded !== "number") {
			return yield* new GhParseError({
				args: postCommentArgs(repo, target, "<body>"),
				message: "comment POST did not return a numeric id",
			});
		}
		return {_tag: "posted" as const, id: decoded};
	});
	yield* verifyLanded(repo, upsert.id, gate);
	return {
		_tag: upsert._tag,
		gate: judgment.gate,
		passed: judgment.passed,
		headRef,
	} satisfies VerdictResult;
});

type TrackerErrors = RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError;

type PostVerdictErrors = TrackerErrors | TrackerInputError | TrackerVerifyError;

/**
 * `Tracker` — the shared crew tracker capability. `claim`, `readBack`, `applyTriage`, and
 * `postVerdict` are live; only the still-declared `graduate` fails `TrackerNotImplementedError`
 * until its sibling child builds it (its success type is `never` by design — a not-yet-built verb
 * produces no value). Built by `GithubTrackerLive`, whose `R` is `ChildProcessSpawner`.
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
		) => Effect.Effect<TriageResult, TrackerErrors>;
		readonly postVerdict: (
			target: TargetId,
			judgment: VerdictJudgment,
		) => Effect.Effect<VerdictResult, PostVerdictErrors>;
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
			applyTriage: (target, judgment) =>
				repo.pipe(Effect.flatMap((r) => withSpawner(applyTriage(r, target, judgment)))),
			postVerdict: (target, judgment) =>
				repo.pipe(Effect.flatMap((r) => withSpawner(postVerdict(r, target, judgment)))),
			graduate: () => notImplemented("graduate"),
		};
	}),
);
