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
import type {CompiledStack} from "alchemy/Stack";
import * as Core from "alchemy/Test/Core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import Stack from "../../alchemy.run.ts";
import {installLocalhostDns} from "./_localhost-dns.ts";

installLocalhostDns();

// `Cloudflare.providers()` validates `CLOUDFLARE_ACCOUNT_ID` (+ token) from the
// environment at CONSTRUCTION time, even though the test deploy runs the worker in
// a local workerd (`dev: true`) with file-based `localState()` and never calls the
// Cloudflare API (the stack forces local state under Vitest — see alchemy.run.ts).
// On a dev machine these resolve from a wrangler/alchemy profile; on a clean CI
// runner there is none, so it throws `AuthError: Missing required env`. The values
// are inert in dev — inject placeholders when absent so the suite is genuinely
// self-contained (no `alchemy login`, no profile, no secrets, no network).
process.env.CLOUDFLARE_ACCOUNT_ID ??= "local-dev-account";
process.env.CLOUDFLARE_API_TOKEN ??= "local-dev-token";

// The worker's `env:` block binds `BETTER_AUTH_SECRET` from a required
// `Config.redacted` (`worker/config.ts`); the deploy resolves it from this env.
// Inject a deterministic dev secret so the integration deploy is self-contained
// and better-auth can sign sessions in the local workerd. An `insecure_`-prefixed
// 32-byte hex value (not a short word-string) so better-auth's startup
// length/entropy checks stay quiet on CI runs with no `.env` — matching `.env`.
process.env.BETTER_AUTH_SECRET ??=
	"insecure_cb11c15edab29ce190c28e1cf4c2d8e27c6918e99bdb3b280c7af98e1e542bb6";

// Run the deployed test worker in dev mode so better-auth permits the suite's
// server-side (browser-less, no `Origin` header) sign-ups. In prod mode
// better-auth omits `baseURL`/`trustedOrigins` and infers the origin from the
// request Host, which 403s `INVALID_ORIGIN` for the harness's same-process
// `fetch`. The integration suite validates application logic, not the prod
// deploy's origin policy; dev mode matches the local `pnpm dev:worker` loop the
// suite stands in for.
process.env.ENVIRONMENT ??= "development";

const options = {
	providers: Cloudflare.providers(),
	state: Alchemy.localState(),
	dev: true,
} satisfies Core.MakeOptions;

// One scope holds the dev sidecar alive across the whole test run; `teardown`
// closes it after `destroy`.
const scope = Scope.makeUnsafe("sequential");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The Stack's compiled output type (`{url: Output<string>}`) — what `Core.deploy`
// resolves and `Core.run` awaits. `Core.deploy` infers this `A` from the Stack
// effect and returns `Input.Resolve<A>` (the Output<string> resolved to a plain
// string), which `Core.run` then awaits. Pinning `A` explicitly keeps the link to
// the Stack's declared output: if the stack stops returning `{url}`, `deploy` no
// longer accepts the Stack and this stops compiling rather than breaking at
// runtime on `out.url`.
type StackOutput =
	typeof Stack extends Effect.Effect<CompiledStack<infer A>, infer _E, infer _R> ? A : never;

// Thin typed wrapper over `Core.deploy` → `Core.run` that threads `StackOutput`
// end-to-end. The base `StackEffect` requirements the stack carries are a subset
// of what `deploy` accepts, so no cast is needed once `A` is pinned; `run` then
// awaits `deploy`'s resolved output type.
const deployStack = (): Promise<Alchemy.Input.Resolve<StackOutput>> =>
	Core.run(Core.deploy<StackOutput>(options, Stack, {scope}), options, scope);

export async function setup() {
	const out = await deployStack();

	// The alchemy dev sidecar publishes the worker URL WITH a trailing slash
	// (`http://localhost:<port>/`). The probe + every harness request append a
	// leading-slash path onto it (`${url}/api/health`, `${url()}${path}`), so a
	// raw concatenation yields a double slash (`//api/health`). The workerd proxy
	// parses a path starting with `//` as a protocol-relative URL — `api` becomes
	// the HOST — and fails the outbound DNS lookup (`params.host = api`), 502-ing
	// every request before it ever reaches the worker. Strip the trailing slash
	// once here, at the single canonical publish point, so all callers concatenate
	// cleanly.
	if (!out.url) throw new Error("deploy returned no worker url");
	const url = out.url.replace(/\/+$/, "");
	let healthy = false;
	for (let i = 0; i < 120; i++) {
		try {
			// Per-attempt timeout: the deploy returns the WorkerProxy URL before workerd
			// is serving, and the proxy parks the request on a promise with no timeout of
			// its own (alchemy fork — deeper fix tracked in #115). Without this signal a
			// single parked poll hangs forever instead of advancing the loop, which is the
			// multi-hour silent stall this suite has hit. AbortSignal.timeout turns a slow
			// attempt into a bounded, retryable failure — it throws into the catch below.
			const res = await fetch(`${url}/api/health`, {signal: AbortSignal.timeout(2500)});
			if (res.status === 200) {
				healthy = true;
				break;
			}
		} catch {
			// connection refused while the sidecar warms, or this attempt timed out — retry
		}
		await sleep(500);
	}
	if (!healthy) throw new Error(`worker never became reachable at ${url}`);

	process.env.PHOENIX_TEST_URL = url;
	console.log(`[integration] worker deployed at ${url}`);
}

export async function teardown() {
	// Log (don't swallow) teardown failures: a failed `destroy` or scope-close can
	// leave a workerd sidecar running, which wedges a CI runner. We still resolve so
	// teardown completes without throwing / raising an unhandled rejection, but the
	// failure is now visible in the run output instead of vanishing.
	await Core.run(Core.destroy(options, Stack, {scope}), options, scope).catch((err) => {
		console.error("[integration] teardown: Core.destroy failed (workerd sidecar may leak)", err);
	});
	await Effect.runPromise(Scope.close(scope, Exit.void)).catch((err) => {
		console.error("[integration] teardown: Scope.close failed (workerd sidecar may leak)", err);
	});
}
