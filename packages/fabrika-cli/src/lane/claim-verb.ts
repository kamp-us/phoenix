/**
 * `lane claim` / `lane release` — the driver's end of the claim protocol, in one file because
 * splitting a claim from its release is how the two come to disagree about who holds a lane.
 *
 * Same race as `build claim`'s, one namespace over (`./claim.ts`): post the marker, **re-read**, and
 * the earliest authorized marker wins. Posting alone only detects a race; the checkpoint read is what
 * resolves it. A loser retracts its **own** marker and nothing else — never another lane's, which is
 * the one write this protocol must never make.
 *
 * **Ownership turns on the whole token, never on the session id alone** (#6060). A session is not a
 * driver: one session routinely spawns several operators, and each mints its own token. Under the
 * session-only rule a sibling lane read the first lane's marker as its own, so `claim` answered `won`
 * carrying a token that owned nothing and `release` deleted the holder's marker — an unrecoverable
 * retraction that left the issue reading unclaimed. Every ownership question here is therefore asked
 * as a {@link Caller} carrying the lane's nonce, read off the `--token` this verb's own `claim`
 * handed back.
 *
 * **One driver leaves at most one marker on a thread**, the same fixed point `build claim` holds
 * (#5782, per lane since #6037). `claim` handed the token it already holds reads ownership before
 * writing and answers `won` with that same marker, posting nothing; `release` sweeps every marker
 * carrying THIS lane's token rather than only the winner. Without both, N claims left N markers and
 * each release peeled one off a stack, and since nothing here expires a marker (`triage claim`'s TTL
 * has no counterpart in this namespace) the leftovers made the lane refuse on `31` until a human
 * deleted the comment.
 *
 * **No admission test runs here.** The fence decides what may start *building* (ADR 0245), and the
 * builder this driver spawns runs it on its own account; a second copy in the driver would refuse a
 * lane at a different moment than the shell it drives, for reasons the driver is type-blind to.
 *
 * **`adopt` is the third verb, and it is what a killed seat's successor runs** (ADR 0324, in parity
 * with ADR 0295's build-namespace succession): the successor states on the board that a seat is gone
 * and inherits its claim, so `release` then answers `Mine` and retracts the claim and the adopt
 * together. No TTL, no lease, no steal.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	composeAdoptMarker,
	composeMarker,
	describeCaller,
	laneCaller,
	markersIn,
	readAdoptMarker,
	readMarkerToken,
	requireCallerToken,
	requireSession,
	resolveOwnership,
} from "../build/claim.ts";
import {composeToken, nonceOf, parseToken} from "../build/lane.ts";
import {resolveTargetRepo} from "../build/target.ts";
import {createComment, deleteComment, getComment, listComments} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {claimTarget, LANE_CLAIM} from "./claim.ts";
import {APPEND_UNKNOWN, CLAIM_NOT_MINE, LANE_UNREADABLE, MARKER_READBACK} from "./codes.ts";
import type {LaneKey} from "./key.ts";

export interface ProtocolOptions {
	readonly key: LaneKey;
	readonly lane: string;
	readonly repo: string | null;
	/**
	 * The token `lane claim` handed this driver — which lane is asking.
	 *
	 * Nullable because a `chore:<name>` key was never claimable and so was never handed one; against
	 * a board number a null is refused rather than widened back to the session.
	 */
	readonly token: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export interface LaneClaimOptions extends ProtocolOptions {
	/** A fresh UUID, supplied by the adapter so the token this run mints is deterministic under test. */
	readonly uuid: string;
	/** The marker's human-readable ISO-8601 timestamp. The tiebreak uses GitHub's `created_at`. */
	readonly at: string;
}

type Preflight =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Inert"; readonly outcome: VerbOutcome}
	| {
			readonly _tag: "Ready";
			readonly repo: string;
			readonly session: string;
			readonly number: number;
	  };

