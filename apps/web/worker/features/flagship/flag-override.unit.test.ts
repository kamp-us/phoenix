/**
 * The runtime flag-override projection (#2741) — latest-event-wins, mirroring
 * `resolveBanState` / `resolveEmailDeliveryState`. `resolveFlagOverride` reads the single
 * newest event; `selectActiveOverrides` rolls the full log up to the active map. No I/O,
 * driven over hand-built rows.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type FlagOverrideEventRow,
	resolveFlagOverride,
	selectActiveOverrides,
} from "./flag-override.ts";

const row = (
	id: string,
	flagKey: string,
	action: FlagOverrideEventRow["action"],
	createdAt: string,
): FlagOverrideEventRow => ({id, flagKey, action, createdAt: new Date(createdAt)});

describe("resolveFlagOverride", () => {
	it("no events → undefined (no override, read the real evaluation)", () => {
		assert.strictEqual(resolveFlagOverride(null), undefined);
	});

	it("latest `on` → true; latest `off` → false (the forced effective value)", () => {
		assert.strictEqual(resolveFlagOverride({action: "on", createdAt: new Date()}), true);
		assert.strictEqual(resolveFlagOverride({action: "off", createdAt: new Date()}), false);
	});

	it("latest `clear` → undefined (a clear lifts the override, distinct from forced-false)", () => {
		assert.strictEqual(resolveFlagOverride({action: "clear", createdAt: new Date()}), undefined);
	});
});

describe("selectActiveOverrides", () => {
	it("no events → empty map", () => {
		assert.strictEqual(selectActiveOverrides([]).size, 0);
	});

	it("a key whose latest event is on/off is in the map with the forced value", () => {
		const active = selectActiveOverrides([
			row("1", "phoenix-reactions", "on", "2026-01-01T00:00:00Z"),
		]);
		assert.strictEqual(active.get("phoenix-reactions"), true);
	});

	it("a clear newer than the force lifts the key (latest-event-wins) — absent from the map", () => {
		const active = selectActiveOverrides([
			row("1", "phoenix-reactions", "on", "2026-01-01T00:00:00Z"),
			row("2", "phoenix-reactions", "clear", "2026-01-02T00:00:00Z"),
		]);
		assert.strictEqual(active.has("phoenix-reactions"), false);
	});

	it("a re-force after a clear brings the key back (newest event decides)", () => {
		const active = selectActiveOverrides([
			row("1", "phoenix-reactions", "on", "2026-01-01T00:00:00Z"),
			row("2", "phoenix-reactions", "clear", "2026-01-02T00:00:00Z"),
			row("3", "phoenix-reactions", "off", "2026-01-03T00:00:00Z"),
		]);
		assert.strictEqual(active.get("phoenix-reactions"), false);
	});

	it("each key is projected independently", () => {
		const active = selectActiveOverrides([
			row("1", "phoenix-reactions", "on", "2026-01-01T06:00:00Z"),
			row("2", "phoenix-user-ban", "off", "2026-01-01T12:00:00Z"),
			row("3", "phoenix-mod-queue", "clear", "2026-01-01T09:00:00Z"),
		]);
		assert.strictEqual(active.get("phoenix-reactions"), true);
		assert.strictEqual(active.get("phoenix-user-ban"), false);
		assert.strictEqual(active.has("phoenix-mod-queue"), false);
		assert.strictEqual(active.size, 2);
	});

	it("breaks a same-instant tie by id, so the latest event is deterministic", () => {
		const at = "2026-01-01T12:00:00Z";
		const active = selectActiveOverrides([
			row("id-1", "phoenix-reactions", "on", at),
			row("id-2", "phoenix-reactions", "clear", at),
		]);
		// id-2 > id-1 at the same timestamp ⇒ the clear is the latest ⇒ lifted.
		assert.strictEqual(active.has("phoenix-reactions"), false);
	});
});
