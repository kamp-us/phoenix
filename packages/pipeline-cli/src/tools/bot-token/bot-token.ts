/**
 * The `bot-token` core — mint a phoenix[bot] GitHub App INSTALLATION access token.
 *
 * Operationalizes ADR 0140: the pipeline authenticates as the `phoenix[bot]` GitHub
 * App via a short-lived installation access token (not a long-lived PAT) to author
 * PR-open + merge-queue enqueue under the bot identity. See ADR 0140 for the why.
 *
 * Two pure, injectable pieces so the whole flow is unit-testable without a live App:
 *   - `buildAppJwt` — a signed RS256 JWT (the App-auth credential), given the App id,
 *     the PEM, and `now` (injected clock). No IO.
 *   - `mintInstallationToken` — POSTs the installation access-token endpoint with the
 *     JWT as a Bearer, given an injected `fetch`. Returns the `ghs_` token string.
 *
 * SECURITY: the token and the PEM are credential material. Neither the PEM nor the
 * minted token is ever returned in an error, logged, or embedded in a message — the
 * whole reason this is a tool and not an inline one-liner (ADR 0140 §1). The command
 * layer prints ONLY the token to stdout.
 */
import {createSign} from "node:crypto";

/** GitHub's installation access-token endpoint response — only `.token` is load-bearing. */
interface AccessTokenResponse {
	readonly token: string;
}

export interface AppJwtInput {
	readonly appId: string;
	readonly privateKeyPem: string;
	/** Injected clock — epoch seconds. Kept a parameter so JWT construction is pure. */
	readonly nowSeconds: number;
}

/** A base64url encoding of a UTF-8 string, no padding (JWT segment encoding, RFC 7515). */
const base64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

/**
 * Build an RS256-signed App JWT: header `{alg:"RS256",typ:"JWT"}`, payload
 * `{iat: now-60, exp: now+540, iss: appId}` (the 60s back-dating absorbs clock skew;
 * the 10-minute window is GitHub's maximum). The signing input
 * `base64url(header).base64url(payload)` is signed with the PEM via `createSign`.
 */
export const buildAppJwt = ({appId, privateKeyPem, nowSeconds}: AppJwtInput): string => {
	const header = base64url(JSON.stringify({alg: "RS256", typ: "JWT"}));
	const payload = base64url(
		JSON.stringify({iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId}),
	);
	const signingInput = `${header}.${payload}`;
	const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem, "base64url");
	return `${signingInput}.${signature}`;
};

/** The minimal `fetch` shape this tool depends on — injectable for tests, satisfied by global `fetch`. */
export type FetchLike = (
	url: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
	},
) => Promise<{
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
}>;

export interface MintInput {
	readonly appId: string;
	readonly installationId: string;
	readonly privateKeyPem: string;
	readonly nowSeconds: number;
	readonly fetch: FetchLike;
}

/**
 * A mint failure carrying ONLY non-secret diagnostic material — the HTTP status and the
 * GitHub API `.message`. Never the JWT, PEM, or a partial token. This is what reaches
 * stderr, so it must stay credential-free by construction.
 */
export class MintError extends Error {
	readonly status: number;
	constructor(status: number, apiMessage: string) {
		super(`bot-token mint failed: HTTP ${status}${apiMessage ? ` — ${apiMessage}` : ""}`);
		this.name = "MintError";
		this.status = status;
	}
}

/** The GitHub API base — the App installation access-token endpoint host. */
const GITHUB_API = "https://api.github.com";

/**
 * Mint an installation access token: build the App JWT, POST
 * `/app/installations/<id>/access_tokens` with it as a Bearer, return the `ghs_` token.
 * Any non-2xx becomes a `MintError` carrying only `status` + the API `.message` (never
 * token material). The response `.token` is valid ~1h.
 */
export const mintInstallationToken = async ({
	appId,
	installationId,
	privateKeyPem,
	nowSeconds,
	fetch,
}: MintInput): Promise<string> => {
	const jwt = buildAppJwt({appId, privateKeyPem, nowSeconds});
	const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${jwt}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "phoenix-pipeline-cli-bot-token",
		},
	});
	const body = await res.text();
	if (!res.ok) {
		// Extract ONLY the API `.message` for the error — never echo the raw body blindly,
		// and never the JWT/PEM. A non-JSON body degrades to an empty message, still safe.
		let apiMessage = "";
		try {
			const parsed = JSON.parse(body) as {message?: unknown};
			apiMessage = typeof parsed.message === "string" ? parsed.message : "";
		} catch {
			apiMessage = "";
		}
		throw new MintError(res.status, apiMessage);
	}
	const parsed = JSON.parse(body) as AccessTokenResponse;
	if (typeof parsed.token !== "string" || parsed.token.length === 0) {
		throw new MintError(res.status, "response missing .token");
	}
	return parsed.token;
};

