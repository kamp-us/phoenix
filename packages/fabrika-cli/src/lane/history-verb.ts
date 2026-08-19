/**
 * `lane history` — the append-only log, verbatim: `{task, event, at}` per recorded event, plus the
 * optional `pr`/`comment` refs a shell-recorded event carries as its evidence.
 *
 * The log IS the history; `from`/`to` are reconstructible by folding, never stored. A fresh lane
 * answers `[]` — no events yet is a well-formed empty history, not a fault.
 */
import {Effect, type FileSystem, type Path} from "effect";
import {answer, type VerbOutcome} from "../verb.ts";
import {loadRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane history";

export const runHistory = (
	ref: LaneRef,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(ref);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		return answer(JSON.stringify(loaded.entries, null, 2), [
			`${VERB}: ${loaded.entries.length} event(s) in ${loaded.logPath}.`,
		]);
	});
