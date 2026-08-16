/**
 * `lane transition` — record one operator event, or refuse it with the log left byte-identical.
 *
 * The order is the contract: validate against the folded state FIRST, append ONLY an event the
 * machine accepts. An invalid event — no cell in the current state, outside the six, wrong phase,
 * finished workflow — never reaches the append, so the refusal leaves `events.jsonl` untouched
 * (#5671, run 8). An append that fails is {@link APPEND_UNKNOWN}, never reported as recorded.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {appendText} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {APPEND_UNKNOWN, EVENT_REFUSED, TASK_UNKNOWN} from "./codes.ts";
import {applyEvent, foldLog, resolveTask} from "./fold.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane transition";

export interface TransitionOptions extends LaneRef {
	/** The operator event, one of the six; folded to upper case here for the operator's fingers. */
	readonly event: string;
	/** The task the event addresses; `null` resolves only on a single-task lane. */
	readonly task: string | null;
}

export const runTransition = (
	options: TransitionOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		const task = resolveTask(loaded.lane, options.task);
		if (task._tag === "Unresolved") {
			return refuse(TASK_UNKNOWN, `${VERB}: ${task.reason}`);
		}
		const fold = foldLog(loaded.lane, loaded.entries);
		if (fold._tag !== "Folded") return replayRefusal(VERB, loaded.logPath, fold);

		const at = yield* Effect.sync(() => new Date().toISOString());
		const applied = applyEvent(
			loaded.lane,
			fold.states,
			task.taskId,
			options.event.toUpperCase(),
			at,
		);
		if (applied._tag === "Refused") {
			return refuse(EVENT_REFUSED, `${VERB}: refused (log unappended): ${applied.reason}`);
		}

		const wrote = yield* Effect.result(
			appendText(loaded.logPath, `${JSON.stringify(applied.entry)}\n`),
		);
		if (Result.isFailure(wrote)) {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: the append to ${loaded.logPath} did not land: ${wrote.failure.reason} — the event is NOT recorded.`,
			);
		}
		return answer(
			JSON.stringify(
				{
					previous: applied.previous.stateValue,
					event: applied.entry.event,
					current: applied.current.stateValue,
					taskAffected: task.taskId,
				},
				null,
				2,
			),
			[`${VERB}: appended ${applied.entry.event} to ${loaded.logPath}.`],
		);
	});
