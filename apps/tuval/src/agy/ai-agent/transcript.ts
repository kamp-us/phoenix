/**
 * agy's `transcript.jsonl` on disk → the `TranscriptPage` the layer's `page(before, limit)` owes.
 *
 * History is backend-owned (founder ruling 5, #7569): older turns come back out of agy's own log
 * rather than a second copy Tuval keeps. The log is plaintext JSONL under
 * `$HOME/.gemini/antigravity-cli/brain/<cid>/.system_generated/logs/`, and the home is resolved by
 * the caller at runtime — no absolute path is written down anywhere in this slice. The neighbouring
 * `conversations/<cid>.db` is SQLite carrying protobuf blobs whose enum mappings are unknown, and
 * nothing here reads it.
 *
 * Three facts about the file drive the shape below, each a census of the two files agy v1.1.27 wrote
 * for one 7,671-line conversation (`transcript-wire.ts` holds the rest of that census):
 *
 * - **A tool call and its result are two lines, not one.** A `MODEL`/`PLANNER_RESPONSE` carries
 *   `tool_calls[]` with `name` and `args` and never an output; the immediately following
 *   `MODEL`/`GENERIC` line carries that output as its `content`. In the census: 3,534 call lines, of
 *   which 3,491 are immediately followed by a `GENERIC`; 0 `GENERIC` lines carry `tool_calls` of
 *   their own; and only 4 `GENERIC` lines follow something that is not a call. So the pair is read
 *   as one `ToolItem` — a reader that emitted the call with an empty result and the output as a
 *   loose row would render every tool row as permanently pending. A call with no `GENERIC` after it
 *   keeps `running`, which is what the `GENERIC`'s own `status: RUNNING` means when the tool is
 *   still in flight.
 * - **`step_index` is very nearly, but not actually, monotonic.** In the census it decreases at 5 of
 *   7,670 steps and repeats a value twice, which a resumed conversation restarting its counter
 *   explains. Ordering is therefore a *stable* sort by `step_index`: the epic's contract is honoured
 *   and the file's own order breaks every tie, so no pair of lines is ever reordered on a guess.
 * - **`truncated_fields` names fields clipped out of this line**, and their whole values live in the
 *   counterpart line of `transcript_full.jsonl` — same line count, same `step_index` sequence, and
 *   the full file marks nothing as truncated. Ignoring it would serve a clipped transcript that
 *   reads exactly like a short message, which is the worst failure available here.
 *
 * `thinking` is dropped rather than folded into the reply, exactly as `pi/ai-agent/items.ts` drops
 * Pi's: the port union is text-only by design, and reasoning rendered as an assistant turn is text
 * the model never said.
 *
 * Pure and total apart from the two `read*` functions, which do nothing but hand the file's bytes to
 * the fold.
 */

import {Effect, FileSystem} from "effect";
import {
	type PageOptions,
	planTranscriptPage,
	type TranscriptPage,
	type TranscriptPageResult,
} from "../../ai-agent/history/index.ts";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {assistantItem, systemItem, toolItem, toolStatusOf, userItem} from "./items.ts";
import {type AgyToolCall, type AgyTranscriptLine, decodeTranscriptLine} from "./transcript-wire.ts";

export const TRANSCRIPT_FILE = "transcript.jsonl";
export const TRANSCRIPT_FULL_FILE = "transcript_full.jsonl";

/** What a field carries when agy clipped it and `transcript_full.jsonl` cannot supply the rest. */
export const CLIPPED_MARK = "\n\n[agy clipped this field; transcript_full.jsonl is not on disk]";

/**
 * Where agy keeps one conversation's logs. `home` is the caller's runtime `$HOME` — `homedir()` at
 * the call site, never a constant — so nothing machine-local is written into this repo.
 */
export const transcriptLogDir = (home: string, conversationId: string): string =>
	`${home}/.gemini/antigravity-cli/brain/${conversationId}/.system_generated/logs`;

export interface TranscriptSource {
	readonly home: string;
	readonly conversationId: string;
}

/** An ISO timestamp as epoch milliseconds; an unparseable one reads as the epoch, never as a throw. */
const millisOf = (timestamp: string): number => {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
};

