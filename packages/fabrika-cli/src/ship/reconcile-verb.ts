/**
 * `ship reconcile` — the bounded post-enqueue watch.
 *
 * See the reconcile help in ./command.ts for the watch outcomes.
 *
 * A poll that cannot read classifies `pending`. A miss can only keep polling; it can never mint
 * `landed` or `ejected`, which is the fail-safe direction.
 */
import {Clock, Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {branchSubjects, isQueueGoverned, pullTimeline} from "./github.ts";
import {armedAtOf, landedOnBase, queueStateOf} from "./queue.ts";
import {badNumber, resolvePull, resolveTargetRepo} from "./target.ts";

const VERB = "ship reconcile";

export type Reconciled = "landed" | "ejected" | "unresolved" | "parked";

/**
 * How long an `--auto` arm may sit unqueued before `parked` may be said. GitHub has been seen
 * holding a live arm 514 s before adding the PR to the queue, so the floor sits well past it.
 */
export const ARM_SETTLE_FLOOR_SECONDS = 1200;

/**
 * The verdict for a watch that saw no terminal. Off a queue the arm IS the merge mechanism, so a
 * long dwell is ordinary. On a queue-governed base, a never-queued arm is `parked` only once it has
 * waited past the floor; an arm with no readable time parks as it always did, never sooner.
 */
export const dwellOutcome = (watch: {
	readonly everQueued: boolean;
	readonly queueGoverned: boolean;
	readonly armedAt: number | null;
	readonly now: number;
}): "unresolved" | "parked" => {
	if (watch.everQueued || !watch.queueGoverned) return "unresolved";
	const settling =
		watch.armedAt !== null && watch.now - watch.armedAt < ARM_SETTLE_FLOOR_SECONDS * 1000;
	return settling ? "unresolved" : "parked";
};

export interface ReconcileOptions {
	readonly pr: number;
	readonly polls: number;
	readonly cadenceSeconds: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

type Poll =
	| {readonly _tag: "Terminal"; readonly outcome: Reconciled}
	| {readonly _tag: "Watched"; readonly queued: boolean; readonly armedAt: number | null}
	| {readonly _tag: "Unreadable"; readonly reason: string}
	/** The timeline read never reached a terminal page — distinct from unreadable, and not pollable. */
	| {readonly _tag: "Truncated"};

export const runReconcile = (
	options: ReconcileOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const first = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) =>
				`${VERB}: every poll failed to read #${pr}: ${reason} — the outcome is UNKNOWN, not "unresolved".`,
		});
		if (first._tag === "Refused") return first.outcome;
		const base = first.pull.baseRef;

		const governed = yield* isQueueGoverned(repo, base);
		// Fail-closed: an unreadable regime reads queue-governed, so a failed read cannot mint `parked`
		// on a branch that has no queue at all.
		const queueGoverned = governed._tag === "Ok" ? governed.value : true;

		const poll = Effect.gen(function* () {
			const pull = yield* resolvePull(VERB, repo, pr);
			if (pull._tag === "Refused") {
				return {_tag: "Unreadable", reason: `the pull request`} satisfies Poll;
			}
			if (pull.pull.merged) return {_tag: "Terminal", outcome: "landed"} satisfies Poll;

			const subjects = yield* branchSubjects(repo, base);
			if (subjects._tag === "Ok" && landedOnBase(subjects.value, pr)) {
				return {_tag: "Terminal", outcome: "landed"} satisfies Poll;
			}

			const events = yield* pullTimeline(repo, pr);
			if (events._tag === "Failure") {
				return {_tag: "Unreadable", reason: events.reason} satisfies Poll;
			}
			if (!events.value.exhausted) return {_tag: "Truncated"} satisfies Poll;
			const state = queueStateOf(events.value.events);
			if (state === "ejected") return {_tag: "Terminal", outcome: "ejected"} satisfies Poll;
			return {
				_tag: "Watched",
				queued: state === "queued",
				armedAt: armedAtOf(events.value.events),
			} satisfies Poll;
		});

		const horizon = options.polls * options.cadenceSeconds;
		let everQueued = false;
		let armedAt: number | null = null;
		let unreadable = 0;
		let lastReason = "no poll ran";
		for (let used = 1; used <= options.polls; used++) {
			const result = yield* poll;
			if (result._tag === "Terminal") return emit(json, result.outcome, used, horizon);
			if (result._tag === "Truncated") {
				return refuse(
					INCOMPLETE_SCAN,
					`${VERB}: the timeline read never reached a terminal page — pagination is unexhausted; refusing to classify over a truncated history.`,
				);
			}
			if (result._tag === "Unreadable") {
				unreadable += 1;
				lastReason = result.reason;
			} else {
				if (result.queued) everQueued = true;
				if (result.armedAt !== null) armedAt = Math.max(armedAt ?? result.armedAt, result.armedAt);
			}
			if (used < options.polls) yield* Effect.sleep(`${options.cadenceSeconds} seconds`);
		}

		if (unreadable === options.polls) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: every poll failed to read #${pr}: ${lastReason} — the outcome is UNKNOWN, not "unresolved".`,
			);
		}
		const now = yield* Clock.currentTimeMillis;
		return emit(
			json,
			dwellOutcome({everQueued, queueGoverned, armedAt, now}),
			options.polls,
			horizon,
		);
	});

const emit = (json: boolean, outcome: Reconciled, polls: number, horizon: number): VerbOutcome =>
	json
		? answer(JSON.stringify({outcome, polls, horizonSeconds: horizon}))
		: answer(`reconcile\t${outcome}\t${polls}\t${horizon}`);
