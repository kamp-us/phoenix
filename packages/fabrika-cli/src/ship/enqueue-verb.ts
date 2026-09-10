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
 * **Mergeability is asserted BEFORE the arm, and both an indefinite and a definitely-false read
 * refuse.** Probed live on this repo: GitHub *accepts* the arm on a conflicted PR under a
 * queue-governed base and parks the intent on it — no platform-side refusal — so nothing but this
 * precondition stands between a `dirty` PR and a parked intent reported as a healthy `enqueued`.
 * `mergeable` is computed lazily, so `null` is routine and is **not an answer**: it is polled, and a
 * still-indefinite value is UNKNOWN and refuses on `11`. A read that could not produce a definite
 * answer must never resolve to one. A definite `mergeable: false` refuses on `16` instead of arming:
 * the conflict is already proven by the read the verb just performed, and arming on it spends an
 * enqueue round plus one of the lane's retries to rediscover it at reconcile.
 *
 * **That refusal splits by cause, and a definite `dirty` is handled here rather than routed.** A
 * conflict with the base is not a verdict on the head, so the verb rebases, publishes and re-reads
 * inside its own horizon (`./rebase.ts`), and the lane never sees a failure. Only a rebase that
 * cannot apply — whose resolution would change content — still refuses on `16`, and every other
 * definite not-mergeable state refuses exactly as it did before.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {remoteFor} from "../io/git.ts";
import type {PullRecord} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, PROVEN_NOT_IN_STATE, STALE_HEAD, WRITE_UNKNOWN} from "./codes.ts";
import {armAutoMerge, pullTimeline, readHeadBranch} from "./github.ts";
import {readDefiniteMergeability} from "./mergeability.ts";
import {queueStateOf} from "./queue.ts";
import {baseLabelOf, type RebaseTarget, rebaseOntoBase} from "./rebase.ts";
import {badNumber, inspectedSha, prefixMatch, resolvePull, resolveTargetRepo} from "./target.ts";

const VERB = "ship enqueue";

/** The one definite not-mergeable state that is a fact about the base rather than about the head. */
const DIRTY = "dirty";

/** Either the head the arm may bind to, or the refusal that ends the run. */
type Settled =
	| {readonly _tag: "Mergeable"; readonly sha: string}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

const refusedWith = (code: number, message: string, notes: ReadonlyArray<string>): Settled => ({
	_tag: "Refused",
	outcome: refuse(code, message, notes),
});

/** The unmergeable read a caller can act on without a rebase — today's refusal, unchanged. */
const notMergeable = (pr: number, state: string, notes: ReadonlyArray<string>): Settled =>
	refusedWith(
		PROVEN_NOT_IN_STATE,
		`${VERB}: #${pr} is not mergeable (mergeable_state: ${state}) — a definite read; nothing was armed.`,
		notes,
	);

/**
 * Resolve the branch to replay, refusing the two shapes a rebase from here cannot serve.
 *
 * A head on a fork is not this repository's to push, and a clone that serves no remote for the
 * target repository has nowhere to publish; both are the caller's `16` rather than an attempt whose
 * failure would have to be read out of git's own message.
 */
const rebaseTargetFor = (
	repo: string,
	pr: number,
	pull: PullRecord,
): Effect.Effect<
	| {readonly _tag: "Target"; readonly target: RebaseTarget}
	| {readonly _tag: "None"; reason: string},
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const branch = yield* readHeadBranch(repo, pr);
		if (branch._tag === "Failure") {
			return {_tag: "None", reason: `its head branch could not be read: ${branch.reason}`};
		}
		if (branch.value.repo.toLowerCase() !== repo.toLowerCase()) {
			return {_tag: "None", reason: `its head lives on ${branch.value.repo}, not on ${repo}`};
		}
		const remote = yield* remoteFor(repo);
		if (remote === null) {
			return {_tag: "None", reason: `this checkout has no remote serving ${repo}`};
		}
		return {
			_tag: "Target",
			target: {remote, ref: branch.value.ref, headSha: pull.headSha, baseRef: pull.baseRef},
		};
	});

/**
 * Rebase a conflicting head onto its base, publish it, and re-read what the platform then says.
 *
 * The whole round stays inside this verb: on a clean replay the caller arms the rebased head against
 * the verdicts already on the PR, so no `ROUTED-REPAIR` is reported and the lane spends no retry.
 * The rule that licenses that is the content binding — a verdict binds to what the head *contains*,
 * not to its SHA (`../review/head-content.ts`) — and a clean rebase changes
 * no content, which is exactly why a conflicting one is refused here instead.
 */
