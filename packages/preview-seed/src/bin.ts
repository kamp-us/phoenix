/**
 * `preview-seed run` seeds a deployed stage's D1 with the fixtures the unauthenticated read e2e
 * specs sample; `preview-seed test-account` provisions the moderator-tier account an authenticated
 * `review-ui` capture renders as (#7051). Both talk to D1 over the REST query API, never a worker
 * route: the admin seeder routes were deleted as a fail-open hole (CLAUDE.md, "Sözlük seed").
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {makeD1Rest} from "@kampus/d1-rest";
import {Config, Console, Effect, Layer, Option, Redacted, Schema} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {seed} from "./seed.ts";
import {
	MIN_SESSION_TOKEN_LEN,
	makeTestAccountDb,
	parseSessionToken,
	provisionTestAccount,
	TEST_ACCOUNT,
} from "./test-account.ts";

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

/** The target is not a throwaway — a database holding somebody's accounts is never provisioned. */
class NotThrowawayError extends Schema.TaggedErrorClass<NotThrowawayError>()(
	"@kampus/preview-seed/NotThrowawayError",
	{foreignAccounts: Schema.Number, databaseId: Schema.String},
) {
	override get message(): string {
		return `preview-seed: D1 ${this.databaseId} holds ${this.foreignAccounts} account(s) that are not the test identity — that is not a throwaway preview/stage, and no test account was written. Target a freshly deployed preview D1.`;
	}
}

/** The supplied token is too short or carries a cookie-illegal character — refused before any write. */
class WeakSessionTokenError extends Schema.TaggedErrorClass<WeakSessionTokenError>()(
	"@kampus/preview-seed/WeakSessionTokenError",
	{},
) {
	override get message(): string {
		return `preview-seed: $PREVIEW_TEST_SESSION_TOKEN must be at least ${MIN_SESSION_TOKEN_LEN} characters with no whitespace, ';' or ',' — it is the whole credential for a moderator on a live preview.`;
	}
}

const testAccount = Command.make(
	"test-account",
	{databaseId: databaseIdFlag, accountId: accountIdFlag},
	Effect.fn(function* ({databaseId, accountId}) {
		const resolvedAccount = Option.isSome(accountId)
			? accountId.value
			: yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
		const raw = yield* Config.redacted("PREVIEW_TEST_SESSION_TOKEN");
		const token = parseSessionToken(Redacted.value(raw));
		if (token === null) return yield* new WeakSessionTokenError();

		const db = makeTestAccountDb(
			makeD1Rest({accountId: resolvedAccount, databaseId, layer: restLayer}),
		);
		const outcome = yield* Effect.tryPromise({
			try: () => provisionTestAccount(db, token),
			catch: (cause) => new D1RestError({cause}),
		});
		if (outcome._tag === "NotThrowaway") {
			return yield* new NotThrowawayError({foreignAccounts: outcome.foreignAccounts, databaseId});
		}
		yield* Console.log(
			`preview-seed: ok — @${TEST_ACCOUNT.username} provisioned as moderator+yazar on D1 ${databaseId}, ${outcome.report.tuples} new moderates tuple(s), session valid to ${outcome.report.expiresAt.toISOString()}`,
		);
	}),
).pipe(
	Command.withDescription(
		"Provision the moderator-tier review-ui test account + its session on a throwaway preview/stage D1 — idempotent, refuses a database holding real accounts",
	),
);

const cli = Command.make("preview-seed").pipe(
	Command.withSubcommands([run, testAccount]),
	Command.withDescription(
		"Direct-D1 seed for the preview stage's unauthenticated read flows (#521) and its review-ui test account (#7051)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
