/**
 * What an SDK exception is allowed to become, driven through the `TuvalAiAgent` the layer publishes
 * rather than through the refusal helpers directly (#8010).
 *
 * Every thrown value here carries `SENTINEL`. It stands for whatever an arbitrary exception happens
 * to hold — an absolute path, an internal frame, a token — and the assertion is the same each time:
 * absent from the public message the service returns, present on the cause the refusal retained.
 */

import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Option, Stream} from "effect";
import {CWD, on, SESSION_ID, START_EVENTS, TOOL_SESSION_ID} from "./fixtures/harness.ts";
import {promptDisconnected} from "./refusals.ts";

const SENTINEL = "sk-ant-oat01-NOT-A-REAL-KEY at /Users/founder/.claude/.credentials.json";

const thrown = (): Error => new Error(`ECONNRESET while reading ${SENTINEL}`);

type Refusal = Error & {_tag?: string; reason?: string; detail?: string};

const failure = (exit: Exit.Exit<unknown, unknown>): Refusal =>
	Exit.isFailure(exit)
		? ((Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ?? {}) as Refusal)
		: ({} as Refusal);

/** The public message stays clean and the thrown value stays reachable — the whole ruling, twice. */
const deliberate = (error: Error & {detail?: string}, names: string): void => {
	assert.notInclude(error.message, SENTINEL);
	assert.notInclude(error.detail ?? "", SENTINEL);
	assert.include(error.detail ?? "", names);
	assert.instanceOf(error.cause, Error);
	assert.include((error.cause as Error).message, SENTINEL);
};

describe("a start the store refuses", () => {
	it.effect("names the open and keeps the thrown value off the message", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({readFails: thrown()}, (agent) =>
					agent.start({
						cwd: CWD,
						resume: {sessionId: TOOL_SESSION_ID, holdsTranscript: false},
					}),
				),
			);
			const error = failure(exit);
			assert.strictEqual(error._tag, "tuval/ai-agent/StartError");
			assert.strictEqual(error.reason, "transport");
			deliberate(error, "did not open a session here");
		}),
	);
});

describe("a start the SDK refuses with a stamped cause", () => {
	it.effect("keeps the install guidance and still drops the thrown text", () =>
		Effect.gen(function* () {
			// The stamps `sdk.mjs` writes for a CLI it could not find. The message beside them is the
			// SDK's, and carries the path it looked at, so it is the thing that must not be repeated.
			const missing = Object.assign(
				new Error(`Claude Code native binary not found at ${SENTINEL}.`),
				{errorClass: "executable_not_found", code: "ENOENT"},
			);
			const exit = yield* Effect.exit(on({openFails: missing}, (agent) => agent.start({cwd: CWD})));
			const error = failure(exit);
			assert.strictEqual(error._tag, "tuval/ai-agent/StartError");
			assert.include(error.detail ?? "", "Claude Code is not installed");
			assert.notInclude(error.message, SENTINEL);
			assert.strictEqual(error.cause, missing);
		}),
	);

	it.effect("invents nothing for a cause carrying no stamp", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({openFails: thrown()}, (agent) => agent.start({cwd: CWD})),
			);
			const error = failure(exit);
			assert.strictEqual(
				error.detail,
				"the Claude Code CLI did not open a session here",
				"an undiagnosable cause gets the operation's name and nothing more",
			);
			deliberate(error, "did not open a session here");
		}),
	);
});

describe("a prompt the session will not take", () => {
	/**
	 * Driven at the refusal rather than through `prompt`, because the only thing that raises it is
	 * the input channel's own `push` throwing (`input.ts`) and no scripted SDK reaches that call.
	 */
	it("names the send and retains the thrown value", () => {
		const cause = thrown();
		const error = promptDisconnected(cause);
		assert.strictEqual(error._tag, "tuval/ai-agent/PromptError");
		assert.strictEqual(error.reason, "disconnected");
		deliberate(error, "did not take the message");
		assert.strictEqual(error.cause, cause);
	});
});

describe("a page of history the store refuses", () => {
	it.effect("names the read and keeps the thrown value off the message", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				// A fresh open reads nothing off the store, so `readFails` bites on the page alone.
				on({readFails: thrown()}, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						return yield* agent.page(null, 10);
					}),
				),
			);
			const error = failure(exit);
			assert.strictEqual(error._tag, "tuval/ai-agent/PageError");
			assert.strictEqual(error.reason, "store-unreadable");
			deliberate(error, "session store did not answer");
		}),
	);

	it.effect("says the same on a stored transcript read", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({readFails: thrown()}, (agent) =>
					agent.sessionTranscript({
						sessionId: SESSION_ID,
						cwd: CWD,
						before: null,
						limit: 10,
					}),
				),
			);
			const error = failure(exit);
			assert.strictEqual(error._tag, "tuval/ai-agent/TranscriptError");
			deliberate(error, "session store did not answer");
		}),
	);
});

describe("a session listing the store refuses", () => {
	it.effect("names the enumeration and keeps the thrown value off the message", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(on({listFails: thrown()}, (agent) => agent.listSessions));
			const error = failure(exit);
			assert.strictEqual(error._tag, "tuval/ai-agent/ListError");
			deliberate(error, "could not be enumerated");
		}),
	);
});

describe("a message stream that throws", () => {
	it.effect("fails events with a deliberate message and the thrown value retained", () =>
		Effect.gen(function* () {
			const exit = yield* on({}, (agent, scripted) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD});
					yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
					scripted.opened[0]?.fail(thrown());
					return yield* Effect.exit(Stream.runCollect(Stream.take(agent.events, 1)));
				}),
			);
			const error = failure(exit);
			assert.strictEqual(error._tag, "tuval/ai-agent/TransportError");
			assert.strictEqual(error.reason, "protocol");
			deliberate(error, "message stream stopped");
		}),
	);
});
