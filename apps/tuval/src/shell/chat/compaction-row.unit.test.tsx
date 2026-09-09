/**
 * @vitest-environment jsdom
 *
 * A compaction row is bounded by the transcript at every payload length (#8608).
 *
 * Pi's compaction item carries the whole summary the model wrote, and the divider used to render it
 * as its label — micro, uppercase, `white-space: nowrap` — so a multi-paragraph document became one
 * line the transcript had to scroll sideways to show. jsdom runs no layout engine, so no assertion
 * here can measure a scrollbar; what jsdom does resolve is the cascade's declared values, and that
 * is exactly where the defect lived. So the case renders the real window over a 2000-character
 * summary and asks the two questions layout would have answered: is anything carrying the whole
 * summary declared `nowrap`, and is what *is* declared `nowrap` bounded by its container.
 *
 * `chat.css` is read off disk and put in the document because Vitest's default `css: false` makes
 * the window's own `import "./chat.css"` an empty module — without this every style assertion is
 * vacuous.
 */

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {act, fireEvent, render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {beforeAll, describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {chatWindow} from "./ChatWindow.tsx";
import {compactionItem, withTranscript} from "./chat.testing.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

beforeAll(() => {
	const style = document.createElement("style");
	style.textContent = readFileSync(fileURLToPath(import.meta.resolve("./chat.css")), "utf8");
	document.head.appendChild(style);
});

/** What Pi hands the window: a markdown document, opening on a heading. */
const SUMMARY = `## Goal\n\n${"Ship codex as a sibling of pi and claude in tuval. ".repeat(40)}`;

const openWindow = async (): Promise<void> => {
	const process: TestProcess<AiAgentSessionState, AiAgentSessionMsg> = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(
			ProcessId.make("p1"),
			withTranscript([compactionItem("c", SUMMARY)]),
		),
	);
	const host = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w1"), initialChatView),
	);
	const element = chatWindow({scrollCommitMs: 0, scrollToFn: () => {}}).render(
		host,
	) as ReactElement;
	render(element);
	await screen.findByRole("log", {name: "Transcript"});
};

const trigger = (): HTMLElement => screen.getByRole("button", {name: /^Goal/});

const label = (): HTMLElement => {
	const found = document.querySelector<HTMLElement>(".tuval-chat-compaction-label");
	if (found === null) throw new Error("the compaction label did not render");
	return found;
};

const summaryElement = (): HTMLElement => {
	const found = document.querySelector<HTMLElement>(".tuval-chat-compaction-summary");
	if (found === null) throw new Error("the compaction summary did not render");
	return found;
};

/**
 * Every element from the one carrying the summary up to the transcript, so a declaration inherited
 * from an ancestor is judged as well as one written on the element itself.
 */
const summaryChain = (): ReadonlyArray<HTMLElement> => {
	const chain: Array<HTMLElement> = [];
	for (
		let node: HTMLElement | null = summaryElement();
		node !== null && !node.classList.contains("tuval-chat-transcript");
		node = node.parentElement
	) {
		chain.push(node);
	}
	return chain;
};

describe("a compaction row over a summary the model wrote", () => {
	it("renders collapsed, with the summary out of the accessible tree", async () => {
		await openWindow();

		expect(SUMMARY.length).toBeGreaterThan(2000);
		expect(trigger().getAttribute("aria-expanded")).toBe("false");
		const panel = document.getElementById(trigger().getAttribute("aria-controls") ?? "");
		expect(panel?.hidden).toBe(true);
		expect(panel?.contains(summaryElement())).toBe(true);
	});

	it("keeps the whole summary off the divider's line, which clips inside its container", async () => {
		await openWindow();

		const line = label();
		expect(line.textContent).toBe("Goal");
		expect(trigger().textContent?.length).toBeLessThan(100);
		const style = getComputedStyle(line);
		// The line must not wrap against the rule, so being bounded is `overflow` doing it.
		expect(style.whiteSpace).toBe("nowrap");
		expect(style.overflow).toBe("hidden");
		expect(style.textOverflow).toBe("ellipsis");
	});

	it("discloses the summary as ordinary wrapping markdown", async () => {
		await openWindow();

		await act(async () => {
			fireEvent.click(trigger());
		});

		expect(trigger().getAttribute("aria-expanded")).toBe("true");
		// `## Goal` is a heading in the panel, not one more run of text on the divider's line.
		expect(summaryElement().querySelector("h1, h2, h3, h4, h5, h6")?.textContent).toBe("Goal");
		for (const node of summaryChain()) {
			const style = getComputedStyle(node);
			expect([node.className, style.whiteSpace]).not.toEqual([node.className, "nowrap"]);
			expect([node.className, style.textTransform]).not.toEqual([node.className, "uppercase"]);
		}
	});
});
