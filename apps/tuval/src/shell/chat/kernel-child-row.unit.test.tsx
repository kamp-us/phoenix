/**
 * @vitest-environment jsdom
 *
 * A kernel child in its parent's sub-agent list (#8719): the row, its mark, and the two things
 * activating a row can do.
 *
 * The whole window is mounted, because the case is what an operator sees and reaches. What the list
 * is a list *of* is proven without a DOM in `./subagents.unit.test.ts`.
 *
 * **Enter and Space are the platform's.** jsdom implements no activation behaviour, so a `keyDown`
 * on a button fires no click there; what the keyboard needs is a real `button` it can reach, and
 * these cases read that — focus lands on a `button`, and clicking it runs the same handler
 * (`../ui/press.ts`'s reasoning, and `./subagent-navigator.unit.test.tsx`'s).
 */

import {act, fireEvent, render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {SubagentSlot} from "../../ai-agent/ports/index.ts";
import {subagentSlot} from "../../ai-agent-fixtures/transcripts.ts";
import {ProcessId} from "../../process/process.ts";
import {applyMsg, initialState, openProcessMsg} from "../core/machine.ts";
import {activeWorkspace, type ShellState, windowIds} from "../core/state.ts";
import {defaultPrefixTable, FOCUS_LIST_KEY} from "../keys/index.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {ForwardedKeyProvider} from "../ui/forwarded-key.tsx";
import {testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {type ChatWindowOptions, chatWindow} from "./ChatWindow.tsx";
import {call, userItem, withTranscript} from "./chat.testing.ts";
import {initialChatView} from "./view.ts";

installDomShims();

const WINDOW = WindowId.make("w1");
const STARTED_AT = 1_756_000_000_000;

const slots = (...entries: ReadonlyArray<SubagentSlot>): Record<string, SubagentSlot> =>
	Object.fromEntries(entries.map((slot) => [slot.id, slot]));

/** One worker the backend spawned and one process the kernel did — the case's whole subject. */
const both = (): AiAgentSessionState =>
	withTranscript([userItem("u1", "go"), call("worker", {name: "Agent"})], {
		subagents: slots(
			// Explicit clocks: the list is oldest-first, so this is what fixes which row is which.
			subagentSlot("worker", {
				type: "reviewer",
				lastLine: "reading rows.ts",
				startedAt: STARTED_AT,
			}),
			subagentSlot("spawn", {
				type: "tuval/claude",
				lastLine: "",
				tokens: 0,
				startedAt: STARTED_AT + 1_000,
				process: "p-9",
			}),
		),
	});

const openWindow = async (state: AiAgentSessionState, options: ChatWindowOptions = {}) => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host = await Effect.runPromise(process.window(WINDOW, initialChatView));
	const renderer = chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined, ...options});
	const stage = (key: string | null, seq: number): ReactElement => (
		<ForwardedKeyProvider value={key === null ? null : {windowId: WINDOW, key, seq}}>
			{renderer.render(host) as ReactElement}
		</ForwardedKeyProvider>
	);
	const rendered = render(stage(null, 0));
	await screen.findByRole("log", {name: /^Transcript/});
	let seq = 0;
	return {
		rendered,
		process,
		chord: async () => {
			seq += 1;
			await act(async () => {
				rendered.rerender(stage(FOCUS_LIST_KEY, seq));
			});
		},
	};
};

const rows = (): ReadonlyArray<HTMLButtonElement> =>
	Array.from(
		document.querySelectorAll<HTMLButtonElement>(
			".tuval-chat-subagent-pick:not(.tuval-chat-subagent-more)",
		),
	);

const fieldsOf = (row: HTMLElement): Record<string, string> =>
	Object.fromEntries(
		Array.from(row.querySelectorAll<HTMLElement>("[data-field]")).map((field) => [
			field.dataset.field,
			field.textContent ?? "",
		]),
	);

const click = async (node: HTMLElement) => {
	await act(async () => {
		node.click();
	});
};

const press = async (key: string) => {
	await act(async () => {
		fireEvent.keyDown(document.activeElement as HTMLElement, {key, bubbles: true});
	});
};

/**
 * A desk the row's activation is driven into for real, wired the way the page wires it
 * (`../../page/boot.tsx`): the Msg goes through the shell reducer, so a case reads the window the
 * operator gets rather than that some callback was called. A stub records the call and would have
 * agreed with an attach that consumed the parent's own window.
 */
