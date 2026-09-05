/**
 * @vitest-environment jsdom
 *
 * The chat window, rendered against the window contract's own test double (`../window/fixtures.ts`)
 * — the same `WindowHost` the WebSocket transport implements, which is the whole point of the seam
 * being transport-blind. No kernel, no socket, no agent layer appears here.
 *
 * Two jsdom facts shape the assertions. There is no layout, so `installDomShims` gives every
 * element the one 1000×1000 box and `scrollTop` is stubbed per element where a scroll matters; and
 * `Element.scrollTo` does nothing, so the window's scroll seam is substituted with a recorder and
 * the offsets it was asked for are what the scroll assertions read.
 */

import {act, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {Effect, Stream} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {phases} from "../../ai-agent/core/state.ts";
import {ItemId} from "../../ai-agent/ports/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims, TEST_VIEWPORT} from "../ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {type ChatWindowHost, type ChatWindowOptions, chatWindow} from "./ChatWindow.tsx";
import {assistantItem, toolItem, transcriptOf, userItem, withTranscript} from "./chat.testing.ts";
import {phaseLines} from "./phase.ts";
import type {ChatView} from "./view.ts";

installDomShims();

const processId = ProcessId.make("p1");

interface Harness {
	readonly process: TestProcess<AiAgentSessionState, AiAgentSessionMsg>;
	readonly host: ChatWindowHost;
	/** Every offset the window asked the transcript to scroll to, in order. */
	readonly scrolls: ReadonlyArray<number>;
	readonly keys: ReadonlyArray<string>;
}

const openWindow = async (
	state: AiAgentSessionState,
	options: ChatWindowOptions = {},
	initialView?: ChatView,
): Promise<Harness & {readonly view: () => ChatView}> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(processId, state),
	);
	const scrolls: Array<number> = [];
	const keys: Array<string> = [];
	const host = await Effect.runPromise(
		process.window<ChatView>(
			WindowId.make("w1"),
			initialView ?? {scroll: 0, draft: "", cursor: null, atOldest: false, expanded: []},
		),
	);
	const resolved: ChatWindowOptions = {
		newKey: () => {
			const key = `k${keys.length}`;
			keys.push(key);
			return key;
		},
		scrollCommitMs: 0,
		scrollToFn: (offset) => void scrolls.push(offset),
		...options,
	};
	const element = chatWindow(resolved).render(host) as ReactElement;
	render(element);
	giveScrollBox(await screen.findByRole("log", {name: "Transcript"}));
	return {process, host, scrolls, keys, view: () => host.view()};
};

/**
 * jsdom gives every element `scrollHeight === clientHeight === 0`, and the virtualizer clamps every
 * scroll to `scrollHeight - clientHeight` (`virtual-core@3.17.8`, `getMaxScrollOffset`) — so without
 * a box the answer to every `scrollToIndex` is 0 and a scroll assertion proves nothing. This gives
 * the scroller a taller-than-viewport box, which is what a real transcript has.
 */
const SCROLL_BOX = 100_000;

const giveScrollBox = (element: HTMLElement): void => {
	Object.defineProperty(element, "scrollHeight", {configurable: true, value: SCROLL_BOX});
	Object.defineProperty(element, "clientHeight", {
		configurable: true,
		value: TEST_VIEWPORT.height,
	});
};

/** jsdom never moves a scroller, so the offset a scroll event reports is set on the element. */
const scrollTo = async (offset: number): Promise<void> => {
	const scroller = screen.getByRole("log", {name: "Transcript"});
	Object.defineProperty(scroller, "scrollTop", {configurable: true, value: offset});
	await act(async () => {
		fireEvent.scroll(scroller);
	});
};

const composer = (): HTMLTextAreaElement =>
	screen.getByRole("combobox", {name: "Write a message to the agent"}) as HTMLTextAreaElement;

const rows = (): ReadonlyArray<HTMLElement> =>
	Array.from(document.querySelectorAll<HTMLElement>(".tuval-chat-row"));

