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

// Stage length is load-bearing: alchemy's `createPhysicalName` hard-caps a D1 name at
// 64 chars by truncating the readable prefix while preserving the trailing 16-char
// hash, and the harness's `resolveD1DatabaseId` (_harness.ts) reconstructs the name as
// `phoenix-phoenix-db-${stage}-…` and finds the DB by that prefix — if alchemy
// truncated the stage out of the readable prefix, `startsWith` misses and the lookup
// throws (the #689 `sozluk-keyset` failure). Budget: `phoenix-phoenix-db-` (19) + `-`
// + hash16 (17) = 36 fixed; capping the stage at 26 keeps the readable prefix (19+26=45)
// comfortably under the cap so the stage is never the part alchemy truncates.
const MAX_STAGE_LEN = 26;
const DISC_LEN = 8;

// Deterministic fixed-length discriminator (FNV-1a 32-bit → base36, padded/truncated to
// DISC_LEN). Fed `${slug}|${runToken}`, it carries BOTH file-distinctness (within a run)
// and run-distinctness (across runs) in a constant width, so the bounded stage never has
// to depend on the raw slug or token fitting.
const disc = (seed: string): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(DISC_LEN, "0").slice(0, DISC_LEN);
};

/**
 * A run-unique, length-bounded per-file stage name. Real remote D1 + workers are keyed
 * by stage against ONE shared Cloudflare account, so two CI runs (different PRs, or a
 * rerun) executing the integration job concurrently must never collide — the file
 * basename alone repeats across runs, deploying the SAME stage names →
 * `DatabaseAlreadyExists` (the dominant integration flake, #689).
 *
 *   - Local + `NO_DESTROY`: stable `it-<slug>` (always short) — NO_DESTROY keeps a
 *     file's deploy alive between local runs to re-adopt it, which REQUIRES a stable name.
 *   - Otherwise: `it-<readable>-<disc>`, always ≤ MAX_STAGE_LEN. `<disc>` is a
 *     fixed-width hash of `<slug>|<runToken>` — it alone guarantees uniqueness across
 *     BOTH files (slug) and runs (runToken: CI's `<run-id>-<run-attempt>`, so a rerun
 *     gets a distinct stage; else a per-process LOCAL_TOKEN). `<readable>` is a slug
 *     prefix kept only as a human-debug aid (a CF-dashboard stage traces to its file).
 *
 * Bounded length is load-bearing — see MAX_STAGE_LEN. Sanitized to the `[a-z0-9-]`
 * Cloudflare resource-name set, no leading/trailing dash, non-empty.
 */
const stageFor = (metaUrl: string): string => {
	const base = (metaUrl.split("/").pop() ?? "integration").replace(/\.test\.ts$/, "");
	const slug = base
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");

	if (NO_DESTROY) return `it-${slug}`;

	const runToken = process.env.GITHUB_RUN_ID
		? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
		: LOCAL_TOKEN;

	// `it-` (3) + `-` (1) + DISC_LEN leaves this many chars for the readable slug aid.
	const readable = slug.slice(0, MAX_STAGE_LEN - "it-".length - 1 - DISC_LEN).replace(/-$/, "");
	return `it-${readable}-${disc(`${slug}|${runToken}`)}`;
};

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

	// Run-unique stages (stageFor) mean a deploy that throws mid-way can't be
	// overwritten by the next run's same-named deploy — orphan D1s accumulate instead.
	// A partial-deploy teardown that reliably cleans those up is out of scope here
	// (hard within alchemy's model); tracked as a follow-up sweep. See #690.
	afterAll.skipIf(NO_DESTROY)(destroy(Stack, {stage}));

	return harness(() => workerUrl, stage);
}
