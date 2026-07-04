/**
 * The cross-encoding AGREEMENT oracle (#2013): the çaylak-sandbox visibility boundary
 * is encoded twice — the in-memory `EntityLifecycle.isVisibleTo` (a decision over the
 * lifecycle tags) and its SQL mirror `SandboxVisibility.sandboxVisibleWhere` (a drizzle
 * predicate composed with the caller's `isNull(removedAt)` guard, i.e. `publicLiveWhere`).
 * They must agree for EVERY lifecycle state; before #2013 nothing linked them, so a new
 * lifecycle tag could compile clean on the SQL side and silently mis-filter at the DB.
 *
 * Both encodings now derive from ONE source — `lifecycleVisibilityRule`, keyed by the
 * closed `LifecycleTag`, interpreted by `ruleVisibleTo` on the in-memory side and by the
 * exhaustive `sandboxArm` switch on the SQL side — so a new lifecycle tag is a compile
 * error at the map and at `sandboxArm`. This test is the RUNTIME oracle for that
 * compile-time tie: it iterates every `LifecycleTag` (exhaustive over the discriminant —
 * a new tag lands here with no expected verdict and its cell fails) and, for each viewer ×
 * ownership cell, evaluates the SQL predicate by APPLYING it to that row's concrete column
 * values and asserts the row is admitted iff `isVisibleTo` marks the state visible.
 *
 * ADR 0082 bans a faked in-process SQL engine (`node:sqlite`) at the unit tier — an
 * in-process engine is more permissive than real D1, so a faked-D1 unit suite can pass
 * while real D1 rejects it. Row-level filtering against real D1 is the integration tier's
 * job. So this unit oracle does NOT execute SQL: it evaluates the drizzle predicate
 * against a row with a small, faithful interpreter over exactly the operators these
 * predicates emit (`IS NULL` / `IS NOT NULL` / `=` / `AND` / `OR`), reading the operator
 * and operands off drizzle's own compiled `{sql, params}`. The interpreter is
 * rule-agnostic — it knows SQL, not the visibility rule — so agreement is not circular.
 */
import {assert, describe, it} from "@effect/vitest";
import {integer, SQLiteDialect, sqliteTable, text} from "drizzle-orm/sqlite-core";
import * as L from "./EntityLifecycle.ts";
import {publicLiveWhere} from "./SandboxVisibility.ts";

// A throwaway drizzle table carrying exactly the lifecycle columns the predicates read;
// used only to render `publicLiveWhere` to `{sql, params}` with stable column names.
const content = sqliteTable("content", {
	id: text("id").primaryKey(),
	authorId: text("author_id").notNull(),
	sandboxedAt: integer("sandboxed_at"),
	removedAt: integer("removed_at"),
});

const dialect = new SQLiteDialect();

const AUTHOR = "the-author";
const OTHER = "someone-else";
const at = 1_750_000_000_000; // epoch millis; a non-null timestamp marker

/** A content row's concrete column values, over exactly the columns the predicate reads. */
interface Row {
	readonly author_id: string;
	readonly sandboxed_at: number | null;
	readonly removed_at: number | null;
}

// The persisted-column shape for each lifecycle state. Exhaustive over `LifecycleTag`
// (a `Record` — a new tag is a compile error here, mirroring `lifecycleVisibilityRule`),
// so the oracle's row set tracks the discriminant. The in-memory `EntityLifecycle` value
// is rebuilt from these same columns via `fromColumns`, so both encodings see one input.
const columnsForTag: Record<
	L.LifecycleTag,
	{sandboxedAt: number | null; removedAt: number | null}
> = {
	Live: {sandboxedAt: null, removedAt: null},
	Sandboxed: {sandboxedAt: at, removedAt: null},
	Removed: {sandboxedAt: null, removedAt: at},
};

const viewers = {
	caylakAuthor: {viewerId: AUTHOR, canSeeSandboxed: false},
	yazar: {viewerId: "a-yazar", canSeeSandboxed: false},
	moderator: {viewerId: "a-mod", canSeeSandboxed: true},
	otherMember: {viewerId: OTHER, canSeeSandboxed: false},
	anonymous: L.anonymousViewer,
} satisfies Record<string, L.SandboxViewer>;

const rowForTag = (tag: L.LifecycleTag, authorId: string): Row => {
	const cols = columnsForTag[tag];
	return {author_id: authorId, sandboxed_at: cols.sandboxedAt, removed_at: cols.removedAt};
};

/**
 * A faithful, rule-AGNOSTIC evaluator of the compiled drizzle SQL predicate against a
 * `Row`, over exactly the operators `publicLiveWhere` emits. Positional `?` params are
 * substituted in order; a column reference resolves off the row by its snake_case name.
 * Uses SQL three-valued logic only where it can differ from JS: `col = value` is false
 * when the column is null (never matches), matching SQLite. This is NOT a SQL engine —
 * it interprets the small closed operator set drizzle rendered, so it cannot drift from
 * the actual predicate the way a hand-written boolean re-encoding would.
 */
