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
 * **`claim` runs the admission test before it writes anything; `confirm` and `release` never run it.**
 * The fence decides what may *start* (ADR 0245), so a focus row edited mid-lane must not strand a
 * running lane or block its release. Claiming is the one moment every path goes through — a number
 * handed straight to `claim` passes through no pool — which is why the refusal has teeth here and is
 * advice at the pool.
 */
import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, deleteComment, getComment, type IssueRecord} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {composeMarker, readMarkerToken, requireSession, resolveOwnership} from "./claim.ts";
import {CLAIM_NOT_MINE, PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {composeToken} from "./lane.ts";
import {
	admissionOf,
	admissionRefusal,
	focusScopeLine,
	readDeclaredFocus,
} from "./scope-admission.ts";
import {openIssue, resolveTargetRepo} from "./target.ts";

export interface ClaimOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** A fresh UUID, supplied by the adapter so the token this run mints is deterministic under test. */
	readonly uuid: string;
	/** The marker's human-readable ISO-8601 timestamp. The tiebreak uses GitHub's `created_at`. */
	readonly at: string;
	/** Why this run claims an issue the admission test refused, or `null` for the ordinary path. */
	readonly override: string | null;
}

export type ProtocolOptions = Omit<ClaimOptions, "uuid" | "at" | "override">;

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

const CLAIM = "build claim";

export const runClaim = (
	options: ClaimOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		if (options.override !== null && options.override.trim() === "") {
			return refuse(
				FAILED,
				`${CLAIM}: --override was given with an empty reason — an override is recorded or it is not one.`,
			);
		}
		const ready = yield* preflight(CLAIM, options);
		if (ready._tag === "Refused") return ready.outcome;
		const {repo, session} = ready;
		const {number} = options;

		const read = yield* readDeclaredFocus();
		if (read._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${CLAIM}: cannot read the "## Focus" declaration: ${read.reason} — scope is UNKNOWN, never admitted; nothing was written.`,
			);
		}
		const scopeLine = focusScopeLine(CLAIM, read.focus);
		const admission = admissionOf(read.focus, ready.issue);
		const refusal = admissionRefusal(CLAIM, admission);
		// An override answers a PROVEN refusal. UNKNOWN has proven nothing, so there is nothing to
		// override — a fence that could not read its input must not be talked past by a flag.
		const overridable = admission._tag === "OutOfFocus" || admission._tag === "AudienceNotAgent";
		if (refusal !== null && !(overridable && options.override !== null)) {
			return {
				...refusal,
				stderr: [
					scopeLine,
					...refusal.stderr,
					`${CLAIM}: nothing was written — #${number} carries no marker from this run${
						overridable ? '; pass --override "<reason>" to claim it anyway' : ""
					}.`,
				],
			};
		}

		const token = composeToken(session, options.uuid);
		const body = composeMarker(token, options.at, options.override);
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
			scopeLine,
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
			return answer(
				JSON.stringify({
					answer: "won",
					number,
					token,
					...(options.override === null ? {} : {override: options.override}),
				}),
				notes,
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
		const deleted = yield* deleteComment(repo, ownership.marker.commentId);
		return deleted._tag === "Failure"
			? refuse(
					WRITE_UNKNOWN,
					`${RELEASE}: the retraction failed: ${deleted.reason} — whether the claim is still held is UNKNOWN; run "fabrika build confirm ${number}".`,
					notes,
				)
			: answer(JSON.stringify({answer: "released", number}), notes);
	});
