/**
 * @vitest-environment jsdom
 *
 * Opening a run of tool calls, and opening one of those calls (#8613).
 *
 * Two disclosures over one `expanded` set: the run keys on its own `tools:<first call id>` row key
 * and each call on its own item id, so the two never open each other and two windows over one
 * process open the same run independently.
 *
 * `Collapsible` keeps its panel in the document and hides it, so every content assertion here reads
 * the *visible* panel — `hiddenPanels` is what a `textContent` over the whole row would have
 * silently included.
 *
 * `chat.css` is read off disk and put in the document because Vitest's default `css: false` makes
 * the window's own `import "./chat.css"` an empty module — without this every style assertion is
 * vacuous.
 */

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {act, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {beforeAll, describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../window/fixtures.ts";
import {type WindowHost, WindowId} from "../window/index.ts";
import {chatWindow} from "./ChatWindow.tsx";
import {call, userItem, withTranscript} from "./chat.testing.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

beforeAll(() => {
	const style = document.createElement("style");
	style.textContent = readFileSync(fileURLToPath(import.meta.resolve("./chat.css")), "utf8");
	document.head.appendChild(style);
});

/** Two reads and a shell call — three consecutive calls, so the window collapses them into a run. */
const RUN: ReadonlyArray<TranscriptItem> = [
	userItem("u1", "go"),
	call("t0", {name: "Read", input: {file_path: "src/rows.ts"}, output: "export const rows = 1;"}),
	call("t1", {name: "Read", input: {file_path: "src/view.ts"}, output: "export const view = 2;"}),
	call("t2", {name: "Bash", input: {command: "pnpm test"}, output: "12 passed"}),
];

type ChatHost = WindowHost<AiAgentSessionState, AiAgentSessionMsg, ChatView>;

const hostOver = async (
	items: ReadonlyArray<TranscriptItem>,
	windowId = "w1",
	process?: TestProcess<AiAgentSessionState, AiAgentSessionMsg>,
): Promise<ChatHost> => {
	const running =
		process ??
		(await Effect.runPromise(
			testProcess<AiAgentSessionState, AiAgentSessionMsg>(
				ProcessId.make("p1"),
				withTranscript(items),
			),
		));
	return await Effect.runPromise(
		running.window<ChatView>(WindowId.make(windowId), initialChatView),
	);
};

const mount = async (host: ChatHost): Promise<{readonly unmount: () => void}> => {
	const element = chatWindow({scrollCommitMs: 0, scrollToFn: () => {}}).render(
		host,
	) as ReactElement;
	const rendered = render(element);
	await screen.findAllByRole("log", {name: "Transcript"});
	return {unmount: rendered.unmount};
};

interface Harness {
	readonly view: () => ChatView;
	readonly unmount: () => void;
}

const openWindow = async (items: ReadonlyArray<TranscriptItem> = RUN): Promise<Harness> => {
	const host = await hostOver(items);
	const {unmount} = await mount(host);
	return {view: () => host.view(), unmount};
};

const activity = (): HTMLElement => screen.getByRole("region", {name: "Activity"});

const buttonIn = (root: HTMLElement, name: RegExp): HTMLElement =>
	within(root).getByRole("button", {name});

const runTrigger = (): HTMLElement => buttonIn(activity(), /^Read 2 files/);

const callTrigger = (name: RegExp): HTMLElement => buttonIn(activity(), name);

/** The panel a trigger owns, or `null` while the primitive has it hidden. */
const visiblePanel = (trigger: HTMLElement): HTMLElement | null => {
	const panel = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
	return panel === null || panel.hidden ? null : panel;
};

const open = async (trigger: HTMLElement): Promise<void> => {
	await act(async () => {
		fireEvent.click(trigger);
	});
};

describe("a run of tool calls opens to its calls", () => {
	it("is a disclosure, and lists the calls in order once it is open", async () => {
		const harness = await openWindow();

		expect(runTrigger().getAttribute("aria-expanded")).toBe("false");
		expect(visiblePanel(runTrigger())).toBeNull();

		await open(runTrigger());

		expect(runTrigger().getAttribute("aria-expanded")).toBe("true");
		const list = screen.getByRole("list", {name: "Tool calls"});
		expect(visiblePanel(runTrigger())?.contains(list)).toBe(true);
		const lines = within(list)
			.getAllByRole("listitem")
			.map((row) => row.querySelector(".tuval-chat-tool-head")?.textContent);
		expect(lines).toEqual(["Read src/rows.tsok", "Read src/view.tsok", "Bash pnpm testok"]);
		harness.unmount();
	});

	it("keys the run on its own row key, never on the first call's id", async () => {
		const harness = await openWindow();

		await open(runTrigger());

		await waitFor(() => expect(harness.view().expanded).toEqual(["tools:t0"]));
		harness.unmount();
	});
});

describe("a call inside a run opens to its detail", () => {
	it("carries its own aria-expanded and discloses its input and its result", async () => {
		const harness = await openWindow();
		await open(runTrigger());

		const trigger = callTrigger(/^Bash pnpm test/);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(visiblePanel(trigger)).toBeNull();

		await open(trigger);

		const opened = callTrigger(/^Bash pnpm test/);
		expect(opened.getAttribute("aria-expanded")).toBe("true");
		expect(visiblePanel(opened)?.textContent).toContain("12 passed");
		// One set, three distinct keys: the run stayed open and its siblings stayed shut.
		await waitFor(() => expect(harness.view().expanded).toEqual(["tools:t0", "t2"]));
		expect(callTrigger(/^Read src\/rows\.ts/).getAttribute("aria-expanded")).toBe("false");
		harness.unmount();
	});

	it("prints no command block for a command the call's own line already shows", async () => {
		const harness = await openWindow();
		await open(runTrigger());
		const trigger = callTrigger(/^Bash pnpm test/);

		await open(trigger);

		const panel = visiblePanel(trigger);
		const labels = [...(panel?.querySelectorAll(".tuval-chat-tool-label") ?? [])].map(
			(node) => node.textContent,
		);
		expect(labels).toEqual(["output"]);
		harness.unmount();
	});

	it("shows the whole command when the line could only carry its first line", async () => {
		const script = "pnpm build\npnpm test";
		const harness = await openWindow([
			userItem("u1", "go"),
			call("t0", {name: "Read", input: {file_path: "a.ts"}}),
			call("t1", {name: "Bash", input: {command: script}, output: "12 passed"}),
		]);
		await open(buttonIn(activity(), /^Read 1 file/));
		const trigger = callTrigger(/^Bash pnpm build/);

		await open(trigger);

		const blocks = [...(visiblePanel(trigger)?.querySelectorAll(".tuval-chat-pre") ?? [])].map(
			(node) => node.textContent,
		);
		expect(blocks).toEqual([script, "12 passed"]);
		harness.unmount();
	});

	it("renders an edit through the design Diff rather than a table of its own", async () => {
		const harness = await openWindow([
			userItem("u1", "go"),
			call("t0", {name: "Read", input: {file_path: "a.ts"}}),
			call("t1", {
				name: "Edit",
				input: {file_path: "src/count.ts", old_string: "const a = 1;", new_string: "const a = 2;"},
				output: "edited",
			}),
		]);
		await open(buttonIn(activity(), /^Read 1 file/));
		const trigger = callTrigger(/^Edit src\/count\.ts/);

		await open(trigger);

		// The diff arrives with its own chunk, a frame after the row's first paint.
		await waitFor(() => expect(screen.getByRole("region", {name: /src\/count\.ts/})).toBeDefined());
		expect(visiblePanel(trigger)?.textContent).toContain("edited");
		expect(document.querySelector(".tuval-chat-diff")).toBeNull();
		harness.unmount();
	});
});

describe("a call with nothing beyond its own line", () => {
	it("is not a disclosure at all: no button, no tab stop, no chevron", async () => {
		const harness = await openWindow([
			userItem("u1", "go"),
			call("t0", {name: "Read", input: {file_path: "a.ts"}}),
			call("t1", {name: "Bash", input: {command: "pnpm test"}, output: ""}),
		]);

		await open(buttonIn(activity(), /^Read 1 file/));

		expect(within(activity()).queryByRole("button", {name: /^Bash pnpm test/})).toBeNull();
		const flat = document.querySelector<HTMLElement>(".tuval-chat-tool-call-flat");
		expect(flat?.textContent).toBe("Bash pnpm testok");
		expect(flat?.getAttribute("role")).toBeNull();
		expect(flat?.getAttribute("tabindex")).toBeNull();
		expect(flat?.querySelector(".tuval-chat-tool-call-blank")?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		harness.unmount();
	});
});

describe("every disclosure a run adds is operable from the keyboard", () => {
	it("opens the run with Enter and a call with Space, reaching each by Tab", async () => {
		const user = userEvent.setup();
		const harness = await openWindow();

		while (document.activeElement !== runTrigger()) {
			await user.tab();
		}
		await user.keyboard("{Enter}");
		expect(runTrigger().getAttribute("aria-expanded")).toBe("true");

		while (document.activeElement !== callTrigger(/^Bash pnpm test/)) {
			await user.tab();
		}
		await user.keyboard(" ");

		expect(callTrigger(/^Bash pnpm test/).getAttribute("aria-expanded")).toBe("true");
		await waitFor(() => expect(harness.view().expanded).toEqual(["tools:t0", "t2"]));
		harness.unmount();
	});
});

describe("a failure is words, never only a tint", () => {
	it("says so on the collapsed run and again on the call that failed", async () => {
		const harness = await openWindow([
			userItem("u1", "go"),
			call("t0", {name: "Read", input: {file_path: "a.ts"}}),
			call("t1", {name: "Bash", input: {command: "pnpm test"}, status: "error", output: "boom"}),
		]);

		const run = buttonIn(activity(), /^Read 1 file and ran 1 command/);
		expect(run.textContent).toContain("failed");

		await open(run);

		expect(callTrigger(/^Bash pnpm test/).textContent).toContain("error");
		harness.unmount();
	});
});

describe("the disclosure state is the window's, not the component's", () => {
	it("opens the same run independently in two windows over one process", async () => {
		const process = await Effect.runPromise(
			testProcess<AiAgentSessionState, AiAgentSessionMsg>(
				ProcessId.make("p1"),
				withTranscript(RUN),
			),
		);
		const left = await hostOver(RUN, "w-left", process);
		const right = await hostOver(RUN, "w-right", process);
		const mounted = [await mount(left), await mount(right)];

		const [leftRun] = screen.getAllByRole("button", {name: /^Read 2 files/});
		await open(leftRun as HTMLElement);

		await waitFor(() => expect(left.view().expanded).toEqual(["tools:t0"]));
		expect(right.view().expanded).toEqual([]);
		for (const rendered of mounted) rendered.unmount();
	});

	it("comes back open on a window remounted onto the same slot", async () => {
		const host = await hostOver(RUN);
		const first = await mount(host);
		await open(runTrigger());
		await waitFor(() => expect(host.view().expanded).toEqual(["tools:t0"]));
		first.unmount();

		const again = await mount(host);

		expect(runTrigger().getAttribute("aria-expanded")).toBe("true");
		again.unmount();
	});
});

describe("the law the new triggers are judged against", () => {
	const css = (): string => readFileSync(fileURLToPath(import.meta.resolve("./chat.css")), "utf8");

	it("floors every collapsible trigger at the 36px hit area", () => {
		const sheet = css();
		expect(sheet).toContain("--tap-min: 36px;");
		// The run's trigger and each call's are inside `.tuval-chat-tool`, which is the scope the
		// shared trigger rule sizes; a call that is no trigger holds the same line for itself.
		expect(sheet).toMatch(
			/\.tuval-chat-tool \[data-scope="collapsible"\]\[data-part="trigger"\][^}]*min-block-size: var\(--tap-min\)/s,
		);
		expect(sheet).toMatch(/\.tuval-chat-tool-call-flat \{[^}]*min-block-size: var\(--tap-min\)/s);
	});

	it("hand-rolls no outline for the rows this slice adds", () => {
		const blocks = css()
			.split("}")
			.filter((block) => /tuval-chat-tool-(call|run)/.test(block.split("{")[0] ?? ""));
		expect(blocks.length).toBeGreaterThan(0);
		expect(blocks.filter((block) => /\boutline\s*:/.test(block))).toEqual([]);
	});
});
