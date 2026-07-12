/**
 * `admin-grant` — the offline D1 CLI that grants/revokes platform-admin authority by
 * minting/dropping the `(subject, "admin", "platform:platform")` relation tuple (ADR
 * 0107). The ONLY sanctioned grant path: a server-side direct-D1 script, never a
 * runtime worker route (the deleted `/api/admin/*` fail-open shape). The
 * `effect/unstable/cli` tooling idiom, mirroring `@kampus/moderator-grant` /
 * `@kampus/founder-seed`; transport is the D1 REST query API over alchemy's already
 * installed `@distilled.cloud/cloudflare` (zero new deps).
 *
 * Parameterized on the TARGET stage's D1 (never prod-hardcoded):
 *   node src/bin.ts grant  --username <handle> --database-id <uuid> [--account-id <acct>]
 *   node src/bin.ts grant  --user-id <id>      --database-id <uuid>
 *   node src/bin.ts revoke --username <handle> --database-id <uuid>
 *   node src/bin.ts list                       --database-id <uuid>
 *   $CLOUDFLARE_API_TOKEN  the minted token (carries D1 Write) — read by CredentialsFromEnv
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {makeD1Rest} from "@kampus/d1-rest";
import {Config, Console, Effect, Layer, Option, Schema} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {assignAdmin, listAdmins, makeGrantDb, revokeAdmin, type Selector} from "./grant.ts";

class SelectorRequired extends Schema.TaggedErrorClass<SelectorRequired>()(
	"@kampus/admin-grant/SelectorRequired",
	{message: Schema.String},
) {}

/** A D1 REST call (grant/revoke/list over the query API) rejected — network/HTTP fault. */
class D1RestError extends Schema.TaggedErrorClass<D1RestError>()(
	"@kampus/admin-grant/D1RestError",
	{
		cause: Schema.Defect(),
	},
) {}

const databaseIdFlag = Flag.string("database-id").pipe(
	Flag.withDescription("the target stage's D1 database UUID"),
);
const accountIdFlag = Flag.string("account-id").pipe(
	Flag.optional,
	Flag.withDescription("Cloudflare account id (default: $CLOUDFLARE_ACCOUNT_ID)"),
);
const usernameFlag = Flag.string("username").pipe(
	Flag.optional,
	Flag.withDescription("select the user by username (handle)"),
);
const userIdFlag = Flag.string("user-id").pipe(
	Flag.optional,
	Flag.withDescription("select the user by id"),
);

const restLayer = Layer.merge(CredentialsFromEnv, FetchHttpClient.layer);

const resolveAccount = (accountId: Option.Option<string>) =>
	Option.isSome(accountId)
		? Effect.succeed(accountId.value)
		: Config.string("CLOUDFLARE_ACCOUNT_ID");

const resolveSelector = (username: Option.Option<string>, userId: Option.Option<string>) => {
	if (Option.isSome(username))
		return Effect.succeed<Selector>({by: "username", value: username.value});
	if (Option.isSome(userId)) return Effect.succeed<Selector>({by: "id", value: userId.value});
	return Effect.fail(
		new SelectorRequired({message: "pass exactly one of --username or --user-id"}),
	);
};

const makeDb = (accountId: string, databaseId: string) =>
	makeGrantDb(makeD1Rest({accountId, databaseId, layer: restLayer}));

const grant = Command.make(
	"grant",
	{
		databaseId: databaseIdFlag,
		accountId: accountIdFlag,
		username: usernameFlag,
		userId: userIdFlag,
	},
	Effect.fn(function* ({databaseId, accountId, username, userId}) {
		const account = yield* resolveAccount(accountId);
		const selector = yield* resolveSelector(username, userId);
		const db = makeDb(account, databaseId);
		const res = yield* Effect.tryPromise({
			try: () => assignAdmin(db, selector),
			catch: (cause) => new D1RestError({cause}),
		});
		yield* res.subject === null
			? Console.log(`admin-grant: no user matched ${selector.by}=${selector.value} (no change)`)
			: res.inserted > 0
				? Console.log(
						`admin-grant: ok — ${selector.by}=${selector.value} (${res.subject}) is now an admin (D1 ${databaseId})`,
					)
				: Console.log(
						`admin-grant: ${selector.by}=${selector.value} (${res.subject}) was already an admin (no change)`,
					);
	}),
).pipe(
	Command.withDescription("Grant platform-admin authority to a user (by --username or --user-id)"),
);

const revoke = Command.make(
	"revoke",
	{
		databaseId: databaseIdFlag,
		accountId: accountIdFlag,
		username: usernameFlag,
		userId: userIdFlag,
	},
	Effect.fn(function* ({databaseId, accountId, username, userId}) {
		const account = yield* resolveAccount(accountId);
		const selector = yield* resolveSelector(username, userId);
		const db = makeDb(account, databaseId);
		const res = yield* Effect.tryPromise({
			try: () => revokeAdmin(db, selector),
			catch: (cause) => new D1RestError({cause}),
		});
		yield* res.subject === null
			? Console.log(`admin-grant: no user matched ${selector.by}=${selector.value} (no change)`)
			: res.removed > 0
				? Console.log(
						`admin-grant: ok — ${selector.by}=${selector.value} (${res.subject}) admin revoked (D1 ${databaseId})`,
					)
				: Console.log(
						`admin-grant: ${selector.by}=${selector.value} (${res.subject}) was not an admin (no change)`,
					);
	}),
).pipe(Command.withDescription("Revoke platform-admin authority (drop the admin tuple)"));

const list = Command.make(
	"list",
	{databaseId: databaseIdFlag, accountId: accountIdFlag},
	Effect.fn(function* ({databaseId, accountId}) {
		const account = yield* resolveAccount(accountId);
		const db = makeDb(account, databaseId);
		const admins = yield* Effect.tryPromise({
			try: () => listAdmins(db),
			catch: (cause) => new D1RestError({cause}),
		});
		yield* Console.log(
			admins.length === 0
				? "admin-grant: no admins"
				: `admin-grant: ${admins.length} admin(s):\n${admins.map((a) => `  - ${a.subject}`).join("\n")}`,
		);
	}),
).pipe(Command.withDescription("List the current platform admins"));

const cli = Command.make("admin-grant").pipe(
	Command.withSubcommands([grant, revoke, list]),
	Command.withDescription(
		'Offline D1 grant/revoke of platform-admin authority — the (subject, "admin", "platform:platform") tuple (ADR 0107)',
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
