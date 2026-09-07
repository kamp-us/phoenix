/**
 * `lane settle` — record the terminal the board's own closure proves, on a lane whose own flow never
 * reached one.
 *
 * Two shapes of stranded ledger, one verb. Lane 5983 sat parked at `blocked` while its issue closed
 * `not_planned`, with no artifact owed and no legal event to end it. The hand-shipped lanes sit in
 * `build` or `review` while their issue closed `completed` over a merged PR the lane's own flow never
 * recorded. In both, `DONE` claims an open PR that is not there, `BLOCKED` only parks, and
 * `UNBLOCKED` resumes work that is already over — so the only remedy was `rm -rf` on the lane
 * directory, which erases an append-only history instead of recording an outcome. This verb appends
 * one line instead, and moves nothing on disk.
 *
 * **The board read is the whole entitlement**, because both terminals are proven from nothing on
 * disk. `not_planned`/`duplicate` records `CANCELLED`; `completed` PLUS at least one merged pull
 * request linking the issue records `LANDED`, carrying those pull requests and their merge commit as
 * the line's evidence. An open issue refuses at {@link ISSUE_LIVE}. A `completed` close with no
 * merged linking PR is UNKNOWN, not a landing — the board says somebody called it done and names
 * nothing that did it, so what discharged the lane is genuinely unread.
 *
 * **A live claim is protected.** A lane another session is driving is not one to end underneath it,
 * so an authorized lane-claim marker refuses unless the caller names that very token. An unreadable
 * claim thread is UNKNOWN, never "unclaimed".
 *
 * The gate order is a cost decision, the shape `lane archive` set: everything local runs first — the
 * load, the fold, and whether this lane already carries a terminal — so a lane with nothing to settle
 * costs no board read, and the pull requests are read only on the arm that needs them.
 *
 * `DONE`'s own proof semantics are untouched: this appends neither `DONE` nor any operator event.
 * See ADR 0365.
 */
import {Effect, FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type Claimants, readClaimants} from "../build/claim.ts";
import {appendText} from "../io/fs.ts";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {getPullRequest} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {LANE_CLAIM} from "./claim.ts";
import {
	APPEND_UNKNOWN,
	CLAIM_NOT_MINE,
	CONCURRENT_WRITE,
	EVENT_REFUSED,
	ISSUE_LIVE,
	ISSUE_UNRESOLVED,
	LANE_UNREADABLE,
	TASK_UNKNOWN,
} from "./codes.ts";
import {applyBoardTerminal, foldLog, resolveTask, type SettlementEvidence} from "./fold.ts";
import {CANCELLED_EVENT} from "./machine.ts";
import {type Nomination, nominatePulls} from "./nominate.ts";
import type {PullFact} from "./prove.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {entitlement} from "./settle.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane settle";

/** One issue's closure as the board states it — `reason` is GitHub's own `state_reason`. */
export type IssueClosure =
	| {readonly _tag: "Read"; readonly state: "open" | "closed"; readonly reason: string | null}
	| {readonly _tag: "Unknown"; readonly reason: string};

export type ClosureReader<R> = (issue: number) => Effect.Effect<IssueClosure, never, R>;

/** The issue's candidate pull requests, read only on the completed-close arm. */
export type PullsReader<R> = (issue: number) => Effect.Effect<Nomination, never, R>;

/** Who holds this lane's issue on the board; the reader a caller passes so tests need no network. */
export type ClaimsReader<R> = (issue: number) => Effect.Effect<Claimants, never, R>;

/** The merge commit one merged pull request left, or `null` where the board published none. */
export type ShaReader<R> = (pr: number) => Effect.Effect<string | null, never, R>;

/**
 * The board-backed readers.
 *
 * Readers the caller passes rather than seams this verb reaches through, the shape `lane archive`
 * and `lane migrate` established: every refusal above is then testable offline, and an unreadable
 * board stays UNKNOWN instead of collapsing into an open issue, an unclaimed one, or a landing.
 */
export const boardReaders = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): {
	readonly closure: ClosureReader<ChildProcessSpawner.ChildProcessSpawner>;
	readonly pulls: PullsReader<ChildProcessSpawner.ChildProcessSpawner>;
	readonly claims: ClaimsReader<ChildProcessSpawner.ChildProcessSpawner>;
	readonly sha: ShaReader<ChildProcessSpawner.ChildProcessSpawner>;
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
				const record = yield* getIssue(name, issue);
				if (record._tag !== "Present") {
					return {
						_tag: "Unknown" as const,
						reason:
							record._tag === "Absent"
								? `#${issue} is not present on ${name}`
								: `cannot read #${issue}: ${record.reason}`,
					};
				}
				return {
					_tag: "Read" as const,
					state: record.value.state === "closed" ? ("closed" as const) : ("open" as const),
					reason: record.value.stateReason,
				};
			}),
		pulls: (issue) =>
			Effect.gen(function* () {
				const name = yield* target;
				if (name === null) {
					return {_tag: "Unreadable" as const, what: "the target repo", reason: noRepo};
				}
				return yield* nominatePulls(name, issue, "open-or-merged");
			}),
		claims: (issue) =>
			Effect.gen(function* () {
				const name = yield* target;
				if (name === null) return {_tag: "Unknown" as const, reason: noRepo};
				return yield* readClaimants(name, issue, LANE_CLAIM);
			}),
		// A merge commit is evidence and never an entitlement, so a read that cannot answer leaves the
		// line without a `sha` rather than refusing a landing the closure already proved.
		sha: (pr) =>
			Effect.gen(function* () {
				const name = yield* target;
				if (name === null) return null;
				const record = yield* getPullRequest(name, pr);
				return record._tag === "Present" ? record.value.mergeCommitSha : null;
			}),
	};
};

