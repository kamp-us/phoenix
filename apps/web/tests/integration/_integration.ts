/**
 * Per-file integration lifecycle — the alchemy `Test.make` substrate (ADR 0082).
 *
 * Each integration test file calls `integrationStack(import.meta.url)` once at
 * module top level. It stands up a per-file `Test.make`, deploys the real phoenix
 * `Stack` to **real remote Cloudflare** under an **isolated stage** derived from the
 * file name, retries the first request through edge propagation, and returns the
 * black-box `harness` (`_harness.ts`) bound to that stage's worker URL. The deploy
 * runs in a `beforeAll(deploy(Stack, {stage}))`; teardown is
 * `afterAll.skipIf(NO_DESTROY)(destroy(Stack, {stage}))`.
 *
 * Per-file isolated stages are the whole point: each file owns its own worker + D1
 * (real, remote), freshly migrated by the existing
 * `D1Database({migrationsTable: "drizzle_migrations"})` resource the deploy applies
 * — one migration path. Files no longer share one long-lived deploy, so they run in
 * parallel instead of the forced single fork that raced itself (#547 / #220 / #560,
 * one root cause). D1 binds remote in `Test.make` (alchemy never emulates D1 — ADR
 * 0032/0082); real creds (`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` /
 * `ALCHEMY_PASSWORD`) come from the environment (CI secrets; a wrangler/alchemy
 * profile locally).
 *
 * `BETTER_AUTH_SECRET` (a required `Config.redacted`, `worker/config.ts`) and
 * `ENVIRONMENT` are self-supplied below when absent — orthogonal to the harness
 * swap, retained from the prior model so the suite stays self-contained on a clean
 * runner.
 */

import type {Input} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type {CompiledStack} from "alchemy/Stack";
import * as Test from "alchemy/Test/Vitest";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {inject} from "vitest";
import Stack from "../../alchemy.run.ts";
import {type Harness, harness} from "./_harness.ts";
import {slugify, stageName} from "./_stage-name.ts";

// Re-export the readiness + deploy hardening the run-scoped shared-stage globalSetup
// reuses (ADR 0104 step 7, #1027), so the two deploy paths share ONE copy of each
// (`deployTransientRetry`, `awaitWorkerReady`, `warmLiveDO`, `ensureIntegrationEnv`,
// `runTokenFromEnv`) rather than forking the logic. The shared-stage path lives in
// `_global-setup.ts`; this file's per-file path (`integrationStack`) consumes the same
// helpers below. The harness client itself (`sharedStack`) is exported at the end.

// Tagged so the retry sentinel stays out of the untagged-error failure channel
// (effect `globalErrorInEffectFailure`): the fresh route 404s until it propagates.
class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{readonly status: number}> {}

// Retry sentinel for the DO-backed `/fate/live` warmup below. Two "not ready" signals
// land on it, both retryable on the same bounded schedule:
//   - 503 `LIVE_UNAVAILABLE`: the `/api/health` probe proves the WORKER route propagated,
//     but never touches the `LiveDO` — so a cold LiveDO still surfaces the bounded
//     cold-start envelope (`fate-live/cold-start-retry.ts`) on the first connect/subscribe.
//   - the Cloudflare-placeholder 404: the preview-stage EDGE route hasn't propagated yet,
//     so `/fate/live` returns CF's HTML 404 page, NOT the worker's response (#1055). The
//     worker's `/fate/live` matches `*` and only ever answers SSE (200) or a JSON
//     `liveError` envelope — never an HTML 404 — so an HTML-bodied 404 is unambiguously the
//     un-propagated edge, distinct from a legitimate worker 404/auth (JSON), which stops.
// Tagged distinctly from `WorkerNotReady` so the two readiness gates retry on their own signals.
class LiveDONotReady extends Data.TaggedError("LiveDONotReady")<{readonly status: number}> {}

