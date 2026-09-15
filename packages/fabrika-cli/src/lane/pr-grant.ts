/**
 * The PR-side half of a driver's grant — what `lane clear` records on the lane's pull request.
 *
 * A lane at its cap has two budgets, and they are counted in two logs: the lane machine guards each
 * task with `retries < maxRetries` off the lane's own events, and `build verdicts` folds
 * `capReached` off the FAIL-marker rounds on the PR. A driver clearing only the lane one dispatched
 * a builder that read the PR one and refused without touching the branch — the lane-side grant, the
 * `UNBLOCKED` and a whole shell spent on budget nobody could read. The two are one act now, and the
 * decision record that rules it is in the repository's own corpus; search it for this verb's name.
 * `build clear` stays the seat for a bare PR-side grant with no lane clear behind it.
 *
 * **What moves and what does not.** The document requirement moves: a driver's rationale IS the
 * dated authorization, because a driver acts on its own recommendation and logs it, exactly as it
 * already does on the lane line. The ACL does not: the marker is honoured through
 * `../build/clearances.ts`'s same four clauses, so the account posting it still has to be in
 * `.fabrika.jsonc`'s grant-author set at the PR's base ref and still has to hold `write+` live.
 * Authority was never the founder document's; it was always the ACL's.
 *
 * **The grant is whole or it is refused.** Every read and both writes happen before `lane clear`
 * appends its own line, so a PR-side grant that cannot be made honourably refuses with the lane log
 * byte-identical rather than leaving a void half-seat — which is the exact failure this module
 * exists to remove. The one asymmetry is deliberate: a task with no pull request answers `NoPull`
 * and the lane-side grant proceeds, because an epic child and a chore lane were always this verb's
 * first seat.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	clearancesOn,
	clearsWriteFloor,
	grantedFrom,
	membershipAt,
	permissionsFor,
} from "../build/clearances.ts";
import {roundsOn} from "../build/rounds.ts";
import {openPull, resolveTargetRepo} from "../build/target.ts";
import {effectiveCap} from "../cap-clearance.ts";
import {createComment, getComment, listComments} from "../io/issues.ts";
import {viewerLogin} from "../io/pulls.ts";
import {CONFIG_PATH} from "../repo-config.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import * as capClearance from "../wire/cap-clearance.ts";
import {stampOf} from "../wire/grill-marker.ts";
import {
	APPEND_UNKNOWN,
	BARE_AT_PATH,
	GRANT_UNAUTHORIZED,
	LANE_UNREADABLE,
	LEAKED_PATH,
	MARKER_READBACK,
	PR_AMBIGUOUS,
} from "./codes.ts";
import {nominatePulls, nominationScope} from "./nominate.ts";
import {tracePulls} from "./prove.ts";

/** What a task's PR-side grant resolved to, or why there is nothing there to grant. */
export type PrGrant =
	| {
			readonly _tag: "Granted";
			readonly pr: number;
			readonly round: number;
			readonly authorization: number;
			readonly marker: number;
			readonly cap: number;
	  }
	/** The round was already granted on this PR — a re-run reconciles and doubles nothing. */
	| {readonly _tag: "Held"; readonly pr: number; readonly round: number; readonly cap: number}
	/** The PR's own budget is not spent, so there is no round there to clear. */
	| {readonly _tag: "Unspent"; readonly pr: number; readonly rounds: number; readonly cap: number}
	/** No pull request carries this task — an epic child, a chore lane, a lane before its first PR. */
	| {readonly _tag: "NoPull"; readonly why: string}
	| {
			readonly _tag: "Refused";
			readonly code: number;
			readonly message: string;
			readonly notes: ReadonlyArray<string>;
	  };

export interface PrGrantRequest {
	readonly verb: string;
	/** The issue the granted task drives, or `null` where the task has no board issue at all. */
	readonly issue: number | null;
	/** Why there is no issue, printed as the `NoPull` note. Unread when `issue` is a number. */
	readonly noIssueWhy: string;
	readonly lane: string;
	readonly task: string;
	readonly rationale: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

const refused = (code: number, message: string, notes: ReadonlyArray<string> = []): PrGrant => ({
	_tag: "Refused",
	code,
	message,
	notes,
});

/**
 * The authorization comment a driver's grant rests on.
 *
 * It is the rationale, dated and attributed — `../build/clearances.ts`'s clause 4 asks for a dated
 * comment from the marker's author immediately before it, and nothing about that clause is the
 * founder's. The date is rendered from the same clock that stamps the marker, so a reader placing
 * the grant in time reads one instant rather than two.
 */
export const authorizationBody = (request: PrGrantRequest, at: string): string =>
	[
		`Driver grant · lane ${request.lane} · task ${request.task} · ${at.slice(0, 10)}`,
		"",
		request.rationale,
		"",
		"Recorded by `fabrika lane clear` on the driver's own recommendation, which is this grant's",
		"whole audit. `build clear` remains the founder's verb for a PR-side grant with no lane clear",
		"behind it.",
		"",
	].join("\n");

/**
 * Grant the lane's pull request one repair round, or say why there is none to grant.
 *
 * The write order is `build clear`'s and for its reason: the authorization lands first and the
 * marker second, so an interrupted run leaves a quote that grants nobody anything rather than a
 * bare marker a careless reader folds as budget.
 */
export const grantPrRound = (
	request: PrGrantRequest,
): Effect.Effect<PrGrant, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {verb, issue} = request;
		if (issue === null) return {_tag: "NoPull" as const, why: request.noIssueWhy};

