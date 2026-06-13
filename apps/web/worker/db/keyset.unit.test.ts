/**
 * Unit coverage for the shared keyset primitives. Predicates are rendered to
 * SQLite text + params via `SQLiteSyncDialect` so the tests assert the actual
 * comparison operators and column order, not just a structural shape.
 */

import type {SQL} from "drizzle-orm";
import {SQLiteSyncDialect} from "drizzle-orm/sqlite-core";
import {describe, expect, it} from "vitest";
import {commentView, definitionView, postSummary, termSummary} from "./drizzle/schema";
import {forwardPage, keysetAfter} from "./keyset";

const dialect = new SQLiteSyncDialect();
const render = (sql: SQL) => dialect.sqlToQuery(sql);

describe("keysetAfter", () => {
	it("returns undefined when there is no cursor (empty keys)", () => {
		expect(keysetAfter([])).toBeUndefined();
	});

	it("returns undefined when every cursor value is null/undefined", () => {
		const predicate = keysetAfter([
			{column: termSummary.lastActivityAt, dir: "desc", value: null},
			{column: termSummary.slug, dir: "asc", value: undefined},
		]);
		expect(predicate).toBeUndefined();
	});

	it("single asc column → a bare `>` comparison (no disjunction)", () => {
		const predicate = keysetAfter([{column: commentView.id, dir: "asc", value: "c1"}]);
		const {sql, params} = render(predicate as SQL);
		expect(sql).toBe('"comment_view"."id" > ?');
		expect(params).toEqual(["c1"]);
	});

	it("single desc column → a bare `<` comparison", () => {
		const predicate = keysetAfter([{column: postSummary.score, dir: "desc", value: 42}]);
		const {sql, params} = render(predicate as SQL);
		expect(sql).toBe('"post_summary"."score" < ?');
		expect(params).toEqual([42]);
	});

	it("two-column asc tuple → lexicographic `(c1 > v1) or (c1 = v1 and c2 > v2)`", () => {
		const created = new Date("2026-01-01T00:00:00.000Z");
		const predicate = keysetAfter([
			{column: commentView.createdAt, dir: "asc", value: created},
			{column: commentView.id, dir: "asc", value: "c9"},
		]);
		const {sql} = render(predicate as SQL);
		// drizzle 1.0 fully parenthesizes every comparison and and/or group
		// (semantically identical to the sparser 0.45 output).
		expect(sql).toBe(
			'(("comment_view"."created_at" > ?) or ' +
				'((("comment_view"."created_at" = ?) and ("comment_view"."id" > ?))))',
		);
	});

	it("mixed-direction tuple (score desc, createdAt asc, id asc) reproduces the definitions keyset", () => {
		const created = new Date("2026-01-01T00:00:00.000Z");
		const predicate = keysetAfter([
			{column: definitionView.score, dir: "desc", value: 5},
			{column: definitionView.createdAt, dir: "asc", value: created},
			{column: definitionView.id, dir: "asc", value: "d7"},
		]);
		const {sql} = render(predicate as SQL);
		expect(sql).toBe(
			'(("definition_view"."score" < ?) or ' +
				'((("definition_view"."score" = ?) and ("definition_view"."created_at" > ?))) or ' +
				'((("definition_view"."score" = ?) and ("definition_view"."created_at" = ?) and ("definition_view"."id" > ?))))',
		);
	});

	it("a null cursor value drops that column (term-summary `recent` fallback)", () => {
		const predicate = keysetAfter([
			{column: termSummary.lastActivityAt, dir: "desc", value: null},
			{column: termSummary.slug, dir: "asc", value: "zebra"},
		]);
		const {sql, params} = render(predicate as SQL);
		expect(sql).toBe('"term_summary"."slug" > ?');
		expect(params).toEqual(["zebra"]);
	});
});

describe("forwardPage", () => {
	const cursorOf = (row: {id: string}) => row.id;

	it("trims the probe row and reports hasNextPage when first+1 fetched", () => {
		const fetched = [{id: "a"}, {id: "b"}, {id: "c"}]; // first = 2, probe present
		const page = forwardPage(fetched, 2, cursorOf);
		expect(page.rows).toEqual([{id: "a"}, {id: "b"}]);
		expect(page.hasNextPage).toBe(true);
		expect(page.endCursor).toBe("b");
	});

	it("no probe row → hasNextPage false, all rows kept", () => {
		const fetched = [{id: "a"}, {id: "b"}];
		const page = forwardPage(fetched, 2, cursorOf);
		expect(page.rows).toEqual([{id: "a"}, {id: "b"}]);
		expect(page.hasNextPage).toBe(false);
		expect(page.endCursor).toBe("b");
	});

	it("empty fetch → empty page, no cursor", () => {
		const page = forwardPage([] as {id: string}[], 10, cursorOf);
		expect(page.rows).toEqual([]);
		expect(page.hasNextPage).toBe(false);
		expect(page.endCursor).toBeNull();
	});

	it("maps fetched rows through `mapRow` before slicing the envelope", () => {
		const fetched = [{slug: "x"}, {slug: "y"}, {slug: "z"}];
		const page = forwardPage<{slug: string}, {id: string}>(
			fetched,
			2,
			(r) => r.id,
			(r) => ({id: r.slug.toUpperCase()}),
		);
		expect(page.rows).toEqual([{id: "X"}, {id: "Y"}]);
		expect(page.hasNextPage).toBe(true);
		expect(page.endCursor).toBe("Y");
	});
});
