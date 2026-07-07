/**
 * `toBasePost` — the viewer-invariant base projection (#2322, epic #2316 leg B): the
 * wire `Post` MINUS the two viewer scalars (`myVote`/`isSaved`). Pure shaping, so it is
 * unit-reachable (no DB). The load-bearing AC is byte-identity: because the base strips
 * the only viewer-derived fields, its output is the SAME for any viewer-scalar input —
 * which is exactly what makes the GET-able base feed cacheable and identical for anon vs
 * signed-in. Proven here at the shaper (the route serializes this verbatim), with the
 * anon-vs-authed round-trip left to the integration tier.
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
		// The same post as it would be stamped for a voter, for a non-voter, and unstamped:
		// the base projection collapses all three to ONE serialization.
		const voter = toBasePost(baseFields({myVote: true, isSaved: true}));
		const nonVoter = toBasePost(baseFields({myVote: false, isSaved: false}));
		const anon = toBasePost(baseFields({myVote: null, isSaved: null}));
		assert.strictEqual(JSON.stringify(voter), JSON.stringify(nonVoter));
		assert.strictEqual(JSON.stringify(voter), JSON.stringify(anon));
	});
});
