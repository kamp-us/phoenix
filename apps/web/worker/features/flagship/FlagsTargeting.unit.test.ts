/**
 * Targeting + percentage-rollout coverage, with no binding and no I/O. The rule
 * *configuration* is system-tier and lives in `resources.ts`; what is unit-testable —
 * the domain→wire mapping and the bucketing stability — is asserted here.
 */
import {assert, describe, it} from "@effect/vitest";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Flagship as CfFlagship} from "alchemy/Cloudflare";
import {Effect, Layer} from "effect";
import {Flags, FlagsLive} from "./Flags.ts";
import {encodeRoles, FlagsContext, toEvaluationContext} from "./FlagsContext.ts";
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
	Effect.die(`Flagship.${method} not exercised in FlagsTargeting.unit.test`);

const stubFlagship = (
	getBooleanValue: Flagship["Service"]["getBooleanValue"],
): Layer.Layer<Flagship> =>
	Layer.succeed(Flagship)(
		Flagship.of({
			raw: Effect.die("Flagship.raw not exercised in FlagsTargeting.unit.test"),
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

/**
 * A deterministic stand-in for Flagship's evaluation engine, mirroring the
 * `demoTargetingFlag` IaC config. No real hashing — just a deterministic function of the
 * bucketing key, which is the only property these tests turn on.
 */
const INTERNAL_ROLE_MARKER = "|internal|";
const fnv1a = (s: string): number => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
};
const bucketOf = (targetingKey: string): number => fnv1a(targetingKey) % 100;

const demoEval: Flagship["Service"]["getBooleanValue"] = (_key, defaultValue, context) => {
	if (context === undefined) return Effect.succeed(defaultValue);
	if (typeof context.roles === "string" && context.roles.includes(INTERNAL_ROLE_MARKER))
		return Effect.succeed(true);
	// 25% consistent-hash rollout on the bucketing key.
	if (typeof context.targetingKey === "string" && bucketOf(context.targetingKey) < 25)
		return Effect.succeed(true);
	return Effect.succeed(defaultValue);
};

describe("toEvaluationContext — domain→wire mapping (#511)", () => {
	it("maps userId to the targetingKey bucketing key", () => {
		assert.deepStrictEqual(toEvaluationContext({userId: "u-1"}), {targetingKey: "u-1"});
	});

	it("is deterministic: a given userId always yields the same targetingKey", () => {
		const a = toEvaluationContext({userId: "u-stable"});
		const b = toEvaluationContext({userId: "u-stable"});
		assert.deepStrictEqual(a, b);
		assert.strictEqual((a as {targetingKey: string}).targetingKey, "u-stable");
	});

	it("flattens a role list to a delimited, contains-targetable string", () => {
		assert.strictEqual(encodeRoles(["internal", "beta"]), "|internal|beta|");
		assert.deepStrictEqual(toEvaluationContext({userId: "u-2", roles: ["internal"]}), {
			targetingKey: "u-2",
			roles: "|internal|",
		});
	});

	it("carries the environment attribute through", () => {
		assert.deepStrictEqual(toEvaluationContext({userId: "u-3", environment: "production"}), {
			targetingKey: "u-3",
			environment: "production",
		});
	});

	it("omits empty role lists and yields undefined for an empty context", () => {
		assert.deepStrictEqual(toEvaluationContext({userId: "u-4", roles: []}), {targetingKey: "u-4"});
		assert.strictEqual(toEvaluationContext({}), undefined);
	});
});

describe("Flags — attribute targeting (#511)", () => {
	it.effect("a targeted (internal-role) user gets the variation", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const enabled = yield* flags
				.getBoolean("targeting-demo", false)
				.pipe(Effect.provideService(FlagsContext, {userId: "u-internal", roles: ["internal"]}));
			assert.strictEqual(enabled, true);
		}).pipe(Effect.provide(flagsOver(demoEval))),
	);

	it.effect("an untargeted user with a non-rollout bucket gets the default", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const outside = "user-2";
			assert.isAtLeast(bucketOf(outside), 25);
			const enabled = yield* flags
				.getBoolean("targeting-demo", false)
				.pipe(Effect.provideService(FlagsContext, {userId: outside}));
			assert.strictEqual(enabled, false);
		}).pipe(Effect.provide(flagsOver(demoEval))),
	);
});

describe("Flags — percentage rollout, stable bucketing (#511)", () => {
	it.effect("a given userId lands in the SAME bucket across repeated evaluations", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const evalOnce = () =>
				flags
					.getBoolean("targeting-demo", false)
					.pipe(Effect.provideService(FlagsContext, {userId: "u-repeat"}));
			const first = yield* evalOnce();
			// Identical result every time IS the anti-flicker contract.
			for (let i = 0; i < 50; i++) {
				const again = yield* evalOnce();
				assert.strictEqual(again, first);
			}
		}).pipe(Effect.provide(flagsOver(demoEval))),
	);

	it.effect("two different userIds bucket independently (the rollout actually splits)", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const inside = "user-0"; // asserted in-rollout below
			assert.isBelow(bucketOf(inside), 25);
			const enabled = yield* flags
				.getBoolean("targeting-demo", false)
				.pipe(Effect.provideService(FlagsContext, {userId: inside}));
			assert.strictEqual(enabled, true);
		}).pipe(Effect.provide(flagsOver(demoEval))),
	);
});

describe("Flags — safe default with targeting context (#511)", () => {
	it.effect("a FlagshipError collapses to the supplied default even with a targeting context", () =>
		Effect.gen(function* () {
			const flags = yield* Flags;
			const enabled = yield* flags
				.getBoolean("targeting-demo", false)
				.pipe(Effect.provideService(FlagsContext, {userId: "u-err", roles: ["internal"]}));
			assert.strictEqual(enabled, false);
		}).pipe(
			Effect.provide(
				flagsOver(() =>
					Effect.fail(
						new CfFlagship.FlagshipError({message: "binding unavailable", cause: undefined}),
					),
				),
			),
		),
	);
});
