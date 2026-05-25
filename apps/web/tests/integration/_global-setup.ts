/**
 * Vitest global setup for the integration suite — deploys the phoenix stack to a
 * local workerd once, offline, in the Vitest **main process** (ADR 0026–0031).
 *
 * This runs in the main process (not a pool worker) on purpose: see the header in
 * `_harness.ts` — the alchemy dev sidecar's Node-side LoopbackServer races and
 * hangs inside a Vitest pool worker, but comes up cleanly in the main process (the
 * same context the `alchemy` CLI runs in). The deployed URL is published via
 * `PHOENIX_TEST_URL`; the test files (running in the pool) read it and assert
 * black-box over HTTP. `teardown()` destroys the stack and closes the scope, which
 * stops the workerd sidecar.
 *
 * `dev: true` + `Alchemy.localState()` keep the whole thing offline (no
 * `alchemy login`, no network) — `state` is forced to `localState()` here even
 * under CI, because the test stack is ephemeral and must not touch the shared
 * Cloudflare-hosted store.
 */

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Core from "alchemy/Test/Core";
import {installLocalhostDns} from "alchemy/Util/LocalhostDns";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import Stack from "../../alchemy.run.ts";

installLocalhostDns();

const options = {
	providers: Cloudflare.providers(),
	state: Alchemy.localState(),
	dev: true,
};

// One scope holds the dev sidecar alive across the whole test run; `teardown`
// closes it after `destroy`.
const scope = Scope.makeUnsafe("sequential");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function setup() {
	const out = (await Core.run(
		Core.deploy(options, Stack as never, {scope}) as never,
		options,
		scope,
	)) as {url: string};

	const url = out.url;
	let healthy = false;
	for (let i = 0; i < 120; i++) {
		try {
			const res = await fetch(`${url}/api/health`);
			if (res.status === 200) {
				healthy = true;
				break;
			}
		} catch {
			// connection refused while the workerd sidecar warms — retry
		}
		await sleep(500);
	}
	if (!healthy) throw new Error(`worker never became reachable at ${url}`);

	process.env.PHOENIX_TEST_URL = url;
	console.log(`[integration] worker deployed at ${url}`);
}

export async function teardown() {
	await Core.run(Core.destroy(options, Stack as never, {scope}) as never, options, scope).catch(
		() => {},
	);
	await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {});
}
