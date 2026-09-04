/**
 * `preview-seed run` seeds a deployed stage's D1 with the fixtures the unauthenticated read e2e
 * specs sample; `preview-seed test-account` provisions the per-tier accounts an authenticated
 * `review-ui` capture renders as (#7051, #7398). Both talk to D1 over the REST query API, never a
 * worker route: the admin seeder routes were deleted as a fail-open hole (CLAUDE.md, "Sözlük seed").
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {makeD1Rest} from "@kampus/d1-rest";
import {Config, Console, Effect, Layer, Option, Redacted, Schema} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {seed} from "./seed.ts";
import {
	type CaylakStanding,
	KEFIL_SUFFIX,
	MIN_SESSION_TOKEN_LEN,
	makeTestAccountDb,
	PREVIEW_TIERS,
	type PreviewCredentials,
	type PreviewTier,
	parseSessionToken,
	parseStanding,
	provisionTestAccounts,
	type SessionToken,
	TEST_ACCOUNTS,
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

/**
 * The environment variable carrying each tier's session token. One variable per tier, because the
 * token IS the identity: a single variable reused across tiers would make a mistyped run provision
 * the wrong audience under the right name. `review-ui render` reads the same names on the capture
 * side (`fabrika-cli`'s `capture/auth.ts`) — the two lists move together.
 */
const TIER_TOKEN_ENV: Readonly<Record<PreviewTier, string>> = {
	yazar: "PREVIEW_TEST_SESSION_TOKEN",
	çaylak: "PREVIEW_TEST_CAYLAK_SESSION_TOKEN",
};

/** The target is not a throwaway — a database holding somebody's accounts is never provisioned. */
class NotThrowawayError extends Schema.TaggedErrorClass<NotThrowawayError>()(
	"@kampus/preview-seed/NotThrowawayError",
	{foreignAccounts: Schema.Number, databaseId: Schema.String},
) {
	override get message(): string {
		return `preview-seed: D1 ${this.databaseId} holds ${this.foreignAccounts} account(s) that are none of the test identities — that is not a throwaway preview/stage, and no test account was written. Target a freshly deployed preview D1.`;
	}
}

/** The supplied token is too short or carries a cookie-illegal character — refused before any write. */
class WeakSessionTokenError extends Schema.TaggedErrorClass<WeakSessionTokenError>()(
	"@kampus/preview-seed/WeakSessionTokenError",
	{variable: Schema.String},
) {
	override get message(): string {
		return `preview-seed: $${this.variable} must be at least ${MIN_SESSION_TOKEN_LEN} characters with no whitespace, ';' or ',' — it is the whole credential for a live preview identity.`;
	}
}

/** No tier was named — a run that seeds nothing must say so, never fall back to a default tier. */
class NoCredentialsError extends Schema.TaggedErrorClass<NoCredentialsError>()(
	"@kampus/preview-seed/NoCredentialsError",
	{},
) {
	override get message(): string {
		return `preview-seed: no tier token is set — set at least one of ${PREVIEW_TIERS.map((tier) => `$${TIER_TOKEN_ENV[tier]}`).join(", ")}. A tier with no token is left unseeded, and review-ui refuses a surface naming it.`;
	}
}

/** The requested standing names a tier this run does not seed — refused before any write. */
class StandingNeedsTierError extends Schema.TaggedErrorClass<StandingNeedsTierError>()(
	"@kampus/preview-seed/StandingNeedsTierError",
	{missing: Schema.String, variable: Schema.String, role: Schema.String},
) {
	override get message(): string {
		const because =
			this.role === "voucher"
				? "a vouched çaylak needs a voucher identity, and authorship_vouch has no foreign keys, so a vouch written without one would dangle"
				: "the standing is the çaylak's, so there is nothing to attach it to";
		return `preview-seed: --caylak-standing needs the ${this.missing} tier in the same run — ${because}. Set $${this.variable} and re-run; nothing was written.`;
	}
}

/** The standing operand does not parse — one flag carries both fields, so a partial one is refused. */
class StandingSpecError extends Schema.TaggedErrorClass<StandingSpecError>()(
	"@kampus/preview-seed/StandingSpecError",
	{spec: Schema.String},
) {
	override get message(): string {
		return `preview-seed: --caylak-standing "${this.spec}" is not a standing — write a non-negative karma total, optionally suffixed "${KEFIL_SUFFIX}" (e.g. "0" or "15${KEFIL_SUFFIX}").`;
	}
}

