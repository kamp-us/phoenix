import {describe, expect, it} from "vitest";
import {tr} from "../../i18n/tr";
import {profileStatTiles} from "./profileStatTiles";

const labelled = (counts: Parameters<typeof profileStatTiles>[0]) =>
	profileStatTiles(counts).map(({labelKey, ...tile}) => ({...tile, label: tr[labelKey]}));

const counts = {definitionCount: 3, postCount: 5, commentCount: 7};

describe("profileStatTiles — the shared canonical activity order (#2203)", () => {
	it("maps each count to its tile with the preserved e2e testid", () => {
		expect(labelled(counts)).toEqual([
			{key: "definitions", testId: "stat-definitions", value: 3, label: "tanım"},
			{key: "posts", testId: "stat-posts", value: 5, label: "başlık"},
			{key: "comments", testId: "stat-comments", value: 7, label: "yorum"},
		]);
	});
});
