/**
 * Run-scoped SHARED integration stage (ADR 0104 step 7, #1027) — the vitest `globalSetup`
 * that deploys the real phoenix `Stack` ONCE per run and `provide`s its handle to forked
 * integration files via `inject` (`_integration.ts`'s `sharedStack()`).
 *
 * This is the deploy-once counterpart to the per-file `integrationStack`: the per-file path
 * stands up ~24 ephemeral stages per run (one `beforeAll(deploy)` each); this stands up ONE
 * and hands every migrated file the same worker URL + D1 coordinates. The two paths share
 * ONE copy of the deploy hardening — `ensureIntegrationEnv` / `runTokenFromEnv` /
 * `deployTransientRetry` / `awaitWorkerReady` / `warmLiveDO` all live in `_integration.ts`
 * and are imported here, never re-implemented.
 *
 * Gated: globalSetup is root-level config, so it runs for ANY invocation of this vitest
 * config — including `test:unit` (`vitest --project unit`), which must deploy nothing. When
 * the `integration` project is filtered out, `vitest.projects` does not contain it (Vitest 4
 * drops a `--project`-excluded project during resolution — `VitestFilteredOutProjectError`),
 * so the gate below returns a no-op teardown without touching Cloudflare.
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Core from "alchemy/Test/Core";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type {TestProject} from "vitest/node";
import Stack from "../../alchemy.run.ts";
import {
	awaitAuthRouteReady,
	awaitWorkerReady,
	deployTransientRetry,
	ensureIntegrationEnv,
	runTokenFromEnv,
	warmLiveDO,
} from "./_integration.ts";
import {sharedStageName} from "./_stage-name.ts";

// The injected-context keys the shared stage provides — typed so `inject(...)` in
// `_integration.ts`'s `sharedStack()` is checked, not `any`. All values are plain
// strings / a POJO, so `provide`'s `structuredClone` serializability check passes.
declare module "vitest" {
	interface ProvidedContext {
		integrationWorkerUrl: string;
		integrationD1: {accountId: string; databaseId: string};
		integrationAuthSecret: string;
	}
}

// Same as the per-file teardown: `afterAll(destroy)` is skipped under NO_DESTROY so a local
// iteration loop keeps the shared deploy alive between runs.
const NO_DESTROY = !!process.env.NO_DESTROY;

const MAKE_OPTIONS: Core.MakeOptions = {
	providers: Cloudflare.providers(),
	state: Cloudflare.state(),
};

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	// GATE (see the file docblock): only deploy when the `integration` project is in this
	// run. `test:unit` runs `vitest --project unit`, which drops `integration` from
	// `vitest.projects` — deploy nothing, return a no-op teardown.
	const integrationSelected = project.vitest.projects.some((p) => p.name === "integration");
	if (!integrationSelected) return async () => {};

	ensureIntegrationEnv();
	const stage = sharedStageName(runTokenFromEnv());

	// Deploy ONCE through `Core.run` — the alchemy test runtime (`toEffect`) that
	// `Test/Vitest.ts` wraps `deploy` with, which provides the full layer stack the per-file
	// `beforeAll(deploy(...))` runs under (AlchemyContext, state). The readiness probes now ride
	// the shared `awaitEdgeReady` over a bare `fetch` (ADR 0127), so they need no `HttpClient`
	// from the runtime. Same hardening the per-file path applies:
	// `deployTransientRetry`, then `awaitWorkerReady` + `warmLiveDO`. No scope: CI is non-dev,
	// so there is no workerd sidecar to keep alive (the scope in `Test/Vitest.ts` exists only
	// for `alchemy dev`).
	//
	// The readiness gate proves BOTH the health route AND the auth-provisioning route are past the
	// CF edge placeholder before `project.provide` releases the URL: edge propagation is per-route,
	// so `/api/health` (`awaitWorkerReady`) can ripen while `/api/auth/sign-up/email`
	// (`awaitAuthRouteReady`) — the route every forked suite hits to provision users — still 404s.
	// Gating on health alone released the URL early and reds all 53 suites with
	// `CloudflarePlaceholder404Error` on a slow auth propagation (#2416); the auth gate pays that
	// wait once, here, so no per-suite `signUp` rides the budget.
	const {url, accountId, databaseId} = await Core.run(
		Core.deploy(MAKE_OPTIONS, Stack, {stage}).pipe(
			deployTransientRetry,
			Effect.flatMap((out) => {
				const resolved = out as {url: string; accountId: string; databaseId: string};
				const cleanUrl = resolved.url.replace(/\/+$/, "");
				if (!cleanUrl) return Effect.die(new Error("shared deploy returned no worker url"));
				if (!resolved.databaseId) {
					return Effect.die(new Error("shared deploy returned no D1 databaseId"));
				}
				return awaitWorkerReady(cleanUrl).pipe(
					Effect.andThen(awaitAuthRouteReady(cleanUrl)),
					Effect.andThen(warmLiveDO(cleanUrl)),
					Effect.as({
						url: cleanUrl,
						accountId: resolved.accountId,
						databaseId: resolved.databaseId,
					}),
				);
			}),
		),
		MAKE_OPTIONS,
	);

	project.provide("integrationWorkerUrl", url);
	project.provide("integrationD1", {accountId, databaseId});
	// `ensureIntegrationEnv()` set this above (idempotent `??=`); a real `.env`/CI secret wins.
	project.provide("integrationAuthSecret", process.env.BETTER_AUTH_SECRET ?? "");

	// Best-effort teardown, ONE destroy per run (mirrors the per-file `afterAll(destroy)`):
	// a CF delete-ordering Conflict / WorkerNotFound is CLEANUP, not an assertion, so catch +
	// log loud (swept by #690) rather than letting it red a green run. See ADR 0104.
	return async () => {
		if (NO_DESTROY) return;
		await Core.run(
			Core.destroy(MAKE_OPTIONS, Stack, {stage}).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning(
						`[integration] best-effort shared-stage teardown failed for stage "${stage}" — stage leaked, sweep via #690 (durable fix #813):\n${Cause.pretty(cause)}`,
					),
				),
			),
			MAKE_OPTIONS,
		);
	};
}