const preflight = (
	verb: string,
	kind: string,
	options: Omit<ProtocolOptions, "token">,
): Effect.Effect<Preflight, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const session = requireSession(verb, options.env);
		if (session._tag === "Refused") return {_tag: "Refused" as const, outcome: session.outcome};
		const target = claimTarget(options.key);
		if (target._tag === "Inert") {
			return {
				_tag: "Inert" as const,
				outcome: answer(JSON.stringify({answer: kind, lane: options.lane, why: target.why}), [
					`${verb}: ${target.why} — nothing was written, and no second driver can be detected here.`,
				]),
			};
		}
		const resolved = yield* resolveTargetRepo(verb, options.repo, options.env);
		if (resolved._tag === "Refused") return {_tag: "Refused" as const, outcome: resolved.outcome};
		return {
			_tag: "Ready" as const,
			repo: resolved.repo,
			session: session.id,
			number: target.number,
		};
	});

const CLAIM = "lane claim";

const unauthorizedNotes = (
	verb: string,
	markers: ReadonlyArray<{readonly commentId: number; readonly author: string}>,
): ReadonlyArray<string> =>
	markers.map(
		(marker) =>
			`${verb}: comment ${marker.commentId} carries a lane-claim marker from "${marker.author}", who holds no write permission — counted, never a winner.`,
	);

/** How a refusal names a same-session winner, which is a sibling driver rather than a stranger. */
const siblingNote = (verb: string, token: string): string =>
	`${verb}: ${token} carries this very session under another nonce — a sibling driver of this session, or a marker an earlier run of it left behind.`;

/**
 * The route out of a proven loss, named on the refusal itself.
 *
 * Without it `lane claim` dead-ends on `31` for a seat `lane stale` is at the same moment naming as
 * one to re-spawn — the two verbs contradicting each other over one lane, with only a hand-composed
 * `--token` release in between (#6374).
 */
const successionNote = (verb: string, holder: {readonly session: string}, lane: string): string =>
	`${verb}: if that seat is gone, take the lane back through succession rather than a hand-composed token — fabrika lane adopt ${lane} --session ${holder.session} --reason "<why>", then fabrika lane release ${lane} --token <the token adopt printed> (ADR 0324).`;

