/**
 * What closing the process's Scope has to do, and what the token must never reach — both driven
 * through the real layer over the scripted `PiSessionHost`, so a real server binds a real loopback
 * port and a real client dials it without a model or a second of wall clock.
 *
 * "Exactly once" is asserted two ways because the layer holds two different things. The session is
 * counted by the scripted host, which records every `dispose`. The server and the client are
 * counted by the process's own open handles: `process.getActiveResourcesInfo()` names a listening
 * socket `TCPSERVERWRAP` and a connected one `TCPWRAP`
 * ([Node, "process.getActiveResourcesInfo()"](https://nodejs.org/api/process.html#processgetactiveresourcesinfo)),
 * so a run that returns to its own baseline left neither behind.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Stream} from "effect";
import {type AgentEvent, TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {makeScriptedHost} from "../server/fixtures.ts";
import {PiAiAgent} from "./index.ts";

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
				Effect.provide(PiAiAgent.layer().pipe(Layer.provide(host.layer))),
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
				Effect.provide(PiAiAgent.layer().pipe(Layer.provide(host.layer))),
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
