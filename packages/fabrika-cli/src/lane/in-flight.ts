/**
 * The shell in flight on each task — who the ledger says is working a task right now, and where.
 *
 * Between a dispatch and the terminal it earns, the event log records nothing, so a working
 * re-spawn and a stuck lane read the same. Two records fill that gap: the driver's `dispatched`,
 * written before it spawns, and the builder's `working`, written once its build claim wins. They
 * live in their own append-only `in-flight.jsonl` beside the log, so no fold reads them and the
 * machine moves exactly as it did without them. The file is its own rather than a kind in
 * `facts.jsonl`: a reader there refuses a kind it does not know, so a builder running a newer
 * fabrika than its driver would otherwise break the driver's `lane record` and `lane wait`.
 *
 * A record stands until the log moves its task after it: a terminal, a lap, a park, any event the
 * task's machine takes. The events that move no task — a clearance, a correction, an amendment —
 * supersede nothing. A `working` recorded before the standing `dispatched` belongs to the shell that
 * dispatch replaced, so it does not stand.
 *
 * **This is a record of who said they were working, never evidence that they still are.** Nothing
 * reads a record's age or its absence as a death: no claim release, worktree retire or reap reads
 * this file, and a shell that dies without a terminal leaves its record standing until the driver
 * records the lap or park that death is owed.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10232
 */
import {isAbsolute} from "node:path";
import {Effect, type FileSystem, Path, Result} from "effect";
import {parseToken} from "../build/lane.ts";
import {readFile} from "../io/fs.ts";
import {type LaneShell, type ShellState, shellOf, shellState} from "../wire/lane-brief.ts";
import {type Instant, instant} from "../wire/lane-record.ts";
import type {LogEntry} from "./fold.ts";
import {AMENDED_EVENT, bareEvent, CLEARED_EVENT, CORRECTED_EVENT} from "./machine.ts";

export const IN_FLIGHT_FILE = "in-flight.jsonl";

export type InFlightRecord =
	/** A driver is about to spawn the shell `state` routes to for `task`. */
	| {
			readonly kind: "dispatched";
			readonly task: string;
			readonly state: ShellState;
			readonly at: Instant;
	  }
	/** A builder won `token` for `task` and works in the absolute `worktree` on this machine. */
	| {
			readonly kind: "working";
			readonly task: string;
			readonly token: string;
			readonly worktree: string;
			readonly at: Instant;
	  };

const decodeRecord = (value: unknown): InFlightRecord | string => {
	if (typeof value !== "object" || value === null) return "is not a JSON object";
	const raw = value as Record<string, unknown>;
	const at = instant(String(raw.at ?? ""));
	const task = typeof raw.task === "string" ? raw.task : "";
	if (at === null || task === "") return "carries no `task` and `at` instant";
	if (raw.kind === "dispatched") {
		const state = shellState(String(raw.state ?? ""));
		return state === null
			? "is a dispatched record whose `state` routes to no shell"
			: {kind: "dispatched", task, state, at};
	}
	if (raw.kind === "working") {
		const token = typeof raw.token === "string" ? raw.token : "";
		const worktree = typeof raw.worktree === "string" ? raw.worktree : "";
		return parseToken(token) === null || !isAbsolute(worktree)
			? "is a working record without a build claim `token` and an absolute `worktree`"
			: {kind: "working", task, token, worktree, at};
	}
	return "is neither a dispatched nor a working record";
};

export type InFlightParse =
	| {readonly _tag: "Parsed"; readonly records: ReadonlyArray<InFlightRecord>}
	| {readonly _tag: "Malformed"; readonly defects: ReadonlyArray<string>};

