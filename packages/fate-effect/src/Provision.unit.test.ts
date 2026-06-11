/**
 * T0 — `provideRequestPair`: THE per-request provision pipeline (review fix,
 * tasks.md task 19).
 *
 * The contract under test:
 *
 *   1. **Provision order** — the per-request pair (`CurrentUser`,
 *      `LivePublisher`) is provided as VALUES off the request context, with
 *      the captured build-time services beneath; an effect requiring all
 *      three resolves with no ambient context (R = never, directly
 *      runnable).
 *   2. **Request values WIN** — a captured context that carries the pair
 *      (impossible from `FateServer.layer`, whose `FateServerRequirements`
 *      excludes both, but expressible here through Context contravariance)
 *      loses to the request values. This was vacuously true at every call
 *      site; the helper seam makes it a real, pinned property.
 *   3. **The R re-pin** — the helper accepts the erased shapes'
 *      `R = unknown` and returns `R = never`, preserving A and E. This is
 *      the package's ONE documented `erased→kernel` request-pipeline cast
 *      (`Provision.ts`); Executor/Interpreter/Walk no longer spell it.
 */
import {Context, Effect} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import {CurrentUser, type CurrentUserInfo} from "./CurrentUser.ts";
import {LivePublisher} from "./LivePublisher.ts";
import {provideRequestPair} from "./Provision.ts";
import type {FateRequestContext} from "./RequestContext.ts";

/** A build-time domain service, as `FateServer.layer` would capture it. */
class Greeting extends Context.Service<Greeting, {readonly word: string}>()("test/Greeting") {}

const userInfo = (id: string): CurrentUserInfo => ({id, email: `${id}@kamp.us`, name: id});

/** A distinct publisher value per call — identity is the assertion. */
const publisherStub = (): typeof LivePublisher.Service => {
	const noop = () => Effect.void;
	return {
		update: noop,
		delete: noop,
		connection: () => ({appendNode: noop, prependNode: noop, deleteEdge: noop, invalidate: noop}),
	};
};

const requestContext = (id: string): FateRequestContext => ({
	currentUser: {user: userInfo(id)},
	livePublisher: publisherStub(),
});

/** Reads all three services — the full provision surface in one program. */
const readAll = Effect.gen(function* () {
	const current = yield* CurrentUser;
	const live = yield* LivePublisher;
	const greeting = yield* Greeting;
	return {current, greeting, live};
});

describe("provideRequestPair", () => {
	it("provides the pair as request VALUES with the captured services beneath", () => {
		const ctx = requestContext("u1");
		const services = Context.make(Greeting, {word: "merhaba"});
		const result = Effect.runSync(provideRequestPair(ctx, services)(readAll));
		expect(result.current.user?.id).toBe("u1");
		expect(result.live).toBe(ctx.livePublisher);
		expect(result.greeting.word).toBe("merhaba");
	});

	it("request values WIN over a captured context carrying the pair", () => {
		const ctx = requestContext("request-user");
		// `FateServer.layer` can never capture the pair (`FateServerRequirements`
		// excludes them), so this poisoned context is constructible only here —
		// Context is contravariant in Services, so Context<CurrentUser | …>
		// assigns into the helper's Context<never> parameter without a cast.
		const services = Context.make(CurrentUser, {user: userInfo("decoy")}).pipe(
			Context.add(LivePublisher, publisherStub()),
			Context.add(Greeting, {word: "still-there"}),
		);
		const result = Effect.runSync(provideRequestPair(ctx, services)(readAll));
		expect(result.current.user?.id).toBe("request-user");
		expect(result.live).toBe(ctx.livePublisher);
		// the domain half of the poisoned context still resolves beneath
		expect(result.greeting.word).toBe("still-there");
	});

	it("re-pins R: unknown → never, preserving A and E (the one documented cast seam)", () => {
		const provide = provideRequestPair(requestContext("u1"), Context.empty());
		// accepts the erased shapes' covariant-top R…
		expectTypeOf(provide<number, "boom">)
			.parameter(0)
			.toEqualTypeOf<Effect.Effect<number, "boom", unknown>>();
		// …and returns the runnable re-pin, A and E untouched
		expectTypeOf(provide<number, "boom">).returns.toEqualTypeOf<Effect.Effect<number, "boom">>();
	});
});
