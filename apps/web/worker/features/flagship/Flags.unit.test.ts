/**
 * T0 unit coverage for the `Flags` domain service — the boolean dark-ship
 * primitive (#508). Drives `FlagsLive` over a stubbed `Flagship` client (no
 * binding, no I/O) and asserts the two load-bearing contracts:
 *
 *   - on/off branching: a flag returning true/false surfaces that value;
 *   - safe-default fallback: a `FlagshipError` from the client collapses to the
 *     supplied default, and the public `getBoolean` error channel is `never`.
 */
import {assert, describe, it} from "@effect/vitest";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {FlagshipError} from "alchemy/Cloudflare";
import {Effect, Layer} from "effect";
import {Flags, FlagsLive} from "./Flags.ts";
import {anonymousFlagsContext, FlagsContext} from "./FlagsContext.ts";
import {Flagship} from "./Flagship.ts";

// `RuntimeContext` is the alchemy binding's intrinsic ambient requirement
// (discharged at worker scope in production, #507); the stub satisfies it here.
const runtimeContext: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};
const RuntimeContextStub = Layer.succeed(RuntimeContext)(runtimeContext);

const unexercised = (method: string) => () =>
	Effect.die(`Flagship.${method} not exercised in Flags.unit.test`);

/**
 * A `Flagship` stub whose `getBooleanValue` is supplied by the test; every other
 * method dies so an accidental call is loud. `boolean` reads either return a
 * value or fail with a `FlagshipError` (the misconfigured-binding signal).
 */
const stubFlagship = (
	getBooleanValue: Flagship["Service"]["getBooleanValue"],
): Layer.Layer<Flagship> =>
	Layer.succeed(Flagship)(
		Flagship.of({
			raw: Effect.die("Flagship.raw not exercised in Flags.unit.test"),
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

describe("Flags.getBoolean", () => {
	it.effect("a flag evaluating true surfaces true (the on branch)", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const enabled = yield* flags
				.getBoolean("feature-on", false)
				.pipe(Effect.provideService(FlagsContext, anonymousFlagsContext));
			assert.strictEqual(enabled, true);
		}).pipe(Effect.provide(flagsOver((_key, _default) => Effect.succeed(true)))),
	);

	it.effect("a flag evaluating false surfaces false (the off branch)", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const enabled = yield* flags
				.getBoolean("feature-off", true)
				.pipe(Effect.provideService(FlagsContext, anonymousFlagsContext));
			assert.strictEqual(enabled, false);
		}).pipe(Effect.provide(flagsOver((_key, _default) => Effect.succeed(false)))),
	);

	it.effect("a FlagshipError collapses to the supplied default (degrade safe)", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			// default `false` is the safe/off path; an eval error must fall back to it.
			const enabled = yield* flags
				.getBoolean("feature-erroring", false)
				.pipe(Effect.provideService(FlagsContext, anonymousFlagsContext));
			assert.strictEqual(enabled, false);
		}).pipe(
			Effect.provide(
				flagsOver(() =>
					Effect.fail(new FlagshipError({message: "binding unavailable", cause: undefined})),
				),
			),
		),
	);

	it.effect("the error fallback yields the default even when the default is true", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const enabled = yield* flags
				.getBoolean("feature-erroring", true)
				.pipe(Effect.provideService(FlagsContext, anonymousFlagsContext));
			assert.strictEqual(enabled, true);
		}).pipe(
			Effect.provide(
				flagsOver(() =>
					Effect.fail(new FlagshipError({message: "binding unavailable", cause: undefined})),
				),
			),
		),
	);

	it.effect("the per-request identity context is threaded to the client", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const enabled = yield* flags
				.getBoolean("targeted", false)
				.pipe(Effect.provideService(FlagsContext, {userId: "u-42"}));
			// the stub returns true only when it sees the bucketing key for u-42
			assert.strictEqual(enabled, true);
		}).pipe(
			Effect.provide(
				flagsOver((_key, defaultValue, context) =>
					Effect.succeed(context?.targetingKey === "u-42" ? true : defaultValue),
				),
			),
		),
	);
});

const flagshipError = () =>
	Effect.fail(new FlagshipError({message: "binding unavailable", cause: undefined}));

