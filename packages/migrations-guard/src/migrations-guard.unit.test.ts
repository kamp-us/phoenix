import {describe, expect, it} from "vitest";
import {
	type Baseline,
	deriveBaseline,
	evaluate,
	type MigrationTree,
	migrationNumber,
} from "./migrations-guard.ts";

// A minimal well-formed tree: 3 migrations, journal + snapshots + hashes all agree, and a
// baseline matching the current hashes. Every case below perturbs one property off this base.
const tree = (over: Partial<MigrationTree> = {}): MigrationTree => ({
	sqlTags: ["0000_a", "0001_b", "0002_c"],
	journal: [
		{idx: 0, tag: "0000_a"},
		{idx: 1, tag: "0001_b"},
		{idx: 2, tag: "0002_c"},
	],
	snapshotStems: ["0000", "0001_b", "0002_c"],
	sqlHashes: {"0000_a": "h0", "0001_b": "h1", "0002_c": "h2"},
	...over,
});

const baseline: Baseline = {"0000_a": "h0", "0001_b": "h1", "0002_c": "h2"};

const kinds = (t: MigrationTree, b: Baseline = baseline) =>
	evaluate(t, b).violations.map((v) => v.kind);

describe("migrationNumber", () => {
	it("extracts the leading 4-digit number", () => {
		expect(migrationNumber("0003_post_bookmark")).toBe(3);
		expect(migrationNumber("0000")).toBe(0);
	});
	it("returns null when there is no leading NNNN", () => {
		expect(migrationNumber("post_bookmark")).toBeNull();
		expect(migrationNumber("12_short")).toBeNull();
	});
});

describe("a valid tree passes", () => {
	it("tolerates the bare-vs-tagged snapshot naming (0000 vs 0002_c)", () => {
		const v = evaluate(tree(), baseline);
		expect(v.ok).toBe(true);
		expect(v.violations).toEqual([]);
	});
});

describe("consistency (AC 1)", () => {
	it("flags a .sql file with no journal entry (count + missing-entry)", () => {
		const t = tree({
			sqlTags: ["0000_a", "0001_b", "0002_c", "0003_d"],
			sqlHashes: {"0000_a": "h0", "0001_b": "h1", "0002_c": "h2", "0003_d": "h3"},
		});
		expect(kinds(t)).toContain("consistency");
	});
	it("flags a renamed file (journal entry with no .sql)", () => {
		const t = tree({
			sqlTags: ["0000_a", "0001_RENAMED", "0002_c"],
			sqlHashes: {"0000_a": "h0", "0001_RENAMED": "h1", "0002_c": "h2"},
		});
		// 0001 present in .sql and journal by number, so this surfaces as an immutability
		// miss on the baselined "0001_b" tag, plus consistency stays clean by number.
		expect(evaluate(t, baseline).ok).toBe(false);
	});
	it("flags a duplicate migration number in the .sql set", () => {
		const t = tree({
			sqlTags: ["0000_a", "0001_b", "0001_dup"],
			journal: [
				{idx: 0, tag: "0000_a"},
				{idx: 1, tag: "0001_b"},
			],
			snapshotStems: ["0000", "0001_b"],
			sqlHashes: {"0000_a": "h0", "0001_b": "h1", "0001_dup": "hx"},
		});
		expect(kinds(t)).toContain("consistency");
	});
	it("flags a missing snapshot", () => {
		const t = tree({snapshotStems: ["0000", "0001_b"]});
		expect(kinds(t)).toContain("consistency");
	});
});

describe("ordering (AC 2)", () => {
	it("flags a non-contiguous journal idx (gap)", () => {
		const t = tree({
			journal: [
				{idx: 0, tag: "0000_a"},
				{idx: 1, tag: "0001_b"},
				{idx: 3, tag: "0002_c"},
			],
		});
		expect(kinds(t)).toContain("ordering");
	});
	it("flags a duplicate journal idx", () => {
		const t = tree({
			journal: [
				{idx: 0, tag: "0000_a"},
				{idx: 1, tag: "0001_b"},
				{idx: 1, tag: "0002_c"},
			],
		});
		expect(kinds(t)).toContain("ordering");
	});
	it("flags a tag number that disagrees with its idx", () => {
		const t = tree({
			journal: [
				{idx: 0, tag: "0000_a"},
				{idx: 1, tag: "0002_b"},
				{idx: 2, tag: "0002_c"},
			],
			sqlTags: ["0000_a", "0002_b", "0002_c"],
			snapshotStems: ["0000", "0002_b", "0002_c"],
			sqlHashes: {"0000_a": "h0", "0002_b": "h1", "0002_c": "h2"},
		});
		expect(kinds(t)).toContain("ordering");
	});
});

describe("immutability (AC 3)", () => {
	it("flags an edited historical migration (hash changed vs baseline)", () => {
		const t = tree({sqlHashes: {"0000_a": "h0", "0001_b": "EDITED", "0002_c": "h2"}});
		const v = evaluate(t, baseline);
		expect(v.ok).toBe(false);
		expect(v.violations.some((x) => x.kind === "immutability")).toBe(true);
	});
	it("flags a deleted/renamed baselined migration (missing from tree)", () => {
		const t = tree({
			sqlTags: ["0000_a", "0002_c"],
			journal: [
				{idx: 0, tag: "0000_a"},
				{idx: 1, tag: "0002_c"},
			],
			snapshotStems: ["0000", "0002_c"],
			sqlHashes: {"0000_a": "h0", "0002_c": "h2"},
		});
		expect(kinds(t)).toContain("immutability");
	});
	it("PASSES a new trailing migration absent from the baseline (AC 3 second half)", () => {
		const t = tree({
			sqlTags: ["0000_a", "0001_b", "0002_c", "0003_new"],
			journal: [
				{idx: 0, tag: "0000_a"},
				{idx: 1, tag: "0001_b"},
				{idx: 2, tag: "0002_c"},
				{idx: 3, tag: "0003_new"},
			],
			snapshotStems: ["0000", "0001_b", "0002_c", "0003_new"],
			sqlHashes: {"0000_a": "h0", "0001_b": "h1", "0002_c": "h2", "0003_new": "hNEW"},
		});
		const v = evaluate(t, baseline);
		expect(v.ok).toBe(true);
	});
});

describe("deriveBaseline", () => {
	it("maps every present tag to its current hash", () => {
		expect(deriveBaseline(tree())).toEqual({"0000_a": "h0", "0001_b": "h1", "0002_c": "h2"});
	});
});
