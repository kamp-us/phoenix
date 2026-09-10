/**
 * Releasing the build claim a dead shell stranded — the half of a shell death nothing used to do.
 *
 * A shell killed by its provider leaves its claim marker standing on the issue, and every later
 * reader treats that marker as a live lane: the number cannot be re-picked, `recipe unpark` holds
 * the `spawn-dead` park open, and a person has to run `build adopt` and `build release` by hand for
 * a failure nobody chose. This module is the proof that lets a verb retract it instead.
 *
 * **The proof is the claim's own age, because there is no heartbeat to read.** The claim protocol
 * bans an age test everywhere else; this module is the one caller it is narrowed to, reached only
 * from the `spawn-dead` unpark row. A claim older than
 * the budget for the kind of work it took (`../lane/shell-budget.ts`) is a claim whose shell is
 * dead by the only definition available. Everything short of that proof leaves the claim standing:
 * an unreadable board, an unreadable timestamp, and a claim still inside its budget all answer with
 * their own arm, and none of them retracts anything.
 *
 * The retraction is read back rather than assumed. Deleting the marker comment is a write like any
 * other, and a delete that reported success while the marker survived would hand the caller a
 * "released" the board disagrees with — which is exactly the false green the whole protocol exists
 * to refuse. `StillHeld` is that disagreement, and it is not folded into `Unknown`: the write
 * happened, and what is wrong is the board's answer to it.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {deleteComment} from "../io/issues.ts";
import {type Liveness, livenessOf} from "../lane/shell-budget.ts";
import {readClaimants} from "./claim.ts";

/** What the board says after a reclamation was attempted against one issue's build claim. */
export type Reclaim =
	| {
			readonly _tag: "Released";
			readonly token: string;
			readonly ageMinutes: number;
			readonly budgetMinutes: number;
			/** How many marker comments carrying that token were retracted. */
			readonly retracted: number;
			/** How many build claim markers stood on the issue before the retraction. */
			readonly scanned: number;
	  }
	| {
			readonly _tag: "Alive";
			readonly token: string;
			readonly ageMinutes: number;
			readonly budgetMinutes: number;
			readonly scanned: number;
	  }
	| {readonly _tag: "Unclaimed"; readonly scanned: number}
	| {readonly _tag: "Unknown"; readonly reason: string}
	/** The delete ran and a claim still stands — a write whose read-back disagrees with it. */
	| {readonly _tag: "StillHeld"; readonly token: string; readonly reason: string};

/**
 * Retract the build claim on `issue` when its age proves the shell that took it is dead.
 *
 * Every marker carrying the dead lane's token is deleted, not merely the winning one: a lane that
 * raced writes more than one, and peeling a single marker off the stack leaves the next-oldest to be
 * read as a live claim — the same stack `build release` sweeps whole for the same reason.
 */
export const reclaimDeadClaim = (
	repo: string,
	issue: number,
	nowEpochMs: number,
	budgetMinutes: number,
): Effect.Effect<Reclaim, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const claimants = yield* readClaimants(repo, issue);
		if (claimants._tag === "Unknown") return {_tag: "Unknown" as const, reason: claimants.reason};
		const scanned = claimants.claimants.length;
		const holder = claimants.holder;
		if (holder === null) return {_tag: "Unclaimed" as const, scanned};

		const liveness: Liveness = livenessOf(holder.createdAt, nowEpochMs, budgetMinutes);
		if (liveness._tag === "Unreadable") {
			return {
				_tag: "Unknown" as const,
				reason: `${holder.token} claims #${issue} and ${liveness.reason} — whether its shell is dead is UNKNOWN, never dead`,
			};
		}
		if (liveness._tag === "Live") {
			return {
				_tag: "Alive" as const,
				token: holder.token,
				ageMinutes: liveness.ageMinutes,
				budgetMinutes: liveness.budgetMinutes,
				scanned,
			};
		}

		const stack = claimants.claimants.filter((marker) => marker.token === holder.token);
		for (const marker of stack) {
			const deleted = yield* deleteComment(repo, marker.commentId);
			if (deleted._tag === "Failure") {
				return {
					_tag: "Unknown" as const,
					reason: `retracting ${holder.token}'s marker ${marker.commentId} on #${issue} failed: ${deleted.reason} — whether the claim still stands is UNKNOWN`,
				};
			}
		}

		const reread = yield* readClaimants(repo, issue);
		if (reread._tag === "Unknown") {
			return {
				_tag: "Unknown" as const,
				reason: `cannot re-read #${issue}'s claims after retracting ${holder.token}: ${reread.reason} — the release is UNKNOWN, never proven`,
			};
		}
		if (reread.holder !== null) {
			return {
				_tag: "StillHeld" as const,
				token: reread.holder.token,
				reason: `#${issue} still reads claimed by ${reread.holder.token} after ${String(stack.length)} marker(s) were retracted`,
			};
		}
		return {
			_tag: "Released" as const,
			token: holder.token,
			ageMinutes: liveness.ageMinutes,
			budgetMinutes: liveness.budgetMinutes,
			retracted: stack.length,
			scanned,
		};
	});
