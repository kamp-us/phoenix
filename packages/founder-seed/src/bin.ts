/**
 * `founder-seed` — the offline D1 CLI bin around {@link seedFounders} (ADR 0107).
 * Transport is the D1 REST query API over alchemy's already-installed
 * `@distilled.cloud/cloudflare` (zero new deps). Parameterized on the TARGET
 * stage's D1, never prod-hardcoded:
 *   node src/bin.ts seed --database-id <uuid> [--account-id <acct>]
 *   node src/bin.ts list --database-id <uuid>
 *   $CLOUDFLARE_API_TOKEN  the minted token (carries D1 Write) — read by CredentialsFromEnv
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {makeD1Rest} from "@kampus/d1-rest";
import {Config, Console, Effect, Layer, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {listFounderTuples, makeSeedDb, seedFounders} from "./seed.ts";

const databaseIdFlag = Flag.string("database-id").pipe(
	Flag.withDescription("the target stage's D1 database UUID"),
);
const accountIdFlag = Flag.string("account-id").pipe(
	Flag.optional,
	Flag.withDescription("Cloudflare account id (default: $CLOUDFLARE_ACCOUNT_ID)"),
);

const restLayer = Layer.merge(CredentialsFromEnv, FetchHttpClient.layer);

const resolveAccount = (accountId: Option.Option<string>) =>
	Option.isSome(accountId)
		? Effect.succeed(accountId.value)
		: Config.string("CLOUDFLARE_ACCOUNT_ID");

const makeDb = (accountId: string, databaseId: string) =>
	makeSeedDb(makeD1Rest({accountId, databaseId, layer: restLayer}));

const seed = Command.make(
	"seed",
	{databaseId: databaseIdFlag, accountId: accountIdFlag},
	Effect.fn(function* ({databaseId, accountId}) {
		const account = yield* resolveAccount(accountId);
		const db = makeDb(account, databaseId);
		const res = yield* Effect.promise(() => seedFounders(db));
		yield* res.founders === 0
			? Console.log(
					`founder-seed: no founders (role='moderator' cohort is empty) — nothing to mint (D1 ${databaseId})`,
				)
			: Console.log(
					`founder-seed: ok — ${res.founders} founder(s), ${res.inserted} new tuple(s) minted (D1 ${databaseId})`,
				);
	}),
).pipe(
	Command.withDescription(
		'Mint the founder cohort (role=\'moderator\') as (id, "moderates", "platform") tuples — idempotent',
	),
);

const list = Command.make(
	"list",
	{databaseId: databaseIdFlag, accountId: accountIdFlag},
	Effect.fn(function* ({databaseId, accountId}) {
		const account = yield* resolveAccount(accountId);
		const db = makeDb(account, databaseId);
		const tuples = yield* Effect.promise(() => listFounderTuples(db));
		yield* Console.log(
			tuples.length === 0
				? "founder-seed: no founder tuples"
				: `founder-seed: ${tuples.length} founder tuple(s):\n${tuples.map((t) => `  - (${t.subject}, ${t.relation}, ${t.object})`).join("\n")}`,
		);
	}),
).pipe(Command.withDescription('List the founder tuples (subject, "moderates", "platform")'));

const cli = Command.make("founder-seed").pipe(
	Command.withSubcommands([seed, list]),
	Command.withDescription(
		"Offline D1 founder seed — mint the moderator cohort as platform-moderates tuples (ADR 0107)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
