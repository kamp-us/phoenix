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
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../../alchemy.run.ts";
import {type Harness, harness} from "./_harness.ts";

// Tagged so the retry sentinel stays out of the untagged-error failure channel
// (effect `globalErrorInEffectFailure`): the fresh route 404s until it propagates.
class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{readonly status: number}> {}

// The worker's `env:` block binds `BETTER_AUTH_SECRET` from a required
// `Config.redacted`; the deploy resolves it from this env. An `insecure_`-prefixed
// 32-byte hex value (not a short word-string) keeps better-auth's startup
// length/entropy checks quiet on a CI run with no `.env` — matching `.env.example`.
process.env.BETTER_AUTH_SECRET ??=
	"insecure_cb11c15edab29ce190c28e1cf4c2d8e27c6918e99bdb3b280c7af98e1e542bb6";

// Run the deployed worker in dev mode so better-auth permits the suite's
// server-side (browser-less, no `Origin` header) sign-ups: in prod mode better-auth
// infers the origin from the request Host and 403s `INVALID_ORIGIN` for the
// harness's `fetch`. The integration suite validates application logic, not the
// prod deploy's origin policy.
process.env.ENVIRONMENT ??= "development";

// The Stack's compiled output type (`{url: Output<string>}`) — what `deploy`
// resolves. Pinning `A` explicitly keeps the link to the Stack's declared output:
// if the stack stops returning `{url}`, `deploy` no longer accepts the Stack and
// this stops compiling rather than breaking at runtime on `out.url`.
type StackOutput =
	typeof Stack extends Effect.Effect<CompiledStack<infer A>, infer _E, infer _R> ? A : never;

/**
 * A per-file isolated stage name. Real remote D1 + workers are keyed by stage, so
 * two files deploying concurrently must never collide; the file's basename is
 * stable across a run (so a re-deploy of the same file adopts the same stage) and
 * unique across files. Sanitized to the `[a-z0-9-]` Cloudflare resource-name set.
 */
const stageFor = (metaUrl: string): string => {
	const base = (metaUrl.split("/").pop() ?? "integration").replace(/\.test\.ts$/, "");
	const slug = base
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
	return `it-${slug}`;
};

// `afterAll(destroy(...))` is skipped when `NO_DESTROY` is set, so a local iteration
// loop can keep the per-file deploy alive between runs (matching the alchemy idiom).
const NO_DESTROY = !!process.env.NO_DESTROY;

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

	const stack = beforeAll(
		deploy(Stack, {stage}).pipe(
			Effect.tap((out: Input.Resolve<StackOutput>) =>
				Effect.gen(function* () {
					// The deploy publishes the worker URL with a trailing slash; the harness
					// appends leading-slash paths, so strip it once here at the publish point
					// to avoid `//api/...` (which workerd parses as a protocol-relative URL).
					const url = (out as {url: string}).url.replace(/\/+$/, "");
					if (!url) return yield* Effect.die(new Error("deploy returned no worker url"));
					workerUrl = url;
					// Retry-first-request: a fresh route 404s briefly while it propagates.
					// Effect.repeat-style retry on a bounded `spaced` Schedule, never a
					// Date.now() polling loop — capped at `times` so a never-ready worker
					// fails fast inside the hook timeout instead of hanging.
					const client = yield* HttpClient.HttpClient;
					yield* client.get(`${url}/api/health`).pipe(
						Effect.flatMap((res) =>
							res.status === 200
								? Effect.void
								: Effect.fail(new WorkerNotReady({status: res.status})),
						),
						Effect.retry({schedule: Schedule.spaced("2 seconds"), times: 30}),
					);
				}),
			),
		),
	);

	// Force vitest to await the deploy hook even though the harness reads the URL
	// out-of-band: `stack` is the `beforeAll` accessor, and touching it here keeps
	// the hook registered. (The harness body itself is HTTP-only and never yields.)
	void stack;

	afterAll.skipIf(NO_DESTROY)(destroy(Stack, {stage}));

	return harness(() => workerUrl);
}
