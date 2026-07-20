import {describe, expect, it} from "vitest";
import {bodyEditOptimistic, postEditOptimistic} from "./optimisticEdit";

/**
 * Covers the load-bearing optimistic-edit core the three Class-A edits ship
 * through (`post.edit`/`comment.edit`/`definition.edit` → `postEditOptimistic` /
 * `bodyEditOptimistic`, #1675): the edited field(s) plus a fresh `updatedAt` that
 * drives the "düzenlendi" indicator, inspected off the REAL exported builders —
 * the same functions the call sites route through, not a re-implemented copy.
 * fate's own apply/reconcile/rollback is exercised at the integration tier; this
 * pins the payload shape hook-free.
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
