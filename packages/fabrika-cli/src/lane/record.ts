/**
 * A lane's record — what the lane did, derived from its log and facts, ready to post.
 *
 * Nothing here is stored: builds, reviews, parks and asks are all read off a step-by-step replay
 * of `events.jsonl`, so the record cannot disagree with the ledger it summarises. The replay folds
 * each prefix of the log, which is what gives every event the leaf it left and the leaf it landed
 * in — the log itself records neither.
 *
 * An **ask** is a park whose route is `founder`: a lane that stopped on something only a person
 * could answer. The route is `report.ts`'s cause table, so a park nothing named routes to the
 * founder, the same fail-closed reading `recipe unpark` takes.
 */
import {acceptsOf} from "@demlik/tea";
import {
	asksOf,
	decode,
	type Instant,
	instant,
	type LaneRecord,
	type Park,
	type Spent,
} from "../wire/lane-record.ts";
import {deferredTasks, resolveDeferrals} from "./deferral.ts";
import {type LaneFact, standingOrigin, standingWait} from "./facts.ts";
import {deriveStatus, foldLog, type LogEntry, standingCauses} from "./fold.ts";
import {
	AMENDED_EVENT,
	bareEvent,
	CORRECTED_EVENT,
	type CompiledLane,
	type TaskState,
} from "./machine.ts";
import {routeForCause, structuralParkCause} from "./report.ts";

/**
 * What the shipped spend reader says. The spend ledger (`spend/`) counts tokens per response and
 * carries no price, and no rate card turns tokens into dollars, so the honest dollar figure is none.
 */
export const LEDGER_SPEND: Spent = {
	_tag: "Unmeasured",
	reason: "the spend ledger records token counts, and no rate card converts them to dollars",
};

/** One replayed event: the leaf its task left and the leaf it landed in. */
export interface Step {
	readonly entry: LogEntry;
	readonly from: string;
	readonly to: string;
}

export type Trace =
	| {
			readonly _tag: "Traced";
			readonly steps: ReadonlyArray<Step>;
			readonly states: Readonly<Record<string, TaskState>>;
	  }
	| {readonly _tag: "Unreplayable"; readonly defects: ReadonlyArray<string>};

/**
 * Replay the log one prefix at a time. An event about no task of this machine — an amendment, a
 * correction, a deferred task's history — moves no leaf and is left out of the steps.
 */
export const traceLog = (lane: CompiledLane, entries: ReadonlyArray<LogEntry>): Trace => {
	const deferrals = resolveDeferrals(entries);
	if (deferrals._tag === "Undecidable") return {_tag: "Unreplayable", defects: deferrals.defects};
	const pending = [...deferredTasks(deferrals.deferrals)];
	let before = foldLog(lane, [], pending);
	if (before._tag !== "Folded") return before;
	const steps: Step[] = [];
	for (const [index, entry] of entries.entries()) {
		const after = foldLog(lane, entries.slice(0, index + 1), pending);
		if (after._tag !== "Folded") return after;
		const bare = bareEvent(entry.event);
		const from = before.states[entry.task]?.type;
		const to = after.states[entry.task]?.type;
		if (
			bare !== AMENDED_EVENT &&
			bare !== CORRECTED_EVENT &&
			from !== undefined &&
			to !== undefined
		) {
			steps.push({entry, from, to});
		}
		before = after;
	}
	return {_tag: "Traced", steps, states: before.states};
};

const PROGRESS_EVENTS = ["DONE", "PASS", "FAIL", "WIP", "LAP", "BLOCKED"];

/** A park is a leaf whose one way out is `UNBLOCKED` — read off the machine, never a name list. */
const isPark = (lane: CompiledLane, task: string, leaf: string): boolean => {
	const compiled = lane.tasks[task];
	if (compiled === undefined) return false;
	const accepts = acceptsOf(compiled.machine, leaf);
	return accepts.includes("UNBLOCKED") && !accepts.some((event) => PROGRESS_EVENTS.includes(event));
};

