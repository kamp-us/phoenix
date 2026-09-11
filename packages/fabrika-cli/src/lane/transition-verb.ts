/**
 * `lane transition` — record one operator event, or refuse it with the log left byte-identical.
 *
 * The order is the contract: validate against the folded state FIRST, append ONLY an event the
 * machine accepts. An invalid event — no cell in the current state, outside the six, wrong phase,
 * finished workflow — never reaches the append, so the refusal leaves `events.jsonl` untouched.
 * An append that fails is {@link APPEND_UNKNOWN}, never reported as recorded.
 *
 * **The append is proof-gated, exactly as `lane report`'s is.** A driver's record is a self-report
 * like a shell's token, so between the machine's acceptance and the append this verb runs the same
 * read `lane prove` runs and refuses on the prover's own code with the log untouched.
 * The proof used to sit beside the verb as a command a driver was told to run first, which a
 * chained `lane prove …; lane transition …` skipped without failing anywhere. The prover is a
 * parameter so this verb's unit tier stays offline; the CLI hands it `runProve`.
 *
 * The prover's own payloads ride the appended line here as they do on the shell's path, `diagnosis`
 * among them: an investigation's build `DONE` proven off a diagnosis comment rather than a pull
 * request takes the machine's `done:diagnosis` arm from this door too, so which verb recorded the
 * terminal cannot change which terminal the lane reaches.
 *
 * The proof is read-only over the artifacts and runs BEFORE the lock; the authoritative
 * load → fold → validate → append pass runs inside it ([`append-lock.ts`](append-lock.ts)), so a
 * writer cannot validate against bytes another is about to move under it. Lock-budget exhaustion
 * refuses {@link CONCURRENT_WRITE} — retry this same event — never an ordinary machine-refusal code.
 */
