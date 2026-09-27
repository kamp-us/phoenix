/**
 * @vitest-environment jsdom
 *
 * The chat window's running-subagent list over a real background spawn's own frames (#9506), which
 * is what the list was empty for: every fabrika driver spawn goes this way, and the operator saw no
 * row for any of them.
 *
 * The synthetic slots in `@kampus/tuval-ui`'s own `subagent-list.unit.test.tsx` prove what the window
 * draws for a slot. This one starts a frame earlier — the captured `Agent` call, its async-launch
 * `tool_result` and the `task_notification` that ended the worker a minute later
 * (`../history/fixtures/background-subagent-turn.json`) — and folds them through the shipped mapping
 * and core, so what it proves is that there is a row on screen at all. It lives beside Claude's
 * window because the capture is Claude's.
 */

import {foldEvent} from "@kampus/tuval-sdk/kernel/ai-agent/core/fold";
import type {
	AiAgentSessionMsg,
	AiAgentSessionState,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {initialState} from "@kampus/tuval-sdk/kernel/ai-agent/core/state";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {testProcess} from "@kampus/tuval-sdk/kernel/shell/window/fixtures";
import {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {type ChatWindowOptions, chatWindow, initialChatView} from "@kampus/tuval-ui/chat";
import {installDomShims} from "@kampus/tuval-ui/testing/dom";
import {render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import {fixtureEventFrames} from "../history/fixtures/events.ts";

installDomShims();

const STARTED_AT = 1_756_000_000_000;

const openWindow = async (state: AiAgentSessionState, options: ChatWindowOptions = {}) => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host = await Effect.runPromise(process.window(WindowId.make("w1"), initialChatView));
	const rendered = render(
		chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined, ...options}).render(
			host,
		) as ReactElement,
	);
	await screen.findByRole("log", {name: "Transcript"});
	return {rendered};
};

const list = () => screen.queryByRole("list", {name: "Running subagents"});

const rowsOf = (): ReadonlyArray<HTMLElement> =>
	Array.from(document.querySelectorAll<HTMLElement>(".tuval-chat-subagent"));

const fieldsOf = (row: HTMLElement): Record<string, string> =>
	Object.fromEntries(
		Array.from(row.querySelectorAll<HTMLElement>("[data-field]")).map((field) => [
			field.dataset.field,
			field.textContent ?? "",
		]),
	);

describe("the window over a captured background spawn", () => {
	/** The session state as of frame `upTo`, folded exactly as the live session folds it. */
	const stateAfter = (upTo: number): AiAgentSessionState => {
		const frames = fixtureEventFrames("background-subagent-turn", {at: STARTED_AT});
		return frames
			.slice(0, upTo)
			.flat()
			.reduce((carried, event) => foldEvent(carried, event, {}), initialState("/repo"));
	};

	it("draws the worker's row while it runs, where it used to draw nothing", async () => {
		const {rendered} = await openWindow(stateAfter(2), {subagentList: true});
		expect(list()).not.toBeNull();
		const rows = rowsOf();
		expect(rows).toHaveLength(1);
		expect(fieldsOf(rows[0] as HTMLElement).type).toBe("Explore");
		rendered.unmount();
	});

	it("takes the row away once the notification ends the worker (Q2)", async () => {
		const {rendered} = await openWindow(stateAfter(3), {subagentList: true});
		expect(list()).toBeNull();
		rendered.unmount();
	});
});
