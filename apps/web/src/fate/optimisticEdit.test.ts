import {describe, expect, it} from "vitest";
import {bodyEditOptimistic, postEditOptimistic} from "./optimisticEdit";

/**
 * Pins the optimistic-edit payload shape (#1675). fate's own
 * apply/reconcile/rollback is covered at the integration tier.
 */
const fixedNow = () => new Date("2026-07-02T12:00:00.000Z");

describe("postEditOptimistic — the payload for post.edit", () => {
	it("returns the edited title/body + a fresh updatedAt", () => {
		expect(postEditOptimistic({title: "yeni", body: "gövde"}, fixedNow)).toEqual({
			title: "yeni",
			body: "gövde",
			updatedAt: fixedNow(),
		});
	});

	it("stamps updatedAt from the injected clock (drives the edited indicator)", () => {
		expect(postEditOptimistic({title: "t", body: "b"}, fixedNow).updatedAt).toEqual(fixedNow());
	});
});

describe("bodyEditOptimistic — the payload for comment.edit / definition.edit", () => {
	it("returns the edited body + a fresh updatedAt", () => {
		expect(bodyEditOptimistic("gövde", fixedNow)).toEqual({
			body: "gövde",
			updatedAt: fixedNow(),
		});
	});
});
