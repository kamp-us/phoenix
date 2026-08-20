/**
 * The cross-encoding AGREEMENT oracle (#2013): the çaylak-sandbox visibility boundary
 * is encoded twice — in-memory (`EntityLifecycle.isVisibleTo`) and as SQL
 * (`SandboxVisibility.sandboxVisibleWhere`). They must agree for EVERY lifecycle state.
 *
 * ADR 0082 bans a faked in-process SQL engine at the unit tier, so this does NOT
 * execute SQL: it evaluates the drizzle predicate against a row with a small,
 * rule-agnostic interpreter over exactly the operators these predicates emit
 * (`IS NULL` / `IS NOT NULL` / `=` / `AND` / `OR`), read off drizzle's compiled
 * `{sql, params}`. Row-level filtering against real D1 is the integration tier's job.
 */
import {assert, describe, it} from "@effect/vitest";
import {integer, SQLiteDialect, sqliteTable, text} from "drizzle-orm/sqlite-core";
import * as L from "./EntityLifecycle.ts";
import {publicLiveWhere} from "./SandboxVisibility.ts";

// A throwaway drizzle table, only so `publicLiveWhere` renders to `{sql, params}`
// with stable column names.
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

interface Row {
	readonly author_id: string;
	readonly sandboxed_at: number | null;
	readonly removed_at: number | null;
}

// Exhaustive over `LifecycleTag` (a `Record`, so a new tag is a compile error here).
// The in-memory value is rebuilt from these same columns, so both encodings see one input.
const columnsForTag: Record<
	L.LifecycleTag,
	{sandboxedAt: number | null; removedAt: number | null}
> = {
	Live: {sandboxedAt: null, removedAt: null},
	Sandboxed: {sandboxedAt: at, removedAt: null},
	Removed: {sandboxedAt: null, removedAt: at},
};

const viewers = {
	caylakAuthor: {viewerId: AUTHOR, canSeeSandboxed: false, seesSandboxedInPlace: false},
	yazar: {viewerId: "a-yazar", canSeeSandboxed: false, seesSandboxedInPlace: false},
	moderator: {viewerId: "a-mod", canSeeSandboxed: true, seesSandboxedInPlace: false},
	otherMember: {viewerId: OTHER, canSeeSandboxed: false, seesSandboxedInPlace: false},
	anonymous: L.anonymousViewer,
	// The #6423 third class: the two encodings must agree for it in every cell too,
	// including that it is still shut out of `Removed`.
	inPlaceYazar: {viewerId: "opted-in-yazar", canSeeSandboxed: false, seesSandboxedInPlace: true},
} satisfies Record<string, L.SandboxViewer>;

const rowForTag = (tag: L.LifecycleTag, authorId: string): Row => {
	const cols = columnsForTag[tag];
	return {author_id: authorId, sandboxed_at: cols.sandboxedAt, removed_at: cols.removedAt};
};

/**
 * A rule-AGNOSTIC evaluator of the compiled drizzle predicate against a `Row`, over
 * exactly the operators `publicLiveWhere` emits. SQL three-valued logic where it can
 * differ from JS: `col = value` is false when the column is null, matching SQLite.
 * Interpreting what drizzle rendered — rather than re-encoding the rule by hand — is
 * what keeps the agreement non-circular.
 */
const evalPredicate = (rendered: {sql: string; params: unknown[]}, row: Row): boolean => {
	let cursor = 0;
	const params = rendered.params;
	// Unique sentinels make tokenizing unambiguous.
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

	// Column refs render as `"content"."sandboxed_at"`; string literals as `'x'`.
	const tokens = withParams.match(
		/"[^"]+"\."[^"]+"|"[^"]*"|\bis not null\b|\bis null\b|[()=]|\S+/gi,
	);
	if (tokens === null) throw new Error("agreement oracle: could not tokenize predicate");

	let i = 0;
	const peek = () => tokens[i];
	const next = () => tokens[i++];

	// Grammar (drizzle fully parenthesizes): expr := or ; or := and ("or" and)* ;
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

// The SQL encoding's verdict for a cell. `undefined` ⇒ no restriction ⇒ admitted.
const sqlAdmitsRow = (tag: L.LifecycleTag, authorId: string, viewer: L.SandboxViewer): boolean => {
	const where = publicLiveWhere(
		{sandboxedAt: content.sandboxedAt, authorId: content.authorId, removedAt: content.removedAt},
		viewer,
	);
	if (where === undefined) return true;
	return evalPredicate(dialect.sqlToQuery(where), rowForTag(tag, authorId));
};

// The in-memory verdict for the same cell, rebuilt from the SAME columns.
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
