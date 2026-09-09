/**
 * One subagent an agent spawned, as the window reads it — the model-blind slot any layer's mapper
 * fills from parent-tagged frames (founder ruling Q11 on #8384).
 *
 * Keyed on the spawning call's item id, so the row a window draws and the tool item it came from
 * are the same identity and no second correlation table exists. Nothing here names a backend: no
 * sidechain path, no SDK type, no agent id of the provider's own — a mapper translates all of that
 * into these six fields, which is what lets one running list render every agent program.
 *
 * `status` is the sixth field, beside the five Q11 names. Without it a finished subagent is
 * unrepresentable except by dropping the slot, and dropping it takes the rows out from under an
 * operator reading that subagent (Q9) — so it is marked finished and kept. It is also the only
 * thing that can say a slot has stopped moving, which is what the checkpoint gate reads
 * (`core/state.ts`).
 *
 * `tokens` is a plain count, and it is the one word `boundary.unit.test.ts` lets this file say. A
 * count is not a model: every backend that spawns workers can report one, and the row Q1 rules
 * shows it while the worker runs.
 *
 * `process` is the seventh and the only optional one: a slot the kernel spawned names the process
 * it is for, and a slot the backend spawned names none (founder rulings R1.1 and R2.1 on #8715).
 * It still names no backend — the kernel is Tuval's own — and it is what lets one row be opened as
 * a window where the other swaps the window's view.
 */

import {Predicate} from "effect";
import {
	type ItemId,
	isNonNegativeInteger,
	isTranscriptItems,
	type TranscriptItem,
} from "./transcript-item.ts";

/**
 * Whether the worker is still writing. `finished` is terminal for the process that holds it:
 * nothing outside a live layer can put a slot back to `running`.
 */
export type SubagentStatus = "running" | "finished";

export interface SubagentSlot {
	/** The spawning call's item id: one tool row, one worker, one slot. */
	readonly id: ItemId;
	/**
	 * What kind of worker this is, in the backend's own words — a label, never a type tag. `null`
	 * means no name is known: the spawning call named none and nothing resolved one. An empty string
	 * is not that fact and stays refused, so a surface can phrase the nameless row once instead of
	 * reading a placeholder back out (#8680).
	 */
	readonly type: string | null;
	/** The newest line the worker wrote, whatever kind of item carried it. */
	readonly lastLine: string;
	/** Epoch milliseconds, so the window computes elapsed without a backend clock type. */
	readonly startedAt: number;
	readonly tokens: number;
	/**
	 * Every item the worker produced, in arrival order. Every kind, not the assistant and tool ones
	 * alone: a worker's inbound turn arrives parent-tagged too, so a slot admitting less would drop
	 * rows out of the view Q7 switches to.
	 */
	readonly items: ReadonlyArray<TranscriptItem>;
	readonly status: SubagentStatus;
	/**
	 * The kernel process this slot is for, when the spawning call went through the kernel's `spawn`
	 * tool. Absent is the other fact and the only other one: the worker is the backend's own and
	 * names no process a window could open.
	 *
	 * One field rather than a mark beside an id, so "this is a kernel process" and "which one"
	 * cannot disagree — a marked row with no process, or a process on an unmarked row, are states
	 * this shape cannot spell. Nothing about it is a backend's: the kernel is Tuval's own.
	 */
	readonly process?: string;
}

const statuses: ReadonlySet<string> = new Set<SubagentStatus>(["running", "finished"]);

export const isSubagentSlot = (value: unknown): value is SubagentSlot =>
	Predicate.isObject(value) &&
	typeof value.id === "string" &&
	value.id.length > 0 &&
	(value.type === null || (typeof value.type === "string" && value.type.length > 0)) &&
	typeof value.lastLine === "string" &&
	Number.isFinite(value.startedAt) &&
	isNonNegativeInteger(value.tokens) &&
	isTranscriptItems(value.items) &&
	typeof value.status === "string" &&
	statuses.has(value.status) &&
	// Absent is a harness-native worker; an empty string is neither fact and stays refused.
	(value.process === undefined || (typeof value.process === "string" && value.process.length > 0));

/**
 * The slots one agent holds, by the id each is keyed on. An array is refused rather than admitted
 * as a record with numeric keys: this reads a checkpoint off disk, where that shape is corruption.
 */
export const isSubagentSlots = (value: unknown): value is Readonly<Record<string, SubagentSlot>> =>
	Predicate.isObject(value) && !Array.isArray(value) && Object.values(value).every(isSubagentSlot);
