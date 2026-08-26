/**
 * `lane transition` — record one operator event, or refuse it with the log left byte-identical.
 *
 * The order is the contract: validate against the folded state FIRST, append ONLY an event the
 * machine accepts. An invalid event — no cell in the current state, outside the six, wrong phase,
 * finished workflow — never reaches the append, so the refusal leaves `events.jsonl` untouched
 * (#5671, run 8). An append that fails is {@link APPEND_UNKNOWN}, never reported as recorded.
 *
 * The whole load → fold → validate → append section runs inside the lane's write lock
 * ([`append-lock.ts`](append-lock.ts)), so a shell recording its own terminal cannot validate
 * against bytes another writer is about to move under it (#5994). Lock-budget exhaustion refuses
 * {@link CONCURRENT_WRITE} — retry this same event — never an ordinary machine-refusal code.
 */
import {Effect, FileSystem, Path, Result} from "effect";
import {appendText} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {
	APPEND_UNKNOWN,
	CAUSE_UNRECOGNISED,
	CLASS_UNRECOGNISED,
	CONCURRENT_WRITE,
	EVENT_REFUSED,
	RESUME_UNBUDGETED,
	TASK_UNKNOWN,
} from "./codes.ts";
import {applyEvent, foldLog, type LogEntry, resolveTask} from "./fold.ts";
import {isOperatorEvent} from "./machine.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type CauseResolution, causeForEvent, classesForEvent} from "./report.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane transition";

export interface TransitionOptions extends LaneRef {
	/** The operator event, one of the six; folded to upper case here for the operator's fingers. */
	readonly event: string;
	/** The task the event addresses; `null` resolves only on a single-task lane. */
	readonly task: string | null;
	/**
	 * Why the lane parked, from the closed set in [`report.ts`](report.ts); `BLOCKED` only.
	 *
	 * A driver originates parks the shells cannot report (`operate` §4), so the cause field has to
	 * reach the ledger on this path too — a `BLOCKED` only a driver could record would otherwise be
	 * novel by construction, which is the gap #6480 closed on the shell's path.
	 */
	readonly cause: string | null;
	/**
	 * The lane classes standing at this event, which the `class:<name>` arms route on (ADR 0317).
	 *
	 * The driver relays a shipped verb's answer here and never derives one (ADR 0228): `lane prove`
	 * writes nothing by design and the append path stays offline, so the class rides the event line
	 * exactly as `--cause` does. Empty leaves the standing set alone; a spelling outside the closed
	 * set is refused rather than routed as unclassed.
	 */
	readonly classes: ReadonlyArray<string>;
}

export const runTransition = (
	options: TransitionOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return yield* withLedgerLock(
			{fs, path, dir: path.join(options.root, options.lane), verb: VERB},
			Effect.gen(function* () {
				const loaded = yield* loadLane(options);
				if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
				const task = resolveTask(loaded.lane, options.task);
				if (task._tag === "Unresolved") {
					return refuse(TASK_UNKNOWN, `${VERB}: ${task.reason}`);
				}
				const fold = foldLog(loaded.lane, loaded.entries);
				if (fold._tag !== "Folded") return replayRefusal(VERB, loaded.logPath, fold);

				const event = options.event.toUpperCase();
				// An event outside the six is applyEvent's refusal below, and its message is the better one;
				// seating the cause as Uncaused here just keeps this read total until that refusal lands.
				const caused: CauseResolution = isOperatorEvent(event)
					? causeForEvent(options.cause, event)
					: {_tag: "Uncaused"};
				if (caused._tag === "Rejected") {
					return refuse(CAUSE_UNRECOGNISED, `${VERB}: refused (log unappended): ${caused.reason}.`);
				}
				const classed = classesForEvent(options.classes);
				if (classed._tag === "Rejected") {
					return refuse(
						CLASS_UNRECOGNISED,
						`${VERB}: refused (log unappended): ${classed.reason}.`,
					);
				}

				const at = yield* Effect.sync(() => new Date().toISOString());
				const applied = applyEvent(
					loaded.lane,
					fold.states,
					task.taskId,
					event,
					at,
					classed.classes,
				);
				if (applied._tag === "Refused") {
					return refuse(
						applied.kind === "unbudgeted-resume" ? RESUME_UNBUDGETED : EVENT_REFUSED,
						`${VERB}: refused (log unappended): ${applied.reason}`,
					);
				}

				const entry: LogEntry = {
					...applied.entry,
					...(caused._tag === "Caused" ? {cause: caused.cause} : {}),
				};
				const wrote = yield* Effect.result(
					appendText(loaded.logPath, `${JSON.stringify(entry)}\n`),
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
							event: entry.event,
							current: applied.current.stateValue,
							taskAffected: task.taskId,
							...(classed.classes === null ? {} : {classes: classed.classes}),
							...(caused._tag === "Caused" ? {cause: caused.cause} : {}),
						},
						null,
						2,
					),
					[`${VERB}: appended ${entry.event} to ${loaded.logPath}.`],
				);
			}),
			(lockDir) => refuse(CONCURRENT_WRITE, lockedRefusal(VERB, lockDir)),
		);
	});
