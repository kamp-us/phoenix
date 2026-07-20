/**
 * AC2 parity (#2984, ADR 0179): the shell flags injected into `window.__BOOT__` resolve to the
 * EXACT same values as `/api/flags/evaluate` across the #2741 override-authz path. Both consume
 * the one {@link resolveRequestFlagsContext} seam, so an authorized admin's `phoenix_flag_overrides`
 * cookie is honored identically on the API and in `__BOOT__`, and an unauthorized cookie is inert
 * identically. This is the regression guard for the divergence the review caught: the `__BOOT__`
 * path called `makeRequestFlagsContext` with 2 args (override-authz off) while the API passed the
 * 3-arg verdict — a prod admin got baseline values in `__BOOT__` but overridden values from the API.
 *
 * Proven with NO binding / NO I/O: `Flags` is the unconditional override wrapper
 * (`FlagsDevOverrideLive`, wired for every stage since #2741) over a stub `Flagship`, plus the same
 * `CurrentActor` (derived from the session) / `RelationStore` / `AgentAuthority` stubs
 * `override-authz.unit.test` uses. The two reads compared are the actual seams: the API's per-key
 * `flags.getBoolean` and the shell's {@link readShellFlags}, both over the ONE resolved context.
 */
import {assert, describe, it} from "@effect/vitest";
import {AgentAuthority, RelationStore} from "@kampus/authz";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import {SHELL_FLAG_KEYS} from "../../../src/flags/shell-keys.ts";
import {encodeOverrideCookieValue, FLAG_OVERRIDE_COOKIE} from "./dev-override.ts";
import {Flags, FlagsDevOverrideLive} from "./Flags.ts";
import {FlagsContext} from "./FlagsContext.ts";
import {Flagship} from "./Flagship.ts";
import {type FlagsSession, resolveRequestFlagsContext} from "./request-flags-context.ts";
import {readShellFlags} from "./shell-boot-route.ts";

const runtimeContext: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const unexercised = (method: string) => () =>
	Effect.die(`Flagship.${method} not exercised in shell-boot-parity.unit.test`);

// Real eval returns the supplied default for every key — shell keys read their default
// (false), so the override wrapper is the only thing that can flip a shell key when authorized.
const flagshipStub: Layer.Layer<Flagship> = Layer.succeed(Flagship)(
	Flagship.of({
		raw: Effect.die("Flagship.raw not exercised"),
		get: unexercised("get"),
		getBooleanValue: (_key, defaultValue) => Effect.succeed(defaultValue),
		getStringValue: unexercised("getStringValue"),
		getNumberValue: unexercised("getNumberValue"),
		getObjectValue: unexercised("getObjectValue"),
		getBooleanDetails: unexercised("getBooleanDetails"),
		getStringDetails: unexercised("getStringDetails"),
		getNumberDetails: unexercised("getNumberDetails"),
		getObjectDetails: unexercised("getObjectDetails"),
	}),
);

const harness = (opts: {isAdmin: boolean}) =>
	Layer.mergeAll(
		// The unconditional override wrapper (prod-installed since #2741) over the stub, so an
		// authorized request's `overrides` short-circuit is exercised without a binding.
		FlagsDevOverrideLive.pipe(Layer.provide(flagshipStub)),
		Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(true)}),
		Layer.succeed(RelationStore, {has: () => Effect.succeed(opts.isAdmin)} as never),
		Layer.succeed(RuntimeContext)(runtimeContext),
	);

// The one shell key the override cookie flips on; baseline eval returns false for it.
const SHELL_KEY = SHELL_FLAG_KEYS[0];
const overrideCookie = `${FLAG_OVERRIDE_COOKIE}=${encodeOverrideCookieValue({[SHELL_KEY]: true})}`;

/**
 * Resolve the shared context under the harness, then read `SHELL_KEY` the TWO ways production
 * does: the API's per-key `flags.getBoolean` (`handleFlagsEvaluate`) and the shell's
 * `readShellFlags` (`handleShellBoot`). Both flow through `resolveRequestFlagsContext`.
 */
const parity = (session: FlagsSession, cookie: string, opts: {isAdmin: boolean}) =>
	Effect.gen(function* () {
		const context = yield* resolveRequestFlagsContext(session, cookie);
		const flags = yield* Flags;
		const evaluateValue = yield* flags
			.getBoolean(SHELL_KEY, false)
			.pipe(Effect.provideService(FlagsContext, context));
		const bootFlags = yield* readShellFlags(context);
		return {evaluateValue, bootValue: bootFlags[SHELL_KEY]};
	}).pipe(
		Effect.provide(harness(opts)),
		Effect.provideService(
			ConfigProvider.ConfigProvider,
			// Prod stage: overrides are honored ONLY via the admin path (#2741), never the dev gate.
			ConfigProvider.fromUnknown({ENVIRONMENT: "production"}),
		),
	);

const adminSession: FlagsSession = {user: {id: "admin-1", email: "admin@kamp.us", name: "admin"}};
const userSession: FlagsSession = {user: {id: "user-1", email: "user@kamp.us", name: "user"}};

describe("shell __BOOT__ flag resolution has parity with /api/flags/evaluate (#2984 AC2)", () => {
	it.effect(
		"authorized admin + override cookie: __BOOT__ value == evaluate value == overridden (true)",
		() =>
			Effect.gen(function* () {
				const {evaluateValue, bootValue} = yield* parity(adminSession, overrideCookie, {
					isAdmin: true,
				});
				assert.strictEqual(bootValue, evaluateValue);
				assert.strictEqual(bootValue, true);
			}),
	);

	it.effect(
		"baseline non-admin + same cookie: __BOOT__ value == evaluate value == baseline (false, cookie inert)",
		() =>
			Effect.gen(function* () {
				const {evaluateValue, bootValue} = yield* parity(userSession, overrideCookie, {
					isAdmin: false,
				});
				assert.strictEqual(bootValue, evaluateValue);
				assert.strictEqual(bootValue, false);
			}),
	);
});
