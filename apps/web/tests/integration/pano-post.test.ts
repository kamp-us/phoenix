/**
 * Pano read paths — Effect service surface (effect-migration task 5).
 *
 * Seed via `Pano.submitPost`, verify reads through `Pano.getPost` and the
 * cross-entity `Pano.listPostsConnection` path. Wire codes preserved; the
 * only change is the call form (Effect over Promise).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:workers";
import {Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {Pano, PanoLive, type SubmitPostInput} from "../../worker/features/pano/Pano";
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

function submitPost(input: SubmitPostInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.submitPost(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function getPost(postId: string) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.getPost(postId);
		}).pipe(Effect.provide(TestLive)),
	);
}

function listPostsConnection(opts: {
	sort?: "hot" | "new" | "top" | "discuss";
	first?: number;
	host?: string | null;
}) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.listPostsConnection(opts);
		}).pipe(Effect.provide(TestLive)),
	);
}

async function applyViewMigrations() {
	const sources = [baselineMigration];
	for (const src of sources) {
		const statements = src
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
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("pano — read paths", () => {
	it("submits a post, reads it back via getPost and via listPostsConnection", async () => {
		const result = await submitPost({
			title: "phoenix nasıl tek worker'da çalışıyor",
			url: "https://example.com/phoenix",
			body: "Tek deploy, tek bind, tek SPA.",
			authorId: "u1",
			authorName: "umut",
			tags: [{kind: "göster", label: "göster"}],
		});

		expect(result.postId).toMatch(/^post_/);

		const post = await getPost(result.postId);
		expect(post).not.toBeNull();
		expect(post!.id).toBe(result.postId);
		expect(post!.title).toContain("phoenix");
		expect(post!.url).toBe("https://example.com/phoenix");
		expect(post!.host).toBe("example.com");
		expect(post!.author).toBe("umut");
		expect(post!.score).toBe(0);
		expect(post!.commentCount).toBe(0);
		expect(post!.tags).toHaveLength(1);
		expect(post!.tags[0]!.kind).toBe("göster");

		const page = await listPostsConnection({sort: "new", first: 100});
		const summary = page.rows.find((s) => s.id === result.postId);
		expect(summary).toBeDefined();
		expect(summary!.title).toContain("phoenix");
		expect(summary!.url).toBe("https://example.com/phoenix");
		expect(summary!.host).toBe("example.com");
		expect(summary!.score).toBe(0);
		expect(summary!.tags).toHaveLength(1);
		expect(summary!.tags[0]!.kind).toBe("göster");
	});

	it("getPost returns null for an unknown post id", async () => {
		const post = await getPost("post_DOES_NOT_EXIST");
		expect(post).toBeNull();
	});

	it("host filter on listPostsConnection narrows to the requested host", async () => {
		const tag = Date.now().toString(36);
		const hostA = `${tag}-a.example.com`;
		const hostB = `${tag}-b.example.com`;

		const a = await submitPost({
			title: "host a post",
			url: `https://${hostA}/x`,
			authorId: "u1",
			authorName: "umut",
			tags: [{kind: "meta"}],
		});
		const b = await submitPost({
			title: "host b post",
			url: `https://${hostB}/x`,
			authorId: "u1",
			authorName: "umut",
			tags: [{kind: "meta"}],
		});

		const filtered = await listPostsConnection({host: hostA, first: 50});
		const ids = filtered.rows.map((p) => p.id);
		expect(ids).toContain(a.postId);
		expect(ids).not.toContain(b.postId);
	});
});
