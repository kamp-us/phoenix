/**
 * `lane dispatched` and `lane working` — the two writers of the in-flight record
 * ([`in-flight.ts`](in-flight.ts)).
 *
 * The driver runs `lane dispatched` before it spawns a stage shell; the builder runs `lane working`
 * once its build claim wins. Each appends one record, never an event, so the fold cannot be moved by
 * either, and each takes the ledger lock so it cannot interleave with a writer of the same lane.
 * The state a record names is read off the fold rather than taken from the caller, so a dispatch
 * cannot claim a shell the task's state routes nowhere.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10232
 */
import {Effect, FileSystem, Path, Result} from "effect";
import {parseToken} from "../build/lane.ts";
import {appendText} from "../io/fs.ts";
import type {Attempt} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {isBuildState, type ShellState, shellOf, shellState} from "../wire/lane-brief.ts";
import {type Instant, instant} from "../wire/lane-record.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {
	APPEND_UNKNOWN,
	CONCURRENT_WRITE,
	FACT_REFUSED,
	LANE_UNREADABLE,
	MALFORMED_RECORD,
	NO_SHELL,
	TASK_UNKNOWN,
} from "./codes.ts";
import {foldLog, resolveTask} from "./fold.ts";
import {encodeInFlight, type InFlightRecord, loadInFlight} from "./in-flight.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

/** The fact a writer composed off the task's folded state, or the refusal saying why it would not. */
type Composed<F extends InFlightRecord> =
	| {readonly _tag: "Fact"; readonly fact: F}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * Append the fact `compose` builds off the task's folded state, under the ledger lock.
 *
 * `compose` sees the state after the fold, so a writer can refuse a state its shell does not serve
 * before anything is written.
 */
const appendInFlight = <F extends InFlightRecord>(
	verb: string,
	ref: LaneRef,
	task: string | null,
	compose: (task: string, state: ShellState, at: Instant) => Composed<F>,
	told: (fact: F) => VerbOutcome,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return yield* withLedgerLock(
			{fs, path, dir: path.join(ref.root, ref.lane), verb},
			Effect.gen(function* () {
				const loaded = yield* loadLane(ref);
				if (loaded._tag !== "Loaded") return loadRefusal(verb, loaded);
				const fold = foldLog(loaded.lane, loaded.entries);
				if (fold._tag !== "Folded") return replayRefusal(verb, loaded.logPath, fold);
				const resolved = resolveTask(loaded.lane, task);
				if (resolved._tag !== "Task") {
					return refuse(TASK_UNKNOWN, `${verb}: ${resolved.reason}. Nothing was appended.`);
				}
				const leaf = fold.states[resolved.taskId]?.type ?? "";
				const state = shellState(leaf);
				if (state === null) {
					return refuse(
						NO_SHELL,
						`${verb}: task "${resolved.taskId}" is "${leaf}", which routes to no shell — no shell is in flight there. Nothing was appended.`,
					);
				}
				const standing = yield* loadInFlight(loaded.dir);
				if (standing._tag === "Unreadable") {
					return refuse(
						LANE_UNREADABLE,
						`${verb}: cannot read ${standing.path}: ${standing.reason} — nothing was appended.`,
					);
				}
				if (standing._tag === "Malformed") {
					return refuse(
						MALFORMED_RECORD,
						`${verb}: ${standing.path} was read in full and is not the shape — nothing was appended.`,
						standing.defects.map((defect) => `${verb}: defect: ${defect}`),
					);
				}
				const at = instant(yield* Effect.sync(() => new Date().toISOString()));
				if (at === null) {
					return refuse(FACT_REFUSED, `${verb}: the clock gave no instant — nothing was appended.`);
				}
				const composed = compose(resolved.taskId, state, at);
				if (composed._tag === "Refused") return composed.outcome;
				const {fact} = composed;
				const wrote = yield* Effect.result(appendText(standing.path, encodeInFlight(fact)));
				if (Result.isFailure(wrote)) {
					return refuse(
						APPEND_UNKNOWN,
						`${verb}: the append to ${standing.path} did not land: ${wrote.failure.reason} — the record is NOT written.`,
					);
				}
				return told(fact);
			}),
			{
				onAbsent: (absentDir) => loadRefusal(verb, {_tag: "Absent", dir: absentDir}),
				onLocked: (lockDir) => refuse(CONCURRENT_WRITE, lockedRefusal(verb, lockDir)),
			},
		);
	});

const DISPATCHED = "fabrika lane dispatched";

export interface DispatchedOptions extends LaneRef {
	readonly task: string | null;
}

/** Record that the driver is about to spawn the shell the task's state routes to. */
export const runDispatched = (
	options: DispatchedOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	appendInFlight(
		DISPATCHED,
		options,
		options.task,
		(task, state, at) => ({_tag: "Fact", fact: {kind: "dispatched", task, state, at} as const}),
		(fact) =>
			answer(
				JSON.stringify({
					answer: "dispatched",
					lane: options.lane,
					task: fact.task,
					state: fact.state,
					shell: shellOf(fact.state),
					at: fact.at,
				}),
				[
					`${DISPATCHED}: lane ${options.lane} task "${fact.task}" — a ${shellOf(fact.state)} is dispatched to "${fact.state}".`,
				],
			),
	);

const WORKING = "fabrika lane working";

export interface WorkingOptions extends LaneRef {
	readonly task: string | null;
	/** The build claim token `build claim` answered `won` with. */
	readonly token: string;
	/** The tree this process runs in, read off git by the adapter. */
	readonly worktree: Attempt<string>;
}

/** Record the builder's claim token and the worktree it builds in, on the task it serves. */
export const runWorking = (
	options: WorkingOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (parseToken(options.token) === null) {
			return refuse(
				FACT_REFUSED,
				`${WORKING}: --token "${options.token}" is not a build claim token — pass the token \`build claim\` answered \`won\` with. Nothing was appended.`,
			);
		}
		if (options.worktree._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${WORKING}: cannot read which tree this runs in: ${options.worktree.reason} — nothing was appended.`,
			);
		}
		const worktree = options.worktree.value;
		if (!(yield* Path.Path).isAbsolute(worktree)) {
			return refuse(
				FACT_REFUSED,
				`${WORKING}: the tree "${worktree}" is not an absolute path. Nothing was appended.`,
			);
		}
		return yield* appendInFlight(
			WORKING,
			options,
			options.task,
			(task, state, at) =>
				isBuildState(state)
					? {
							_tag: "Fact",
							fact: {kind: "working", task, token: options.token, worktree, at} as const,
						}
					: {
							_tag: "Refused",
							outcome: refuse(
								NO_SHELL,
								`${WORKING}: task "${task}" is "${state}", which a ${shellOf(state)} serves, not a builder. Nothing was appended.`,
							),
						},
			(fact) =>
				answer(
					JSON.stringify({
						answer: "working",
						lane: options.lane,
						task: fact.task,
						token: fact.token,
						worktree: fact.worktree,
						at: fact.at,
					}),
					[`${WORKING}: lane ${options.lane} task "${fact.task}" is worked in ${fact.worktree}.`],
				),
		);
	});
