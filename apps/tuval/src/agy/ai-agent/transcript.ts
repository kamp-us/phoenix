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
 * **The join between this reader's ids and the live tail's is stated here** (#8900), because the
 * window pages by sending a live row's own id back as the cursor and only this module holds both
 * spaces — see `storedId` for the shapes and `transcriptProjection` for the map.
 *
 * Pure and total apart from the two `read*` functions, which do nothing but hand the file's bytes to
 * the fold.
 */

import {Effect, FileSystem} from "effect";
import {
	planTranscriptPage,
	type TranscriptPage,
	type TranscriptPageResult,
} from "../../ai-agent/history/index.ts";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {assistantItem, itemId, systemItem, toolItem, toolStatusOf, userItem} from "./items.ts";
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

/**
 * A stored row's id, and the one word in it that does the work.
 *
 * agy is the one backend whose two id spaces would otherwise *overlap*: the live tail keys a row on
 * the step number agy streams (`${conversation_id}:${step_index}` in `mapper.ts`) and this reader
 * keys it on the line's file position, so both would render `cid:<n>` over different numbers. The
 * shared pager gives an exact stored-id hit precedence over an alias
 * (`../../ai-agent/history/page.ts`), so under one shape a live step number that happened to equal
 * an unrelated line's ordinal would resolve to the wrong row with no refusal — a silently wrong page
 * in place of a loud one (#8900). `line` is what makes the two spaces disjoint by construction:
 * nothing agy streams is ever shaped `cid:line:<n>`, so the precedence can never fire on a live
 * cursor and the alias below is the only thing that resolves one.
 */
const storedId = (conversationId: string, ordinal: number): string =>
	`${conversationId}:line:${ordinal}`;

/**
 * The live tail's id for one streamed step — `mapper.ts`'s own key, restated here because this is
 * the side of the join that has to guess nothing: `stepEvents` keys every row it mints this way.
 */
const liveStepId = (conversationId: string, stepIndex: number): string =>
	`${conversationId}:${stepIndex}`;

/** The live tail's id for a reply only the terminal `result` carried (`resultEvents` in `mapper.ts`). */
const liveResponseId = (conversationId: string): string => `${conversationId}:response`;

/**
 * The id this reader minted for the same row before `line:` was added to it (#8968) — the one
 * `cid:<ordinal>` shape, derived from the current id by deleting the segment rather than by
 * restating how each row kind numbers itself, so a tool row's `cid:line:<ord>:<idx>` comes back as
 * `cid:<ord>:<idx>` with no second rule to keep in step.
 *
 * A cursor in the old shape is what a desk checkpointed before #8968 can hand back, and the row it
 * named is still on disk under a new id, so resolving it is a page where refusing it is a dead
 * history (#8900, criterion 11).
 */
const legacyStoredId = (conversationId: string, stored: string): string => {
	const prefix = `${conversationId}:line:`;
	return stored.startsWith(prefix) ? `${conversationId}:${stored.slice(prefix.length)}` : stored;
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
	/**
	 * The `step_index` of the `GENERIC` line this outcome was read from, which is also the step the
	 * live tail keyed this call's own row on — the join for a tool row (see `transcriptProjection`).
	 */
	readonly stepIndex: number;
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

export interface TranscriptProjection {
	/** The port items, oldest-first, each stamped with the live tail's id for the same row. */
	readonly items: ReadonlyArray<TranscriptItem>;
	/** A live tail id → the stored row it names, for the pager's `cursorAliases`. */
	readonly cursorAliases: ReadonlyMap<string, string>;
}

/**
 * One conversation's lines → the port items, oldest-first, **and the join to the live tail's ids**.
 *
 * `full` is the parsed `transcript_full.jsonl`, or an empty array when it is not on disk — which is
 * not an error: the clipped content is served and marked instead.
 *
 * The join is the whole of #8900's fix, and it is stated in three rules, each of them measured
 * against agy v1.2.0 by driving one two-turn conversation and capturing *both* sides of it
 * (`fixtures/live-join-stream.ndjson` and `fixtures/live-join-transcript.jsonl`, the same
 * conversation's stream and log):
 *
 * - **A row's own line's `step_index` is the live id of that row.** Measured: disk `USER_INPUT` at
 *   step 0 and 5 against stream `user_input` steps 0 and 5; disk reply `PLANNER_RESPONSE` at steps 4
 *   and 6 against stream `agent_response` steps 4 and 6.
 * - **A tool row's live id is the `step_index` of the `GENERIC` line its outcome was read from**, not
 *   of the `PLANNER_RESPONSE` that issued the call. Measured: a two-call planner line at step 1
 *   whose outcomes sit at steps 2 and 3, against two stream `tool` steps numbered 2 and 3 — the
 *   planner's own step 1 carries only an empty `agent_response` the live tail mints no row for. The
 *   filing guessed the batch was live `cid:1`; the capture says otherwise, so the planner's step is
 *   kept as a *fallback* onto the batch's first row rather than as the identity.
 * - **A reply also answers to `` `${conversation_id}:response` ``**, the id `resultEvents` mints for a
 *   turn no `agent_response` delta carried.
 * - **Every row also answers to the id this reader minted for it before #8968** (`legacyStoredId`), so
 *   a cursor out of a desk checkpointed under that shape pages instead of refusing. Not measured
 *   against agy — it is this repo's own history, read off the shape the module carried at `7ec91481`.
 *
 * A step entry is first-occurrence-wins, which is Claude's precedent (`claude/history/items.ts`) and
 * the tie-break `step_index` needs: it is neither unique nor monotonic (the census in the module
 * note: it decreases at 5 of 7,670 steps and repeats a value), so the map is many-to-one and the
 * oldest row wins the key rather than whichever line the walk reached last. The response key is the
 * one exception and `resolvesLatest` says why — it is not one line's id to begin with.
 */
export const transcriptProjection = (
	conversationId: string,
	lines: ReadonlyArray<AgyTranscriptLine>,
	full: ReadonlyArray<AgyTranscriptLine>,
): TranscriptProjection => {
	const byStep = new Map<number, AgyTranscriptLine>();
	full.forEach((line) => {
		if (!byStep.has(line.step_index)) byStep.set(line.step_index, line);
	});

	const placed: Array<Placed> = [];
	const consumed = new Set<number>();
	const cursorAliases = new Map<string, string>();
	const liveIds = new Map<string, string>();

	const push = (source: Located, item: TranscriptItem) =>
		placed.push({item, stepIndex: source.line.step_index, ordinal: source.ordinal});

	/** A live id and the stored row it names, both directions, first occurrence winning each. */
	const join = (liveId: string, stored: string) => {
		if (!cursorAliases.has(liveId)) cursorAliases.set(liveId, stored);
		if (!liveIds.has(stored)) liveIds.set(stored, liveId);
	};

	/**
	 * A live id this row would answer to without being the id the tail keyed it on — a tool batch's
	 * planner step. It resolves a cursor and is never stamped back as the row's `alias`, because a
	 * second row carrying a live id that names another row would make the page/tail stitch drop a
	 * turn it does not hold.
	 */
	const resolvesTo = (liveId: string, stored: string) => {
		if (!cursorAliases.has(liveId)) cursorAliases.set(liveId, stored);
	};

	/**
	 * `` `${conversation_id}:response` `` — and the one key in this map that the *newest* row wins.
	 *
	 * A step key names one line, so first-occurrence is a tie-break for a log whose `step_index`
	 * repeats. This key is not one line's: `resultEvents` mints it once per conversation and every
	 * turn whose reply no `agent_response` delta carried re-sends it, so the row the live tail holds
	 * under it carries the *latest* such reply's text. Resolving it to an older reply would page
	 * before a boundary the window has already walked past and leave the rows between the two
	 * unreachable; resolving it to the newest reply can only return rows the window already holds,
	 * and the page/tail stitch drops exactly those (`shell/chat/rows.ts`'s `unheld`).
	 */
	const resolvesLatest = (liveId: string, stored: string) => {
		cursorAliases.set(liveId, stored);
	};

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
		const id = storedId(conversationId, ordinal);
		const ownLiveId = liveStepId(conversationId, line.step_index);
		const timestamp = millisOf(line.created_at);
		const content = line.content ?? "";
		const calls = line.tool_calls;

		if (line.source === "USER_EXPLICIT" && line.type === "USER_INPUT") {
			join(ownLiveId, id);
			push(here, userItem(id, timestamp, marked(content, clipped.has("content"))));
			return;
		}

		if (line.source === "MODEL" && line.type === "PLANNER_RESPONSE") {
			if (content.length > 0) {
				join(ownLiveId, id);
				resolvesLatest(liveResponseId(conversationId), id);
				push(here, assistantItem(id, timestamp, marked(content, clipped.has("content"))));
			}
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
					stepIndex: read.line.step_index,
				});
				consumed.add(entry.ordinal);
			}
			const tools = toolItemsOf(id, timestamp, calls, outcomes, clipped.has("tool_calls"));
			tools.forEach((item, index) => {
				const outcome = outcomes[index];
				// A call agy has written no outcome for has no live id of its own yet: the step the tail
				// will key it on is the one the `GENERIC` line carries, and that line is not on disk.
				if (outcome !== undefined) join(liveStepId(conversationId, outcome.stepIndex), item.id);
				push(here, item);
			});
			const first = tools[0];
			if (first !== undefined) resolvesTo(ownLiveId, first.id);
			return;
		}

		if (line.source === "SYSTEM") {
			join(ownLiveId, id);
			push(here, systemItem(id, timestamp, marked(content, clipped.has("content"))));
			return;
		}

		join(ownLiveId, id);
		push(here, systemItem(id, timestamp, marked(unrecognisedText(line), clipped.has("content"))));
	});

	/**
	 * The pre-#8968 shape of every stored id, registered only where the live namespace claimed no
	 * such key — which is why it runs after the walk rather than inside it.
	 *
	 * The two old shapes overlapped: this reader keyed a row `cid:<ordinal>` while the tail keys one
	 * `cid:<step_index>`, so a legacy key that won would move a *live* cursor's boundary onto the row
	 * at the same number — the silently wrong page `line:` was added to make impossible. Going last
	 * and never overwriting leaves it able to turn a refusal into a page and unable to change any
	 * resolution that already stands.
	 */
	for (const {item} of placed) resolvesTo(legacyStoredId(conversationId, item.id), item.id);

	// The fold already walks this order, but a batch's rows are all pushed from their call line's
	// `step_index`, so this is what keeps them together rather than interleaved with their outcomes'.
	const items = placed
		.slice()
		.sort((left, right) =>
			left.stepIndex === right.stepIndex
				? left.ordinal - right.ordinal
				: left.stepIndex - right.stepIndex,
		)
		.map((entry) => {
			const live = liveIds.get(entry.item.id);
			return live === undefined ? entry.item : {...entry.item, alias: itemId(live)};
		});
	return {items, cursorAliases};
};

