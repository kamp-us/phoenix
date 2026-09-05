/**
 * The Pi window in a real browser, without a kernel, a socket or a Pi server.
 *
 * jsdom has no layout, so every claim about paint — where the usage line sits in the bar, that it
 * wraps instead of pushing the mode switch off the end, that it reads dark — is unfalsifiable in the
 * unit tier. The harness ships rather than being deleted after the run (#7610, review-code FAIL
 * 2026-09-05): `pnpm proof:pi-window` from `apps/tuval` serves this page, so a reviewer reproduces
 * the load instead of taking a report for it.
 *
 * Two windows over one `testProcess` — the same double the unit tier renders against — because one
 * of the facts under test is that two windows show one usage figure. The usage totals move on a
 * timer here purely so a loaded page shows the line changing; no agent, no model and no network is
 * involved, and nothing about Pi's backend is exercised or claimed.
 */

import {Effect} from "effect";
import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../../ai-agent/core/index.ts";
import {ProcessId} from "../../../process/process.ts";
import {type ChatView, initialChatView} from "../../../shell/chat/index.ts";
import {type TestProcess, testProcess} from "../../../shell/window/fixtures.ts";
import {WindowId} from "../../../shell/window/index.ts";
import {piChatWindow} from "../PiChatWindow.tsx";
import {piSession, usageOf} from "../pi-window.testing.ts";
import "../../../shell/ui/tokens.css";
import "./proof.css";

const MODEL = "anthropic/claude-sonnet-4-5-20250929";

const state: AiAgentSessionState = piSession({
	usage: usageOf({model: MODEL, cost: 0.0142, input: 1204, output: 340}),
});

const view: ChatView = initialChatView;

const mount = Effect.gen(function* () {
	const host = document.getElementById("proof");
	if (host === null) return yield* Effect.die(new Error("the proof page has no #proof element"));
	const process = yield* testProcess<AiAgentSessionState, AiAgentSessionMsg>(
		ProcessId.make("proof"),
		state,
	);
	const left = yield* process.window<ChatView>(WindowId.make("left"), view);
	const right = yield* process.window<ChatView>(WindowId.make("right"), view);
	const renderer = piChatWindow();
	createRoot(host).render(
		<StrictMode>
			<div className="tuval-surface proof-desk" data-scheme="dark">
				<div className="proof-pane">{renderer.render(left)}</div>
				<div className="proof-pane">{renderer.render(right)}</div>
			</div>
		</StrictMode>,
	);
	return process;
});

const turn = (
	process: TestProcess<AiAgentSessionState, AiAgentSessionMsg>,
	count: number,
): Effect.Effect<void> =>
	process.commit({
		...state,
		usage: usageOf({
			model: MODEL,
			cost: 0.0142 + count * 0.0091,
			input: 1204 + count * 812,
			output: 340 + count * 219,
		}),
	});

void Effect.runPromise(mount).then((process) => {
	let count = 0;
	// The ticker lives out here rather than inside `mount`, because a `runFork` inside a running
	// Effect drops the surrounding services (`effect(runEffectInsideEffect)`); nothing in this
	// harness needs them, and keeping the seam honest costs one function.
	setInterval(() => {
		count += 1;
		void Effect.runFork(turn(process, count));
	}, 2_000);
});
