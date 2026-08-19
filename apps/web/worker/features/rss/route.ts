/**
 * `GET /rss.xml` — the site RSS feed. A raw `HttpRouter.add` route (the body is an XML document,
 * not a schema-shaped JSON value); see `.patterns/alchemy-http-router.md`.
 *
 * Links are absolute, derived from the request origin: the worker has no configured canonical site
 * URL, and the fetched-from origin is the correct base per environment without a new binding.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {Pano} from "../pano/Pano.ts";
import {type FeedChannel, type FeedItem, renderFeed} from "./feed.ts";

const FEED_SIZE = 30;

const postPath = (slug: string | null, id: string): string => `/pano/${slug ?? id}`;

export const handleRss = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const pano = yield* Pano;

	const origin = new URL(raw.url).origin;

	const page = yield* pano.listPostsConnection({sort: "new", first: FEED_SIZE});

	const items: FeedItem[] = page.rows.map((row) => ({
		id: row.id,
		title: row.title,
		link: `${origin}${postPath(row.slug, row.id)}`,
		description: row.body,
		pubDate: row.createdAt,
	}));

	const channel: FeedChannel = {
		title: "kamp.us · pano",
		link: `${origin}/pano`,
		description: "kamp.us pano — son gönderiler",
		feedUrl: `${origin}/rss.xml`,
		items,
	};

	return HttpServerResponse.text(renderFeed(channel), {
		contentType: "application/rss+xml; charset=utf-8",
	});
});

export const rssRoute = HttpRouter.add("GET", "/rss.xml", handleRss);
