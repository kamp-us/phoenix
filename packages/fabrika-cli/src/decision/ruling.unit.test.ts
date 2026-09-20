import {describe, expect, it} from "vitest";
import type {CommentRecord} from "../io/issues.ts";
import {
	criterionIndex,
	emit,
	markedIssue,
	rulingUrl,
	scopeDigest,
} from "../wire/decision-ruling.ts";
import {type MarkerTime, markerTime} from "../wire/grill-marker.ts";
import {ISSUE, RULER, RULING_URL} from "./fixtures.test-support.ts";
import {newestRulingAt, scanRulings} from "./ruling.ts";

const ROSTER = new Set([RULER]);
const DIGEST = "0123456789ab";

/** A conforming marker comment, with its own ruled-at stamp and its own write stamp. */
const marker = (
	id: number,
	at: string,
	updatedAt: string,
	author: string = RULER,
): CommentRecord => {
	const issue = markedIssue(ISSUE);
	const digest = scopeDigest(DIGEST);
	const ruling = rulingUrl(RULING_URL);
	const stamp = markerTime(at);
	if (issue === null || digest === null || ruling === null || stamp === null) {
		throw new Error("the fixture does not brand");
	}
	return {
		id,
		author,
		createdAt: updatedAt,
		updatedAt,
		body: emit({issue, digest, ruling, supersedes: criterionIndex(1), at: stamp}),
	};
};

const scanOf = (...rows: ReadonlyArray<CommentRecord>) => scanRulings(rows, ISSUE, ROSTER);

describe("newestRulingAt", () => {
	it("answers null where nothing rules the issue", () => {
		expect(newestRulingAt(scanOf())).toBe(null);
	});

	it("answers the one ruling's own stamp", () => {
		expect(newestRulingAt(scanOf(marker(1, "2026-09-20T12:00:00Z", "2026-09-20T12:00:00Z")))).toBe(
			"2026-09-20T12:00:00Z",
		);
	});

	/**
	 * The fail-open shape this exists to close: `scan.standing` is last by comment `updatedAt`, so
	 * editing an older marker sorts it last while it still carries its older ruled-at stamp. Dating
	 * a verdict against that stamp would call a PASS written before the real newest ruling current.
	 */
	it("takes the latest stamp even when an older marker was edited last", () => {
		const scan = scanOf(
			marker(1, "2026-09-20T12:00:00Z", "2026-09-20T18:00:00Z"),
			marker(2, "2026-09-20T15:00:00Z", "2026-09-20T15:00:00Z"),
		);
		expect(scan.standing?.ruling.at).toBe("2026-09-20T12:00:00Z");
		expect(newestRulingAt(scan)).toBe("2026-09-20T15:00:00Z");
	});

	/** An undatable stamp is handed on so the currency read answers UNKNOWN rather than current. */
	it("returns a stamp that will not parse rather than skipping it", () => {
		const scan = scanOf(marker(1, "2026-09-20T12:00:00Z", "2026-09-20T12:00:00Z"));
		const standing = scan.all[0];
		if (standing === undefined) throw new Error("the fixture scanned no ruling");
		const undatable = {
			...standing,
			ruling: {...standing.ruling, at: "whenever" as MarkerTime},
		};
		expect(newestRulingAt({...scan, all: [standing, undatable]})).toBe("whenever");
	});

	it("ignores a marker from an account off the control-plane roster", () => {
		const scan = scanRulings(
			[
				marker(1, "2026-09-20T12:00:00Z", "2026-09-20T12:00:00Z"),
				marker(2, "2026-09-20T15:00:00Z", "2026-09-20T15:00:00Z", "drive-by"),
			],
			ISSUE,
			ROSTER,
		);
		expect(scan.unauthorized).toBe(1);
		expect(newestRulingAt(scan)).toBe("2026-09-20T12:00:00Z");
	});
});
