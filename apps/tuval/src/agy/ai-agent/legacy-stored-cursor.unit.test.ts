/**
 * A cursor in the stored-id shape this reader minted **before** #8968 (#8900, criterion 11).
 *
 * #8968 moved a stored row's id from `cid:<ordinal>` to `cid:line:<ordinal>` — the segment that makes
 * the two id spaces disjoint, because the live tail keys a row `cid:<step_index>` and the two would
 * otherwise render the same text over different numbers. A desk written down under the old shape can
 * therefore hand back a cursor naming a row that is still on disk under a new id, and without the
 * alias `legacyStoredId` registers it reads as `cursor-not-found` — a history that cannot be walked
 * at all.
 *
 * **The old shape is not reachable through the desk's own paths today**, and that is why this file is
 * the whole of the check rather than one half of a desk test. Three carriers could hold a stored row
 * across a restart and every one of them is closed: `refillTranscript` (`ai-agent/core/fold.ts`) runs
 * only on a `StartedSession.history`, which `AgyAiAgent`'s `start` does not carry; `lastPage` is
 * dropped by `restore` (`ai-agent/core/state.ts`); and the read-only session view needs a picked row,
 * which agy's `unsupported` session list mints none of. So the alias is insurance against a carrier
 * being wired, not a migration of a state the desk can produce — the fourth case below is what pins
 * the shape if one ever is.
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
		const batch = transcriptProjection(
			MULTI_CID,
			parsed(fixtures.multiCallLines),
			parsed(fixtures.multiCallFullLines),
		).items.filter((item) => item.kind === "tool");
		expect(ids(batch)).toEqual([`${MULTI_CID}:line:2:0`, `${MULTI_CID}:line:2:1`]);
		expect(batch.map((item) => preFix(MULTI_CID, item.id))).toEqual([
			`${MULTI_CID}:2:0`,
			`${MULTI_CID}:2:1`,
		]);
	});

	it("resolves for every row of the paired v1.2.0 capture, rather than refusing cursor-not-found", () => {
		const history = joinProjection();
		for (const item of history.items) {
			const cursor = preFix(JOIN_CID, item.id);
			const answer = joinPage(cursor);
			expect(isRefusal(answer) ? `refused:${cursor}` : "page").toBe("page");
		}
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

	it("never outranks the live id of the same text, which is what the two shapes overlapping costs", () => {
		// Every `cid:<n>` a pre-fix row would be named by is already a live key on this capture, and
		// the live meaning is the one that stands: the alias goes in last and overwrites nothing. Here
		// the two agree — `step_index` equals the ordinal for each of these rows — so the assertion is
		// that the live resolution is unchanged, not that the pre-fix one won.
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
});
