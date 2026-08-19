/**
 * `lane claim` / `lane release` — the driver's end of the claim protocol, in one file because
 * splitting a claim from its release is how the two come to disagree about who holds a lane.
 *
 * Same race as `build claim`'s, one namespace over (`./claim.ts`): post the marker, **re-read**, and
 * the earliest authorized marker wins. Posting alone only detects a race; the checkpoint read is what
 * resolves it. A loser retracts its **own** marker and nothing else — never another lane's, which is
 * the one write this protocol must never make.
 *
 * **No admission test runs here.** The fence decides what may start *building* (ADR 0245), and the
 * builder this driver spawns runs it on its own account; a second copy in the driver would refuse a
 * lane at a different moment than the shell it drives, for reasons the driver is type-blind to.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	anySessionCaller,
	composeMarker,
	readMarkerToken,
	requireSession,
	resolveOwnership,
} from "../build/claim.ts";
import {composeToken} from "../build/lane.ts";
import {resolveTargetRepo} from "../build/target.ts";
import {createComment, deleteComment, getComment} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {claimTarget, LANE_CLAIM} from "./claim.ts";
import {APPEND_UNKNOWN, CLAIM_NOT_MINE, LANE_UNREADABLE, MARKER_READBACK} from "./codes.ts";
import type {LaneKey} from "./key.ts";

export interface ProtocolOptions {
	readonly key: LaneKey;
	readonly lane: string;
	readonly repo: string | null;
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
	options: ProtocolOptions,
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

export const runLaneClaim = (
	options: LaneClaimOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const ready = yield* preflight(CLAIM, "unclaimable", options);
		if (ready._tag !== "Ready") return ready.outcome;
		const {repo, session, number} = ready;

		const token = composeToken(session, options.uuid, LANE_CLAIM.prefix);
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

		// The checkpoint: posting DETECTS a race, this re-read RESOLVES it.
		const {ownership, unauthorized} = yield* resolveOwnership(
			repo,
			number,
			anySessionCaller(session),
			LANE_CLAIM,
		);
		const notes = unauthorizedNotes(CLAIM, unauthorized);
		if (ownership._tag === "Unknown") {
			return refuse(
				LANE_UNREADABLE,
				`${CLAIM}: cannot read the lane-claim markers on #${number}: ${ownership.reason} — ownership is UNKNOWN, never "unclaimed".`,
				notes,
			);
		}
		if (ownership._tag === "Mine") {
			return answer(JSON.stringify({answer: "won", lane: options.lane, number, token}), notes);
		}

		// Lost, or shadowed by an unauthorized-only thread: retract this run's OWN marker, nothing else.
		const retracted = yield* deleteComment(repo, posted.value.id);
		const trailer =
			retracted._tag === "Failure"
				? [
						`${CLAIM}: could not retract this run's own marker (comment ${posted.value.id}): ${retracted.reason}.`,
					]
				: [`${CLAIM}: retracted this run's own marker (comment ${posted.value.id}).`];
		return ownership._tag === "Foreign"
			? refuse(
					CLAIM_NOT_MINE,
					`${CLAIM}: lost to ${ownership.marker.token} (posted ${ownership.marker.createdAt}, authorized) — another driver holds this lane.`,
					[...notes, ...trailer],
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

		const {ownership, unauthorized} = yield* resolveOwnership(
			repo,
			number,
			anySessionCaller(session),
			LANE_CLAIM,
		);
		const notes = unauthorizedNotes(RELEASE, unauthorized);
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
				`${RELEASE}: this session holds no lane claim on #${number} — refusing to release another driver's.`,
				notes,
			);
		}
		const deleted = yield* deleteComment(repo, ownership.marker.commentId);
		return deleted._tag === "Failure"
			? refuse(
					APPEND_UNKNOWN,
					`${RELEASE}: the retraction failed: ${deleted.reason} — whether this driver still holds #${number} is UNKNOWN.`,
					notes,
				)
			: answer(JSON.stringify({answer: "released", lane: options.lane, number}), notes);
	});
