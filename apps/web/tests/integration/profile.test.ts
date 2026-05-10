/**
 * Profile query + interleaved contributions feed integration test (T14).
 *
 * Exercises end-to-end inside workerd:
 *   1. Apply the D1 view migrations.
 *   2. Seed a Pasaport user, set a username, wait for `user_profile` to land.
 *   3. Drive `addDefinition`, `submitPost`, `addComment` so the per-DO outbox
 *      emits projection events and the MVs (`definition_view`, `post_summary`,
 *      `comment_view`) accumulate the author's contributions.
 *   4. Read `lookupProfile` + `listContributions` and assert:
 *      - profile aggregates match the seeded counts (1/1/1)
 *      - the feed interleaves all three kinds in `created_at DESC` order
 *      - cursor pagination yields disjoint pages
 *      - non-existent username returns null
 */
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import {listContributions, lookupProfile} from "../../worker/features/pasaport/userProfileReader";
import viewMigration0000 from "../../worker/view/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/view/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/view/drizzle/migrations/0002_wandering_natasha_romanoff.sql";
import viewMigration0003 from "../../worker/view/drizzle/migrations/0003_lazy_thanos.sql";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [viewMigration0000, viewMigration0001, viewMigration0002, viewMigration0003];
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

async function waitFor<T>(check: () => Promise<T | null>, attempts = 30): Promise<T | null> {
	for (let i = 0; i < attempts; i++) {
		const v = await check();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function signUpUser(email: string, password: string, name: string): Promise<string> {
	const stub = env.PASAPORT.get(env.PASAPORT.idFromName("kampus"));
	const req = new Request("https://example.com/api/auth/sign-up/email", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({email, password, name}),
	});
	const response = await stub.fetch(req);
	if (!response.ok) {
		throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
	}
	const data = (await response.json()) as {user?: {id: string}};
	if (!data.user?.id) throw new Error("sign-up returned no user id");
	return data.user.id;
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("profile query + interleaved contributions feed (T14)", () => {
	it("aggregates 1 definition + 1 post + 1 comment and returns the feed in created_at DESC order", async () => {
		// 1) sign up + bootstrap username
		const userId = await signUpUser("ada@kamp.us", "supersecret123", "Ada Lovelace");
		const pasaport = env.PASAPORT.get(env.PASAPORT.idFromName("kampus"));
		await pasaport.setUsername({userId, value: "ada"});

		// Wait for user_profile MV row to land before reading the profile.
		const profileSeed = await waitFor(async () => {
			const row = await env.PHOENIX_DB.prepare(
				"SELECT user_id FROM user_profile WHERE username = ?",
			)
				.bind("ada")
				.first<{user_id: string}>();
			return row;
		});
		expect(profileSeed).not.toBeNull();

		// 2) seed a definition
		const termSlug = "differential-engine";
		const termStub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(termSlug));
		await termStub.addDefinition({
			authorId: userId,
			authorName: "Ada Lovelace",
			body: "A mechanical general-purpose computer designed by Charles Babbage.",
			termTitle: "Differential Engine",
		});

		// 3) seed a post — DO name == post id (matches resolver)
		const postId = "post_t14_seed_one";
		const postStub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
		await postStub.submitPost({
			title: "ada's first post",
			url: "https://example.com/ada",
			body: "an opening note",
			tags: [{kind: "tartışma"}],
			authorId: userId,
			authorName: "Ada Lovelace",
		});

		// 4) seed a comment on the same post
		await postStub.addComment({
			authorId: userId,
			authorName: "Ada Lovelace",
			body: "kendi gönderime kendim yorum yazıyorum",
		});

		// 5) wait for all three view rows to land
		const defRow = await waitFor(async () =>
			env.PHOENIX_DB.prepare("SELECT id FROM definition_view WHERE author_id = ?")
				.bind(userId)
				.first<{id: string}>(),
		);
		expect(defRow).not.toBeNull();

		const postRow = await waitFor(async () =>
			env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE author_id = ?")
				.bind(userId)
				.first<{id: string}>(),
		);
		expect(postRow).not.toBeNull();

		const commentRow = await waitFor(async () =>
			env.PHOENIX_DB.prepare("SELECT id FROM comment_view WHERE author_id = ?")
				.bind(userId)
				.first<{id: string}>(),
		);
		expect(commentRow).not.toBeNull();

		// 6) read the profile and assert aggregates
		const profile = await lookupProfile(env.PHOENIX_DB, "ada");
		expect(profile).not.toBeNull();
		expect(profile!.username).toBe("ada");
		expect(profile!.definitionCount).toBe(1);
		expect(profile!.postCount).toBe(1);
		expect(profile!.commentCount).toBe(1);

		// 7) read the contributions feed
		const feed = await listContributions(env.PHOENIX_DB, {
			authorId: userId,
			after: null,
			first: 20,
		});
		expect(feed.edges.length).toBe(3);

		const kinds = feed.edges.map((e) => e.node.kind).sort();
		expect(kinds).toEqual(["comment", "definition", "post"].sort());

		// Ordering: created_at DESC. The comment was the latest write so it
		// should be first; the post second (submitted before the comment); the
		// definition first or last depending on ordering. Just assert the
		// timestamps are non-increasing.
		for (let i = 1; i < feed.edges.length; i++) {
			const prev = feed.edges[i - 1]!.node.createdAt.getTime();
			const cur = feed.edges[i]!.node.createdAt.getTime();
			expect(prev).toBeGreaterThanOrEqual(cur);
		}

		// All edges have a non-empty cursor
		for (const e of feed.edges) {
			expect(e.cursor).toMatch(/^\d+:.+$/);
		}
	});

	it("paginates with a forge ULID cursor (after returns disjoint pages)", async () => {
		const userId = await signUpUser("grace@kamp.us", "supersecret123", "Grace");
		const pasaport = env.PASAPORT.get(env.PASAPORT.idFromName("kampus"));
		await pasaport.setUsername({userId, value: "grace"});

		// Seed 5 definitions on different slugs so they get distinct ids.
		for (let i = 0; i < 5; i++) {
			const slug = `cursor-test-${i}`;
			const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
			await stub.addDefinition({
				authorId: userId,
				authorName: "Grace",
				body: `definition number ${i}`,
				termTitle: `cursor test ${i}`,
			});
		}

		// Wait for all 5 rows to land in definition_view.
		await waitFor(async () => {
			const row = await env.PHOENIX_DB.prepare(
				"SELECT COUNT(*) as n FROM definition_view WHERE author_id = ?",
			)
				.bind(userId)
				.first<{n: number}>();
			return row && row.n === 5 ? row : null;
		});

		const page1 = await listContributions(env.PHOENIX_DB, {
			authorId: userId,
			after: null,
			first: 2,
		});
		expect(page1.edges.length).toBe(2);
		expect(page1.hasNextPage).toBe(true);
		expect(page1.endCursor).not.toBeNull();

		const page2 = await listContributions(env.PHOENIX_DB, {
			authorId: userId,
			after: page1.endCursor,
			first: 2,
		});
		expect(page2.edges.length).toBe(2);

		// Disjoint: no overlap between page1 and page2 ids.
		const ids1 = new Set(page1.edges.map((e) => e.node.id));
		for (const e of page2.edges) {
			expect(ids1.has(e.node.id)).toBe(false);
		}

		// Page 3 picks up the final row.
		const page3 = await listContributions(env.PHOENIX_DB, {
			authorId: userId,
			after: page2.endCursor,
			first: 2,
		});
		expect(page3.edges.length).toBe(1);
		expect(page3.hasNextPage).toBe(false);
	});

	it("returns null for a non-existent username", async () => {
		const result = await lookupProfile(env.PHOENIX_DB, "nobody-here-1234567890");
		expect(result).toBeNull();
	});
});
