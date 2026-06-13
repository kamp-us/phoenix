/**
 * Micro-tier: the d1 fake's `meta` envelope contract (ADR 0040 gap #1/#3). The
 * fate wire never serializes `meta` (`changes`/`last_row_id`), so this contract
 * was untested at every tier; here it's asserted in-process against the raw
 * `prepare(...).run()` / `batch([...])` D1 surface (not Drizzle), because `meta`
 * is a property of that binding contract.
 */
import {assert, describe, it} from "@effect/vitest";
import {makeSqliteTestDb} from "./sqlite-d1.testing.ts";

describe("d1 fake — meta envelope", () => {
	it("run() reports last_row_id after an INSERT", async () => {
		const sqlite = makeSqliteTestDb();
		try {
			const result = await sqlite.d1
				.prepare(
					"INSERT INTO definition_vote (definition_id, voter_id, created_at) VALUES (?, ?, ?)",
				)
				.bind("def-1", "voter-1", Date.now())
				.run();

			assert.isTrue(result.success);
			assert.isNumber(result.meta.last_row_id);
			assert.isTrue(result.meta.last_row_id > 0, "last_row_id reflects the inserted rowid");
			assert.strictEqual(result.meta.changes, 1, "one row written");
		} finally {
			sqlite.close();
		}
	});

	it("run() reports changes after an UPDATE", async () => {
		const sqlite = makeSqliteTestDb();
		try {
			const now = Date.now();
			await sqlite.d1
				.prepare(
					"INSERT INTO definition_vote (definition_id, voter_id, created_at) VALUES (?, ?, ?)",
				)
				.bind("def-1", "voter-1", now)
				.run();
			await sqlite.d1
				.prepare(
					"INSERT INTO definition_vote (definition_id, voter_id, created_at) VALUES (?, ?, ?)",
				)
				.bind("def-1", "voter-2", now)
				.run();

			const result = await sqlite.d1
				.prepare("UPDATE definition_vote SET created_at = ? WHERE definition_id = ?")
				.bind(now + 1, "def-1")
				.run();

			assert.isTrue(result.success);
			assert.strictEqual(result.meta.changes, 2, "both rows for def-1 updated");
		} finally {
			sqlite.close();
		}
	});

	it("batch() populates per-statement meta", async () => {
		const sqlite = makeSqliteTestDb();
		try {
			const now = Date.now();
			const insert = sqlite.d1
				.prepare(
					"INSERT INTO definition_vote (definition_id, voter_id, created_at) VALUES (?, ?, ?)",
				)
				.bind("def-1", "voter-1", now);
			const update = sqlite.d1
				.prepare("UPDATE definition_vote SET created_at = ? WHERE definition_id = ?")
				.bind(now + 1, "def-1");

			const [insertResult, updateResult] = await sqlite.d1.batch([insert, update]);

			assert.strictEqual(insertResult!.meta.changes, 1, "insert wrote one row");
			assert.isTrue(insertResult!.meta.last_row_id > 0, "insert reports its rowid");
			assert.strictEqual(updateResult!.meta.changes, 1, "update touched the inserted row");
		} finally {
			sqlite.close();
		}
	});
});
