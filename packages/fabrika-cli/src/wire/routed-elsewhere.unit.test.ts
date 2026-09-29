/**
 * The one law the registry's conformance suite cannot state for this format: **a verdict and a
 * route never read as each other.**
 *
 * Conformance drives each row's reader over that row's own fixtures, so it proves this format is
 * total over its own bytes and says nothing about `verdict-marker`'s. The property that matters
 * here is cross-format: `ship gate` resolves a namespace by asking both readers, and the moment one
 * of them answers on the other's bytes, "I judged nothing" and "I judged it and it passed" become
 * one state.
 */
import {assert, describe, it} from "@effect/vitest";
import {type Clause, emit, type HeadSha, read as readRouted} from "./routed-elsewhere.ts";
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

describe("a route's basis", () => {
	it("round-trips basis:hand-check and basis:skip, and the verdict reader still calls it Absent", () => {
		for (const basis of ["hand-check", "skip"] as const) {
			const bytes = emit({
				namespace: "review-ui",
				sha: "6c6fe226" as HeadSha,
				clause: "no preview; routed by the repo's rules" as Clause,
				basis,
			});
			assert.strictEqual(
				bytes.split(" — ")[0],
				`routed-elsewhere: review-ui @ 6c6fe226 basis:${basis}`,
			);
			const parsed = readRouted(bytes);
			assert.strictEqual(parsed._tag === "Found" ? parsed.value.basis : null, basis);
			assert.strictEqual(
				parsed._tag === "Found" ? parsed.value.clause : null,
				"no preview; routed by the repo's rules",
			);
			assert.strictEqual(readVerdict(bytes)._tag, "Absent");
		}
	});

	it("reads a route with no basis token as one with no basis", () => {
		const parsed = readRouted(ROUTE);
		assert.strictEqual(parsed._tag === "Found" ? parsed.value.basis : "read", undefined);
	});

	it("is Malformed on a basis outside the vocabulary", () => {
		const drifted = readRouted("routed-elsewhere: review-ui @ 6c6fe226 basis:eyeballed — fine\n");
		assert.strictEqual(drifted._tag, "Malformed");
	});
});
