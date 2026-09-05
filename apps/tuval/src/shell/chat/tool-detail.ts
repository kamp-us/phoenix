/**
 * What an expanded tool row shows below the name, derived from the call's input alone.
 *
 * The port is model-blind (`../../ai-agent/ports/transcript-item.ts`): a tool's `input` is plain
 * JSON and its `name` is whatever the backend called it. So the window recognises a **shape**, never
 * a name — an edit is "a path plus an old and a new text", a shell call is "a command" — and one
 * renderer serves Pi's `edit_file` and the SDK's `Edit` without knowing either exists.
 *
 * The key aliases below are the reason this is data rather than a field access: two backends spell
 * the same field four ways, and a window that read one spelling would silently fall back to raw
 * JSON for the other.
 */

import type {JsonValue, ToolItem} from "../../ai-agent/ports/index.ts";

export interface DiffLine {
	readonly kind: "same" | "removed" | "added";
	readonly text: string;
}

export type ToolDetail =
	/** A file edit: the path it touched, and the line diff between the two texts. */
	| {readonly kind: "edit"; readonly path: string; readonly diff: ReadonlyArray<DiffLine>}
	/** A shell call. The output is the item's own `result`, which every row renders. */
	| {readonly kind: "shell"; readonly command: string}
	/** Anything else: the input, pretty-printed. */
	| {readonly kind: "generic"; readonly input: string};

const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;
const OLD_KEYS = ["old_text", "oldText", "old_string", "oldString", "old"] as const;
const NEW_KEYS = ["new_text", "newText", "new_string", "newString", "new"] as const;
const COMMAND_KEYS = ["command", "cmd"] as const;

const isRecord = (value: JsonValue): value is {readonly [key: string]: JsonValue} =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stringAt = (
	input: {readonly [key: string]: JsonValue},
	keys: ReadonlyArray<string>,
): string | null => {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string") return value;
	}
	return null;
};

/**
 * Split on `\n` and drop a single trailing empty line, so a text ending in a newline and the same
 * text without one diff as identical rather than as one phantom removed line.
 */
const lines = (text: string): ReadonlyArray<string> => {
	const split = text.split("\n");
	return split.length > 1 && split[split.length - 1] === "" ? split.slice(0, -1) : split;
};

/**
 * The line diff: trim the common prefix and the common suffix, and call everything between them
 * removed-then-added.
 *
 * Deliberately **not** an LCS. A tool input carries no bound — it is whatever the backend put on
 * the wire — and an LCS is quadratic in the line counts, so a single large edit would spend the
 * render thread on a table nobody reads. This pass is linear, deterministic, and shows an edit the
 * way an edit tool makes one: a contiguous region replaced inside unchanged surroundings.
 */
export const diffLines = (before: string, after: string): ReadonlyArray<DiffLine> => {
	const from = lines(before);
	const to = lines(after);
	let head = 0;
	while (head < from.length && head < to.length && from[head] === to[head]) head += 1;
	let tail = 0;
	while (
		tail < from.length - head &&
		tail < to.length - head &&
		from[from.length - 1 - tail] === to[to.length - 1 - tail]
	) {
		tail += 1;
	}
	const rows: Array<DiffLine> = [];
	for (const text of from.slice(0, head)) rows.push({kind: "same", text});
	for (const text of from.slice(head, from.length - tail)) rows.push({kind: "removed", text});
	for (const text of to.slice(head, to.length - tail)) rows.push({kind: "added", text});
	for (const text of from.slice(from.length - tail)) rows.push({kind: "same", text});
	return rows;
};

/** What the expanded row shows for one call. Total: every input has a rendering. */
export const toolDetail = (item: ToolItem): ToolDetail => {
	const input = item.input;
	if (!isRecord(input)) return {kind: "generic", input: JSON.stringify(input) ?? "null"};
	const path = stringAt(input, PATH_KEYS);
	const before = stringAt(input, OLD_KEYS);
	const after = stringAt(input, NEW_KEYS);
	if (path !== null && before !== null && after !== null) {
		return {kind: "edit", path, diff: diffLines(before, after)};
	}
	const command = stringAt(input, COMMAND_KEYS);
	if (command !== null) return {kind: "shell", command};
	return {kind: "generic", input: JSON.stringify(input, null, 2) ?? "null"};
};

/** The omission line an expanded row shows when the per-item bound cut the result. */
export const omissionLine = (bytes: number): string | null =>
	bytes > 0 ? `${bytes} bytes omitted from this result` : null;
