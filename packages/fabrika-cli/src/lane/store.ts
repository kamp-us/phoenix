/**
 * The lane store — where a lane lives on disk, and the one guarded read every verb goes through.
 *
 * A lane is a directory: `.fabrika/lanes/<n>/workflow.json` (the machine document, placed there by
 * the operator from a committed template) plus `events.jsonl` (the append-only log, born on the
 * first recorded event). Lane state is local and gitignored — the repo `.gitignore`'s `/.fabrika/`
 * entry covers it (#5673).
 *
 * The load keeps four outcomes apart because they take opposite remedies: the lane is provably not
 * there, it could not be read (UNKNOWN, never "fresh"), it was read in full and is not the shape,
 * or it loaded. An absent `events.jsonl` alone is NOT one of them — a lane with no events yet is a
 * well-formed fresh lane, not a fault.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import {exists, readFile} from "../io/fs.ts";
import {type LogEntry, parseLog} from "./fold.ts";
import {type CompiledLane, compileText} from "./machine.ts";

export const DEFAULT_LANES_ROOT = ".fabrika/lanes";

export interface LaneRef {
	/** The lanes root — `.fabrika/lanes` unless a caller relocates it. */
	readonly root: string;
	/** The lane id under the root — by convention the issue number the lane drives. */
	readonly lane: string;
}

export type LoadedLane =
	| {
			readonly _tag: "Loaded";
			readonly lane: CompiledLane;
			readonly entries: ReadonlyArray<LogEntry>;
			readonly dir: string;
			readonly logPath: string;
	  }
	| {readonly _tag: "Absent"; readonly dir: string}
	| {readonly _tag: "Unreadable"; readonly path: string; readonly reason: string}
	| {readonly _tag: "Malformed"; readonly path: string; readonly defects: ReadonlyArray<string>};

/** Read and compile one lane. Every outcome is proven; nothing resolves to a plausible default. */
export const loadLane = (
	ref: LaneRef,
): Effect.Effect<LoadedLane, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const dir = path.join(ref.root, ref.lane);
		const workflowPath = path.join(dir, "workflow.json");
		const logPath = path.join(dir, "events.jsonl");

		const workflowText = yield* Effect.result(readFile(workflowPath));
		if (Result.isFailure(workflowText)) {
			const probe = yield* Effect.result(exists(workflowPath));
			if (Result.isFailure(probe) || probe.success) {
				return {
					_tag: "Unreadable",
					path: workflowPath,
					reason: workflowText.failure.reason,
				} as const;
			}
			return {_tag: "Absent", dir} as const;
		}

		const compiled = compileText(workflowText.success);
		if (compiled._tag === "Malformed") {
			return {_tag: "Malformed", path: workflowPath, defects: compiled.defects} as const;
		}

		const logText = yield* Effect.result(readFile(logPath));
		if (Result.isFailure(logText)) {
			const probe = yield* Effect.result(exists(logPath));
			if (Result.isFailure(probe) || probe.success) {
				return {_tag: "Unreadable", path: logPath, reason: logText.failure.reason} as const;
			}
			return {_tag: "Loaded", lane: compiled.lane, entries: [], dir, logPath} as const;
		}
		const parsed = parseLog(logText.success);
		if (parsed._tag === "Malformed") {
			return {_tag: "Malformed", path: logPath, defects: parsed.defects} as const;
		}
		return {_tag: "Loaded", lane: compiled.lane, entries: parsed.entries, dir, logPath} as const;
	});