export const runLaneClaim = (
	options: LaneClaimOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const ready = yield* preflight(CLAIM, "unclaimable", options);
		if (ready._tag !== "Ready") return ready.outcome;
		const {repo, session, number} = ready;

		// Already THIS DRIVER's: answer with the marker that owns it and write nothing. A second marker
		// would leave `claim` printing one nonce while `release` deleted the earliest, so each release
		// peeled one off a stack and the leftovers locked the lane out (#6087). Only a caller that
		// named its own token can be answered this way — a same-session marker under another nonce
		// belongs to a sibling driver, and races below like any other (#6060).
		if (options.token !== null) {
			const holding = requireCallerToken(CLAIM, session, options.token, LANE_CLAIM);
			if (holding._tag === "Refused") return holding.outcome;
			const prior = yield* resolveOwnership(repo, number, holding.caller, LANE_CLAIM);
			if (prior.ownership._tag === "Mine" && prior.ownership.adopt !== null) {
				// Answering `won` here would hand back the DEAD seat's token — the winner on an adopted
				// claim — which every later verb of this run refuses as another lane's. This is the only
				// arm that can see it: the post-write read below runs under a nonce no adopt can name, so a
				// tokenless claim resolves `Foreign` and loses. Nothing was written, so nothing to retract.
				return refuse(
					CLAIM_NOT_MINE,
					`${CLAIM}: #${number} still carries the adopted claim ${prior.ownership.marker.token} — run "fabrika lane release ${options.lane} --token ${prior.ownership.adopt.token}" to retract it and the adopt together, then claim.`,
				);
			}
			if (prior.ownership._tag === "Mine") {
				return answer(
					JSON.stringify({
						answer: "won",
						lane: options.lane,
						number,
						token: prior.ownership.marker.token,
					}),
					[
						...unauthorizedNotes(CLAIM, prior.unauthorized),
						`${CLAIM}: #${number} is already held by this driver (comment ${prior.ownership.marker.commentId}) — answered with the marker that owns it; nothing was written.`,
					],
				);
			}
		}

		const token = composeToken(session, options.uuid, LANE_CLAIM.prefix);
		const nonce = nonceOf(token, LANE_CLAIM.prefix);
		if (nonce === null) {
			return refuse(
				FAILED,
				`${CLAIM}: the token this run mints, ${token}, yields no lane nonce — nothing was written.`,
			);
		}
		const posted = yield* createComment(
			repo,
			number,
			composeMarker(token, options.at, null, LANE_CLAIM),
		);
		if (posted._tag === "Failure") {
			return refuse(
				APPEND_UNKNOWN,
				`${CLAIM}: the marker write failed: ${posted.reason} — whether this driver holds #${number} is UNKNOWN; re-run before emitting a ledger.`,
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		if (
			back._tag === "Failure" ||
			readMarkerToken(normalizeForReadback(back.value), LANE_CLAIM) !== token
		) {
			return refuse(
				MARKER_READBACK,
				`${CLAIM}: the marker landed but the read-back does not match — the claim needs a human eye.`,
				[`${CLAIM}: comment ${posted.value.id} on #${number} is the one to inspect.`],
			);
		}

		// The checkpoint: posting DETECTS a race, this re-read RESOLVES it. It resolves against the
		// token this run just minted, so a sibling driver of the same session is a co-racer like any
		// other rather than this run reading its neighbour's marker as its own (#6060).
		const {ownership, unauthorized} = yield* resolveOwnership(
			repo,
			number,
			laneCaller(session, nonce, token),
			LANE_CLAIM,
		);
		const notes = unauthorizedNotes(CLAIM, unauthorized);
		if (ownership._tag === "Mine") {
			return answer(
				JSON.stringify({answer: "won", lane: options.lane, number, token: ownership.marker.token}),
				notes,
			);
		}

		// Lost, unreadable, or shadowed by an unauthorized-only thread: retract this run's OWN marker,
		// nothing else. The UNKNOWN arm retracts too — its comment id is in hand and is provably this
		// run's own write, and leaving it behind strands a marker no later run can resolve (#6000).
		const retracted = yield* deleteComment(repo, posted.value.id);
		const trailer =
			retracted._tag === "Failure"
				? [
						`${CLAIM}: could not retract this run's own marker (comment ${posted.value.id}): ${retracted.reason}.`,
					]
				: [`${CLAIM}: retracted this run's own marker (comment ${posted.value.id}).`];
		if (ownership._tag === "Unknown") {
			return refuse(
				LANE_UNREADABLE,
				`${CLAIM}: cannot read the lane-claim markers on #${number}: ${ownership.reason} — ownership is UNKNOWN, never "unclaimed".`,
				[...notes, ...trailer],
			);
		}
		return ownership._tag === "Foreign"
			? refuse(
					CLAIM_NOT_MINE,
					`${CLAIM}: lost to ${ownership.marker.token} (posted ${ownership.marker.createdAt}, authorized) — another driver holds this lane.`,
					[
						...notes,
						...(ownership.sameSession ? [siblingNote(CLAIM, ownership.marker.token)] : []),
						successionNote(CLAIM, ownership.marker, options.lane),
						...trailer,
					],
				)
			: refuse(
					CLAIM_NOT_MINE,
					`${CLAIM}: this run's own marker is not authorized — its author holds no write permission, so it can never win (ADR 0055).`,
					[...notes, ...trailer],
				);
	});

const RELEASE = "lane release";

export const runLaneRelease = (
	options: ProtocolOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const ready = yield* preflight(RELEASE, "inert", options);
		if (ready._tag !== "Ready") return ready.outcome;
		const {repo, session, number} = ready;

		if (options.token === null) {
			return refuse(
				FAILED,
				`${RELEASE}: --token is unset — which driver is releasing #${number} is not stated, and a release that guesses retracts somebody else's marker; pass the token "fabrika lane claim ${options.lane}" printed.`,
			);
		}
		const asking = requireCallerToken(RELEASE, session, options.token, LANE_CLAIM);
		if (asking._tag === "Refused") return asking.outcome;
		const lane = asking.caller;

		const {ownership, unauthorized, unauthorizedAdopts} = yield* resolveOwnership(
			repo,
			number,
			lane,
			LANE_CLAIM,
		);
		const notes = [
			...unauthorizedNotes(RELEASE, unauthorized),
			...unauthorizedAdopts.map(
				(marker) =>
					`${RELEASE}: comment ${marker.commentId} carries a lane-adopt marker from "${marker.author}", who holds no write permission — counted, never a succession.`,
			),
		];
		if (ownership._tag === "Unknown") {
			return refuse(
				LANE_UNREADABLE,
				`${RELEASE}: cannot read the lane-claim markers on #${number}: ${ownership.reason} — ownership is UNKNOWN, never "unclaimed".`,
				notes,
			);
		}
		if (ownership._tag !== "Mine") {
			return refuse(
				CLAIM_NOT_MINE,
				ownership._tag === "Foreign"
					? `${RELEASE}: #${number} is held by ${ownership.marker.token}, not by ${describeCaller(lane)} — refusing to retract another driver's marker.`
					: `${RELEASE}: no lane claim exists on #${number} — nothing to retract.`,
				ownership._tag === "Foreign"
					? [
							...notes,
							...(ownership.sameSession ? [siblingNote(RELEASE, ownership.marker.token)] : []),
							successionNote(RELEASE, ownership.marker, options.lane),
						]
					: notes,
			);
		}
		// Every marker carrying THIS DRIVER's token, not only the winning one: a thread carrying
		// duplicates — a write that landed after it reported UNKNOWN, then re-posted — would otherwise
		// leave the leftovers behind for the next claim to lose to (#6087). The filter is the lane's
		// whole token, never its session: a sibling driver's marker is another driver's claim, and
		// sweeping it is the one write this protocol must never make (#6060).
		const listed = yield* listComments(repo, number);
		if (listed._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${RELEASE}: cannot re-read the lane-claim markers on #${number}: ${listed.reason} — nothing was retracted; run "fabrika lane release ${options.lane} --token ${options.token.trim()}" again.`,
				notes,
			);
		}
		const ids = new Set([
			ownership.marker.commentId,
			...markersIn(listed.value, LANE_CLAIM)
				.filter(
					(held) =>
						parseToken(held.token, LANE_CLAIM.prefix)?.session === lane.session &&
						nonceOf(held.token, LANE_CLAIM.prefix) === lane.nonce,
				)
				.map((held) => held.commentId),
		]);
		for (const id of ids) {
			const deleted = yield* deleteComment(repo, id);
			if (deleted._tag === "Failure") {
				return refuse(
					APPEND_UNKNOWN,
					`${RELEASE}: the retraction failed: ${deleted.reason} — whether this driver still holds #${number} is UNKNOWN.`,
					notes,
				);
			}
		}
		const adopt = ownership.adopt;
		if (adopt === null) {
			return answer(JSON.stringify({answer: "released", lane: options.lane, number}), notes);
		}
		// The adopt outlives nothing: it exists to authorize this release, so it goes with the claim.
		const cleared = yield* deleteComment(repo, adopt.commentId);
		return cleared._tag === "Failure"
			? refuse(
					APPEND_UNKNOWN,
					`${RELEASE}: the claim was retracted and its adopt marker (comment ${adopt.commentId}) was not: ${cleared.reason} — delete it by hand, or a later claim on #${number} reads a succession that no longer applies.`,
					notes,
				)
			: answer(
					JSON.stringify({
						answer: "released",
						lane: options.lane,
						number,
						adopted: adopt.adopted,
					}),
					notes,
				);
	});

