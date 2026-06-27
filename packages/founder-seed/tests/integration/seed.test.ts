/**
 * Founder seed I/O against **real remote Cloudflare D1** (ADR 0082 integration tier) —
 * runs the production `seedFounders`/`listFounderTuples` over the shipped REST transport
 * (`makeD1Rest` + `makeSeedDb`, the bin's path) against a per-file isolated, migrated D1
 * (`_d1.ts`, incl. `0010_relation_tuple`), and asserts the seed's real-DB facts:
 *
 *   - the seed mints the `role='moderator'` cohort as `(id, "moderates", key(platform))`
 *     tuples and reports `inserted === founders`; `listFounderTuples` reads exactly
 *     those rows back;
 *   - a re-run is idempotent — `inserted === 0`, no duplicate tuple (the `onConflictDoNothing`
 *     against the composite PK);
 *   - an empty cohort (no moderators) reads distinctly: `{founders: 0, inserted: 0}`,
 *     writing nothing;
 *   - a member (non-moderator) is never minted a founder tuple.
 *
 * These are integration, not unit: each is only-wrong-if-the-DB-differs (does the
 * INSERT actually mint the row, does the changed-count come back, does the re-run no-op
 * on the real PK) — the exact class a faked engine could only fake. The pure
 * statement-building stays in the unit tier (`src/seed.unit.test.ts`).
 *
 * Locally (no Cloudflare creds) the `beforeAll` deploy stops at `Unauthorized` —
 * expected; this tier proves itself on CI's integration job.
 */
import {beforeEach, describe, expect, it} from "vitest";
import {listFounderTuples, seedFounders} from "../../src/seed.ts";
import {seedD1} from "./_d1.ts";

const h = seedD1(import.meta.url);

// Seed users directly over the REST seam (the founder-seed core reads the cohort and
// writes tuples, never inserts users). All bound columns are non-null — D1's REST
// params is strict string[] and rejects null (#569); the literal columns render inline.
const seedUser = (id: string, role: "member" | "moderator") =>
	h
		.rawDb()
		.prepare("INSERT INTO user (id, email, role) VALUES (?, ?, ?)")
		.bind(id, `${id}@test.local`, role)
		.run();

// A clean slate each test on the same per-file D1: clear the cohort + any tuples the
// previous test minted, then seed a fresh user set.
beforeEach(async () => {
	const db = h.rawDb();
	await db.prepare("DELETE FROM relation_tuple").run();
	await db.prepare("DELETE FROM user WHERE id IN ('u-alice', 'u-bob', 'u-carol')").run();
});

describe("seedFounders on real D1 — mints the moderator cohort as platform-moderates tuples", () => {
	it("mints exactly the role='moderator' cohort and reads it back", async () => {
		await seedUser("u-alice", "moderator");
		await seedUser("u-bob", "moderator");
		await seedUser("u-carol", "member"); // a member must NOT be minted

		const db = h.seedDb();
		const res = await seedFounders(db);
		expect(res.founders).toBe(2);
		expect(res.inserted).toBe(2);

		const tuples = await listFounderTuples(db);
		const subjects = tuples.map((t) => t.subject).sort();
		expect(subjects).toEqual(["u-alice", "u-bob"]);
		for (const t of tuples) {
			expect(t.relation).toBe("moderates");
			expect(t.object).toBe("platform:platform");
		}
	});

	it("is idempotent — a re-run mints nothing new and never duplicates a tuple", async () => {
		await seedUser("u-alice", "moderator");
		const db = h.seedDb();

		const first = await seedFounders(db);
		expect(first.inserted).toBe(1);

		const second = await seedFounders(db);
		expect(second.founders).toBe(1);
		expect(second.inserted).toBe(0); // onConflictDoNothing — no dup

		const tuples = await listFounderTuples(db);
		expect(tuples.length).toBe(1);
	});

	it("an empty cohort reads distinctly (founders 0, inserted 0) and writes nothing", async () => {
		await seedUser("u-carol", "member");
		const db = h.seedDb();

		const res = await seedFounders(db);
		expect(res.founders).toBe(0);
		expect(res.inserted).toBe(0);

		const tuples = await listFounderTuples(db);
		expect(tuples.length).toBe(0);
	});
});
