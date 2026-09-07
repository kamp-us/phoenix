import {Effect} from "effect";
import {createRoot} from "react-dom/client";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../../ai-agent/core/index.ts";
import type {InitialEffortProof} from "../../../claude/proof/initial-effort.ts";
import {ProcessId} from "../../../process/process.ts";
import {testProcess} from "../../window/fixtures.ts";
import {WindowId} from "../../window/index.ts";
import {chatWindow} from "../ChatWindow.tsx";
import {initialChatView} from "../view.ts";
import "../../../page/styles.ts";
import "./proof.css";

const response = await fetch("/initial-effort.json");
if (!response.ok) throw new Error(`Initial effort proof failed: ${response.status}`);
const proof: InitialEffortProof = await response.json();
const host = document.getElementById("proof");
if (host === null) throw new Error("Missing proof host");

await Effect.runPromise(
	Effect.gen(function* () {
		const process = yield* testProcess<AiAgentSessionState, AiAgentSessionMsg>(
			ProcessId.make("initial-effort-proof"),
			proof.state,
		);
		const window = yield* process.window(WindowId.make("initial-effort"), initialChatView);
		createRoot(host).render(
			<div className="tuval-surface proof-desk" data-scheme="dark">
				<div className="proof-pane">{chatWindow().render(window)}</div>
			</div>,
		);
		// The transport double records UI dispatches but does not run a kernel command handler.
		Object.assign(globalThis, {initialEffortProof: proof, initialEffortInbox: process.inbox});
	}),
);

// The capture-only route opens the actual picker, never selects a model or an effort.
if (location.pathname.endsWith("/effort-offered.html")) {
	const button = await new Promise<HTMLButtonElement>((resolve, reject) => {
		const observer = new MutationObserver(() => {
			const picker = document.querySelector<HTMLButtonElement>(
				'button[aria-label="thinking effort: none selected"]',
			);
			if (picker === null || picker.disabled) return;
			observer.disconnect();
			clearTimeout(timeout);
			resolve(picker);
		});
		const timeout = setTimeout(() => {
			observer.disconnect();
			reject(new Error("Initial effort picker did not become enabled"));
		}, 5000);
		observer.observe(host, {subtree: true, childList: true, attributes: true});
	});
	button.click();
}
