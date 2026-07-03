/**
 * The `cf-utils auth` surface: `login` acquires Cloudflare credentials two ways — a browser
 * OAuth flow (`--oauth`, #1761, in the `wrangler login` mold: authorize in the browser, no
 * secret ever crosses the terminal) or the pasted API token (#1730, the default). Both
 * validate with an authenticated read BEFORE persisting and store through the SAME macOS
 * Keychain seam. `status` reports where each credential resolves from (and how it was
 * acquired) and whether the effective resolution authenticates; `logout` deletes every stored
 * item. Secrets ride the browser, prompts (`Prompt.password`), and the keychain — never argv,
 * shell history, or a dotfile.
 */
import {Console, Effect, Redacted} from "effect";
import {Command, Flag, Prompt} from "effect/unstable/cli";
import {
	credentialSources,
	persistOAuthTokens,
	validateCredentials,
	validateOAuthCredentials,
} from "./credentials.ts";
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
import {OAuthFlowError, oauthClientId, runBrowserLogin} from "./oauth.ts";

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

const oauthFlag = Flag.boolean("oauth").pipe(
	Flag.withDescription(
		"authorize in the browser (Authorization-Code + PKCE) instead of pasting an API token — no secret crosses the terminal",
	),
);

// The pasted-token path (#1730): prompt for the token + account id, validate, store. Unchanged.
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

// The browser-OAuth path (#1761): prompt only the (non-secret) account id, authorize in the
// browser, then persist the acquired access + refresh token through the same keychain seam.
const oauthLogin = Effect.fn(function* () {
	const accountId = yield* accountIdPrompt;
	const clientId = yield* oauthClientId.pipe(
		Effect.mapError(
			(error) =>
				new OAuthFlowError({
					reason: `no OAuth client id — set $CF_UTILS_OAUTH_CLIENT_ID to the public PKCE client registered in the Cloudflare dashboard (see packages/cf-utils/README.md): ${error.message ?? String(error)}`,
				}),
		),
	);

	yield* Console.log("opening your browser to authorize with Cloudflare…");
	const tokens = yield* runBrowserLogin(clientId, (url) =>
		Console.log(`  if it doesn't open, visit:\n  ${url}`),
	);

	const apps = yield* validateOAuthCredentials(tokens, accountId);
	yield* Console.log(`validated — ${apps} Flagship app(s) visible on account ${accountId}`);

	const keychain = yield* Keychain;
	yield* persistOAuthTokens(tokens);
	yield* keychain.set(ACCOUNT_ID_ACCOUNT, accountId);
	yield* Console.log(
		`stored in the macOS Keychain (service "${KEYCHAIN_SERVICE}") — every cf-utils command now resolves credentials automatically (refreshed on expiry)`,
	);
});

const login = Command.make(
	"login",
	{oauth: oauthFlag},
	Effect.fn(function* ({oauth}) {
		yield* oauth ? oauthLogin() : tokenPasteLogin();
	}),
).pipe(
	Command.withDescription(
		"Acquire Cloudflare credentials and store them in the macOS Keychain — browser OAuth (--oauth) or pasted API token (default)",
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
		// Surface HOW a keychain token was acquired (browser OAuth vs pasted) so `status` reflects
		// the #1761 provenance consistently with the keychain | env | missing model.
		const describeToken =
			sources.apiTokenKind === undefined
				? sources.apiToken
				: `${sources.apiToken} (${sources.apiTokenKind})`;
		yield* Console.log(`api token:  ${describeToken}`);
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
		// Clear every stored item — the pasted token, the account id, AND the OAuth token triple
		// (#1761) — so logout is a clean slate regardless of which login path was used.
		const removed = yield* Effect.all([
			keychain.remove(API_TOKEN_ACCOUNT),
			keychain.remove(ACCOUNT_ID_ACCOUNT),
			keychain.remove(OAUTH_ACCESS_TOKEN_ACCOUNT),
			keychain.remove(OAUTH_REFRESH_TOKEN_ACCOUNT),
			keychain.remove(OAUTH_EXPIRES_AT_ACCOUNT),
		]);
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
