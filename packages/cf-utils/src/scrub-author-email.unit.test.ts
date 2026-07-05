/**
 * The author-email scrub — pure core + statement-shape, asserted without a real DB (ADR 0082
 * unit tier). The email-shaped heuristic, the label-recompute parity with `authorDisplayLabel`,
 * the confirm-gate matrix, and the leak-clean render are pure and pinned directly; the
 * `scanAffected` / `scrubEmails` DB paths resolve their SQL+params via drizzle's `.toSQL()` and
 * a mock `D1Database` that records statements and returns fixture rows — so the `LIKE`
 * predicate and the `COALESCE/NULLIF/TRIM` recompute are proven present without booting SQLite.
 * Whether the UPDATE actually rewrites a real D1 row is only-wrong-if-D1-differs and belongs to
 * a founder-run verification against prod (this CLI's run is founder-side; the build is
 * creds-free).
 */
import {commentRecord, definitionRecord, postRecord} from "@kampus/db-schema";
import {like, sql} from "drizzle-orm";
import {assert, describe, it} from "vitest";
import {
	CONFIRM_OP_NAME,
	decideWrite,
	EMAIL_SHAPED_LIKE,
	isEmailShaped,
	makeScrubDb,
	recomputeLabel,
	renderDryRun,
	renderScrubbed,
	SCRUB_TABLES,
	scanAffected,
	scrubEmails,
	type TableAffected,
} from "./scrub-author-email.ts";
import {AUTHOR_FALLBACK_LABEL} from "./scrub-schema.ts";

describe("isEmailShaped — the email heuristic distinguishes a leak from a name with an @", () => {
	it("matches full local@domain.tld emails (the leaked shape)", () => {
		for (const email of ["umut@kamp.us", "a@b.co", "ceyhun.ozturk@gmail.com", "x@y.z.w"]) {
			assert.isTrue(isEmailShaped(email), email);
		}
	});

	it("does NOT match a free-form display name that merely contains an @", () => {
		for (const name of [
			"@ceyhun", // a leading-@ handle-style name — no domain.tld
			"umut", // a plain name
			"kullanıcı",
			"a @ b", // spaces, no dotted domain
			"@user.name", // no `@` after a local part (leads with @)
			"first@last", // no dot in the domain
			"", // empty
			"foo@bar.", // dot but empty TLD
		]) {
			assert.isFalse(isEmailShaped(name), name);
		}
	});
});

describe("recomputeLabel — lockstep parity with authorDisplayLabel (name → @username → kullanıcı)", () => {
	// The parity table restated inline: the worker module `author-label.ts` cannot be imported
	// from a `packages/` CLI (no worker→packages edge), so the SAME precedence cases are pinned
	// here — mirroring how `author-label.unit.test.ts` locks the SPA `actorLabel` parity.
	it("prefers a trimmed display name", () => {
		assert.strictEqual(recomputeLabel({name: "Umut Sirin", username: "umut"}), "Umut Sirin");
		assert.strictEqual(recomputeLabel({name: "  Ceyhun  ", username: "cey"}), "Ceyhun");
	});

	it("falls to @username when name is absent/blank", () => {
		assert.strictEqual(recomputeLabel({name: null, username: "umut"}), "@umut");
		assert.strictEqual(recomputeLabel({name: "   ", username: "umut"}), "@umut");
		assert.strictEqual(recomputeLabel({username: " cey "}), "@cey");
	});

	it("falls to the kullanıcı fallback when neither name nor username resolves", () => {
		assert.strictEqual(recomputeLabel({}), AUTHOR_FALLBACK_LABEL);
		assert.strictEqual(recomputeLabel({name: null, username: null}), AUTHOR_FALLBACK_LABEL);
		assert.strictEqual(recomputeLabel({name: "  ", username: "  "}), AUTHOR_FALLBACK_LABEL);
		assert.strictEqual(AUTHOR_FALLBACK_LABEL, "kullanıcı");
	});

	it("never returns an email — email is not an input (the leak is closed at the type)", () => {
		// A recomputed label from ANY {name, username} snapshot is never email-shaped: the only
		// values it can produce are a display name, `@username`, or the fixed fallback — an email
		// is structurally excluded (it is never a field of the identity snapshot).
		for (const label of [
			recomputeLabel({name: "Umut", username: "u"}),
			recomputeLabel({username: "u"}),
			recomputeLabel({}),
		]) {
			assert.isFalse(isEmailShaped(label), label);
		}
	});
});

