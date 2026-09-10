/**
 * The seam #8900 reported broken: an agy window's live rows and its history page are built by two
 * different modules, and the window pages by sending a live row's own id back as the cursor
 * (`oldestLoadedId` → `olderPageRequest` in `shell/chat/rows.ts`, carried as
 * `{type: "page", before, limit}`). `mapper.ts` keys a live row on the step number agy streams;
 * `transcript.ts` keys the same row on its line's file position. Before the join below, every page on
 * a real desk answered `cursor-not-found`.
 *
 * The two sides are joined here rather than in either module's own test, because neither can see the
 * mismatch alone — and both are built by the shipped functions rather than hand-numbered, for the
 * reason `pi/ai-agent/paging-from-live.unit.test.ts` gives: hand-numbering passes while the real thing
 * fails. The live tail is `eventsOf` folded with the core's own `upsertItem`; the page is
 * `planPageOverTranscript`, the one function `AgyAiAgent`'s `page` and `sessionTranscript` both reach
 * through, so dropping the cursor aliases from the shipped path reds this file.
 *
 * The live side of the paired v1.2.0 capture is a *real stream* (`transcript-fixtures.ts` states what
 * was driven), so the first cases are the measurement the join rests on, and `streamFor` — the
 * synthesiser the older single-sided fixture needs — is checked against that capture rather than
 * trusted.
 */

import {describe, expect, it} from "vitest";
import {promptItem, upsertItem} from "../../ai-agent/core/index.ts";
import {isRefusal, type TranscriptPage} from "../../ai-agent/history/index.ts";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
// `rows.ts` rather than the chat barrel: the barrel re-exports `.tsx`, which the node tsconfig's
// file list does not carry, so importing it from here is a TS6307 on `pnpm typecheck`.
import {mergeOlder} from "../../shell/chat/rows.ts";
import {eventsOf, idleTurn} from "./mapper.ts";
import {planPageOverTranscript, transcriptLines, transcriptProjection} from "./transcript.ts";
import * as fixtures from "./transcript-fixtures.ts";
import type {AgyTranscriptLine} from "./transcript-wire.ts";

const JOIN_CID = fixtures.liveJoinConversationId;
const MULTI_CID = fixtures.multiCallConversationId;

/** The rows the window's live tail holds, folded the way the core folds them. */
const liveTail = (stream: ReadonlyArray<string>): ReadonlyArray<TranscriptItem> => {
	let carry = idleTurn;
	let items: ReadonlyArray<TranscriptItem> = [];
	stream.forEach((line, index) => {
		const folded = eventsOf(carry, line, 1_760_000_000_000 + index);
		carry = folded.next;
		for (const event of folded.events)
			if (event.kind === "item") items = upsertItem(items, event.item);
	});
	return items;
};

const parsed = (lines: ReadonlyArray<string>): ReadonlyArray<AgyTranscriptLine> =>
	transcriptLines(lines.join("\n"));

const stored = (
	conversationId: string,
	lines: ReadonlyArray<string>,
	full: ReadonlyArray<string>,
) => transcriptProjection(conversationId, parsed(lines), parsed(full));

const pageBefore = (
	conversationId: string,
	lines: ReadonlyArray<string>,
	full: ReadonlyArray<string>,
	before: string | null,
	limit = 50,
) => planPageOverTranscript(conversationId, parsed(lines), parsed(full), {before, limit});

/** The live-join capture's own page read, which is every case below bar the two other fixtures'. */
const joinPage = (before: string | null, limit = 50) =>
	pageBefore(JOIN_CID, fixtures.liveJoinLines, fixtures.liveJoinFullLines, before, limit);

const served = (answer: ReturnType<typeof pageBefore>): TranscriptPage => {
	expect(isRefusal(answer)).toBe(false);
	if (isRefusal(answer)) throw new Error("refused");
	return answer;
};

const texts = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
	items.map((item) => (item.kind === "tool" ? `${item.name}()` : item.text));

