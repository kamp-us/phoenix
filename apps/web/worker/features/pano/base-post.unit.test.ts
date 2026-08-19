/**
 * `toBasePost` is the wire `Post` minus the two viewer scalars (#2322). The
 * load-bearing property is byte-identity: stripping the only viewer-derived fields
 * makes the output the same for any viewer-scalar input, which is what makes the
 * GET-able base feed cacheable. The anon-vs-authed round-trip is integration's job.
 */
import {assert, describe, it} from "@effect/vitest";
import type {PostFields} from "./post-fields.ts";
import {toBasePost, toPost} from "./shapers.ts";

const baseFields = (overrides: Partial<PostFields> = {}): PostFields => ({
	id: "p1",
	slug: "slug-1",
	title: "başlık",
	url: "https://example.com/a",
	host: "example.com",
	body: "gövde",
	author: "yazar",
	authorId: "u-author",
	authorUsername: "yazar",
	authorDisplayName: "Yazar",
	score: 3,
	commentCount: 2,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-02T00:00:00Z"),
	tags: [{kind: "tartışma", label: "tartışma"}],
	...overrides,
});

describe("toBasePost — viewer-invariant base projection (#2322)", () => {
	it("omits the myVote/isSaved viewer scalars entirely", () => {
		const base = toBasePost(baseFields({myVote: true, isSaved: true}));
		assert.isFalse(Object.hasOwn(base, "myVote"), "base carries no myVote");
		assert.isFalse(Object.hasOwn(base, "isSaved"), "base carries no isSaved");
	});

	it("keeps every non-viewer field identical to toPost", () => {
		const fields = baseFields();
		const {myVote: _mv, isSaved: _is, ...expected} = toPost(fields);
		assert.deepStrictEqual(toBasePost(fields), expected);
	});

	it("is byte-identical regardless of the viewer scalar input (the cacheable-base guarantee)", () => {
		// The base projection must collapse all three stampings to one serialization.
		const voter = toBasePost(baseFields({myVote: true, isSaved: true}));
		const nonVoter = toBasePost(baseFields({myVote: false, isSaved: false}));
		const anon = toBasePost(baseFields({myVote: null, isSaved: null}));
		assert.strictEqual(JSON.stringify(voter), JSON.stringify(nonVoter));
		assert.strictEqual(JSON.stringify(voter), JSON.stringify(anon));
	});
});
