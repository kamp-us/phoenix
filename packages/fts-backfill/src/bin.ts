/**
 * `fts-backfill run` — the one-time, direct-D1 FTS backfill for #534 (see
 * backfill.ts for the why). A thin `effect/unstable/cli` bin over `backfill(d1)`
 * with a `D1Database` adapter (`makeD1RestFromEnv`) speaking the Cloudflare D1
 * REST query API, so the bin runs the SAME path the unit test exercises against
 * an in-memory fake. Idempotent: safe to re-run.
 *
 * Parameterized on the TARGET stage's D1 (never prod-hardcoded):
 *   --database-id  the stage's D1 UUID (from the alchemy state store / `getDatabase`)
 *   --account-id   Cloudflare account id (defaults to $CLOUDFLARE_ACCOUNT_ID)
 *   $CLOUDFLARE_API_TOKEN  the minted token (carries D1 Write) — read by CredentialsFromEnv
 *
 *   node src/bin.ts run --database-id <uuid> --account-id <acct>
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {makeD1RestFromEnv} from "@kampus/d1-rest";
import {Config, Console, Effect, Option, Schema} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {backfill} from "./backfill.ts";

/** A D1 REST call (FTS backfill over the query API) rejected — network/HTTP fault. */
class D1RestError extends Schema.TaggedErrorClass<D1RestError>()(
	"@kampus/fts-backfill/D1RestError",
	{cause: Schema.Defect()},
) {}

const databaseIdFlag = Flag.string("database-id").pipe(
	Flag.withDescription("the target stage's D1 database UUID to backfill"),
);

// Optional: falls back to $CLOUDFLARE_ACCOUNT_ID so callers pass only the per-stage database id.
const accountIdFlag = Flag.string("account-id").pipe(
	Flag.optional,
	Flag.withDescription("Cloudflare account id (default: $CLOUDFLARE_ACCOUNT_ID)"),
);

const run = Command.make(
	"run",
	{databaseId: databaseIdFlag, accountId: accountIdFlag},
	Effect.fn(function* ({databaseId, accountId}) {
		const resolvedAccount = Option.isSome(accountId)
			? accountId.value
			: yield* Config.string("CLOUDFLARE_ACCOUNT_ID");

		const d1 = makeD1RestFromEnv({accountId: resolvedAccount, databaseId});
		const report = yield* Effect.tryPromise({
			try: () => backfill(d1),
			catch: (cause) => new D1RestError({cause}),
		});

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
