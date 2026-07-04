/**
 * The `bot-token` tool — `pipeline-cli bot-token mint`.
 *
 * Mints the target org's bot GitHub App INSTALLATION access token (JWT RS256 → installation
 * access token) for the pipeline's bot-authored PR-open + merge-queue enqueue. See ADR 0140
 * for the why (short-lived installation token, no long-lived PAT; the bot is the distinct PR
 * author so any control-plane member may approve).
 *
 * PLUGIN-LEVEL, ORG-DERIVED: the plugin serves N GitHub owners, so the org is DERIVED from the
 * target repo's owner — never a hardcoded org. The repo is resolved by the SAME idiom the
 * skills use: `--repo` flag > env `CLAUDE_PIPELINE_REPO` > `gh repo view --json nameWithOwner`;
 * the org is that repo's owner segment (`resolveOrg`). Creds are keyed by org under
 * `~/.config/kampus-pipeline/<org>/` — each org has its own bot App + its own key material.
 *
 * OUTPUT CONTRACT (security-critical): print ONLY the `ghs_` token to STDOUT, so a caller does
 * `GH_TOKEN=$(node packages/pipeline-cli/src/bin.ts bot-token mint) gh pr create …`. The PEM is
 * NEVER printed. The token is NEVER logged to stderr. Errors go to stderr as generic messages
 * (HTTP status + the GitHub API `.message` only, never token material) with a non-zero exit.
 * This is the whole reason it's a tool and not an inline one-liner — the PEM/token never log.
 *
 * Provisioning (ADR 0140) — rung-1 is LOCAL-PATH per machine, org-keyed: the PEM lives out of
 * every repo at `~/.config/kampus-pipeline/<org>/private-key.pem`; ids at
 * `~/.config/kampus-pipeline/<org>/config.json` (`{appId, installationId}`) or env. Each
 * operator mints their OWN private key (GitHub App multi-key — no PEM transfer). The documented
 * upgrade path is a Cloudflare token-broker: because the helper takes the PEM as CONTENT via
 * `--private-key` (env `KAMPUS_PIPELINE_PRIVATE_KEY`), the broker rides that input with ZERO
 * rework — it supplies the key content in place of the local file. See the README runbook.
 *
 * Inputs (precedence explicit flag > env > org-keyed config file):
 *   - `--repo` / `CLAUDE_PIPELINE_REPO` — force the target repo (else `gh repo view`); org = owner.
 *   - `--app-id` / `KAMPUS_PIPELINE_APP_ID`
 *   - `--installation-id` / `KAMPUS_PIPELINE_INSTALLATION_ID`
 *   - PEM source (at most one override): `--private-key-path` / `KAMPUS_PIPELINE_PRIVATE_KEY_PATH`
 *     (default `~/.config/kampus-pipeline/<org>/private-key.pem`) OR `--private-key` /
 *     `KAMPUS_PIPELINE_PRIVATE_KEY` (PEM content — the broker / secret-injection path).
 *
 * No cred literal (org / app id / installation id / PEM) is ever committed — they live only in
 * env or the out-of-repo org-keyed config; the tool source carries none.
 */
