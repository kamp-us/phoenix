/**
 * The build-time `LiveEventBus` stub fate's config holds (ADR 0023/0039,
 * `.patterns/fate-live-views.md`).
 *
 * fate's built-in `createLiveEventBus()` is an in-memory `EventEmitter`: a
 * `live.update` reaches only subscribers in the **same** Worker isolate, so it
 * cannot fan out across the isolates a Worker spreads requests over. phoenix
 * keeps fate's SSE wire protocol but moves everything off this object:
 *
 *   - **publish** — mutations publish through `@phoenix/fate-effect`'s
 *     per-request `LivePublisher` service; `live-publisher.ts` builds the
 *     frames + topic keys directly and fans out via the `LiveDO` topic role;
 *   - **subscribe** — the SSE protocol is served by the `/fate/live` route +
 *     `LiveDO` (`live-do.ts`), not by fate's `handleLiveRequest`.
 *
 * The only thing fate ever does with this value is the build-time structural
 * check `"subscribe" in live` (custom-bus detection, in `toCodegenServer` /
 * `createFateServer` — `fate/config.ts`). Nothing calls any method, so every
 * method THROWS: a call would mean a publish or subscribe leaked onto the
 * config bus, and that must fail loudly instead of silently dropping.
 */

import type {LiveEventBus} from "@nkzw/fate/server";

const neverPublished = (): never => {
	throw new Error("live publishes go through the per-request LivePublisher service, not the bus");
};

const neverSubscribed = (): never => {
	throw new Error("live subscriptions are served by LiveDO, not the bus");
};

/**
 * The bus handed to fate at worker init (`createFateServer`'s `live` option).
 * Exists solely so fate's `"subscribe" in live` detection passes; see the
 * module doc for why every method throws.
 */
export const liveBusConfig: LiveEventBus = {
	update: neverPublished,
	delete: neverPublished,
	emit: neverPublished,
	connection: neverPublished,
	subscribe: neverSubscribed,
	subscribeConnection: neverSubscribed,
};
