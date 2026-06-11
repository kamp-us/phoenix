/**
 * The one fate server config (`.patterns/fate-effect-server.md`,
 * `.patterns/fate-effect-compiler.md`).
 *
 * `FateServer.config` mirrors `createFateServer`'s options shape; every record
 * value is a `Fate.query`/`Fate.list`/`Fate.mutation`/`Fate.source` entry
 * composed from the per-feature aggregator barrels (`queries.ts`/`lists.ts`/
 * `mutations.ts`/`sources.ts`).
 *
 * The config is consumed at BOTH edges from this single declaration:
 *
 *   - **live** — `PhoenixFateLive` (`layers.ts`) wraps it in
 *     `FateServer.layer(fateConfig)`; the `/fate` route serves the resolved
 *     service through the native interpreter (`FateInterpreter.handleRequest`,
 *     ADR 0043).
 *   - **build time** — `schema.ts` exports
 *     `FateExecutor.toCodegenServer(fateConfig)` for the fate Vite plugin: same
 *     record keys, same `type` strings, inert handlers, no database.
 *
 * Import-pure by construction: the record modules capture resolver functions
 * (services are reached per request through the runtime), so importing this
 * module evaluates pure data — the codegen path depends on that.
 *
 * `live` is the publish-only `LiveEventBus` (ADR 0023): fate detects a custom
 * bus by `"subscribe" in live` (the property exists but throws — the SSE
 * protocol is served by the `/fate/live` route + DO, not by fate's
 * `handleLiveRequest`). See `worker/features/fate-live/event-bus.ts`.
 */
import {FateServer} from "@phoenix/fate-effect";
import {liveBusConfig} from "../fate-live/event-bus.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {sources} from "./sources.ts";

/**
 * The composed config: sozluk (`term`/`terms`/`definition.*`) + pano
 * (`post`/`posts`/`post.*`/`comment.*`) + pasaport (`me`/`profile`/
 * `user.setUsername`) + stats (`landingStats`/`health`), with the
 * `Fate.source` entries for every relation-fetchable entity.
 */
export const fateConfig = FateServer.config({
	queries,
	lists,
	mutations,
	sources,
	live: liveBusConfig,
});
