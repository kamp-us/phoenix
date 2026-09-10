/**
 * `lane clear` — the driver's seat on a spent repair budget, for a lane with no pull request.
 *
 * `build clear` is PR-keyed from its first line, so an epic child and a chore lane could never
 * reach it: their budget spent, they parked with a door nothing could walk. This verb is the other
 * seat, and it grants exactly what the founder's does — one recorded `<TASK>.CLEARED` round, which
 * is the only event a repair budget may come from.
 *
 * **The round is derived, never typed.** `capWith` reads the task's own declared cap against the
 * rounds already cleared in its log, so one call grants one round and the next needs its own call.
 * A flag would let a caller type a number far ahead and buy several rounds in one line, which is
 * exactly the unbounded door this verb exists not to be.
 *
 * **The rationale is mandatory, because it is the whole audit.** A founder's grant is reviewable on
 * the pull request it was posted to; a driver's is reviewable on this line or nowhere — the driver
 * acts on its own recommendation and logs it.
 *
 * The round is derived outside the append's lock and recorded inside it, which is safe for the one
 * reason the grant is keyed by its round at all: two drivers deriving the same round concurrently
 * leave one `Recorded` and one `AlreadyHeld`, never two grants.
 */
import {Effect, type FileSystem, type Path} from "effect";
import {budgetWith, capWith} from "../cap-clearance.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {recordClearedRound} from "./clearance.ts";
import {APPEND_UNKNOWN, GRANT_REFUSED, RATIONALE_REFUSED, TASK_UNKNOWN} from "./codes.ts";
import {foldLog, resolveTask} from "./fold.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane clear";

export interface ClearOptions extends LaneRef {
	/** The task the grant addresses; `null` resolves only on a single-task lane. */
	readonly task: string | null;
	/** Why this round is granted — refused blank, since a grant nobody can review is not one. */
	readonly rationale: string | null;
}

export const runClear = (
	options: ClearOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const rationale = options.rationale === null ? "" : options.rationale.trim();
		if (rationale === "") {
			return refuse(
				RATIONALE_REFUSED,
				`${VERB}: refused (log unappended): --rationale is ${options.rationale === null ? "absent" : "blank"}, and a driver's grant is auditable on this line or nowhere.`,
			);
		}

		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		const task = resolveTask(loaded.lane, options.task);
		if (task._tag === "Unresolved") return refuse(TASK_UNKNOWN, `${VERB}: ${task.reason}`);
		const fold = foldLog(loaded.lane, loaded.entries);
		if (fold._tag !== "Folded") return replayRefusal(VERB, loaded.logPath, fold);

		const state = fold.states[task.taskId];
		const compiled = loaded.lane.tasks[task.taskId];
		if (state === undefined || compiled === undefined) {
			return refuse(
				TASK_UNKNOWN,
				`${VERB}: task "${task.taskId}" folded to no state in this lane's machine.`,
			);
		}
		// The declared cap, not the folded one: `maxRetries` already carries the grants below, and
		// deriving the next round off it would compound each grant into the next one's floor.
		const round = capWith(compiled.initial.maxRetries + 1, state.cleared);
		if (state.retries < state.maxRetries) {
			return refuse(
				GRANT_REFUSED,
				`${VERB}: refused (log unappended): task "${task.taskId}" is at ${state.retries}/${state.maxRetries} retries and has budget to spend — a round granted before the budget is spent is one nobody asked for.`,
			);
		}

		const recorded = yield* recordClearedRound(options, task.taskId, round, rationale);
		if (recorded._tag === "NoLane") return loadRefusal(VERB, {_tag: "Absent", dir: recorded.dir});
		if (recorded._tag === "Unusable") {
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: the grant did not land at ${recorded.path}: ${recorded.reason} — the round is NOT cleared.`,
			);
		}
		// `AlreadyHeld` is reachable only through the race the docblock names: the budget check above
		// refuses any re-run whose grant is still unspent, so a second call on one writer's timeline
		// always derives the round after it.
		const held = recorded._tag === "AlreadyHeld";
		return answer(
			JSON.stringify(
				{
					answer: held ? "held" : "cleared",
					lane: options.lane,
					task: task.taskId,
					round,
					budget: budgetWith(compiled.initial.maxRetries, [...state.cleared, round]),
					rationale,
				},
				null,
				2,
			),
			[
				held
					? `${VERB}: round ${round} was already cleared on "${task.taskId}" — a grant is keyed by its round, so this buys nothing and doubles nothing.`
					: `${VERB}: granted round ${round} to "${task.taskId}" at ${recorded.path} — one round, on this driver's own recommendation. The park's door is walkable now: record the UNBLOCKED next.`,
			],
		);
	});
