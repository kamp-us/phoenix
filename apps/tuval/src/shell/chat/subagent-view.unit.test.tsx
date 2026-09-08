/**
 * @vitest-environment jsdom
 *
 * The window's one view slot, swapped in place (#8406, founder ruling Q7).
 *
 * Everything here mounts the whole `ChatWindow`, because the criteria are about what the operator
 * gets: which transcript is on screen, what the navigator says while they are inside a worker, and
 * where the viewport lands when they come back. What the slot itself holds is proven without a DOM
 * in `./view.unit.test.ts`, the row build in `./rows.unit.test.ts`, and the navigator's model in
 * `./subagents.unit.test.ts`.
 */

import {act, fireEvent, render, within} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {SubagentSlot, TranscriptItem} from "../../ai-agent/ports/index.ts";
import {ItemId} from "../../ai-agent/ports/index.ts";
import {subagentSlot} from "../../ai-agent-fixtures/transcripts.ts";
import {NativeSubagents} from "../../codex/subagents.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {type ChatWindowOptions, chatWindow} from "./ChatWindow.tsx";
import {assistantItem, call, userItem, withTranscript} from "./chat.testing.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

/**
 * jsdom lays nothing out, so every element reports `scrollHeight === clientHeight === 0` and the
 * virtualizer clamps every scroll to `scrollHeight - clientHeight` (`@tanstack/virtual-core@3.17.8`,
 * `getMaxScrollOffset`) — without a box, the answer to every scroll is 0 and a scroll assertion
 * proves nothing. On the prototype and before the first render, because a box stubbed after mount
 * is stubbed after the opening layout effect has already resolved against a max scroll of 0
 * (`./chat-window.unit.test.tsx` carries the same shim and the #8174 case behind it).
 */
const SCROLL_BOX = 100_000;
const VIEWPORT = 600;

Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
	configurable: true,
	get(this: HTMLElement): number {
		return this.classList.contains("tuval-chat-transcript") ? SCROLL_BOX : 0;
	},
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
	configurable: true,
	get(this: HTMLElement): number {
		return this.classList.contains("tuval-chat-transcript") ? VIEWPORT : 0;
	},
});

const slots = (...entries: ReadonlyArray<SubagentSlot>): Record<string, SubagentSlot> =>
	Object.fromEntries(entries.map((slot) => [slot.id, slot]));

const under = (head: string) => ({parentId: ItemId.make(head)});

/** What the `reviewer` worker wrote, as its slot carries it: parent-tagged, every kind. */
const reviewerItems: ReadonlyArray<TranscriptItem> = [
	{...userItem("r-in", "review the diff"), ...under("agent")},
	{...assistantItem("r-out", "the fold looks right"), ...under("agent")},
];

const builderItems: ReadonlyArray<TranscriptItem> = [
	{...assistantItem("b-out", "writing the test"), ...under("other")},
];

const reviewer = (status: SubagentSlot["status"] = "running") =>
	subagentSlot("agent", {type: "reviewer", items: reviewerItems, status, lastLine: "wrote 4 rows"});

const builder = () => subagentSlot("other", {type: "builder", items: builderItems});

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

const openProcess = (state: AiAgentSessionState) =>
	Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);

type Process = Awaited<ReturnType<typeof openProcess>>;

/** One window onto an already-open process, so a case can mount two of them. */
const openWindow = async (
	process: Process,
	windowId: string,
	options: ChatWindowOptions = {},
	view: ChatView = initialChatView,
) => {
	const bound = await Effect.runPromise(process.window(WindowId.make(windowId), view));
	const scrolls: Array<number> = [];
	const rendered = render(
		chatWindow({
			scrollCommitMs: 0,
			scrollToFn: (offset) => void scrolls.push(offset),
			subagentList: true,
			...options,
		}).render(bound) as ReactElement,
	);
	// Scoped to this render, because a case that mounts two windows has two of every region.
	await within(rendered.container).findByRole("log", {name: /^Transcript/});
	return {rendered, scrolls, view: () => bound.view()};
};

