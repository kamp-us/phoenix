/**
 * `build claim` / `build confirm` / `build release` — one protocol, three verbs, in one file because
 * splitting them across three is how two of them come to disagree about who holds a lane.
 *
 * The race is detect-then-tiebreak, not a lock: post the marker, **re-read**, and the earliest
 * authorized marker wins. Posting alone only detects a race; the checkpoint read is what resolves it,
 * and a claim that skipped it would let two staggered co-racers both proceed.
 *
 * **A lost race is a proven outcome on its own code, never exit 0.** v1's direct-claim script exited 0
 * on both won and lost and left the routing to prose (`step3-direct-claim.sh:31,40`), and v1's
 * `claim is-mine` fused "proven lost" with "no session id" on exit 1 (`claim/command.ts:57`). Here
 * `15` is proven-foreign only, a missing session id is `1`, and an unreadable marker set is `11`.
 *
 * A loser retracts its **own** marker and nothing else — never another lane's, which is the one write
 * this protocol must never make.
 *
 * **One session leaves at most one marker on a thread.** `claim` reads ownership before it writes and
 * short-circuits when the lane is already this session's, `release` sweeps every marker of this
 * session rather than the winning one, and both `claim` branches answer with `ownership.marker.token`
 * — the token `requireClaim` will read. Without that, N claims left N markers, `claim` printed its own
 * fresh nonce while every other verb read the earliest, and each `release` peeled one off a stack
 * (#5782) — which is how `build branch --resume` cut a branch off a nonce the caller was never shown.
 *
 * **`claim` runs the admission test before it writes anything; `confirm` and `release` never run it.**
 * The fence decides what may *start* (ADR 0245), so a focus row edited mid-lane must not strand a
 * running lane or block its release. Claiming is the one moment every path goes through — a number
 * handed straight to `claim` passes through no pool — which is why the refusal has teeth here and is
 * advice at the pool. In repair the number is a **PR**, which carries no home and no audience of its
 * own, so the test runs over the issue that PR serves (#5562) — and when that issue is
 * `type:decision` the audience axis does not bind, because triage bars a decision from
 * `ready-for:agent` and the fence could otherwise never be satisfied (#5914).
 */
import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	createComment,
	deleteComment,
	getComment,
	type IssueRecord,
	listComments,
} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	BUILD_CLAIM,
	type ClaimOverride,
	composeMarker,
	markersIn,
	readMarkerToken,
	requireSession,
	resolveOwnership,
} from "./claim.ts";
import {
	CLAIM_NOT_MINE,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {composeToken, parseToken} from "./lane.ts";
import {
	admissionOf,
	admissionRefusal,
	audienceAxisOf,
	CLAIM_PURPOSES,
	DEFAULT_CLAIM_PURPOSE,
	focusScopeLine,
	NOT_REPAIR,
	parseClaimPurpose,
	purposeScopeLine,
	readDeclaredFocus,
} from "./scope-admission.ts";
import {openIssue, resolveAdmissionSubject, resolveTargetRepo} from "./target.ts";

export interface ClaimOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** A fresh UUID, supplied by the adapter so the token this run mints is deterministic under test. */
	readonly uuid: string;
	/** The marker's human-readable ISO-8601 timestamp. The tiebreak uses GitHub's `created_at`. */
	readonly at: string;
	/** Why this lane claims — `plan` | `gate` | `build`, as typed. Off-enum refuses (#5175). */
	readonly purpose: string;
	/** Why this run claims an issue the admission test refused, or `null` for the ordinary path. */
	readonly override: string | null;
	/** The lane an override is taken for — required with an override, refused without one. */
	readonly overrideLane: string | null;
}

export type ProtocolOptions = Omit<
	ClaimOptions,
	"uuid" | "at" | "purpose" | "override" | "overrideLane"
>;

const CLAIM = "build claim";

type OverrideRead =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Read"; readonly override: ClaimOverride | null};

/**
 * The override's two required fields, read before anything is written.
 *
 * An override is the fence's escape hatch, and an escape hatch that records nothing is how the fence
 * rots fail-open by convention — so a reason without a lane, a lane without a reason, and a blank
 * either is a usage refusal rather than a claim with a thin trace (#5175).
 */
const readOverride = (reason: string | null, lane: string | null): OverrideRead => {
	const refusal = (message: string): OverrideRead => ({
		_tag: "Refused",
		outcome: refuse(FAILED, `${CLAIM}: ${message}`),
	});
	if (reason === null && lane === null) return {_tag: "Read", override: null};
	if (reason === null) {
		return refusal(
			"--override-lane was given without --override — a lane names no override on its own.",
		);
	}
	if (reason.trim() === "") {
		return refusal(
			"--override was given with an empty reason — an override is recorded or it is not one.",
		);
	}
	if (lane === null || lane.trim() === "") {
		return refusal(
			'--override was given without a lane — pass --override-lane "<lane>" so the escape hatch names who took it.',
		);
	}
	return {_tag: "Read", override: {lane: lane.trim(), reason: reason.trim()}};
};

