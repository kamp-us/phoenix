/**
 * `lane amend` — re-derive a running epic's machine from the epic body's current topology, and
 * record that it happened.
 *
 * `lane emit` boots a lane once and refuses to be run over one on disk, so until this verb a plan
 * that changed after emission had two routes and both were bad: retire the directory and re-emit,
 * which discards `events.jsonl` and every landed child's record with it, or hand-drive the rest of
 * the epic outside its own ledger. Both fired on the same day, on the same campaign's epics.
 *
 * **The log is appended to, never rewritten.** The amendment is one {@link AMENDED_EVENT} line
 * naming the task set the re-derived machine holds; every line above it stays exactly as recorded,
 * and the fold drops the amendment before any message reaches a machine. What changes is
 * `workflow.json`, and only where {@link judgeAmendment} proves the change carries the lane's own
 * history intact.
 *
 * **It reconciles nothing.** The `## Dependencies` block is read as it stands — a block naming a
 * child the board has closed is that block's problem, and `fabrika plan restage` is the verb that
 * owns it. Two questions, two verbs, and this one refuses rather than guessing at either.
 *
 * The lap axis is read off the lane's OWN machine rather than off `.fabrika.jsonc`: an amendment
 * changes the topology and nothing else, so a repo that flipped `machineryLaps.onEmit` since the
 * emission must not have that flip land here as a side effect of adding a child.
 */
import {Effect, FileSystem, Path, Result} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber, openIssue, resolveTargetRepo} from "../build/target.ts";
import {appendText, readFile, writeFile} from "../io/fs.ts";
import {listSubIssues} from "../plan/github.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {judgeAmendment} from "./amend.ts";
import {lockedRefusal, withLedgerLock} from "./append-lock.ts";
import {
	AMEND_DROPS_LANDED,
	AMEND_UNREPLAYABLE,
	APPEND_UNKNOWN,
	CONCURRENT_WRITE,
	LANE_UNREADABLE,
	TOPOLOGY_ABSENT,
	TOPOLOGY_CYCLE,
	TOPOLOGY_FOREIGN,
	TOPOLOGY_MALFORMED,
} from "./codes.ts";
import {type EmitResult, emitMachine} from "./emit.ts";
import type {LogEntry} from "./fold.ts";
import {AMENDED_EVENT, type CompiledLane, compileText} from "./machine.ts";
import {sameMachine} from "./migrate.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane, WORKFLOW_FILE} from "./store.ts";

const VERB = "fabrika lane amend";

export interface AmendOptions extends LaneRef {
	/** The epic this lane drives — the lane key as a number, since only an epic lane has a topology. */
	readonly epic: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The `at` the appended amendment carries. */
	readonly now: string;
}

/**
 * Whether this lane's machine carries the machinery lap arms, read off the compiled regions.
 *
 * `lapStates` is empty on every machine emitted with the axis off, and non-empty on every one
 * emitted with it on, so the machine answers for itself and no config read can move it.
 */
const carriesLaps = (lane: CompiledLane): boolean =>
	Object.values(lane.tasks).some((task) => task.lapStates.size > 0);

const emitRefusal = (epic: number, result: Exclude<EmitResult, {_tag: "Emitted"}>): VerbOutcome => {
	switch (result._tag) {
		case "NoTopology":
			return refuse(
				TOPOLOGY_ABSENT,
				`${VERB}: #${epic} carries no readable \`## Dependencies\` topology — there is nothing to amend this lane's machine to.`,
			);
		case "Unparseable":
			return refuse(
				TOPOLOGY_MALFORMED,
				`${VERB}: #${epic}'s topology line ${result.line} does not parse: "${result.text}" — nothing was written. The \`## Dependencies\` section holds only \`- phase <n>: <refs>\` and \`- <ref> requires: <refs>\` lines; editorial or history prose belongs below a \`---\` thematic break, which ends the section.`,
			);
		case "Duplicate":
			return refuse(
				TOPOLOGY_MALFORMED,
				`${VERB}: #${epic}'s topology places #${result.child} in more than one phase — nothing was written.`,
			);
		case "Unplaced":
			return refuse(
				TOPOLOGY_MALFORMED,
				`${VERB}: #${epic}'s topology names #${result.child} in a requires line but places it in no phase — nothing was written.`,
			);
		case "Foreign":
			return refuse(
				TOPOLOGY_FOREIGN,
				`${VERB}: the topology references ${result.ref}, which is not a child of #${epic} — nothing was written.`,
			);
		case "Cycle":
			return refuse(
				TOPOLOGY_CYCLE,
				`${VERB}: the topology holds a cycle: ${result.path.map((n) => `#${n}`).join(" → ")} — nothing was written.`,
			);
	}
};

/** The one line an accepted amendment appends: it moves no task and names the set it left behind. */
export const amendmentEntry = (
	epic: number,
	at: string,
	tasks: ReadonlyArray<string>,
): LogEntry => {
	const task = `epic_${epic}`;
	return {task, event: `${task.toUpperCase()}.${AMENDED_EVENT}`, at, tasks};
};