/**
 * One conversation's lines → the port items, oldest-first.
 *
 * The projection's items, for a caller that wants the history and not the cursor join — which is
 * every caller *except* the page planner, and the planner reaches them through
 * `planPageOverTranscript` so it cannot take one without the other.
 */
export const transcriptItems = (
	conversationId: string,
	lines: ReadonlyArray<AgyTranscriptLine>,
	full: ReadonlyArray<AgyTranscriptLine>,
): ReadonlyArray<TranscriptItem> => transcriptProjection(conversationId, lines, full).items;

const readLines = Effect.fn("Agy.readTranscriptLines")(function* (path: string) {
	const fs = yield* FileSystem.FileSystem;
	const present = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
	if (!present) return [];
	const raw = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
	return transcriptLines(raw);
});

/** A conversation's two log files, parsed: the second is empty when it is not on disk. */
const readBoth = Effect.fn("Agy.readTranscriptFiles")(function* (source: TranscriptSource) {
	const dir = transcriptLogDir(source.home, source.conversationId);
	const lines = yield* readLines(`${dir}/${TRANSCRIPT_FILE}`);
	const full = lines.length === 0 ? [] : yield* readLines(`${dir}/${TRANSCRIPT_FULL_FILE}`);
	return {lines, full};
});

/**
 * One conversation's history, oldest-first. A conversation with no directory and no file yields an
 * empty history rather than a failure: a session agy has not written yet is a session with no
 * history, which is a page, not an error.
 */
