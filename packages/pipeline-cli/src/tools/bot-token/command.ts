/**
 * The `bot-token` tool — `pipeline-cli bot-token mint`.
 *
 * Mints a phoenix[bot] GitHub App INSTALLATION access token (JWT RS256 → installation
 * access token) for the pipeline's bot-authored PR-open + merge-queue enqueue. See
 * ADR 0140 for the why (short-lived installation token, no long-lived PAT; the bot is
 * the distinct PR author so any @kamp-us/control-plane member may approve).
 *
 * OUTPUT CONTRACT (security-critical): print ONLY the `ghs_` token to STDOUT, so a
 * caller does `GH_TOKEN=$(node packages/pipeline-cli/src/bin.ts bot-token mint) gh pr
 * create …`. The PEM is NEVER printed. The token is NEVER logged to stderr. Errors go
 * to stderr as generic messages (HTTP status + the GitHub API `.message` only, never
 * token material) with a non-zero exit. This is the whole reason it's a tool and not an
 * inline one-liner — the PEM/token never enter a log.
 *
 * Provisioning (ADR 0140) — multi-machine, LOCAL-PATH per machine (the settled model;
 * no shared secret manager). The pipeline runs on ≥2 machines (each operator runs their
 * own instance), so the PEM lives on each machine out of the repo at
 * `~/.config/phoenix-bot/private-key.pem` (override `PHOENIX_BOT_PRIVATE_KEY_PATH`); ids
 * come from env `PHOENIX_BOT_APP_ID`/`PHOENIX_BOT_INSTALLATION_ID` or the out-of-repo
 * `~/.config/phoenix-bot/config.json`. No cred literal is ever committed. The helper stays
 * storage-agnostic — it also takes the PEM as CONTENT via `--private-key` (env
 * `PHOENIX_BOT_PRIVATE_KEY`), co-equal with the path, so a future shared secret manager
 * drops in with zero code change (resolve the value in the caller). See the README runbook.
 *
 * Inputs (each flag → env fallback via `Flag.withFallbackConfig`; ids also fall back to
 * the config file; precedence flag/env > config-file):
 *   - `--app-id` / `PHOENIX_BOT_APP_ID`
 *   - `--installation-id` / `PHOENIX_BOT_INSTALLATION_ID`
 *   - PEM source (at most one of): `--private-key-path` / `PHOENIX_BOT_PRIVATE_KEY_PATH`
 *     (file path, default `~/.config/phoenix-bot/private-key.pem`) OR `--private-key` /
 *     `PHOENIX_BOT_PRIVATE_KEY` (PEM content, for secret injection).
 *   - `--config-path` / `PHOENIX_BOT_CONFIG_PATH` (default `~/.config/phoenix-bot/config.json`).
 *
 * No cred literal (app id / installation id / PEM) is ever committed — they live only in
 * env or the out-of-repo config; the tool source carries none.
 */