		if (isBareAtReference(request.rationale)) {
			return refused(
				BARE_AT_PATH,
				`${verb}: the rationale is a bare @ path reference — not redactable, and it is headed for a public pull request. Nothing was posted and the log is unappended.`,
			);
		}
		const leaks = scanBody(request.rationale);
		const firstLeak = leaks.leaks[0];
		if (firstLeak !== undefined) {
			return refused(
				LEAKED_PATH,
				`${verb}: the rationale carries a machine-local path: ${firstLeak.text} — it is headed for a public pull request. Nothing was posted and the log is unappended.`,
				renderLeaks(leaks.leaks),
			);
		}

		const resolved = yield* resolveTargetRepo(verb, request.repo, request.env);
		if (resolved._tag === "Refused") {
			return refused(
				LANE_UNREADABLE,
				`${verb}: cannot resolve a target repo, so whether this lane has a pull request to grant is UNKNOWN — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves. The log is unappended.`,
			);
		}
		const repo = resolved.repo;

		const nominated = yield* nominatePulls(repo, issue);
		if (nominated._tag === "Unreadable") {
			return refused(
				LANE_UNREADABLE,
				`${verb}: cannot read ${nominated.what}: ${nominated.reason} — the PR-side budget is UNKNOWN, so the grant is unmade and the log unappended.`,
			);
		}
		const traced = tracePulls(issue, nominated.pulls);
		if (traced._tag === "Many") {
			return refused(
				PR_AMBIGUOUS,
				`${verb}: ${traced.prs.length} open PRs link #${issue} — which one carries this task's repair budget is not this verb's to guess. Nothing was posted and the log is unappended.`,
				[`${verb}: candidates: ${traced.prs.map((pr) => `#${pr}`).join(", ")}.`],
			);
		}
		if (traced._tag === "None") {
			return {
				_tag: "NoPull" as const,
				why: `${traced.why} across ${nominationScope(issue)}`,
			};
		}
		const pr = traced.pr;

		const target = yield* openPull(
			verb,
			repo,
			pr,
			(reason) =>
				`${verb}: cannot read PR #${pr}: ${reason} — whether its budget can be granted is UNKNOWN. Nothing was posted and the log is unappended.`,
		);
		if (target._tag === "Refused") {
			return refused(
				LANE_UNREADABLE,
				`${verb}: PR #${pr} traces to #${issue} and no longer reads as open — the PR-side grant is unmade and the log unappended.`,
			);
		}
		const baseRef = target.pull.baseRef;

		const listed = yield* listComments(repo, pr);
		if (listed._tag === "Failure") {
			return refused(
				LANE_UNREADABLE,
				`${verb}: cannot read the comments on #${pr}: ${listed.reason} — the round count is UNKNOWN. Nothing was posted and the log is unappended.`,
			);
		}
		const rounds = roundsOn(listed.value);
		const recorded = yield* clearancesOn(repo, baseRef, listed.value);
		if (recorded._tag === "Unknown") {
			return refused(
				LANE_UNREADABLE,
				`${verb}: cannot read the recorded clearances on #${pr}: ${recorded.reason} — the granted budget is UNKNOWN. Nothing was posted and the log is unappended.`,
			);
		}
		const granted = grantedFrom(recorded.rows);
		const cap = effectiveCap(granted);
		const held = recorded.rows.find((row) => row.honoured && row.round === rounds);
		if (held !== undefined) {
			return {_tag: "Held" as const, pr, round: held.round, cap};
		}
		if (rounds < cap) {
			return {_tag: "Unspent" as const, pr, rounds, cap};
		}

		const viewer = yield* viewerLogin;
		if (viewer._tag === "Failure") {
			return refused(
				LANE_UNREADABLE,
				`${verb}: cannot resolve the invoking account: ${viewer.reason} — authority is UNKNOWN, never granted. Nothing was posted and the log is unappended.`,
			);
		}
		const authority = yield* membershipAt(repo, baseRef);
		if (authority._tag === "Unknown") {
			return refused(
				LANE_UNREADABLE,
				`${verb}: cannot resolve ${viewer.value}'s authority on ${repo}: ${authority.reason} — nothing was posted and the log is unappended.`,
			);
		}
		if (authority._tag === "Unusable" || !authority.holds(viewer.value)) {
			return refused(
				GRANT_UNAUTHORIZED,
				`${verb}: ${
					authority._tag === "Unusable"
						? authority.reason
						: `${viewer.value} is not in ${CONFIG_PATH}'s grant-author set at ${baseRef}`
				} — a marker this account posts on #${pr} would be void, so the grant is refused whole. Nothing was posted and the log is unappended.`,
			);
		}
		const permissions = yield* permissionsFor(repo, [viewer.value]);
		if (permissions._tag === "Unknown") {
			return refused(
				LANE_UNREADABLE,
				`${verb}: cannot resolve ${viewer.value}'s repository permission: ${permissions.reason} — authority is UNKNOWN, never granted. Nothing was posted and the log is unappended.`,
			);
		}
		const level = permissions.levelOf(viewer.value);
		if (!clearsWriteFloor(level)) {
			return refused(
				GRANT_UNAUTHORIZED,
				`${verb}: ${viewer.value} resolves to ${level ?? "no collaboration"} on ${repo}, below write — authority is the ACL's, never ${CONFIG_PATH}'s alone. Nothing was posted and the log is unappended.`,
			);
		}