/** Parse the file's text. A line that does not decode is a defect, never a skipped record. */
export const parseInFlight = (text: string): InFlightParse => {
	const records: InFlightRecord[] = [];
	const defects: string[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim() === "") continue;
		const parsed = Result.try({try: (): unknown => JSON.parse(line), catch: () => null});
		const record = Result.isFailure(parsed) ? "is not JSON" : decodeRecord(parsed.success);
		if (typeof record === "string") defects.push(`${IN_FLIGHT_FILE} line ${index + 1} ${record}`);
		else records.push(record);
	}
	return defects.length > 0 ? {_tag: "Malformed", defects} : {_tag: "Parsed", records};
};

export const encodeInFlight = (record: InFlightRecord): string => `${JSON.stringify(record)}\n`;

export type InFlightLoad =
	| {
			readonly _tag: "Loaded";
			readonly records: ReadonlyArray<InFlightRecord>;
			readonly path: string;
	  }
	| {readonly _tag: "Unreadable"; readonly path: string; readonly reason: string}
	| {readonly _tag: "Malformed"; readonly path: string; readonly defects: ReadonlyArray<string>};

/** Read a lane's in-flight records. An absent file is a lane with none, never a fault. */
export const loadInFlight = (
	dir: string,
): Effect.Effect<InFlightLoad, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = (yield* Path.Path).join(dir, IN_FLIGHT_FILE);
		const text = yield* Effect.result(readFile(path));
		if (Result.isFailure(text)) {
			return text.failure.notFound
				? ({_tag: "Loaded", records: [], path} as const)
				: ({_tag: "Unreadable", path, reason: text.failure.reason} as const);
		}
		const parsed = parseInFlight(text.success);
		return parsed._tag === "Malformed"
			? ({_tag: "Malformed", path, defects: parsed.defects} as const)
			: ({_tag: "Loaded", records: parsed.records, path} as const);
	});

export interface Dispatched {
	readonly state: ShellState;
	readonly shell: LaneShell;
	readonly at: Instant;
}

export interface Working {
	readonly token: string;
	readonly worktree: string;
	readonly at: Instant;
}

/** One task's standing record — a dispatch, a builder's seat, or both, never neither. */
export type InFlight =
	| {readonly dispatched: Dispatched; readonly working: Working | null}
	| {readonly dispatched: null; readonly working: Working};

const STILL_EVENTS: ReadonlySet<string> = new Set([CLEARED_EVENT, CORRECTED_EVENT, AMENDED_EVENT]);

const movedSince = (entries: ReadonlyArray<LogEntry>, task: string, at: Instant): boolean =>
	entries.some(
		(entry) =>
			entry.task === task &&
			!STILL_EVENTS.has(bareEvent(entry.event)) &&
			Date.parse(entry.at) > Date.parse(at),
	);

/** Every task with a standing record, keyed by task. A task with none is absent. */
export const inFlight = (
	records: ReadonlyArray<InFlightRecord>,
	entries: ReadonlyArray<LogEntry>,
): Readonly<Record<string, InFlight>> => {
	const standing: Record<string, InFlight> = {};
	for (const task of new Set(records.map((record) => record.task))) {
		const lastDispatch = records.findLast(
			(record): record is Extract<InFlightRecord, {kind: "dispatched"}> =>
				record.kind === "dispatched" && record.task === task,
		);
		const lastWorking = records.findLast(
			(record): record is Extract<InFlightRecord, {kind: "working"}> =>
				record.kind === "working" && record.task === task,
		);
		const dispatched: Dispatched | null =
			lastDispatch === undefined || movedSince(entries, task, lastDispatch.at)
				? null
				: {state: lastDispatch.state, shell: shellOf(lastDispatch.state), at: lastDispatch.at};
		const working: Working | null =
			lastWorking === undefined ||
			movedSince(entries, task, lastWorking.at) ||
			(dispatched !== null && Date.parse(lastWorking.at) < Date.parse(dispatched.at))
				? null
				: {token: lastWorking.token, worktree: lastWorking.worktree, at: lastWorking.at};
		if (dispatched !== null) standing[task] = {dispatched, working};
		else if (working !== null) standing[task] = {dispatched: null, working};
	}
	return standing;
};
