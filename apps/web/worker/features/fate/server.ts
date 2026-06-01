/**
 * The fate server.
 *
 * `createFateServer` produces plain `Request → Response` handlers
 * (`handleRequest` / `handleLiveRequest`) that the `HttpRouter.add` for the
 * `POST /fate` route invokes directly — no Hono in between. The route hands a
 * `FateContext` of `{runtime, request, auth, liveBus}` down through
 * `adapterContext`; fate's `context` factory passes it through to each resolver
 * as `ctx`. The bridge runner (`features/fate/effect.ts`) runs each resolver
 * Effect on the worker `ManagedRuntime` (`ctx.runtime`) with the per-request
 * `Auth`/`LiveBus` provided onto it. See `.patterns/fate-server-wiring.md`.
 *
 * Wired surface: sozluk (`term`/`terms`/`definition.*`) + pano
 * (`post`/`posts`/`post.*`/`comment.*`) + pasaport (`me`/`profile`/
 * `landingStats`/`user.setUsername`). `roots` stays empty: every read is a
 * custom resolver (full control over the nested `definitions` / `comments` /
 * `contributions` connections — see `.patterns/fate-connections.md`), not a
 * source-masked byId/list root. `live` is the publish-only `LiveEventBus`
 * (ADR 0023) routing mutation events to the `LiveDO` (topic role) fan-out.
 * `sources` is the hand-built Effect-backed resolver from `sources.ts`
 * (`User`/`Term`/`Definition`/`Post`/`Comment`/`Tag`/`Profile`/`Contribution`,
 * `byIds` on every relation-fetchable type).
 */
import {createFateServer} from "@nkzw/fate/server";
import {liveBusConfig} from "../fate-live/event-bus.ts";
import type {FateContext} from "./context.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {sources} from "./sources.ts";

export const fateServer = createFateServer<
	FateContext,
	Record<never, never>,
	typeof queries,
	typeof lists,
	typeof mutations,
	FateContext
>({
	// The `/fate` route always supplies {runtime, request} as adapterContext
	// (fate types it optional); read it through, asserting its presence.
	context: ({adapterContext}) => {
		if (!adapterContext) {
			throw new Error("fate adapterContext missing — the /fate route must supply it.");
		}
		return adapterContext;
	},
	// `roots` stays empty here on purpose. The client-exposed root queries are
	// declared by the `Root` *value* exported from `views.ts`, which the fate
	// Vite plugin reads at build time to generate the typed client roots. At
	// runtime each such root (e.g. `me`) is a `query` operation resolved by its
	// matching `queries.<name>` resolver — so it needs no entry in `roots`, and
	// keeping `roots` empty keeps `fateServer`'s exported type nameable (a
	// non-empty `Roots` generic would surface fate's internal `DataView` symbol,
	// TS2883). byId/list roots come from `sources`/`lists`. See
	// `worker/features/fate/views.ts`.
	roots: {},
	queries,
	lists,
	mutations,
	sources,
	// The publish-only `LiveEventBus` (ADR 0023): `live.*` in a mutation resolves
	// a topic and fetches the `TopicDO` instance with inline-resolved data.
	// fate detects a custom bus by `"subscribe" in live` (the property exists but
	// throws — the SSE protocol is served by the `/fate/live` route + DO, not by
	// fate's `handleLiveRequest`). See `worker/features/fate-live/event-bus.ts`.
	live: liveBusConfig,
});