import {execFile} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {homedir} from "node:os";
import {promisify} from "node:util";
import {Config, Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {
	defaultConfigPath,
	defaultKeyPath,
	EXIT_MINT_FAILED,
	EXIT_NOT_CONFIGURED,
	expandHome,
	MintError,
	mintInstallationToken,
	resolveIds,
	resolveKeySource,
	resolveOrg,
} from "./bot-token.ts";

const execFileP = promisify(execFile);

const repoFlag = Flag.string("repo").pipe(
	Flag.withFallbackConfig(Config.string("CLAUDE_PIPELINE_REPO")),
	Flag.optional,
	Flag.withDescription(
		"Target repo owner/name to derive the org from (env CLAUDE_PIPELINE_REPO, else gh repo view)",
	),
);
const appIdFlag = Flag.string("app-id").pipe(
	Flag.withFallbackConfig(Config.string("KAMPUS_PIPELINE_APP_ID")),
	Flag.optional,
	Flag.withDescription("Bot App id (env KAMPUS_PIPELINE_APP_ID, or the org config.json)"),
);
const installationIdFlag = Flag.string("installation-id").pipe(
	Flag.withFallbackConfig(Config.string("KAMPUS_PIPELINE_INSTALLATION_ID")),
	Flag.optional,
	Flag.withDescription(
		"Bot App installation id (env KAMPUS_PIPELINE_INSTALLATION_ID, or the org config.json)",
	),
);
const privateKeyPathFlag = Flag.string("private-key-path").pipe(
	Flag.withFallbackConfig(Config.string("KAMPUS_PIPELINE_PRIVATE_KEY_PATH")),
	Flag.optional,
	Flag.withDescription(
		"Override the PEM file path (env KAMPUS_PIPELINE_PRIVATE_KEY_PATH, default ~/.config/kampus-pipeline/<org>/private-key.pem)",
	),
);
const privateKeyFlag = Flag.string("private-key").pipe(
	Flag.withFallbackConfig(Config.string("KAMPUS_PIPELINE_PRIVATE_KEY")),
	Flag.optional,
	Flag.withDescription(
		"App private-key PEM content — the token-broker / secret-injection path (env KAMPUS_PIPELINE_PRIVATE_KEY)",
	),
);

// A generic, credential-free failure that carries only a message to stderr + exit 1 (mint-failed).
// MintError already scrubs to status + API message; input/read faults surface here.
class BotTokenFailure {
	readonly _tag = "BotTokenFailure";
	readonly message: string;
	constructor(message: string) {
		this.message = message;
	}
}

// The org has NO bot creds at all — not an error, an opt-out signal. Exits 3 (distinct from the
// mint-failed 1) so a caller can fall back to the operator token. See the exit-code contract in
// bot-token.ts. Kept a SEPARATE tag from BotTokenFailure so the two exit codes can't be conflated.
class BotTokenNotConfigured {
	readonly _tag = "BotTokenNotConfigured";
	readonly message: string;
	constructor(message: string) {
		this.message = message;
	}
}

/** Resolve the target repo `owner/name` via `gh repo view` when no --repo/env is given. */
const ghRepoNameWithOwner = (): Effect.Effect<string, BotTokenFailure> =>
	Effect.tryPromise({
		try: async () => {
			const {stdout} = await execFileP("gh", [
				"repo",
				"view",
				"--json",
				"nameWithOwner",
				"-q",
				".nameWithOwner",
			]);
			return stdout.trim();
		},
		catch: () =>
			new BotTokenFailure(
				"cannot resolve the target repo — pass --repo owner/name, set CLAUDE_PIPELINE_REPO, or run inside the repo (gh repo view)",
			),
	});

const readPemFileOrFail = (path: string): Effect.Effect<string, BotTokenFailure> =>
	Effect.try({
		try: () => readFileSync(expandHome(path, homedir()), "utf8"),
		// The path is a well-known/derived location, safe to echo; the file CONTENT (the PEM)
		// is not touched in the error — only the failing path + a generic reason reach stderr.
		catch: () => new BotTokenFailure(`cannot read private-key file: ${path}`),
	});

/**
 * Read + parse the optional org-keyed `{appId, installationId}` config JSON. Reports both the
 * parsed value (a soft `undefined` on missing/unreadable/malformed — ids may still come from
 * env/flags) AND `present`: whether the file EXISTS on disk. Presence is what separates
 * not-configured (no file) from configured-but-broken (file present but unparseable/empty) —
 * the latter must hard-fail (exit 1), never degrade to exit 3.
 */
const readConfigFile = (
	path: string,
): Effect.Effect<{
	present: boolean;
	value: {appId?: unknown; installationId?: unknown} | undefined;
}> =>
	Effect.sync(() => {
		const resolved = expandHome(path, homedir());
		const present = existsSync(resolved);
		if (!present) return {present: false, value: undefined};
		try {
			const parsed = JSON.parse(readFileSync(resolved, "utf8"));
			return {
				present: true,
				value:
					parsed && typeof parsed === "object"
						? (parsed as {appId?: unknown; installationId?: unknown})
						: undefined,
			};
		} catch {
			// Present but unparseable — configured-but-broken. `present:true` forces the hard-fail path.
			return {present: true, value: undefined};
		}
	});

const mint = Command.make(
	"mint",
	{
		repo: repoFlag,
		appId: appIdFlag,
		installationId: installationIdFlag,
		privateKeyPath: privateKeyPathFlag,
		privateKey: privateKeyFlag,
	},
	(args) => {
		const run = Effect.gen(function* () {
			// 1. Resolve the target repo (flag/env, else gh), then DERIVE the org from its owner.
			const repoSlug =
				args.repo._tag === "Some" && args.repo.value.trim().length > 0
					? args.repo.value.trim()
					: yield* ghRepoNameWithOwner();
			const orgRes = resolveOrg(repoSlug);
			if (orgRes._tag === "Error") {
				return yield* Effect.fail(new BotTokenFailure(orgRes.message));
			}
			const org = orgRes.org;

			// 2. Ids: flag > env > the org-keyed config file. Resolved BEFORE any file read so a
			//    genuinely not-configured org exits 3 without a spurious PEM-read failure. A supplied
			//    key override (--private-key[-path] / env) is configuration intent — it flips a missing
			//    id from not-configured to configured-but-broken (hard-fail), never a silent exit-3.
			const keyOverrideSupplied =
				args.privateKey._tag === "Some" || args.privateKeyPath._tag === "Some";
			const configPath = defaultConfigPath(org);
			const config = yield* readConfigFile(configPath);
			const ids = resolveIds({
				configPathForError: configPath,
				configPresent: config.present || keyOverrideSupplied,
				...(args.appId._tag === "Some" ? {appId: args.appId.value} : {}),
				...(args.installationId._tag === "Some" ? {installationId: args.installationId.value} : {}),
				...(config.value ? {configFile: config.value} : {}),
			});
			if (ids._tag === "NotConfigured") {
				return yield* Effect.fail(new BotTokenNotConfigured(ids.message));
			}
			if (ids._tag === "Error") {
				return yield* Effect.fail(new BotTokenFailure(ids.message));
			}

			// 3. PEM source: explicit override, else the org-derived default path. A read failure
			//    here is configured-but-broken (we HAD the ids) → mint-failed (exit 1), never exit 3.
			const source = resolveKeySource({
				defaultPath: defaultKeyPath(org),
				...(args.privateKey._tag === "Some" ? {privateKey: args.privateKey.value} : {}),
				...(args.privateKeyPath._tag === "Some" ? {privateKeyPath: args.privateKeyPath.value} : {}),
			});
			if (source._tag === "Error") {
				return yield* Effect.fail(new BotTokenFailure(source.message));
			}
			const privateKeyPem =
				source._tag === "File" ? yield* readPemFileOrFail(source.path) : source.pem;

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
			// not-configured (exit 3) — an opt-out signal, distinct from mint-failed. Caller may
			// fall back to the operator token. Prefixed so the stderr line is unmistakable.
			Effect.catchTag("BotTokenNotConfigured", (e) =>
				Effect.sync(() => {
					process.stderr.write(`bot-token: ${e.message}\n`);
					process.exit(EXIT_NOT_CONFIGURED);
				}),
			),
			// every other failure (bad key, mint HTTP error, malformed/present config, GitHub reject)
			// stays mint-failed (exit 1) — a configured-but-broken bot must hard-fail, never degrade.
			Effect.catchTag("BotTokenFailure", (e) =>
				Effect.sync(() => {
					process.stderr.write(`${e.message}\n`);
					process.exit(EXIT_MINT_FAILED);
				}),
			),
		);
	},
).pipe(
	Command.withDescription(
		"Mint the target org's bot installation access token (ADR 0140) — prints only the ghs_ token to stdout",
	),
);

export const botTokenCommand = Command.make("bot-token").pipe(
	Command.withSubcommands([mint]),
	Command.withDescription("Per-org bot GitHub App installation-token minting (ADR 0140)"),
);