// A non-200 `/fate/live` response that is NOT one of the two retryable "not ready" signals
// above — e.g. a legitimate worker 404/auth (JSON), a 500. Tagged distinctly so the warmup's
// bounded retry only re-polls `LiveDONotReady`; an unexpected response stops immediately
// (swallowed non-fatally by `catchCause`) rather than burning the full deadline on something
// that will never warm.
class LiveDOUnexpected extends Data.TaggedError("LiveDOUnexpected")<{readonly status: number}> {}

/**
 * Self-supply the two env values the integration deploy needs when a clean runner has no
 * `.env` — idempotent (`??=`), so a real `.env`/CI secret always wins. Both deploy paths
 * (this file's `integrationStack` and the shared-stage `_global-setup.ts`) call this, so
 * the values live in ONE place.
 *
 *   - `BETTER_AUTH_SECRET`: the worker's `env:` block binds it from a required
 *     `Config.redacted` (`worker/config.ts`); the deploy resolves it from this env. An
 *     `insecure_`-prefixed 32-byte hex value (not a short word-string) keeps better-auth's
 *     startup length/entropy checks quiet — matching `.env.example`.
 *   - `ENVIRONMENT=development`: runs the deployed worker in dev mode so better-auth permits
 *     the suite's server-side (browser-less, no `Origin` header) sign-ups; in prod mode
 *     better-auth infers the origin from the request Host and 403s `INVALID_ORIGIN` for the
 *     harness's `fetch`. The integration suite validates application logic, not the prod
 *     deploy's origin policy.
 */
export const ensureIntegrationEnv = (): void => {
	process.env.BETTER_AUTH_SECRET ??=
		"insecure_cb11c15edab29ce190c28e1cf4c2d8e27c6918e99bdb3b280c7af98e1e542bb6";
	process.env.ENVIRONMENT ??= "development";
};

ensureIntegrationEnv();

// The Stack's compiled output type (`{url, databaseId, accountId}` as `Output<…>`) —
// what `deploy` resolves. Pinning `A` explicitly keeps the link to the Stack's declared
// output: if the stack stops returning these fields, `deploy` no longer accepts the
// Stack and this stops compiling rather than breaking at runtime on `out.databaseId`.
type StackOutput =
	typeof Stack extends Effect.Effect<CompiledStack<infer A>, infer _E, infer _R> ? A : never;

// `afterAll(destroy(...))` is skipped when `NO_DESTROY` is set, so a local iteration
// loop can keep the per-file deploy alive between runs (matching the alchemy idiom).
const NO_DESTROY = !!process.env.NO_DESTROY;

// Per-PROCESS token for local default (destroy-on) runs: stable for one vitest
// process, distinct across concurrent local processes. The stage is destroyed in
// afterAll, so this name never outlives the run — pid + hrtime base36, not
// Date.now()/Math.random() (the stage is single-use; this is deterministic-enough, short).
const LOCAL_TOKEN = `${process.pid.toString(36)}${process.hrtime.bigint().toString(36)}`.replace(
	/[^a-z0-9]/g,
	"",
);

/**
 * The run-unique token both stage-naming paths discriminate on: CI's
 * `<run-id>-<run-attempt>` (so a rerun gets a distinct stage; two PRs' overlapping CI never
 * collide), else the per-process `LOCAL_TOKEN`. The per-file `stageFor` folds it into
 * `<slug>|<runToken>`; the shared-stage `sharedStageName` into `shared|<runToken>` — one
 * source for the run dimension.
 */
export const runTokenFromEnv = (): string =>
	process.env.GITHUB_RUN_ID
		? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
		: LOCAL_TOKEN;

