/**
 * The page's reading of a session-list reply. The correlation is the subject: a page holding more
 * than one call open reads every reply that arrives, so "this is not my answer" has to stay
 * distinguishable from "this is my answer and there are no sessions".
 */

import {assert, describe, it} from "vitest";
import {CallId} from "../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellReplyError, SpellReplyOk} from "../protocol/messages.ts";
import {SESSION_LIST_PATH} from "../protocol/session-list.ts";
import {readSessionList, sessionListCall} from "./session-list.ts";

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
	it("addresses the call at the session-list path with an id of its own", () => {
		const call = sessionListCall();

		assert.deepStrictEqual([...call.path], [...SESSION_LIST_PATH]);
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
