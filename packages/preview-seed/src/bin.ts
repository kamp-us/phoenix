/**
 * `preview-seed run` — seeds a deployed stage's D1 with the fixtures the unauthenticated
 * read e2e specs sample. It talks to D1 over the REST query API, never a worker route:
 * the admin seeder routes were deleted as a fail-open hole (CLAUDE.md, "Sözlük seed").
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {makeD1Rest} from "@kampus/d1-rest";
import {Config, Console, Effect, Layer, Option, Schema} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {seed} from "./seed.ts";

class D1RestError extends Schema.TaggedErrorClass<D1RestError>()(
	"@kampus/preview-seed/D1RestError",
	{cause: Schema.Defect()},
) {}

const databaseIdFlag = Flag.string("database-id").pipe(
	Flag.withDescription("the target stage's D1 database UUID to seed"),
);

const accountIdFlag = Flag.string("account-id").pipe(
	Flag.optional,
	Flag.withDescription("Cloudflare account id (default: $CLOUDFLARE_ACCOUNT_ID)"),
);

const restLayer = Layer.merge(CredentialsFromEnv, FetchHttpClient.layer);

const run = Command.make(
	"run",
	{databaseId: databaseIdFlag, accountId: accountIdFlag},
	Effect.fn(function* ({databaseId, accountId}) {
		const resolvedAccount = Option.isSome(accountId)
			? accountId.value
			: yield* Config.string("CLOUDFLARE_ACCOUNT_ID");

		const d1 = makeD1Rest({accountId: resolvedAccount, databaseId, layer: restLayer});
		const report = yield* Effect.tryPromise({
			try: () => seed(d1),
			catch: (cause) => new D1RestError({cause}),
		});

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
