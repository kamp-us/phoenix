/**
 * `ship nudge` — the at-most-once dropped-trigger remedy.
 *
 * **The verb trusts nothing it was told.** It re-derives the zero-runs precondition itself, because
 * a mis-dispatched nudge once close→reopened a live green head and left a false comment on it
 * (#4816): the caller's `ship checks` output is routing, never authority. A state *proven otherwise*
 * — runs exist, no workflows, PR not open — is `16`, refused without touching the PR.
 *
 * The head ref is untouched by construction: close/reopen preserves it, so SHA-bound verdicts
 * survive. That is why the remedy is this and not a rebase.
 *
 * `17` is the loudest code in the group. The nudge is the group's one two-legged mutation, and v1's
 * unguarded PATCH pair could close a PR, fail the reopen, and still report "nudged". Folding that
 * into `8` would hide the one fact the operator must act on immediately.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	INCOMPLETE_SCAN,
	NUDGE_REOPEN_UNCONFIRMED,
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	STALE_HEAD,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	commitDate,
	countCommitStatuses,
	listShipCheckRuns,
	listWorkflows,
	pullTimeline,
	setPullState,
} from "./github.ts";
import {reopensSince} from "./queue.ts";
import {badNumber, inspectedSha, prefixMatch, resolvePull, resolveTargetRepo} from "./target.ts";

const VERB = "ship nudge";

export interface NudgeOptions {
	readonly pr: number;
	readonly sha: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runNudge = (
	options: NudgeOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return bound;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const unreadable = (what: string, reason: string): VerbOutcome =>
			refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${what}: ${reason} — the dropped-trigger state is UNKNOWN; nothing was touched.`,
			);
		const notInState = (why: string): VerbOutcome =>
			refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: #${pr} is not in the dropped-trigger state (${why}) — refusing to touch it (#4816).`,
			);

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) => unreadable(`PR #${pr}`, reason).stderr.at(-1) ?? reason,
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;
		if (!prefixMatch(pull.headSha, bound)) {
			return refuse(
				STALE_HEAD,
				`${VERB}: the live head is ${pull.headSha}, not ${bound} — the state you diagnosed is another tree's.`,
			);
		}
		if (pull.state !== "open") return notInState("the PR is not open");

		const runs = yield* listShipCheckRuns(repo, bound);
		if (runs._tag === "Failure") return unreadable(`the check runs at ${bound}`, runs.reason);
		if (runs.value.declared > 0) {
			return notInState(`${runs.value.declared} check runs exist at ${bound}`);
		}
		const statuses = yield* countCommitStatuses(repo, bound);
		if (statuses._tag === "Failure") {
			return unreadable(`the commit statuses at ${bound}`, statuses.reason);
		}
		if (statuses.value > 0) {
			return notInState(`${statuses.value} commit statuses exist at ${bound}`);
		}
		const workflows = yield* listWorkflows(repo);
		if (workflows._tag === "Failure") {
			return unreadable("the workflow inventory", workflows.reason);
		}
		if (workflows.value === 0) return notInState("the repository declares no workflows");

		const pushed = yield* commitDate(repo, bound);
		if (pushed._tag === "Failure") return unreadable(`the push date of ${bound}`, pushed.reason);
		const events = yield* pullTimeline(repo, pr);
		if (events._tag === "Failure") return unreadable(`#${pr}'s timeline`, events.reason);
		if (!events.value.exhausted) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: the timeline read never reached a terminal page — pagination is unexhausted; refusing to count reopens over a truncated history.`,
			);
		}
		const reopens = reopensSince(events.value.events, pushed.value);
		if (reopens >= 1) {
			return refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: head ${bound} was already nudged (${reopens} reopened events since push) — a second nudge is escalation, not retry.`,
			);
		}

		const closed = yield* setPullState(repo, pr, "closed");
		if (closed._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the close failed: ${closed.reason} — nothing changed state.`,
			);
		}
		const afterClose = yield* resolvePull(VERB, repo, pr);
		if (afterClose._tag === "Refused" || afterClose.pull.state === "open") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the close failed: the read-back does not show #${pr} closed — nothing changed state.`,
			);
		}

		const reopened = yield* setPullState(repo, pr, "open");
		const afterOpen = yield* resolvePull(VERB, repo, pr);
		if (afterOpen._tag === "Refused" || afterOpen.pull.state !== "open") {
			const why =
				reopened._tag === "Failure" ? reopened.reason : "the read-back does not show it open";
			return refuse(
				NUDGE_REOPEN_UNCONFIRMED,
				`${VERB}: the close landed and the reopen is UNCONFIRMED: ${why} — PR #${pr} may be CLOSED. Reopen it by hand now.`,
			);
		}

		return json
			? answer(JSON.stringify({outcome: "nudged", sha: bound}))
			: answer(`nudged\t${bound}`);
	});