/** A line and where in the file it sat: the ordinal is the item's stable identity and its tiebreak. */
interface Located {
	readonly ordinal: number;
	readonly line: AgyTranscriptLine;
}

/** A whole file's text → its readable lines, in file order. */
export const transcriptLines = (raw: string): ReadonlyArray<AgyTranscriptLine> => {
	const lines: Array<AgyTranscriptLine> = [];
	for (const text of raw.split("\n")) {
		const read = decodeTranscriptLine(text);
		// A half-written record is skipped rather than rendered: this is an append-only log agy may
		// still be writing to, so an unreadable line is almost always the tail mid-write, and every
		// line before it is whole history the operator would otherwise lose.
		if (read.kind === "line") lines.push(read.line);
	}
	return lines;
};

/**
 * The counterpart of the line at `ordinal`, taken from the full file. The two files align by
 * position — same count, same `step_index` sequence — and `step_index` is the cross-check rather
 * than the key, because it is not unique. A mismatch falls back to the first full line carrying this
 * one's `step_index`, which is what a full file cut short leaves to work with.
 */
const counterpartOf = (
	full: ReadonlyArray<AgyTranscriptLine>,
	byStep: ReadonlyMap<number, AgyTranscriptLine>,
	ordinal: number,
	line: AgyTranscriptLine,
): AgyTranscriptLine | undefined => {
	const aligned = full[ordinal];
	if (aligned !== undefined && aligned.step_index === line.step_index) return aligned;
	return byStep.get(line.step_index);
};

/** The line with every clipped field it can recover restored, and the names of those it cannot. */
interface Restored {
	readonly line: AgyTranscriptLine;
	readonly clipped: ReadonlySet<string>;
}

const restore = (line: AgyTranscriptLine, full: AgyTranscriptLine | undefined): Restored => {
	const truncated = line.truncated_fields;
	if (truncated === undefined || truncated.length === 0) return {line, clipped: new Set<string>()};
	if (full === undefined) return {line, clipped: new Set(truncated)};
	let restored = line;
	const clipped = new Set<string>();
	for (const field of truncated) {
		if (field === "content" && full.content !== undefined)
			restored = {...restored, content: full.content};
		else if (field === "thinking" && full.thinking !== undefined)
			restored = {...restored, thinking: full.thinking};
		else if (field === "tool_calls" && full.tool_calls !== undefined)
			restored = {...restored, tool_calls: full.tool_calls};
		else clipped.add(field);
	}
	return {line: restored, clipped};
};

const marked = (text: string, clipped: boolean): string => (clipped ? text + CLIPPED_MARK : text);

/** An item and the two numbers that order it: `step_index` first, file position to break the tie. */
interface Placed {
	readonly item: TranscriptItem;
	readonly stepIndex: number;
	readonly ordinal: number;
}

const toolItemsOf = (
	id: string,
	timestamp: number,
	calls: ReadonlyArray<AgyToolCall>,
	result: string,
	status: string,
	clipped: boolean,
): ReadonlyArray<TranscriptItem> =>
	calls.map((call, index) =>
		toolItem({
			id: `${id}:${index}`,
			timestamp,
			name: call.name,
			input: call.args,
			result: marked(result, clipped),
			status: toolStatusOf(status),
		}),
	);

/**
 * The unrecognised arm's row. Nothing is dropped and nothing throws: the combination is named so a
 * `.jsonl` written by a newer agy reads as a transcript with an odd row in it, not as a short one.
 */
const unrecognisedText = (line: AgyTranscriptLine): string => {
	const head = `agy step ${line.step_index} of an unrecognised kind ${JSON.stringify(`${line.source}/${line.type}`)} (${line.status})`;
	const content = line.content ?? "";
	return content.length === 0 ? head : `${head}: ${content}`;
};

/**
 * One conversation's lines → the port items, oldest-first.
 *
 * `full` is the parsed `transcript_full.jsonl`, or an empty array when it is not on disk — which is
 * not an error: the clipped content is served and marked instead.
 */
