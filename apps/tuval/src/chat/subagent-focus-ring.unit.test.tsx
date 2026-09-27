/**
 * @vitest-environment jsdom
 *
 * The subagent rows' focus ring (#8751). The rows are buttons, so they owe a visible ring, and the
 * desk paints it once for everything under `.tuval-surface`. What is proven here is that the chat
 * sheet hand-rolls none of its own and that a focused row is inside the desk rule's reach. The
 * chat sheet is `@kampus/tuval-ui`'s and the desk rule is the app's, so the proof lives in the app.
 *
 * jsdom does not resolve `var()` substitution, so a computed `outline` string would read the same
 * whether the declaration survived or was dropped — the sheet is read off disk and the desk rule is
 * checked by selector match instead.
 */

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {SubagentSlot} from "@kampus/tuval-sdk/ai-agent/ports";
import type {
	AiAgentSessionMsg,
	AiAgentSessionState,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {subagentSlot} from "@kampus/tuval-sdk/kernel/ai-agent-fixtures/transcripts";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {testProcess} from "@kampus/tuval-sdk/kernel/shell/window/fixtures";
import {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {chatWindow, initialChatView} from "@kampus/tuval-ui/chat";
import {INPUT_MODALITY_ATTRIBUTE} from "@kampus/tuval-ui/input-modality";
import {userItem, withTranscript} from "@kampus/tuval-ui/testing/chat";
import {installDomShims} from "@kampus/tuval-ui/testing/dom";
import {render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import {chatSheetPath} from "./ui-source.testing.ts";

installDomShims();

const chatSheet = (): string => readFileSync(chatSheetPath, "utf8");

const deskSheet = (): string =>
	readFileSync(fileURLToPath(import.meta.resolve("../shell/ui/tokens.css")), "utf8");

const slots = (...entries: ReadonlyArray<SubagentSlot>): Record<string, SubagentSlot> =>
	Object.fromEntries(entries.map((slot) => [slot.id, slot]));

/** The window mounted under a desk root, which is what carries `.tuval-surface` in the app. */
const openUnderSurface = async (state: AiAgentSessionState) => {
	const surface = document.createElement("div");
	surface.className = "tuval-surface";
	// The desk root's own mark, which the ring rule is gated on since #8786 (`../shell/ui/Desk.tsx` writes
	// it). Keyboard, because that is what a desk carries until a pointer touches it, and a row
	// reached by keyboard is the case this file is about.
	surface.setAttribute(INPUT_MODALITY_ATTRIBUTE, "keyboard");
	document.body.append(surface);
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host = await Effect.runPromise(process.window(WindowId.make("w1"), initialChatView));
	const rendered = render(
		chatWindow({scrollCommitMs: 0, scrollToFn: () => undefined, subagentList: true}).render(
			host,
		) as ReactElement,
		{container: surface},
	);
	await screen.findByRole("log", {name: "Transcript"});
	return {
		rendered,
		unmount: () => {
			rendered.unmount();
			surface.remove();
		},
	};
};

describe("the subagent rows' focus ring", () => {
	it("is hand-rolled nowhere in the chat sheet", () => {
		const blocks = chatSheet()
			.split("}")
			.filter((block) => /tuval-chat-subagent/.test(block.split("{")[0] ?? ""));

		expect(blocks.length).toBeGreaterThan(0);
		expect(blocks.filter((block) => /\boutline\s*:/.test(block))).toEqual([]);
	});

	it("is the desk's one rule, declared off the ring tokens", () => {
		expect(deskSheet()).toMatch(
			/\.tuval-board-overlay :focus-visible,\s*\.tuval-surface:not\(\[data-input-modality="pointer"\]\) :focus-visible \{[^}]*outline: var\(--focus-ring\);[^}]*outline-offset: var\(--focus-ring-offset\);/s,
		);
	});

	it("reaches a focused pick row, which sits under the desk root", async () => {
		const opened = await openUnderSurface(
			withTranscript([userItem("u1", "go")], {
				subagents: slots(subagentSlot("a", {type: "reviewer"})),
			}),
		);
		const pick = document.querySelector<HTMLButtonElement>(".tuval-chat-subagent-pick");
		expect(pick).not.toBeNull();

		pick?.focus();

		expect(
			Array.from(
				document.querySelectorAll(
					'.tuval-surface:not([data-input-modality="pointer"]) :focus-visible',
				),
			),
		).toContain(pick);
		opened.unmount();
	});
});
