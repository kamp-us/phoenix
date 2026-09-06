/**
 * The page's connection lifecycle, over a scripted link. The tier is `unit`: every claim here is
 * about the loop's own arithmetic and its scopes, and each one could be wrong with a perfectly
 * healthy socket (`.patterns/effect-testing.md`). The socket itself is proven in a real browser by
 * `./proof/`.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import {ProcessId} from "../process/process.ts";
import type {ShellMsg} from "../shell/core/index.ts";
import type {AttachedProcess, PageAttachment} from "../shell/transport/browser.ts";
import {
	defaultRecovery,
	drive,
	dropKind,
	nextAttempt,
	noRecovery,
	type PageLink,
	type Recovery,
} from "./connection.ts";

const closeWith = (code: number) =>
	new Socket.SocketError({reason: new Socket.SocketCloseError({code})});

const neverOpened = new Socket.SocketError({
	reason: new Socket.SocketOpenError({kind: "Unknown", cause: new Error("refused")}),
});

const link = (closed: Effect.Effect<Socket.SocketError>): PageLink => ({
	page: {
		rows: Stream.empty,
		programs: Stream.empty,
		keys: Stream.empty,
		attachProcess: (() => Effect.never) as PageAttachment["attachProcess"],
		call: () => Effect.never,
		detach: () => Effect.void,
		closed,
		readShell: (() => Stream.empty) as PageAttachment["readShell"],
	},
	shell: {
		processId: ProcessId.make("shell"),
		readProcess: Stream.empty,
		dispatch: () => Effect.succeed({_tag: "Delivered" as const}),
	} satisfies AttachedProcess<unknown, ShellMsg>,
});

describe("reading what ended an attempt", () => {
	it("calls an open that never landed its own thing, because the browser will not say why", () => {
		assert.strictEqual(dropKind(neverOpened), "never-opened");
	});

	it("calls a policy close a protocol disagreement, and every other close a plain drop", () => {
		assert.strictEqual(dropKind(closeWith(1008)), "protocol");
		assert.strictEqual(dropKind(closeWith(1006)), "dropped");
		assert.strictEqual(dropKind(closeWith(1000)), "dropped");
	});

	it("calls anything that is not a socket error a plain drop", () => {
		assert.strictEqual(dropKind(new Error("the kernel runs no shell process")), "dropped");
	});
});

describe("choosing the next attempt", () => {
	const recovery: Recovery = {firstDelayMillis: 100, maxDelayMillis: 400, attempts: 5};

	it("doubles the delay and stops doubling at the ceiling", () => {
		const delays = [1, 2, 3, 4].map((failures) => {
			const next = nextAttempt(recovery, "dropped", failures, "gone");
			return next._tag === "Wait" ? next.delayMillis : next._tag;
		});
		assert.deepStrictEqual(delays, [100, 200, 400, 400]);
	});

	it("refuses a protocol disagreement at once, however much budget is left", () => {
		const next = nextAttempt(recovery, "protocol", 1, "1008: undecodable frame");
		assert.strictEqual(next._tag, "Refuse");
		assert.include(next._tag === "Refuse" ? next.reason : "", "disagree about the wire");
	});

	it("refuses once the budget is spent, and names the token as one of the two readings", () => {
		const next = nextAttempt(recovery, "never-opened", 5, "An error occurred during Open");
		assert.strictEqual(next._tag, "Refuse");
		assert.include(next._tag === "Refuse" ? next.reason : "", "launch token");
	});

	it("never retries under `noRecovery` — the control the browser proof's negative arm runs", () => {
		assert.strictEqual(nextAttempt(noRecovery, "dropped", 1, "gone")._tag, "Refuse");
	});

	it("gives the shipped page a bounded run rather than an endless one", () => {
		assert.strictEqual(nextAttempt(defaultRecovery, "dropped", 1, "gone")._tag, "Wait");
		assert.strictEqual(
			nextAttempt(defaultRecovery, "dropped", defaultRecovery.attempts, "gone")._tag,
			"Refuse",
		);
	});
});

describe("driving the lifecycle", () => {
	/** Every attempt is scoped, so a link that ended has released its socket before the next opens. */
	const scripted = (workingLinks: number) => {
		const state = {opened: 0, live: 0, peak: 0, links: 0, refusals: [] as Array<string>};
		const open = Effect.suspend(() => {
			state.opened += 1;
			if (state.opened > workingLinks) return Effect.fail(neverOpened);
			return Effect.acquireRelease(
				Effect.sync(() => {
					state.live += 1;
					state.peak = Math.max(state.peak, state.live);
				}),
				() =>
					Effect.sync(() => {
						state.live -= 1;
					}),
			).pipe(Effect.as(link(Effect.succeed(closeWith(1006)))));
		});
		return {state, open};
	};

	const instant: Recovery = {firstDelayMillis: 0, maxDelayMillis: 0, attempts: 3};

	it.effect("replaces the link on every drop and never holds two sockets at once", () =>
		Effect.gen(function* () {
			const {state, open} = scripted(3);
			yield* drive({
				recovery: instant,
				open,
				onLink: () => {
					state.links += 1;
				},
				onRefusal: (reason) => {
					state.refusals.push(reason);
				},
			});

			assert.strictEqual(state.links, 3, "one link handed out per working attempt");
			assert.strictEqual(state.peak, 1, "a link is released before the next one opens");
			assert.strictEqual(state.live, 0, "the last link's scope closed with the loop");
		}),
	);

	it.effect("starts the failure run over after a link that worked", () =>
		Effect.gen(function* () {
			const {state, open} = scripted(3);
			yield* drive({
				recovery: instant,
				open,
				onLink: () => {
					state.links += 1;
				},
				onRefusal: (reason) => {
					state.refusals.push(reason);
				},
			});

			// The third drop counts as the run's first failure, so the budget of three is spent two
			// opens later — not three. A drop is a failure the page has already survived, not a fresh
			// start, which is what keeps a socket that flaps from retrying for ever.
			assert.strictEqual(state.opened, 5);
		}),
	);

	it.effect("stops at the budget, says so once, and opens nothing after", () =>
		Effect.gen(function* () {
			const {state, open} = scripted(0);
			yield* drive({
				recovery: instant,
				open,
				onLink: () => {
					state.links += 1;
				},
				onRefusal: (reason) => {
					state.refusals.push(reason);
				},
			});

			assert.strictEqual(state.links, 0);
			assert.strictEqual(state.opened, 3);
			assert.strictEqual(state.refusals.length, 1);
			assert.include(state.refusals[0] ?? "", "3 attempt(s)");
		}),
	);

	it.effect("refuses a protocol disagreement without spending the budget", () =>
		Effect.gen(function* () {
			const state = {opened: 0, refusals: [] as Array<string>};
			yield* drive({
				recovery: instant,
				open: Effect.suspend(() => {
					state.opened += 1;
					return Effect.succeed(link(Effect.succeed(closeWith(1008))));
				}),
				onLink: () => {},
				onRefusal: (reason) => {
					state.refusals.push(reason);
				},
			});

			assert.strictEqual(state.opened, 1);
			assert.strictEqual(state.refusals.length, 1);
		}),
	);
});
