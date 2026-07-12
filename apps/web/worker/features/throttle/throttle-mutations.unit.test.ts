/**
 * `throttleMutations` seam coverage (ADR 0177) — the wrapper is transparent to a
 * mutation's handler when the actor is under budget (its write AND its
 * `/fate/live` publish still fire), and short-circuits with `RATE_LIMIT_EXCEEDED`
 * BEFORE the handler when over budget (so a throttled write never publishes — the
 * fanout invariant is preserved because the handler simply doesn't run).
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentActor, human} from "@kampus/authz";
import {
	type AnyFateMutation,
	type FateMutationsRecord,
	failureOf,
	wireCodeOf,
} from "@kampus/fate-effect";
import {Effect, Exit, Layer} from "effect";
import * as Schema from "effect/Schema";
import {DEFAULT_MUTATION_POLICY, type RateLimiter, RateLimiterLive} from "./RateLimiter.ts";
import {InIsolateRateLimitStoreLive} from "./RateLimitStore.ts";
import {throttleMutations} from "./throttle-mutations.ts";

const TestRateLimiter = RateLimiterLive.pipe(Layer.provide(InIsolateRateLimitStoreLive));
const CAPACITY = DEFAULT_MUTATION_POLICY.capacity;

/**
 * A stand-in fanned mutation whose `resolve` records a "publish" — the
 * `/fate/live` invalidation a real fanned mutation fires after its write. The
 * `published` array is the observable proof of whether the handler ran.
 */
const makeFannedMutations = (published: Array<string>): FateMutationsRecord => ({
	"post.submit": {
		kind: "mutation",
		definition: {input: Schema.Unknown, type: "Post"},
		type: "Post",
		handler: (() => Effect.succeed(null)) as AnyFateMutation["handler"],
		resolve: (() =>
			Effect.sync(() => {
				published.push("post.invalidated");
				return {ok: true};
			})) as AnyFateMutation["resolve"],
	},
});

/** Drive the throttled `post.submit` resolve, re-pinning its erased `R` to the
 * services the wrapper truly needs (both provided by {@link runAsWriter}). */
const submit = (published: Array<string>) => {
	const entry = throttleMutations(makeFannedMutations(published))["post.submit"] as AnyFateMutation;
	return entry.resolve({input: {}, select: []}) as Effect.Effect<
		unknown,
		unknown,
		RateLimiter | CurrentActor
	>;
};

const runAsWriter = <A, E>(effect: Effect.Effect<A, E, RateLimiter | CurrentActor>) =>
	effect.pipe(
		Effect.provideService(CurrentActor, {actor: human("u-writer")}),
		Effect.provide(TestRateLimiter),
	);

describe("throttleMutations (ADR 0177)", () => {
	it.effect("under budget the wrapped handler runs — the fanned publish still fires", () =>
		runAsWriter(
			Effect.gen(function* () {
				const published: Array<string> = [];
				const result = yield* submit(published);
				assert.deepStrictEqual(published, ["post.invalidated"]);
				assert.deepStrictEqual(result, {ok: true});
			}),
		),
	);

	it.effect(
		"over budget the wrapped mutation fails RATE_LIMIT_EXCEEDED and the handler (write + publish) never runs",
		() =>
			runAsWriter(
				Effect.gen(function* () {
					const published: Array<string> = [];
					for (let i = 0; i < CAPACITY; i++) yield* submit(published);
					const publishedBefore = published.length;
					const exit = yield* submit(published).pipe(Effect.exit);
					assert.isTrue(Exit.isFailure(exit));
					if (Exit.isFailure(exit)) {
						assert.strictEqual(wireCodeOf(failureOf(exit.cause)), "RATE_LIMIT_EXCEEDED");
					}
					assert.strictEqual(published.length, publishedBefore); // handler skipped
				}),
			),
	);
});
