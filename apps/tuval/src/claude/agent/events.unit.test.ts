/**
 * One stream, every kind. The turn replayed here is `tool-turn.json` — a real captured run of a
 * `Bash` call and its answer — so the item ids, the statuses and the usage numbers are the SDK's
 * own rather than a shape this test invented (`.patterns/golden-real-payload-fixtures.md`).
 */

import type {CanUseTool} from "@anthropic-ai/claude-agent-sdk";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Stream} from "effect";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {Mode} from "../../ai-agent/ports/index.ts";
import {CWD, MODES, messages, OPENED_EVENTS, on, settled} from "./fixtures/harness.ts";

/**
 * The tool turn's four frames after `init`, folded: the call opens `running`, its answer settles it
 * `ok`, the reply lands, and the result reports spend. The first assistant frame carries only the
 * `tool_use` block, so it earns no text item of its own.
 */
const TURN_EVENTS = 4;

describe("events over a captured tool turn", () => {
	it.effect("carries the turn's items and its usage in one ordered stream", () =>
		on({opening: messages("tool-turn")}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(
					Stream.take(agent.events, OPENED_EVENTS + TURN_EVENTS),
				);
				assert.deepStrictEqual(
					events.map((event) => event.kind),
					// The start's own three, then the first turn's `init` — its ready phase and the
					// model it names — and then the turn itself.
					["phase", "phase", "mode", "phase", "usage", "item", "item", "item", "usage"],
				);
			}),
		),
	);

	it.effect("re-sends the same item id, running then ok", () =>
		on({opening: messages("tool-turn")}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(
					Stream.take(agent.events, OPENED_EVENTS + TURN_EVENTS),
				);
				const tools = events.flatMap((event: AgentEvent) =>
					event.kind === "item" && event.item.kind === "tool" ? [event.item] : [],
				);
				assert.lengthOf(tools, 2);
				assert.strictEqual(tools[0]?.id, tools[1]?.id);
				assert.deepStrictEqual(
					tools.map((one) => one.status),
					["running", "ok"],
				);
				assert.strictEqual(tools[0]?.name, "Bash");
			}),
		),
	);

	it.effect("reports the turn's spend against the model init named", () =>
		on({opening: messages("tool-turn")}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(
					Stream.take(agent.events, OPENED_EVENTS + TURN_EVENTS),
				);
				const usage = events[OPENED_EVENTS + TURN_EVENTS - 1];
				assert.strictEqual(usage?.kind, "usage");
				assert.strictEqual(usage?.kind === "usage" ? usage.model : "", "claude-fable-5-1");
			}),
		),
	);
});

describe("every kind rides the one stream", () => {
	it.effect("interleaves items, a permission card, its resolution and a mode switch", () =>
		on({opening: messages("tool-turn")}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const turn = yield* Stream.runCollect(
					Stream.take(agent.events, OPENED_EVENTS + TURN_EVENTS),
				);
				const ask = scripted.opened[0]?.record.options.canUseTool as CanUseTool;
				const pending = ask(
					"Bash",
					{},
					{
						signal: new AbortController().signal,
						toolUseID: "toolu_00000000000000000099",
						requestId: "req_1",
					},
				);
				const card = yield* Stream.runCollect(Stream.take(agent.events, 1));
				yield* agent.answer("toolu_00000000000000000099", "allow-once");
				yield* settled(pending);
				yield* agent.setMode(Mode.make("plan"));
				const rest = yield* Stream.runCollect(Stream.take(agent.events, 2));
				assert.deepStrictEqual(
					[...turn, ...card, ...rest].map((event) => event.kind),
					[
						"phase",
						"phase",
						"mode",
						"phase",
						"usage",
						"item",
						"item",
						"item",
						"usage",
						"permission",
						"permission-resolved",
						"mode",
					],
				);
				assert.deepStrictEqual(rest[1], {
					kind: "mode",
					current: Mode.make("plan"),
					available: MODES,
				});
			}),
		),
	);
});
