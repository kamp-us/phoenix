/**
 * What closing the Scope has to do, and what a subprocess that goes away has to say.
 *
 * The subprocess is a fake `spawnClaudeCodeProcess` that records a spawn and a kill and never
 * speaks the protocol, so nothing here spawns a child: the whole assertion is on the two calls the
 * SDK makes on the layer's behalf.
 */

import type {CanUseTool} from "@anthropic-ai/claude-agent-sdk";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Option, Stream} from "effect";
import {DENIED_MESSAGE} from "./cards.ts";
import {fakeSpawn} from "./fixtures/fake-spawn.ts";
import {CWD, onScripted, START_EVENTS, settled} from "./fixtures/harness.ts";
import {scriptedSdk} from "./fixtures/scripted-query.ts";

const options = (spawn: ReturnType<typeof fakeSpawn>) => ({spawn: spawn.spawn});

describe("closing the Scope", () => {
	it.effect("calls Query.close exactly once and kills the subprocess", () =>
		Effect.gen(function* () {
			const spawn = fakeSpawn();
			const scripted = scriptedSdk({opening: []});
			yield* onScripted(options(spawn), scripted, (agent) => agent.start({cwd: CWD}));
			assert.lengthOf(spawn.spawns, 1);
			assert.strictEqual(scripted.opened[0]?.record.closes, 1);
			assert.deepStrictEqual(spawn.kills, ["SIGTERM"]);
		}),
	);

	it.effect("closes once even when the run already asked for a second session", () =>
		Effect.gen(function* () {
			const spawn = fakeSpawn();
			const scripted = scriptedSdk({opening: []});
			yield* onScripted(options(spawn), scripted, (agent) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD});
					yield* agent.start({cwd: CWD});
				}),
			);
			assert.lengthOf(scripted.opened, 2);
			assert.deepStrictEqual(
				scripted.opened.map((one) => one.record.closes),
				[1, 1],
			);
		}),
	);

	it.effect("resolves every parked permission as denied, so nothing stays blocked", () =>
		Effect.gen(function* () {
			const spawn = fakeSpawn();
			const scripted = scriptedSdk({opening: []});
			let parked: Promise<unknown> | null = null;
			yield* onScripted(options(spawn), scripted, (agent) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD});
					const ask = scripted.opened[0]?.record.options.canUseTool as CanUseTool;
					parked = ask(
						"Bash",
						{},
						{
							signal: new AbortController().signal,
							toolUseID: "toolu_00000000000000000077",
							requestId: "req_1",
						},
					);
					yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
				}),
			);
			assert.isNotNull(parked);
			assert.deepStrictEqual(yield* settled(parked as Promise<unknown>), {
				behavior: "deny",
				message: DENIED_MESSAGE,
			});
		}),
	);
});

describe("a subprocess that goes before its turn produced a result", () => {
	it.effect("fails the stream with a TransportError naming the exit", () =>
		Effect.gen(function* () {
			const spawn = fakeSpawn();
			const scripted = scriptedSdk({opening: []});
			const exit = yield* onScripted(options(spawn), scripted, (agent) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD});
					yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
					spawn.exit(1, null);
					scripted.opened[0]?.stop();
					return yield* Effect.exit(Stream.runCollect(Stream.take(agent.events, 1)));
				}),
			);
			const error = Exit.isFailure(exit)
				? (Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as
						| {_tag?: string; reason?: string; detail?: string}
						| undefined)
				: undefined;
			assert.strictEqual(error?._tag, "tuval/ai-agent/TransportError");
			assert.strictEqual(error?.reason, "disconnected");
			assert.include(error?.detail ?? "", "exited with code 1");
		}),
	);

	it.effect("does not respawn: one spawn, one query, and no second open", () =>
		Effect.gen(function* () {
			const spawn = fakeSpawn();
			const scripted = scriptedSdk({opening: []});
			yield* onScripted(options(spawn), scripted, (agent) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD});
					yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
					spawn.exit(null, "SIGKILL");
					scripted.opened[0]?.stop();
					yield* Effect.exit(Stream.runCollect(Stream.take(agent.events, 1)));
				}),
			);
			assert.lengthOf(spawn.spawns, 1);
			assert.lengthOf(scripted.opened, 1);
		}),
	);

	it.effect("ends the stream cleanly when the turn had already settled", () =>
		Effect.gen(function* () {
			const spawn = fakeSpawn();
			const scripted = scriptedSdk({opening: []});
			const exit = yield* onScripted(options(spawn), scripted, (agent) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD});
					scripted.opened[0]?.say({
						type: "result",
						subtype: "success",
						is_error: false,
						total_cost_usd: 0,
						usage: {input_tokens: 1, output_tokens: 1},
					} as never);
					yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
					scripted.opened[0]?.stop();
					return yield* Effect.exit(Stream.runCollect(Stream.take(agent.events, 1)));
				}),
			);
			assert.isTrue(Exit.isSuccess(exit));
		}),
	);
});
