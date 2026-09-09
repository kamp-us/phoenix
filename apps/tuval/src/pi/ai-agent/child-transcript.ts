/**
 * A spawned Pi worker's own JSONL artifact → the port items its slot shows.
 *
 * `pi-subagents` appends one JSON line per child event while the child runs
 * (`src/shared/child-transcript.ts:157-165`, `fs.appendFileSync`) to
 * `<artifactsDir>/<runId>_<agent>_<index>_transcript.jsonl` (`src/shared/artifacts.ts:182-193`),
 * and under the default `dir: "session"` preference that directory is
 * `dirname(parentSessionFile)/subagent-artifacts` (`src/shared/artifacts.ts:156-167`) — for Tuval,
 * `<cwd>/.tuval/pi-sessions/subagent-artifacts/`, off `../server/AgentSessionHost.ts`'s
 * `defaultSessionDir`.
 *
 * The grammar is versioned (`CHILD_TRANSCRIPT_ARTIFACT_VERSION = 1`) and small, so it is
 * reimplemented here rather than imported: `pi-subagents`' own reader is
 * `src/tui/fleet-transcript.ts`, which pulls `@earendil-works/pi-tui` and would break the
 * paths-only rule `../server/subagents.ts` holds. The parse is pure and total — a malformed line is
 * skipped, never thrown on — and it keeps that reader's tail safety: the file is being appended to
 * while it is read, so a final line that does not yet parse is not a record and is dropped
 * (`src/tui/fleet-transcript.ts:173`).
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {
	boundToolResult,
	type ItemId,
	type JsonValue,
	type ToolItem,
	type ToolStatus,
	type TranscriptItem,
} from "../../ai-agent/ports/index.ts";

/** One worker's artifact as a slot reads it: its rows, its newest line, and what it has spent. */
export interface ChildTranscript {
	readonly items: ReadonlyArray<TranscriptItem>;
	readonly lastLine: string;
	readonly tokens: number;
}

/** The child transcripts a fold holds, by the `runId` that names each one's file. */
export type ChildTranscripts = ReadonlyMap<string, ChildTranscript>;

const emptyTranscript: ChildTranscript = {items: [], lastLine: "", tokens: 0};

/** Minted here rather than off `items.ts`, which imports this module. */
const childItemId = (value: string): ItemId => value as ItemId;

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const stringOf = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value : undefined;

const numberOf = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * A tool row the fold is still filling. Mutable because the grammar reports one call over as many
 * as three records — `tool_start`, the `toolResult` message, then `tool_end` — and each settles a
 * different field of the same row.
 */
interface OpenTool {
	readonly kind: "tool";
	readonly timestamp: number;
	readonly name: string;
	readonly input: JsonValue;
	readonly toolCallId: string | undefined;
	result: ToolItem["result"];
	status: ToolStatus;
	resultSeen: boolean;
}

type Row = Exclude<TranscriptItem, ToolItem> | OpenTool;

const isOpenTool = (row: Row | undefined): row is OpenTool => row?.kind === "tool";

/** `argsPayload` is the call's arguments as the writer serialized them; anything else is no input. */
const inputOf = (payload: string | undefined): JsonValue => {
	if (payload === undefined) return null;
	try {
		return JSON.parse(payload) as JsonValue;
	} catch {
		return null;
	}
};

/**
 * The tool row a `tool_end` or a `toolResult` belongs to: the newest carrying the call id, or — for
 * a record that names none — the newest still awaiting its result. The lookback
 * `src/tui/fleet-transcript.ts`'s `findTool` runs, and what keeps two calls to one tool from
 * collapsing into a single row.
 */
const openTool = (
	rows: ReadonlyArray<Row>,
	toolCallId: string | undefined,
): OpenTool | undefined => {
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const row = rows[index];
		if (!isOpenTool(row)) continue;
		if (toolCallId !== undefined ? row.toolCallId === toolCallId : !row.resultSeen) return row;
	}
	return undefined;
};

/**
 * Every kind the child writes, folded onto the port's own union: `assistant` and `user` land as
 * themselves, `tool` as one row per call, and the stderr `notice` is dropped — the port has no kind
 * for it, and inventing one would put the child's stream plumbing on a surface that exists to be
 * model-blind. No `thinking` reaches the artifact at all, because the writer extracts text only
 * (`src/shared/child-transcript.ts:197-207`), so the reasoning row is absent rather than wrong.
 */
const foldRecord = (rows: Array<Row>, record: Record<string, unknown>): void => {
	const recordType = stringOf(record.recordType);
	const timestamp = numberOf(record.ts) ?? 0;
	if (recordType === "tool_start") {
		rows.push({
			kind: "tool",
			timestamp,
			name: stringOf(record.toolName) ?? "tool",
			input: inputOf(stringOf(record.argsPayload)),
			toolCallId: stringOf(record.toolCallId),
			result: boundToolResult(""),
			status: "running",
			resultSeen: false,
		});
		return;
	}
	if (recordType === "tool_end") {
		const tool = openTool(rows, stringOf(record.toolCallId));
		if (tool !== undefined && !tool.resultSeen)
			tool.status = record.isError === true ? "error" : "ok";
		return;
	}
	if (recordType !== "message") return;

	const message = objectOf(record.message);
	const role = stringOf(record.role) ?? stringOf(message?.role);
	const text = stringOf(record.text) ?? stringOf(message?.text) ?? "";
	if (role === "toolResult") {
		const toolCallId = stringOf(record.toolCallId) ?? stringOf(message?.toolCallId);
		const held = openTool(rows, toolCallId);
		const tool: OpenTool = held ?? {
			kind: "tool",
			timestamp,
			name: stringOf(record.toolName) ?? stringOf(message?.toolName) ?? "tool",
			input: null,
			toolCallId,
			result: boundToolResult(""),
			status: "running",
			resultSeen: false,
		};
		if (held === undefined) rows.push(tool);
		if (tool.resultSeen) return;
		tool.resultSeen = true;
		tool.status = record.isError === true || message?.isError === true ? "error" : "ok";
		tool.result = boundToolResult(text);
		return;
	}
	if ((role === "assistant" || role === "user") && text !== "")
		rows.push({kind: role, id: childItemId(""), timestamp, text});
};

