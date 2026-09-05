/**
 * The chat window in a real browser, without a kernel, a socket or an agent.
 *
 * It exists because jsdom has no layout: every claim this slice makes about paint — a fixed diff
 * column, a disclosure indicator's size, a portaled listbox's tokens — is unfalsifiable in the unit
 * tier, and the round that asserted a browser run and deleted its harness left a reviewer with
 * nothing to check (#7610, review-code FAIL 2026-09-05). So the harness ships: `pnpm proof:chat`
 * from `apps/tuval` serves this page, and anyone can reproduce the run rather than trust a report.
 *
 * Two windows over one `testProcess` — the same double the unit tier renders against — because the
 * per-window facts (an expanded row, a page cursor) are only visible with a second window beside
 * the first. There is no runtime agent import here, so nothing about the backend is exercised or
 * claimed: what this page proves is paint and keyboard, and nothing else.
 */

import {Effect} from "effect";
import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../../ai-agent/core/index.ts";
import {ProcessId} from "../../../process/process.ts";
import {testProcess} from "../../window/fixtures.ts";
import {WindowId} from "../../window/index.ts";
import {chatWindow} from "../ChatWindow.tsx";
import {
	assistantItem,
	call,
	modes,
	permissionRequest,
	userItem,
	withTranscript,
} from "../chat.testing.ts";
import type {ChatView} from "../view.ts";
import "../../ui/tokens.css";
import "./proof.css";

const state: AiAgentSessionState = withTranscript(
	[
		userItem("u1", "Rename the guard and show me the diff."),
		assistantItem("a1", "Renaming it now."),
		call("t1", {
			name: "edit_file",
			input: {
				path: "src/shell/chat/ChatWindow.tsx",
				old_text: "const guard = true;\nconst limit = 50;\nreturn guard;",
				new_text: "const guard = loading;\nconst limit = 50;\nreturn guard;",
			},
			output: "1 file changed",
		}),
		call("t2", {
			name: "bash",
			input: {command: "pnpm vitest run src/shell/chat"},
			output: "Test Files  4 passed (4)\n     Tests  62 passed (62)",
			resultLimit: 40,
			status: "error",
		}),
		assistantItem("a2", "Done — the guard is per-window now."),
	],
	{
		permissions: {"req-1": permissionRequest()},
		modes: modes(["default", "plan", "accept edits"], "default"),
	},
);

const view: ChatView = {scroll: 0, draft: "", cursor: null, atOldest: false, expanded: []};

const mount = Effect.gen(function* () {
	const host = document.getElementById("proof");
	if (host === null) return yield* Effect.die(new Error("the proof page has no #proof element"));
	const process = yield* testProcess<AiAgentSessionState, AiAgentSessionMsg>(
		ProcessId.make("proof"),
		state,
	);
	const left = yield* process.window<ChatView>(WindowId.make("left"), view);
	const right = yield* process.window<ChatView>(WindowId.make("right"), view);
	const renderer = chatWindow();
	createRoot(host).render(
		<StrictMode>
			<div className="tuval-surface proof-desk" data-scheme="dark">
				<div className="proof-pane">{renderer.render(left)}</div>
				<div className="proof-pane">{renderer.render(right)}</div>
			</div>
		</StrictMode>,
	);
});

Effect.runFork(mount);
