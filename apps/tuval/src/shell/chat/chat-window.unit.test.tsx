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
import {type ReactElement, StrictMode} from "react";
import {afterEach, describe, expect, it} from "vitest";
import {
	type AiAgentSessionMsg,
	type AiAgentSessionState,
	foldEvent,
} from "../../ai-agent/core/index.ts";
import {phases} from "../../ai-agent/core/state.ts";
import {ItemId} from "../../ai-agent/ports/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims, TEST_VIEWPORT} from "../ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {type ChatWindowHost, type ChatWindowOptions, chatWindow} from "./ChatWindow.tsx";
import {
	assistantItem,
	call,
	compactionItem,
	thinkingItem,
	toolItem,
	transcriptOf,
	userItem,
	withTranscript,
} from "./chat.testing.ts";
import {phaseLines} from "./phase.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

const processId = ProcessId.make("p1");

interface Harness {
	readonly process: TestProcess<AiAgentSessionState, AiAgentSessionMsg>;
	readonly host: ChatWindowHost;
	/** Every offset the window asked the transcript to scroll to, in order. */
	readonly scrolls: ReadonlyArray<number>;
	/** Every value the window pushed at its own view slot, in order. */
	readonly writes: ReadonlyArray<ChatView>;
	readonly keys: ReadonlyArray<string>;
}

/** The send clock every dispatched prompt in this file wears. */
const SENT_AT = 1_700_000_000_000;

const openWindow = async (
	state: AiAgentSessionState,
	options: ChatWindowOptions = {},
	initialView?: ChatView,
	mount: {readonly strict?: boolean} = {},
): Promise<Harness & {readonly view: () => ChatView}> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(processId, state),
	);
	const scrolls: Array<number> = [];
	const keys: Array<string> = [];
	const bound = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w1"), initialView ?? initialChatView),
	);
	const writes: Array<ChatView> = [];
	const host: ChatWindowHost = {
		...bound,
		setView: (next) =>
			Effect.suspend(() => {
				writes.push(next);
				return bound.setView(next);
			}),
	};
	const resolved: ChatWindowOptions = {
		newKey: () => {
			const key = `k${keys.length}`;
			keys.push(key);
			return key;
		},
		now: () => SENT_AT,
		scrollCommitMs: 0,
		scrollToFn: (offset) => void scrolls.push(offset),
		...options,
	};
	const element = chatWindow(resolved).render(host) as ReactElement;
	render(element, mount.strict === true ? {wrapper: StrictMode} : undefined);
	giveScrollBox(await screen.findByRole("log", {name: "Transcript"}));
	return {process, host, scrolls, writes, keys, view: () => host.view()};
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

/**
 * Past every row there is: the virtualizer's total size is bounded by the rows it holds, so an
 * offset beyond the stubbed box is unambiguously "resting on the newest turn".
 */
const scrollToNewest = (): Promise<void> => scrollTo(SCROLL_BOX);

