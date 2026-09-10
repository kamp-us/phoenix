/**
 * The fold — `events.jsonl` in, lane state out, every invocation from scratch.
 *
 * Fold = state: there is no resident process and no snapshot, a verb re-folds the whole log each
 * run — measured trivially fast at operator scale. Tasks are independent regions,
 * so the global log partitions cleanly and each task's messages fold through its own machine.
 *
 * `deriveStatus` is the whole "compound machine": the active phase is the first whose tasks are not
 * all final, and a completed phase with a task in an error final trips the workflow — the
 * `noErrors` gate as a pure derivation, never a machine event. Everything here returns a
 * discriminated union rather than throwing, so a verb's refusal is data it seats on an exit code.
 */
import {applyCell, foldMsgs, NoCellError} from "@demlik/tea";
import {type Deferral, deferredTasks, resolveDeferrals} from "./deferral.ts";
import {
	AMENDED_EVENT,
	BOARD_TERMINALS,
	bareEvent,
	CLEARED_EVENT,
	CORRECTED_EVENT,
	type CompiledLane,
	isBoardTerminalEvent,
	isBoardTerminalState,
	isOperatorEvent,
	LANDED_EVENT,
	type LaneMsg,
	MACHINERY_EVENT,
	OPERATOR_EVENTS,
	type TaskState,
} from "./machine.ts";
import {ROUTED_MACHINERY_CAUSES} from "./report.ts";

/**
 * One appended line of `events.jsonl`: which task, which (namespaced) event, when — plus, on an
 * event a shell reported through `lane report`, the artifact refs its terminal named, on a
 * `BLOCKED`, the closed-set cause of the park, and the lane classes the recorder observed
 * at that moment. Those three refs are evidence carried verbatim.
 *
 * `round`, `classes`, `waitGrant` and `partial` are not evidence — they are the payloads the fold
 * reads. A `CLEARED` line without a `round` names no round to clear, `classes` is what a
 * `class:<name>` guard routes on, `waitGrant` is the waits a resume buys, which rides
 * the `UNBLOCKED` line so one recorded event both clears a queue stall and pays for the read the
 * lane resumes to take, and `partial` says the merge behind a ship's `DONE` left its
 * issue open, which is what the `merge:partial` guard routes on. It is recorded at both
 * polarities, so absent means "nobody read the closure", never "the merge closed it": the fold still
 * routes an absent one down the closing arm, and every line written before the field existed folds
 * exactly as it did, but a reader asking which lines were never confirmed can now tell.
 * `landed` is that `partial`'s evidence — the merged pull requests the closure read stood on — and
 * it is what makes a recorded `false` legible after the fact: one naming its evidence was read off a
 * PR, one naming none fell through a nominator that could not see the subject, and no timestamp on
 * the line distinguishes them.
 *
 * `diagnosis` is the third payload of that kind and rides a `DONE` out of build: it says the
 * terminal was proven off a diagnosis comment rather than a pull request, which is what the
 * `done:diagnosis` guard routes on. Only `true` routes, so an absent field folds exactly as it
 * always did, and every line written before the field existed still reaches `review`.
 *
 * `deferred` is the fourth kind: not evidence and not a payload the fold reads, but the disclosure
 * that this `PASS` was proven over a set short the namespaces named — the routed `review-ui` an
 * epic child hands to its epic's tail. Without it a deferred `PASS` and a whole-set one are
 * the same line, and nothing in the ledger says a rendered verdict is still owed anywhere.
 *
 * `tasks` is the sixth and rides one line only, an {@link AMENDED_EVENT}: the task set the
 * re-derived machine holds. It is the whole audit of a topology amendment — the log is append-only,
 * so the machine that folded the lines above this one is gone, and this field is what says which
 * task set replaced which.
 *
 * `corrects` is the fifth and rides one line only, a {@link CORRECTED_EVENT}: the `at` of the
 * earlier entry of this same task whose `partial` payload this line supersedes. It is the
 * one field naming another line, and it is how a routing fact recorded before the field existed is
 * repaired without any recorded line changing — see {@link applyCorrections}.
 */
export interface LogEntry {
	readonly task: string;
	readonly event: string;
	readonly at: string;
	readonly pr?: string;
	readonly comment?: string;
	readonly cause?: string;
	/**
	 * Why the driver cleared this park, on an `UNBLOCKED` it took on its own recommendation.
	 *
	 * Evidence, like `cause`, and the mirror of it: a cause says why the lane parked, a rationale
	 * says why it was let out. It is the whole audit of a driver-routed clear — a clearance no line
	 * records is one nobody can review afterwards — so `recipe unpark` refuses the clear rather than
	 * record an `UNBLOCKED` without it.
	 */
	readonly rationale?: string;
	readonly round?: number;
	readonly classes?: ReadonlyArray<string>;
	readonly deferred?: ReadonlyArray<string>;
	readonly waitGrant?: number;
	readonly partial?: boolean;
	readonly landed?: ReadonlyArray<number>;
	readonly diagnosis?: boolean;
	readonly corrects?: string;
	/** The task set an {@link AMENDED_EVENT} left the lane's machine holding. */
	readonly tasks?: ReadonlyArray<string>;
	/**
	 * The tasks this {@link AMENDED_EVENT} **defers** — the seventh payload, and the only one that
	 * changes how the lines above it are read.
	 *
	 * `deferred` above is a different word for a different thing (the review namespaces a `PASS` was
	 * short), so this one is spelled for the act rather than the state. Each row names the task
	 * leaving the plan, the `at` bounding the history the deferral covers, and the reason — see
	 * [`deferral.ts`](deferral.ts) for what makes a row resolvable.
	 */
	readonly defers?: ReadonlyArray<Deferral>;
	/**
	 * The board outcome a board-proven terminal stands on — the sixth kind, and evidence rather than
	 * a payload the fold reads.
	 *
	 * These two terminals are proven from nothing on disk, so the line has to carry what the board
	 * said: `not_planned` or `duplicate` on a `CANCELLED`, `completed` on a `LANDED` — the closed set
	 * [`settle.ts`](settle.ts) names. Without it the record says a lane ended and not why anyone was
	 * entitled to end it, which is the whole audit the terminal exists to keep, so a line carrying
	 * none is a parse defect rather than an event.
	 */
	readonly outcome?: string;
	/**
	 * The merge commit a {@link LANDED_EVENT} line stands on, beside the `landed` pull requests it
	 * read — absent where the board published none for that merge, which is a fact about the merge
	 * rather than a hole in the evidence.
	 */
	readonly sha?: string;
	/**
	 * Who established the link between a {@link LANDED_EVENT}'s issue and the merge it names —
	 * present only where a caller supplied it, absent where a pull request body proved it.
	 *
	 * The two landings are not equally proven and the record has to say which one this is: a body
	 * link is on the board for anyone to re-read, while `--landed-by` is a person's word that this
	 * merge is what discharged this lane. The board still proved the merge either way, so the
	 * difference is exactly the link — and it is the absent field that carries the stronger claim,
	 * which is what keeps every already-recorded line true. The set is
	 * [`settle.ts`](settle.ts)'s.
	 */
	readonly assertedBy?: string;
}

