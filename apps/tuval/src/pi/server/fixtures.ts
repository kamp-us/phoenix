/**
 * A `PiSessionHost` with no model behind it: prompts append to the transcript and the change
 * signal fires exactly as a real session's does. Every unit test of the wire — correlation,
 * ownership, reconnect, the bounds, the scoped teardown — runs on this, so none of them needs a
 * provider, a socket to a model, or a second of wall clock.
 */

import type {ModelMetadata, TranscriptItem} from "@earendil-works/pi-protocol";
import {Effect, Layer, Queue} from "effect";
import {type PiSessionHandle, PiSessionHost, type PiSessionView} from "./PiSessionHost.ts";

export const scriptedModel: ModelMetadata = {
	provider: "scripted",
	id: "scripted-1",
	name: "Scripted",
	api: "scripted",
	reasoning: false,
	input: ["text"],
	contextWindow: 1024,
	maxTokens: 256,
	cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
	supportedThinkingLevels: ["off"],
	authenticated: true,
};

export interface ScriptedHost {
	readonly layer: Layer.Layer<PiSessionHost>;
	/** How many times each session's `dispose` ran, keyed by session id. */
	readonly disposals: ReadonlyMap<string, number>;
	readonly openCount: () => number;
}

export const makeScriptedHost = (options: {readonly promptDelayMs?: number} = {}): ScriptedHost => {
	const disposals = new Map<string, number>();
	let opened = 0;

	const layer = Layer.succeed(PiSessionHost, {
		models: Effect.succeed([scriptedModel]),
		open: (request) =>
			Effect.gen(function* () {
				const id = `scripted-session-${++opened}`;
				const changes = yield* Queue.make<void>({capacity: 1, strategy: "sliding"});
				const transcript: TranscriptItem[] = [];
				let phase: PiSessionView["phase"] = "idle";
				const steer: string[] = [];

				const append = (role: "user" | "assistant", text: string): void => {
					transcript.push(
						role === "user"
							? {
									id: `item-${transcript.length}`,
									role: "user",
									content: [{type: "text", text}],
									timestamp: transcript.length,
								}
							: {
									id: `item-${transcript.length}`,
									role: "assistant",
									content: [{type: "text", text}],
									model: {provider: scriptedModel.provider, id: scriptedModel.id},
									timestamp: transcript.length,
									status: "complete",
									stopReason: "stop",
								},
					);
					Queue.offerUnsafe(changes, undefined);
				};

				const handle: PiSessionHandle = {
					id,
					cwd: request.cwd,
					file: undefined,
					createdAt: 0,
					read: Effect.sync(() => ({
						phase,
						model: {provider: scriptedModel.provider, id: scriptedModel.id},
						thinkingLevel: "off",
						transcript: [...transcript],
						name: request.name,
						queuedSteer: [...steer],
					})),
					prompt: (text) =>
						Effect.gen(function* () {
							phase = "turn";
							append("user", text);
							if (options.promptDelayMs !== undefined) {
								yield* Effect.sleep(`${options.promptDelayMs} millis`);
							}
							append("assistant", `echo: ${text}`);
							phase = "idle";
						}),
					steer: (text) =>
						Effect.sync(() => {
							steer.push(text);
							Queue.offerUnsafe(changes, undefined);
						}),
					abort: Effect.sync(() => {
						phase = "idle";
						Queue.offerUnsafe(changes, undefined);
					}),
					setModel: () => Effect.void,
					setThinkingLevel: () => Effect.void,
					changes: Queue.take(changes),
					dispose: Effect.sync(() => {
						disposals.set(id, (disposals.get(id) ?? 0) + 1);
					}),
				};
				return handle;
			}),
	});

	return {layer, disposals, openCount: () => opened};
};
