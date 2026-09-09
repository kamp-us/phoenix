/**
 * @vitest-environment jsdom
 *
 * The reproduced incident of #8542: a restored desk whose reconnect was refused, an operator
 * picking a model, the activity list reading "The agent model changed to Opus 5." and the composer's
 * button still reading "Sonnet 5".
 *
 * It runs the whole seam the founder ran by hand, minus the CLI: the real `ClaudeAiAgent` layer over
 * the scripted SDK, the real core fold, the real `composerBridge` and the shared `AgentChatInput`.
 * The layer's own events are what drive the composer, so neither half can be right on its own — the
 * layer announcing the clear does nothing if the picker paints the copy over the pick, and the
 * picker naming the pick does nothing if the layer never says the catalog is gone.
 */

import type {ModelInfo} from "@anthropic-ai/claude-agent-sdk";
import {AgentChatInput, DesignTranslationProvider} from "@kampus/design";
import {act, render, screen} from "@testing-library/react";
import {Effect, Stream} from "effect";
import type {ReactElement} from "react";
import {expect, it} from "vitest";
import {type AiAgentSessionState, foldEvent, initialState} from "../../ai-agent/core/index.ts";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {CWD, on, START_EVENTS, settled} from "../../claude/agent/fixtures/harness.ts";
import {installDomShims} from "../ui/dom.testing.ts";
import {type ComposerBridge, composerBridge} from "./composer-bridge.ts";
import {tuvalDesignTranslate} from "./copy.ts";

installDomShims();

const CATALOG: ReadonlyArray<ModelInfo> = [
	{
		value: "opus",
		resolvedModel: "claude-opus-5",
		displayName: "Opus 5",
		description: "Scripted catalog row, not a live model claim",
		supportsEffort: true,
		supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
	},
	{
		value: "sonnet",
		displayName: "Sonnet 5",
		description: "Scripted catalog row, not a live model claim",
		supportsEffort: true,
		supportedEffortLevels: ["low", "medium", "high"],
	},
];

/** What `ChatWindow` does with the four slices, in the order its effects run. */
const push = (composer: ComposerBridge, state: AiAgentSessionState): void => {
	composer.setPhase(state.phase);
	composer.setModels(state.models);
	composer.setCommands(state.commands);
	composer.setThinking(state.thinking);
};

const fold = (state: AiAgentSessionState, events: ReadonlyArray<AgentEvent>): AiAgentSessionState =>
	events.reduce((held, event) => foldEvent(held, event, {}), state);

const modelButton = async (): Promise<string> =>
	(await screen.findByRole("button", {name: /^model: /})).getAttribute("aria-label") ?? "";

it("names the held pick on the button when the reconnect left no catalog behind it", async () => {
	await Effect.runPromise(
		on(
			{
				models: CATALOG,
				runningModel: "claude-opus-5",
				openFails: new Error("the CLI would not spawn"),
				openFailsAt: 2,
			},
			(agent) =>
				Effect.gen(function* () {
					// The live half of the incident: a session on the scripted catalog, and the operator
					// picking Sonnet 5 on it.
					yield* agent.start({cwd: CWD});
					yield* agent.setModel({id: "sonnet", name: "Sonnet 5"});
					const opened = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 2));
					const live = fold(initialState(CWD), opened);
					expect(live.models.current).toEqual({id: "sonnet", name: "Sonnet 5"});

					// The restart: the window comes back on its checkpoint, which is why the composer is
					// mounted on the state above rather than on an empty one.
					const composer = composerBridge({
						initialPhase: live.phase,
						initialModels: live.models,
						initialCommands: live.commands,
						initialThinking: live.thinking,
						onPrompt: () => undefined,
						onInterrupt: () => undefined,
						onSetModel: () => undefined,
						onSetThinkingLevel: () => undefined,
					});
					yield* settled(
						act(async () => {
							render(
								(
									<DesignTranslationProvider translate={tuvalDesignTranslate}>
										<AgentChatInput bridge={composer.bridge} />
									</DesignTranslationProvider>
								) as ReactElement,
							);
						}),
					);
					expect(yield* settled(modelButton())).toContain("Sonnet 5");

					// The refused reconnect, and then the pick the founder made in that state.
					yield* Effect.exit(agent.start({cwd: CWD}));
					yield* agent.setModel({id: "opus", name: "Opus 5"});
					const after = yield* Stream.runCollect(Stream.take(agent.events, 6));
					const now = fold(live, after);
					yield* settled(act(async () => push(composer, now)));

					// The button follows the pick rather than contradicting it, and says the offer behind
					// it is empty rather than painting the dead session's rows as live.
					expect(now.models).toEqual({current: {id: "opus", name: "Opus 5"}, available: []});
					const named = yield* settled(modelButton());
					expect(named).toContain("Opus 5");
					expect(named).toContain("none offered");
					expect(named).not.toContain("Sonnet 5");
				}),
		),
	);
});
