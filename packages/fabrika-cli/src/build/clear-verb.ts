/**
 * `build clear` — record the founder's clearance of one extra repair round on a PR.
 *
 * The clauses are conjunctive and any miss resolves to *not cleared*, never to a warning: the
 * invoking account is in the repo's `.fabrika.jsonc` grant-author set at the PR's base ref, the PR
 * is open, its budget is actually spent, and the quoted authorization is present and dated. A bare
 * stamp is void (#4938), which is why `--authorization` is required rather than inferred.
 *
 * **Write ordering is an invariant, not an implementation detail** — the same one `grill rule`
 * holds. The authorization comment lands first and the marker second: an interrupted run that wrote
 * the marker first would leave a void grant a careless reader folds as budget, while the reverse
 * leaves a quote with no marker, which resolves to nothing and grants nobody anything. The lane's
 * local bump is last, because a lane that has not heard about the grant only freezes early, and a
 * lane bumped with no marker behind it would run a round nobody granted.
 *
 * **What `cleared` proves, exactly.** That an account the repo configured posted a marker naming a
 * round whose budget was spent, with a dated authorization comment beside it. It does not prove the
 * quoted authorization is a truthful record of what the founder said; nothing mechanical can, and
 * the residue is the same one #4441 is open on for `grill rule`. In a repo where an agent runs on
 * the founder's own token, the agent's restraint is what holds — this verb is the operator's, and
 * `build`'s Repair section tells a builder that reads a cap to escalate, never to clear it.
 */

import type {FileSystem, Path} from "effect";
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {effectiveCap, grantedRounds} from "../cap-clearance.ts";
import {createComment, getComment, listComments} from "../io/issues.ts";
import {viewerLogin} from "../io/pulls.ts";
import {recordClearedRound} from "../lane/clearance.ts";
import {laneRef, parseKey} from "../lane/key.ts";
import {CONFIG_PATH} from "../repo-config.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {CAP_ROUND} from "../retry-budget.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import * as capClearance from "../wire/cap-clearance.ts";
import {stampOf} from "../wire/grill-marker.ts";
import {read as readMarker} from "../wire/verdict-marker.ts";
import {clearancesOn, grantedFrom, membershipAt} from "./clearances.ts";
import {
	AUTHORIZATION_VOID,
	BARE_AT_PATH,
	GRANT_UNAUTHORIZED,
	LEAKED_PATH,
	LOCAL_LANE_UNWRITTEN,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {closingTargets, proseOf} from "./pr-body.ts";
import {countRounds} from "./rounds.ts";
import {openPull, resolveTargetRepo} from "./target.ts";

const VERB = "build clear";

/** Any ISO-8601 date in the quote — a clearance the reader cannot place in time is not dated. */
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

/** A file the adapter read for the verb, so the verb itself touches no filesystem for it. */
export type DocumentRead =
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "Failed"; readonly reason: string};

export interface ClearOptions<R = never> {
	readonly pr: number;
	/** The `--authorization` path, carried for the refusal messages only. */
	readonly authorizationPath: string;
	readonly authorization: Effect.Effect<DocumentRead, never, R>;
	/** The lanes root override, and the task the grant addresses on a multi-task lane. */
	readonly laneRoot: string | null;
	readonly task: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

export const runClear = <R = never>(
	options: ClearOptions<R>,
): Effect.Effect<
	VerbOutcome,
	never,
	R | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {pr, authorizationPath} = options;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const read = yield* options.authorization;
		if (read._tag === "Failed") {
			return refuse(
				FAILED,
				`${VERB}: could not read --authorization ${authorizationPath}: ${read.reason} — the authorization is UNKNOWN, never empty.`,
			);
		}
		const quoted = read.text;
		if (quoted.trim() === "") {
			return refuse(
				AUTHORIZATION_VOID,
				`${VERB}: --authorization ${authorizationPath} is empty — a clearance with no quoted authorization is void (#4938).`,
			);
		}
		if (!ISO_DATE.test(quoted)) {
			return refuse(
				AUTHORIZATION_VOID,
				`${VERB}: --authorization ${authorizationPath} carries no ISO-8601 date — the authorization must be dated.`,
			);
		}
		if (isBareAtReference(quoted)) {
			return refuse(
				BARE_AT_PATH,
				`${VERB}: the authorization is a bare @ path reference — not redactable, refusing to post it.`,
			);
		}
		const leaks = scanBody(quoted);
		const firstLeak = leaks.leaks[0];
		if (firstLeak !== undefined) {
			return refuse(
				LEAKED_PATH,
				`${VERB}: the authorization carries a machine-local path: ${firstLeak.text} — refusing to post it.`,
				renderLeaks(leaks.leaks),
			);
		}

		const target = yield* openPull(
			VERB,
			repo,
			pr,
			(reason) =>
				`${VERB}: cannot read PR #${pr}: ${reason} — whether it can be cleared is UNKNOWN. Nothing was posted.`,
		);
		if (target._tag === "Refused") return target.outcome;
		const baseRef = target.pull.baseRef;

