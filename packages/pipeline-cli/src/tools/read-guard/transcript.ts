/**
 * Reconstruct a session's read-set from its transcript (issue #740).
 *
 * The PreToolUse hook envelope hands us `transcript_path` but not the read-set
 * directly — so we derive it by scanning the transcript JSONL for prior `Read`
 * `tool_use` entries. Each carries `input.file_path` (the path read) and an entry
 * `timestamp` (when it was read), which is exactly the `{path, readAtMs}` the pure
 * core needs to apply its staleness test.
 *
 * Pure and total: `parseReadSet(text)` over the raw transcript text returns the
 * read-set, skipping any line that isn't JSON or isn't a `Read` tool_use, never
 * throwing. A malformed transcript degrades to fewer recorded reads (fail-open: a
 * missed read just means an extra precautionary block, never a crash).
 */
import type {ReadSet, RecordedRead} from "./read-guard.ts";

interface ToolUseBlock {
	readonly type?: unknown;
	readonly name?: unknown;
	readonly input?: {readonly file_path?: unknown} | null;
}

interface TranscriptEntry {
	readonly timestamp?: unknown;
	readonly message?: {readonly content?: unknown} | null;
}

const toMs = (ts: unknown): number | null => {
	if (typeof ts !== "string") return null;
	const ms = Date.parse(ts);
	return Number.isNaN(ms) ? null : ms;
};

const readFromBlock = (block: ToolUseBlock, readAtMs: number): RecordedRead | null => {
	if (block.type !== "tool_use" || block.name !== "Read") return null;
	const fp = block.input?.file_path;
	if (typeof fp !== "string" || fp.length === 0) return null;
	return {path: fp, readAtMs};
};

/** Every `Read` recorded in a transcript's JSONL, as a read-set the core consumes. */
export const parseReadSet = (transcript: string): ReadSet => {
	const reads: RecordedRead[] = [];
	for (const line of transcript.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let entry: TranscriptEntry;
		try {
			entry = JSON.parse(trimmed) as TranscriptEntry;
		} catch {
			continue; // not a JSON line — skip, never throw
		}
		const readAtMs = toMs(entry.timestamp);
		if (readAtMs === null) continue;
		const content = entry.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as ToolUseBlock[]) {
			const r = readFromBlock(block, readAtMs);
			if (r !== null) reads.push(r);
		}
	}
	return reads;
};
