/**
 * The pano read paths under the #6423 third viewer class (#6424, epic #4306) — proven on
 * the SQL each read actually emits (and, for the single-row `getPost`, on the value it
 * returns), per viewer shape.
 *
 * Three claims:
 *   - an opted-in in-place viewer's sandbox mask is author-blind, and a connection's
 *     `totalCount` carries the SAME mask as its page;
 *   - the author-only DRAFT arm is untouched by the opt-in — an unpublished draft stays
 *     private to its author, with no moderator and no in-place exemption (ADR 0113);
 *   - every other viewer shape emits byte-for-byte the statement it emitted before the
 *     class existed, so the flag-off world is pinned by literal rather than by inspection.
 *
 * The goldens keep the whole statement — predicate, `order by`, `limit`, bound params —
 * with only the leading select-column list collapsed to `…`: that list is the schema's
 * axis, not the mask's.
 *
 * Unit-tier per ADR 0082; the scripted-`Drizzle` capture idiom is
 * `post-by-id-draft-visibility.unit.test.ts`'s.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import {anonymousViewer, type SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
import {Vote} from "../vote/Vote.ts";
import {Bookmark} from "./Bookmark.ts";
import {Pano, PanoLive} from "./Pano.ts";

const MEMBER = "u-yazar";
const MOD = "u-mod";
const CAYLAK = "u-caylak";

const member: SandboxViewer = {
	viewerId: MEMBER,
	canSeeSandboxed: false,
	seesSandboxedInPlace: false,
};
const inPlace: SandboxViewer = {
	viewerId: MEMBER,
	canSeeSandboxed: false,
	seesSandboxedInPlace: true,
};
const moderator: SandboxViewer = {
	viewerId: MOD,
	canSeeSandboxed: true,
	seesSandboxedInPlace: false,
};

interface Rendered {
	readonly sql: string;
	readonly params: unknown[];
}

/** A connection's two reads: the `totalCount` and the page. */
interface TwoReads {
	readonly count: Rendered;
	readonly page: Rendered;
}

const collapse = ({sql, params}: Rendered): Rendered => ({
	sql: sql.replace(/^select "[\s\S]*?" from /, "select … from "),
	params,
});

const hasToSQL = (v: unknown): v is {toSQL: () => Rendered} =>
	typeof v === "object" && v !== null && typeof (v as {toSQL?: unknown}).toSQL === "function";

function scriptedAccess(results: ReadonlyArray<unknown>): {
	access: DrizzleAccess;
	builders: Rendered[];
	prepared: {sql: string; params: unknown[]}[];
} {
	const state = {i: 0};
	const builders: Rendered[] = [];
	const prepared: {sql: string; params: unknown[]}[] = [];
	// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed; only `prepare`/`batch` are exercised and every result is scripted.
	const capturingD1 = {
		prepare: (sql: string) => {
			const entry = {sql, params: [] as unknown[]};
			prepared.push(entry);
			return {
				bind(...params: unknown[]) {
					entry.params = params;
					return this;
				},
				async all() {
					return {results: []};
				},
				async first() {
					return null;
				},
				async run() {
					return {};
				},
				async raw() {
					return [];
				},
			};
		},
		async batch() {
			return [];
		},
	} as unknown as D1Database;
	const renderDb = drizzle(capturingD1, {relations});

	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			const built = fn(renderDb) as unknown;
			if (hasToSQL(built)) builders.push(built.toSQL());
			return Effect.succeed(results[state.i++] as A);
		},
		batch: () => Effect.die(new Error("these reads must not batch")),
	};
	return {access, builders, prepared};
}

// biome-ignore lint/plugin: a service double — these reads only reach `readMine`.
const VoteStub = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("a read must not cast a vote")),
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

// biome-ignore lint/plugin: a service double — only `readMine` is on this path.
const BookmarkStub = Layer.succeed(Bookmark, {
	toggle: () => Effect.die(new Error("a read must not toggle a bookmark")),
	readMine: () => Effect.succeed(new Set<string>()),
	listSavedConnection: () => Effect.die(new Error("not on this path")),
} as unknown as typeof Bookmark.Service);

const panoLayer = (access: DrizzleAccess) =>
	PanoLive.pipe(
		Layer.provide(VoteStub),
		Layer.provide(BookmarkStub),
		Layer.provide(ReactionStub),
		Layer.provide(PasaportIdentityStub),
		Layer.provide(Layer.succeed(Drizzle, access)),
	);

const now = new Date("2026-08-19T00:00:00.000Z");

/**
 * A çaylak's still-sandboxed, published (non-draft) post. `getPost` reads only the
 * lifecycle/draft/author columns plus the `toPostPage` field set, so the fixture stops
 * there rather than enumerating every `post_record` column.
 */
