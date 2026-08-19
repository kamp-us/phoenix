/**
 * The #1868 regression guard: the fate data-plane `Flags` layer must install the
 * local-override wrapper (before it, `makeFateLayer` baked the PLAIN `FlagsLive`, so the
 * flag-flip cookie had no effect on a mutation). Whether an override is AUTHORIZED is a
 * different question, proven in `flagship/override-authz.unit.test.ts`.
 *
 * The stub `Flagship`'s real eval always returns the supplied default, so the only way a
 * flag can read ON is the override decorator — a passing ON assertion proves the wrapper
 * is installed, not that real eval flipped.
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
			assert.strictEqual(value, true);
		}),
	);

	it.effect("no override in context delegates to real eval — stays OFF", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* resolveWith({environment: "production"}), false);
		}),
	);
});
