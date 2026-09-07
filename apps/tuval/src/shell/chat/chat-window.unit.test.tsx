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
import {Deferred, Effect, Stream} from "effect";
import {type ReactElement, StrictMode} from "react";
import {afterEach, describe, expect, it} from "vitest";
import {
	type AiAgentSessionMsg,
	type AiAgentSessionState,
	foldEvent,
	PAGE_ERROR,
	PROMPT_ERROR,
} from "../../ai-agent/core/index.ts";
import {isAiAgentSessionState} from "../../ai-agent/core/snapshot.ts";
import {phases} from "../../ai-agent/core/state.ts";
import {ItemId} from "../../ai-agent/ports/index.ts";
import {ProcessId} from "../../process/process.ts";
import {
	DISPATCHED_KIND,
	decodeServerFrame,
	encodeFrame,
	PROCESS_STATE_KIND,
} from "../transport/wire.ts";
import {growObservedElement, installDomShims, TEST_VIEWPORT} from "../ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../window/fixtures.ts";
import type {DispatchResult} from "../window/host.ts";
import {PREFIX_ARMED_ATTRIBUTE, WindowId} from "../window/index.ts";
import {type ChatWindowHost, type ChatWindowOptions, chatWindow} from "./ChatWindow.tsx";
import {
	assistantItem,
	call,
	compactionItem,
	systemItem,
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
	readonly answerPage: (
		state: AiAgentSessionState,
		index?: number,
		publish?: boolean,
	) => Promise<void>;
}

/** The send clock every dispatched prompt in this file wears. */
const SENT_AT = 1_700_000_000_000;

/** Dispatch resolves only after the handler outcome, like Processes.dispatchFolded; both channels use the shipped codec. */
const pageCompletions = (process: TestProcess<AiAgentSessionState, AiAgentSessionMsg>) => {
	const pendingPages: Array<Deferred.Deferred<DispatchResult>> = [];
	const bind = (bound: ChatWindowHost): ChatWindowHost => ({
		...bound,
		readProcess: bound.readProcess.pipe(
			Stream.map((view) => {
				const decoded = decodeServerFrame(encodeFrame({kind: PROCESS_STATE_KIND, processId, view}));
				if (decoded._tag !== "Frame" || decoded.frame.kind !== PROCESS_STATE_KIND)
					throw new Error("snapshot codec refused");
				const next = decoded.frame.view;
				if (next._tag === "ProcessGone") return {...next, processId};
				if (!isAiAgentSessionState(next.state)) throw new Error("invalid session snapshot");
				return {...next, state: next.state, processId};
			}),
		),
		dispatch: (msg) =>
			Effect.gen(function* () {
				yield* bound.dispatch(msg);
				if (msg.type !== "page") return {_tag: "Delivered"} as const;
				const completion = yield* Deferred.make<DispatchResult>();
				pendingPages.push(completion);
				return yield* Deferred.await(completion);
			}),
	});
	const answerPage = async (
		next: AiAgentSessionState,
		index = pendingPages.length - 1,
		publish = true,
	): Promise<void> => {
		const completion = pendingPages[index];
		if (completion === undefined) throw new Error("no pending page dispatch");
		if (publish) await Effect.runPromise(process.commit(next));
		const decoded = decodeServerFrame(
			encodeFrame({
				kind: DISPATCHED_KIND,
				seq: index,
				result: {
					_tag: "Delivered",
					view: {revision: index + 1, state: next},
				},
			}),
		);
		if (decoded._tag !== "Frame" || decoded.frame.kind !== DISPATCHED_KIND)
			throw new Error("completion codec refused");
		await Effect.runPromise(Deferred.succeed(completion, decoded.frame.result));
	};
	return {bind, answerPage};
};

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
	const {bind, answerPage} = pageCompletions(process);
	const host: ChatWindowHost = {
		...bind(bound),
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
	await screen.findByRole("log", {name: "Transcript"});

	return {process, host, scrolls, writes, keys, answerPage, view: () => host.view()};
};

/**
 * jsdom gives every element `scrollHeight === clientHeight === 0`, and the virtualizer clamps every
 * scroll to `scrollHeight - clientHeight` (`@tanstack/virtual-core@3.17.8`, `getMaxScrollOffset`) —
 * so without a box the answer to every `scrollToIndex` is 0 and a scroll assertion proves nothing.
 * This gives the transcript's scroller a taller-than-viewport box, which is what a real one has.
 *
 * On the prototype and not on the mounted element, because *when* the box exists decides what the
 * window's opening scroll asks for. A box stubbed after `render` is stubbed after the first layout
 * effect has already resolved `scrollToIndex(last, "end")` against a max scroll of 0 — so the
 * window asks for the top, and the reconcile only re-derives the real target when a later
 * measurement lands. A case that then has to wait out that reconcile is a case whose verdict
 * depends on how fast the machine is, which is how this file went red on CI while passing on every
 * developer machine (#8174). Keyed on the transcript's own class, so every other element keeps
 * jsdom's own 0; a per-element `defineProperty` (`trackContentHeight`) still wins over it.
 */
const SCROLL_BOX = 100_000;

/** The box the next mounted transcript reports. A case that needs another sets it before opening. */
let scrollBox = SCROLL_BOX;

const openScrollBox = (height: number): void => {
	scrollBox = height;
};

const installScrollBox = (): void => {
	const boxed = (element: HTMLElement): boolean =>
		element.classList.contains("tuval-chat-transcript");
	Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
		configurable: true,
		get(this: HTMLElement): number {
			return boxed(this) ? scrollBox : 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get(this: HTMLElement): number {
			return boxed(this) ? TEST_VIEWPORT.height : 0;
		},
	});
};