const ADOPT = "lane adopt";

/**
 * `adopt` takes no `--token`: it MINTS the driver identity the succession creates and prints it. A
 * successor holds no token on a lane whose claim it is inheriting — demanding one would be demanding
 * the thing being conferred.
 */
export interface LaneAdoptOptions extends Omit<ProtocolOptions, "token"> {
	/** The session whose stranded seat this run adopts. */
	readonly session: string;
	/** Why the succession is taken — required, and recorded on the marker. */
	readonly reason: string;
	/** A fresh UUID, supplied by the adapter so the successor token is deterministic under test. */
	readonly uuid: string;
	readonly at: string;
}

/**
 * `lane adopt` — the successor operator seat names a stranded seat on the board, so its lane claim
 * becomes releasable (ADR 0324, the lane-namespace half of ADR 0295).
 *
 * **It admits this run's own session, and that is the difference from `build adopt`.** What dies in
 * this namespace is a *seat*, not a session: a killed operator seat's successor boots under the same
 * `CLAUDE_CODE_SESSION_ID` and only its nonce differs, so the marker it must inherit is
 * same-session-other-nonce — the shape `build adopt` refuses as already covered by plain release.
 * Here plain release does not cover it: `resolveOwnership` turns on the whole token, so the stranded
 * marker reads `Foreign` and the only way through was reading its token out of the comment thread by
 * hand (#6374). That hand-composed `--token` is what this verb exists to remove.
 *
 * The price is the one ADR 0295 already priced and disclosed: an adopt proves a seat gone no more
 * than it proves a session gone, so a driver may adopt a live sibling's claim. The guard is the
 * ACL plus the marker sitting on the issue with its reason, not a liveness proof.
 *
 * It writes one comment and nothing else. It takes no claim and evicts nobody: the release that
 * follows runs the ordinary ownership read, so an adopt posted below `write` decides nothing.
 */
