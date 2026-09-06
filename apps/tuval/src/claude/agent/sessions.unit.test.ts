/**
 * The Claude backend's `listSessions`, driven with no CLI present.
 *
 * Everything here runs through the scripted `AgentSdk`, which is why the seam's fourth member
 * exists: a listing is a read of the CLI's on-disk store, and no test may depend on what that
 * machine happens to hold.
 */

import type {SDKSessionInfo} from "@anthropic-ai/claude-agent-sdk";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Option} from "effect";
import {on} from "./fixtures/harness.ts";

const failure = (
	exit: Exit.Exit<unknown, unknown>,
): {_tag?: string; reason?: string; detail?: string} =>
	Exit.isFailure(exit)
		? ((Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ?? {}) as {
				_tag?: string;
				reason?: string;
				detail?: string;
			})
		: {};

const stored: ReadonlyArray<SDKSessionInfo> = [
	{
		sessionId: "00000000-0000-4000-8000-00000000000a",
		summary: "an older chat",
		lastModified: 1_760_000_000_000,
		firstPrompt: "why is the picker empty",
		cwd: "/Users/founder/code/phoenix",
		gitBranch: "main",
	},
	{
		sessionId: "00000000-0000-4000-8000-00000000000b",
		summary: "the newest chat",
		lastModified: 1_760_000_900_000,
		firstPrompt: "list my sessions",
		cwd: "/Users/founder/code/tuval",
		gitBranch: "umut/session-list",
	},
];

describe("listSessions on the Claude backend", () => {
	it.effect("answers the store's sessions newest first, tagged with this backend", () =>
		on({sessions: stored}, (agent) =>
			Effect.gen(function* () {
				const listed = yield* agent.listSessions;
				assert.deepStrictEqual(
					listed.map((one) => one.sessionId),
					[stored[1]?.sessionId, stored[0]?.sessionId],
				);
				assert.deepStrictEqual(listed[0], {
					sessionId: "00000000-0000-4000-8000-00000000000b",
					lastModified: 1_760_000_900_000,
					backend: "claude",
					firstPrompt: "list my sessions",
					folder: "/Users/founder/code/tuval",
					branch: "umut/session-list",
				});
			}),
		),
	);

	/**
	 * Ruling 3 (#8070): one unified list, every session on the machine whatever started it. The pin
	 * documents `includeProgrammatic: false` as the parity-with-`/resume` choice an IDE picker makes,
	 * which is the opposite — so what this pins is that the layer passes nothing at all and the SDK's
	 * `true` default stands.
	 */
	it.effect("passes no options, leaving includeProgrammatic at its true default", () =>
		on({sessions: stored}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.listSessions;
				assert.deepStrictEqual(scripted.lists, [undefined]);
			}),
		),
	);

	it.effect("reads the store without a session open, and answers an empty store truthfully", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* agent.listSessions, []);
				assert.lengthOf(scripted.opened, 0);
			}),
		),
	);

	it.effect("leaves absent what the store did not supply rather than filling it in", () =>
		on(
			{
				sessions: [
					{
						sessionId: "00000000-0000-4000-8000-00000000000c",
						summary: "a session the store knows little about",
						lastModified: 1_760_000_000_000,
					},
				],
			},
			(agent) =>
				Effect.gen(function* () {
					// `SDKSessionInfo` counts no messages at the pin, so `messageCount` is absent on
					// every Claude row — never `0`, which would render as an empty session.
					assert.deepStrictEqual(yield* agent.listSessions, [
						{
							sessionId: "00000000-0000-4000-8000-00000000000c",
							lastModified: 1_760_000_000_000,
							backend: "claude",
						},
					]);
				}),
		),
	);

	it.effect("turns a throwing listing into a ListError naming what the store said", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on(
					{listFails: new Error("the projects directory is unreadable")},
					(agent) => agent.listSessions,
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/ListError");
			assert.strictEqual(failure(exit).reason, "store-unreadable");
			assert.include(failure(exit).detail ?? "", "the projects directory is unreadable");
		}),
	);
});
