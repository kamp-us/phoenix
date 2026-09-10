/**
 * @vitest-environment jsdom
 *
 * #8584's rendered half, re-anchored by #8699: a turn the operator cut before the model wrote
 * anything. The stop has no assistant row to name, so the marker rides the operator's own prompt and
 * is there from the press — the window draws the break and the resend off it like any other cut
 * turn, including on a turn that never draws an assistant row at all.
 *
 * The state is folded by the real machine over events the Pi mapper produced, rather than written
 * by hand: the defect was the window and the core disagreeing about which row was cut, so a
 * hand-built state would decide the very thing under test. Reaching into a backend is a liberty
 * test files have and source files do not — `boundary.unit.test.ts` holds that import out of every
 * `.ts`/`.tsx` in this directory.
 */

import {applyCellChecked} from "@demlik/tea";
import {fireEvent, render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {
	AiAgentSessionCmd,
	AiAgentSessionMsg,
	AiAgentSessionState,
} from "../../ai-agent/core/index.ts";
import {aiAgentSessionMachine} from "../../ai-agent/core/machine.ts";
import {emptyProjection, eventsOf} from "../../pi/ai-agent/items.ts";
import type {TranscriptItem as PiTranscriptItem, SessionSnapshot} from "../../pi/wire/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {type ChatWindowHost, chatWindow} from "./ChatWindow.tsx";
import {sessionState} from "./chat.testing.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

const SESSION = "session-8584";
const SENT_AT = 1_756_000_000_000;

const machine = aiAgentSessionMachine({cwd: "/workspace"});

const apply = (state: AiAgentSessionState, msg: AiAgentSessionMsg): AiAgentSessionState =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(
		machine,
		state,
		msg,
	)[0];

const snapshotOf = (
	transcript: ReadonlyArray<PiTranscriptItem>,
	phase: SessionSnapshot["phase"],
	revision: number,
): SessionSnapshot => ({
	id: SESSION,
	cwd: "/workspace",
	createdAt: 0,
	updatedAt: 0,
	phase,
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
	attached: true,
	locked: false,
	revision,
	transcript: [...transcript],
	queuedSteer: [],
	queuedSteerCount: 0,
});

/** The wire snapshot as Msgs, in the order the live path delivers them. */
const pushed = (
	state: AiAgentSessionState,
	transcript: ReadonlyArray<PiTranscriptItem>,
	phase: SessionSnapshot["phase"],
	revision: number,
): AiAgentSessionState =>
	eventsOf(emptyProjection, snapshotOf(transcript, phase, revision)).events.reduce(
		(carried, event) => apply(carried, {type: "event", sessionId: SESSION, event}),
		state,
	);

const prompt: PiTranscriptItem = {
	id: "item-0",
	role: "user",
	content: [{type: "text", text: "rewrite the README"}],
	timestamp: 10,
};

/** The cut turn as Pi reports it: aborted, and with not one token of text on it. */
const abortedTextlessTurn: PiTranscriptItem = {
	id: "item-1",
	role: "assistant",
	content: [],
	model: {provider: "faux", id: "faux-1"},
	timestamp: 11,
	status: "aborted",
	stopReason: "aborted",
};

/**
 * The same turn as Pi reports it when its content was tool calls alone: `complete`, and with not one
 * token of text — which `emptyReply` (`../../pi/ai-agent/items.ts`) suppresses, so the tail holds no
 * assistant row for this turn at all and never will.
 */
const toolOnlyTurn: PiTranscriptItem = {
	id: "item-1",
	role: "assistant",
	content: [{type: "toolCall", toolCallId: "call-0", toolName: "read", input: {path: "README"}}],
	model: {provider: "faux", id: "faux-1"},
	timestamp: 11,
	status: "complete",
	stopReason: "toolUse",
};

/** Prompt sent, Escape pressed, and nothing from the backend yet. */
const atThePress = (): AiAgentSessionState => {
	const sent = apply(sessionState({sessionId: SESSION}), {
		type: "prompt",
		text: "rewrite the README",
		key: "k1",
		timestamp: SENT_AT,
	});
	return apply(sent, {type: "interrupt", at: SENT_AT + 500});
};

/** Prompt sent, Escape pressed, then the backend's report of the turn it stopped. */
const cutBeforeAnyText = (): AiAgentSessionState =>
	pushed(atThePress(), [prompt, abortedTextlessTurn], "idle", 1);

/** The same, for a turn whose only content was a call — so no reply row ever lands. */
const cutWithToolCallsOnly = (): AiAgentSessionState =>
	pushed(atThePress(), [prompt, toolOnlyTurn], "idle", 1);

const openWindow = async (
	state: AiAgentSessionState,
): Promise<TestProcess<AiAgentSessionState, AiAgentSessionMsg>> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host: ChatWindowHost = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w1"), {...initialChatView, pinned: true}),
	);
	render(chatWindow({scrollToFn: () => {}}).render(host) as ReactElement);
	return process;
};

describe("a turn cut before the model wrote anything", () => {
	// #8699: the affordance is the operator's own act rendered back, so it is there on the press and
	// owes nothing to a row the backend may send later — or never.
	it("offers the resend from the press, with nothing yet heard from the backend", async () => {
		await openWindow(atThePress());
		expect(screen.getByText("interrupted")).toBeTruthy();
		expect(screen.getByRole("button", {name: /Resend/})).toBeTruthy();
	});

	it("draws the break and offers the resend", async () => {
		await openWindow(cutBeforeAnyText());
		expect(screen.getByText("interrupted")).toBeTruthy();
		expect(screen.getByRole("button", {name: /Resend/})).toBeTruthy();
	});

	// The turn that drew no reply row at all, and the case #8747's anchor had no answer for: its only
	// content was a call, so `emptyReply` suppresses the assistant row and nothing the backend ever
	// sends will name this turn's reply.
	it("offers the resend on a turn whose content was tool calls alone", async () => {
		const process = await openWindow(cutWithToolCallsOnly());
		expect(screen.getByRole("button", {name: /Resend/})).toBeTruthy();
		fireEvent.click(screen.getByRole("button", {name: /Resend/}));
		expect(process.inbox()).toEqual([
			expect.objectContaining({type: "prompt", text: "rewrite the README"}),
		]);
	});

	it("resends the prompt that turn was answering, not some other one", async () => {
		const process = await openWindow(cutBeforeAnyText());
		fireEvent.click(screen.getByRole("button", {name: /Resend/}));
		expect(process.inbox()).toEqual([
			expect.objectContaining({type: "prompt", text: "rewrite the README"}),
		]);
	});

	// The same aborted row replayed by a snapshot on a session with no stop outstanding. Nothing
	// here is the answer to an operator's request, so a resend would send the newest prompt under a
	// badge pointing at an old row.
	it("draws no break for an aborted row that answers no request of the operator's", async () => {
		await openWindow(
			pushed(sessionState({sessionId: SESSION}), [prompt, abortedTextlessTurn], "idle", 1),
		);
		expect(screen.queryByText("interrupted")).toBeNull();
		expect(screen.queryByRole("button", {name: /Resend/})).toBeNull();
	});
});
