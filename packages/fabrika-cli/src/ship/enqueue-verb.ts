/**
 * `ship enqueue` — arm the queue's auto-merge at a pinned head, and prove the arm landed.
 *
 * **There is no merge-method flag to pass, by construction.** The queue owns the method, and v1's
 * documented hazard is that a `--squash` alongside `--auto` conflicts with the queue and silently
 * no-ops the enqueue at exit 0. A surface that does not exist cannot be misused.
 *
 * The live head is re-resolved first and drift refuses on `12`: the enqueue is the one action every
 * gate's `--sha` was protecting, so arming at a moved head ships a tree nobody verified.
 *
 * After the arm, `auto_merge: null` is **expected** — the queue consumes the intent — and is never
 * read as a jam. The jam discriminator is the arm's own error response, quoted verbatim on `8`.
 *
 * **Mergeability is asserted BEFORE the arm, and an indefinite read refuses.** Probed live on this
 * repo: GitHub *accepts* the arm on a conflicted PR under a queue-governed base and parks the intent
 * on it — no platform-side refusal — so nothing but this precondition stands between a `dirty` PR
 * and a parked intent reported as a healthy `enqueued`. `mergeable` is computed lazily, so `null` is
 * routine and is **not an answer**: it is polled, and a still-indefinite value is UNKNOWN and
 * refuses. A read that could not produce a definite answer must never resolve to one.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, STALE_HEAD, WRITE_UNKNOWN} from "./codes.ts";
import {armAutoMerge, isIndefinite, pullTimeline, readMergeability} from "./github.ts";
import {queueStateOf} from "./queue.ts";
import {badNumber, inspectedSha, prefixMatch, resolvePull, resolveTargetRepo} from "./target.ts";

const VERB = "ship enqueue";

/** How many extra reads the indefinite value gets before it is called UNKNOWN. */
const MERGEABILITY_POLLS = 3;

/** How long to wait between those reads, giving GitHub's background computation time to land. */
const MERGEABILITY_CADENCE_SECONDS = 2;

export interface EnqueueOptions {
	readonly pr: number;
	readonly sha: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runEnqueue = (
	options: EnqueueOptions,
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

		const target = yield* resolvePull(VERB, repo, pr, {
			closedReason: "nothing to enqueue.",
			mergedReason: "nothing to enqueue.",
			unknownMessage: (reason) =>
				`${VERB}: cannot read #${pr}'s live head: ${reason} — nothing was armed.`,
		});
		if (target._tag === "Refused") return target.outcome;
		const live = target.pull.headSha;
		if (!prefixMatch(live, bound)) {
			return refuse(
				STALE_HEAD,
				`${VERB}: the live head is ${live}, gates ran at ${bound} — refusing to arm a tree nobody verified.`,
			);
		}

		const diagnostics: string[] = [];
		let mergeability = yield* readMergeability(repo, pr);
		for (let poll = 1; poll <= MERGEABILITY_POLLS; poll++) {
			if (mergeability._tag === "Failure" || !isIndefinite(mergeability.value)) break;
			yield* Effect.sleep(`${MERGEABILITY_CADENCE_SECONDS} seconds`);
			mergeability = yield* readMergeability(repo, pr);
		}
		if (mergeability._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${pr}'s mergeability: ${mergeability.reason} — nothing was armed.`,
			);
		}
		if (isIndefinite(mergeability.value)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: #${pr}'s mergeable_state is still indefinite after ${MERGEABILITY_POLLS} polls — mergeability is UNKNOWN, never green; nothing was armed.`,
			);
		}
		diagnostics.push(
			`${VERB}: mergeable_state is ${mergeability.value.state} (mergeable: ${String(mergeability.value.mergeable)}) — a definite read; arming.`,
		);

		const armed = yield* armAutoMerge(repo, pr);
		if (armed._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the arm failed: "${armed.reason}" — whether an intent is parked is UNKNOWN; disarm before stopping.`,
				diagnostics,
			);
		}

		const events = yield* pullTimeline(repo, pr);
		if (events._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the arm was sent and the confirming read-back failed: ${events.reason} — whether an intent is parked is UNKNOWN; disarm before stopping.`,
				diagnostics,
			);
		}
		// `settling` is the normal race, not a failure: the arm landed and the entry has not surfaced.
		// Everything after this line is `ship reconcile`'s. An unexhausted read-back cannot PROVE the
		// entry, so it degrades to `settling` rather than refusing — the arm already landed, and
		// `ship reconcile` owns the classification from here.
		const proven = events.value.exhausted && queueStateOf(events.value.events) === "queued";
		if (!events.value.exhausted) {
			diagnostics.push(
				`${VERB}: the confirming timeline read never reached a terminal page — the entry is unproven, so this answers settling.`,
			);
		}
		const entry = proven ? "queued" : "settling";
		return json
			? answer(JSON.stringify({outcome: "enqueued", sha: bound, entry}), diagnostics)
			: answer(`enqueued\t${bound}\t${entry}`, diagnostics);
	});
