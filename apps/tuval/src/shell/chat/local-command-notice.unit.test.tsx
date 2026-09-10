/**
 * @vitest-environment jsdom
 *
 * The renderer half of #8211: a slash command's output reads as a session notice, never as a YOU
 * turn showing its own wrapper.
 *
 * The rows come off the real Claude mapper over the captured frames (`claude/history/fixtures`), so
 * this case and the mapper's own move together — a renderer case fed a hand-made item would still
 * pass with the mapping put back the way it was. The import is this file's alone: `boundary.unit.
 * test.ts` forbids a shipped file under `shell/chat/` from reaching a backend, and exempts tests.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {act, fireEvent, render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {toAgentEvents} from "../../claude/history/events.ts";
import {loadFixture} from "../../claude/history/fixtures/load.ts";
import {emptyMapping} from "../../claude/history/map.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {chatWindow} from "./ChatWindow.tsx";
import {userItem, withTranscript} from "./chat.testing.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

const AT = 1_700_000_000_000;

const mapped = (name: Parameters<typeof loadFixture>[0]): ReadonlyArray<TranscriptItem> =>
	toAgentEvents(loadFixture(name) as SDKMessage, emptyMapping, {at: AT}).events.flatMap((event) =>
		event.kind === "item" ? [event.item] : [],
	);

const openWindow = async (items: ReadonlyArray<TranscriptItem>): Promise<void> => {
	const process: TestProcess<AiAgentSessionState, AiAgentSessionMsg> = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(
			ProcessId.make("p1"),
			withTranscript(items),
		),
	);
	const host = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w1"), initialChatView),
	);
	const element = chatWindow({scrollCommitMs: 0, scrollToFn: () => {}}).render(
		host,
	) as ReactElement;
	render(element);
	await screen.findByRole("log", {name: "Transcript"});
};

/** The operator rows on screen: `ChatWindow` tags every item row with the item's own kind. */
const roles = (): ReadonlyArray<string> =>
	[...document.querySelectorAll<HTMLElement>(".tuval-chat-row")]
		.map((row) => row.getAttribute("data-message-role"))
		.filter((role): role is string => role === "user");

describe("a captured local command's output in the transcript", () => {
	it("reads as a session notice, with no operator row and no wrapper markup on screen", async () => {
		await openWindow(mapped("local-command-turn"));

		expect(roles()).toEqual([]);
		expect(screen.getByText("Set model to Fable 5 and saved as your default for new sessions"));
		expect(document.body.textContent).not.toMatch(/local-command-stdout/);
	});

	/**
	 * The control for the case above: `roles()` is what an operator row looks like, so the empty
	 * answer there is this window declining to draw one rather than the query finding nothing.
	 */
	it("still draws the operator's own row for a real prompt", async () => {
		await openWindow([userItem("u1", "read the readme")]);

		expect(roles()).toEqual(["user"]);
	});

	it("keeps the whole output reachable behind the notice's own disclosure", async () => {
		await openWindow(mapped("local-command-lines-turn"));

		const trigger = screen.getByRole("button", {name: /^Shift\+Enter is natively supported/});
		expect(trigger.getAttribute("aria-expanded")).toBe("false");

		await act(async () => {
			fireEvent.click(trigger);
		});

		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		const panel = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
		expect(panel?.textContent).toContain("No configuration needed.");
		expect(panel?.textContent).not.toMatch(/local-command-stdout/);
	});
});
