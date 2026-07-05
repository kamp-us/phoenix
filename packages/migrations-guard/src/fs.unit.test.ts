import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {loadBaseline, loadMigrationTree, serializeBaseline} from "./fs.ts";
import {evaluate} from "./migrations-guard.ts";

let dir: string;

const writeTree = (root: string) => {
	const meta = join(root, "meta");
	mkdirSync(meta, {recursive: true});
	writeFileSync(join(root, "0000_a.sql"), "CREATE TABLE a (id INTEGER);\n");
	writeFileSync(join(root, "0001_b.sql"), "CREATE TABLE b (id INTEGER);\n");
	writeFileSync(
		join(meta, "_journal.json"),
		JSON.stringify({
			version: "7",
			dialect: "sqlite",
			entries: [
				{idx: 0, tag: "0000_a"},
				{idx: 1, tag: "0001_b"},
			],
		}),
	);
	writeFileSync(join(meta, "0000_snapshot.json"), "{}");
	writeFileSync(join(meta, "0001_b_snapshot.json"), "{}");
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "migrations-guard-"));
	writeTree(dir);
});
afterEach(() => rmSync(dir, {recursive: true, force: true}));

describe("loadMigrationTree", () => {
	it("loads sql tags, journal, snapshots, and stable content hashes", () => {
		const tree = loadMigrationTree(dir);
		expect(tree.sqlTags).toEqual(["0000_a", "0001_b"]);
		expect(tree.journal).toEqual([
			{idx: 0, tag: "0000_a"},
			{idx: 1, tag: "0001_b"},
		]);
		expect(tree.snapshotStems).toEqual(["0000", "0001_b"]);
		expect(tree.sqlHashes["0000_a"]).toMatch(/^[0-9a-f]{64}$/);
	});

	it("hashes are content-derived — editing a .sql changes its hash", () => {
		const before = loadMigrationTree(dir).sqlHashes["0001_b"];
		writeFileSync(join(dir, "0001_b.sql"), "CREATE TABLE b (id INTEGER, x TEXT);\n");
		const after = loadMigrationTree(dir).sqlHashes["0001_b"];
		expect(after).not.toBe(before);
	});
});

describe("baseline round-trip drives the immutability check", () => {
	it("a baseline written from the tree passes, and an edit afterward fails", () => {
		const baselinePath = join(dir, "migration-hashes.json");
		writeFileSync(baselinePath, serializeBaseline(loadMigrationTree(dir).sqlHashes));

		expect(evaluate(loadMigrationTree(dir), loadBaseline(baselinePath)).ok).toBe(true);

		writeFileSync(join(dir, "0000_a.sql"), "CREATE TABLE a (id INTEGER, edited TEXT);\n");
		const verdict = evaluate(loadMigrationTree(dir), loadBaseline(baselinePath));
		expect(verdict.ok).toBe(false);
		expect(verdict.violations.some((v) => v.kind === "immutability")).toBe(true);
	});
});

describe("loadBaseline", () => {
	it("a missing baseline reads as empty (pre-baseline state)", () => {
		expect(loadBaseline(join(dir, "does-not-exist.json"))).toEqual({});
	});
});
