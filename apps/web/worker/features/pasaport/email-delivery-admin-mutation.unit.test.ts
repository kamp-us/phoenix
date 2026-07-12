/**
 * `emailDelivery.mark` / `emailDelivery.clear` / `emailDelivery.failing` WIRE-boundary
 * coverage (Child #2692, email-bounce epic #2687) — the authority + dark-ship decisions
 * that are wrong-or-right with no database (ADR 0082), driven through the real external
 * interface (`resolveWire`: decode + the `encodeWireError` class→wire-code seam), so a
 * denial's wire `code` is what a client gets.
 *
 * The load-bearing AC (#2692): mark and clear each FAIL CLOSED for a non-admin caller — a
 * non-holder of the `admin` relation and the anonymous actor both get the invisible
 * `UNAUTHORIZED` (ADR 0098 §2), and neither reaches the append (the `Pasaport` stub is
 * fail-on-contact). Plus the dark-ship: with the `phoenix-email-delivery-admin` flag OFF
 * the path is inert (fails `Denied` before any authority check or write). The mark's
 * reason floor (`EmailFailingReasonRequired`) rejects a blank note even for an admin. The
 * `emailDelivery.failing` admin roll-up read is gated the same way. The real-D1
 * append→projection round-trip is left to integration.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type Actor,
	AgentAuthority,
	CurrentActor,
	human,
	RelationStore,
	unauthenticated,
} from "@kampus/authz";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {makePasaportStub} from "./Pasaport.testing.ts";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "email-delivery-test",
	id: "email-delivery-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(
		Flags,
		// biome-ignore lint/plugin: a Flags test double — only getBoolean is exercised on this path.
		{
			getBoolean: () => Effect.succeed(on),
			getString: () => Effect.die(new Error("unused")),
			getNumber: () => Effect.die(new Error("unused")),
			getObject: () => Effect.die(new Error("unused")),
		} as unknown as typeof Flags.Service,
	);

const agentAuthorityStub = Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(false)});

// A `RelationStore` where exactly `holders` hold the `admin` relation on platform.
const adminStoreOf = (holders: ReadonlyArray<string>): Layer.Layer<RelationStore> =>
	Layer.succeed(RelationStore, {
		has: (tuple) => Effect.succeed(tuple.relation === "admin" && holders.includes(tuple.subject)),
		hasSubjects: ({subjects, relation}) =>
			Effect.succeed(
				new Set(relation === "admin" ? subjects.filter((s) => holders.includes(s)) : []),
			),
		subjectsOf: ({relation}) => Effect.succeed(new Set(relation === "admin" ? holders : [])),
	});

const requestContext = (actor: Actor, on: boolean) =>
	flagsStub(on).pipe(
		Layer.provideMerge(Layer.succeed(CurrentUser, {user: undefined})),
		Layer.provideMerge(Layer.succeed(CurrentActor, {actor})),
		Layer.provideMerge(Layer.succeed(RuntimeContext, runtimeContextStub)),
	);

const mark = (userId: string, reason: string) =>
	resolveWire(mutations["emailDelivery.mark"], {
		input: {userId, reason},
		select: ["id", "failing", "reason"],
	});

const clear = (userId: string) =>
	resolveWire(mutations["emailDelivery.clear"], {
		input: {userId},
		select: ["id", "failing", "reason"],
	});

const failing = () =>
	resolveWire(lists["emailDelivery.failing"], {
		args: {},
		select: ["id", "address", "userId", "reason", "since"],
	});

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

// A `Pasaport` that fails on ANY contact — proving a denied path never reached the write.
const noWriteReached = Layer.mergeAll(makePasaportStub(), agentAuthorityStub);

describe("emailDelivery.mark — admin authority (fail closed)", () => {
	it.effect("an admin marks a target; the append runs, stamps the actor, reports failing", () => {
		// Capture the actor threaded to the write (#2734): the mark must stamp the discharged
		// admin's id (`u-admin`), never a client-supplied identity.
		const seen: {actorId?: string} = {};
		return Effect.gen(function* () {
			const receipt = yield* mark("u-target", "user reports no magic-links");
			assert.strictEqual((receipt as {failing: boolean}).failing, true);
			assert.strictEqual(
				(receipt as {reason: string | null}).reason,
				"user reports no magic-links",
			);
			assert.strictEqual(seen.actorId, "u-admin");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub({
						markEmailFailing: ({actorId}) => {
							seen.actorId = actorId;
							return Effect.succeed({
								address: "t@x.co",
								state: {failing: true, reason: "user reports no magic-links"},
							});
						},
					}),
					adminStoreOf(["u-admin"]),
					agentAuthorityStub,
					requestContext(human("u-admin"), true),
				),
			),
		);
	});

	it.effect("a non-admin gets the invisible UNAUTHORIZED — and never reaches the write", () =>
		Effect.gen(function* () {
			const exit = yield* mark("u-target", "spam").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					adminStoreOf(["someone-else"]),
					requestContext(human("u-rando"), true),
				),
			),
		),
	);

	it.effect("the anonymous actor gets the SAME invisible UNAUTHORIZED", () =>
		Effect.gen(function* () {
			const exit = yield* mark("u-target", "spam").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					adminStoreOf(["u-admin"]),
					requestContext(unauthenticated, true),
				),
			),
		),
	);

	it.effect("a blank reason fails EMAIL_FAILING_REASON_REQUIRED even for an admin", () =>
		Effect.gen(function* () {
			const exit = yield* mark("u-target", "   ").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit))
				assert.strictEqual(wireCodeOf(exit.cause), "EMAIL_FAILING_REASON_REQUIRED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					adminStoreOf(["u-admin"]),
					requestContext(human("u-admin"), true),
				),
			),
		),
	);

	it.effect("with the #2692 flag OFF the path is inert — no authority check, no write", () =>
		Effect.gen(function* () {
			const exit = yield* mark("u-target", "spam").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					// Authority must NOT be consulted when the flag is off.
					Layer.succeed(RelationStore, {
						has: () => Effect.die(new Error("flag OFF must not check authority")),
						hasSubjects: () => Effect.die(new Error("flag OFF must not check authority")),
						subjectsOf: () => Effect.die(new Error("flag OFF must not check authority")),
					}),
					requestContext(human("u-admin"), false),
				),
			),
		),
	);
});

describe("emailDelivery.clear — admin authority (fail closed)", () => {
	it.effect(
		"an admin clears a target; the actor is stamped and the address reads deliverable",
		() => {
			const seen: {actorId?: string} = {};
			return Effect.gen(function* () {
				const receipt = yield* clear("u-target");
				assert.strictEqual((receipt as {failing: boolean}).failing, false);
				assert.strictEqual(seen.actorId, "u-admin");
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makePasaportStub({
							clearEmailFailing: ({actorId}) => {
								seen.actorId = actorId;
								return Effect.succeed({address: "t@x.co", state: {failing: false, reason: null}});
							},
						}),
						adminStoreOf(["u-admin"]),
						agentAuthorityStub,
						requestContext(human("u-admin"), true),
					),
				),
			);
		},
	);

	it.effect("a non-admin gets the invisible UNAUTHORIZED — and never reaches the write", () =>
		Effect.gen(function* () {
			const exit = yield* clear("u-target").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					adminStoreOf(["someone-else"]),
					requestContext(human("u-rando"), true),
				),
			),
		),
	);
});

describe("emailDelivery.failing — admin roll-up read (fail closed)", () => {
	it.effect("an admin reads the roll-up; the failing addresses are returned", () =>
		Effect.gen(function* () {
			const conn = yield* failing();
			const items = (conn as {items: ReadonlyArray<{node: {address: string}}>}).items;
			assert.deepStrictEqual(
				items.map((e) => e.node.address),
				["a@x.co"],
			);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub({
						listFailingAddresses: () =>
							Effect.succeed([
								{
									address: "a@x.co",
									userId: "u-a",
									reason: "bounce",
									since: new Date("2026-01-01T00:00:00Z"),
								},
							]),
					}),
					adminStoreOf(["u-admin"]),
					agentAuthorityStub,
					requestContext(human("u-admin"), true),
				),
			),
		),
	);

	it.effect("a non-admin gets the invisible UNAUTHORIZED — and never reaches the read", () =>
		Effect.gen(function* () {
			const exit = yield* failing().pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					adminStoreOf(["someone-else"]),
					requestContext(human("u-rando"), true),
				),
			),
		),
	);

	it.effect("with the #2692 flag OFF the roll-up is inert — no authority check, no read", () =>
		Effect.gen(function* () {
			const exit = yield* failing().pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					noWriteReached,
					Layer.succeed(RelationStore, {
						has: () => Effect.die(new Error("flag OFF must not check authority")),
						hasSubjects: () => Effect.die(new Error("flag OFF must not check authority")),
						subjectsOf: () => Effect.die(new Error("flag OFF must not check authority")),
					}),
					requestContext(human("u-admin"), false),
				),
			),
		),
	);
});