/**
 * A run-unique per-file stage name. Real remote D1 + workers are keyed by stage against
 * ONE shared Cloudflare account, so two CI runs (different PRs, or a rerun) executing the
 * integration job concurrently must never collide — the file basename alone repeats across
 * runs, deploying the SAME stage names → `DatabaseAlreadyExists` (the dominant integration
 * flake, #689).
 *
 *   - Local + `NO_DESTROY`: stable `it-<slug>` — NO_DESTROY keeps a file's deploy alive
 *     between local runs to re-adopt it, which REQUIRES a stable name.
 *   - Otherwise: `it-<readable>-<disc>`. `<disc>` is a fixed-width hash of
 *     `<slug>|<runToken>` — it alone guarantees uniqueness across BOTH files (slug) and
 *     runs (runToken: CI's `<run-id>-<run-attempt>`, so a rerun gets a distinct stage; else
 *     a per-process LOCAL_TOKEN). `<readable>` is a slug prefix kept only as a human-debug
 *     aid (a CF-dashboard stage traces to its file).
 *
 * Sanitized to the `[a-z0-9-]` Cloudflare resource-name set, no leading/trailing dash, no
 * internal `--`, non-empty — the pure `stageName`/`slugify` of `_stage-name.ts` enforce
 * this for every input (unit-pinned in `_stage-name.unit.test.ts`). The harness reads the
 * deployed D1's uuid off the compiled Stack output, so the stage no longer needs the #689
 * `MAX_STAGE_LEN` length bound (#692).
 */
const stageFor = (metaUrl: string): string => {
	const base = (metaUrl.split("/").pop() ?? "integration").replace(/\.test\.ts$/, "");
	const slug = slugify(base);
	return stageName(slug, NO_DESTROY, runTokenFromEnv());
};

/**
 * Warm the DO-backed `/fate/live` path so the suite's first asserting subscribe
 * doesn't draw the cold-start 503.
 *
 * `/api/health` proving green warms only the WORKER route — it never reaches the
 * `LiveDO`. Cloudflare instantiates a DO lazily, so the freshly-deployed stage's
 * first `/fate/live` connect/subscribe hits a cold `connection:`/`topic:` DO; the
 * worker seam's bounded cold-start retry (`fate-live/cold-start-retry.ts`, #842) can
 * exhaust on that first hit and render the 503 `LIVE_UNAVAILABLE` envelope. We force
 * that warm here, behind the same bounded `spaced` retry as the health probe: sign up
 * a throwaway session (the route 401s without one, before the DO is touched), then
 * GET-open `/fate/live` and retry while it 503s (cold DO) OR returns the Cloudflare
 * HTML-placeholder 404 (edge route not yet propagated, #1055) — so the cold-start cost
 * AND the edge-propagation lag are paid by the gate, not by `fate-live.test.ts`'s first
 * subscribe (#1018, #1058).
 */
