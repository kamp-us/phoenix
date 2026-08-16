/**
 * `lane print` — the compiled machine topology as data: per task, each state's legal events.
 *
 * What it answers is what compiled, not the document's bytes — the one way to see which events the
 * machine would refuse where, without sending any.
 */
import {Effect, type FileSystem, type Path} from "effect";
import {answer, type VerbOutcome} from "../verb.ts";
import {topology} from "./machine.ts";
import {loadRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane print";

export const runPrint = (
	ref: LaneRef,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(ref);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		return answer(JSON.stringify(topology(loaded.lane), null, 2), [
			`${VERB}: compiled ${Object.keys(loaded.lane.tasks).length} task machine(s) from ${loaded.dir}/workflow.json.`,
		]);
	});