describe("the transcript", () => {
	it("renders only the rows the viewport can hold, over a thousand-item transcript", async () => {
		const items = transcriptOf(1_000);
		await openWindow(withTranscript(items));
		await waitFor(() => expect(rows().length).toBeGreaterThan(0));
		expect(rows().length).toBeLessThan(64);
		expect(items.length).toBe(1_000);
	});

	it("renders every item kind, with a tool call as one collapsed line", async () => {
		await openWindow(
			withTranscript([
				userItem("a", "do it"),
				assistantItem("b", "done"),
				toolItem("c"),
				{kind: "system", id: ItemId.make("d"), timestamp: 1, text: "resumed"},
			]),
		);
		expect(await screen.findByText("do it")).toBeDefined();
		expect(screen.getByText("done")).toBeDefined();
		expect(screen.getByText("resumed")).toBeDefined();
		// The tool call is its disclosure trigger, and the trigger's own content is its accessible
		// name: the tool and its status, both as words.
		expect(screen.getByRole("button", {name: "read_file ok"})).toBeDefined();
	});

	it("is dark whatever it is mounted inside", async () => {
		await openWindow(withTranscript(transcriptOf(2)));
		const window = document.querySelector(".tuval-chat");
		expect(window?.getAttribute("data-scheme")).toBe("dark");
	});
});

describe("paging", () => {
	const page = {
		items: [userItem("p0", "older prompt"), assistantItem("p1", "older answer")],
		hasMore: true,
	};

	it("asks for one page with the oldest loaded id when the transcript reaches the top", async () => {
		const {process} = await openWindow(withTranscript(transcriptOf(20)), {pageLimit: 25});
		await scrollTo(0);
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({type: "page", before: "i0", limit: 25});
		expect(await screen.findByText("Loading earlier messages…")).toBeDefined();
	});

	it("asks once, not once per scroll event, while the reply is out", async () => {
		const {process} = await openWindow(withTranscript(transcriptOf(20)));
		await scrollTo(0);
		await scrollTo(0);
		await scrollTo(0);
		await waitFor(() => expect(process.inbox().length).toBe(1));
	});

	it("prepends the reply and scrolls back onto the row that was at the top", async () => {
		const {process, scrolls} = await openWindow(withTranscript(transcriptOf(20)));
		await scrollTo(0);
		const before = scrolls.length;
		await act(async () => {
			await Effect.runPromise(process.commit(withTranscript(transcriptOf(20), {lastPage: page})));
		});
		await waitFor(() => expect(scrolls.length).toBeGreaterThan(before));
		// The viewport moved down by the height the prepend added: the row the operator was looking
		// at is still under the top edge rather than two pages of older history below it.
		// Neither pinned at the top on the freshly-prepended old messages, nor thrown to the bottom:
		// the row the operator was looking at is back under the top edge.
		const landed = scrolls[scrolls.length - 1] ?? -1;
		expect(landed).toBeGreaterThan(0);
		expect(landed).toBeLessThan(SCROLL_BOX - TEST_VIEWPORT.height);
		expect(await screen.findByText("older prompt")).toBeDefined();
		expect(screen.queryByText("Loading earlier messages…")).toBeNull();
	});

	it("records the page cursor in its own view slot", async () => {
		const {process, view} = await openWindow(withTranscript(transcriptOf(20)));
		await scrollTo(0);
		await act(async () => {
			await Effect.runPromise(process.commit(withTranscript(transcriptOf(20), {lastPage: page})));
		});
		await waitFor(() => expect(view().cursor).toBe("p0"));
		expect(view().atOldest).toBe(false);
	});

	it("drops the head row once the backend says there is nothing older", async () => {
		const {process, view} = await openWindow(withTranscript(transcriptOf(4)));
		await scrollTo(0);
		await act(async () => {
			await Effect.runPromise(
				process.commit(
					withTranscript(transcriptOf(4), {lastPage: {items: page.items, hasMore: false}}),
				),
			);
		});
		await waitFor(() => expect(view().atOldest).toBe(true));
		expect(screen.queryByRole("button", {name: "Load earlier messages"})).toBeNull();
		expect(screen.queryByText("Loading earlier messages…")).toBeNull();
	});
});

