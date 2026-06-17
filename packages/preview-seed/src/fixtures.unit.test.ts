/**
 * Fixture-content invariants — the pure core, asserted without a DB. These pin
 * exactly the properties the unauth e2e specs depend on (so a fixture edit that
 * would break a spec breaks a test here first).
 */
import {assert, describe, it} from "@effect/vitest";
import {buildFixtures, SEED_POST_ID, SEED_TERM_SLUG} from "./fixtures.ts";

describe("buildFixtures — sözlük content (07-sozluk-term, 00-smoke)", () => {
	it("seeds at least one term with the stable slug", () => {
		const {terms} = buildFixtures();
		assert.isAtLeast(terms.length, 1);
		assert.isTrue(terms.some((t) => t.slug === SEED_TERM_SLUG));
	});

	it("every term row has the NOT NULL columns the /sozluk list reads", () => {
		for (const t of buildFixtures().terms) {
			assert.isTrue(typeof t.slug === "string" && t.slug.length > 0);
			assert.isTrue(typeof t.title === "string" && t.title.length > 0);
			assert.isTrue(typeof t.firstLetter === "string" && t.firstLetter.length > 0);
		}
	});

	it("first_letter is the lower-cased first character of the title", () => {
		for (const t of buildFixtures().terms) {
			assert.strictEqual(t.firstLetter, t.title[0]?.toLocaleLowerCase("tr"));
		}
	});

	it("seeds at least one non-deleted definition for the seeded term", () => {
		const {definitions} = buildFixtures();
		const forTerm = definitions.filter((d) => d.termSlug === SEED_TERM_SLUG);
		assert.isAtLeast(forTerm.length, 1);
		// deleted_at must be unset so the term page (WHERE deleted_at IS NULL) lists it.
		assert.isTrue(forTerm.every((d) => d.deletedAt == null));
	});

	it("definition rows carry the columns the card renders (body, excerpt, author)", () => {
		for (const d of buildFixtures().definitions) {
			assert.isTrue(typeof d.id === "string" && d.id.length > 0);
			assert.isTrue(typeof d.body === "string" && d.body.length > 0);
			assert.isTrue(typeof d.bodyExcerpt === "string" && d.bodyExcerpt.length > 0);
			assert.isTrue(typeof d.authorName === "string" && d.authorName.length > 0);
		}
	});
});

describe("buildFixtures — pano content (03-pano-feed, 00-smoke)", () => {
	it("seeds at least one non-deleted post with the stable id (the /pano/<id> route value)", () => {
		const {posts} = buildFixtures();
		assert.isAtLeast(posts.length, 1);
		const post = posts.find((p) => p.id === SEED_POST_ID);
		assert.isDefined(post);
		assert.isTrue(post?.deletedAt == null);
	});

	it("post rows carry the NOT NULL columns the hot feed reads", () => {
		for (const p of buildFixtures().posts) {
			assert.isTrue(typeof p.title === "string" && p.title.length > 0);
			assert.isTrue(typeof p.authorName === "string" && p.authorName.length > 0);
			assert.isTrue(typeof p.tags === "string");
			assert.isTrue(typeof p.hotScore === "number");
		}
	});
});

describe("buildFixtures — determinism (idempotency precondition)", () => {
	it("is deterministic for a fixed clock (same identity, re-run upserts the same rows)", () => {
		const now = new Date("2026-01-01T00:00:00Z");
		assert.deepStrictEqual(buildFixtures(now), buildFixtures(now));
	});
});