export const transcriptItems = (
	conversationId: string,
	lines: ReadonlyArray<AgyTranscriptLine>,
	full: ReadonlyArray<AgyTranscriptLine>,
): ReadonlyArray<TranscriptItem> => {
	const byStep = new Map<number, AgyTranscriptLine>();
	full.forEach((line) => {
		if (!byStep.has(line.step_index)) byStep.set(line.step_index, line);
	});

	const placed: Array<Placed> = [];
	const consumed = new Set<number>();

	const push = (source: Located, item: TranscriptItem) =>
		placed.push({item, stepIndex: source.line.step_index, ordinal: source.ordinal});

	lines.forEach((raw, ordinal) => {
		if (consumed.has(ordinal)) return;
		const {line, clipped} = restore(raw, counterpartOf(full, byStep, ordinal, raw));
		const here: Located = {ordinal, line};
		const id = `${conversationId}:${ordinal}`;
		const timestamp = millisOf(line.created_at);
		const content = line.content ?? "";
		const calls = line.tool_calls;

		if (line.source === "USER_EXPLICIT" && line.type === "USER_INPUT") {
			push(here, userItem(id, timestamp, marked(content, clipped.has("content"))));
			return;
		}

		if (line.source === "MODEL" && line.type === "PLANNER_RESPONSE") {
			if (content.length > 0)
				push(here, assistantItem(id, timestamp, marked(content, clipped.has("content"))));
			if (calls === undefined || calls.length === 0) return;
			// The result line, if agy wrote one: physically the next line, and consumed here so it
			// never also renders as a row of its own.
			const next = lines[ordinal + 1];
			const pairs = next !== undefined && next.source === "MODEL" && next.type === "GENERIC";
			const outcome = pairs
				? restore(next, counterpartOf(full, byStep, ordinal + 1, next))
				: undefined;
			if (pairs) consumed.add(ordinal + 1);
			for (const item of toolItemsOf(
				id,
				timestamp,
				calls,
				outcome?.line.content ?? "",
				outcome?.line.status ?? "RUNNING",
				clipped.has("tool_calls") || (outcome?.clipped.has("content") ?? false),
			))
				push(here, item);
			return;
		}

		if (line.source === "SYSTEM") {
			push(here, systemItem(id, timestamp, marked(content, clipped.has("content"))));
			return;
		}

		push(here, systemItem(id, timestamp, marked(unrecognisedText(line), clipped.has("content"))));
	});

	// Stable by construction: `sort` is not guaranteed stable across every engine for the comparator
	// alone, so the file position is the explicit second key rather than an assumption about it.
	return placed
		.slice()
		.sort((left, right) =>
			left.stepIndex === right.stepIndex
				? left.ordinal - right.ordinal
				: left.stepIndex - right.stepIndex,
		)
		.map((entry) => entry.item);
};

const readLines = Effect.fn("Agy.readTranscriptLines")(function* (path: string) {
	const fs = yield* FileSystem.FileSystem;
	const present = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
	if (!present) return [];
	const raw = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
	return transcriptLines(raw);
});

/**
 * One conversation's history, oldest-first. A conversation with no directory and no file yields an
 * empty history rather than a failure: a session agy has not written yet is a session with no
 * history, which is a page, not an error.
 */
export const readTranscriptItems = Effect.fn("Agy.readTranscriptItems")(function* (
	source: TranscriptSource,
) {
	const dir = transcriptLogDir(source.home, source.conversationId);
	const lines = yield* readLines(`${dir}/${TRANSCRIPT_FILE}`);
	const full = lines.length === 0 ? [] : yield* readLines(`${dir}/${TRANSCRIPT_FULL_FILE}`);
	return transcriptItems(source.conversationId, lines, full);
});

export const emptyPage: TranscriptPage = {
	kind: "page",
	start: 0,
	items: [],
	omitted: {items: 0, bytes: 0, reason: "none"},
	next: null,
};

/**
 * The page `page(before, limit)` owes, planned over the whole on-disk history by the shared bound.
 *
 * A refusal is returned rather than raised: the cursor and limit rules are the port's, so the layer
 * maps `cursor-not-found` and `limit-not-positive` onto its own `page` error channel — this reader
 * does not own that vocabulary.
 */
export const readTranscriptPage = Effect.fn("Agy.readTranscriptPage")(function* (
	source: TranscriptSource,
	options: PageOptions,
) {
	const items = yield* readTranscriptItems(source);
	if (items.length === 0 && (options.before ?? null) === null)
		return emptyPage satisfies TranscriptPageResult;
	return planTranscriptPage(items, options);
});