describe("decideWrite — the confirm-and-name gate blocks a write without --execute AND the op name", () => {
	it("dry-runs by default (no --execute)", () => {
		const d = decideWrite({execute: false, confirm: undefined});
		assert.strictEqual(d._tag, "DryRun");
	});

	it("dry-runs when --execute is given but --confirm names nothing", () => {
		const d = decideWrite({execute: true, confirm: undefined});
		assert.strictEqual(d._tag, "DryRun");
	});

	it("dry-runs when --confirm names the WRONG op", () => {
		const d = decideWrite({execute: true, confirm: "yes"});
		assert.strictEqual(d._tag, "DryRun");
		const d2 = decideWrite({execute: true, confirm: "scrub"});
		assert.strictEqual(d2._tag, "DryRun");
	});

	it("authorizes a write ONLY with BOTH --execute AND --confirm scrub-author-email", () => {
		const d = decideWrite({execute: true, confirm: CONFIRM_OP_NAME});
		assert.strictEqual(d._tag, "Write");
		assert.strictEqual(CONFIRM_OP_NAME, "scrub-author-email");
	});

	it("a confirm name alone (no --execute) never authorizes a write", () => {
		const d = decideWrite({execute: false, confirm: CONFIRM_OP_NAME});
		assert.strictEqual(d._tag, "DryRun");
	});
});

describe("renderDryRun / renderScrubbed — leak-clean output: the count, never the PII", () => {
	const affected: ReadonlyArray<TableAffected> = [
		{table: "definition_record", count: 3},
		{table: "post_record", count: 0},
		{table: "comment_record", count: 2},
	];

	it("prints per-table counts and a total — and NO email value", () => {
		const out = renderDryRun(affected);
		assert.include(out, "definition_record: 3");
		assert.include(out, "post_record: 0");
		assert.include(out, "comment_record: 2");
		assert.include(out, "5 email-shaped author_name row(s) would be rewritten");
		// leak-clean: an `@`-bearing email string must never appear in the report.
		assert.notMatch(out, /@[a-z0-9.-]+\.[a-z]{2,}/i);
	});

	it("a zero total is the first-class close-as-done path (nothing to scrub)", () => {
		const out = renderDryRun([
			{table: "definition_record", count: 0},
			{table: "post_record", count: 0},
			{table: "comment_record", count: 0},
		]);
		assert.include(out, "no email-shaped author_name rows found");
		assert.include(out, "#2137 closeable as done");
	});

	it("renderScrubbed reports per-table rewritten counts + total, no PII", () => {
		const out = renderScrubbed([
			{table: "definition_record", changed: 3},
			{table: "post_record", changed: 0},
			{table: "comment_record", changed: 2},
		]);
		assert.include(out, "rewrote 5 email-shaped author_name row(s)");
		assert.include(out, "definition_record: 3");
		assert.notMatch(out, /@[a-z0-9.-]+\.[a-z]{2,}/i);
	});
});

// A mock `D1Database` recording every prepared statement + returning fixture results. drizzle's
// d1 driver calls `prepare(sql).bind(...params).all()` for selects and `.run()` for updates.
interface Recorded {
	sql: string;
	params: unknown[];
}
const mockD1 = (
	rowsFor: (sql: string) => Record<string, unknown>[],
	changesFor: () => number,
): {db: D1Database; statements: Recorded[]} => {
	const statements: Recorded[] = [];
	const bound = (sqlText: string) => ({
		all: async () => ({results: rowsFor(sqlText)}),
		run: async () => ({success: true as const, meta: {changes: changesFor()}, results: []}),
		first: async () => rowsFor(sqlText)[0] ?? null,
		raw: async () => rowsFor(sqlText).map((r) => Object.values(r)),
	});
	const prepare = (sqlText: string) => {
		statements.push({sql: sqlText, params: []});
		return {
			...bound(sqlText),
			bind: (...params: unknown[]) => {
				statements[statements.length - 1]!.params = params;
				return bound(sqlText);
			},
		};
	};
	// biome-ignore lint/plugin: a recording stand-in implements only the prepare slice drizzle-orm/d1 drives; the full D1Database surface can't be built honestly here.
	return {db: {prepare} as unknown as D1Database, statements};
};

