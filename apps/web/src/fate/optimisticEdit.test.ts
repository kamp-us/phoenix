import {describe, expect, it} from "vitest";
import {bodyEditOptimistic, postEditOptimistic} from "./optimisticEdit";

/**
 * Covers the load-bearing optimistic-edit core the three Class-A edits ship
 * through (`post.edit`/`comment.edit`/`definition.edit` → `postEditOptimistic` /
 * `bodyEditOptimistic`, #1675): the dark-ship flag gate (off ⇒ no optimistic
 * payload, the pre-flag round-trip behavior; on ⇒ the edited field(s) plus a
 * fresh `updatedAt` that drives the "düzenlendi" indicator), inspected off the
 * REAL exported builders — the same functions the call sites route through, not a
 * re-implemented copy. fate's own apply/reconcile/rollback is exercised at the
 * integration tier; this pins the gate + payload shape hook-free.
 */
const fixedNow = () => new Date("2026-07-02T12:00:00.000Z");

describe("postEditOptimistic — the flag gate + payload for post.edit", () => {
	it("returns undefined when the flag is off (pre-flag: wait for the round-trip)", () => {
		expect(postEditOptimistic(false, {title: "yeni", body: "gövde"}, fixedNow)).toBeUndefined();
	});

	it("returns the edited title/body + a fresh updatedAt when the flag is on", () => {
		expect(postEditOptimistic(true, {title: "yeni", body: "gövde"}, fixedNow)).toEqual({
			title: "yeni",
			body: "gövde",
			updatedAt: fixedNow(),
		});
	});

	it("stamps updatedAt from the injected clock (drives the edited indicator)", () => {
		const result = postEditOptimistic(true, {title: "t", body: "b"}, fixedNow);
		expect(result?.updatedAt).toEqual(fixedNow());
	});
});

describe("bodyEditOptimistic — the flag gate + payload for comment.edit / definition.edit", () => {
	it("returns undefined when the flag is off", () => {
		expect(bodyEditOptimistic(false, "gövde", fixedNow)).toBeUndefined();
	});

	it("returns the edited body + a fresh updatedAt when the flag is on", () => {
		expect(bodyEditOptimistic(true, "gövde", fixedNow)).toEqual({
			body: "gövde",
			updatedAt: fixedNow(),
		});
	});
});