export const runAmend = (
	options: AmendOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| HttpClient.HttpClient
	| Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const bad = badNumber(VERB, "an issue number", options.epic);
		if (bad !== null) return bad;

		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		const workflowPath = path.join(loaded.dir, WORKFLOW_FILE);
		const onDisk = yield* Effect.result(readFile(workflowPath));
		if (Result.isFailure(onDisk)) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot re-read ${workflowPath}: ${onDisk.failure.reason} — nothing was written.`,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const target = yield* openIssue(
			VERB,
			resolved.repo,
			options.epic,
			(reason) => `${VERB}: cannot read #${options.epic}: ${reason} — nothing was written.`,
		);
		if (target._tag === "Refused") return target.outcome;
		const listed = yield* listSubIssues(resolved.repo, options.epic, options.env);
		if (listed._tag === "Failure") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read #${options.epic}'s children: ${listed.reason} — nothing was written.`,
			);
		}

		const emitted = emitMachine(
			options.epic,
			target.issue.body,
			listed.value,
			carriesLaps(loaded.lane),
		);
		if (emitted._tag !== "Emitted") return emitRefusal(options.epic, emitted);
		if (sameMachine(onDisk.success, emitted.text)) {
			return answer(
				JSON.stringify({
					answer: "current",
					lane: options.lane,
					epic: options.epic,
					workflow: workflowPath,
					tasks: Object.keys(loaded.lane.tasks),
					added: [],
					dropped: [],
				}),
				[
					`${VERB}: #${options.epic}'s topology already derives the machine this lane runs — nothing was appended and nothing was written.`,
				],
			);
		}
		const candidate = compileText(emitted.text);
		if (candidate._tag === "Malformed") {
			return refuse(
				TOPOLOGY_MALFORMED,
				`${VERB}: the machine #${options.epic}'s topology derives does not compile — nothing was written.`,
				candidate.defects.map((defect) => `${VERB}: defect: ${defect}`),
			);
		}

		const judged = judgeAmendment(loaded.lane, candidate.lane, loaded.entries);
		if (judged._tag === "Unreplayable") {
			return replayRefusal(VERB, loaded.logPath, {
				_tag: "Unreplayable",
				defects: judged.defects,
			});
		}
		if (judged._tag === "DropsLanded") {
			return refuse(
				AMEND_DROPS_LANDED,
				`${VERB}: refused (nothing written): #${options.epic}'s topology no longer places ${judged.landed
					.map((row) => `"${row.task}" (landed in "${row.state}")`)
					.join(
						", ",
					)}, and this lane's ledger is the only record that work landed. Put the child back in a phase, or close the epic over what it built.`,
			);
		}
		if (judged._tag === "Unreachable") {
			return refuse(
				AMEND_UNREPLAYABLE,
				`${VERB}: refused (nothing written): the re-derived machine cannot carry this lane's recorded history.`,
				judged.reasons.map((reason) => `${VERB}: ${reason}`),
			);
		}

		const entry = amendmentEntry(options.epic, options.now, judged.tasks);
		return yield* withLedgerLock(
			{fs, path, dir: loaded.dir, verb: VERB},
			Effect.gen(function* () {
				// Re-read and re-judge under the lock: between the judgement above and this append a
				// concurrent writer may have moved the lane, and a machine swapped under a history this
				// run never saw is the corruption the whole verb is built to refuse.
				const fresh = yield* loadLane(options);
				if (fresh._tag !== "Loaded") {
					return refuse(
						LANE_UNREADABLE,
						`${VERB}: ${loaded.logPath} became unreadable before the append — nothing was written.`,
					);
				}
				const again = judgeAmendment(fresh.lane, candidate.lane, fresh.entries);
				if (again._tag !== "Amendable") {
					return refuse(
						AMEND_UNREPLAYABLE,
						`${VERB}: refused (nothing written): the lane moved between the judgement and the append — re-run to re-judge it.`,
					);
				}
				// The record lands before the machine it records, so a half-applied amendment leaves a
				// log the old machine still replays (this line reaches no machine) rather than a machine
				// nothing accounts for. Re-running then re-judges and completes it.
				const appended = yield* Effect.result(
					appendText(fresh.logPath, `${JSON.stringify(entry)}\n`),
				);
				if (Result.isFailure(appended)) {
					return refuse(
						APPEND_UNKNOWN,
						`${VERB}: the amendment did not land at ${fresh.logPath}: ${appended.failure.reason} — the machine is NOT amended.`,
					);
				}
				const wrote = yield* Effect.result(writeFile(workflowPath, emitted.text));
				if (Result.isFailure(wrote)) {
					return refuse(
						APPEND_UNKNOWN,
						`${VERB}: the amendment is recorded at ${fresh.logPath} and the write to ${workflowPath} did not land: ${wrote.failure.reason} — the machine still runs the old topology. Re-run this verb to complete it.`,
					);
				}
				return answer(
					JSON.stringify({
						answer: "amended",
						lane: options.lane,
						epic: options.epic,
						workflow: workflowPath,
						tasks: again.tasks,
						added: again.added,
						dropped: again.dropped,
						phases: emitted.phases,
						children: emitted.children,
						bytes: new TextEncoder().encode(emitted.text).length,
					}),
					[
						`${VERB}: read #${options.epic} and ${listed.value.length} sub-issue link(s) from ${resolved.repo}.`,
						`${VERB}: appended ${entry.event} at ${fresh.logPath} — no recorded line was rewritten.`,
					],
				);
			}),
			{
				onAbsent: (dir) => loadRefusal(VERB, {_tag: "Absent", dir}),
				onLocked: (lockDir) => refuse(CONCURRENT_WRITE, lockedRefusal(VERB, lockDir)),
			},
		);
	});