/** Let a render the virtualizer scheduled off a measurement land before a scroll count is read. */
const settle = async (): Promise<void> => {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
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

describe("following the newest turn", () => {
	it("scrolls to the newest row when a turn lands while the transcript is resting on it", async () => {
		const {process, scrolls, view} = await openWindow(withTranscript(transcriptOf(4)));
		await scrollToNewest();
		await waitFor(() => expect(view().pinned).toBe(true));
		await settle();
		const before = scrolls.length;
		const landedBefore = scrolls[scrolls.length - 1] ?? -1;

		await act(async () => {
			await Effect.runPromise(process.commit(withTranscript(transcriptOf(5))));
		});

		await waitFor(() => expect(scrolls.length).toBeGreaterThan(before));
		// The appended row ends below where the last one did, so following it is never a scroll back
		// up the transcript. Not *strictly* below: the virtualizer clamps every offset to
		// `scrollHeight - clientHeight` (`virtual-core@3.17.8`, `getMaxScrollOffset`), and against
		// this file's stubbed box a tall enough transcript is already sitting on that ceiling.
		expect(scrolls[scrolls.length - 1] ?? -1).toBeGreaterThanOrEqual(landedBefore);
	});

	// The other arm, and the reason the pin is a fact the window keeps rather than a follow that
	// always fires: a reader who scrolled up to read history is not yanked back down by a turn
	// landing behind them. It reds against a follow that ignores the pin.
	it("leaves the offset alone when a turn lands after the reader scrolled up", async () => {
		const {process, scrolls, view} = await openWindow(withTranscript(transcriptOf(20)));
		await scrollTo(400);
		await waitFor(() => expect(view().pinned).toBe(false));
		await settle();
		const before = scrolls.length;

		await act(async () => {
			await Effect.runPromise(process.commit(withTranscript(transcriptOf(21))));
		});

		await settle();
		expect(scrolls.length).toBe(before);
		expect(view().pinned).toBe(false);
	});

	it("re-pins on a send, so the operator sees the turn they just typed", async () => {
		const {view} = await openWindow(withTranscript(transcriptOf(20)));
		await scrollTo(400);
		await waitFor(() => expect(view().pinned).toBe(false));

		const input = composer();
		await act(async () => {
			fireEvent.change(input, {target: {value: "ship it"}});
			fireEvent.keyDown(input, {key: "Enter"});
		});

		await waitFor(() => expect(view().pinned).toBe(true));
	});

	it("writes the view slot on a pin flip and not on every scroll event", async () => {
		const {writes, view} = await openWindow(withTranscript(transcriptOf(20)));
		await scrollTo(400);
		await waitFor(() => expect(view().pinned).toBe(false));
		await settle();

		// Same offset, same pin: three events that change nothing about the slot. A write here is a
		// wholesale `ShellState` rebuild for every subscriber of the desk, once per scroll frame.
		const settled = writes.length;
		await scrollTo(400);
		await scrollTo(400);
		await scrollTo(400);
		await settle();
		expect(writes.length).toBe(settled);

		// …and the flip itself still lands, so the guard above is an identity check and not a mute.
		await scrollToNewest();
		await settle();
		expect(writes.length).toBeGreaterThan(settled);
		expect(view().pinned).toBe(true);
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

	it("stops following the newest turn when it is the top that asked for the page", async () => {
		// A transcript barely taller than its viewport sits inside the top threshold and the bottom
		// one at once, so the geometry alone still reads the top that asks for history as resting on
		// the newest turn. Every row measures a full viewport here, so the overlap is staged from
		// the threshold rather than from the row count; the invariant is the same either way.
		const {process, scrolls, view} = await openWindow(withTranscript(transcriptOf(20)), {
			bottomThreshold: SCROLL_BOX,
		});
		await scrollToNewest();
		await waitFor(() => expect(view().pinned).toBe(true));

		await scrollTo(0);
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(view().pinned).toBe(false);

		const before = scrolls.length;
		await act(async () => {
			await Effect.runPromise(process.commit(withTranscript(transcriptOf(20), {lastPage: page})));
		});
		await waitFor(() => expect(scrolls.length).toBeGreaterThan(before));
		await settle();

		// The re-anchor put the reader back on the row they were reading. Nothing pulled them to the
		// bottom of the history they just asked for.
		expect(scrolls[scrolls.length - 1] ?? -1).toBeLessThan(SCROLL_BOX - TEST_VIEWPORT.height);
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
		expect(process.inbox()[0]).toEqual({
			type: "prompt",
			text: "ship it",
			key: keys[0],
			timestamp: SENT_AT,
		});
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
		await waitFor(() => expect(process.inbox()).toEqual([{type: "interrupt", at: SENT_AT}]));
	});

	// #8007: the session is still `prompting` while the abort is unanswered, and the bar has to say
	// that rather than repeat the working line or, worse, read as a finished turn.
	it("says an outstanding interruption is outstanding", async () => {
		const {process} = await openWindow(withTranscript(transcriptOf(2), {phase: "prompting"}));
		await act(async () => {
			await Effect.runPromise(
				process.commit(
					withTranscript(transcriptOf(2), {
						phase: "prompting",
						interruption: {requestedAt: SENT_AT},
					}),
				),
			);
		});
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Interrupting"));
		expect(screen.getByRole("status").textContent).not.toContain("Ready");
	});

	it("restores the draft the window was left with", async () => {
		await openWindow(
			withTranscript(transcriptOf(2)),
			{},
			{...initialChatView, draft: "half-written"},
		);
		expect(composer().value).toBe("half-written");
	});
});

/**
 * Dispatch is not delivery, so the draft this window cleared is still this window's until the
 * session names an outcome for that send's key (#8005).
 *
 * Every case below drives the outcome in as committed state rather than as a phase or a timing, so
 * nothing here depends on where in a turn a backend answers. The two cases that do care which
 * channel carried the outcome fold the real event through `foldEvent` rather than writing the row
 * by hand, because "the layer took the handoff" and "the backend ran the turn" are two different
 * facts and only the second releases the copy (#8018, #8005).
 */
describe("a send whose outcome is not yet known", () => {
	const sent = async (text: string): Promise<void> => {
		const input = composer();
		await act(async () => {
			fireEvent.change(input, {target: {value: text}});
		});
		await act(async () => {
			fireEvent.keyDown(input, {key: "Enter"});
		});
	};

	const refusal = {
		tag: "tuval/ai-agent/PromptError",
		reason: "refused",
		detail: "the backend said no",
	};

	const withSends = (
		sends: AiAgentSessionState["sends"],
		over: Partial<AiAgentSessionState> = {},
	): AiAgentSessionState => withTranscript(transcriptOf(2), {sends, ...over});

	it("holds the text it cleared out of the composer, under the send's own key", async () => {
		const {keys, view} = await openWindow(withTranscript(transcriptOf(2)));
		await sent("ship it");
		await waitFor(() => expect(view().draft).toBe(""));
		expect(view().outgoing).toEqual([{key: keys[0], text: "ship it"}]);
		// Nothing settled, so nothing is offered back — the send may still be running.
		expect(screen.queryByRole("list", {name: "Unsent messages"})).toBeNull();
	});

	it("lets go of the copy the session says the layer took, and only that one", async () => {
		const {process, keys, view} = await openWindow(withTranscript(transcriptOf(2)));
		await sent("first");
		await sent("second");
		await waitFor(() => expect(view().outgoing.length).toBe(2));

		await act(async () => {
			await Effect.runPromise(process.commit(withSends([{key: keys[0] ?? "", state: "accepted"}])));
		});
		await waitFor(() => expect(view().outgoing).toEqual([{key: keys[1], text: "second"}]));
		expect(screen.queryByRole("list", {name: "Unsent messages"})).toBeNull();
	});

	/**
	 * The path #8005's seventh criterion pins. The layer took the handoff without refusing — both
	 * rows return there (#8018) — and the pin refused a round trip later, with no caller left to
	 * raise to, so the refusal arrives as a `failure` event. The send is still the one in flight,
	 * so the window that minted the key gets its words back.
	 */
	it("offers back a send the backend refused on the event stream after the handoff", async () => {
		const {process, keys, view} = await openWindow(withTranscript(transcriptOf(2)));
		await sent("the long prompt");
		const key = keys[0] ?? "";
		await waitFor(() => expect(view().outgoing).toEqual([{key, text: "the long prompt"}]));

		// A `sent` carrying no failure leaves the row `pending` (`core/machine.unit.test.ts`), so
		// this is the state the refusal folds over.
		const handed = withSends([{key, state: "pending"}]);
		await act(async () => {
			await Effect.runPromise(process.commit(handed));
		});
		expect(screen.queryByRole("list", {name: "Unsent messages"})).toBeNull();

		await act(async () => {
			await Effect.runPromise(
				process.commit(foldEvent(handed, {kind: "failure", failure: refusal}, {})),
			);
		});
		expect(await screen.findByText("This message was not sent.")).toBeDefined();
		expect(view().outgoing).toEqual([{key, text: "the long prompt"}]);
	});

	/**
	 * #8005's eighth criterion, at the window. The core reaches `prompting` on admission, so an
	 * Escape can land while `aiAgent.prompt` is still in flight. The interrupt leaves the send
	 * `pending` (`../../ai-agent/core/machine.unit.test.ts` proves the core does that), the window
	 * therefore keeps holding the copy, and the refusal that arrives afterwards still has words to
	 * offer back.
	 */
	it("keeps the copy when a send is interrupted before the layer answers, and offers it on the refusal", async () => {
		const {process, keys, view} = await openWindow(withTranscript(transcriptOf(2)));
		await sent("the long prompt");
		const key = keys[0] ?? "";
		await waitFor(() => expect(view().outgoing).toEqual([{key, text: "the long prompt"}]));

		// What the core leaves behind: the abort is out but unconfirmed, so the turn is still
		// `prompting` (#8007) and the send is still `pending`.
		const cut = withSends([{key, state: "pending"}], {
			phase: "prompting",
			interrupted: ItemId.make("a1"),
			interruption: {requestedAt: 1_700_000_000_000},
		});
		await act(async () => {
			await Effect.runPromise(process.commit(cut));
		});
		expect(screen.queryByRole("list", {name: "Unsent messages"})).toBeNull();
		expect(view().outgoing).toEqual([{key, text: "the long prompt"}]);

		await act(async () => {
			await Effect.runPromise(
				process.commit({...cut, sends: [{key, state: "refused", failure: refusal}]}),
			);
		});
		expect(await screen.findByText("This message was not sent.")).toBeDefined();
		expect(view().outgoing).toEqual([{key, text: "the long prompt"}]);
	});

	/** The other side of that line: the turn ended, so the text crossed and the copy goes. */
	it("lets go of the copy once the turn the backend ran comes to an end", async () => {
		const {process, keys, view} = await openWindow(withTranscript(transcriptOf(2)));
		await sent("ship it");
		const key = keys[0] ?? "";
		const handed = withSends([{key, state: "pending"}], {phase: "prompting"});
		await act(async () => {
			await Effect.runPromise(
				process.commit(foldEvent(handed, {kind: "phase", phase: "ready"}, {})),
			);
		});
		await waitFor(() => expect(view().outgoing).toEqual([]));
		expect(screen.queryByRole("list", {name: "Unsent messages"})).toBeNull();
	});

	it("offers a refused send back, and puts it in the composer on the operator's word", async () => {
		const {process, keys, view} = await openWindow(withTranscript(transcriptOf(2)));
		await sent("the long prompt");
		await act(async () => {
			await Effect.runPromise(
				process.commit(withSends([{key: keys[0] ?? "", state: "refused", failure: refusal}])),
			);
		});

		expect(await screen.findByText("This message was not sent.")).toBeDefined();
		expect(screen.getByText("the long prompt")).toBeDefined();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", {name: "Restore"}));
		});
		await waitFor(() => expect(view().draft).toBe("the long prompt"));
		expect(composer().value).toBe("the long prompt");
		expect(view().outgoing).toEqual([]);
		// Recovery is the composer and nothing else: the prompt Msg count has not moved.
		expect(process.inbox().length).toBe(1);
	});

	it("says an uncertain send is uncertain, and resends nothing on its own", async () => {
		const {process, keys} = await openWindow(withTranscript(transcriptOf(2)));
		await sent("maybe it went");
		await act(async () => {
			await Effect.runPromise(
				process.commit(withSends([{key: keys[0] ?? "", state: "uncertain", failure: null}])),
			);
		});

		expect(await screen.findByText("This message may not have been sent.")).toBeDefined();
		expect(process.inbox()).toEqual([
			{type: "prompt", text: "maybe it went", key: keys[0], timestamp: SENT_AT},
		]);
	});

	it("recovers above text typed after the send rather than over it", async () => {
		const {process, keys, view} = await openWindow(withTranscript(transcriptOf(2)));
		await sent("the long prompt");
		await act(async () => {
			fireEvent.change(composer(), {target: {value: "something newer"}});
		});
		await waitFor(() => expect(view().draft).toBe("something newer"));

		await act(async () => {
			await Effect.runPromise(
				process.commit(withSends([{key: keys[0] ?? "", state: "refused", failure: refusal}])),
			);
		});
		await act(async () => {
			fireEvent.click(await screen.findByRole("button", {name: "Restore"}));
		});
		await waitFor(() => expect(view().draft).toBe("the long prompt\n\nsomething newer"));
	});

	it("drops a held send the operator discards, without touching the draft", async () => {
		const {process, keys, view} = await openWindow(withTranscript(transcriptOf(2)));
		await sent("never mind");
		await act(async () => {
			await Effect.runPromise(
				process.commit(withSends([{key: keys[0] ?? "", state: "refused", failure: refusal}])),
			);
		});
		await act(async () => {
			fireEvent.click(await screen.findByRole("button", {name: "Discard"}));
		});
		await waitFor(() => expect(view().outgoing).toEqual([]));
		expect(view().draft).toBe("");
		expect(screen.queryByRole("list", {name: "Unsent messages"})).toBeNull();
	});
});

describe("keys typed on the transcript", () => {
	const seen: string[] = [];
	const listener = (event: Event): void => void seen.push((event as KeyboardEvent).key);

	afterEach(() => {
		globalThis.document.removeEventListener("keydown", listener);
		seen.length = 0;
	});

	/** Every keydown the desk's one document listener would have seen (`../ui/Desk.tsx`). */
	const watchDesk = (): ReadonlyArray<string> => {
		globalThis.document.addEventListener("keydown", listener);
		return seen;
	};

	it("keeps a bare character off the desk's listener, and lets the rest through (#7973)", async () => {
		await openWindow(withTranscript(transcriptOf(2)));
		const transcript = screen.getByRole("log", {name: "Transcript"});
		const reached = watchDesk();

		await act(async () => {
			fireEvent.keyDown(transcript, {key: "x"});
			fireEvent.keyDown(transcript, {key: "b", ctrlKey: true});
			fireEvent.keyDown(transcript, {key: "Escape"});
			fireEvent.keyDown(transcript, {key: "r", altKey: true});
		});

		expect(reached).toEqual(["b", "Escape", "r"]);
	});

	it("still interrupts on Escape typed on the transcript", async () => {
		const {process} = await openWindow(withTranscript(transcriptOf(2), {phase: "prompting"}));
		await act(async () => {
			fireEvent.keyDown(screen.getByRole("log", {name: "Transcript"}), {key: "Escape"});
		});
		await waitFor(() => expect(process.inbox()).toEqual([{type: "interrupt", at: SENT_AT}]));
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
		expect(process.inbox()[0]).toEqual({
			type: "prompt",
			text: "go",
			key: keys[0],
			timestamp: SENT_AT,
		});
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
		expect(process.inbox()[0]).toEqual({type: "prompt", text: "go", key: "k0", timestamp: SENT_AT});
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

	it("shows the working tell only while a turn runs, and never as a second live region", async () => {
		const {process} = await openWindow(withTranscript(transcriptOf(2), {phase: "ready"}));
		const working = () => document.querySelector(".tuval-chat-working");
		expect(working()).toBeNull();

		await act(async () => {
			await Effect.runPromise(
				process.commit(withTranscript(transcriptOf(2), {phase: "prompting"})),
			);
		});
		await waitFor(() => expect(working()).not.toBeNull());
		// The phase line is the announced one; a second `status` would narrate the same turn twice.
		expect(working()?.getAttribute("aria-hidden")).toBe("true");
		expect(screen.getAllByRole("status").length).toBe(1);

		await act(async () => {
			await Effect.runPromise(process.commit(withTranscript(transcriptOf(2), {phase: "ready"})));
		});
		await waitFor(() => expect(working()).toBeNull());
	});

	it("renders the empty placeholder before the process has said anything", () => {
		const silent: ChatWindowHost = {
			windowId: WindowId.make("w-empty"),
			processId,
			readProcess: Stream.never,
			dispatch: () => Effect.succeed({_tag: "Delivered"} as const),
			view: () => initialChatView,
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
		const initial: ChatView = initialChatView;
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

	/**
	 * The race #8005 is about: both windows send, the session admits one and refuses the other, and
	 * the refusal must land on the window that earned it. The correlation is the idempotency key —
	 * neither window reads a phase, so the arrival order of the two outcomes changes nothing.
	 */
	it("offers a refused send back in the window that sent it, and clears the other's", async () => {
		const keys: Array<string> = [];
		const {process, left, right} = await openPair(withTranscript(transcriptOf(2)), {
			newKey: () => {
				const key = `k${keys.length}`;
				keys.push(key);
				return key;
			},
		});

		const [leftInput, rightInput] = screen.getAllByRole("combobox", {
			name: "Write a message to the agent",
		}) as [HTMLTextAreaElement, HTMLTextAreaElement];
		for (const [input, text] of [
			[leftInput, "left prompt"],
			[rightInput, "right prompt"],
		] as const) {
			await act(async () => {
				fireEvent.change(input, {target: {value: text}});
			});
			await act(async () => {
				fireEvent.keyDown(input, {key: "Enter"});
			});
		}
		await waitFor(() => expect(right.view().outgoing.length).toBe(1));

		const failure = {
			tag: "tuval/ai-agent/PromptError",
			reason: "no-session",
			detail: "the session is prompting, not ready",
		};
		await act(async () => {
			await Effect.runPromise(
				process.commit(
					withTranscript(transcriptOf(2), {
						sends: [
							{key: "k0", state: "accepted"},
							{key: "k1", state: "refused", failure},
						],
					}),
				),
			);
		});

		await waitFor(() => expect(left.view().outgoing).toEqual([]));
		expect(within(windowBox("left")).queryByText("right prompt")).toBeNull();
		expect(within(windowBox("right")).getByText("right prompt")).toBeDefined();
		expect(right.view().outgoing).toEqual([{key: "k1", text: "right prompt"}]);

		await act(async () => {
			fireEvent.click(within(windowBox("right")).getByRole("button", {name: "Restore"}));
		});
		await waitFor(() => expect(right.view().draft).toBe("right prompt"));
		expect(left.view().draft).toBe("");
	});
});

describe("a group head's fold, as a control assistive tech can read", () => {
	const group = [
		call("agent", {name: "Agent"}),
		call("child-1", {name: "bash", parentId: "agent"}),
		call("child-2", {name: "grep", parentId: "agent"}),
	];

	const foldButton = (): HTMLElement => screen.getByRole("button", {name: /nested calls?$/});

	it("names the rows it reveals and announces the reveal, separately from the call's own panel", async () => {
		await openWindow(withTranscript(group));

		const fold = foldButton();
		expect(fold.textContent).toBe("Show 2 nested calls");
		expect(fold.getAttribute("aria-expanded")).toBe("false");
		// Collapsed, the rows do not exist, so the control names nothing rather than naming ghosts.
		expect(fold.getAttribute("aria-controls")).toBeNull();
		expect(document.getElementById("tuval-row-w1-child-1")).toBeNull();

		await act(async () => {
			fireEvent.click(fold);
		});

		const opened = foldButton();
		expect(opened.textContent).toBe("Hide 2 nested calls");
		expect(opened.getAttribute("aria-expanded")).toBe("true");
		const controls = opened.getAttribute("aria-controls")?.split(" ") ?? [];
		expect(controls).toEqual(["tuval-row-w1-child-1", "tuval-row-w1-child-2"]);
		for (const id of controls) expect(document.getElementById(id)).not.toBeNull();
	});

	it("unpins a following window when a fold opens, the way an opened tool row does (#7994)", async () => {
		const {view} = await openWindow(withTranscript(group));
		await waitFor(() => expect(view().pinned).toBe(true));

		await act(async () => {
			fireEvent.click(foldButton());
		});

		await waitFor(() => expect(view().pinned).toBe(false));
		expect(view().unfolded).toEqual(["agent"]);
	});

	it("leaves the call's own input panel shut, so reading a row does not burst its group open", async () => {
		const harness = await openWindow(withTranscript(group));

		const trigger = screen.getByRole("button", {name: /^Agent/});
		await act(async () => {
			fireEvent.click(trigger);
		});
		expect(harness.view().expanded).toEqual(["agent"]);
		expect(harness.view().unfolded).toEqual([]);
		expect(document.getElementById("tuval-row-w1-child-1")).toBeNull();

		await act(async () => {
			fireEvent.click(foldButton());
		});
		expect(harness.view().unfolded).toEqual(["agent"]);
		expect(harness.view().expanded).toEqual(["agent"]);
	});

	it("gives a folded row that heads its own group a fold of its own", async () => {
		await openWindow(
			withTranscript([
				call("agent", {name: "Agent"}),
				call("inner", {name: "Agent", parentId: "agent"}),
				call("leaf", {name: "bash", parentId: "inner"}),
			]),
			{},
			{...initialChatView, unfolded: ["agent"]},
		);

		const folds = screen.getAllByRole("button", {name: /nested calls?$/});
		expect(folds.map((button) => button.textContent)).toEqual([
			"Hide 1 nested call",
			"Show 1 nested call",
		]);
		expect(document.getElementById("tuval-row-w1-leaf")).toBeNull();

		await act(async () => {
			fireEvent.click(folds[1] as HTMLElement);
		});
		expect(document.getElementById("tuval-row-w1-leaf")).not.toBeNull();
	});
});

describe("the two daily rows", () => {
	const REASONING = ["First, read the ledger.", "", "Then decide which lane is stalled."].join(
		"\n",
	);

	const reasoning = (): HTMLElement =>
		screen.getByRole("button", {name: "First, read the ledger."});

	/** The region a disclosure's trigger names, which is where the disclosed text lands. */
	const panelOf = (trigger: HTMLElement): HTMLElement | null =>
		document.getElementById(trigger.getAttribute("aria-controls") ?? "");

	it("shows a thinking row collapsed, named by the first line of the reasoning", async () => {
		await openWindow(withTranscript([userItem("a", "go"), thinkingItem("t", REASONING)]));

		const trigger = reasoning();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(panelOf(trigger)?.hidden).toBe(true);
	});

	it("keeps a long line off the collapsed row, so unfolded reasoning cannot flood it (#8027)", async () => {
		const long = `${"reconciling the ledger against the board ".repeat(6)}done`;
		await openWindow(withTranscript([thinkingItem("t", long)]));

		const trigger = screen.getByRole("button", {name: /^reconciling the ledger/});
		expect(trigger.textContent?.length).toBeLessThan(long.length);
		expect(trigger.textContent?.endsWith("…")).toBe(true);
	});

	it("names the disclosure even when the reasoning is whitespace", async () => {
		await openWindow(withTranscript([thinkingItem("t", "  \n\t\n ")]));
		expect(screen.getByRole("button", {name: "Reasoning"})).toBeDefined();
	});

	it("discloses the whole reasoning inside the row the virtualizer measures", async () => {
		const {scrolls, view} = await openWindow(
			withTranscript([userItem("a", "go"), thinkingItem("t", REASONING)]),
		);
		await settle();
		const before = scrolls.length;

		await act(async () => {
			fireEvent.click(reasoning());
		});
		await settle();

		const trigger = reasoning();
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		const panel = panelOf(trigger);
		expect(panel?.textContent).toBe(REASONING);
		// The virtualizer measures `.tuval-chat-row`, so a panel rendered outside one would grow the
		// transcript without the list ever hearing about it — the row would clip at its estimate.
		expect(panel?.closest(".tuval-chat-row")?.getAttribute("data-kind")).toBe("thinking");
		// And opening anchors that row through the virtualizer, the same path an opened tool row takes.
		expect(scrolls.length).toBeGreaterThan(before);
		expect(view().expanded).toEqual(["t"]);
	});

	it("renders a compaction item as a marker, not as one more line the session said", async () => {
		await openWindow(
			withTranscript([assistantItem("b", "done"), compactionItem("c", "context compacted")]),
		);

		const rule = screen.getByRole("separator");
		const marker = rule.closest(".tuval-chat-row");
		expect(marker?.getAttribute("data-kind")).toBe("compaction");
		// The line is beside the rule and is not a text row: the assistant's turn above is what a
		// text row looks like, and this is the one other shape the transcript draws.
		expect(screen.getByText("context compacted").className).toBe("tuval-chat-compaction-label");
		expect(screen.getByText("done").className).toBe("tuval-chat-text");
		expect(marker?.querySelector(".tuval-chat-text")).toBeNull();
	});
});

/**
 * React documents a state updater as pure and `StrictMode` re-invokes it, so a host write forked
 * from inside one lands twice per commit (#8033). Tuval mounts under `StrictMode` and never deploys
 * (ADR 0345), so that is every commit the desk makes, not a hypothetical.
 */
describe("the view slot's writer, under StrictMode", () => {
	it("forks one host setView per commit on the tool-toggle path", async () => {
		const {writes} = await openWindow(
			withTranscript([userItem("a", "do it"), call("c")]),
			{},
			undefined,
			{strict: true},
		);
		await settle();
		const before = writes.length;

		await act(async () => {
			fireEvent.click(screen.getByRole("button", {name: "read_file ok"}));
		});
		await settle();

		expect(writes.length).toBe(before + 1);
		expect(writes[writes.length - 1]?.expanded).toEqual(["c"]);
	});

	it("forks one host setView per keystroke on the draft path", async () => {
		const {writes, view} = await openWindow(withTranscript(transcriptOf(2)), {}, undefined, {
			strict: true,
		});
		await settle();
		const before = writes.length;

		const input = composer();
		for (const draft of ["s", "sh", "shi"]) {
			await act(async () => {
				fireEvent.change(input, {target: {value: draft}});
			});
		}
		await settle();

		expect(writes.length).toBe(before + 3);
		expect(view().draft).toBe("shi");
	});

	// The other half of "exactly once": a `next` handing back what it was given writes nothing at
	// all, so the doubled write is not traded for an unconditional one.
	it("forks nothing when a commit changes no field", async () => {
		const {writes, view} = await openWindow(withTranscript(transcriptOf(20)), {}, undefined, {
			strict: true,
		});
		await scrollTo(400);
		await waitFor(() => expect(view().pinned).toBe(false));
		await settle();

		const settled = writes.length;
		await scrollTo(400);
		await scrollTo(400);
		await settle();

		expect(writes.length).toBe(settled);
	});

	// Two commits inside one batch: the second composes off what the first wrote, not off the view
	// this render was given. It reds against a ref written from an effect rather than in `commit`.
	it("composes batched commits off the last committed value", async () => {
		const {writes, view} = await openWindow(
			withTranscript([userItem("a", "do it"), call("c"), call("d", {name: "grep"})]),
			{},
			undefined,
			{strict: true},
		);
		await settle();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", {name: "read_file ok"}));
			fireEvent.click(screen.getByRole("button", {name: "grep ok"}));
		});
		await settle();

		expect(view().expanded).toEqual(["c", "d"]);
		expect(writes[writes.length - 1]?.expanded).toEqual(["c", "d"]);
	});
});
