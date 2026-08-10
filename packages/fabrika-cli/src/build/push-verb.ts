/**
 * `build push` — publish the lane's branch, then **independently confirm the remote ref moved**.
 *
 * `git push`'s own report is not evidence: a push that died mid-hook read as sent, and every stage
 * downstream assumed a branch that was not there (#4136). So the verdict comes from `git ls-remote`
 * asking the remote directly, compared against the local head.
 *
 * **This verb is the group's one deviant on the channel rule: the entire report is stdout,
 * single-stream, so the last stdout line is always the verdict line.** v1 documented exactly this
 * `tail -1` idiom and then shipped the report to stderr at both call sites (`SKILL.md:778-781` vs
 * `step5-push.sh:47`), so the documented read never ran. Here the channel is part of the contract, and
 * the two non-`MOVED` outcomes take their own codes with empty stdout — which is what keeps `tail -1`
 * of stdout on exit 0 unambiguous.
 *
 * `--force-with-lease` is the only force shape. A bare `--force` flag does not exist, and neither does
 * `--no-verify`: the ban is enforced by the flag not existing rather than by prose (#4159, #4468,
 * #4540).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {currentBranch} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {requireSession} from "./claim.ts";
import {PRECONDITION_UNKNOWN, REF_NOT_MOVED, UNSAFE_PUSH, WRITE_UNKNOWN} from "./codes.ts";
import {headSha, isAncestor, push, remoteSha, upstreamOf} from "./git.ts";
import {requireLane} from "./lane-guard.ts";
import {resolveTargetRepo} from "./target.ts";

const VERB = "build push";

export interface PushOptions {
	readonly forceWithLease: boolean;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runPush = (
	options: PushOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		// Detached HEAD is refused HERE, ahead of the lane guard, so it lands on `19` (refused before
		// pushing) rather than on the guard's `14` (wrong lane) — they are different facts.
		if ((yield* currentBranch) === null) {
			return refuse(UNSAFE_PUSH, `${VERB}: HEAD is detached — refusing to guess a branch.`);
		}
		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const lane = yield* requireLane(VERB, resolved.repo, session.id, null);
		if (lane._tag === "Refused") return lane.outcome;

		const local = yield* headSha;
		if (local._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve HEAD: ${local.reason} — nothing was pushed.`,
				lane.notes,
			);
		}

		// The push TARGET is the tracked upstream when there is one — resume mode's local name differs
		// from the PR's remote head branch, and reading back the local name would call every repair
		// push a false `17`.
		const upstream = yield* upstreamOf(lane.branch);
		const remote = upstream?.remote ?? "origin";
		const ref = upstream?.ref ?? lane.branch;

		const before = yield* remoteSha(remote, ref);
		if (before._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${remote}/${ref}: ${before.reason} — nothing was pushed.`,
				lane.notes,
			);
		}
		if (before.value !== null && !options.forceWithLease) {
			const fastForward = yield* isAncestor(before.value, local.value);
			if (!fastForward) {
				return refuse(
					UNSAFE_PUSH,
					`${VERB}: non-fast-forward — pass --force-with-lease only for this lane's own repair resubmission.`,
					lane.notes,
				);
			}
		}

		const pushed = yield* push(remote, ref, options.forceWithLease);
		const after = yield* remoteSha(remote, ref);
		if (after._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: pushed, but the remote ref could not be re-read: ${after.reason} — the outcome is UNKNOWN.`,
				lane.notes,
			);
		}
		if (after.value !== local.value) {
			return refuse(
				REF_NOT_MOVED,
				`${VERB}: the remote ref did not move (remote ${after.value ?? "absent"} ≠ local ${local.value}).`,
				[
					...lane.notes,
					...(pushed._tag === "Failure" ? [`${VERB}: git push reported: ${pushed.reason}.`] : []),
				],
			);
		}
		return answer(
			[
				`pushed ${lane.branch} → ${remote}/${ref}`,
				`remote ref read back: ${after.value}`,
				"PUSH-VERDICT: MOVED",
			].join("\n"),
			lane.notes,
		);
	});
