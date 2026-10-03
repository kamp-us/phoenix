/**
 * The worktrees a lane's shells were handed — the set `lane cleanup` removes when the run ends.
 *
 * Every shell of a lane runs in a worktree of its own, and the only one the lane used to hear about
 * was the builder's, through an in-flight `working` record that stops standing at the task's next
 * event. So a finished lane left every tree behind with nothing naming them. These records live in
 * their own append-only `worktrees.jsonl` beside the log and are read by no fold: a `handed` line
 * names a tree, a `removed` line retires it, and a tree is in the set while its latest line is
 * `handed`. Nothing here expires with an event.
 *
 * The file is its own rather than a kind in `in-flight.jsonl`, whose reader refuses a kind it does
 * not know: a shell running a newer fabrika than its driver would otherwise break the driver's
 * `lane status`.
 *
 * `removed` exists because a path can be reused. Without it a tree placed later at a path this lane
 * once held would be this lane's to remove.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10340
 */
import {isAbsolute} from "node:path";
import {Effect, type FileSystem, Path, Result} from "effect";
import {readFile} from "../io/fs.ts";
import {type Instant, instant} from "../wire/lane-record.ts";

export const WORKTREES_FILE = "worktrees.jsonl";

export type WorktreeRecord =
	/** A shell of this lane runs in the absolute `worktree`; `task` is the one it serves, if it named one. */
	| {
			readonly kind: "handed";
			readonly worktree: string;
			readonly task: string | null;
			readonly at: Instant;
	  }
	/** `lane cleanup` removed `worktree`, or found it already gone. */
	| {readonly kind: "removed"; readonly worktree: string; readonly at: Instant};

const decodeRecord = (value: unknown): WorktreeRecord | string => {
	if (typeof value !== "object" || value === null) return "is not a JSON object";
	const raw = value as Record<string, unknown>;
	const at = instant(String(raw.at ?? ""));
	const worktree = typeof raw.worktree === "string" ? raw.worktree : "";
	if (at === null || !isAbsolute(worktree))
		return "carries no absolute `worktree` and `at` instant";
	if (raw.kind === "removed") return {kind: "removed", worktree, at};
	if (raw.kind !== "handed") return "is neither a handed nor a removed record";
	if (raw.task !== null && (typeof raw.task !== "string" || raw.task === "")) {
		return "is a handed record whose `task` is neither a task nor null";
	}
	return {kind: "handed", worktree, task: raw.task, at};
};

export type WorktreesParse =
	| {readonly _tag: "Parsed"; readonly records: ReadonlyArray<WorktreeRecord>}
	| {readonly _tag: "Malformed"; readonly defects: ReadonlyArray<string>};

/** Parse the file's text. A line that does not decode is a defect, never a skipped record. */
export const parseWorktrees = (text: string): WorktreesParse => {
	const records: WorktreeRecord[] = [];
	const defects: string[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim() === "") continue;
		const parsed = Result.try({try: (): unknown => JSON.parse(line), catch: () => null});
		const record = Result.isFailure(parsed) ? "is not JSON" : decodeRecord(parsed.success);
		if (typeof record === "string") defects.push(`${WORKTREES_FILE} line ${index + 1} ${record}`);
		else records.push(record);
	}
	return defects.length > 0 ? {_tag: "Malformed", defects} : {_tag: "Parsed", records};
};

export const encodeWorktree = (record: WorktreeRecord): string => `${JSON.stringify(record)}\n`;

export type WorktreesLoad =
	| {
			readonly _tag: "Loaded";
			readonly records: ReadonlyArray<WorktreeRecord>;
			readonly path: string;
	  }
	| {readonly _tag: "Unreadable"; readonly path: string; readonly reason: string}
	| {readonly _tag: "Malformed"; readonly path: string; readonly defects: ReadonlyArray<string>};

/** Read a lane's worktree records. An absent file is a lane that recorded none, never a fault. */
export const loadWorktrees = (
	dir: string,
): Effect.Effect<WorktreesLoad, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = (yield* Path.Path).join(dir, WORKTREES_FILE);
		const text = yield* Effect.result(readFile(path));
		if (Result.isFailure(text)) {
			return text.failure.notFound
				? ({_tag: "Loaded", records: [], path} as const)
				: ({_tag: "Unreadable", path, reason: text.failure.reason} as const);
		}
		const parsed = parseWorktrees(text.success);
		return parsed._tag === "Malformed"
			? ({_tag: "Malformed", path, defects: parsed.defects} as const)
			: ({_tag: "Loaded", records: parsed.records, path} as const);
	});

/** One tree the lane still holds: where it is and which task's shell it was handed to. */
export interface HandedTree {
	readonly worktree: string;
	readonly task: string | null;
}

/** The trees whose latest record is `handed`, in the order each was first recorded. */
export const handedTrees = (records: ReadonlyArray<WorktreeRecord>): ReadonlyArray<HandedTree> => {
	const latest = new Map<string, WorktreeRecord>();
	for (const record of records) latest.set(record.worktree, record);
	return [...latest.values()].flatMap((record) =>
		record.kind === "handed" ? [{worktree: record.worktree, task: record.task}] : [],
	);
};
