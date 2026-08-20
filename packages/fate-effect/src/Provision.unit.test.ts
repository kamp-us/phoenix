/**
 * Unit — `provideRequestPair`, the per-request provision pipeline, including the generic
 * per-request service seam of ADR 0107 §7. The seam is opaque: the package names no app
 * service, so `Actor` below is a stand-in an app would provide through `requestServices`.
 */
import {Cause, Context, Effect, Exit} from "effect";
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
		invalidate: noop,
		topic: () => ({appendNode: noop, prependNode: noop, deleteEdge: noop, invalidate: noop}),
	};
};

const requestContext = (id: string): FateRequestContext => ({
	currentUser: {user: userInfo(id)},
	livePublisher: publisherStub(),
});

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
		expect(result.greeting.word).toBe("still-there");
	});

	it("re-pins R: unknown → never, preserving A and E (the one documented cast seam)", () => {
		const provide = provideRequestPair(requestContext("u1"), Context.empty());
		expectTypeOf(provide<number, "boom">)
			.parameter(0)
			.toEqualTypeOf<Effect.Effect<number, "boom", unknown>>();
		expectTypeOf(provide<number, "boom">).returns.toEqualTypeOf<Effect.Effect<number, "boom">>();
	});
});

class Actor extends Context.Service<Actor, {readonly id: string; readonly level: string}>()(
	"test/Actor",
) {}

const requestContextWithActor = (id: string, actor: typeof Actor.Service): FateRequestContext => ({
	currentUser: {user: userInfo(id)},
	livePublisher: publisherStub(),
	requestServices: Context.make(Actor, actor),
});

const readWithActor = Effect.gen(function* () {
	const current = yield* CurrentUser;
	const actor = yield* Actor;
	return {actor, current};
});

describe("provideRequestPair — generic per-request provision seam (ADR 0107 §7)", () => {
	it("provides an app-registered per-request service through the seam, visible to a handler", () => {
		const ctx = requestContextWithActor("u1", {id: "u1", level: "yazar"});
		const result = Effect.runSync(provideRequestPair(ctx, Context.empty())(readWithActor));
		expect(result.actor).toEqual({id: "u1", level: "yazar"});
		expect(result.current.user?.id).toBe("u1");
	});

	it("the per-request seam value WINS over the same tag in the build-time services", () => {
		const ctx = requestContextWithActor("u1", {id: "u1", level: "yazar"});
		const services = Context.make(Actor, {id: "build", level: "visitor"});
		const result = Effect.runSync(provideRequestPair(ctx, services)(readWithActor));
		expect(result.actor).toEqual({id: "u1", level: "yazar"});
	});

	it("a registered-but-unprovided per-request service fails loudly at run, never silently", () => {
		const ctx = requestContext("u1");
		const exit = Effect.runSyncExit(provideRequestPair(ctx, Context.empty())(readWithActor));
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(Cause.pretty(exit.cause)).toContain("Service not found");
			expect(Cause.pretty(exit.cause)).toContain("test/Actor");
		}
	});

	it("the seam stays opaque: a context with no requestServices is unchanged (the pair still resolves)", () => {
		const ctx = requestContext("u1");
		expect(ctx.requestServices).toBeUndefined();
		const services = Context.make(Greeting, {word: "merhaba"});
		const result = Effect.runSync(provideRequestPair(ctx, services)(readAll));
		expect(result.current.user?.id).toBe("u1");
		expect(result.greeting.word).toBe("merhaba");
	});
});
