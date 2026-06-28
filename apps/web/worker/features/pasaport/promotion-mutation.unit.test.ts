/**
 * `user.promote` / `user.vouch` WIRE-boundary coverage (#1206) — the promotion
 * authority + tandem decisions that are wrong-or-right with no database (ADR 0082),
 * driven through the real external interface (`resolveWire`: decode + the
 * `encodeWireError` class→wire-code seam), so a denial's wire `code` is what a client
 * gets and a mis-annotated `[FateWireCode]` is a unit failure.
 *
 * Covers the acceptance matrix: direct mod promotion (server-enforced), vouch above
 * the reduced bar (promoted) vs below (recorded, NOT promoted) — the tandem, and that
 * an unprivileged actor cannot self-promote (a non-mod → invisible `UNAUTHORIZED`; a
 * çaylak vouching → public `FORBIDDEN`). Plus the #1204 dark-ship: flag OFF ⇒ the path
 * is inert (no authority check, no write). The atomic backlog sweep itself is
 * `promotion-sweep.unit.test.ts`; real-D1 fidelity is the integration tier.
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
import {Kunye} from "../kunye/Kunye.ts";
import type {Tier} from "../kunye/standing.ts";
import {makeVouchLedgerStub} from "../kunye/VouchLedger.testing.ts";
import {mutations} from "./mutations.ts";
import {makePasaportStub} from "./Pasaport.testing.ts";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "promotion-test",
	id: "promotion-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(
		Flags,
		// biome-ignore lint/plugin: a Flags test double — only getBoolean is exercised on this path; structurally building the full provider-agnostic interface (the typed variations) adds nothing.
		{
			getBoolean: () => Effect.succeed(on),
			getString: () => Effect.die(new Error("unused")),
			getNumber: () => Effect.die(new Error("unused")),
			getObject: () => Effect.die(new Error("unused")),
		} as unknown as typeof Flags.Service,
	);

const agentAuthorityStub = Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(false)});

// A `RelationStore` where exactly `holders` hold the `moderates` relation on platform.
const relationStoreOf = (holders: ReadonlyArray<string>): Layer.Layer<RelationStore> =>
	Layer.succeed(RelationStore, {
		has: (tuple) =>
			Effect.succeed(tuple.relation === "moderates" && holders.includes(tuple.subject)),
	});

// A `Kunye` whose standing/karma answer by id.
const kunyeOf = (
	tierById: Record<string, Tier>,
	karmaById: Record<string, number>,
): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {
		tierOf: (id: string) => Effect.succeed(tierById[id] ?? "visitor"),
		karmaOf: (id: string) => Effect.succeed(karmaById[id] ?? 0),
		rootOf: (id: string) => Effect.succeed(id),
	});

const requestContext = (actor: Actor, on: boolean) =>
	Layer.mergeAll(flagsStub(on)).pipe(
		Layer.provideMerge(Layer.succeed(CurrentUser, {user: undefined})),
		Layer.provideMerge(Layer.succeed(CurrentActor, {actor})),
		Layer.provideMerge(Layer.succeed(RuntimeContext, runtimeContextStub)),
	);

const promote = (userId: string) =>
	resolveWire(mutations["user.promote"], {
		input: {userId},
		select: ["userId", "promoted", "vouchRecorded"],
	});

const vouch = (candidateId: string) =>
	resolveWire(mutations["user.vouch"], {
		input: {candidateId},
		select: ["userId", "promoted", "vouchRecorded"],
	});

const withdrawVouch = (candidateId: string) =>
	resolveWire(mutations["user.withdrawVouch"], {
		input: {candidateId},
		select: ["userId", "promoted", "vouchRecorded"],
	});

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

describe("user.promote — direct moderator promotion", () => {
	it.effect("a moderator promotes a çaylak; the tier flip is server-enforced", () =>
		Effect.gen(function* () {
			const receipt = yield* promote("u-target");
			assert.strictEqual((receipt as {promoted: boolean}).promoted, true);
			assert.strictEqual((receipt as {vouchRecorded: boolean}).vouchRecorded, false);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub({promoteToYazar: () => Effect.succeed({promoted: true})}),
					relationStoreOf(["u-mod"]),
					agentAuthorityStub,
					requestContext(human("u-mod"), true),
				),
			),
		),
	);

	it.effect("a non-moderator gets the invisible UNAUTHORIZED — and never reaches the write", () =>
		Effect.gen(function* () {
			const exit = yield* promote("u-target").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			// Pasaport fail-on-contact: a reached promote would die, proving no self-promote write.
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub(),
					relationStoreOf(["someone-else"]),
					agentAuthorityStub,
					requestContext(human("u-rando"), true),
				),
			),
		),
	);

	it.effect("with the #1204 flag OFF the path is inert — no authority check, no write", () =>
		Effect.gen(function* () {
			const receipt = yield* promote("u-target");
			assert.strictEqual((receipt as {promoted: boolean}).promoted, false);
		}).pipe(
			// Both the write seam and the authority seam fail-on-contact: neither is reached.
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub(),
					Layer.succeed(RelationStore, {
						has: () => Effect.die(new Error("flag OFF must not check authority")),
					}),
					agentAuthorityStub,
					requestContext(human("u-rando"), false),
				),
			),
		),
	);
});

describe("user.vouch — author-vouch tandem", () => {
	const yazarVoucher = {tier: {"u-yazar": "yazar"} as Record<string, Tier>};

	// The KARMA-FIRST tandem order: karma is already over the bar, so placing the vouch
	// promotes on the vouch act itself (through the shared `resolveTandem`).
	it.effect(
		"karma-first: vouch with karma already over the bar promotes; the vouch is recorded (actor preserved)",
		() =>
			Effect.gen(function* () {
				const receipt = yield* vouch("u-caylak");
				assert.strictEqual((receipt as {promoted: boolean}).promoted, true);
				assert.strictEqual((receipt as {vouchRecorded: boolean}).vouchRecorded, true);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makePasaportStub({promoteToYazar: () => Effect.succeed({promoted: true})}),
						makeVouchLedgerStub({
							castVouch: () => Effect.succeed({outcome: "recorded" as const}),
							hasActiveFor: () => Effect.succeed(true),
						}),
						kunyeOf(yazarVoucher.tier, {"u-caylak": 25}), // above VOUCH_PROMOTION_KARMA_BAR
						agentAuthorityStub,
						requestContext(human("u-yazar"), true),
					),
				),
			),
	);

	it.effect("below the reduced bar the vouch is recorded but NO tier flips (the tandem)", () =>
		Effect.gen(function* () {
			const receipt = yield* vouch("u-caylak");
			assert.strictEqual((receipt as {promoted: boolean}).promoted, false);
			assert.strictEqual((receipt as {vouchRecorded: boolean}).vouchRecorded, true);
		}).pipe(
			// Pasaport fail-on-contact: a reached promote below the bar would die.
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub(),
					makeVouchLedgerStub({
						castVouch: () => Effect.succeed({outcome: "recorded" as const}),
						hasActiveFor: () => Effect.succeed(true),
					}),
					kunyeOf(yazarVoucher.tier, {"u-caylak": 1}), // below the bar
					agentAuthorityStub,
					requestContext(human("u-yazar"), true),
				),
			),
		),
	);

	// The concurrent-vouch cap (D5): the cap is owned by `VouchLedger.castVouch` (#1362),
	// so a yazar at the cap gets a `capReached` outcome the resolver maps to the public
	// VOUCH_LIMIT_REACHED. The default `has`/`activeCountFor` are fail-on-contact, proving
	// the resolver no longer re-derives the cap from the active count.
	it.effect("a yazar at the concurrent-vouch cap is denied a 4th — VOUCH_LIMIT_REACHED", () =>
		Effect.gen(function* () {
			const exit = yield* vouch("u-fourth").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "VOUCH_LIMIT_REACHED");
		}).pipe(
			// hasActiveFor + Pasaport fail-on-contact: a denied vouch never reaches the tandem.
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub(),
					makeVouchLedgerStub({
						castVouch: () => Effect.succeed({outcome: "capReached" as const}),
					}),
					kunyeOf(yazarVoucher.tier, {}),
					agentAuthorityStub,
					requestContext(human("u-yazar"), true),
				),
			),
		),
	);

	// Re-vouching an already-vouched candidate is the idempotent `alreadyVouched` outcome —
	// a success that consumes no fresh slot, so `vouchRecorded` is false and no tier flips
	// below the bar.
	it.effect("re-vouching an already-vouched candidate is allowed (idempotent, no fresh slot)", () =>
		Effect.gen(function* () {
			const receipt = yield* vouch("u-existing");
			assert.strictEqual((receipt as {vouchRecorded: boolean}).vouchRecorded, false);
			assert.strictEqual((receipt as {promoted: boolean}).promoted, false);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub(),
					makeVouchLedgerStub({
						castVouch: () => Effect.succeed({outcome: "alreadyVouched" as const}),
						hasActiveFor: () => Effect.succeed(true),
					}),
					kunyeOf(yazarVoucher.tier, {"u-existing": 1}), // below the bar ⇒ no promote
					agentAuthorityStub,
					requestContext(human("u-yazar"), true),
				),
			),
		),
	);

	it.effect(
		"a çaylak cannot vouch — public FORBIDDEN, no record, no write (no self-promotion)",
		() =>
			Effect.gen(function* () {
				const exit = yield* vouch("u-anyone").pipe(Effect.exit);
				assert.isTrue(Exit.isFailure(exit));
				if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "FORBIDDEN");
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makePasaportStub(),
						makeVouchLedgerStub(),
						kunyeOf({"u-caylak-actor": "çaylak"}, {}),
						agentAuthorityStub,
						requestContext(human("u-caylak-actor"), true),
					),
				),
			),
	);

	it.effect("an anonymous actor cannot vouch — FORBIDDEN", () =>
		Effect.gen(function* () {
			const exit = yield* vouch("u-anyone").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "FORBIDDEN");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub(),
					makeVouchLedgerStub(),
					kunyeOf({}, {}),
					agentAuthorityStub,
					requestContext(unauthenticated, true),
				),
			),
		),
	);
});

describe("user.withdrawVouch — releasing the slot", () => {
	const yazarVoucher = {tier: {"u-yazar": "yazar"} as Record<string, Tier>};

	it.effect("a yazar withdraws their vouch (deletes the row); the ack never promotes", () =>
		Effect.gen(function* () {
			const receipt = yield* withdrawVouch("u-caylak");
			assert.strictEqual((receipt as {promoted: boolean}).promoted, false);
			assert.strictEqual((receipt as {vouchRecorded: boolean}).vouchRecorded, false);
		}).pipe(
			// Pasaport fail-on-contact: withdraw must never touch the promotion path.
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub(),
					makeVouchLedgerStub({withdraw: () => Effect.succeed({withdrawn: true})}),
					kunyeOf(yazarVoucher.tier, {}),
					agentAuthorityStub,
					requestContext(human("u-yazar"), true),
				),
			),
		),
	);

	it.effect("a çaylak cannot withdraw a vouch — public FORBIDDEN, no write", () =>
		Effect.gen(function* () {
			const exit = yield* withdrawVouch("u-anyone").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "FORBIDDEN");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub(),
					makeVouchLedgerStub(),
					kunyeOf({"u-caylak-actor": "çaylak"}, {}),
					agentAuthorityStub,
					requestContext(human("u-caylak-actor"), true),
				),
			),
		),
	);

	it.effect("with the #1204 flag OFF withdraw is inert — no authority check, no write", () =>
		Effect.gen(function* () {
			const receipt = yield* withdrawVouch("u-caylak");
			assert.strictEqual((receipt as {promoted: boolean}).promoted, false);
		}).pipe(
			// Both seams fail-on-contact: neither the ledger nor the standing read is reached.
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub(),
					makeVouchLedgerStub(),
					kunyeOf({}, {}),
					agentAuthorityStub,
					requestContext(human("u-rando"), false),
				),
			),
		),
	);
});
