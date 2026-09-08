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

/**
 * What one call did, read off its input alone. The four actions are what a run of calls is counted
 * and spoken in (`tool-run.ts`), and they carry the strings the reading found rather than a flag
 * beside them, so nothing downstream has to probe the input a second time and reach a different
 * answer.
 *
 * `other` is the honest end of the ladder: a shape this file does not recognise says only that a
 * tool ran. It is never guessed into one of the other three.
 */
export type ToolShape =
	| {
			readonly action: "edit";
			readonly path: string;
			readonly before: string;
			readonly after: string;
	  }
	| {readonly action: "read"; readonly path: string}
	| {readonly action: "command"; readonly command: string}
	| {readonly action: "other"};

export type ToolAction = ToolShape["action"];

/**
 * The one shape probe. The order is the precedence: an edit is a path plus both texts, a shell call
 * is a command, and a bare path with neither is a read — so a call carrying a path *and* a command
 * reads as the command it ran, as it did before this was a named answer.
 */
export const toolShape = (item: ToolItem): ToolShape => {
	const input = item.input;
	if (!isRecord(input)) return {action: "other"};
	const path = stringAt(input, PATH_KEYS);
	const before = stringAt(input, OLD_KEYS);
	const after = stringAt(input, NEW_KEYS);
	if (path !== null && before !== null && after !== null) {
		return {action: "edit", path, before, after};
	}
	const command = stringAt(input, COMMAND_KEYS);
	if (command !== null) return {action: "command", command};
	return path === null ? {action: "other"} : {action: "read", path};
};

/**
 * The raw input a generic row falls back to. A record is pretty-printed and anything else is not:
 * an array or a bare string has no keys to lay out, and indenting one only spreads it down the row.
 */
const rawInput = (input: JsonValue): string =>
	(isRecord(input) ? JSON.stringify(input, null, 2) : JSON.stringify(input)) ?? "null";

/** What the expanded row shows for one call. Total: every input has a rendering. */
export const toolDetail = (item: ToolItem): ToolDetail => {
	const shape = toolShape(item);
	if (shape.action === "edit") {
		return {kind: "edit", path: shape.path, diff: diffLines(shape.before, shape.after)};
	}
	if (shape.action === "command") return {kind: "shell", command: shape.command};
	return {kind: "generic", input: rawInput(item.input)};
};

/** The omission line an expanded row shows when the per-item bound cut the result. */
export const omissionLine = (bytes: number): string | null =>
	bytes > 0 ? `${bytes} bytes omitted from this result` : null;
