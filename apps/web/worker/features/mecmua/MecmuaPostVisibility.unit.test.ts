/**
 * The mecmua draft/publish visibility matrix. The load-bearing cell: a null-`publishedAt`
 * draft is hidden from every non-author. mecmua has NO sandbox arm, so there is no
 * moderator-exemption cell to pin. The SQL mirror, `mecmuaPostVisibleWhere`, is proven off
 * its rendered predicate in `public-read-route.unit.test.ts` and `index-route.unit.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	anonymousMecmuaViewer,
	type MecmuaPostViewer,
	mecmuaPostVisibleTo,
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
});
