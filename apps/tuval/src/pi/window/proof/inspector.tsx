/** The production inspector over a controllable in-memory process; no backend or model. */
import {Effect} from "effect";
import {createRoot} from "react-dom/client";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../../ai-agent/core/index.ts";
import {AiAgentInspector} from "../../../ai-agent/window/AiAgentInspector.tsx";
import {agentSessionState, usageOf} from "../../../ai-agent/window/inspector.testing.ts";
import {ProcessId} from "../../../process/process.ts";
import {testProcess} from "../../../shell/window/fixtures.ts";
import {WindowId} from "../../../shell/window/index.ts";
import "../../../page/styles.ts";
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