/** Default OUT-OF-REPO cred locations — the local-path provisioning shape (ADR 0140). */
export const DEFAULT_KEY_PATH = "~/.config/phoenix-bot/private-key.pem";
export const DEFAULT_CONFIG_PATH = "~/.config/phoenix-bot/config.json";

/**
 * Expand a leading `~` / `$HOME` to the home dir (`home` injected so it's pure). Only a
 * leading `~/` or `~` is expanded — a `~` mid-path is left untouched. An absolute or
 * relative path passes through unchanged.
 */
export const expandHome = (path: string, home: string): string => {
	if (path === "~") return home;
	if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
	if (path.startsWith("$HOME/")) return `${home}/${path.slice("$HOME/".length)}`;
	return path;
};

export interface KeySourceInput {
	/** `--private-key` / env `PHOENIX_BOT_PRIVATE_KEY` — PEM CONTENT (secret-injection case). */
	readonly privateKey?: string | undefined;
	/** `--private-key-path` / env `PHOENIX_BOT_PRIVATE_KEY_PATH` — a PEM file path. */
	readonly privateKeyPath?: string | undefined;
}

export type KeyResolution =
	| {readonly _tag: "File"; readonly path: string}
	| {readonly _tag: "Inline"; readonly pem: string}
	| {readonly _tag: "Error"; readonly message: string};

/**
 * Resolve the PEM source. `--private-key` (inline content, e.g. a secret-manager value)
 * and `--private-key-path` (a file path) are the two sources; giving BOTH is an error. If
 * NEITHER is set, fall back to the well-known local path `DEFAULT_KEY_PATH` — the local-path
 * provisioning shape (ADR 0140): creds live OUT of the repo under `~/.config/phoenix-bot/`,
 * so a path source always exists by default. The caller reads the file for the `File` case
 * (kept out of this pure resolver so precedence is testable without touching the filesystem).
 */
export const resolveKeySource = ({privateKey, privateKeyPath}: KeySourceInput): KeyResolution => {
	const hasInline = typeof privateKey === "string" && privateKey.length > 0;
	const hasPath = typeof privateKeyPath === "string" && privateKeyPath.length > 0;
	if (hasInline && hasPath) {
		return {
			_tag: "Error",
			message: "both --private-key and --private-key-path given — provide exactly one PEM source",
		};
	}
	if (hasInline) {
		return {_tag: "Inline", pem: privateKey as string};
	}
	// path given, or neither → the well-known local default (local-path shape).
	return {_tag: "File", path: hasPath ? (privateKeyPath as string) : DEFAULT_KEY_PATH};
};

export interface BotConfigInput {
	/** Flag or env value — highest precedence. */
	readonly appId?: string | undefined;
	readonly installationId?: string | undefined;
	/** Parsed `~/.config/phoenix-bot/config.json` contents (optional fallback). */
	readonly configFile?: {readonly appId?: unknown; readonly installationId?: unknown} | undefined;
}

export type IdResolution =
	| {readonly _tag: "Ok"; readonly appId: string; readonly installationId: string}
	| {readonly _tag: "Error"; readonly message: string};

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Resolve `appId` + `installationId` with precedence flag/env > config-file. Both are
 * non-secret but kept OUT of committed source — sourced from env or the gitignored
 * out-of-repo `~/.config/phoenix-bot/config.json` (ADR 0140). A missing id is a clear error.
 */
export const resolveIds = ({appId, installationId, configFile}: BotConfigInput): IdResolution => {
	const resolvedAppId = nonEmpty(appId)
		? appId
		: nonEmpty(configFile?.appId)
			? configFile.appId
			: undefined;
	const resolvedInstallationId = nonEmpty(installationId)
		? installationId
		: nonEmpty(configFile?.installationId)
			? configFile.installationId
			: undefined;
	if (!nonEmpty(resolvedAppId)) {
		return {
			_tag: "Error",
			message:
				"no app id — set --app-id, env PHOENIX_BOT_APP_ID, or appId in ~/.config/phoenix-bot/config.json",
		};
	}
	if (!nonEmpty(resolvedInstallationId)) {
		return {
			_tag: "Error",
			message:
				"no installation id — set --installation-id, env PHOENIX_BOT_INSTALLATION_ID, or installationId in ~/.config/phoenix-bot/config.json",
		};
	}
	return {_tag: "Ok", appId: resolvedAppId, installationId: resolvedInstallationId};
};
