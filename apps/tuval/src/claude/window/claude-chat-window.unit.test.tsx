/**
 * @vitest-environment jsdom
 *
 * The Claude window, rendered against the window contract's own test double
 * (`../../shell/window/fixtures.ts`) — the same `WindowHost` the WebSocket transport implements. No
 * kernel, no subprocess and no Agent SDK appears here, which is what makes this a test of the
 * binding rather than of Claude.
 *
 * jsdom has no layout, so nothing below asserts a painted fact: the scroll seam is substituted and
 * every claim is about what is in the tree and what a reader can name.
 *
 * The sharpest test here is the last one. "This window adds no control of its own" is not provable
 * by looking at the window alone, so it is proved by difference: the same state, the same
 * interactions, driven through the shared `chatWindow` and through `claudeChatWindow`, and the two
 * processes' inboxes compared. A dispatch this binding invented would show up as an inbox the
 * shared window never produced.
 */

import {act, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {pageRenderers} from "../../page/renderers.tsx";
import {ProcessId} from "../../process/process.ts";
import type {ChatWindowOptions, ChatWindowRenderer} from "../../shell/chat/index.ts";
import {type ChatView, chatWindow, initialChatView} from "../../shell/chat/index.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../../shell/window/fixtures.ts";
import {type WindowHost, WindowId} from "../../shell/window/index.ts";
import {CLAUDE_CHAT_WINDOW_REF} from "../renderer-ref.ts";
import {ClaudeChatWindow, claudeChatWindow} from "./ClaudeChatWindow.tsx";
import {
	CWD,
	claudeSessionState,
	FIRST_PROMPT,
	SESSION_ID,
	usageOf,
} from "./claude-window.testing.ts";

installDomShims();

const processId = ProcessId.make("p1");

type ClaudeHost = WindowHost<AiAgentSessionState, AiAgentSessionMsg, ChatView>;

interface Opened {
	readonly process: TestProcess<AiAgentSessionState, AiAgentSessionMsg>;
	readonly hosts: ReadonlyArray<ClaudeHost>;
}

const SENT_AT = 1_700_000_000_000;

/** Deterministic keys, so two windows driven the same way produce byte-identical prompts. */
const countingKeys = () => {
	let next = 0;
	return () => {
		const key = `k${next}`;
		next += 1;
		return key;
	};
};

const open = async (state: AiAgentSessionState, windows = 1): Promise<Opened> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(processId, state),
	);
	const renderer = claudeChatWindow({
		scrollCommitMs: 0,
		scrollToFn: () => undefined,
		newKey: countingKeys(),
		now: () => SENT_AT,
	});
	const hosts: Array<ClaudeHost> = [];
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
const sessionLine = (): HTMLElement => screen.getByRole("group", {name: "Session details"});

describe("the Claude usage line", () => {
	it("renders the model, the cumulative cost and the token counts off the state", async () => {
		await open(
			claudeSessionState({
				usage: usageOf({model: "claude-sonnet-4-5", cost: 0.0142, input: 1204, output: 340}),
			}),
		);
		const line = usageLine();
		expect(within(line).getByText("claude-sonnet-4-5")).toBeDefined();
		expect(within(line).getByText("$0.0142")).toBeDefined();
		expect(within(line).getByText("1,204 in")).toBeDefined();
		expect(within(line).getByText("340 out")).toBeDefined();
	});

	it("says so rather than blanking before the first usage event names a model", async () => {
		await open(claudeSessionState());
		const line = usageLine();
		expect(within(line).getByText("no model yet")).toBeDefined();
		expect(within(line).getByText("$0.00")).toBeDefined();
	});

	it("moves as usage accumulates on the process", async () => {
		const state = claudeSessionState({
			usage: usageOf({model: "claude-sonnet-4-5", cost: 0.01, input: 100, output: 10}),
		});
		const {process} = await open(state);
		expect(within(usageLine()).getByText("100 in")).toBeDefined();

		await Effect.runPromise(
			process.commit({
				...state,
				usage: usageOf({model: "claude-opus-4-1", cost: 0.0325, input: 2500, output: 640}),
			}),
		);

		await waitFor(() => {
			const line = usageLine();
			expect(within(line).getByText("claude-opus-4-1")).toBeDefined();
			expect(within(line).getByText("$0.0325")).toBeDefined();
			expect(within(line).getByText("2,500 in")).toBeDefined();
			expect(within(line).getByText("640 out")).toBeDefined();
		});
	});
});

describe("the Claude session line", () => {
	it("renders the session id and the cwd off the state", async () => {
		await open(claudeSessionState());
		const line = sessionLine();
		expect(within(line).getByText(`session ${SESSION_ID}`)).toBeDefined();
		expect(within(line).getByText(CWD)).toBeDefined();
	});

	it("says so rather than blanking before start has answered with a session id", async () => {
		await open(claudeSessionState({sessionId: null, phase: "starting"}));
		expect(within(sessionLine()).getByText("session no session yet")).toBeDefined();
	});

	it("follows the session id a reconnect replaces", async () => {
		const state = claudeSessionState({sessionId: null, phase: "starting"});
		const {process} = await open(state);
		await Effect.runPromise(process.commit({...state, phase: "ready", sessionId: "second"}));
		await waitFor(() => expect(within(sessionLine()).getByText("session second")).toBeDefined());
	});
});

