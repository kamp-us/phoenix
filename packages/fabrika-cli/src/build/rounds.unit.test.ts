import {describe, expect, it} from "vitest";
import type {CommentRecord} from "../io/issues.ts";
import {countRounds, ROUND_GAP_MS, roundsOn} from "./rounds.ts";

const at = (secondsFromStart: number) =>
	new Date(1_770_000_000_000 + secondsFromStart * 1000).toISOString();

const comment = (id: number, body: string, createdAt: string): CommentRecord => ({
	id,
	author: "a-gate",
	createdAt,
	updatedAt: createdAt,
	body,
});

const HEAD_A = "73d6db5a1c2e4f60b8d9a0c1e2f3a4b5c6d7e8f9";
const HEAD_B = "b640e87f1a2b3c4d5e6f708192a3b4c5d6e7f809";

describe("countRounds counts one round per graded head", () => {
	it("counts no FAILs as zero rounds — a fact, not a gap", () => {
		expect(countRounds([])).toBe(0);
	});

	it("folds every FAIL at one head into one round, however far apart they post", () => {
		expect(
			countRounds([
				{sha: HEAD_A, createdAt: at(0)},
				{sha: HEAD_A, createdAt: at(600)},
				{sha: HEAD_A, createdAt: at(4000)},
			]),
		).toBe(1);
	});

	/**
	 * PR #6122's shape: two heads, two gates each, 8 and 4 minutes between the gates at one head.
	 * The wall-clock rule read this as four rounds and spent the cap on gate latency (#6137).
	 */
	it("counts #6122's four markers over two heads as two rounds", () => {
		expect(
			countRounds([
				{sha: HEAD_A, createdAt: "2026-08-18T20:36:29Z"},
				{sha: HEAD_A, createdAt: "2026-08-18T20:44:35Z"},
				{sha: HEAD_B, createdAt: "2026-08-18T20:56:57Z"},
				{sha: HEAD_B, createdAt: "2026-08-18T21:01:05Z"},
			]),
		).toBe(2);
	});

	it("counts two heads graded seconds apart as two rounds — time is not the axis", () => {
		expect(
			countRounds([
				{sha: HEAD_A, createdAt: at(0)},
				{sha: HEAD_B, createdAt: at(1)},
			]),
		).toBe(2);
	});

	it("reads an abbreviated SHA and the full one it abbreviates as one head", () => {
		expect(
			countRounds([
				{sha: HEAD_A.slice(0, 7), createdAt: at(0)},
				{sha: HEAD_A, createdAt: at(600)},
			]),
		).toBe(1);
	});

	it("is order-independent, so a list read out of order counts the same", () => {
		expect(
			countRounds([
				{sha: HEAD_B, createdAt: at(600)},
				{sha: HEAD_A, createdAt: at(0)},
				{sha: HEAD_B, createdAt: at(10)},
			]),
		).toBe(2);
	});

	describe("a FAIL whose head is unreadable", () => {
		it("still counts, clustered by the inclusive 120-second gap", () => {
			expect(ROUND_GAP_MS).toBe(120_000);
			expect(
				countRounds([
					{sha: null, createdAt: at(0)},
					{sha: null, createdAt: at(120)},
				]),
			).toBe(1);
			expect(
				countRounds([
					{sha: null, createdAt: at(0)},
					{sha: null, createdAt: at(121)},
				]),
			).toBe(2);
		});

		it("adds its clusters to the head count rather than joining a head's round", () => {
			expect(
				countRounds([
					{sha: HEAD_A, createdAt: at(0)},
					{sha: "not a sha", createdAt: at(5)},
				]),
			).toBe(2);
		});

		it("counts nothing for a timestamp that does not parse either", () => {
			expect(countRounds([{sha: null, createdAt: "not a date"}])).toBe(0);
		});
	});
});

describe("roundsOn folds a PR's comments — the one derivation both call sites take", () => {
	it("counts only FAIL markers, by their heads", () => {
		const page = [
			comment(1, `governance: FAIL @ ${HEAD_A} — the ADR collides`, at(0)),
			comment(2, `review-doc: FAIL @ ${HEAD_A} — the same head, later`, at(600)),
			comment(3, `review-code: PASS @ ${HEAD_B} — merge-ready`, at(700)),
			comment(4, "just a normal comment", at(800)),
		];
		expect(roundsOn(page)).toBe(1);
	});

	it("moves the count only when a new head is graded", () => {
		const page = [
			comment(1, `governance: FAIL @ ${HEAD_A} — one`, at(0)),
			comment(2, `governance: FAIL @ ${HEAD_B} — two`, at(600)),
		];
		expect(roundsOn(page)).toBe(2);
	});
});
