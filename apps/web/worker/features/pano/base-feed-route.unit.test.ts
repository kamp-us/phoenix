import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {expect, it} from "vitest";
import {anonymousViewer} from "../lifecycle/EntityLifecycle.ts";
import {handleBaseFeed} from "./base-feed-route.ts";
import {baseFeedCacheControl, PANO_FEED_CACHE_TAG} from "./feed-cache.ts";
import {Pano} from "./Pano.ts";

it("emits the public cache policy and purge tag from the viewer-invariant handler", async () => {
	const methods: Partial<typeof Pano.Service> = {
		listPostsConnection: (options) => {
			expect(options.sandboxViewer).toBe(anonymousViewer);
			return Effect.succeed({rows: [], hasNextPage: false, endCursor: null, totalCount: 0});
		},
	};
	const pano = new Proxy(methods, {
		get(target, key) {
			if (key in target) return Reflect.get(target, key);
			throw new Error(`Unexpected Pano method: ${String(key)}`);
		},
	}) as typeof Pano.Service;
	const response = await Effect.runPromise(
		handleBaseFeed.pipe(
			Effect.provideService(Pano, pano),
			Effect.provideService(Cloudflare.Request, new Request("https://worker.test/fate/pano/feed")),
		),
	);
	const web = HttpServerResponse.toWeb(response);
	expect(web.headers.get("cache-control")).toBe(baseFeedCacheControl);
	expect(web.headers.get("cache-tag")).toBe(PANO_FEED_CACHE_TAG);
	expect(await web.json()).toEqual({items: [], pagination: {hasNext: false, hasPrevious: false}});
});
