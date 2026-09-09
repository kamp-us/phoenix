/**
 * @vitest-environment jsdom
 *
 * The turn summary as a control (#8614): one `<button>` whose accessible name is the label, whose
 * `aria-expanded` is the whole of its state, and whose click puts the turn's own key in this
 * window's `unfolded` set — so a window switched away from and back to comes back as it was left.
 *
 * It is deliberately **not** a `Collapsible`. The rows it reveals are virtualized siblings in the
 * transcript, outside any content this control owns, so a primitive wiring `aria-controls` over its
 * own panel would announce a panel while N unrelated rows appeared unannounced (#8027). That is the
 * same shape and the same reason as the group head's fold button (#8057).
 *
 * `chat.css` is read off disk and put in the document because Vitest's default `css: false` makes
 * the window's own `import "./chat.css"` an empty module.
 */

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {beforeAll, describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {ItemId, type TranscriptItem} from "../../ai-agent/ports/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {testProcess} from "../window/fixtures.ts";
import {type WindowHost, WindowId} from "../window/index.ts";
import {chatWindow} from "./ChatWindow.tsx";
import {assistantItem, thinkingItem, toolItem, userItem, withTranscript} from "./chat.testing.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

beforeAll(() => {
	const style = document.createElement("style");
	style.textContent = readFileSync(fileURLToPath(import.meta.resolve("./chat.css")), "utf8");
	document.head.appendChild(style);
});

const AT = 1_756_000_000_000;

/** One settled turn: a thought and a call behind the reply, four point two seconds end to end. */
const TURN: ReadonlyArray<TranscriptItem> = [
	userItem("u", "go", AT),
	thinkingItem("k", "weighing it", AT + 100),
	toolItem("t", "ok", AT + 200),
	assistantItem("a", "done", AT + 4_200),
];

/** The same turn, cut short by the operator — the label says so beside the marker the reply keeps. */
const STOPPED: ReadonlyArray<TranscriptItem> = [
	userItem("u", "go", AT),
	thinkingItem("k", "weighing it", AT + 100),
	assistantItem("a", "half an ans", AT + 2_000, true),
];

type ChatHost = WindowHost<AiAgentSessionState, AiAgentSessionMsg, ChatView>;

const hostOver = async (
	items: ReadonlyArray<TranscriptItem>,
	over: Partial<AiAgentSessionState> = {},
): Promise<ChatHost> => {
	const running = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(
			ProcessId.make("p1"),
			withTranscript(items, over),
		),
	);
	return await Effect.runPromise(running.window<ChatView>(WindowId.make("w1"), initialChatView));
};

const mount = async (host: ChatHost): Promise<{readonly unmount: () => void}> => {
	const element = chatWindow({scrollCommitMs: 0, scrollToFn: () => {}}).render(
		host,
	) as ReactElement;
	const rendered = render(element);
	await screen.findAllByRole("log", {name: "Transcript"});
	return {unmount: rendered.unmount};
};

const summary = (name: string): HTMLElement => screen.getByRole("button", {name});

const click = async (element: HTMLElement): Promise<void> => {
	await act(async () => {
		fireEvent.click(element);
	});
};

describe("the row a settled turn folds behind", () => {
	it("is a button named by its label, and says how long the turn took", async () => {
		const host = await hostOver(TURN);
		const {unmount} = await mount(host);

		const button = summary("Worked for 4.2s");
		expect(button.tagName).toBe("BUTTON");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		// The chevron is decoration: it never reaches the name and never carries the state alone.
		expect(button.querySelector(".tuval-chat-turn-chevron")?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		expect(screen.queryByText("weighing it")).toBeNull();
		unmount();
	});

	it("reveals the rows it stands for, and writes the turn's own key to this window's slot", async () => {
		const host = await hostOver(TURN);
		const {unmount} = await mount(host);

		await click(summary("Worked for 4.2s"));

		expect(summary("Worked for 4.2s").getAttribute("aria-expanded")).toBe("true");
		await waitFor(() => expect(host.view().unfolded).toEqual(["turn:u"]));
		// The prompt's own id is not the key: the two share the one `unfolded` set (#8027).
		expect(host.view().unfolded).not.toContain("u");
		expect(host.view().expanded).toEqual([]);
		unmount();
	});

	it("comes back open on a window remounted onto the same slot", async () => {
		const host = await hostOver(TURN);
		const first = await mount(host);
		await click(summary("Worked for 4.2s"));
		await waitFor(() => expect(host.view().unfolded).toEqual(["turn:u"]));
		first.unmount();

		const again = await mount(host);

		expect(summary("Worked for 4.2s").getAttribute("aria-expanded")).toBe("true");
		again.unmount();
	});

	it("says the operator stopped it, and leaves the marker and Resend where they were", async () => {
		const host = await hostOver(STOPPED, {interrupted: ItemId.make("a"), lastPrompt: "go"});
		const {unmount} = await mount(host);

		expect(summary("You stopped after 2.0s")).toBeDefined();
		expect(screen.getByText("interrupted")).toBeDefined();
		expect(screen.getByRole("button", {name: /^Resend/})).toBeDefined();
		unmount();
	});
});

describe("the law the summary row is judged against", () => {
	const css = (): string => readFileSync(fileURLToPath(import.meta.resolve("./chat.css")), "utf8");

	it("floors the summary at the 36px hit area", () => {
		expect(css()).toMatch(/\.tuval-chat-turn \{[^}]*min-block-size: var\(--tap-min\)/s);
	});

	it("hand-rolls no outline, so the shared focus ring is what paints it", () => {
		const blocks = css()
			.split("}")
			.filter((block) => /tuval-chat-turn/.test(block.split("{")[0] ?? ""));
		expect(blocks.length).toBeGreaterThan(0);
		expect(blocks.filter((block) => /\boutline\s*:/.test(block))).toEqual([]);
	});
});
