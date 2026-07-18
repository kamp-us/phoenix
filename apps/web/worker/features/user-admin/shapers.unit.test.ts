/**
 * `user-admin/shapers` coverage (#3200) — the pure wire-shaping: the relation-sourced role
 * decision, the epoch-millis `createdAt` conversion, and the row assembly. DOM-free.
 */
import {assert, describe, it} from "@effect/vitest";
import type {AdminUserRow} from "../pasaport/Pasaport.ts";
import {createdAtMillis, roleOf, toUserAdminRow} from "./shapers.ts";

const row: AdminUserRow = {
	id: "u1",
	username: "kanka",
	email: "kanka@test.local",
	tier: "yazar",
	createdAt: new Date("2026-01-02T03:04:05Z"),
};

describe("roleOf", () => {
	it("a moderates-tuple holder is moderator", () => {
		assert.strictEqual(roleOf(true), "moderator");
	});
	it("a non-holder is member (never the retired column)", () => {
		assert.strictEqual(roleOf(false), "member");
	});
});

describe("createdAtMillis", () => {
	it("converts a Date to epoch millis", () => {
		assert.strictEqual(
			createdAtMillis(new Date("2026-01-02T03:04:05Z")),
			Date.UTC(2026, 0, 2, 3, 4, 5),
		);
	});
	it("a null column (pre-column cohort) reads 0", () => {
		assert.strictEqual(createdAtMillis(null), 0);
	});
});

describe("toUserAdminRow", () => {
	it("assembles the wire entity, joining banned + role and stamping the discriminant", () => {
		assert.deepStrictEqual(toUserAdminRow(row, {banned: true, isModerator: true}), {
			__typename: "UserAdmin",
			id: "u1",
			username: "kanka",
			email: "kanka@test.local",
			role: "moderator",
			banned: true,
			tier: "yazar",
			createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
		});
	});

	it("a not-banned non-moderator reads member + aktif standing", () => {
		const node = toUserAdminRow({...row, username: null}, {banned: false, isModerator: false});
		assert.strictEqual(node.role, "member");
		assert.strictEqual(node.banned, false);
		assert.strictEqual(node.username, null);
	});
});