		const stamped = stampOf(request.now());
		if (stamped === null) {
			return refused(
				LANE_UNREADABLE,
				`${verb}: the clock did not render an ISO-8601 UTC instant — the marker cannot be stamped. Nothing was posted and the log is unappended.`,
			);
		}
		const round = capClearance.clearedRound(rounds);
		if (round === null) {
			return refused(
				LANE_UNREADABLE,
				`${verb}: #${pr} counts ${rounds} rounds, which is not a round a clearance can name. Nothing was posted and the log is unappended.`,
			);
		}

		const authorization = yield* createComment(repo, pr, authorizationBody(request, stamped));
		if (authorization._tag === "Failure") {
			return refused(
				APPEND_UNKNOWN,
				`${verb}: the authorization write on #${pr} failed, so whether it posted is UNKNOWN and no marker was written — read #${pr} before re-running. The log is unappended.`,
			);
		}
		const markerBody = capClearance.emit({round, at: stamped});
		const marker = yield* createComment(repo, pr, markerBody);
		if (marker._tag === "Failure") {
			return refused(
				APPEND_UNKNOWN,
				`${verb}: the authorization comment landed on #${pr} as ${authorization.value.id} and the marker write failed — the clearance is INCOMPLETE and grants nothing. Read #${pr} before re-running. The log is unappended.`,
			);
		}
		const landed = yield* getComment(repo, marker.value.id);
		if (
			landed._tag === "Failure" ||
			normalizeForReadback(landed.value) !== normalizeForReadback(markerBody)
		) {
			return refused(
				MARKER_READBACK,
				`${verb}: the marker posted on #${pr} and the read-back does not match what was sent. The log is unappended.`,
			);
		}

		return {
			_tag: "Granted" as const,
			pr,
			round,
			authorization: authorization.value.id,
			marker: marker.value.id,
			cap: effectiveCap([...granted, round]),
		};
	});

/** The stderr line a resolved PR-side grant reports itself on — one line, whatever the arm. */
export const prGrantNote = (verb: string, grant: PrGrant): string => {
	switch (grant._tag) {
		case "Granted":
			return `${verb}: granted round ${grant.round} on PR #${grant.pr} as marker ${grant.marker}, on the rationale posted beside it — the builder reads a cap of ${grant.cap} now.`;
		case "Held":
			return `${verb}: PR #${grant.pr} already carried an honoured grant at round ${grant.round} — a grant is keyed by its round, so this buys nothing and doubles nothing.`;
		case "Unspent":
			return `${verb}: PR #${grant.pr} is at ${grant.rounds} round(s) against a cap of ${grant.cap} — its budget is not spent, so there was no PR-side round to clear.`;
		case "NoPull":
			return `${verb}: no PR-side budget to grant — ${grant.why}.`;
		case "Refused":
			return grant.message;
	}
};

/**
 * What the verb's stdout carries about the PR side, or `null` where no pull request was found.
 *
 * `answer` is the arm's own word rather than a boolean, because "granted", "already held" and "its
 * budget was not spent" are three different facts about one number and a reader collapsing them
 * cannot tell a round this call bought from one it found.
 */
export const prGrantAnswer = (
	grant: PrGrant,
): {
	readonly number: number;
	readonly answer: "cleared" | "held" | "unspent";
	readonly round: number;
	readonly cap: number;
} | null => {
	switch (grant._tag) {
		case "Granted":
			return {number: grant.pr, answer: "cleared", round: grant.round, cap: grant.cap};
		case "Held":
			return {number: grant.pr, answer: "held", round: grant.round, cap: grant.cap};
		case "Unspent":
			return {number: grant.pr, answer: "unspent", round: grant.rounds, cap: grant.cap};
		default:
			return null;
	}
};
