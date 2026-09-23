/**
 * @vitest-environment jsdom
 *
 * Codex's native sub-agent slots in the chat window's existing navigator (#8406's view slot, over
 * Codex's own `NativeSubagents` fold). The navigator and the view slot are proven over synthetic
 * slots in `@kampus/tuval-ui`'s own `subagent-view.unit.test.tsx`; this case drives the slots through
 * Codex's fold, so it lives beside Codex's window.
 */

import type {SubagentSlot, TranscriptItem} from "@kampus/tuval-sdk/ai-agent/ports";
import {ItemId} from "@kampus/tuval-sdk/ai-agent/ports";
import type {
	AiAgentSessionMsg,
	AiAgentSessionState,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {testProcess} from "@kampus/tuval-sdk/kernel/shell/window/fixtures";
import {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {chatWindow, initialChatView} from "@kampus/tuval-ui/chat";
import {assistantItem, call, userItem, withTranscript} from "@kampus/tuval-ui/testing/chat";
import {installDomShims} from "@kampus/tuval-ui/testing/dom";
import {act, render, within} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import {NativeSubagents} from "../subagents.ts";

installDomShims();

/**
 * jsdom lays nothing out, so the virtualizer clamps every scroll to 0 without a box; the same shim
 * `@kampus/tuval-ui`'s `subagent-view.unit.test.tsx` carries, set before the first render.
 */
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
	configurable: true,
	get(this: HTMLElement): number {
		return this.classList.contains("tuval-chat-transcript") ? 100_000 : 0;
	},
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
	configurable: true,
	get(this: HTMLElement): number {
		return this.classList.contains("tuval-chat-transcript") ? 600 : 0;
	},
});

const slots = (...entries: ReadonlyArray<SubagentSlot>): Record<string, SubagentSlot> =>
	Object.fromEntries(entries.map((slot) => [slot.id, slot]));

const under = (head: string) => ({parentId: ItemId.make(head)});

const reviewerItems: ReadonlyArray<TranscriptItem> = [
	{...userItem("r-in", "review the diff"), ...under("agent")},
	{...assistantItem("r-out", "the fold looks right"), ...under("agent")},
];

const builderItems: ReadonlyArray<TranscriptItem> = [
	{...assistantItem("b-out", "writing the test"), ...under("other")},
];

/** The agent's own transcript, with the two spawning calls and one call of the agent's own. */
const agentSession = (...held: ReadonlyArray<SubagentSlot>) =>
	withTranscript(
		[
			userItem("u1", "go"),
			call("agent", {name: "Agent"}),
			call("other", {name: "Agent"}),
			call("own", {name: "Bash", output: "the agent's own call"}),
			...reviewerItems,
			...builderItems,
		],
		{subagents: slots(...held)},
	);

const openOne = async (state: AiAgentSessionState) => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const bound = await Effect.runPromise(process.window(WindowId.make("w1"), initialChatView));
	const rendered = render(
		chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined, subagentList: true}).render(
			bound,
		) as ReactElement,
	);
	await within(rendered.container).findByRole("log", {name: /^Transcript/});
	return {process, rendered};
};

const dom = (root: ParentNode) => ({
	text: () => root.querySelector<HTMLElement>(".tuval-chat-spacer")?.textContent ?? "",
	picks: () => Array.from(root.querySelectorAll<HTMLButtonElement>(".tuval-chat-subagent-pick")),
	current: () =>
		root.querySelector<HTMLElement>('.tuval-chat-subagent-pick[aria-current="true"]')
			?.textContent ?? null,
});

/** Click the navigator row whose visible text starts with `label`. */
const pick = async (root: ParentNode, label: string) => {
	const button = dom(root)
		.picks()
		.find((candidate) => (candidate.textContent ?? "").startsWith(label));
	expect(button, `no navigator row for "${label}"`).toBeTruthy();
	await act(async () => {
		(button as HTMLButtonElement).click();
	});
};

describe("Codex native slots in the existing navigator", () => {
	it("retains a viewed completed child and returns to the parent without a second interface", async () => {
		const native = new NativeSubagents();
		native.collab(
			{
				type: "collabAgentToolCall",
				id: "agent",
				tool: "spawnAgent",
				status: "completed",
				senderThreadId: "parent",
				receiverThreadIds: ["child"],
				prompt: "review",
				agentsStates: {child: {status: "running", message: null}},
			},
			"parent",
			1,
		);
		native.item("child", {type: "agentMessage", id: "reply", text: "Native"}, 2, true);
		const state = () => agentSession(...native.slots.values());
		const {rendered, process} = await openOne(state());
		await pick(rendered.container, "agent");
		expect(dom(rendered.container).text()).toContain("Native");
		native.hydrate("child", {
			type: "agent",
			status: "running",
			turnId: "turn",
			items: [
				{
					kind: "assistant",
					id: ItemId.make("reply"),
					text: "Native child answer",
					timestamp: 3,
					partial: true,
				},
			],
		});
		native.delta("child", "reply", " child");
		await act(async () => {
			await Effect.runPromise(process.commit(state()));
		});
		expect(dom(rendered.container).text()).toContain("Native child answer");
		native.finishCall("agent", "completed", false);
		native.delta("child", "reply", " answer");
		native.collab(
			{
				type: "collabAgentToolCall",
				id: "wait",
				tool: "wait",
				status: "completed",
				senderThreadId: "parent",
				receiverThreadIds: ["child"],
				prompt: null,
				agentsStates: {child: {status: "completed", message: "Done"}},
			},
			"parent",
			3,
		);
		await act(async () => {
			await Effect.runPromise(process.commit(state()));
		});
		expect(dom(rendered.container).text()).toContain("Native child answer");
		expect(dom(rendered.container).current()).toContain("agent");
		await pick(rendered.container, "Back to the agent transcript");
		expect(dom(rendered.container).text()).toContain("the agent's own call");
		expect(dom(rendered.container).text()).not.toContain("Native child answer");
		expect(process.inbox()).toEqual([]);
		rendered.unmount();
	});
});
