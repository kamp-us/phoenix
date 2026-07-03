/**
 * The `cf-utils auth` surface (#1730, extended for OAuth in #1761), in the `gh auth login`
 * mold: `login` acquires a credential — via a browser OAuth flow (`--oauth`, the `wrangler
 * login` model) OR the token-paste prompt (the default) — and stores it in the macOS
 * Keychain; `status` reports what's stored, where each credential resolves from, and whether
 * the effective resolution authenticates; `logout` deletes the stored items. Secrets ride
 * prompts (`Prompt.password`), the browser (OAuth), and the keychain — never argv, shell
 * history, or a dotfile. OAuth authorizes in the browser so no API-token secret ever crosses
 * the terminal (safe to run on a stream).
 */
import {Console, Effect, Redacted} from "effect";
import {Command, Flag, Prompt} from "effect/unstable/cli";
import {credentialSources, validateCredentials, writeOAuthTokens} from "./credentials.ts";
import {FlagshipRead} from "./flagship.ts";
import {
	ACCOUNT_ID_ACCOUNT,
	API_TOKEN_ACCOUNT,
	KEYCHAIN_SERVICE,
	Keychain,
	OAUTH_ACCESS_TOKEN_ACCOUNT,
	OAUTH_EXPIRES_AT_ACCOUNT,
	OAUTH_REFRESH_TOKEN_ACCOUNT,
} from "./keychain.ts";
import {authorize, awaitCallback, FLAGSHIP_OAUTH_SCOPES, openBrowser} from "./oauth.ts";

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

/**
 * The browser OAuth login mode (#1761): mint PKCE + state, open the browser to the CF
 * authorize URL, run the local loopback callback to receive the code, exchange it for an
 * access + refresh token, and persist the set through the keychain seam. The account id is
 * still prompted (the OAuth grant doesn't carry it) and stored alongside, so `flag list` et al.
 * resolve an account without a second setup step.
 */
const oauthLogin = Effect.fn(function* () {
	const auth = authorize(FLAGSHIP_OAUTH_SCOPES);
	yield* Console.log("opening the browser to authorize with Cloudflare…");
	yield* Console.log(`if it doesn't open, visit:\n  ${auth.url}`);
	yield* openBrowser(auth.url);
	yield* Console.log("waiting for the browser authorization (up to 5 minutes)…");
	const tokens = yield* awaitCallback(auth);

	const accountId = yield* accountIdPrompt;

	const keychain = yield* Keychain;
	yield* writeOAuthTokens(keychain, tokens);
	yield* keychain.set(ACCOUNT_ID_ACCOUNT, accountId);
	yield* Console.log(
		`stored the OAuth credentials in the macOS Keychain (service "${KEYCHAIN_SERVICE}") — every cf-utils command now resolves them automatically and refreshes on expiry`,
	);
	yield* Console.log(
		`granted scopes: ${tokens.scopes.length > 0 ? tokens.scopes.join(" ") : "(none reported)"}`,
	);
});

/** The token-paste login mode (#1730), unchanged: prompt, validate before persisting, store. */
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

const oauthFlag = Flag.boolean("oauth").pipe(
	Flag.withDescription(
		"authorize via the browser (OAuth + PKCE, no token paste) instead of prompting for an API token",
	),
);

const login = Command.make(
	"login",
	{oauth: oauthFlag},
	Effect.fn(function* ({oauth}) {
		// Token-paste stays the default (the OAuth Flagship scope is pending founder dashboard
		// confirmation, #1761); `--oauth` opts into the browser flow.
		yield* oauth ? oauthLogin() : tokenPasteLogin();
	}),
).pipe(
	Command.withDescription(
		"Acquire Cloudflare credentials and store them in the macOS Keychain (token-paste by default; --oauth for the browser flow)",
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

		if (sources.apiToken === "missing" || sources.accountId.source === "missing") {
			yield* Console.log(
				"validation: skipped — run `cf-utils auth login` (or export $CLOUDFLARE_API_TOKEN / $CLOUDFLARE_ACCOUNT_ID)",
			);
			return;
		}

		// Validate through the SAME ambient resolution every other command uses, so a green
		// status proves `flag list` et al. will authenticate too.
		const read = yield* FlagshipRead;
		yield* read.listApps().pipe(
			Effect.matchEffect({
				onSuccess: (apps) => Console.log(`validation: ok — ${apps.length} Flagship app(s) visible`),
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
		const removed = yield* Effect.all([
			keychain.remove(API_TOKEN_ACCOUNT),
			keychain.remove(ACCOUNT_ID_ACCOUNT),
			keychain.remove(OAUTH_ACCESS_TOKEN_ACCOUNT),
			keychain.remove(OAUTH_REFRESH_TOKEN_ACCOUNT),
			keychain.remove(OAUTH_EXPIRES_AT_ACCOUNT),
		]);
		yield* Console.log(
			removed.some((r) => r)
				? "removed stored Cloudflare credentials (token-paste and OAuth) from the macOS Keychain"
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