/** A window over its own process, the shape most cases need. */
const openOne = async (
	state: AiAgentSessionState,
	options: ChatWindowOptions = {},
	view: ChatView = initialChatView,
) => {
	const process = await openProcess(state);
	return {process, ...(await openWindow(process, "w1", options, view))};
};

const dom = (root: ParentNode) => ({
	rowKinds: () =>
		Array.from(root.querySelectorAll<HTMLElement>(".tuval-chat-row")).map(
			(row) => row.dataset.kind ?? "",
		),
	text: () => root.querySelector<HTMLElement>(".tuval-chat-spacer")?.textContent ?? "",
	picks: () => Array.from(root.querySelectorAll<HTMLButtonElement>(".tuval-chat-subagent-pick")),
	current: () =>
		root.querySelector<HTMLElement>('.tuval-chat-subagent-pick[aria-current="true"]')
			?.textContent ?? null,
	end: () => root.querySelector<HTMLElement>(".tuval-chat-subagent-end")?.textContent ?? null,
	list: () => root.querySelector<HTMLElement>(".tuval-chat-subagents"),
});

/** Click the navigator row whose visible text starts with `type`. */
const pick = async (root: ParentNode, label: string) => {
	const button = dom(root)
		.picks()
		.find((candidate) => (candidate.textContent ?? "").startsWith(label));
	expect(button, `no navigator row for "${label}"`).toBeTruthy();
	await act(async () => {
		(button as HTMLButtonElement).click();
	});
};

/** jsdom never moves a scroller, so the offset a scroll event reports is set on the element. */
const scrollTo = async (scroller: HTMLElement, offset: number) => {
	Object.defineProperty(scroller, "scrollTop", {configurable: true, value: offset});
	await act(async () => {
		fireEvent.scroll(scroller);
	});
};

const atOldest = (over: Partial<ChatView> = {}): ChatView => ({
	...initialChatView,
	atOldest: true,
	...over,
});

afterEach(() => {
	vi.useRealTimers();
});

describe("swapping the view slot to a subagent", () => {
	it("swaps the transcript in place, opening no window and minting no picker entry (Q7)", async () => {
		const {rendered, process} = await openOne(agentSession(reviewer(), builder()), {}, atOldest());
		const root = rendered.container;
		expect(dom(root).text()).toContain("the agent's own call");

		await pick(root, "reviewer");

		expect(dom(root).text()).toContain("the fold looks right");
		expect(dom(root).text()).not.toContain("the agent's own call");
		// The swap is a write to this window's own slot and nothing else: no Msg reaches the process,
		// so nothing downstream of it could open a window or mint a picker entry.
		expect(process.inbox()).toEqual([]);
		expect(root.querySelectorAll(".tuval-chat").length).toBe(1);
		rendered.unmount();
	});

	it("keeps the list as the navigator, marking the row that is showing (Q8)", async () => {
		const {rendered} = await openOne(agentSession(reviewer(), builder()), {}, atOldest());
		const root = rendered.container;
		expect(dom(root).current()).toBeNull();

		await pick(root, "reviewer");

		expect(dom(root).list()).not.toBeNull();
		expect(dom(root).current()).toContain("reviewer");
		expect(
			dom(root)
				.picks()
				.map((button) => (button.textContent ?? "").split("·")[0]?.trim()),
		).toEqual(["Back to the agent transcript", "reviewer", "builder"]);

		// Hopping straight to the other worker is one pick, with no stop at main.
		await pick(root, "builder");
		expect(dom(root).current()).toContain("builder");
		expect(dom(root).text()).toContain("writing the test");
		rendered.unmount();
	});

	it("names the region a screen reader lands in after the swap", async () => {
		const {rendered} = await openOne(agentSession(reviewer()), {}, atOldest());
		expect(within(rendered.container).getByRole("log", {name: "Transcript"})).toBeTruthy();

		await pick(rendered.container, "reviewer");

		expect(
			within(rendered.container).getByRole("log", {name: "Transcript: reviewer subagent"}),
		).toBeTruthy();
		rendered.unmount();
	});

	it("reads the worker's rows at depth zero rather than as rows nested under a head", async () => {
		const {rendered} = await openOne(agentSession(reviewer()), {}, atOldest());
		await pick(rendered.container, "reviewer");
		expect(dom(rendered.container).rowKinds()).toEqual(["user", "assistant"]);
		expect(rendered.container.querySelector('[data-nested="true"]')).toBeNull();
		rendered.unmount();
	});
});

