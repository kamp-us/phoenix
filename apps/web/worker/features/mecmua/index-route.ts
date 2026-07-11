/**
 * `GET /fate/mecmua/index` (#2512, epic #2467) — the PUBLIC chronological index of
 * published mecmua posts, newest-first by `published_at`. A raw `HttpRouter.add` route
 * following the anonymous-read idiom of `public-read-route.ts` / pano's
 * `base-feed-route.ts`: it never validates a session and never reads `CurrentUser`, so
 * an anon GET does zero identity work. It applies `mecmuaPostVisibleWhere` (#2496) under
 * the `anonymousMecmuaViewer`, so a draft (null `published_at`) is structurally masked —
 * only published posts appear in the index, no auth required.
 *
 * This is the PUBLIC index (all published posts) — distinct from the personalized
 * subscribed-author feed (#2500). The list is lean (id + slug + başlık + publishedAt),
 * not the full markdown body, since the reader (`/mecmua/:slug`) fetches the body on
 * demand.
 *
 * Dark behind `MECMUA_PUBLIC_READ` (default-off), the same seam the read route gates on:
 * with the flag off the route 404s, so the whole discovery surface ships dark until a
 * human flips the flag at release (ADR 0083). The flag is read under the anonymous flags
 * context (no identity), so the gate itself does no session work either.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import {desc, type SQL} from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {MECMUA_PUBLIC_READ} from "../../../src/flags/keys.ts";
import {Drizzle, type DrizzleAccessOrDie, orDieAccess} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {Flags} from "../flagship/Flags.ts";
import {
	anonymousFlagsContext,
	FlagsContext,
	makeRequestFlagsContext,
} from "../flagship/FlagsContext.ts";
import {anonymousMecmuaViewer, mecmuaPostVisibleWhere} from "./MecmuaPostVisibility.ts";

/** The default (and max) index page size — a lean first page, no cursor pagination in v1. */
const DEFAULT_LIMIT = 50;

/**
 * The lean wire row for the index — identity + slug + başlık + the publish marker, but
 * NOT the markdown body (the reader fetches that per-slug). `publishedAt` is non-null in
 * practice because the WHERE masks drafts; the `Date | null` type just mirrors the column.
 */
export interface MecmuaIndexRow {
	readonly id: string;
	readonly slug: string | null;
	readonly title: string;
	readonly publishedAt: Date | null;
}

/**
 * The index WHERE: the `mecmuaPostVisibleWhere` published gate (#2496) under the
 * anonymous viewer — `published_at is not null`, with NO `author_id = :viewer` ownership
 * escape (there is no viewer). So a draft never appears in the public index.
 */
export const mecmuaPublishedIndexWhere: SQL | undefined = mecmuaPostVisibleWhere(
	{publishedAt: schema.mecmuaPost.publishedAt, authorId: schema.mecmuaPost.authorId},
	anonymousMecmuaViewer,
);

/** List the published mecmua posts newest-first by `published_at`, lean rows only. */
export const listPublishedMecmuaPosts = (
	run: DrizzleAccessOrDie["run"],
	limit = DEFAULT_LIMIT,
): Effect.Effect<ReadonlyArray<MecmuaIndexRow>> =>
	run((db) =>
		db
			.select({
				id: schema.mecmuaPost.id,
				slug: schema.mecmuaPost.slug,
				title: schema.mecmuaPost.title,
				publishedAt: schema.mecmuaPost.publishedAt,
			})
			.from(schema.mecmuaPost)
			.where(mecmuaPublishedIndexWhere)
			.orderBy(desc(schema.mecmuaPost.publishedAt))
			.limit(limit),
	);

export const handleMecmuaIndex = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;

	// The dark-ship gate under the ANONYMOUS flags context — an anon GET does zero
	// identity work even to decide the flag. Off => 404, the shipped-dark default.
	const flags = yield* Flags;
	const flagsContext = yield* makeRequestFlagsContext(
		anonymousFlagsContext,
		raw.headers.get("cookie"),
	);
	const on = yield* flags
		.getBoolean(MECMUA_PUBLIC_READ, false)
		.pipe(Effect.provideService(FlagsContext, flagsContext));
	if (!on) return HttpServerResponse.empty({status: 404});

	const {run} = orDieAccess(yield* Drizzle);
	const posts = yield* listPublishedMecmuaPosts(run);
	return HttpServerResponse.jsonUnsafe(posts);
});

export const mecmuaIndexRoute = HttpRouter.add("GET", "/fate/mecmua/index", handleMecmuaIndex);