installScrollBox();

afterEach(() => {
	scrollBox = SCROLL_BOX;
});

/**
 * Let the scroller's `scrollHeight` follow the spacer the virtualizer sizes, the way a real one
 * does. jsdom never lays out, so the fixed box above answers every follow with the same number: `getOffsetForIndex` resolves the LAST row's `end` alignment to the scroller's own max
 * scroll rather than to the row (`@tanstack/virtual-core@3.17.8`, `getOffsetForIndex`), so a row
 * growing cannot move the offset unless the box grows with it.
 */
const trackContentHeight = (): void => {
	const scroller = screen.getByRole("log", {name: "Transcript"});
	Object.defineProperty(scroller, "scrollHeight", {
		configurable: true,
		get: () => {
			const spacer = document.querySelector<HTMLElement>(".tuval-chat-spacer");
			return Number.parseInt(spacer?.style.height ?? "", 10) || SCROLL_BOX;
		},
	});
};

/** jsdom never moves a scroller, so the offset a scroll event reports is set on the element. */
const scrollElementTo = async (scroller: HTMLElement, offset: number): Promise<void> => {
	Object.defineProperty(scroller, "scrollTop", {configurable: true, value: offset});
	await act(async () => {
		fireEvent.scroll(scroller);
	});
};

const transcript = (): HTMLElement => screen.getByRole("log", {name: "Transcript"});

// The window carries more than one `role="status"` — the phase line, and the subagent view slot's
// notice that `features.subagentList` brings with it — so a bare `getByRole("status")` is ambiguous.
const phaseLine = (): HTMLElement => {
	const line = document.querySelector<HTMLElement>(".tuval-chat-phase");
	if (line === null) throw new Error("no phase line");
	return line;
};

const liveRegions = (): number => screen.getAllByRole("status").length;

const scrollTo = (offset: number): Promise<void> => scrollElementTo(transcript(), offset);

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

/** Long enough for `reconcileScroll`'s own `requestAnimationFrame` to run at least twice. */
const RECONCILE_MS = 50;

/**
 * Hold every animation frame until the returned release, so the virtualizer's scroll reconcile
 * cannot re-derive its target while a case is reading the one offset the window asked for
 * (`@tanstack/virtual-core@3.17.8`, `scheduleScrollReconcile`). Nothing else in this window is
 * driven off a frame.
 */
const holdAnimationFrames = (): {readonly release: () => void} => {
	const held = globalThis.requestAnimationFrame;
	globalThis.requestAnimationFrame = (() => 0) as typeof globalThis.requestAnimationFrame;
	return {
		release: () => {
			globalThis.requestAnimationFrame = held;
		},
	};
};

/** Where the scroller's own box says the content ends — `getMaxScrollOffset`'s answer, verbatim. */
const contentEndOf = (scroller: HTMLElement): number =>
	Math.max(0, scroller.scrollHeight - scroller.clientHeight);

const contentEnd = (): number => contentEndOf(transcript());

/**
 * Settle the virtualizer's pending index-scroll, and prove it settled.
 *
 * `scrollToIndex` leaves a live `scrollState` that re-derives its target from every later
 * measurement, once per animation frame, until the scroller's own offset reaches that target
 * (`@tanstack/virtual-core@3.17.8`, `reconcileScroll`). This harness's `scrollToFn` only records, so
 * in a test nothing ever reaches it — and a still-reconciling scroll answers a row growing all by
 * itself, which would make a follow assertion pass with the follow effect gone. Writing the offset
 * the virtualizer asked for onto the scroller is what a browser does, and it is what lets the
 * reconcile stop; after this returns, the follow effect is the only thing left that can scroll.
 *
 * The exit is a fact about the offset and not a quiet stretch of wall clock: the last asked-for
 * offset has to be *where the content ends*, and the reconcile only settles once the scroller's own
 * offset reaches its target. A loop that returned on "no new scroll within 50 ms" instead called a
 * still-pending scroll settled whenever the runner was slow enough to spend that window first,
 * which is how this file went red on CI while passing on every developer machine (#8174).
 */
const landPendingScrollIn = async (
	scroller: HTMLElement,
	scrolls: ReadonlyArray<number>,
): Promise<void> => {
	for (let attempt = 0; attempt < 20; attempt++) {
		const target = scrolls[scrolls.length - 1];
		if (target === undefined) throw new Error("nothing to land: no scroll was ever asked for");
		const asked = scrolls.length;
		await scrollElementTo(scroller, target);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, RECONCILE_MS));
		});
		if (scrolls.length === asked && target === contentEndOf(scroller)) return;
	}
	throw new Error("the virtualizer's pending scroll never reached the content end");
};

const landPendingScroll = (scrolls: ReadonlyArray<number>): Promise<void> =>
	landPendingScrollIn(transcript(), scrolls);

/**
 * The reader arriving at the top, after the window has finished placing itself.
 *
 * The opening `scrollToIndex(last, "end")` resolves to the top while jsdom has not laid the
 * scroller out, and a scroll event carrying the offset the window itself just asked for is the
 * window hearing its own request rather than the reader moving (`ChatWindow.tsx`, `onScroll`) — so
 * a case whose subject is *the reader* reaching the top lands that opening scroll first.
 */
const readerScrollsToTop = async (scrolls: ReadonlyArray<number>): Promise<void> => {
	await landPendingScroll(scrolls);
	await scrollTo(0);
};

