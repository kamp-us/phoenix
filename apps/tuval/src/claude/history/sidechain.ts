/**
 * A subagent's own transcript, read out of the sidechain file the CLI writes beside its parent
 * session — `<session>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` beside it.
 *
 * Pure, like the rest of this directory: the caller hands over the two files' text and gets the
 * settled items back. The disk read is `agent/sidechain-store.ts`, which is where the refusals for
 * a file that is not there or will not open live.
 *
 * Two shapes have to be reconciled here. The CLI's on-disk record keys camelCase (`sessionId`,
 * `parentUuid`, `isSidechain`, `agentId`) and carries rows the SDK has no name for, while
 * `toHistoryItems` reads the SDK's `SessionMessage`. The SDK's own reader re-keys the one into the
 * other, and this repeats that mapping rather than inventing a second one: at
 * `@anthropic-ai/claude-agent-sdk@0.3.259` (`sdk.mjs`) it builds
 * `{type, uuid, session_id: row.sessionId, message: row.message, parent_tool_use_id,
 * parent_agent_id, timestamp}` and keeps the `user` and `assistant` rows alone.
 */

import type {SessionMessage} from "@anthropic-ai/claude-agent-sdk";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {type HistoryItems, toHistoryItems} from "./items.ts";
import type {MappingOptions} from "./map.ts";

/** The directory the CLI writes a session's sidechain files into, under the session's own dir. */
export const SUBAGENTS_DIR = "subagents";

export const sidechainFileName = (agentId: string): string => `agent-${agentId}.jsonl`;
export const sidechainMetaName = (agentId: string): string => `agent-${agentId}.meta.json`;

/**
 * What a subagent is called when its meta file is absent or will not parse. A read that got the
 * rows still answers them — the transcript is the thing the operator asked for, and a label is not
 * worth failing it over.
 */
export const UNNAMED_SUBAGENT = "subagent";

/** The two files one subagent is written as. `meta` is `null` when it could not be read. */
export interface SidechainSource {
	readonly jsonl: string;
	readonly meta: string | null;
}

export interface SidechainTranscript {
	readonly kind: "transcript";
	readonly items: ReadonlyArray<TranscriptItem>;
	/** The subagent's type off its meta file, or `UNNAMED_SUBAGENT`. */
	readonly type: string;
	/** How many rows the mapping had nothing to say about. */
	readonly skipped: number;
}

/**
 * A line that is not JSON. It is a refusal rather than a skipped row because a dropped line is a
 * hole in the middle of a transcript nobody can see — the reader would answer a conversation
 * missing a turn and say nothing about it.
 */
export interface SidechainRefusal {
	readonly kind: "refused";
	readonly reason: "malformed-line";
	/** 1-based, so it names the line a reader would open the file to. */
	readonly line: number;
	readonly detail: string;
}

export type SidechainResult = SidechainTranscript | SidechainRefusal;

export const isSidechainRefusal = (value: SidechainResult): value is SidechainRefusal =>
	value.kind === "refused";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stringOr = (value: unknown, fallback: string): string =>
	typeof value === "string" ? value : fallback;

/** The meta file's `toolUseId` and `parentAgentId`, which are what the re-key tags every row with. */
interface SidechainMeta {
	readonly type: string;
	readonly toolUseId: string | null;
	readonly parentAgentId: string | null;
}

const NO_META: SidechainMeta = {type: UNNAMED_SUBAGENT, toolUseId: null, parentAgentId: null};

const metaOf = (text: string | null): SidechainMeta => {
	if (text === null) return NO_META;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return NO_META;
	}
	if (!isRecord(parsed)) return NO_META;
	return {
		type: stringOr(parsed.agentType, UNNAMED_SUBAGENT),
		toolUseId: typeof parsed.toolUseId === "string" ? parsed.toolUseId : null,
		parentAgentId: typeof parsed.parentAgentId === "string" ? parsed.parentAgentId : null,
	};
};

/**
 * A stored row as the wire form `toHistoryItems` reads.
 *
 * `timestamp` is not on `SessionMessage` at the `0.3.259` pin, but the SDK's own re-key writes one
 * onto every row it returns, and `timestampOf` reads it to land an item at its own clock rather
 * than at the caller's. Declared here so the value the SDK really carries is not dropped by a type
 * that forgot to name it.
 */
type StoredMessage = SessionMessage & {readonly timestamp?: string};

/**
 * One stored row as that wire form.
 *
 * The parent tag comes off the meta file rather than off the row: a sidechain row names no
 * spawning call, and the meta file's `toolUseId` is the call in the parent session that opened
 * this subagent. Tagging here is what makes a row read the same whether it arrived live off the
 * stream or was read back from this file.
 */
const rekeyed = (
	row: Record<string, unknown>,
	type: "user" | "assistant",
	meta: SidechainMeta,
): StoredMessage => ({
	type,
	uuid: stringOr(row.uuid, ""),
	session_id: stringOr(row.sessionId, ""),
	message: row.message,
	parent_tool_use_id: meta.toolUseId,
	parent_agent_id: meta.parentAgentId,
	timestamp: stringOr(row.timestamp, ""),
});

/**
 * The subagent's settled transcript, oldest-first.
 *
 * File order is the order: the CLI appends a row as it writes it, so the file is already
 * chronological. The SDK's reader walks `parentUuid` links before it maps, which resolves a
 * rewound branch; a sidechain has no rewind path today, and a chain walk would silently drop every
 * row whose parent is missing — the opposite of what a reader that refuses rather than truncates
 * is for.
 */
export const readSidechain = (
	source: SidechainSource,
	options: MappingOptions,
): SidechainResult => {
	const meta = metaOf(source.meta);
	const rows: Array<StoredMessage> = [];
	const lines = source.jsonl.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (cause) {
			return {
				kind: "refused",
				reason: "malformed-line",
				line: index + 1,
				detail: cause instanceof Error ? cause.message : String(cause),
			};
		}
		if (!isRecord(parsed)) {
			return {
				kind: "refused",
				reason: "malformed-line",
				line: index + 1,
				detail: "the line parsed to something that is not an object",
			};
		}
		// The CLI writes rows the SDK's `SessionMessage` has no arm for — `attachment`,
		// `fork-context-ref`, its own `system` subtypes — and its reader keeps the two
		// conversation kinds alone (`sdk.mjs` at 0.3.259). Anything else is not a row this
		// mapping skipped; it is not a message.
		if (parsed.type !== "user" && parsed.type !== "assistant") continue;
		rows.push(rekeyed(parsed, parsed.type, meta));
	}
	const mapped: HistoryItems = toHistoryItems(rows, options);
	return {kind: "transcript", items: mapped.items, type: meta.type, skipped: mapped.skipped};
};
