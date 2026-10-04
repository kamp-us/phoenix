/**
 * `preview-seed run` seeds a deployed stage's D1 with the fixtures the unauthenticated read e2e
 * specs sample; `preview-seed test-account` provisions the per-audience accounts an authenticated
 * `review-ui` capture renders as (#7051, #7398, #10264). Both talk to D1 over the REST query API, never a
 * worker route: the admin seeder routes were deleted as a fail-open hole (CLAUDE.md, "Sözlük seed").
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {makeD1Rest, resolveDatabaseName} from "@kampus/d1-rest";
import {Config, Console, Effect, Layer, Option, Redacted, Schema, Stream} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {
	describeFailure,
	IDENTITY_TOKEN_ENV,
	LOGINS_NAME,
	type LoginStore,
	resolveCredentials,
	rotateLogins,
	type StoreWrite,
} from "./logins.ts";
import {seed} from "./seed.ts";
import {
	type CaylakStanding,
	isThrowawayDatabaseName,
	KEFIL_SUFFIX,
	MIN_SESSION_TOKEN_LEN,
	makeTestAccountDb,
	PREVIEW_IDENTITIES,
	PREVIEW_NAME_MARKER,
	parseStanding,
	provisionTestAccounts,
	TEST_ACCOUNTS,
} from "./test-account.ts";

class D1RestError extends Schema.TaggedError<D1RestError>()("@kampus/preview-seed/D1RestError", {
	cause: Schema.Defect(),
}) {}

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

/** The target is not a per-PR preview — anything else is somebody's real world, and is refused. */
class NotThrowawayError extends Schema.TaggedError<NotThrowawayError>()(
	"@kampus/preview-seed/NotThrowawayError",
	{databaseName: Schema.String, databaseId: Schema.String},
) {
	override get message(): string {
		return `preview-seed: D1 ${this.databaseId} is named "${this.databaseName}", which is not a per-PR preview (a preview name carries "${PREVIEW_NAME_MARKER}") — no test account was written. Target the D1 a PR's preview-deploy comment names.`;
	}
}

/** A supplied token is too short or carries a cookie-illegal character — refused before any write. */
class WeakSessionTokenError extends Schema.TaggedError<WeakSessionTokenError>()(
	"@kampus/preview-seed/WeakSessionTokenError",
	{source: Schema.String},
) {
	override get message(): string {
		return `preview-seed: ${this.source} must be at least ${MIN_SESSION_TOKEN_LEN} characters with no whitespace, ';' or ',' — it is the whole credential for a live preview identity.`;
	}
}

/** `$PREVIEW_TEST_LOGINS` is set and is not the logins object — refused before any write. */
class MalformedLoginsError extends Schema.TaggedError<MalformedLoginsError>()(
	"@kampus/preview-seed/MalformedLoginsError",
	{reason: Schema.String},
) {
	override get message(): string {
		return `preview-seed: $${LOGINS_NAME} is set but ${this.reason} — it must be the JSON object \`preview-seed rotate-logins\` writes, keyed by ${Object.values(IDENTITY_TOKEN_ENV).join(", ")}. Nothing was written, and its contents were not printed.`;
	}
}

/**
 * The provisioning write failed. `reason` is the failure with every token scrubbed out — a driver
 * reports a failed statement with its bound parameters, which include the session tokens — so this
 * error deliberately carries no raw `cause`.
 */
class ProvisionFailedError extends Schema.TaggedError<ProvisionFailedError>()(
	"@kampus/preview-seed/ProvisionFailedError",
	{databaseId: Schema.String, reason: Schema.String},
) {
	override get message(): string {
		return `preview-seed: could not provision the test accounts on D1 ${this.databaseId}: ${this.reason}`;
	}
}

/** No identity was named — a run that seeds nothing must say so, never fall back to a default one. */
class NoCredentialsError extends Schema.TaggedError<NoCredentialsError>()(
	"@kampus/preview-seed/NoCredentialsError",
	{},
) {
	override get message(): string {
		return `preview-seed: no identity token is set — set $${LOGINS_NAME} (the JSON object \`preview-seed rotate-logins\` writes), or at least one of ${PREVIEW_IDENTITIES.map((identity) => `$${IDENTITY_TOKEN_ENV[identity]}`).join(", ")}. An identity with no token is left unseeded, and review-ui refuses a surface naming it.`;
	}
}

