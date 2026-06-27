/**
 * The pure divan roster shaping (#1287) — `buildRoster` grouping, with no DB
 * (ADR 0082 unit tier). Proves the unit is the PERSON: items group by author, the
 * per-kind counts are correct, only authors with ≥1 pending item appear, and the
 * blank-author (author-deleted placeholder) row is skipped.
 */
import {assert, describe, it} from "@effect/vitest";
import {buildRoster, type DivanItem} from "./roster.ts";

const item = (kind: DivanItem["kind"], id: string, authorId: string): DivanItem => ({
	kind,
	id,
	authorId,
	createdAt: new Date("2026-06-25T00:00:00.000Z"),
	preview: `${kind}:${id}`,
});

describe("buildRoster — group sandboxed backlog by author", () => {
	it("groups items by author with correct per-kind counts", () => {
		const roster = buildRoster([
			item("definition", "d1", "cyl-a"),
			item("definition", "d2", "cyl-a"),
			item("post", "p1", "cyl-a"),
			item("comment", "c1", "cyl-b"),
		]);
		assert.lengthOf(roster, 2);
		const a = roster.find((r) => r.authorId === "cyl-a");
		assert.deepStrictEqual(a, {
			authorId: "cyl-a",
			definitionCount: 2,
			postCount: 1,
			commentCount: 0,
			totalCount: 3,
		});
		const b = roster.find((r) => r.authorId === "cyl-b");
		assert.deepStrictEqual(b, {
			authorId: "cyl-b",
			definitionCount: 0,
			postCount: 0,
			commentCount: 1,
			totalCount: 1,
		});
	});

	it("only authors with ≥1 item appear — an empty input yields an empty roster", () => {
		assert.deepStrictEqual(buildRoster([]), []);
	});

	it("orders by total pending desc, then authorId", () => {
		const roster = buildRoster([
			item("post", "p1", "z-one"),
			item("definition", "d1", "a-three"),
			item("definition", "d2", "a-three"),
			item("comment", "c1", "a-three"),
		]);
		assert.deepStrictEqual(
			roster.map((r) => r.authorId),
			["a-three", "z-one"],
		);
	});

	it("skips the blank-author placeholder (author-deleted, not removed) row", () => {
		const roster = buildRoster([item("comment", "c1", ""), item("post", "p1", "cyl-a")]);
		assert.deepStrictEqual(
			roster.map((r) => r.authorId),
			["cyl-a"],
		);
	});
});
