// @patch-pin: alchemy@2.0.0-beta.59
/**
 * Regression pin for the alchemy `Test.make` hook-timeout patch (#3168, ADR 0038).
 *
 * Unpatched, alchemy's `Test.make` hook registrars pass `timeoutOf(opts) ?? 120_000`
 * as the explicit second arg to vitest's `beforeAll`/`afterAll`. `@vitest/runner`
 * honors that arg verbatim (`beforeAll(fn, timeout = getDefaultHookTimeout())`), so an
 * un-annotated hook is silently clamped to 120s and the project's `config.hookTimeout`
 * never applies — the #3146 merge-queue eviction root cause. The patch drops the
 * `?? DEFAULT_TIMEOUT` fallback so an un-annotated hook passes `undefined`, which lets
 * the runner's default parameter resolve `config.hookTimeout` instead.
 *
 * The pin reads the timeout `@vitest/runner` actually resolved for a registered hook,
 * which it stores on the hook fn under the `VITEST_CLEANUP_TIMEOUT` symbol. It
 * self-calibrates against a plain vitest `beforeAll` (whose resolved timeout IS
 * `config.hookTimeout`), so it holds at whatever this project's hook timeout is rather
 * than a hard-coded number: an un-annotated `Test.make` hook must resolve to the same
 * default a plain hook does, and specifically must NOT be the 120000 clamp — while an
 * explicit `{timeout}` override still threads through unchanged.
 */
import * as Test from "alchemy/Test/Vitest";
import {Effect, Layer} from "effect";
import {describe, expect, it, beforeAll as vitestBeforeAll} from "vitest";
import {getCurrentSuite, getHooks} from "vitest/suite";

// `@vitest/runner` stashes each hook's resolved timeout on the registered hook fn under
// this symbol (see `beforeAll` in @vitest/runner's chunk-artifact). Read it back to see
// exactly what timeout the runner resolved — the observable the clamp lives in.
const resolvedTimeoutOfLastBeforeAll = (): number | undefined => {
	const suite = getCurrentSuite().suite;
	if (suite === undefined) return undefined;
	const hooks = getHooks(suite).beforeAll as ReadonlyArray<object>;
	const last = hooks[hooks.length - 1];
	if (last === undefined) return undefined;
	const sym = Object.getOwnPropertySymbols(last).find(
		(s) => s.description === "VITEST_CLEANUP_TIMEOUT",
	);
	const value = sym === undefined ? undefined : (last as Record<symbol, unknown>)[sym];
	return typeof value === "number" ? value : undefined;
};

const CLAMP = 120_000;

// Hooks are registered at collection time (outside any `it`), then asserted inside the
// tests below. `Test.make({providers: Layer.empty})` needs no cloud wiring here — the
// registrar closures are captured, not run for their effect, so this stays offline.
describe("alchemy Test.make honors config.hookTimeout (patch pin, #3168)", () => {
	// A plain vitest hook with no explicit timeout resolves to config.hookTimeout — the
	// calibration baseline an un-annotated Test.make hook must match.
	vitestBeforeAll(() => {});
	const configDefault = resolvedTimeoutOfLastBeforeAll();

	const api = Test.make({providers: Layer.empty});
	// `beforeAll` returns an accessor Effect we register only for its side effect (the
	// vitest hook it installs); `void` it, matching `_integration.ts`'s `void stack`.
	const unannotatedHook = api.beforeAll(Effect.void);
	const unannotated = resolvedTimeoutOfLastBeforeAll();
	void unannotatedHook;

	const overriddenHook = api.beforeAll(Effect.void, {timeout: 300_000});
	const overridden = resolvedTimeoutOfLastBeforeAll();
	void overriddenHook;

	it("resolves an un-annotated hook to config.hookTimeout, not the 120s clamp", () => {
		expect(typeof configDefault).toBe("number");
		expect(configDefault).not.toBe(CLAMP);
		expect(unannotated).toBe(configDefault);
		expect(unannotated).not.toBe(CLAMP);
	});

	it("threads an explicit {timeout} override (>120s) through unchanged", () => {
		expect(overridden).toBe(300_000);
	});
});