const sandboxedRow = {
	id: "post_sb1",
	slug: null,
	title: "yeni gelen",
	url: null,
	host: null,
	body: "ilk yazı",
	bodyExcerpt: "ilk yazı",
	authorId: CAYLAK,
	authorName: "Çaylak",
	tags: "",
	score: 0,
	commentCount: 0,
	hotScore: 0,
	createdAt: now,
	updatedAt: now,
	lastActivityAt: now,
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: now,
	isDraft: null,
} as never;

/** The same author's still-unpublished draft. */
const draftRow = {...(sandboxedRow as object), id: "post_dr1", isDraft: 1} as never;

const getPostFor = (row: unknown, viewer: SandboxViewer) =>
	Effect.gen(function* () {
		const pano = yield* Pano;
		return yield* pano.getPost("post_x", {sandboxViewer: viewer});
	}).pipe(Effect.provide(panoLayer(scriptedAccess([row]).access)));

/** `Pano.listPostsConnection`'s two reads — the feed's masked count and page. */
const feedSql = (viewer: SandboxViewer): Effect.Effect<TwoReads> =>
	Effect.gen(function* () {
		const {access, builders, prepared} = scriptedAccess([0, []]);
		yield* Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.listPostsConnection({sort: "new", sandboxViewer: viewer});
		}).pipe(Effect.provide(panoLayer(access)));
		const count = prepared[0];
		const page = builders[0];
		assert.isDefined(count, "the totalCount read reached the D1 binding");
		assert.isDefined(page, "the page read rendered off the seam");
		return {count: collapse(count), page: collapse(page)};
	});

/** `Pano.getPostsByIds` — the feed's re-hydrate and the `Post` source's batch loader. */
const postsByIdsSql = (viewer: SandboxViewer): Effect.Effect<Rendered> =>
	Effect.gen(function* () {
		const {access, builders} = scriptedAccess([[]]);
		yield* Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.getPostsByIds(["post_1"], {sandboxViewer: viewer});
		}).pipe(Effect.provide(panoLayer(access)));
		const fetch = builders[0];
		assert.isDefined(fetch, "the by-ids read rendered off the seam");
		return collapse(fetch);
	});

/** `Pano.listCommentsKeyset`'s two reads — the thread's masked count and page. */
const commentsKeysetSql = (viewer: SandboxViewer): Effect.Effect<TwoReads> =>
	Effect.gen(function* () {
		const {access, builders, prepared} = scriptedAccess([0, []]);
		yield* Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.listCommentsKeyset("post_1", {sandboxViewer: viewer});
		}).pipe(Effect.provide(panoLayer(access)));
		const count = prepared[0];
		const page = builders[0];
		assert.isDefined(count, "the totalCount read reached the D1 binding");
		assert.isDefined(page, "the page read rendered off the seam");
		return {count: collapse(count), page: collapse(page)};
	});

/** `Pano.getCommentsByIds` — the `Comment` source's batch loader. */
const commentsByIdsSql = (viewer: SandboxViewer): Effect.Effect<Rendered> =>
	Effect.gen(function* () {
		const {access, builders} = scriptedAccess([[]]);
		yield* Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.getCommentsByIds(["cmt_1"], {sandboxViewer: viewer});
		}).pipe(Effect.provide(panoLayer(access)));
		const fetch = builders[0];
		assert.isDefined(fetch, "the by-ids read rendered off the seam");
		return collapse(fetch);
	});

const POST_AUTHOR_ARM = /"post_record"\."author_id" = \?/;
const COMMENT_AUTHOR_ARM = /"comment_record"\."author_id" = \?/;
const POST_WIDENED = /"post_record"\."sandboxed_at" is not null/i;
const COMMENT_WIDENED = /"comment_record"\."sandboxed_at" is not null/i;
const DRAFT_ARM = /"post_record"\."is_draft" is not 1/i;

