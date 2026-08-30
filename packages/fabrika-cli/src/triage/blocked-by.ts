/**
 * `triage apply --blocked-by` — turn a stated ordering into native `blocked_by` edges.
 *
 * ADR 0301 makes the graph the one carrier of "do not start this yet", and until now no triage verb
 * could reach it: `map ticket` was the only caller of `addBlockedBy`, and only for a wayfinding
 * map's own tickets, so a triager filing an ordered slice set wrote the ordering as prose (#6728).
 * The founder ruling at
 * https://github.com/kamp-us/phoenix/issues/6728#issuecomment-5465597763 seats the write here.
 *
 * Two shapes carry the weight. **Every target is resolved before any edge is written**, so a typo'd
 * number refuses over a graph nobody touched rather than half-way through one. And **the edges
 * already live are read first and skipped**, which is what makes the flag idempotent for a resumed
 * lane without resting on an unverified claim about how the API answers a duplicate POST.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {addBlockedBy, blockedBy, internalId} from "../io/edges.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN, ZERO_SCOPE} from "./codes.ts";

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
			const id = yield* internalId(repo, number);
			if (id._tag === "Absent") {
				return refused(
					refuse(
						ZERO_SCOPE,
						`${verb}: --blocked-by ${number} names no issue in ${repo} — no edge was written.`,
					),
				);
			}
			if (id._tag === "Unknown") {
				return refused(
					refuse(
						PRECONDITION_UNKNOWN,
						`${verb}: cannot resolve #${number}'s internal id in ${repo}: ${id.reason} — no edge was written.`,
					),
				);
			}
			toWrite.push({number, id: id.value});
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

/** The diagnostic line the verb prints for the edges it landed. */
export const edgeLine = (verb: string, issue: number, live: ReadonlyArray<number>): string =>
	`${verb}: read back #${issue} blocked_by ${live.map((n) => `#${n}`).join(", ")}.`;
