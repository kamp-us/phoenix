/**
 * `triage claim` — take a session-scoped claim on one issue, proven by read-back.
 *
 * Post this session's marker, re-read every marker on the issue, discard the ones older than the
 * TTL, and let the earliest survivor win. `won` and `lost` are both **proven answers** and both exit
 * 0, with the discriminator in the state word: a losing claim is something this verb *determined*,
 * so seating it on a non-zero code would make "another sweep holds it" indistinguishable from "the
 * verb is broken".
 *
 * Everything a marker set could fail to say is a refusal instead. An unreadable comment list, a
 * shape that is not a list of comments, a marker whose ordering key will not parse — none of them
 * resolve to "no competing claim", which is the fail-open shape this verb exists to design out (see
 * `claim.ts`). The resolution itself is pure and lives there; this module is the IO and the exit
 * codes.
 *
 * The `Attempt`/`Existence` results the IO returns are **values, not the `E` channel**: a 404 and a
 * 502 are outcomes this verb maps onto its own codes, not exceptions (effect-smol `LLMS.md`
 * §"Error handling" — the typed error channel is for faults a caller recovers from, and `io/exec.ts`
 * already folds the spawn fault in).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, deleteComment, getIssue, listComments, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	expiryOf,
	isStampableSession,
	markerBody,
	markersOf,
	myMarker,
	resolveClaim,
} from "./claim.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {scannedLine} from "./scope.ts";

export {DEFAULT_TTL_MINUTES} from "./claim.ts";

export interface ClaimOptions {
	readonly issue: number;
	readonly ttlMinutes: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

const VERB = "triage claim";

/**
 * The session id, or a refusal.
 *
 * The unset case is seated on `1` because the merged contract's errors table puts it there. That
 * sits against the group's own rule that a proven refusal never shares a code with a failure to
 * invoke — the tension is real and disclosed rather than renumbered here, and it is defensible: an
 * unstamped environment is a precondition of *invoking* the verb, not a verdict it reached.
 */
const sessionFrom = (
	env: Readonly<Record<string, string | undefined>>,
): {readonly session: string} | {readonly refusal: VerbOutcome} => {
	const raw = env.CLAUDE_CODE_SESSION_ID ?? "";
	if (raw.trim() === "") {
		return {
			refusal: refuse(
				FAILED,
				`${VERB}: CLAUDE_CODE_SESSION_ID is unset — refusing to post an unattributable claim.`,
			),
		};
	}
	const session = raw.trim();
	if (!isStampableSession(session)) {
		return {
			refusal: refuse(
				FAILED,
				`${VERB}: CLAUDE_CODE_SESSION_ID is not a single token — a marker stamped with it would not read back as this session.`,
			),
		};
	}
	return {session};
};

export const runClaim = (
	options: ClaimOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, ttlMinutes, json} = options;

		if (!Number.isInteger(issue) || issue <= 0) {
			return refuse(FAILED, `${VERB}: ${issue} is not an issue number.`);
		}
		if (!Number.isInteger(ttlMinutes) || ttlMinutes <= 0) {
			return refuse(FAILED, `${VERB}: --ttl-minutes ${ttlMinutes} is not a positive integer.`);
		}

		const stamped = sessionFrom(options.env);
		if ("refusal" in stamped) return stamped.refusal;
		const {session} = stamped;

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				`${VERB}: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.`,
			);
		}
		const repo = repoAttempt.value;

		const target = yield* getIssue(repo, issue);
		if (target._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${VERB}: issue #${issue} not found in ${repo}.`);
		}
		if (target._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue} or its comments in ${repo}: ${target.reason} — no claim was resolved; never "won".`,
			);
		}
		if (target.value.state === "closed") {
			return refuse(ZERO_SCOPE, `${VERB}: issue #${issue} is closed — nothing to triage.`);
		}

		const before = yield* listComments(repo, issue);
		if (before._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue} or its comments in ${repo}: ${before.reason} — no claim was resolved; never "won".`,
			);
		}

		const now = options.now().getTime();
		// Re-running inside one session is idempotent: a second marker is strictly later than the
		// first, so it can win nothing the first did not and only adds litter to clean up.
		const alreadyHeld = myMarker(
			resolveClaim({markers: markersOf(before.value), session, now, ttlMinutes}),
		);

		let postedId: number | null = null;
		if (alreadyHeld === null) {
			const posted = yield* createComment(repo, issue, markerBody(session));
			if (posted._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: marker POST failed: ${posted.reason} — UNKNOWN whether it landed; re-run before mutating #${issue}.`,
				);
			}
			postedId = posted.value.id;
		}

		const after = alreadyHeld === null ? yield* listComments(repo, issue) : before;
		if (after._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue} or its comments in ${repo}: ${after.reason} — no claim was resolved; never "won".`,
				postedId === null
					? []
					: [
							`${VERB}: this session's marker ${postedId} is live on #${issue} and was not read back — delete it by hand if this session stops here.`,
						],
			);
		}
		const scope = scannedLine(VERB, repo, after.value.length, "comment");
		const resolution = resolveClaim({
			markers: markersOf(after.value),
			session,
			now,
			ttlMinutes,
		});

		if (resolution._tag === "Unresolvable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue} or its comments in ${repo}: ${resolution.reason} — no claim was resolved; never "won".`,
				[scope],
			);
		}

		if (resolution._tag === "MineAbsent") {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: marker posted but absent on read-back — treating the claim as lost.`,
				[scope],
			);
		}

		if (resolution._tag === "Won") {
			return json
				? answer(
						JSON.stringify({
							outcome: "won",
							session,
							holder: null,
							markers: resolution.live,
							expired: resolution.expired,
						}),
						[scope],
					)
				: answer("won", [scope]);
		}

		// A losing claim deletes the marker it just posted, before it says so. Litter survives the
		// full TTL and its created_at is older than every marker posted after it, so a session that
		// already conceded would beat a rightful winner on a later run.
		const deleted = yield* deleteComment(repo, resolution.mine.id);
		if (deleted._tag === "Failure") {
			const expiry = expiryOf(resolution.mine.createdAt, ttlMinutes) ?? "an unknown time";
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: lost #${issue}, but this session's marker ${resolution.mine.id} could not be deleted: ${deleted.reason} — a stale claim is live on the issue until ${expiry}; delete it by hand.`,
				[scope],
			);
		}

		const notice = `${VERB}: #${issue} is held by session ${resolution.holder.session} since ${resolution.holder.createdAt} — backing off.`;
		return json
			? answer(
					JSON.stringify({
						outcome: "lost",
						session,
						holder: resolution.holder.session,
						markers: resolution.live,
						expired: resolution.expired,
					}),
					[scope, notice],
				)
			: answer(`lost\t${resolution.holder.session}`, [scope, notice]);
	});