/**
 * Whether a `defers` payload is the shape {@link resolveDeferrals} can judge at all.
 *
 * Every field is load-bearing and none has a defaulting reading: a row with no `through` bounds
 * nothing, and one with no `reason` records that a plan changed without recording why — the same
 * silent-no-op class a roundless `CLEARED` is, and a parse defect for the same reason. A duplicate
 * task inside one payload is caught here rather than at the resolve, because the two rows may agree
 * and still say one plan change twice.
 */
const isDeferralList = (value: unknown): value is ReadonlyArray<Deferral> => {
	if (!Array.isArray(value) || value.length === 0) return false;
	const tasks = new Set<string>();
	for (const row of value) {
		if (typeof row !== "object" || row === null) return false;
		const {task, through, reason} = row as {task?: unknown; through?: unknown; reason?: unknown};
		if (typeof task !== "string" || task === "") return false;
		if (typeof through !== "string" || through === "") return false;
		if (typeof reason !== "string" || reason.trim() === "") return false;
		if (tasks.has(task)) return false;
		tasks.add(task);
	}
	return true;
};

export type ParseLogResult =
	| {readonly _tag: "Parsed"; readonly entries: ReadonlyArray<LogEntry>}
	| {readonly _tag: "Malformed"; readonly defects: ReadonlyArray<string>};

