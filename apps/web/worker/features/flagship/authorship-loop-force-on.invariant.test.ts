/**
 * The force-on-is-AUDIT-ONLY / PROD-NEVER-ON invariant for the earned-authorship
 * loop (#1511, epic #1510 — the rite-audit harness gating prerequisite). Mirrors
 * `authorship-loop.invariant.test.ts` (the default-=-safe-state proof) with the
 * complementary safety core: the environment-targeting force-on rule the audit
 * stage activates serves `on` ONLY for the dedicated `audit` deploy class and can
 * NEVER fire in `production`.
 *
 * Two layers, no binding / no I/O:
 *
 *   - structural — the exported `AUTHORSHIP_LOOP_RULES` (the same record the factory
 *     spreads into `FlagshipFlag`) is one `equals environment == audit` rule; every
 *     rule that serves `on` keys on `audit`, so none can match `production`. The
 *     prod-never property is read off the rule shape itself — as close to
 *     structurally unrepresentable as the IaC mechanism allows.
 *   - semantic — `FlagsLive` over a stub Flagship that evaluates `AUTHORSHIP_LOOP_RULES`
 *     resolves the flag ON for `environment: "audit"` and OFF (the default) for
 *     `production` and `preview`, proving the live rule config drives the audit-on /
 *     prod-off behavior end to end through the real `Flags` seam.
 *
 * Plus the env-taxonomy guard the AC names: adding the `audit` class keeps
 * `parseDeployEnvironment` fail-LOUD on genuinely-unknown values (#1433).
 */
import {assert, describe, it} from "@effect/vitest";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import type {FlagshipEvaluationContext} from "alchemy/Cloudflare";
import {Effect, Layer} from "effect";
import {PHOENIX_AUTHORSHIP_LOOP} from "../../../src/flags/keys.ts";
import {parseDeployEnvironment, UnknownEnvironmentError} from "../../environment.ts";
import {Flags, FlagsLive} from "./Flags.ts";
import {FlagsContext} from "./FlagsContext.ts";
import {Flagship} from "./Flagship.ts";
import {AUTHORSHIP_LOOP_FLAG, AUTHORSHIP_LOOP_RULES} from "./resources.ts";

const runtimeContext: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};
const RuntimeContextStub = Layer.succeed(RuntimeContext)(runtimeContext);

const unexercised = (method: string) => () =>
	Effect.die(`Flagship.${method} not exercised in authorship-loop-force-on.invariant.test`);

const stubFlagship = (
	getBooleanValue: Flagship["Service"]["getBooleanValue"],
): Layer.Layer<Flagship> =>
	Layer.succeed(Flagship)(
		Flagship.of({
			raw: Effect.die("Flagship.raw not exercised"),
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
 * A deterministic stand-in for Flagship's engine that evaluates the LIVE exported
 * `AUTHORSHIP_LOOP_RULES` against the wire context (first matching rule wins, in
 * ascending priority). Only the `equals` operator on a flat attribute is needed for
 * this flag; anything else falls through to the default — so the test exercises the
 * real rule config, not a hand-mirrored copy.
 */
const evalAuthorshipLoop: Flagship["Service"]["getBooleanValue"] = (
	_key,
	defaultValue,
	context,
) => {
	const ctx = (context ?? {}) as FlagshipEvaluationContext;
	for (const rule of [...AUTHORSHIP_LOOP_RULES].sort((a, b) => a.priority - b.priority)) {
		const matched = rule.conditions.every((condition) => {
			if (!("attribute" in condition)) return false;
			return condition.operator === "equals" && ctx[condition.attribute] === condition.value;
		});
		if (matched) return Effect.succeed(rule.serveVariation === "on");
	}
	return Effect.succeed(defaultValue);
};

const resolveForEnvironment = (environment: string) =>
	Effect.gen(function* () {
		const flags = yield* Flags;
		return yield* flags
			.getBoolean(PHOENIX_AUTHORSHIP_LOOP, false)
			.pipe(Effect.provideService(FlagsContext, {environment}));
	}).pipe(Effect.provide(flagsOver(evalAuthorshipLoop)));

describe("authorship loop force-on — structurally audit-only, prod-never", () => {
	it("is a single equals-environment==audit rule that serves on", () => {
		assert.strictEqual(AUTHORSHIP_LOOP_RULES.length, 1);
		const [rule] = AUTHORSHIP_LOOP_RULES;
		assert.ok(rule);
		assert.strictEqual(rule.serveVariation, "on");
		assert.strictEqual(rule.conditions.length, 1);
		const [condition] = rule.conditions;
		assert.ok(condition && "attribute" in condition);
		assert.strictEqual(condition.attribute, "environment");
		assert.strictEqual(condition.operator, "equals");
		assert.strictEqual(condition.value, "audit");
	});

	it("no on-serving rule can match production (the prod-never structural property)", () => {
		// Every rule that would serve `on` keys its environment condition on `audit`,
		// so `production` (the value a prod deploy carries) can match NONE of them.
		for (const rule of AUTHORSHIP_LOOP_RULES) {
			if (rule.serveVariation !== "on") continue;
			for (const condition of rule.conditions) {
				if ("attribute" in condition && condition.attribute === "environment") {
					assert.notStrictEqual(condition.value, "production");
					assert.strictEqual(condition.value, "audit");
				}
			}
		}
	});

	it("the default stays off — outside the audit class the flag is the dark-ship safe state", () => {
		assert.strictEqual(AUTHORSHIP_LOOP_FLAG.defaultVariation, "off");
		assert.strictEqual(AUTHORSHIP_LOOP_FLAG.variations.off, false);
	});
});

describe("authorship loop force-on — resolves audit-on / prod-off through Flags", () => {
	it.effect("reads ON for the dedicated audit environment", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* resolveForEnvironment("audit"), true);
		}),
	);

	it.effect("stays OFF for production — no env value forces it on", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* resolveForEnvironment("production"), false);
		}),
	);

	it.effect("stays OFF for a per-PR preview deploy", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* resolveForEnvironment("preview"), false);
		}),
	);

	it.effect("stays OFF for development", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* resolveForEnvironment("development"), false);
		}),
	);
});

describe("authorship loop force-on — the env-taxonomy change keeps parseDeployEnvironment fail-loud", () => {
	it("recognizes the new audit class as a known value", () => {
		assert.strictEqual(parseDeployEnvironment("audit"), "audit");
	});

	it("still throws UnknownEnvironmentError on a genuinely-unknown value", () => {
		assert.throws(() => parseDeployEnvironment("prod"), UnknownEnvironmentError);
		assert.throws(() => parseDeployEnvironment("staging"), UnknownEnvironmentError);
	});
});
