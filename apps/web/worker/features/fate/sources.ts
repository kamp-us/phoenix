/**
 * Barrel composing per-feature `Fate.source` entries into the ARRAY form
 * `FateServer.config` takes (fate is pure transport, ADR 0016; it never queries
 * D1). The registry is keyed by each entry's `definition` OBJECT — fate looks
 * executors up by identity, so entries hold the features' exported definition
 * objects, never copies. `Contribution` and `ReportReceipt` are the
 * capability-less `Fate.syntheticSource` entries (view-reachable — the former via
 * `Profile.contributions`, the latter as `report.submit`'s result — with no fetch
 * path by design).
 *
 * Sources carry NO `connection` executor or `orderBy` contract: every connection
 * — root and nested — is delivered by a custom resolver in `queries.ts` /
 * `lists.ts` calling the service keyset method directly (ADR 0019). See
 * `.patterns/fate-connections.md`, `.patterns/fate-effect-sources.md`.
 */
import {commentSource, postSource, tagSource} from "../pano/sources.ts";
import {
	accountDeletionReceiptSource,
	contributionSource,
	profileSource,
	userSource,
} from "../pasaport/sources.ts";
import {openReportSource, reportReceiptSource, resolveReceiptSource} from "../report/sources.ts";
import {definitionSource, termSource} from "../sozluk/sources.ts";

export const sources = [
	userSource,
	definitionSource,
	termSource,
	postSource,
	commentSource,
	tagSource,
	profileSource,
	contributionSource,
	accountDeletionReceiptSource,
	reportReceiptSource,
	openReportSource,
	resolveReceiptSource,
] as const;