		const listed = yield* listComments(repo, pr);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the comments on #${pr}: ${listed.reason} — the round count is UNKNOWN. Nothing was posted.`,
			);
		}
		const rounds = countRounds(
			listed.value.flatMap((comment) => {
				const parsed = readMarker(comment.body);
				return parsed._tag === "Found" && parsed.value.polarity === "FAIL"
					? [comment.createdAt]
					: [];
			}),
		);
		const recorded = yield* clearancesOn(repo, baseRef, listed.value);
		if (recorded._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the recorded clearances: ${recorded.reason} — the granted budget is UNKNOWN. Nothing was posted.`,
			);
		}
		const granted = grantedFrom(recorded.rows);
		const cap = effectiveCap(granted);
		const scopeLine = `${VERB}: ${repo}#${pr} at ${rounds} round(s); cap ${cap} = ${CAP_ROUND} declared + ${grantedRounds(granted)} cleared.`;
		if (rounds < cap) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${pr} has ${rounds} round(s) against a cap of ${cap} — the budget is not spent, so there is no round to clear.`,
				[scopeLine],
			);
		}

		const viewer = yield* viewerLogin;
		if (viewer._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the invoking account: ${viewer.reason} — authority is UNKNOWN, never granted. Nothing was posted.`,
				[scopeLine],
			);
		}
		// The ACL is read through the same door that judges a landed marker, so the set that may post
		// a grant and the set whose grant counts can never drift into two.
		const authority = yield* membershipAt(repo, baseRef);
		if (authority._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve ${viewer.value}'s authority on ${repo}: ${authority.reason} — nothing was posted.`,
				[scopeLine],
			);
		}
		if (authority._tag === "Unusable") {
			return refuse(GRANT_UNAUTHORIZED, `${VERB}: ${authority.reason}. Nothing was posted.`, [
				scopeLine,
			]);
		}
		if (!authority.holds(viewer.value)) {
			return refuse(
				GRANT_UNAUTHORIZED,
				`${VERB}: ${viewer.value} is not in ${CONFIG_PATH}'s grant-author set at ${baseRef} — refusing to record a clearance.`,
				[scopeLine],
			);
		}

		const stamped = stampOf(options.now());
		if (stamped === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: the clock did not render an ISO-8601 UTC instant — the marker cannot be stamped. Nothing was posted.`,
				[scopeLine],
			);
		}
		const round = capClearance.clearedRound(rounds);
		if (round === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: #${pr} counts ${rounds} rounds, which is not a round a clearance can name.`,
				[scopeLine],
			);
		}
		const authorizationBody = quoted.trim().endsWith("\n") ? quoted.trim() : `${quoted.trim()}\n`;
		const authorization = yield* createComment(repo, pr, authorizationBody);
		if (authorization._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the authorization write failed, so whether it posted is UNKNOWN and no marker was written — read #${pr} before re-running.`,
				[scopeLine],
			);
		}
		const markerBody = capClearance.emit({round, at: stamped});
		const marker = yield* createComment(repo, pr, markerBody);
		if (marker._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the authorization comment landed as #${authorization.value.id} and the marker write failed — the clearance is INCOMPLETE and grants nothing. Read #${pr} before re-running.`,
				[scopeLine],
			);
		}
		const landed = yield* getComment(repo, marker.value.id);
		if (
			landed._tag === "Failure" ||
			normalizeForReadback(landed.value) !== normalizeForReadback(markerBody)
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the marker posted but the read-back does not match what was sent.`,
				[scopeLine],
			);
		}

		const lane = yield* bumpLane(options, target.pull.body, round);
		if (lane._tag === "Unwritten") {
			return refuse(
				LOCAL_LANE_UNWRITTEN,
				`${VERB}: the clearance is recorded on #${pr}, and the lane at ${lane.path} did not take it: ${lane.reason} — the lane still freezes. Re-run to reconcile; the grant is not doubled.`,
				[scopeLine],
			);
		}

		return answer(
			JSON.stringify({
				pr,
				round,
				at: stamped,
				by: viewer.value,
				authorization: authorization.value.id,
				marker: marker.value.id,
				cap: effectiveCap([...granted, round]),
				lane: lane.note,
				resolvesTo: "cleared",
			}),
			[scopeLine],
		);
	});

type LaneBump =
	| {readonly _tag: "Note"; readonly note: string}
	| {readonly _tag: "Unwritten"; readonly path: string; readonly reason: string};

/**
 * Carry the grant into the local lane, if one is there.
 *
 * The lane is the PR's linked issue — the same closing keyword every other reader resolves the
 * contract through — so nothing here invents a lane key. A PR that closes nothing, or a lane that
 * is not on this machine, is an answer: there is no local guard to trip.
 */
const bumpLane = <R>(
	options: ClearOptions<R>,
	body: string,
	round: number,
): Effect.Effect<LaneBump, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const issue = closingTargets(proseOf(body))[0];
		if (issue === undefined) return {_tag: "Note" as const, note: "no linked issue, so no lane"};
		const key = parseKey(String(issue));
		if (key._tag === "Malformed") {
			return {_tag: "Note" as const, note: `#${issue} is not a lane key`};
		}
		const written = yield* recordClearedRound(
			laneRef(key.key, options.laneRoot),
			options.task,
			round,
		);
		if (written._tag === "NoLane") {
			return {_tag: "Note" as const, note: `no lane at ${written.dir}`};
		}
		if (written._tag === "Unusable") {
			return {_tag: "Unwritten" as const, path: written.path, reason: written.reason};
		}
		return {
			_tag: "Note" as const,
			note:
				written._tag === "Recorded"
					? `recorded on ${written.task} in ${written.path}`
					: `${written.task} already held round ${round}`,
		};
	});
