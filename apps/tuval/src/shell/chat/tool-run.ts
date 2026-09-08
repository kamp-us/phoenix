/**
 * A run of consecutive tool calls as one sentence, in the tool's own words — "Read 3 files",
 * "Ran 2 commands and changed 1 file".
 *
 * The grammar is T3 Code's, read at pingdotgg/t3code `0fe4c99`
 * (`packages/client-runtime/src/work-log/presentation.ts:487-563`): bucket the calls by action in
 * first-seen order, one clause per bucket, then join — one clause as it stands, two as "A and b",
 * three or more as "A, b, and c", with every clause after the first lowercased at its first
 * character so the line reads as one sentence rather than a list of headings.
 *
 * Two things this deliberately does not do. It never names a target: the line says how many files
 * were read, never which, because the argument belongs to the call's own disclosure and a summary
 * that guessed one would be a fictional tool argument. And it reads the action off the call's input
 * *shape* (`tool-detail.ts`'s `toolShape`), never off the tool's name, which is what serves Pi's
 * `edit_file` and the SDK's `Edit` from one code path.
 */

import type {ToolItem, ToolStatus} from "../../ai-agent/ports/index.ts";
import {type ToolAction, toolShape} from "./tool-detail.ts";

const clause: Readonly<Record<ToolAction, (count: number) => string>> = {
	read: (count) => `Read ${count} ${count === 1 ? "file" : "files"}`,
	edit: (count) => `Changed ${count} ${count === 1 ? "file" : "files"}`,
	command: (count) => `Ran ${count} ${count === 1 ? "command" : "commands"}`,
	other: (count) => `Used ${count} ${count === 1 ? "tool" : "tools"}`,
};

/**
 * What one bucket counts. Edits count **distinct files** — three edits to one file changed one file
 * — so the bucket carries the paths as well as the calls, and `count` reads whichever the action
 * asks for.
 */
interface Bucket {
	calls: number;
	readonly paths: Set<string>;
}

/** The buckets in first-seen order. A `Map` keeps insertion order, and re-setting a key never moves it. */
const bucketed = (calls: ReadonlyArray<ToolItem>): ReadonlyMap<ToolAction, Bucket> => {
	const buckets = new Map<ToolAction, Bucket>();
	for (const item of calls) {
		const shape = toolShape(item);
		const bucket = buckets.get(shape.action) ?? {calls: 0, paths: new Set<string>()};
		bucket.calls += 1;
		if (shape.action === "edit") bucket.paths.add(shape.path);
		buckets.set(shape.action, bucket);
	}
	return buckets;
};

/** Join the clauses into one sentence, lowercasing every clause after the first. */
const sentence = (clauses: ReadonlyArray<string>): string => {
	const joined = clauses.map((text, index) =>
		index === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1),
	);
	if (joined.length < 2) return joined[0] ?? "";
	if (joined.length === 2) return joined.join(" and ");
	return `${joined.slice(0, -1).join(", ")}, and ${joined[joined.length - 1]}`;
};

/** The run's whole line. Empty only for an empty run, which the row type cannot hold. */
export const runSentence = (calls: ReadonlyArray<ToolItem>): string =>
	sentence(
		[...bucketed(calls)].map(([action, bucket]) =>
			clause[action](action === "edit" ? bucket.paths.size : bucket.calls),
		),
	);

/**
 * The run's status: a failure anywhere is the run's, and a call still going outranks a settled one.
 * A run never hides a failure behind the calls that succeeded around it.
 */
export const runStatus = (calls: ReadonlyArray<ToolItem>): ToolStatus => {
	if (calls.some((call) => call.status === "error")) return "error";
	return calls.some((call) => call.status === "running") ? "running" : "ok";
};

/**
 * The status as a word beside the sentence, or nothing at all for a run that simply finished.
 * Pillar 4: this is what carries the state, so neither the dot's tint nor the shimmer is ever the
 * only signal — and a reader who asked for no motion still reads "running".
 */
export const runStatusWord = (status: ToolStatus): string | null => {
	if (status === "error") return "failed";
	return status === "running" ? "running" : null;
};
