/**
 * @vitest-environment jsdom
 *
 * What a transcript row does with the markdown an agent replies in (#8012), rendered through the
 * same window-contract double the rest of this slice uses (`../window/fixtures.ts`).
 *
 * Every assertion here reads the DOM straight after `render`, with no `waitFor` and no `act` past
 * the mount. That is deliberate: the transcript is virtualized and each row is measured at the
 * height it painted, so content that arrived later would leave the measurement stale. A row that
 * only becomes complete under `waitFor` would pass a laxer test and still break the scroll.
 */

import {render, screen, within} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {type ChatWindowHost, chatWindow} from "./ChatWindow.tsx";
import {assistantItem, systemItem, userItem, withTranscript} from "./chat.testing.ts";
import type {ChatView} from "./view.ts";

installDomShims();

const openWindow = async (state: AiAgentSessionState): Promise<void> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host: ChatWindowHost = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w1"), {
			scroll: 0,
			draft: "",
			cursor: null,
			atOldest: false,
			expanded: [],
		}),
	);
	render(chatWindow({scrollToFn: () => {}}).render(host) as ReactElement);
};

const TABLE_REPLY = [
	"**Needs you (1)**:",
	"",
	"| issue | priority |",
	"|---|---|",
	"| [#7890](https://github.com/kamp-us/phoenix/issues/7890) | p1 |",
].join("\n");

describe("an agent reply renders as markdown", () => {
	it("renders a table as a table and a link as an anchor carrying its href", async () => {
		await openWindow(withTranscript([assistantItem("a1", TABLE_REPLY)]));

		const table = screen.getByRole("table");
		expect(within(table).getByRole("columnheader", {name: "issue"})).toBeDefined();
		const link = within(table).getByRole("link", {name: "#7890"});
		expect(link.getAttribute("href")).toBe("https://github.com/kamp-us/phoenix/issues/7890");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noreferrer");
		expect(screen.queryByText("|---|---|")).toBeNull();
	});

	it("renders emphasis, headings, lists and fenced code as elements", async () => {
		const reply = [
			"# Report",
			"",
			"Some **bold** text.",
			"",
			"- one",
			"- two",
			"",
			"1. first",
			"",
			"```ts",
			"const x = 1;",
			"```",
		].join("\n");
		await openWindow(withTranscript([assistantItem("a1", reply)]));

		const row = screen.getByRole("log", {name: "Transcript"});
		expect(within(row).getByRole("heading", {name: "Report"})).toBeDefined();
		expect(within(row).getByText("bold").tagName).toBe("STRONG");
		expect(within(row).getAllByRole("list")).toHaveLength(2);
		expect(within(row).getAllByRole("listitem")).toHaveLength(3);
		const code = within(row).getByText("const x = 1;");
		expect(code.tagName).toBe("CODE");
		expect(code.parentElement?.tagName).toBe("PRE");
	});

	it("prints raw HTML in a reply as text rather than markup", async () => {
		await openWindow(
			withTranscript([
				assistantItem("a1", "before\n\n<script>alert(1)</script>\n\n<b>x</b> after"),
			]),
		);

		const row = screen.getByRole("log", {name: "Transcript"});
		expect(row.querySelector("script")).toBeNull();
		expect(row.querySelector("b")).toBeNull();
		expect(row.textContent).toContain("<script>alert(1)</script>");
		expect(row.textContent).toContain("<b>x</b>");
	});

	it("refuses an anchor to a javascript: link, keeping its text", async () => {
		await openWindow(withTranscript([assistantItem("a1", "[click me](javascript:alert(1))")]));

		const row = screen.getByRole("log", {name: "Transcript"});
		expect(within(row).queryByRole("link")).toBeNull();
		expect(row.textContent).toContain("click me");
	});

	it("leaves a typed message and a session line as plain text", async () => {
		await openWindow(
			withTranscript([
				userItem("u1", "**not bold** | a | b |"),
				systemItem("s1", "# not a heading"),
			]),
		);

		const row = screen.getByRole("log", {name: "Transcript"});
		expect(within(row).queryByRole("table")).toBeNull();
		expect(within(row).queryByRole("heading")).toBeNull();
		expect(within(row).getByText("**not bold** | a | b |").className).toBe("tuval-chat-text");
		expect(within(row).getByText("# not a heading").className).toBe("tuval-chat-text");
	});
});
