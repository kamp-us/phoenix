/**
 * `lane report` — a shell records its own terminal token, mapped to one operator event in code.
 *
 * The channel between a shell and the ledger used to be prose the operator re-read out of a
 * transcript; this verb closes it: token in, [`report.ts`](report.ts)'s map picks the event, and
 * the append rides `transition`'s exact path — validate against the folded state FIRST, append only
 * what the machine accepts, refuse everything else with the log left byte-identical. The optional
 * `--pr`/`--comment` refs land on the event line itself, so an event names its evidence at the
 * moment the shell knows the URL. One more field lands there and it is the prover's rather than the
 * caller's: `deferred`, relayed off the proof's own answer and never recomposed here, says this
 * `PASS` was proven over a set short the namespaces named — the routed `review-ui` an epic child
 * hands to its epic's tail, which nothing else in the ledger records. `partial` is the second of
 * that kind and rides the ship stage's `DONE`: it says whether the merge behind this terminal
 * carried `Part of #N` and left the issue open, which is the whole input to the machine's
 * `merge:partial` arm. It rides at both polarities — a closing merge records `partial: false` — so
 * the line says the closure was read rather than leaving a later sweep to read it again. `landed`
 * is that read's evidence and rides beside it: the merged PRs the closure judged, so a recorded
 * `false` says which reader wrote it and not only which way it fell. `diagnosis` is the third and
 * rides a `DONE` out of build: it says this terminal was proven off a diagnosis comment rather than
 * a pull request, which is what the machine's `done:diagnosis` arm carries an investigation to its
 * own terminal on instead of the review it opened nothing for. It rides at `true` only, because the
 * three builder terminals that reach this verb all report one `DONE` and only the prover can tell
 * them apart.
 *
 * **A queue wait is floored as well as counted.** A `ship:queued` re-fold that arrives before
 * `WAIT_FLOOR_SECONDS` of elapsed time since the task's last line is refused at `WAIT_TOO_SOON` with
 * the log byte-identical, so the wait budget measures how long a PR has sat rather than how fast a
 * driver passes.
 *
 * **One token names two events, and the proof picks.** `ROUTED-ELSEWHERE` out of `review:ui` is
 * [`report.ts`](report.ts)'s one {@link PROOF_CONDITIONAL_TERMINALS} row: a published head-bound
 * route beside a complete set of binding verdicts is a *finished* review, so the terminal records
 * the `PASS` that finish earns instead of a park the board itself contradicts. The advanced arm is
 * tried, never assumed — the lane's own machine must hold the transition and `lane prove` must earn
 * it unmodified — and every shortfall falls through to the park the flat table maps, byte-for-byte
 * as before. `routed` rides the line that lands, so the ledger says the `PASS` stood on a route
 * rather than on a rendered verdict nobody wrote.
 *
 * **The append is proof-gated.** A token is still a self-report, and moving the recorder from the
 * operator into the shell must not move the bar: between the machine's acceptance and the append
 * this verb runs the same read `lane prove` runs, so a `DONE` and a `PASS` enter the ledger with
 * their artifact behind them or not at all, a reviewer's park enters it only while no `FAIL` at the
 * head says the run reached a verdict, and every other event answers `not-required` — or
 * `not-walkable`, where this lane's machine walks no such event out of the task's leaf — without
 * a board read. A refusal is returned on the prover's own code, log untouched — the codes and their
 * remedies are `lane prove`'s, unchanged. The prover is a parameter so this verb's unit tier stays
 * offline; the CLI always hands it `runProve`, which is the only prover a shell ever invokes.
 */