/** The requested standing names an identity this run does not seed — refused before any write. */
class StandingNeedsIdentityError extends Schema.TaggedError<StandingNeedsIdentityError>()(
	"@kampus/preview-seed/StandingNeedsIdentityError",
	{missing: Schema.String, variable: Schema.String, role: Schema.String},
) {
	override get message(): string {
		const because =
			this.role === "voucher"
				? "a vouched çaylak needs a voucher identity, and authorship_vouch has no foreign keys, so a vouch written without one would dangle"
				: "the standing is the çaylak's, so there is nothing to attach it to";
		return `preview-seed: --caylak-standing needs the ${this.missing} identity in the same run — ${because}. Set $${this.variable} and re-run; nothing was written.`;
	}
}

/** The standing operand does not parse — one flag carries both fields, so a partial one is refused. */
class StandingSpecError extends Schema.TaggedError<StandingSpecError>()(
	"@kampus/preview-seed/StandingSpecError",
	{spec: Schema.String},
) {
	override get message(): string {
		return `preview-seed: --caylak-standing "${this.spec}" is not a standing — write a non-negative karma total, optionally suffixed "${KEFIL_SUFFIX}" (e.g. "0" or "15${KEFIL_SUFFIX}").`;
	}
}

/** A variable's value as `Redacted`, or `null` when it is unset. */
const readRedacted = Effect.fn(function* (variable: string) {
	return Option.getOrNull(yield* Config.option(Config.redacted(variable)));
});

/**
 * The tokens this run provisions: each identity's own variable, else its entry in
 * `$PREVIEW_TEST_LOGINS`. Nothing here unwraps a token, and no refusal quotes one.
 */
const readCredentials = Effect.gen(function* () {
	const own = Object.fromEntries(
		(yield* Effect.forEach(
			PREVIEW_IDENTITIES,
			(identity) =>
				readRedacted(IDENTITY_TOKEN_ENV[identity]).pipe(
					Effect.map((token) => [identity, token] as const),
				),
			// Serial on purpose: these are env reads, and the order decides which weak-token
			// refusal an operator sees first — PREVIEW_IDENTITIES order, not a race.
			{concurrency: 1},
		)).flatMap(([identity, token]) => (token === null ? [] : [[identity, token] as const])),
	);
	const read = resolveCredentials(own, yield* readRedacted(LOGINS_NAME));
	if (read._tag === "Weak") return yield* new WeakSessionTokenError({source: read.source});
	if (read._tag === "MalformedBundle")
		return yield* new MalformedLoginsError({reason: read.reason});
	return read.credentials;
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
		// Parsed ahead of the name lookup: a mistyped operand is a local fact, so it refuses without
		// spending an API round trip — and still before any token read, which the fence below owns.
		const standing: CaylakStanding | null = Option.isSome(caylakStanding)
			? (parseStanding(caylakStanding.value) ??
				(yield* new StandingSpecError({spec: caylakStanding.value})))
			: null;
		const target = {accountId: resolvedAccount, databaseId, layer: restLayer};
		const databaseName = yield* Effect.tryPromise({
			try: () => resolveDatabaseName(target),
			catch: (cause) => new D1RestError({cause}),
		});
		// The fence runs ahead of the token reads, not just ahead of the write: a run against a real
		// database refuses on the target alone, so no live preview credential is parsed into this
		// process first. `provisionTestAccounts` re-decides it for every other caller of the package.
		if (!isThrowawayDatabaseName(databaseName)) {
			return yield* new NotThrowawayError({databaseName, databaseId});
		}

		const credentials = yield* readCredentials;

		const db = makeTestAccountDb(makeD1Rest(target));
		const outcome = yield* Effect.tryPromise({
			try: () => provisionTestAccounts(db, databaseName, credentials, standing),
			catch: (cause) =>
				new ProvisionFailedError({
					databaseId,
					reason: describeFailure(cause, Object.values(credentials)),
				}),
		});
		if (outcome._tag === "NoCredentials") return yield* new NoCredentialsError();
		if (outcome._tag === "NotThrowaway") {
			return yield* new NotThrowawayError({databaseName: outcome.databaseName, databaseId});
		}
		if (outcome._tag === "StandingNeedsIdentity") {
			return yield* new StandingNeedsIdentityError({
				missing: outcome.missing,
				variable: IDENTITY_TOKEN_ENV[outcome.missing],
				role: outcome.role,
			});
		}
		const provisioned = outcome.report.identities
			.map((identity) => {
				const account = TEST_ACCOUNTS[identity];
				return `@${account.username} at ${account.tier}${account.emailVerified ? "" : " (email unverified)"}`;
			})
			.join(", ");
		const unseeded = PREVIEW_IDENTITIES.filter(
			(identity) => !outcome.report.identities.includes(identity),
		);
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
		"Provision the review-ui test accounts + their sessions and profile rows on a per-PR preview D1, one per identity whose token is set — in $PREVIEW_TEST_LOGINS, the JSON object `rotate-logins` writes, or in the identity's own variable, which wins ($PREVIEW_TEST_SESSION_TOKEN for yazar, $PREVIEW_TEST_CAYLAK_SESSION_TOKEN for çaylak, $PREVIEW_TEST_CAYLAK_UNVERIFIED_SESSION_TOKEN for an email-unverified çaylak) — optionally placing the çaylak at a point on the promotion path with --caylak-standing — idempotent, refuses any database Cloudflare does not name as a per-PR preview, and prints the identities provisioned plus any left unseeded",
	),
);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the owner/name whose secret and variable are set (default: the repository gh resolves from this directory)",
	),
);

