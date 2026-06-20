/**
 * Grant I/O against **real remote Cloudflare D1** (ADR 0082 integration tier) — runs
 * the production `setRole`/`listModerators` over the shipped REST transport
 * (`makeD1Rest` + `makeGrantDb`, the bin's path) against a per-file isolated, migrated
 * D1 (`_d1.ts`), and asserts the grant's real-DB facts:
 *
 *   - the grant flips `user.role` to `moderator` selected by username, and
 *     `listModerators` reads exactly that row back;
 *   - the grant is also selectable by id (the alternate selector);
 *   - revoke flips a moderator back to `member` (drops it from the list);
 *   - a non-matching selector yields `changed: 0` — distinct from a successful flip —
 *     and writes nothing.
 *
 * These are integration, not unit: each is only-wrong-if-the-DB-differs (does the
 * UPDATE actually match the row, does the changed-count come back, does the read
 * round-trip the role) — the exact class the `node:sqlite` fake could only fake. The
 * pure statement-building + REST-wire contract stay in the unit tier (`src/*.unit.test.ts`).
 *
 * Locally (no Cloudflare creds) the `beforeAll` deploy stops at `Unauthorized` —
 * expected; this tier proves itself on CI's integration job.
 */
import {beforeEach, describe, expect, it} from "vitest";
import {listModerators, setRole} from "../../src/grant.ts";
import {grantD1} from "./_d1.ts";

const h = grantD1(import.meta.url);

// Seed two members directly over the REST seam (the grant core only UPDATEs, never
// inserts). All bound columns are non-null — D1's REST params is strict string[] and
// rejects null (#569); the literal 'human'/'member' columns are rendered inline.
const seedUser = (id: string, username: string) =>
	h
		.rawDb()
		.prepare(
			"INSERT INTO user (id, email, username, type, role) VALUES (?, ?, ?, 'human', 'member')",
		)
		.bind(id, `${username}@test.local`, username)
		.run();

// A fresh pair each test, on the same per-file D1 — usernames are unique, so each test
// resets the two rows it touches (a clean slate without tearing the stage down).
beforeEach(async () => {
	const db = h.rawDb();
	await db.prepare("DELETE FROM user WHERE id IN ('u-alice', 'u-bob')").run();
	await seedUser("u-alice", "alice");
	await seedUser("u-bob", "bob");
});

describe("setRole on real D1 — grant/revoke flips user.role", () => {
	it("grants moderator by username and listModerators reads it back", async () => {
		const db = h.grantDb();
		const res = await setRole(db, {by: "username", value: "alice"}, "moderator");
		expect(res.changed).toBe(1);

		const mods = await listModerators(db);
		const aliceRow = mods.find((m) => m.id === "u-alice");
		expect(aliceRow?.username).toBe("alice");
	});

	it("grants moderator by id (the alternate selector)", async () => {
		const db = h.grantDb();
		const res = await setRole(db, {by: "id", value: "u-bob"}, "moderator");
		expect(res.changed).toBe(1);
		const mods = await listModerators(db);
		expect(mods.some((m) => m.id === "u-bob")).toBe(true);
	});

	it("revoke flips a moderator back to member (drops from the list)", async () => {
		const db = h.grantDb();
		await setRole(db, {by: "username", value: "alice"}, "moderator");
		const revoked = await setRole(db, {by: "username", value: "alice"}, "member");
		expect(revoked.changed).toBe(1);
		const mods = await listModerators(db);
		expect(mods.some((m) => m.id === "u-alice")).toBe(false);
	});

	it("no matching user → changed 0 (distinct from a successful flip), writes nothing", async () => {
		const db = h.grantDb();
		const before = await listModerators(db);
		const res = await setRole(db, {by: "username", value: "ghost"}, "moderator");
		expect(res.changed).toBe(0);
		const after = await listModerators(db);
		expect(after.length).toBe(before.length);
	});
});
