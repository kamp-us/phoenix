import {describe, expect, it} from "vitest";
import {
	alchemyPrefix,
	type Baseline,
	deriveBaseline,
	evaluate,
	type Migration,
	type MigrationTree,
	migrationNumber,
} from "./migrations-guard.ts";

const flat = (tag: string, hash: string): Migration => ({
	tag,
	id: `${tag}.sql`,
	layout: "flat",
	hash,
	hasSnapshot: false,
});

const dir = (tag: string, hash: string, over: Partial<Migration> = {}): Migration => ({
	tag,
	id: `${tag}/migration.sql`,
	layout: "directory",
	hash,
	hasSnapshot: true,
	...over,
});

// The post-cutover shape: three frozen flat migrations plus one directory migration whose
// timestamp prefix sorts after them. Every case below perturbs one property off this base.
const tree = (over: Partial<MigrationTree> = {}): MigrationTree => ({
	migrations: [
		flat("0000_a", "h0"),
		flat("0001_b", "h1"),
		flat("0002_c", "h2"),
		dir("20260820035306_v7_baseline", "hb"),
	],
	metaDirPresent: false,
	unrecognizedSqlFiles: [],
	...over,
});

const baseline: Baseline = {
	"0000_a": "h0",
	"0001_b": "h1",
	"0002_c": "h2",
	"20260820035306_v7_baseline": "hb",
};

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

describe("alchemyPrefix mirrors alchemy's own getPrefix", () => {
	it("parses the segment before the first underscore", () => {
		expect(alchemyPrefix("0032_user_role_event.sql")).toBe(32);
		expect(alchemyPrefix("20260820035306_v7_baseline/migration.sql")).toBe(20260820035306);
	});
	it("is null when that segment is not a number", () => {
		expect(alchemyPrefix("baseline/migration.sql")).toBeNull();
	});
});

describe("a valid post-cutover tree passes", () => {
	it("accepts frozen flat history beside a directory migration", () => {
		const v = evaluate(tree(), baseline);
		expect(v.ok).toBe(true);
		expect(v.violations).toEqual([]);
	});
});

describe("consistency", () => {
	it("fails closed on zero scope (ADR 0092)", () => {
		const v = evaluate(tree({migrations: []}), baseline);
		expect(v.ok).toBe(false);
		expect(v.violations).toHaveLength(1);
		expect(v.violations[0]?.message).toContain("zero scope");
	});
	it("flags the retired meta/ layout coming back", () => {
		expect(kinds(tree({metaDirPresent: true}))).toContain("consistency");
	});
	it("flags a migration directory with no snapshot.json", () => {
		const t = tree({
			migrations: [
				flat("0000_a", "h0"),
				flat("0001_b", "h1"),
				flat("0002_c", "h2"),
				dir("20260820035306_v7_baseline", "hb", {hasSnapshot: false}),
			],
		});
		expect(kinds(t)).toContain("consistency");
	});
	it("flags a .sql outside the two known layouts — alchemy would apply it too", () => {
		const t = tree({unrecognizedSqlFiles: ["20260820035306_v7_baseline/extra.sql"]});
		expect(kinds(t)).toContain("consistency");
	});
	it("flags an unrecognized .sql even when the tree is otherwise zero scope", () => {
		const t = tree({migrations: [], unrecognizedSqlFiles: ["0001_x/evil.sql"]});
		const v = evaluate(t, baseline);
		expect(v.ok).toBe(false);
		expect(v.violations.some((x) => x.message.includes("0001_x/evil.sql"))).toBe(true);
	});
	it("flags a NEW flat migration — the flat layout is frozen history", () => {
		const t = tree({migrations: [...tree().migrations, flat("0003_new", "hNEW")]});
		const v = evaluate(t, baseline);
		expect(v.ok).toBe(false);
		expect(v.violations.some((x) => x.message.includes("frozen history"))).toBe(true);
	});
	it("flags a duplicate apply prefix", () => {
		const t = tree({
			migrations: [...tree().migrations, dir("20260820035306_again", "hx")],
		});
		expect(kinds(t)).toContain("consistency");
	});
	it("flags a prefix-less directory alchemy would sort last by name", () => {
		const t = tree({
			migrations: [...tree().migrations, dir("baseline", "hx")],
		});
		expect(kinds(t)).toContain("consistency");
	});
	it("flags a directory migration absent from the baseline (ADR 0309 amendment)", () => {
		const t = tree({migrations: [...tree().migrations, dir("20260901120000_next", "hNEW")]});
		const v = evaluate(t, baseline);
		expect(v.ok).toBe(false);
		expect(
			v.violations.some(
				(x) => x.kind === "consistency" && x.message.includes("lands with its baseline row"),
			),
		).toBe(true);
	});
	it("accepts a purely additive directory migration landed with its baseline row", () => {
		const t = tree({migrations: [...tree().migrations, dir("20260901120000_next", "hNEW")]});
		const v = evaluate(t, {...baseline, "20260901120000_next": "hNEW"});
		expect(v.ok).toBe(true);
		expect(v.violations).toEqual([]);
	});
});

