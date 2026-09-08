/**
 * @vitest-environment jsdom
 *
 * The navigator under a hand (#8407): `<c-b> a` arriving as the forwarded key, the arrows walking
 * the rows, the way back, the tail's door — and the mouse doing all of it through the same handlers.
 *
 * The chord's route through the key router and the command table is proven without a DOM in
 * `../core/machine.unit.test.ts`; what is proven here is the other end of it, where the key lands.
 *
 * **Enter and Space are the platform's, not this window's.** jsdom implements no activation
 * behaviour, so a `keyDown` on a button fires no click there and asserting one would test the test.
 * What the keyboard needs is a real `button` it can reach, and that is what these cases read: the
 * element focus lands on is a `button`, and clicking it runs the same handler the mouse runs. The
 * shipped a11y pass makes the same call for the same reason.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {act, fireEvent, render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {SubagentSlot} from "../../ai-agent/ports/index.ts";
import {subagentSlot} from "../../ai-agent-fixtures/transcripts.ts";
import {ProcessId} from "../../process/process.ts";
import {FOCUS_LIST_KEY} from "../keys/index.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {ForwardedKeyProvider} from "../ui/forwarded-key.tsx";
import {testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {type ChatWindowOptions, chatWindow} from "./ChatWindow.tsx";
import {call, userItem, withTranscript} from "./chat.testing.ts";
import {SUBAGENT_ROW_CAP} from "./subagents.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

const WINDOW = WindowId.make("w1");

const slots = (...entries: ReadonlyArray<SubagentSlot>): Record<string, SubagentSlot> =>
	Object.fromEntries(entries.map((slot) => [slot.id, slot]));

/** Two running workers and the call that spawned one of them — the ordinary shape of the list. */
const twoRunning = (): AiAgentSessionState =>
	withTranscript([userItem("u1", "go"), call("agent", {name: "Agent"})], {
		subagents: slots(
			subagentSlot("agent", {type: "reviewer", lastLine: "reading rows.ts"}),
			subagentSlot("other", {type: "builder", lastLine: "writing the test"}),
		),
	});

/**
 * A window mounted under a forwarded-key provider, so a test can press the chord the way the desk
 * delivers it: one bump of `seq`, which is the only thing that makes two presses two events.
 */
const openWindow = async (
	state: AiAgentSessionState,
	options: ChatWindowOptions = {},
	view: ChatView = initialChatView,
) => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host = await Effect.runPromise(process.window(WINDOW, view));
	const renderer = chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined, ...options});
	const stage = (key: string | null, seq: number): ReactElement => (
		<ForwardedKeyProvider value={key === null ? null : {windowId: WINDOW, key, seq}}>
			{renderer.render(host) as ReactElement}
		</ForwardedKeyProvider>
	);
	const rendered = render(stage(null, 0));
	await screen.findByRole("log", {name: /^Transcript/});
	let seq = 0;
	const forward = async (key: string) => {
		seq += 1;
		await act(async () => {
			rendered.rerender(stage(key, seq));
		});
	};
	return {rendered, process, chord: () => forward(FOCUS_LIST_KEY), forward};
};

const active = (): HTMLElement => document.activeElement as HTMLElement;
/** Re-read on every use: Manti owns the field, so a case asserting across a swap would hold a
 * node React has since replaced. */
const composer = (): HTMLTextAreaElement => {
	const found = document.querySelector<HTMLTextAreaElement>("textarea");
	expect(found, "no composer field").toBeTruthy();
	return found as HTMLTextAreaElement;
};
const rows = (): ReadonlyArray<HTMLButtonElement> =>
	Array.from(
		document.querySelectorAll<HTMLButtonElement>(
			".tuval-chat-subagent-pick:not(.tuval-chat-subagent-more)",
		),
	);

const press = async (key: string) => {
	await act(async () => {
		fireEvent.keyDown(active(), {key, bubbles: true});
	});
};

const click = async (node: HTMLElement) => {
	await act(async () => {
		node.click();
	});
};

