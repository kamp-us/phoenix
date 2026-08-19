/**
 * `overridesAuthorized` — the per-request gate that un-gates the #622 local-override
 * wrapper to production for an admin (#2741). Proven with NO binding and NO I/O.
 *
 * The prod fail-closed invariant: development is always authorized; on production only
 * an admin is, so a non-admin's or an anonymous visitor's `phoenix_flag_overrides`
 * cookie stays inert. The second block proves the verdict is actually consumed by
 * `makeRequestFlagsContext`.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type Actor,
	AgentAuthority,
	CurrentActor,
	human,
	RelationStore,
	unauthenticated,
} from "@kampus/authz";
import {Effect, Layer} from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import {encodeOverrideCookieValue, FLAG_OVERRIDE_COOKIE} from "./dev-override.ts";
import {makeRequestFlagsContext} from "./FlagsContext.ts";
import {overridesAuthorized} from "./override-authz.ts";

// `Admin.over` reads the `(actor, "admin", platform)` tuple through `RelationStore.has`.
const relationStoreWith = (isAdmin: boolean): Layer.Layer<RelationStore> =>
	Layer.succeed(RelationStore, {has: () => Effect.succeed(isAdmin)} as never);

const authorize = (environment: string, opts: {isAdmin: boolean; actor: Actor}) =>
	overridesAuthorized({environment}).pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.succeed(CurrentActor, {actor: opts.actor}),
				Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(true)}),
				relationStoreWith(opts.isAdmin),
			),
		),
	);

describe("overridesAuthorized — may this request honor its per-browser cookie (#2741)", () => {
	it.effect("development: always authorized (the #622 dev convenience)", () =>
		Effect.gen(function* () {
			const allowed = yield* authorize("development", {
				isAdmin: false,
				actor: unauthenticated,
			});
			assert.strictEqual(allowed, true);
		}),
	);

	it.effect("prod, admin: authorized (admin-on-prod)", () =>
		Effect.gen(function* () {
			const allowed = yield* authorize("production", {isAdmin: true, actor: human("admin-1")});
			assert.strictEqual(allowed, true);
		}),
	);

	it.effect("prod, non-admin: NOT authorized — an attacker cookie stays inert", () =>
		Effect.gen(function* () {
			const allowed = yield* authorize("production", {isAdmin: false, actor: human("user-1")});
			assert.strictEqual(allowed, false);
		}),
	);

	it.effect("prod, anonymous: NOT authorized — Admin.over denies the anon arm", () =>
		Effect.gen(function* () {
			const allowed = yield* authorize("production", {isAdmin: true, actor: unauthenticated});
			assert.strictEqual(allowed, false);
		}),
	);
});

const OVERRIDDEN_FLAG = "phoenix-reactions";
const cookieForcing = (value: boolean): string =>
	`${FLAG_OVERRIDE_COOKIE}=${encodeOverrideCookieValue({[OVERRIDDEN_FLAG]: value})}`;

const contextOverrides = (environment: string, overridesAllowed: boolean) =>
	makeRequestFlagsContext({}, cookieForcing(true), overridesAllowed).pipe(
		Effect.map((ctx) => ctx.overrides),
		Effect.provideService(
			ConfigProvider.ConfigProvider,
			ConfigProvider.fromUnknown({ENVIRONMENT: environment}),
		),
	);

describe("makeRequestFlagsContext — the verdict gates cookie parsing (#2741)", () => {
	it.effect("prod, verdict false: the cookie is dropped — no overrides", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* contextOverrides("production", false), undefined);
		}),
	);

	it.effect("prod, verdict true: the cookie is honored — overrides carried", () =>
		Effect.gen(function* () {
			const overrides = yield* contextOverrides("production", true);
			assert.deepStrictEqual(overrides, {[OVERRIDDEN_FLAG]: true});
		}),
	);
});