describe("pano reads — the opted-in in-place viewer's mask is author-blind (#6424)", () => {
	it.effect("the feed page widens, and totalCount carries the IDENTICAL mask", () =>
		Effect.gen(function* () {
			const {count, page} = yield* feedSql(inPlace);
			for (const rendered of [count, page]) {
				assert.match(rendered.sql, POST_WIDENED, "the sandboxed arm is admitted");
				assert.notMatch(rendered.sql, POST_AUTHOR_ARM, "author-blind — no ownership arm");
			}
		}),
	);

	it.effect("the by-ids post read widens the same way", () =>
		Effect.gen(function* () {
			const {sql} = yield* postsByIdsSql(inPlace);
			assert.match(sql, POST_WIDENED);
		}),
	);

	it.effect("the comment thread's page and totalCount both widen", () =>
		Effect.gen(function* () {
			const {count, page} = yield* commentsKeysetSql(inPlace);
			for (const rendered of [count, page]) {
				assert.match(rendered.sql, COMMENT_WIDENED, "the sandboxed arm is admitted");
				assert.notMatch(rendered.sql, COMMENT_AUTHOR_ARM, "author-blind — no ownership arm");
			}
		}),
	);

	it.effect("the by-ids comment read widens the same way", () =>
		Effect.gen(function* () {
			const {sql} = yield* commentsByIdsSql(inPlace);
			assert.match(sql, COMMENT_WIDENED);
			assert.notMatch(sql, COMMENT_AUTHOR_ARM);
		}),
	);

	it.effect("post detail returns another author's sandboxed post to an in-place viewer", () =>
		Effect.gen(function* () {
			assert.isNotNull(yield* getPostFor(sandboxedRow, inPlace));
			assert.isNull(
				yield* getPostFor(sandboxedRow, member),
				"a signed-in viewer who did not opt in still reads not-found",
			);
			assert.isNull(yield* getPostFor(sandboxedRow, anonymousViewer));
		}),
	);
});

/**
 * The draft dimension is `post_record`-local and author-only, with no moderator exemption
 * (ADR 0113). The in-place opt-in is a SANDBOX widening, so it must not reach here.
 */
describe("pano reads — the author-only draft arm is untouched by the opt-in (#6424)", () => {
	it.effect("the feed's draft arm is the same for an in-place viewer as for a member", () =>
		Effect.gen(function* () {
			const widened = yield* feedSql(inPlace);
			const plain = yield* feedSql(member);
			for (const rendered of [widened.count, widened.page, plain.count, plain.page]) {
				assert.match(rendered.sql, DRAFT_ARM, "drafts stay excluded from the feed");
			}
		}),
	);

	it.effect("an in-place viewer still reads another author's draft as not-found", () =>
		Effect.gen(function* () {
			assert.isNull(yield* getPostFor(draftRow, inPlace));
			assert.isNull(yield* getPostFor(draftRow, moderator), "no moderator exemption either");
		}),
	);
});

const FEED_GOLDENS: Record<string, TwoReads> = {
	anonymous: {
		count: {
			sql: 'select count(*) from "post_record" where ((("post_record"."removed_at" is null)) and ("post_record"."is_draft" is not 1) and (("post_record"."sandboxed_at" is null)))',
			params: [],
		},
		page: {
			sql: 'select … from "post_record" where ((("post_record"."removed_at" is null)) and ("post_record"."is_draft" is not 1) and (("post_record"."sandboxed_at" is null))) order by "post_record"."id" desc limit ?',
			params: [21],
		},
	},
	"signed-in, not opted in": {
		count: {
			sql: 'select count(*) from "post_record" where ((("post_record"."removed_at" is null)) and ("post_record"."is_draft" is not 1) and (((("post_record"."sandboxed_at" is null)) or ("post_record"."author_id" = ?))))',
			params: [MEMBER],
		},
		page: {
			sql: 'select … from "post_record" where ((("post_record"."removed_at" is null)) and ("post_record"."is_draft" is not 1) and (((("post_record"."sandboxed_at" is null)) or ("post_record"."author_id" = ?)))) order by "post_record"."id" desc limit ?',
			params: [MEMBER, 21],
		},
	},
	moderator: {
		count: {
			sql: 'select count(*) from "post_record" where ((("post_record"."removed_at" is null)) and ("post_record"."is_draft" is not 1))',
			params: [],
		},
		page: {
			sql: 'select … from "post_record" where ((("post_record"."removed_at" is null)) and ("post_record"."is_draft" is not 1)) order by "post_record"."id" desc limit ?',
			params: [21],
		},
	},
};

const POSTS_BY_IDS_GOLDENS: Record<string, Rendered> = {
	anonymous: {
		sql: 'select … from "post_record" where (("post_record"."id" in (?)) and (("post_record"."removed_at" is null)) and (((("post_record"."sandboxed_at" is null)) and ("post_record"."is_draft" is not 1))))',
		params: ["post_1"],
	},
	"signed-in, not opted in": {
		sql: 'select … from "post_record" where (("post_record"."id" in (?)) and (("post_record"."removed_at" is null)) and (((((("post_record"."sandboxed_at" is null)) or ("post_record"."author_id" = ?))) and ((("post_record"."is_draft" is not 1) or ("post_record"."author_id" = ?))))))',
		params: ["post_1", MEMBER, MEMBER],
	},
	moderator: {
		sql: 'select … from "post_record" where (("post_record"."id" in (?)) and (("post_record"."removed_at" is null)) and ((("post_record"."is_draft" is not 1) or ("post_record"."author_id" = ?))))',
		params: ["post_1", MOD],
	},
};

