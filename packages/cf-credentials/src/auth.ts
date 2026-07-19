/**
 * The `cf-utils auth` surface: `login` acquires Cloudflare credentials by pasting an API
 * token (#1730), validating it with an authenticated read BEFORE persisting and storing it
 * through the macOS Keychain seam. `status` reports where each credential resolves from and
 * whether the effective resolution authenticates; `logout` deletes every stored item.
 * Secrets ride prompts (`Prompt.password`) and the keychain — never argv, shell history, or
 * a dotfile.
 */
import {Console, Effect, Redacted} from "effect";
import {Command, Prompt} from "effect/unstable/cli";
import {credentialSources, validateAmbient, validateCredentials} from "./credentials.ts";
import {ACCOUNT_ID_ACCOUNT, API_TOKEN_ACCOUNT, KEYCHAIN_SERVICE, Keychain} from "./keychain.ts";

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;

const tokenPrompt = Prompt.password({
	message: "Cloudflare API token",
	validate: (value) =>
		value.trim().length > 0 ? Effect.succeed(value.trim()) : Effect.fail("token cannot be empty"),
});

const accountIdPrompt = Prompt.text({
	message: "Cloudflare account id",
	validate: (value) =>
		ACCOUNT_ID_RE.test(value.trim())
			? Effect.succeed(value.trim())
			: Effect.fail("expected a 32-hex-char Cloudflare account id"),
});

const tokenPasteLogin = Effect.fn(function* () {
	const token = yield* tokenPrompt;
	const accountId = yield* accountIdPrompt;

	const apps = yield* validateCredentials(Redacted.value(token), accountId);
	yield* Console.log(`validated — ${apps} Flagship app(s) visible on account ${accountId}`);

	const keychain = yield* Keychain;
	yield* keychain.set(API_TOKEN_ACCOUNT, Redacted.value(token));
	yield* keychain.set(ACCOUNT_ID_ACCOUNT, accountId);
	yield* Console.log(
		`stored in the macOS Keychain (service "${KEYCHAIN_SERVICE}") — every cf-utils command now resolves credentials automatically`,
	);
});

const login = Command.make(
	"login",
	{},
	Effect.fn(function* () {
		yield* tokenPasteLogin();
	}),
).pipe(
	Command.withDescription(
		"Acquire Cloudflare credentials (paste an API token) and store them in the macOS Keychain",
	),
);

const status = Command.make(
	"status",
	{},
	Effect.fn(function* () {
		const sources = yield* credentialSources;
		const describeAccount =
			sources.accountId.value === undefined
				? "(none)"
				: `${sources.accountId.value} (${sources.accountId.source})`;
		yield* Console.log(`api token:  ${sources.apiToken}`);
		yield* Console.log(`account id: ${describeAccount}`);

		if (sources.apiToken === "missing" || sources.accountId.value === undefined) {
			yield* Console.log(
				"validation: skipped — run `cf-utils auth login` (or export $CLOUDFLARE_API_TOKEN / $CLOUDFLARE_ACCOUNT_ID)",
			);
			return;
		}

		// Validate through the SAME ambient (keychain-first, env-fallback) resolution every flag
		// command uses, so a green status proves `flag list` et al. will authenticate too.
		yield* validateAmbient(sources.accountId.value).pipe(
			Effect.matchEffect({
				onSuccess: (apps) => Console.log(`validation: ok — ${apps} Flagship app(s) visible`),
				onFailure: (error) =>
					Console.log(
						`validation: FAILED — ${error instanceof Error ? error.message : String(error)}`,
					),
			}),
		);
	}),
).pipe(
	Command.withDescription(
		"Report where credentials resolve from (keychain vs env) and whether they authenticate",
	),
);

const logout = Command.make(
	"logout",
	{},
	Effect.fn(function* () {
		const keychain = yield* Keychain;
		const removed = yield* Effect.all(
			[keychain.remove(API_TOKEN_ACCOUNT), keychain.remove(ACCOUNT_ID_ACCOUNT)],
			{concurrency: 1},
		);
		yield* Console.log(
			removed.some((wasRemoved) => wasRemoved)
				? "removed stored Cloudflare credentials from the macOS Keychain"
				: "nothing stored — the keychain had no cf-utils credentials",
		);
	}),
).pipe(Command.withDescription("Remove the stored Cloudflare credentials from the macOS Keychain"));

export const auth = Command.make("auth").pipe(
	Command.withSubcommands([login, status, logout]),
	Command.withDescription(
		"Persist Cloudflare credentials once (keychain-backed) — login/status/logout",
	),
);