/**
 * The typed-read analog of `stubFlagship`: the boolean read dies (these suites
 * exercise only the typed surface) and the supplied typed reads override the
 * unexercised defaults. Each surfaces a value or fails with a `FlagshipError`.
 */
const stubTypedFlagship = (overrides: {
	getStringValue?: Flagship["Service"]["getStringValue"];
	getNumberValue?: Flagship["Service"]["getNumberValue"];
	getObjectValue?: Flagship["Service"]["getObjectValue"];
}): Layer.Layer<Flagship> =>
	Layer.succeed(Flagship)(
		Flagship.of({
			raw: Effect.die("Flagship.raw not exercised in Flags.unit.test"),
			get: unexercised("get"),
			getBooleanValue: unexercised("getBooleanValue"),
			getStringValue: overrides.getStringValue ?? unexercised("getStringValue"),
			getNumberValue: overrides.getNumberValue ?? unexercised("getNumberValue"),
			getObjectValue: overrides.getObjectValue ?? unexercised("getObjectValue"),
			getBooleanDetails: unexercised("getBooleanDetails"),
			getStringDetails: unexercised("getStringDetails"),
			getNumberDetails: unexercised("getNumberDetails"),
			getObjectDetails: unexercised("getObjectDetails"),
		}),
	);

const typedFlagsOver = (overrides: {
	getStringValue?: Flagship["Service"]["getStringValue"];
	getNumberValue?: Flagship["Service"]["getNumberValue"];
	getObjectValue?: Flagship["Service"]["getObjectValue"];
}): Layer.Layer<Flags | RuntimeContext> =>
	Layer.mergeAll(FlagsLive.pipe(Layer.provide(stubTypedFlagship(overrides))), RuntimeContextStub);

describe("Flags.getString", () => {
	it.effect("an evaluated string surfaces that value (happy path)", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const value = yield* flags
				.getString("copy", "fallback")
				.pipe(Effect.provideService(FlagsContext, anonymousFlagsContext));
			assert.strictEqual(value, "live-copy");
		}).pipe(Effect.provide(typedFlagsOver({getStringValue: () => Effect.succeed("live-copy")}))),
	);

	it.effect("a FlagshipError collapses to the supplied string default (degrade safe)", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const value = yield* flags
				.getString("copy", "fallback")
				.pipe(Effect.provideService(FlagsContext, anonymousFlagsContext));
			assert.strictEqual(value, "fallback");
		}).pipe(Effect.provide(typedFlagsOver({getStringValue: flagshipError}))),
	);
});

describe("Flags.getNumber", () => {
	it.effect("an evaluated number surfaces that value (happy path)", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const value = yield* flags
				.getNumber("limit", 10)
				.pipe(Effect.provideService(FlagsContext, anonymousFlagsContext));
			assert.strictEqual(value, 42);
		}).pipe(Effect.provide(typedFlagsOver({getNumberValue: () => Effect.succeed(42)}))),
	);

	it.effect("a FlagshipError collapses to the supplied number default (degrade safe)", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const value = yield* flags
				.getNumber("limit", 10)
				.pipe(Effect.provideService(FlagsContext, anonymousFlagsContext));
			assert.strictEqual(value, 10);
		}).pipe(Effect.provide(typedFlagsOver({getNumberValue: flagshipError}))),
	);
});

describe("Flags.getObject", () => {
	it.effect("an evaluated object surfaces that value (happy path)", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const value = yield* flags
				.getObject("config", {theme: "default"})
				.pipe(Effect.provideService(FlagsContext, anonymousFlagsContext));
			assert.deepStrictEqual(value, {theme: "dark"});
		}).pipe(
			Effect.provide(typedFlagsOver({getObjectValue: () => Effect.succeed({theme: "dark"})})),
		),
	);

	it.effect("a FlagshipError collapses to the supplied object default (degrade safe)", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const fallback = {theme: "default"};
			const value = yield* flags
				.getObject("config", fallback)
				.pipe(Effect.provideService(FlagsContext, anonymousFlagsContext));
			assert.deepStrictEqual(value, fallback);
		}).pipe(Effect.provide(typedFlagsOver({getObjectValue: flagshipError}))),
	);
});
