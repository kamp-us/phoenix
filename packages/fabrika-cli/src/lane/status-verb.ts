/**
 * `lane status` — one lane's derived state, folded fresh from its whole log every invocation.
 *
 * The answer is the operator's status shape: compound `stateValue` (active phase → per-task leaf,
 * future phases `"waiting"`), `status` active/done, and per-task `{retries, maxRetries, …extras}`
 * context with the tripped tasks in `errors`. A task whose latest event named a park cause carries
 * it as `context.<task>.cause` — the key `recipe unpark` seats a park against — and a task
 * with lane classes standing carries them as `context.<task>.classes`, which is what a driver
 * relays onto the next event's `--class`.
 *
 * A `deferred` array rides beside it on a lane that has one, and it is the only part of the answer
 * not derived from the machine: a task an amendment deferred is gone from the machine, so nothing in
 * `stateValue` or `context` can say it ever existed. Without it a deferred child and a child nobody
 * ever planned read identically, and "deferred" would be indistinguishable from "done" to a reader
 * that only checks the lane reached its terminal. Absent rather than empty where the lane deferred
 * nothing, so every other lane's status is byte for byte what it always was.
 */
import {Effect, type FileSystem, type Path} from "effect";
import {answer, type VerbOutcome} from "../verb.ts";
import {resolveDeferrals} from "./deferral.ts";
import {deriveStatus, foldLog, standingCauses, standingRationales} from "./fold.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane status";

export const runStatus = (
	ref: LaneRef,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(ref);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		const fold = foldLog(loaded.lane, loaded.entries);
		if (fold._tag !== "Folded") return replayRefusal(VERB, loaded.logPath, fold);
		const status = deriveStatus(
			loaded.lane,
			fold.states,
			standingCauses(loaded.entries),
			standingRationales(loaded.entries),
		);
		const deferrals = resolveDeferrals(loaded.entries);
		const deferred = deferrals._tag === "Resolved" ? deferrals.deferrals : [];
		return answer(JSON.stringify(deferred.length === 0 ? status : {...status, deferred}, null, 2), [
			`${VERB}: folded ${loaded.entries.length} event(s) from ${loaded.logPath}.`,
			...(deferred.length === 0
				? []
				: [
						`${VERB}: ${deferred.length} task(s) deferred out of this plan: ${deferred
							.map((row) => row.task)
							.join(", ")} — deferred, not completed.`,
					]),
		]);
	});
