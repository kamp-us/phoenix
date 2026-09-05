/**
 * @vitest-environment jsdom
 *
 * The Pi window, rendered against the window contract's own test double
 * (`../../shell/window/fixtures.ts`) — the same `WindowHost` the WebSocket transport implements. No
 * kernel, no socket and no Pi layer appears here, which is what makes this a test of the binding
 * rather than of Pi.
 *
 * jsdom has no layout, so nothing below asserts a painted fact: the scroll seam is substituted and
 * every claim is about what is in the tree and what a reader can name.
 */

import {render, screen, waitFor, within} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {ProcessId} from "../../process/process.ts";
import {type ChatView, initialChatView} from "../../shell/chat/index.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../../shell/window/fixtures.ts";
import {type WindowHost, WindowId} from "../../shell/window/index.ts";
import {piChatWindow} from "./PiChatWindow.tsx";
import {FIRST_PROMPT, piSession, usageOf} from "./pi-window.testing.ts";

installDomShims();

const processId = ProcessId.make("p1");

type PiHost = WindowHost<AiAgentSessionState, AiAgentSessionMsg, ChatView>;

interface Opened {
	readonly process: TestProcess<AiAgentSessionState, AiAgentSessionMsg>;
	readonly hosts: ReadonlyArray<PiHost>;
}

const open = async (state: AiAgentSessionState, windows = 1): Promise<Opened> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(processId, state),
	);
	const renderer = piChatWindow({scrollCommitMs: 0, scrollToFn: () => undefined});
	const hosts: Array<PiHost> = [];
	for (let index = 0; index < windows; index += 1) {
		const host = await Effect.runPromise(
			process.window<ChatView>(WindowId.make(`w${index}`), initialChatView),
		);
		hosts.push(host);
		render(renderer.render(host) as ReactElement);
	}
	await screen.findAllByRole("log", {name: "Transcript"});
	return {process, hosts};
};

const usageLine = (): HTMLElement => screen.getByRole("group", {name: "Session usage"});

describe("the Pi usage line", () => {
	it("renders the model, the cumulative cost and the token counts off the state", async () => {
		await open(
			piSession({usage: usageOf({model: "faux/faux-1", cost: 0.0142, input: 1204, output: 340})}),
		);
		const line = usageLine();
		expect(within(line).getByText("faux/faux-1")).toBeDefined();
		expect(within(line).getByText("$0.0142")).toBeDefined();
		expect(within(line).getByText("1,204 in")).toBeDefined();
		expect(within(line).getByText("340 out")).toBeDefined();
	});

	it("says so rather than blanking before the first usage event names a model", async () => {
		await open(piSession());
		const line = usageLine();
		expect(within(line).getByText("no model yet")).toBeDefined();
		expect(within(line).getByText("$0.00")).toBeDefined();
	});

	it("moves as usage accumulates on the process", async () => {
		const state = piSession({
			usage: usageOf({model: "faux/faux-1", cost: 0.01, input: 100, output: 10}),
		});
		const {process} = await open(state);
		expect(within(usageLine()).getByText("100 in")).toBeDefined();

		await Effect.runPromise(
			process.commit({
				...state,
				usage: usageOf({model: "faux/faux-2", cost: 0.0325, input: 2500, output: 640}),
			}),
		);

		await waitFor(() => {
			const line = usageLine();
			expect(within(line).getByText("faux/faux-2")).toBeDefined();
			expect(within(line).getByText("$0.0325")).toBeDefined();
			expect(within(line).getByText("2,500 in")).toBeDefined();
			expect(within(line).getByText("640 out")).toBeDefined();
		});
	});

	it("is not a live region, because cost moves on every event of a running turn", async () => {
		await open(piSession({phase: "prompting"}));
		expect(usageLine().getAttribute("role")).toBe("group");
		expect(usageLine().getAttribute("aria-live")).toBeNull();
	});
});

describe("what a Pi session does not offer", () => {
	it("renders no permission card and no mode switch", async () => {
		await open(piSession());
		// Pi answers its own permission prompts and advertises an empty mode list, so both controls
		// are absent rather than empty — an empty listbox is a control that lies about being
		// operable, and the shared window drops each to `null` on an empty input
		// (`../../shell/chat/ModeSwitch.tsx`, `PermissionCards.tsx`).
		expect(screen.queryByRole("combobox", {name: "Mode"})).toBeNull();
		expect(document.querySelector(".tuval-chat-mode")).toBeNull();
		expect(document.querySelector(".tuval-chat-permissions")).toBeNull();
	});
});

describe("two windows over one Pi process", () => {
	it("render the same transcript and own one view slot each", async () => {
		const {hosts} = await open(piSession(), 2);
		const logs = screen.getAllByRole("log", {name: "Transcript"});
		expect(logs).toHaveLength(2);
		for (const log of logs) expect(within(log).getByText(FIRST_PROMPT)).toBeDefined();
		expect(screen.getAllByRole("group", {name: "Session usage"})).toHaveLength(2);

		const [left, right] = hosts as readonly [PiHost, PiHost];
		await Effect.runPromise(left.setView({...initialChatView, draft: "only mine"}));
		expect(left.view().draft).toBe("only mine");
		expect(right.view().draft).toBe("");
	});
});

describe("the window's scheme", () => {
	it("is dark by default, whatever it is mounted inside", async () => {
		await open(piSession());
		expect(screen.getByRole("region", {name: "Agent chat"}).getAttribute("data-scheme")).toBe(
			"dark",
		);
	});
});
