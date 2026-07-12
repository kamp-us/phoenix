/**
 * `moderator-grant` — the offline D1 CLI that flips `user.role` to `moderator`
 * (ADR 0098 §1). The ONLY sanctioned grant path: a server-side direct-D1 script,
 * never a runtime worker route (the deleted `/api/admin/*` fail-open shape). The
 * `effect/unstable/cli` tooling idiom, mirroring `@kampus/preview-seed` /
 * `@kampus/leak-guard`; transport is the D1 REST query API over alchemy's already
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
import {listModerators, makeGrantDb, type Selector, setRole} from "./grant.ts";

class SelectorRequired extends Schema.TaggedErrorClass<SelectorRequired>()(
	"@kampus/moderator-grant/SelectorRequired",
	{message: Schema.String},
) {}

/** A D1 REST call (set-role/list over the query API) rejected — network/HTTP fault. */
class D1RestError extends Schema.TaggedErrorClass<D1RestError>()(
	"@kampus/moderator-grant/D1RestError",
	{cause: Schema.Defect()},
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
			try: () => setRole(db, selector, "moderator"),
			catch: (cause) => new D1RestError({cause}),
		});
		yield* res.changed > 0
			? Console.log(
					`moderator-grant: ok — ${selector.by}=${selector.value} is now a moderator (D1 ${databaseId})`,
				)
			: Console.log(
					`moderator-grant: no user matched ${selector.by}=${selector.value} (no change)`,
				);
	}),
).pipe(Command.withDescription("Grant the moderator role to a user (by --username or --user-id)"));

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
			try: () => setRole(db, selector, "member"),
			catch: (cause) => new D1RestError({cause}),
		});
		yield* res.changed > 0
			? Console.log(
					`moderator-grant: ok — ${selector.by}=${selector.value} reverted to member (D1 ${databaseId})`,
				)
			: Console.log(
					`moderator-grant: no user matched ${selector.by}=${selector.value} (no change)`,
				);
	}),
).pipe(Command.withDescription("Revoke the moderator role (set back to member)"));

const list = Command.make(
	"list",
	{databaseId: databaseIdFlag, accountId: accountIdFlag},
	Effect.fn(function* ({databaseId, accountId}) {
		const account = yield* resolveAccount(accountId);
		const db = makeDb(account, databaseId);
		const mods = yield* Effect.tryPromise({
			try: () => listModerators(db),
			catch: (cause) => new D1RestError({cause}),
		});
		yield* Console.log(
			mods.length === 0
				? "moderator-grant: no moderators"
				: `moderator-grant: ${mods.length} moderator(s):\n${mods.map((m) => `  - ${m.username ?? "(no username)"} (${m.id})`).join("\n")}`,
		);
	}),
).pipe(Command.withDescription("List the current moderators"));

const cli = Command.make("moderator-grant").pipe(
	Command.withSubcommands([grant, revoke, list]),
	Command.withDescription("Offline D1 grant/revoke of the moderator role (ADR 0098)"),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
