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
	/** What kind of worker this is, in the backend's own words — a label, never a type tag. */
	readonly type: string;
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
}

const statuses: ReadonlySet<string> = new Set<SubagentStatus>(["running", "finished"]);

export const isSubagentSlot = (value: unknown): value is SubagentSlot =>
	Predicate.isObject(value) &&
	typeof value.id === "string" &&
	value.id.length > 0 &&
	typeof value.type === "string" &&
	typeof value.lastLine === "string" &&
	Number.isFinite(value.startedAt) &&
	isNonNegativeInteger(value.tokens) &&
	isTranscriptItems(value.items) &&
	typeof value.status === "string" &&
	statuses.has(value.status);

/**
 * The slots one agent holds, by the id each is keyed on. An array is refused rather than admitted
 * as a record with numeric keys: this reads a checkpoint off disk, where that shape is corruption.
 */
export const isSubagentSlots = (value: unknown): value is Readonly<Record<string, SubagentSlot>> =>
	Predicate.isObject(value) && !Array.isArray(value) && Object.values(value).every(isSubagentSlot);
