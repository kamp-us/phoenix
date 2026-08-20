/**
 * The pure, IO-free core of the D1 migrations guard (issue #1435, ADR 0108; re-grounded on the
 * v7 layout by ADR 0309). It takes an already-loaded snapshot of the migrations tree — one row
 * per migration with its alchemy apply id, its content hash and its layout — plus a committed
 * immutability baseline, and returns the set of violations across three properties:
 *
 *   1. consistency  — the tree is a shape alchemy can apply and drizzle-kit can diff: every
 *                     directory migration carries a `migration.sql` and a `snapshot.json` and
 *                     no second `.sql`, the retired `meta/` layout is gone, no two migrations
 *                     share an apply prefix, and the frozen flat history gained no new member;
 *   2. ordering     — the flat `NNNN_` numbers run contiguous from 0, and every directory
 *                     migration sorts after all of them under alchemy's own prefix sort;
 *   3. immutability — every migration already recorded in the baseline has an unchanged SQL
 *                     content hash (an edit to landed history is caught; a *new* trailing
 *                     migration absent from the baseline passes).
 *
 * It never touches the filesystem and is total over the loaded input, so every branch is
 * unit-testable.
 */

// The two layouts that coexist in the tree after the v7 cutover (ADR 0309): the 33 frozen flat
// `NNNN_name.sql` files whose apply ids production already recorded, and the per-migration
// `<prefix>_<name>/migration.sql` directories drizzle-kit writes from here on.
export type MigrationLayout = "flat" | "directory";

// One migration as the guard decides over it. `id` is the path relative to the migrations dir —
// the exact string alchemy stores in `drizzle_migrations.name` and matches against on the next
// deploy, so it is the field the no-replay property is about. `tag` is the baseline key.
export interface Migration {
	readonly tag: string;
	readonly id: string;
	readonly layout: MigrationLayout;
	readonly hash: string;
	// Directory migrations only: whether `snapshot.json` sits beside `migration.sql`, and any
	// `.sql` in the directory that is not `migration.sql`. Both are false/empty for flat rows.
	readonly hasSnapshot: boolean;
	readonly straySqlFiles: readonly string[];
}

// The loaded, IO-free view of the migrations tree. The fs boundary populates it; the core never
// re-reads disk. `metaDirPresent` is its own field because an empty `meta/` produces no rows yet
// is still the retired layout coming back.
export interface MigrationTree {
	readonly migrations: readonly Migration[];
	readonly metaDirPresent: boolean;
}

// The committed immutability baseline: tag → the sha256 the migration's SQL had when it landed.
// Regenerated deliberately (a re-baseline is an audited, committed edit).
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

// The leading NNNN number of a flat migration tag ("0003_post_bookmark" → 3), or null when the
// tag does not begin with a 4-digit number — itself a malformed-name violation the caller flags.
export const migrationNumber = (tag: string): number | null => {
	const m = /^(\d{4})(?:_|$)/.exec(tag);
	const digits = m?.[1];
	return digits === undefined ? null : Number.parseInt(digits, 10);
};

/**
 * alchemy's apply-order key, mirroring `getPrefix` in its `lib/Sql/SqlFile.js` byte for byte:
 * `Number.parseInt(name.split("_")[0], 10)`, null when that is NaN. Ordering below is judged on
 * this and not on our own parse, because this is the function that decides what runs first.
 */
export const alchemyPrefix = (id: string): number | null => {
	const head = id.split("_")[0] ?? "";
	const num = Number.parseInt(head, 10);
	return Number.isNaN(num) ? null : num;
};

const isFlat = (m: Migration): boolean => m.layout === "flat";

// (1) Consistency: the tree is a shape both tools accept, and the frozen flat history is intact.
const checkConsistency = (tree: MigrationTree, baseline: Baseline): Violation[] => {
	const v: Violation[] = [];

	// Fail closed on zero scope (ADR 0092): an empty tree means the guard is reading the wrong
	// directory, and "nothing to check" must never read as "everything is fine".
	if (tree.migrations.length === 0) {
		v.push({
			kind: "consistency",
			message: "no migrations found — zero scope; the guard is pointed at the wrong directory",
		});
		return v;
	}

	if (tree.metaDirPresent) {
		v.push({
			kind: "consistency",
			message:
				'a "meta/" directory is present — the v6 central-journal layout is retired (ADR 0309); drizzle-kit refuses to generate against it',
		});
	}

	for (const m of tree.migrations) {
		if (m.layout === "directory") {
			if (!m.hasSnapshot) {
				v.push({
					kind: "consistency",
					message: `migration directory "${m.tag}" has no snapshot.json — drizzle-kit cannot diff the next generate against it`,
				});
			}
			for (const stray of m.straySqlFiles) {
				v.push({
					kind: "consistency",
					message: `migration directory "${m.tag}" holds a second .sql file "${stray}" — alchemy applies every .sql it finds, so this would run as its own migration`,
				});
			}
		} else if (baseline[m.tag] === undefined) {
			v.push({
				kind: "consistency",
				message: `flat migration "${m.id}" is not in the baseline — the flat layout is frozen history (ADR 0309); a new migration must be a <prefix>_<name>/migration.sql directory`,
			});
		}
	}

	const seenPrefix = new Map<number, string>();
	for (const m of tree.migrations) {
		const p = alchemyPrefix(m.id);
		if (p === null) {
			v.push({
				kind: "consistency",
				message: `migration "${m.id}" has no numeric prefix — alchemy sorts prefix-less files last by name, so its apply order is not the tree's order`,
			});
			continue;
		}
		const owner = seenPrefix.get(p);
		if (owner !== undefined) {
			v.push({
				kind: "consistency",
				message: `duplicate apply prefix ${p}: "${owner}" and "${m.id}" — their relative apply order is unspecified`,
			});
		} else {
			seenPrefix.set(p, m.id);
		}
	}

	return v;
};

