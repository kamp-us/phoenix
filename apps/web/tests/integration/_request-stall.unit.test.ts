/**
 * Pins the stall classification + recovery policy that keeps a single transient round-trip
 * from reding a clean PR in the merge queue (#3942): a stalled SAFE request is replayable by
 * HTTP semantics, an unsafe one is NOT blind-replayed, and a non-idempotent mutation converges
 * by adopting the landed write. `sleep` is injected so the whole suite runs offline.
 */

import {describe, expect, it, vi} from "vitest";
import {
	convergeAfterStall,
	isSafeMethod,
	isStall,
	RequestStallError,
	SAFE_STALL_REPLAYS,
} from "./_request-stall.ts";

const timeoutError = (): Error => {
	const e = new Error("The operation was aborted due to timeout");
	e.name = "TimeoutError";
	return e;
};

const noSleep = () => Promise.resolve();

describe("isStall", () => {
	it("matches the raw AbortSignal.timeout rejection (the shape CI printed for #3942)", () => {
		expect(isStall(timeoutError())).toBe(true);
		const aborted = new Error("aborted");
		aborted.name = "AbortError";
		expect(isStall(aborted)).toBe(true);
	});

	it("matches the attributed RequestStallError it is re-thrown as", () => {
		expect(isStall(new RequestStallError("POST", "/fate", 30_000, 1))).toBe(true);
	});

	it("does NOT match a real failure — a connection error or a domain error still surfaces", () => {
		expect(isStall(new Error("fetch failed"))).toBe(false);
		expect(isStall(new TypeError("network"))).toBe(false);
		expect(isStall(undefined)).toBe(false);
	});
});

describe("RequestStallError", () => {
	it("names the round-trip that stalled — the attribution the bare TimeoutError lacked", () => {
		const e = new RequestStallError("POST", "/fate", 30_000, 2);
		expect(e.method).toBe("POST");
		expect(e.path).toBe("/fate");
		expect(e.timeoutMs).toBe(30_000);
		expect(e.attempts).toBe(2);
		expect(e.message).toContain("POST /fate");
		expect(e.message).toContain("30000ms");
	});
});

describe("isSafeMethod", () => {
	it("treats GET/HEAD as replayable (RFC 9110 safe ⇒ idempotent), including an absent method", () => {
		expect(isSafeMethod("GET")).toBe(true);
		expect(isSafeMethod("head")).toBe(true);
		expect(isSafeMethod(undefined)).toBe(true); // fetch defaults to GET
	});

	it("treats a write method as NOT replayable — a stalled POST may have committed", () => {
		expect(isSafeMethod("POST")).toBe(false);
		expect(isSafeMethod("PUT")).toBe(false);
		expect(isSafeMethod("DELETE")).toBe(false);
	});

	it("allows exactly one replay of a stalled safe request, bounded under the test budget", () => {
		// Two 30s attempts = 60s, half the 120s testTimeout — the room the harness budgets.
		expect(SAFE_STALL_REPLAYS).toBe(1);
	});
});

describe("convergeAfterStall", () => {
	it("returns the send result untouched when nothing stalls (no probe, no sleep)", async () => {
		const send = vi.fn(async () => "sent");
		const landed = vi.fn(async () => "adopted" as string | undefined);
		const sleep = vi.fn(noSleep);
		await expect(convergeAfterStall(send, landed, {sleep})).resolves.toBe("sent");
		expect(landed).not.toHaveBeenCalled();
		expect(sleep).not.toHaveBeenCalled();
	});

	it("ADOPTS a write that landed before the stall — no duplicate send", async () => {
		const send = vi.fn(async () => {
			throw timeoutError();
		});
		const landed = vi.fn(async () => "adopted" as string | undefined);
		await expect(convergeAfterStall(send, landed, {sleep: noSleep})).resolves.toBe("adopted");
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("RE-SENDS once the probe proves the write did not land", async () => {
		let attempt = 0;
		const send = vi.fn(async () => {
			if (attempt++ === 0) throw timeoutError();
			return "sent-on-retry";
		});
		const landed = vi.fn(async () => undefined);
		await expect(convergeAfterStall(send, landed, {sleep: noSleep})).resolves.toBe("sent-on-retry");
		expect(send).toHaveBeenCalledTimes(2);
		expect(landed).toHaveBeenCalledTimes(1);
	});

	it("does NOT recover a real error — it surfaces at once, unprobed and un-resent", async () => {
		const send = vi.fn(async () => {
			throw new Error("fetch failed");
		});
		const landed = vi.fn(async () => "adopted" as string | undefined);
		await expect(convergeAfterStall(send, landed, {sleep: noSleep})).rejects.toThrow(
			"fetch failed",
		);
		expect(send).toHaveBeenCalledTimes(1);
		expect(landed).not.toHaveBeenCalled();
	});

	it("treats a RESOLVED result as terminal — a domain-level `!ok` is an answer, not a transient", async () => {
		const send = vi.fn(async () => ({ok: false, code: "DISPLAY_NAME_EMPTY"}));
		const landed = vi.fn(async () => undefined);
		await expect(convergeAfterStall(send, landed, {sleep: noSleep})).resolves.toEqual({
			ok: false,
			code: "DISPLAY_NAME_EMPTY",
		});
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("surfaces the last stall once the budget is spent and the write never landed", async () => {
		const send = vi.fn(async () => {
			throw timeoutError();
		});
		const landed = vi.fn(async () => undefined);
		await expect(
			convergeAfterStall(send, landed, {attempts: 3, sleep: noSleep}),
		).rejects.toMatchObject({name: "TimeoutError"});
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("honors a widened `recoverable` — the seeding path probes a domain rejection too", async () => {
		class Rejected extends Error {}
		let attempt = 0;
		const send = vi.fn(async () => {
			if (attempt++ === 0) throw new Rejected("rejected");
			return "sent-on-retry";
		});
		const landed = vi.fn(async () => undefined);
		await expect(
			convergeAfterStall(send, landed, {
				recoverable: (e) => isStall(e) || e instanceof Rejected,
				sleep: noSleep,
			}),
		).resolves.toBe("sent-on-retry");
		expect(landed).toHaveBeenCalledTimes(1);
	});
});
