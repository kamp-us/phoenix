/**
 * The one fate server config, consumed at both edges from this single
 * declaration: the `/fate` serving path (`layers.ts` → native interpreter,
 * ADR 0043) and build-time codegen (`schema.ts` → inert handlers, no database).
 * See `.patterns/fate-effect-server.md`, `.patterns/fate-effect-compiler.md`.
 *
 * Import-pure by construction: the record modules capture resolver functions
 * (services are reached per request through the runtime), so importing this
 * module evaluates pure data — the codegen path depends on that.
 *
 * `live` is the publish-only `LiveEventBus` (ADR 0023): fate detects a custom
 * bus by `"subscribe" in live` (the property exists but throws — the SSE
 * protocol is served by the `/fate/live` route + DO, not by fate's
 * `handleLiveRequest`).
 */
import {FateServer} from "@kampus/fate-effect";
import {liveBusConfig} from "../fate-live/event-bus.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {sources} from "./sources.ts";

export const fateConfig = FateServer.config({
	queries,
	lists,
	mutations,
	sources,
	live: liveBusConfig,
});
