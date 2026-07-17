/**
 * The one fate server config, consumed at both edges from this single
 * declaration: the `/fate` serving path (`layers.ts` → native interpreter,
 * ADR 0043) and build-time codegen (`schema.ts` → inert handlers, no database).
 * See `.patterns/fate-effect-server.md`, `.patterns/fate-effect-compiler.md`.
 *
 * Each feature contributes its whole fate surface as one `fateModule` (its own
 * `queries`/`lists`/`mutations`/`sources`); the root merges the `modules` array
 * once (`mergeFateModules`) instead of threading every feature through a separate
 * central barrel per category. Registering a feature is this one array entry —
 * see `.patterns/per-feature-fate-aggregators.md`.
 *
 * Import-pure by construction: the record modules capture resolver functions
 * (services are reached per request through the runtime), so importing this
 * module evaluates pure data — the codegen path depends on that.
 *
 * `live` is the publish-only `LiveEventBus` (ADR 0023): fate detects a custom
 * bus by `"subscribe" in live` (the property exists but throws — the SSE
 * protocol is served by the `/fate/live` route + DO, not by fate's
 * `handleLiveRequest`).
 *
 * Sources carry NO `connection` executor or `orderBy` contract: every connection
 * — root and nested — is delivered by a custom resolver in a feature's
 * `queries.ts` / `lists.ts` calling the service keyset method directly (ADR
 * 0019). `Contribution`/`ReportReceipt`/`OpenReport`/`ResolveReceipt` are
 * capability-less `Fate.syntheticSource` entries (view-reachable, no fetch path).
 * See `.patterns/fate-connections.md`, `.patterns/fate-effect-sources.md`.
 */
import {FateServer} from "@kampus/fate-effect";
import {fateModule as adminConsoleModule} from "../admin-console/fate-module.ts";
import {fateModule as bildirimModule} from "../bildirim/fate-module.ts";
import {fateModule as divanModule} from "../divan/fate-module.ts";
import {liveBusConfig} from "../fate-live/event-bus.ts";
import {fateModule as funnelModule} from "../funnel/fate-module.ts";
import {fateModule as mecmuaModule} from "../mecmua/fate-module.ts";
import {fateModule as muteModule} from "../mute/fate-module.ts";
import {fateModule as panoModule} from "../pano/fate-module.ts";
import {fateModule as pasaportModule} from "../pasaport/fate-module.ts";
import {fateModule as reportModule} from "../report/fate-module.ts";
import {fateModule as searchModule} from "../search/fate-module.ts";
import {fateModule as sozlukModule} from "../sozluk/fate-module.ts";
import {fateModule as statsModule} from "../stats/fate-module.ts";
import {fateModule as userAdminModule} from "../user-admin/fate-module.ts";
import {mergeFateModules} from "./module.ts";

// The one feature registry. Drives BOTH the served config (`mergeFateModules` below)
// and the client `Root` map (`views.ts` → `mergeFateRoots`), so registering a feature
// is this single array entry — its queries/lists/mutations/sources AND its roots.
export const modules = [
	statsModule,
	adminConsoleModule,
	pasaportModule,
	sozlukModule,
	panoModule,
	searchModule,
	reportModule,
	divanModule,
	funnelModule,
	bildirimModule,
	mecmuaModule,
	muteModule,
	userAdminModule,
];

export const fateConfig = FateServer.config({
	...mergeFateModules(modules),
	live: liveBusConfig,
});
