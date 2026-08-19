/**
 * The GET-able base pano feed (#2322): the feed connection served WITHOUT the
 * per-viewer scalar stamp, so its bytes are identical for anon and every signed-in
 * viewer and it can sit behind an edge cache. Sort, host and pagination ride the URL,
 * so the cache key falls out of path+query and each subfeed variant is its own entry.
 * See .patterns/alchemy-http-router.md.
 *
 * The load-bearing property: it never validates a session and never reads
 * `CurrentUser`, so nothing session-derived can become cacheable (ADR 0169). The
 * per-viewer scalars arrive through the separate authed read on `POST /fate`. The
 * cache-tag purge lives at the mutation seam in `feed-cache.ts`, not here.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {toPostSort} from "../../../src/lib/panoFeedSort.ts";
import {toConnection} from "../fate/connection.ts";
import {anonymousViewer} from "../lifecycle/EntityLifecycle.ts";
import {baseFeedCacheControl, PANO_FEED_CACHE_TAG} from "./feed-cache.ts";
import {Pano, type PostSummaryRow} from "./Pano.ts";
import {type BasePost, toBasePost} from "./shapers.ts";

// Matches the `posts` list resolver's default.
const DEFAULT_FIRST = 20;

export const handleBaseFeed = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;

	const params = new URL(raw.url).searchParams;
	const host = params.get("host");
	const after = params.get("after");
	const firstRaw = params.get("first");
	const first = firstRaw !== null ? Number.parseInt(firstRaw, 10) : DEFAULT_FIRST;

	const pano = yield* Pano;
	const page = yield* pano.listPostsConnection({
		sort: toPostSort(params.get("sort") ?? undefined),
		// `listPostsConnection` clamps `first` to [1,100]; a non-numeric `?first=` parses
		// to `NaN`, so fall back to the default rather than pass `NaN` through the clamp.
		first: Number.isNaN(first) ? DEFAULT_FIRST : first,
		...(after !== null ? {after} : {}),
		...(host !== null && host.length > 0 ? {host} : {}),
		// Viewer-invariant and no moderator probe, so the base bytes never depend on who
		// asked: a sandboxed post is filtered out for everyone.
		sandboxViewer: anonymousViewer,
	});

	const connection = toConnection<PostSummaryRow, BasePost>(
		page,
		(row) => row.id,
		(row) => toBasePost(row),
	);
	// The per-Worker edge cache serves repeat anon GETs off these headers; the
	// fanned-mutation seam purges the tag on a feed-visible write (ADR 0170).
	return HttpServerResponse.jsonUnsafe(connection, {
		headers: {"cache-control": baseFeedCacheControl, "cache-tag": PANO_FEED_CACHE_TAG},
	});
});

export const baseFeedRoute = HttpRouter.add("GET", "/fate/pano/feed", handleBaseFeed);