export const warmLiveDO = (url: string): Effect.Effect<void, never, never> =>
	Effect.tryPromise(async () => {
		const signUp = await fetch(`${url}/api/auth/sign-up/email`, {
			method: "POST",
			headers: {"content-type": "application/json", origin: "http://localhost:3000"},
			body: JSON.stringify({
				email: `live-warmup-${LOCAL_TOKEN}@warmup.local`,
				password: "warmup-warmup-warmup",
				name: "warmup",
			}),
		});
		// A `NO_DESTROY` re-run reuses the stage's D1, so a warmup user from a prior run
		// makes sign-up 422 USER_ALREADY_EXISTS — fall back to sign-in for the cookie.
		const authed =
			signUp.status === 422
				? await fetch(`${url}/api/auth/sign-in/email`, {
						method: "POST",
						headers: {"content-type": "application/json", origin: "http://localhost:3000"},
						body: JSON.stringify({
							email: `live-warmup-${LOCAL_TOKEN}@warmup.local`,
							password: "warmup-warmup-warmup",
						}),
					})
				: signUp;
		const setCookie = authed.headers.get("set-cookie");
		if (!authed.ok || !setCookie) {
			throw new Error(`live warmup auth failed: ${authed.status} ${await authed.text()}`);
		}
		const cookie = setCookie
			.split(/,(?=[^;]+=)/)
			.map((part) => part.split(";")[0]!.trim())
			.filter((kv) => kv.includes("="))
			.join("; ");
		return cookie;
	}).pipe(
		Effect.flatMap((cookie) =>
			Effect.tryPromise(() =>
				fetch(`${url}/fate/live?connectionId=live-warmup-${LOCAL_TOKEN}`, {
					headers: {accept: "text/event-stream", cookie},
				}),
			).pipe(
				// Always release the response body (the held SSE stream on a 200, the error
				// envelope body on a 503) before deciding — a leaked stream keeps the fetch
				// connection open across the retry loop.
				Effect.tap((res) =>
					Effect.promise(() => res.body?.cancel().catch(() => {}) ?? Promise.resolve()),
				),
				Effect.flatMap((res) => {
					// 200 means the LiveDO warmed. Otherwise retry only the two "not ready"
					// signals (`LiveDONotReady`): a 503 cold-DO envelope, OR a Cloudflare
					// HTML-placeholder 404 (edge route not yet propagated, #1055). The worker's
					// `/fate/live` answers only SSE (200) or a JSON `liveError` — never HTML — so a
					// non-JSON 404 is unambiguously the un-propagated edge. Any OTHER non-200 (a
					// real JSON 404/auth, a 500) is `LiveDOUnexpected`: outside the retry's `while`,
					// so the loop stops at once instead of burning the deadline on a real response.
					if (res.status === 200) return Effect.void;
					const contentType = res.headers.get("content-type") ?? "";
					const isPlaceholder404 = res.status === 404 && !contentType.includes("application/json");
					return res.status === 503 || isPlaceholder404
						? Effect.fail(new LiveDONotReady({status: res.status}))
						: Effect.fail(new LiveDOUnexpected({status: res.status}));
				}),
				Effect.retry({
					while: (error) => error._tag === "LiveDONotReady",
					schedule: Schedule.spaced("2 seconds").pipe(Schedule.both(Schedule.recurs(30))),
				}),
			),
		),
		// Warmup is a readiness OPTIMIZATION, not an assertion: if it can't establish a
		// cookie or never warms within the bound, the suite still runs (the worker seam's
		// own retry is the real fix; this just front-loads the cold cost). Swallow so a
		// warmup hiccup can't red a green stage — the asserting tests remain the gate.
		Effect.catchCause((cause) =>
			Effect.logWarning(
				`[integration] /fate/live warmup did not settle (non-fatal):\n${Cause.pretty(cause)}`,
			),
		),
	);

// The eventually-consistent CF signatures the stage deploy can transiently draw under
// cross-PR load on the shared account — registry lag right after `putScript`. Grounded in
// the `@distilled.cloud/cloudflare` error decode (`src/services/workers.ts`): `WorkerNotFound`
// = code 10007, `InternalServerError` = 15000, `UnknownCloudflareError` = 10013 — the same tags
// alchemy-effect's own create path retries piecewise (`Cloudflare/Workers/Worker.ts`), here
// applied to the deploy as a whole. ONLY these transient tags retry; a real deploy error (bad
// config, auth, a 10068 invalid-script) carries a different tag and still fails fast.
const DEPLOY_TRANSIENT_TAGS = new Set([
	"WorkerNotFound",
	"InternalServerError",
	"UnknownCloudflareError",
]);

// One more eventually-consistent signature, decoded NOT to a code-specific tag but to the
// bare HTTP-404 fallback `NotFound` (`@distilled.cloud/core/errors`, via `HTTP_STATUS_MAP[404]`):
// "This Worker has no versions, which means this Worker has no content or versioned settings."
// — the deploy reads the freshly-`putScript`ed worker before its version propagates through the
// registry (an original #1010 flake signature). Matched on the MESSAGE, not the bare `NotFound`
// _tag: a blanket 404 retry would mask a genuinely-missing resource, which must still fail fast.
// This precise substring is the version-propagation race alone.
const NO_VERSIONS_MESSAGE = "no versions";

