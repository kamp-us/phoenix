/**
 * The pre-write mergeability read both landing verbs run, with its indefinite-value handling.
 *
 * `mergeable` is computed lazily by GitHub, so a `null` / `unknown` read is routine and is **not an
 * answer**: it is re-read, and a still-indefinite value is UNKNOWN and refuses. The three outcomes
 * are kept apart at the type layer because folding `Indefinite` into either neighbour is the whole
 * defect — read as `Definite` it becomes a green nobody computed, read as `Unreadable` it loses the
 * fact that the platform answered and simply had not finished.
 *
 * It lives here rather than in `ship enqueue`, which had it first, because `ship merge` asserts the
 * same precondition and a second copy of a poll loop is a second poll policy that can drift.
 *
 * The route is the single-PR `GET /repos/{repo}/pulls/{pr}`, and that is the route GitHub documents
 * for this: its git-database guide says to call that endpoint to *start* the background job and then
 * to poll that same endpoint until `mergeable` is true or false
 * ([Checking mergeability of pull requests](https://docs.github.com/en/rest/guides/getting-started-with-the-git-database-api?apiVersion=2022-11-28#checking-mergeability-of-pull-requests)).
 * The REST list route carries no `mergeable` field at all, so there is no list read to fall back to
 * — and a live probe of this repo found the GraphQL list read returning `UNKNOWN` for 11 of 12 open
 * pull requests on a first read and decided values for all 12 on a second, which is the same lazy
 * job this loop waits on rather than a privileged read path. What was wrong was the window, not the
 * route: three polls two seconds apart gave the job six seconds, and a conflicted PR that had not
 * settled inside it refused as UNKNOWN when one more read would have said `dirty`.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9032
 */
import {Effect} from "effect";
import type {Attempt, Shell} from "../io/git.ts";
import {isIndefinite, type Mergeability, readMergeability} from "./github.ts";

/** The whole wall-clock an indefinite value gets to settle before it is called UNKNOWN. */
export const MERGEABILITY_WINDOW_SECONDS = 60;

/** The first wait after an indefinite read. Each later wait doubles, to {@link MAX_WAIT_SECONDS}. */
const FIRST_WAIT_SECONDS = 2;

/** The longest single wait, so a widened window buys more re-reads rather than one long silence. */
const MAX_WAIT_SECONDS = 8;

/**
 * The waits between re-reads, derived from the window so the schedule needs no clock to bound it.
 *
 * Backoff rather than a fixed cadence: the job usually lands within a second or two, and the reads
 * that matter after that are the late ones. The last wait is trimmed to what the window has left, so
 * the waits sum to exactly the window and the refusal names a number it actually spent.
 */
export const pollWaits = (windowSeconds: number): ReadonlyArray<number> => {
	const waits: number[] = [];
	let wait = FIRST_WAIT_SECONDS;
	for (let spent = 0; spent < windowSeconds; ) {
		const next = Math.min(wait, windowSeconds - spent);
		waits.push(next);
		spent += next;
		wait = Math.min(wait * 2, MAX_WAIT_SECONDS);
	}
	return waits;
};

export type MergeabilityRead =
	| {readonly _tag: "Definite"; readonly value: Mergeability}
	| {readonly _tag: "Indefinite"; readonly polls: number; readonly seconds: number}
	| {readonly _tag: "Unreadable"; readonly reason: string};

const definiteOf = (
	attempt: Attempt<Mergeability>,
	polls: number,
	seconds: number,
): MergeabilityRead =>
	attempt._tag === "Failure"
		? {_tag: "Unreadable", reason: attempt.reason}
		: isIndefinite(attempt.value)
			? {_tag: "Indefinite", polls, seconds}
			: {_tag: "Definite", value: attempt.value};

export const readDefiniteMergeability = (
	repo: string,
	pr: number,
	windowSeconds: number = MERGEABILITY_WINDOW_SECONDS,
): Shell<MergeabilityRead> =>
	Effect.gen(function* () {
		const waits = pollWaits(windowSeconds);
		let attempt = yield* readMergeability(repo, pr);
		let spent = 0;
		for (const wait of waits) {
			if (attempt._tag === "Failure" || !isIndefinite(attempt.value)) break;
			yield* Effect.sleep(`${wait} seconds`);
			spent += wait;
			attempt = yield* readMergeability(repo, pr);
		}
		return definiteOf(attempt, waits.length, spent);
	});

/**
 * The one definite not-mergeable value that is a fact about the **base** rather than the head.
 *
 * `dirty` is GitHub's word for "the merge of this head into its base conflicts", so it is base
 * movement that reached a path the PR changed. Every other definite not-mergeable value —
 * `blocked`, `behind`, `draft` — says something about the head or its checks. Callers split on this
 * because the two route to different lane budgets, and reading a prose state string at each caller
 * is how the split drifts.
 */
export const isBaseConflict = (value: Mergeability): boolean =>
	!value.mergeable && value.state.trim().toLowerCase() === "dirty";
