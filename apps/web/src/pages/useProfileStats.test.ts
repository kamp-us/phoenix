import {describe, expect, it} from "vitest";
import {type ProfileStats, toProfileStatsState} from "./useProfileStats";

describe("toProfileStatsState", () => {
	it("projects a present snapshot into ok with its counts", () => {
		const data: ProfileStats = {postCount: 3, commentCount: 7, definitionCount: 1};
		expect(toProfileStatsState(data)).toEqual({status: "ok", stats: data});
	});

	it("maps a null snapshot to ok with all-zero counts — empty is success, not error", () => {
		// The regression this guards (#448): a real zero-activity user resolves to a
		// successful `ok` with zeros, so it stays distinguishable from the hook's
		// `error` state (which only the catch branch produces). A null snapshot must
		// NOT collapse into the same value an error would render.
		expect(toProfileStatsState(null)).toEqual({
			status: "ok",
			stats: {postCount: 0, commentCount: 0, definitionCount: 0},
		});
	});

	it("only projects the count scalars, dropping extra snapshot fields", () => {
		// A snapshot carrying more than the count scalars (here the selected `userId`)
		// is a structural ProfileStats supertype, so it passes to the helper with no
		// cast — and the assertion below proves the extra field is dropped.
		const data: ProfileStats & {userId: string} = {
			postCount: 2,
			commentCount: 4,
			definitionCount: 6,
			userId: "u_1",
		};
		expect(toProfileStatsState(data)).toEqual({
			status: "ok",
			stats: {postCount: 2, commentCount: 4, definitionCount: 6},
		});
	});
});
