/**
 * @vitest-environment jsdom
 *
 * The composer fills the chat window, at every window width (#7989).
 *
 * The rule under test is `@kampus/design`'s, not Tuval's, so this file reads the shipped
 * `AgentChatInput.css` off disk and puts it in the document — the component's own
 * `import "./AgentChatInput.css"` resolves to an empty module under Vitest's default `css: false`,
 * so without this the window renders unstyled and every width assertion is vacuous. Resolving it
 * through `import.meta.resolve("@kampus/design")` rather than a `../` climb keeps the test pointed
 * at the same file the component imports.
 *
 * jsdom runs no layout engine, and this slice's shims (`../ui/dom.testing.ts`) hand every element
 * one fixed 1000×1000 box, so `getBoundingClientRect` cannot answer what width the composer takes.
 * What jsdom does resolve is the cascade's declared values, and the defect lived entirely there: a
 * `max-width` plus `margin: 0 auto` on `.kp-agent-chat` capped and centred the box inside a
 * full-width window. So `composerBox` resolves those declarations against a known parent width the
 * way a layout engine would, and the assertions are over that.
 */

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {render} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {beforeAll, describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {chatWindow} from "./ChatWindow.tsx";
import {sessionState} from "./chat.testing.ts";
import type {ChatView} from "./view.ts";

installDomShims();

const designCss = (name: string): string => {
	const entry = fileURLToPath(import.meta.resolve("@kampus/design"));
	return readFileSync(entry.replace(/index\.ts$/, name), "utf8");
};

beforeAll(() => {
	const style = document.createElement("style");
	style.textContent = designCss("AgentChatInput.css");
	document.head.appendChild(style);
});

const emptyView: ChatView = {scroll: 0, draft: "", cursor: null, atOldest: false, expanded: []};

/** Mounts the window inside a parent of a known inline size, the way a desk window sizes it. */
const openWindowIn = async (parentWidth: number): Promise<void> => {
	const process: TestProcess<AiAgentSessionState, AiAgentSessionMsg> = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), sessionState()),
	);
	const host = await Effect.runPromise(process.window<ChatView>(WindowId.make("w1"), emptyView));
	const element = chatWindow({scrollCommitMs: 0, scrollToFn: () => {}}).render(
		host,
	) as ReactElement;
	const parent = document.createElement("div");
	parent.style.width = `${parentWidth}px`;
	document.body.appendChild(parent);
	render(element, {container: parent});
};

interface ComposerBox {
	/** The inline size the declarations resolve to, in px, against the parent's own width. */
	readonly inlineSize: number;
	/** Whether anything on the root caps that size below the parent's. */
	readonly capped: boolean;
	/** Whether an `auto` inline margin centres what is left, leaving side gaps. */
	readonly centred: boolean;
}

/** Each field answers one question: a cap is reported by `capped`, never folded into the size. */

const composerBox = (parentWidth: number): ComposerBox => {
	const root = document.querySelector(".kp-agent-chat");
	if (root === null) throw new Error("the composer root .kp-agent-chat did not render");
	const style = getComputedStyle(root);
	const declared = (property: string): string => style.getPropertyValue(property).trim();
	const resolve = (value: string): number | null =>
		value.endsWith("%") ? (Number.parseFloat(value) / 100) * parentWidth : null;

	const size = resolve(declared("inline-size") || declared("width"));
	const cap = declared("max-inline-size") || declared("max-width");
	return {
		inlineSize: size ?? Number.NaN,
		capped: cap !== "" && cap !== "none",
		centred: [
			declared("margin-inline-start") || declared("margin-left"),
			declared("margin-inline-end") || declared("margin-right"),
		].includes("auto"),
	};
};

// A phone-narrow window and a wide one. The bug was width-blind — the cap and the auto margins
// applied identically at both — so a single width could not have told the two states apart.
describe.each([
	["a narrow window", 360],
	["a wide window", 1440],
])("the composer in %s", (_label, parentWidth) => {
	it("fills its parent's inline size, uncapped and uncentred", async () => {
		await openWindowIn(parentWidth);
		expect(composerBox(parentWidth)).toEqual({
			inlineSize: parentWidth,
			capped: false,
			centred: false,
		});
	});
});