/** Parse the log text. A line that does not parse is a defect, never a silently skipped event. */
export const parseLog = (text: string): ParseLogResult => {
	const defects: string[] = [];
	const entries: LogEntry[] = [];
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			defects.push(`line ${index + 1} is not JSON`);
			continue;
		}
		const record = parsed as {
			task?: unknown;
			event?: unknown;
			at?: unknown;
			pr?: unknown;
			comment?: unknown;
			cause?: unknown;
			rationale?: unknown;
			round?: unknown;
			classes?: unknown;
			deferred?: unknown;
			waitGrant?: unknown;
			partial?: unknown;
			landed?: unknown;
			diagnosis?: unknown;
			corrects?: unknown;
			tasks?: unknown;
			defers?: unknown;
			outcome?: unknown;
			sha?: unknown;
			assertedBy?: unknown;
		};
		if (
			typeof record !== "object" ||
			record === null ||
			typeof record.task !== "string" ||
			typeof record.event !== "string" ||
			typeof record.at !== "string"
		) {
			defects.push(`line ${index + 1} does not carry string \`task\`/\`event\`/\`at\``);
			continue;
		}
		if (
			(record.pr !== undefined && typeof record.pr !== "string") ||
			(record.comment !== undefined && typeof record.comment !== "string") ||
			(record.cause !== undefined && typeof record.cause !== "string")
		) {
			defects.push(`line ${index + 1} carries a non-string \`pr\`/\`comment\`/\`cause\` field`);
			continue;
		}
		// A blank rationale reads back as a recorded one and says nothing, which is the unauditable
		// clearance the field exists to prevent — so it is a parse defect, never a present field.
		if (
			record.rationale !== undefined &&
			!(typeof record.rationale === "string" && record.rationale.trim() !== "")
		) {
			defects.push(`line ${index + 1} carries a \`rationale\` field that says nothing`);
			continue;
		}
		if (record.round !== undefined && !Number.isInteger(record.round)) {
			defects.push(`line ${index + 1} carries a non-integer \`round\` field`);
			continue;
		}
		// A grant that names no round raises the budget by nothing and would fold as a silent no-op —
		// the failure mode the recorded-clearance rule exists to delete, so it is a defect at the parse.
		if (bareEvent(record.event) === CLEARED_EVENT && record.round === undefined) {
			defects.push(`line ${index + 1} is a ${CLEARED_EVENT} event carrying no \`round\``);
			continue;
		}
		// Same failure mode on the wait axis: a grant of nothing raises `maxWaits` by nothing and folds
		// as a silent no-op, so the entry that names one is a defect rather than an event.
		if (
			record.waitGrant !== undefined &&
			!(Number.isInteger(record.waitGrant) && (record.waitGrant as number) > 0)
		) {
			defects.push(`line ${index + 1} carries a \`waitGrant\` that names no whole grant of waits`);
			continue;
		}
		if (
			record.classes !== undefined &&
			!(
				Array.isArray(record.classes) &&
				record.classes.every((name) => typeof name === "string" && name !== "")
			)
		) {
			defects.push(`line ${index + 1} carries a \`classes\` field that is not a list of names`);
			continue;
		}
		if (
			record.deferred !== undefined &&
			!(
				Array.isArray(record.deferred) &&
				record.deferred.every((name) => typeof name === "string" && name !== "")
			)
		) {
			defects.push(`line ${index + 1} carries a \`deferred\` field that is not a list of names`);
			continue;
		}
		// Only `true` is a routing fact; a `false` on the line says the merge closed, which is the
		// absent field's own reading, so both spellings fold identically and neither is a defect.
		if (record.partial !== undefined && typeof record.partial !== "boolean") {
			defects.push(`line ${index + 1} carries a non-boolean \`partial\` field`);
			continue;
		}
		// An empty `landed` names no merged PR, so it attests nothing while reading as evidence — the
		// same silent no-op a roundless `CLEARED` is, and a defect here for the same reason.
		if (
			record.landed !== undefined &&
			!(
				Array.isArray(record.landed) &&
				record.landed.length > 0 &&
				record.landed.every((number) => Number.isInteger(number) && (number as number) > 0)
			)
		) {
			defects.push(
				`line ${index + 1} carries a \`landed\` field that is not a non-empty list of pull request numbers`,
			);
			continue;
		}
		// Only `true` routes, exactly as `partial` does: a `false` says this DONE stood on a pull
		// request, which is the absent field's own reading, so both fold identically.
		if (record.diagnosis !== undefined && typeof record.diagnosis !== "boolean") {
			defects.push(`line ${index + 1} carries a non-boolean \`diagnosis\` field`);
			continue;
		}
		// A correction that names no target line, or names one with nothing to put on it, supersedes
		// nothing and would fold as a silent no-op — the same failure mode a roundless `CLEARED` has,
		// and the reason both are defects here rather than events.
		const corrected = bareEvent(record.event) === CORRECTED_EVENT;
		if (record.corrects !== undefined && typeof record.corrects !== "string") {
			defects.push(`line ${index + 1} carries a non-string \`corrects\` field`);
			continue;
		}
		if (corrected && (typeof record.corrects !== "string" || typeof record.partial !== "boolean")) {
			defects.push(
				`line ${index + 1} is a ${CORRECTED_EVENT} event that does not carry both a \`corrects\` timestamp and a \`partial\``,
			);
			continue;
		}
		// An amendment naming no task set records that the machine changed and not what it changed to,
		// which leaves the one thing this line exists to carry unreadable — the same silent-no-op class
		// a roundless `CLEARED` is, and a defect here for the same reason.
		const amended = bareEvent(record.event) === AMENDED_EVENT;
		if (
			record.tasks !== undefined &&
			!(
				Array.isArray(record.tasks) &&
				record.tasks.length > 0 &&
				record.tasks.every((name) => typeof name === "string" && name !== "")
			)
		) {
			defects.push(
				`line ${index + 1} carries a \`tasks\` field that is not a non-empty list of task ids`,
			);
			continue;
		}
		if (amended && record.tasks === undefined) {
			defects.push(
				`line ${index + 1} is an ${AMENDED_EVENT} event carrying no \`tasks\` — the task set the re-derived machine holds`,
			);
			continue;
		}
		if (record.defers !== undefined && !isDeferralList(record.defers)) {
			defects.push(
				`line ${index + 1} carries a \`defers\` field that is not a non-empty list of {task, through, reason} rows`,
			);
			continue;
		}
		if (!amended && record.defers !== undefined) {
			defects.push(
				`line ${index + 1} carries \`defers\` on a "${bareEvent(record.event)}" event — only an ${AMENDED_EVENT} defers a task out of the plan`,
			);
			continue;
		}
		if (!amended && record.tasks !== undefined) {
			defects.push(
				`line ${index + 1} carries \`tasks\` on a "${bareEvent(record.event)}" event — only an ${AMENDED_EVENT} names a re-derived task set`,
			);
			continue;
		}
		// The board outcome is a settled terminal's whole evidence, so a line missing it records a
		// terminal nobody can audit — the same silent-no-op class a roundless `CLEARED` is.
		const settled = isBoardTerminalEvent(bareEvent(record.event));
		if (
			record.outcome !== undefined &&
			!(typeof record.outcome === "string" && record.outcome !== "")
		) {
			defects.push(`line ${index + 1} carries an \`outcome\` field that is not a board outcome`);
			continue;
		}
		if (settled && record.outcome === undefined) {
			defects.push(
				`line ${index + 1} is a ${bareEvent(record.event)} event carrying no \`outcome\` — the board outcome it stands on`,
			);
			continue;
		}
		if (!settled && record.outcome !== undefined) {
			defects.push(
				`line ${index + 1} carries \`outcome\` on a "${bareEvent(record.event)}" event — only a board-proven terminal (${Object.keys(BOARD_TERMINALS).join("/")}) stands on a board outcome`,
			);
			continue;
		}
		// A landing is the one terminal asserting an artifact exists, so it names the merged pull
		// requests it read — without them the line says work shipped and points at nothing.
		if (bareEvent(record.event) === LANDED_EVENT && record.landed === undefined) {
			defects.push(
				`line ${index + 1} is a ${LANDED_EVENT} event naming no \`landed\` pull request — the merge it stands on`,
			);
			continue;
		}
		if (record.sha !== undefined && !(typeof record.sha === "string" && record.sha !== "")) {
			defects.push(`line ${index + 1} carries a \`sha\` field that names no commit`);
			continue;
		}
		// Only a landing has a link to attribute, so the field anywhere else is a line claiming a
		// provenance for evidence it does not carry.
		if (
			record.assertedBy !== undefined &&
			!(typeof record.assertedBy === "string" && record.assertedBy !== "")
		) {
			defects.push(
				`line ${index + 1} carries an \`assertedBy\` field that names no source of the link`,
			);
			continue;
		}
		if (record.assertedBy !== undefined && bareEvent(record.event) !== LANDED_EVENT) {
			defects.push(
				`line ${index + 1} carries \`assertedBy\` on a "${bareEvent(record.event)}" event — only a ${LANDED_EVENT} names who established its link`,
			);
			continue;
		}
		if (!corrected && record.corrects !== undefined) {
			defects.push(
				`line ${index + 1} carries \`corrects\` on a "${bareEvent(record.event)}" event — only a ${CORRECTED_EVENT} supersedes another line`,
			);
			continue;
		}
		entries.push({
			task: record.task,
			event: record.event,
			at: record.at,
			...(record.pr === undefined ? {} : {pr: record.pr}),
			...(record.comment === undefined ? {} : {comment: record.comment}),
			...(record.cause === undefined ? {} : {cause: record.cause}),
			...(record.rationale === undefined ? {} : {rationale: record.rationale as string}),
			...(record.round === undefined ? {} : {round: record.round as number}),
			...(record.classes === undefined ? {} : {classes: record.classes as ReadonlyArray<string>}),
			...(record.deferred === undefined
				? {}
				: {deferred: record.deferred as ReadonlyArray<string>}),
			...(record.waitGrant === undefined ? {} : {waitGrant: record.waitGrant as number}),
			...(record.partial === undefined ? {} : {partial: record.partial as boolean}),
			...(record.landed === undefined ? {} : {landed: record.landed as ReadonlyArray<number>}),
			...(record.diagnosis === undefined ? {} : {diagnosis: record.diagnosis as boolean}),
			...(record.corrects === undefined ? {} : {corrects: record.corrects as string}),
			...(record.tasks === undefined ? {} : {tasks: record.tasks as ReadonlyArray<string>}),
			...(record.defers === undefined ? {} : {defers: record.defers as ReadonlyArray<Deferral>}),
			...(record.outcome === undefined ? {} : {outcome: record.outcome as string}),
			...(record.sha === undefined ? {} : {sha: record.sha as string}),
			...(record.assertedBy === undefined ? {} : {assertedBy: record.assertedBy as string}),
		});
	}
	return defects.length > 0 ? {_tag: "Malformed", defects} : {_tag: "Parsed", entries};
};