import {Effect, FileSystem, Path, Result} from "effect";
import type {ParkCauseSurface} from "../config/keys/park-cause.ts";
import type {Read} from "../config/read-key.ts";
import {appendText} from "../io/fs.ts";
import {ANSWER, answer, refuse, type VerbOutcome} from "../verb.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {
	APPEND_UNKNOWN,
	CAUSE_UNRECOGNISED,
	CLASS_UNRECOGNISED,
	CONCURRENT_WRITE,
	EVENT_REFUSED,
	PARK_UNCAUSED,
	TASK_UNKNOWN,
	TOKEN_UNRECOGNISED,
	WAIT_TOO_SOON,
} from "./codes.ts";
import {applyEvent, foldLog, type LogEntry, resolveTask} from "./fold.ts";
import type {CompiledLane, OperatorEvent, TaskState} from "./machine.ts";
import {parkCauseRefusal} from "./park-cause-rule.ts";
import {gateOnProof} from "./proof-gate.ts";
import type {ProofOutcome, ProveOptions} from "./prove-verb.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {
	type ConditionalTerminal,
	causeForEvent,
	classesForEvent,
	conditionalTerminal,
	eventForToken,
	floorQueueWait,
	machineryCause,
} from "./report.ts";
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
	/** Why the lane parked, from the closed set in [`report.ts`](report.ts); `BLOCKED` only. */
	readonly cause: string | null;
	/**
	 * The repo's declared `parkCause`, read by the adapter off the `.fabrika.jsonc` of the repository
	 * that OWNS the cwd — never the cwd's own copy. The rule is weighed against the shared lane ledger,
	 * which a linked worktree and its primary checkout derive alike, so the worktree's tracked copy
	 * would govern a log it does not own.
	 *
	 * Passed in rather than read here, the way `lane open` takes its cap: this verb's append path
	 * stays offline, and the one config read belongs to the adapter that already knows the checkout.
	 */
	readonly parkCause: Read<ParkCauseSurface>;
	/** The lane classes standing at this event, relayed onto the event line. */
	readonly classes: ReadonlyArray<string>;
	/** The target repo the proof reads against, resolved exactly as `lane prove` resolves it. */
	readonly repo: string | null;
	/**
	 * The checkout this run stands in, handed to the proof — not the ledger root, and not where
	 * `.fabrika.jsonc` is read: {@link parkCause} above is resolved off the repository that OWNS this
	 * path, so a linked worktree is judged by the primary checkout's declaration.
	 */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** The leaf a folded task stands in — `""` where the fold holds no state for it. */
const freshLeafOf = (
	fold: Extract<ReturnType<typeof foldLog>, {readonly _tag: "Folded"}>,
	taskId: string,
): string => fold.states[taskId]?.type ?? "";

/**
 * Whether the advanced arm was earned, and the one line that says why either way.
 *
 * `Parked` is not a refusal: the caller falls through to the event its token maps to flat, which is
 * what it recorded before this arm existed. The note is what keeps that legible — a driver reading
 * `blocked` needs told the advance was *tried* and what the board said, or the park looks like the
 * unconditional one it used to be.
 */
type Advance =
	| {
			readonly _tag: "Advanced";
			readonly event: OperatorEvent;
			readonly proof: ProofOutcome;
			readonly note: string;
	  }
	| {readonly _tag: "Parked"; readonly note: string};

interface AdvanceInput<R> {
	readonly prove: (options: ProveOptions) => Effect.Effect<ProofOutcome, never, R>;
	readonly options: ProveOptions;
	readonly lane: CompiledLane;
	readonly states: Readonly<Record<string, TaskState>>;
	readonly taskId: string;
	readonly at: string;
	readonly classes: ReadonlyArray<string> | null;
	readonly conditional: ConditionalTerminal;
	readonly token: string;
}

/**
 * Try the advanced event, and answer `Parked` on anything short of a clean proof.
 *
 * Two gates and both are the ordinary ones. The machine must hold the transition out of this cell —
 * a lane whose own `workflow.json` has no such arm never advances, which is how a foreign machine
 * and an epic child's region are covered without naming either. Then the proof is `lane prove`'s,
 * run unmodified for the advanced event: nothing here relaxes a floor, subtracts a namespace or
 * reads a route the prover would not have read on its own.
 */
