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

/** The table over a socket that answers nothing: this file judges the Claude entry, never a call. */
const renderers = pageRenderers(() => Effect.never);

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

describe("what the Claude window's chat bar carries", () => {
	// #8190 sent the usage line and the session line to the desk inspector, so the bar is the phase
	// line and nothing else — and it reads identically to the Pi window's, which is the point of the
	// ruling. The cwd is the fact that forced it: a raw absolute path wrapped the bar over three
	// lines at desk width.
	it("is the phase line, and neither of the two lines it used to add", async () => {
		await open(
			claudeSessionState({
				usage: usageOf({model: "claude-sonnet-4-5", cost: 0.0142, input: 1204, output: 340}),
			}),
		);
		expect(screen.queryByRole("group", {name: "Session usage"})).toBeNull();
		expect(screen.queryByRole("group", {name: "Session details"})).toBeNull();
		expect(document.querySelector(".tuval-claude-extras")).toBeNull();
		expect(screen.queryByText("claude-sonnet-4-5")).toBeNull();
		expect(screen.queryByText(CWD)).toBeNull();
		expect(screen.queryByText(`session ${SESSION_ID}`)).toBeNull();
		const bar = document.querySelector<HTMLElement>(".tuval-chat-bar");
		expect(bar).not.toBeNull();
		expect(bar?.querySelectorAll(".tuval-chat-phase")).toHaveLength(1);
		expect((bar as HTMLElement).textContent?.trim()).toBe("Ready.");
	});
});

describe("two windows over one Claude process", () => {
	it("render the same transcript and own one view slot each", async () => {
		const {hosts} = await open(claudeSessionState(), 2);
		const logs = screen.getAllByRole("log", {name: "Transcript"});
		expect(logs).toHaveLength(2);
		for (const log of logs) expect(within(log).getByText(FIRST_PROMPT)).toBeDefined();

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
	// Not an identity check against `ClaudeChatWindow` any more: the page builds its own renderer at
	// the operator's feature flags, so the table holds an equivalent renderer rather than this
	// module's default constant (#8439). What is still checked is that the reference has a seat, that
	// the seat holds a renderer of the kind the reference declares, and its guard.
	it("resolves to a renderer of this kind in the page's table", () => {
		const entry = renderers[CLAUDE_CHAT_WINDOW_REF.ref];
		expect(entry?.renderer.kind).toBe(CLAUDE_CHAT_WINDOW_REF.kind);
		expect(entry?.renderer.kind).toBe(ClaudeChatWindow.kind);
		// Guarded by the session state's own predicate, so a kernel sending an older shape refuses in
		// this window instead of throwing through it (#8157).
		expect(entry?.admits(claudeSessionState())).toBe(true);
		expect(entry?.admits({phase: "idle"})).toBe(false);
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
			{type: "interrupt", at: SENT_AT},
		]);
	});

	it("adds no operable element of its own", async () => {
		const state = claudeSessionState();
		const shared = await mount(chatWindow, state);
		const claude = await mount(claudeChatWindow, state);
		expect(controlsIn(claude.rendered.container)).toEqual(controlsIn(shared.rendered.container));
	});

	it("adds no markup of its own either, now that both lines are the inspector's", async () => {
		const state = claudeSessionState();
		const shared = await mount(chatWindow, state);
		const claude = await mount(claudeChatWindow, state);
		// React mints a fresh `useId` per mount, so the two trees differ in every generated id and in
		// nothing else. Blanking them is what makes "identical markup" a claim about what the binding
		// renders rather than about the order the two were mounted in.
		const withoutIds = (root: HTMLElement) => root.innerHTML.replace(/_r_[0-9a-z]+_/g, "_id_");
		expect(withoutIds(claude.rendered.container)).toEqual(withoutIds(shared.rendered.container));
	});
});
