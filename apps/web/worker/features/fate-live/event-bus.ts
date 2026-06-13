/**
 * The build-time `LiveEventBus` stub fate's config holds (ADR 0023/0039,
 * `.patterns/fate-live-views.md`).
 *
 * fate's built-in `createLiveEventBus()` is an in-memory `EventEmitter` that
 * can't fan out across the isolates a Worker spreads requests over, so phoenix
 * moves publish (→ the per-request `LivePublisher`) and subscribe (→ `/fate/live`
 * + `LiveDO`) off it entirely. The only thing fate does with this value is the
 * build-time `"subscribe" in live` check (custom-bus detection, `fate/config.ts`).
 * Nothing calls any method, so every method THROWS: a call would mean a publish
 * or subscribe leaked onto the config bus, and that must fail loudly.
 */

import type {LiveEventBus} from "@nkzw/fate/server";

const neverPublished = (): never => {
	throw new Error("live publishes go through the per-request LivePublisher service, not the bus");
};

const neverSubscribed = (): never => {
	throw new Error("live subscriptions are served by LiveDO, not the bus");
};

/** The bus handed to fate at worker init (`createFateServer`'s `live` option). */
export const liveBusConfig: LiveEventBus = {
	update: neverPublished,
	delete: neverPublished,
	emit: neverPublished,
	connection: neverPublished,
	subscribe: neverSubscribed,
	subscribeConnection: neverSubscribed,
};
