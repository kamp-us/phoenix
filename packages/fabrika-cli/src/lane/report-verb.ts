/**
 * `lane report` — a shell records its own terminal token, mapped to one operator event in code.
 *
 * The channel between a shell and the ledger used to be prose the operator re-read out of a
 * transcript (#5736); this verb closes it: token in, [`report.ts`](report.ts)'s map picks the
 * event, and the append rides `transition`'s exact path — validate against the folded state FIRST,
 * append only what the machine accepts, refuse everything else with the log left byte-identical.
 * The optional `--pr`/`--comment` refs land on the event line itself, so an event names its
 * evidence at the moment the shell knows the URL (#5712).
 *
 * **The append is proof-gated.** A token is still a self-report, and moving the recorder from the
 * operator into the shell must not move the bar: between the machine's acceptance and the append
 * this verb runs the same read `lane prove` runs, so a `DONE` and a `PASS` enter the ledger with
 * their artifact behind them or not at all, a reviewer's park enters it only while no `FAIL` at the
 * head says the run reached a verdict (#6112), and every other event answers `not-required` without
 * a board read. A refusal is returned on the prover's own code, log untouched — the codes and their
 * remedies are `lane prove`'s, unchanged. The prover is a parameter so this verb's unit tier stays
 * offline; the CLI always hands it `runProve`, which is the only prover a shell ever invokes.
 */
import {Effect, FileSystem, Path, Result} from "effect";
import {appendText} from "../io/fs.ts";
import {ANSWER, answer, refuse, type VerbOutcome} from "../verb.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {
	APPEND_UNKNOWN,
	CAUSE_UNRECOGNISED,
	CLASS_UNRECOGNISED,
	CONCURRENT_WRITE,
	EVENT_REFUSED,
	TASK_UNKNOWN,
	TOKEN_UNRECOGNISED,
} from "./codes.ts";
import {applyEvent, foldLog, type LogEntry, resolveTask} from "./fold.ts";
import type {ProveOptions} from "./prove-verb.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {causeForEvent, classesForEvent, eventForToken} from "./report.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane report";
const PROVE_VERB = "fabrika lane prove";

