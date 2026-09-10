/**
 * @vitest-environment jsdom
 *
 * The pixel half of #8689: both calls of an agy batch show *their own* outcome on screen.
 *
 * The rows come off the real agy transcript reader over the driven v1.1.28 capture
 * (`agy/ai-agent/fixtures/multi-call-transcript.jsonl`), not out of `chat.testing.ts` — a renderer
 * case fed hand-made items would still pass with the pairing put back the way it was, and the
 * previous round's unit cases asserted on `item.text`, which is exactly the layer that cannot see
 * whether a reader ever reaches the screen. The import is this file's alone: `boundary.unit.test.ts`
 * forbids a shipped file under `shell/chat/` from reaching a backend, and exempts tests.
 */

import {act, fireEvent, render, screen, within} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import {transcriptItems, transcriptLines} from "../../agy/ai-agent/transcript.ts";
import * as fixtures from "../../agy/ai-agent/transcript-fixtures.ts";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {ProcessId} from "../../process/process.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../window/fixtures.ts";
import {WindowId} from "../window/index.ts";
import {chatWindow} from "./ChatWindow.tsx";
import {withTranscript} from "./chat.testing.ts";
import {type ChatView, initialChatView} from "./view.ts";

installDomShims();

const captured = (): ReadonlyArray<TranscriptItem> =>
	transcriptItems(
		fixtures.multiCallConversationId,
		transcriptLines(fixtures.multiCallLines.join("\n")),
		transcriptLines(fixtures.multiCallFullLines.join("\n")),
	);

const openWindow = async (items: ReadonlyArray<TranscriptItem>): Promise<void> => {
	const process: TestProcess<AiAgentSessionState, AiAgentSessionMsg> = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(
			ProcessId.make("p1"),
			withTranscript(items),
		),
	);
	const host = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w1"), initialChatView),
	);
	render(chatWindow({scrollCommitMs: 0, scrollToFn: () => {}}).render(host) as ReactElement);
	await screen.findAllByRole("log", {name: "Transcript"});
};

const activity = (): HTMLElement => screen.getByRole("region", {name: "Activity"});

const open = async (trigger: HTMLElement): Promise<void> => {
	await act(async () => {
		fireEvent.click(trigger);
	});
};

/** The panel a trigger owns, or `null` while the primitive has it hidden. */
const visiblePanel = (trigger: HTMLElement): HTMLElement | null => {
	const panel = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
	return panel === null || panel.hidden ? null : panel;
};

describe("an agy batch on screen", () => {
	it("shows each call its own outcome, and neither the other's", async () => {
		await openWindow(captured());

		// A settled turn folds, so the batch is two disclosures deep: the fold, then the run.
		await open(screen.getByRole("button", {name: /^Worked/}));

		const [run] = within(activity()).getAllByRole("button");
		expect(run).toBeDefined();
		await open(run as HTMLElement);

		const calls = within(screen.getByRole("list", {name: "Tool calls"})).getAllByRole("listitem");
		expect(calls).toHaveLength(2);
		const triggers = calls.map((row) => within(row).getByRole("button"));

		for (const trigger of triggers) await open(trigger);

		const [first, second] = triggers.map((trigger) => visiblePanel(trigger)?.textContent ?? "");
		expect(first).toContain("1: alpha");
		expect(first).not.toContain("1: bir");
		expect(second).toContain("1: bir");
		expect(second).not.toContain("1: alpha");
	});
});
