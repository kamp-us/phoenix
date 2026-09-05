/**
 * What a `pi-session` checkpoint taken mid-reply comes back as.
 *
 * This is a unit test rather than a stage of the proof beside it because a Pi turn cannot be cut
 * from a test today: a stop taken while one is in flight never returns (#7896), and mid-turn state
 * is unobservable anyway, since a Cmd handler runs inside the actor's serial step so nothing folds
 * until `prompt` resolves (#7852). So the checkpoint is written here, exactly as the store would
 * have held it, and the rule under test is the one the spawner applies to it.
 */

import {assert, describe, it} from "@effect/vitest";
import type {AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {ItemId} from "../../ai-agent/ports/index.ts";
import {restoreSession, resumeMessages} from "../../ai-agent/restore/index.ts";
import {itemOf} from "../ai-agent/items.ts";

const at = 1_760_000_000_000;

/** A Pi wire item, mapped by the Pi row's own projection so the tail is the shape it really holds. */
const assistant = (id: string, text: string) =>
	itemOf({
		id,
		role: "assistant",
		content: [{type: "text", text}],
		model: {provider: "faux", id: "faux-1"},
		timestamp: at,
		status: "complete",
		stopReason: "stop",
	});

const user = (id: string, text: string) =>
	itemOf({id, role: "user", content: [{type: "text", text}], timestamp: at});

const cutMidReply: AiAgentSessionState = {
	phase: "prompting",
	sessionId: "pi-session-under-test",
	connection: 2,
	cwd: "/work",
	transcript: {
		items: [user("item-0", "read the readme"), assistant("item-1", "I was in the middle of")],
		omitted: {items: 0, bytes: 0, reason: "none"},
	},
	interrupted: null,
	usage: {model: "faux/faux-1", inputTokens: 10, outputTokens: 4, cost: 0},
	permissions: {},
	modes: {current: null, available: []},
	lastPrompt: "read the readme",
	lastPage: null,
	failure: null,
};

describe("a pi-session checkpoint written mid-reply", () => {
	it("comes back idle, with the cut turn marked so a window can offer the resend", () => {
		const restored = restoreSession(cutMidReply);
		assert.strictEqual(restored.phase, "idle");
		assert.strictEqual(restored.interrupted, "item-1" as ItemId);
		const cut = restored.transcript.items.at(-1);
		assert.isTrue(
			cut?.kind === "assistant" && cut.interrupted === true,
			"the cut turn came back unmarked, so no window could offer the resend",
		);
	});

	it("is resumed by a reconnect, never by a fresh session", () => {
		assert.deepStrictEqual(resumeMessages(restoreSession(cutMidReply)), [{type: "reconnect"}]);
	});

	it("has nothing to resume once the session is gone", () => {
		const gone = restoreSession({...cutMidReply, phase: "gone"});
		assert.strictEqual(gone.phase, "gone");
		assert.deepStrictEqual(resumeMessages(gone), []);
	});
});