export const readTranscriptItems = Effect.fn("Agy.readTranscriptItems")(function* (
	source: TranscriptSource,
) {
	const read = yield* readBoth(source);
	return transcriptItems(source.conversationId, read.lines, read.full);
});

export const emptyPage: TranscriptPage = {
	kind: "page",
	start: 0,
	items: [],
	omitted: {items: 0, bytes: 0, reason: "none"},
	next: null,
};

/** What a page read is bounded by. The cursor join is not here, because no caller may choose it. */
export interface PageBound {
	/** The oldest item the caller already holds — a stored id or a live tail id — or `null`. */
	readonly before: string | null;
	readonly limit: number;
	readonly byteLimit?: number;
}

/**
 * One page of this conversation, planned the one way every caller must plan it.
 *
 * The two planner options that resolve a live cursor live *here*, composed with the projection that
 * mints them, rather than at each call site where dropping one reds nothing and silently restores
 * #8900: `cursorAliases` is the live-to-stored join, and `cursorBoundary` is what a cursor naming a
 * tool row *inside* an exchange needs — the boundary is that exchange's start, not the row itself
 * (the shape `pi/ai-agent/entries.ts`'s `planPageOverEntries` fixed for Pi in #8204).
 */
export const planPageOverTranscript = (
	conversationId: string,
	lines: ReadonlyArray<AgyTranscriptLine>,
	full: ReadonlyArray<AgyTranscriptLine>,
	bound: PageBound,
): TranscriptPageResult => {
	const projected = transcriptProjection(conversationId, lines, full);
	if (projected.items.length === 0 && bound.before === null) return emptyPage;
	return planTranscriptPage(projected.items, {
		before: bound.before,
		cursorAliases: projected.cursorAliases,
		cursorBoundary: "containing-group",
		limit: bound.limit,
		...(bound.byteLimit === undefined ? {} : {byteLimit: bound.byteLimit}),
	});
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
	bound: PageBound,
) {
	const read = yield* readBoth(source);
	return planPageOverTranscript(source.conversationId, read.lines, read.full, bound);
});