// (2) Ordering: the flat numbers still run contiguous from 0, and every directory migration
// sorts strictly after all of them — a directory that sorted earlier would be applied ahead of
// migrations production has already run.
const checkOrdering = (tree: MigrationTree): Violation[] => {
	const v: Violation[] = [];

	const flatNums: number[] = [];
	for (const m of tree.migrations.filter(isFlat)) {
		const n = migrationNumber(m.tag);
		if (n === null) {
			v.push({
				kind: "ordering",
				message: `flat migration "${m.id}" has no leading NNNN number`,
			});
		} else {
			flatNums.push(n);
		}
	}
	flatNums.sort((a, b) => a - b);
	for (let i = 0; i < flatNums.length; i++) {
		if (flatNums[i] !== i) {
			v.push({
				kind: "ordering",
				message: `flat migration numbers not contiguous from 0: expected ${i}, found ${flatNums[i]}`,
			});
			break;
		}
	}

	const highestFlat = flatNums.length === 0 ? -1 : (flatNums[flatNums.length - 1] as number);
	for (const m of tree.migrations) {
		if (isFlat(m)) continue;
		const p = alchemyPrefix(m.id);
		if (p !== null && p <= highestFlat) {
			v.push({
				kind: "ordering",
				message: `migration directory "${m.tag}" has prefix ${p}, at or below the highest flat migration ${highestFlat} — it would be applied ahead of already-applied history`,
			});
		}
	}

	return v;
};

// (3) Immutability: every migration recorded in the baseline must have the SAME SQL content hash
// now. A migration present in the tree but ABSENT from the baseline is a new trailing migration
// and passes — it is not yet landed history. A baseline tag missing from the tree (a deleted or
// renamed migration) is itself a violation, and the sharpest one: its apply id is what production
// recorded, so losing it is what makes the whole set replay.
const checkImmutability = (tree: MigrationTree, baseline: Baseline): Violation[] => {
	const v: Violation[] = [];
	const hashes = new Map(tree.migrations.map((m) => [m.tag, m.hash]));
	for (const [tag, hash] of Object.entries(baseline)) {
		const current = hashes.get(tag);
		if (current === undefined) {
			v.push({
				kind: "immutability",
				message: `baselined migration "${tag}" is missing from the tree — a landed migration was deleted or renamed, which changes the apply id production recorded`,
			});
		} else if (current !== hash) {
			v.push({
				kind: "immutability",
				message: `landed migration "${tag}" SQL content changed (baseline ${hash.slice(0, 12)}… now ${current.slice(0, 12)}…) — landed migrations are immutable`,
			});
		}
	}
	return v;
};

export const evaluate = (tree: MigrationTree, baseline: Baseline): GuardVerdict => {
	const consistency = checkConsistency(tree, baseline);
	// A zero-scope tree has nothing to order and nothing to compare; the one violation above is
	// the whole answer, and running the rest would bury it under derived noise.
	const violations =
		tree.migrations.length === 0
			? consistency
			: [...consistency, ...checkOrdering(tree), ...checkImmutability(tree, baseline)];
	return {ok: violations.length === 0, violations};
};

// The baseline the guard SHOULD carry for the current tree: every present migration mapped to its
// current SQL hash. `baseline` regenerates this deliberately (an audited re-baseline).
export const deriveBaseline = (tree: MigrationTree): Baseline =>
	Object.fromEntries(tree.migrations.map((m) => [m.tag, m.hash]));

export const renderVerdict = (verdict: GuardVerdict): string => {
	if (verdict.ok) return "migrations-guard: OK — consistency, ordering, and immutability hold.";
	const lines = verdict.violations.map((x) => `  ✗ [${x.kind}] ${x.message}`);
	return [`migrations-guard: ${verdict.violations.length} violation(s):`, ...lines].join("\n");
};
