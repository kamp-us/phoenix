/**
 * moderator-grant unit coverage — the grant core against a real (in-memory) SQLite
 * engine behind the D1 surface (the `@kampus/preview-seed` fake idiom). Proves the
 * grant flips `role`, is selectable by id OR username, reports "no such user"
 * distinctly, and that `listModerators` reads back exactly the granted set.
 */
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {listModerators, makeGrantDb, setRole} from "./grant.ts";
import {makeGrantTestDb, type SqliteD1} from "./sqlite-d1.testing.ts";

let fake: SqliteD1;

const seedUser = (id: string, username: string) =>
	fake.d1
		.prepare(
			"INSERT INTO user (id, email, username, type, role) VALUES (?, ?, ?, 'human', 'member')",
		)
		.bind(id, `${username}@test.local`, username)
		.run();

beforeEach(async () => {
	fake = makeGrantTestDb();
	await seedUser("u-alice", "alice");
	await seedUser("u-bob", "bob");
});

afterEach(() => fake.close());

describe("setRole", () => {
	it("grants moderator by username and listModerators reads it back", async () => {
		const db = makeGrantDb(fake.d1);
		const res = await setRole(db, {by: "username", value: "alice"}, "moderator");
		expect(res.changed).toBe(1);

		const mods = await listModerators(db);
		expect(mods.map((m) => m.username)).toEqual(["alice"]);
		expect(mods[0]?.id).toBe("u-alice");
	});

	it("grants moderator by id", async () => {
		const db = makeGrantDb(fake.d1);
		const res = await setRole(db, {by: "id", value: "u-bob"}, "moderator");
		expect(res.changed).toBe(1);
		const mods = await listModerators(db);
		expect(mods.map((m) => m.id)).toEqual(["u-bob"]);
	});

	it("revoke flips a moderator back to member", async () => {
		const db = makeGrantDb(fake.d1);
		await setRole(db, {by: "username", value: "alice"}, "moderator");
		const revoked = await setRole(db, {by: "username", value: "alice"}, "member");
		expect(revoked.changed).toBe(1);
		expect(await listModerators(db)).toEqual([]);
	});

	it("no matching user → changed 0 (distinct from a successful flip)", async () => {
		const db = makeGrantDb(fake.d1);
		const res = await setRole(db, {by: "username", value: "ghost"}, "moderator");
		expect(res.changed).toBe(0);
		expect(await listModerators(db)).toEqual([]);
	});
});