import {readFileSync} from "node:fs";
import {homedir} from "node:os";
import {Config, Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {
	DEFAULT_CONFIG_PATH,
	expandHome,
	MintError,
	mintInstallationToken,
	resolveIds,
	resolveKeySource,
} from "./bot-token.ts";

const appIdFlag = Flag.string("app-id").pipe(
	Flag.withFallbackConfig(Config.string("PHOENIX_BOT_APP_ID")),
	Flag.optional,
	Flag.withDescription("GitHub App id (env PHOENIX_BOT_APP_ID, or config.json)"),
);
const installationIdFlag = Flag.string("installation-id").pipe(
	Flag.withFallbackConfig(Config.string("PHOENIX_BOT_INSTALLATION_ID")),
	Flag.optional,
	Flag.withDescription(
		"GitHub App installation id (env PHOENIX_BOT_INSTALLATION_ID, or config.json)",
	),
);
const privateKeyPathFlag = Flag.string("private-key-path").pipe(
	Flag.withFallbackConfig(Config.string("PHOENIX_BOT_PRIVATE_KEY_PATH")),
	Flag.optional,
	Flag.withDescription(
		"Path to the App private-key PEM file (env PHOENIX_BOT_PRIVATE_KEY_PATH, default ~/.config/phoenix-bot/private-key.pem)",
	),
);
const privateKeyFlag = Flag.string("private-key").pipe(
	Flag.withFallbackConfig(Config.string("PHOENIX_BOT_PRIVATE_KEY")),
	Flag.optional,
	Flag.withDescription("App private-key PEM content, for CI secrets (env PHOENIX_BOT_PRIVATE_KEY)"),
);
const configPathFlag = Flag.string("config-path").pipe(
	Flag.withFallbackConfig(Config.string("PHOENIX_BOT_CONFIG_PATH")),
	Flag.optional,
	Flag.withDescription(
		"Path to {appId, installationId} JSON (env PHOENIX_BOT_CONFIG_PATH, default ~/.config/phoenix-bot/config.json)",
	),
);

// A generic, credential-free failure that carries only a message to stderr + exit 1.
// MintError already scrubs to status + API message; input/read faults surface here.
class BotTokenFailure {
	readonly _tag = "BotTokenFailure";
	readonly message: string;
	constructor(message: string) {
		this.message = message;
	}
}

const readPemFileOrFail = (path: string): Effect.Effect<string, BotTokenFailure> =>
	Effect.try({
		try: () => readFileSync(expandHome(path, homedir()), "utf8"),
		// The path is a user-supplied/well-known location, safe to echo; the file CONTENT
		// (the PEM) is not touched in the error — only the failing path + a generic reason.
		catch: () => new BotTokenFailure(`cannot read private-key file: ${path}`),
	});

/** Read + parse the optional `{appId, installationId}` config JSON; a missing/unreadable/malformed file is a soft null (ids may still come from env/flags). */
const readConfigFile = (
	path: string,
): Effect.Effect<{appId?: unknown; installationId?: unknown} | undefined> =>
	Effect.sync(() => {
		try {
			const parsed = JSON.parse(readFileSync(expandHome(path, homedir()), "utf8"));
			return parsed && typeof parsed === "object"
				? (parsed as {appId?: unknown; installationId?: unknown})
				: undefined;
		} catch {
			return undefined;
		}
	});

const mint = Command.make(
	"mint",
	{
		appId: appIdFlag,
		installationId: installationIdFlag,
		privateKeyPath: privateKeyPathFlag,
		privateKey: privateKeyFlag,
		configPath: configPathFlag,
	},
	(args) => {
		const run = Effect.gen(function* () {
			const source = resolveKeySource({
				...(args.privateKey._tag === "Some" ? {privateKey: args.privateKey.value} : {}),
				...(args.privateKeyPath._tag === "Some" ? {privateKeyPath: args.privateKeyPath.value} : {}),
			});
			if (source._tag === "Error") {
				return yield* Effect.fail(new BotTokenFailure(source.message));
			}
			const privateKeyPem =
				source._tag === "File" ? yield* readPemFileOrFail(source.path) : source.pem;

			const configFile = yield* readConfigFile(
				args.configPath._tag === "Some" ? args.configPath.value : DEFAULT_CONFIG_PATH,
			);
			const ids = resolveIds({
				...(args.appId._tag === "Some" ? {appId: args.appId.value} : {}),
				...(args.installationId._tag === "Some" ? {installationId: args.installationId.value} : {}),
				...(configFile ? {configFile} : {}),
			});
			if (ids._tag === "Error") {
				return yield* Effect.fail(new BotTokenFailure(ids.message));
			}

			const token = yield* Effect.tryPromise({
				try: () =>
					mintInstallationToken({
						appId: ids.appId,
						installationId: ids.installationId,
						privateKeyPem,
						nowSeconds: Math.floor(Date.now() / 1000),
						fetch: globalThis.fetch,
					}),
				catch: (cause) =>
					// MintError is pre-scrubbed (status + API message only). Any other cause is
					// a network/transport fault; stringify it generically, never the PEM/token.
					new BotTokenFailure(
						cause instanceof MintError ? cause.message : `bot-token mint failed: ${String(cause)}`,
					),
			});

			// The ONLY stdout write — the bare token, so `$(… bot-token mint)` captures it clean.
			yield* Console.log(token);
		});

		return run.pipe(
			Effect.catchTag("BotTokenFailure", (e) =>
				Effect.sync(() => {
					process.stderr.write(`${e.message}\n`);
					process.exit(1);
				}),
			),
		);
	},
).pipe(
	Command.withDescription(
		"Mint a phoenix[bot] installation access token (ADR 0140) — prints only the ghs_ token to stdout",
	),
);

export const botTokenCommand = Command.make("bot-token").pipe(
	Command.withSubcommands([mint]),
	Command.withDescription("phoenix[bot] GitHub App installation-token minting (ADR 0140)"),
);
