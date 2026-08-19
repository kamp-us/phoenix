/**
 * The mecmua draft/publish visibility matrix. The load-bearing cell: a null-`publishedAt`
 * draft is hidden from every non-author. mecmua has NO sandbox arm, so there is no
 * moderator-exemption cell to pin.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	anonymousMecmuaViewer,
	type MecmuaPostViewer,
	mecmuaPostVisibleTo,
	mecmuaPostVisibleWhere,
} from "./MecmuaPostVisibility.ts";

const publishedAt = new Date("2026-06-27T00:00:00.000Z");
const AUTHOR = "the-author";
const OTHER = "someone-else";

const viewers = {
	anonymous: anonymousMecmuaViewer,
	author: {viewerId: AUTHOR},
	otherMember: {viewerId: OTHER},
} satisfies Record<string, MecmuaPostViewer>;

const matrix: Record<
	string,
	{publishedAt: Date | null; expect: Record<keyof typeof viewers, boolean>}
> = {
	Published: {
		publishedAt,
		expect: {anonymous: true, author: true, otherMember: true},
	},
	Draft: {
		publishedAt: null,
		expect: {anonymous: false, author: true, otherMember: false},
	},
};

describe("mecmuaPostVisibleTo — the published × viewer visibility matrix", () => {
	for (const [stateName, {publishedAt: at, expect}] of Object.entries(matrix)) {
		for (const [viewerName, viewer] of Object.entries(viewers)) {
			const want = expect[viewerName as keyof typeof viewers];
			it(`${stateName} content is ${want ? "visible" : "hidden"} to ${viewerName}`, () => {
				assert.strictEqual(mecmuaPostVisibleTo(at, AUTHOR, viewer), want);
			});
		}
	}

	it("a null-publishedAt draft is hidden from a public read (the mask), a published row is exposed", () => {
		assert.isFalse(mecmuaPostVisibleTo(null, AUTHOR, anonymousMecmuaViewer));
		assert.isTrue(mecmuaPostVisibleTo(publishedAt, AUTHOR, anonymousMecmuaViewer));
	});

	it("the author sees their OWN draft but not ANOTHER author's draft", () => {
		assert.isTrue(mecmuaPostVisibleTo(null, AUTHOR, viewers.author));
		assert.isFalse(mecmuaPostVisibleTo(null, OTHER, viewers.author));
	});
});

describe("mecmuaPostVisibleWhere — the SQL mirror's predicate shape", () => {
	const cols = {publishedAt: {} as never, authorId: {} as never};

	it("an anonymous viewer gets a restricting predicate (bare published test)", () => {
		assert.isDefined(mecmuaPostVisibleWhere(cols, anonymousMecmuaViewer));
	});

	it("a signed-in member gets a restricting predicate (published OR own)", () => {
		assert.isDefined(mecmuaPostVisibleWhere(cols, viewers.author));
	});
});
