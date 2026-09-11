/**
 * A cursor in the stored-id shape this reader minted **before** #8968 (#8900, criteria 11 and 12).
 *
 * #8968 moved a stored row's id from `cid:<ordinal>` to `cid:line:<ordinal>` — the segment that makes
 * the two id spaces disjoint, because the live tail keys a row `cid:<step_index>` and the two would
 * otherwise render the same text over different numbers. A desk written down under the old shape can
 * therefore hand back a cursor naming a row that is still on disk under a new id, and without an
 * alias it reads as `cursor-not-found` — a history that cannot be walked at all.
 *
 * The alias is registered on **one** of the two old shapes: a tool row's `cid:<ordinal>:<index>`,
 * whose second segment nothing in the live namespace can mint. The bare `cid:<ordinal>` a non-tool row
 * carried is *not* registered, and that is the point of criterion 12 rather than a gap — it is the
 * live tail's own key shape, so registering it would put the two spaces back in one namespace in both
 * directions. The last two cases below are what pin that, over the fixture whose `step_index`
 * sequence differs from its file order; the cost — a bare legacy cursor still refusing — is stated
 * there rather than left to be noticed.
 *
 * **The old shape is not reachable through the desk's own paths today**, and that is why this file is
 * the whole of the check rather than one half of a desk test. Three carriers could hold a stored row
 * across a restart and every one of them is closed: `refillTranscript` (`ai-agent/core/fold.ts`) runs
 * only on a `StartedSession.history`, which `AgyAiAgent`'s `start` does not carry; `lastPage` is
 * dropped by `restore` (`ai-agent/core/state.ts`); and the read-only session view needs a picked row,
 * which agy's `unsupported` session list mints none of. So the alias is insurance against a carrier
 * being wired, not a migration of a state the desk can produce.
 *
 * The pre-fix ids are read off the repo's own history (the module at `7ec91481`, whose `storedId` was
 * `` `${conversationId}:${ordinal}` `` and whose tool rows were `` `${id}:${index}` ``) rather than
 * hand-numbered — and the two this file names literally are the two triage read off that same module
 * when it filed the criterion.
 */

import {describe, expect, it} from "vitest";
import {type AiAgentSessionState, initialState, restore} from "../../ai-agent/core/index.ts";
import {isRefusal} from "../../ai-agent/history/index.ts";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {planPageOverTranscript, transcriptLines, transcriptProjection} from "./transcript.ts";
import * as fixtures from "./transcript-fixtures.ts";

const JOIN_CID = fixtures.liveJoinConversationId;
const MULTI_CID = fixtures.multiCallConversationId;

const parsed = (lines: ReadonlyArray<string>) => transcriptLines(lines.join("\n"));

const joinProjection = () =>
	transcriptProjection(
		JOIN_CID,
		parsed(fixtures.liveJoinLines),
		parsed(fixtures.liveJoinFullLines),
	);

const joinPage = (before: string | null, limit = 50) =>
	planPageOverTranscript(
		JOIN_CID,
		parsed(fixtures.liveJoinLines),
		parsed(fixtures.liveJoinFullLines),
		{before, limit},
	);

const multiProjection = () =>
	transcriptProjection(
		MULTI_CID,
		parsed(fixtures.multiCallLines),
		parsed(fixtures.multiCallFullLines),
	);

/**
 * The same capture with the batch's **second** outcome dropped, which is the in-flight shape: agy has
 * written the `PLANNER_RESPONSE` carrying both calls and the first call's `GENERIC`, and the second
 * call's `GENERIC` — the line whose `step_index` the live tail keys that row on — is not on disk yet.
 * The two files align by position and carry the same sequence, so the same line goes from both.
 */
const withoutSecondOutcome = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
	lines.filter((line) => (JSON.parse(line) as {step_index: number}).step_index !== 3);

const inFlightProjection = () =>
	transcriptProjection(
		MULTI_CID,
		parsed(withoutSecondOutcome(fixtures.multiCallLines)),
		parsed(withoutSecondOutcome(fixtures.multiCallFullLines)),
	);

