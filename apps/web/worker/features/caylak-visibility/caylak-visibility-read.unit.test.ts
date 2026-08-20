/**
 * `caylakVisibility.mine` WIRE-boundary coverage (#6422, epic #4306) — the viewer's
 * own preference read, driven through `resolveWire`.
 *
 * The load-bearing ACs: with the flag OFF the read resolves "not opted in" and issues
 * NO D1 query (the fail-on-contact store proves it); a signed-out viewer does the same;
 * with the flag ON the read reports the signed-in viewer's own row, keyed off
 * `CurrentUser` — the operation takes no argument, so no wire shape exists by which one
 * account reads another's preference.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {CaylakVisibility, type CaylakVisibilityState} from "./CaylakVisibility.ts";
import {queries} from "./queries.ts";
import type {CaylakVisibilityPreference} from "./views.ts";

const VIEWER = {id: "yzr", email: "kaan@example.com", name: "kaan"};
const OPTED_IN_AT = new Date("2026-08-19T00:00:00.000Z");

const runtimeContextStub: BaseRuntimeContext = {
	Type: "caylak-visibility-read-test",
	id: "caylak-visibility-read-test",
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

/** Fail-on-contact by default: any read that reaches the store fails the test. */
const storeStub = (impl?: (userId: string | null | undefined) => CaylakVisibilityState) =>
	Layer.succeed(CaylakVisibility, {
		read: impl
			? (userId) => Effect.succeed(impl(userId))
			: () => Effect.die("the store was read on a path that must short-circuit"),
		set: () => Effect.die("CaylakVisibility.set not exercised"),
	});

const readMine = (user?: typeof VIEWER) =>
	resolveWire(queries["caylakVisibility.mine"], {
		args: undefined,
		select: ["id", "optedIn", "optedInAt"],
	}).pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

const NOT_OPTED_IN: CaylakVisibilityPreference = {
	__typename: "CaylakVisibilityPreference",
	id: "mine",
	optedIn: false,
	optedInAt: null,
};

describe("caylakVisibility.mine — the read is dark, viewer-scoped, and never errors", () => {
	it.effect("with the flag OFF it resolves not-opted-in without touching the store", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* readMine(VIEWER), NOT_OPTED_IN);
		}).pipe(Effect.provide(Layer.mergeAll(flagsStub(false), storeStub()))),
	);

	it.effect("a signed-out viewer resolves not-opted-in without touching the store", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* readMine(), NOT_OPTED_IN);
		}).pipe(Effect.provide(Layer.mergeAll(flagsStub(true), storeStub()))),
	);

	it.effect("with the flag ON it reports the signed-in viewer's own row", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* readMine(VIEWER), {
				__typename: "CaylakVisibilityPreference",
				id: "mine",
				optedIn: true,
				optedInAt: OPTED_IN_AT.toISOString(),
			});
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(true),
					storeStub((userId) => {
						assert.strictEqual(userId, VIEWER.id, "the account read is the viewer's own");
						return {optedIn: true, setAt: OPTED_IN_AT};
					}),
				),
			),
		),
	);
});
