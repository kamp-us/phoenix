/**
 * "This tree, on this branch, is my lane" — the precondition `tree --issue`, `check`, `push` and `pr`
 * share, guarded identically so a sibling verb cannot take the same ground on weaker evidence.
 *
 * Two facts in one order, each proven before the next is asked: a branch whose **name** parses as a
 * lane (`14`), and a claim on that lane's number held by *the lane the branch names* (`15` / `11`).
 *
 * The second is the one that makes the first worth having. A branch that merely *looks* like a lane
 * proves nothing; the branch's nonce is passed in as the asking lane's identity, so the branch name and
 * the live claim have to agree on the same UUID — which is what a second lane of the same session
 * cannot fake. When the winner is another lane of this same session the refusal is re-mapped to `14`:
 * inside one session that is a wrong tree to be standing in, not a wrong session (#6037).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {currentBranch} from "../io/issues.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {type ClaimMarker, laneCaller, requireClaim} from "./claim.ts";
import {WRONG_LANE} from "./codes.ts";
import {type LaneBranch, laneNumber, parseLaneBranch} from "./lane.ts";
import {assertGround} from "./tree.ts";

export type Lane =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {
			readonly _tag: "Lane";
			readonly root: string;
			readonly branch: string;
			readonly lane: LaneBranch;
			readonly marker: ClaimMarker;
			readonly notes: ReadonlyArray<string>;
	  };

export const requireLane = (
	verb: string,
	repo: string,
	session: string,
	/** The number the caller expects the lane to serve, when it has one; `null` reads it off the branch. */
	expected: number | null,
): Effect.Effect<Lane, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const ground = yield* assertGround(verb, false);
		if (ground._tag === "Refused") return ground;

		const branch = yield* currentBranch;
		if (branch === null) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					WRONG_LANE,
					`${verb}: HEAD is detached — there is no lane branch to prove.`,
				),
			};
		}
		const lane = parseLaneBranch(branch);
		if (lane === null) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					WRONG_LANE,
					`${verb}: the checked-out branch "${branch}" is not a lane branch — wrong lane.`,
				),
			};
		}
		const number = laneNumber(lane);
		if (expected !== null && number !== expected) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					WRONG_LANE,
					`${verb}: the checked-out branch "${branch}" serves #${number}, not #${expected} — wrong lane.`,
				),
			};
		}

		const held = yield* requireClaim(verb, repo, number, laneCaller(session, lane.nonce));
		if (held._tag === "Refused") {
			return {
				_tag: "Refused" as const,
				outcome:
					held.ownership._tag === "Foreign" && held.ownership.sameSession
						? refuse(
								WRONG_LANE,
								`${verb}: the checked-out branch "${branch}" does not carry claim ${held.ownership.marker.token}'s nonce — wrong lane.`,
								held.notes,
							)
						: held.outcome,
			};
		}
		return {
			_tag: "Lane" as const,
			root: ground.root,
			branch,
			lane,
			marker: held.marker,
			notes: held.notes,
		};
	});