const preflight = (
	verb: string,
	options: ProtocolOptions,
): Effect.Effect<
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {
			readonly _tag: "Ready";
			readonly repo: string;
			readonly session: string;
			readonly issue: IssueRecord;
	  },
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const session = requireSession(verb, options.env);
		if (session._tag === "Refused") return {_tag: "Refused" as const, outcome: session.outcome};
		const resolved = yield* resolveTargetRepo(verb, options.repo, options.env);
		if (resolved._tag === "Refused") return {_tag: "Refused" as const, outcome: resolved.outcome};
		const target = yield* openIssue(
			verb,
			resolved.repo,
			options.number,
			(reason) =>
				`${verb}: cannot read #${options.number}: ${reason} — ownership is UNKNOWN, never "unclaimed".`,
		);
		if (target._tag === "Refused") return {_tag: "Refused" as const, outcome: target.outcome};
		return {
			_tag: "Ready" as const,
			repo: resolved.repo,
			session: session.id,
			issue: target.issue,
		};
	});

export const runClaim = (
	options: ClaimOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const purpose = parseClaimPurpose(options.purpose);
		if (purpose === null) {
			return refuse(
				OFF_VOCABULARY,
				`${CLAIM}: --purpose "${options.purpose}" is not one of ${CLAIM_PURPOSES.join(" | ")} — an unrecognised purpose refuses, and never falls back to ${DEFAULT_CLAIM_PURPOSE}.`,
			);
		}
		const overrideRead = readOverride(options.override, options.overrideLane);
		if (overrideRead._tag === "Refused") return overrideRead.outcome;
		const override = overrideRead.override;

		const ready = yield* preflight(CLAIM, options);
		if (ready._tag === "Refused") return ready.outcome;
		const {repo, session} = ready;
		const {number} = options;

		// Already this session's: answer with the marker that owns the lane and write nothing. A second
		// marker would leave `claim` printing one nonce while `confirm`/`requireClaim` read the earliest
		// (#5782), and each `release` would then peel one marker off a stack instead of clearing it.
		// The fence is not re-run for the same reason `confirm` and `release` never run it — it decides
		// what may START, and this lane already started.
		const prior = yield* resolveOwnership(repo, number, session);
		if (prior.ownership._tag === "Mine") {
			return answer(
				JSON.stringify({answer: "won", number, token: prior.ownership.marker.token, purpose}),
				[
					`${CLAIM}: #${number} is already held by this session (comment ${prior.ownership.marker.commentId}) — answered with the marker that owns the lane; nothing was written.`,
				],
			);
		}

		const read = yield* readDeclaredFocus();
		if (read._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${CLAIM}: cannot read the "## Focus" declaration: ${read.reason} — scope is UNKNOWN, never admitted; nothing was written.`,
			);
		}
		const scopeLine = focusScopeLine(CLAIM, read.focus);
		const subject = yield* resolveAdmissionSubject(CLAIM, repo, read.focus, ready.issue);
		const judged = subject._tag === "Judged" ? subject.facts : ready.issue;
		const repair = subject._tag === "Judged" ? subject.repair : NOT_REPAIR;
		const purposeLine = purposeScopeLine(CLAIM, purpose, audienceAxisOf(judged), repair);
		const admission =
			subject._tag === "Judged"
				? admissionOf(read.focus, subject.facts, purpose, repair)
				: subject.admission;
		const lines = [
			scopeLine,
			...(subject._tag === "Judged" && subject.note !== null ? [subject.note] : []),
			purposeLine,
		];
		const refusal = admissionRefusal(CLAIM, admission);
		// An override answers a PROVEN refusal. UNKNOWN has proven nothing, so there is nothing to
		// override — a fence that could not read its input must not be talked past by a flag.
		const overridable =
			admission._tag === "OutOfFocus" ||
			admission._tag === "AudienceNotAgent" ||
			admission._tag === "NoServedIssue";
		if (refusal !== null && !(overridable && override !== null)) {
			return {
				...refusal,
				stderr: [
					...lines,
					...refusal.stderr,
					`${CLAIM}: nothing was written — #${number} carries no marker from this run${
						overridable
							? '; pass --override "<reason>" --override-lane "<lane>" to claim it anyway'
							: ""
					}.`,
				],
			};
		}

		const token = composeToken(session, options.uuid);
		const body = composeMarker(token, options.at, override);
		const posted = yield* createComment(repo, number, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${CLAIM}: the marker write failed: ${posted.reason} — the claim state is UNKNOWN; run "fabrika build confirm ${number}" before any further action.`,
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		if (back._tag === "Failure" || readMarkerToken(normalizeForReadback(back.value)) !== token) {
			return refuse(
				READBACK_MISMATCH,
				`${CLAIM}: the marker landed but the read-back does not match — the claim needs a human eye.`,
				[`${CLAIM}: comment ${posted.value.id} on #${number} is the one to inspect.`],
			);
		}

		// The checkpoint: posting DETECTS a race, this re-read RESOLVES it.
		const {ownership, unauthorized} = yield* resolveOwnership(repo, number, session);
		const notes = [
			...lines,
			...unauthorized.map(
				(marker) =>
					`${CLAIM}: comment ${marker.commentId} carries a claim marker from "${marker.author}", who holds no write permission — counted, never a winner.`,
			),
		];
		if (ownership._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${CLAIM}: cannot read the claim markers on #${number}: ${ownership.reason} — ownership is UNKNOWN, never "unclaimed".`,
				notes,
			);
		}
		if (ownership._tag === "Mine") {
			// The winner is this session's, but not necessarily the comment this run just posted: a
			// marker of ours already on the thread outranks it. Retract the loser so the thread keeps
			// one marker per session, and answer with the token every other verb will read.
			const shadowed = ownership.marker.commentId !== posted.value.id;
			const retracted = shadowed ? yield* deleteComment(repo, posted.value.id) : null;
			const trailer =
				retracted === null
					? []
					: retracted._tag === "Failure"
						? [
								`${CLAIM}: an older marker of this session already held #${number}; could not retract this run's duplicate (comment ${posted.value.id}): ${retracted.reason}.`,
							]
						: [
								`${CLAIM}: an older marker of this session already held #${number} — retracted this run's duplicate (comment ${posted.value.id}).`,
							];
			return answer(
				JSON.stringify({
					answer: "won",
					number,
					token: ownership.marker.token,
					purpose,
					...(override === null ? {} : {override}),
				}),
				[...notes, ...trailer],
			);
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
					`${CLAIM}: lost to ${ownership.marker.token} (posted ${ownership.marker.createdAt}, authorized).`,
					[...notes, ...trailer],
				)
			: refuse(
					CLAIM_NOT_MINE,
					`${CLAIM}: this run's own marker is not authorized — its author holds no write permission, so it can never win (ADR 0055).`,
					[...notes, ...trailer],
				);
	});