const evalPredicate = (rendered: {sql: string; params: unknown[]}, row: Row): boolean => {
	let cursor = 0;
	const params = rendered.params;
	// Substitute positional params left-to-right into unique sentinels so tokenizing is
	// unambiguous, then walk a fully-parenthesized boolean expression.
	const withParams = rendered.sql.replace(/\?/g, () => JSON.stringify(params[cursor++]));

	const colValue = (name: string): string | number | null => {
		switch (name) {
			case "author_id":
				return row.author_id;
			case "sandboxed_at":
				return row.sandboxed_at;
			case "removed_at":
				return row.removed_at;
			default:
				throw new Error(`agreement oracle: predicate referenced an unmodeled column "${name}"`);
		}
	};

	// Tokenize into columns, literals, operators, parens. Column refs render as
	// `"content"."sandboxed_at"`; string literals as `'x'` (from JSON we get `"x"`).
	const tokens = withParams.match(
		/"[^"]+"\."[^"]+"|"[^"]*"|\bis not null\b|\bis null\b|[()=]|\S+/gi,
	);
	if (tokens === null) throw new Error("agreement oracle: could not tokenize predicate");

	let i = 0;
	const peek = () => tokens[i];
	const next = () => tokens[i++];

	// Grammar (fully parenthesized by drizzle): expr := or ; or := and ("or" and)* ;
	// and := not ("and" not)* ; not := "(" or ")" | comparison
	const parseComparison = (): boolean => {
		const lhs = next() ?? "";
		const colMatch = lhs.match(/^"[^"]+"\."([^"]+)"$/);
		const colName = colMatch?.[1];
		if (colName === undefined) throw new Error(`agreement oracle: expected a column, got "${lhs}"`);
		const col = colValue(colName);
		const op = (peek() ?? "").toLowerCase();
		if (op === "is null") {
			next();
			return col === null;
		}
		if (op === "is not null") {
			next();
			return col !== null;
		}
		if (op === "=") {
			next();
			const litTok = next() ?? "";
			const lit = litTok.startsWith('"') ? JSON.parse(litTok) : litTok;
			return col !== null && String(col) === String(lit);
		}
		throw new Error(`agreement oracle: unexpected operator "${op}"`);
	};

	const parseNot = (): boolean => {
		if (peek() === "(") {
			next();
			const v = parseOr();
			if (next() !== ")") throw new Error("agreement oracle: unbalanced parens");
			return v;
		}
		return parseComparison();
	};

	function parseAnd(): boolean {
		let v = parseNot();
		while ((peek() ?? "").toLowerCase() === "and") {
			next();
			v = parseNot() && v;
		}
		return v;
	}

	function parseOr(): boolean {
		let v = parseAnd();
		while ((peek() ?? "").toLowerCase() === "or") {
			next();
			v = parseAnd() || v;
		}
		return v;
	}

	const result = parseOr();
	if (i !== tokens.length) throw new Error("agreement oracle: trailing tokens after parse");
	return result;
};

// The SQL encoding's verdict for a cell: does `publicLiveWhere` (the removal guard AND
// `sandboxVisibleWhere` — how content reads compose it) admit this row? `undefined` ⇒
// no restriction ⇒ admitted.
const sqlAdmitsRow = (tag: L.LifecycleTag, authorId: string, viewer: L.SandboxViewer): boolean => {
	const where = publicLiveWhere(
		{sandboxedAt: content.sandboxedAt, authorId: content.authorId, removedAt: content.removedAt},
		viewer,
	);
	if (where === undefined) return true;
	return evalPredicate(dialect.sqlToQuery(where), rowForTag(tag, authorId));
};

// The in-memory encoding's verdict for the same cell, rebuilt from the SAME columns.
const inMemoryVisible = (
	tag: L.LifecycleTag,
	authorId: string,
	viewer: L.SandboxViewer,
): boolean => {
	const cols = columnsForTag[tag];
	const lifecycle = L.fromColumns({
		removedAt: cols.removedAt === null ? null : new Date(cols.removedAt),
		removedBy: cols.removedAt === null ? null : "mod-1",
		removedReason: cols.removedAt === null ? null : JSON.stringify({_tag: "AuthorDeletion"}),
		sandboxedAt: cols.sandboxedAt === null ? null : new Date(cols.sandboxedAt),
	});
	return L.isVisibleTo(lifecycle, authorId, viewer);
};

describe("çaylak-sandbox visibility — SQL mirror agrees with isVisibleTo for every lifecycle state (#2013)", () => {
	// Exhaustive over the lifecycle discriminant: a new tag added to `EntityLifecycle`
	// forces a `columnsForTag` entry (compile error otherwise), so it is automatically
	// covered here — the runtime companion to the compile-time single-source.
	const tags = Object.keys(columnsForTag) as L.LifecycleTag[];

	for (const tag of tags) {
		for (const [viewerName, viewer] of Object.entries(viewers)) {
			for (const [ownership, authorId] of [
				["own", AUTHOR],
				["others'", OTHER],
			] as const) {
				it(`${viewerName} · ${ownership} · ${tag}: SQL predicate === isVisibleTo`, () => {
					const expected = inMemoryVisible(tag, authorId, viewer);
					const actual = sqlAdmitsRow(tag, authorId, viewer);
					assert.strictEqual(
						actual,
						expected,
						`SQL admitted=${actual} but isVisibleTo=${expected} for viewer=${viewerName} ownership=${ownership} state=${tag}`,
					);
				});
			}
		}
	}
});