/**
 * The id `7ec91481`'s reader minted for the row this one calls `stored` — the `line:` segment gone
 * and nothing else touched, which is the whole of what #8968 changed about the shape.
 */
const preFix = (conversationId: string, stored: string): string =>
	stored.replace(`${conversationId}:line:`, `${conversationId}:`);

const ids = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
	items.map((item) => item.id);

describe("a cursor in the pre-#8968 stored-id shape", () => {
	it("is the shape triage read off the pre-fix module, for the fixture it read it on", () => {
		// The criterion's own words about `fixtures/multi-call-transcript.jsonl`: "the batch's stored
		// rows are `cid:2:0` and `cid:2:1`". That is the pre-fix reader's answer, written down before
		// this change existed, so it is the one independent check on `preFix` below.
		const batch = multiProjection().items.filter((item) => item.kind === "tool");
		expect(ids(batch)).toEqual([`${MULTI_CID}:line:2:0`, `${MULTI_CID}:line:2:1`]);
		expect(batch.map((item) => preFix(MULTI_CID, item.id))).toEqual([
			`${MULTI_CID}:2:0`,
			`${MULTI_CID}:2:1`,
		]);
	});

	it("names the row it was minted for, on the tool-row shape no live id can claim", () => {
		// `cid:<ordinal>:<index>` is the one pre-fix shape that is unambiguous by construction: the
		// live tail mints `cid:<n>` and `cid:response` and never a second segment, so nothing shadows
		// it. Equality against the page the row's *current* id gives is the claim — the pre-fix cursor
		// names the same row, rather than merely being a cursor something answered.
		const served = joinPage(`${JOIN_CID}:2:0`);
		expect(served).toEqual(joinPage(`${JOIN_CID}:line:2:0`));
		expect(isRefusal(served)).toBe(false);
		if (isRefusal(served)) throw new Error("refused");
		// Empty, and that is the boundary rule rather than a missing row: the cursor names a tool row
		// inside an exchange, `cursorBoundary: "containing-group"` moves the boundary to that
		// exchange's start, and the capture's first exchange opens on the conversation's first row.
		expect(ids(served.items)).toEqual([]);
	});

	it("pages every row of the paired v1.2.0 capture — the tool rows by the alias, the rest by a live key that already stood", () => {
		// This capture's log is written in step order, so `step_index` equals the ordinal for each of
		// its non-tool rows and their bare pre-fix ids are already live keys. That is what answers them
		// here, not the alias — the next two cases are the ones that separate the two.
		const history = joinProjection();
		for (const item of history.items) {
			const cursor = preFix(JOIN_CID, item.id);
			const answer = joinPage(cursor);
			expect(isRefusal(answer) ? `refused:${cursor}` : "page").toBe("page");
		}
	});

	it("never outranks the live id of the same text, which is what the two shapes overlapping would cost", () => {
		const aliases = joinProjection().cursorAliases;
		for (const ordinal of [0, 4, 5, 6, 7, 8, 9]) {
			expect(aliases.get(`${JOIN_CID}:${ordinal}`)).toBe(`${JOIN_CID}:line:${ordinal}`);
		}
		// The two keys the alias actually adds, both unshadowed.
		expect(aliases.get(`${JOIN_CID}:2:0`)).toBe(`${JOIN_CID}:line:2:0`);
		expect(aliases.get(`${JOIN_CID}:2:1`)).toBe(`${JOIN_CID}:line:2:1`);
	});

	it("pages a restored tail whose rows came back under the pre-fix shape", () => {
		// The state criterion 11 describes, built by hand because no desk path produces it: a
		// checkpoint whose agy tail is stored rows under the old ids. `restore` keeps the tail, so the
		// window's oldest loaded row is a pre-fix id and the page it asks for carries one.
		const history = joinProjection().items;
		const saved: AiAgentSessionState = {
			...initialState("/repo"),
			phase: "ready",
			sessionId: JOIN_CID,
			transcript: {
				items: history.map((item) => ({...item, id: preFix(JOIN_CID, item.id)}) as TranscriptItem),
				omitted: {items: 0, bytes: 0, reason: "none"},
			},
		};
		const back = restore(saved);
		expect(ids(back.transcript.items)).toEqual(history.map((item) => preFix(JOIN_CID, item.id)));

		// Every row of that tail, not only its oldest: the window walks back one page at a time, so a
		// cursor that refuses three rows in is a history that stops three rows in. The batch's two are
		// the ones this would refuse without the alias — no live key names them.
		for (const item of back.transcript.items) {
			const answer = joinPage(item.id);
			expect(isRefusal(answer) ? `refused:${item.id}` : "page").toBe("page");
		}
	});

	it("adds the two-segment tool keys and no bare one, on a transcript whose step order is not its file order", () => {
		// `multi-call-transcript.jsonl` is written out of step order — ordinals 0,1,2,3,4 carry steps
		// 0,2,1,3,4 — so this is the projection where "the ordinal" and "the step number" are different
		// numbers and a bare `cid:<n>` key can only mean one of them. The whole key set, asserted
		// exactly rather than by spot-check, because the claim is an absence: every bare key here was
		// minted by the walk from a line's own `step_index`, and the alias contributed the two
		// two-segment keys alone. It is a pin and not by itself a discriminator — this capture's steps
		// happen to cover every ordinal, so a bare registration would have overwritten nothing here.
		// The next case is the one that separates the two.
		expect([...multiProjection().cursorAliases.entries()]).toEqual([
			[`${MULTI_CID}:0`, `${MULTI_CID}:line:0`],
			[`${MULTI_CID}:2`, `${MULTI_CID}:line:2:0`],
			[`${MULTI_CID}:3`, `${MULTI_CID}:line:2:1`],
			[`${MULTI_CID}:1`, `${MULTI_CID}:line:2:0`],
			[`${MULTI_CID}:4`, `${MULTI_CID}:line:4`],
			[`${MULTI_CID}:response`, `${MULTI_CID}:line:4`],
			[`${MULTI_CID}:2:0`, `${MULTI_CID}:line:2:0`],
			[`${MULTI_CID}:2:1`, `${MULTI_CID}:line:2:1`],
		]);
	});

	it("leaves an in-flight call's live key refusing rather than resolving it onto the line at that ordinal", () => {
		// The case criterion 12 turns on, and the one the bare shape would break. With the batch's
		// second outcome not yet on disk, that tool row has no live id of its own — `mapper.ts` keys it
		// `cid:3` the moment the step goes `RUNNING`, while the projection can mint no key for a
		// `GENERIC` it cannot read. Meanwhile the reply slides up to **ordinal 3**, so its bare pre-fix
		// id is `cid:3` too: registering that would answer the in-flight cursor with an unrelated row
		// and swallow the rows between — a gap of unreachable history in place of the #8814 banner.
		const inFlight = inFlightProjection();
		expect(
			inFlight.items.map((item) => [item.id, item.alias, (item as {status?: string}).status]),
		).toEqual([
			[`${MULTI_CID}:line:0`, `${MULTI_CID}:0`, undefined],
			[`${MULTI_CID}:line:2:0`, `${MULTI_CID}:2`, "ok"],
			[`${MULTI_CID}:line:2:1`, undefined, "running"],
			[`${MULTI_CID}:line:3`, `${MULTI_CID}:4`, undefined],
		]);
		expect(inFlight.cursorAliases.has(`${MULTI_CID}:3`)).toBe(false);

		// And the cost, stated rather than hidden: a *legacy* cursor in the bare shape refuses now too,
		// including this reply's own pre-fix `cid:3`. A refusal is the #8814 banner — visible and
		// recoverable — where the alternative is a silently wrong boundary, which is the failure class
		// #8900 exists to remove. Only the two-segment keys resolve.
		expect(inFlight.cursorAliases.get(`${MULTI_CID}:2:0`)).toBe(`${MULTI_CID}:line:2:0`);
		expect(inFlight.cursorAliases.get(`${MULTI_CID}:2:1`)).toBe(`${MULTI_CID}:line:2:1`);
	});
});
