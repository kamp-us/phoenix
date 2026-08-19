/**
 * `GET /fate/mecmua/post/:slug` (#2498) — the PUBLIC read of a single published mecmua
 * post, by slug or id. It never validates a session and never reads `CurrentUser`, so an
 * anon GET does zero identity work; a draft is masked by `mecmuaPostVisibleWhere` (#2496).
 * See `.patterns/alchemy-http-router.md`.
 *
 * Dark behind `MECMUA_PUBLIC_READ` (default-off, ADR 0083): flag off ⇒ 404.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import {and, eq, or, type SQL} from "drizzle-orm";
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
import {type MecmuaPostRow, toMecmuaPostRow} from "./post-fields.ts";

/**
 * Deliberately NO `author_id = :viewer` ownership escape — there is no viewer here, so a
 * draft is never disclosed publicly whichever key names it (#2496).
 */
export const mecmuaPublicReadWhere = (key: string): SQL | undefined =>
	and(
		or(eq(schema.mecmuaPost.slug, key), eq(schema.mecmuaPost.id, key)),
		mecmuaPostVisibleWhere(
			{publishedAt: schema.mecmuaPost.publishedAt, authorId: schema.mecmuaPost.authorId},
			anonymousMecmuaViewer,
		),
	);

/** A draft and a genuine miss both mask to null, which the route renders as a 404. */
export const readPublishedMecmuaPost = (
	run: DrizzleAccessOrDie["run"],
	key: string,
): Effect.Effect<MecmuaPostRow | null> =>
	run((db) => db.select().from(schema.mecmuaPost).where(mecmuaPublicReadWhere(key)).limit(1)).pipe(
		Effect.map((rows) => (rows[0] ? toMecmuaPostRow(rows[0]) : null)),
	);

export const handleMecmuaPublicRead = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;

	// Evaluated under the ANONYMOUS flags context, so an anon GET does zero identity work
	// even to decide the flag.
	const flags = yield* Flags;
	const flagsContext = yield* makeRequestFlagsContext(
		anonymousFlagsContext,
		raw.headers.get("cookie"),
	);
	const on = yield* flags
		.getBoolean(MECMUA_PUBLIC_READ, false)
		.pipe(Effect.provideService(FlagsContext, flagsContext));
	if (!on) return HttpServerResponse.empty({status: 404});

	const params = yield* HttpRouter.params;
	const key = params.slug;
	if (key === undefined || key.length === 0) return HttpServerResponse.empty({status: 404});

	const {run} = orDieAccess(yield* Drizzle);
	const post = yield* readPublishedMecmuaPost(run, key);
	if (post === null) return HttpServerResponse.empty({status: 404});

	return HttpServerResponse.jsonUnsafe(post);
});

export const mecmuaPublicReadRoute = HttpRouter.add(
	"GET",
	"/fate/mecmua/post/:slug",
	handleMecmuaPublicRead,
);