const ids = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
	items.map((item) => item.id);

/** Turn 1 of the capture: the prompt, the two calls of its one planner step, and the reply. */
const firstTurn = [
	expect.stringContaining("In ONE single planner step"),
	"view_file()",
	"view_file()",
	"5,3",
];

/**
 * The stream agy would have sent for these log lines, for a fixture captured on one side only.
 *
 * It reproduces the step *identities* the paired v1.2.0 capture measured, and only those — which is
 * why a tool step here names no real tool: `mapper.ts` keys every row it mints on
 * `${conversation_id}:${step_index}`, so the identity is the whole of what a cursor test needs. The
 * third case below asserts this synthesiser reproduces the real capture's ids from its log alone, so
 * it is checked rather than assumed.
 */
const streamFor = (
	conversationId: string,
	lines: ReadonlyArray<AgyTranscriptLine>,
): ReadonlyArray<string> => {
	const step = (body: Record<string, unknown>) =>
		JSON.stringify({
			event: "step_update",
			step_update: {conversation_id: conversationId, state: "DONE", ...body},
		});
	const ordered = [...lines].sort((left, right) => left.step_index - right.step_index);
	const stream: Array<string> = [];
	let turns = 0;
	let reply = "";
	const endTurn = () => {
		if (turns === 0) return;
		// The terminal `result` is not decoration: `mapper.ts` carries one reply id per *turn*, so a
		// stream with no turn end folds every later reply into the first turn's row.
		stream.push(
			JSON.stringify({
				event: "result",
				result: {
					conversation_id: conversationId,
					status: "SUCCESS",
					response: reply,
					num_turns: turns,
				},
			}),
		);
		reply = "";
	};
	for (const line of ordered) {
		// Measured: agy carries no text on a `user_input` step and none on a `system_message` one, so
		// neither mints a live row at all — only the log holds those turns.
		if (line.source === "USER_EXPLICIT") {
			endTurn();
			turns += 1;
			stream.push(step({step_index: line.step_index, step_type: "user_input"}));
			continue;
		}
		if (line.source === "SYSTEM") {
			stream.push(step({step_index: line.step_index, step_type: "system_message"}));
			continue;
		}
		if (line.type === "GENERIC") {
			stream.push(step({step_index: line.step_index, step_type: "tool", tool_name: "tool"}));
			continue;
		}
		reply = line.content ?? "";
		stream.push(
			step({step_index: line.step_index, step_type: "agent_response", text_delta: reply}),
		);
	}
	endTurn();
	return stream;
};