/** `usage` is already normalized by the writer (`normalizeUsage`), so the spend is a plain sum. */
const tokensOf = (record: Record<string, unknown>): number => {
	const usage = objectOf(record.usage);
	if (usage === undefined) return 0;
	return (numberOf(usage.input) ?? 0) + (numberOf(usage.output) ?? 0);
};

/** The newest thing the worker wrote, whatever kind of row carried it (`../../codex/subagents.ts`). */
const lineOf = (item: TranscriptItem): string =>
	item.kind === "tool" ? item.result.text || item.name : item.text;

/** Ids are positional within one artifact; the caller re-keys them under the call it is filling. */
const rowItem = (row: Row, id: string): TranscriptItem => {
	if (!isOpenTool(row)) return {...row, id: childItemId(id)};
	return {
		kind: "tool",
		id: childItemId(id),
		timestamp: row.timestamp,
		name: row.name,
		input: row.input,
		result: row.result,
		status: row.status,
	};
};

/** Whether a line is a whole record — `src/tui/fleet-transcript.ts`'s `isCompleteRecord`. */
const isCompleteRecord = (line: string | undefined): boolean => {
	if (line === undefined || line.trim() === "") return false;
	try {
		return objectOf(JSON.parse(line)) !== undefined;
	} catch {
		return false;
	}
};

/** One artifact's whole text as a slot reads it. */
export const parseChildTranscript = (text: string): ChildTranscript => {
	const lines = text.split("\n");
	if (!isCompleteRecord(lines.at(-1))) lines.pop();
	const rows: Array<Row> = [];
	let tokens = 0;
	for (const line of lines) {
		if (line.trim() === "") continue;
		let record: Record<string, unknown> | undefined;
		try {
			record = objectOf(JSON.parse(line));
		} catch {
			continue;
		}
		if (record === undefined) continue;
		tokens += tokensOf(record);
		foldRecord(rows, record);
	}
	const items = rows.map((row, index) => rowItem(row, `child-${index}`));
	const last = items.at(-1);
	return {items, lastLine: last === undefined ? "" : lineOf(last), tokens};
};

/**
 * Where a spawned child's artifacts land, off the directory this process writes its own session
 * JSONL to: `pi-subagents` derives the directory from the parent session file's, and Tuval's
 * session file sits directly in that directory.
 */
export const subagentArtifactsDir = (sessionDir: string): string =>
	join(sessionDir, "subagent-artifacts");

/**
 * The artifacts one run wrote. A parallel spawn starts several children under one run, each with
 * its own `<runId>_<agent>_<index>_transcript.jsonl`, and they are read in name order so the slot
 * keyed on the spawning call — which is 1:N against a parallel spawn either way — shows all of them
 * rather than an arbitrary one.
 *
 * Raw `node:fs` under `.patterns/effect-platform-access.md`'s "a `node:*`-only API the platform
 * service doesn't expose" case, for the reason `PiAiAgent`'s own `readBranch` reads that way: this
 * is a synchronous tail on the fold's own fiber, and every failure it can meet — no directory yet,
 * a file removed between the scan and the read — means "nothing to show yet" rather than an error a
 * caller could act on.
 */
export const readChildTranscript = (dir: string, runId: string): ChildTranscript => {
	let names: ReadonlyArray<string>;
	try {
		names = readdirSync(dir)
			.filter((name) => name.startsWith(`${runId}_`) && name.endsWith("_transcript.jsonl"))
			.sort();
	} catch {
		return emptyTranscript;
	}
	const read = names.flatMap((name) => {
		try {
			return [parseChildTranscript(readFileSync(join(dir, name), "utf-8"))];
		} catch {
			return [];
		}
	});
	const items = read.flatMap((child, at) =>
		child.items.map((item) => ({...item, id: childItemId(`child-${at}-${item.id}`)})),
	);
	const last = items.at(-1);
	return {
		items,
		lastLine: last === undefined ? "" : lineOf(last),
		tokens: read.reduce((sum, child) => sum + child.tokens, 0),
	};
};

/**
 * Several runs' transcripts as one slot's rows. An async spawn is one call over as many workers as
 * its `steps[]` names, and the slot stays keyed on the call (#8664 owns how a fan-out is laid out),
 * so their rows are concatenated in the order the steps were resolved and re-keyed apart.
 *
 * The re-key runs even for a single run, matching `readChildTranscript`'s own `child-<at>-` prefix:
 * a step that launches later must not renumber the ids of the rows already on screen.
 */
export const joinChildTranscripts = (parts: ReadonlyArray<ChildTranscript>): ChildTranscript => {
	const items = parts.flatMap((part, at) =>
		part.items.map((item) => ({...item, id: childItemId(`run-${at}-${item.id}`)})),
	);
	const last = items.at(-1);
	return {
		items,
		lastLine: last === undefined ? "" : lineOf(last),
		tokens: parts.reduce((sum, part) => sum + part.tokens, 0),
	};
};

/** Every named run's artifact, read fresh — the tail step the watcher repeats while a slot runs. */
export const readChildTranscripts = (
	dir: string,
	runIds: ReadonlyArray<string>,
): ChildTranscripts => new Map(runIds.map((runId) => [runId, readChildTranscript(dir, runId)]));
