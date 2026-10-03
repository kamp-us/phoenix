import {describe, expect, it} from "vitest";
import type {ListedIssue} from "../io/issues.ts";
import {rulingComment} from "./ruled.test-support.ts";
import {ruledSuspects, ruledUnbuiltOf} from "./ruled.ts";

const REPO = "acme/widgets";
const RULER = "founder";
const ROSTER = new Set([RULER]);

const listed = (number: number, labels: ReadonlyArray<string>): ListedIssue => ({
	number,
	title: `Issue ${number}`,
	body: "",
	labels,
	author: RULER,
	association: "OWNER",
	createdAt: "2026-09-01T00:00:00Z",
});

describe("ruledSuspects", () => {
	it("reads only decisions a ruling handed to agents", () => {
		const open = new Map(
			[
				listed(3, ["type:decision", "ready-for:agent"]),
				listed(1, ["type:decision", "ready-for:agent", "p2"]),
				listed(2, ["type:decision", "ready-for:human"]),
				listed(4, ["type:feature", "ready-for:agent"]),
			].map((issue) => [issue.number, issue] as const),
		);

		expect(ruledSuspects(open)).toEqual([1, 3]);
	});
});

describe("ruledUnbuiltOf", () => {
	it("lists every issue a roster account ruled on, oldest ruling first", () => {
		const ruled = ruledUnbuiltOf(
			[
				[5, [rulingComment(REPO, 5, "2026-09-20T00:00:00Z", RULER)]],
				[6, [rulingComment(REPO, 6, "2026-09-02T00:00:00Z", RULER)]],
				[7, []],
			],
			ROSTER,
		);

		expect(ruled.map((one) => [one.issue, one.ruledAt])).toEqual([
			[6, "2026-09-02T00:00:00Z"],
			[5, "2026-09-20T00:00:00Z"],
		]);
	});

	it("never counts a marker from an account off the roster", () => {
		expect(
			ruledUnbuiltOf([[5, [rulingComment(REPO, 5, "2026-09-20T00:00:00Z", "someone")]]], ROSTER),
		).toEqual([]);
	});

	it("dates a re-ruled issue by its first ruling and cites its newest", () => {
		const [one] = ruledUnbuiltOf(
			[
				[
					5,
					[
						rulingComment(REPO, 5, "2026-09-01T00:00:00Z", RULER, 501),
						rulingComment(REPO, 5, "2026-09-15T00:00:00Z", RULER, 502),
					],
				],
			],
			ROSTER,
		);

		expect(one?.ruledAt).toBe("2026-09-01T00:00:00Z");
		expect(one?.ruling).toBe(`https://github.com/${REPO}/issues/5#issuecomment-501`);
	});
});
