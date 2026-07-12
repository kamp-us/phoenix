/**
 * `overridesAuthorized` — the per-request gate that un-gates the #622 local-override
 * read-wrapper to production for an admin (#2741, epic #2711). Proven here with NO
 * binding / NO I/O: `Flags` over a stub `Flagship` (real eval returns the supplied
 * default, so the only ON signal for `phoenix-admin-console` is this stub flipping it),
 * a `CurrentActor` stub, and a `RelationStore` stub whose `has` fixes the
 * `(actor, "admin", platform)` verdict `Admin.over` reads.
 *
 * The truth table the load-bearing prod fail-closed invariant rests on:
 *   - `development` — always authorized (the #622 dev convenience, unchanged).
 *   - prod, admin + flag ON  — authorized (the new admin-on-prod path).
 *   - prod, non-admin        — NOT authorized (an attacker cookie stays inert).
 *   - prod, admin + flag OFF — NOT authorized (dark-ship default holds).
 *   - prod, anonymous        — NOT authorized (`Admin.over` denies the anon arm).
 *
 * The second block proves the verdict is consumed: `makeRequestFlagsContext` populates
 * `overrides` from the cookie ONLY when the verdict is `true` — so on prod a non-admin's
 * `phoenix_flag_overrides` cookie yields no overrides at all.
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
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import {PHOENIX_ADMIN_CONSOLE} from "../../../src/flags/keys.ts";
import {encodeOverrideCookieValue, FLAG_OVERRIDE_COOKIE} from "./dev-override.ts";
import {FlagsLive} from "./Flags.ts";
import {makeRequestFlagsContext} from "./FlagsContext.ts";
import {Flagship} from "./Flagship.ts";
import {overridesAuthorized} from "./override-authz.ts";

const runtimeContext: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};
const RuntimeContextStub = Layer.succeed(RuntimeContext)(runtimeContext);

const unexercised = (method: string) => () =>
	Effect.die(`Flagship.${method} not exercised in override-authz.unit.test`);

// Real eval returns the supplied default for every key EXCEPT `phoenix-admin-console`,
// which reads `adminConsoleOn` — so an ON verdict can only come from the stub flip.
const flagshipWith = (adminConsoleOn: boolean): Layer.Layer<Flagship> =>
	Layer.succeed(Flagship)(
		Flagship.of({
			raw: Effect.die("Flagship.raw not exercised"),
			get: unexercised("get"),
			getBooleanValue: (key, defaultValue) =>
				Effect.succeed(key === PHOENIX_ADMIN_CONSOLE ? adminConsoleOn : defaultValue),
			getStringValue: unexercised("getStringValue"),
			getNumberValue: unexercised("getNumberValue"),
			getObjectValue: unexercised("getObjectValue"),
			getBooleanDetails: unexercised("getBooleanDetails"),
			getStringDetails: unexercised("getStringDetails"),
			getNumberDetails: unexercised("getNumberDetails"),
			getObjectDetails: unexercised("getObjectDetails"),
		}),
	);

// `Admin.over` reads the `(actor, "admin", platform)` tuple through `RelationStore.has`.
const relationStoreWith = (isAdmin: boolean): Layer.Layer<RelationStore> =>
	Layer.succeed(RelationStore, {has: () => Effect.succeed(isAdmin)} as never);

const authorize = (
	environment: string,
	opts: {adminConsoleOn: boolean; isAdmin: boolean; actor: Actor},
) =>
	overridesAuthorized({environment}).pipe(
		Effect.provide(
			Layer.mergeAll(
				FlagsLive.pipe(Layer.provide(flagshipWith(opts.adminConsoleOn))),
				Layer.succeed(CurrentActor, {actor: opts.actor}),
				Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(true)}),
				relationStoreWith(opts.isAdmin),
				RuntimeContextStub,
			),
		),
	);

describe("overridesAuthorized — may this request honor its per-browser cookie (#2741)", () => {
	it.effect("development: always authorized (the #622 dev convenience)", () =>
		Effect.gen(function* () {
			const allowed = yield* authorize("development", {
				adminConsoleOn: false,
				isAdmin: false,
				actor: unauthenticated,
			});
			assert.strictEqual(allowed, true);
		}),
	);

	it.effect("prod, admin + flag ON: authorized (admin-on-prod)", () =>
		Effect.gen(function* () {
			const allowed = yield* authorize("production", {
				adminConsoleOn: true,
				isAdmin: true,
				actor: human("admin-1"),
			});
			assert.strictEqual(allowed, true);
		}),
	);

	it.effect("prod, non-admin (flag ON): NOT authorized — an attacker cookie stays inert", () =>
		Effect.gen(function* () {
			const allowed = yield* authorize("production", {
				adminConsoleOn: true,
				isAdmin: false,
				actor: human("user-1"),
			});
			assert.strictEqual(allowed, false);
		}),
	);

	it.effect("prod, admin + flag OFF: NOT authorized — the dark-ship default holds", () =>
		Effect.gen(function* () {
			const allowed = yield* authorize("production", {
				adminConsoleOn: false,
				isAdmin: true,
				actor: human("admin-1"),
			});
			assert.strictEqual(allowed, false);
		}),
	);

	it.effect("prod, anonymous (flag ON): NOT authorized — Admin.over denies the anon arm", () =>
		Effect.gen(function* () {
			const allowed = yield* authorize("production", {
				adminConsoleOn: true,
				isAdmin: true,
				actor: unauthenticated,
			});
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