describe("the way back to the agent's own transcript", () => {
	it("returns to main and leaves main where it was, offset and all", async () => {
		const {rendered, scrolls} = await openOne(
			agentSession(reviewer()),
			{},
			atOldest({pinned: false, scroll: 640}),
		);
		const root = rendered.container;
		// First paint puts main back on its saved offset, which is the position the back action owes.
		expect(scrolls).toContain(640);

		await pick(root, "reviewer");
		scrolls.length = 0;
		await pick(root, "Back to the agent transcript");

		expect(dom(root).text()).toContain("the agent's own call");
		expect(dom(root).current()).toBeNull();
		expect(scrolls).toContain(640);
		rendered.unmount();
	});

	it("writes the parked position into the slot, so a re-mount restores it too", async () => {
		const {rendered, view} = await openOne(
			agentSession(reviewer()),
			{},
			atOldest({pinned: false, scroll: 640}),
		);
		await pick(rendered.container, "reviewer");

		expect(view().viewing).toEqual({id: "agent", from: {pinned: false, scroll: 640}});
		expect([view().pinned, view().scroll]).toEqual([true, 0]);
		rendered.unmount();
	});

	/**
	 * The offset is committed on a settle timer, so a swap taken inside that window has two ways to
	 * get the park wrong: it can park an offset one debounce behind the reader, and the pending timer
	 * can then land main's offset on the `scroll` field the subagent view now owns (review round 1 on
	 * #8467). Both are closed by settling the offset before the swap, and both are asserted here —
	 * dropping the `settleScroll()` call from `showSubagent` reds each of them.
	 */
	it("settles the pending scroll commit before it parks, and lands nothing on the subagent", async () => {
		vi.useFakeTimers({shouldAdvanceTime: true});
		const {rendered, view} = await openOne(
			agentSession(reviewer()),
			{scrollCommitMs: 150},
			atOldest({pinned: false, scroll: 10}),
		);
		const scroller = rendered.container.querySelector(".tuval-chat-transcript") as HTMLElement;
		// The first event is the window hearing the scroll its own first paint asked for; the second is
		// the reader, which is the one whose offset the settle window is holding.
		await scrollTo(scroller, 10);
		await scrollTo(scroller, 640);
		expect(view().scroll, "still inside the settle window").toBe(10);

		await pick(rendered.container, "reviewer");

		expect(view().viewing).toEqual({id: "agent", from: {pinned: false, scroll: 640}});
		expect(view().scroll).toBe(0);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});

		expect(view().viewing?.from.scroll).toBe(640);
		expect(view().scroll, "main's offset must not land on the subagent's view").toBe(0);
		rendered.unmount();
	});
});

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
		native.item(
			"child",
			{type: "agentMessage", id: "reply", text: "Native child answer"},
			2,
			false,
		);
		const state = () => agentSession(...native.slots.values());
		const {rendered, process} = await openOne(state(), {}, atOldest());
		await pick(rendered.container, "agent");
		expect(dom(rendered.container).text()).toContain("Native child answer");
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

