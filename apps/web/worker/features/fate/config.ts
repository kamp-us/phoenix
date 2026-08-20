/**
 * The one fate server config, consumed at both edges from this single declaration: the
 * `/fate` serving path (ADR 0043) and build-time codegen. See
 * `.patterns/fate-effect-server.md`, `.patterns/fate-effect-compiler.md`,
 * `.patterns/per-feature-fate-aggregators.md`.
 *
 * Import-pure by construction: the modules capture resolver functions only (services are
 * reached per request), so importing this evaluates pure data — codegen depends on that.
 *
 * `live` is the publish-only `LiveEventBus` (ADR 0023): fate detects a custom bus by
 * `"subscribe" in live` — the property exists but throws, since SSE is served by the
 * `/fate/live` route + DO. Sources carry NO `connection` executor or `orderBy`: every
 * connection is delivered by a feature resolver calling the service keyset method (ADR 0019).
 */
import {FateServer} from "@kampus/fate-effect";
import {fateModule as adminConsoleModule} from "../admin-console/fate-module.ts";
import {fateModule as bildirimModule} from "../bildirim/fate-module.ts";
import {fateModule as caylakVisibilityModule} from "../caylak-visibility/fate-module.ts";
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

// The one feature registry, driving BOTH the served config and the client `Root` map, so
// registering a feature is this single array entry.
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
	caylakVisibilityModule,
	userAdminModule,
];

export const fateConfig = FateServer.config({
	...mergeFateModules(modules),
	live: liveBusConfig,
});
