/**
 * The pure core of `cf-utils scrub-author-email` — the founder-side, one-off data-scrub verb
 * that removes email-at-rest from the denormalized `author_name` column on the three record
 * tables (`definition_record` / `post_record` / `comment_record`). It is the data-backfill
 * remediation of #2130's PII-at-rest leak: #2136 stopped *new* email-bearing writes; this
 * scrubs the rows persisted *before* that fix under the old `user.name ?? user.email`
 * fallback, which still render an email publicly on the author surfaces (#2137).
 *
 * This is delivered as a `cf-utils` verb — a server-side direct-D1 CLI over the D1 REST
 * transport (`@kampus/d1-rest`), reusing cf-utils' keychain credential seam — and NEVER as a
 * runtime worker route: a public/`ENVIRONMENT`-gated admin/seeder endpoint is exactly the
 * deleted fail-open hole (CLAUDE.md "Sözlük seed"; the removed `/api/admin/*` routes).
 *
 * Two invariants are load-bearing (both verified by `scrub-author-email.unit.test.ts`):
 *
 *   1. DESTRUCTIVE CEREMONY. The verb is DRY-RUN by default: it scans and prints the
 *      per-table affected-row COUNT only — never the email values (leak-clean output: the
 *      count is the signal, the PII is not). A write happens ONLY under an explicit
 *      confirm-and-name gate: `--execute` AND `--confirm scrub-author-email`. No `--execute`,
 *      or a wrong/absent `--confirm` name, is a refused write (a dry-run). There is no
 *      write-by-default and no silent write.
 *
 *   2. SQL GROUNDED vs REAL D1 (ADR 0082 — D1 is SQLite-over-REST, no `node:sqlite` oracle).
 *      The email-shaped predicate is core-SQLite `LIKE` (`author_name LIKE '%_@_%_._%'`), and
 *      the replacement label is recomputed in SQL by MIRRORING `authorDisplayLabel`
 *      (`apps/web/worker/features/pasaport/author-label.ts`) via core-SQLite scalar functions
 *      — `COALESCE(NULLIF(TRIM(name),''), '@'||NULLIF(TRIM(username),''), 'kullanıcı')`,
 *      joined on `author_id = user.id`. `LIKE`, `COALESCE`, `NULLIF`, `TRIM`, and `||` are all
 *      core SQLite (present in D1); the pure `recomputeLabel` here is the same rule in TS, kept
 *      in lockstep parity with `authorDisplayLabel` by the unit test.
 *
 * `author_name` is `.notNull()`, so the scrub REWRITES the value to the recomputed label — it
 * never nulls the column and never deletes the row.
 */
