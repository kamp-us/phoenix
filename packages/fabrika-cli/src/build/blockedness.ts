/**
 * Blockedness, read off GitHub's native `blocked_by` graph and nowhere else.
 *
 * ADR 0301 makes the graph the one carrier of "do not start this yet", for a standalone issue
 * exactly as for an epic child, and #5387 ruled the same for the epic ledger's prose
 * `## Dependencies` block: that block is at most a rendering of the graph, never an input anything
 * parses to decide behaviour. This module is the one reader over that one source, so `build
 * eligible` today and the claim-seam gate of #6249 answer the same question the same way.
 *
 * **A `blocked_by` entry is not a block on its own.** The endpoint lists every blocker whatever its
 * state, so the derivation — "any blocker issue still open" — lives here, in the reader, as
 * [`../io/edges.ts`](../io/edges.ts) already says it must.
 *
 * **The read fails closed on every axis** (ADR 0092). The edge list is `Unknown` when it 404s just
 * as when the transport failed: the caller proves the issue exists before asking, so a 404 here is
 * an unexplained answer, not "no edges". A blocker whose own state could not be read is its own
 * unread row rather than a closed one — it never shortens the blocking set, and it never seats a
 * pass on its own.
 */
import {Effect} from "effect";
import {blockedBy} from "../io/edges.ts";
import type {Shell} from "../io/git.ts";
import {getIssue} from "../io/issues.ts";

/** A blocker whose state could not be read — never counted closed, never counted open. */
export interface UnreadBlocker {
	readonly number: number;
	readonly reason: string;
}

export type Blockedness =
	| {
			readonly _tag: "Read";
			/** How many edges the graph named — the scope any "all closed" claim is made over. */
			readonly scanned: number;
			/** Every blocker proven still open, in the order the graph listed them. */
			readonly open: ReadonlyArray<number>;
			readonly unread: ReadonlyArray<UnreadBlocker>;
	  }
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * Every open `blocked_by` edge on `issue`.
 *
 * A blocker that is proven **absent** counts open: an edge pointing at an issue this token cannot
 * see is not an edge anything discharged, and the fail-open reading is the one this module exists
 * to remove. Every blocker is read before the answer is returned, so the result does not depend on
 * the order the graph happens to list them in.
 */
export const readBlockedness = (repo: string, issue: number): Shell<Blockedness> =>
	Effect.gen(function* () {
		const edges = yield* blockedBy(repo, issue);
		if (edges._tag === "Unknown") return {_tag: "Unknown" as const, reason: edges.reason};
		if (edges._tag === "Absent") {
			return {
				_tag: "Unknown" as const,
				reason: `the blocked_by list for #${issue} answered 404 for an issue already proven open`,
			};
		}
		const open: number[] = [];
		const unread: UnreadBlocker[] = [];
		for (const blocker of edges.value) {
			const state = yield* getIssue(repo, blocker);
			if (state._tag === "Unknown") {
				unread.push({number: blocker, reason: state.reason});
				continue;
			}
			if (state._tag === "Absent" || state.value.state === "open") open.push(blocker);
		}
		return {_tag: "Read" as const, scanned: edges.value.length, open, unread};
	});

/**
 * The gate's answer for the seams that only need "may this start" — `build claim` and `build pick`.
 *
 * ADR 0301 keeps this **out** of the admission test: that module is pure and total over facts
 * already on an issue, while blockedness needs a paged network read and its remedy is waiting rather
 * than an edit. So it composes after the pure axes, and the three-way seating is derived here alone
 * so the two seams cannot come to disagree about what an unread blocker means.
 */
export type BlockedGate =
	| {readonly _tag: "Clear"; readonly scanned: number}
	| {readonly _tag: "Blocked"; readonly scanned: number; readonly open: ReadonlyArray<number>}
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * Seat one blockedness read.
 *
 * A *proven* open edge is proof of blockedness whatever else could not be read, so an unread blocker
 * beside one downgrades nothing. With nothing proven open, an unread blocker is UNKNOWN: the
 * blocking set is complete only when every blocker's state is known, and "could not tell" never
 * resolves to "not blocked".
 */
export const gateOf = (blockedness: Blockedness): BlockedGate => {
	if (blockedness._tag === "Unknown") return {_tag: "Unknown", reason: blockedness.reason};
	const {scanned, open, unread} = blockedness;
	if (open.length > 0) return {_tag: "Blocked", scanned, open};
	return unread.length === 0
		? {_tag: "Clear", scanned}
		: {
				_tag: "Unknown",
				reason: unread.map((row) => `blocker #${row.number}: ${row.reason}`).join("; "),
			};
};

/** Read the graph and seat it — the whole gate, for a seam that carries no discharge evidence. */
export const readBlockedGate = (repo: string, issue: number): Shell<BlockedGate> =>
	Effect.map(readBlockedness(repo, issue), gateOf);
