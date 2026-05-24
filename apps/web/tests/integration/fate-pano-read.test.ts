/**
 * fate pano reads — end-to-end against the live worker `/fate` route.
 *
 * Drives the real `/fate` HTTP surface inside workerd via `SELF.fetch`, after
 * seeding `post_summary` + `comment_view` through the `Pano` service (same
 * `env.PHOENIX_DB` the worker reads). Asserts wire parity with the GraphQL pano
 * read surface:
 *
 *   - `posts(sort, host)` returns the post rows and id cursors.
 *   - `post(idOrSlug)` returns the detail row with its scalar surface + tags.
 *   - `post(idOrSlug){ comments }` paginates via a DB keyset in chronological-asc
 *     order `(created_at asc, id asc)`, with comment id as the cursor — no skips
 *     or duplicates across pages (replacing the in-memory id-index slice).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env, SELF} from "cloudflare:test";
import {Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {Pano, PanoLive} from "../../worker/features/pano/Pano";
import {VoteLive} from "../../worker/features/vote/Vote";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = PanoLive.pipe(
	Layer.provideMerge(VoteLive),
	Layer.provide(DrizzleLive),
	Layer.provide(Layer.succeed(CloudflareEnv, env)),
);

const run = <A, E>(eff: Effect.Effect<A, E, Pano>) =>
	Effect.runPromise(eff.pipe(Effect.provide(TestLive)) as Effect.Effect<A, E, never>);

async function applyViewMigrations() {
	const statements = baselineMigration
		.split("--> statement-breakpoint")
		.map((s: string) => s.trim())
		.filter(Boolean);
	for (const stmt of statements) {
		try {
			await env.PHOENIX_DB.prepare(stmt).run();
		} catch (err) {
			const msg = String(err);
			if (
				!msg.includes("already exists") &&
				!msg.includes("duplicate column") &&
				!msg.includes("no such table") &&
				!msg.includes("no such index")
			) {
				throw err;
			}
		}
	}
}

type FateResult =
	| {ok: true; data: unknown; id: string}
	| {ok: false; error: {code: string; message?: string}; id: string};

async function fateOp(operation: Record<string, unknown>): Promise<FateResult> {
	const res = await SELF.fetch("https://test.local/fate", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({version: 1, operations: [{id: "1", ...operation}]}),
	});
	const body = (await res.json()) as {results: FateResult[]};
	return body.results[0]!;
}

let postId = "";
let commentIds: string[] = [];

beforeAll(async () => {
	await applyViewMigrations();
	// Seed one post with five chronological comments so the keyset order is
	// deterministic (comment ids are forge ULIDs — lex-sortable, monotonic with
	// creation order).
	const seeded = await run(
		Effect.gen(function* () {
			const pano = yield* Pano;
			const post = yield* pano.submitPost({
				title: "Fate Pano Read",
				url: "https://example.com/fate-read",
				body: "fate pano read body",
				tags: [{kind: "tartışma"}, {kind: "soru"}],
				authorId: "pano-u1",
				authorName: "umut",
			});
			const ids: string[] = [];
			for (let i = 0; i < 5; i++) {
				const c = yield* pano.addComment({
					postId: post.postId,
					authorId: `pano-c${i}`,
					authorName: `commenter ${i}`,
					body: `comment ${i} body — long enough`,
				});
				ids.push(c.commentId);
			}
			return {postId: post.postId, commentIds: ids};
		}),
	);
	postId = seeded.postId;
	commentIds = seeded.commentIds;
});

describe("fate pano reads — /fate", () => {
	it("posts(hot) returns rows with id cursors", async () => {
		const result = await fateOp({
			kind: "list",
			name: "posts",
			args: {sort: "hot"},
			select: ["id", "title", "score", "commentCount", "author"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			items: Array<{
				cursor: string;
				node: {id: string; title: string; commentCount: number; author: string};
			}>;
			pagination: {hasNext: boolean; hasPrevious: boolean};
		};
		const seeded = data.items.find((e) => e.node.id === postId);
		expect(seeded).toBeDefined();
		expect(seeded!.cursor).toBe(postId); // cursor is the post id keyset
		expect(seeded!.node.title).toBe("Fate Pano Read");
		expect(seeded!.node.commentCount).toBe(5);
		expect(seeded!.node.author).toBe("umut");
		expect(data.pagination.hasPrevious).toBe(false);
	});

	it("posts(host) filters by host", async () => {
		const result = await fateOp({
			kind: "list",
			name: "posts",
			args: {sort: "new", host: "example.com"},
			select: ["id", "host"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {items: Array<{node: {id: string; host: string | null}}>};
		expect(data.items.length).toBeGreaterThan(0);
		expect(data.items.every((e) => e.node.host === "example.com")).toBe(true);
		expect(data.items.some((e) => e.node.id === postId)).toBe(true);
	});

	it("post(idOrSlug) returns the detail row with tags", async () => {
		const result = await fateOp({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId},
			// `tags` is a scalar embedded array (`{kind, label}[]`), selected as a
			// whole field (no `tags.kind`/`tags.label` relation paths) — see the
			// embedded-scalar note on `postDataView` (task 7 / fate 1.0.3 drift).
			select: ["id", "title", "url", "host", "score", "commentCount", "tags"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			id: string;
			title: string;
			host: string | null;
			commentCount: number;
			tags: Array<{kind: string; label: string}>;
		};
		expect(data.id).toBe(postId);
		expect(data.title).toBe("Fate Pano Read");
		expect(data.host).toBe("example.com");
		expect(data.commentCount).toBe(5);
		expect(data.tags.map((t) => t.kind).sort()).toEqual(["soru", "tartışma"]);
	});

	it("post(idOrSlug) returns null for an unknown id", async () => {
		const result = await fateOp({
			kind: "query",
			name: "post",
			args: {idOrSlug: "post_does_not_exist"},
			select: ["id"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBeNull();
	});

	it("Post.comments paginates by DB keyset with no skips/dupes across pages", async () => {
		// Page 1: first 2 in chronological-asc order.
		const page1 = await fateOp({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId, comments: {first: 2}},
			select: ["id", "comments.id", "comments.body", "comments.author"],
		});
		expect(page1.ok).toBe(true);
		if (!page1.ok) return;
		const d1 = page1.data as {
			comments: {
				items: Array<{cursor: string; node: {id: string; body: string}}>;
				pagination: {hasNext: boolean; nextCursor?: string};
			};
		};
		expect(d1.comments.items.map((e) => e.node.id)).toEqual(commentIds.slice(0, 2));
		expect(d1.comments.pagination.hasNext).toBe(true);
		const cursor = d1.comments.pagination.nextCursor;
		expect(cursor).toBe(commentIds[1]); // cursor is the last node id

		// Page 2: after the page-1 cursor.
		const page2 = await fateOp({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId, comments: {first: 2, after: cursor}},
			select: ["id", "comments.id"],
		});
		expect(page2.ok).toBe(true);
		if (!page2.ok) return;
		const d2 = page2.data as {
			comments: {
				items: Array<{node: {id: string}}>;
				pagination: {hasNext: boolean; nextCursor?: string};
			};
		};
		expect(d2.comments.items.map((e) => e.node.id)).toEqual(commentIds.slice(2, 4));
		expect(d2.comments.pagination.hasNext).toBe(true);

		// Page 3: the last comment, no more.
		const page3 = await fateOp({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId, comments: {first: 2, after: d2.comments.pagination.nextCursor}},
			select: ["id", "comments.id"],
		});
		expect(page3.ok).toBe(true);
		if (!page3.ok) return;
		const d3 = page3.data as {
			comments: {items: Array<{node: {id: string}}>; pagination: {hasNext: boolean}};
		};
		expect(d3.comments.items.map((e) => e.node.id)).toEqual([commentIds[4]]);
		expect(d3.comments.pagination.hasNext).toBe(false);

		// No skips/dupes: the union of all page ids is exactly the 5 seeded.
		const allIds = [
			...d1.comments.items.map((e) => e.node.id),
			...d2.comments.items.map((e) => e.node.id),
			...d3.comments.items.map((e) => e.node.id),
		];
		expect(new Set(allIds).size).toBe(5);
		expect([...allIds].sort()).toEqual([...commentIds].sort());
	});

	it("Comment nodes carry the GraphQL scalar surface (author/authorId/myVote)", async () => {
		const result = await fateOp({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId, comments: {first: 1}},
			select: [
				"comments.id",
				"comments.body",
				"comments.author",
				"comments.authorId",
				"comments.score",
				"comments.myVote",
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const node = (result.data as {comments: {items: Array<{node: Record<string, unknown>}>}})
			.comments.items[0]!.node;
		expect(node.author).toBe("commenter 0");
		expect(node.authorId).toBe("pano-c0");
		expect(node.score).toBe(0);
		// Anonymous viewer → myVote null (parity with GraphQL signed-out path).
		expect(node.myVote).toBeNull();
	});
});
