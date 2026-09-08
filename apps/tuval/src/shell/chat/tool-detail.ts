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

export type ToolDetail =
	/**
	 * A file edit: the path it touched and the two texts, handed to `@kampus/design`'s `Diff` as
	 * they arrived. Splitting them here would be a hand-rolled line table, which the design law
	 * names as the thing that primitive replaces (`design-system-manifest.md`, component selection).
	 */
	| {readonly kind: "edit"; readonly path: string; readonly before: string; readonly after: string}
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
		return {kind: "edit", path: shape.path, before: shape.before, after: shape.after};
	}
	if (shape.action === "command") return {kind: "shell", command: shape.command};
	return {kind: "generic", input: rawInput(item.input)};
};

/** The omission line an expanded row shows when the per-item bound cut the result. */
export const omissionLine = (bytes: number): string | null =>
	bytes > 0 ? `${bytes} bytes omitted from this result` : null;

/**
 * The call's main argument as one line: the path it touched, or the first line of the command it
 * ran. A shape with no argument has none — a bare tool name is the whole of what that call says.
 *
 * One line rather than the whole string because this is a *label*, and a command spanning ten lines
 * would make the run's list ten rows tall. Truncating here is also what keeps the raw form
 * reachable: the disclosure below dedupes against this line, so a one-line command is never printed
 * twice while a multi-line one still shows in full (T3's `workEntryRawCommand`,
 * `MessagesTimeline.tsx:3073-3081`).
 */
export const callArgument = (item: ToolItem): string | null => {
	const shape = toolShape(item);
	if (shape.action === "other") return null;
	const value = shape.action === "command" ? shape.command : shape.path;
	const first = value.trim().split("\n")[0]?.trim() ?? "";
	return first.length === 0 ? null : first;
};

/** The call's line in a run: the tool, and what it was pointed at. */
export const callLabel = (item: ToolItem): string => {
	const argument = callArgument(item);
	return argument === null ? item.name : `${item.name} ${argument}`;
};

/** One labelled block of text inside a call's disclosure. */
export interface CallBlock {
	readonly label: string;
	readonly text: string;
}

/** What a call discloses under its line, with nothing the line already says repeated. */
export interface CallDisclosure {
	/** The edit to render through the design `Diff`, or `null` on every other shape. */
	readonly edit: {readonly path: string; readonly before: string; readonly after: string} | null;
	readonly blocks: ReadonlyArray<CallBlock>;
	readonly omitted: string | null;
}

/**
 * What one call discloses, deduped against the label the reader can already see and against itself.
 *
 * The label is a parameter rather than `callLabel` because two rows disclose the same call under
 * different lines: a run's call row shows the tool and its argument, and a standalone `ToolRow`
 * shows the tool alone. Dedupe is only ever right against the line actually on screen —
 * T3 passes its `visibleLabel` down for the same reason
 * (`buildToolCallExpandedBody`, `MessagesTimeline.tsx:3083-3128`). An empty block is dropped too: a
 * labelled box with nothing in it is a line of noise.
 */
export const callDisclosure = (item: ToolItem, visibleLabel: string): CallDisclosure => {
	const detail = toolDetail(item);
	const label = visibleLabel.trim();
	const argument = callArgument(item);
	const seen = new Set<string>([label]);
	if (argument !== null && label.includes(argument)) seen.add(argument);
	const blocks: Array<CallBlock> = [];
	const add = (label: string, value: string): void => {
		const text = value.trim();
		if (text.length === 0 || seen.has(text)) return;
		seen.add(text);
		blocks.push({label, text});
	};
	if (detail.kind === "shell") add("command", detail.command);
	if (detail.kind === "generic") add("input", detail.input);
	add(detail.kind === "shell" ? "output" : "result", item.result.text);
	return {
		edit:
			detail.kind === "edit"
				? {path: detail.path, before: detail.before, after: detail.after}
				: null,
		blocks,
		omitted: omissionLine(item.result.omitted.bytes),
	};
};

/**
 * Whether a call's line is worth a disclosure at all. A call whose whole content is its own label
 * gets none: no trigger, no `aria-expanded`, nothing to tab to (T3's `canExpand`,
 * `MessagesTimeline.tsx:3312-3320`).
 */
export const canExpandCall = (disclosure: CallDisclosure): boolean =>
	disclosure.edit !== null || disclosure.blocks.length > 0 || disclosure.omitted !== null;
