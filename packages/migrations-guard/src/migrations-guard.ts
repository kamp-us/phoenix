/**
 * The pure, IO-free core of the D1 migrations guard (issue #1435, ADR 0108). It takes an
 * already-loaded snapshot of the flat migrations tree — the `.sql` filenames, the journal
 * `entries`, the per-migration snapshot filenames, the SQL content hashes, and a committed
 * immutability baseline — and returns the set of violations across three properties:
 *
 *   1. consistency  — `.sql` files ↔ journal entries ↔ snapshots agree on the migration set;
 *   2. ordering     — journal `idx`/tag and file numbers are contiguous from 0 and unique;
 *   3. immutability  — every migration already recorded in the baseline has an unchanged SQL
 *                      content hash (an edit to journaled history is caught; a *new* trailing
 *                      migration absent from the baseline passes).
 *
 * It never touches the filesystem; the `fs.ts` boundary loads the `MigrationTree` and the
 * baseline, this core decides. Total over the loaded input, so every branch is unit-testable.
 */

// A journal entry as drizzle-kit writes it into meta/_journal.json.
export interface JournalEntry {
	readonly idx: number;
	readonly tag: string;
}

// The loaded, IO-free view of the migrations tree the core decides over. Every field is the
// raw material a check needs; the fs boundary populates it, the core never re-reads disk.
export interface MigrationTree {
	// `.sql` filenames without the `.sql` extension, e.g. "0000_d1_baseline" — as committed.
	readonly sqlTags: readonly string[];
	// meta/_journal.json entries, in file order.
	readonly journal: readonly JournalEntry[];
	// meta/*_snapshot.json filenames without the `_snapshot.json` suffix. Two shapes exist in
	// the committed tree: the bare-number "0000" (early) and the tagged "0003_post_bookmark".
	readonly snapshotStems: readonly string[];
	// tag → sha256 of the `.sql` file's bytes, for every `.sql` file present.
	readonly sqlHashes: Readonly<Record<string, string>>;
}

// The committed immutability baseline: tag → the sha256 the migration's SQL had when it was
// first journaled. Regenerated deliberately (a re-baseline is an audited, committed edit).
export type Baseline = Readonly<Record<string, string>>;

export type ViolationKind = "consistency" | "ordering" | "immutability";

export interface Violation {
	readonly kind: ViolationKind;
	readonly message: string;
}

export interface GuardVerdict {
	readonly ok: boolean;
	readonly violations: readonly Violation[];
}

// The leading NNNN number of a migration tag ("0003_post_bookmark" → 3), or null if the tag
// does not begin with a 4-digit number — itself a malformed-name violation the caller flags.
export const migrationNumber = (tag: string): number | null => {
	const m = /^(\d{4})(?:_|$)/.exec(tag);
	const digits = m?.[1];
	return digits === undefined ? null : Number.parseInt(digits, 10);
};

// A snapshot stem may be bare ("0000") or tagged ("0003_post_bookmark"); reduce both to the
// leading 4-digit number so a stem can be matched against a journal entry regardless of shape.
const snapshotNumber = (stem: string): number | null => migrationNumber(stem);

// (1) Consistency: the `.sql` set, the journal `tag` set, and the snapshot set must name the
// same migrations. Compared by leading number so the bare-vs-tagged snapshot naming (0000 vs
// 0003_post_bookmark) does not read as a spurious mismatch.
const checkConsistency = (tree: MigrationTree): Violation[] => {
	const v: Violation[] = [];

	const sqlNums = new Set<number>();
	for (const tag of tree.sqlTags) {
		const n = migrationNumber(tag);
		if (n === null) {
			v.push({kind: "consistency", message: `.sql file "${tag}" has no leading NNNN number`});
		} else if (sqlNums.has(n)) {
			v.push({kind: "consistency", message: `duplicate .sql migration number ${n} (tag "${tag}")`});
		} else {
			sqlNums.add(n);
		}
	}

	const journalNums = new Set<number>();
	for (const e of tree.journal) {
		const n = migrationNumber(e.tag);
		if (n === null) {
			v.push({
				kind: "consistency",
				message: `journal entry tag "${e.tag}" has no leading NNNN number`,
			});
		} else {
			journalNums.add(n);
		}
	}

	const snapNums = new Set<number>();
	for (const stem of tree.snapshotStems) {
		const n = snapshotNumber(stem);
		if (n === null) {
			v.push({kind: "consistency", message: `snapshot "${stem}" has no leading NNNN number`});
		} else if (snapNums.has(n)) {
			v.push({
				kind: "consistency",
				message: `duplicate snapshot for migration number ${n} ("${stem}")`,
			});
		} else {
			snapNums.add(n);
		}
	}

	const count = tree.sqlTags.length;
	if (tree.journal.length !== count) {
		v.push({
			kind: "consistency",
			message: `count disagreement: ${count} .sql file(s) but ${tree.journal.length} journal entr(ies)`,
		});
	}
	if (tree.snapshotStems.length !== count) {
		v.push({
			kind: "consistency",
			message: `count disagreement: ${count} .sql file(s) but ${tree.snapshotStems.length} snapshot(s)`,
		});
	}

	for (const n of sqlNums) {
		if (!journalNums.has(n))
			v.push({kind: "consistency", message: `migration ${n} has a .sql file but no journal entry`});
		if (!snapNums.has(n))
			v.push({kind: "consistency", message: `migration ${n} has a .sql file but no snapshot`});
	}
	for (const n of journalNums) {
		if (!sqlNums.has(n))
			v.push({kind: "consistency", message: `migration ${n} has a journal entry but no .sql file`});
	}
	for (const n of snapNums) {
		if (!sqlNums.has(n))
			v.push({kind: "consistency", message: `migration ${n} has a snapshot but no .sql file`});
	}

	return v;
};

