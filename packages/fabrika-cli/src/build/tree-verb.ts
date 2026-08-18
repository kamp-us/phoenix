/**
 * `build tree` — the ground, proven from git state and one claim, and never repaired.
 *
 * Two assertions, each with its own code so a caller can act on which one failed: a clean tree at a
 * `--require-clean` open (`13`), and a checked-out branch carrying this claim's nonce (`14`). Both are
 * location-neutral — where the lane runs is the operator's call, not fabrika's (#5386). It reads and
 * never repairs: no clean, no create, no remove.
 *
 * The skill re-runs this before every git mutation because the shell's cwd resets between calls, so a
 * pass here is a fact about *this* invocation and nothing later.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {currentBranch} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {laneCaller, requireClaim, requireSession} from "./claim.ts";
import {WRONG_LANE} from "./codes.ts";
import {parseLaneBranch} from "./lane.ts";
import {resolveTargetRepo} from "./target.ts";
import {assertGround} from "./tree.ts";

const VERB = "build tree";

export interface TreeOptions {
	readonly requireClean: boolean;
	/** Additionally prove the checked-out branch carries this claim's nonce — the pre-mutation posture. */
	readonly issue: number | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runTree = (
	options: TreeOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const ground = yield* assertGround(VERB, options.requireClean);
		if (ground._tag === "Refused") return ground.outcome;
		if (options.issue === null) return answer(ground.root);

		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		// The checked-out branch's nonce IS this lane's identity here, so the claim read asks "does the
		// winning marker belong to my lane" instead of "to my session" (#6037).
		const branch = yield* currentBranch;
		const lane = branch === null ? null : parseLaneBranch(branch);
		if (lane === null) {
			return refuse(
				WRONG_LANE,
				`${VERB}: the checked-out branch "${branch ?? "(detached)"}" is not a lane branch — wrong lane.`,
			);
		}

		const held = yield* requireClaim(
			VERB,
			resolved.repo,
			options.issue,
			laneCaller(session.id, lane.nonce),
		);
		if (held._tag === "Refused") {
			return held.ownership._tag === "Foreign" && held.ownership.sameSession
				? refuse(
						WRONG_LANE,
						`${VERB}: the checked-out branch "${branch}" does not carry claim ${held.ownership.marker.token}'s nonce — wrong lane.`,
						held.notes,
					)
				: held.outcome;
		}
		return answer(ground.root, held.notes);
	});