const isTransientDeployError = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
	const {_tag: tag, message} = error as {_tag: unknown; message?: unknown};
	if (typeof tag === "string" && DEPLOY_TRANSIENT_TAGS.has(tag)) return true;
	return tag === "NotFound" && typeof message === "string" && message.includes(NO_VERSIONS_MESSAGE);
};

/**
 * Wrap the stage `deploy` so a TRANSIENT CF deploy error self-heals. The ~24 ephemeral
 * stages per run hit ONE eventually-consistent CF account; #1015's per-run fork cap bounds
 * WITHIN-run concurrency, but two PRs' CI overlapping still produces registry lag — a
 * `WorkerNotFound (10007)` mid-deploy fails an otherwise-green suite (#1019). alchemy deploys
 * are convergent: re-running `deploy(Stack, {stage})` reconciles the SAME stage's state
 * (idempotent), so the retry resolves the lag without standing up a duplicate stage or
 * compounding the #1020/#690 teardown leak. Bounded — a persistent error still fails fast.
 */
export const deployTransientRetry = Effect.retry({
	while: isTransientDeployError,
	schedule: Schedule.exponential("1 second").pipe(Schedule.both(Schedule.recurs(5))),
});

/**
 * Probe a freshly-deployed worker's `/api/health` until it serves `{status:"ok"}` — a fresh
 * workers.dev route 404s for a few seconds while it propagates, so retry every non-ready
 * outcome (`WorkerNotReady` AND any request-transport `HttpClientError`, e.g. an edge reset)
 * on a bounded `spaced` schedule. A worker that never serves healthy JSON within the bound
 * (30 × 2s) dies with a clear message rather than hanging. ONE copy for both deploy paths
 * (the per-file `integrationStack` and the shared-stage `_global-setup.ts`).
 */
export const awaitWorkerReady = (url: string): Effect.Effect<void, never, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		yield* client.get(`${url}/api/health`).pipe(
			Effect.flatMap((res) =>
				res.status === 200
					? res.json.pipe(
							Effect.flatMap((body) =>
								(body as {status?: unknown} | null)?.status === "ok"
									? Effect.void
									: Effect.fail(new WorkerNotReady({status: res.status})),
							),
							// A CF HTML error page (or any non-JSON body) fails `res.json`
							// decode — treat as not-ready, retryable, never a hard error.
							Effect.catchTag("HttpClientError", () =>
								Effect.fail(new WorkerNotReady({status: res.status})),
							),
						)
					: Effect.fail(new WorkerNotReady({status: res.status})),
			),
			Effect.retry({schedule: Schedule.spaced("2 seconds"), times: 30}),
			Effect.catch((cause) =>
				Effect.die(
					new Error(
						`worker never served a healthy /api/health within the readiness window for ${url}: ${String(cause)}`,
					),
				),
			),
		);
	});

/**
 * Stand up this file's per-file `Test.make` lifecycle and return the black-box
 * `harness` bound to its deployed worker URL. Call once at module top level.
 *
 * The deploy resolves inside a vitest `beforeAll` hook (so the worker exists before
 * any `it` body runs); its resolved URL is stashed in a holder the synchronous
 * `harness()` reads. The first request against a freshly-deployed workers.dev URL
 * 404s for a few seconds while the route propagates, so a probe retries
 * `GET /api/health` on a bounded `spaced` schedule before the suite asserts.
 */
