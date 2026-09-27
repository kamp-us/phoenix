/**
 * A lane's facts — what the lane is, beside what it did.
 *
 * `events.jsonl` is the machine's log: every line folds through a task's machine, and a line no
 * machine holds a cell for is a replay defect. Where a lane came from, and what it is waiting on,
 * move no task, so they live in their own append-only `facts.jsonl` beside the log and no fold
 * ever reads them. The lane directory moves as a whole on archive, so the two files never part.
 *
 * Two kinds, both closed. An `origin` line is written once, by `lane open`; a lane carrying none —
 * booted before this file existed, or by `lane emit` — reads as a driver pick, the default the
 * ruling names. A `waiting` line is written by `lane wait`, and the latest one stands.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import {readFile} from "../io/fs.ts";
import {
	DEFAULT_ORIGIN,
	type Instant,
	instant,
	type Origin,
	origin,
	type Waiting,
	waitingOn,
} from "../wire/lane-record.ts";

export const FACTS_FILE = "facts.jsonl";

export type LaneFact =
	| {readonly kind: "origin"; readonly origin: Origin; readonly at: Instant}
	| {readonly kind: "waiting"; readonly on: string; readonly until: Instant; readonly at: Instant};

export type FactsParse =
	| {readonly _tag: "Parsed"; readonly facts: ReadonlyArray<LaneFact>}
	| {readonly _tag: "Malformed"; readonly defects: ReadonlyArray<string>};

const decodeFact = (value: unknown): LaneFact | string => {
	if (typeof value !== "object" || value === null) return "is not a JSON object";
	const raw = value as Record<string, unknown>;
	const at = instant(String(raw.at ?? ""));
	if (at === null) return "carries no `at` instant";
	if (raw.kind === "origin") {
		const named = origin(String(raw.origin ?? ""));
		return named === null
			? "names an origin outside the closed set"
			: {kind: "origin", origin: named, at};
	}
	if (raw.kind === "waiting") {
		const until = instant(String(raw.until ?? ""));
		const on = typeof raw.on === "string" ? raw.on.trim() : "";
		if (until === null || !waitingOn(on))
			return "is a waiting fact without a one-line `on` and an `until` date";
		return {kind: "waiting", on, until, at};
	}
	return "is neither an origin nor a waiting fact";
};

/** Parse the facts text. A line that does not decode is a defect, never a skipped fact. */
export const parseFacts = (text: string): FactsParse => {
	const facts: LaneFact[] = [];
	const defects: string[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim() === "") continue;
		const parsed = Result.try({try: (): unknown => JSON.parse(line), catch: () => null});
		if (Result.isFailure(parsed)) {
			defects.push(`facts line ${index + 1} is not JSON`);
			continue;
		}
		const fact = decodeFact(parsed.success);
		if (typeof fact === "string") defects.push(`facts line ${index + 1} ${fact}`);
		else facts.push(fact);
	}
	if (facts.filter((fact) => fact.kind === "origin").length > 1) {
		defects.push("the facts record more than one origin — a lane starts once");
	}
	return defects.length > 0 ? {_tag: "Malformed", defects} : {_tag: "Parsed", facts};
};

export const encodeFact = (fact: LaneFact): string => `${JSON.stringify(fact)}\n`;

/** Where the lane came from, and when that was recorded — `null` where no line says. */
export const standingOrigin = (
	facts: ReadonlyArray<LaneFact>,
): {readonly origin: Origin; readonly at: Instant | null} => {
	const fact = facts.find((candidate) => candidate.kind === "origin");
	return fact?.kind === "origin"
		? {origin: fact.origin, at: fact.at}
		: {origin: DEFAULT_ORIGIN, at: null};
};

/** The latest wait the lane declared. Whether it has lapsed is the reader's clock, not the record's. */
export const standingWait = (facts: ReadonlyArray<LaneFact>): Waiting => {
	const fact = facts.findLast((candidate) => candidate.kind === "waiting");
	return fact?.kind === "waiting"
		? {_tag: "Until", on: fact.on, until: fact.until}
		: {_tag: "None"};
};

export type FactsLoad =
	| {readonly _tag: "Loaded"; readonly facts: ReadonlyArray<LaneFact>; readonly path: string}
	| {readonly _tag: "Unreadable"; readonly path: string; readonly reason: string}
	| {readonly _tag: "Malformed"; readonly path: string; readonly defects: ReadonlyArray<string>};

/** Read a lane's facts. An absent file is a lane with no facts, never a fault. */
export const loadFacts = (
	dir: string,
): Effect.Effect<FactsLoad, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = (yield* Path.Path).join(dir, FACTS_FILE);
		const text = yield* Effect.result(readFile(path));
		if (Result.isFailure(text)) {
			return text.failure.notFound
				? ({_tag: "Loaded", facts: [], path} as const)
				: ({_tag: "Unreadable", path, reason: text.failure.reason} as const);
		}
		const parsed = parseFacts(text.success);
		return parsed._tag === "Malformed"
			? ({_tag: "Malformed", path, defects: parsed.defects} as const)
			: ({_tag: "Loaded", facts: parsed.facts, path} as const);
	});