describe("ordering", () => {
	it("flags a gap in the flat numbers", () => {
		const t = tree({migrations: [flat("0000_a", "h0"), flat("0002_c", "h2")]});
		expect(kinds(t, {"0000_a": "h0", "0002_c": "h2"})).toContain("ordering");
	});
	it("flags a directory whose prefix sorts at or below the flat history", () => {
		const t = tree({migrations: [...tree().migrations, dir("0001_squeezed", "hx")]});
		expect(kinds(t)).toContain("ordering");
	});
	it("accepts a directory whose prefix sorts after every flat migration", () => {
		const t = tree({migrations: [...tree().migrations, dir("20260901120000_next", "hx")]});
		expect(evaluate(t, baseline).violations.filter((v) => v.kind === "ordering")).toEqual([]);
	});
});

describe("immutability", () => {
	it("flags an edited historical migration (hash changed vs baseline)", () => {
		const t = tree({
			migrations: [flat("0000_a", "h0"), flat("0001_b", "EDITED"), flat("0002_c", "h2")],
		});
		const v = evaluate(t, baseline);
		expect(v.ok).toBe(false);
		expect(v.violations.some((x) => x.kind === "immutability")).toBe(true);
	});
	it("flags an edited landed DIRECTORY migration too", () => {
		const t = tree({
			migrations: [
				flat("0000_a", "h0"),
				flat("0001_b", "h1"),
				flat("0002_c", "h2"),
				dir("20260820035306_v7_baseline", "EDITED"),
			],
		});
		expect(kinds(t)).toContain("immutability");
	});
	it("flags a deleted/renamed baselined migration (missing from tree)", () => {
		const t = tree({
			migrations: [flat("0000_a", "h0"), flat("0002_c", "h2")],
		});
		expect(kinds(t)).toContain("immutability");
	});
	it("judges a renamed baselined migration as both a missing tag and (unbaselined) new id", () => {
		// The #7034 shape: `0002_c.sql` became `0002_c/migration.sql` — the baseline tag is
		// keyed the same, so the rename reads as an edited-or-moved id, never a silent pass.
		const t = tree({
			migrations: [
				flat("0000_a", "h0"),
				flat("0001_b", "h1"),
				dir("20260901120000_c_moved", "h2"),
				dir("20260820035306_v7_baseline", "hb"),
			],
		});
		const v = evaluate(t, baseline);
		expect(v.ok).toBe(false);
		expect(
			v.violations.some((x) => x.kind === "immutability" && x.message.includes("0002_c")),
		).toBe(true);
		expect(v.violations.some((x) => x.kind === "consistency")).toBe(true);
	});
});

describe("deriveBaseline", () => {
	it("maps every present tag to its current hash", () => {
		expect(deriveBaseline(tree())).toEqual(baseline);
	});
});
