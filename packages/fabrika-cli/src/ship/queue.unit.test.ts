import {describe, expect, it} from "vitest";
import {ADDED, landedOnBase, MERGED, queueStateOf, REMOVED, reopensSince} from "./queue.ts";

const at = (event: string, createdAt: string) => ({event, createdAt});

describe("queueStateOf", () => {
	it("is queued while the newest event is an addition", () => {
		expect(queueStateOf([at(ADDED, "2026-08-08T10:00:00Z")])).toBe("queued");
	});

	it("is queued when a re-addition follows an earlier removal", () => {
		expect(
			queueStateOf([
				at(ADDED, "2026-08-08T10:00:00Z"),
				at(REMOVED, "2026-08-08T10:05:00Z"),
				at(ADDED, "2026-08-08T10:06:00Z"),
			]),
		).toBe("queued");
	});

	it("is NOT ejected when the removal is paired with a merge — the #4155 false ejection", () => {
		expect(
			queueStateOf([
				at(ADDED, "2026-08-08T10:00:00Z"),
				at(REMOVED, "2026-08-08T10:09:59Z"),
				at(MERGED, "2026-08-08T10:10:00Z"),
			]),
		).toBe("none");
	});

	it("is ejected on a removal with no merge beside it", () => {
		expect(
			queueStateOf([at(ADDED, "2026-08-08T10:00:00Z"), at(REMOVED, "2026-08-08T10:09:59Z")]),
		).toBe("ejected");
	});

	it("is ejected when the only merge is far from the removal, not within the pairing window", () => {
		expect(
			queueStateOf([at(REMOVED, "2026-08-08T10:00:00Z"), at(MERGED, "2026-08-08T12:00:00Z")]),
		).toBe("ejected");
	});

	it("is none on an empty timeline — nothing observed is not an ejection", () => {
		expect(queueStateOf([])).toBe("none");
	});
});

describe("landedOnBase", () => {
	it("credits the PR whose number ENDS the subject", () => {
		expect(landedOnBase(["fix(x): a thing (#3924) (#4010)"], 4010)).toBe(true);
	});

	it("does NOT credit a number that merely appears in the subject", () => {
		expect(landedOnBase(["fix(x): a thing (#3924) (#4010)"], 3924).valueOf()).toBe(false);
	});

	it("reads the subject line only, not the body", () => {
		expect(landedOnBase(["fix: a thing (#4010)\n\nbody mentions (#3924)"], 3924)).toBe(false);
	});
});

describe("reopensSince", () => {
	it("counts only reopens at or after the head's push", () => {
		const events = [at("reopened", "2026-08-08T09:00:00Z"), at("reopened", "2026-08-08T11:00:00Z")];
		expect(reopensSince(events, "2026-08-08T10:00:00Z")).toBe(1);
	});

	it("is zero when nothing reopened since the push — the at-most-once gate stays open", () => {
		expect(reopensSince([at("closed", "2026-08-08T11:00:00Z")], "2026-08-08T10:00:00Z")).toBe(0);
	});
});
