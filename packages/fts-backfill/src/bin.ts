/**
 * `fts-backfill run` — the one-time, direct-D1 FTS backfill for issue #534.
 *
 * Re-indexes every existing `term_summary` / `post_summary` row into the FTS5
 * `term_search` / `post_search` tables through the worker's own ADR-0080 sync
 * builders, so search works for content written before the dual-write existed.
 * This is the direct-D1 script CLAUDE.md's "Sözlük seed" mandates — NOT a worker
 * route, NOT a `.sql` migration (a migration can't run the app-side Turkish fold
 * the `norm` column needs), and NOT Python (the `effect/unstable/cli` idiom,
 * mirroring `@kampus/preview-seed` / `@kampus/leak-guard`). Idempotent: safe to
 * re-run.
 *
 * Transport: a `D1Database` adapter (`makeD1Rest`) over the Cloudflare D1 REST
 * query API via alchemy's already-installed `@distilled.cloud/cloudflare` (zero
 * new deps) — so the bin runs the SAME `backfill(d1)` path the unit test exercises
 * against an in-memory fake, no workerd binding needed.
 *
 * Parameterized on the TARGET stage's D1 (never prod-hardcoded):
 *   --database-id  the stage's D1 UUID (from the alchemy state store / `getDatabase`)
 *   --account-id   Cloudflare account id (defaults to $CLOUDFLARE_ACCOUNT_ID)
 *   $CLOUDFLARE_API_TOKEN  the minted token (carries D1 Write) — read by CredentialsFromEnv
 *
 *   node src/bin.ts run --database-id <uuid> --account-id <acct>
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Config, Console, Effect, Layer, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {backfill} from "./backfill.ts";
import {makeD1Rest} from "./d1-rest.ts";

const databaseIdFlag = Flag.string("database-id").pipe(
	Flag.withDescription("the target stage's D1 database UUID to backfill"),
);

// Optional: falls back to $CLOUDFLARE_ACCOUNT_ID so callers pass only the per-stage database id.
const accountIdFlag = Flag.string("account-id").pipe(
	Flag.optional,
	Flag.withDescription("Cloudflare account id (default: $CLOUDFLARE_ACCOUNT_ID)"),
);

// Credentials (CLOUDFLARE_API_TOKEN) + an HTTP client — the services queryDatabase needs.
const restLayer = Layer.merge(CredentialsFromEnv, FetchHttpClient.layer);

const run = Command.make(
	"run",
	{databaseId: databaseIdFlag, accountId: accountIdFlag},
	Effect.fn(function* ({databaseId, accountId}) {
		const resolvedAccount = Option.isSome(accountId)
			? accountId.value
			: yield* Config.string("CLOUDFLARE_ACCOUNT_ID");

		const d1 = makeD1Rest({accountId: resolvedAccount, databaseId, layer: restLayer});
		const report = yield* Effect.promise(() => backfill(d1));

		yield* Console.log(
			`fts-backfill: ok — re-indexed ${report.terms} term(s), ${report.posts} post(s) into term_search/post_search on D1 ${databaseId} (idempotent upsert)`,
		);
	}),
).pipe(Command.withDescription("Backfill the FTS tables from existing term/post summary rows"));

const cli = Command.make("fts-backfill").pipe(
	Command.withSubcommands([run]),
	Command.withDescription(
		"Direct-D1 one-time FTS backfill — re-index existing sözlük/pano rows for search (#534)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
