/**
 * The migration judgement — may this lane's `workflow.json` be replaced by the committed template?
 *
 * `lane open` places a byte-identical copy of the committed template into each lane at boot and
 * refuses to overwrite one afterwards, so a template edit reaches lanes booted after it and no lane
 * already on disk. That is safe while an edit touches the *template* only. It stops being safe the
 * moment a token→event map in code changes with it: `report.ts` is code, so a remap lands on every
 * booted lane at once and asks their frozen machines for a cell they do not have (ADR 0313, and the
 * `QUEUED`→`WIP` remap that named this).
 *
 * The fold is what makes a swap provable rather than hoped: state is `events.jsonl` replayed from
 * scratch every run, with no snapshot anywhere. So a replacement is safe exactly when the existing
 * log replays through the new machine to the same per-task leaf state it replays to through the old
 * one. This module decides that and nothing else — it reads no disk and writes none.
 *
 * The check is deliberately stricter than "the log replays": a machine that re-routes an event the
 * log already carries would replay fine and land the lane somewhere it never was, which is a
 * rewritten history rather than a migration. Drift is refused with each task named.
 *
 * What gets written is not the template's bytes but {@link graftContext}'s — see there for why the
 * lane's own `machine.context` survives the swap and why a generated machine is left alone.
 */
import {isRecord, parseJson} from "../io/json.ts";
import {foldLog, type LogEntry} from "./fold.ts";
import type {CompiledLane, TaskState} from "./machine.ts";

/**
 * The template's shape carrying the lane's own `machine.context`, as the text to write.
 *
 * The context is the one part of a booted lane's document that is **data, not shape**: a task's
 * `maxRetries` is read from it, and a lane may carry per-task extras beside it that the fold passes
 * through to status untouched. Copying the template over a lane verbatim would reset every one of
 * them to the template's own numbers — a silent loss no fold could catch, because the log still
 * replays. So the swap replaces the states and keeps the context.
 *
 * A founder's cleared round is *not* among the things being kept here, and deliberately: since
 * ADR 0312 a grant is a `CLEARED` line in `events.jsonl`, never a context field, so it survives the
 * swap for free — the log is what the new machine replays.
 *
 * `Foreign` is the other half of the same care: a lane whose machine was *generated* rather than
 * booted (`lane emit`'s per-epic document) has no committed template to be brought up to, so it is
 * not this sweep's business at all. The document `id` is the recognition — an emitted machine is
 * `epic-<n>` and a booted one carries its template's id.
 */
export type Graft =
	| {readonly _tag: "Grafted"; readonly text: string}
	| {readonly _tag: "Foreign"; readonly id: string}
	| {readonly _tag: "Ungraftable"; readonly reason: string};

const documentId = (document: unknown): string | null =>
	isRecord(document) && typeof document.id === "string" ? document.id : null;

const contextOf = (document: unknown): Record<string, unknown> | null => {
	if (!isRecord(document)) return null;
	const machine = document.machine;
	return isRecord(machine) && isRecord(machine.context) ? {...machine.context} : null;
};

/** Build the text a migration would write, or say why this lane is not one to write it to. */
export const graftContext = (templateText: string, laneText: string): Graft => {
	const template = parseJson(templateText);
	const lane = parseJson(laneText);
	const templateId = documentId(template);
	const laneId = documentId(lane);
	if (templateId === null)
		return {_tag: "Ungraftable", reason: "the committed template has no `id`"};
	if (laneId === null) return {_tag: "Ungraftable", reason: "this lane's document has no `id`"};
	if (laneId !== templateId) return {_tag: "Foreign", id: laneId};

	const templateContext = contextOf(template);
	const laneContext = contextOf(lane);
	if (templateContext === null || laneContext === null) {
		return {_tag: "Ungraftable", reason: "one of the two documents carries no `machine.context`"};
	}
	const grafted = Object.fromEntries(
		Object.keys(templateContext).map((task) => [task, laneContext[task] ?? templateContext[task]]),
	);
	const machine = (template as {machine: Record<string, unknown>}).machine;
	return {
		_tag: "Grafted",
		text: `${JSON.stringify({...(template as object), machine: {...machine, context: grafted}}, null, "\t")}\n`,
	};
};

/**
 * Whether two documents are the same machine once formatting is read past.
 *
 * `lane open` copies the committed template's biome-formatted bytes, with inline objects a tab
 * indent expands, so comparing text calls every un-booted-since lane stale whatever machine it
 * carries — the opposite of the question `--check` is asked. The comparison is order-sensitive on
 * purpose: a grafted document is built from the template, so a key order that differs is a template
 * that differs.
 */
export const sameMachine = (a: string, b: string): boolean => {
	const left = parseJson(a);
	const right = parseJson(b);
	if (left === null || right === null) return false;
	return JSON.stringify(left) === JSON.stringify(right);
};

/** One task whose folded state would move if the machine were swapped under it. */
export interface Drift {
	readonly task: string;
	readonly from: string;
	readonly to: string;
}

export type MigrationVerdict =
	/** The log replays through both machines to the same states — the swap changes no lane state. */
	| {readonly _tag: "Preserved"; readonly states: Readonly<Record<string, TaskState>>}
	/** The log does not replay through one of the machines, and which one decides the remedy. */
	| {
			readonly _tag: "Unreplayable";
			readonly through: "current" | "candidate";
			readonly defects: ReadonlyArray<string>;
	  }
	/** Both replay and disagree — the candidate would relocate the lane, not migrate it. */
	| {readonly _tag: "Drifts"; readonly drifts: ReadonlyArray<Drift>};

/**
 * Judge one swap. The candidate's task set may be a superset of the current one — a new task region
 * is a machine the log has nothing to say about yet, and it folds to its own initial state — but a
 * task the current machine folds and the candidate does not carry is a drift, because that lane's
 * state would simply stop being represented.
 */
export const judgeMigration = (
	current: CompiledLane,
	candidate: CompiledLane,
	entries: ReadonlyArray<LogEntry>,
): MigrationVerdict => {
	const before = foldLog(current, entries);
	if (before._tag !== "Folded") {
		return {_tag: "Unreplayable", through: "current", defects: before.defects};
	}
	const after = foldLog(candidate, entries);
	if (after._tag !== "Folded") {
		return {_tag: "Unreplayable", through: "candidate", defects: after.defects};
	}
	const drifts: Drift[] = [];
	for (const [task, state] of Object.entries(before.states)) {
		const next = after.states[task];
		if (next === undefined) {
			drifts.push({task, from: state.type, to: "(no such task)"});
			continue;
		}
		if (next.type !== state.type) drifts.push({task, from: state.type, to: next.type});
	}
	return drifts.length > 0 ? {_tag: "Drifts", drifts} : {_tag: "Preserved", states: after.states};
};
