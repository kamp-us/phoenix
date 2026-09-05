/**
 * The checkpoint as data: which fields it is made of, that all of them survive JSON, and what a
 * load does to a session that was mid-reply when the process went away.
 *
 * Pure — no kernel, no layer, no process. The round trip against the layer is `restore.unit.test.ts`
 * beside it, and the whole app twice over one state directory is `restore-proof.unit.test.ts`.
 */

import {describe, expect, it} from "vitest";
import {assistantItem, toolItem, userItem} from "../../ai-agent-fixtures/transcripts.ts";
import {
	type AiAgentSessionState,
	initialState,
	parseSessionState,
	promptItemId,
	restore,
} from "../core/index.ts";
import {Mode, type PermissionRequest} from "../ports/index.ts";
import {checkpointFields, resumeMessages} from "./checkpoint.ts";

/** A field on the state that `checkpointFields` does not name reds here with TS2322. */
const everyFieldNamed: Exclude<
	keyof AiAgentSessionState,
	(typeof checkpointFields)[number]
> extends never
	? true
	: false = true;

const card: PermissionRequest = {
	title: "Write README.md",
	displayName: "write_file",
	description: "Create a file in the working directory",
	input: {path: "README.md", contents: "hello"},
	offersAlways: true,
};

/** A session cut mid-reply: the layer reported `prompting` and never reported the turn's `ready`. */
const saved: AiAgentSessionState = {
	...initialState("/repo"),
	phase: "prompting",
	sessionId: "session-1",
	connection: 2,
	transcript: {
		items: [userItem("i0"), assistantItem("i1"), toolItem("i2")],
		omitted: {items: 3, bytes: 120, reason: "item-limit"},
	},
	usage: {model: "claude-opus-5", inputTokens: 1_200, outputTokens: 340, cost: 0.031},
	permissions: {"req-1": card},
	modes: {current: Mode.make("plan"), available: [Mode.make("plan"), Mode.make("build")]},
	models: {
		current: {provider: "anthropic", id: "claude-opus-5", name: "Opus 5"},
		available: [
			{provider: "anthropic", id: "claude-opus-5", name: "Opus 5"},
			// No provider: a backend that names a model by a bare id, which the predicate admits.
			{id: "haiku", name: "Haiku"},
		],
	},
	lastPrompt: "make the README",
	lastPage: {items: [userItem("older-0")], hasMore: true},
	failure: {tag: "tuval/ai-agent/PromptError", reason: "disconnected", detail: "socket closed"},
};

describe("what a checkpoint carries", () => {
	it("is exactly the named field set, and nothing else", () => {
		expect(everyFieldNamed).toBe(true);
		expect(Object.keys(saved).sort()).toEqual([...checkpointFields].sort());
	});

	it("round-trips through JSON with every field intact", () => {
		const parsed = parseSessionState(JSON.parse(JSON.stringify(saved)));
		expect(parsed).toEqual(saved);
		expect(parsed?.permissions["req-1"]).toEqual(card);
		expect(parsed?.usage).toEqual(saved.usage);
		expect(parsed?.transcript.items).toEqual(saved.transcript.items);
		expect(parsed?.models).toEqual(saved.models);
	});

	it("refuses a saved model list whose rows are not model refs", () => {
		expect(parseSessionState({...saved, models: {current: null, available: [{id: 1}]}})).toBeNull();
		expect(parseSessionState({...saved, models: {current: "opus", available: []}})).toBeNull();
	});

	it("carries nothing a JSON round trip would lose", () => {
		expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
	});
});

describe("restoring a saved session", () => {
	it("comes back holding no transport, with its session id and tail kept", () => {
		const restored = restore(saved);
		expect(restored.phase).toBe("idle");
		expect(restored.sessionId).toBe("session-1");
		expect(restored.cwd).toBe("/repo");
		expect(restored.transcript.omitted).toEqual(saved.transcript.omitted);
		expect(restored.usage).toEqual(saved.usage);
		expect(restored.permissions).toEqual(saved.permissions);
		expect(restored.modes).toEqual(saved.modes);
		expect(restored.models).toEqual(saved.models);
		expect(restored.lastPrompt).toBe("make the README");
	});

	it("marks the assistant turn the restart cut, in state and in the tail", () => {
		const cut: AiAgentSessionState = {
			...saved,
			transcript: {...saved.transcript, items: [userItem("i0"), assistantItem("i1")]},
		};
		const restored = restore(cut);
		expect(restored.interrupted).toBe("i1");
		expect(restored.transcript.items[1]).toEqual({...assistantItem("i1"), interrupted: true});
	});

	it("marks nothing when the cut turn had no assistant item yet", () => {
		const firstTurn: AiAgentSessionState = {
			...saved,
			transcript: {...saved.transcript, items: [userItem("i0")]},
		};
		expect(restore(firstTurn).interrupted).toBeNull();
		expect(restore(firstTurn).transcript.items).toEqual([userItem("i0")]);
	});

	it("marks nothing on a session that was not mid-reply", () => {
		const ready: AiAgentSessionState = {...saved, phase: "ready", interrupted: null};
		expect(restore(ready).interrupted).toBeNull();
		expect(restore(ready).transcript.items).toEqual(saved.transcript.items);
	});

	it("drops the refusal and the page the dead run left behind", () => {
		const restored = restore(saved);
		expect(restored.failure).toBeNull();
		expect(restored.lastPage).toBeNull();
	});

	it("leaves a session the backend already refused gone", () => {
		expect(restore({...saved, phase: "gone"}).phase).toBe("gone");
	});

	it("brings back a send no layer had echoed yet, once and unchanged", () => {
		const unechoed: AiAgentSessionState = {
			...saved,
			transcript: {
				...saved.transcript,
				items: [
					{...userItem(promptItemId("k1"), "make the README"), local: true},
					assistantItem("i1"),
				],
			},
		};
		const restored = restore(unechoed);
		expect(restored.transcript.items[0]).toEqual({
			...userItem(promptItemId("k1"), "make the README"),
			local: true,
		});
		expect(restored.transcript.items).toHaveLength(2);
		// The cut-short marking is the other half of a `prompting` checkpoint and is untouched by it.
		expect(restored.interrupted).toBe("i1");
		expect(restored.transcript.items[1]).toEqual({...assistantItem("i1"), interrupted: true});
	});
});

describe("what a spawner dispatches into a restored process", () => {
	it("reconnects a session that has an id", () => {
		expect(resumeMessages(restore(saved))).toEqual([{type: "reconnect"}]);
	});

	// Written down between the spawn and the first `started`: nothing to reconnect to, and no id a
	// fresh open could duplicate, so it takes the route a fresh spawn takes (#7925).
	it("starts a session that was checkpointed before it was ever opened", () => {
		expect(resumeMessages(initialState("/repo"))).toEqual([
			{type: "start", cwd: "/repo", resume: null},
		]);
	});

	it("dispatches nothing into a session the backend already refused", () => {
		expect(resumeMessages(restore({...saved, phase: "gone"}))).toEqual([]);
	});
});