describe("neither extra line is a live region", () => {
	// Cost and token counts move on every usage event of a running turn, so a live region here
	// would narrate the whole turn to a screen-reader user.
	it("because both change while a turn runs", async () => {
		await open(claudeSessionState({phase: "prompting"}));
		for (const line of [usageLine(), sessionLine()]) {
			expect(line.getAttribute("role")).toBe("group");
			expect(line.getAttribute("aria-live")).toBeNull();
		}
	});
});

describe("two windows over one Claude process", () => {
	it("render the same transcript and own one view slot each", async () => {
		const {hosts} = await open(claudeSessionState(), 2);
		const logs = screen.getAllByRole("log", {name: "Transcript"});
		expect(logs).toHaveLength(2);
		for (const log of logs) expect(within(log).getByText(FIRST_PROMPT)).toBeDefined();
		expect(screen.getAllByRole("group", {name: "Session usage"})).toHaveLength(2);
		expect(screen.getAllByRole("group", {name: "Session details"})).toHaveLength(2);

		const [left, right] = hosts as readonly [ClaudeHost, ClaudeHost];
		await Effect.runPromise(left.setView({...initialChatView, draft: "only mine"}));
		expect(left.view().draft).toBe("only mine");
		expect(right.view().draft).toBe("");
	});
});

describe("the window's scheme", () => {
	it("is dark by default, whatever it is mounted inside", async () => {
		await open(claudeSessionState());
		expect(
			screen.getAllByRole("region", {name: "Agent chat"})[0]?.getAttribute("data-scheme"),
		).toBe("dark");
	});
});

describe("the row's renderer reference", () => {
	it("resolves to this renderer in the page's table", () => {
		expect(pageRenderers[CLAUDE_CHAT_WINDOW_REF.ref]).toBe(ClaudeChatWindow);
	});
});

/**
 * The binding adds no control, card or row: everything operable in the window is the shared one's,
 * and every Msg the window sends is one the shared window would have sent from the same state and
 * the same keystrokes.
 */
describe("what this binding adds to the shared window", () => {
	const composer = (root: HTMLElement): HTMLTextAreaElement =>
		within(root).getByRole("combobox", {
			name: "Write a message to the agent",
		}) as HTMLTextAreaElement;

	/** One window of the given renderer, in its own container, over its own process. */
	const mount = async (
		make: (options: ChatWindowOptions) => ChatWindowRenderer,
		state: AiAgentSessionState,
	) => {
		const process = await Effect.runPromise(
			testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
		);
		const host = await Effect.runPromise(
			process.window<ChatView>(WindowId.make("w1"), initialChatView),
		);
		const renderer = make({
			scrollCommitMs: 0,
			scrollToFn: () => undefined,
			newKey: countingKeys(),
			now: () => SENT_AT,
		});
		const rendered = render(renderer.render(host) as ReactElement);
		await within(rendered.container).findByRole("log", {name: "Transcript"});
		return {process, rendered};
	};

	/** Type a prompt, send it, then cut the turn short — three Msgs across three shared controls. */
	const drive = async (root: HTMLElement) => {
		const input = composer(root);
		await act(async () => {
			fireEvent.change(input, {target: {value: "ship it"}});
		});
		await act(async () => {
			fireEvent.keyDown(input, {key: "Enter"});
		});
		await act(async () => {
			fireEvent.keyDown(input, {key: "Escape"});
		});
	};

	const controlsIn = (root: HTMLElement): ReadonlyArray<string> =>
		Array.from(root.querySelectorAll("button, input, textarea, select, a[href], [tabindex]"))
			.map(
				(element) =>
					`${element.tagName.toLowerCase()}:${element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""}`,
			)
			.sort();

	it("dispatches exactly what the shared window dispatches from the same keystrokes", async () => {
		const state = claudeSessionState({phase: "prompting"});
		const shared = await mount(chatWindow, state);
		const claude = await mount(claudeChatWindow, state);

		await drive(shared.rendered.container);
		await drive(claude.rendered.container);

		await waitFor(() => expect(claude.process.inbox().length).toBeGreaterThan(0));
		expect(claude.process.inbox()).toEqual(shared.process.inbox());
		// The drive is only a real test of "adds nothing" if it actually made the window send.
		expect(shared.process.inbox()).toEqual([
			{type: "prompt", text: "ship it", key: "k0", timestamp: SENT_AT},
			{type: "interrupt"},
		]);
	});

	it("adds no operable element of its own", async () => {
		const state = claudeSessionState();
		const shared = await mount(chatWindow, state);
		const claude = await mount(claudeChatWindow, state);
		expect(controlsIn(claude.rendered.container)).toEqual(controlsIn(shared.rendered.container));
	});

	it("adds only the two lines, and both are plain text", async () => {
		const {rendered} = await mount(claudeChatWindow, claudeSessionState());
		const extras = rendered.container.querySelector<HTMLElement>(".tuval-claude-extras");
		expect(extras).not.toBeNull();
		expect(controlsIn(extras as HTMLElement)).toEqual([]);
	});
});
