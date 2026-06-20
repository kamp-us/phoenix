/**
 * `preview-seed run` — the CI-callable surface for issue #521.
 *
 * Seeds a *deployed* stage's D1 with the minimal sözlük + pano fixtures the
 * unauthenticated read e2e specs sample, so a fresh (empty) per-PR preview D1
 * isn't blank when those specs navigate to /sozluk and /pano. This is the
 * direct-D1 script CLAUDE.md's "Sözlük seed" mandates — NOT a worker route (the
 * admin seeder routes were deleted as a fail-open hole), and NOT Python (the
 * `effect/unstable/cli` tooling idiom, mirroring @kampus/leak-guard).
 *
 * Transport: a `D1Database` adapter (`makeD1Rest`) over the Cloudflare D1 REST
 * query API via alchemy's already-installed `@distilled.cloud/cloudflare` (zero
 * new deps) — so the bin runs the SAME `seed(d1)` path the unit tests exercise
 * against the in-memory fake, no workerd binding needed.
 *
 * Parameterized on the TARGET stage's D1 (never prod-hardcoded):
 *   --database-id  the stage's D1 UUID (from the alchemy state store / `getDatabase`)
 *   --account-id   Cloudflare account id (defaults to $CLOUDFLARE_ACCOUNT_ID)
 *   $CLOUDFLARE_API_TOKEN  the minted CI token (carries D1 Write) — read by CredentialsFromEnv
 *
 *   node src/bin.ts run --database-id <uuid> --account-id <acct>
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {makeD1Rest} from "@kampus/d1-rest";
import {Config, Console, Effect, Layer, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {seed} from "./seed.ts";

const databaseIdFlag = Flag.string("database-id").pipe(
	Flag.withDescription("the target stage's D1 database UUID to seed"),
);

// Optional: falls back to $CLOUDFLARE_ACCOUNT_ID so CI passes only the per-stage database id.
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
		const report = yield* Effect.promise(() => seed(d1));

		yield* Console.log(
			`preview-seed: ok — wrote ${report.terms} term(s), ${report.definitions} definition(s), ${report.posts} post(s), ${report.termsFts} term-search + ${report.postsFts} post-search FTS row(s) to D1 ${databaseId} (idempotent upsert)`,
		);
	}),
).pipe(Command.withDescription("Seed a stage's D1 with the unauth read-flow fixtures"));

const cli = Command.make("preview-seed").pipe(
	Command.withSubcommands([run]),
	Command.withDescription(
		"Direct-D1 seed for the preview stage's unauthenticated read flows (#521)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
