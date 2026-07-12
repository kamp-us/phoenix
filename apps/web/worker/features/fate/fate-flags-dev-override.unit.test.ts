/**
 * The fate data-plane `Flags` layer honors the dev-override cookie ONLY under
 * `development` — the fate-runtime twin of the raw-route selection in `http/app.ts`
 * (the #622 gate), proven here at the seam that broke #1868.
 *
 * The gap this covers: `makeFateLayer` baked the PLAIN `FlagsLive` unconditionally, so
 * the `withDevOverrides` decorator was never on the fate mutation/resolver path — a
 * flag-gated `definition.react` on the integration `development` stage ignored the
 * `phoenix_flag_overrides` cookie `provideRequestFlags` threads, and the live-reconcile
 * integration test's flag-flip had no effect. `FateFlagsLive` (`layers.ts`) selects the
 * dev-override wrapper under `development` and the plain layer everywhere else.
 *
 * Two properties, no binding / no I/O — `FateFlagsLive` over a stub `Flagship` whose
 * real eval always returns the dark-ship default OFF, with the environment supplied via
 * a `ConfigProvider` (mirroring the worker-scope `AppConfig` read):
 *
 *   - `development` — the override in `FlagsContext.overrides` forces the flag ON even
 *     though real eval says OFF: the decorator is installed, so the cookie takes effect.
 *   - `production` / `preview` — the SAME override in context is IGNORED and the flag
 *     stays at the real-eval default OFF: the plain layer is installed, so an
 *     attacker-supplied override cookie can never flip a flag on a deployed stage (the
 *     load-bearing prod fail-closed gate). This is the fate-path complement to
 *     `http/app.ts`'s `environment === "development"` install gate.
 */
import {assert, describe, it} from "@effect/vitest";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import {PHOENIX_REACTIONS} from "../../../src/flags/keys.ts";
import {FlagOverrideStore} from "../flagship/FlagOverrideStore.ts";
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

// A `Flagship` whose real boolean eval ALWAYS returns the supplied default (dark-ship
// OFF for `phoenix-reactions`): the only way the flag reads ON is the dev-override
// decorator short-circuiting on `FlagsContext.overrides`, so a passing ON assertion
// proves the wrapper is installed — not that real eval flipped.
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

// A no-op runtime-override store (#2741): no key carries a durable override, so the
// runtime-override wrapper `FateFlagsLive` now installs delegates straight to real eval —
// isolating THIS test to the dev-override cookie behavior it asserts.
const noRuntimeOverrides: Layer.Layer<FlagOverrideStore> = Layer.succeed(FlagOverrideStore)(
	FlagOverrideStore.of({
		record: () => Effect.void,
		getActiveOverride: () => Effect.succeed(undefined),
		listActiveOverrides: () => Effect.succeed(new Map()),
	}),
);

/** Mirror the worker-scope `ConfigProvider` with a fixed `ENVIRONMENT` stage. */
const withEnvironment = (environment: string) =>
	Effect.provideService(
		ConfigProvider.ConfigProvider,
		ConfigProvider.fromUnknown({ENVIRONMENT: environment}),
	);

// Read `phoenix-reactions` (default OFF) through the environment-selected fate `Flags`
// layer, with an override forcing it ON present in the request `FlagsContext` — the
// exact shape `provideRequestFlags` builds from the threaded cookie under development.
const resolveWithOverride = (environment: string) =>
	Effect.gen(function* () {
		const flags = yield* Flags;
		return yield* flags.getBoolean(PHOENIX_REACTIONS, false).pipe(
			Effect.provideService(FlagsContext, {
				environment,
				overrides: {[PHOENIX_REACTIONS]: true},
			}),
		);
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				FateFlagsLive.pipe(Layer.provide(darkFlagship), Layer.provide(noRuntimeOverrides)),
				RuntimeContextStub,
			),
		),
		withEnvironment(environment),
	);

describe("fate Flags layer — dev-override honored only under development", () => {
	it.effect("development: the override cookie forces phoenix-reactions ON", () =>
		Effect.gen(function* () {
			// Real eval says OFF; the ON result can only come from the dev-override wrapper.
			assert.strictEqual(yield* resolveWithOverride("development"), true);
		}),
	);

	it.effect("production: the same override is IGNORED — flag stays OFF (prod fail-closed)", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* resolveWithOverride("production"), false);
		}),
	);

	it.effect("preview: the same override is IGNORED — flag stays OFF (deployed fail-closed)", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* resolveWithOverride("preview"), false);
		}),
	);
});
