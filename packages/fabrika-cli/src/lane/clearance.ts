/**
 * Recording a founder-cleared round into a lane's own machine document.
 *
 * The clearance itself lives on the PR, where it is audited (`../build/clearances.ts`). This is the
 * local half: the lane's `retriesRemaining` guard reads `retries < maxRetries` out of the compiled
 * context, so a lane that never heard about the grant freezes the same repair `build verdicts` says
 * still has budget. Writing the granted round into the task's `clearedRounds` is what keeps the two
 * readers on one derivation (`../cap-clearance.ts`).
 *
 * **Set semantics, so a re-run buys nothing.** The round is added only when it is not already
 * there, which makes reconciling an interrupted grant safe: the operator re-runs the verb and the
 * budget is the same as if it had landed the first time.
 */

import {Effect, type FileSystem, Path, Result} from "effect";
import {readFile, writeFile} from "../io/fs.ts";
import {isRecord, parseJson} from "../io/json.ts";
import type {LaneRef} from "./store.ts";

export type Recorded =
	| {readonly _tag: "Recorded"; readonly task: string; readonly path: string}
	| {readonly _tag: "AlreadyHeld"; readonly task: string; readonly path: string}
	/** No lane at this ref — nothing local can trip, so this is an answer, not a fault. */
	| {readonly _tag: "NoLane"; readonly dir: string}
	| {readonly _tag: "Unusable"; readonly path: string; readonly reason: string};

/** Add one cleared round to a lane task's context. Every refusal names the document it read. */
export const recordClearedRound = (
	ref: LaneRef,
	task: string | null,
	round: number,
): Effect.Effect<Recorded, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const dir = path.join(ref.root, ref.lane);
		const workflowPath = path.join(dir, "workflow.json");
		const text = yield* Effect.result(readFile(workflowPath));
		if (Result.isFailure(text)) return {_tag: "NoLane" as const, dir};

		const parsed = parseJson(text.success);
		if (parsed === null) {
			return {_tag: "Unusable" as const, path: workflowPath, reason: "the document is not JSON"};
		}
		const machine = isRecord(parsed) ? parsed.machine : undefined;
		const context = isRecord(machine) && isRecord(machine.context) ? machine.context : undefined;
		if (context === undefined) {
			return {
				_tag: "Unusable" as const,
				path: workflowPath,
				reason: "the document carries no `machine.context` to record the grant in",
			};
		}
		const ids = Object.keys(context);
		const only = ids.length === 1 ? ids[0] : undefined;
		const taskId = task ?? only;
		if (taskId === undefined || context[taskId] === undefined) {
			return {
				_tag: "Unusable" as const,
				path: workflowPath,
				reason:
					task === null
						? `--task is required on a lane with ${ids.length} tasks (${ids.join(", ")})`
						: `task "${task}" is not in this lane's machine (tasks: ${ids.join(", ")})`,
			};
		}

		const entry = context[taskId];
		if (!isRecord(entry)) {
			return {
				_tag: "Unusable" as const,
				path: workflowPath,
				reason: `task "${taskId}"'s context entry is not an object`,
			};
		}
		const held = Array.isArray(entry.clearedRounds)
			? entry.clearedRounds.filter((value): value is number => typeof value === "number")
			: [];
		if (held.includes(round)) {
			return {_tag: "AlreadyHeld" as const, task: taskId, path: workflowPath};
		}
		context[taskId] = {...entry, clearedRounds: [...held, round].sort((a, b) => a - b)};
		const wrote = yield* Effect.result(
			writeFile(workflowPath, `${JSON.stringify(parsed, null, "\t")}\n`),
		);
		return Result.isFailure(wrote)
			? ({_tag: "Unusable", path: workflowPath, reason: wrote.failure.reason} as const)
			: ({_tag: "Recorded", task: taskId, path: workflowPath} as const);
	});
