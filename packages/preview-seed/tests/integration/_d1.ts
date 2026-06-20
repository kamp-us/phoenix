/**
 * Per-file real-D1 substrate for the seed's integration tier — the alchemy
 * `Test.make` idiom of ADR 0082 / `.patterns/alchemy-test-harness.md`, scoped to
 * a **D1-only stack** (this package has no worker; the seed talks to D1 directly).
 *
 * Each integration test file calls `seedD1(import.meta.url)` once at module top
 * level. It stands up a per-file `Test.make`, deploys a stack declaring ONLY the
 * phoenix D1 resource under an isolated stage — migrated by the **same** worker
 * migrations dir the production deploy applies (`worker/db/drizzle/migrations`),
 * so the seeded tables (incl. the `0002_search_fts.sql` FTS5 virtual tables) exist
 * exactly as in prod, one migration path — and returns a `seedDb()` accessor that
 * builds a `D1Database` over the production REST transport (`makeD1Rest`) pointed
 * at that stage's real D1. The seed then runs the SAME `seed(d1)` path the bin
 * ships; assertions read back over the same REST seam.
 *
 * Real remote D1 + a shared Cloudflare account are stage-keyed, so two CI runs (or
 * a rerun) must never collide on a stage name — the same isolated-stage derivation
 * apps/web uses (`_stage-name`'s run-unique `it-<readable>-<disc>`). Creds
 * (`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `ALCHEMY_PASSWORD`) come from
 * the environment — CI secrets; an alchemy/wrangler profile locally. Without them
 * the deploy fails at `Unauthorized` (expected off-CI; the suite proves itself on
 * CI's integration job).
 */
import {join} from "node:path";
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {makeD1Rest} from "@kampus/d1-rest";
import type {Input} from "alchemy";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {slugify, stageName} from "./_stage-name.ts";

// The worker's canonical migrations dir — the SAME one `apps/web`'s D1 resource
// applies on deploy (ADR 0082's "one migration path"). Resolved from this file:
// `packages/preview-seed/tests/integration/` → repo root is four levels up.
const MIGRATIONS_DIR = join(
	import.meta.dirname,
	"../../../../apps/web/worker/db/drizzle/migrations",
);

// `phoenix_db` matches the worker's D1 resource id (`worker/db/resources.ts`) so a
// migrations-table mismatch can't drift; `drizzle_migrations` matches drizzle-kit's
// own bookkeeping table.
const phoenixD1Stack = (stage: string) =>
	Alchemy.Stack(
		`preview-seed-it-${stage}`,
		{providers: Cloudflare.providers(), state: Cloudflare.state()},
		Effect.gen(function* () {
			const db = yield* Cloudflare.D1Database("phoenix_db", {
				migrationsDir: MIGRATIONS_DIR,
				migrationsTable: "drizzle_migrations",
			});
			return {databaseId: db.databaseId, accountId: db.accountId};
		}),
	);

type StackOutput = {databaseId: string; accountId: string};

// Credentials (CLOUDFLARE_API_TOKEN) + an HTTP client — what `queryDatabase` (the
// REST transport inside makeD1Rest) needs. The same layer the bin assembles.
const restLayer = Layer.merge(CredentialsFromEnv, FetchHttpClient.layer);

// `afterAll(destroy)` is skipped when `NO_DESTROY` is set, so a local iteration loop
// can keep the per-file deploy alive between runs (the alchemy idiom).
const NO_DESTROY = !!process.env.NO_DESTROY;

// Per-process token for destroy-on runs: stable for one vitest process, distinct
// across concurrent processes; the stage is destroyed in afterAll so it never
// outlives the run. pid + hrtime base36 (deterministic-enough, short), not
// Date.now()/Math.random().
const LOCAL_TOKEN = `${process.pid.toString(36)}${process.hrtime.bigint().toString(36)}`.replace(
	/[^a-z0-9]/g,
	"",
);

const stageFor = (metaUrl: string): string => {
	const base = (metaUrl.split("/").pop() ?? "integration").replace(/\.test\.ts$/, "");
	const slug = slugify(base);
	const runToken = process.env.GITHUB_RUN_ID
		? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
		: LOCAL_TOKEN;
	return stageName(slug, NO_DESTROY, runToken);
};

export interface SeedD1 {
	/** A `D1Database` over this stage's real D1 (the production REST transport). */
	seedDb(): D1Database;
	/** This stage's real D1 coordinates, for an assertion that needs the raw REST seam. */
	target(): {accountId: string; databaseId: string};
}

/**
 * Stand up this file's per-file `Test.make` D1-only deploy and return a `seedDb()`
 * accessor over its real D1. Call once at module top level. The deploy resolves in
 * a vitest `beforeAll` (so the D1 exists + is migrated before any `it` body runs);
 * its `{accountId, databaseId}` is stashed in a holder the synchronous accessors read.
 */
export function seedD1(metaUrl: string): SeedD1 {
	const stage = stageFor(metaUrl);
	const {beforeAll, afterAll, deploy, destroy} = Test.make({
		providers: Cloudflare.providers(),
		state: Cloudflare.state(),
	});

	let resolved: StackOutput | undefined;

	const stack = beforeAll(
		deploy(phoenixD1Stack(stage), {stage}).pipe(
			Effect.tap((out: Input.Resolve<StackOutput>) =>
				Effect.sync(() => {
					if (!out.databaseId) throw new Error("D1 deploy returned no databaseId");
					resolved = {databaseId: out.databaseId, accountId: out.accountId};
				}),
			),
		),
	);
	// Touch the accessor so vitest keeps the beforeAll hook registered (the accessors
	// below read the resolved coordinates out-of-band).
	void stack;

	afterAll.skipIf(NO_DESTROY)(destroy(phoenixD1Stack(stage), {stage}));

	const target = (): {accountId: string; databaseId: string} => {
		if (!resolved) {
			throw new Error(
				"D1 not deployed — beforeAll(deploy) has not resolved. Build the harness via seedD1().",
			);
		}
		return {accountId: resolved.accountId, databaseId: resolved.databaseId};
	};

	const seedDb = (): D1Database => {
		const {accountId, databaseId} = target();
		return makeD1Rest({accountId, databaseId, layer: restLayer});
	};

	return {seedDb, target};
}