const stage = (leaf: string, name: string): boolean => leaf === name || leaf.startsWith(`${name}:`);

export interface Tally {
	readonly builds: number;
	readonly reviews: number;
	readonly parks: ReadonlyArray<Park>;
}

/** Builds, reviews and parks, counted off the replay. */
export const tally = (lane: CompiledLane, steps: ReadonlyArray<Step>): Tally => {
	let builds = 0;
	let reviews = 0;
	const parks: Park[] = [];
	for (const {entry, from, to} of steps) {
		const bare = bareEvent(entry.event);
		if (bare === "DONE" && stage(from, "build")) builds += 1;
		if ((bare === "PASS" || bare === "FAIL") && stage(from, "review")) reviews += 1;
		if (to !== from && isPark(lane, entry.task, to)) {
			const cause = entry.cause ?? structuralParkCause(to);
			const at = instant(entry.at);
			if (at !== null) {
				parks.push({task: entry.task, leaf: to, cause, route: routeForCause(cause), at});
			}
		}
	}
	return {builds, reviews, parks};
};

/** The asks a log holds — founder-routed parks, derived and never stored. */
export const asksInLog = (lane: CompiledLane, entries: ReadonlyArray<LogEntry>): number | null => {
	const trace = traceLog(lane, entries);
	return trace._tag === "Traced" ? asksOf(tally(lane, trace.steps)) : null;
};

const PR_URL = /\/pull\/(\d+)(?:[/?#]|$)/;

/** The pull requests the log names as evidence, by number. */
export const prsOf = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<number> => {
	const numbers = new Set<number>();
	for (const entry of entries) {
		const named =
			entry.pr === undefined ? null : (PR_URL.exec(entry.pr) ?? /^#?(\d+)$/.exec(entry.pr.trim()));
		if (named?.[1] !== undefined) numbers.add(Number(named[1]));
		for (const landed of entry.landed ?? []) numbers.add(landed);
	}
	return [...numbers].sort((a, b) => a - b);
};

export interface RecordInput {
	readonly issue: number;
	readonly lane: CompiledLane;
	readonly entries: ReadonlyArray<LogEntry>;
	readonly facts: ReadonlyArray<LaneFact>;
	readonly spent: Spent;
}

export type Composition =
	| {readonly _tag: "Composed"; readonly record: LaneRecord}
	| {readonly _tag: "NotTerminal"; readonly stateValue: unknown}
	| {readonly _tag: "Unreplayable"; readonly defects: ReadonlyArray<string>};

/** The record of a lane that has reached a terminal state; any other lane has none to post. */
export const composeRecord = (input: RecordInput): Composition => {
	const trace = traceLog(input.lane, input.entries);
	if (trace._tag === "Unreplayable") return trace;
	const status = deriveStatus(input.lane, trace.states, standingCauses(input.entries));
	const last = input.entries.at(-1);
	if (status.status !== "done" || typeof status.stateValue !== "string" || last === undefined) {
		return {_tag: "NotTerminal", stateValue: status.stateValue};
	}
	const counted = tally(input.lane, trace.steps);
	const opened = standingOrigin(input.facts);
	const first = input.entries[0]?.at ?? last.at;
	const startedAt: Instant | null =
		opened.at !== null && Date.parse(opened.at) < Date.parse(first) ? opened.at : instant(first);
	const decoded = decode({
		issue: input.issue,
		outcome: status.stateValue,
		startedAt,
		terminalAt: last.at,
		builds: counted.builds,
		reviews: counted.reviews,
		parks: counted.parks,
		spent: input.spent,
		origin: opened.origin,
		waiting: standingWait(input.facts),
		prs: prsOf(input.entries),
		log: input.entries.map((entry) => JSON.stringify(entry)),
	});
	return decoded.ok
		? {_tag: "Composed", record: decoded.value}
		: {_tag: "Unreplayable", defects: [`the log does not compose a record: ${decoded.reason}`]};
};
