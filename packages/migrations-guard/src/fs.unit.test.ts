import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {loadBaseline, loadMigrationTree, serializeBaseline} from "./fs.ts";
import {deriveBaseline, evaluate} from "./migrations-guard.ts";

let dir: string;

// The post-cutover shape on disk: frozen flat history plus one migration directory.
const writeTree = (root: string) => {
	writeFileSync(join(root, "0000_a.sql"), "CREATE TABLE a (id INTEGER);\n");
	writeFileSync(join(root, "0001_b.sql"), "CREATE TABLE b (id INTEGER);\n");
	const migration = join(root, "20260820035306_v7_baseline");
	mkdirSync(migration, {recursive: true});
	writeFileSync(join(migration, "migration.sql"), "-- no-op baseline\n");
	writeFileSync(join(migration, "snapshot.json"), '{"version":"7"}');
};

const baselinePath = () => join(dir, "migration-hashes.json");
const writeBaseline = () =>
	writeFileSync(baselinePath(), serializeBaseline(deriveBaseline(loadMigrationTree(dir))));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "migrations-guard-"));
	writeTree(dir);
});
afterEach(() => rmSync(dir, {recursive: true, force: true}));

describe("loadMigrationTree", () => {
	it("loads both layouts with alchemy's apply id and stable content hashes", () => {
		const tree = loadMigrationTree(dir);
		expect(tree.migrations.map((m) => m.id)).toEqual([
			"0000_a.sql",
			"0001_b.sql",
			"20260820035306_v7_baseline/migration.sql",
		]);
		expect(tree.migrations.map((m) => m.layout)).toEqual(["flat", "flat", "directory"]);
		expect(tree.migrations[2]?.hasSnapshot).toBe(true);
		expect(tree.migrations[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(tree.metaDirPresent).toBe(false);
	});

	it("reports a meta/ directory that came back", () => {
		mkdirSync(join(dir, "meta"));
		writeFileSync(join(dir, "meta", "_journal.json"), "{}");
		expect(loadMigrationTree(dir).metaDirPresent).toBe(true);
	});

	it("sees a stray .sql beside migration.sql", () => {
		writeFileSync(join(dir, "20260820035306_v7_baseline", "extra.sql"), "DROP TABLE a;\n");
		expect(loadMigrationTree(dir).unrecognizedSqlFiles).toEqual([
			"20260820035306_v7_baseline/extra.sql",
		]);
	});

	// alchemy's `listSqlFiles` reads migrationsDir with `{recursive: true}`, so each of these three
	// shapes is applied at deploy time; the guard has to see every one of them (#6438).
	it("sees a .sql in a directory that carries no migration.sql", () => {
		mkdirSync(join(dir, "0001_x"));
		writeFileSync(join(dir, "0001_x", "evil.sql"), "DROP TABLE a;\n");
		const tree = loadMigrationTree(dir);
		expect(tree.unrecognizedSqlFiles).toEqual(["0001_x/evil.sql"]);
		expect(tree.migrations.map((m) => m.id)).not.toContain("0001_x/evil.sql");
	});

	it("sees a .sql nested deeper than one level", () => {
		mkdirSync(join(dir, "20260820035306_v7_baseline", "sub"));
		writeFileSync(join(dir, "20260820035306_v7_baseline", "sub", "y.sql"), "DROP TABLE a;\n");
		expect(loadMigrationTree(dir).unrecognizedSqlFiles).toEqual([
			"20260820035306_v7_baseline/sub/y.sql",
		]);
	});

	it("sees a .sql that came back under meta/", () => {
		mkdirSync(join(dir, "meta"));
		writeFileSync(join(dir, "meta", "0000_a.sql"), "DROP TABLE a;\n");
		expect(loadMigrationTree(dir).unrecognizedSqlFiles).toEqual(["meta/0000_a.sql"]);
	});

	it("the two known layouts are recognized, so a clean tree has none", () => {
		expect(loadMigrationTree(dir).unrecognizedSqlFiles).toEqual([]);
	});

	it("hashes are content-derived — editing a .sql changes its hash", () => {
		const before = loadMigrationTree(dir).migrations[1]?.hash;
		writeFileSync(join(dir, "0001_b.sql"), "CREATE TABLE b (id INTEGER, x TEXT);\n");
		expect(loadMigrationTree(dir).migrations[1]?.hash).not.toBe(before);
	});
});

describe("baseline round-trip drives the immutability check", () => {
	it("a baseline written from the tree passes, and an edit afterward fails", () => {
		writeBaseline();
		expect(evaluate(loadMigrationTree(dir), loadBaseline(baselinePath())).ok).toBe(true);

		writeFileSync(join(dir, "0000_a.sql"), "CREATE TABLE a (id INTEGER, edited TEXT);\n");
		const verdict = evaluate(loadMigrationTree(dir), loadBaseline(baselinePath()));
		expect(verdict.ok).toBe(false);
		expect(verdict.violations.some((v) => v.kind === "immutability")).toBe(true);
	});

	it("editing a landed migration.sql fails the same way", () => {
		writeBaseline();
		writeFileSync(join(dir, "20260820035306_v7_baseline", "migration.sql"), "-- edited\n");
		const verdict = evaluate(loadMigrationTree(dir), loadBaseline(baselinePath()));
		expect(verdict.violations.some((v) => v.kind === "immutability")).toBe(true);
	});

	it("a new migration directory reds until its baseline row lands beside it (#7055)", () => {
		writeBaseline();
		const next = join(dir, "20260901120000_next");
		mkdirSync(next);
		writeFileSync(join(next, "migration.sql"), "ALTER TABLE a ADD COLUMN x TEXT;\n");
		writeFileSync(join(next, "snapshot.json"), '{"version":"7"}');
		const before = evaluate(loadMigrationTree(dir), loadBaseline(baselinePath()));
		expect(before.ok).toBe(false);
		expect(before.violations.some((v) => v.message.includes("lands with its baseline row"))).toBe(
			true,
		);

		writeBaseline();
		expect(evaluate(loadMigrationTree(dir), loadBaseline(baselinePath())).ok).toBe(true);
	});

	it("a .sql sorting into applied history reds instead of slipping past the checks", () => {
		writeBaseline();
		mkdirSync(join(dir, "0001_x"));
		writeFileSync(join(dir, "0001_x", "evil.sql"), "DROP TABLE a;\n");
		const verdict = evaluate(loadMigrationTree(dir), loadBaseline(baselinePath()));
		expect(verdict.ok).toBe(false);
		expect(verdict.violations.some((v) => v.message.includes("0001_x/evil.sql"))).toBe(true);
	});

	it("an empty directory is zero scope, not a pass (ADR 0092)", () => {
		const empty = mkdtempSync(join(tmpdir(), "migrations-guard-empty-"));
		const verdict = evaluate(loadMigrationTree(empty), {});
		rmSync(empty, {recursive: true, force: true});
		expect(verdict.ok).toBe(false);
	});
});

describe("loadBaseline", () => {
	it("a missing baseline reads as empty (pre-baseline state)", () => {
		expect(loadBaseline(join(dir, "does-not-exist.json"))).toEqual({});
	});
});