import {Effect, FileSystem, Path, Result} from "effect";
import type {ParkCauseSurface} from "../config/keys/park-cause.ts";
import type {Read} from "../config/read-key.ts";
import {appendText} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {
	APPEND_UNKNOWN,
	CAUSE_UNRECOGNISED,
	CLASS_UNRECOGNISED,
	CONCURRENT_WRITE,
	EVENT_REFUSED,
	GRANT_REFUSED,
	PARK_UNCAUSED,
	RATIONALE_REFUSED,
	RESUME_UNBUDGETED,
	TASK_UNKNOWN,
} from "./codes.ts";
import {applyEvent, foldLog, type LogEntry, resolveTask} from "./fold.ts";
import {isOperatorEvent} from "./machine.ts";
import {parkCauseRefusal} from "./park-cause-rule.ts";
import {gateOnProof} from "./proof-gate.ts";
import type {ProofOutcome, ProveOptions} from "./prove-verb.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {
	type CauseResolution,
	causeForEvent,
	classesForEvent,
	type GrantResolution,
	grantForEvent,
	type RationaleResolution,
	rationaleForEvent,
} from "./report.ts";
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
	 * novel by construction, which is the gap the cause field closed on the shell's path.
	 */
	readonly cause: string | null;
	/**
	 * The repo's declared `parkCause`, read off `.fabrika.jsonc` by the adapter.
	 *
	 * This verb records the parks a driver originates, so the rule refusing a cause-less park has to
	 * reach it too — a rule only the shell's path enforced would leave the driver's own bare
	 * `BLOCKED` recordable, which is the same defect at a different door.
	 */
	readonly parkCause: Read<ParkCauseSurface>;
	/**
	 * The lane classes standing at this event, which the `class:<name>` arms route on.
	 *
	 * The driver relays a shipped verb's answer here and never derives one: `lane prove` writes
	 * nothing by design, so the class rides the event line exactly as `--cause` does — and it rides
	 * into the proof as well, because it picks the arm the event takes. Empty leaves the standing set
	 * alone; a spelling outside the closed set is refused rather than routed as unclassed.
	 */
	readonly classes: ReadonlyArray<string>;
	/**
	 * Waits this event grants, on an `UNBLOCKED` out of a wait park; `null` grants none.
	 *
	 * It rides the resume so the clear and the grant are one recorded line — `recipe unpark` passes
	 * it once it has proven the queue moved, and a human passes `--grant-wait` when that read cannot
	 * run. A resume that needs one and carries none is `applyEvent`'s `unbudgeted-resume`.
	 */
	readonly waitGrant: number | null;
	/**
	 * Why the park this event clears was cleared, on an `UNBLOCKED` only; `null` records none.
	 *
	 * `recipe unpark` passes the driver's own recommendation here when it clears a driver-routed
	 * park, which is the whole audit of that clearance — the route says a driver may take the park,
	 * and this says what it took it on.
	 */
	readonly rationale: string | null;
	/** The target repo the proof reads against, resolved exactly as `lane prove` resolves it. */
	readonly repo: string | null;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in, not the ledger root. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runTransition = <R>(
	options: TransitionOptions,
	prove: (options: ProveOptions) => Effect.Effect<ProofOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path | R> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
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
		const rule = parkCauseRefusal(VERB, options.parkCause);
		if (rule._tag === "Refused") return rule.outcome;
		const caused: CauseResolution = isOperatorEvent(event)
			? causeForEvent(options.cause, event, rule.requireCause)
			: {_tag: "Uncaused"};
		if (caused._tag === "Rejected") {
			return refuse(CAUSE_UNRECOGNISED, `${VERB}: refused (log unappended): ${caused.reason}.`);
		}
		if (caused._tag === "Required") {
			return refuse(PARK_UNCAUSED, `${VERB}: refused (log unappended): ${caused.reason}.`);
		}
		const classed = classesForEvent(options.classes);
		if (classed._tag === "Rejected") {
			return refuse(CLASS_UNRECOGNISED, `${VERB}: refused (log unappended): ${classed.reason}.`);
		}
		const granted: GrantResolution = isOperatorEvent(event)
			? grantForEvent(options.waitGrant, event)
			: {_tag: "Granted", grant: null};
		if (granted._tag === "Rejected") {
			return refuse(GRANT_REFUSED, `${VERB}: refused (log unappended): ${granted.reason}.`);
		}
		const reasoned: RationaleResolution = isOperatorEvent(event)
			? rationaleForEvent(options.rationale, event)
			: {_tag: "Reasoned", rationale: null};
		if (reasoned._tag === "Rejected") {
			return refuse(RATIONALE_REFUSED, `${VERB}: refused (log unappended): ${reasoned.reason}.`);
		}

		const at = yield* Effect.sync(() => new Date().toISOString());
		const applied = applyEvent(
			loaded.lane,
			fold.states,
			task.taskId,
			event,
			at,
			classed.classes,
			granted.grant,
			null,
			null,
			caused._tag === "Caused" ? caused.cause : null,
		);
		if (applied._tag === "Refused") {
			return refuse(
				applied.kind === "unbudgeted-resume" ? RESUME_UNBUDGETED : EVENT_REFUSED,
				`${VERB}: refused (log unappended): ${applied.reason}`,
			);
		}

		// The proof runs BEFORE the lock: it is read-only over the artifacts, never over the lane's
		// bytes, so holding writers up behind a slow board read buys nothing. What the lock covers is
		// the authoritative second pass below, where a fresh fold decides and appends.
		const gated = yield* gateOnProof(
			VERB,
			prove,
			{
				root: options.root,
				lane: options.lane,
				event,
				task: task.taskId,
				// The same classes the append carries, so the proof asks about the arm this event
				// actually takes rather than the one the lane stood on before it.
				classes: classed.classes,
				// A driver's own record names no PR, so the ship-stage closure read nominates for one
				// exactly as it does on a shell terminal that carried no `--pr`.
				pr: null,
				repo: options.repo,
				cwd: options.cwd,
				env: options.env,
			},
			`the ${event}`,
		);
		if (gated._tag === "Refused") return gated.outcome;
		const proved = gated.proof;

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
					event,
					now,
					classed.classes,
					granted.grant,
					proved.partial,
					proved.diagnosis ? true : null,
					caused._tag === "Caused" ? caused.cause : null,
				);
				if (reapplied._tag === "Refused") {
					return refuse(
						reapplied.kind === "unbudgeted-resume" ? RESUME_UNBUDGETED : EVENT_REFUSED,
						`${VERB}: refused (log unappended): ${reapplied.reason}`,
					);
				}

				const entry: LogEntry = {
					...reapplied.entry,
					...(caused._tag === "Caused" ? {cause: caused.cause} : {}),
					...(reasoned.rationale === null ? {} : {rationale: reasoned.rationale}),
					...(proved.deferred.length === 0 ? {} : {deferred: proved.deferred}),
					...(proved.landed.length === 0 ? {} : {landed: proved.landed}),
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
							previous: reapplied.previous.stateValue,
							event: entry.event,
							current: reapplied.current.stateValue,
							taskAffected: freshTask.taskId,
							...(classed.classes === null ? {} : {classes: classed.classes}),
							...(caused._tag === "Caused" ? {cause: caused.cause} : {}),
							...(granted.grant === null ? {} : {waitGrant: granted.grant}),
							...(reasoned.rationale === null ? {} : {rationale: reasoned.rationale}),
							...(proved.deferred.length === 0 ? {} : {deferred: proved.deferred}),
							...(proved.partial === null ? {} : {partial: proved.partial}),
							...(proved.diagnosis ? {diagnosis: true} : {}),
							...(proved.landed.length === 0 ? {} : {landed: proved.landed}),
						},
						null,
						2,
					),
					[...proved.stderr, `${VERB}: appended ${entry.event} to ${fresh.logPath}, proven first.`],
				);
			}),
			{
				onAbsent: (dir) => loadRefusal(VERB, {_tag: "Absent", dir}),
				onLocked: (lockDir) => refuse(CONCURRENT_WRITE, lockedRefusal(VERB, lockDir)),
			},
		);
	});
