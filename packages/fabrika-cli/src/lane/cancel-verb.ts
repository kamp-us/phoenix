/**
 * `lane cancel` — record the cancellation terminal on a lane whose issue the board dropped.
 *
 * The route for lane 5983's shape: an issue closed `not_planned` or `duplicate` while its lane sat
 * nonterminal, with no artifact owed and no legal event to end it. `DONE` claims a PR that never
 * existed, `BLOCKED` only parks and `UNBLOCKED` resumes the work the board just dropped — so the
 * only remedy was `rm -rf` on the lane directory, which erases an append-only history instead of
 * recording an outcome. This verb appends one line instead, and moves nothing on disk.
 *
 * **The board read is the whole entitlement**, because a cancellation is the one lane terminal with
 * no artifact behind it. An open issue refuses at {@link ISSUE_LIVE}; a `completed` close refuses at
 * {@link CLOSURE_LANDED} and names the shipped path (`lane reconcile`, then `lane archive`), since
 * saying "cancelled" about work that shipped is the opposite of what the board says; and a read that
 * failed, or a closure nobody can classify, is UNKNOWN with the log unappended.
 *
 * **A live claim is protected.** A lane another session is driving is not one to end underneath it,
 * so an authorized lane-claim marker refuses unless the caller names that very token. An unreadable
 * claim thread is UNKNOWN, never "unclaimed".
 *
 * The gate order is a cost decision, the shape `lane archive` set: everything local runs first — the
 * load, the fold, and whether this lane already carries a terminal — so a lane with nothing to
 * cancel costs no board read at all.
 */
import {Effect, FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type Claimants, readClaimants} from "../build/claim.ts";
import {appendText} from "../io/fs.ts";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {entitlement} from "./cancel.ts";
import {LANE_CLAIM} from "./claim.ts";
import {
	APPEND_UNKNOWN,
	CLAIM_NOT_MINE,
	CLOSURE_LANDED,
	CONCURRENT_WRITE,
	EVENT_REFUSED,
	ISSUE_LIVE,
	ISSUE_UNRESOLVED,
	LANE_UNREADABLE,
	TASK_UNKNOWN,
} from "./codes.ts";
import {applyCancellation, foldLog, resolveTask} from "./fold.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane cancel";

/** One issue's closure as the board states it — `reason` is GitHub's own `state_reason`. */
export type IssueClosure =
	| {readonly _tag: "Read"; readonly state: "open" | "closed"; readonly reason: string | null}
	| {readonly _tag: "Unknown"; readonly reason: string};

export type ClosureReader<R> = (issue: number) => Effect.Effect<IssueClosure, never, R>;

/** Who holds this lane's issue on the board; the reader a caller passes so tests need no network. */
export type ClaimsReader<R> = (issue: number) => Effect.Effect<Claimants, never, R>;

/**
 * The board-backed pair of readers.
 *
 * Both are readers the caller passes rather than seams this verb reaches through, the shape
 * `lane archive` and `lane migrate` established: every refusal above is then testable offline, and
 * an unreadable board stays UNKNOWN instead of collapsing into an open issue or an unclaimed one.
 */
export const boardReaders = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): {
	readonly closure: ClosureReader<ChildProcessSpawner.ChildProcessSpawner>;
	readonly claims: ClaimsReader<ChildProcessSpawner.ChildProcessSpawner>;
} => {
	let resolved: string | null = null;
	const target = Effect.gen(function* () {
		if (resolved !== null) return resolved;
		const attempt = yield* resolveRepo(repo, env);
		if (attempt._tag === "Failure") return null;
		resolved = attempt.value;
		return resolved;
	});
	const noRepo = "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name";
	return {
		closure: (issue) =>
			Effect.gen(function* () {
				const name = yield* target;
				if (name === null) return {_tag: "Unknown" as const, reason: noRepo};
				return yield* getIssueRecord(name, issue);
			}),
		claims: (issue) =>
			Effect.gen(function* () {
				const name = yield* target;
				if (name === null) return {_tag: "Unknown" as const, reason: noRepo};
				return yield* readClaimants(name, issue, LANE_CLAIM);
			}),
	};
};

const getIssueRecord = (
	repo: string,
	issue: number,
): Effect.Effect<IssueClosure, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const record = yield* getIssue(repo, issue);
		if (record._tag !== "Present") {
			return {
				_tag: "Unknown" as const,
				reason:
					record._tag === "Absent"
						? `#${issue} is not present on ${repo}`
						: `cannot read #${issue}: ${record.reason}`,
			};
		}
		return {
			_tag: "Read" as const,
			state: record.value.state === "closed" ? ("closed" as const) : ("open" as const),
			reason: record.value.stateReason,
		};
	});

export interface CancelOptions<R = never> extends LaneRef {
	/** The issue this lane drives, or `null` for a key that names none. */
	readonly issue: number | null;
	/** The task the cancellation addresses; `null` resolves only on a single-task lane. */
	readonly task: string | null;
	/** The lane-claim token, when this caller is the driver holding the lane; `null` otherwise. */
	readonly token: string | null;
	readonly closure: ClosureReader<R>;
	readonly claims: ClaimsReader<R>;
}