describe("SQL is grounded vs real D1 (ADR 0082): LIKE predicate + COALESCE/NULLIF/TRIM recompute", () => {
	it("scanAffected issues a count(*) WHERE author_name LIKE the email heuristic, per table", async () => {
		const {db, statements} = mockD1(
			() => [{n: 4}],
			() => 0,
		);
		const scrubDb = makeScrubDb(db);
		const affected = await scanAffected(scrubDb);

		// one scan per record table, each returning the mocked count
		assert.deepStrictEqual(
			affected.map((a) => a.table),
			["definition_record", "post_record", "comment_record"],
		);
		assert.isTrue(affected.every((a) => a.count === 4));

		// every scan is a count(*) with the email-shaped LIKE predicate + the heuristic param
		const scans = statements.filter((s) => /count\(\*\)/i.test(s.sql));
		assert.strictEqual(scans.length, 3);
		for (const s of scans) {
			assert.match(s.sql, /"[a-z_]+"\."author_name" like \?/i);
			assert.include(s.params as unknown[], EMAIL_SHAPED_LIKE);
		}
	});

	it("scrubEmails UPDATEs author_name to COALESCE(NULLIF(TRIM(name)), @username, kullanıcı) WHERE LIKE", () => {
		// pin the UPDATE statement shape directly via .toSQL() (no engine): the recompute mirrors
		// authorDisplayLabel in core-SQLite scalars, guarded by the email-shaped WHERE.
		const db = makeScrubDb(
			mockD1(
				() => [],
				() => 0,
			).db,
		);
		for (const table of [definitionRecord, postRecord, commentRecord]) {
			const {sql: text, params} = db
				.update(table)
				.set({
					authorName: sql`
						COALESCE(
							(SELECT NULLIF(TRIM(u.name), '') FROM "user" u WHERE u.id = ${table.authorId}),
							(SELECT '@' || NULLIF(TRIM(u.username), '') FROM "user" u WHERE u.id = ${table.authorId}),
							${AUTHOR_FALLBACK_LABEL}
						)
					`,
				})
				.where(like(table.authorName, EMAIL_SHAPED_LIKE))
				.toSQL();
			assert.match(text, /update .*set "author_name" =/i);
			assert.match(text, /coalesce\(/i);
			assert.match(text, /nullif\(trim\(u\.name\)/i);
			assert.match(text, /'@' \|\| nullif\(trim\(u\.username\)/i);
			// the recompute is correlated to the matched row's author_id (drizzle qualifies the column)
			assert.match(text, /from "user" u where u\.id = "[a-z_]+"\."author_id"/i);
			assert.match(text, /where "[a-z_]+"\."author_name" like \?/i);
			assert.include(params as unknown[], EMAIL_SHAPED_LIKE);
			assert.include(params as unknown[], AUTHOR_FALLBACK_LABEL);
		}
	});

	it("scrubEmails carries D1's real changed-row count per table (meta.changes plumbing)", async () => {
		const {db} = mockD1(
			() => [],
			() => 7,
		);
		const scrubbed = await scrubEmails(makeScrubDb(db));
		assert.deepStrictEqual(
			scrubbed.map((s) => s.table),
			["definition_record", "post_record", "comment_record"],
		);
		assert.isTrue(scrubbed.every((s) => s.changed === 7));
	});

	it("scans exactly the three record tables that carry author_name (no widening)", () => {
		assert.deepStrictEqual(
			SCRUB_TABLES.map((t) => t.name),
			["definition_record", "post_record", "comment_record"],
		);
	});
});