export function integrationStack(metaUrl: string): Harness {
	const stage = stageFor(metaUrl);
	const {beforeAll, afterAll, deploy, destroy} = Test.make({
		providers: Cloudflare.providers(),
		state: Cloudflare.state(),
	});

	let workerUrl = "";
	let d1Target: {accountId: string; databaseId: string} | undefined;

	const stack = beforeAll(
		deploy(Stack, {stage}).pipe(
			deployTransientRetry,
			Effect.tap((out: Input.Resolve<StackOutput>) =>
				Effect.gen(function* () {
					// The deploy publishes the worker URL with a trailing slash; the harness
					// appends leading-slash paths, so strip it once here at the publish point
					// to avoid `//api/...` (which workerd parses as a protocol-relative URL).
					const resolved = out as {url: string; accountId: string; databaseId: string};
					const url = resolved.url.replace(/\/+$/, "");
					if (!url) return yield* Effect.die(new Error("deploy returned no worker url"));
					workerUrl = url;
					// The D1 uuid + account this stage deployed, read straight off the
					// compiled Stack output (alchemy `Cloudflare.D1Database`) — the harness's
					// setup-only D1 REST path reads the id the deploy knows, never a
					// reconstructed physical name (#692).
					if (!resolved.databaseId) {
						return yield* Effect.die(new Error("deploy returned no D1 databaseId"));
					}
					d1Target = {accountId: resolved.accountId, databaseId: resolved.databaseId};
					yield* awaitWorkerReady(url);
					yield* warmLiveDO(url);
				}),
			),
		),
	);

	// Force vitest to await the deploy hook even though the harness reads the URL
	// out-of-band: `stack` is the `beforeAll` accessor, and touching it here keeps
	// the hook registered. (The harness body itself is HTTP-only and never yields.)
	void stack;

	// Run-unique stages (stageFor) mean a deploy that throws mid-way can't be
	// overwritten by the next run's same-named deploy — orphan D1s accumulate instead.
	// A partial-deploy teardown that reliably cleans those up is out of scope here
	// (hard within alchemy's model); tracked as a follow-up sweep. See #690.
	//
	// Teardown is CLEANUP, not an assertion: a CF delete-ordering Conflict ("referenced
	// by Worker script" — the #813 missing worker→FlagshipApp downstream edge deletes
	// app+worker concurrently) or a WorkerNotFound here must NOT red a green suite, whose
	// pass/fail is the test assertions alone. So we catch the destroy's cause, log it loud
	// so the leaked stage is visible (swept by #690), and succeed. Durable fix: #813 (#1020).
	afterAll.skipIf(NO_DESTROY)(
		destroy(Stack, {stage}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning(
					`[integration] best-effort teardown failed for stage "${stage}" — stage leaked, sweep via #690 (durable fix #813):\n${Cause.pretty(cause)}`,
				),
			),
		),
	);

	return harness(
		() => workerUrl,
		() => {
			if (!d1Target) {
				throw new Error(
					"integration D1 target is not set — beforeAll(deploy(Stack)) has not resolved. " +
						"Build the harness via integrationStack() so the per-file deploy runs first.",
				);
			}
			return d1Target;
		},
	);
}

/**
 * Build the black-box `harness` over the RUN-SCOPED SHARED stage (ADR 0104 step 7, #1027) —
 * the deploy-once counterpart to `integrationStack`. No `beforeAll`/`afterAll`, no deploy:
 * `_global-setup.ts` deploys ONE stage per run in vitest `globalSetup` and `provide`s its
 * handle, so this is a pure HTTP/D1 client over the injected values, built via the SAME
 * `harness(urlAccessor, d1Accessor)` factory the per-file path uses. A file moves onto the
 * shared stage by swapping `integrationStack(import.meta.url)` for `sharedStack()` (no file
 * is migrated in this PR — only the sanity test reads it).
 *
 * `inject` resolves the values `globalSetup` provided; it throws if globalSetup didn't run
 * (the `integration` project wasn't selected), which is the correct failure for a file that
 * deploys nothing of its own.
 */
export function sharedStack(): Harness {
	const d1 = inject("integrationD1");
	return harness(
		() => inject("integrationWorkerUrl"),
		() => d1,
	);
}