const CONFIRM = "build confirm";

export const runConfirm = (
	options: ProtocolOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const ready = yield* preflight(CONFIRM, options);
		if (ready._tag === "Refused") return ready.outcome;
		const {repo, session} = ready;
		const {number} = options;

		const {ownership, unauthorized} = yield* resolveOwnership(repo, number, session);
		const notes = unauthorized.map(
			(marker) =>
				`${CONFIRM}: comment ${marker.commentId} carries a claim marker from "${marker.author}", who holds no write permission — counted, never a winner.`,
		);
		switch (ownership._tag) {
			case "Unknown":
				return refuse(
					PRECONDITION_UNKNOWN,
					`${CONFIRM}: cannot read the claim markers on #${number}: ${ownership.reason} — ownership is UNKNOWN, never "unclaimed".`,
					notes,
				);
			case "Unclaimed":
				return refuse(
					CLAIM_NOT_MINE,
					`${CONFIRM}: no claim exists on #${number} — nothing to confirm; run "fabrika build claim ${number}" first.`,
					notes,
				);
			case "Foreign":
				return refuse(
					CLAIM_NOT_MINE,
					`${CONFIRM}: #${number} is held by ${ownership.marker.token}, not this session.`,
					notes,
				);
			case "Mine":
				return answer(
					JSON.stringify({answer: "mine", number, token: ownership.marker.token}),
					notes,
				);
		}
	});

const RELEASE = "build release";

export const runRelease = (
	options: ProtocolOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const ready = yield* preflight(RELEASE, options);
		if (ready._tag === "Refused") return ready.outcome;
		const {repo, session} = ready;
		const {number} = options;

		const {ownership, unauthorized} = yield* resolveOwnership(repo, number, session);
		const notes = unauthorized.map(
			(marker) =>
				`${RELEASE}: comment ${marker.commentId} carries a claim marker from "${marker.author}", who holds no write permission — counted, never a winner.`,
		);
		if (ownership._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${RELEASE}: cannot read the claim markers on #${number}: ${ownership.reason} — ownership is UNKNOWN, never "unclaimed".`,
				notes,
			);
		}
		if (ownership._tag !== "Mine") {
			return refuse(
				CLAIM_NOT_MINE,
				`${RELEASE}: this session holds no claim on #${number} — refusing to release another lane's.`,
				notes,
			);
		}
		// Every marker of this session's, not only the winner. A thread carrying duplicates — from a
		// build that predates #5782's fix — would otherwise hand the next `confirm` the next-oldest
		// one, so release/confirm would have no fixed point.
		const listed = yield* listComments(repo, number);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${RELEASE}: cannot re-read the markers on #${number}: ${listed.reason} — nothing was retracted; run "fabrika build release ${number}" again.`,
				notes,
			);
		}
		const ids = new Set([
			ownership.marker.commentId,
			...markersIn(listed.value)
				.filter((held) => parseToken(held.token, BUILD_CLAIM.prefix)?.session === session)
				.map((held) => held.commentId),
		]);
		for (const id of ids) {
			const deleted = yield* deleteComment(repo, id);
			if (deleted._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${RELEASE}: the retraction failed: ${deleted.reason} — whether the claim is still held is UNKNOWN; run "fabrika build confirm ${number}".`,
					notes,
				);
			}
		}
		return answer(JSON.stringify({answer: "released", number}), notes);
	});