const rebaseAndReread = (
	repo: string,
	pr: number,
	pull: PullRecord,
	notes: Array<string>,
): Effect.Effect<Settled, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		// The rebase path is reachable only from this pre-arm read, and only while nothing is armed:
		// a branch the queue already holds is one no verb of this group may rewrite underneath it.
		if (pull.autoMerge) {
			return refusedWith(
				PROVEN_NOT_IN_STATE,
				`${VERB}: #${pr} is not mergeable (mergeable_state: ${DIRTY}) and a merge intent is already parked on it — refusing to rewrite a branch the queue holds; nothing was armed.`,
				notes,
			);
		}
		const resolved = yield* rebaseTargetFor(repo, pr, pull);
		if (resolved._tag === "None") {
			return refusedWith(
				PROVEN_NOT_IN_STATE,
				`${VERB}: #${pr} conflicts with its base and no rebase was attempted — ${resolved.reason}; nothing was armed.`,
				notes,
			);
		}
		const base = baseLabelOf(resolved.target);
		notes.push(
			`${VERB}: #${pr} conflicts with ${base} (mergeable_state: ${DIRTY}) — a fact about the base, not a verdict on the head; rebasing inside this verb rather than routing to repair.`,
		);
		const rebased = yield* rebaseOntoBase(pr, resolved.target);
		if (rebased._tag === "Conflicted") {
			return refusedWith(
				PROVEN_NOT_IN_STATE,
				`${VERB}: #${pr} cannot replay onto ${base}: ${rebased.reason} — resolving those hunks changes content, so it is a new head and routes to repair; nothing was armed.`,
				notes,
			);
		}
		if (rebased._tag === "Unattempted") {
			return refusedWith(
				PROVEN_NOT_IN_STATE,
				`${VERB}: #${pr} conflicts with ${base} and the rebase did not run — ${rebased.reason}; nothing was published and nothing was armed.`,
				notes,
			);
		}
		if (rebased._tag === "Unknown") {
			return refusedWith(
				PRECONDITION_UNKNOWN,
				`${VERB}: #${pr}'s rebase onto ${base} was pushed and its outcome is UNKNOWN — ${rebased.reason}; nothing was armed, and the PR's head must be re-read before anything else.`,
				notes,
			);
		}
		notes.push(
			`${VERB}: rebased #${pr} onto ${base} and republished its head at ${rebased.head} — a verdict binds to the head's content, not to its SHA (../review/head-content.ts), so a clean rebase owes no new review round and the arm rides the verdicts already on the PR.`,
		);
		const reread = yield* readDefiniteMergeability(repo, pr);
		if (reread._tag === "Unreadable") {
			return refusedWith(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${pr}'s mergeability after the rebase: ${reread.reason} — nothing was armed.`,
				notes,
			);
		}
		if (reread._tag === "Indefinite") {
			return refusedWith(
				PRECONDITION_UNKNOWN,
				`${VERB}: #${pr}'s mergeable_state is still indefinite after the rebase and ${reread.polls} polls — mergeability is UNKNOWN, never green; nothing was armed.`,
				notes,
			);
		}
		return reread.value.mergeable
			? {_tag: "Mergeable", sha: rebased.head}
			: refusedWith(
					PROVEN_NOT_IN_STATE,
					`${VERB}: #${pr} is still not mergeable (mergeable_state: ${reread.value.state}) after rebasing onto ${base} — nothing was armed.`,
					notes,
				);
	});

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
		const mergeability = yield* readDefiniteMergeability(repo, pr);
		if (mergeability._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${pr}'s mergeability: ${mergeability.reason} — nothing was armed.`,
			);
		}
		if (mergeability._tag === "Indefinite") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: #${pr}'s mergeable_state is still indefinite after ${mergeability.polls} polls — mergeability is UNKNOWN, never green; nothing was armed.`,
			);
		}
		let armAt = bound;
		if (!mergeability.value.mergeable) {
			const settled =
				mergeability.value.state === DIRTY
					? yield* rebaseAndReread(repo, pr, target.pull, diagnostics)
					: notMergeable(pr, mergeability.value.state, diagnostics);
			if (settled._tag === "Refused") return settled.outcome;
			armAt = settled.sha;
		} else {
			diagnostics.push(
				`${VERB}: mergeable_state is ${mergeability.value.state} (mergeable: true) — a definite read; arming.`,
			);
		}

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
		const rebased = armAt !== bound;
		return json
			? answer(JSON.stringify({outcome: "enqueued", sha: armAt, entry, rebased}), diagnostics)
			: answer(`enqueued\t${armAt}\t${entry}`, diagnostics);
	});
