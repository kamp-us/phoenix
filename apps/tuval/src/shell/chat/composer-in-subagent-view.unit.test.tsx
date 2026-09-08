/**
 * @vitest-environment jsdom
 *
 * The composer while the view slot shows a subagent (#8466, founder ruling 2026-09-08).
 *
 * A subagent has no session of its own to address, so a prompt typed inside its view would land in
 * the transcript the operator is not reading. The founder picked disable over re-word, and these
 * cases are that ruling: the field and the send control are off while a worker is showing, the
 * placeholder says where prompts go and how to get back, and the round trip never touches the draft.
 *
 * The process here is `testProcess` over a plain session fixture — no Claude, no Pi. That is the
 * point of mounting it this way: the window reads its own `viewing` slot, so nothing about the
 * behaviour can depend on which layer owns the parent.
 */

import {act, fireEvent, render, within} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {SubagentSlot, TranscriptItem} from "../../ai-agent/ports/index.ts";
import {ItemId} from "../../ai-agent/ports/index.ts";
import {subagentSlot} from "../../ai-agent-fixtures/transcripts.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {chatWindow} from "./ChatWindow.tsx";
import {assistantItem, call, userItem, withTranscript} from "./chat.testing.ts";
import {subagentViewPlaceholder, tuvalDesignMessages} from "./copy.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

const reviewerItems: ReadonlyArray<TranscriptItem> = [
	{...assistantItem("r-out", "the fold looks right"), parentId: ItemId.make("agent")},
];

const reviewer = (): SubagentSlot =>
	subagentSlot("agent", {type: "reviewer", items: reviewerItems, lastLine: "wrote 4 rows"});

const session = (): AiAgentSessionState =>
	withTranscript([userItem("u1", "go"), call("agent", {name: "Agent"}), ...reviewerItems], {
		subagents: {agent: reviewer()},
	});

const open = async () => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), session()),
	);
	const opened: ChatView = {...initialChatView, atOldest: true};
	const bound = await Effect.runPromise(process.window(WindowId.make("w1"), opened));
	const rendered = render(
		chatWindow({scrollCommitMs: 0, scrollToFn: () => {}, subagentList: true}).render(
			bound,
		) as ReactElement,
	);
	const root = rendered.container;
	await within(root).findByRole("log", {name: /^Transcript/});
	// Re-read on every use: Manti's field owns the element, so a case asserting across a swap would
	// otherwise hold a node React has since replaced.
	const composer = (): HTMLTextAreaElement => {
		const found = root.querySelector<HTMLTextAreaElement>("textarea");
		expect(found, "no composer field").toBeTruthy();
		return found as HTMLTextAreaElement;
	};
	return {
		rendered,
		root,
		process,
		composer,
		send: () => root.querySelector<HTMLButtonElement>("button[type='submit']"),
		view: () => bound.view(),
	};
};

/** Click the navigator row whose visible text starts with `label`. */
const pick = async (root: ParentNode, label: string) => {
	const button = Array.from(
		root.querySelectorAll<HTMLButtonElement>(".tuval-chat-subagent-pick"),
	).find((candidate) => (candidate.textContent ?? "").startsWith(label));
	expect(button, `no navigator row for "${label}"`).toBeTruthy();
	await act(async () => {
		(button as HTMLButtonElement).click();
	});
};

const type = async (composer: HTMLTextAreaElement, text: string) => {
	await act(async () => {
		fireEvent.change(composer, {target: {value: text}});
	});
};

const ordinary = tuvalDesignMessages["admin.agent.compose.placeholder"];

describe("the composer inside a subagent view", () => {
	it("disables the field and the send control, and says where prompts go", async () => {
		const {rendered, root, composer, send} = await open();
		expect(composer().disabled).toBe(false);
		expect(composer().placeholder).toBe(ordinary);
		expect(send()?.disabled).toBe(false);

		await pick(root, "reviewer");

		expect(composer().disabled).toBe(true);
		expect(composer().placeholder).toBe(subagentViewPlaceholder);
		expect(send()?.disabled).toBe(true);
		rendered.unmount();
	});

	it("re-enables on the way back, with the ordinary placeholder", async () => {
		const {rendered, root, composer, send} = await open();
		await pick(root, "reviewer");
		await pick(root, "Back to the agent transcript");

		expect(composer().disabled).toBe(false);
		expect(composer().placeholder).toBe(ordinary);
		expect(send()?.disabled).toBe(false);
		rendered.unmount();
	});

	it("keeps a draft typed before the swap, and holds it in the window's own slot", async () => {
		const {rendered, root, composer, view} = await open();
		await type(composer(), "half a prompt");

		await pick(root, "reviewer");
		expect(composer().value).toBe("half a prompt");

		await pick(root, "Back to the agent transcript");
		expect(composer().value).toBe("half a prompt");
		expect(view().draft).toBe("half a prompt");
		rendered.unmount();
	});

	it("re-enables when Escape in the navigator is the way back", async () => {
		const {rendered, root, composer} = await open();
		await type(composer(), "still here");
		await pick(root, "reviewer");
		expect(composer().disabled).toBe(true);

		const list = root.querySelector<HTMLElement>(".tuval-chat-subagents");
		expect(list).toBeTruthy();
		await act(async () => {
			fireEvent.keyDown(list as HTMLElement, {key: "Escape"});
		});

		expect(composer().disabled).toBe(false);
		expect(composer().value).toBe("still here");
		rendered.unmount();
	});
});