describe("paging an agy window back from its own live tail", () => {
	it("keys the live tail on steps and the history on file positions, in two disjoint spaces", () => {
		// Four rows for three turns: agy streams no text on a `user_input` or `system_message` step,
		// so the operator's own prompts have no layer row at all — the core's local echo stands in.
		const tail = liveTail(fixtures.liveJoinStreamLines);
		expect(ids(tail)).toEqual([`${JOIN_CID}:2`, `${JOIN_CID}:3`, `${JOIN_CID}:4`, `${JOIN_CID}:6`]);

		const history = stored(JOIN_CID, fixtures.liveJoinLines, fixtures.liveJoinFullLines);
		expect(ids(history.items)).toEqual([
			`${JOIN_CID}:line:0`,
			`${JOIN_CID}:line:2:0`,
			`${JOIN_CID}:line:2:1`,
			`${JOIN_CID}:line:4`,
			`${JOIN_CID}:line:5`,
			`${JOIN_CID}:line:6`,
			`${JOIN_CID}:line:7`,
			`${JOIN_CID}:line:8`,
			`${JOIN_CID}:line:9`,
		]);

		// No live id is a stored id, so the pager's exact-match precedence can never fire on one and
		// the alias is the only thing that resolves a live cursor.
		const storedIds = new Set(ids(history.items));
		for (const item of tail) expect(storedIds.has(item.id)).toBe(false);
	});

	it("resolves every id the real stream minted onto the stored row for the same turn", () => {
		const tail = liveTail(fixtures.liveJoinStreamLines);
		const history = stored(JOIN_CID, fixtures.liveJoinLines, fixtures.liveJoinFullLines);
		const resolved = (items: ReadonlyArray<TranscriptItem>) =>
			items.map((item) => history.cursorAliases.get(item.id) ?? `unresolved:${item.id}`);

		expect(resolved(tail)).toEqual([
			`${JOIN_CID}:line:2:0`,
			`${JOIN_CID}:line:2:1`,
			`${JOIN_CID}:line:4`,
			`${JOIN_CID}:line:6`,
		]);
		// The resumed child's own turn, off the second capture: `step_index` continues across a resume,
		// so its id lands in the same space and resolves through the same map.
		expect(resolved(liveTail(fixtures.liveJoinResumedStreamLines))).toEqual([`${JOIN_CID}:line:9`]);
	});

	it("reproduces the real capture's live ids from its log alone, which is what the synthesiser claims", () => {
		const real = ids(liveTail(fixtures.liveJoinStreamLines));
		const resumed = ids(liveTail(fixtures.liveJoinResumedStreamLines));
		const modelled = ids(liveTail(streamFor(JOIN_CID, parsed(fixtures.liveJoinLines))));
		expect(modelled).toEqual([...real, ...resumed]);
	});

	it("answers a live cursor with the rows behind it instead of cursor-not-found", () => {
		for (const item of liveTail(fixtures.liveJoinStreamLines)) {
			expect(isRefusal(joinPage(item.id))).toBe(false);
		}

		// The window holding all three turns pages from its newest turn's reply and gets the two
		// before it. Before the join this call was the `unknown-cursor` banner (#8814).
		const page = served(joinPage(`${JOIN_CID}:6`));
		expect(texts(page.items)).toEqual(firstTurn);
	});

	it("hands back stored ids, so history is walkable to its start and not one page deep", () => {
		const first = served(joinPage(`${JOIN_CID}:9`, 1));
		expect(first.next).toBe(`${JOIN_CID}:line:8`);

		// Every later cursor is a stored id this reader minted, so the walk needs no alias after the
		// first call — and it reaches the conversation's first row rather than stalling.
		const walked: Array<string> = [...ids(first.items)];
		let cursor = first.next;
		for (let guard = 0; cursor !== null && guard < 10; guard += 1) {
			const next = served(joinPage(cursor, 1));
			walked.unshift(...ids(next.items));
			cursor = next.next;
		}
		expect(walked).toEqual([
			`${JOIN_CID}:line:0`,
			`${JOIN_CID}:line:2:0`,
			`${JOIN_CID}:line:2:1`,
			`${JOIN_CID}:line:4`,
			`${JOIN_CID}:line:5`,
			`${JOIN_CID}:line:6`,
			`${JOIN_CID}:line:7`,
			`${JOIN_CID}:line:8`,
		]);
	});

	/**
	 * The restart the filing observed not helping: the restored process brings its checkpointed live
	 * items back, so the window still pages with a live id — the id of a row a *stopped* child minted.
	 * Here that is the first child's own tail against a log a resumed child has since grown.
	 */
	it("accepts a cursor a stopped child minted, so a desk restart pages rather than refusing", () => {
		const restored = liveTail(fixtures.liveJoinStreamLines);
		const oldest = restored[0]?.id ?? null;
		expect(oldest).toBe(`${JOIN_CID}:2`);

		// The oldest restored row sits in the conversation's first exchange, so the page behind it is
		// empty and walkable to its start — a page, never a refusal.
		const page = served(joinPage(oldest));
		expect(page.items).toEqual([]);
		expect(page.next).toBeNull();
		expect(texts(served(joinPage(restored[3]?.id ?? null)).items)).toEqual(firstTurn);
	});

	it("takes a tool row inside a batch as a cursor, by its live id and by its stored one", () => {
		const live = served(joinPage(`${JOIN_CID}:3`));
		const byStoredId = served(joinPage(`${JOIN_CID}:line:2:1`));
		// The boundary is the exchange the row sits inside, not the row itself, so neither answer
		// slices the batch in half.
		expect(texts(live.items)).toEqual([]);
		expect(texts(byStoredId.items)).toEqual(texts(live.items));
	});

	it("resolves the id resultEvents mints for a turn no delta carried", () => {
		const history = stored(JOIN_CID, fixtures.liveJoinLines, fixtures.liveJoinFullLines);
		// The newest reply wins this key, because every turn re-sends it — `resolvesLatest` in
		// `transcript.ts` has the reason.
		expect(history.cursorAliases.get(`${JOIN_CID}:response`)).toBe(`${JOIN_CID}:line:9`);

		const page = served(joinPage(`${JOIN_CID}:response`));
		expect(ids(page.items)).toEqual([
			`${JOIN_CID}:line:0`,
			`${JOIN_CID}:line:2:0`,
			`${JOIN_CID}:line:2:1`,
			`${JOIN_CID}:line:4`,
			`${JOIN_CID}:line:5`,
			`${JOIN_CID}:line:6`,
			`${JOIN_CID}:line:7`,
			`${JOIN_CID}:line:8`,
		]);
	});

	/**
	 * Criterion: a prepended page doubles no turn the live tail already holds. The four rows agy's
	 * stream minted carry the tail's ids in `alias`, so the stitch drops the page's copies of them;
	 * the prompts and the system notice are rows the stream never minted, and they are what the page
	 * is *for* — bar one the window holds the core's own `local:` echo of, which the case below is.
	 */
	it("stamps the live id on every stored row, so a prepended page doubles no turn the tail holds", () => {
		// What a window holds after the restart: the stopped child's rows, restored, then the resumed
		// child's own — distinct ids in step order, which is what the core's fold leaves.
		const tail = [
			...liveTail(fixtures.liveJoinStreamLines),
			...liveTail(fixtures.liveJoinResumedStreamLines),
		];
		const history = stored(JOIN_CID, fixtures.liveJoinLines, fixtures.liveJoinFullLines);
		expect(history.items.map((item) => item.alias)).toEqual([
			`${JOIN_CID}:0`,
			`${JOIN_CID}:2`,
			`${JOIN_CID}:3`,
			`${JOIN_CID}:4`,
			`${JOIN_CID}:5`,
			`${JOIN_CID}:6`,
			`${JOIN_CID}:7`,
			`${JOIN_CID}:8`,
			`${JOIN_CID}:9`,
		]);

		const merged = mergeOlder(tail, served(joinPage(null)).items);
		expect(ids(merged)).toEqual([
			`${JOIN_CID}:line:0`,
			`${JOIN_CID}:line:5`,
			`${JOIN_CID}:line:7`,
			`${JOIN_CID}:line:8`,
			...ids(tail),
		]);
	});

	/**
	 * The other half of the same stitch, and the one agy alone needs (#8961): the operator's own turn.
	 *
	 * agy's `user_input` step carries no `text_delta`, so its live tail mints no `user` row for a
	 * prompt at all — the core's `local:` echo is the only copy the window holds, and it stays `local`
	 * for the window's whole life. There is therefore no id on either side to join on, and
	 * `claimsLocal`'s text join is the whole of the reconciliation. It can only fire on the text the
	 * operator actually typed, which is what `promptText` in `transcript.ts` is for: against the
	 * stored `<USER_REQUEST>` frame the budget never spent and the page prepended a second copy of the
	 * turn, in agy's wire markup, above the echo.
	 */
	it("joins a paged prompt against the local echo agy never confirmed, rather than doubling it", () => {
		// The window's tail as a desk that sent the third turn itself holds it: the restored rows of
		// the stopped child, then the echo the core recorded on send, then the resumed child's own row.
		const echo = promptItem({
			text: "Reply with only the word AGAIN and run no tools. No paths, no links.",
			key: "send-again",
			timestamp: 1_760_000_000_000,
		});
		const tail = [
			...liveTail(fixtures.liveJoinStreamLines),
			echo,
			...liveTail(fixtures.liveJoinResumedStreamLines),
		];

		const page = served(joinPage(null));
		// The stored row for that turn carries the prompt as typed, which is the only thing the join
		// has: unwrapped it equals the echo's text exactly, frame and metadata blocks gone.
		const storedPrompt = page.items.find((item) => item.id === `${JOIN_CID}:line:7`);
		expect(storedPrompt?.kind === "user" ? storedPrompt.text : null).toBe(echo.text);

		const merged = mergeOlder(tail, page.items);
		expect(ids(merged)).toEqual([
			`${JOIN_CID}:line:0`,
			`${JOIN_CID}:line:5`,
			`${JOIN_CID}:line:8`,
			...ids(tail),
		]);
		// One copy of the turn, and it is the echo's row: the page's copy is gone, not both.
		expect(texts(merged).filter((text) => text === echo.text)).toEqual([echo.text]);
	});

	/**
	 * The ambiguity the one-shape scheme left: this capture's lines carry `step_index` 0,2,1,3,4 over
	 * ordinals 0..4, so a live step number and an unrelated line's file position agree by luck — live
	 * `cid:4` is the reply while ordinal 4 is a different row's position under the old scheme.
	 * Resolution is by construction: no stored id is shaped like a live one, so there is no
	 * exact-match precedence for the coincidence to win.
	 */
	it("does not page the wrong rows when a live step number equals an unrelated file ordinal", () => {
		const history = stored(MULTI_CID, fixtures.multiCallLines, fixtures.multiCallFullLines);
		const tail = liveTail(streamFor(MULTI_CID, parsed(fixtures.multiCallLines)));

		expect(ids(tail)).toEqual([`${MULTI_CID}:2`, `${MULTI_CID}:3`, `${MULTI_CID}:4`]);
		expect(
			tail.map((item) => history.cursorAliases.get(item.id) ?? `unresolved:${item.id}`),
		).toEqual([`${MULTI_CID}:line:2:0`, `${MULTI_CID}:line:2:1`, `${MULTI_CID}:line:4`]);

		const page = served(
			pageBefore(MULTI_CID, fixtures.multiCallLines, fixtures.multiCallFullLines, `${MULTI_CID}:4`),
		);
		// The reply is the cursor, so the page is its own exchange up to it — not the file's tail,
		// which is what a bare `cid:4` hit under one id space.
		expect(texts(page.items)).toEqual([]);
		expect(page.next).toBeNull();
	});

	/**
	 * `step_index` is neither unique nor monotonic (the census in `transcript.ts`'s module note), so
	 * the map is many-to-one. First occurrence wins — Claude's precedent — rather than whichever line
	 * the walk reached last, which is what makes the boundary a fact about the log instead of about
	 * the iteration order.
	 */
	it("gives a repeated step_index to its first occurrence", () => {
		const at = (step: number, text: string, user = false) =>
			JSON.stringify({
				step_index: step,
				source: user ? "USER_EXPLICIT" : "MODEL",
				type: user ? "USER_INPUT" : "PLANNER_RESPONSE",
				status: "DONE",
				created_at: "2026-09-10T05:21:26Z",
				content: text,
			});
		const lines = [
			at(0, "q1", true),
			at(1, "a1"),
			at(2, "q2", true),
			at(3, "first"),
			at(3, "second"),
		];
		const history = stored("cid", lines, []);

		expect(texts(history.items)).toEqual(["q1", "a1", "q2", "first", "second"]);
		// The rule lives here: last-occurrence would name `cid:line:4`, the row the window is already
		// holding under this very cursor, and page behind a boundary it has walked past.
		expect(history.cursorAliases.get("cid:3")).toBe("cid:line:3");
		expect(texts(served(pageBefore("cid", lines, [], "cid:3")).items)).toEqual(["q1", "a1"]);
	});
});
