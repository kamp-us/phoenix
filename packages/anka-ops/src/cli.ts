/**
 * The `anka-ops` command tree + the shared operator-credential runtime layer.
 *
 * This is the framework-tier skeleton (epic #2089, ADR 0045): the root `anka-ops` command wires
 * the `auth`, `flag`, and `report` verb groups — `auth` reused wholesale from `@kampus/cf-credentials`
 * so anka-ops rolls NO second credential store — and leaves `VERB_GROUPS` as the single extension
 * point children fold their groups into. No product verb (no flag, no report content) lands here.
 *
 * The runtime layer is the credential seam every verb group resolves through: keychain-first
 * (`anka-ops auth login` → OS keychain), falling back to $CLOUDFLARE_API_TOKEN / $CLOUDFLARE_ACCOUNT_ID
 * for CI (the byte-for-byte-unchanged env path). A missing/unauthorized credential surfaces a typed
 * error on the `E` channel, rendered by `NodeRuntime.runMain` in bin.ts — never a raw stack trace.
 * `report` resolves the injected `ReportCatalog` (empty in the core) + the AE read client through it.
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
import {AnalyticsReadLive} from "./analytics.ts";
import {flag} from "./flag-command.ts";
import {makeReportCatalog} from "./report.ts";
import {REPORT_CATALOG} from "./report-catalog.ts";
import {report} from "./report-command.ts";

/** A verb group folded under the root `anka-ops` command — the ops-language surface descriptor. */
export interface VerbGroup {
	readonly name: string;
	readonly summary: string;
}

/**
 * The registry of shipped verb groups — the single place a child extends the ops language.
 * `flag` folds the cf-utils Flagship core (#3133); `report` folds the generic AE-read runner over
 * an injected report catalog (#3134). A new group touches both this registry and `withSubcommands`.
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
	{
		name: "report",
		summary: "Run named AE product-usage reports from an injected catalog (ADR 0153)",
	},
];

/** The root command. Extension point: a new group adds its `Command` to `withSubcommands`. */
export const ankaOps = Command.make("anka-ops").pipe(
	Command.withSubcommands([auth, flag, report]),
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

// The per-verb-group clients, all provided ON TOP of the shared credential seam (ADR 0045: one
// credential): cf-utils' Flagship read/write for `flag`, the AE read client for `report`, and the
// injected report catalog (EMPTY in the core — product content is wired via REPORT_CATALOG, ADR 0153).
const VerbGroupClients = Layer.mergeAll(
	FlagshipReadLive,
	FlagshipWriteLive,
	AnalyticsReadLive,
	makeReportCatalog(REPORT_CATALOG),
);

/** The runtime layer bin.ts provides to `anka-ops`; every verb group resolves through it. */
export const AnkaOpsRuntimeLayer = Layer.provideMerge(
	VerbGroupClients,
	CredentialLayer.pipe(Layer.provideMerge(Layer.merge(FetchHttpClient.layer, NodeServices.layer))),
);
