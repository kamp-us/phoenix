/**
 * Founder seed I/O against **real remote Cloudflare D1** (ADR 0082 integration tier) —
 * runs the production `seedFounders`/`listFounderTuples` over the shipped REST transport
 * (`makeD1Rest` + `makeSeedDb`, the bin's path) against a per-file isolated, migrated D1
 * (`_d1.ts`, incl. `0010_relation_tuple` + `0011_authorship_tier`), and asserts the
 * seed's real-DB facts:
 *
 *   - the seed promotes the cohort roster to BOTH `moderator` (role + the
 *     `(id, "moderates", key(platform))` tuple) AND `yazar` (the `user.tier`), and
 *     reports `matched`/`promoted`/`inserted`; `listFounderTuples` reads the tuples back;
 *   - a re-run is idempotent — `promoted === 0`, `inserted === 0`, no duplicate tuple;
 *   - a re-run never DOWNGRADES a founder already at moderator/yazar (the row is left
 *     untouched); the guard targets only the ladder tops;
 *   - an id with no `user` row is skipped (no phantom promotion, no orphan tuple);
 *   - an empty cohort reads distinctly: `{cohort: 0, matched: 0, promoted: 0, inserted: 0}`,
 *     writing nothing.
 *
 * These are integration, not unit: each is only-wrong-if-the-DB-differs (does the write
 * actually land, does the changed-count come back, does the re-run no-op on the real PK /
 * guard) — the exact class a faked engine could only fake. The pure statement-building
 * stays in the unit tier (`src/seed.unit.test.ts`).
 *
 * Locally (no Cloudflare creds) the `beforeAll` deploy stops at `Unauthorized` —
 * expected; this tier proves itself on CI's integration job.
 */
import {beforeEach, describe, expect, it} from "vitest";
import {listFounderTuples, seedFounders} from "../../src/seed.ts";
import {seedD1} from "./_d1.ts";

const h = seedD1(import.meta.url);

// Seed users directly over the REST seam (the founder-seed core promotes existing rows
// and mints tuples, never inserts users). All bound columns are non-null — D1's REST
// params is strict string[] and rejects null (#569); the literal columns render inline.
const seedUser = (id: string, role: "member" | "moderator", tier: "çaylak" | "yazar") =>
	h
		.rawDb()
		.prepare("INSERT INTO user (id, email, role, tier) VALUES (?, ?, ?, ?)")
		.bind(id, `${id}@test.local`, role, tier)
		.run();

const readUser = (id: string) =>
	h.rawDb().prepare("SELECT role, tier FROM user WHERE id = ?").bind(id).first<{
		role: string;
		tier: string;
	}>();

// A clean slate each test on the same per-file D1: clear the cohort + any tuples the
// previous test minted, then seed a fresh user set.
beforeEach(async () => {
	const db = h.rawDb();
	await db.prepare("DELETE FROM relation_tuple").run();
	await db.prepare("DELETE FROM user WHERE id IN ('u-alice', 'u-bob', 'u-carol')").run();
});

describe("seedFounders on real D1 — mints the cohort as moderator+yazar", () => {
	it("promotes the roster to moderator+yazar, mints the tuples, and skips an unknown id", async () => {
		await seedUser("u-alice", "member", "çaylak");
		await seedUser("u-bob", "member", "çaylak");
		// u-ghost is in the roster but has no user row → skipped (no orphan tuple)

		const db = h.seedDb();
		const res = await seedFounders(db, ["u-alice", "u-bob", "u-ghost"]);
		expect(res.cohort).toBe(3);
		expect(res.matched).toBe(2);
		expect(res.promoted).toBe(2);
		expect(res.inserted).toBe(2);

		expect(await readUser("u-alice")).toEqual({role: "moderator", tier: "yazar"});
		expect(await readUser("u-bob")).toEqual({role: "moderator", tier: "yazar"});

		const tuples = await listFounderTuples(db);
		const subjects = tuples.map((t) => t.subject).sort();
		expect(subjects).toEqual(["u-alice", "u-bob"]);
		for (const t of tuples) {
			expect(t.relation).toBe("moderates");
			expect(t.object).toBe("platform:platform");
		}
	});

	it("is idempotent — a re-run promotes nothing, mints nothing, never duplicates a tuple", async () => {
		await seedUser("u-alice", "member", "çaylak");
		const db = h.seedDb();
		const cohort = ["u-alice"];

		const first = await seedFounders(db, cohort);
		expect(first.promoted).toBe(1);
		expect(first.inserted).toBe(1);

		const second = await seedFounders(db, cohort);
		expect(second.matched).toBe(1);
		expect(second.promoted).toBe(0); // guard skips the already-seeded row
		expect(second.inserted).toBe(0); // onConflictDoNothing — no dup

		const tuples = await listFounderTuples(db);
		expect(tuples.length).toBe(1);
	});

	it("never downgrades — a founder already moderator+yazar is left untouched", async () => {
		await seedUser("u-alice", "moderator", "yazar");
		const db = h.seedDb();

		const res = await seedFounders(db, ["u-alice"]);
		expect(res.promoted).toBe(0); // nothing to change; never flips moderator/yazar back down

		expect(await readUser("u-alice")).toEqual({role: "moderator", tier: "yazar"});
	});

	it("an empty cohort reads distinctly and writes nothing", async () => {
		await seedUser("u-carol", "member", "çaylak");
		const db = h.seedDb();

		const res = await seedFounders(db, []);
		expect(res).toEqual({cohort: 0, matched: 0, promoted: 0, inserted: 0});

		expect(await readUser("u-carol")).toEqual({role: "member", tier: "çaylak"});
		const tuples = await listFounderTuples(db);
		expect(tuples.length).toBe(0);
	});
});
