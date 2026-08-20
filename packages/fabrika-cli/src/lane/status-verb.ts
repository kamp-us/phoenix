/**
 * `lane status` — one lane's derived state, folded fresh from its whole log every invocation.
 *
 * The answer is the operator's status shape: compound `stateValue` (active phase → per-task leaf,
 * future phases `"waiting"`), `status` active/done, and per-task `{retries, maxRetries, …extras}`
 * context with the tripped tasks in `errors`. A task whose latest event named a park cause carries
 * it as `context.<task>.cause` — the key `recipe unpark` seats a park against (#6480).
 */
import {Effect, type FileSystem, type Path} from "effect";
import {answer, type VerbOutcome} from "../verb.ts";
import {deriveStatus, foldLog, standingCauses} from "./fold.ts";
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
		const status = deriveStatus(loaded.lane, fold.states, standingCauses(loaded.entries));
		return answer(JSON.stringify(status, null, 2), [
			`${VERB}: folded ${loaded.entries.length} event(s) from ${loaded.logPath}.`,
		]);
	});
