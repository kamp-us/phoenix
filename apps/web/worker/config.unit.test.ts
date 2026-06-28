/**
 * Guards the single-sourced worker env binding NAMES (#1432): the binding key the
 * worker `env:` block uses and the name the `Config` constructor reads under are the
 * SAME `ENV_BINDINGS` literal, so a key↔name drift can't sneak in. Two halves:
 *
 *  - `envBindings` (the object `index.ts` spreads into `env:`) is keyed by exactly the
 *    declared binding names — so the worker binds under nothing else.
 *  - each `Config` constant actually RESOLVES a value provided under that same name —
 *    so the read and the bind agree end to end. If a constructor's name string ever
 *    drifted from `ENV_BINDINGS`, the value provided under the binding name would not
 *    reach the read (environment falls back to its default; the secret errors).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Redacted from "effect/Redacted";
import {AppConfig, betterAuthSecret, ENV_BINDINGS, envBindings, environment} from "./config.ts";

const withEnv = (env: Record<string, string>) =>
	Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env));

describe("ENV_BINDINGS — the single binding-name source", () => {
	it("pins the worker's two binding names", () => {
		assert.strictEqual(ENV_BINDINGS.environment, "ENVIRONMENT");
		assert.strictEqual(ENV_BINDINGS.betterAuthSecret, "BETTER_AUTH_SECRET");
	});

	it("envBindings binds under exactly the declared names (no key drift)", () => {
		assert.deepStrictEqual(
			Object.keys(envBindings).sort(),
			[ENV_BINDINGS.environment, ENV_BINDINGS.betterAuthSecret].sort(),
		);
	});

	it("envBindings maps each binding name to its Config constant (the env block binds these)", () => {
		assert.strictEqual(envBindings[ENV_BINDINGS.environment], environment);
		assert.strictEqual(envBindings[ENV_BINDINGS.betterAuthSecret], betterAuthSecret);
	});
});

describe("the Config constants read under the single-sourced binding name", () => {
	it.effect("`environment` resolves the value provided under ENV_BINDINGS.environment", () =>
		Effect.gen(function* () {
			const value = yield* environment;
			assert.strictEqual(value, "preview");
		}).pipe(withEnv({[ENV_BINDINGS.environment]: "preview"})),
	);

	it.effect(
		"`betterAuthSecret` resolves the value provided under ENV_BINDINGS.betterAuthSecret",
		() =>
			Effect.gen(function* () {
				const value = yield* betterAuthSecret;
				assert.strictEqual(Redacted.value(value), "s3cr3t");
			}).pipe(withEnv({[ENV_BINDINGS.betterAuthSecret]: "s3cr3t"})),
	);

	it.effect("`AppConfig` resolves `environment` off the bound name", () =>
		Effect.gen(function* () {
			const {environment: resolved} = yield* AppConfig;
			assert.strictEqual(resolved, "production");
		}).pipe(withEnv({[ENV_BINDINGS.environment]: "production"})),
	);
});