const composer = (): HTMLTextAreaElement =>
	screen.getByRole("combobox", {name: "Write a message to the agent"}) as HTMLTextAreaElement;

const rows = (): ReadonlyArray<HTMLElement> =>
	Array.from(document.querySelectorAll<HTMLElement>(".tuval-chat-row"));

/** The deepest row the virtualizer has rendered — the newest turn, whenever it is on screen. */
const newestRenderedRow = (): HTMLElement => {
	const deepest = rows().reduce<HTMLElement | null>(
		(held, row) =>
			held === null || Number(row.dataset.index) > Number(held.dataset.index) ? row : held,
		null,
	);
	if (deepest === null) throw new Error("no rows rendered");
	return deepest;
};

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
		// The window opens resting on the newest turn, so land that opening scroll before scrolling
		// up. Left pending it keeps re-deriving its target from every later measurement, and the turn
		// landing below is a measurement — which is the spurious scroll that made this case red about
		// one run in five (#8106, #8225).
		await landPendingScroll(scrolls);
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

	// The streaming arm: a turn already on screen grows at its bottom instead of a new row landing.
	// The row keeps its key, so nothing about `rows` changes — only the measured height does, which
	// is why the follow effect depends on `totalSize` rather than on the row count alone.
	it("follows the newest row while that row grows, not only when one is appended", async () => {
		const {scrolls, view} = await openWindow(withTranscript(transcriptOf(4)));
		trackContentHeight();
		// The window's opening `scrollToIndex(last, "end")` is still reconciling, and it re-derives
		// its target from every later measurement — so a growth below would be answered by that
		// pending scroll rather than by the follow effect, and this case would pass with `totalSize`
		// dropped from the effect's dependencies. Landing it leaves the follow effect as the only
		// thing that can scroll.
		await landPendingScroll(scrolls);
		// Resting on the newest turn: five rows of a viewport each, less the viewport.
		await waitFor(() => expect(view().pinned).toBe(true));
		await settle();
		const before = scrolls.length;
		const landedBefore = scrolls[scrolls.length - 1] ?? -1;
		const newest = newestRenderedRow();
		// Four items and the leading older-history row the transcript carries while more history
		// exists: the newest turn is row 4, and this guard says the growth below lands on it.
		expect(newest.dataset.index).toBe("4");

		await act(async () => {
			growObservedElement(newest, TEST_VIEWPORT.height * 2);
		});

		// `useFlushSync: false` puts the measurement a render behind the growth, so the follow lands
		// on the task after the `act` above rather than inside it. One `settle` is that task — no
		// wall-clock budget, which is what kept this racing the runner's own 5 s test ceiling.
		await settle();
		expect(scrolls.length).toBeGreaterThan(before);
		// Strictly below where the follow last rested: the last row's `end` alignment resolves to the
		// scroller's own max scroll, and `trackContentHeight` makes that follow the content — so the
		// growth is the only thing that moved it.
		expect(scrolls[scrolls.length - 1] ?? -1).toBeGreaterThan(landedBefore);
	});

	// The pin is the reader's fact, and a scroll the window issued itself is not the reader moving.
	it("keeps the pin when the scroller reports back the offset the window asked for", async () => {
		// A scroller whose box has not caught up with the content it holds: the window asks for its
		// newest row and `getOffsetForAlignment` clamps that ask to the box's own max scroll, which
		// is short of where the rows actually end. The scroll event carrying that offset back is the
		// window hearing its own request — read as the reader walking up the transcript it clears the
		// pin, and in a streaming reply that stops the follow dead, because the follow effect asks
		// once per measurement and every one of those asks is resolved against the size before it
		// (#8174).
		openScrollBox(TEST_VIEWPORT.height * 2);
		const frames = holdAnimationFrames();
		try {
			const {scrolls, view} = await openWindow(withTranscript(transcriptOf(4)));
			const asked = scrolls[scrolls.length - 1];
			if (asked === undefined) throw new Error("the window asked its scroller for nothing");
			expect(asked).toBe(contentEnd());
			// Four rows of a viewport each and one more for the older-history head: the offset the box
			// allowed is thousands of pixels short of the newest turn, so a pin read off it is a lie.
			await scrollTo(asked);
			await settle();
			expect(view().pinned).toBe(true);

			// …and the reader's own scroll to that same offset still unpins, so this is one exempt
			// scroll event and not an offset the window stops reading.
			await scrollTo(asked);
			await waitFor(() => expect(view().pinned).toBe(false));
		} finally {
			frames.release();
		}
	});

	it("leaves the offset alone when the newest row grows after the reader scrolled up", async () => {
		// Restored unpinned at an offset two rows up: far enough from the end to be unpinned, near
		// enough that the newest row is still rendered — the whole point is that a growth the window
		// can see does not move it. Restored rather than scrolled there so the only scroll this
		// window has ever asked for is an offset one, which the virtualizer settles against a fixed
		// target; a pending `scrollToIndex` re-derives its target from every later measurement
		// (`@tanstack/virtual-core@3.17.8`, `reconcileScroll`) and would answer the growth itself.
		const {scrolls, view} = await openWindow(
			withTranscript(transcriptOf(4)),
			{},
			{
				...initialChatView,
				pinned: false,
				scroll: 2_000,
			},
		);
		trackContentHeight();
		await waitFor(() => expect(rows().length).toBeGreaterThan(0));
		await settle();
		const before = scrolls.length;
		const newest = newestRenderedRow();
		// Four items and the leading older-history row the transcript carries while more history
		// exists: the newest turn is row 4, and this guard says the growth below lands on it.
		expect(newest.dataset.index).toBe("4");

		await act(async () => {
			growObservedElement(newest, TEST_VIEWPORT.height * 2);
		});
		await settle();

		expect(scrolls.length).toBe(before);
		expect(view().pinned).toBe(false);
	});
});

