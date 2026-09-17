// @patch-pin: alchemy@2.0.0-beta.77
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {
	applyAlchemyFormat,
	applyMigrations,
	MigrationError,
	type MigrationRecord,
	runMigrations,
	type SqlExecutor,
} from "alchemy/SQL/Migrations/index";
import {hashMigrations} from "alchemy/SQL/SqlFile";
import {Cause, Effect, Exit} from "effect";
import {afterAll} from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-migration-pin-"));
afterAll(() => fs.rmSync(root, {recursive: true, force: true}));
const mixed = path.join(root, "mixed");
const nested = "20260901000000_next";
fs.mkdirSync(path.join(mixed, nested), {recursive: true});
fs.writeFileSync(path.join(mixed, "0000_baseline.sql"), "CREATE TABLE baseline(id TEXT);");
fs.writeFileSync(path.join(mixed, nested, "migration.sql"), "CREATE TABLE next(id TEXT);");
const empty = path.join(root, "empty");
fs.mkdirSync(empty);

const columns = (legacy = false): Array<Record<string, unknown>> => [
	{name: "id", type: legacy ? "TEXT" : "INTEGER"},
	{name: "name", type: "TEXT"},
	{name: "applied_at", type: "TEXT"},
	...(legacy ? [] : [{name: "hash", type: "TEXT"}]),
];
const rows = (...names: string[]): Array<Record<string, unknown>> =>
	names.map((name) => ({name, applied_at: "2026-09-01T00:00:00Z"}));

function recorder(replies: Array<Array<Record<string, unknown>> | MigrationError>) {
	const queries: string[] = [];
	const batches: ReadonlyArray<string>[] = [];
	const executor: SqlExecutor = {
		dialect: "sqlite",
		query: (sql) =>
			Effect.suspend(() => {
				queries.push(sql);
				const reply = replies.shift();
				if (reply === undefined) return Effect.die(`unexpected query: ${sql}`);
				return reply instanceof MigrationError ? Effect.fail(reply) : Effect.succeed(reply);
			}),
		batch: (sql) => Effect.sync(() => void batches.push(sql)),
	};
	return {executor, queries, batches, remaining: () => replies.length};
}
const record = (name: string, hash = "same"): MigrationRecord => ({
	name,
	hash,
	createdAtMillis: undefined,
	sql: `CREATE TABLE ${name}(id TEXT);`,
	statements: [`CREATE TABLE ${name}(id TEXT);`],
});
const drift = (strategy?: "adopt") => ({
	strategy,
	previousHashes: {old: "same", missing: "other"},
});

function failureMessage<E>(exit: Exit.Exit<unknown, E>): string {
	assert.isTrue(Exit.isFailure(exit));
	if (Exit.isSuccess(exit)) throw new Error("expected migration refusal");
	return String(Cause.squash(exit.cause));
}

