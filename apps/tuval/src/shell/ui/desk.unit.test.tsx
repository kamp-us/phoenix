/**
 * @vitest-environment jsdom
 *
 * The desk, rendered. The tier is `unit` on purpose: every assertion here could be wrong even if
 * every socket behaved perfectly, which is the litmus (`.patterns/effect-testing.md`).
 *
 * The harness runs the real reducer over dispatched Msgs, so a press that arms the prefix leaves
 * the next render actually armed. Anything that stubbed the core would prove the surface agrees
 * with a fake and nothing about the desk.
 */

import {act, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {Duration} from "effect";
import type {ReactElement} from "react";
import {StrictMode, useEffect, useRef, useState} from "react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import type {ShellMsg, ShellState} from "../core/index.ts";
import {applyMsg} from "../core/index.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import type {PickerEntries} from "../picker/index.ts";
import {empty, prefixArmedAround, processGone, type WindowId} from "../window/index.ts";
import {Desk} from "./Desk.tsx";
import {installDomShims} from "./dom.testing.ts";
import {threeWindowDesk} from "./fixtures.ts";
import {useForwardedKey} from "./forwarded-key.tsx";
import {boundMount, type MountResolver, noRenderer, type ReactWindowRenderer} from "./mount.ts";
import {type KeyPress, refused, replyIn} from "./press.ts";

installDomShims();

const entries: PickerEntries = {
	programs: [{_tag: "Program", programId: ProgramId.make("counter"), label: "Counter"}],
	processes: [],
};

/** Every window bound, rendering whatever the caller wants inside it. */
const boundTo =
	(render: ReactWindowRenderer): MountResolver =>
	(windowId, processId) =>
		processId === null
			? empty
			: boundMount(
					{
						windowId,
						processId: ProcessId.make(processId),
						readProcess: undefined as never,
						dispatch: undefined as never,
						view: () => null,
						setView: undefined as never,
					},
					render,
				);

/** Every window bound, every renderer a paragraph naming its process. */
const boundEverywhere: MountResolver = boundTo((host) => (
	<p>renderer for {String(host.processId)}</p>
));

/**
 * A window shaped like the chat one: the two places an operator's focus actually sits — a composer
 * that reads its own keys, and a scroll region that swallows a bare character exactly as
 * `../chat/ChatWindow.tsx` does. The rule is the shipped helper, not a paraphrase of it, so a desk
 * that stopped honouring the armed mark fails here.
 */
const chatShapedWindow: MountResolver = boundTo((host) => (
	<>
		<div
			role="log"
			aria-label={`Transcript ${host.windowId}`}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must take keyboard focus
			tabIndex={0}
			onKeyDown={(event) => {
				const bare =
					!event.ctrlKey && !event.metaKey && !event.altKey && [...event.key].length === 1;
				if (bare && !prefixArmedAround(event.target)) event.stopPropagation();
			}}
		/>
		<textarea aria-label={`Compose ${host.windowId}`} defaultValue="" />
	</>
));

interface HarnessProps {
	readonly initial: ShellState;
	readonly sent: Array<ShellMsg>;
	readonly resolveMount?: MountResolver;
	/**
	 * Where a held answer waits, one entry per unanswered press, oldest first. Absent means the
	 * kernel answers as the key is pressed, which is the fast local round trip; a test that types
	 * faster than the kernel supplies this array and releases the answers itself.
	 */
	readonly replies?: Array<() => void>;
	/** Presses the kernel never applies — a dispatch the socket dropped, answered `Refused`. */
	readonly dropFirst?: number;
	/** A snapshot the kernel pushed out of band: a lapse it folded itself, or a fresh attach. */
	readonly frame?: ShellState;
	/**
	 * Kernel traffic that leaves the prefix alone — a demo counter ticking. Every change re-decodes
	 * the snapshot, so it is equal in value and new in identity, exactly as a socket delivers it.
	 */
	readonly traffic?: number;
}

/**
 * A desk over the real reducer, plus the acknowledgement the transport carries back (#8274). The
 * kernel folds a key when it receives it and the desk learns *both* the answer and the state it
 * left behind from the reply, which is what the `dispatched` frame carries.
 */
function Harness({
	initial,
	sent,
	resolveMount = boundEverywhere,
	replies,
	dropFirst = 0,
	frame,
	traffic = 0,
}: HarnessProps): ReactElement {
	const [shown, setShown] = useState(initial);
	const kernel = useRef(initial);
	const presses = useRef(0);

	useEffect(() => {
		if (frame === undefined) return;
		kernel.current = frame;
		setShown(frame);
	}, [frame]);

	useEffect(() => {
		if (traffic === 0) return;
		setShown((current) => JSON.parse(JSON.stringify(current)) as ShellState);
	}, [traffic]);

	const fold = (msg: ShellMsg): ShellState => {
		sent.push(msg);
		const [next] = applyMsg(defaultPrefixTable, kernel.current, msg);
		kernel.current = next;
		return next;
	};

	const press: KeyPress = (key) => {
		presses.current += 1;
		if (presses.current <= dropFirst) return Promise.resolve(refused);
		const pressId = `page-${presses.current}`;
		const applied = fold({type: "keys.press", key, pressId});
		return new Promise((resolve) => {
			const answer = (): void => {
				setShown(applied);
				resolve(replyIn(pressId, applied));
			};
			if (replies === undefined) answer();
			else replies.push(answer);
		});
	};

	return (
		<Desk
			state={shown}
			dispatch={(msg) => setShown(fold(msg))}
			press={press}
			resolveMount={resolveMount}
			entries={entries}
			table={defaultPrefixTable}
		/>
	);
}

/** Release the oldest held answer and let React settle everything it caused. */
const answer = async (replies: Array<() => void>, count = 1): Promise<void> => {
	for (let i = 0; i < count; i++) {
		const next = replies.shift();
		if (next === undefined) throw new Error("no answer is being held");
		await act(async () => {
			next();
		});
	}
};

const arm = (): void => {
	fireEvent.keyDown(document, {key: "b", ctrlKey: true, code: "KeyB"});
};

/**
 * `<prefix> :`, with the kernel's answers landed. Opening the line is the page's part of a command
 * the kernel named, so it happens when the answer arrives rather than at the press (#8274).
 */
const openCommandLine = async (): Promise<void> => {
	await act(async () => {
		fireEvent.keyDown(document, {key: "b", ctrlKey: true, code: "KeyB"});
		fireEvent.keyDown(document, {key: ":", code: "Semicolon", shiftKey: true});
	});
};

/** `<c-l>` — `workspace:next`, the repeatable binding that opens tmux's `repeat-time` window. */
const repeat = (): void => {
	fireEvent.keyDown(document, {key: "l", ctrlKey: true, code: "KeyL"});
};

describe("the desk renders the workspace's layout tree", () => {
	it("nests the splits the way the tree does, and marks the focused window once", () => {
		render(<Harness initial={threeWindowDesk("window-3")} sent={[]} />);

		// Every window is a landmark, and so is the status line; the window ones are the named ones.
		const windows = screen.getAllByRole("region", {name: /^Window /});
		expect(windows.map((node) => node.getAttribute("data-window-id"))).toEqual([
			"window-1",
			"window-2",
			"window-3",
		]);

		const focused = windows.filter((node) => node.getAttribute("data-focused") === "true");
		expect(focused).toHaveLength(1);
		expect(focused[0]?.getAttribute("data-window-id")).toBe("window-3");
		// The mark is not the colour: the focused window says so in its own title row.
		expect(within(focused[0] as HTMLElement).getByText("(focused)")).toBeTruthy();
	});

	it("puts window-1 beside a vertical stack of window-2 and window-3", () => {
		const {container} = render(<Harness initial={threeWindowDesk()} sent={[]} />);

		const root = container.querySelector<HTMLElement>('[data-stack-id="stack-root"]');
		const right = container.querySelector<HTMLElement>('[data-stack-id="stack-right"]');
		// The library's whole reading of `orientation` is this flex direction (`Group.tsx`), and it
		// is one to one with the tree's own word: `"horizontal"` is children side by side.
		expect(root?.style.flexDirection).toBe("row");
		expect(right?.style.flexDirection).toBe("column");
		// The nesting is the claim: the inner stack is inside the outer one, not a sibling of it.
		expect(root?.contains(right as Node)).toBe(true);
		expect(within(right as HTMLElement).getByLabelText("Window window-2")).toBeTruthy();
		expect(within(right as HTMLElement).queryByLabelText("Window window-1")).toBeNull();
	});

	it("renders dark, off the surface's own token layer", () => {
		const {container} = render(<Harness initial={threeWindowDesk()} sent={[]} />);
		const surface = container.querySelector(".tuval-surface");
		expect(surface?.getAttribute("data-scheme")).toBe("dark");
	});
});

describe("the three arms of the window contract", () => {
	it("mounts a bound window's renderer, an empty window's picker and a gone process's placeholder", () => {
		const resolveMount: MountResolver = (windowId, processId) => {
			if (processId === null) return empty;
			if (windowId === "window-1") return processGone(ProcessId.make(processId));
			return noRenderer(ProcessId.make(processId), "its program declares no renderer");
		};
		render(<Harness initial={threeWindowDesk()} sent={[]} resolveMount={resolveMount} />);

		expect(screen.getByText(/Process process-1 is gone/)).toBeTruthy();
		expect(screen.getByText(/Process process-3 is running/)).toBeTruthy();
		expect(screen.getByRole("listbox", {name: /Open a program/})).toBeTruthy();
	});

	it("mounts the program's own renderer when the window is bound", () => {
		render(<Harness initial={threeWindowDesk()} sent={[]} />);
		expect(screen.getByText("renderer for process-1")).toBeTruthy();
		expect(screen.getByText("renderer for process-3")).toBeTruthy();
	});
});

describe("the picker's activedescendant", () => {
	// `aria-activedescendant` is announced only off the element that holds DOM focus, so a listbox
	// nothing ever focused moves a highlight assistive tech never hears (#7499). The listbox is the
	// only element the pattern may focus — the options stay untabbable.
	it("holds DOM focus while its window is the focused one, and names an active option", () => {
		render(<Harness initial={threeWindowDesk("window-2")} sent={[]} />);
		const listbox = screen.getByRole("listbox", {name: /Open a program/});
		expect(document.activeElement).toBe(listbox);
		expect(listbox.getAttribute("aria-activedescendant")).toBeTruthy();
	});

	it("does not take focus when another window is the focused one", () => {
		render(<Harness initial={threeWindowDesk("window-1")} sent={[]} />);
		const listbox = screen.getByRole("listbox", {name: /Open a program/});
		expect(document.activeElement).not.toBe(listbox);
	});
});

/**
 * A window renderer that reads its own keys, so a click can land inside a text entry the way it
 * does in a chat composer. `boundEverywhere` renders a paragraph, which focuses nothing.
 */
const composerEverywhere: MountResolver = (windowId, processId) =>
	processId === null
		? empty
		: {
				_tag: "Bound",
				host: {
					windowId,
					processId: ProcessId.make(processId),
					readProcess: undefined as never,
					dispatch: undefined as never,
					view: () => null,
					setView: undefined as never,
				},
				render: (host) => <input aria-label={`composer for ${String(host.processId)}`} />,
			};

const focusedWindowId = (): string | null => {
	const marked = screen
		.getAllByRole("region", {name: /^Window /})
		.filter((node) => node.getAttribute("data-focused") === "true");
	expect(marked).toHaveLength(1);
	return marked[0]?.getAttribute("data-window-id") ?? null;
};

const focusMsgs = (sent: Array<ShellMsg>): Array<ShellMsg> =>
	sent.filter((msg) => msg.type === "window.focus");

describe("pointer focus (#7848)", () => {
	it("focuses the window a pointer goes down on, and hands its renderer DOM focus", () => {
		const sent: Array<ShellMsg> = [];
		render(<Harness initial={threeWindowDesk("window-1")} sent={sent} />);
		expect(focusedWindowId()).toBe("window-1");

		fireEvent.pointerDown(screen.getByLabelText("Window window-2"));

		expect(focusMsgs(sent)).toEqual([{type: "window.focus", windowId: "window-2"}]);
		expect(focusedWindowId()).toBe("window-2");
		// window-2 is the empty one, so its picker is the renderer — and desk focus and DOM focus
		// agree without this handler ever calling `focus()`.
		expect(document.activeElement).toBe(screen.getByRole("listbox", {name: /Open a program/}));
	});

	it("sends nothing when the window is already the focused one", () => {
		const sent: Array<ShellMsg> = [];
		render(<Harness initial={threeWindowDesk("window-1")} sent={sent} />);

		fireEvent.pointerDown(screen.getByLabelText("Window window-1"));

		expect(focusMsgs(sent)).toEqual([]);
		expect(focusedWindowId()).toBe("window-1");
	});

	it("leaves focus alone for a separator press, and for a drag that travels over a window", () => {
		const sent: Array<ShellMsg> = [];
		const {container} = render(<Harness initial={threeWindowDesk("window-1")} sent={sent} />);
		const separator = container.querySelector(".tuval-separator");
		expect(separator).not.toBeNull();

		// A separator is a sibling of the panels, never a descendant of a window, so the press does
		// not bubble through one — and a drag fires no second pointerdown wherever it travels.
		fireEvent.pointerDown(separator as Element);
		const window2 = screen.getByLabelText("Window window-2");
		fireEvent.pointerMove(window2);
		fireEvent.pointerUp(window2);

		expect(focusMsgs(sent)).toEqual([]);
		expect(focusedWindowId()).toBe("window-1");
	});

	it("focuses the window a composer sits in without pulling DOM focus off the composer", () => {
		const sent: Array<ShellMsg> = [];
		render(
			<Harness
				initial={threeWindowDesk("window-1")}
				sent={sent}
				resolveMount={composerEverywhere}
			/>,
		);
		const composer = screen.getByLabelText("composer for process-3");
		// What the gesture's own default does before the desk re-renders: the caret is in the input.
		composer.focus();

		fireEvent.pointerDown(composer);

		expect(focusMsgs(sent)).toEqual([{type: "window.focus", windowId: "window-3"}]);
		expect(focusedWindowId()).toBe("window-3");
		expect(document.activeElement).toBe(composer);
	});

	it("walks focus by keyboard exactly as before, with the pointer path in place", () => {
		render(<Harness initial={threeWindowDesk("window-1")} sent={[]} />);

		act(arm);
		act(() => void fireEvent.keyDown(document, {key: "l", code: "KeyL"}));
		expect(focusedWindowId()).toBe("window-2");

		act(arm);
		act(() => void fireEvent.keyDown(document, {key: "j", code: "KeyJ"}));
		expect(focusedWindowId()).toBe("window-3");

		act(arm);
		act(() => void fireEvent.keyDown(document, {key: "ArrowUp", code: "ArrowUp"}));
		expect(focusedWindowId()).toBe("window-2");

		act(arm);
		act(() => void fireEvent.keyDown(document, {key: "ArrowLeft", code: "ArrowLeft"}));
		expect(focusedWindowId()).toBe("window-1");
	});
});

describe("the single application-level keyboard listener", () => {
	let added: Array<string>;

	beforeEach(() => {
		added = [];
		const real = Document.prototype.addEventListener;
		vi.spyOn(document, "addEventListener").mockImplementation(
			(type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
				added.push(type);
				real.call(document, type, listener, options as AddEventListenerOptions | undefined);
			},
		);
	});

	it("registers exactly one, and dispatches keys.press through it", () => {
		const sent: Array<ShellMsg> = [];
		render(<Harness initial={threeWindowDesk()} sent={sent} />);

		expect(added.filter((type) => type === "keydown")).toHaveLength(1);

		fireEvent.keyDown(document, {key: "j"});
		expect(sent).toEqual([
			expect.objectContaining({type: "keys.press", key: expect.objectContaining({key: "j"})}),
		]);
	});

	it("adds none for the pointer path: a pointer handler is not a keyboard listener", () => {
		render(<Harness initial={threeWindowDesk("window-1")} sent={[]} />);
		fireEvent.pointerDown(screen.getByLabelText("Window window-2"));

		expect(added.filter((type) => type === "keydown")).toHaveLength(1);
	});

	it("adds no second listener when the command line opens", async () => {
		render(<Harness initial={threeWindowDesk()} sent={[]} />);
		await openCommandLine();

		expect(screen.getByLabelText("Type a command")).toBeTruthy();
		expect(added.filter((type) => type === "keydown")).toHaveLength(1);
	});
});

describe("the command line", () => {
	it("opens on `prefix :` and dispatches the Msg a typed row names", async () => {
		const sent: Array<ShellMsg> = [];
		render(<Harness initial={threeWindowDesk()} sent={sent} />);

		expect(screen.queryByLabelText("Type a command")).toBeNull();
		await openCommandLine();

		const input = screen.getByLabelText("Type a command");
		fireEvent.change(input, {target: {value: "workspace:create"}});
		act(() => {
			fireEvent.submit(input);
		});

		expect(sent).toContainEqual({type: "workspace.create"});
		expect(screen.queryByLabelText("Type a command")).toBeNull();
	});

	it("shows the row's own refusal and stays open on a line it cannot read", async () => {
		const sent: Array<ShellMsg> = [];
		render(<Harness initial={threeWindowDesk()} sent={sent} />);
		await openCommandLine();

		const input = screen.getByLabelText("Type a command");
		fireEvent.change(input, {target: {value: "workspace:nope"}});
		act(() => {
			fireEvent.submit(input);
		});

		expect(screen.getByRole("alert").textContent).toMatch(/workspace:nope/);
		expect(screen.getByLabelText("Type a command")).toBeTruthy();
		expect(sent.filter((msg) => msg.type !== "keys.press")).toEqual([]);
	});

	it("does not read the desk's keys while it is open", async () => {
		const sent: Array<ShellMsg> = [];
		render(<Harness initial={threeWindowDesk()} sent={sent} />);
		await openCommandLine();
		const before = sent.length;

		fireEvent.keyDown(screen.getByLabelText("Type a command"), {key: "x"});
		expect(sent).toHaveLength(before);
	});
});

/**
 * tmux's rule, from the two places the operator actually sits (#8270). The composer holds the caret
 * most of the day and the transcript the rest of it, and before this the whole key grammar was
 * unreachable from both.
 *
 * `fireEvent` returns the `dispatchEvent` answer, so `false` is "the default was prevented" — which
 * is the browser-side proof that no character was inserted. jsdom performs no default text entry of
 * its own, so that return, and not the textarea's value, is what carries the claim.
 */
describe("the shell's own keys from a focused text entry or transcript", () => {
	const openDesk = (sent: Array<ShellMsg>): void => {
		render(
			<Harness initial={threeWindowDesk("window-1")} sent={sent} resolveMount={chatShapedWindow} />,
		);
	};
	const composer = (): HTMLTextAreaElement =>
		screen.getByLabelText("Compose window-1") as HTMLTextAreaElement;
	const transcript = (): HTMLElement => screen.getByRole("log", {name: "Transcript window-1"});
	const armed = (): boolean =>
		document.querySelector(".tuval-surface")?.hasAttribute("data-prefix-armed") === true;

	/** The `dispatchEvent` answer for one press, with the render it caused already flushed. */
	const press = (element: Element, init: Record<string, unknown>): boolean => {
		let answer = true;
		act(() => {
			answer = fireEvent.keyDown(element, init);
		});
		return answer;
	};

	it("arms the prefix on `<c-b>` typed into a focused textarea", () => {
		const sent: Array<ShellMsg> = [];
		openDesk(sent);
		composer().focus();

		const notPrevented = press(composer(), {key: "b", ctrlKey: true, code: "KeyB"});

		expect(sent).toEqual([
			expect.objectContaining({
				type: "keys.press",
				key: expect.objectContaining({key: "b", ctrlKey: true}),
			}),
		]);
		expect(armed()).toBe(true);
		expect(notPrevented).toBe(false);
	});

	it("completes `<c-b> w` from the focused transcript, putting the window back on the picker", () => {
		openDesk([]);
		transcript().focus();

		const scroller = transcript();
		press(scroller, {key: "b", ctrlKey: true, code: "KeyB"});
		expect(armed()).toBe(true);
		press(scroller, {key: "w", code: "KeyW"});

		expect(armed()).toBe(false);
		// `window:pick` unbound the focused window, so its mount is the picker (#8083) — window-2 is
		// empty from the start, so the claim is scoped to the one the sequence acted on.
		const window1 = within(screen.getByLabelText("Window window-1"));
		expect(window1.getByRole("listbox", {name: /Open a program/})).toBeTruthy();
		expect(window1.queryByRole("log")).toBeNull();
	});

	it("leaves a plain `w` to the composer while the prefix is idle", () => {
		const sent: Array<ShellMsg> = [];
		openDesk(sent);
		composer().focus();

		const notPrevented = press(composer(), {key: "w", code: "KeyW"});

		expect(notPrevented).toBe(true);
		expect(sent).toEqual([]);
		expect(armed()).toBe(false);
	});

	it("opens the palette on Cmd+K and on Ctrl+K from inside a textarea", () => {
		openDesk([]);
		const palette = (): HTMLElement | null => screen.queryByRole("combobox", {name: "Run a spell"});

		composer().focus();
		press(composer(), {key: "k", metaKey: true, code: "KeyK"});
		expect(palette()).toBeTruthy();

		press(palette() as HTMLElement, {key: "Escape"});
		expect(palette()).toBeNull();

		composer().focus();
		press(composer(), {key: "k", ctrlKey: true, code: "KeyK"});
		expect(palette()).toBeTruthy();
	});

	it("keeps every key of an armed sequence out of the composer", () => {
		openDesk([]);
		// Held across the sequence: `<c-b> w` unbinds this window, so the element is the composer's
		// only surviving witness once the picker has taken its place.
		const box = composer();
		box.focus();

		const prefixPrevented = press(box, {key: "b", ctrlKey: true, code: "KeyB"});
		const sequencePrevented = press(box, {key: "w", code: "KeyW"});

		expect([prefixPrevented, sequencePrevented]).toEqual([false, false]);
		expect(box.value).toBe("");
	});
});

describe("the status line", () => {
	it("shows the workspace, the armed prefix and the pending sequence", () => {
		render(<Harness initial={threeWindowDesk()} sent={[]} />);
		const status = screen.getByLabelText("Shell status");

		expect(status.textContent).toContain("workspace-0");
		expect(status.textContent).toContain("3 windows");
		expect(status.textContent).toContain("idle");

		act(arm);
		expect(screen.getByLabelText("Shell status").textContent).toContain("armed");
		expect(screen.getByLabelText("Shell status").textContent).toContain(
			"Prefix armed, waiting for a sequence.",
		);
	});
});

describe("the repeat window's countdown", () => {
	it("lapses on its own clock, however much unrelated kernel traffic arrives (#7782)", async () => {
		vi.useFakeTimers();
		try {
			const sent: Array<ShellMsg> = [];
			const view = render(<Harness initial={threeWindowDesk()} sent={sent} traffic={0} />);
			// `<c-l>` is `workspace:next`, a `repeatable: true` binding: it leaves the prefix armed
			// for the table's 500ms repeat window, the one bounded window left.
			act(arm);
			act(repeat);

			// Snapshots across the window: a demo counter ticking at 100ms, and nothing about the
			// prefix changing. A countdown keyed on the snapshot object re-armed on every one of
			// these and never fired.
			for (let tick = 1; tick <= 4; tick++) {
				act(() => {
					view.rerender(<Harness initial={threeWindowDesk()} sent={sent} traffic={tick} />);
					vi.advanceTimersByTime(100);
				});
			}
			act(() => void vi.advanceTimersByTime(200));

			expect(sent.filter((msg) => msg.type === "prefix.repeatLapsed")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never runs for a prefix armed by hand: that one waits indefinitely (#7842)", () => {
		vi.useFakeTimers();
		try {
			const sent: Array<ShellMsg> = [];
			render(<Harness initial={threeWindowDesk()} sent={sent} />);
			act(arm);

			act(() => void vi.advanceTimersByTime(30_000));

			expect(sent.filter((msg) => msg.type === "prefix.repeatLapsed")).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
			expect(screen.getByText("armed")).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("Escape drops the armed prefix back to idle", () => {
		const sent: Array<ShellMsg> = [];
		render(<Harness initial={threeWindowDesk()} sent={sent} />);
		act(arm);
		expect(screen.getByText("armed")).toBeTruthy();

		act(() => void fireEvent.keyDown(document, {key: "Escape", code: "Escape"}));
		expect(screen.getByText("idle")).toBeTruthy();
	});
});

const KeySpy = ({
	windowId,
	received,
}: {
	readonly windowId: WindowId;
	readonly received: Array<string>;
}): ReactElement => {
	useForwardedKey(windowId, (key) => void received.push(key));
	return <p>renderer for {String(windowId)}</p>;
};

/** Every window bound to a renderer that records the keys the desk forwards into it. */
const spyingOn = (received: Array<string>): MountResolver =>
	boundTo((host) => <KeySpy windowId={host.windowId} received={received} />);

/**
 * The kernel is the only router, so a key typed faster than one round trip is not routed twice —
 * it is not routed on the page at all (#8274). Every test here holds the kernel's answers back and
 * releases them by hand, which is the snapshot that does not move between two presses.
 */
describe("a sequence typed faster than one kernel round trip (#8274)", () => {
	const press = (init: Record<string, unknown>): boolean => {
		let answered = true;
		act(() => {
			answered = fireEvent.keyDown(document, init);
		});
		return answered;
	};

	const repeatTimeoutMs = Duration.toMillis(defaultPrefixTable.repeatTimeout);
	const idleDesk = threeWindowDesk("window-1");
	const armedMark = (): boolean =>
		document.querySelector(".tuval-surface")?.hasAttribute("data-prefix-armed") === true;

	it("routes `<c-b> h` as the bound command, not as `h` to the window", async () => {
		const sent: Array<ShellMsg> = [];
		const received: Array<string> = [];
		const replies: Array<() => void> = [];
		render(
			<Harness
				initial={idleDesk}
				sent={sent}
				replies={replies}
				resolveMount={spyingOn(received)}
			/>,
		);

		const prefixPrevented = press({key: "b", ctrlKey: true, code: "KeyB"});
		const commandPrevented = press({key: "h", code: "KeyH"});

		expect(sent).toEqual([
			expect.objectContaining({
				type: "keys.press",
				key: expect.objectContaining({key: "b", ctrlKey: true}),
			}),
			expect.objectContaining({type: "keys.press", key: expect.objectContaining({key: "h"})}),
		]);
		expect([prefixPrevented, commandPrevented]).toEqual([false, false]);
		// Both answers now land. `h` completed `window:focus-left`, so nothing was ever the window's.
		await answer(replies, 2);
		expect(received).toEqual([]);
	});

	it("routes `<c-b> |` as the split, so no pipe reaches the window either", async () => {
		const sent: Array<ShellMsg> = [];
		const received: Array<string> = [];
		const replies: Array<() => void> = [];
		render(
			<Harness
				initial={idleDesk}
				sent={sent}
				replies={replies}
				resolveMount={spyingOn(received)}
			/>,
		);

		press({key: "b", ctrlKey: true, code: "KeyB"});
		const splitPrevented = press({key: "|", code: "Backslash", shiftKey: true});

		expect(sent).toHaveLength(2);
		expect(splitPrevented).toBe(false);
		await answer(replies, 2);
		expect(received).toEqual([]);
		expect(screen.getAllByRole("region", {name: /^Window /})).toHaveLength(4);
	});

	it("still hands a plain key to the focused window while the prefix is idle", async () => {
		const sent: Array<ShellMsg> = [];
		const received: Array<string> = [];
		render(<Harness initial={idleDesk} sent={sent} resolveMount={spyingOn(received)} />);

		let notPrevented = false;
		await act(async () => {
			notPrevented = fireEvent.keyDown(document, {key: "h", code: "KeyH"});
		});

		expect(received).toEqual(["h"]);
		expect(notPrevented).toBe(true);
	});

	it("starts the repeat countdown at the answer, with no state frame arriving first", () => {
		vi.useFakeTimers();
		try {
			const sent: Array<ShellMsg> = [];
			render(<Harness initial={idleDesk} sent={sent} />);

			press({key: "b", ctrlKey: true, code: "KeyB"});
			// `<c-l>` is `workspace:next`, the `repeatable: true` binding that opens the 500ms window.
			press({key: "l", ctrlKey: true, code: "KeyL"});
			expect(sent.filter((msg) => msg.type === "prefix.repeatLapsed")).toHaveLength(0);

			act(() => void vi.advanceTimersByTime(repeatTimeoutMs));

			expect(sent.filter((msg) => msg.type === "prefix.repeatLapsed")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("forwards nothing while an answer is outstanding, whatever the snapshot says", async () => {
		const sent: Array<ShellMsg> = [];
		const received: Array<string> = [];
		const replies: Array<() => void> = [];
		render(
			<Harness
				initial={idleDesk}
				sent={sent}
				replies={replies}
				resolveMount={spyingOn(received)}
			/>,
		);

		// Two presses in flight. The snapshot has not moved, so a page routing over it would read
		// `w` as a plain key and hand it to the window; the kernel reads it as `window:pick`.
		press({key: "b", ctrlKey: true, code: "KeyB"});
		press({key: "w", code: "KeyW"});
		expect(received).toEqual([]);

		await answer(replies, 2);
		expect(received).toEqual([]);
		// `window:pick` unbound the focused window, so its mount is the picker (#8083).
		expect(
			within(screen.getByLabelText("Window window-1")).getByRole("listbox", {
				name: /Open a program/,
			}),
		).toBeTruthy();
	});

	// Three presses is where the page-held prefix of rounds 1 and 2 broke: the sequence has cycled
	// back through the page's own value, so an early frame matches it while later presses are still
	// out. Nothing here is held on the page, so there is nothing to match against (#8274).
	it("keeps a three-press sequence the kernel's, frame by frame", async () => {
		const sent: Array<ShellMsg> = [];
		const received: Array<string> = [];
		const replies: Array<() => void> = [];
		render(
			<Harness
				initial={idleDesk}
				sent={sent}
				replies={replies}
				resolveMount={spyingOn(received)}
			/>,
		);

		press({key: "b", ctrlKey: true, code: "KeyB"});
		press({key: "h", code: "KeyH"});
		press({key: "b", ctrlKey: true, code: "KeyB"});
		// The kernel's answers to presses 1 and 2, one at a time: armed, then idle again.
		await answer(replies, 2);
		expect(armedMark()).toBe(false);
		// Press 3 armed the kernel and its answer is still out, so `j` is the shell's: the desk
		// forwards nothing and prevents the default rather than guessing off a snapshot it knows is
		// one press behind.
		const prevented = press({key: "j", code: "KeyJ"});

		expect(received).toEqual([]);
		expect(prevented).toBe(false);
		await answer(replies, 2);
		expect(received).toEqual([]);
	});

	// The mirror: four presses leave the kernel idle, so the fifth key is the window's — and it
	// reaches the window on the kernel's own answer, however far behind the snapshot is.
	it("hands the window a key the kernel routed to it, four presses in", async () => {
		const sent: Array<ShellMsg> = [];
		const received: Array<string> = [];
		const replies: Array<() => void> = [];
		render(
			<Harness
				initial={idleDesk}
				sent={sent}
				replies={replies}
				resolveMount={spyingOn(received)}
			/>,
		);

		press({key: "b", ctrlKey: true, code: "KeyB"});
		press({key: "h", code: "KeyH"});
		press({key: "b", ctrlKey: true, code: "KeyB"});
		press({key: "h", code: "KeyH"});
		press({key: "j", code: "KeyJ"});

		expect(received).toEqual([]);
		await answer(replies, 5);
		expect(received).toEqual(["j"]);
	});

	// Criterion 10's ledger is gone with the ledger. Every answer landing in one React commit is
	// just five answers: there is no per-frame bookkeeping left to under-count.
	it("loses nothing when every answer lands in one commit", async () => {
		const sent: Array<ShellMsg> = [];
		const received: Array<string> = [];
		const replies: Array<() => void> = [];
		render(
			<Harness
				initial={idleDesk}
				sent={sent}
				replies={replies}
				resolveMount={spyingOn(received)}
			/>,
		);

		press({key: "b", ctrlKey: true, code: "KeyB"});
		press({key: "h", code: "KeyH"});
		press({key: "b", ctrlKey: true, code: "KeyB"});
		await act(async () => {
			for (const settle of replies.splice(0)) settle();
		});

		expect(armedMark()).toBe(true);
		expect(received).toEqual([]);
		// Nothing is outstanding and the kernel is armed, so `j` is `window:focus-down`.
		press({key: "j", code: "KeyJ"});
		await answer(replies);
		expect(received).toEqual([]);
		expect(armedMark()).toBe(false);
	});

	// Criterion 9: a press the kernel never applies. The transport drops an in-flight dispatch on a
	// socket drop and answers `ProcessGone`, which reads as `Refused` — nothing is forwarded, and
	// the desk is still on the kernel's own prefix for every key after it.
	it("returns to the kernel's prefix after a press the kernel never answers", async () => {
		const sent: Array<ShellMsg> = [];
		const received: Array<string> = [];
		render(
			<Harness initial={idleDesk} sent={sent} dropFirst={1} resolveMount={spyingOn(received)} />,
		);

		// The arming press is lost on the wire, so the kernel never armed.
		await act(async () => {
			fireEvent.keyDown(document, {key: "b", ctrlKey: true, code: "KeyB"});
		});
		expect(sent).toEqual([]);
		expect(armedMark()).toBe(false);

		// Every later key is answered by the kernel as it actually stands, not by a page one press
		// out of phase: `h` is the window's, and so is the next one.
		await act(async () => {
			fireEvent.keyDown(document, {key: "h", code: "KeyH"});
		});
		await act(async () => {
			fireEvent.keyDown(document, {key: "j", code: "KeyJ"});
		});

		expect(received).toEqual(["h", "j"]);
		expect(armedMark()).toBe(false);
	});

	it("takes a prefix the kernel moved out of band, with nothing in flight", async () => {
		const sent: Array<ShellMsg> = [];
		const received: Array<string> = [];
		const mount = spyingOn(received);
		const armedDesk = applyMsg(defaultPrefixTable, idleDesk, {
			type: "keys.press",
			key: {key: "b", ctrlKey: true},
		})[0];
		const view = render(
			<Harness initial={idleDesk} sent={sent} frame={armedDesk} resolveMount={mount} />,
		);
		expect(armedMark()).toBe(true);

		// The kernel reports idle with nothing outstanding — an Escape or a lapse it folded itself.
		act(() => {
			view.rerender(
				<Harness initial={idleDesk} sent={sent} frame={idleDesk} resolveMount={mount} />,
			);
		});
		expect(armedMark()).toBe(false);

		await act(async () => {
			fireEvent.keyDown(document, {key: "j", code: "KeyJ"});
		});
		expect(received).toEqual(["j"]);
	});
});

describe("the palette's door", () => {
	it("opens on Cmd+K and leaves the caret on the desk when nothing else can take it", async () => {
		const {container} = render(<Harness initial={threeWindowDesk("window-1")} sent={[]} />);
		// window-1 is bound, so no picker listbox takes the caret and `document.body` holds it: the
		// desk nobody has clicked yet, which is where Esc used to strand focus.
		expect(document.activeElement).toBe(document.body);

		fireEvent.keyDown(document, {key: "k", metaKey: true, code: "KeyK"});
		const input = screen.getByRole("combobox", {name: "Run a spell"});
		expect(document.activeElement).toBe(input);

		fireEvent.keyDown(input, {key: "Escape"});
		expect(screen.queryByRole("combobox", {name: "Run a spell"})).toBeNull();
		// The dialog gives the caret up as it unmounts, a frame after the handler returns.
		await waitFor(() =>
			expect(document.activeElement).toBe(container.querySelector(".tuval-surface")),
		);
	});
});

/**
 * The desk with a stand-in for the kernel's spawn: `window.open` answers with a Cmd whose reply is
 * `window.bind` (`../core/machine.ts`), and the harnesses above drop Cmds — so without this the
 * window never fills, which is the half of the journey below that matters.
 */
function PickJourney({
	initial,
	sent,
	rows,
	strict = false,
}: {
	readonly initial: ShellState;
	readonly sent: Array<ShellMsg>;
	readonly rows: PickerEntries;
	readonly strict?: boolean;
}): ReactElement {
	const [state, setState] = useState(initial);
	const dispatch = (msg: ShellMsg): void => {
		sent.push(msg);
		setState((current) => {
			const [next] = applyMsg(defaultPrefixTable, current, msg);
			if (msg.type !== "window.open") return next;
			return applyMsg(defaultPrefixTable, next, {
				type: "window.bind",
				windowId: msg.windowId,
				processId: `process-${msg.programId}`,
				takesKeys: true,
			})[0];
		});
	};
	const desk = (
		<Desk
			state={state}
			dispatch={dispatch}
			resolveMount={boundEverywhere}
			entries={rows}
			table={defaultPrefixTable}
		/>
	);
	return strict ? <StrictMode>{desk}</StrictMode> : desk;
}

/** Two rows, so a move has somewhere to go: a one-row picker clamps `j` back onto the cursor. */
const twoPrograms: PickerEntries = {
	programs: [
		{_tag: "Program", programId: ProgramId.make("counter"), label: "Counter"},
		{_tag: "Program", programId: ProgramId.make("clock"), label: "Clock"},
	],
	processes: [],
};

const bindMsgs = (sent: Array<ShellMsg>): Array<ShellMsg> =>
	sent.filter((msg) => msg.type === "window.open" || msg.type === "window.attach");

describe("`<c-b> w` on a filled window stays on the picker (#8279)", () => {
	/** Choose `counter` with `<enter>`, then press `<c-b> w`. Returns what the pick alone sent. */
	const journey = (strict: boolean): Array<ShellMsg> => {
		const sent: Array<ShellMsg> = [];
		render(
			<PickJourney
				initial={threeWindowDesk("window-2")}
				sent={sent}
				rows={twoPrograms}
				strict={strict}
			/>,
		);
		act(() => void fireEvent.keyDown(document, {key: "Enter", code: "Enter"}));
		expect(screen.getByText("renderer for process-counter")).toBeTruthy();

		sent.length = 0;
		// Two acts, never one: the page routes each press against the snapshot it has, so a `w`
		// batched with the prefix that armed it is routed as a plain key and forwarded — #8274, a
		// different bug and a different lane.
		act(arm);
		act(() => void fireEvent.keyDown(document, {key: "w", code: "KeyW"}));
		return sent;
	};

	it("mounts the picker and re-binds nothing", () => {
		const sent = journey(false);
		expect(screen.getByRole("listbox", {name: /Open a program/})).toBeTruthy();
		expect(bindMsgs(sent)).toEqual([]);
	});

	it("re-binds nothing under StrictMode either, where a mount effect runs twice", () => {
		const sent = journey(true);
		expect(screen.getByRole("listbox", {name: /Open a program/})).toBeTruthy();
		expect(bindMsgs(sent)).toEqual([]);
	});

	it("still forwards a key to the picker it just mounted", () => {
		const sent = journey(false);
		act(() => void fireEvent.keyDown(document, {key: "j", code: "KeyJ"}));

		// `toMatchObject`, not `toEqual`: the picker's view slot is `picker/view.ts`'s to shape, and
		// this test owns only that the key reached the picker and moved its cursor.
		expect(sent.filter((msg) => msg.type === "window.setView")).toMatchObject([
			{type: "window.setView", windowId: "window-2", view: {cursor: 1, refusal: null}},
		]);
		expect(bindMsgs(sent)).toEqual([]);
	});
});