describe("a subagent that finishes while its view is open (Q9)", () => {
	const finish = async (process: Process) => {
		await act(async () => {
			await Effect.runPromise(process.commit(agentSession(reviewer("finished"))));
		});
	};

	it("keeps the view open on its rows, and neither blanks nor snaps to main", async () => {
		const {rendered, process} = await openOne(agentSession(reviewer()), {}, atOldest());
		const root = rendered.container;
		await pick(root, "reviewer");

		await finish(process);

		expect(dom(root).text()).toContain("the fold looks right");
		expect(dom(root).current()).toContain("reviewer");
		expect(
			within(rendered.container).getByRole("log", {name: "Transcript: reviewer subagent"}),
		).toBeTruthy();
		rendered.unmount();
	});

	it("shows the terminal result and the way back", async () => {
		const {rendered, process} = await openOne(agentSession(reviewer()), {}, atOldest());
		const root = rendered.container;
		await pick(root, "reviewer");
		expect(dom(root).end()).toContain("still running");

		await finish(process);

		expect(dom(root).end()).toContain("finished");
		expect(dom(root).end()).toContain("wrote 4 rows");
		expect(dom(root).picks()[0]?.textContent).toBe("Back to the agent transcript");
		rendered.unmount();
	});

	it("drops the row from the running list at that same moment, and marks the one being read", async () => {
		const process = await openProcess(agentSession(reviewer(), builder()));
		const inside = await openWindow(process, "w1", {}, atOldest());
		const onMain = await openWindow(process, "w2", {}, atOldest());
		await pick(inside.rendered.container, "reviewer");

		await finish(process);

		// The window on main sees a two-row list become one: a finished worker left it (Q2).
		expect(
			dom(onMain.rendered.container)
				.picks()
				.map((button) => button.textContent),
		).toEqual([]);
		// …and the window reading it keeps the row, marked and without the elapsed or token readout.
		const held = dom(inside.rendered.container).picks();
		expect(held[1]?.textContent).toContain("finished");
		expect(held[1]?.textContent).not.toContain("elapsed");
		expect(held[1]?.getAttribute("aria-current")).toBe("true");
		inside.rendered.unmount();
		onMain.rendered.unmount();
	});
});

describe("two windows over one process", () => {
	it("sit on two different subagents at once, and closing one does not move the other", async () => {
		const process = await openProcess(agentSession(reviewer(), builder()));
		const first = await openWindow(process, "w1", {}, atOldest());
		const second = await openWindow(process, "w2", {}, atOldest());

		await pick(first.rendered.container, "reviewer");
		await pick(second.rendered.container, "builder");

		expect(dom(first.rendered.container).text()).toContain("the fold looks right");
		expect(dom(second.rendered.container).text()).toContain("writing the test");
		expect(first.view().viewing?.id).toBe("agent");
		expect(second.view().viewing?.id).toBe("other");

		second.rendered.unmount();

		expect(dom(first.rendered.container).current()).toContain("reviewer");
		expect(dom(first.rendered.container).text()).toContain("the fold looks right");
		expect(first.view().viewing?.id).toBe("agent");
		first.rendered.unmount();
	});
});

describe("with the flag off", () => {
	it("draws today's window, whatever the slot says the view is", async () => {
		const {rendered} = await openOne(
			agentSession(reviewer()),
			{subagentList: false},
			atOldest({
				viewing: {id: "agent", from: {pinned: true, scroll: 0}},
				unfolded: ["agent"],
			}),
		);
		const root = rendered.container;

		expect(dom(root).list()).toBeNull();
		expect(dom(root).end()).toBeNull();
		expect(within(rendered.container).getByRole("log", {name: "Transcript"})).toBeTruthy();
		// The agent's own rows are all there, and the subagent's still fold under the spawning call —
		// today's window, exactly as it was before #8405.
		expect(dom(root).text()).toContain("the agent's own call");
		expect(dom(root).text()).toContain("the fold looks right");
		expect(root.querySelectorAll('[data-nested="true"]').length).toBeGreaterThan(0);
		rendered.unmount();
	});
});