describe("<c-b> a and the list it lands in", () => {
	it("puts focus on a row of the list, and the arrows walk it", async () => {
		const {rendered, chord} = await openWindow(twoRunning(), {subagentList: true});
		expect(active().className).not.toContain("tuval-chat-subagent-pick");

		await chord();
		expect(active()).toBe(rows()[0]);
		expect(active().tagName).toBe("BUTTON");

		await press("ArrowDown");
		expect(active()).toBe(rows()[1]);
		// Clamped at the end rather than wrapped: the walk stops where the list does.
		await press("ArrowDown");
		expect(active()).toBe(rows()[1]);
		await press("ArrowUp");
		expect(active()).toBe(rows()[0]);
		await press("End");
		expect(active()).toBe(rows()[1]);
		await press("Home");
		expect(active()).toBe(rows()[0]);

		rendered.unmount();
	});

	it("holds one tab stop, and it is the row the window is showing", async () => {
		const {rendered, chord} = await openWindow(twoRunning(), {subagentList: true});
		expect(rows().map((row) => row.tabIndex)).toEqual([0, -1]);

		await chord();
		await press("ArrowDown");
		expect(rows().map((row) => row.tabIndex)).toEqual([-1, 0]);

		// Opening the second row keeps the stop on it, so the chord comes back to where they were.
		await click(rows()[1] as HTMLElement);
		const [back, ...opened] = rows();
		expect(back?.textContent).toBe("Back to the agent transcript");
		expect(opened.map((row) => row.tabIndex)).toEqual([-1, 0]);
		expect(opened[1]?.getAttribute("aria-current")).toBe("true");

		rendered.unmount();
	});

	it("opens the focused row in place, through the button the mouse clicks", async () => {
		const {rendered, chord} = await openWindow(twoRunning(), {subagentList: true});
		await chord();
		await click(active());

		expect(screen.getByRole("log", {name: "Transcript: reviewer subagent"})).toBeTruthy();
		rendered.unmount();
	});

	it("comes back to main from the way-back row, and leaves focus on the composer", async () => {
		const {rendered, chord} = await openWindow(twoRunning(), {subagentList: true});
		await chord();
		await click(active());

		const back = rows()[0] as HTMLButtonElement;
		expect(back.textContent).toBe("Back to the agent transcript");
		await click(back);

		expect(screen.getByRole("log", {name: "Transcript"})).toBeTruthy();
		// The navigator survives here — two workers are still running — and focus still leaves it:
		// the destination is the composer whether or not the list outlives the view.
		expect(rows()).toHaveLength(2);
		expect(composer().disabled).toBe(false);
		expect(active()).toBe(composer());
		rendered.unmount();
	});

	it("comes back to main on Escape from inside a subagent view, onto the composer", async () => {
		const {rendered, chord} = await openWindow(twoRunning(), {subagentList: true});
		await chord();
		await click(active());
		expect(screen.getByRole("log", {name: "Transcript: reviewer subagent"})).toBeTruthy();

		await press("Escape");
		expect(screen.getByRole("log", {name: "Transcript"})).toBeTruthy();
		expect(composer().disabled).toBe(false);
		expect(active()).toBe(composer());
		rendered.unmount();
	});

	it("leaves Escape to the window while it is already on main, so a turn can still be cut", async () => {
		const state = withTranscript([userItem("u1", "go")], {
			phase: "prompting",
			subagents: slots(subagentSlot("agent", {type: "reviewer"})),
		});
		const {rendered, process, chord} = await openWindow(state, {subagentList: true});
		await chord();
		await press("Escape");

		expect(process.inbox().map((msg) => msg.type)).toContain("interrupt");
		rendered.unmount();
	});

	it("expands the tail from the more row and lands focus on the first row it revealed", async () => {
		const running = Array.from({length: 8}, (_, index) =>
			subagentSlot(`s${index}`, {type: `worker-${index}`, startedAt: 1_756_000_000_000 + index}),
		);
		const {rendered, chord} = await openWindow(
			withTranscript([userItem("u1", "go")], {subagents: slots(...running)}),
			{subagentList: true},
		);
		expect(rows()).toHaveLength(SUBAGENT_ROW_CAP);
		const more = screen.getByRole("button", {name: "Show 3 more running"});

		await chord();
		await press("End");
		expect(active()).toBe(more);
		await click(more);

		expect(rows()).toHaveLength(8);
		expect(screen.queryByRole("button", {name: /more running$/})).toBeNull();
		expect(active()).toBe(rows()[SUBAGENT_ROW_CAP]);
		rendered.unmount();
	});
});

