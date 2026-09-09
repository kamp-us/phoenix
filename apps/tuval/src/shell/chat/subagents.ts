/**
 * What the running-subagent list is a list *of*, and the two labels its rows read in.
 *
 * Pure and model-blind: everything here is a function of the port's `SubagentSlot`
 * (`../../ai-agent/ports/subagent.ts`), so the list a window draws is the same list for every agent
 * program the moment that program's mapper fills the slot (founder ruling Q11 on #8384).
 *
 * A row draws the four fields Q1 names and nothing else — no count of the rows the slot holds, which
 * was a verbatim "no". `startedAt` rather than an elapsed number: elapsed is what a clock the
 * component reads makes of it, and computing it here would freeze it at the render that built the
 * model. `status` and `current` are not a fifth and sixth field but the row's own state: which
 * navigator entry is the one showing, and whether its worker still runs (#8406).
 *
 * `workers` is not that refused count either: Q1's "no" was about the transcript rows a slot holds,
 * and this is how many workers the one spawning call started. A fan-out stays one slot (founder
 * ruling 2026-09-09 on #8664), so without it the row's line, elapsed and tokens read as one
 * worker's when they are several workers' together.
 */

import type {ItemId, SubagentSlot, SubagentStatus} from "../../ai-agent/ports/index.ts";
import {workerCountLabel} from "./copy.ts";

/** How many rows the list shows before the tail collapses into one "more" row (Q3). */
export const SUBAGENT_ROW_CAP = 5;

/**
 * How a worker is named inside a sentence that already says "subagent" — the slot's own label, or
 * the bare word when no name is known. One phrase for the footer, the live region and the
 * transcript label, so none of them can double the word (#8680).
 */
export const subagentPhrase = (type: string | null, workers: number = 1): string => {
	const named = type === null ? "subagent" : `${type} subagent`;
	const count = workerCountLabel(workers);
	// Read as an adjective rather than appended, because every call site drops this into a sentence
	// ("the … is still running", "the …'s transcript") where a trailing count would break it.
	return count === null ? named : `${workers}-worker ${named}`;
};

export interface SubagentRow {
	readonly id: ItemId;
	/** The slot's label as-is, `null` included: a row with no name draws none. */
	readonly type: string | null;
	readonly lastLine: string;
	/** Epoch milliseconds, so the row's elapsed is the reader's own clock minus this. */
	readonly startedAt: number;
	readonly tokens: number;
	/** How many workers the slot holds. One is the ordinary row and draws no count. */
	readonly workers: number;
	/**
	 * A `finished` row is only ever here because it is the one being viewed (Q9). It draws neither
	 * elapsed nor tokens — Q2 answered "no" to both once a worker stops.
	 */
	readonly status: SubagentStatus;
	/** This row's transcript is the one the window is showing.  */
	readonly current: boolean;
}

export interface SubagentListModel {
	readonly rows: ReadonlyArray<SubagentRow>;
	/** How many running workers the cap left off. Zero means the list shows all of them. */
	readonly more: number;
}

const rowOf = (slot: SubagentSlot, current: boolean): SubagentRow => ({
	id: slot.id,
	type: slot.type,
	lastLine: slot.lastLine,
	startedAt: slot.startedAt,
	tokens: slot.tokens,
	workers: slot.workers,
	status: slot.status,
	current,
});

/**
 * The list the window draws, oldest-first and capped, plus the viewed worker wherever it is.
 *
 * Oldest-first, tie-broken on the id, because the order has to hold still: a list sorted by
 * anything that moves — the last line, the token count — would re-order itself under a reader's
 * eyes on every frame the workers write.
 *
 * A finished slot left the list the moment its worker stopped (Q2) — *unless* it is the one being
 * viewed, and then it is appended. That is what keeps the navigator honest under Q9: the operator
 * inside a subagent that finishes still sees which transcript they are reading and can pick another,
 * where a list that simply dropped the row would leave the view with no name on it.
 */
export const runningSubagents = (
	slots: Readonly<Record<string, SubagentSlot>>,
	viewing: string | null = null,
	/** How many running workers the list shows. The "more" row raises it to all of them (#8407). */
	cap: number = SUBAGENT_ROW_CAP,
): SubagentListModel => {
	const running = Object.values(slots)
		.filter((slot) => slot.status === "running")
		.sort((left, right) =>
			left.startedAt === right.startedAt
				? left.id.localeCompare(right.id)
				: left.startedAt - right.startedAt,
		);
	const shown = running.slice(0, cap);
	const held = new Set<string>(shown.map((slot) => slot.id));
	const viewed = viewing === null || held.has(viewing) ? undefined : slots[viewing];
	return {
		rows: [
			...shown.map((slot) => rowOf(slot, slot.id === viewing)),
			...(viewed === undefined ? [] : [rowOf(viewed, true)]),
		],
		more: running.length - shown.length - (viewed?.status === "running" ? 1 : 0),
	};
};

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * How long a worker has been running, in the coarsest unit that still moves: seconds under a
 * minute, then minutes and seconds, then hours and minutes. A duration below zero reads as zero —
 * a checkpoint restored on a machine whose clock moved back is not a worker that started in the
 * future.
 */
export const elapsedLabel = (millis: number): string => {
	const seconds = Math.max(0, Math.floor(millis / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
	return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
};

/** One tier of the compact count: the value in that unit, its zero decimal dropped. */
const compact = (value: number, unit: string): string => `${Number(value.toFixed(1))}${unit}`;

/**
 * A token count at the width a row can spare. Exact under a thousand, because that is where a
 * reader still reads the digits; compact above it, because the row is a glance and not a ledger.
 */
export const tokenLabel = (tokens: number): string => {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 1_000_000) return compact(tokens / 1_000, "k");
	return compact(tokens / 1_000_000, "M");
};
