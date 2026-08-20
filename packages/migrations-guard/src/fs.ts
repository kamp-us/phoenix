/**
 * The filesystem boundary: load a `MigrationTree` from the migrations directory and read the
 * committed immutability baseline. The only module that touches disk, keeping the core pure.
 */
import {createHash} from "node:crypto";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Baseline, Migration, MigrationTree} from "./migrations-guard.ts";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const stripSuffix = (name: string, suffix: string): string =>
	name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;

// The one file inside a migration directory alchemy is meant to apply; anything else ending in
// `.sql` beside it would apply as a second migration, which the core reds on.
const MIGRATION_SQL = "migration.sql";

/**
 * Load the tree from `migrationsDir`. Two layouts coexist (ADR 0309): the frozen flat
 * `NNNN_name.sql` files at the top level, and `<prefix>_<name>/migration.sql` directories.
 * The apply `id` is the path relative to `migrationsDir` — the string alchemy records — so it is
 * built with a forward slash regardless of platform, matching `readSqlFile`'s own `id: name`.
 */
export const loadMigrationTree = (migrationsDir: string): MigrationTree => {
	const entries = readdirSync(migrationsDir, {withFileTypes: true}).sort((a, b) =>
		a.name.localeCompare(b.name),
	);

	const migrations: Migration[] = [];
	let metaDirPresent = false;

	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (entry.name === "meta") {
				metaDirPresent = true;
				continue;
			}
			const dir = join(migrationsDir, entry.name);
			const inner = readdirSync(dir);
			if (!inner.includes(MIGRATION_SQL)) continue;
			migrations.push({
				tag: entry.name,
				id: `${entry.name}/${MIGRATION_SQL}`,
				layout: "directory",
				hash: sha256(readFileSync(join(dir, MIGRATION_SQL))),
				hasSnapshot: inner.includes("snapshot.json"),
				straySqlFiles: inner.filter((f) => f.endsWith(".sql") && f !== MIGRATION_SQL).sort(),
			});
			continue;
		}
		if (!entry.name.endsWith(".sql")) continue;
		migrations.push({
			tag: stripSuffix(entry.name, ".sql"),
			id: entry.name,
			layout: "flat",
			hash: sha256(readFileSync(join(migrationsDir, entry.name))),
			hasSnapshot: false,
			straySqlFiles: [],
		});
	}

	return {migrations, metaDirPresent};
};

// Read the committed baseline; a missing file is an empty baseline (the pre-baseline state —
// every migration then reads as new, so immutability has nothing to compare yet).
export const loadBaseline = (baselinePath: string): Baseline => {
	let text: string;
	try {
		text = readFileSync(baselinePath, "utf8");
	} catch {
		return {};
	}
	const raw = JSON.parse(text) as {readonly hashes?: Readonly<Record<string, string>>};
	return raw.hashes ?? {};
};

// Serialize with hash keys in sorted order so a re-baseline yields a stable, reviewable diff.
export const serializeBaseline = (baseline: Baseline): string => {
	const sortedHashes: Record<string, string> = {};
	for (const [tag, hash] of Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b))) {
		sortedHashes[tag] = hash;
	}
	return `${JSON.stringify({hashes: sortedHashes}, null, "\t")}\n`;
};
