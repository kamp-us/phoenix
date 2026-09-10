/**
 * The page's reading of a session-list reply. The correlation is the subject: a page holding more
 * than one call open reads every reply that arrives, so "this is not my answer" has to stay
 * distinguishable from "this is my answer and there are no sessions".
 */

import {assert, describe, it} from "vitest";
import {CallId} from "../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellReplyError, SpellReplyOk} from "../protocol/messages.ts";
import {
	SESSION_LIST_CALL_PATH,
	SESSION_LIST_DEADLINE_MILLIS,
	SESSION_LIST_PATH,
} from "../protocol/session-list.ts";
import {
	atClock,
	elapsedMillis,
	reading,
	readSessionList,
	sessionListCall,
	settled,
} from "./session-list.ts";

const okReply = (id: CallId, result: unknown) =>
	new SpellReplyOk({type: "spell.reply", version: PROTOCOL_VERSION, id, ok: true, result});

const rows = {
	sessions: [
		{
			sessionId: "s-2",
			lastModified: 2_000,
			programId: "pi-session",
			backend: "pi",
			firstPrompt: "port the loader",
		},
		{sessionId: "s-1", lastModified: 1_000, programId: "claude-session", backend: "claude"},
	],
	unreadable: [{programId: "pi", provenance: "@kampus/tuval/pi@1.0.0 (sha256:pi)", detail: "gone"}],
};

describe("the page's session list", () => {
	it("addresses the call where the registry holds the spell, with an id of its own", () => {
		const call = sessionListCall();

		// The row's own path is `session.list`; the registry keys it under the program id, and a call
		// carrying the bare path reaches no spell at all (#8161).
		assert.deepStrictEqual([...call.path], [...SESSION_LIST_CALL_PATH]);
		assert.deepStrictEqual([...call.path].slice(1), [...SESSION_LIST_PATH]);
		assert.isAbove(call.id.length, 0);
		assert.notStrictEqual(sessionListCall().id, call.id);
	});

	it("reads the rows and the unreadable backends out of its own reply", () => {
		const call = sessionListCall();

		const answer = readSessionList(call, okReply(call.id, rows));

		assert.strictEqual(answer?._tag, "Listed");
		assert.deepStrictEqual(
			answer?._tag === "Listed" ? answer.sessions.map((row) => row.sessionId) : [],
			["s-2", "s-1"],
		);
		assert.deepStrictEqual(
			answer?._tag === "Listed" ? answer.unreadable.map((row) => row.programId) : [],
			["pi"],
		);
		// A backend that supplies no first prompt leaves the key absent, so a row renders an
		// absence rather than an empty string that reads like a real, blank prompt.
		assert.isUndefined(answer?._tag === "Listed" ? answer.sessions[1]?.firstPrompt : "unread");
	});

	it("answers an empty list as this call's answer, not as no answer", () => {
		const call = sessionListCall();

		const answer = readSessionList(call, okReply(call.id, {sessions: [], unreadable: []}));

		assert.strictEqual(answer?._tag, "Listed");
		assert.deepStrictEqual(answer?._tag === "Listed" ? answer.sessions : ["unread"], []);
	});

	it("leaves another call's reply alone", () => {
		const call = sessionListCall();

		assert.isNull(readSessionList(call, okReply(CallId.make("someone-else"), rows)));
	});

	it("carries a refused call through as a refusal the window can render", () => {
		const call = sessionListCall();

		const answer = readSessionList(
			call,
			new SpellReplyError({
				type: "spell.reply",
				version: PROTOCOL_VERSION,
				id: call.id,
				ok: false,
				error: {tag: "tuval/SessionListTimedOut", message: "did not answer within 10000ms"},
			}),
		);

		assert.strictEqual(answer?._tag, "Refused");
		assert.strictEqual(
			answer?._tag === "Refused" ? answer.failure.tag : undefined,
			"tuval/SessionListTimedOut",
		);
	});

	it("refuses a result it cannot read as a session list rather than showing partial rows", () => {
		const call = sessionListCall();

		const answer = readSessionList(call, okReply(call.id, {sessions: [{sessionId: "s-1"}]}));

		assert.strictEqual(answer?._tag, "Refused");
		assert.strictEqual(
			answer?._tag === "Refused" ? answer.failure.tag : undefined,
			"tuval/BadSessionList",
		);
	});
});

describe("where the read has got to", () => {
	const started = 1_000_000;
	const outstanding = reading(started, SESSION_LIST_DEADLINE_MILLIS);

	it("counts elapsed time from when the call left, clamped to its own bound", () => {
		assert.strictEqual(elapsedMillis(outstanding, started + 6_000), 6_000);
		assert.strictEqual(elapsedMillis(outstanding, started - 5), 0);
		assert.strictEqual(
			elapsedMillis(outstanding, started + SESSION_LIST_DEADLINE_MILLIS + 9_000),
			SESSION_LIST_DEADLINE_MILLIS,
		);
	});

	it("stays reading until the deadline, and is timed out from the moment it passes", () => {
		assert.strictEqual(atClock(outstanding, started + 9_999)._tag, "Reading");

		const past = atClock(outstanding, started + SESSION_LIST_DEADLINE_MILLIS);
		assert.strictEqual(past._tag, "TimedOut");
		assert.strictEqual(
			past._tag === "TimedOut" ? past.deadlineMillis : 0,
			SESSION_LIST_DEADLINE_MILLIS,
		);
	});

	it("leaves a landed answer where it is, whatever the clock says", () => {
		const landed = settled({_tag: "Listed", sessions: [], unreadable: []});
		assert.strictEqual(atClock(landed, started + 60_000)._tag, "Listed");
	});

	it("reads the kernel's own timeout tag as the timed-out state, not as a refusal", () => {
		const status = settled({
			_tag: "Refused",
			failure: {tag: "tuval/SessionListTimedOut", message: "did not answer within 10000ms"},
		});

		assert.strictEqual(status._tag, "TimedOut");
	});

	it("leaves every other refusal a refusal, so the kernel's own sentence still reaches a reader", () => {
		const status = settled({
			_tag: "Refused",
			failure: {tag: "tuval/UnknownSpell", message: "no spell is registered there"},
		});

		assert.strictEqual(status._tag, "Refused");
		assert.strictEqual(
			status._tag === "Refused" ? status.failure.message : "",
			"no spell is registered there",
		);
	});
});
