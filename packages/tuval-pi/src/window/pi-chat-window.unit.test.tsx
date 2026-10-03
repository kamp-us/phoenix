/**
 * @vitest-environment jsdom
 *
 * The Pi window, rendered against the window contract's own test double
 * (`@kampus/tuval-sdk/kernel/shell/window/fixtures`) — the same `WindowHost` the WebSocket transport implements. No
 * kernel, no socket and no Pi layer appears here, which is what makes this a test of the binding
 * rather than of Pi.
 *
 * jsdom has no layout, so nothing below asserts a painted fact: the scroll seam is substituted and
 * every claim is about what is in the tree and what a reader can name.
 */

import type {
	AiAgentSessionMsg,
	AiAgentSessionState,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {testProcess} from "@kampus/tuval-sdk/kernel/shell/window/fixtures";
import {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {type ChatView, initialChatView} from "@kampus/tuval-ui/chat";
import {installDomShims} from "@kampus/tuval-ui/testing/dom";
import {render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import {piChatWindow} from "./PiChatWindow.tsx";
import {piSession, usageOf} from "./pi-window.testing.ts";

installDomShims();

const open = async (state: AiAgentSessionState): Promise<void> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w0"), initialChatView),
	);
	render(
		piChatWindow({scrollCommitMs: 0, scrollToFn: () => undefined}).render(host) as ReactElement,
	);
	await screen.findByRole("log", {name: "Transcript"});
};

describe("what the Pi window's chat bar carries", () => {
	// #8190 sent the usage line to the desk inspector, so the bar is the phase line and nothing
	// else — and it reads identically to the Claude window's, which is the point of the ruling.
	it("is the phase line, and no usage line of its own", async () => {
		await open(
			piSession({usage: usageOf({model: "faux/faux-1", cost: 0.0142, input: 1204, output: 340})}),
		);
		expect(screen.queryByRole("group", {name: "Session usage"})).toBeNull();
		expect(document.querySelector(".tuval-pi-usage")).toBeNull();
		expect(screen.queryByText("faux/faux-1")).toBeNull();
		expect(screen.queryByText("1,204 in")).toBeNull();
		const bar = document.querySelector<HTMLElement>(".tuval-chat-bar");
		expect(bar).not.toBeNull();
		expect(bar?.querySelectorAll(".tuval-chat-phase")).toHaveLength(1);
		expect((bar as HTMLElement).textContent?.trim()).toBe("Ready.");
	});
});

describe("the options this binding admits", () => {
	// A type claim, held by the typechecker rather than by this run: `@ts-expect-error` itself reds if
	// the parameter ever widens back to the full `ChatWindowOptions`, which is the shape that dropped
	// a caller's `extras` in silence (#7957).
	it("refuses the `extras` the binding owns, and takes every other option", () => {
		// @ts-expect-error `extras` is the binding's slot, not the caller's.
		expect(piChatWindow({extras: () => null})).toBeDefined();
		expect(piChatWindow({subagentList: false, pageLimit: 10, scrollCommitMs: 0})).toBeDefined();
	});
});