export type CorrectionResult =
	| {readonly _tag: "Corrected"; readonly entries: ReadonlyArray<LogEntry>}
	| {readonly _tag: "Undecidable"; readonly defects: ReadonlyArray<string>};

/**
 * Resolve every {@link CORRECTED_EVENT} line against the entry it names, producing the log the fold
 * replays: corrections removed, and each corrected entry carrying the `partial` its correction
 * states.
 *
 * The log is append-only, so a routing fact recorded wrong can only be superseded, never edited —
 * and the supersession has to be resolvable offline, from the log alone, since the fold is total
 * over `events.jsonl` and reads nothing else. A correction addresses its target by that entry's own
 * `at` within the same task, which is stable under every later append.
 *
 * Ambiguity is a defect rather than a resolution: a `corrects` matching no entry, or matching more
 * than one, is exactly the state where picking would invent a history. Corrections apply in log
 * order, so a later one supersedes an earlier one over the same line.
 */
export const applyCorrections = (entries: ReadonlyArray<LogEntry>): CorrectionResult => {
	const corrections = entries.filter((entry) => bareEvent(entry.event) === CORRECTED_EVENT);
	if (corrections.length === 0) return {_tag: "Corrected", entries};
	const defects: string[] = [];
	const corrected = entries.filter((entry) => bareEvent(entry.event) !== CORRECTED_EVENT);
	const patched = [...corrected];
	for (const correction of corrections) {
		const targets = patched
			.map((entry, index) => ({entry, index}))
			.filter(({entry}) => entry.task === correction.task && entry.at === correction.corrects);
		const only = targets[0];
		if (only === undefined || targets.length > 1) {
			defects.push(
				`the ${CORRECTED_EVENT} at ${correction.at} names ${targets.length === 0 ? "no" : `${targets.length}`} event of task "${correction.task}" recorded at ${correction.corrects}`,
			);
			continue;
		}
		patched[only.index] = {...only.entry, partial: correction.partial === true};
	}
	return defects.length > 0
		? {_tag: "Undecidable", defects}
		: {_tag: "Corrected", entries: patched};
};

export type FoldResult =
	| {readonly _tag: "Folded"; readonly states: Readonly<Record<string, TaskState>>}
	| {readonly _tag: "Unreplayable"; readonly defects: ReadonlyArray<string>};

/**
 * The compiler admits a phase's task ids and the fold keys states by those same ids, so both
 * lookups hold by construction; the throw is the invariant's enforcement site, not a code path.
 */
const taskIn = (lane: CompiledLane, taskId: string): CompiledLane["tasks"][string] => {
	const task = lane.tasks[taskId];
	if (task === undefined) throw new Error(`lane machine holds no task "${taskId}"`);
	return task;
};

const stateIn = (states: Readonly<Record<string, TaskState>>, taskId: string): TaskState => {
	const state = states[taskId];
	if (state === undefined) throw new Error(`no folded state for task "${taskId}"`);
	return state;
};

/**
 * Fold the whole log into per-task leaf states. A log only ever appended through
 * {@link applyEvent} replays cleanly; one that names an unknown task or carries an event the
 * machine holds no cell for (a hand edit, or a `workflow.json` swap) is refused with the defect
 * named — never partially applied.
 *
 * {@link applyCorrections} runs first, so a correction line never reaches the machine: it is
 * resolved into the entry it names and dropped, and a correction that cannot be resolved is a
 * defect on the same channel as an unreplayable log.
 *
 * An {@link AMENDED_EVENT} reaches no machine either, and is exempt from the task check above it:
 * it is a fact about the lane rather than about a task, so the id it carries names the lane's own
 * subject and nothing dispatches on it. Judging it against the task set would make the one line
 * recording a topology change the line that refuses to replay through the topology it recorded.
 *
 * A **deferred** task is the one other exemption, and it is narrow by construction: only the tasks
 * an amendment's `defers` payload names, and only over the history that payload bounds. Everything
 * else about a deferred task is refused rather than ignored — an unresolvable payload, and any line
 * the bound does not cover, are defects on this same channel. `pending` carries the deferrals of an
 * amendment not yet appended, which is the only way {@link judgeAmendment} can fold a log through
 * the machine the amendment would write before writing it.
 */
