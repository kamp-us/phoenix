/**
 * Pano D1-direct post read paths (task_7, d1-direct).
 *
 * Mirrors `sozluk-term.test.ts` for the post side: seed via `submitPost`,
 * verify reads through `getPost` and the cross-entity `listPostSummaries`
 * D1 reader.
 *
 * No `runInDurableObject`, no projection workflow — the writes are inline
 * D1 (ADR 0009).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import viewMigration0000 from "../../worker/db/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/db/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/db/drizzle/migrations/0002_wandering_natasha_romanoff.sql";
import viewMigration0003 from "../../worker/db/drizzle/migrations/0003_lazy_thanos.sql";
import viewMigration0004 from "../../worker/db/drizzle/migrations/0004_brown_squadron_supreme.sql";
import viewMigration0005 from "../../worker/db/drizzle/migrations/0005_d1_direct_sozluk.sql";
import viewMigration0006 from "../../worker/db/drizzle/migrations/0006_d1_direct_pano.sql";
import {getPost, submitPost} from "../../worker/features/pano/module";
import {listPostSummaries} from "../../worker/features/pano/postSummaryReader";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [
		viewMigration0000,
		viewMigration0001,
		viewMigration0002,
		viewMigration0003,
		viewMigration0004,
		viewMigration0005,
		viewMigration0006,
	];
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

describe("pano — read paths after d1-direct migration", () => {
	it("submits a post, reads it back via getPost and via post_summary listing", async () => {
		const result = await submitPost(env, {
			title: "phoenix nasıl tek worker'da çalışıyor",
			url: "https://example.com/phoenix",
			body: "Tek deploy, tek bind, tek SPA.",
			authorId: "u1",
			authorName: "umut",
			tags: [{kind: "göster", label: "göster"}],
		});

		expect(result.postId).toMatch(/^post_/);

		// Read path 1: direct D1 single-post read.
		const post = await getPost(env, result.postId);
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

		// Read path 2: cross-entity D1 view (same source of truth under
		// d1-direct — no projection step required).
		const summaries = await listPostSummaries(env.PHOENIX_DB, {sort: "new", limit: 100});
		const summary = summaries.find((s) => s.id === result.postId);
		expect(summary).toBeDefined();
		expect(summary!.title).toContain("phoenix");
		expect(summary!.url).toBe("https://example.com/phoenix");
		expect(summary!.host).toBe("example.com");
		expect(summary!.score).toBe(0);
		expect(summary!.tags).toHaveLength(1);
		expect(summary!.tags[0]!.kind).toBe("göster");
	});

	it("getPost returns null for an unknown post id", async () => {
		const post = await getPost(env, "post_DOES_NOT_EXIST");
		expect(post).toBeNull();
	});

	it("host filter on listPostSummaries narrows to the requested host", async () => {
		// Use a unique host per test run to avoid noise from sibling tests.
		const tag = Date.now().toString(36);
		const hostA = `${tag}-a.example.com`;
		const hostB = `${tag}-b.example.com`;

		const a = await submitPost(env, {
			title: "host a post",
			url: `https://${hostA}/x`,
			authorId: "u1",
			authorName: "umut",
			tags: [{kind: "meta"}],
		});
		const b = await submitPost(env, {
			title: "host b post",
			url: `https://${hostB}/x`,
			authorId: "u1",
			authorName: "umut",
			tags: [{kind: "meta"}],
		});

		const filtered = await listPostSummaries(env.PHOENIX_DB, {host: hostA, limit: 50});
		const ids = filtered.map((p) => p.id);
		expect(ids).toContain(a.postId);
		expect(ids).not.toContain(b.postId);
	});
});