import {commentRecord, definitionRecord, postRecord} from "@kampus/db-schema";
import {like, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {defineRelations} from "drizzle-orm/relations";
import {AUTHOR_FALLBACK_LABEL, scrubUser} from "./scrub-schema.ts";

/**
 * The email-shaped `LIKE` heuristic, single-sourced so the count-scan and the UPDATE share the
 * exact same predicate. `author_name` legitimately holds free-form display names that may
 * contain a bare `@` (a name like `@ceyhun`), so a bare `%@%` match would over-scrub — the
 * heuristic requires the full `local@domain.tld` shape: at least one char before the `@`, at
 * least one after it before a `.`, and at least one char after the final `.`. In SQLite `LIKE`,
 * `_` matches exactly one char and `%` matches any run — so `'%_@_%_._%'` reads as
 * "(anything) _ @ _ (anything) _ . _ (anything)", i.e. a non-empty local part, a non-empty
 * domain label, a dot, and a non-empty TLD. This is core SQLite, present in D1 (ADR 0082).
 */
export const EMAIL_SHAPED_LIKE = "%_@_%_._%";

/** Does this persisted `author_name` look like an email (the {@link EMAIL_SHAPED_LIKE} shape)? */
export const isEmailShaped = (value: string): boolean => {
	// The TS mirror of the SQLite `LIKE` heuristic: a non-empty local part, `@`, a non-empty
	// domain label, a `.`, and a non-empty TLD, with the dot AFTER the `@`. Deliberately close
	// to the `LIKE` semantics (not a full RFC email validator) so the scan and the predicate
	// agree on what "email-shaped" means.
	const at = value.indexOf("@");
	if (at <= 0) return false;
	const domain = value.slice(at + 1);
	const dot = domain.indexOf(".");
	if (dot <= 0) return false;
	const tld = domain.slice(dot + 1);
	return tld.length > 0;
};

/**
 * The TS mirror of the persisted replacement label — the SAME precedence as
 * `authorDisplayLabel` (`apps/web/worker/features/pasaport/author-label.ts`): trimmed display
 * name → `@username` → the fixed `kullanıcı` fallback, whitespace-only treated as absent, email
 * structurally impossible (not an input). Kept in lockstep with `authorDisplayLabel` by the
 * unit test; the SQL `recomputeLabelSql` below is the third co-parity expression.
 */
export const recomputeLabel = (identity: {
	readonly name?: string | null | undefined;
	readonly username?: string | null | undefined;
}): string => {
	if (identity.name?.trim()) return identity.name.trim();
	if (identity.username?.trim()) return `@${identity.username.trim()}`;
	return AUTHOR_FALLBACK_LABEL;
};

// RQB v2 (drizzle 1.0): drizzle() takes `relations`, not `schema`. No relational `.with`
// traversal here (the recompute rides a correlated subquery in raw SQL), so an empty
// `defineRelations` just registers the tables — mirrors `@kampus/moderator-grant`.
const relations = defineRelations({
	definitionRecord,
	postRecord,
	commentRecord,
	user: scrubUser,
});

export type ScrubDb = ReturnType<typeof drizzle<typeof relations>>;

export const makeScrubDb = (d1: D1Database): ScrubDb => drizzle(d1, {relations});

/** The three denormalized read-model tables carrying an `author_name` / `author_id` pair. */
export const SCRUB_TABLES = [
	{name: "definition_record", table: definitionRecord},
	{name: "post_record", table: postRecord},
	{name: "comment_record", table: commentRecord},
] as const;

export type ScrubTableName = (typeof SCRUB_TABLES)[number]["name"];

/** The count of email-shaped `author_name` rows in one table (the dry-run signal, never PII). */
export interface TableAffected {
	readonly table: ScrubTableName;
	readonly count: number;
}

/**
 * The recomputed-label SQL expression — the SQLite mirror of `recomputeLabel`, correlated to
 * the matched record row's `author_id`. Core SQLite scalar functions only (ADR 0082):
 * `COALESCE` / `NULLIF` / `TRIM` / `||`, resolving the current label from `user` by id:
 *   COALESCE( NULLIF(TRIM(name),''), '@' || NULLIF(TRIM(username),''), 'kullanıcı' )
 * A missing `user` row (no match) makes both NULLIFs NULL → the `kullanıcı` fallback, exactly
 * as `authorDisplayLabel` returns the fallback for an empty identity — so a scrubbed row is
 * never left email-shaped even when the author account is gone.
 */
const recomputeLabelSql = (authorIdCol: ReturnType<typeof sql>) => sql`
	COALESCE(
		(SELECT NULLIF(TRIM(u.name), '') FROM "user" u WHERE u.id = ${authorIdCol}),
		(SELECT '@' || NULLIF(TRIM(u.username), '') FROM "user" u WHERE u.id = ${authorIdCol}),
		${AUTHOR_FALLBACK_LABEL}
	)
`;

/**
 * Count the email-shaped `author_name` rows in each of the three tables — the dry-run scan.
 * Returns per-table counts ONLY (leak-clean: it never selects or returns the email values).
 */
export const scanAffected = async (db: ScrubDb): Promise<ReadonlyArray<TableAffected>> => {
	const out: Array<TableAffected> = [];
	for (const {name, table} of SCRUB_TABLES) {
		const rows = await db
			.select({n: sql<number>`count(*)`})
			.from(table)
			.where(like(table.authorName, EMAIL_SHAPED_LIKE))
			.all();
		out.push({table: name, count: Number(rows[0]?.n ?? 0)});
	}
	return out;
};

/** The count of rows actually rewritten in one table under `--execute`. */
export interface TableScrubbed {
	readonly table: ScrubTableName;
	readonly changed: number;
}

/**
 * Rewrite every email-shaped `author_name` in each table to its recomputed label (name →
 * `@username` → `kullanıcı`), joined on `author_id`. Idempotent: the recomputed label is never
 * email-shaped, so re-running matches nothing. Never nulls the column, never deletes a row.
 * Called ONLY after the confirm-and-name gate has authorized the write (see `decideWrite`).
 */
export const scrubEmails = async (db: ScrubDb): Promise<ReadonlyArray<TableScrubbed>> => {
	const out: Array<TableScrubbed> = [];
	for (const {name, table} of SCRUB_TABLES) {
		const result = await db
			.update(table)
			.set({authorName: recomputeLabelSql(sql`${table.authorId}`)})
			.where(like(table.authorName, EMAIL_SHAPED_LIKE))
			.run();
		out.push({table: name, changed: result.meta.changes});
	}
	return out;
};

/** The one op name the confirm gate demands be typed to authorize the destructive write. */
export const CONFIRM_OP_NAME = "scrub-author-email";

/**
 * The pure confirm-and-name gate decision. A write is authorized ONLY when BOTH `--execute` is
 * passed AND `--confirm` names the op exactly (`scrub-author-email`). Absent `--execute`, or a
 * missing/wrong confirm name, is a refused write — the run stays a dry-run. This is the
 * destructive-ceremony core: there is no write-by-default and no single-flag write.
 */
export type WriteDecision =
	| {readonly _tag: "Write"}
	| {readonly _tag: "DryRun"; readonly reason: string};

export const decideWrite = (input: {
	readonly execute: boolean;
	readonly confirm: string | undefined;
}): WriteDecision => {
	if (!input.execute) {
		return {_tag: "DryRun", reason: "no --execute (dry-run by default)"};
	}
	if (input.confirm === undefined) {
		return {
			_tag: "DryRun",
			reason: `--execute given but --confirm is missing — name the op to authorize: --confirm ${CONFIRM_OP_NAME}`,
		};
	}
	if (input.confirm !== CONFIRM_OP_NAME) {
		return {
			_tag: "DryRun",
			reason: `--confirm "${input.confirm}" does not name the op — expected --confirm ${CONFIRM_OP_NAME}`,
		};
	}
	return {_tag: "Write"};
};

/**
 * Render the dry-run report — per-table counts and a total, and NOTHING ELSE. Deliberately
 * emits only the affected-row COUNT, never an `author_name` value: the count is the signal a
 * founder needs to size the blast radius, the email values are the PII the leak-clean output
 * must never re-print. A zero total is a first-class "nothing to scrub" (the #2137
 * close-as-done path).
 */
export const renderDryRun = (affected: ReadonlyArray<TableAffected>): string => {
	const total = affected.reduce((sum, a) => sum + a.count, 0);
	const lines = affected.map((a) => `  ${a.table}: ${a.count} email-shaped author_name row(s)`);
	const header =
		total === 0
			? "scrub-author-email (dry-run): no email-shaped author_name rows found — nothing to scrub"
			: `scrub-author-email (dry-run): ${total} email-shaped author_name row(s) would be rewritten`;
	const footer =
		total === 0
			? "  (exposure is nil — #2137 closeable as done)"
			: `  pass --execute --confirm ${CONFIRM_OP_NAME} to rewrite them to the author-label rule`;
	return [header, ...lines, footer].join("\n");
};

/** Render the post-write summary — per-table rewritten counts + a total. Counts only, no PII. */
export const renderScrubbed = (scrubbed: ReadonlyArray<TableScrubbed>): string => {
	const total = scrubbed.reduce((sum, s) => sum + s.changed, 0);
	const lines = scrubbed.map((s) => `  ${s.table}: ${s.changed} author_name row(s) rewritten`);
	return [
		`scrub-author-email: rewrote ${total} email-shaped author_name row(s) to the author-label rule`,
		...lines,
	].join("\n");
};
