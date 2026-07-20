/**
 * The fate data-plane `Flags` layer installs the #622 local-override wrapper — so a
 * flag-gated fate resolver/mutation honors an `overrides` entry in its per-request
 * `FlagsContext`. This is the #1868 regression guard (before it, `makeFateLayer` baked
 * the PLAIN `FlagsLive`, so the decorator was never on the fate path and the flag-flip
 * cookie had no effect on a mutation).
 *
 * As of #2741 the wrapper is installed UNCONDITIONALLY (not env-selected): whether an
 * override is HONORED is decided upstream, per request, by `overridesAuthorized` (dev,
 * or an admin) which populates `FlagsContext.overrides`.
 * That gate — including the prod fail-closed "a non-admin's cookie is inert" invariant —
 * is proven in `flagship/override-authz.unit.test.ts`. This test proves only the
 * mechanism it feeds: given an override in context, the fate layer honors it.
 *
 * No binding / no I/O — `FateFlagsLive` over a stub `Flagship` whose real eval always
 * returns the supplied default (dark-ship OFF for `phoenix-reactions`): the only way the
 * flag reads ON is the override decorator short-circuiting on `FlagsContext.overrides`,
 * so a passing ON assertion proves the wrapper is installed — not that real eval flipped.
 */
import {assert, describe, it} from "@effect/vitest";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import {PHOENIX_REACTIONS} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {FlagsContext} from "../flagship/FlagsContext.ts";
import {Flagship} from "../flagship/Flagship.ts";
import {FateFlagsLive} from "./layers.ts";

const runtimeContext: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};
const RuntimeContextStub = Layer.succeed(RuntimeContext)(runtimeContext);

const unexercised = (method: string) => () =>
	Effect.die(`Flagship.${method} not exercised in fate-flags-dev-override.unit.test`);

const darkFlagship: Layer.Layer<Flagship> = Layer.succeed(Flagship)(
	Flagship.of({
		raw: Effect.die("Flagship.raw not exercised"),
		get: unexercised("get"),
		getBooleanValue: (_key, defaultValue) => Effect.succeed(defaultValue),
		getStringValue: unexercised("getStringValue"),
		getNumberValue: unexercised("getNumberValue"),
		getObjectValue: unexercised("getObjectValue"),
		getBooleanDetails: unexercised("getBooleanDetails"),
		getStringDetails: unexercised("getStringDetails"),
		getNumberDetails: unexercised("getNumberDetails"),
		getObjectDetails: unexercised("getObjectDetails"),
	}),
);

const withEnvironment = (environment: string) =>
	Effect.provideService(
		ConfigProvider.ConfigProvider,
		ConfigProvider.fromUnknown({ENVIRONMENT: environment}),
	);

// Read `phoenix-reactions` (default OFF) through the fate `Flags` layer with a given
// `FlagsContext` — `overrides` populated or not — mirroring what `provideRequestFlags`
// hands a resolver once `overridesAuthorized` has decided.
const resolveWith = (context: {environment: string; overrides?: Record<string, boolean>}) =>
	Effect.gen(function* () {
		const flags = yield* Flags;
		return yield* flags
			.getBoolean(PHOENIX_REACTIONS, false)
			.pipe(Effect.provideService(FlagsContext, context));
	}).pipe(
		Effect.provide(
			Layer.mergeAll(FateFlagsLive.pipe(Layer.provide(darkFlagship)), RuntimeContextStub),
		),
		withEnvironment(context.environment),
	);

describe("fate Flags layer — the override wrapper is installed (#1868/#2741)", () => {
	it.effect("an override in context forces phoenix-reactions ON (real eval says OFF)", () =>
		Effect.gen(function* () {
			const value = yield* resolveWith({
				environment: "production",
				overrides: {[PHOENIX_REACTIONS]: true},
			});
			// The ON result can only come from the installed override wrapper.
			assert.strictEqual(value, true);
		}),
	);

	it.effect("no override in context delegates to real eval — stays OFF", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* resolveWith({environment: "production"}), false);
		}),
	);
});
