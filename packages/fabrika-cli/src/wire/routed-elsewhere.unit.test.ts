/**
 * The one law the registry's conformance suite cannot state for this format: **a verdict and a
 * route never read as each other.**
 *
 * Conformance drives each row's reader over that row's own fixtures, so it proves this format is
 * total over its own bytes and says nothing about `verdict-marker`'s. The property that matters
 * here is cross-format: `ship gate` resolves a namespace by asking both readers, and the moment one
 * of them answers on the other's bytes, "I judged nothing" and "I judged it and it passed" become
 * one state (ADR 0316).
 */
import {assert, describe, it} from "@effect/vitest";
import {read as readRouted} from "./routed-elsewhere.ts";
import {read as readVerdict} from "./verdict-marker.ts";

const ROUTE =
	"routed-elsewhere: review-ui @ 6c6fe226 — no rendered delta; the diff is prose only\n";
const VERDICT = "review-ui: PASS @ 6c6fe226 — every surface matches its golden\n";

describe("routed-elsewhere against the verdict marker", () => {
	it("reads a route the verdict reader calls Absent", () => {
		assert.strictEqual(readVerdict(ROUTE)._tag, "Absent");
		const parsed = readRouted(ROUTE);
		assert.strictEqual(parsed._tag, "Found");
		assert.strictEqual(parsed._tag === "Found" ? parsed.value.namespace : "", "review-ui");
	});

	it("calls a verdict Absent rather than reading it as a route", () => {
		assert.strictEqual(readRouted(VERDICT)._tag, "Absent");
		assert.strictEqual(readVerdict(VERDICT)._tag, "Found");
	});

	it("is Malformed, never Absent, on a route whose namespace drifted", () => {
		const drifted = readRouted("routed-elsewhere: review_ui @ 6c6fe226 — no rendered delta\n");
		assert.strictEqual(drifted._tag, "Malformed");
	});
});
