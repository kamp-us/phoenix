/**
 * The canonical profile activity-tile order (#2203), asserted DOM-free — the ONE
 * ordering shared by `/profile` and `/u/:username` is factored to a pure function
 * and pinned here (the pure-extraction idiom of `profileStandingLabel`). Before
 * this the two hand-derived headers rendered the same scalars in two orders; the
 * test is what keeps them from drifting apart again.
 */
import {describe, expect, it} from "vitest";
import {profileStatTiles} from "./profileStatTiles";

const counts = {definitionCount: 3, postCount: 5, commentCount: 7};

describe("profileStatTiles — the shared canonical activity order (#2203)", () => {
	it("orders the tiles tanım → başlık → yorum (sözlük is definition-first)", () => {
		expect(profileStatTiles(counts).map((t) => t.label)).toEqual(["tanım", "başlık", "yorum"]);
	});

	it("maps each count to its tile with the preserved e2e testid", () => {
		expect(profileStatTiles(counts)).toEqual([
			{key: "definitions", testId: "stat-definitions", value: 3, label: "tanım"},
			{key: "posts", testId: "stat-posts", value: 5, label: "başlık"},
			{key: "comments", testId: "stat-comments", value: 7, label: "yorum"},
		]);
	});

	it("never emits a karma tile — karma is appended by the flag-gated header, not this set", () => {
		expect(profileStatTiles(counts).some((t) => t.label === "karma")).toBe(false);
	});

	it("emits only lowercase-Turkish labels (user-facing convention)", () => {
		for (const tile of profileStatTiles(counts)) {
			expect(tile.label).toBe(tile.label.toLocaleLowerCase("tr-TR"));
		}
	});
});
