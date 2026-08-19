import {describe, expect, it} from "vitest";
import {type ProfileStats, toProfileStatsState} from "./useProfileStats";

describe("toProfileStatsState", () => {
	it("projects a present snapshot into ok with its counts and karma", () => {
		const data: ProfileStats = {postCount: 3, commentCount: 7, definitionCount: 1, totalKarma: 12};
		expect(toProfileStatsState(data)).toEqual({status: "ok", stats: data});
	});

	it("maps a null snapshot to ok with all-zero counts and zero karma — empty is success, not error", () => {
		// #448: a null snapshot must NOT collapse into the value an `error` would render.
		expect(toProfileStatsState(null)).toEqual({
			status: "ok",
			stats: {postCount: 0, commentCount: 0, definitionCount: 0, totalKarma: 0},
		});
	});

	it("only projects the stat scalars, dropping extra snapshot fields", () => {
		const data: ProfileStats & {userId: string} = {
			postCount: 2,
			commentCount: 4,
			definitionCount: 6,
			totalKarma: 9,
			userId: "u_1",
		};
		expect(toProfileStatsState(data)).toEqual({
			status: "ok",
			stats: {postCount: 2, commentCount: 4, definitionCount: 6, totalKarma: 9},
		});
	});
});
