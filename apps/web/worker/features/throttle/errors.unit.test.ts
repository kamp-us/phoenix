/**
 * The throttle wire-error annotation pin (ADR 0177). It lives here rather than in
 * `fate/wireCodes-per-class.unit.test.ts` because a seam-injected code has no declared
 * union for that staleness guard to pin against.
 */
import {encodeWireError, wireCodeOfClass} from "@kampus/fate-effect";
import {describe, expect, it} from "vitest";
import {RateLimitExceeded} from "./errors.ts";

describe("throttle wire error", () => {
	it("RateLimitExceeded carries RATE_LIMIT_EXCEEDED", () => {
		expect(wireCodeOfClass(RateLimitExceeded)).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("encodes to its wire code with its own message", () => {
		const wire = encodeWireError(new RateLimitExceeded({message: "slow down", retryAfterMs: 1000}));
		expect(wire.code).toBe("RATE_LIMIT_EXCEEDED");
		expect(wire.message).toBe("slow down");
	});
});