const tryAdvance = <R>(input: AdvanceInput<R>): Effect.Effect<Advance, never, R> =>
	Effect.gen(function* () {
		const walkable = applyEvent(
			input.lane,
			input.states,
			input.taskId,
			input.conditional.advanced,
			input.at,
			input.classes,
			null,
			null,
			null,
			null,
		);
		if (walkable._tag === "Refused") {
			return {
				_tag: "Parked",
				note: `${VERB}: ${input.token} could advance this task to ${input.conditional.advanced}, but this lane's own machine holds no such arm out of "${input.conditional.leaf}" — recording the park instead.`,
			};
		}
		const proof = yield* input.prove(input.options);
		if (proof.code !== ANSWER) {
			return {
				_tag: "Parked",
				note: `${VERB}: ${input.token} advances to ${input.conditional.advanced} only where ${input.conditional.earns}; the proof answered exit ${proof.code}, so the park stands and nothing was widened.`,
			};
		}
		return {
			_tag: "Advanced",
			event: input.conditional.advanced,
			proof,
			note: `${VERB}: ${input.token} is proven complete — ${input.conditional.earns} — so it records ${input.conditional.advanced} rather than the park. No rendered verdict was written or assumed.`,
		};
	});

export const runReport = <R>(
	options: ReportOptions,
	prove: (options: ProveOptions) => Effect.Effect<ProofOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path | R> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const resolved = eventForToken(options.token);
		if (resolved._tag === "Unrecognised") {
			return refuse(TOKEN_UNRECOGNISED, `${VERB}: refused (log unappended): ${resolved.reason}`);
		}
		const rule = parkCauseRefusal(VERB, options.parkCause);
		if (rule._tag === "Refused") return rule.outcome;
		const caused = causeForEvent(
			options.cause ?? machineryCause(resolved.token),
			resolved.event,
			rule.requireCause,
		);
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
		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		const task = resolveTask(loaded.lane, options.task);
		if (task._tag === "Unresolved") {
			return refuse(TASK_UNKNOWN, `${VERB}: ${task.reason}`);
		}
		const fold = foldLog(loaded.lane, loaded.entries);
		if (fold._tag !== "Folded") return replayRefusal(VERB, loaded.logPath, fold);

		const leaf = fold.states[task.taskId]?.type ?? "";
		const conditional = conditionalTerminal(resolved.token, leaf);
		const proveOptions = (event: OperatorEvent) => ({
			root: options.root,
			lane: options.lane,
			event,
			task: task.taskId,
			// The same classes the append carries, so the proof asks about the arm this event actually
			// takes rather than the one the lane stood on before it.
			classes: classed.classes,
			// The ship stage's closure is read off this very PR, so the ref has to reach the proof and
			// not only the line it lands on — nominating for it cannot see a merged `Part of #N`.
			pr: options.pr,
			repo: options.repo,
			cwd: options.cwd,
			env: options.env,
		});

		const at = yield* Effect.sync(() => new Date().toISOString());
		// The advanced arm is **tried**, never assumed: the machine must hold the transition and the
		// ordinary proof must earn it. Every refusal falls through to the parked event this token maps
		// to flat, which is byte-for-byte what it recorded before the conditional row existed — so a
		// missing, stale, unauthorized or unreadable route, an outstanding review or a standing FAIL
		// all park exactly as they did, and only a proof nobody had to weaken advances the lane.
		const attempt =
			conditional === null
				? null
				: yield* tryAdvance({
						prove,
						options: proveOptions(conditional.advanced),
						lane: loaded.lane,
						states: fold.states,
						taskId: task.taskId,
						at,
						classes: classed.classes,
						conditional,
						token: resolved.token,
					});
		const advanced = attempt?._tag === "Advanced" ? attempt : null;
		const event: OperatorEvent = advanced?.event ?? resolved.event;
		// A cause names why a lane parked, so the advanced arm carries none — and the caller is not
		// refused for having passed one, because at the moment it typed the flag the park was the only
		// reading its token had. The line records the route instead.
		const cause = advanced === null && caused._tag === "Caused" ? caused.cause : null;

		const applied = applyEvent(
			loaded.lane,
			fold.states,
			task.taskId,
			event,
			at,
			classed.classes,
			null,
			null,
			null,
			cause,
		);
		if (applied._tag === "Refused") {
			return refuse(EVENT_REFUSED, `${VERB}: refused (log unappended): ${applied.reason}`);
		}

		// The proof runs BEFORE the lock: it is read-only over the artifacts, never over the lane's
		// bytes, so holding writers up behind a slow board read buys nothing. What the lock
		// covers is the authoritative second pass below, where a fresh fold decides and appends.
		const gated =
			advanced === null
				? yield* gateOnProof(
						VERB,
						prove,
						proveOptions(event),
						`the ${event} behind token ${resolved.token}`,
					)
				: ({_tag: "Proven", proof: advanced.proof} as const);
		if (gated._tag === "Refused") return gated.outcome;
		const proved = gated.proof;
		const conditionalNotes = attempt === null ? [] : [attempt.note];

		// Authoritative pass, inside the write lock: a fresh load → fold → validate → append against
		// the bytes as they exist under the lock, so a shell recording its terminal cannot validate
		// against a state another writer is about to move under it. The pre-lock pass above
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

				// The conditional reading is keyed on the leaf, so it is re-read under the lock for the
				// reason the fold is: a task another writer moved out of `review:ui` between the proof and
				// the append is not the task this event was proven for, and recording the advanced arm
				// there would spend a proof on a cell it never stood in.
				if (
					advanced !== null &&
					conditionalTerminal(resolved.token, freshLeafOf(freshFold, freshTask.taskId)) === null
				) {
					return refuse(
						EVENT_REFUSED,
						`${VERB}: refused (log unappended): task "${freshTask.taskId}" left "${leaf}" while ${resolved.token}'s ${advanced.event} was being proven — re-read the lane and report again.`,
					);
				}

				const now = yield* Effect.sync(() => new Date().toISOString());
				// The floor is read here and not in the pre-lock pass because the line it measures from is
				// exactly what a concurrent writer moves: a re-fold that cleared the floor before the lock
				// has not cleared it after another lane's wait landed under it.
				const floored = floorQueueWait({
					lane: fresh.lane,
					states: freshFold.states,
					taskId: freshTask.taskId,
					event,
					lastAt: fresh.entries.findLast((entry) => entry.task === freshTask.taskId)?.at,
					now,
				});
				if (floored._tag === "TooSoon") {
					return refuse(WAIT_TOO_SOON, `${VERB}: refused (log unappended): ${floored.reason}.`);
				}
				// `partial` reaches only this pass: the pre-lock one runs before the proof that reads it,
				// and it decides nothing — both arms of `merge:partial` hold a cell, so the arm taken
				// cannot turn an acceptance into a refusal. This pass is the one that appends.
				const reapplied = applyEvent(
					fresh.lane,
					freshFold.states,
					freshTask.taskId,
					event,
					now,
					classed.classes,
					null,
					proved.partial,
					proved.diagnosis ? true : null,
					cause,
				);
				if (reapplied._tag === "Refused") {
					return refuse(EVENT_REFUSED, `${VERB}: refused (log unappended): ${reapplied.reason}`);
				}

				const entry: LogEntry = {
					...reapplied.entry,
					...(options.pr === null ? {} : {pr: options.pr}),
					...(options.comment === null ? {} : {comment: options.comment}),
					...(cause === null ? {} : {cause}),
					...(proved.deferred.length === 0 ? {} : {deferred: proved.deferred}),
					...(proved.routed.length === 0 ? {} : {routed: proved.routed}),
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
							token: resolved.token,
							previous: reapplied.previous.stateValue,
							event: entry.event,
							current: reapplied.current.stateValue,
							taskAffected: freshTask.taskId,
							...(options.pr === null ? {} : {pr: options.pr}),
							...(options.comment === null ? {} : {comment: options.comment}),
							...(cause === null ? {} : {cause}),
							...(proved.deferred.length === 0 ? {} : {deferred: proved.deferred}),
							...(proved.routed.length === 0 ? {} : {routed: proved.routed}),
							...(proved.partial === null ? {} : {partial: proved.partial}),
							...(proved.diagnosis ? {diagnosis: true} : {}),
							...(proved.landed.length === 0 ? {} : {landed: proved.landed}),
						},
						null,
						2,
					),
					[
						...conditionalNotes,
						...proved.stderr,
						`${VERB}: appended ${entry.event} (token ${resolved.token}) to ${fresh.logPath}, proven first.`,
					],
				);
			}),
			{
				onAbsent: (dir) => loadRefusal(VERB, {_tag: "Absent", dir}),
				onLocked: (lockDir) => refuse(CONCURRENT_WRITE, lockedRefusal(VERB, lockDir)),
			},
		);
	});
