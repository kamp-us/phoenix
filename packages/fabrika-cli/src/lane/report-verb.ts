/**
 * `lane report` — a shell records its own terminal token, mapped to one operator event in code.
 *
 * The channel between a shell and the ledger used to be prose the operator re-read out of a
 * transcript (#5736); this verb closes it: token in, [`report.ts`](report.ts)'s map picks the
 * event, and the append rides `transition`'s exact path — validate against the folded state FIRST,
 * append only what the machine accepts, refuse everything else with the log left byte-identical.
 * The optional `--pr`/`--comment` refs land on the event line itself, so an event names its
 * evidence at the moment the shell knows the URL (#5712).
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {appendText} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {APPEND_UNKNOWN, EVENT_REFUSED, TASK_UNKNOWN, TOKEN_UNRECOGNISED} from "./codes.ts";
import {applyEvent, foldLog, type LogEntry, resolveTask} from "./fold.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {eventForToken} from "./report.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane report";

export interface ReportOptions extends LaneRef {
	/** The shell's terminal token, exactly as its skill's vocabulary spells it; case-folded here. */
	readonly token: string;
	/** The task the event addresses; `null` resolves only on a single-task lane. */
	readonly task: string | null;
	/** The PR URL the terminal names, recorded on the event line. */
	readonly pr: string | null;
	/** The comment URL the terminal names, recorded on the event line. */
	readonly comment: string | null;
}

export const runReport = (
	options: ReportOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const resolved = eventForToken(options.token);
		if (resolved._tag === "Unrecognised") {
			return refuse(TOKEN_UNRECOGNISED, `${VERB}: refused (log unappended): ${resolved.reason}`);
		}
		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		const task = resolveTask(loaded.lane, options.task);
		if (task._tag === "Unresolved") {
			return refuse(TASK_UNKNOWN, `${VERB}: ${task.reason}`);
		}
		const fold = foldLog(loaded.lane, loaded.entries);
		if (fold._tag !== "Folded") return replayRefusal(VERB, loaded.logPath, fold);

		const at = yield* Effect.sync(() => new Date().toISOString());
		const applied = applyEvent(loaded.lane, fold.states, task.taskId, resolved.event, at);
		if (applied._tag === "Refused") {
			return refuse(EVENT_REFUSED, `${VERB}: refused (log unappended): ${applied.reason}`);
		}

		const entry: LogEntry = {
			...applied.entry,
			...(options.pr === null ? {} : {pr: options.pr}),
			...(options.comment === null ? {} : {comment: options.comment}),
		};
		const wrote = yield* Effect.result(appendText(loaded.logPath, `${JSON.stringify(entry)}\n`));
		if (Result.isFailure(wrote)) {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: the append to ${loaded.logPath} did not land: ${wrote.failure.reason} — the event is NOT recorded.`,
			);
		}
		return answer(
			JSON.stringify(
				{
					token: resolved.token,
					previous: applied.previous.stateValue,
					event: entry.event,
					current: applied.current.stateValue,
					taskAffected: task.taskId,
					...(options.pr === null ? {} : {pr: options.pr}),
					...(options.comment === null ? {} : {comment: options.comment}),
				},
				null,
				2,
			),
			[`${VERB}: appended ${entry.event} (token ${resolved.token}) to ${loaded.logPath}.`],
		);
	});
