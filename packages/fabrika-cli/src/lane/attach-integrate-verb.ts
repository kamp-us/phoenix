/**
 * `lane attach-integrate` — the driver's way to put the `lane integrate` exit and assembly head on
 * an epic child's integrate `FAIL` recorded before `lane report` carried them.
 *
 * The judgement is [`integrate-attach.ts`](integrate-attach.ts)'s; this verb loads, judges, and
 * appends the `CORRECTED` line under the ledger lock after judging again against the bytes the lock
 * holds. Every refusal leaves the log byte-identical.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9882
 */
import {Effect, FileSystem, Path, Result} from "effect";
import {appendText} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {APPEND_UNKNOWN, CONCURRENT_WRITE, INTEGRATE_EVIDENCE, TASK_UNKNOWN} from "./codes.ts";
import {foldLog, resolveTask} from "./fold.ts";
import {type Attachment, judgeAttachment} from "./integrate-attach.ts";
import {type IntegrateFailure, readIntegrateEvidence} from "./integrate-failure.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane attach-integrate";

export interface AttachIntegrateOptions extends LaneRef {
	/** The child task the `FAIL` belongs to; `null` resolves only on a single-task lane. */
	readonly task: string | null;
	/** The `at` of the recorded `FAIL` line the pair attaches to. */
	readonly at: string;
	readonly integrateExit: number;
	readonly assemblyHead: string;
	readonly now: () => Date;
}

/** Load, resolve the task, replay, and judge — once before the lock and again under it. */
const judge = (
	options: AttachIntegrateOptions,
	failure: IntegrateFailure,
	now: string,
): Effect.Effect<
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {
			readonly _tag: "Judged";
			readonly attachment: Extract<Attachment, {_tag: "Attachable"}>;
			readonly logPath: string;
			readonly task: string;
	  },
	never,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return {_tag: "Refused", outcome: loadRefusal(VERB, loaded)};
		const task = resolveTask(loaded.lane, options.task);
		if (task._tag === "Unresolved") {
			return {_tag: "Refused", outcome: refuse(TASK_UNKNOWN, `${VERB}: ${task.reason}`)};
		}
		const fold = foldLog(loaded.lane, loaded.entries);
		if (fold._tag !== "Folded") {
			return {_tag: "Refused", outcome: replayRefusal(VERB, loaded.logPath, fold)};
		}
		const attachment = judgeAttachment(
			loaded.lane,
			loaded.entries,
			task.taskId,
			options.at,
			failure,
			now,
		);
		if (attachment._tag === "Unreplayable") {
			return {_tag: "Refused", outcome: replayRefusal(VERB, loaded.logPath, attachment)};
		}
		if (attachment._tag === "Refused") {
			return {
				_tag: "Refused",
				outcome: refuse(
					INTEGRATE_EVIDENCE,
					`${VERB}: refused (log unappended): ${attachment.reason}.`,
				),
			};
		}
		return {
			_tag: "Judged",
			attachment,
			logPath: loaded.logPath,
			task: task.taskId,
		};
	});

export const runAttachIntegrate = (
	options: AttachIntegrateOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const evidence = readIntegrateEvidence(options.integrateExit, options.assemblyHead);
		if (evidence._tag !== "Read") {
			return refuse(
				INTEGRATE_EVIDENCE,
				`${VERB}: refused (log unappended): ${evidence._tag === "Rejected" ? evidence.reason : "no pair was given"}.`,
			);
		}
		const now = options.now().toISOString();
		const first = yield* judge(options, evidence.failure, now);
		if (first._tag === "Refused") return first.outcome;

		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return yield* withLedgerLock(
			{fs, path, dir: path.join(options.root, options.lane), verb: VERB},
			Effect.gen(function* () {
				const fresh = yield* judge(options, evidence.failure, now);
				if (fresh._tag === "Refused") return fresh.outcome;
				const {entry} = fresh.attachment;
				const wrote = yield* Effect.result(appendText(fresh.logPath, `${JSON.stringify(entry)}\n`));
				if (Result.isFailure(wrote)) {
					return refuse(
						APPEND_UNKNOWN,
						`${VERB}: the append to ${fresh.logPath} did not land: ${wrote.failure.reason} — the pair is NOT attached.`,
					);
				}
				return answer(
					JSON.stringify(
						{
							lane: options.lane,
							task: fresh.task,
							event: entry.event,
							corrects: options.at,
							integrate: evidence.failure,
						},
						null,
						2,
					),
					[
						`${VERB}: appended ${entry.event} to ${fresh.logPath}, attaching lane integrate exit ${evidence.failure.exit} and assembly head ${evidence.failure.head} to the FAIL at ${options.at}.`,
					],
				);
			}),
			{
				onAbsent: (dir) => loadRefusal(VERB, {_tag: "Absent", dir}),
				onLocked: (lockDir) => refuse(CONCURRENT_WRITE, lockedRefusal(VERB, lockDir)),
			},
		);
	});