/** Read one tier's token: absent ⇒ this run does not seed the tier; present-but-weak ⇒ refused. */
const readTierToken = Effect.fn(function* (tier: PreviewTier) {
	const raw = yield* Config.option(Config.redacted(TIER_TOKEN_ENV[tier]));
	if (Option.isNone(raw)) return null;
	const token = parseSessionToken(Redacted.value(raw.value));
	if (token === null) return yield* new WeakSessionTokenError({variable: TIER_TOKEN_ENV[tier]});
	return token satisfies SessionToken;
});

const caylakStandingFlag = Flag.string("caylak-standing").pipe(
	Flag.optional,
	Flag.withDescription(
		`where the çaylak stands on the promotion path — a non-negative karma total, optionally suffixed "${KEFIL_SUFFIX}" (e.g. "0", "15${KEFIL_SUFFIX}"); omitted leaves the standing untouched`,
	),
);

const testAccount = Command.make(
	"test-account",
	{databaseId: databaseIdFlag, accountId: accountIdFlag, caylakStanding: caylakStandingFlag},
	Effect.fn(function* ({databaseId, accountId, caylakStanding}) {
		const resolvedAccount = Option.isSome(accountId)
			? accountId.value
			: yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
		const standing: CaylakStanding | null = Option.isSome(caylakStanding)
			? (parseStanding(caylakStanding.value) ??
				(yield* new StandingSpecError({spec: caylakStanding.value})))
			: null;
		const credentials: PreviewCredentials = Object.fromEntries(
			(yield* Effect.forEach(
				PREVIEW_TIERS,
				(tier) => readTierToken(tier).pipe(Effect.map((token) => [tier, token] as const)),
				// Serial on purpose: these are env reads, and the order decides which weak-token
				// refusal an operator sees first — PREVIEW_TIERS order, not a race.
				{concurrency: 1},
			)).filter(([, token]) => token !== null),
		);

		const db = makeTestAccountDb(
			makeD1Rest({accountId: resolvedAccount, databaseId, layer: restLayer}),
		);
		const outcome = yield* Effect.tryPromise({
			try: () => provisionTestAccounts(db, credentials, standing),
			catch: (cause) => new D1RestError({cause}),
		});
		if (outcome._tag === "NoCredentials") return yield* new NoCredentialsError();
		if (outcome._tag === "NotThrowaway") {
			return yield* new NotThrowawayError({foreignAccounts: outcome.foreignAccounts, databaseId});
		}
		if (outcome._tag === "StandingNeedsTier") {
			return yield* new StandingNeedsTierError({
				missing: outcome.missing,
				variable: TIER_TOKEN_ENV[outcome.missing],
				role: outcome.role,
			});
		}
		const provisioned = outcome.report.tiers
			.map((tier) => `@${TEST_ACCOUNTS[tier].username} at ${tier}`)
			.join(", ");
		const unseeded = PREVIEW_TIERS.filter((tier) => !outcome.report.tiers.includes(tier));
		const standingSaid =
			standing === null
				? "no standing written"
				: `çaylak standing set to ${standing.karma} karma, kefil ${standing.kefil ? "var" : "yok"}`;
		yield* Console.log(
			`preview-seed: ok — provisioned ${provisioned} on D1 ${databaseId}, ${outcome.report.tuples} new moderates tuple(s), ${standingSaid}, sessions valid to ${outcome.report.expiresAt.toISOString()}${unseeded.length === 0 ? "" : `; unseeded: ${unseeded.join(", ")}`}`,
		);
	}),
).pipe(
	Command.withDescription(
		"Provision the review-ui test accounts + their sessions on a throwaway preview/stage D1, one per tier whose token is set ($PREVIEW_TEST_SESSION_TOKEN for yazar, $PREVIEW_TEST_CAYLAK_SESSION_TOKEN for çaylak), optionally placing the çaylak at a point on the promotion path with --caylak-standing — idempotent, refuses a database holding real accounts, and prints the tiers provisioned plus any left unseeded",
	),
);

const cli = Command.make("preview-seed").pipe(
	Command.withSubcommands([run, testAccount]),
	Command.withDescription(
		"Direct-D1 seed for the preview stage's unauthenticated read flows (#521) and its per-tier review-ui test accounts (#7051, #7398)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
