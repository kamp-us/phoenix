/**
 * The `anka-ops` command tree + the shared operator-credential runtime layer.
 *
 * This is the framework-tier skeleton (epic #2089, ADR 0045): the root `anka-ops` command wires
 * the `auth` verb group — reused wholesale from `@kampus/cf-credentials`, so anka-ops rolls NO
 * second credential store — and leaves `VERB_GROUPS` as the single extension point children B
 * (`flag`, #3133) and C (`report`, #3134) fold their groups into. No product verb lands here.
 *
 * The runtime layer is the credential seam every later verb group resolves through: keychain-first
 * (`anka-ops auth login` → OS keychain), falling back to $CLOUDFLARE_API_TOKEN / $CLOUDFLARE_ACCOUNT_ID
 * for CI (the byte-for-byte-unchanged env path). A missing/unauthorized credential surfaces a typed
 * error on the `E` channel, rendered by `NodeRuntime.runMain` in bin.ts — never a raw stack trace.
 */
import {NodeServices} from "@effect/platform-node";
import {
	AccountIdKeychainConfig,
	auth,
	CredentialsKeychainFirst,
	KeychainLive,
} from "@kampus/cf-credentials";
import {FlagshipReadLive, FlagshipWriteLive} from "@kampus/cf-utils";
import {Layer} from "effect";
import {Command} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {flag} from "./flag-command.ts";

/** A verb group folded under the root `anka-ops` command — the ops-language surface descriptor. */
export interface VerbGroup {
	readonly name: string;
	readonly summary: string;
}

/**
 * The registry of shipped verb groups — the single place a child extends the ops language.
 * `flag` folds the cf-utils Flagship core (#3133); `report` (#3134) appends its descriptor here
 * (and its `Command` into {@link ankaOps}'s `withSubcommands`) as it lands.
 */
export const VERB_GROUPS: ReadonlyArray<VerbGroup> = [
	{
		name: "auth",
		summary: "Persist the scoped operator credential (keychain-first) — login/status/logout",
	},
	{
		name: "flag",
		summary: "Read and release Flagship flags — get/open/close/graduate over the cf-utils core",
	},
];

/** The root command. Extension point: child C adds its `Command` to `withSubcommands`. */
export const ankaOps = Command.make("anka-ops").pipe(
	Command.withSubcommands([auth, flag]),
	Command.withDescription(
		"Operator CLI for anka-built apps — scoped ops over hidden infra (epic #2089, ADR 0045)",
	),
);

// The keychain-first credential seam + its account-id ConfigProvider twin, with `KeychainLive`
// underneath and a Node ChildProcessSpawner (for `security`) + Fetch HTTP client (for the
// validating read) below — the SAME wiring shape cf-utils uses (ADR 0045: one shared credential).
const CredentialLayer = Layer.mergeAll(CredentialsKeychainFirst, AccountIdKeychainConfig).pipe(
	Layer.provideMerge(KeychainLive),
);

// The Flagship read/write clients the `flag` verb group resolves through — provided ON TOP of the
// shared credential seam (ADR 0045: one credential), so the fold reuses cf-utils' clients as-is.
const FlagshipClients = Layer.mergeAll(FlagshipReadLive, FlagshipWriteLive);

/** The runtime layer bin.ts provides to `anka-ops`; every verb group resolves through it. */
export const AnkaOpsRuntimeLayer = Layer.provideMerge(
	FlagshipClients,
	CredentialLayer.pipe(Layer.provideMerge(Layer.merge(FetchHttpClient.layer, NodeServices.layer))),
);
