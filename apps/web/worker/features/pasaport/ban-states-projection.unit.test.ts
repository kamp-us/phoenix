/**
 * `selectBanStates` — the batched ban-state projection (#3200), the roster's join. Latest
 * event-per-user wins (by `createdAt`, tie-broken by `id`), reusing `resolveBanState`: a
 * user whose newest event is a `ban` is banned; a later `unban` lifts it; an expired ban
 * self-lifts; a user with no event is absent (read as not-banned). No I/O, over hand-built
 * rows — the twin of `email-delivery-admin.unit.test.ts`'s `selectFailingAddresses`.
 */
import {assert, describe, it} from "@effect/vitest";
import {selectBanStates, type UserBanEvent} from "./ban.ts";

const NOW = new Date("2026-07-09T12:00:00Z");

const event = (
	id: string,
	userId: string,
	action: UserBanEvent["action"],
	createdAt: string,
	over: Partial<UserBanEvent> = {},
): UserBanEvent => ({
	id,
	userId,
	action,
	reason: action === "ban" ? "spam" : null,
	expiresAt: null,
	createdAt: new Date(createdAt),
	...over,
});

describe("selectBanStates", () => {
	it("no events → empty map", () => {
		assert.strictEqual(selectBanStates([], NOW).size, 0);
	});

	it("a user whose latest event is a ban is banned, carrying its reason", () => {
		const states = selectBanStates([event("1", "u-a", "ban", "2026-07-09T10:00:00Z")], NOW);
		assert.deepStrictEqual(states.get("u-a"), {banned: true, reason: "spam", expiresAt: null});
	});

	it("an unban newer than the ban lifts it (latest-event-wins)", () => {
		const states = selectBanStates(
			[
				event("1", "u-a", "ban", "2026-07-09T10:00:00Z"),
				event("2", "u-a", "unban", "2026-07-09T11:00:00Z"),
			],
			NOW,
		);
		assert.strictEqual(states.get("u-a")?.banned, false);
	});

	it("an expired ban self-lifts at `now`", () => {
		const states = selectBanStates(
			[
				event("1", "u-a", "ban", "2026-07-09T10:00:00Z", {
					expiresAt: new Date("2026-07-09T11:00:00Z"),
				}),
			],
			NOW,
		);
		assert.strictEqual(states.get("u-a")?.banned, false);
	});

	it("each user is projected independently", () => {
		const states = selectBanStates(
			[
				event("1", "u-a", "ban", "2026-07-09T10:00:00Z"),
				event("2", "u-b", "unban", "2026-07-09T10:00:00Z"),
			],
			NOW,
		);
		assert.strictEqual(states.get("u-a")?.banned, true);
		assert.strictEqual(states.get("u-b")?.banned, false);
	});

	it("breaks a same-instant tie by id, so the latest event is deterministic", () => {
		const at = "2026-07-09T10:00:00Z";
		const states = selectBanStates(
			[event("id-1", "u-a", "ban", at), event("id-2", "u-a", "unban", at)],
			NOW,
		);
		// id-2 > id-1 at the same timestamp ⇒ the unban is the latest ⇒ not banned.
		assert.strictEqual(states.get("u-a")?.banned, false);
	});
});
