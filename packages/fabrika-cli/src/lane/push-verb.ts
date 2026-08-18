/**
 * `lane push` — publish an epic run's assembly branch, then **independently confirm the remote ref
 * moved**.
 *
 * `build push` cannot serve this branch: it proves the checked-out branch carries a build claim's
 * nonce, and the assembly branch is owned by no spawned shell (ADR 0285). The alternative was a bare
 * `git push` in the driver's own hands, which cannot report whether the ref landed — the exact hole
 * #4213 closed everywhere else in the corpus. So the assembly step gets a verb of its own with the
 * same evidence discipline: `git ls-remote` asks the remote directly and the caller compares.
 *
 * The branch name is derived from the epic number through {@link epicBranch}, never taken from the
 * caller, and the run's lane must be on disk — together that makes "this is the run's assembly
 * branch" a fact read off the ledger rather than a claim the argument asserts.
 *
 * There is no force flag. The assembly branch only ever grows, one merge per landed child, so a
 * non-fast-forward push is always a mistake and the flag that would let one through does not exist.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	commitsDropped,
	ensureCommitPresent,
	headSha,
	isAncestor,
	push,
	remoteSha,
	upstreamOf,
} from "../build/git.ts";
import {currentBranch} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {epicBranch} from "../wire/lane-brief.ts";
import {
	APPEND_UNKNOWN,
	LANE_UNREADABLE,
	REF_NOT_MOVED,
	UNSAFE_PUSH,
	WRONG_BRANCH,
} from "./codes.ts";
import {loadRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane push";

export interface PushOptions extends LaneRef {
	readonly epic: number;
}

export const runPush = (
	options: PushOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);

		const branch = epicBranch(options.epic);
		const checkedOut = yield* currentBranch;
		if (checkedOut === null) {
			return refuse(
				WRONG_BRANCH,
				`${VERB}: HEAD is detached — switch to ${branch}, the run's assembly branch.`,
			);
		}
		if (checkedOut !== branch) {
			return refuse(
				WRONG_BRANCH,
				`${VERB}: the checked-out branch "${checkedOut}" is not #${options.epic}'s assembly branch (${branch}) — nothing was pushed.`,
			);
		}

		const local = yield* headSha;
		if (local._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot resolve HEAD: ${local.reason} — nothing was pushed.`,
			);
		}

		const upstream = yield* upstreamOf(branch);
		const remote = upstream?.remote ?? "origin";
		const ref = upstream?.ref ?? branch;

		const before = yield* remoteSha(remote, ref);
		if (before._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read ${remote}/${ref}: ${before.reason} — nothing was pushed.`,
			);
		}
		if (before.value !== null) {
			if (!(yield* ensureCommitPresent(remote, ref, before.value))) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot prove containment — ${remote}/${ref} is at ${before.value}, which this checkout does not hold and could not fetch. Nothing was pushed.`,
				);
			}
			if (!(yield* isAncestor(before.value, local.value))) {
				const dropped = yield* commitsDropped(local.value, before.value);
				return refuse(
					UNSAFE_PUSH,
					`${VERB}: the local head does not contain ${remote}/${ref} (${before.value}) — this push would DROP ${
						dropped.lines.length === 0
							? "commits the remote holds and this head does not"
							: `${dropped.lines.join("; ")}${dropped.truncated ? "; …" : ""}`
					}. Fetch and merge the published assembly head; the assembly branch is never rewritten.`,
				);
			}
		}

		const pushed = yield* push(remote, ref, false);
		const after = yield* remoteSha(remote, ref);
		if (after._tag === "Failure") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: pushed, but the remote ref could not be re-read: ${after.reason} — the outcome is UNKNOWN.`,
			);
		}
		if (after.value !== local.value) {
			return refuse(
				REF_NOT_MOVED,
				`${VERB}: the remote ref did not move (remote ${after.value ?? "absent"} ≠ local ${local.value}).`,
				pushed._tag === "Failure" ? [`${VERB}: git push reported: ${pushed.reason}.`] : [],
			);
		}
		return answer(
			[
				`pushed ${branch} → ${remote}/${ref}`,
				`remote ref read back: ${after.value}`,
				"PUSH-VERDICT: MOVED",
			].join("\n"),
			[`${VERB}: assembly branch of the lane at ${loaded.dir}.`],
		);
	});