export const foldLog = (
	lane: CompiledLane,
	entries: ReadonlyArray<LogEntry>,
	pending: ReadonlyArray<string> = [],
): FoldResult => {
	const resolvedDeferrals = resolveDeferrals(entries);
	if (resolvedDeferrals._tag === "Undecidable") {
		return {_tag: "Unreplayable", defects: resolvedDeferrals.defects};
	}
	const deferred = new Set([...deferredTasks(resolvedDeferrals.deferrals), ...pending]);
	const defects: string[] = [];
	for (const entry of entries) {
		if (bareEvent(entry.event) === AMENDED_EVENT) continue;
		if (deferred.has(entry.task)) continue;
		if (lane.tasks[entry.task] === undefined) {
			defects.push(`log names task "${entry.task}", which is not in this lane's machine`);
		}
	}
	if (defects.length > 0) return {_tag: "Unreplayable", defects};
	const resolved = applyCorrections(entries);
	if (resolved._tag === "Undecidable") {
		return {_tag: "Unreplayable", defects: resolved.defects};
	}
	const states: Record<string, TaskState> = {};
	for (const [taskId, task] of Object.entries(lane.tasks)) {
		const msgs = resolved.entries
			.filter((entry) => entry.task === taskId && bareEvent(entry.event) !== AMENDED_EVENT)
			.map((entry) => ({
				type: bareEvent(entry.event),
				...(entry.round === undefined ? {} : {round: entry.round}),
				...(entry.classes === undefined ? {} : {classes: entry.classes}),
				...(entry.waitGrant === undefined ? {} : {waitGrant: entry.waitGrant}),
				...(entry.partial === undefined ? {} : {partial: entry.partial}),
				...(entry.diagnosis === undefined ? {} : {diagnosis: entry.diagnosis}),
				...(entry.cause === undefined ? {} : {cause: entry.cause}),
			}));
		try {
			states[taskId] = foldMsgs(task.machine, task.initial, msgs);
		} catch (error) {
			if (error instanceof NoCellError) {
				return {
					_tag: "Unreplayable",
					defects: [`task "${taskId}": the log does not replay — ${error.message}`],
				};
			}
			throw error;
		}
	}
	return {_tag: "Folded", states};
};

/**
 * The cause standing over each task — the `cause` on that task's latest entry, when it carries one.
 *
 * A cause is a property of the event that parked the task, so it stands exactly while that event is
 * the last thing said about the task: the `UNBLOCKED` that clears the park carries none, and the
 * standing cause goes with it. Deriving it that way rather than tracking it as machine state is
 * what keeps the fold total over a log written before this field existed — no cause reads as the
 * bare `BLOCKED` it always was.
 *
 * A `CLEARED` is not the last thing said about a task, because it says nothing about one: it moves
 * no task and clears no park, so a grant landing on a parked lane must leave that park's cause
 * standing. A `CORRECTED` is skipped for the same reason — it amends an older line's
 * routing payload and parks nothing, so letting it stand as the latest entry would silently clear
 * the cause a repaired lane is still waiting under. An `AMENDED` is skipped for the third time on the
 * same reasoning: it re-derives the machine and parks nothing.
 */
export const standingCauses = (
	entries: ReadonlyArray<LogEntry>,
): Readonly<Record<string, string>> => standingField(entries, "cause");

/**
 * The rationale standing over each task — the `rationale` on that task's latest entry, when it
 * carries one.
 *
 * The mirror of {@link standingCauses}, derived the same way for the same reason: a rationale is a
 * property of the `UNBLOCKED` that cleared the park, so it stands exactly while that event is the
 * last thing said about the task, and the next event replaces it. That is what makes a driver's
 * clearance readable back off the ledger's own re-fold rather than only off the raw log.
 */
export const standingRationales = (
	entries: ReadonlyArray<LogEntry>,
): Readonly<Record<string, string>> => standingField(entries, "rationale");

const standingField = (
	entries: ReadonlyArray<LogEntry>,
	field: "cause" | "rationale",
): Readonly<Record<string, string>> => {
	const latest: Record<string, LogEntry> = {};
	for (const entry of entries) {
		const bare = bareEvent(entry.event);
		if (bare === CLEARED_EVENT || bare === CORRECTED_EVENT || bare === AMENDED_EVENT) continue;
		latest[entry.task] = entry;
	}
	const standing: Record<string, string> = {};
	for (const [task, entry] of Object.entries(latest)) {
		const value = entry[field];
		if (value !== undefined) standing[task] = value;
	}
	return standing;
};

export interface LaneStatus {
	readonly stateValue: string | Readonly<Record<string, Readonly<Record<string, string>> | string>>;
	readonly status: "active" | "done";
	readonly context: Readonly<Record<string, unknown>>;
}