describe("paging", () => {
	const page = {
		items: [userItem("p0", "older prompt"), assistantItem("p1", "older answer")],
		hasMore: true,
	};

	it("asks for one page with the oldest loaded id when the transcript reaches the top", async () => {
		const {process, scrolls} = await openWindow(withTranscript(transcriptOf(20)), {pageLimit: 25});
		await readerScrollsToTop(scrolls);
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({type: "page", before: "i0", limit: 25});
		expect(await screen.findByText("Loading earlier messages…")).toBeDefined();
	});

	it("pages with a stored id and reanchors to the older local row, not that cursor", async () => {
		const tail = [{...userItem("local:send", "local prompt"), local: true}, ...transcriptOf(20)];
		const {process, scrolls, answerPage} = await openWindow(withTranscript(tail), {
			pageLimit: 25,
			estimateRowHeight: TEST_VIEWPORT.height,
		});
		await readerScrollsToTop(scrolls);
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({type: "page", before: "i0", limit: 25});
		const before = scrolls.length;
		await act(async () => {
			await answerPage(
				withTranscript(tail, {lastPage: page, pageOutcome: {status: "success", page}}),
			);
		});
		await waitFor(() => expect(scrolls.length).toBeGreaterThan(before));
		// The older-history head and two prepended rows precede the local anchor, not four rows.
		expect(scrolls.at(-1)).toBe(3 * TEST_VIEWPORT.height);
	});

	it("does not dispatch a partial live id before the reply has completed", async () => {
		const local = {...userItem("local:stream-send", "local prompt"), local: true};
		const reply = {...assistantItem("live-reply", "streaming reply"), partial: true};
		const {process, scrolls} = await openWindow(withTranscript([local, reply]));
		await readerScrollsToTop(scrolls);
		await settle();
		expect(process.inbox()).toEqual([]);
		expect(screen.queryByText("Loading earlier messages…")).toBeNull();
		await act(async () => {
			await Effect.runPromise(process.commit(withTranscript([local, {...reply, partial: false}])));
		});
		await scrollTo(0);
		await waitFor(() => expect(process.inbox()).toHaveLength(1));
		expect(process.inbox()[0]).toEqual({type: "page", before: reply.id, limit: 50});
	});

	it("does not request the newest page when every held row is local", async () => {
		const tail = transcriptOf(20).map((item) => ({
			...userItem(`local:${item.id}`, `local ${item.id}`),
			local: true,
		}));
		const {process, scrolls} = await openWindow(withTranscript(tail));
		await readerScrollsToTop(scrolls);
		await settle();
		expect(process.inbox()).toEqual([]);
		expect(screen.queryByText("Loading earlier messages…")).toBeNull();
	});

	it("shows a page refusal, retries without consuming the retained failure, and settles on a page", async () => {
		const state = withTranscript(transcriptOf(4));
		const {process, scrolls, view, answerPage} = await openWindow(state, {pageLimit: 25});
		await readerScrollsToTop(scrolls);
		expect(await screen.findByText("Loading earlier messages…")).toBeDefined();
		const failure = {
			tag: PAGE_ERROR,
			reason: "unknown-cursor",
			detail: "The history cursor is unknown.",
		};
		await act(async () => {
			await answerPage({...state, failure, pageOutcome: {status: "refused", failure}});
		});
		expect(screen.queryByText("Loading earlier messages…")).toBeNull();
		expect(
			within(transcript()).getByText(`Could not load earlier messages: ${failure.detail}`),
		).toBeDefined();
		expect(view().atOldest).toBe(false);
		expect(view().cursor).toBeNull();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", {name: "Retry loading earlier messages"}));
		});
		await waitFor(() =>
			expect(process.inbox()).toEqual([
				{type: "page", before: "i0", limit: 25},
				{type: "page", before: "i0", limit: 25},
			]),
		);
		expect(await screen.findByText("Loading earlier messages…")).toBeDefined();
		expect(screen.queryByText(`Could not load earlier messages: ${failure.detail}`)).toBeNull();
		await act(async () => {
			await Effect.runPromise(process.commit({...state, failure, phase: "prompting"}));
		});
		expect(screen.getByText("Loading earlier messages…")).toBeDefined();

		const repeatedFailure = {...failure};
		await act(async () => {
			await answerPage({
				...state,
				failure: repeatedFailure,
				pageOutcome: {status: "refused", failure: repeatedFailure},
			});
		});
		expect(screen.queryByText("Loading earlier messages…")).toBeNull();
		expect(screen.getByRole("button", {name: "Retry loading earlier messages"})).toBeDefined();
		expect(view().atOldest).toBe(false);
		await scrollTo(0);
		await waitFor(() => expect(process.inbox()).toHaveLength(3));
		expect(process.inbox()[2]).toEqual({type: "page", before: "i0", limit: 25});
		await act(async () => {
			await answerPage({
				...state,
				failure: repeatedFailure,
				lastPage: page,
				pageOutcome: {status: "success", page},
			});
		});
		await waitFor(() => expect(view().cursor).toBe("p0"));
		expect(view().atOldest).toBe(false);
		expect(screen.queryByText("Loading earlier messages…")).toBeNull();
		expect(screen.queryByRole("button", {name: "Retry loading earlier messages"})).toBeNull();
	});

	it("distinguishes success, refusal twice, and equal retained success across cloned snapshots", async () => {
		const state = withTranscript(transcriptOf(4));
		const {process, scrolls, view, answerPage} = await openWindow(state);
		const failure = {tag: PAGE_ERROR, reason: "unknown-cursor", detail: "Unknown history cursor."};
		const succeeded: AiAgentSessionState = {
			...state,
			failure,
			lastPage: page,
			pageOutcome: {status: "success", page},
		};
		const refused: AiAgentSessionState = {...succeeded, pageOutcome: {status: "refused", failure}};
		await readerScrollsToTop(scrolls);
		await act(async () => {
			await answerPage(succeeded);
		});
		await waitFor(() => expect(view().cursor).toBe("p0"));
		for (const outcome of [refused, refused, succeeded]) {
			await scrollTo(0);
			expect(await screen.findByText("Loading earlier messages…")).toBeDefined();
			for (const prior of [succeeded, refused, refused]) {
				await act(async () => {
					await Effect.runPromise(process.commit(prior));
				});
				expect(screen.getByText("Loading earlier messages…")).toBeDefined();
			}
			await act(async () => {
				await answerPage(outcome);
			});
			expect(screen.queryByText("Loading earlier messages…")).toBeNull();
			expect(view().atOldest).toBe(false);
			if (outcome.pageOutcome?.status === "refused") {
				expect(
					screen.getByText("Could not load earlier messages: Unknown history cursor."),
				).toBeDefined();
			}
		}
		expect(process.inbox()).toHaveLength(4);
		expect(screen.queryByRole("button", {name: "Retry loading earlier messages"})).toBeNull();
		await act(async () => {
			await Effect.runPromise(process.commit(refused));
		});
		expect(screen.queryByRole("button", {name: "Retry loading earlier messages"})).toBeNull();
	});

	it.each([
		"session",
		"connection",
	] as const)("ignores an old completion after the %s changes", async (changed) => {
		const state = withTranscript(transcriptOf(4));
		const {process, scrolls, answerPage, view} = await openWindow(state);
		await readerScrollsToTop(scrolls);
		const replacement =
			changed === "session"
				? {...state, sessionId: "replacement"}
				: {...state, connection: state.connection + 1};
		await act(async () => {
			await Effect.runPromise(process.commit(replacement));
		});
		expect(screen.queryByText("Loading earlier messages…")).toBeNull();
		await scrollTo(0);
		await waitFor(() => expect(process.inbox()).toHaveLength(2));
		await act(async () => {
			await answerPage({...state, pageOutcome: {status: "success", page}}, 0, false);
		});
		expect(screen.getByText("Loading earlier messages…")).toBeDefined();
		expect(view().cursor).toBeNull();
		const failure = {tag: PAGE_ERROR, reason: "unknown-cursor", detail: "Replacement refused."};
		await act(async () => {
			await answerPage({...replacement, pageOutcome: {status: "refused", failure}}, 1);
		});
		expect(screen.queryByText("Loading earlier messages…")).toBeNull();
		expect(screen.getByText("Could not load earlier messages: Replacement refused.")).toBeDefined();
	});

	it("does not consume a page refusal observed before this window asks for history", async () => {
		const state = withTranscript(transcriptOf(4), {
			failure: {
				tag: PAGE_ERROR,
				reason: "unknown-cursor",
				detail: "Another window's cursor is unknown.",
			},
		});
		const {process, scrolls, view} = await openWindow(state);
		await readerScrollsToTop(scrolls);
		await waitFor(() => expect(process.inbox()).toHaveLength(1));
		expect(screen.getByText("Loading earlier messages…")).toBeDefined();
		expect(screen.queryByRole("button", {name: "Retry loading earlier messages"})).toBeNull();
		expect(view().atOldest).toBe(false);
	});

	it("does not settle paging on an unrelated failure", async () => {
		const state = withTranscript(transcriptOf(4));
		const {process, scrolls} = await openWindow(state);
		await readerScrollsToTop(scrolls);
		await act(async () => {
			await Effect.runPromise(
				process.commit({
					...state,
					failure: {
						tag: PROMPT_ERROR,
						reason: "refused",
						detail: "The prompt was refused.",
					},
				}),
			);
		});
		expect(screen.getByText("Loading earlier messages…")).toBeDefined();
		expect(screen.queryByRole("button", {name: "Retry loading earlier messages"})).toBeNull();
	});

	it("asks once, not once per scroll event, while the reply is out", async () => {
		const {process, scrolls} = await openWindow(withTranscript(transcriptOf(20)));
		await readerScrollsToTop(scrolls);
		await scrollTo(0);
		await scrollTo(0);
		await waitFor(() => expect(process.inbox().length).toBe(1));
	});

	it("prepends the reply and scrolls back onto the row that was at the top", async () => {
		const {scrolls, answerPage} = await openWindow(withTranscript(transcriptOf(20)));
		await readerScrollsToTop(scrolls);
		const before = scrolls.length;
		await act(async () => {
			await answerPage(
				withTranscript(transcriptOf(20), {lastPage: page, pageOutcome: {status: "success", page}}),
			);
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
		const {process, scrolls, view, answerPage} = await openWindow(
			withTranscript(transcriptOf(20)),
			{
				bottomThreshold: SCROLL_BOX,
			},
		);
		await scrollToNewest();
		await waitFor(() => expect(view().pinned).toBe(true));

		await scrollTo(0);
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(view().pinned).toBe(false);

		const before = scrolls.length;
		await act(async () => {
			await answerPage(
				withTranscript(transcriptOf(20), {lastPage: page, pageOutcome: {status: "success", page}}),
			);
		});
		await waitFor(() => expect(scrolls.length).toBeGreaterThan(before));
		await settle();

		// The re-anchor put the reader back on the row they were reading. Nothing pulled them to the
		// bottom of the history they just asked for.
		expect(scrolls[scrolls.length - 1] ?? -1).toBeLessThan(SCROLL_BOX - TEST_VIEWPORT.height);
	});

	it("records the page cursor in its own view slot", async () => {
		const {scrolls, view, answerPage} = await openWindow(withTranscript(transcriptOf(20)));
		await readerScrollsToTop(scrolls);
		await act(async () => {
			await answerPage(
				withTranscript(transcriptOf(20), {lastPage: page, pageOutcome: {status: "success", page}}),
			);
		});
		await waitFor(() => expect(view().cursor).toBe("p0"));
		expect(view().atOldest).toBe(false);
	});

	it("drops the head row once the backend says there is nothing older", async () => {
		const {scrolls, view, answerPage} = await openWindow(withTranscript(transcriptOf(4)));
		await readerScrollsToTop(scrolls);
		await act(async () => {
			const oldest = {...page, hasMore: false};
			await answerPage(
				withTranscript(transcriptOf(4), {
					lastPage: oldest,
					pageOutcome: {status: "success", page: oldest},
				}),
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
		expect(phaseLine().getAttribute("role")).toBe("status");
		await waitFor(() => expect(phaseLine().textContent).toContain("Interrupting"));
		expect(phaseLine().textContent).not.toContain("Ready");
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
		const handed = withSends([{key, state: "pending", turn: "unstarted"}]);
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
		const cut = withSends([{key, state: "pending", turn: "unstarted"}], {
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
		const running = withSends([{key, state: "pending", turn: "running"}], {phase: "prompting"});
		await act(async () => {
			await Effect.runPromise(
				process.commit(foldEvent(running, {kind: "phase", phase: "ready"}, {})),
			);
		});
		await waitFor(() => expect(view().outgoing).toEqual([]));
		expect(screen.queryByRole("list", {name: "Unsent messages"})).toBeNull();
	});

	/**
	 * #8107. Same event, a turn no layer ever said had begun: the window keeps its copy, because a
	 * refusal a round trip later is what it would have to offer back.
	 */
	it("keeps the copy through a ready the backend never ran a turn for", async () => {
		const {process, keys, view} = await openWindow(withTranscript(transcriptOf(2)));
		await sent("ship it");
		const key = keys[0] ?? "";
		const handed = withSends([{key, state: "pending", turn: "unstarted"}], {phase: "prompting"});
		await act(async () => {
			await Effect.runPromise(
				process.commit(foldEvent(handed, {kind: "phase", phase: "ready"}, {})),
			);
		});
		expect(view().outgoing).toEqual([{key, text: "ship it"}]);

		await act(async () => {
			await Effect.runPromise(
				process.commit(withSends([{key, state: "refused", failure: refusal}])),
			);
		});
		expect(await screen.findByText("This message was not sent.")).toBeDefined();
		expect(view().outgoing).toEqual([{key, text: "ship it"}]);
	});

	/**
	 * #8107's second half, at the window. A stale `ready` leaves the session `ready` under a send
	 * whose turn never began, so the operator can send again and the window ends up holding two
	 * copies. The next turn the backend runs is the first send's, and only that copy may go — the
	 * failure this guards is the ledger accepting the wrong key and the window dropping the text
	 * the backend has not seen.
	 */
	it("drops only the copy of the send whose turn the backend ran, with two in flight", async () => {
		const {process, keys, view} = await openWindow(withTranscript(transcriptOf(2)));
		await sent("the first thing");
		await sent("the second thing");
		await waitFor(() => expect(view().outgoing.length).toBe(2));
		const [first = "", second = ""] = keys;

		const bothHeld = withSends(
			[
				{key: first, state: "pending", turn: "unstarted"},
				{key: second, state: "pending", turn: "unstarted"},
			],
			{phase: "prompting"},
		);
		const ran = foldEvent(
			foldEvent(bothHeld, {kind: "phase", phase: "prompting"}, {}),
			{kind: "phase", phase: "ready"},
			{},
		);
		await act(async () => {
			await Effect.runPromise(process.commit(ran));
		});

		await waitFor(() => expect(view().outgoing).toEqual([{key: second, text: "the second thing"}]));
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
		globalThis.document.body.removeAttribute(PREFIX_ARMED_ATTRIBUTE);
		seen.length = 0;
	});

	/**
	 * The desk's mark, put on an ancestor of the window exactly as the desk puts it on its own root
	 * (`../ui/Desk.tsx`) — the window is mounted under `body` here, and there is no desk above it.
	 */
	const armTheDesk = (): void =>
		globalThis.document.body.setAttribute(PREFIX_ARMED_ATTRIBUTE, "true");

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

	it("stands down for every key of an armed sequence, transcript and composer alike (#8270)", async () => {
		const {process} = await openWindow(
			withTranscript(transcriptOf(2), {phase: "prompting", interrupted: ItemId.make("b")}),
		);
		const reached = watchDesk();
		armTheDesk();

		await act(async () => {
			fireEvent.keyDown(screen.getByRole("log", {name: "Transcript"}), {key: "w"});
			fireEvent.keyDown(composer(), {key: "Escape"});
			fireEvent.keyDown(composer(), {key: "r", altKey: true});
		});

		// The bare `w` is the second key of `<prefix> w`, and the window's own two keys are the
		// shell's while it is armed: nothing here is the window's to act on.
		expect(reached).toEqual(["w", "Escape", "r"]);
		expect(process.inbox()).toEqual([]);
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
		const regionsWhileReady = liveRegions();

		await act(async () => {
			await Effect.runPromise(
				process.commit(withTranscript(transcriptOf(2), {phase: "prompting"})),
			);
		});
		await waitFor(() => expect(working()).not.toBeNull());
		// The phase line is the announced one; a `status` the tell brought with it would narrate the
		// same turn twice. Counted against the ready window rather than against a literal, because not
		// every live region the window carries is the tell's business.
		expect(working()?.getAttribute("aria-hidden")).toBe("true");
		expect(liveRegions()).toBe(regionsWhileReady);

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
	/** Every offset each window asked its own scroller for, keyed by that scroller. */
	const asks = new Map<Element, Array<number>>();

	afterEach(() => {
		asks.clear();
	});

	interface Pair {
		readonly answerPage: Harness["answerPage"];
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
		const {bind, answerPage} = pageCompletions(process);
		const left = bind(
			await Effect.runPromise(process.window<ChatView>(WindowId.make("left"), initial)),
		);
		const right = bind(
			await Effect.runPromise(process.window<ChatView>(WindowId.make("right"), initial)),
		);
		// One renderer serves both windows, so the offsets are recorded per scroller rather than in
		// one list: `landPendingScrollIn` settles each window's opening scroll on its own.
		const renderer = chatWindow({
			scrollCommitMs: 0,
			scrollToFn: (offset, _scroll, instance) => {
				const scroller = instance.scrollElement;
				if (scroller === null) return;
				const held = asks.get(scroller) ?? [];
				held.push(offset);
				asks.set(scroller, held);
			},
			...options,
		});
		render(
			<>
				{renderer.render(left)}
				{renderer.render(right)}
			</>,
		);
		const transcripts = await screen.findAllByRole("log", {name: "Transcript"});
		expect(transcripts.length).toBe(2);
		const [first, second] = transcripts as [HTMLElement, HTMLElement];
		return {process, left, right, answerPage, scrollers: [first, second]};
	};

	const scrollWindowTo = scrollElementTo;

	/** The reader of one window arriving at the top, after that window has placed itself. */
	const readerOfWindowScrollsToTop = async (scroller: HTMLElement): Promise<void> => {
		await landPendingScrollIn(scroller, asks.get(scroller) ?? []);
		await scrollElementTo(scroller, 0);
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

	it("merges the page only into the window that asked for it", async () => {
		const {process, left, right, scrollers, answerPage} = await openPair(
			withTranscript(transcriptOf(20)),
			{
				pageLimit: 25,
			},
		);

		await readerOfWindowScrollsToTop(scrollers[0]);
		await waitFor(() => expect(process.inbox().length).toBe(1));
		expect(process.inbox()[0]).toEqual({type: "page", before: "i0", limit: 25});

		await act(async () => {
			await answerPage(
				withTranscript(transcriptOf(20), {lastPage: page, pageOutcome: {status: "success", page}}),
			);
		});

		await waitFor(() => expect(left.view().cursor).toBe("p0"));
		expect(within(windowBox("left")).getByText("older prompt")).toBeDefined();

		expect(within(windowBox("right")).queryByText("older prompt")).toBeNull();
		expect(within(windowBox("right")).queryByText("older answer")).toBeNull();
		expect(right.view().cursor).toBeNull();
		expect(right.view().atOldest).toBe(false);
	});

	it("does not merge the page it ignored when it later asks for one of its own", async () => {
		const {process, left, right, scrollers, answerPage} = await openPair(
			withTranscript(transcriptOf(20)),
		);

		await readerOfWindowScrollsToTop(scrollers[0]);
		await act(async () => {
			await answerPage(
				withTranscript(transcriptOf(20), {lastPage: page, pageOutcome: {status: "success", page}}),
			);
		});
		await waitFor(() => expect(left.view().cursor).toBe("p0"));

		await readerOfWindowScrollsToTop(scrollers[1]);
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

	it("counts the rows it reveals and announces the reveal, separately from the call's own panel", async () => {
		await openWindow(withTranscript(group));

		const fold = foldButton();
		expect(fold.textContent).toBe("Show 2 nested calls");
		expect(fold.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("bash")).toBeNull();

		await act(async () => {
			fireEvent.click(fold);
		});

		const opened = foldButton();
		expect(opened.textContent).toBe("Hide 2 nested calls");
		expect(opened.getAttribute("aria-expanded")).toBe("true");
		expect(screen.queryByText("bash")).not.toBeNull();
		expect(screen.queryByText("grep")).not.toBeNull();
	});

	// The rows are virtualized, so any idref list the button named would go stale as the reader
	// scrolls (#8057). `aria-expanded` alone carries the disclosure, which is all APG asks of one.
	it("names no rows in aria-controls, open or shut", async () => {
		await openWindow(withTranscript(group));

		expect(foldButton().getAttribute("aria-controls")).toBeNull();

		await act(async () => {
			fireEvent.click(foldButton());
		});

		expect(foldButton().getAttribute("aria-controls")).toBeNull();
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
		expect(screen.queryByText("bash")).toBeNull();

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
		expect(screen.queryByText("bash")).toBeNull();

		await act(async () => {
			fireEvent.click(folds[1] as HTMLElement);
		});
		expect(screen.queryByText("bash")).not.toBeNull();
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
		expect(screen.getByText("done").closest(".tuval-chat-markdown")).not.toBeNull();
		expect(marker?.querySelector(".tuval-chat-markdown")).toBeNull();
	});
});

/**
 * Everything else a backend says about the session, through the one row that renders all of it.
 * The SDK's fifteen-odd `system` subtypes never reach this window as subtypes — a `SystemItem` is
 * a summary and an optional detail, and these cases are the whole of what the row does with them.
 */
describe("the session row", () => {
	const sessionRows = (): ReadonlyArray<HTMLElement> =>
		Array.from(document.querySelectorAll<HTMLElement>('.tuval-chat-row[data-kind="session"]'));

	const panelOf = (trigger: HTMLElement): HTMLElement | null =>
		document.getElementById(trigger.getAttribute("aria-controls") ?? "");

	it("renders a summary-only notice as a line with no control to open", async () => {
		await openWindow(withTranscript([userItem("a", "go"), systemItem("s", "session resumed")]));

		const line = await screen.findByText("session resumed");
		expect(line.className).toContain("tuval-chat-text");
		// Nothing is folded away, so a disclosure here would name a region with nothing in it.
		expect(screen.queryByRole("button", {name: "session resumed"})).toBeNull();
	});

	it("folds a notice's detail behind a disclosure the summary names", async () => {
		const detail = "PreToolUse hook exited 1\n  at guard.sh:12";
		await openWindow(withTranscript([systemItem("s", "hook refused the call", 1, detail)]));

		const trigger = await screen.findByRole("button", {name: "hook refused the call"});
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(panelOf(trigger)?.hidden).toBe(true);

		await act(async () => {
			fireEvent.click(trigger);
		});

		const opened = screen.getByRole("button", {name: "hook refused the call"});
		expect(opened.getAttribute("aria-expanded")).toBe("true");
		const panel = panelOf(opened);
		expect(panel?.hidden).toBe(false);
		expect(panel?.textContent).toBe(detail);
		// The panel lives inside the row the virtualizer measures, or the row clips at its estimate.
		expect(panel?.closest(".tuval-chat-row")?.getAttribute("data-kind")).toBe("session");
	});

	it("collapses a burst of consecutive notices into one row rather than stacking them", async () => {
		await openWindow(
			withTranscript([
				userItem("a", "go"),
				systemItem("s1", "hook started"),
				systemItem("s2", "hook running"),
				systemItem("s3", "hook finished"),
				assistantItem("b", "done"),
			]),
		);
		await screen.findByText("done");

		expect(sessionRows().length).toBe(1);
		// The newest notice is the session's current word, and the row says how much it holds back.
		const trigger = screen.getByRole("button", {name: /^hook finished/});
		expect(trigger.textContent).toContain("2 earlier notices");
		// The earlier notices are behind the fold, not on the row: `Collapsible` keeps its content
		// mounted and `hidden`, so what is asserted is the region, never the absence of the node.
		expect(panelOf(trigger)?.hidden).toBe(true);
		expect(screen.getByText("hook started").closest("[hidden]")).toBe(panelOf(trigger));

		await act(async () => {
			fireEvent.click(trigger);
		});

		const panel = panelOf(screen.getByRole("button", {name: /^hook finished/}));
		expect(
			Array.from(panel?.querySelectorAll(".tuval-chat-text") ?? []).map((line) => line.textContent),
		).toEqual(["hook started", "hook running", "hook finished"]);
	});

	it("keeps a run out of the row its neighbours are in", async () => {
		await openWindow(
			withTranscript([
				systemItem("s1", "session resumed"),
				assistantItem("b", "done"),
				systemItem("s2", "rate limit reached"),
			]),
		);
		await screen.findByText("done");

		expect(sessionRows().length).toBe(2);
		expect(screen.getByText("done").closest(".tuval-chat-row")?.getAttribute("data-kind")).toBe(
			"assistant",
		);
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

/**
 * #8159. The composer offers a "queue" button while a turn runs, so the words an operator writes
 * then have to be somewhere they can see. They are in the session's queue, and the window renders
 * that queue rather than anything it remembers itself — which is what makes the same waiting text
 * visible in the other window over the same process.
 */
describe("the messages waiting for the running turn to end", () => {
	const waiting = (
		queued: AiAgentSessionState["queued"],
		over: Partial<AiAgentSessionState> = {},
	): AiAgentSessionState => withTranscript(transcriptOf(2), {phase: "prompting", queued, ...over});

	it("renders each one, off the session's own queue", async () => {
		await openWindow(
			waiting([
				{key: "q1", text: "then the CHANGELOG", timestamp: SENT_AT},
				{key: "q2", text: "and tag it", timestamp: SENT_AT + 1},
			]),
		);
		const list = screen.getByRole("list", {name: "Queued messages"});
		expect(
			within(list)
				.getAllByRole("listitem")
				.map((row) => row.textContent),
		).toEqual(["then the CHANGELOG", "and tag it"]);
		expect(screen.getByText("2 messages are waiting for the turn to end.")).toBeDefined();
	});

	// The ordinary case — everything sent — earns no permanent strip of chrome (ADR 0162, Pillar 3).
	it("renders nothing at all on an empty queue", async () => {
		await openWindow(waiting([]));
		expect(screen.queryByRole("list", {name: "Queued messages"})).toBeNull();
	});

	// A queued message has reached no backend, so it is not a turn: the tail must not claim one.
	it("keeps them off the transcript until they are sent", async () => {
		await openWindow(waiting([{key: "q1", text: "then the CHANGELOG", timestamp: SENT_AT}]));
		const transcript = screen.getByRole("log", {name: "Transcript"});
		expect(within(transcript).queryByText("then the CHANGELOG")).toBeNull();
	});
});
