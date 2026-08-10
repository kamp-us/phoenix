import {describe, expect, it} from "vitest";
import {
	compareWriteRecency,
	latestByWriteRecency,
	stampIso,
	withWrittenAt,
	writeRecencyOf,
	writtenAtOf,
} from "./write-recency.ts";

const at = (id: number, createdAt: string, body = "review-doc: FAIL @ abc1234 — x") => ({
	id,
	createdAt,
	body,
});

describe("stampIso", () => {
	it("drops the milliseconds, so a stamp cannot sort below a created_at in the same second", () => {
		expect(stampIso(Date.parse("2026-08-09T04:05:28.412Z"))).toBe("2026-08-09T04:05:28Z");
		expect("2026-08-09T04:05:28.412Z" < "2026-08-09T04:05:28Z").toBe(true);
	});
});

describe("withWrittenAt / writtenAtOf", () => {
	it("stamps a body and reads its own stamp back", () => {
		const body = withWrittenAt(
			"review-doc: FAIL @ abc1234 — x\n\nthe table\n",
			"2026-08-09T04:00:00Z",
		);
		expect(writtenAtOf(body)).toBe("2026-08-09T04:00:00Z");
	});

	it("replaces the prior stamp rather than stacking a second one", () => {
		const once = withWrittenAt("verdict", "2026-08-09T04:00:00Z");
		const twice = withWrittenAt(once, "2026-08-09T05:00:00Z");
		expect(twice.match(/Verdict-written:/g)).toHaveLength(1);
		expect(writtenAtOf(twice)).toBe("2026-08-09T05:00:00Z");
	});

	it("reads no stamp off an unstamped body", () => {
		expect(writtenAtOf("review-doc: FAIL @ abc1234 — x")).toBeNull();
	});

	it("takes the LAST stamp, so a body quoting an earlier one still resolves to its own", () => {
		const body = withWrittenAt(
			"we corrected the verdict stamped\n\nVerdict-written: 2026-08-09T01:00:00Z\n",
			"2026-08-09T06:00:00Z",
		);
		expect(writtenAtOf(body)).toBe("2026-08-09T06:00:00Z");
	});
});

describe("writeRecencyOf — created_at is the floor, never the key", () => {
	it("falls back to created_at for an unstamped body", () => {
		expect(writeRecencyOf(at(1, "2026-08-09T03:00:00Z"))).toBe("2026-08-09T03:00:00Z");
	});

	it("takes the stamp when it is later than the slot", () => {
		const body = withWrittenAt("review-doc: FAIL @ abc1234 — x", "2026-08-09T05:00:00Z");
		expect(writeRecencyOf({id: 1, createdAt: "2026-08-09T03:00:00Z", body})).toBe(
			"2026-08-09T05:00:00Z",
		);
	});

	it("refuses a backdated stamp — a verdict cannot predate the slot that carries it", () => {
		const body = withWrittenAt("review-doc: FAIL @ abc1234 — x", "2026-08-09T01:00:00Z");
		expect(writeRecencyOf({id: 1, createdAt: "2026-08-09T03:00:00Z", body})).toBe(
			"2026-08-09T03:00:00Z",
		);
	});
});

describe("compareWriteRecency", () => {
	/**
	 * The case the stamp exists for, in the shape the enqueue gate meets it: a marker is posted, an
	 * advisory is written 19 minutes later, and then the marker is corrected IN PLACE. The PATCH
	 * leaves the marker's `created_at` at the original post, so slot time ranks the superseded
	 * advisory above the live correction. Only the stamp gets it right (#5048).
	 */
	it("a re-posted marker outranks an advisory created between the post and the re-post", () => {
		const marker = {
			id: 5229629030,
			createdAt: "2026-08-09T03:46:59Z",
			body: withWrittenAt(
				"review-code: FAIL @ abc1234 — a criterion is red",
				"2026-08-09T04:20:00Z",
			),
		};
		const advisory = {
			id: 5229688003,
			createdAt: "2026-08-09T04:05:28Z",
			body: "review-code: advisory — blocking-set PR\n\nReviewed-head: @ abc1234\n",
		};
		expect(compareWriteRecency(marker, advisory)).toBeGreaterThan(0);
		expect(latestByWriteRecency([marker, advisory])).toBe(marker);
		// And the defect it replaces: unstamped, the same pair ranks the other way round.
		const unstamped = {...marker, body: "review-code: FAIL @ abc1234 — a criterion is red"};
		expect(compareWriteRecency(unstamped, advisory)).toBeLessThan(0);
	});

	it("breaks a same-instant tie on the server-assigned id", () => {
		expect(compareWriteRecency(at(2, "2026-08-09T04:00:00Z"), at(9, "2026-08-09T04:00:00Z"))).toBe(
			-7,
		);
	});
});

describe("latestByWriteRecency", () => {
	it("is undefined for an empty set — the fail-closed 'nothing to upsert onto'", () => {
		expect(latestByWriteRecency([])).toBeUndefined();
	});

	it("takes the newest however the input happens to be ordered", () => {
		const rows = [at(1, "2026-08-09T05:00:00Z"), at(2, "2026-08-09T03:00:00Z")];
		expect(latestByWriteRecency(rows)?.id).toBe(1);
		expect(latestByWriteRecency([...rows].reverse())?.id).toBe(1);
	});
});

/**
 * The interop pin. fabrika reimplements this format and never calls v1 (ADR 0238), so nothing at
 * build time couples the two — the only thing keeping them one format is that the bytes match. The
 * literal below is v1's own matcher, copied verbatim from
 * `packages/pipeline-cli/src/tools/verdict/verdict-match.ts`; if this test goes red, a fabrika-posted
 * verdict has become unorderable to the resolver the enqueue gate reads, which is the whole defect.
 */
describe("the emitted line is what pipeline-cli's resolver reads", () => {
	const consumerRe =
		/^[ \t]*Verdict-written:[ \t]*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)[ \t]*$/gim;

	it("matches the consumer's matcher, capturing the instant that was stamped", () => {
		const body = withWrittenAt(
			"review-code: FAIL @ abc1234 — a criterion is red\n\n| criterion | verdict |\n",
			stampIso(Date.parse("2026-08-09T04:20:00.999Z")),
		);
		const matches = [...body.matchAll(consumerRe)];
		expect(matches).toHaveLength(1);
		expect(matches[0]?.[1]).toBe("2026-08-09T04:20:00Z");
	});
});