describe("the composer", () => {
	it("sends one prompt with a fresh key and clears the draft", async () => {
		const {process, keys, view} = await openWindow(withTranscript(transcriptOf(2)));
		const input = composer();
		await act(async () => {
			fireEvent.change(input, {target: {value: "ship it"}});
		});
		await waitFor(() => expect(view().draft).toBe("ship it"));
		await act(async () => {
			fireEvent.keyDown(input, {key: "Enter"});
		});
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({type: "prompt", text: "ship it", key: keys[0]});
		await waitFor(() => expect(view().draft).toBe(""));
		expect(input.value).toBe("");
	});

	it("interrupts on Escape while a turn is running, and does nothing otherwise", async () => {
		const {process} = await openWindow(withTranscript(transcriptOf(2), {phase: "ready"}));
		await act(async () => {
			fireEvent.keyDown(composer(), {key: "Escape"});
		});
		expect(process.inbox()).toEqual([]);
		await act(async () => {
			await Effect.runPromise(
				process.commit(withTranscript(transcriptOf(2), {phase: "prompting"})),
			);
		});
		await act(async () => {
			fireEvent.keyDown(composer(), {key: "Escape"});
		});
		await waitFor(() => expect(process.inbox()).toEqual([{type: "interrupt"}]));
	});

	it("restores the draft the window was left with", async () => {
		await openWindow(
			withTranscript(transcriptOf(2)),
			{},
			{
				scroll: 0,
				draft: "half-written",
				cursor: null,
				atOldest: false,
				expanded: [],
			},
		);
		expect(composer().value).toBe("half-written");
	});
});

describe("an interrupted turn", () => {
	const interrupted = withTranscript([userItem("a", "go"), assistantItem("b", "part", 1, true)], {
		interrupted: ItemId.make("b"),
		lastPrompt: "go",
	});

	it("renders the cut turn as interrupted and resends nothing on its own", async () => {
		const {process} = await openWindow(interrupted);
		expect(await screen.findByText("interrupted")).toBeDefined();
		await waitFor(() => expect(screen.getByRole("button", {name: /Resend/})).toBeDefined());
		expect(process.inbox()).toEqual([]);
	});

	it("resends the last prompt exactly once, under a new key", async () => {
		const {process, keys} = await openWindow(interrupted);
		const resend = await screen.findByRole("button", {name: /Resend/});
		await act(async () => {
			fireEvent.click(resend);
		});
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({type: "prompt", text: "go", key: keys[0]});
	});

	it("resends on Alt+R from the composer, and on nothing else", async () => {
		const {process} = await openWindow(interrupted);
		await act(async () => {
			fireEvent.keyDown(composer(), {key: "r"});
		});
		expect(process.inbox()).toEqual([]);
		await act(async () => {
			fireEvent.keyDown(composer(), {key: "r", altKey: true});
		});
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({type: "prompt", text: "go", key: "k0"});
	});
});

describe("the phase line and the contract's two placeholders", () => {
	it("renders a line for every phase the session can be in", async () => {
		const {process} = await openWindow(withTranscript(transcriptOf(2), {phase: "idle"}));
		expect(phases.length).toBe(6);
		for (const phase of phases) {
			await act(async () => {
				await Effect.runPromise(process.commit(withTranscript(transcriptOf(2), {phase})));
			});
			expect(await screen.findByText(phaseLines[phase])).toBeDefined();
		}
	});

	it("renders the empty placeholder before the process has said anything", () => {
		const silent: ChatWindowHost = {
			windowId: WindowId.make("w-empty"),
			processId,
			readProcess: Stream.never,
			dispatch: () => Effect.succeed({_tag: "Delivered"} as const),
			view: () => ({scroll: 0, draft: "", cursor: null, atOldest: false, expanded: []}),
			setView: () => Effect.void,
		};
		render(chatWindow({}).render(silent) as ReactElement);
		expect(screen.getByText("This window has nothing to show yet.")).toBeDefined();
	});

	it("renders the gone placeholder once the process leaves the table", async () => {
		const {process} = await openWindow(withTranscript(transcriptOf(2)));
		await act(async () => {
			await Effect.runPromise(process.stop);
		});
		expect(await screen.findByText(/is gone/)).toBeDefined();
	});
});

