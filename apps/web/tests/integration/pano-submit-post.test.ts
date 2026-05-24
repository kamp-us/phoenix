/**
 * Pano `submitPost` — Effect service path (effect-migration task 5).
 *
 * Exercises `PanoLive` + `VoteLive` + `DrizzleLive` end-to-end against
 * `env.PHOENIX_DB` inside workerd. Wire codes preserved verbatim; the only
 * change versus the pre-effect-migration shape is the call form (Effect over
 * Promise) and the typed `PostValidation` failure channel.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:workers";
import {Cause, Effect, Exit, Layer} from "effect";
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

function submitPost(input: SubmitPostInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.submitPost(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

async function expectValidation(program: Effect.Effect<unknown, unknown, never>, code: string) {
	const exit = await Effect.runPromise(Effect.exit(program));
	if (Exit.isSuccess(exit)) throw new Error("expected validation failure");
	const found = Cause.findError(exit.cause);
	if (found._tag !== "Success") throw new Error("expected typed failure");
	const err = found.success as {_tag?: string; code?: string};
	expect(err._tag).toBe("pano/PostValidation");
	expect(err.code).toBe(code);
}

function submitProgram(input: SubmitPostInput) {
	return Effect.gen(function* () {
		const pano = yield* Pano;
		return yield* pano.submitPost(input);
	}).pipe(Effect.provide(TestLive));
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("pano.submitPost", () => {
	it("writes post_summary with denormalized author + tags + host", async () => {
		const result = await submitPost({
			title: "phoenix neden tek worker'da koşuyor",
			url: "https://example.com/phoenix-arch",
			body: "Tek deploy, tek bind, tek SPA — DO'lar incremental şekilde geliyor.",
			tags: [
				{kind: "tartışma", label: "tartışma"},
				{kind: "meta", label: "meta"},
			],
			authorId: "u-author-1",
			authorName: "umut",
		});

		expect(result.postId).toMatch(/^post_/);
		expect(result.host).toBe("example.com");
		expect(result.url).toBe("https://example.com/phoenix-arch");
		expect(result.tags.map((t) => t.kind)).toEqual(["tartışma", "meta"]);
		expect(result.score).toBe(0);
		expect(result.commentCount).toBe(0);

		const summary = (await env.PHOENIX_DB.prepare(
			"SELECT id, title, url, host, body, body_excerpt, author_id, author_name, tags, score, comment_count FROM post_summary WHERE id = ?",
		)
			.bind(result.postId)
			.first()) as {
			id: string;
			title: string;
			url: string;
			host: string;
			body: string;
			body_excerpt: string;
			author_id: string;
			author_name: string;
			tags: string;
			score: number;
			comment_count: number;
		} | null;

		expect(summary).not.toBeNull();
		expect(summary!.title).toContain("phoenix");
		expect(summary!.host).toBe("example.com");
		expect(summary!.url).toBe("https://example.com/phoenix-arch");
		expect(summary!.author_id).toBe("u-author-1");
		expect(summary!.author_name).toBe("umut");
		expect(summary!.tags).toBe("tartışma,meta");
		expect(summary!.score).toBe(0);
		expect(summary!.comment_count).toBe(0);
		expect(summary!.body).toContain("Tek deploy");
		expect(summary!.body_excerpt).toContain("Tek deploy");
	});

	it("rejects empty title with title_required", async () => {
		await expectValidation(
			submitProgram({
				title: "   ",
				tags: [{kind: "tartışma"}],
				authorId: "u1",
				authorName: "umut",
			}),
			"title_required",
		);
	});

	it("rejects titles over 200 chars with title_too_long", async () => {
		await expectValidation(
			submitProgram({
				title: "x".repeat(201),
				tags: [{kind: "tartışma"}],
				authorId: "u1",
				authorName: "umut",
			}),
			"title_too_long",
		);
	});

	it("rejects invalid URLs with url_invalid", async () => {
		await expectValidation(
			submitProgram({
				title: "valid title",
				url: "not a url",
				tags: [{kind: "tartışma"}],
				authorId: "u1",
				authorName: "umut",
			}),
			"url_invalid",
		);
	});

	it("rejects bodies over 10 000 chars with body_too_long", async () => {
		await expectValidation(
			submitProgram({
				title: "valid title",
				body: "x".repeat(10_001),
				tags: [{kind: "tartışma"}],
				authorId: "u1",
				authorName: "umut",
			}),
			"body_too_long",
		);
	});

	it("rejects empty tag list with tags_required", async () => {
		await expectValidation(
			submitProgram({
				title: "valid title",
				tags: [],
				authorId: "u1",
				authorName: "umut",
			}),
			"tags_required",
		);
	});

	it("rejects tags outside the fixed enum with tag_invalid", async () => {
		await expectValidation(
			submitProgram({
				title: "valid title",
				tags: [{kind: "haber"}],
				authorId: "u1",
				authorName: "umut",
			}),
			"tag_invalid",
		);
	});

	it("post_summary carries author_id + created_at so the (author_id, created_at DESC) index can serve the profile feed", async () => {
		const authorId = `u-idx-${Date.now().toString(36)}`;

		const first = await submitPost({
			title: "first post",
			tags: [{kind: "meta"}],
			authorId,
			authorName: "indexer",
		});

		// Force a 1100ms gap so created_at sec-resolution doesn't collapse the
		// two rows onto the same timestamp.
		await new Promise((r) => setTimeout(r, 1100));

		const second = await submitPost({
			title: "second post",
			tags: [{kind: "meta"}],
			authorId,
			authorName: "indexer",
		});

		const rows = await env.PHOENIX_DB.prepare(
			"SELECT id, title FROM post_summary WHERE author_id = ? ORDER BY created_at DESC",
		)
			.bind(authorId)
			.all();
		expect(rows.results.length).toBe(2);
		expect(rows.results[0]!.id).toBe(second.postId);
		expect(rows.results[1]!.id).toBe(first.postId);
	});
});
