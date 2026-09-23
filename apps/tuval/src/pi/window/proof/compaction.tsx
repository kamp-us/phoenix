/** The existing chat window fed through production projection/adapter; no model or socket. */

import type {
	AiAgentSessionMsg,
	AiAgentSessionState,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {testProcess} from "@kampus/tuval-sdk/kernel/shell/window/fixtures";
import {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {type ChatView, initialChatView} from "@kampus/tuval-ui/chat";
import {withTranscript} from "@kampus/tuval-ui/testing/chat";
import {Effect} from "effect";
import {createRoot} from "react-dom/client";
import {itemsOf} from "../../ai-agent/items.ts";
import {projectTranscript, type SourceMessage} from "../../server/transcript.ts";
import {piChatWindow} from "../PiChatWindow.tsx";
import "../../../page/styles.ts";
import "./proof.css";

const messages: ReadonlyArray<SourceMessage> = [
	{
		role: "compactionSummary",
		summary: "Earlier turns established the transcript paging contract.",
		timestamp: 1,
	},
	{role: "user", content: "Keep this question in the retained context.", timestamp: 2},
];
const mount = Effect.gen(function* () {
	const host = document.getElementById("proof");
	if (host === null) return yield* Effect.die(new Error("Missing proof host"));
	const process = yield* testProcess<AiAgentSessionState, AiAgentSessionMsg>(
		ProcessId.make("compaction-proof"),
		withTranscript(projectTranscript(messages).flatMap(itemsOf)),
	);
	const window = yield* process.window<ChatView>(WindowId.make("compaction"), initialChatView);
	createRoot(host).render(
		<div className="tuval-surface proof-desk" data-scheme="dark">
			<div className="proof-pane">{piChatWindow().render(window)}</div>
		</div>,
	);
});
void Effect.runPromise(mount);
