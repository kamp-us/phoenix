/** The existing chat window fed through production projection/adapter; no model or socket. */
import {Effect} from "effect";
import {createRoot} from "react-dom/client";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../../ai-agent/core/index.ts";
import {ProcessId} from "../../../process/process.ts";
import {withTranscript} from "../../../shell/chat/chat.testing.ts";
import {type ChatView, initialChatView} from "../../../shell/chat/index.ts";
import {testProcess} from "../../../shell/window/fixtures.ts";
import {WindowId} from "../../../shell/window/index.ts";
import {itemsOf} from "../../ai-agent/items.ts";
import {projectTranscript, type SourceMessage} from "../../server/transcript.ts";
import {piChatWindow} from "../PiChatWindow.tsx";
import "../../../page/styles.ts";
import "./proof.css";

const messages: ReadonlyArray<SourceMessage> = [
	{role: "user", content: "Explain the next step.", timestamp: 1},
	{
		role: "assistant",
		content: [],
		provider: "openai",
		model: "synthetic",
		stopReason: "error",
		errorMessage:
			"You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
		timestamp: 2,
	},
];
const mount = Effect.gen(function* () {
	const host = document.getElementById("proof");
	if (host === null) return yield* Effect.die(new Error("Missing proof host"));
	const process = yield* testProcess<AiAgentSessionState, AiAgentSessionMsg>(
		ProcessId.make("provider-failure-proof"),
		withTranscript(projectTranscript(messages).flatMap(itemsOf)),
	);
	const window = yield* process.window<ChatView>(
		WindowId.make("provider-failure"),
		initialChatView,
	);
	createRoot(host).render(
		<div className="tuval-surface proof-desk" data-scheme="dark">
			<div className="proof-pane">{piChatWindow().render(window)}</div>
		</div>,
	);
});
void Effect.runPromise(mount);
