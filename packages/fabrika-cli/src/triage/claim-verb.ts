/**
 * `triage claim` — take one lane's claim on one issue, proven by read-back.
 *
 * Post this lane's marker, re-read every marker on the issue, discard the ones older than the
 * TTL, and let the earliest survivor win. `won` and `lost` are both **proven answers** and both exit
 * 0, with the discriminator in the state word: a losing claim is something this verb *determined*,
 * so seating it on a non-zero code would make "another sweep holds it" indistinguishable from "the
 * verb is broken".
 *
 * **A claim names a lane, and the lane is the token this verb hands back.** A run with no `--token`
 * mints one and races under its nonce; a run that passes the token it was handed re-enters the lane
 * it already owns. That is what makes re-entry idempotent *and* keeps two triagers of one session
 * apart — the session id alone told each sibling of a fan-out that it held its sibling's marker, and
 * both wrote the issue (#6132).
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
	type AskedLane,
	DEFAULT_TTL_MINUTES,
	expiryOf,
	markerBody,
	markersOf,
	mintCaller,
	myMarker,
	requireCallerToken,
	requireSession,
	resolveClaim,
} from "./claim.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {scannedLine} from "./scope.ts";

export interface ClaimOptions {
	readonly issue: number;
	readonly repo: string | null;
	readonly json: boolean;
	/** The token this lane was already handed, or `null` on a first claim — see {@link callerFrom}. */
	readonly token: string | null;
	/** The UUID a fresh lane's token is minted from; injected so a test can pin the nonce. */
	readonly uuid: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

const VERB = "triage claim";

/**
 * The lane that is asking — the one it was handed a token for, or a fresh one minted here.
 *
 * Both arms and the session read behind them live in `claim.ts`, so `triage scratch` asks the same
 * question in the same words rather than in a second copy of them.
 */
const callerFrom = (
	session: string,
	token: string | null,
	uuid: string,
): AskedLane | {readonly refusal: VerbOutcome} => {
	const asked =
		token === null ? mintCaller(VERB, session, uuid) : requireCallerToken(VERB, session, token);
	return "refusal" in asked ? asked : asked.value;
};

export const runClaim = (
	options: ClaimOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, json} = options;

		if (!Number.isInteger(issue) || issue <= 0) {
			return refuse(FAILED, `${VERB}: ${issue} is not an issue number.`);
		}

		const stamped = requireSession(VERB, options.env, "refusing to post an unattributable claim");
		if ("refusal" in stamped) return stamped.refusal;
		const session = stamped.value;

		const asking = callerFrom(session, options.token, options.uuid);
		if ("refusal" in asking) return asking.refusal;
		const {caller, token: laneToken} = asking;

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
		// Re-entering one lane is idempotent: a second marker under the same nonce is strictly later
		// than the first, so it can win nothing the first did not and only adds litter to clean up. It
		// is the LANE that re-enters, not the session — a sibling lane of the same session holds a
		// marker under another nonce, and posting its own is exactly what the race needs (#6132).
		const alreadyHeld = myMarker(
			resolveClaim({
				markers: markersOf(before.value),
				caller,
				now,
				ttlMinutes: DEFAULT_TTL_MINUTES,
			}),
		);

		let postedId: number | null = null;
		if (alreadyHeld === null) {
			const posted = yield* createComment(repo, issue, markerBody(caller));
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
							`${VERB}: this lane's marker ${postedId} is live on #${issue} and was not read back — delete it by hand if this lane stops here.`,
						],
			);
		}
		const scope = scannedLine(VERB, repo, after.value.length, "comment");
		const resolution = resolveClaim({
			markers: markersOf(after.value),
			caller,
			now,
			ttlMinutes: DEFAULT_TTL_MINUTES,
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
							token: laneToken,
							holder: null,
							holderLane: null,
							markers: resolution.live,
							expired: resolution.expired,
						}),
						[scope],
					)
				: answer(`won\t${laneToken}`, [scope]);
		}

		// A losing claim deletes the marker it just posted, before it says so. Litter survives the
		// full TTL and its created_at is older than every marker posted after it, so a session that
		// already conceded would beat a rightful winner on a later run.
		const deleted = yield* deleteComment(repo, resolution.mine.id);
		if (deleted._tag === "Failure") {
			const expiry = expiryOf(resolution.mine.createdAt, DEFAULT_TTL_MINUTES) ?? "an unknown time";
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: lost #${issue}, but this lane's marker ${resolution.mine.id} could not be deleted: ${deleted.reason} — a stale claim is live on the issue until ${expiry}; delete it by hand.`,
				[scope],
			);
		}

		// The lane is named beside the session because under a fan-out the winner IS this session — a
		// notice reading "held by session <mine>" and nothing else describes a lane losing to itself.
		const holderLane = resolution.holder.lane;
		const heldBy =
			holderLane === null
				? `session ${resolution.holder.session}`
				: `session ${resolution.holder.session} on lane ${holderLane}`;
		const notice = `${VERB}: #${issue} is held by ${heldBy} since ${resolution.holder.createdAt} — backing off.`;
		return json
			? answer(
					JSON.stringify({
						outcome: "lost",
						session,
						token: laneToken,
						holder: resolution.holder.session,
						holderLane,
						markers: resolution.live,
						expired: resolution.expired,
					}),
					[scope, notice],
				)
			: answer(`lost\t${resolution.holder.session}`, [scope, notice]);
	});