/** The pure phase derivation — compound stateValue, `"waiting"` future phases, `noErrors` gating. */
export const deriveStatus = (
	lane: CompiledLane,
	states: Readonly<Record<string, TaskState>>,
	causes: Readonly<Record<string, string>> = {},
	rationales: Readonly<Record<string, string>> = {},
): LaneStatus => {
	const errors = Object.entries(states)
		.filter(([taskId, state]) => taskIn(lane, taskId).errorFinals.has(state.type))
		.map(([taskId]) => taskId);
	const context: Record<string, unknown> = {};
	for (const [taskId, state] of Object.entries(states)) {
		const cause = causes[taskId];
		const rationale = rationales[taskId];
		context[taskId] = {
			retries: state.retries,
			maxRetries: state.maxRetries,
			...(state.cleared.length === 0 ? {} : {clearedRounds: state.cleared}),
			waits: state.waits,
			maxWaits: state.maxWaits,
			// Absent on a machine that declares no lap-guarded cell — every lane emitted before the
			// machinery axis existed, and every one emitted with the key off — so their status is
			// byte-for-byte what it always was rather than gaining a counter nothing can spend.
			...(taskIn(lane, taskId).lapStates.size === 0
				? {}
				: {laps: state.laps, maxLaps: state.maxLaps}),
			// Absent rather than empty when unclassed, so an unclassed lane's status is what it always
			// was; a driver relaying `--class` reads the standing set here.
			...(state.classes.length === 0 ? {} : {classes: state.classes}),
			...taskIn(lane, taskId).extras,
			...(cause === undefined ? {} : {cause}),
			...(rationale === undefined ? {} : {rationale}),
		};
	}
	context.errors = errors;

	let active: CompiledLane["phases"][number] | undefined;
	for (const phase of lane.phases) {
		const done = phase.tasks.every((taskId) =>
			taskIn(lane, taskId).finals.has(stateIn(states, taskId).type),
		);
		if (!done) {
			active = phase;
			break;
		}
		// Read before the trip, and never folded into either declared terminal: `complete` would claim
		// this lane's own flow finished it and `tripped` would claim it failed, and the board said
		// neither. A phase holding a settled task beside an unfinished sibling is not done and never
		// reaches here, so settling one epic child does not end its epic.
		const settled = phase.tasks.find((taskId) =>
			isBoardTerminalState(stateIn(states, taskId).type),
		);
		if (settled !== undefined) {
			return {stateValue: stateIn(states, settled).type, status: "done", context};
		}
		// Read for the same reason and never folded into `complete`: an investigation's `DONE` is
		// proven off a diagnosis comment rather than a merge, so answering `complete` here would name
		// a shipped lane's terminal over a lane that shipped nothing. Empty on every machine
		// declaring no `done:diagnosis` arm, which is every one but the coder workflow's `build`.
		const diagnosed = phase.tasks.find((taskId) =>
			taskIn(lane, taskId).diagnosisFinals.has(stateIn(states, taskId).type),
		);
		if (diagnosed !== undefined) {
			return {stateValue: stateIn(states, diagnosed).type, status: "done", context};
		}
		if (phase.tasks.some((taskId) => errors.includes(taskId))) {
			return {stateValue: lane.terminals.tripped, status: "done", context};
		}
	}
	if (active === undefined) return {stateValue: lane.terminals.complete, status: "done", context};

	const stateValue: Record<string, Record<string, string> | string> = {
		[active.name]: Object.fromEntries(
			active.tasks.map((taskId) => [taskId, stateIn(states, taskId).type]),
		),
	};
	for (const phase of lane.phases.slice(lane.phases.indexOf(active) + 1)) {
		stateValue[phase.name] = "waiting";
	}
	return {stateValue, status: "active", context};
};

/**
 * The leaf this task would land in if this event were recorded now, asked of the compiled cell
 * itself — `null` where the machine holds no cell for it.
 *
 * `lane prove` needs the answer to know which cell owes what, and reading it off the machine rather
 * than off a state-name list is what keeps the routing and the proof one fact: a `PASS` out of
 * `review` that lands in `review:ui` is a `PASS` whose rendered namespace the cell it routes into
 * owes, while the same `PASS` on a machine with no such arm — a chore workflow, or a rendered head
 * whose reviewer relayed no class — lands in `ship` and owes the whole set here.
 *
 * It answers the machine's question only. Whether the event is *appendable* stays
 * {@link applyEvent}'s, which asks several more.
 */
export const nextLeaf = (
	lane: CompiledLane,
	states: Readonly<Record<string, TaskState>>,
	taskId: string,
	event: string,
	classes: ReadonlyArray<string> | null,
): string | null => {
	const task = lane.tasks[taskId];
	const from = states[taskId];
	if (task === undefined || from === undefined || !isOperatorEvent(event)) return null;
	try {
		const [next] = applyCell<TaskState, LaneMsg, never>(task.machine, from, {
			type: event,
			...(classes === null ? {} : {classes}),
		});
		return next.type;
	} catch (error) {
		if (error instanceof NoCellError) return null;
		throw error;
	}
};

export type TaskResolution =
	| {readonly _tag: "Task"; readonly taskId: string}
	| {readonly _tag: "Unresolved"; readonly reason: string};

/** `--task` may be omitted exactly when the machine leaves no choice. */
export const resolveTask = (lane: CompiledLane, requested: string | null): TaskResolution => {
	const known = Object.keys(lane.tasks);
	if (requested !== null) {
		return lane.tasks[requested] === undefined
			? {
					_tag: "Unresolved",
					reason: `task "${requested}" is not in this lane's machine (tasks: ${known.join(", ")})`,
				}
			: {_tag: "Task", taskId: requested};
	}
	const only = known.length === 1 ? known[0] : undefined;
	return only !== undefined
		? {_tag: "Task", taskId: only}
		: {
				_tag: "Unresolved",
				reason: `--task is required on a lane with ${known.length} tasks (${known.join(", ")})`,
			};
};

export type ApplyResult =
	| {
			readonly _tag: "Applied";
			readonly entry: LogEntry;
			readonly previous: LaneStatus;
			readonly current: LaneStatus;
	  }
	| {
			readonly _tag: "Refused";
			readonly reason: string;
			/**
			 * Which fact the refusal proves, so the verb can seat it on the right exit code without
			 * reading the message. `"unbudgeted-resume"` is the one whose remedy is not a different
			 * event — see {@link applyEvent}.
			 */
			readonly kind: "event" | "unbudgeted-resume";
	  };

const refuseEvent = (reason: string): ApplyResult => ({_tag: "Refused", reason, kind: "event"});

/**
 * Validate and apply one operator event, producing the entry to append. Every refusal is decided
 * BEFORE anything would touch the log, which is what lets a verb prove refuse-without-append. The
 * no-cell refusal is tea's own dispatch guard (`applyCell` → `NoCellError`), surfaced verbatim.
 *
 * Two refusals are this function's own rather than the machine table's, one per budget, and both are
 * the same defect: a resume that restores the state and not the budget it needs, so the lane
 * advertises `active`, is not walkable, and nobody is told.
 *
 * On the **retry** axis it is an `UNBLOCKED` out of an error final into a state whose only non-`PASS`
 * route is `retries`-guarded and spent; the budget comes from a recorded `CLEARED` and
 * from nothing else. On the **wait** axis it is a resume out of a wait park back into the very state
 * whose spent `waits` guard produced that park. The wait one cannot key on `errorFinals` the way the
 * retry one does — `human:queue-stall` carries no `type: "final"` and structurally cannot be in that
 * set — so it keys on the wait counter and on the guarded state's own park pairing, and its grant
 * rides the resume rather than arriving as a separate line.
 */
