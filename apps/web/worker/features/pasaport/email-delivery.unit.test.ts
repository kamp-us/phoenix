/**
 * `resolveEmailDeliveryState` — the pure failing-address projection (epic #2687). Latest
 * event wins, exactly like `resolveBanState`: no events → deliverable, a `fail` →
 * failing, a `fail` then a `clear` → deliverable again. No I/O, driven directly over
 * hand-built latest events.
 */
import {assert, describe, it} from "@effect/vitest";
import {DELIVERABLE, type EmailDeliveryEvent, resolveEmailDeliveryState} from "./email-delivery.ts";

const NOW = new Date("2026-01-01T00:00:00Z");

const event = (
	action: EmailDeliveryEvent["action"],
	reason: string | null,
	createdAt: Date,
): EmailDeliveryEvent => ({action, reason, createdAt});

describe("resolveEmailDeliveryState", () => {
	it("no events → deliverable", () => {
		assert.deepStrictEqual(resolveEmailDeliveryState(null, NOW), DELIVERABLE);
	});

	it("latest fail → failing, carrying the reason", () => {
		const latest = event("fail", "550 mailbox unavailable", new Date("2025-12-31T12:00:00Z"));
		assert.deepStrictEqual(resolveEmailDeliveryState(latest, NOW), {
			failing: true,
			reason: "550 mailbox unavailable",
		});
	});

	it("fail then clear → deliverable (a clear lifts a fail, latest-event-wins)", () => {
		// The projection only ever sees the single newest event; a `clear` newer than the
		// `fail` is what the caller passes, and it projects to deliverable.
		const latest = event("clear", null, new Date("2026-01-01T06:00:00Z"));
		assert.deepStrictEqual(resolveEmailDeliveryState(latest, NOW), DELIVERABLE);
	});

	it("a failing state carries a null reason through when the fail had none", () => {
		const latest = event("fail", null, new Date("2025-12-31T12:00:00Z"));
		assert.deepStrictEqual(resolveEmailDeliveryState(latest, NOW), {failing: true, reason: null});
	});
});
