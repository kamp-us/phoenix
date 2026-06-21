/**
 * Pano submit-validation unit coverage (ADR 0082) — the post/draft/comment input
 * checks that are wrong-or-right with NO database.
 *
 * `submitPost` / `saveDraft` / `addComment` run these pure validators BEFORE any
 * DB read, so the length/format/URL/tag rejections are pure logic on the input —
 * they could never be wrong just because the database differed (ADR 0082 litmus).
 * Each is now an exported module-level function with no `Drizzle` dependency at
 * all, so calling it directly is itself the "no DB read" proof: there is no seam
 * to a database to reach. The DB-state-dependent rejections of the same mutations
 * (`POST_NOT_FOUND`, `PARENT_NOT_FOUND`, `UNAUTHORIZED`) stay on real D1 in
 * `tests/integration/pano-*.test.ts` — those are only-wrong-if-the-DB-differs.
 */

import {Cause, Effect, Exit} from "effect";
import {assert, describe, expect, it} from "vitest";
import {
	normalizeDraftTags,
	normalizeSubmitTags,
	POST_BODY_MAX,
	POST_TITLE_MAX,
	parseSubmitUrl,
	validateCommentBody,
	validateDraftTitle,
	validatePostBody,
	validatePostTitle,
} from "./Pano.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSyncExit(effect);

const expectTag = (exit: Exit.Exit<unknown, unknown>, tag: string) => {
	assert.isTrue(Exit.isFailure(exit), "expected the validator to fail");
	if (Exit.isFailure(exit)) {
		const error = Cause.findErrorOption(exit.cause);
		assert.isTrue(error._tag === "Some", "expected a typed failure, not a die");
		if (error._tag === "Some") {
			assert.strictEqual((error.value as {_tag: string})._tag, tag);
		}
	}
};

const expectValue = <A>(exit: Exit.Exit<A, unknown>): A => {
	assert.isTrue(Exit.isSuccess(exit), "expected the validator to succeed");
	if (Exit.isSuccess(exit)) return exit.value;
	throw new Error("unreachable");
};

describe("Pano.validatePostTitle", () => {
	it("an empty title rejects with TitleRequired", () => {
		expectTag(run(validatePostTitle("")), "pano/TitleRequired");
	});

	it("a whitespace-only title rejects with TitleRequired", () => {
		expectTag(run(validatePostTitle("   ")), "pano/TitleRequired");
	});

	it("a title over the max rejects with TitleTooLong", () => {
		expectTag(run(validatePostTitle("a".repeat(POST_TITLE_MAX + 1))), "pano/TitleTooLong");
	});

	it("a valid title returns trimmed", () => {
		expect(expectValue(run(validatePostTitle("  hello  ")))).toBe("hello");
	});
});

describe("Pano.validateDraftTitle", () => {
	it("an empty draft title is allowed (no required gate)", () => {
		expect(expectValue(run(validateDraftTitle("")))).toBe("");
	});

	it("a draft title over the max still rejects with TitleTooLong", () => {
		expectTag(run(validateDraftTitle("a".repeat(POST_TITLE_MAX + 1))), "pano/TitleTooLong");
	});

	it("a valid draft title returns trimmed", () => {
		expect(expectValue(run(validateDraftTitle("  taslak  ")))).toBe("taslak");
	});
});

describe("Pano.validatePostBody", () => {
	it("an empty body normalizes to null", () => {
		expect(expectValue(run(validatePostBody("")))).toBeNull();
	});

	it("a body over the max rejects with PostBodyTooLong", () => {
		expectTag(run(validatePostBody("a".repeat(POST_BODY_MAX + 1))), "pano/PostBodyTooLong");
	});

	it("a non-empty body within the cap returns verbatim", () => {
		expect(expectValue(run(validatePostBody("gövde")))).toBe("gövde");
	});
});

describe("Pano.validateCommentBody", () => {
	it("an undefined body rejects with CommentBodyRequired", () => {
		expectTag(run(validateCommentBody(undefined)), "pano/CommentBodyRequired");
	});

	it("a whitespace-only body rejects with CommentBodyRequired", () => {
		expectTag(run(validateCommentBody("   ")), "pano/CommentBodyRequired");
	});

	it("a body over the max rejects with CommentBodyTooLong", () => {
		expectTag(run(validateCommentBody("a".repeat(5_001))), "pano/CommentBodyTooLong");
	});

	it("a valid body returns verbatim (untrimmed)", () => {
		expect(expectValue(run(validateCommentBody(" yorum ")))).toBe(" yorum ");
	});
});

describe("Pano.parseSubmitUrl", () => {
	it("a null URL yields no host / no normalized url", () => {
		expect(expectValue(run(parseSubmitUrl(null)))).toEqual({host: null, urlNormalized: null});
	});

	it("an empty URL yields no host / no normalized url", () => {
		expect(expectValue(run(parseSubmitUrl("")))).toEqual({host: null, urlNormalized: null});
	});

	it("a malformed URL rejects with UrlInvalid", () => {
		expectTag(run(parseSubmitUrl("not a url")), "pano/UrlInvalid");
	});

	it("a valid URL is normalized and the host extracted", () => {
		const value = expectValue(run(parseSubmitUrl("https://example.com/path")));
		expect(value.host).toBe("example.com");
		expect(value.urlNormalized).toBe("https://example.com/path");
	});
});

describe("Pano.normalizeSubmitTags", () => {
	it("an empty tag list rejects with TagsRequired", () => {
		expectTag(run(normalizeSubmitTags([])), "pano/TagsRequired");
	});

	it("an absent tag list rejects with TagsRequired", () => {
		expectTag(run(normalizeSubmitTags(null)), "pano/TagsRequired");
	});

	it("a tag outside the fixed enum rejects with TagInvalid", () => {
		expectTag(run(normalizeSubmitTags([{kind: "nope"}])), "pano/TagInvalid");
	});

	it("valid tags normalize, dedupe by kind, and default the label to the kind", () => {
		const value = expectValue(
			run(normalizeSubmitTags([{kind: "soru"}, {kind: "soru"}, {kind: "meta", label: "M"}])),
		);
		expect(value).toEqual([
			{kind: "soru", label: "soru"},
			{kind: "meta", label: "M"},
		]);
	});
});

describe("Pano.normalizeDraftTags", () => {
	it("an absent tag list yields an empty list (no required gate)", () => {
		expect(expectValue(run(normalizeDraftTags(undefined)))).toEqual([]);
	});

	it("empty kinds are skipped, not rejected", () => {
		expect(expectValue(run(normalizeDraftTags([{kind: "  "}, {kind: "soru"}])))).toEqual([
			{kind: "soru", label: "soru"},
		]);
	});

	it("a non-empty kind outside the fixed enum still rejects with TagInvalid", () => {
		expectTag(run(normalizeDraftTags([{kind: "nope"}])), "pano/TagInvalid");
	});
});
