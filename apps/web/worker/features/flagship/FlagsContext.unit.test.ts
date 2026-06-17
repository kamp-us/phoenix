/**
 * T0 unit coverage for the environment / per-app-stage mapping (#512): the
 * per-request `FlagsContext` sources its `environment` attribute from the deploy
 * stage (`ENVIRONMENT` config / ADR 0057), and a flag with an environment rule
 * resolves per stage over the `Flags` service — degrading safe on error.
 *
 * `makeRequestFlagsContext` reads `AppConfig` off the `ConfigProvider` alchemy
 * auto-wires at worker scope; here we mirror that with `ConfigProvider.fromUnknown`
 * over a fixed `ENVIRONMENT`, so the stage source is the thing under test.
 */
import {assert, describe, it} from "@effect/vitest";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {FlagshipError} from "alchemy/Cloudflare";
import {Effect, Layer} from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import {Flags, FlagsLive} from "./Flags.ts";
import {anonymousFlagsContext, FlagsContext, makeRequestFlagsContext} from "./FlagsContext.ts";
import {Flagship} from "./Flagship.ts";

const runtimeContext: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};
const RuntimeContextStub = Layer.succeed(RuntimeContext)(runtimeContext);

const unexercised = (method: string) => () =>
	Effect.die(`Flagship.${method} not exercised in FlagsContext.unit.test`);

const stubFlagship = (
	getBooleanValue: Flagship["Service"]["getBooleanValue"],
): Layer.Layer<Flagship> =>
	Layer.succeed(Flagship)(
		Flagship.of({
			raw: Effect.die("Flagship.raw not exercised in FlagsContext.unit.test"),
			get: unexercised("get"),
			getBooleanValue,
			getStringValue: unexercised("getStringValue"),
			getNumberValue: unexercised("getNumberValue"),
			getObjectValue: unexercised("getObjectValue"),
			getBooleanDetails: unexercised("getBooleanDetails"),
			getStringDetails: unexercised("getStringDetails"),
			getNumberDetails: unexercised("getNumberDetails"),
			getObjectDetails: unexercised("getObjectDetails"),
		}),
	);

const flagsOver = (
	getBooleanValue: Flagship["Service"]["getBooleanValue"],
): Layer.Layer<Flags | RuntimeContext> =>
	Layer.mergeAll(FlagsLive.pipe(Layer.provide(stubFlagship(getBooleanValue))), RuntimeContextStub);

/** Mirror the worker-scope `ConfigProvider` with a fixed `ENVIRONMENT` stage. */
const withStage = (environment: string) =>
	Effect.provideService(
		ConfigProvider.ConfigProvider,
		ConfigProvider.fromUnknown({ENVIRONMENT: environment}),
	);

describe("makeRequestFlagsContext — environment sourced from the deploy stage", () => {
	it.effect("populates `environment` from the ENVIRONMENT stage (development)", () =>
		Effect.gen(function* () {
			const context = yield* makeRequestFlagsContext({userId: "u-1"});
			assert.strictEqual(context.environment, "development");
			// the supplied identity is preserved alongside the sourced environment
			assert.strictEqual(context.userId, "u-1");
		}).pipe(withStage("development")),
	);

	it.effect("populates `environment` from the ENVIRONMENT stage (production)", () =>
		Effect.gen(function* () {
			const context = yield* makeRequestFlagsContext(anonymousFlagsContext);
			assert.strictEqual(context.environment, "production");
		}).pipe(withStage("production")),
	);

	it.effect("falls back to production when ENVIRONMENT is unset (fail-closed default)", () =>
		Effect.gen(function* () {
			const context = yield* makeRequestFlagsContext(anonymousFlagsContext);
			assert.strictEqual(context.environment, "production");
		}).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))),
	);
});

describe("environment-targeting flag resolves per stage (no call-site change)", () => {
	// One flag, one stub rule: ON only in development. The call-site is identical
	// across stages — only the sourced `environment` differs, so the same flag
	// resolves differently per stage with no code change.
	const devOnlyFlag = (_key: string, defaultValue: boolean, context?: {environment?: string}) =>
		Effect.succeed(context?.environment === "development" ? true : defaultValue);

	const resolveInStage = (environment: string) =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const context = yield* makeRequestFlagsContext(anonymousFlagsContext);
			return yield* flags
				.getBoolean("dev-only-feature", false)
				.pipe(Effect.provideService(FlagsContext, context));
		}).pipe(withStage(environment), Effect.provide(flagsOver(devOnlyFlag)));

	it.effect("resolves ON in the development stage", () =>
		Effect.gen(function* () {
			const enabled = yield* resolveInStage("development");
			assert.strictEqual(enabled, true);
		}),
	);

	it.effect("resolves OFF (the default) in the production stage — same call-site", () =>
		Effect.gen(function* () {
			const enabled = yield* resolveInStage("production");
			assert.strictEqual(enabled, false);
		}),
	);
});

describe("environment-targeting degrades safe on error", () => {
	it.effect("a FlagshipError collapses to the supplied default even with an environment rule", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const context = yield* makeRequestFlagsContext(anonymousFlagsContext);
			// default `false` is the off/safe path; an eval error must fall back to it
			// regardless of the environment attribute carried in the context.
			const enabled = yield* flags
				.getBoolean("dev-only-feature", false)
				.pipe(Effect.provideService(FlagsContext, context));
			assert.strictEqual(enabled, false);
		}).pipe(
			withStage("development"),
			Effect.provide(
				flagsOver(() =>
					Effect.fail(new FlagshipError({message: "binding unavailable", cause: undefined})),
				),
			),
		),
	);
});
