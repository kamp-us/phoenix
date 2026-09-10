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
 * Four facts about the file drive the shape below (`transcript-wire.ts` holds the rest of the
 * census behind them):
 *
 * - **A tool call and its result are two lines, not one.** A `MODEL`/`PLANNER_RESPONSE` carries
 *   `tool_calls[]` with `name` and `args` and never an output; a following `MODEL`/`GENERIC` line
 *   carries that output as its `content`. So the pair is read as one `ToolItem` — a reader that
 *   emitted the call with an empty result and the output as a loose row would render every tool row
 *   as permanently pending. A call with no `GENERIC` of its own keeps `running`, which is what the
 *   `GENERIC`'s own `status: RUNNING` means when the tool is still in flight.
 * - **A batch of N calls on one `PLANNER_RESPONSE` gets N `GENERIC` lines, one per call, in call
 *   order** — not one merged outcome for the batch. Measured rather than assumed (#8689): across 95
 *   transcripts on this machine, 67 of 73 multi-call lines are followed, in `step_index` order, by
 *   exactly as many `GENERIC` lines as they carry calls, and on all 21 of those whose calls name
 *   distinct file paths the k-th `GENERIC` echoes the k-th call's path — 21 of 21 identity, no
 *   permutation. A capture driven against v1.1.28 for this issue reproduces it in the small:
 *   `fixtures/multi-call-transcript.jsonl`. Attribution is therefore by **position**, and there is
 *   no batch-level outcome to render.
 * - **`step_index` orders the file; the file's own order does not.** The results of a batch routinely
 *   land *before* their own call line on disk — in the v1.1.28 capture the planner line sits at file
 *   position 2 while its first call's result sits at position 1 — so pairing by file adjacency pairs
 *   a call with another call's outcome. The fold therefore walks a *stable* sort by `step_index`
 *   (file position breaks every tie, because `step_index` is not unique and not monotonic: in the
 *   census it decreases at 5 of 7,670 steps and repeats a value twice, which a resumed conversation
 *   restarting its counter explains).
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
 * Where agy keeps one conversation. Its presence is the whole evidence that the store holds the
 * conversation at all: the log files under it are written as the turns run, so their absence means
 * an empty conversation and never a missing one (`sessionTranscript` in `AgyAiAgent.ts` turns on
 * exactly that distinction).
 */
export const conversationDir = (home: string, conversationId: string): string =>
	`${home}/.gemini/antigravity-cli/brain/${conversationId}`;

/**
 * Where agy keeps one conversation's logs. `home` is the caller's runtime `$HOME` — `homedir()` at
 * the call site, never a constant — so nothing machine-local is written into this repo.
 */
export const transcriptLogDir = (home: string, conversationId: string): string =>
	`${conversationDir(home, conversationId)}/.system_generated/logs`;

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

/** One call's own `GENERIC` line, read. Absent means agy has written no outcome for that call yet. */
interface CallOutcome {
	readonly text: string;
	readonly status: string;
	/** Whether *this* outcome's `content` was clipped — a fact about this row and no other (#8877). */
	readonly clipped: boolean;
}

/**
 * One `PLANNER_RESPONSE`'s calls → their rows, each carrying its own outcome.
 *
 * agy writes one `GENERIC` per call in call order (see the module note), so the k-th outcome is the
 * k-th call's and position is the pairing. A call agy has written no outcome for keeps `running`
 * with an empty result rather than borrowing a neighbour's.
 */
const toolItemsOf = (
	id: string,
	timestamp: number,
	calls: ReadonlyArray<AgyToolCall>,
	outcomes: ReadonlyArray<CallOutcome>,
	callsClipped: boolean,
): ReadonlyArray<TranscriptItem> =>
	calls.map((call, index) => {
		const outcome = outcomes[index];
		return toolItem({
			id: `${id}:${index}`,
			timestamp,
			name: call.name,
			input: call.args,
			result: marked(outcome?.text ?? "", callsClipped || (outcome?.clipped ?? false)),
			status: toolStatusOf(outcome?.status ?? "RUNNING"),
		});
	});

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

	// The fold's own order, not the file's: a batch's outcomes routinely sit before their call line on
	// disk, so adjacency there pairs a call with another call's result. File position breaks the tie.
	const order = lines
		.map((line, ordinal) => ({line, ordinal}))
		.sort((left, right) =>
			left.line.step_index === right.line.step_index
				? left.ordinal - right.ordinal
				: left.line.step_index - right.line.step_index,
		);

	order.forEach(({ordinal, line: raw}, position) => {
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
			// One `GENERIC` per call, taken in step order and consumed here so none also renders as a
			// row of its own. The run stops at the first line that is not one: a batch agy is still
			// working through has written fewer than it will.
			const outcomes: Array<CallOutcome> = [];
			for (let step = position + 1; step < order.length && outcomes.length < calls.length; step++) {
				const entry = order[step];
				if (entry === undefined) break;
				if (entry.line.source !== "MODEL" || entry.line.type !== "GENERIC") break;
				const read = restore(entry.line, counterpartOf(full, byStep, entry.ordinal, entry.line));
				outcomes.push({
					text: read.line.content ?? "",
					status: read.line.status,
					clipped: read.clipped.has("content"),
				});
				consumed.add(entry.ordinal);
			}
			for (const item of toolItemsOf(id, timestamp, calls, outcomes, clipped.has("tool_calls")))
				push(here, item);
			return;
		}

		if (line.source === "SYSTEM") {
			push(here, systemItem(id, timestamp, marked(content, clipped.has("content"))));
			return;
		}

		push(here, systemItem(id, timestamp, marked(unrecognisedText(line), clipped.has("content"))));
	});

	// The fold already walks this order, but a batch's rows are all pushed from their call line's
	// `step_index`, so this is what keeps them together rather than interleaved with their outcomes'.
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
