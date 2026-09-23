/**
 * Pi on its own faux provider, as a `TuvalAiAgent` layer: the one host every Pi proof boots.
 *
 * `fauxProvider` is Pi's own (`@earendil-works/pi-ai`), so a proof standing on this layer runs the
 * real agent loop against scripted replies — no key, no model API, no cost (founder ruling
 * 2026-09-02, amended on #7573: the real provider is exercised by hand, never in CI).
 *
 * The provider is minted per call, which is what makes a restart proof honest: two boots of one
 * config module are two runtimes, and the only things that cross between them are the JSONL and the
 * checkpoint — the things actually under test.
 *
 * Two options are load-bearing rather than tidy. `authPath` and `agentDir` sit under the desk's own
 * state dir, so nothing reads or writes the operator's `~/.pi`; `allowModelNetwork: false` makes
 * that structural instead of a promise.
 *
 * The state dir is where the session store goes too, so this substitute layer lives under the same
 * law the shipped row does (ADR 0402): the proof's project root is the session's cwd and nothing
 * more, and a proof writes nothing into it.
 */

import {join} from "node:path";
import type {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {fauxProvider} from "@earendil-works/pi-ai";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import type {TuvalAiAgent} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import {featuresDefault} from "@kampus/tuval-sdk/kernel/features";
import {piSessionStore, StateDir} from "@kampus/tuval-sdk/kernel/state-dir";
import {Effect, Layer} from "effect";
import {aiAgentOverHost} from "../ai-agent/PiAiAgent.ts";
import {agentSessionHostLayer, SessionOpenFailed, subagentExtensionPaths} from "../server/index.ts";

/** The model the faux provider advertises. Its rates are per million tokens, as Pi's catalog states them. */
export const FAUX_MODEL = {provider: "faux", id: "faux-1"} as const;

/** One scripted reply, as Pi's own helpers build one. */
export type FauxReply = ReturnType<typeof fauxAssistantMessage>;

export interface FauxPiOptions {
	/** The project root: the session cwd, and nothing else. Nothing is written under it. */
	readonly root: string;
	/** What the provider answers, in order. A turn past the end of this list is a proof asking for one too many. */
	readonly replies: ReadonlyArray<FauxReply>;
}

/**
 * The `TuvalAiAgent` layer a `pi-session` row runs under in a proof: `aiAgentOverHost` over a Pi
 * session host whose model runtime knows one provider and no built-in tools.
 *
 * `noTools: "all"` is why a scripted tool call answers "that tool is not available here" rather than
 * touching the caller's disk — the tool *turn* is still exercised end to end, which is the item a
 * transcript proof needs.
 */
export const fauxPiLayer = ({
	root,
	replies,
}: FauxPiOptions): Layer.Layer<TuvalAiAgent, never, StateDir> =>
	Layer.unwrap(Effect.map(StateDir, (state) => fauxOverStateDir({root, replies}, state.path)));

const fauxOverStateDir = (
	{root, replies}: FauxPiOptions,
	stateDir: string,
): Layer.Layer<TuvalAiAgent> => {
	const agentDir = join(stateDir, "proof-pi-agent");
	const sessionDir = piSessionStore(stateDir);
	return aiAgentOverHost({model: FAUX_MODEL, projectRoot: root, sessionDir}).pipe(
		Layer.provide(
			Layer.unwrap(
				Effect.tryPromise({
					try: async () => {
						const faux = fauxProvider({
							provider: FAUX_MODEL.provider,
							api: "faux",
							models: [
								{id: FAUX_MODEL.id, cost: {input: 3, output: 15, cacheRead: 0, cacheWrite: 0}},
							],
						});
						faux.setResponses([...replies]);
						const modelRuntime = await ModelRuntime.create({
							modelsPath: null,
							refreshOnCreate: false,
							allowModelNetwork: false,
							authPath: join(agentDir, "auth.json"),
						});
						modelRuntime.registerNativeProvider(faux.provider);
						// The same flag the shipped row reads (`../ai-agent/PiAiAgent.ts`), so flipping it
						// and running `proof:pi-vertical` is the hand check for the extension (#8555).
						// The child a `subagent` call spawns is a detached process with its own
						// `ModelRuntime`, so it never sees this faux provider and needs a real model.
						const extensionPaths = subagentExtensionPaths(featuresDefault);
						return agentSessionHostLayer({
							modelRuntime,
							agentDir,
							projectRoot: root,
							sessionDir,
							// `"all"` is no tools at all; `"builtin"` leaves extension tools active and the four
							// disk-touching built-ins inactive (`pi-coding-agent` `dist/core/sdk.js:141,144`
							// with `agent-session.js:2086-2100`), which is what lets the turn reach
							// `subagent`. Weaker than `"all"`, though: under `"builtin"` the builtins stay
							// registered and allowed, so a `setActiveToolsByName` could bring them back.
							noTools: extensionPaths.length === 0 ? "all" : "builtin",
							...(extensionPaths.length === 0 ? {} : {extensionPaths}),
						});
					},
					catch: (cause) => new SessionOpenFailed({cwd: root, detail: String(cause)}),
				}).pipe(Effect.orDie),
			),
		),
	);
};
