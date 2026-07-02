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
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
	AppConfig,
	betterAuthSecret,
	ENV_BINDINGS,
	envBindings,
	environment,
	sentryDsn,
} from "./config.ts";

const withEnv = (env: Record<string, string>) =>
	Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env));

describe("ENV_BINDINGS — the single binding-name source", () => {
	it("pins the worker's binding names", () => {
		assert.strictEqual(ENV_BINDINGS.environment, "ENVIRONMENT");
		assert.strictEqual(ENV_BINDINGS.betterAuthSecret, "BETTER_AUTH_SECRET");
		assert.strictEqual(ENV_BINDINGS.sentryDsn, "SENTRY_DSN");
	});

	it("envBindings binds only the always-on names (SENTRY_DSN is bound conditionally, not here)", () => {
		// `sentryDsn` is in ENV_BINDINGS (single-sourced name) but deliberately NOT in
		// `envBindings`: it's added to the env block conditionally at deploy (index.ts)
		// only when a DSN is provisioned, so an unset DSN produces no binding (ADR 0118).
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

	it.effect("`sentryDsn` resolves Some off the bound name", () =>
		Effect.gen(function* () {
			const dsn = yield* sentryDsn;
			assert.strictEqual(Option.getOrNull(dsn), "https://k@o0.ingest.de.sentry.io/1");
		}).pipe(withEnv({[ENV_BINDINGS.sentryDsn]: "https://k@o0.ingest.de.sentry.io/1"})),
	);

	it.effect("`sentryDsn` resolves None when the binding is absent (the inert path)", () =>
		Effect.gen(function* () {
			const dsn = yield* sentryDsn;
			assert.strictEqual(Option.isNone(dsn), true);
		}).pipe(withEnv({})),
	);

	it.effect("`AppConfig` resolves `environment` off the bound name", () =>
		Effect.gen(function* () {
			const {environment: resolved} = yield* AppConfig;
			assert.strictEqual(resolved, "production");
		}).pipe(withEnv({[ENV_BINDINGS.environment]: "production"})),
	);
});
