/**
 * `triage apply --blocked-by` — turn a stated ordering into native `blocked_by` edges.
 *
 * ADR 0301 makes the graph the one carrier of "do not start this yet", and until now no triage verb
 * could reach it: `map ticket` was the only caller of `addBlockedBy`, and only for a wayfinding
 * map's own tickets, so a triager filing an ordered slice set wrote the ordering as prose (#6728).
 * The founder ruling at
 * https://github.com/kamp-us/phoenix/issues/6728#issuecomment-5465597763 seats the write here.
 *
 * Three shapes carry the weight. **Every target is resolved before any edge is written**, so a typo'd
 * number refuses over a graph nobody touched rather than half-way through one. **The edges already
 * live are read first and skipped**, which is what makes the flag idempotent for a resumed lane
 * without resting on an unverified claim about how the API answers a duplicate POST. And **a target
 * that is a pull request is refused on its own seat**, because `repos/{o}/{r}/issues/<n>` serves PRs
 * — so one resolves `Present` and the proven-absent arm never fires for it (see `edgeTarget`).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {addBlockedBy, blockedBy, edgeTarget} from "../io/edges.ts";
import {type Existence, present, unknown} from "../io/issues.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {
	PRECONDITION_UNKNOWN,
	PULL_REQUEST_TARGET,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";

/** What ADR 0301 says to do with a pull request that blocks something — quoted on both refusals. */
const PR_RULE =
	"ADR 0301: a blocking pull request is named in the graph by the issue its merge closes";

/** What the write phase will do, decided entirely from reads. */
export interface EdgePlan {
	/** Every `--blocked-by` value, deduplicated, in the order given. */
	readonly requested: ReadonlyArray<number>;
	/** The requested edges the graph does not carry yet, with the internal id each POST takes. */
	readonly toWrite: ReadonlyArray<{readonly number: number; readonly id: number}>;
}

export type EdgeStep<A> =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {
			readonly _tag: "Resolved";
			readonly value: A;
	  };

const refused = (outcome: VerbOutcome): EdgeStep<never> => ({_tag: "Refused", outcome});
const resolved = <A>(value: A): EdgeStep<A> => ({_tag: "Resolved", value});

/**
 * Resolve every `--blocked-by` target and decide which edges are missing — reads only.
 *
 * A target that is its own issue is refused here rather than left to the API: a self-edge makes the
 * issue permanently unbuildable, and `build eligible` would report it as a real blocker.
 */
export const planEdges = (
	verb: string,
	repo: string,
	issue: number,
	values: ReadonlyArray<number>,
): Effect.Effect<EdgeStep<EdgePlan>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const requested = [...new Set(values)];
		if (requested.length === 0) return resolved({requested, toWrite: []});
		if (requested.includes(issue)) {
			return refused(refuse(ZERO_SCOPE, `${verb}: --blocked-by ${issue} names the issue itself.`));
		}

		const live = yield* blockedBy(repo, issue);
		if (live._tag === "Absent") {
			return refused(refuse(ZERO_SCOPE, `${verb}: issue #${issue} not found in ${repo}.`));
		}
		if (live._tag === "Unknown") {
			return refused(
				refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read #${issue}'s blocked_by edges in ${repo}: ${live.reason} — no edge was written.`,
				),
			);
		}

		const toWrite: {number: number; id: number}[] = [];
		for (const number of requested) {
			if (live.value.includes(number)) continue;
			const target = yield* edgeTarget(repo, number);
			if (target._tag === "Absent") {
				return refused(
					refuse(
						ZERO_SCOPE,
						`${verb}: --blocked-by ${number} names no issue in ${repo} — no edge was written.`,
					),
				);
			}
			if (target._tag === "Unknown") {
				return refused(
					refuse(
						PRECONDITION_UNKNOWN,
						`${verb}: cannot resolve #${number}'s internal id in ${repo}: ${target.reason} — no edge was written.`,
					),
				);
			}
			if (target.value.pullRequest) {
				return refused(
					refuse(
						PULL_REQUEST_TARGET,
						`${verb}: --blocked-by ${number} names a pull request, not an issue — ${PR_RULE}, so pass that issue's number instead. No edge was written.`,
					),
				);
			}
			toWrite.push({number, id: target.value.id});
		}
		return resolved({requested, toWrite});
	});

/**
 * Write the planned edges, then re-read the whole set and prove every requested number is in it.
 *
 * The read-back is over `blockedBy`, never over the POST responses: a write this verb believes
 * landed and a graph that carries the edge are different facts, and only the second one gates a
 * build lane.
 */
export const landEdges = (
	verb: string,
	repo: string,
	issue: number,
	plan: EdgePlan,
): Effect.Effect<EdgeStep<ReadonlyArray<number>>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (plan.requested.length === 0) return resolved([]);

		for (const {number, id} of plan.toWrite) {
			const written = yield* addBlockedBy(repo, issue, id);
			if (written._tag === "Failure") {
				return refused(
					refuse(
						WRITE_UNKNOWN,
						`${verb}: the --blocked-by ${number} edge did NOT land: ${written.reason} — #${issue}'s topology is UNKNOWN; re-run this verb, which skips the edges already live.`,
					),
				);
			}
		}

		const back = yield* blockedBy(repo, issue);
		if (back._tag !== "Present") {
			return refused(
				refuse(
					READBACK_MISMATCH,
					`${verb}: the --blocked-by edges were written and could not be read back (${
						back._tag === "Absent" ? "the issue is now absent" : back.reason
					}) — inspect #${issue}'s dependencies before continuing.`,
				),
			);
		}
		const missing = plan.requested.filter((number) => !back.value.includes(number));
		if (missing.length > 0) {
			return refused(
				refuse(
					READBACK_MISMATCH,
					`${verb}: read-back shows #${issue} blocked_by ${
						back.value.length === 0 ? "nothing" : back.value.map((n) => `#${n}`).join(", ")
					} — the requested edge(s) ${missing.map((n) => `#${n}`).join(", ")} are not in it.`,
				),
			);
		}
		return resolved(back.value);
	});

/**
 * Which of the numbers a body's stated ordering names are pull requests — the ones the gate must not
 * red on.
 *
 * ADR 0301 names a blocking PR by the issue its merge closes, so a body writing "blocked on #7271"
 * about a PR states no edge that could exist, and the `--blocked-by` escape cannot clear it: over the
 * 150 most recently created issues, 5 of the 6 bodies the gate refused named a PR (#6728 round 1).
 * A target proven absent is **not** dropped — an ordering naming an issue nobody can find is still a
 * red — and a read that failed refuses, because a gate that passed on an unread target would be
 * fail-open.
 */
export const pullRequestReferences = (
	repo: string,
	numbers: ReadonlyArray<number>,
): Effect.Effect<
	Existence<ReadonlyArray<number>>,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const pulls: number[] = [];
		for (const number of numbers) {
			const target = yield* edgeTarget(repo, number);
			if (target._tag === "Unknown") {
				return unknown<ReadonlyArray<number>>(`#${number} could not be read: ${target.reason}`);
			}
			if (target._tag === "Present" && target.value.pullRequest) pulls.push(number);
		}
		return present<ReadonlyArray<number>>(pulls);
	});

/** The diagnostic line the verb prints for the edges it landed. */
export const edgeLine = (verb: string, issue: number, live: ReadonlyArray<number>): string =>
	`${verb}: read back #${issue} blocked_by ${live.map((n) => `#${n}`).join(", ")}.`;
