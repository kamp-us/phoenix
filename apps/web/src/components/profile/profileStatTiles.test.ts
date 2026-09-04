import {describe, expect, it} from "vitest";
import {tr} from "../../i18n/tr";
import {profileStatTiles} from "./profileStatTiles";

const labelled = (counts: Parameters<typeof profileStatTiles>[0]) =>
	profileStatTiles(counts).map(({labelKey, ...tile}) => ({...tile, label: tr[labelKey]}));

const counts = {definitionCount: 3, postCount: 5, commentCount: 7};

describe("profileStatTiles — the shared canonical activity order (#2203)", () => {
	it("orders the tiles tanım → başlık → yorum (sözlük is definition-first)", () => {
		expect(labelled(counts).map((t) => t.label)).toEqual(["tanım", "başlık", "yorum"]);
	});

	it("maps each count to its tile with the preserved e2e testid", () => {
		expect(labelled(counts)).toEqual([
			{key: "definitions", testId: "stat-definitions", value: 3, label: "tanım"},
			{key: "posts", testId: "stat-posts", value: 5, label: "başlık"},
			{key: "comments", testId: "stat-comments", value: 7, label: "yorum"},
		]);
	});

	it("never emits a karma tile — karma is appended by the flag-gated header, not this set", () => {
		expect(labelled(counts).some((t) => t.label === "karma")).toBe(false);
	});

	it("emits only lowercase-Turkish labels (user-facing convention)", () => {
		for (const tile of labelled(counts)) {
			expect(tile.label).toBe(tile.label.toLocaleLowerCase("tr-TR"));
		}
	});
});
