/**
 * The keychain-first resolution order over a FAKE Keychain — no real `security` CLI and no
 * real CF in the unit tier (ADR 0082). Covers the load-bearing contract of #1730: keychain
 * hit wins, keychain miss falls back to the env vars byte-for-byte (the CI path), and a
 * double miss fails with the `auth login` hint; the account-id ConfigProvider mirrors the
 * same order for `Config.string("CLOUDFLARE_ACCOUNT_ID")`.
 */
import {Credentials} from "@distilled.cloud/cloudflare/Credentials";
import {assert, describe, it} from "@effect/vitest";
import {Config, ConfigProvider, Effect, Layer, Redacted} from "effect";
import {
	AccountIdKeychainConfig,
	CredentialsKeychainFirst,
	credentialSources,
} from "./credentials.ts";
import {Keychain, type KeychainCommandError} from "./keychain.ts";

const fakeKeychain = (store: Record<string, string>): Layer.Layer<Keychain> =>
	Layer.succeed(Keychain)({
		get: (account) => Effect.succeed(store[account]),
		set: () => Effect.void as Effect.Effect<void, KeychainCommandError>,
		remove: () => Effect.succeed(false) as Effect.Effect<boolean, KeychainCommandError>,
	});

const resolveWith = (store: Record<string, string>, env: Record<string, string>) =>
	Effect.gen(function* () {
		const resolve = yield* Credentials;
		return yield* resolve;
	}).pipe(
		Effect.provide(CredentialsKeychainFirst.pipe(Layer.provide(fakeKeychain(store)))),
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({env})),
	);

describe("CredentialsKeychainFirst", () => {
	it.effect("resolves the keychain token first, even when the env var is also set", () =>
		Effect.gen(function* () {
			const creds = yield* resolveWith(
				{"cloudflare-api-token": "keychain-token"},
				{CLOUDFLARE_API_TOKEN: "env-token"},
			);
			assert.strictEqual(creds.type, "apiToken");
			assert.strictEqual(
				creds.type === "apiToken" ? Redacted.value(creds.apiToken) : undefined,
				"keychain-token",
			);
		}),
	);

	it.effect("falls back to $CLOUDFLARE_API_TOKEN on a keychain miss (the CI path)", () =>
		Effect.gen(function* () {
			const creds = yield* resolveWith({}, {CLOUDFLARE_API_TOKEN: "env-token"});
			assert.strictEqual(creds.type, "apiToken");
			assert.strictEqual(
				creds.type === "apiToken" ? Redacted.value(creds.apiToken) : undefined,
				"env-token",
			);
		}),
	);

	it.effect("a double miss fails with a ConfigError pointing at `anka-ops auth login`", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(resolveWith({}, {}));
			assert.isTrue(exit._tag === "Failure");
			const message = exit._tag === "Failure" ? String(exit.cause) : "";
			assert.include(message, "anka-ops auth login");
		}),
	);
});

describe("AccountIdKeychainConfig", () => {
	const readAccountId = (store: Record<string, string>, env: Record<string, string>) =>
		Effect.gen(function* () {
			return yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
		}).pipe(
			Effect.provide(AccountIdKeychainConfig.pipe(Layer.provide(fakeKeychain(store)))),
			Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({env})),
		);

	it.effect("keychain account id wins over the env var", () =>
		Effect.gen(function* () {
			const value = yield* readAccountId(
				{"cloudflare-account-id": "a".repeat(32)},
				{CLOUDFLARE_ACCOUNT_ID: "b".repeat(32)},
			);
			assert.strictEqual(value, "a".repeat(32));
		}),
	);

	it.effect("keychain miss falls through to $CLOUDFLARE_ACCOUNT_ID", () =>
		Effect.gen(function* () {
			const value = yield* readAccountId({}, {CLOUDFLARE_ACCOUNT_ID: "b".repeat(32)});
			assert.strictEqual(value, "b".repeat(32));
		}),
	);

	it.effect("other config paths pass through to the env untouched", () =>
		Effect.gen(function* () {
			const value = yield* Effect.gen(function* () {
				return yield* Config.string("SOME_OTHER_KEY");
			}).pipe(
				Effect.provide(
					AccountIdKeychainConfig.pipe(
						Layer.provide(fakeKeychain({"cloudflare-account-id": "a".repeat(32)})),
					),
				),
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromEnv({env: {SOME_OTHER_KEY: "hello"}}),
				),
			);
			assert.strictEqual(value, "hello");
		}),
	);
});

describe("credentialSources", () => {
	it.effect("reports keychain over env per credential", () =>
		Effect.gen(function* () {
			const sources = yield* credentialSources.pipe(
				Effect.provide(fakeKeychain({"cloudflare-api-token": "t"})),
			);
			assert.strictEqual(sources.apiToken, "keychain");
		}),
	);
});