describe("Alchemy migration compatibility (ADR 0309)", () => {
	it.effect("applies the flat baseline and directory SQL in a mixed tree", () =>
		Effect.gen(function* () {
			const h = recorder([columns(), [], columns(), []]);
			yield* applyMigrations({
				resolved: {dir: mixed, table: "drizzle_migrations"},
				executor: h.executor,
				drift: {previousHashes: {}},
			}).pipe(Effect.provide(NodeServices.layer));
			assert.strictEqual(h.batches.length, 2);
			assert.strictEqual(h.batches[0]?.[0], "CREATE TABLE baseline(id TEXT);");
			assert.strictEqual(h.batches[1]?.[0], "CREATE TABLE next(id TEXT);");
			assert.include(h.batches[0]?.[1] ?? "", "0000_baseline.sql");
			assert.include(h.batches[1]?.[1] ?? "", `${nested}/migration.sql`);
			assert.strictEqual(h.remaining(), 0);
		}),
	);

	it.effect("converts legacy bookkeeping without replaying the applied baseline", () =>
		Effect.gen(function* () {
			const h = recorder([
				columns(true),
				rows("0000_baseline.sql"),
				columns(true),
				rows("0000_baseline.sql"),
				rows("0000_baseline.sql"),
			]);
			yield* applyMigrations({
				resolved: {dir: mixed, table: "drizzle_migrations"},
				executor: h.executor,
				drift: {previousHashes: {}},
			}).pipe(Effect.provide(NodeServices.layer));
			assert.strictEqual(h.batches.length, 2);
			const conversion = h.batches[0]?.join("\n") ?? "";
			assert.include(conversion, "0000_baseline.sql");
			assert.include(conversion, "2026-09-01T00:00:00Z");
			assert.include(conversion, 'RENAME TO "drizzle_migrations"');
			assert.notInclude(h.batches.flat().join("\n"), "CREATE TABLE baseline");
			assert.strictEqual(h.batches[1]?.[0], "CREATE TABLE next(id TEXT);");
			assert.strictEqual(h.remaining(), 0);
		}),
	);

	it.effect("refuses a rename after conversion before any SQL is applied", () =>
		Effect.gen(function* () {
			const h = recorder([columns(), rows("old")]);
			const exit = yield* applyAlchemyFormat({
				executor: h.executor,
				table: "drizzle_migrations",
				records: [record("renamed")],
				drift: drift(),
			}).pipe(Effect.exit);
			assert.include(failureMessage(exit), "renamed (content-identical)");
			assert.deepStrictEqual(h.batches, []);
		}),
	);

	it.effect("adopts an identical rename before converting legacy history, without replay", () =>
		Effect.gen(function* () {
			const h = recorder([
				columns(true),
				rows("old"),
				columns(true),
				rows("renamed"),
				rows("renamed"),
			]);
			yield* applyAlchemyFormat({
				executor: h.executor,
				table: "drizzle_migrations",
				records: [record("renamed")],
				drift: drift("adopt"),
			});
			assert.deepStrictEqual(h.batches[0], [
				'UPDATE "drizzle_migrations" SET "name" = \'renamed\' WHERE "name" = \'old\';',
			]);
			assert.strictEqual(h.batches.length, 2);
			assert.notInclude(h.batches.flat().join("\n"), "CREATE TABLE renamed");
			assert.strictEqual(h.remaining(), 0);
		}),
	);

	it.effect("refuses deletions even when adopt could repair another row", () =>
		Effect.gen(function* () {
			const h = recorder([columns(), rows("old", "missing")]);
			const exit = yield* applyAlchemyFormat({
				executor: h.executor,
				table: "drizzle_migrations",
				records: [record("renamed")],
				drift: drift("adopt"),
			}).pipe(Effect.exit);
			assert.include(failureMessage(exit), 'recorded but gone from disk: "missing"');
			assert.deepStrictEqual(h.batches, []);
		}),
	);

	it.effect("adopts a directory rename using the provider's file-keyed state hashes", () =>
		Effect.gen(function* () {
			const dir = fs.mkdtempSync(path.join(root, "directory-rename-"));
			const oldName = "20260901000000_old";
			const newName = "20260901000000_renamed";
			fs.mkdirSync(path.join(dir, oldName));
			fs.writeFileSync(path.join(dir, oldName, "migration.sql"), "CREATE TABLE kept(id TEXT);");
			const previousHashes = yield* hashMigrations(dir);
			assert.deepStrictEqual(Object.keys(previousHashes), [`${oldName}/migration.sql`]);
			fs.renameSync(path.join(dir, oldName), path.join(dir, newName));
			const h = recorder([columns(), rows(oldName), columns(), rows(newName)]);
			const result = yield* runMigrations({
				input: {dir, table: "drizzle_migrations"},
				stamped: {table: "drizzle_migrations"},
				drift: {strategy: "adopt", previousHashes},
				withExecutor: (apply) => apply(h.executor),
			});
			assert.deepStrictEqual(h.batches, [
				[`UPDATE "drizzle_migrations" SET "name" = '${newName}' WHERE "name" = '${oldName}';`],
			]);
			assert.deepStrictEqual(Object.keys(result.hashes), [`${newName}/migration.sql`]);
			assert.strictEqual(h.remaining(), 0);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("cannot adopt an edited rename or a rename without its previous hash", () =>
		Effect.gen(function* () {
			for (const previousHashes of [{old: "different"}, {}]) {
				const h = recorder([columns(), rows("old")]);
				const exit = yield* applyAlchemyFormat({
					executor: h.executor,
					table: "drizzle_migrations",
					records: [record("renamed")],
					drift: {strategy: "adopt", previousHashes},
				}).pipe(Effect.exit);
				assert.include(failureMessage(exit), 'recorded but gone from disk: "old"');
				assert.deepStrictEqual(h.batches, []);
			}
		}),
	);

	it.effect("two applied rows cannot adopt the same pending file", () =>
		Effect.gen(function* () {
			const h = recorder([columns(), rows("old", "also-old")]);
			const exit = yield* applyAlchemyFormat({
				executor: h.executor,
				table: "drizzle_migrations",
				records: [record("renamed")],
				drift: {strategy: "adopt", previousHashes: {old: "same", "also-old": "same"}},
			}).pipe(Effect.exit);
			assert.include(failureMessage(exit), "recorded but gone from disk");
			assert.deepStrictEqual(h.batches, []);
		}),
	);

	it.effect("checks recorded history even if every migration file was removed", () =>
		Effect.gen(function* () {
			const h = recorder([columns(), rows("old")]);
			const exit = yield* runMigrations({
				input: {dir: empty, table: "drizzle_migrations"},
				stamped: {table: "drizzle_migrations"},
				drift: drift("adopt"),
				withExecutor: (apply) => apply(h.executor),
			}).pipe(Effect.provide(NodeServices.layer), Effect.exit);
			assert.include(failureMessage(exit), "recorded but gone from disk");
			assert.deepStrictEqual(h.batches, []);
		}),
	);

	it.effect("keeps upstream directory-name aliases without replay", () =>
		Effect.gen(function* () {
			const h = recorder([
				columns(),
				rows(`${nested}/migration.sql`),
				columns(),
				rows(`${nested}/migration.sql`),
			]);
			yield* applyAlchemyFormat({
				executor: h.executor,
				table: "drizzle_migrations",
				records: [record(nested)],
				drift: {previousHashes: {}},
			});
			assert.deepStrictEqual(h.batches, []);
		}),
	);

	it.effect("fails closed when the existing history cannot be read", () =>
		Effect.gen(function* () {
			const h = recorder([new MigrationError({message: "history unavailable"})]);
			const exit = yield* applyAlchemyFormat({
				executor: h.executor,
				table: "drizzle_migrations",
				records: [record("next")],
				drift: drift(),
			}).pipe(Effect.exit);
			assert.include(failureMessage(exit), "history unavailable");
			assert.deepStrictEqual(h.batches, []);
		}),
	);

	it("threads the D1 resource's adoption choice and prior hashes into both providers", () => {
		const cloudflare = fileURLToPath(import.meta.resolve("alchemy/Cloudflare"));
		const source = fs.readFileSync(path.join(path.dirname(cloudflare), "D1/Database.js"), "utf8");
		assert.strictEqual(
			source.match(
				/drift: \{ strategy: news\.migrationsDriftStrategy, previousHashes: output\?\.migrationsHashes \?\? \{\} \}/g,
			)?.length,
			2,
		);
	});
});
