/**
 * The interleaving #8034 named: an event the Sub has folded and the host has not applied yet, and
 * then a Cmd that re-seeds the projection from the committed state.
 *
 * It is driven at the handler set rather than through a spawned process, because the thing under
 * test is exactly the gap a running host closes for itself — the Msg the Sub dispatched waits for
 * the transition tail the Cmd's own commit is holding. Here `dispatch` records and applies nothing,
 * which holds that gap open for as long as the test needs it.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Scope} from "effect";
import {assistantItem} from "../../ai-agent-fixtures/transcripts.ts";
import {ProcessPorts} from "../../ports/index.ts";
import {ProcessId} from "../../process/process.ts";
import {ProcessSelf} from "../../process/self.ts";
import {
	type AiAgentSessionMsg,
	type AiAgentSessionState,
	eventsSub,
	initialState,
} from "../core/index.ts";
import type {TranscriptPayload} from "../ports/index.ts";
import {plainReply, SESSION_ID} from "../service/fixtures/scripts.ts";
import {ScriptedAiAgent} from "../service/index.ts";
import {aiAgentHandlers} from "./index.ts";
import {aiAgentPortNames} from "./publish.ts";

const CWD = "/w";

const settled = assistantItem("a-0", "first");
const late = assistantItem("a-1", "late");

/** What the core has committed: one settled reply, and nothing the first turn produced. */
const committed: AiAgentSessionState = {
	...initialState(CWD),
	phase: "ready",
	sessionId: SESSION_ID,
	transcript: {items: [settled], omitted: initialState(CWD).transcript.omitted},
};

/** Turn one narrates an item; turn two narrates nothing, so only the seed can publish it back. */
const script = {
	...plainReply,
	turns: [{events: [{kind: "item", item: late} as const]}, {events: []}],
};

describe("the prompt handler's re-seed", () => {
	it.live("keeps an item the Sub folded before the host applied its Msg", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const scope = yield* Effect.scope;
				const published: Array<{port: string; payload: unknown}> = [];
				const dispatched: Array<AiAgentSessionMsg> = [];

				const provide = <A, E>(
					effect: Effect.Effect<A, E, ProcessSelf | ProcessPorts | Scope.Scope>,
				) =>
					effect.pipe(
						Effect.provideService(Scope.Scope, scope),
						Effect.provideService(ProcessSelf, {
							id: ProcessId.make("seed-rebase"),
							scope,
							state: () => committed,
						}),
						Effect.provideService(ProcessPorts, {
							emit: (port: string, payload: unknown) =>
								Effect.sync(() => {
									published.push({port, payload});
									return [];
								}),
						}),
					);

				const row = aiAgentHandlers({
					layer: ScriptedAiAgent.layer(script),
					program: "seed-rebase",
					cwd: CWD,
				});

				yield* provide(
					row.handlers["aiAgent.start"]({
						type: "aiAgent.start",
						cwd: CWD,
						resume: null,
						mode: null,
					}),
				);
				yield* Effect.forkScoped(
					provide(
						row.subs["aiAgent.events"](
							eventsSub(SESSION_ID, 0),
							(msg) => void dispatched.push(msg),
						),
					),
				);
				yield* Effect.sleep("20 millis");

				yield* provide(
					row.handlers["aiAgent.prompt"]({type: "aiAgent.prompt", text: "one", key: "k1"}),
				);
				yield* Effect.sleep("20 millis");

				// The Sub folded the item and handed the host a Msg this test never applies, so the
				// committed state the second Cmd re-seeds from is a turn behind the projection.
				assert.isTrue(dispatched.some((msg) => msg.type === "event"));
				assert.deepStrictEqual(committed.transcript.items, [settled]);

				yield* provide(
					row.handlers["aiAgent.prompt"]({type: "aiAgent.prompt", text: "two", key: "k2"}),
				);

				const tails = published
					.filter((entry) => entry.port === aiAgentPortNames.transcript)
					.map((entry) => entry.payload as TranscriptPayload);
				assert.deepStrictEqual(
					tails.at(-1)?.items.map((item) => item.id),
					["a-0", "a-1"],
				);
			}),
		),
	);
});
