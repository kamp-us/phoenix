/**
 * Reading one task's leaf state out of `lane status`'s answer.
 *
 * The recipe verb relays the lane's own fold rather than re-folding the log itself (ADR 0228), so
 * what it holds is the status verb's stdout — a `stateValue` that is either a bare terminal name or
 * `{phase: {task: leaf}}` with future phases as the string `"waiting"`. Turning that back into one
 * task's leaf is the only derivation this file does, and it is pure so the ambiguity cases are
 * testable without a lane on disk.
 *
 * A finished workflow answers {@link Finished} rather than a leaf: a terminal is not a park, and
 * inventing a leaf for it is how a completed lane would read as clearable.
 */
import {isRecord, parseJson} from "../io/json.ts";
import {isPark} from "./parks.ts";

export type LeafRead =
	| {
			readonly _tag: "Leaf";
			readonly task: string;
			readonly leaf: string;
			/** Why the task parked, off the fold's `context.<task>.cause`; `null` on a causeless park. */
			readonly cause: string | null;
	  }
	| {readonly _tag: "Finished"; readonly terminal: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * The tasks of the active phase — the one phase whose value is an object rather than `"waiting"`.
 */
const activeTasks = (stateValue: unknown): Readonly<Record<string, unknown>> | null => {
	if (!isRecord(stateValue)) return null;
	for (const value of Object.values(stateValue)) {
		if (isRecord(value)) return value;
	}
	return null;
};

/**
 * The cause `lane status` folded onto one task, or `null`. A context that is not there, a task with
 * no entry in it, and a `cause` that is not a string all read the same: no cause, so the park is
 * the bare one it was before the field existed and `classifyPark` answers Novel for it.
 */
const causeOf = (parsed: Readonly<Record<string, unknown>>, task: string): string | null => {
	const context = parsed.context;
	if (!isRecord(context)) return null;
	const entry = context[task];
	if (!isRecord(entry)) return null;
	return typeof entry.cause === "string" ? entry.cause : null;
};

/** One task's leaf, off `lane status`'s stdout. `requested` is `null` on a single-task lane. */
export const leafOf = (stdout: string, requested: string | null): LeafRead => {
	const parsed = parseJson(stdout);
	if (!isRecord(parsed) || parsed.stateValue === undefined) {
		return {_tag: "Unreadable", reason: "lane status answered no `stateValue`"};
	}
	const stateValue = parsed.stateValue;
	if (typeof stateValue === "string") return {_tag: "Finished", terminal: stateValue};

	const tasks = activeTasks(stateValue);
	if (tasks === null) {
		return {_tag: "Unreadable", reason: "lane status answered no active phase"};
	}
	const names = Object.keys(tasks);
	if (requested === null && names.length !== 1) {
		return {
			_tag: "Unreadable",
			reason: `--task is required on a phase with ${names.length} tasks (${names.join(", ")})`,
		};
	}
	const task = requested ?? names[0];
	if (task === undefined || !Object.hasOwn(tasks, task)) {
		return {
			_tag: "Unreadable",
			reason: `task "${task}" is not in the active phase (${names.join(", ")})`,
		};
	}
	const leaf = tasks[task];
	return typeof leaf === "string"
		? {_tag: "Leaf", task, leaf, cause: causeOf(parsed, task)}
		: {_tag: "Unreadable", reason: `task "${task}" carries no leaf state`};
};

export type ClearProof =
	| {readonly _tag: "Cleared"; readonly leaf: string}
	| {readonly _tag: "Unproven"; readonly reason: string};

/**
 * Whether a re-fold proves a park was cleared — the whole read-back decision, as a pure function.
 *
 * The three ways it can fail take one answer because they take one remedy (a human reads the lane),
 * and none of them may read as success: a re-fold that refused, a re-fold whose bytes name no leaf,
 * and a re-fold that reads a leaf still in a park. Keeping it out of the verb is what makes the
 * failed-read-back path testable without a filesystem that fails its second read only.
 */
export const clearProof = (code: number, stdout: string, task: string): ClearProof => {
	if (code !== 0) {
		return {_tag: "Unproven", reason: `the re-fold refused at exit ${code}`};
	}
	const read = leafOf(stdout, task);
	if (read._tag !== "Leaf") {
		const detail = read._tag === "Finished" ? `is "${read.terminal}"` : read.reason;
		return {_tag: "Unproven", reason: `the re-fold ${detail}`};
	}
	return isPark(read.leaf)
		? {_tag: "Unproven", reason: `the re-fold still reads the park "${read.leaf}"`}
		: {_tag: "Cleared", leaf: read.leaf};
};

/**
 * The issue a task drives: the number in an emitted epic lane's task name (`issue_<n>`), else the
 * lane id itself on a single-issue lane. `null` when neither carries one — the same derivation
 * `lane brief` makes, kept identical so a park and its brief never disagree about which issue they
 * are about.
 */
export const issueOf = (lane: string, task: string): number | null => {
	const named = /^issue_(\d+)$/.exec(task);
	if (named?.[1] !== undefined) return Number.parseInt(named[1], 10);
	return /^\d+$/.test(lane.trim()) ? Number.parseInt(lane.trim(), 10) : null;
};
