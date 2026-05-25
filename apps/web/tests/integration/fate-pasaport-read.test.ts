/**
 * fate pasaport reads — end-to-end against the live worker `/fate` route.
 *
 * Drives the real `/fate` HTTP surface inside workerd via `SELF.fetch`, after
 * seeding a user + username (so `user_profile` lands) and three contributions
 * (one definition, one post, one comment) through the live services against the
 * same `env.PHOENIX_DB` the worker reads. Asserts wire parity with the GraphQL
 * pasaport read surface:
 *
 *   - `profile(username)` returns the identity + live-aggregated counters.
 *   - `profile(username)` returns null for an unknown username.
 *   - `landingStats` returns the four counters + the build `version`.
 *   - `Profile.contributions` is a **discriminant** feed — every node carries a
 *     `kind` (`definition | post | comment`) the profile page switches on.
 *   - `Profile.contributions` paginates via a DB keyset in `(createdAt desc,
 *     id desc)` order, with the `<epochSeconds>:<id>` cursor — no skips/dupes
 *     across pages, the discriminant preserved.
 *
 * `me` is exercised by the seam test (anonymous → UNAUTHORIZED) and the
 * mutations test (full row after a session is baked); the HTTP route here can't
 * forge a session cookie, so authenticated `me` is covered there.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env, SELF} from "cloudflare:test";
import {Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {Pano, PanoLive} from "../../worker/features/pano/Pano";
import {Pasaport, PasaportLive} from "../../worker/features/pasaport/Pasaport";
import {Sozluk, SozlukLive} from "../../worker/features/sozluk/Sozluk";
import {VoteLive} from "../../worker/features/vote/Vote";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = Layer.mergeAll(
	PasaportLive,
	Layer.mergeAll(SozlukLive, PanoLive).pipe(Layer.provideMerge(VoteLive)),
).pipe(Layer.provide(DrizzleLive), Layer.provide(Layer.succeed(CloudflareEnv, env)));

const run = <A, E, R extends Pasaport | Sozluk | Pano>(eff: Effect.Effect<A, E, R>) =>
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

async function waitFor<T>(check: () => Promise<T | null>, attempts = 30): Promise<T | null> {
	for (let i = 0; i < attempts; i++) {
		const v = await check();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function signUpUser(email: string, password: string, name: string): Promise<string> {
	const req = new Request("https://test.local/api/auth/sign-up/email", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({email, password, name}),
	});
	const response = await run(
		Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			return yield* pasaport.handleAuth(req);
		}),
	);
	if (!response.ok) {
		throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
	}
	const data = (await response.json()) as {user?: {id: string}};
	if (!data.user?.id) throw new Error("sign-up returned no user id");
	return data.user.id;
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

const USERNAME = "fate-profile-user";
let USER_ID = "";

beforeAll(async () => {
	await applyViewMigrations();
	USER_ID = await signUpUser("fate-profile@test.local", "supersecret123", "Fate Profile");
	await run(
		Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			yield* pasaport.setUsername({userId: USER_ID, value: USERNAME});
		}),
	);
	// Seed one of each contribution kind so the discriminant feed is mixed.
	await run(
		Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.addDefinition({
				termSlug: "fate-profile-term",
				termTitle: "Fate Profile Term",
				authorId: USER_ID,
				authorName: "Fate Profile",
				body: "a seeded definition for the profile feed",
			});
		}),
	);
	const post = await run(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.submitPost({
				title: "fate profile post",
				url: "https://example.com/fate-profile",
				body: "a seeded post",
				tags: [{kind: "tartışma"}],
				authorId: USER_ID,
				authorName: "Fate Profile",
			});
		}),
	);
	await run(
		Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.addComment({
				postId: post.postId,
				authorId: USER_ID,
				authorName: "Fate Profile",
				body: "a seeded comment",
			});
		}),
	);
	// Wait for all three view rows to land.
	await waitFor(async () => {
		const row = await env.PHOENIX_DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM definition_view WHERE author_id = ?1) +
				(SELECT COUNT(*) FROM post_summary WHERE author_id = ?1) +
				(SELECT COUNT(*) FROM comment_view WHERE author_id = ?1) AS n`,
		)
			.bind(USER_ID)
			.first<{n: number}>();
		return row && row.n === 3 ? row : null;
	});
});

describe("fate pasaport reads — /fate", () => {
	it("profile(username) returns identity + live-aggregated counters", async () => {
		const result = await fateOp({
			kind: "query",
			name: "profile",
			args: {username: USERNAME},
			select: [
				"userId",
				"username",
				"displayName",
				"totalKarma",
				"definitionCount",
				"postCount",
				"commentCount",
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			userId: string;
			username: string;
			displayName: string | null;
			definitionCount: number;
			postCount: number;
			commentCount: number;
		};
		expect(data.userId).toBe(USER_ID);
		expect(data.username).toBe(USERNAME);
		expect(data.displayName).toBe("Fate Profile");
		expect(data.definitionCount).toBe(1);
		expect(data.postCount).toBe(1);
		expect(data.commentCount).toBe(1);
	});

	it("profile(username) returns null for an unknown username", async () => {
		const result = await fateOp({
			kind: "query",
			name: "profile",
			args: {username: "no-such-user-99999"},
			select: ["userId"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBeNull();
	});

	it("landingStats returns the four counters plus the build version", async () => {
		const result = await fateOp({
			kind: "query",
			name: "landingStats",
			select: ["id", "totalDefinitions", "totalPosts", "totalComments", "totalAuthors", "version"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			id: string;
			totalDefinitions: number;
			totalPosts: number;
			totalComments: number;
			totalAuthors: number;
			version: string;
		};
		// `LandingStats` is a singleton entity stamped with a constant id so the
		// client normalizes it to a single cache record.
		expect(data.id).toBe("landing");
		// Parity with GraphQL: counters reflect the live DB (>= the seeded set),
		// version is the build tag.
		expect(data.totalDefinitions).toBeGreaterThanOrEqual(1);
		expect(data.totalPosts).toBeGreaterThanOrEqual(1);
		expect(data.totalComments).toBeGreaterThanOrEqual(1);
		expect(data.totalAuthors).toBeGreaterThanOrEqual(1);
		expect(data.version).toBe("v0.3");
	});

	it("Profile.contributions is a mixed discriminant feed (kind per node)", async () => {
		const result = await fateOp({
			kind: "query",
			name: "profile",
			args: {username: USERNAME, contributions: {first: 10}},
			select: [
				"username",
				"contributions.kind",
				"contributions.id",
				"contributions.score",
				"contributions.termSlug",
				"contributions.title",
				"contributions.postId",
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			contributions: {
				items: Array<{cursor: string; node: {kind: string; id: string}}>;
				pagination: {hasNext: boolean};
			};
		};
		expect(data.contributions.items.length).toBe(3);
		const kinds = data.contributions.items.map((e) => e.node.kind).sort();
		expect(kinds).toEqual(["comment", "definition", "post"]);
		// Cursor is the `<epochSeconds>:<id>` keyset key.
		for (const e of data.contributions.items) {
			expect(e.cursor).toMatch(/^\d+:.+$/);
		}
		expect(data.contributions.pagination.hasNext).toBe(false);
	});

	it("Profile.contributions paginates by DB keyset with no skips/dupes, discriminant preserved", async () => {
		// Page 1: first 2 in (createdAt desc, id desc) order.
		const page1 = await fateOp({
			kind: "query",
			name: "profile",
			args: {username: USERNAME, contributions: {first: 2}},
			select: ["username", "contributions.kind", "contributions.id"],
		});
		expect(page1.ok).toBe(true);
		if (!page1.ok) return;
		const d1 = page1.data as {
			contributions: {
				items: Array<{cursor: string; node: {kind: string; id: string}}>;
				pagination: {hasNext: boolean; nextCursor?: string};
			};
		};
		expect(d1.contributions.items.length).toBe(2);
		expect(d1.contributions.pagination.hasNext).toBe(true);
		const cursor = d1.contributions.pagination.nextCursor;
		expect(cursor).toBeDefined();
		// Cursor is the last node's keyset key (`<sec>:<id>`, ends with its id).
		expect(cursor!.endsWith(d1.contributions.items[1]!.node.id)).toBe(true);

		// Page 2: after the page-1 cursor → the final contribution.
		const page2 = await fateOp({
			kind: "query",
			name: "profile",
			args: {username: USERNAME, contributions: {first: 2, after: cursor}},
			select: ["username", "contributions.kind", "contributions.id"],
		});
		expect(page2.ok).toBe(true);
		if (!page2.ok) return;
		const d2 = page2.data as {
			contributions: {
				items: Array<{node: {kind: string; id: string}}>;
				pagination: {hasNext: boolean};
			};
		};
		expect(d2.contributions.items.length).toBe(1);
		expect(d2.contributions.pagination.hasNext).toBe(false);

		// No skips/dupes: union of all page ids is exactly the 3 seeded; every
		// node still carries a valid discriminant `kind`.
		const allNodes = [...d1.contributions.items, ...d2.contributions.items].map((e) => e.node);
		expect(new Set(allNodes.map((n) => n.id)).size).toBe(3);
		expect(new Set(allNodes.map((n) => n.kind))).toEqual(
			new Set(["comment", "definition", "post"]),
		);
	});
});