export interface ReportOptions extends LaneRef {
	/** The shell's terminal token, exactly as its skill's vocabulary spells it; case-folded here. */
	readonly token: string;
	/** The task the event addresses; `null` resolves only on a single-task lane. */
	readonly task: string | null;
	/** The PR URL the terminal names, recorded on the event line. */
	readonly pr: string | null;
	/** The comment URL the terminal names, recorded on the event line. */
	readonly comment: string | null;
	/** Why the lane parked, from the closed set in [`report.ts`](report.ts); `BLOCKED` only. */
	readonly cause: string | null;
	/** The lane classes standing at this event, relayed onto the event line (ADR 0317). */
	readonly classes: ReadonlyArray<string>;
	/** The target repo the proof reads against, resolved exactly as `lane prove` resolves it. */
	readonly repo: string | null;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in, not the ledger root. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runReport = <R>(
	options: ReportOptions,
	prove: (options: ProveOptions) => Effect.Effect<VerbOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path | R> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const resolved = eventForToken(options.token);
		if (resolved._tag === "Unrecognised") {
			return refuse(TOKEN_UNRECOGNISED, `${VERB}: refused (log unappended): ${resolved.reason}`);
		}
		const caused = causeForEvent(options.cause, resolved.event);
		if (caused._tag === "Rejected") {
			return refuse(CAUSE_UNRECOGNISED, `${VERB}: refused (log unappended): ${caused.reason}.`);
		}
		const classed = classesForEvent(options.classes);
		if (classed._tag === "Rejected") {
			return refuse(CLASS_UNRECOGNISED, `${VERB}: refused (log unappended): ${classed.reason}.`);
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
		const applied = applyEvent(
			loaded.lane,
			fold.states,
			task.taskId,
			resolved.event,
			at,
			classed.classes,
		);
		if (applied._tag === "Refused") {
			return refuse(EVENT_REFUSED, `${VERB}: refused (log unappended): ${applied.reason}`);
		}

		// The proof runs BEFORE the lock: it is read-only over the artifacts, never over the lane's
		// bytes, so holding writers up behind a slow board read buys nothing (#5994). What the lock
		// covers is the authoritative second pass below, where a fresh fold decides and appends.
		const proved = yield* prove({
			root: options.root,
			lane: options.lane,
			event: resolved.event,
			task: task.taskId,
			// The same classes the append carries, so the proof asks about the arm this event actually
			// takes rather than the one the lane stood on before it (#6664).
			classes: classed.classes,
			repo: options.repo,
			cwd: options.cwd,
			env: options.env,
		});
		if (proved.code !== ANSWER) {
			return refuse(
				proved.code,
				`${VERB}: refused (log unappended): the ${resolved.event} behind token ${resolved.token} is not proven — the reasons above are ${PROVE_VERB}'s and so are their remedies.`,
				proved.stderr,
			);
		}

		// Authoritative pass, inside the write lock: a fresh load → fold → validate → append against
		// the bytes as they exist under the lock, so a shell recording its terminal cannot validate
		// against a state another writer is about to move under it (#5994). The pre-lock pass above
		// only gated whether proving was worth its board read; this pass decides.
		return yield* withLedgerLock(
			{fs, path, dir: path.join(options.root, options.lane), verb: VERB},
			Effect.gen(function* () {
				const fresh = yield* loadLane(options);
				if (fresh._tag !== "Loaded") return loadRefusal(VERB, fresh);
				const freshTask = resolveTask(fresh.lane, options.task);
				if (freshTask._tag === "Unresolved") {
					return refuse(TASK_UNKNOWN, `${VERB}: ${freshTask.reason}`);
				}
				const freshFold = foldLog(fresh.lane, fresh.entries);
				if (freshFold._tag !== "Folded") return replayRefusal(VERB, fresh.logPath, freshFold);

				const now = yield* Effect.sync(() => new Date().toISOString());
				const reapplied = applyEvent(
					fresh.lane,
					freshFold.states,
					freshTask.taskId,
					resolved.event,
					now,
					classed.classes,
				);
				if (reapplied._tag === "Refused") {
					return refuse(EVENT_REFUSED, `${VERB}: refused (log unappended): ${reapplied.reason}`);
				}

				const entry: LogEntry = {
					...reapplied.entry,
					...(options.pr === null ? {} : {pr: options.pr}),
					...(options.comment === null ? {} : {comment: options.comment}),
					...(caused._tag === "Caused" ? {cause: caused.cause} : {}),
				};
				const wrote = yield* Effect.result(appendText(fresh.logPath, `${JSON.stringify(entry)}\n`));
				if (Result.isFailure(wrote)) {
					return refuse(
						APPEND_UNKNOWN,
						`${VERB}: the append to ${fresh.logPath} did not land: ${wrote.failure.reason} — the event is NOT recorded.`,
					);
				}
				return answer(
					JSON.stringify(
						{
							token: resolved.token,
							previous: reapplied.previous.stateValue,
							event: entry.event,
							current: reapplied.current.stateValue,
							taskAffected: freshTask.taskId,
							...(options.pr === null ? {} : {pr: options.pr}),
							...(options.comment === null ? {} : {comment: options.comment}),
							...(caused._tag === "Caused" ? {cause: caused.cause} : {}),
						},
						null,
						2,
					),
					[
						...proved.stderr,
						`${VERB}: appended ${entry.event} (token ${resolved.token}) to ${fresh.logPath}, proven first.`,
					],
				);
			}),
			(lockDir) => refuse(CONCURRENT_WRITE, lockedRefusal(VERB, lockDir)),
		);
	});
