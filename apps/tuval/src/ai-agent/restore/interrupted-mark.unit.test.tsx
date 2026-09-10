/**
 * @vitest-environment jsdom
 *
 * The cut turn's mark and its Resend across a desk restore (#8895): the checkpoint is the only thing
 * that carries them, and this pins that it does.
 *
 * Two rows, two carriers, and the distinction is the whole test. The reply keeps its own
 * `interrupted: true` — `../core/state.ts`'s `markInterrupted` writes it — and the *prompt* carries
 * the mark and the Resend, because `state.interrupted` is the resend anchor and `ChatWindow` renders
 * both off it (#8699). Both are checkpointed fields, so a restore that drops either reds here.
 *
 * The history the resume refills over comes from agy's on-disk reader, and that reader mints no
 * interrupted item at all — measured, not assumed: at agy 1.2.0 an operator stop leaves the cut reply
 * in `transcript.jsonl` as a plain `PLANNER_RESPONSE` with `status: "DONE"` and no field naming the
 * stop, so there is nothing on disk to read the flag off. That is what makes the checkpoint the sole
 * carrier rather than one of two, and the refill assertion below is the one that would red if a future
 * change let the store's bare copy win over ours.
 */

import {applyCellChecked} from "@demlik/tea";
import {render, screen} from "@testing-library/react";
import {Effect} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import {transcriptItems, transcriptLines} from "../../agy/ai-agent/transcript.ts";
import {
	liveJoinConversationId,
	liveJoinFullLines,
	liveJoinLines,
} from "../../agy/ai-agent/transcript-fixtures.ts";
import {ProcessId} from "../../process/process.ts";
import {type ChatWindowHost, chatWindow} from "../../shell/chat/ChatWindow.tsx";
import {type ChatView, initialChatView} from "../../shell/chat/view.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import {type TestProcess, testProcess} from "../../shell/window/fixtures.ts";
import {WindowId} from "../../shell/window/index.ts";
import type {AiAgentSessionCmd, AiAgentSessionMsg, AiAgentSessionState} from "../core/index.ts";
import {loadCheckpoint} from "../core/index.ts";
import {aiAgentSessionMachine} from "../core/machine.ts";
import type {TranscriptItem} from "../ports/index.ts";

installDomShims();

const CWD = "/workspace";
const SESSION = "0b66a786-44c8-4acf-a8b6-e197d8ae6003";
const PROMPT_ID = "local:7071967b-1e8f-456f-9e85-988f80d1b35f";
const REPLY_ID = `${SESSION}:1`;
const PROMPT_TEXT = "Write a long, detailed essay about the history of suspension bridges";

const machine = aiAgentSessionMachine({cwd: CWD});

const apply = (state: AiAgentSessionState, msg: AiAgentSessionMsg): AiAgentSessionState =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(
		machine,
		state,
		msg,
	)[0];

/**
 * The checkpoint a real desk wrote for a real stop, as JSON — the shape the store hands `init`, so
 * this rides the load boundary (`loadCheckpoint`) rather than a hand-built state object.
 *
 * Its field values are the capture's: `phase: "ready"` because the stop settled before the desk went
 * down, which is why the `prompting` arm of `restore` never fires and the two checkpointed carriers
 * are all there is. `cut` swaps the flag and the anchor off, for the negative case.
 */
const checkpointJson = (cut: boolean): unknown => ({
	phase: "ready",
	sessionId: SESSION,
	connection: 2,
	cwd: CWD,
	interrupted: cut ? PROMPT_ID : null,
	// The third checkpointed carrier, and the one the Resend *control* needs: the text a resend
	// sends is `lastPrompt`, so a checkpoint that lost it restores the mark with no way to act on it.
	lastPrompt: PROMPT_TEXT,
	transcript: {
		items: [
			{kind: "user", id: PROMPT_ID, timestamp: 1, text: PROMPT_TEXT},
			{
				kind: "assistant",
				id: REPLY_ID,
				timestamp: 2,
				text: "# The Catenary Web: A Comprehensive History of Suspension Bridges",
				...(cut ? {interrupted: true} : {}),
			},
		],
		omitted: {items: 0, bytes: 0, reason: "none"},
	},
});

/** The history the resumed layer reads back: agy's own log, through agy's own reader. */
const storedHistory: ReadonlyArray<TranscriptItem> = transcriptItems(
	liveJoinConversationId,
	transcriptLines(liveJoinLines.join("\n")),
	transcriptLines(liveJoinFullLines.join("\n")),
);

/** The load boundary the kernel hands a checkpoint to: JSON in, the restored session out. */
const restored = (cut: boolean): AiAgentSessionState => loadCheckpoint(checkpointJson(cut), CWD);

/** The rest of the restore: the resumed layer's open, which re-plans the tail over the store. */
const refilled = (cut: boolean): AiAgentSessionState =>
	apply(apply(restored(cut), {type: "reconnect"}), {
		type: "started",
		sessionId: SESSION,
		history: storedHistory,
	});

const openWindow = async (
	state: AiAgentSessionState,
): Promise<TestProcess<AiAgentSessionState, AiAgentSessionMsg>> => {
	const process = await Effect.runPromise(
		testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("p1"), state),
	);
	const host: ChatWindowHost = await Effect.runPromise(
		process.window<ChatView>(WindowId.make("w1"), {...initialChatView, pinned: true}),
	);
	render(chatWindow({scrollToFn: () => {}}).render(host) as ReactElement);
	return process;
};

describe("a restored session whose checkpoint holds a cut reply", () => {
	it("renders the mark and an enabled Resend", async () => {
		await openWindow(restored(true));
		expect(screen.getByText("interrupted")).toBeTruthy();
		const resend = screen.getByRole("button", {name: /Resend/});
		expect((resend as HTMLButtonElement).disabled).toBe(false);
	});

	it("keeps the reply's own flag and the anchor through the resume's refill", () => {
		const state = refilled(true);
		expect(state.transcript.items.find((item) => item.id === REPLY_ID)).toMatchObject({
			kind: "assistant",
			interrupted: true,
		});
		expect(state.interrupted).toBe(PROMPT_ID);
		expect(state.lastPrompt).toBe(PROMPT_TEXT);
	});

	// The store's copy of a cut reply is bare, because agy's log says nothing about the stop.
	it("reads no interrupted row out of agy's own log", () => {
		expect(
			storedHistory.some((item) => item.kind === "assistant" && item.interrupted === true),
		).toBe(false);
	});

	// The hazard behind the two above: the store holds this very row, bare. Ours is the copy the
	// operator has already read, so the refill has to keep it rather than take the store's.
	it("keeps our marked copy when the store holds the same row unmarked", () => {
		const bare = restored(true).transcript.items.map((item) =>
			item.id === REPLY_ID ? {...item, interrupted: undefined} : item,
		);
		const state = apply(apply(restored(true), {type: "reconnect"}), {
			type: "started",
			sessionId: SESSION,
			history: bare,
		});
		expect(state.transcript.items.find((item) => item.id === REPLY_ID)).toMatchObject({
			interrupted: true,
		});
	});
});

describe("a restored session whose turn completed", () => {
	it("renders no mark and offers no Resend", async () => {
		await openWindow(restored(false));
		expect(screen.queryByText("interrupted")).toBeNull();
		expect(screen.queryByRole("button", {name: /Resend/})).toBeNull();
	});
});
