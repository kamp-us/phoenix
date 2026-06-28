/**
 * Column-set anchor for the shared read-model tables. This is the regression
 * guard for the drift class issue #859 closes: it pins the exact column set of
 * each shared table, so a column ADDED to or RENAMED in a consumer's stale local
 * copy (the failure mode before this leaf existed) can't slip through — there is
 * only this one declaration, and these assertions fail the moment it changes
 * without the test being updated alongside. The `is_draft` (ADR 0093) and the
 * `removed_at` triad (ADR 0096) — the two columns that silently failed to
 * propagate to the copies — are asserted explicitly.
 */
import {getTableConfig} from "drizzle-orm/sqlite-core";
import {describe, expect, it} from "vitest";
import {commentRecord, definitionRecord, postRecord, termRecord} from "./index.ts";

const columnNames = (table: Parameters<typeof getTableConfig>[0]) =>
	getTableConfig(table)
		.columns.map((c) => c.name)
		.sort();

describe("shared read-model schema", () => {
	it("term_record column set", () => {
		expect(columnNames(termRecord)).toEqual(
			[
				"slug",
				"title",
				"first_letter",
				"definition_count",
				"total_score",
				"excerpt",
				"top_definition_id",
				"first_at",
				"last_activity_at",
				"last_edit_at",
			].sort(),
		);
	});

	it("definition_record column set carries the ADR 0096 removed_at triad", () => {
		const cols = columnNames(definitionRecord);
		expect(cols).toEqual(
			[
				"id",
				"author_id",
				"author_name",
				"term_slug",
				"term_title",
				"body",
				"body_excerpt",
				"score",
				"created_at",
				"updated_at",
				"removed_at",
				"removed_by",
				"removed_reason",
				"sandboxed_at",
			].sort(),
		);
		expect(cols).toContain("removed_at");
		expect(cols).toContain("sandboxed_at");
	});

	it("post_record column set carries is_draft (ADR 0093) and the removed_at triad", () => {
		const cols = columnNames(postRecord);
		expect(cols).toEqual(
			[
				"id",
				"slug",
				"title",
				"url",
				"host",
				"body",
				"body_excerpt",
				"author_id",
				"author_name",
				"tags",
				"score",
				"comment_count",
				"hot_score",
				"created_at",
				"updated_at",
				"last_activity_at",
				"removed_at",
				"removed_by",
				"removed_reason",
				"sandboxed_at",
				"is_draft",
			].sort(),
		);
		expect(cols).toContain("is_draft");
		expect(cols).toContain("removed_at");
		expect(cols).toContain("sandboxed_at");
	});

	it("comment_record column set carries the ADR 0096 removed_at triad", () => {
		const cols = columnNames(commentRecord);
		expect(cols).toEqual(
			[
				"id",
				"author_id",
				"author_name",
				"post_id",
				"post_title",
				"parent_id",
				"body",
				"body_excerpt",
				"score",
				"created_at",
				"updated_at",
				"removed_at",
				"removed_by",
				"removed_reason",
				"sandboxed_at",
			].sort(),
		);
		expect(cols).toContain("removed_at");
		expect(cols).toContain("sandboxed_at");
	});
});