describe("two windows over one process", () => {
	interface Pair {
		readonly process: TestProcess<AiAgentSessionState, AiAgentSessionMsg>;
		readonly left: ChatWindowHost;
		readonly right: ChatWindowHost;
		/** Each window's own transcript scroller, boxed so a scroll offset means something. */
		readonly scrollers: readonly [HTMLElement, HTMLElement];
	}

	const openPair = async (
		state: AiAgentSessionState,
		options: ChatWindowOptions = {},
	): Promise<Pair> => {
		const process = await Effect.runPromise(
			testProcess<AiAgentSessionState, AiAgentSessionMsg>(processId, state),
		);
		const initial: ChatView = {scroll: 0, draft: "", cursor: null, atOldest: false, expanded: []};
		const left = await Effect.runPromise(process.window<ChatView>(WindowId.make("left"), initial));
		const right = await Effect.runPromise(
			process.window<ChatView>(WindowId.make("right"), initial),
		);
		const renderer = chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined, ...options});
		render(
			<>
				{renderer.render(left)}
				{renderer.render(right)}
			</>,
		);
		const transcripts = await screen.findAllByRole("log", {name: "Transcript"});
		expect(transcripts.length).toBe(2);
		const [first, second] = transcripts as [HTMLElement, HTMLElement];
		giveScrollBox(first);
		giveScrollBox(second);
		return {process, left, right, scrollers: [first, second]};
	};

	/** jsdom never moves a scroller, so the offset a scroll event reports is set on the element. */
	const scrollWindowTo = async (scroller: HTMLElement, offset: number): Promise<void> => {
		Object.defineProperty(scroller, "scrollTop", {configurable: true, value: offset});
		await act(async () => {
			fireEvent.scroll(scroller);
		});
	};

	const windowBox = (id: string): HTMLElement => {
		const box = document.querySelector<HTMLElement>(`[data-window="${id}"]`);
		if (box === null) throw new Error(`window ${id} is not mounted`);
		return box;
	};

	const page = {
		items: [userItem("p0", "older prompt"), assistantItem("p1", "older answer")],
		hasMore: true,
	};

	it("show the same transcript and keep their own scroll offset and page cursor", async () => {
		const {left, right, scrollers} = await openPair(withTranscript(transcriptOf(20)));
		await scrollWindowTo(scrollers[0], 400);
		await scrollWindowTo(scrollers[1], 900);
		await waitFor(() => expect(left.view().scroll).toBe(400));
		expect(right.view().scroll).toBe(900);
		expect(left.view()).not.toEqual(right.view());
		expect(TEST_VIEWPORT.height).toBe(1_000);
	});

	// `lastPage` is one slot of shared session state, so the reply to the left window's request is
	// visible to the right one too. Without `ChatWindow`'s `loading` guard the right window merges
	// a page it never asked for — it gains history it did not scroll to and its own cursor advances,
	// which is what made #7604's per-window cursor a slot that could not diverge (#7860). Deleting
	// that guard reds this test.
	it("merges the page only into the window that asked for it", async () => {
		const {process, left, right, scrollers} = await openPair(withTranscript(transcriptOf(20)), {
			pageLimit: 25,
		});

		await scrollWindowTo(scrollers[0], 0);
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({type: "page", before: "i0", limit: 25});

		await act(async () => {
			await Effect.runPromise(process.commit(withTranscript(transcriptOf(20), {lastPage: page})));
		});

		await waitFor(() => expect(left.view().cursor).toBe("p0"));
		expect(within(windowBox("left")).getByText("older prompt")).toBeDefined();

		expect(within(windowBox("right")).queryByText("older prompt")).toBeNull();
		expect(within(windowBox("right")).queryByText("older answer")).toBeNull();
		expect(right.view().cursor).toBeNull();
		expect(right.view().atOldest).toBe(false);
	});

	// The seen-marker is set whether or not the page was merged, so the page the right window
	// ignored is not merged later when it does ask: it waits for its own reply.
	it("does not merge the page it ignored when it later asks for one of its own", async () => {
		const {process, left, right, scrollers} = await openPair(withTranscript(transcriptOf(20)));

		await scrollWindowTo(scrollers[0], 0);
		await act(async () => {
			await Effect.runPromise(process.commit(withTranscript(transcriptOf(20), {lastPage: page})));
		});
		await waitFor(() => expect(left.view().cursor).toBe("p0"));

		await scrollWindowTo(scrollers[1], 0);
		await waitFor(() => expect(process.inbox().length).toBe(2));
		expect(within(windowBox("right")).getByText("Loading earlier messages…")).toBeDefined();
		expect(within(windowBox("right")).queryByText("older prompt")).toBeNull();
		expect(right.view().cursor).toBeNull();
	});
});
