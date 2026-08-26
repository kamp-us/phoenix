/**
 * Recording a founder-cleared round into a lane's own event log.
 *
 * The clearance itself lives on the PR, where it is audited (`../build/clearances.ts`). This is the
 * local half: the lane's guard reads `retries < maxRetries` off the fold, so a lane that never heard
 * about the grant freezes the same repair `build verdicts` says still has budget. Appending a
 * `<TASK>.CLEARED` event is what keeps the two readers on one derivation (`../cap-clearance.ts`).
 *
 * **The grant is an event, never a field.** It used to be written into the task's `clearedRounds`
 * context and read back at replay time, which let a clearance recorded today change how yesterday's
 * `FAIL` routed — it stranded lane 6462's legally-recorded `UNBLOCKED` in a state with no cell for
 * it and bricked every verb on the lane (#6578). Appended, the budget is a fold over the events
 * before each position, so a recorded event keeps the routing it took (ADR 0312).
 *
 * **Set semantics, so a re-run buys nothing.** The append happens only when the log holds no
 * `CLEARED` for that round on that task, which makes reconciling an interrupted grant safe: the
 * operator re-runs the verb and the budget is the same as if it had landed the first time.
 */

import {Effect, FileSystem, Path, Result} from "effect";
import {appendText} from "../io/fs.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {applyClearance, resolveTask} from "./fold.ts";
import {type LaneRef, loadLane} from "./store.ts";

export type Recorded =
	| {readonly _tag: "Recorded"; readonly task: string; readonly path: string}
	| {readonly _tag: "AlreadyHeld"; readonly task: string; readonly path: string}
	/** No lane at this ref — nothing local can trip, so this is an answer, not a fault. */
	| {readonly _tag: "NoLane"; readonly dir: string}
	| {readonly _tag: "Unusable"; readonly path: string; readonly reason: string};

/** Append one cleared round to a lane task's log. Every refusal names the document it read. */
export const recordClearedRound = (
	ref: LaneRef,
	task: string | null,
	round: number,
): Effect.Effect<Recorded, never, FileSystem.FileSystem | Path.Path> => {
	const VERB = "lane clearance";
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return yield* withLedgerLock(
			{fs, path, dir: path.join(ref.root, ref.lane), verb: VERB},
			Effect.gen(function* () {
				const loaded = yield* loadLane(ref);
				if (loaded._tag === "Absent") return {_tag: "NoLane" as const, dir: loaded.dir};
				if (loaded._tag === "Unreadable") {
					return {_tag: "Unusable" as const, path: loaded.path, reason: loaded.reason};
				}
				if (loaded._tag === "Malformed") {
					return {_tag: "Unusable" as const, path: loaded.path, reason: loaded.defects.join("; ")};
				}

				const resolved = resolveTask(loaded.lane, task);
				if (resolved._tag === "Unresolved") {
					return {_tag: "Unusable" as const, path: loaded.logPath, reason: resolved.reason};
				}

				const at = yield* Effect.sync(() => new Date().toISOString());
				const applied = applyClearance(loaded.lane, loaded.entries, resolved.taskId, round, at);
				if (applied._tag === "Refused") {
					return {_tag: "Unusable" as const, path: loaded.logPath, reason: applied.reason};
				}
				if (applied._tag === "AlreadyHeld") {
					return {_tag: "AlreadyHeld" as const, task: resolved.taskId, path: loaded.logPath};
				}

				const wrote = yield* Effect.result(
					appendText(loaded.logPath, `${JSON.stringify(applied.entry)}\n`),
				);
				return Result.isFailure(wrote)
					? ({_tag: "Unusable", path: loaded.logPath, reason: wrote.failure.reason} as const)
					: ({_tag: "Recorded", task: resolved.taskId, path: loaded.logPath} as const);
			}),
			(lockDir) => ({
				_tag: "Unusable" as const,
				path: lockDir,
				reason: lockedRefusal(VERB, lockDir),
			}),
		);
	});
};
