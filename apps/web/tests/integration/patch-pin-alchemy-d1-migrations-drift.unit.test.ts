// @patch-pin: alchemy@2.0.0-beta.59
/**
 * Behavior-pin for the D1 migration-drift hunk of `patches/alchemy@2.0.0-beta.59.patch`
 * (ADR 0038, #7055, ADR 0309 amendment) — alchemy skips an applied migration by exact id
 * (= path) match, so renaming or deleting an already-applied file re-runs its SQL against a
 * database that already ran it (the #7034 stage outage). The patch makes `applyMigrations`
 * refuse that drift with an adopt-or-wipe report; `migrationsDriftStrategy: "adopt"` re-keys
 * content-identical renames without re-running their SQL and never covers a deletion.
 *
 * GROUND reads the installed artifact's text so a `pnpm install` that drops the hunk reds;
 * CONTRACT imports the patched module's pure exports and exercises the real classifier.
 *
 * Retire this file when an alchemy release ships drift detection natively.
 */
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {describe, expect, it} from "vitest";

const cloudflareEntry = fileURLToPath(import.meta.resolve("alchemy/Cloudflare"));
const d1Dir = path.join(path.dirname(cloudflareEntry), "D1");
const applyMigrationsPath = path.join(d1Dir, "ApplyMigrations.js");
const applySrc = fs.readFileSync(applyMigrationsPath, "utf8");
const databaseSrc = fs.readFileSync(path.join(d1Dir, "Database.js"), "utf8");
const propsDts = fs.readFileSync(path.join(d1Dir, "Database.d.ts"), "utf8");

interface DriftReport {
	readonly drifted: boolean;
	readonly renames: ReadonlyArray<{readonly from: string; readonly to: string}>;
	readonly deletions: ReadonlyArray<string>;
}
interface DriftFile {
	readonly id: string;
	readonly hash: string;
}
const mod = (await import(/* @vite-ignore */ pathToFileURL(applyMigrationsPath).href)) as {
	detectMigrationsDrift: (
		applied: ReadonlySet<string>,
		files: ReadonlyArray<DriftFile>,
		previousHashes: Readonly<Record<string, string>>,
	) => DriftReport;
	renderMigrationsDrift: (report: DriftReport) => string;
};

describe("patch-pin: alchemy D1 migration-drift refusal (#7055)", () => {
	describe("grounding — the installed artifact carries the hunk", () => {
		it("applyMigrations classifies drift before the apply loop and refuses it", () => {
			expect(applySrc).toContain(
				"detectMigrationsDrift(applied, migrationsFiles, previousHashes ?? {})",
			);
			expect(applySrc).toContain('driftStrategy !== "adopt" || drift.deletions.length > 0');
		});

		it("adopt re-keys the record instead of re-running the SQL", () => {
			expect(applySrc).toContain(
				"UPDATE ${migrationsTable} SET name = '${to}' WHERE name = '${from}'",
			);
		});

		it("Database threads the strategy prop and the state's last-deploy hashes", () => {
			expect(databaseSrc).toContain("news.migrationsDriftStrategy, output?.migrationsHashes ?? {}");
		});

		it("DatabaseProps declares the `migrationsDriftStrategy` prop", () => {
			expect(propsDts).toMatch(/migrationsDriftStrategy\?:\s*"adopt"/);
		});
	});

	describe("contract — detectMigrationsDrift, the patched module's own export", () => {
		const files = (...rows: ReadonlyArray<[string, string]>): DriftFile[] =>
			rows.map(([id, hash]) => ({id, hash}));

		it("no drift when every recorded id is still on disk (a new pending file is fine)", () => {
			const report = mod.detectMigrationsDrift(
				new Set(["0000_a.sql"]),
				files(["0000_a.sql", "hA"], ["20260901_next/migration.sql", "hNEW"]),
				{"0000_a.sql": "hA"},
			);
			expect(report.drifted).toBe(false);
		});

		it("classifies a content-identical rename via the state's tracked hash (the #7034 shape)", () => {
			const report = mod.detectMigrationsDrift(
				new Set(["0000_a.sql", "0034_user_activity_day.sql"]),
				files(["0000_a.sql", "hA"], ["0034_user_activity_day/migration.sql", "h34"]),
				{"0000_a.sql": "hA", "0034_user_activity_day.sql": "h34"},
			);
			expect(report.drifted).toBe(true);
			expect(report.renames).toEqual([
				{from: "0034_user_activity_day.sql", to: "0034_user_activity_day/migration.sql"},
			]);
			expect(report.deletions).toEqual([]);
		});

		it("a recorded id with no hash-equal pending file is a deletion — never adoptable", () => {
			const report = mod.detectMigrationsDrift(
				new Set(["0000_a.sql", "0001_b.sql"]),
				files(["0000_a.sql", "hA"], ["0001_b_edited/migration.sql", "hDIFFERENT"]),
				{"0000_a.sql": "hA", "0001_b.sql": "hB"},
			);
			expect(report.renames).toEqual([]);
			expect(report.deletions).toEqual(["0001_b.sql"]);
		});

		it("a recorded id absent from the previous-hash map cannot be hash-proven — deletion", () => {
			const report = mod.detectMigrationsDrift(
				new Set(["0000_a.sql"]),
				files(["0000_moved/migration.sql", "hA"]),
				{},
			);
			expect(report.deletions).toEqual(["0000_a.sql"]);
		});

		it("two identical-content orphans cannot both claim one pending candidate", () => {
			const report = mod.detectMigrationsDrift(
				new Set(["0000_a.sql", "0001_b.sql"]),
				files(["0000_moved/migration.sql", "hSAME"]),
				{"0000_a.sql": "hSAME", "0001_b.sql": "hSAME"},
			);
			expect(report.renames).toHaveLength(1);
			expect(report.deletions).toHaveLength(1);
		});

		it("the refusal report asks the adopt-or-wipe question, naming both routes", () => {
			const text = mod.renderMigrationsDrift(
				mod.detectMigrationsDrift(
					new Set(["0000_a.sql"]),
					files(["0000_moved/migration.sql", "hA"]),
					{
						"0000_a.sql": "hA",
					},
				),
			);
			expect(text).toContain("Decide adopt or wipe:");
			expect(text).toContain('migrationsDriftStrategy: "adopt"');
			expect(text).toContain("destroy and recreate this stage's database");
			expect(text).toContain(
				'renamed (content-identical): "0000_a.sql" -> "0000_moved/migration.sql"',
			);
		});
	});
});
