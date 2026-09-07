import type {ModelInfo} from "@anthropic-ai/claude-agent-sdk";
import {Effect, Stream} from "effect";
import {foldEvent, initialState} from "../../ai-agent/core/index.ts";
import {CWD, message, on, START_EVENTS} from "../agent/fixtures/harness.ts";

const models: ReadonlyArray<ModelInfo> = [
	{value: "haiku", displayName: "Haiku", description: "No effort axis"},
	{
		value: "opus",
		resolvedModel: "claude-opus-5",
		displayName: "Opus 5",
		description: "Scripted catalog row, not a live model claim",
		supportsEffort: true,
		supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
	},
];

/** Real layer and core, scripted SDK/KernelBridge; never opens the real CLI or sends a prompt. */
export const initialEffortProof = () =>
	on(
		{
			models,
			runningModel: "claude-opus-5",
			opening: [message("init")],
			deferOpening: true,
		},
		(agent, scripted) =>
			Effect.gen(function* () {
				const startedAt = new Date().toISOString();
				const start = performance.now();
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				const record = scripted.opened[0]?.record;
				return {
					boundary:
						"Real ClaudeAiAgent and core; scripted SDK and KernelBridge; no CLI, kernel transport or model spend",
					startedAt,
					elapsedMs: performance.now() - start,
					events,
					state: events.reduce((state, event) => foldEvent(state, event, {}), initialState(CWD)),
					record: {
						configuredModel: record?.options.model ?? null,
						prompts: record?.prompts.length ?? -1,
						modelSelections: record?.models ?? [],
						effortSelections: record?.efforts ?? [],
						contextReads: record?.contextReads ?? [],
					},
				};
			}),
	);

export type InitialEffortProof = Effect.Success<ReturnType<typeof initialEffortProof>>;