export const runLaneAdopt = (
	options: LaneAdoptOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const adopted = options.session.trim();
		const reason = options.reason.trim();
		if (adopted === "") {
			return refuse(
				FAILED,
				`${ADOPT}: --session is empty — an adoption that names no session adopts nothing.`,
			);
		}
		if (reason === "") {
			return refuse(
				FAILED,
				`${ADOPT}: --reason is empty — a succession is recorded or it is not one.`,
			);
		}
		// The marker is one line with `·` as its field separator, so a value carrying either composes a
		// comment the reader cannot read back: the post lands, the read-back refuses, and a stray comment
		// is left behind. Refuse before the write instead.
		if (/[\s·]/.test(adopted)) {
			return refuse(
				FAILED,
				`${ADOPT}: --session "${adopted}" carries whitespace or "·" — a session id is one unbroken word, and this one would compose a marker no reader can read back; nothing was written.`,
			);
		}
		if (/[\r\n]/.test(reason)) {
			return refuse(
				FAILED,
				`${ADOPT}: --reason spans more than one line — the marker records one line, so the rest would be dropped silently; restate it as one line. Nothing was written.`,
			);
		}

		const ready = yield* preflight(ADOPT, "inert", options);
		if (ready._tag !== "Ready") return ready.outcome;
		const {repo, session, number} = ready;

		const token = composeToken(session, options.uuid, LANE_CLAIM.prefix);
		const body = composeAdoptMarker(adopted, token, options.at, reason, LANE_CLAIM);
		const posted = yield* createComment(repo, number, body);
		if (posted._tag === "Failure") {
			return refuse(
				APPEND_UNKNOWN,
				`${ADOPT}: the adopt marker write failed: ${posted.reason} — whether the succession is recorded is UNKNOWN; re-read #${number}'s comments before releasing.`,
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		const read =
			back._tag === "Failure"
				? null
				: readAdoptMarker(normalizeForReadback(back.value), LANE_CLAIM);
		if (read === null || read.adopted !== adopted || read.token !== token) {
			return refuse(
				MARKER_READBACK,
				`${ADOPT}: the adopt marker landed but the read-back does not match — the succession needs a human eye.`,
				[`${ADOPT}: comment ${posted.value.id} on #${number} is the one to inspect.`],
			);
		}
		return answer(
			JSON.stringify({answer: "adopted", lane: options.lane, number, session: adopted, token}),
			[
				`${ADOPT}: #${number}'s lane claim from "${adopted}" is now releasable by the driver this marker names — run "fabrika lane release ${options.lane} --token ${token}".`,
			],
		);
	});
