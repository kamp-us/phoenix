/**
 * Where the operator's own turn comes from on a Claude session, pinned in both directions.
 *
 * The mapping is not what drops it. `userEvents` maps the exact `SDKUserMessage` that
 * `../agent/input.ts` writes to a `user` item, bare-string `content` and all — the first case here.
 * What no Claude session produces is a *frame* to map: the CLI does not echo a submitted prompt
 * back on its output stream, so the second case drives a whole turn through the real layer and
 * reads that absence off the pump. Together they say the transcript's user row is the core's, from
 * the `prompt` cell (#7978), and never the layer's (#7979).
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Stream} from "effect";
import {expect} from "vitest";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {CWD, messages, OPENED_EVENTS, on, SESSION_ID} from "../agent/fixtures/harness.ts";
import {userMessage} from "../agent/input.ts";
import {toAgentEvents} from "./events.ts";
import {emptyMapping} from "./map.ts";

const AT = 1_700_000_000_000;
const PROMPT = "read the readme";

/** The tool turn's own five events after `init`, as `../agent/events.unit.test.ts` counts them. */
const TURN_EVENTS = 5;

const itemsIn = (events: ReadonlyArray<AgentEvent>) =>
	events.flatMap((event) => (event.kind === "item" ? [event.item] : []));

describe("the message the layer writes for one operator turn", () => {
	it("maps to a user item carrying its text, so nothing in the mapping drops it", () => {
		const step = toAgentEvents(userMessage(SESSION_ID, PROMPT), emptyMapping, {at: AT});
		expect(step.events).toEqual([
			{
				kind: "item",
				// The message carries no `uuid` — the layer writes it, the CLI has not stamped it yet
				// — so the mapping falls back to the clock it was handed.
				item: {kind: "user", id: `user-${AT}`, timestamp: AT, text: PROMPT},
			},
		]);
		assert.strictEqual(step.mapping.skipped, 0, "the operator's own message was counted as unread");
	});
});

describe("what a whole turn puts on the pump", () => {
	it.effect("carries the operator's message in and no user item back out", () =>
		on({opening: messages("tool-turn"), deferOpening: true}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt(PROMPT, "k1");
				const events = yield* Stream.runCollect(
					Stream.take(agent.events, OPENED_EVENTS + TURN_EVENTS),
				);

				// In: the turn reached the CLI as the very message the first case just mapped.
				const sent = scripted.opened[0]?.record.prompts ?? [];
				assert.lengthOf(sent, 1);
				assert.deepStrictEqual(sent[0], userMessage(SESSION_ID, PROMPT));

				// Out: the turn's own `tool_result` frame is a user frame and lands as a tool row, so
				// the absence below is the CLI never echoing the prompt rather than nothing arriving.
				const items = itemsIn([...events]);
				assert.deepStrictEqual(
					items.map((item) => item.kind),
					["tool", "tool", "assistant"],
				);
				assert.isEmpty(
					items.filter((item) => item.kind === "user"),
					"the Claude layer emitted a user item, so the transcript has two sources for one turn",
				);
			}),
		),
	);

	it.effect("reads the same absence off the mapping over the turn's raw frames", () =>
		Effect.sync(() => {
			const frames: ReadonlyArray<SDKMessage> = messages("tool-turn");
			let mapping = emptyMapping;
			const events: AgentEvent[] = [];
			for (const frame of frames) {
				const step = toAgentEvents(frame, mapping, {at: AT});
				mapping = step.mapping;
				events.push(...step.events);
			}
			assert.isEmpty(
				itemsIn(events).filter((item) => item.kind === "user"),
				"a captured turn carries a frame the mapping reads as the operator's own text",
			);
		}),
	);
});
