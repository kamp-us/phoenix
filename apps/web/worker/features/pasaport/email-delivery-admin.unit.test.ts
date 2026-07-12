/**
 * `selectFailingAddresses` — the pure admin failing-address roll-up (Child #2692, epic
 * #2687). Latest-event-per-address wins, reusing `resolveEmailDeliveryState`: an address
 * whose newest event is a `fail` is failing; a later `clear` lifts it; a `fail` on a
 * DIFFERENT address is independent. No I/O, driven over hand-built log rows.
 */
import {assert, describe, it} from "@effect/vitest";
import {type EmailDeliveryEventRow, selectFailingAddresses} from "./email-delivery.ts";

const NOW = new Date("2026-01-01T00:00:00Z");

const row = (
	id: string,
	address: string,
	userId: string | null,
	action: EmailDeliveryEventRow["action"],
	reason: string | null,
	createdAt: string,
): EmailDeliveryEventRow => ({id, address, userId, action, reason, createdAt: new Date(createdAt)});

describe("selectFailingAddresses", () => {
	it("no events → no failing addresses", () => {
		assert.deepStrictEqual(selectFailingAddresses([], NOW), []);
	});

	it("an address whose latest event is a fail is included, carrying its reason", () => {
		const rows = [
			row("1", "a@x.co", "u-a", "fail", "550 mailbox unavailable", "2025-12-31T12:00:00Z"),
		];
		assert.deepStrictEqual(selectFailingAddresses(rows, NOW), [
			{
				address: "a@x.co",
				userId: "u-a",
				reason: "550 mailbox unavailable",
				since: new Date("2025-12-31T12:00:00Z"),
			},
		]);
	});

	it("a clear newer than the fail lifts the address (latest-event-wins) — excluded", () => {
		const rows = [
			row("1", "a@x.co", "u-a", "fail", "bounce", "2025-12-31T12:00:00Z"),
			row("2", "a@x.co", "u-a", "clear", null, "2025-12-31T18:00:00Z"),
		];
		assert.deepStrictEqual(selectFailingAddresses(rows, NOW), []);
	});

	it("a re-fail after a clear brings the address back (newest event decides)", () => {
		const rows = [
			row("1", "a@x.co", "u-a", "fail", "first", "2025-12-30T00:00:00Z"),
			row("2", "a@x.co", "u-a", "clear", null, "2025-12-31T00:00:00Z"),
			row("3", "a@x.co", "u-a", "fail", "again", "2025-12-31T12:00:00Z"),
		];
		const failing = selectFailingAddresses(rows, NOW);
		assert.strictEqual(failing.length, 1);
		assert.strictEqual(failing[0]?.reason, "again");
		assert.deepStrictEqual(failing[0]?.since, new Date("2025-12-31T12:00:00Z"));
	});

	it("each address is projected independently, newest-failing first", () => {
		const rows = [
			row("1", "a@x.co", "u-a", "fail", "a-reason", "2025-12-31T06:00:00Z"),
			row("2", "b@x.co", null, "fail", "b-reason", "2025-12-31T12:00:00Z"),
			row("3", "c@x.co", "u-c", "clear", null, "2025-12-31T09:00:00Z"),
		];
		const failing = selectFailingAddresses(rows, NOW);
		// b (12:00) then a (06:00); c's latest is a clear → excluded.
		assert.deepStrictEqual(
			failing.map((f) => f.address),
			["b@x.co", "a@x.co"],
		);
		// a null userId (a send to an address with no account row) is preserved.
		assert.strictEqual(failing[0]?.userId, null);
	});

	it("breaks a same-instant tie by id, so the latest event is deterministic", () => {
		const at = "2025-12-31T12:00:00Z";
		const rows = [
			row("id-1", "a@x.co", "u-a", "fail", "older-write", at),
			row("id-2", "a@x.co", "u-a", "clear", null, at),
		];
		// id-2 > id-1 at the same timestamp ⇒ the clear is the latest ⇒ excluded.
		assert.deepStrictEqual(selectFailingAddresses(rows, NOW), []);
	});
});
