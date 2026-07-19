/**
 * `GET /fate/pano/feed?sort=…&host=…&first=…&after=…` (#2322, epic #2316 leg B) —
 * the GET-able **base feed**: the pano feed connection served WITHOUT the per-viewer
 * scalar stamp, so its bytes are identical for anon and every signed-in viewer and it
 * can sit behind an edge cache (#2324). `sort` / `host` / pagination ride the URL (the
 * cache key falls out of path+query, per the leg-B spike #2320), so each subfeed
 * variant is its own entry. A raw `HttpRouter.add` route (like `rssRoute` /
 * `linkMetadataRoute`) reaching `Pano` through the runtime-derived context layer. See
 * `.patterns/alchemy-http-router.md`.
 *
 * One load-bearing property this route exists to hold:
 *   - **No session validation, no per-viewer work.** It never validates a session and
 *     never reads `CurrentUser`; it reads the ANONYMOUS sandbox viewer, so an anon GET
 *     pays nothing for identity. The per-viewer `myVote`/`isSaved` arrive via the
 *     separate authed `PostOverlay` read on `POST /fate` (ADR 0169 untouched — nothing
 *     session-derived becomes cacheable).
 *
 * Edge-cache headers (leg B, #2324, ADR 0170): the 200 carries `Cache-Control` (the TTL
 * backstop) + `Cache-Tag: pano-feed`, so the per-Worker edge cache serves repeat anon GETs
 * without re-running the D1 read; the fanned-mutation seam purges the tag on a feed-visible
 * write. The purge lives at the mutation seam (`feed-cache.ts`), NOT here — this route only
 * stamps the cache metadata.
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

/** The base-feed page size, matching the `posts` list resolver's default. */
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
		// The anonymous sandbox viewer: viewer-invariant + no moderator probe, so the
		// base bytes never depend on who asked (a çaylak's sandboxed post is filtered out
		// for everyone, exactly as the public `landingPosts` column already reads).
		sandboxViewer: anonymousViewer,
	});

	const connection = toConnection<PostSummaryRow, BasePost>(
		page,
		(row) => row.id,
		(row) => toBasePost(row),
	);
	// The per-Worker edge cache serves repeat anon GETs off these; the fanned-mutation seam
	// purges `Cache-Tag: pano-feed` on a feed-visible write (ADR 0170).
	return HttpServerResponse.jsonUnsafe(connection, {
		headers: {"cache-control": baseFeedCacheControl, "cache-tag": PANO_FEED_CACHE_TAG},
	});
});

export const baseFeedRoute = HttpRouter.add("GET", "/fate/pano/feed", handleBaseFeed);
