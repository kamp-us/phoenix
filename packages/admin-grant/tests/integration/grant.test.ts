/**
 * Grant I/O against **real remote Cloudflare D1** (ADR 0082 integration tier) — runs
 * the production `assignAdmin`/`revokeAdmin`/`listAdmins` over the shipped REST
 * transport (`makeD1Rest` + `makeGrantDb`, the bin's path) against a per-file isolated,
 * migrated D1 (`_d1.ts`), and asserts the grant's real-DB facts:
 *
 *   - the grant mints `(subject, "admin", "platform:platform")` selected by username,
 *     and `listAdmins` reads exactly that subject back;
 *   - the grant is also selectable by id (the alternate selector);
 *   - the grant is idempotent — a re-run mints nothing (`inserted: 0`);
 *   - revoke drops the tuple (drops the subject from the list);
 *   - a non-matching selector yields `subject: null` (distinct from a real grant) and
 *     writes nothing.
 *
 * These are integration, not unit: each is only-wrong-if-the-DB-differs (does the
 * INSERT actually land the tuple, does the username resolve, does the read round-trip)
 * — the exact class a faked engine could only fake. The pure statement-building +
 * key-encoding contract stay in the unit tier (`src/grant.unit.test.ts`).
 *
 * Locally (no Cloudflare creds) the `beforeAll` deploy stops at `Unauthorized` —
 * expected; this tier proves itself on CI's integration job.
 */
import {beforeEach, describe, expect, it} from "vitest";
import {assignAdmin, listAdmins, revokeAdmin} from "../../src/grant.ts";
import {adminD1} from "./_d1.ts";

const h = adminD1(import.meta.url);

// Seed two users directly over the REST seam (the grant core only writes relation
// tuples, never user rows). All bound columns are non-null — D1's REST params is
// strict string[] and rejects null (#569).
const seedUser = (id: string, username: string) =>
	h
		.rawDb()
		.prepare("INSERT INTO user (id, email, username, type) VALUES (?, ?, ?, 'human')")
		.bind(id, `${username}@test.local`, username)
		.run();

// A fresh pair each test, on the same per-file D1 — reset the two users + their admin
// tuples (a clean slate without tearing the stage down).
beforeEach(async () => {
	const db = h.rawDb();
	await db.prepare("DELETE FROM relation_tuple WHERE subject IN ('u-alice', 'u-bob')").run();
	await db.prepare("DELETE FROM user WHERE id IN ('u-alice', 'u-bob')").run();
	await seedUser("u-alice", "alice");
	await seedUser("u-bob", "bob");
});

describe("assignAdmin on real D1 — grant/revoke the admin relation tuple", () => {
	it("grants admin by username and listAdmins reads it back", async () => {
		const db = h.grantDb();
		const res = await assignAdmin(db, {by: "username", value: "alice"});
		expect(res.subject).toBe("u-alice");
		expect(res.inserted).toBe(1);

		const admins = await listAdmins(db);
		expect(admins.some((a) => a.subject === "u-alice")).toBe(true);
	});

	it("grants admin by id (the alternate selector)", async () => {
		const db = h.grantDb();
		const res = await assignAdmin(db, {by: "id", value: "u-bob"});
		expect(res.subject).toBe("u-bob");
		expect(res.inserted).toBe(1);
		const admins = await listAdmins(db);
		expect(admins.some((a) => a.subject === "u-bob")).toBe(true);
	});

	it("is idempotent — a re-grant mints nothing (inserted 0)", async () => {
		const db = h.grantDb();
		await assignAdmin(db, {by: "username", value: "alice"});
		const again = await assignAdmin(db, {by: "username", value: "alice"});
		expect(again.subject).toBe("u-alice");
		expect(again.inserted).toBe(0);
		const admins = await listAdmins(db);
		expect(admins.filter((a) => a.subject === "u-alice").length).toBe(1);
	});

	it("revoke drops the tuple (drops the subject from the list)", async () => {
		const db = h.grantDb();
		await assignAdmin(db, {by: "username", value: "alice"});
		const revoked = await revokeAdmin(db, {by: "username", value: "alice"});
		expect(revoked.subject).toBe("u-alice");
		expect(revoked.removed).toBe(1);
		const admins = await listAdmins(db);
		expect(admins.some((a) => a.subject === "u-alice")).toBe(false);
	});

	it("no matching user → subject null (distinct from a real grant), writes nothing", async () => {
		const db = h.grantDb();
		const before = await listAdmins(db);
		const res = await assignAdmin(db, {by: "username", value: "ghost"});
		expect(res.subject).toBe(null);
		expect(res.inserted).toBe(0);
		const after = await listAdmins(db);
		expect(after.length).toBe(before.length);
	});
});
