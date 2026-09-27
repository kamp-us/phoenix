/** The production inspector over a controllable in-memory process; no backend or model. */

import type {
	AiAgentSessionMsg,
	AiAgentSessionState,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {testProcess} from "@kampus/tuval-sdk/kernel/shell/window/fixtures";
import {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {AiAgentInspector} from "@kampus/tuval-ui/agent-window";
import {agentSessionState, usageOf} from "@kampus/tuval-ui/testing/inspector";
import {Effect} from "effect";
import {createRoot} from "react-dom/client";
import "../../page/styles.ts";
import "./proof.css";

const state = agentSessionState({
	cwd: "/project/a-long-directory-name/another-long-directory-name/source",
	usage: usageOf({model: "fixture", cost: 0.1111, input: 111111, output: 111111}),
});

declare global {
	interface Window {
		inspectorProof: {update: (cost: number, input: number, output: number) => Promise<void>};
	}
}

const mount = Effect.gen(function* () {
	const element = document.getElementById("proof");
	if (element === null) return yield* Effect.die(new Error("Missing inspector proof host"));
	const process = yield* testProcess<AiAgentSessionState, AiAgentSessionMsg>(
		ProcessId.make("inspector-proof"),
		state,
	);
	const host = yield* process.window(WindowId.make("inspector"), null);
	createRoot(element).render(
		<div className="tuval-surface proof-desk" data-scheme="dark">
			<div className="proof-pane">{AiAgentInspector.render(host)}</div>
		</div>,
	);
	return process;
});

void Effect.runPromise(mount).then((process) => {
	window.inspectorProof = {
		update: (cost, input, output) =>
			Effect.runPromise(
				process.commit({
					...state,
					usage: usageOf({model: "fixture", cost, input, output}),
				}),
			),
	};
});
