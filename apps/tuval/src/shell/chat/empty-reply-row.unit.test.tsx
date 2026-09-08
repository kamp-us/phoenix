/**
 * @vitest-environment jsdom
 *
 * #8216's rendered half: a Pi turn that only called a tool draws that call and no `agent` label
 * over nothing.
 *
 * The rows come from the Pi mapper rather than a hand-written transcript. The defect was a mapped
 * item the window then rendered faithfully, so a fixture composed here would decide the answer it
 * is meant to check. Reaching into a backend is a liberty test files have and source files do not —
 * `boundary.unit.test.ts` holds that import out of every `.ts`/`.tsx` in this directory.
 */

import {render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {emptyProjection, eventsOf} from "../../pi/ai-agent/items.ts";
import type {TranscriptItem as PiTranscriptItem, SessionSnapshot} from "../../pi/wire/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {type ChatWindowHost, chatWindow} from "./ChatWindow.tsx";
import {withTranscript} from "./chat.testing.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

const openWindow = async (state: AiAgentSessionState): Promise<void> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host: ChatWindowHost = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w1"), {...initialChatView, pinned: true}),
	);
	render(chatWindow({scrollToFn: () => {}}).render(host) as ReactElement);
};

const snapshotOf = (transcript: ReadonlyArray<PiTranscriptItem>): SessionSnapshot => ({
	id: "session-8216",
	cwd: "/workspace",
	createdAt: 0,
	updatedAt: 0,
	phase: "idle",
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
	attached: true,
	locked: false,
	revision: 1,
	transcript: [...transcript],
	queuedSteer: [],
	queuedSteerCount: 0,
});

/** The wire transcript as the window would hold it, mapped the one way the live path maps it. */
const rowsOf = (transcript: ReadonlyArray<PiTranscriptItem>): ReadonlyArray<TranscriptItem> =>
	eventsOf(emptyProjection, snapshotOf(transcript)).events.flatMap((event) =>
		event.kind === "item" ? [event.item] : [],
	);

const prompt: PiTranscriptItem = {
	id: "item-0",
	role: "user",
	content: [{type: "text", text: "read the readme"}],
	timestamp: 10,
};

const toolOnlyTurn: PiTranscriptItem = {
	id: "item-1",
	role: "assistant",
	content: [
		{type: "toolCall", toolCallId: "call-1", toolName: "read_file", input: {path: "README.md"}},
	],
	model: {provider: "faux", id: "faux-1"},
	timestamp: 11,
	status: "complete",
	stopReason: "toolUse",
};

const toolResult: PiTranscriptItem = {
	id: "item-2",
	role: "tool",
	toolCallId: "call-1",
	toolName: "read_file",
	input: {path: "README.md"},
	content: [{type: "text", text: "the file"}],
	timestamp: 12,
	status: "complete",
	isError: false,
};

const reply: PiTranscriptItem = {
	...toolOnlyTurn,
	id: "item-3",
	content: [{type: "text", text: "it says hello"}],
	timestamp: 13,
	status: "complete",
	stopReason: "stop",
};

describe("a tool-only turn in the window", () => {
	it("draws the tool row and no agent label above it", async () => {
		await openWindow(withTranscript(rowsOf([prompt, toolOnlyTurn, toolResult])));

		expect(screen.queryAllByText("agent")).toHaveLength(0);
		expect(screen.getByText("tool")).toBeDefined();
		expect(screen.getByText("read the readme")).toBeDefined();
	});

	it("still labels the reply the same turn's model went on to write", async () => {
		await openWindow(withTranscript(rowsOf([prompt, toolOnlyTurn, toolResult, reply])));

		expect(screen.queryAllByText("agent")).toHaveLength(1);
		expect(screen.getByText("it says hello")).toBeDefined();
	});
});