export const runCancel = <R = never>(
	options: CancelOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return yield* withLedgerLock(
			{fs, path, dir: path.join(options.root, options.lane), verb: VERB},
			Effect.gen(function* () {
				const {issue} = options;
				if (issue === null) {
					return refuse(
						ISSUE_UNRESOLVED,
						`${VERB}: "${options.lane}" names no issue, and a cancellation stands on that issue reading closed as not planned or duplicate — a chore lane can never satisfy it. Nothing was appended.`,
					);
				}
				const loaded = yield* loadLane(options);
				if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
				const task = resolveTask(loaded.lane, options.task);
				if (task._tag === "Unresolved") {
					return refuse(TASK_UNKNOWN, `${VERB}: ${task.reason}`);
				}
				const fold = foldLog(loaded.lane, loaded.entries);
				if (fold._tag !== "Folded") return replayRefusal(VERB, loaded.logPath, fold);

				// The offline gates first, with a placeholder outcome: whether there is anything here to
				// cancel is a fact about the fold alone, so a lane already carrying a terminal never costs
				// a board read. The outcome the board proves is applied on the second call below.
				const at = yield* Effect.sync(() => new Date().toISOString());
				const dry = applyCancellation(loaded.lane, fold.states, task.taskId, "not_planned", at);
				if (dry._tag === "Refused") {
					return refuse(EVENT_REFUSED, `${VERB}: refused (log unappended): ${dry.reason}.`);
				}

				const read = yield* options.closure(issue);
				if (read._tag === "Unknown") {
					return refuse(
						LANE_UNREADABLE,
						`${VERB}: cannot establish how #${issue} closed: ${read.reason} — UNKNOWN, and the log is unappended.`,
					);
				}
				const entitled = entitlement(read.state, read.reason);
				if (entitled._tag === "Unknown") {
					return refuse(
						LANE_UNREADABLE,
						`${VERB}: ${entitled.reason} — UNKNOWN, and the log is unappended.`,
					);
				}
				if (entitled._tag === "Live") {
					return refuse(
						ISSUE_LIVE,
						`${VERB}: #${issue} is open, so this lane is live work nobody dropped — drive it, or close the issue as not planned first. Nothing was appended.`,
					);
				}
				if (entitled._tag === "Landed") {
					return refuse(
						CLOSURE_LANDED,
						`${VERB}: #${issue} closed as completed — the work landed, and calling that a cancellation says the opposite of what the board says. Bring the ledger to the board with \`fabrika lane reconcile\`, then \`fabrika lane archive ${options.lane}\`. Nothing was appended.`,
					);
				}

				const claimed = yield* options.claims(issue);
				if (claimed._tag === "Unknown") {
					return refuse(
						LANE_UNREADABLE,
						`${VERB}: cannot establish whether #${issue} carries a live lane claim: ${claimed.reason} — UNKNOWN, never "unclaimed", and the log is unappended.`,
					);
				}
				const holder = claimed.holder;
				if (holder !== null && holder.token !== options.token) {
					return refuse(
						CLAIM_NOT_MINE,
						`${VERB}: #${issue} carries the live lane claim ${holder.token} — a lane another session is driving is not one to end underneath it. Pass --token ${holder.token} if that driver is you, or clear the seat through \`fabrika lane adopt ${options.lane}\` then \`fabrika lane release\`. Nothing was appended.`,
					);
				}

				const applied = applyCancellation(
					loaded.lane,
					fold.states,
					task.taskId,
					entitled.outcome,
					at,
				);
				if (applied._tag === "Refused") {
					return refuse(EVENT_REFUSED, `${VERB}: refused (log unappended): ${applied.reason}.`);
				}
				const wrote = yield* Effect.result(
					appendText(loaded.logPath, `${JSON.stringify(applied.entry)}\n`),
				);
				if (Result.isFailure(wrote)) {
					return refuse(
						APPEND_UNKNOWN,
						`${VERB}: the append to ${loaded.logPath} did not land: ${wrote.failure.reason} — the cancellation is NOT recorded.`,
					);
				}
				return answer(
					JSON.stringify(
						{
							answer: "cancelled",
							lane: options.lane,
							issue,
							previous: applied.previous.stateValue,
							event: applied.entry.event,
							current: applied.current.stateValue,
							taskAffected: task.taskId,
							outcome: entitled.outcome,
						},
						null,
						2,
					),
					[
						`${VERB}: appended ${applied.entry.event} to ${loaded.logPath}; #${issue} is closed as ${entitled.outcome}.`,
						`${VERB}: the lane is terminal at "${String(applied.current.stateValue)}" and holds no seat — the directory stays where it is, and \`fabrika lane history ${options.lane}\` still reads its whole log.`,
					],
				);
			}),
			(lockDir) => refuse(CONCURRENT_WRITE, lockedRefusal(VERB, lockDir)),
		);
	});
