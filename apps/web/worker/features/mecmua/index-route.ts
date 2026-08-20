/**
 * `GET /fate/mecmua/index` — the PUBLIC chronological index of published mecmua posts. A raw
 * `HttpRouter.add` route on the anonymous-read idiom: it never validates a session and never
 * reads `CurrentUser`, so an anon GET does zero identity work. Drafts are structurally
 * masked by `mecmuaPostVisibleWhere` under the anonymous viewer.
 *
 * Dark behind `MECMUA_PUBLIC_READ` (default-off): flag off ⇒ 404, so the discovery surface
 * ships dark until a human flips it at release (ADR 0083). The flag is read under the
 * anonymous flags context, so the gate does no session work either.
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

// The default (and max) index page size — no cursor pagination in v1.
const DEFAULT_LIMIT = 50;

// Lean on purpose: NOT the markdown body, which the reader fetches per-slug. `publishedAt`
// is non-null in practice because the WHERE masks drafts; `Date | null` mirrors the column.
export interface MecmuaIndexRow {
	readonly id: string;
	readonly slug: string | null;
	readonly title: string;
	readonly publishedAt: Date | null;
}

// No `author_id = :viewer` ownership escape (there is no viewer), so a draft never appears
// in the public index.
export const mecmuaPublishedIndexWhere: SQL | undefined = mecmuaPostVisibleWhere(
	{publishedAt: schema.mecmuaPost.publishedAt, authorId: schema.mecmuaPost.authorId},
	anonymousMecmuaViewer,
);

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

	// The dark-ship gate under the ANONYMOUS flags context — an anon GET does zero identity
	// work even to decide the flag. Off ⇒ 404, the shipped-dark default.
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
