import {describe, expect, it} from "@effect/vitest";
import {Effect, Fiber, Layer} from "effect";
import {TestClock} from "effect/testing";
import {fakeHttp, fakeShell, type HttpReply, once} from "../fakes.test-support.ts";
import {pull} from "./fixtures.test-support.ts";
import {MERGEABILITY_WINDOW_SECONDS, pollWaits, readDefiniteMergeability} from "./mergeability.ts";

describe("pollWaits", () => {
	it("backs off from 2s, doubling to a cap of 8s", () => {
		expect(pollWaits(60)).toEqual([2, 4, 8, 8, 8, 8, 8, 8, 6]);
	});

	it("spends exactly the window, so the refusal names a number it really waited", () => {
		for (const window of [0, 1, 2, 3, 6, 30, 60, 137]) {
			const waits = pollWaits(window);
			expect(waits.reduce((sum, wait) => sum + wait, 0)).toBe(window);
		}
	});

	it("waits not at all on a window of zero — one read, no re-read", () => {
		expect(pollWaits(0)).toEqual([]);
	});

	// The shipped window used to be 3 polls 2s apart. A conflicted PR whose background job had not
	// landed inside those 6s refused as UNKNOWN, and the read that would have said `dirty` was one
	// the loop never made. The default is a promise about how long the job gets, so it is pinned.
	// @ruling https://github.com/kamp-us/phoenix/issues/9032
	it("gives the lazy job a minute by default", () => {
		expect(MERGEABILITY_WINDOW_SECONDS).toBe(60);
		expect(pollWaits(MERGEABILITY_WINDOW_SECONDS)).toHaveLength(9);
	});
});

/**
 * The loop both landing verbs share, driven on the test clock: `ship enqueue` and `ship merge` only
 * map its three outcomes to their own refusals, so the re-read itself is proven here once.
 */
describe("readDefiniteMergeability", () => {
	const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;
	const reply = (shape: Parameters<typeof pull>[0]): HttpReply => ({
		status: 200,
		body: pull(shape).stdout,
	});
	const INDEFINITE = reply({mergeable: null, mergeableState: "unknown"});
	const DIRTY = reply({mergeable: false, mergeableState: "dirty"});

	/** Runs the read over a scripted endpoint, advancing the clock past the whole window. */
	const settle = (script: ReadonlyArray<readonly [RegExp, HttpReply]>, windowSeconds: number) => {
		const http = fakeHttp(script);
		return Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(readDefiniteMergeability("o/r", 4321, windowSeconds));
			yield* TestClock.adjust(`${windowSeconds} seconds`);
			return {read: yield* Fiber.join(fiber), calls: http.calls};
		}).pipe(Effect.provide(Layer.merge(fakeShell([], undefined, [/^gh /]).layer, http.layer)));
	};

	// @ruling https://github.com/kamp-us/phoenix/issues/9032
	it.effect("re-reads past an indefinite value and lands the value a later read carries", () =>
		Effect.gen(function* () {
			const {read, calls} = yield* settle(
				[
					[once(PULL), INDEFINITE],
					[PULL, DIRTY],
				],
				4,
			);
			expect(read).toEqual({_tag: "Definite", value: {mergeable: false, state: "dirty"}});
			expect(calls).toHaveLength(2);
		}),
	);

	it.effect("answers Indefinite, naming the polls and seconds it spent, when nothing settles", () =>
		Effect.gen(function* () {
			const {read, calls} = yield* settle([[PULL, INDEFINITE]], 4);
			expect(read).toEqual({_tag: "Indefinite", polls: 2, seconds: 4});
			expect(calls).toHaveLength(3);
		}),
	);
});