/** One of the two stores refused, so the logins are not in place. */
class RotateRefusedError extends Schema.TaggedError<RotateRefusedError>()(
	"@kampus/preview-seed/RotateRefusedError",
	{store: Schema.Literals(["secret", "variable"]), reason: Schema.String},
) {
	override get message(): string {
		return this.store === "secret"
			? `preview-seed: gh could not set the ${LOGINS_NAME} secret (${this.reason}) — nothing was changed.`
			: `preview-seed: the ${LOGINS_NAME} secret was set but gh could not set the variable (${this.reason}) — the two now disagree, so previews deployed from here on are seeded with logins no agent can fetch. Re-run this command; it replaces both.`;
	}
}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const firstLine = (text: string): string =>
	(text.split("\n").find((line) => line.trim() !== "") ?? "").trim();

/**
 * Hand one store its value through `gh`. The value travels on stdin and never as an argument, so
 * it is in no process listing and no shell history, and `gh`'s stdout is read and dropped.
 */
const ghSetLogins =
	(repo: string | null) => (store: LoginStore, value: Redacted.Redacted<string>) =>
		Effect.scoped(
			Effect.gen(function* () {
				const handle = yield* ChildProcess.make(
					"gh",
					[store, "set", LOGINS_NAME, ...(repo === null ? [] : ["--repo", repo])],
					{stdin: Stream.fromIterable([new TextEncoder().encode(Redacted.value(value))])},
				);
				const [, stderr, exitCode] = yield* Effect.all(
					[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
					{concurrency: "unbounded"},
				);
				return (
					exitCode === 0
						? {_tag: "Written"}
						: {_tag: "Refused", reason: firstLine(stderr) || `gh exited ${exitCode}`}
				) satisfies StoreWrite;
			}),
		).pipe(
			Effect.catchTag("PlatformError", (cause) =>
				Effect.succeed<StoreWrite>({
					_tag: "Refused",
					reason: firstLine(cause.message) || "could not run gh",
				}),
			),
		);

const rotate = Command.make(
	"rotate-logins",
	{repo: repoFlag},
	Effect.fn(function* ({repo}) {
		const write = ghSetLogins(Option.getOrNull(repo));
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const outcome = yield* rotateLogins((store, value) =>
			Effect.provideService(write(store, value), ChildProcessSpawner.ChildProcessSpawner, spawner),
		);
		if (outcome._tag === "SecretRefused") {
			return yield* new RotateRefusedError({store: "secret", reason: outcome.reason});
		}
		if (outcome._tag === "VariableRefused") {
			return yield* new RotateRefusedError({store: "variable", reason: outcome.reason});
		}
		yield* Console.log(
			`preview-seed: ok — set the ${LOGINS_NAME} secret and the ${LOGINS_NAME} variable to one fresh set of logins (${outcome.identities.join(", ")}); neither was printed. A preview already deployed keeps its old logins until its next deploy re-seeds it.`,
		);
	}),
).pipe(
	Command.withDescription(
		`Generate a fresh random session token per review-ui test identity and store the set twice on GitHub through gh: as the ${LOGINS_NAME} Actions secret the deploy workflow seeds each preview from, and as the ${LOGINS_NAME} repository variable an agent fetches to sign in — prints neither, and a re-run is the rotation`,
	),
);

const cli = Command.make("preview-seed").pipe(
	Command.withSubcommands([run, testAccount, rotate]),
	Command.withDescription(
		"Direct-D1 seed for the preview stage's unauthenticated read flows (#521) and its per-audience review-ui test accounts (#7051, #7398, #10264)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