export interface SettleOptions<R = never> extends LaneRef {
	/** The issue this lane drives, or `null` for a key that names none. */
	readonly issue: number | null;
	/** The task the terminal addresses; `null` resolves only on a single-task lane. */
	readonly task: string | null;
	/** The lane-claim token, when this caller is the driver holding the lane; `null` otherwise. */
	readonly token: string | null;
	readonly closure: ClosureReader<R>;
	readonly pulls: PullsReader<R>;
	readonly claims: ClaimsReader<R>;
	readonly sha: ShaReader<R>;
}

export const runSettle = <R = never>(
	options: SettleOptions<R>,
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
						`${VERB}: "${options.lane}" names no issue, and settling a lane stands on that issue's own closure — a chore lane can never satisfy it. Nothing was appended.`,
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

				// The offline gate first: whether there is anything here to settle is a fact about the fold
				// alone, so a lane already carrying a terminal never costs a board read. Which terminal it
				// would take is the board's, and both take the same route through the machine.
				const at = yield* Effect.sync(() => new Date().toISOString());
				const dry = applyBoardTerminal(
					loaded.lane,
					fold.states,
					task.taskId,
					CANCELLED_EVENT,
					{outcome: "not_planned"},
					at,
				);
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
				if (read.state === "open") {
					return refuse(
						ISSUE_LIVE,
						`${VERB}: #${issue} is open, so this lane is live work — drive it, or close the issue first. Nothing was appended.`,
					);
				}
				// Read only on the arm that needs them: a cancellation stands on the closure alone.
				let facts: ReadonlyArray<PullFact> | null = null;
				if (read.reason === "completed") {
					const nominated = yield* options.pulls(issue);
					if (nominated._tag === "Unreadable") {
						return refuse(
							LANE_UNREADABLE,
							`${VERB}: cannot read ${nominated.what}: ${nominated.reason} — what landed for #${issue} is UNKNOWN, and the log is unappended.`,
						);
					}
					facts = nominated.pulls;
				}
				const entitled = entitlement(issue, read.state, read.reason, facts);
				if (entitled._tag === "Unknown") {
					return refuse(
						LANE_UNREADABLE,
						`${VERB}: ${entitled.reason} — UNKNOWN, and the log is unappended.`,
					);
				}
				if (entitled._tag === "Live") {
					return refuse(
						ISSUE_LIVE,
						`${VERB}: #${issue} is open, so this lane is live work — drive it, or close the issue first. Nothing was appended.`,
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

				let evidence: SettlementEvidence = {outcome: entitled.outcome};
				if (entitled._tag === "Landed") {
					const first = entitled.landed[0];
					const sha = first === undefined ? null : yield* options.sha(first);
					evidence = {
						outcome: entitled.outcome,
						landed: entitled.landed,
						...(sha === null ? {} : {sha}),
					};
				}
				const applied = applyBoardTerminal(
					loaded.lane,
					fold.states,
					task.taskId,
					entitled.event,
					evidence,
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
						`${VERB}: the append to ${loaded.logPath} did not land: ${wrote.failure.reason} — the terminal is NOT recorded.`,
					);
				}
				return answer(
					JSON.stringify(
						{
							answer: "settled",
							lane: options.lane,
							issue,
							previous: applied.previous.stateValue,
							event: applied.entry.event,
							current: applied.current.stateValue,
							taskAffected: task.taskId,
							outcome: entitled.outcome,
							...(evidence.landed === undefined ? {} : {landed: evidence.landed}),
							...(evidence.sha === undefined ? {} : {sha: evidence.sha}),
						},
						null,
						2,
					),
					[
						`${VERB}: appended ${applied.entry.event} to ${loaded.logPath}; #${issue} is closed as ${entitled.outcome}${
							evidence.landed === undefined
								? ""
								: ` over ${evidence.landed.map((pr) => `#${pr}`).join(", ")}`
						}.`,
						`${VERB}: the lane is terminal at "${String(applied.current.stateValue)}" and holds no seat — the directory stays where it is, and \`fabrika lane history ${options.lane}\` still reads its whole log.`,
					],
				);
			}),
			(lockDir) => refuse(CONCURRENT_WRITE, lockedRefusal(VERB, lockDir)),
		);
	});
