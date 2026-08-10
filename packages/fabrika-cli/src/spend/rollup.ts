/**
 * The spend roll-up — what fabrika's runs cost, summed out of the durable ledger (#5010).
 *
 * Pure and total: it takes what {@link readSpendLedger} already produced and a resolved window, and
 * returns the answer. Nothing here reads a file, spawns anything, or re-parses a transcript — the
 * rows were measured when the runs finished, and this only adds them up.
 *
 * **Every number it cannot count is a number it reports.** A total that quietly omits the lines it
 * could not read, or the runs it could not place in time, is worse than an error: it is wrong and
 * looks right. So the unread halves ride out on the answer next to the total, split the way
 * {@link LedgerSkips} splits them, and a bounded window names how many rows it could not date.
 */
import type {LedgerRead, LedgerRow, LedgerSkips} from "./ledger.ts";

/** The four figures a roll-up answers with, plus how many runs stand behind them. */
export interface SpendTotals {
	/** Σ `billed` — the headline (ADR 0112 §2). */
	readonly billed: number;
	/** Σ `exCacheRead` — the cross-run comparator that does not re-count the cached prefix. */
	readonly exCacheRead: number;
	readonly assistantTurns: number;
	/** Rows in the bucket, measured or not. */
	readonly runs: number;
	/** Rows whose spend was actually reconstructed — the rest contributed nothing to the sums. */
	readonly measuredRuns: number;
}

export interface DayTotals extends SpendTotals {
	readonly day: string;
}

export interface SkillTotals extends SpendTotals {
	readonly skill: string;
}

export interface StageArmTotals extends SpendTotals {
	readonly stage: string;
	readonly arm: string;
}

/** The window as the operator wrote it, echoed back so an answer states what it covered. */
export interface RollupWindow {
	readonly since: string | null;
	readonly until: string | null;
}

/** Lines the ledger held but could not yield, carried onto the answer rather than dropped. */
export interface RollupSkipped extends LedgerSkips {
	readonly total: number;
}

export interface Rollup {
	readonly window: RollupWindow;
	readonly totals: SpendTotals;
	readonly skipped: RollupSkipped;
	/** Rows a bounded window could not place in time. Always 0 when no bound was given. */
	readonly undatedRows: number;
	readonly byDay: ReadonlyArray<DayTotals>;
	readonly bySkill: ReadonlyArray<SkillTotals>;
	readonly byStageArm: ReadonlyArray<StageArmTotals>;
}

/** A resolved window: epoch milliseconds, or `null` for an unbounded edge. */
export interface ResolvedWindow {
	readonly sinceAt: number | null;
	readonly untilAt: number | null;
	readonly text: RollupWindow;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve one window edge to epoch milliseconds, or `null` when it is not a time at all.
 *
 * A bare `YYYY-MM-DD` widens to the whole UTC day — `--since` to its first millisecond, `--until` to
 * its last — because an operator who writes `--until 2026-08-09` means "through the 9th", and
 * midnight would silently drop that day's every run.
 */
export const resolveBound = (text: string, edge: "since" | "until"): number | null => {
	const iso = DATE_ONLY.test(text)
		? `${text}T${edge === "since" ? "00:00:00.000" : "23:59:59.999"}Z`
		: text;
	const at = Date.parse(iso);
	return Number.isNaN(at) ? null : at;
};

const EMPTY: SpendTotals = {
	billed: 0,
	exCacheRead: 0,
	assistantTurns: 0,
	runs: 0,
	measuredRuns: 0,
};

const add = (totals: SpendTotals, row: LedgerRow): SpendTotals => {
	const runs = totals.runs + 1;
	if (row.spend._tag !== "Reconstructed") return {...totals, runs};
	const spend = row.spend.spend;
	return {
		billed: totals.billed + spend.billed,
		exCacheRead: totals.exCacheRead + spend.exCacheRead,
		assistantTurns: totals.assistantTurns + spend.assistantTurns,
		runs,
		measuredRuns: totals.measuredRuns + 1,
	};
};

const groupBy = <K extends string>(
	rows: ReadonlyArray<LedgerRow>,
	key: (row: LedgerRow) => K,
): ReadonlyArray<readonly [K, SpendTotals]> => {
	const buckets = new Map<K, SpendTotals>();
	for (const row of rows) {
		const k = key(row);
		buckets.set(k, add(buckets.get(k) ?? EMPTY, row));
	}
	return [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
};

/** The UTC day a row was recorded on — the stamp's own date, never a clock read here. */
const dayOf = (row: LedgerRow): string => row.recordedAt.slice(0, 10);

/** A tab cannot appear in a JSON-decoded key without being escaped, so it is a safe joiner. */
const STAGE_ARM = "\t";

/**
 * Select the rows a window covers.
 *
 * A row whose `recordedAt` is not a time cannot be *proven* inside a bounded window, so a bounded
 * window drops it and says how many it dropped — the same rule as everywhere else here: an
 * unplaceable row is reported, never quietly counted in or out. With no bound there is nothing to
 * prove, so every row is in.
 */
export const selectWindow = (
	rows: ReadonlyArray<LedgerRow>,
	window: ResolvedWindow,
): {readonly rows: ReadonlyArray<LedgerRow>; readonly undated: number} => {
	if (window.sinceAt === null && window.untilAt === null) return {rows, undated: 0};
	const selected: Array<LedgerRow> = [];
	let undated = 0;
	for (const row of rows) {
		const at = Date.parse(row.recordedAt);
		if (Number.isNaN(at)) {
			undated += 1;
			continue;
		}
		if (window.sinceAt !== null && at < window.sinceAt) continue;
		if (window.untilAt !== null && at > window.untilAt) continue;
		selected.push(row);
	}
	return {rows: selected, undated};
};

/** Sum a ledger read over a window, grouped three ways. */
export const rollUp = (read: LedgerRead, window: ResolvedWindow): Rollup => {
	const {rows, undated} = selectWindow(read.rows, window);
	return {
		window: window.text,
		totals: rows.reduce(add, EMPTY),
		skipped: {total: read.skipped, ...read.skips},
		undatedRows: undated,
		byDay: groupBy(rows, dayOf).map(([day, totals]) => ({day, ...totals})),
		bySkill: groupBy(rows, (row) => row.skillName).map(([skill, totals]) => ({skill, ...totals})),
		byStageArm: groupBy(rows, (row) => `${row.stage}${STAGE_ARM}${row.arm}`).map(
			([key, totals]) => {
				const [stage = "", arm = ""] = key.split(STAGE_ARM);
				return {stage, arm, ...totals};
			},
		),
	};
};
