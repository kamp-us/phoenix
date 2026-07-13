/**
 * The filesystem boundary: load a `MigrationTree` from the flat migrations directory and read
 * the committed immutability baseline. The only module that touches disk, keeping the core pure.
 */
import {createHash} from "node:crypto";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Baseline, JournalEntry, MigrationTree} from "./migrations-guard.ts";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const stripSuffix = (name: string, suffix: string): string =>
	name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;

interface RawJournal {
	readonly entries?: readonly {readonly idx?: unknown; readonly tag?: unknown}[];
}

const parseJournal = (text: string): JournalEntry[] => {
	const raw = JSON.parse(text) as RawJournal;
	const entries = raw.entries ?? [];
	return entries.map((e, i) => {
		if (typeof e.idx !== "number") throw new Error(`journal entry ${i} has non-numeric idx`);
		if (typeof e.tag !== "string") throw new Error(`journal entry ${i} has non-string tag`);
		return {idx: e.idx, tag: e.tag};
	});
};

// Load the tree from `migrationsDir` (the dir holding the NNNN_*.sql files + a meta/ subdir
// with _journal.json and the per-migration *_snapshot.json files).
export const loadMigrationTree = (migrationsDir: string): MigrationTree => {
	const files = readdirSync(migrationsDir);
	const sqlFiles = files.filter((f) => f.endsWith(".sql")).sort();

	const sqlTags: string[] = [];
	const sqlHashes: Record<string, string> = {};
	for (const f of sqlFiles) {
		const tag = stripSuffix(f, ".sql");
		sqlTags.push(tag);
		sqlHashes[tag] = sha256(readFileSync(join(migrationsDir, f)));
	}

	const metaDir = join(migrationsDir, "meta");
	const journal = parseJournal(readFileSync(join(metaDir, "_journal.json"), "utf8"));
	const snapshotStems = readdirSync(metaDir)
		.filter((f) => f.endsWith("_snapshot.json"))
		.map((f) => stripSuffix(f, "_snapshot.json"))
		.sort();

	return {sqlTags, journal, snapshotStems, sqlHashes};
};

// Read the committed baseline; a missing file is an empty baseline (the pre-baseline state —
// every migration then reads as new/trailing, so immutability has nothing to compare yet).
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
