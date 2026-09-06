/**
 * What closing the process's Scope has to do, and what the token must never reach — both driven
 * through `aiAgentOverHost` on the scripted `PiSessionHost`, so a real server binds a real loopback
 * port and a real client dials it without a model or a second of wall clock. That door is
 * `PiAiAgent.layer` minus the model runtime, which declares no `dispose` or `close` and so adds
 * nothing to what closing the scope has to release.
 *
 * "Exactly once" is asserted two ways because the layer holds two different things. The session is
 * counted by the scripted host, which records every `dispose`. The server and the client are
 * counted by the process's own open handles: `process.getActiveResourcesInfo()` names a listening
 * socket `TCPSERVERWRAP` and a connected one `TCPWRAP`
 * ([Node, "process.getActiveResourcesInfo()"](https://nodejs.org/api/process.html#processgetactiveresourcesinfo)),
 * so a run that returns to its own baseline left neither behind.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, Layer, Option, Stream} from "effect";
import {type AgentEvent, TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {makeScriptedHost} from "../server/fixtures.ts";
import {aiAgentOverHost} from "./PiAiAgent.ts";

const CWD = "/tuval/teardown";

/** 32 random bytes as hex is what `mintCapabilityToken` makes, and what must appear nowhere. */
const TOKEN_SHAPE = /(^|[^0-9a-f])[0-9a-f]{64}([^0-9a-f]|$)/;

const sockets = (): {server: number; open: number} => {
	const handles = process.getActiveResourcesInfo();
	return {
		server: handles.filter((handle) => handle === "TCPSERVERWRAP").length,
		open: handles.filter((handle) => handle === "TCPWRAP").length,
	};
};

/**
 * A socket closes on the event loop, not on the scope's last statement, so the baseline is met a
 * tick or two later. The wait is capped well under the suite budget and names which handle class
 * outlived the scope, so the failure line is the diagnosis rather than a timeout
 * (`.patterns/ci-legible-integration-tests.md`, rules 2 and 3).
 */
const settleTo = (baseline: {server: number; open: number}) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 60; attempt += 1) {
			const now = sockets();
			if (now.server <= baseline.server && now.open <= baseline.open) return;
			yield* Effect.sleep("50 millis");
		}
		const now = sockets();
		assert.fail(
			`the closed scope left sockets open: listening ${now.server} (baseline ${baseline.server}), connected ${now.open} (baseline ${baseline.open})`,
		);
	});

const drive = (collected: Array<AgentEvent>) =>
	Effect.gen(function* () {
		const agent = yield* TuvalAiAgent;
		const started = yield* agent.start({cwd: CWD});
		const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
		yield* agent.prompt("hello");
		// The scripted host answers in-process, so the pushed snapshot is one round trip away;
		// taking a bounded slice keeps this from waiting on a stream that never ends.
		yield* Stream.runForEach(Stream.take(Stream.fromQueue(events), 4), (event) =>
			Effect.sync(() => collected.push(event)),
		).pipe(Effect.timeout("5 seconds"), Effect.orDie);
		return started.sessionId;
	});

describe("closing the process's scope", () => {
	it.live("terminates the client, the server and every session exactly once", () => {
		const host = makeScriptedHost();
		const collected: Array<AgentEvent> = [];
		return Effect.gen(function* () {
			const baseline = sockets();
			const sessionId = yield* drive(collected).pipe(
				Effect.provide(aiAgentOverHost().pipe(Layer.provide(host.layer))),
				Effect.scoped,
			);

			assert.deepStrictEqual(
				[...host.disposals.entries()],
				[[sessionId, 1]],
				"the one session this run opened was disposed exactly once",
			);
			yield* settleTo(baseline);
		});
	});
});

/**
 * The regression #7896 filed: a stop taken while a turn is in flight, rather than between turns.
 * The scripted host's reply is still four seconds out when the scope closes, so the run either
 * returns while the turn is unfinished or it is the reported hang.
 *
 * The run is forked and *awaited* under a bound rather than wrapped in `Effect.timeout`: a timeout
 * interrupts its source and waits for it, and a scope finalizer is uninterruptible, so wrapping the
 * hang would hang the wrapper too. Awaiting the fiber instead leaves the failure line as the
 * diagnosis (`.patterns/ci-legible-integration-tests.md`).
 *
 * The outer bound only tells a hang from a return; what pins the *correct* return is
 * `CLOSE_BOUND_MS` over the close alone, measured from the run's last statement. It sits under
 * every degraded shape this close could take — one `boundedTeardown` ceiling (5s), two of them in
 * series, and a close that merely waits the scripted turn's remaining 3.75s out — so none of them
 * can pass as the correct return, which measures in tens of milliseconds.
 */
const TURN_MS = 4_000;
const REACHED_MS = 250;
const CLOSE_BOUND_MS = 1_000;

describe("closing the process's scope with a turn in flight", () => {
	it.live("returns, and still disposes the session exactly once", () => {
		const host = makeScriptedHost({promptDelayMs: TURN_MS});
		let leftAt = 0;
		return Effect.gen(function* () {
			const baseline = sockets();
			const run = Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const started = yield* agent.start({cwd: CWD});
				// `prompt` returns at the send (#8018), so the turn is running when this returns and
				// the sleep is only there to let the host reach it before the scope closes.
				yield* agent.prompt("mid-turn");
				yield* Effect.sleep(`${REACHED_MS} millis`);
				yield* Effect.sync(() => {
					leftAt = Date.now();
				});
				return started.sessionId;
			}).pipe(Effect.provide(aiAgentOverHost().pipe(Layer.provide(host.layer))), Effect.scoped);

			const fiber = yield* Effect.forkDetach(run);
			const stopped = yield* Fiber.awaitAll([fiber]).pipe(Effect.timeoutOption("20 seconds"));
			assert.isTrue(
				Option.isSome(stopped),
				"closing the scope with a turn in flight never returned",
			);
			const sessionId = yield* Fiber.join(fiber);
			assert.isBelow(
				Date.now() - leftAt,
				CLOSE_BOUND_MS,
				`the close returned, but took long enough to be a ceiling expiring or the ${TURN_MS}ms turn being waited out rather than a stop taken mid-turn`,
			);

			assert.deepStrictEqual(
				[...host.disposals.entries()],
				[[sessionId, 1]],
				"a stop mid-turn disposed the session other than exactly once",
			);
			yield* settleTo(baseline);
		});
	});
});

describe("the per-launch token in flight", () => {
	it.live("reaches no event, no method's answer and no log line", () => {
		const host = makeScriptedHost();
		const collected: Array<AgentEvent> = [];
		const logged: Array<string> = [];
		const sinks = ["log", "info", "warn", "error"] as const;
		const originals = sinks.map((sink) => console[sink]);
		for (const sink of sinks) {
			console[sink] = (...parts: ReadonlyArray<unknown>) => {
				logged.push(parts.map(String).join(" "));
			};
		}

		return Effect.gen(function* () {
			yield* drive(collected).pipe(
				Effect.provide(aiAgentOverHost().pipe(Layer.provide(host.layer))),
				Effect.scoped,
			);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					sinks.forEach((sink, index) => {
						console[sink] = originals[index] as typeof console.log;
					});
				}),
			),
			Effect.tap(() =>
				Effect.sync(() => {
					assert.isAbove(collected.length, 0, "the run produced events to search");
					assert.notMatch(JSON.stringify(collected), TOKEN_SHAPE);
					assert.notMatch(logged.join("\n"), TOKEN_SHAPE);
				}),
			),
		);
	});
});