export const applyEvent = (
	lane: CompiledLane,
	states: Readonly<Record<string, TaskState>>,
	taskId: string,
	event: string,
	at: string,
	classes: ReadonlyArray<string> | null = null,
	waitGrant: number | null = null,
	partial: boolean | null = null,
	diagnosis: boolean | null = null,
	cause: string | null = null,
): ApplyResult => {
	if (!isOperatorEvent(event)) {
		if (event === CLEARED_EVENT) {
			return refuseEvent(
				`"${event}" is not an operator event — a cleared repair round is appended by \`build clear\`, never recorded here`,
			);
		}
		if (isBoardTerminalEvent(event)) {
			return refuseEvent(
				`"${event}" is not an operator event — a board-proven terminal is proven from the board's closed issue and is appended by \`lane settle\`, never transitioned`,
			);
		}
		if (event === AMENDED_EVENT) {
			return refuseEvent(
				`"${event}" is not an operator event — a topology amendment re-derives the lane's machine and is appended by \`lane amend\`, never transitioned`,
			);
		}
		return refuseEvent(
			event === CORRECTED_EVENT
				? `"${event}" is not an operator event — a correction supersedes an already-recorded line's routing payload and is appended by \`lane reconcile\`, never transitioned`
				: `"${event}" is outside the operator's event set (${OPERATOR_EVENTS.join("/")})`,
		);
	}
	const previous = deriveStatus(lane, states);
	// A task sitting in an open final is parked, not finished: the door out is still walkable.
	// This is a fact about the task alone — a phase holding a parked child beside an
	// unfinished sibling never folds, so the lane's own status says nothing about it.
	const compiled = lane.tasks[taskId];
	const state = states[taskId];
	const inOpenFinal =
		compiled !== undefined && state !== undefined && compiled.openFinals.has(state.type);
	// Only the tripped terminal admits an event once the whole lane has folded — `complete` means
	// every task finished clean, and no door leads out of that.
	const parked =
		previous.status === "done" && previous.stateValue === lane.terminals.tripped && inOpenFinal;
	if (previous.status === "done" && !parked) {
		return refuseEvent(`workflow is "${String(previous.stateValue)}" — no further events`);
	}
	const activePhase = parked
		? lane.phases.find((phase) => phase.tasks.includes(taskId))
		: lane.phases.find(
				(phase) => typeof (previous.stateValue as Record<string, unknown>)[phase.name] === "object",
			);
	if (activePhase === undefined || !activePhase.tasks.includes(taskId)) {
		return refuseEvent(`task "${taskId}" is not in the active phase ("${activePhase?.name}")`);
	}
	const task = taskIn(lane, taskId);
	const from = stateIn(states, taskId);
	// A lane keeps its own copy of `workflow.json` from `lane open`, so a cell can predate a cause.
	// An unrouted lap loops the stage, which is right for every cause but one — see
	// `ROUTED_MACHINERY_CAUSES`.
	if (event === MACHINERY_EVENT && cause !== null && ROUTED_MACHINERY_CAUSES.has(cause)) {
		if (!(task.lapRoutes.get(from.type)?.has(cause) ?? false)) {
			return refuseEvent(
				`task "${taskId}" is in "${from.type}", whose machinery cell holds no arm for cause "${cause}" — this lane's machine was written before that cause existed and would loop the stage instead of folding it, so nothing was recorded`,
			);
		}
	}
	let next: TaskState;
	try {
		[next] = applyCell<TaskState, LaneMsg, never>(task.machine, from, {
			type: event,
			...(classes === null ? {} : {classes}),
			...(waitGrant === null ? {} : {waitGrant}),
			...(partial === null ? {} : {partial}),
			...(diagnosis === null ? {} : {diagnosis}),
			...(cause === null ? {} : {cause}),
		});
	} catch (error) {
		if (error instanceof NoCellError) {
			return refuseEvent(`${error.name}: ${error.message}`);
		}
		throw error;
	}
	// A region booted straight into a park left no state behind it, so its door resolves to the park
	// itself; recording that would answer "resumed" for a fold that did not move.
	if (inOpenFinal && next.type === from.type) {
		return refuseEvent(
			`task "${taskId}" booted in "${next.type}" and left no state to resume — the door leads back to itself`,
		);
	}
	if (
		task.errorFinals.has(from.type) &&
		task.guardedStates.has(next.type) &&
		next.retries >= next.maxRetries
	) {
		const stale =
			task.staleGrants.length === 0
				? ""
				: ` This lane's \`workflow.json\` still names a retired \`clearedRounds\` of [${task.staleGrants.join(", ")}], which the compiler no longer honours — re-record each as a ${CLEARED_EVENT} event.`;
		return {
			_tag: "Refused",
			kind: "unbudgeted-resume",
			reason: `task "${taskId}" would resume from "${from.type}" into "${next.type}" at ${next.retries}/${next.maxRetries} retries — the state comes back and the repair budget does not, so every guarded route out of "${next.type}" falls straight back to "${from.type}". Record the cleared round first — \`build clear\` where a pull request carries the founder's grant, \`lane clear\` where the lane has none and the driver grants the round on its own diagnosis; the two may land in either order.${stale}`,
		};
	}
	if (task.waitParks.get(next.type)?.has(from.type) === true && next.waits >= next.maxWaits) {
		return {
			_tag: "Refused",
			kind: "unbudgeted-resume",
			reason: `task "${taskId}" would resume from "${from.type}" into "${next.type}" at ${next.waits}/${next.maxWaits} waits — the state comes back and the wait budget does not, so the next guarded route out of "${next.type}" falls straight back to "${from.type}". Grant the waits on this same resume: \`recipe unpark\` grants them once it has proven the queue moved, and \`lane transition … UNBLOCKED --grant-wait <n>\` is the fallback when that read cannot run. \`build clear\` buys a repair round and never a longer wait.`,
		};
	}
	const entry: LogEntry = {
		task: taskId,
		event: `${taskId.toUpperCase()}.${event}`,
		at,
		...(classes === null ? {} : {classes}),
		...(waitGrant === null ? {} : {waitGrant}),
		...(partial === null ? {} : {partial}),
		...(diagnosis === null ? {} : {diagnosis}),
	};
	const current = deriveStatus(lane, {...states, [taskId]: next});
	return {_tag: "Applied", entry, previous, current};
};

