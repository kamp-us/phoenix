/**
 * The two preconditions the `ui` group shares: where the repo root is, and whether this lane is mine.
 *
 * **Lane mechanics are the `build` group's, reused — never respecified.** The parse, the claim
 * re-read and the nonce agreement all live in `../build/lane-guard.ts`; this module only re-seats
 * that guard's refusals onto the `ui` matrix, where every proven lane failure — foreign claim, no
 * claim, a branch that does not parse — is one code (`18`) and an unreadable claim state stays `11`.
 * Collapsing the three proven shapes onto one code is the contract's call: the caller's next act is
 * identical for all three, and the distinguishing detail rides on stderr.
 *
 * `ui manifest`, `ui law` and `ui golden` are pure reads and take no lane precondition — they call
 * {@link resolveRoot} and nothing here.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {laneNumber, nonceOf, parseLaneBranch} from "../build/lane.ts";
import {requireLane} from "../build/lane-guard.ts";
import {readTree} from "../build/worktree.ts";
import {currentBranch} from "../io/issues.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {LANE_NOT_MINE, PRECONDITION_UNKNOWN} from "./codes.ts";

export type Root =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Root"; readonly root: string};

/** The repo root every convention path resolves against — never the cwd, never a web URL. */
export const resolveRoot = (
	verb: string,
): Effect.Effect<Root, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const tree = yield* readTree;
		return tree._tag === "Failure"
			? {
					_tag: "Refused" as const,
					outcome: refuse(
						PRECONDITION_UNKNOWN,
						`${verb}: cannot resolve the repo root: ${tree.reason} — every convention path is UNKNOWN.`,
					),
				}
			: {_tag: "Root" as const, root: tree.value.root};
	});

export type UiLane =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {
			readonly _tag: "Lane";
			readonly root: string;
			readonly branch: string;
			/** The number the branch is claimed under — the issue in create mode, the PR in resume mode. */
			readonly number: number;
			/** The claim nonce, which is what makes the scratch namespace per-lane. */
			readonly nonce: string;
			readonly notes: ReadonlyArray<string>;
	  };

/**
 * Prove the checked-out branch names a lane this session holds.
 *
 * `refusal` builds the `18` line, because the two lane-guarding verbs word it differently: `ui
 * render` names the branch, `ui evidence` names the number it is about to write to. It is handed the
 * lane number when the branch parses as one and `null` when it does not — the case where there is no
 * number to name is exactly the case the message must not invent one for.
 */
export const requireUiLane = (
	verb: string,
	repo: string,
	session: string,
	refusal: (detail: string, number: number | null) => string,
): Effect.Effect<UiLane, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const lane = yield* requireLane(verb, repo, session, null);
		if (lane._tag === "Refused") {
			const {outcome} = lane;
			if (outcome.code === PRECONDITION_UNKNOWN) return {_tag: "Refused" as const, outcome};
			const detail = outcome.stderr.at(-1) ?? "no detail";
			const branch = yield* currentBranch;
			const parsed = branch === null ? null : parseLaneBranch(branch);
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					LANE_NOT_MINE,
					refusal(detail, parsed === null ? null : laneNumber(parsed)),
					outcome.stderr.slice(0, -1),
				),
			};
		}
		const nonce = nonceOf(lane.marker.token);
		if (nonce === null) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: the claim carries the token ${lane.marker.token}, which yields no lane nonce — the lane is UNKNOWN.`,
					lane.notes,
				),
			};
		}
		return {
			_tag: "Lane" as const,
			root: lane.root,
			branch: lane.branch,
			number: laneNumber(lane.lane),
			nonce,
			notes: lane.notes,
		};
	});
