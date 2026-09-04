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

import {act, fireEvent, render, screen, within} from "@testing-library/react";
import type {ReactElement} from "react";
import {useEffect, useState} from "react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import type {ShellMsg, ShellState} from "../core/index.ts";
import {applyMsg} from "../core/index.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import type {PickerEntries} from "../picker/index.ts";
import {empty, processGone} from "../window/index.ts";
import {Desk} from "./Desk.tsx";
import {installDomShims} from "./dom.testing.ts";
import {threeWindowDesk} from "./fixtures.ts";
import {type MountResolver, noRenderer} from "./mount.ts";

installDomShims();

const entries: PickerEntries = {
	programs: [{_tag: "Program", programId: ProgramId.make("counter"), label: "Counter"}],
	processes: [],
};

/** Every window bound, every renderer a paragraph naming its process. */
const boundEverywhere: MountResolver = (windowId, processId) =>
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
				render: (host) => <p>renderer for {String(host.processId)}</p>,
			};

interface HarnessProps {
	readonly initial: ShellState;
	readonly sent: Array<ShellMsg>;
	readonly resolveMount?: MountResolver;
}

function Harness({initial, sent, resolveMount = boundEverywhere}: HarnessProps): ReactElement {
	const [state, setState] = useState(initial);
	return (
		<Desk
			state={state}
			dispatch={(msg) => {
				sent.push(msg);
				setState((current) => applyMsg(defaultPrefixTable, current, msg)[0]);
			}}
			resolveMount={resolveMount}
			entries={entries}
		/>
	);
}

const arm = (): void => {
	fireEvent.keyDown(document, {key: "b", ctrlKey: true, code: "KeyB"});
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
		expect(sent).toEqual([{type: "keys.press", key: expect.objectContaining({key: "j"})}]);
	});

	it("adds no second listener when the command line opens", () => {
		render(<Harness initial={threeWindowDesk()} sent={[]} />);
		arm();
		fireEvent.keyDown(document, {key: ":", code: "Semicolon", shiftKey: true});

		expect(screen.getByLabelText("Type a command")).toBeTruthy();
		expect(added.filter((type) => type === "keydown")).toHaveLength(1);
	});
});

describe("the command line", () => {
	it("opens on `prefix :` and dispatches the Msg a typed row names", () => {
		const sent: Array<ShellMsg> = [];
		render(<Harness initial={threeWindowDesk()} sent={sent} />);

		expect(screen.queryByLabelText("Type a command")).toBeNull();
		arm();
		fireEvent.keyDown(document, {key: ":", code: "Semicolon", shiftKey: true});

		const input = screen.getByLabelText("Type a command");
		fireEvent.change(input, {target: {value: "workspace:create"}});
		act(() => {
			fireEvent.submit(input);
		});

		expect(sent).toContainEqual({type: "workspace.create"});
		expect(screen.queryByLabelText("Type a command")).toBeNull();
	});

	it("shows the row's own refusal and stays open on a line it cannot read", () => {
		const sent: Array<ShellMsg> = [];
		render(<Harness initial={threeWindowDesk()} sent={sent} />);
		arm();
		fireEvent.keyDown(document, {key: ":", code: "Semicolon", shiftKey: true});

		const input = screen.getByLabelText("Type a command");
		fireEvent.change(input, {target: {value: "workspace:nope"}});
		act(() => {
			fireEvent.submit(input);
		});

		expect(screen.getByRole("alert").textContent).toMatch(/workspace:nope/);
		expect(screen.getByLabelText("Type a command")).toBeTruthy();
		expect(sent.filter((msg) => msg.type !== "keys.press")).toEqual([]);
	});

	it("does not read the desk's keys while it is open", () => {
		const sent: Array<ShellMsg> = [];
		render(<Harness initial={threeWindowDesk()} sent={sent} />);
		arm();
		fireEvent.keyDown(document, {key: ":", code: "Semicolon", shiftKey: true});
		const before = sent.length;

		fireEvent.keyDown(screen.getByLabelText("Type a command"), {key: "x"});
		expect(sent).toHaveLength(before);
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

/**
 * The harness above keeps one desk object across renders; this one re-decodes it, which is what a
 * live socket does — every snapshot is fresh JSON, equal in value and new in identity.
 */
function DecodedHarness({
	sent,
	snapshots,
}: {
	readonly sent: Array<ShellMsg>;
	readonly snapshots: number;
}): ReactElement {
	const [state, setState] = useState<ShellState>(threeWindowDesk());
	useEffect(() => {
		if (snapshots > 0) setState((current) => JSON.parse(JSON.stringify(current)) as ShellState);
	}, [snapshots]);
	return (
		<Desk
			state={state}
			dispatch={(msg) => {
				sent.push(msg);
				setState(
					(current) =>
						JSON.parse(JSON.stringify(applyMsg(defaultPrefixTable, current, msg)[0])) as ShellState,
				);
			}}
			resolveMount={boundEverywhere}
			entries={entries}
		/>
	);
}

describe("the prefix countdown", () => {
	it("times out on its own clock, however much unrelated kernel traffic arrives (#7782)", () => {
		vi.useFakeTimers();
		try {
			const sent: Array<ShellMsg> = [];
			const view = render(<DecodedHarness sent={sent} snapshots={0} />);
			act(arm);

			// Ten snapshots over one armed second: a demo counter ticking at 100ms, and nothing about
			// the prefix changing. A countdown keyed on the snapshot object re-armed on every one of
			// these and never fired.
			for (let tick = 1; tick <= 10; tick++) {
				act(() => {
					view.rerender(<DecodedHarness sent={sent} snapshots={tick} />);
					vi.advanceTimersByTime(100);
				});
			}
			act(() => void vi.advanceTimersByTime(200));

			expect(sent.filter((msg) => msg.type === "prefix.timeout")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
