import {id} from "@usirin/forge";
import {
	type AnySQLiteColumn,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, {mode: "timestamp"});

const timestamps = {
	createdAt: timestamp("created_at").$defaultFn(() => new Date()),
	updatedAt: timestamp("updated_at").$defaultFn(() => new Date()),
};

/**
 * `authorId` references `user.id` from the Pasaport DO. DOs are storage-isolated,
 * so the FK is intentionally un-enforced — denormalize `authorName` here so the
 * pano feed never has to cross-DO call to render a row.
 *
 * `host` is denormalized from `url` on insert (`new URL(url).host`) so the
 * site-filtered feed is a simple `where host = ?` rather than a per-row parse.
 *
 * `slug` is nullable for now — URLs render as `/pano/p_abc123`. Slugs come
 * later when post titles are richer than "wgpu nasıl debug ediliyor".
 *
 * `commentCount` is denormalized so the list query stays a single scan.
 * The comment-insert path (when it lands) bumps it; until then the seed
 * sets it directly.
 */
export const post = sqliteTable("post", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => id("post")),
	slug: text("slug"),
	title: text("title").notNull(),
	url: text("url"),
	host: text("host"),
	body: text("body"),
	authorId: text("author_id").notNull(),
	authorName: text("author_name").notNull(),
	score: integer("score").notNull().default(0),
	commentCount: integer("comment_count").notNull().default(0),
	...timestamps,
});

/**
 * Tags are owned by their post. A plain row + cascade keeps the write path
 * single-statement; uniqueness across (postId, kind) is a write-time concern
 * we'll enforce when post creation lands.
 */
export const tag = sqliteTable(
	"tag",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => id("tag")),
		kind: text("kind").notNull(),
		label: text("label").notNull(),
		postId: text("post_id")
			.notNull()
			.references(() => post.id, {onDelete: "cascade"}),
	},
	(t) => [index("tag_post_id_idx").on(t.postId)],
);

/**
 * Comment threading is `parentId` self-ref, nullable for top-level comments.
 * Tree assembly happens at the read site (resolver / client) — the DO returns
 * the flat list ordered by score then createdAt and the caller walks parents.
 *
 * `score` is denormalized for the same reason as `post.score`.
 */
export const comment = sqliteTable(
	"comment",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => id("comm")),
		postId: text("post_id")
			.notNull()
			.references(() => post.id, {onDelete: "cascade"}),
		parentId: text("parent_id").references((): AnySQLiteColumn => comment.id, {
			onDelete: "cascade",
		}),
		authorId: text("author_id").notNull(),
		authorName: text("author_name").notNull(),
		body: text("body").notNull(),
		score: integer("score").notNull().default(0),
		...timestamps,
	},
	(c) => [index("comment_post_id_idx").on(c.postId)],
);

/**
 * One row per (user, post) — compound PK keeps the upsert path conflict-free.
 * `value` is constrained at the application layer to {-1, 1}; a `value: 0`
 * vote is represented by row deletion, not by storing a zero. The denormalized
 * `post.score` is recomputed in the same DB transaction as the vote write so
 * the two never drift.
 */
export const postVote = sqliteTable(
	"post_vote",
	{
		userId: text("user_id").notNull(),
		postId: text("post_id")
			.notNull()
			.references(() => post.id, {onDelete: "cascade"}),
		value: integer("value").notNull(),
		createdAt: timestamp("created_at").$defaultFn(() => new Date()),
	},
	(v) => [
		primaryKey({columns: [v.userId, v.postId]}),
		index("post_vote_post_id_idx").on(v.postId),
	],
);

/**
 * Mirrors `postVote` for comments. Separate table (rather than a polymorphic
 * `target_kind` column) so the FK can cascade on comment delete and the
 * sum-by-target query stays a single typed scan.
 */
export const commentVote = sqliteTable(
	"comment_vote",
	{
		userId: text("user_id").notNull(),
		commentId: text("comment_id")
			.notNull()
			.references(() => comment.id, {onDelete: "cascade"}),
		value: integer("value").notNull(),
		createdAt: timestamp("created_at").$defaultFn(() => new Date()),
	},
	(v) => [
		primaryKey({columns: [v.userId, v.commentId]}),
		index("comment_vote_comment_id_idx").on(v.commentId),
	],
);
