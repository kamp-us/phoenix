/**
 * `caylakVisibility.optIn` / `.optOut` WIRE-boundary coverage (#6422, epic #4306) —
 * driven through the real external interface (`resolveWire`: decode +
 * `encodeWireError`), so a denial's wire `code` is what a client actually gets.
 *
 * The load-bearing ACs:
 *   - signed out ⇒ the invisible `UNAUTHORIZED` before any read;
 *   - flag off ⇒ `UNAUTHORIZED` (the dark-ship `Denied`) before any write;
 *   - a çaylak is REFUSED opt-in `FORBIDDEN` and NO row is written — the tier comes
 *     from the real `Kunye.tierOf` read through the real capability discharge, never
 *     from wire input (there is none);
 *   - a yazar opts in and the receipt reports the new state;
 *   - opt-OUT is not yazar-floored, so a demoted account can still withdraw.
 */
import {assert, describe, it} from "@effect/vitest";
import {type Actor, CurrentActor, human} from "@kampus/authz";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {AgentAuthorityV1} from "../kunye/AgentAuthorityV1.ts";
import {makeKunyeStub} from "../kunye/Kunye.testing.ts";
import type {Tier} from "../kunye/Kunye.ts";
import {
	CaylakVisibility,
	type CaylakVisibilitySetInput,
	type CaylakVisibilitySetResult,
} from "./CaylakVisibility.ts";
import {mutations} from "./mutations.ts";

const YAZAR = {id: "yzr", email: "kaan@example.com", name: "kaan"};
const CAYLAK = {id: "cyl", email: "deniz@example.com", name: "deniz"};

const standings: Record<string, Tier> = {yzr: "yazar", cyl: "çaylak"};
const kunye = makeKunyeStub({tierOf: (id) => Effect.succeed(standings[id] ?? "visitor")});

const runtimeContextStub: BaseRuntimeContext = {
	Type: "caylak-visibility-mutation-test",
	id: "caylak-visibility-mutation-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(on),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service);

/** A `CaylakVisibility` whose `set` runs `impl` — fail-on-contact by default, so a
 * refused path proves it never reached the write. */
const storeStub = (
	impl?: (input: CaylakVisibilitySetInput) => Effect.Effect<CaylakVisibilitySetResult>,
) =>
	Layer.succeed(CaylakVisibility, {
		read: () => Effect.die("CaylakVisibility.read not exercised"),
		set: impl ?? (() => Effect.die("the write was reached on a path that must refuse")),
	});

const actorLayer = (actor: Actor) => Layer.succeed(CurrentActor, {actor});

const call = (key: "caylakVisibility.optIn" | "caylakVisibility.optOut", user?: typeof YAZAR) =>
	resolveWire(mutations[key], {input: {}, select: ["id", "optedIn", "optedInAt"]}).pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

const codeOfFailure = (exit: Exit.Exit<unknown, unknown>): unknown => {
	assert.isTrue(Exit.isFailure(exit), "expected a refusal, got a success");
	return Exit.isFailure(exit) ? wireCodeOf(exit.cause) : undefined;
};

describe("caylakVisibility.optIn — the gates, in order, all fail closed", () => {
	it.effect("an anonymous caller is rejected UNAUTHORIZED and never reaches the write", () =>
		Effect.gen(function* () {
			const exit = yield* call("caylakVisibility.optIn").pipe(Effect.exit);
			assert.strictEqual(codeOfFailure(exit), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(true),
					storeStub(),
					kunye,
					AgentAuthorityV1,
					actorLayer(human(YAZAR.id)),
				),
			),
		),
	);

	it.effect("with the flag OFF a yazar is refused UNAUTHORIZED — no write", () =>
		Effect.gen(function* () {
			const exit = yield* call("caylakVisibility.optIn", YAZAR).pipe(Effect.exit);
			assert.strictEqual(codeOfFailure(exit), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(false),
					storeStub(),
					kunye,
					AgentAuthorityV1,
					actorLayer(human(YAZAR.id)),
				),
			),
		),
	);

	it.effect("a çaylak is REFUSED FORBIDDEN and the row is not written", () =>
		Effect.gen(function* () {
			const exit = yield* call("caylakVisibility.optIn", CAYLAK).pipe(Effect.exit);
			assert.strictEqual(codeOfFailure(exit), "FORBIDDEN");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(true),
					storeStub(),
					kunye,
					AgentAuthorityV1,
					actorLayer(human(CAYLAK.id)),
				),
			),
		),
	);

	it.effect("a yazar opts in; the receipt carries the post-write state", () =>
		Effect.gen(function* () {
			const receipt = yield* call("caylakVisibility.optIn", YAZAR);
			assert.deepStrictEqual(receipt, {
				__typename: "CaylakVisibilityPreference",
				id: "mine",
				optedIn: true,
				optedInAt: "2026-08-19T00:00:00.000Z",
			});
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(true),
					storeStub((input) => {
						assert.strictEqual(input.userId, YAZAR.id, "the account written is the caller's own");
						assert.strictEqual(input.value, true);
						return Effect.succeed({
							optedIn: true,
							setAt: new Date("2026-08-19T00:00:00.000Z"),
							changed: true,
						});
					}),
					kunye,
					AgentAuthorityV1,
					actorLayer(human(YAZAR.id)),
				),
			),
		),
	);
});

describe("caylakVisibility.optOut — flag-gated, but not yazar-floored", () => {
	it.effect("with the flag OFF a yazar is refused UNAUTHORIZED — no write", () =>
		Effect.gen(function* () {
			const exit = yield* call("caylakVisibility.optOut", YAZAR).pipe(Effect.exit);
			assert.strictEqual(codeOfFailure(exit), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(false),
					storeStub(),
					kunye,
					AgentAuthorityV1,
					actorLayer(human(YAZAR.id)),
				),
			),
		),
	);

	it.effect("a çaylak may withdraw an opt-in it made while it was a yazar", () =>
		Effect.gen(function* () {
			const receipt = yield* call("caylakVisibility.optOut", CAYLAK);
			assert.deepStrictEqual(receipt, {
				__typename: "CaylakVisibilityPreference",
				id: "mine",
				optedIn: false,
				optedInAt: null,
			});
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(true),
					storeStub((input) => {
						assert.strictEqual(input.userId, CAYLAK.id);
						assert.strictEqual(input.value, false);
						return Effect.succeed({optedIn: false, changed: true});
					}),
					kunye,
					AgentAuthorityV1,
					actorLayer(human(CAYLAK.id)),
				),
			),
		),
	);
});
