/**
 * The two calls that carry a turn — `prompt` and `interrupt` — and the history read behind `page`.
 *
 * `prompt` is asserted through the input iterable the SDK actually reads, not through a call
 * counter: what the session receives is the only thing that matters, and the scripted `Query`
 * consumes the iterable exactly as the real one does.
 */

import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Logger, Option, Stream} from "effect";
import {
	CWD,
	message,
	OPENED_EVENTS,
	on,
	rows,
	SESSION_ID,
	TOOL_SESSION_ID,
} from "./fixtures/harness.ts";

const sent = (prompts: ReadonlyArray<{message: {content: unknown}}>): ReadonlyArray<unknown> =>
	prompts.map((one) => one.message.content);

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

describe("prompt", () => {
	it.effect("puts the operator's text on the session's input stream", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("hello");
				yield* Effect.yieldNow;
				const record = scripted.opened[0]?.record;
				assert.deepStrictEqual(sent(record?.prompts ?? []), ["hello"]);
				assert.strictEqual(record?.prompts[0]?.session_id, SESSION_ID);
			}),
		),
	);

	it.effect("drops a key this session already saw rather than re-sending it", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("hello", "turn-1");
				yield* agent.prompt("hello", "turn-1");
				yield* agent.prompt("hello again", "turn-2");
				yield* Effect.yieldNow;
				assert.deepStrictEqual(sent(scripted.opened[0]?.record.prompts ?? []), [
					"hello",
					"hello again",
				]);
			}),
		),
	);

	it.effect("admits a key the previous session spent, because keys belong to a session", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("hello", "turn-1");
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("hello", "turn-1");
				yield* Effect.yieldNow;
				assert.deepStrictEqual(sent(scripted.opened[1]?.record.prompts ?? []), ["hello"]);
			}),
		),
	);

	it.effect("sends an unkeyed repeat, because a deliberate resend mints no key", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("hello");
				yield* agent.prompt("hello");
				yield* Effect.yieldNow;
				assert.lengthOf(scripted.opened[0]?.record.prompts ?? [], 2);
			}),
		),
	);

	it.effect("refuses before a session is open", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(on({}, (agent) => agent.prompt("hello")));
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/PromptError");
			assert.strictEqual(failure(exit).reason, "no-session");
		}),
	);
});

describe("interrupt", () => {
	it.effect("reaches Query.interrupt", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.interrupt;
				assert.strictEqual(scripted.opened[0]?.record.interrupts, 1);
			}),
		),
	);

	it.effect("is a no-op with no session, and never fails", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.interrupt;
				assert.lengthOf(scripted.opened, 0);
			}),
		),
	);
});

describe("page", () => {
	it.effect("reads the session's own store and returns the page oldest-first", () =>
		on({rows: rows()}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD, resume: TOOL_SESSION_ID});
				const page = yield* agent.page(null, 10);
				assert.deepStrictEqual(
					page.items.map((one) => one.kind),
					["user", "tool", "assistant"],
				);
				assert.isFalse(page.hasMore);
			}),
		),
	);

	it.effect("reads through the id it resumed, which is the id the CLI hands back", () =>
		on({rows: rows(), opening: [message("resumed-init")]}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD, resume: SESSION_ID});
				yield* agent.page(null, 10);
				// A plain `resume` keeps the session's id — `resumed-init.json` is a real second
				// `query()` over the same id (`../history/fixtures/PROVENANCE.md`) — so the existence
				// check, the query's `resume` and every later store read are one session.
				assert.strictEqual(scripted.opened[0]?.record.options.resume, SESSION_ID);
				assert.deepStrictEqual(scripted.reads, [
					{sessionId: SESSION_ID, dir: CWD},
					{sessionId: SESSION_ID, dir: CWD},
				]);
			}),
		),
	);

	it.effect("warns when the CLI's init frame names a session other than the one opened", () =>
		Effect.gen(function* () {
			const warnings: Array<string> = [];
			yield* on({rows: rows(), opening: [message("resumed-init")]}, (agent) =>
				Effect.gen(function* () {
					// `resumed-init` names SESSION_ID, so resuming TOOL_SESSION_ID is a CLI that opened
					// a session other than the one the layer is keyed on — silent, and it would break
					// every later read.
					yield* agent.start({cwd: CWD, resume: TOOL_SESSION_ID});
					yield* Stream.runCollect(Stream.take(agent.events, OPENED_EVENTS));
				}),
			).pipe(
				Effect.provide(
					Logger.layer([
						Logger.make(({logLevel, message: line}) => {
							if (logLevel !== "Warn") return;
							warnings.push(String(Array.isArray(line) ? line[0] : line));
						}),
					]),
				),
			);
			const warned = warnings.find((each) => each.includes(SESSION_ID));
			assert.isDefined(warned);
			assert.include(warned ?? "", TOOL_SESSION_ID);
		}),
	);

	it.effect("refuses a cursor no item in the store carries", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({rows: rows()}, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD, resume: TOOL_SESSION_ID});
						return yield* agent.page("no-such-item", 10);
					}),
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/PageError");
			assert.strictEqual(failure(exit).reason, "unknown-cursor");
		}),
	);

	it.effect("refuses before a session is open", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(on({}, (agent) => agent.page(null, 10)));
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/PageError");
			assert.strictEqual(failure(exit).reason, "store-unreadable");
		}),
	);

	it.effect("turns a throwing read into a PageError naming what the store said", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({readFails: new Error("the transcript is unreadable")}, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						return yield* agent.page(null, 10);
					}),
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/PageError");
			assert.strictEqual(failure(exit).reason, "store-unreadable");
			assert.include(failure(exit).detail ?? "", "the transcript is unreadable");
		}),
	);
});
