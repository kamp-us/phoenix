/** The existing chat window fed through production projection/adapter; no model or socket. */
import {Effect} from "effect";
import {createRoot} from "react-dom/client";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../../ai-agent/core/index.ts";
import {failureOf} from "../../../ai-agent/handlers/failures.ts";
import {ProcessId} from "../../../process/process.ts";
import {sessionState} from "../../../shell/chat/chat.testing.ts";
import {type ChatView, initialChatView} from "../../../shell/chat/index.ts";
import {testProcess} from "../../../shell/window/fixtures.ts";
import {WindowId} from "../../../shell/window/index.ts";
import {startErrorOf} from "../../ai-agent/refusals.ts";
import {connectionRefusalOf} from "../../client/refusals.ts";
import {piChatWindow} from "../PiChatWindow.tsx";
import "../../../page/styles.ts";
import "./proof.css";

const mount = Effect.gen(function* () {
	const host = document.getElementById("proof");
	if (host === null) return yield* Effect.die(new Error("Missing proof host"));
	const process = yield* testProcess<AiAgentSessionState, AiAgentSessionMsg>(
		ProcessId.make("exception-proof"),
		sessionState({
			phase: "idle",
			failure: failureOf(
				startErrorOf(
					"/workspace",
					connectionRefusalOf(new Error("Synthetic internal diagnostic from the Pi client")),
				),
			),
		}),
	);
	const window = yield* process.window<ChatView>(WindowId.make("exception"), initialChatView);
	createRoot(host).render(
		<div className="tuval-surface proof-desk" data-scheme="dark">
			<div className="proof-pane">{piChatWindow().render(window)}</div>
		</div>,
	);
});
void Effect.runPromise(mount);
