/**
 * The `anka-ops` command tree + the shared operator-credential runtime layer (ADR 0045). No
 * product verb lands here: this is the framework tier, and children extend it through
 * `VERB_GROUPS`. Credentials are keychain-first, falling back to $CLOUDFLARE_API_TOKEN /
 * $CLOUDFLARE_ACCOUNT_ID for CI.
 */
import {NodeServices} from "@effect/platform-node";
import {
	AccountIdKeychainConfig,
	auth,
	CredentialsKeychainFirst,
	KeychainLive,
} from "@kampus/cf-credentials";
import {Layer} from "effect";
import {Command} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {AnalyticsReadLive} from "./analytics.ts";
import {flag} from "./flag-command.ts";
import {FlagshipReadLive, FlagshipWriteLive} from "./flagship.ts";
import {makeReportCatalog} from "./report.ts";
import {REPORT_CATALOG} from "./report-catalog.ts";
import {report} from "./report-command.ts";

export interface VerbGroup {
	readonly name: string;
	readonly summary: string;
}

/** A new group touches BOTH this registry and `withSubcommands` below. */
export const VERB_GROUPS: ReadonlyArray<VerbGroup> = [
	{
		name: "auth",
		summary: "Persist the scoped operator credential (keychain-first) — login/status/logout",
	},
	{
		name: "flag",
		summary:
			"Read and release Flagship flags — list/get/open/close/graduate over the Flagship core",
	},
	{
		name: "report",
		summary: "Run named AE product-usage reports from an injected catalog (ADR 0153)",
	},
];

export const ankaOps = Command.make("anka-ops").pipe(
	Command.withSubcommands([auth, flag, report]),
	Command.withDescription(
		"Operator CLI for anka-built apps — scoped ops over hidden infra (epic #2089, ADR 0045)",
	),
);

const CredentialLayer = Layer.mergeAll(CredentialsKeychainFirst, AccountIdKeychainConfig).pipe(
	Layer.provideMerge(KeychainLive),
);

// Provided ON TOP of the shared credential seam — one credential across every group (ADR 0045).
const VerbGroupClients = Layer.mergeAll(
	FlagshipReadLive,
	FlagshipWriteLive,
	AnalyticsReadLive,
	makeReportCatalog(REPORT_CATALOG),
);

export const AnkaOpsRuntimeLayer = Layer.provideMerge(
	VerbGroupClients,
	CredentialLayer.pipe(Layer.provideMerge(Layer.merge(FetchHttpClient.layer, NodeServices.layer))),
);