const desk = () => {
	let state = initialState();
	const attached: Array<{readonly processId: string; readonly windowId: string}> = [];
	const parent = focusedWindow(state);
	return {
		parent,
		attached,
		windows: () => windowIds(workspaceOf(state)),
		open: (processId: string) => {
			const [next, cmds] = applyMsg(defaultPrefixTable, state, openProcessMsg(processId));
			state = next;
			for (const cmd of cmds) {
				if (cmd.type === "attachProcess")
					attached.push({processId: cmd.processId, windowId: cmd.windowId});
			}
		},
	};
};

const workspaceOf = (state: ShellState) => {
	const workspace = activeWorkspace(state);
	if (workspace === undefined) throw new Error("test setup: no active workspace");
	return workspace;
};

const focusedWindow = (state: ShellState): string => workspaceOf(state).focused;

/** A route that exists but is never activated, for the cases about what a row *says*. */
const ignore = (): void => undefined;

/** The flag on, with the route a window needs before it may draw a row that claims to open one. */
const flagged = (open: (processId: string) => void): ChatWindowOptions => ({
	subagentList: true,
	kernelChildren: true,
	openProcess: open,
});

describe("a kernel child in the sub-agent list", () => {
	it("is a row of the list beside the backend's own worker", async () => {
		const {rendered} = await openWindow(both(), flagged(ignore));
		expect(rows().map((row) => fieldsOf(row).type)).toEqual(["reviewer", "tuval/claude"]);
		rendered.unmount();
	});

	// Pillar 4: the mark is a word in the row's own text, so it survives a reader who sees no colour
	// and a screen reader that reads none.
	it("is marked as a process, in text rather than by colour", async () => {
		const {rendered} = await openWindow(both(), flagged(ignore));
		const [worker, child] = rows();
		expect(fieldsOf(worker as HTMLElement).kernel).toBeUndefined();
		expect(fieldsOf(child as HTMLElement).kernel).toContain("process");
		expect(child?.textContent).toContain("opens in its own window");
		rendered.unmount();
	});

	it("draws no token count, which its parent knows nothing about", async () => {
		const {rendered} = await openWindow(both(), flagged(ignore));
		const [worker, child] = rows();
		expect(fieldsOf(worker as HTMLElement).tokens).toBeDefined();
		expect(fieldsOf(child as HTMLElement).tokens).toBeUndefined();
		rendered.unmount();
	});

	it("opens as its own window when activated, where a worker's row swaps the view", async () => {
		const shell = desk();
		const {rendered} = await openWindow(both(), flagged(shell.open));

		await click(rows()[1] as HTMLElement);
		// A window of the child's own, beside the parent's rather than instead of it: the desk holds
		// two windows now, and the attach landed on the one the activation minted.
		const [parent, opened] = shell.windows();
		expect(parent).toBe(shell.parent);
		expect(opened).toBeDefined();
		expect(shell.attached).toEqual([{processId: "p-9", windowId: opened}]);
		// The parent's own window kept its transcript: no way-back row was added.
		expect(rows()[0]?.textContent).not.toBe("Back to the agent transcript");

		await click(rows()[0] as HTMLElement);
		expect(shell.windows()).toHaveLength(2);
		expect(rows()[0]?.textContent).toBe("Back to the agent transcript");

		rendered.unmount();
	});

	it("reaches both by keyboard, through the handlers the mouse calls", async () => {
		const opened: Array<string> = [];
		const {rendered, chord} = await openWindow(
			both(),
			flagged((processId) => opened.push(processId)),
		);

		await chord();
		expect(document.activeElement).toBe(rows()[0]);
		await press("ArrowDown");
		const focused = document.activeElement as HTMLButtonElement;
		expect(focused).toBe(rows()[1]);
		expect(focused.tagName).toBe("BUTTON");

		await click(focused);
		expect(opened).toEqual(["p-9"]);

		rendered.unmount();
	});

	// The containment: a slot written while the flag was on must not keep a row once it is off.
	it("is not in the list at all with the flag off, which leaves the list as it is today", async () => {
		const {rendered} = await openWindow(both(), {subagentList: true});
		expect(rows().map((row) => fieldsOf(row).type)).toEqual(["reviewer"]);
		rendered.unmount();
	});

	// A row saying "opens in its own window" that no route can open would be a row that lies.
	it("is not drawn when the window was built with no way to open a process", async () => {
		const {rendered} = await openWindow(both(), {subagentList: true, kernelChildren: true});
		expect(rows().map((row) => fieldsOf(row).type)).toEqual(["reviewer"]);
		rendered.unmount();
	});
});