/**
 * The path where the region itself goes: the only worker finishes under its own open view, so
 * leaving lands on a window with no navigator at all. Before the founder's 2026-09-08 ruling on
 * #8470 the list asked for its own first line here and there was none, which put focus on the body.
 */
describe("leaving the last finished worker", () => {
	/** One worker, so main has nothing to list once it has stopped. */
	const one = (status: SubagentSlot["status"]): AiAgentSessionState =>
		withTranscript([userItem("u1", "go"), call("agent", {name: "Agent"})], {
			subagents: slots(subagentSlot("agent", {type: "reviewer", lastLine: "wrote 4 rows", status})),
		});

	const openFinished = async () => {
		const opened = await openWindow(one("running"), {subagentList: true});
		await opened.chord();
		await click(active());
		await act(async () => {
			await Effect.runPromise(opened.process.commit(one("finished")));
		});
		// Q9 on #8384, unchanged: the view it finished under stays open until the operator leaves.
		expect(screen.getByRole("log", {name: "Transcript: reviewer subagent"})).toBeTruthy();
		expect(composer().disabled).toBe(true);
		return opened;
	};

	it("lands on the composer when Escape is the way out", async () => {
		const {rendered} = await openFinished();

		await press("Escape");

		expect(screen.getByRole("log", {name: "Transcript"})).toBeTruthy();
		expect(document.querySelector(".tuval-chat-subagents")).toBeNull();
		expect(composer().disabled).toBe(false);
		expect(active()).toBe(composer());
		rendered.unmount();
	});

	it("lands on the composer when the back button is the way out", async () => {
		const {rendered} = await openFinished();

		const back = rows()[0] as HTMLButtonElement;
		expect(back.textContent).toBe("Back to the agent transcript");
		await click(back);

		expect(screen.getByRole("log", {name: "Transcript"})).toBeTruthy();
		expect(document.querySelector(".tuval-chat-subagents")).toBeNull();
		expect(composer().disabled).toBe(false);
		expect(active()).toBe(composer());
		rendered.unmount();
	});
});

describe("the chord where there is no list", () => {
	it("does nothing and takes nothing down when the window is showing none", async () => {
		const {rendered, chord} = await openWindow(withTranscript([userItem("u1", "go")]), {
			subagentList: true,
		});
		const before = active();

		await chord();

		expect(document.querySelector(".tuval-chat-subagents")).toBeNull();
		expect(active()).toBe(before);
		expect(screen.getByRole("log", {name: "Transcript"})).toBeTruthy();
		rendered.unmount();
	});

	it("does nothing with the flag off, where no row is focusable at all", async () => {
		const {rendered, chord} = await openWindow(twoRunning(), {subagentList: false});
		const before = active();

		await chord();

		expect(document.querySelector(".tuval-chat-subagents")).toBeNull();
		expect(rows()).toEqual([]);
		expect(active()).toBe(before);
		rendered.unmount();
	});
});

/**
 * #7559's own invariant, re-read because this ticket is the one that could have broken it: the
 * chord reaches the window as a forwarded key, so the list needs no listener of its own and the
 * page keeps the one the desk owns.
 */
describe("the page's keyboard listeners", () => {
	const modules = (dir: string): ReadonlyArray<readonly [string, string]> =>
		readdirSync(dir, {recursive: true, withFileTypes: true})
			.filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
			.filter((entry) => !entry.name.includes(".test.") && !entry.name.endsWith(".testing.ts"))
			.map((entry) => {
				const path = join(entry.parentPath, entry.name);
				return [path, readFileSync(path, "utf8")] as const;
			});

	it("registers a keydown on a shared target in exactly one module, and it is the desk's", () => {
		const shell = join(import.meta.dirname, "..");
		const offenders = modules(shell)
			.filter(([, source]) => /addEventListener\(\s*"keydown"/.test(source))
			.map(([path]) => path.slice(shell.length + 1));
		expect(offenders).toEqual(["ui/Desk.tsx"]);
	});
});