const COMMENTS_KEYSET_GOLDENS: Record<string, TwoReads> = {
	anonymous: {
		count: {
			sql: 'select count(*) from "comment_record" where (("comment_record"."post_id" = ?) and (("comment_record"."removed_at" IS NULL OR EXISTS (SELECT 1 FROM "comment_record" AS child WHERE child.parent_id = "comment_record"."id" AND child.removed_at IS NULL))) and (("comment_record"."sandboxed_at" is null)))',
			params: ["post_1"],
		},
		page: {
			sql: 'select … from "comment_record" where (("comment_record"."post_id" = ?) and (("comment_record"."removed_at" IS NULL OR EXISTS (SELECT 1 FROM "comment_record" AS child WHERE child.parent_id = "comment_record"."id" AND child.removed_at IS NULL))) and (("comment_record"."sandboxed_at" is null))) order by "comment_record"."created_at" asc, "comment_record"."id" asc limit ?',
			params: ["post_1", 51],
		},
	},
	"signed-in, not opted in": {
		count: {
			sql: 'select count(*) from "comment_record" where (("comment_record"."post_id" = ?) and (("comment_record"."removed_at" IS NULL OR EXISTS (SELECT 1 FROM "comment_record" AS child WHERE child.parent_id = "comment_record"."id" AND child.removed_at IS NULL))) and (((("comment_record"."sandboxed_at" is null)) or ("comment_record"."author_id" = ?))))',
			params: ["post_1", MEMBER],
		},
		page: {
			sql: 'select … from "comment_record" where (("comment_record"."post_id" = ?) and (("comment_record"."removed_at" IS NULL OR EXISTS (SELECT 1 FROM "comment_record" AS child WHERE child.parent_id = "comment_record"."id" AND child.removed_at IS NULL))) and (((("comment_record"."sandboxed_at" is null)) or ("comment_record"."author_id" = ?)))) order by "comment_record"."created_at" asc, "comment_record"."id" asc limit ?',
			params: ["post_1", MEMBER, 51],
		},
	},
	moderator: {
		count: {
			sql: 'select count(*) from "comment_record" where (("comment_record"."post_id" = ?) and (("comment_record"."removed_at" IS NULL OR EXISTS (SELECT 1 FROM "comment_record" AS child WHERE child.parent_id = "comment_record"."id" AND child.removed_at IS NULL))))',
			params: ["post_1"],
		},
		page: {
			sql: 'select … from "comment_record" where (("comment_record"."post_id" = ?) and (("comment_record"."removed_at" IS NULL OR EXISTS (SELECT 1 FROM "comment_record" AS child WHERE child.parent_id = "comment_record"."id" AND child.removed_at IS NULL)))) order by "comment_record"."created_at" asc, "comment_record"."id" asc limit ?',
			params: ["post_1", 51],
		},
	},
};

const COMMENTS_BY_IDS_GOLDENS: Record<string, Rendered> = {
	anonymous: {
		sql: 'select … from "comment_record" where (("comment_record"."id" in (?)) and (("comment_record"."sandboxed_at" is null)))',
		params: ["cmt_1"],
	},
	"signed-in, not opted in": {
		sql: 'select … from "comment_record" where (("comment_record"."id" in (?)) and (((("comment_record"."sandboxed_at" is null)) or ("comment_record"."author_id" = ?))))',
		params: ["cmt_1", MEMBER],
	},
	moderator: {
		sql: 'select … from "comment_record" where "comment_record"."id" in (?)',
		params: ["cmt_1"],
	},
};

/**
 * With `phoenix-caylak-visibility` off nothing resolves `seesSandboxedInPlace: true`, so
 * every read below must emit exactly what it emitted before the class existed.
 */
describe("pano reads — every non-in-place viewer emits byte-for-byte today's SQL (#6424)", () => {
	const shapes: ReadonlyArray<[name: string, viewer: SandboxViewer]> = [
		["anonymous", anonymousViewer],
		["signed-in, not opted in", member],
		["moderator", moderator],
	];

	for (const [name, viewer] of shapes) {
		it.effect(`${name} — the feed's count and page`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* feedSql(viewer), FEED_GOLDENS[name]);
			}),
		);

		it.effect(`${name} — the by-ids post read`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* postsByIdsSql(viewer), POSTS_BY_IDS_GOLDENS[name]);
			}),
		);

		it.effect(`${name} — the comment thread's count and page`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* commentsKeysetSql(viewer), COMMENTS_KEYSET_GOLDENS[name]);
			}),
		);

		it.effect(`${name} — the by-ids comment read`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* commentsByIdsSql(viewer), COMMENTS_BY_IDS_GOLDENS[name]);
			}),
		);
	}
});
