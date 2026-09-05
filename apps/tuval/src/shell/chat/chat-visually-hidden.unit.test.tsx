/**
 * @vitest-environment jsdom
 *
 * The composer's screen-reader-only text resolves to the hidden box, not to the container's width.
 *
 * `@kampus/design` marks that text with `kp-visually-hidden` and used to ship no rule for it, so in
 * Tuval every such element laid out at full width and the page scrolled sideways — 2026 CSS px of
 * `scrollWidth` against a 1333 px viewport (#7984). The rule now lives in the package, and one of
 * its sites is a Manti field ROOT (`AgentChatInput.tsx` puts the class on an `Input`), which this
 * directory's own `.tuval-chat [data-scope="field"][data-part="root"]` rule outranks on
 * specificity. So this file loads BOTH real stylesheets and reads the cascade's answer.
 *
 * jsdom has no layout, but it does resolve the cascade for `getComputedStyle` — which is the
 * question here, the defect having been a losing declaration rather than a wrong number. One limit
 * is load-bearing enough to state: cssstyle does not know `inline-size`, so it neither maps it onto
 * `width` (a browser does, in horizontal-tb) nor honours `!important` on it. The window's field-root
 * rule is written in exactly that spelling, so the collision itself is not decidable here. The
 * third test covers what jsdom cannot: that the shipped rule declares the box `!important` at all,
 * which is what makes it unoutrankable in the browser. The browser measurement in the PR body is
 * the ground truth for the resolved layout.
 */

import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {beforeAll, describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {type ChatWindowHost, chatWindow} from "./ChatWindow.tsx";
import {userItem, withTranscript} from "./chat.testing.ts";
import type {ChatView} from "./view.ts";

installDomShims();

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolved through the package's `exports` map, so a package that stops publishing the stylesheet
 * fails here rather than falling back to a path that happens to exist.
 */
const packageRule = createRequire(import.meta.url).resolve("@kampus/design/visually-hidden.css");

beforeAll(() => {
	for (const path of [packageRule, join(here, "chat.css")]) {
		const style = document.createElement("style");
		style.textContent = readFileSync(path, "utf8");
		document.head.appendChild(style);
	}
});

const openComposer = async (): Promise<void> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(
			ProcessId.make("p1"),
			withTranscript([userItem("a", "do it")]),
		),
	);
	const view: ChatView = {scroll: 0, draft: "", cursor: null, atOldest: false, expanded: []};
	const host: ChatWindowHost = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w1"), view),
	);
	render(chatWindow({scrollCommitMs: 0, scrollToFn: () => {}}).render(host) as ReactElement);
	await screen.findByRole("log", {name: "Transcript"});
};

const hidden = (): ReadonlyArray<HTMLElement> =>
	Array.from(document.querySelectorAll<HTMLElement>(".tuval-chat .kp-visually-hidden"));

describe("the composer's visually-hidden text", () => {
	it("resolves to the hidden box on every element that carries the class", async () => {
		await openComposer();
		expect(hidden().length).toBeGreaterThan(0);
		for (const element of hidden()) {
			const style = getComputedStyle(element);
			expect({
				tag: element.tagName,
				position: style.position,
				width: style.width,
				height: style.height,
				overflow: style.overflow,
				clip: style.clip,
			}).toEqual({
				tag: element.tagName,
				position: "absolute",
				width: "1px",
				height: "1px",
				overflow: "hidden",
				clip: "rect(0px, 0px, 0px, 0px)",
			});
		}
	});

	it("covers the file input, whose class lands on the field root rather than a span", async () => {
		await openComposer();
		const fieldRoots = hidden().filter((element) => element.getAttribute("data-part") === "root");
		expect(fieldRoots.length).toBeGreaterThan(0);
		for (const root of fieldRoots) {
			expect(root.querySelector("input[type='file']")).not.toBeNull();
			expect(getComputedStyle(root).width).toBe("1px");
		}
	});

	it("is declared important, which is what no consumer selector can outrank", async () => {
		const rule = readFileSync(packageRule, "utf8");
		const declarations = rule.slice(rule.indexOf("{"), rule.indexOf("}"));
		const box = ["position", "width", "height", "overflow", "clip", "clip-path"];
		for (const property of box) {
			expect(declarations).toMatch(new RegExp(`\\n\\t${property}:[^;]+!important;`));
		}
	});
});
