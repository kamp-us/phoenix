/**
 * The page's transcript half without a socket: what one reply becomes, and what a sequence of
 * landed pages folds into.
 *
 * The rendered half is `./session-transcript-window.unit.test.tsx`, which drives the same functions
 * through the mounted window over a scripted `call`. This file is where the fold's rules are stated
 * one at a time, because each of them is a case a rendered assertion would only reach indirectly.
 */

import {describe, expect, it} from "vitest";
import {CallId} from "../protocol/ids.ts";
import type {SpellFailure, SpellReply} from "../protocol/messages.ts";
import {PROTOCOL_VERSION, SpellReplyError, SpellReplyOk} from "../protocol/messages.ts";
import {SESSION_LIST_PROGRAM} from "../protocol/session-list.ts";
import type {SessionTranscript, TranscriptItemWire} from "../protocol/session-transcript.ts";
import {
	SESSION_TRANSCRIPT_CALL_PATH,
	SESSION_TRANSCRIPT_PATH,
} from "../protocol/session-transcript.ts";
import type {TranscriptPaging} from "./session-transcript.ts";
import {
	askedOlder,
	landedPage,
	noPages,
	pagedAnswer,
	readSessionTranscript,
	sessionTranscriptCall,
} from "./session-transcript.ts";

const READ = {
	programId: "claude-session",
	sessionId: "c-1",
	cwd: "/Users/founder/code/phoenix",
	before: null,
	limit: 50,
};

const item = (id: string): TranscriptItemWire => ({
	kind: "user",
	id,
	timestamp: 1,
	text: `turn ${id}`,
});

const page = (ids: ReadonlyArray<string>, next: string | null): SessionTranscript => ({
	items: ids.map(item),
	next,
});

const ok = (id: string, result: unknown): SpellReply =>
	new SpellReplyOk({
		type: "spell.reply",
		version: PROTOCOL_VERSION,
		id: CallId.make(id),
		ok: true,
		result,
	});

const failure: SpellFailure = {
	tag: "tuval/TranscriptError",
	message: 'no session "c-1" is stored for this working directory',
	path: [...SESSION_TRANSCRIPT_PATH],
};

const refusal = (id: string, error: SpellFailure = failure): SpellReply =>
	new SpellReplyError({
		type: "spell.reply",
		version: PROTOCOL_VERSION,
		id: CallId.make(id),
		ok: false,
		error,
	});

const ids = (paging: TranscriptPaging): ReadonlyArray<string> =>
	paging.items.map((held) => held.id);

describe("the call", () => {
	it("addresses the call where the registry holds the spell", () => {
		const call = sessionTranscriptCall(READ);

		// The row's own path is `session.transcript`; the registry keys it under the program id, and
		// a call carrying the bare path reaches no spell at all (#8238).
		expect([...call.path]).toEqual([...SESSION_TRANSCRIPT_CALL_PATH]);
		expect([...call.path].slice(1)).toEqual([...SESSION_TRANSCRIPT_PATH]);
		expect(call.path[0]).toBe(SESSION_LIST_PROGRAM);
	});

	it("carries the session's whole address plus the cursor and the bound", () => {
		const call = sessionTranscriptCall({...READ, before: "m-9", limit: 50});

		expect(call.args).toEqual({
			programId: "claude-session",
			sessionId: "c-1",
			cwd: "/Users/founder/code/phoenix",
			before: "m-9",
			limit: 50,
		});
	});

	it("mints a fresh id per call, so two reads of one session are two answers", () => {
		expect(sessionTranscriptCall(READ).id).not.toBe(sessionTranscriptCall(READ).id);
	});
});

describe("reading a reply", () => {
	it("ignores a reply that answers another call", () => {
		const call = sessionTranscriptCall(READ);
		expect(readSessionTranscript(call, ok("someone-else", page(["a"], null)))).toBeNull();
	});

	it("reads a well-formed page as the page it is", () => {
		const call = sessionTranscriptCall(READ);
		const landing = readSessionTranscript(call, ok(call.id, page(["a", "b"], "a")));

		expect(landing).toEqual({_tag: "Paged", page: page(["a", "b"], "a")});
	});

	it("reads the kernel's own refusal as a refusal, keeping its words", () => {
		const call = sessionTranscriptCall(READ);
		const landing = readSessionTranscript(call, refusal(call.id));

		expect(landing).toEqual({_tag: "Refused", failure});
	});

	it("refuses a result the schema cannot read rather than reading it as an empty session", () => {
		const call = sessionTranscriptCall(READ);
		const landing = readSessionTranscript(
			call,
			ok(call.id, {items: [{kind: "nonsense"}], next: null}),
		);

		expect(landing?._tag).toBe("Refused");
		expect(landing?._tag === "Refused" && landing.failure.tag).toBe("tuval/BadSessionTranscript");
	});
});

describe("folding landed pages", () => {
	const first = landedPage(noPages, null, {_tag: "Paged", page: page(["c", "d"], "c")});

	it("says nothing has landed before the first page does", () => {
		expect(pagedAnswer(noPages)).toBeNull();
	});

	it("renders a session that really holds nothing as a landed empty page", () => {
		const empty = landedPage(noPages, null, {_tag: "Paged", page: page([], null)});

		expect(pagedAnswer(empty)).toEqual({
			_tag: "Read",
			page: {items: [], next: null},
			older: {_tag: "Idle"},
		});
	});

	it("puts an older page before the one already held", () => {
		const older = landedPage(first, "c", {_tag: "Paged", page: page(["a", "b"], "a")});

		expect(ids(older)).toEqual(["a", "b", "c", "d"]);
		expect(older.next).toBe("a");
	});

	it("drops an overlapping item rather than repeating one already on screen", () => {
		const older = landedPage(first, "c", {_tag: "Paged", page: page(["a", "b", "c"], null)});

		expect(ids(older)).toEqual(["a", "b", "c", "d"]);
	});

	it("ends the walk when a page reports no cursor", () => {
		const older = landedPage(first, "c", {_tag: "Paged", page: page(["a"], null)});

		expect(pagedAnswer(older)).toEqual({
			_tag: "Read",
			page: {items: [item("a"), item("c"), item("d")], next: null},
			older: {_tag: "Idle"},
		});
	});

	it("keeps the history and the cursor when an older page fails", () => {
		const failed = landedPage(askedOlder(first), "c", {_tag: "Refused", failure});

		expect(ids(failed)).toEqual(["c", "d"]);
		expect(failed.next).toBe("c");
		expect(pagedAnswer(failed)).toEqual({
			_tag: "Read",
			page: {items: [item("c"), item("d")], next: "c"},
			older: {_tag: "Failed", failure},
		});
	});

	it("clears that failure when the same cursor is asked for again and answers", () => {
		const failed = landedPage(askedOlder(first), "c", {_tag: "Refused", failure});
		const retried = landedPage(askedOlder(failed), "c", {
			_tag: "Paged",
			page: page(["a", "b"], null),
		});

		expect(ids(retried)).toEqual(["a", "b", "c", "d"]);
		expect(retried.older).toEqual({_tag: "Idle"});
	});

	it("makes a refused first page the whole view's refusal, never an empty transcript", () => {
		const refused = landedPage(noPages, null, {_tag: "Refused", failure});

		expect(pagedAnswer(refused)).toEqual({_tag: "Refused", failure});
	});
});