export type SettlementResult =
	| {
			readonly _tag: "Appendable";
			readonly entry: LogEntry;
			readonly previous: LaneStatus;
			readonly current: LaneStatus;
	  }
	| {readonly _tag: "Refused"; readonly reason: string};

/** The evidence a board-proven terminal's line carries, beside the outcome the board stated. */
export interface SettlementEvidence {
	readonly outcome: string;
	/** The merged pull requests a `LANDED` stands on; absent on a `CANCELLED`, which has none. */
	readonly landed?: ReadonlyArray<number>;
	/** The merge commit those pull requests left, where the board published one. */
	readonly sha?: string;
	/** Who established the link, on a landing a caller asserted; absent where a body proved it. */
	readonly assertedBy?: string;
}

/**
 * The entry a board-proven terminal appends — `lane settle`'s offline half, kept beside
 * {@link applyEvent} because both decide appendability from the same fold.
 *
 * It reaches every state a lane can sit in, including a park, because that is what the incidents
 * were: lane 5983 sat in `blocked` and no door led anywhere, and the hand-shipped lanes sit in
 * `build` or `review` over a merge their own flow never recorded. What it does NOT reach is a task
 * whose outcome is already recorded — a task in a final, or a lane already folded done — since
 * ending an ended lane records a second terminal over the first.
 *
 * Whether the board entitles this at all is the verb's read, not this function's: nothing here can
 * see an issue, and a terminal appended over an unread board is exactly the fabrication these two
 * events exist to make impossible.
 */
export const applyBoardTerminal = (
	lane: CompiledLane,
	states: Readonly<Record<string, TaskState>>,
	taskId: string,
	event: string,
	evidence: SettlementEvidence,
	at: string,
): SettlementResult => {
	if (!isBoardTerminalEvent(event)) {
		return {
			_tag: "Refused",
			reason: `"${event}" is not a board-proven terminal (${Object.keys(BOARD_TERMINALS).join("/")})`,
		};
	}
	const task = lane.tasks[taskId];
	const from = states[taskId];
	if (task === undefined || from === undefined) {
		return {
			_tag: "Refused",
			reason: `task "${taskId}" is not in this lane's machine (tasks: ${Object.keys(lane.tasks).join(", ")})`,
		};
	}
	const previous = deriveStatus(lane, states);
	if (previous.status === "done") {
		return {
			_tag: "Refused",
			reason: `workflow is "${String(previous.stateValue)}" — this lane already carries a terminal, and settling over it would record a second outcome for one lane`,
		};
	}
	if (task.finals.has(from.type)) {
		return {
			_tag: "Refused",
			reason: `task "${taskId}" is in "${from.type}", a final — its outcome is already recorded, so there is nothing here to settle`,
		};
	}
	let next: TaskState;
	try {
		[next] = applyCell<TaskState, LaneMsg, never>(task.machine, from, {type: event});
	} catch (error) {
		if (error instanceof NoCellError) {
			return {_tag: "Refused", reason: `${error.name}: ${error.message}`};
		}
		throw error;
	}
	return {
		_tag: "Appendable",
		entry: {
			task: taskId,
			event: `${taskId.toUpperCase()}.${event}`,
			at,
			outcome: evidence.outcome,
			...(evidence.landed === undefined ? {} : {landed: evidence.landed}),
			...(evidence.sha === undefined ? {} : {sha: evidence.sha}),
			...(evidence.assertedBy === undefined ? {} : {assertedBy: evidence.assertedBy}),
		},
		previous,
		current: deriveStatus(lane, {...states, [taskId]: next}),
	};
};

export type ClearanceResult =
	| {readonly _tag: "Appendable"; readonly entry: LogEntry}
	/** The log already carries this round for this task — set semantics, so nothing to append. */
	| {readonly _tag: "AlreadyHeld"; readonly round: number}
	| {readonly _tag: "Refused"; readonly reason: string};

/**
 * The entry a recorded clearance appends — the local half of the grant protocol, kept beside
 * {@link applyEvent} because both decide appendability from the same fold. Two verbs reach it, one
 * per seat: `build clear` where the grant is a founder's marker on a pull request, and `lane clear`
 * where the lane has no pull request to carry one.
 *
 * It validates far less than an operator event does, and deliberately: a grant moves no task, so
 * there is no cell to miss, no phase to be outside of, and no terminal to be past. A clearance may
 * land on a lane in any state, in any order relative to the `UNBLOCKED` it enables — which is the
 * whole point of anchoring the budget to the event rather than to mutable context.
 *
 * The `rationale` is the driver seat's whole audit: a founder's grant is reviewable on the pull
 * request it was posted to, and a driver's is reviewable on this line or nowhere.
 */
export const applyClearance = (
	lane: CompiledLane,
	entries: ReadonlyArray<LogEntry>,
	taskId: string,
	round: number,
	at: string,
	rationale: string | null = null,
): ClearanceResult => {
	if (lane.tasks[taskId] === undefined) {
		return {
			_tag: "Refused",
			reason: `task "${taskId}" is not in this lane's machine (tasks: ${Object.keys(lane.tasks).join(", ")})`,
		};
	}
	if (!Number.isInteger(round)) {
		return {_tag: "Refused", reason: `round ${round} is not a whole round to clear`};
	}
	const held = entries.some(
		(entry) =>
			entry.task === taskId && bareEvent(entry.event) === CLEARED_EVENT && entry.round === round,
	);
	if (held) return {_tag: "AlreadyHeld", round};
	return {
		_tag: "Appendable",
		entry: {
			task: taskId,
			event: `${taskId.toUpperCase()}.${CLEARED_EVENT}`,
			at,
			round,
			...(rationale === null ? {} : {rationale}),
		},
	};
};
