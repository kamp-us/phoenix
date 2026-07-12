/**
 * Unit coverage for `withRuntimeOverrides` (#2741) — the durable-override decorator over a
 * `FlagsAccess`. Drives it over a stub inner surface + stub `FlagOverrideStore` (no binding, no
 * D1), asserting the three load-bearing contracts:
 *   - an active override short-circuits `getBoolean` to the forced value (on AND off);
 *   - no active override (or a store that resolved `undefined`) delegates to the real evaluation,
 *     so a Flagship outage still degrades to the caller's safe default — the override layer never
 *     turns the never-throwing flag contract fail-open (epic #2711 story 8).
 */
import {assert, describe, it} from "@effect/vitest";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import type {FlagOverrideStore} from "./FlagOverrideStore.ts";
import {type FlagsAccess, withRuntimeOverrides} from "./Flags.ts";
import {anonymousFlagsContext, FlagsContext} from "./FlagsContext.ts";

const runtimeContext: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};
const RuntimeContextStub = Layer.succeed(RuntimeContext)(runtimeContext);

// A stub inner surface whose boolean read returns `innerValue` (standing in for the real,
// possibly-degraded Flagship evaluation). The typed reads die — the override surface is boolean-only.
const stubInner = (innerValue: boolean): FlagsAccess => ({
	getBoolean: (_key, _default) => Effect.succeed(innerValue),
	getString: () => Effect.die("getString not exercised"),
	getNumber: () => Effect.die("getNumber not exercised"),
	getObject: () => Effect.die("getObject not exercised"),
});

// A stub store whose per-key read resolves `override` (the fail-soft `undefined` stands in for
// both "no override" and "a swallowed store outage"). `record`/`listActiveOverrides` are unused.
const stubStore = (override: boolean | undefined): FlagOverrideStore["Service"] => ({
	record: () => Effect.void,
	getActiveOverride: () => Effect.succeed(override),
	listActiveOverrides: () => Effect.succeed(new Map()),
});

const readBoolean = (inner: FlagsAccess, store: FlagOverrideStore["Service"]) =>
	withRuntimeOverrides(inner, store)
		.getBoolean("phoenix-reactions", false)
		.pipe(
			Effect.provideService(FlagsContext, anonymousFlagsContext),
			Effect.provide(RuntimeContextStub),
		);

describe("withRuntimeOverrides", () => {
	it.effect("an active `on` override short-circuits to true, ignoring the real evaluation", () =>
		Effect.gen(function* () {
			// inner would say false; the override forces true.
			const value = yield* readBoolean(stubInner(false), stubStore(true));
			assert.strictEqual(value, true);
		}),
	);

	it.effect("an active `off` override short-circuits to false, ignoring the real evaluation", () =>
		Effect.gen(function* () {
			// inner would say true; the override forces false.
			const value = yield* readBoolean(stubInner(true), stubStore(false));
			assert.strictEqual(value, false);
		}),
	);

	it.effect("no active override delegates to the real evaluation (the inner value wins)", () =>
		Effect.gen(function* () {
			const value = yield* readBoolean(stubInner(true), stubStore(undefined));
			assert.strictEqual(value, true);
		}),
	);

	it.effect(
		"a store that resolved undefined (fail-soft) degrades to the caller's safe default",
		() =>
			Effect.gen(function* () {
				// Simulate a Flagship outage: the real evaluation already degraded to the `false`
				// default. With no override, the wrapper must surface that safe default, never throw.
				const value = yield* readBoolean(stubInner(false), stubStore(undefined));
				assert.strictEqual(value, false);
			}),
	);
});
