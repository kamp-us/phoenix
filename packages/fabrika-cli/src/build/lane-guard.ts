/**
 * "This tree, on this branch, is my lane" — the precondition `tree --issue`, `check`, `push` and `pr`
 * share, guarded identically so a sibling verb cannot take the same ground on weaker evidence.
 *
 * Three facts in one order, and each is proven before the next is asked: a branch whose **name**
 * parses as a lane (`14`), a claim on that lane's number this session holds (`15` / `11`), and a nonce
 * in the branch that matches the token that claim carries (`14`).
 *
 * The last step is the one that makes the others worth having. A branch that merely *looks* like a
 * lane proves nothing; the branch name and the live claim have to agree on the same UUID, which is
 * what a second run of the same session on a different issue cannot fake.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {currentBranch} from "../io/issues.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {type ClaimMarker, requireClaim} from "./claim.ts";
import {WRONG_LANE} from "./codes.ts";
import {type LaneBranch, laneNumber, nonceOf, parseLaneBranch} from "./lane.ts";
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

		const held = yield* requireClaim(verb, repo, number, session);
		if (held._tag === "Refused") return held;
		if (nonceOf(held.marker.token) !== lane.nonce) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					WRONG_LANE,
					`${verb}: the checked-out branch "${branch}" does not carry claim ${held.marker.token}'s nonce — wrong lane.`,
					held.notes,
				),
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
