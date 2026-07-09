/**
 * `resolveBanState` coverage — the ban-state projection (epic #968). Asserts the
 * latest-event-wins projection over the append-only log: an empty log and an
 * `unban` are not-banned; a permanent `ban` is banned; a `ban` past its expiry
 * self-lifts; an `unban` after a `ban` restores access. The real D1 write→read
 * round-trip (and the session-refusal enforcement) lives in
 * `apps/web/tests/integration/pasaport-ban.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {type BanEvent, NOT_BANNED, resolveBanState} from "./ban.ts";

const at = (iso: string): Date => new Date(iso);
const NOW = at("2026-07-09T12:00:00Z");

const ban = (over: Partial<BanEvent> = {}): BanEvent => ({
	action: "ban",
	reason: "spam",
	expiresAt: null,
	createdAt: at("2026-07-09T10:00:00Z"),
	...over,
});

describe("resolveBanState", () => {
	it("empty log → not banned", () => {
		assert.deepStrictEqual(resolveBanState(null, NOW), NOT_BANNED);
	});

	it("latest event is an unban → not banned", () => {
		const state = resolveBanState(
			{action: "unban", reason: null, expiresAt: null, createdAt: NOW},
			NOW,
		);
		assert.deepStrictEqual(state, NOT_BANNED);
	});

	it("permanent ban (no expiry) → banned, carries the reason", () => {
		const state = resolveBanState(ban({reason: "abuse", expiresAt: null}), NOW);
		assert.isTrue(state.banned);
		assert.strictEqual(state.reason, "abuse");
		assert.isNull(state.expiresAt);
	});

	it("ban with a future expiry → banned until then", () => {
		const expiresAt = at("2026-07-10T12:00:00Z");
		const state = resolveBanState(ban({expiresAt}), NOW);
		assert.isTrue(state.banned);
		assert.strictEqual(state.expiresAt?.getTime(), expiresAt.getTime());
	});

	it("ban whose expiry has elapsed → self-lifts to not banned", () => {
		const state = resolveBanState(ban({expiresAt: at("2026-07-09T11:00:00Z")}), NOW);
		assert.deepStrictEqual(state, NOT_BANNED);
	});

	it("expiry exactly at now → lifted (fail-open on equality)", () => {
		const state = resolveBanState(ban({expiresAt: NOW}), NOW);
		assert.isFalse(state.banned);
	});
});
