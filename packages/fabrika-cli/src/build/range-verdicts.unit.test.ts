import {describe, expect, it} from "vitest";
import type {CommentRecord} from "../io/issues.ts";
import {failing, readRangeVerdicts} from "./range-verdicts.ts";

const BASE = "9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4";
const TIP = "03135b917283a4b5c6d7e8f90a1b2c3d4e5f6071";
const LATER_TIP = "5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
const DIGEST = "2f1a9c4e0b7d";

const marker = (namespace: string, polarity: string, tip = TIP) =>
	`${namespace}: ${polarity} range:${BASE}..${tip} content:${DIGEST} — read it`;

const comment = (id: number, body: string, updatedAt = "2026-08-19T12:00:00Z"): CommentRecord => ({
	id,
	author: "a-gate",
	createdAt: updatedAt,
	updatedAt,
	body,
});

describe("readRangeVerdicts folds a child issue's range verdicts", () => {
	it("answers no standing verdict on a thread that carries none", () => {
		const read = readRangeVerdicts([comment(1, "just a note")]);
		expect(read.standing).toEqual([]);
		expect(read.malformed).toEqual([]);
		expect(failing(read)).toEqual([]);
	});

	it("keeps the newest write per namespace, so a FAIL upserted after a PASS wins (#4200)", () => {
		const read = readRangeVerdicts([
			comment(1, marker("review-code", "PASS"), "2026-08-19T12:00:00Z"),
			comment(2, marker("review-code", "FAIL"), "2026-08-19T12:30:00Z"),
		]);
		expect(read.standing).toEqual([
			{namespace: "review-code", polarity: "FAIL", commentId: 2, range: `${BASE}..${TIP}`},
		]);
	});

	it("keeps the newest write per namespace when the PASS is the later one", () => {
		const read = readRangeVerdicts([
			comment(1, marker("review-code", "FAIL"), "2026-08-19T12:00:00Z"),
			comment(2, marker("review-code", "PASS", LATER_TIP), "2026-08-19T12:30:00Z"),
		]);
		expect(failing(read)).toEqual([]);
	});

	/** #6296's shape: one gate failed the child while another passed it, and the FAIL is what stands. */
	it("reports a FAIL in one namespace beside a PASS in another", () => {
		const read = readRangeVerdicts([
			comment(1, marker("governance", "PASS")),
			comment(2, marker("review-code", "FAIL")),
		]);
		expect(read.standing.map((row) => `${row.namespace} ${row.polarity}`)).toEqual([
			"governance PASS",
			"review-code FAIL",
		]);
		expect(failing(read).map((row) => row.namespace)).toEqual(["review-code"]);
	});

	it("counts a body reaching for the format and missing it, never drops it", () => {
		const read = readRangeVerdicts([
			comment(1, "review-code: FAIL @ 03135b91 — a PR-scoped marker on a child issue"),
		]);
		expect(read.standing).toEqual([]);
		expect(read.malformed).toHaveLength(1);
		expect(read.malformed[0]).toContain("#1:");
	});

	/**
	 * A verdict formed over a range the branch has since moved past is stale, and staleness is not
	 * this reader's question: a fresh claim asks whether the child was built and graded at all.
	 */
	it("stands a FAIL over an older range — a graded build is a graded build", () => {
		const read = readRangeVerdicts([comment(1, marker("review-code", "FAIL", LATER_TIP))]);
		expect(failing(read).map((row) => row.range)).toEqual([`${BASE}..${LATER_TIP}`]);
	});
});