// (2) Ordering: journal `idx` runs 0,1,2,… contiguous and unique; each entry's `idx` matches
// the leading number of its `tag`; and the `.sql` numbers likewise run contiguous from 0.
const checkOrdering = (tree: MigrationTree): Violation[] => {
	const v: Violation[] = [];

	const idxs = tree.journal.map((e) => e.idx);
	const seen = new Set<number>();
	for (const idx of idxs) {
		if (seen.has(idx)) v.push({kind: "ordering", message: `duplicate journal idx ${idx}`});
		seen.add(idx);
	}
	const expectedIdx = [...idxs].sort((a, b) => a - b);
	for (let i = 0; i < expectedIdx.length; i++) {
		if (expectedIdx[i] !== i) {
			v.push({
				kind: "ordering",
				message: `journal idx not contiguous from 0: expected ${i}, found ${expectedIdx[i]}`,
			});
			break;
		}
	}

	for (const e of tree.journal) {
		const n = migrationNumber(e.tag);
		if (n !== null && n !== e.idx) {
			v.push({
				kind: "ordering",
				message: `journal entry tag "${e.tag}" number ${n} != its idx ${e.idx}`,
			});
		}
	}

	const sqlNums = tree.sqlTags
		.map(migrationNumber)
		.filter((n): n is number => n !== null)
		.sort((a, b) => a - b);
	for (let i = 0; i < sqlNums.length; i++) {
		if (sqlNums[i] !== i) {
			v.push({
				kind: "ordering",
				message: `.sql migration numbers not contiguous from 0: expected ${i}, found ${sqlNums[i]}`,
			});
			break;
		}
	}

	return v;
};

// (3) Immutability: every migration recorded in the baseline must have the SAME SQL content
// hash now. A migration present in the tree but ABSENT from the baseline is a new trailing
// migration and passes — it is not yet journaled history. A baseline tag missing from the tree
// (a deleted/renamed historical migration) is itself an immutability violation.
const checkImmutability = (tree: MigrationTree, baseline: Baseline): Violation[] => {
	const v: Violation[] = [];
	for (const [tag, hash] of Object.entries(baseline)) {
		const current = tree.sqlHashes[tag];
		if (current === undefined) {
			v.push({
				kind: "immutability",
				message: `baselined migration "${tag}" is missing from the tree — a journaled migration was deleted or renamed`,
			});
		} else if (current !== hash) {
			v.push({
				kind: "immutability",
				message: `journaled migration "${tag}" SQL content changed (baseline ${hash.slice(0, 12)}… now ${current.slice(0, 12)}…) — historical migrations are immutable`,
			});
		}
	}
	return v;
};

export const evaluate = (tree: MigrationTree, baseline: Baseline): GuardVerdict => {
	const violations = [
		...checkConsistency(tree),
		...checkOrdering(tree),
		...checkImmutability(tree, baseline),
	];
	return {ok: violations.length === 0, violations};
};

// The baseline the guard SHOULD carry for the current tree: every present migration mapped to
// its current SQL hash. `baseline` regenerates this deliberately (an audited re-baseline).
export const deriveBaseline = (tree: MigrationTree): Baseline => ({...tree.sqlHashes});

export const renderVerdict = (verdict: GuardVerdict): string => {
	if (verdict.ok) return "migrations-guard: OK — consistency, ordering, and immutability hold.";
	const lines = verdict.violations.map((x) => `  ✗ [${x.kind}] ${x.message}`);
	return [`migrations-guard: ${verdict.violations.length} violation(s):`, ...lines].join("\n");
};
